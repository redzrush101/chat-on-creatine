import { randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionEvent, SessionMeta } from '@shared/types';
import { flushWrites, writeJson } from '../core/durable';
import { Emitter } from '../core/emitter';
import { createLogger } from '../core/log';

export type MetaChange = SessionMeta | { deleted: string };

interface History {
  /** Latest version of each event, in order of first appearance. */
  events: Map<string, SessionEvent>;
  /** Lines in events.jsonl, including superseded ones. */
  lines: number;
}

const SAVE_DELAY_MS = 250;
const DAY_MS = 86_400_000;

/**
 * Durable sessions: `<dir>/<sessionId>/meta.json` plus `events.jsonl`, an append-only log where a
 * later line with the same event id replaces the earlier one.
 */
export class SessionStore {
  private readonly dir: string;
  private readonly recording: () => boolean;
  private readonly metas = new Map<string, SessionMeta>();
  private readonly histories = new Map<string, History>();
  private readonly saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly emitter = new Emitter<{
    meta: MetaChange;
    events: { sessionId: string; events: SessionEvent[] };
  }>();
  private readonly log = createLogger('sessions');

  constructor(dir: string, opts: { recording: () => boolean }) {
    this.dir = dir;
    this.recording = opts.recording;
  }

  /** Reads every session meta from disk. Corrupt sessions are skipped and logged. */
  load(): void {
    mkdirSync(this.dir, { recursive: true });
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      try {
        const meta = JSON.parse(readFileSync(join(this.dir, entry.name, 'meta.json'), 'utf8')) as SessionMeta;
        if (meta.id !== entry.name) throw new Error('id does not match its folder');
        this.metas.set(meta.id, meta);
      } catch (error) {
        this.log.warn(`skipping corrupt session ${entry.name}: ${String(error)}`);
      }
    }
  }

  list(): SessionMeta[] {
    return [...this.metas.values()].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): SessionMeta | undefined {
    return this.metas.get(id);
  }

  create(init: Partial<SessionMeta> & { kind: SessionMeta['kind'] }): SessionMeta {
    const now = Date.now();
    const meta: SessionMeta = {
      title: 'New chat',
      projectId: null,
      cwd: null,
      conversationId: null,
      lineage: [],
      model: null,
      reasoning: null,
      createdAt: now,
      updatedAt: now,
      pinned: false,
      parentId: null,
      goal: { mode: 'off', objective: '', steps: 0, status: 'idle', lastDecision: null },
      contextTokens: 0,
      blocked: false,
      ...init,
      id: randomUUID()
    };
    mkdirSync(join(this.dir, meta.id), { recursive: true });
    this.metas.set(meta.id, meta);
    this.scheduleSave(meta.id);
    this.emitter.emit('meta', meta);
    return meta;
  }

  update(id: string, patch: Partial<Omit<SessionMeta, 'id'>>): SessionMeta | undefined {
    const current = this.metas.get(id);
    if (!current) return undefined;
    const next: SessionMeta = { ...current, ...patch, id };
    this.metas.set(id, next);
    this.scheduleSave(id);
    this.emitter.emit('meta', next);
    return next;
  }

  /** Removes the session folder. Pending writes land first so none can resurrect it. */
  delete(id: string): void {
    if (!this.metas.delete(id)) return;
    this.histories.delete(id);
    clearTimeout(this.saveTimers.get(id));
    this.saveTimers.delete(id);
    this.emitter.emit('meta', { deleted: id });
    void flushWrites().then(() => rmSync(join(this.dir, id), { recursive: true, force: true }));
  }

  /** The most recently updated session bound to this conversation, current binding first. */
  byConversation(conversationId: string): SessionMeta | undefined {
    const sessions = this.list();
    return (
      sessions.find((meta) => meta.conversationId === conversationId) ??
      sessions.find((meta) => meta.lineage.includes(conversationId))
    );
  }

  events(id: string): SessionEvent[] {
    return [...(this.history(id)?.events.values() ?? [])];
  }

  event(id: string, eventId: string): SessionEvent | undefined {
    return this.history(id)?.events.get(eventId);
  }

  /** Upserts events by id in memory and, while recording is on, appends them to disk. */
  append(id: string, events: SessionEvent[]): void {
    const meta = this.metas.get(id);
    const history = this.history(id);
    if (!meta || !history || events.length === 0) return;
    for (const event of events) history.events.set(event.id, event);
    if (this.recording()) {
      appendFileSync(this.eventsFile(id), events.map((event) => `${JSON.stringify(event)}\n`).join(''));
      history.lines += events.length;
    }
    meta.updatedAt = Date.now();
    this.scheduleSave(id);
    this.emitter.emit('events', { sessionId: id, events });
    this.emitter.emit('meta', meta);
  }

  /** Deletes unpinned sessions not updated within the retention window. 0 keeps everything. */
  prune(retentionDays: number, now = Date.now()): string[] {
    if (retentionDays <= 0) return [];
    const cutoff = now - retentionDays * DAY_MS;
    const expired = this.list().filter((meta) => !meta.pinned && meta.updatedAt < cutoff);
    for (const meta of expired) this.delete(meta.id);
    return expired.map((meta) => meta.id);
  }

  /** Writes all pending meta changes now and waits for every queued write. */
  async flush(): Promise<void> {
    for (const id of [...this.saveTimers.keys()]) {
      clearTimeout(this.saveTimers.get(id));
      this.save(id);
    }
    await flushWrites();
  }

  onMeta(listener: (change: MetaChange) => void): () => void {
    return this.emitter.on('meta', listener);
  }

  onEvents(listener: (sessionId: string, events: SessionEvent[]) => void): () => void {
    return this.emitter.on('events', ({ sessionId, events }) => listener(sessionId, events));
  }

  private eventsFile(id: string): string {
    return join(this.dir, id, 'events.jsonl');
  }

  private history(id: string): History | undefined {
    const cached = this.histories.get(id);
    if (cached || !this.metas.has(id)) return cached;

    const events = new Map<string, SessionEvent>();
    let lines = 0;
    const file = this.eventsFile(id);
    if (existsSync(file)) {
      for (const line of readFileSync(file, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        lines++;
        try {
          const event = JSON.parse(line) as SessionEvent;
          events.set(event.id, event);
        } catch {
          this.log.warn(`skipping unreadable event line in session ${id}`);
        }
      }
    }

    const history: History = { events, lines };
    this.histories.set(id, history);
    if (this.recording() && lines > 0 && lines - events.size > lines / 2) this.compact(id, history);
    return history;
  }

  private compact(id: string, history: History): void {
    const file = this.eventsFile(id);
    const temp = `${file}.tmp`;
    writeFileSync(temp, [...history.events.values()].map((event) => `${JSON.stringify(event)}\n`).join(''));
    renameSync(temp, file);
    history.lines = history.events.size;
  }

  private scheduleSave(id: string): void {
    clearTimeout(this.saveTimers.get(id));
    this.saveTimers.set(
      id,
      setTimeout(() => this.save(id), SAVE_DELAY_MS)
    );
  }

  private save(id: string): void {
    this.saveTimers.delete(id);
    const meta = this.metas.get(id);
    if (!meta) return;
    writeJson(join(this.dir, id, 'meta.json'), meta).catch((error: unknown) =>
      this.log.error(`could not save session ${id}`, error)
    );
  }
}
