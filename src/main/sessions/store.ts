import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { SessionEvent, SessionMeta } from '@shared/types';
import { CHARS_PER_TOKEN, CONTEXT_PARTS, contextUsage, eventContextUsage, usageTokens } from '@shared/context';
import { appendText, flushWrites, writeFileAtomic, writeJson } from '../core/durable';
import { Emitter } from '../core/emitter';
import { createLogger } from '../core/log';

type MetaChange = SessionMeta | { deleted: string };

interface History {
  /** Latest version of each event, in order of first appearance. */
  events: Map<string, SessionEvent>;
  /** Lines in events.jsonl, including superseded ones. */
  lines: number;
  contextIds: Set<string>;
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
  private readonly recordTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly pendingRecords = new Map<string, Map<string, SessionEvent>>();
  private readonly deletions = new Set<Promise<void>>();
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
    this.metas.set(meta.id, meta);
    this.histories.set(meta.id, { events: new Map(), lines: 0, contextIds: new Set() });
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
    clearTimeout(this.recordTimers.get(id));
    this.recordTimers.delete(id);
    this.pendingRecords.delete(id);
    this.emitter.emit('meta', { deleted: id });
    const deletion = flushWrites().then(() => rm(join(this.dir, id), { recursive: true, force: true }));
    this.deletions.add(deletion);
    void deletion.then(() => this.deletions.delete(deletion), (error: unknown) => {
      this.deletions.delete(deletion);
      this.log.error(`could not delete session ${id}`, error);
    });
  }

  /** The most recently updated session bound to this conversation, current binding first. */
  byConversation(conversationId: string): SessionMeta | undefined {
    let current: SessionMeta | undefined;
    let earlier: SessionMeta | undefined;
    for (const meta of this.metas.values()) {
      if (meta.conversationId === conversationId && (!current || meta.updatedAt > current.updatedAt)) current = meta;
      if (meta.lineage.includes(conversationId) && (!earlier || meta.updatedAt > earlier.updatedAt)) earlier = meta;
    }
    return current ?? earlier;
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
    let usage = { ...(meta.contextUsage ?? contextUsage([...history.events.values()])) };
    if (!meta.contextUsage) usage.other += Math.max(0, (meta.contextTokens - usageTokens(usage)) * CHARS_PER_TOKEN);
    for (const event of events) {
      const previous = history.events.get(event.id);
      if (event.kind === 'handoff' && !previous) {
        usage = eventContextUsage();
        history.contextIds.clear();
      } else if (!previous || history.contextIds.has(event.id)) {
        const before = eventContextUsage(previous);
        const after = eventContextUsage(event);
        for (const key of Object.keys(CONTEXT_PARTS) as (keyof typeof CONTEXT_PARTS)[]) usage[key] = Math.max(0, usage[key] + after[key] - before[key]);
        history.contextIds.add(event.id);
      }
      history.events.set(event.id, event);
    }
    meta.contextUsage = usage;
    meta.contextTokens = usageTokens(usage);
    if (this.recording()) {
      let pending = this.pendingRecords.get(id);
      if (!pending) this.pendingRecords.set(id, (pending = new Map()));
      for (const event of events) pending.set(event.id, event);
      if (events.some((event) => !('streaming' in event) || !event.streaming)) this.record(id);
      else if (!this.recordTimers.has(id)) this.recordTimers.set(id, setTimeout(() => this.record(id), SAVE_DELAY_MS));
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
    for (const id of [...this.pendingRecords.keys()]) this.record(id);
    for (const id of [...this.saveTimers.keys()]) {
      clearTimeout(this.saveTimers.get(id));
      this.save(id);
    }
    await flushWrites();
    await Promise.allSettled(this.deletions);
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
          // Persisted messages have no live stream after the app restarts.
          if (event.kind === 'assistant' || event.kind === 'reasoning') event.streaming = false;
          events.set(event.id, event);
        } catch {
          this.log.warn(`skipping unreadable event line in session ${id}`);
        }
      }
    }

    const current = [...events.values()];
    const history: History = { events, lines, contextIds: new Set(current.slice(current.findLastIndex((event) => event.kind === 'handoff') + 1).map((event) => event.id)) };
    this.histories.set(id, history);
    if (this.recording() && lines > 0 && lines - events.size > lines / 2) this.compact(id, history);
    return history;
  }

  private compact(id: string, history: History): void {
    const file = this.eventsFile(id);
    void writeFileAtomic(file, [...history.events.values()].map((event) => `${JSON.stringify(event)}\n`).join(''))
      .catch((error: unknown) => this.log.error(`could not compact session ${id}`, error));
    history.lines = history.events.size;
  }

  private scheduleSave(id: string): void {
    if (this.saveTimers.has(id)) return;
    this.saveTimers.set(
      id,
      setTimeout(() => this.save(id), SAVE_DELAY_MS)
    );
  }

  private record(id: string): void {
    clearTimeout(this.recordTimers.get(id));
    this.recordTimers.delete(id);
    const pending = this.pendingRecords.get(id);
    this.pendingRecords.delete(id);
    const history = this.histories.get(id);
    if (!pending?.size || !history) return;
    void appendText(this.eventsFile(id), [...pending.values()].map((event) => `${JSON.stringify(event)}\n`).join(''))
      .catch((error: unknown) => this.log.error(`could not record session ${id}`, error));
    history.lines += pending.size;
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
