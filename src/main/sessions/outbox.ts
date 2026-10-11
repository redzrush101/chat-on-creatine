import { randomUUID } from 'node:crypto';
import type { InputDelivery, InputItem, InputState } from '@shared/types';
import { readJsonSync, writeJson } from '../core/durable';
import { Emitter } from '../core/emitter';
import { createLogger } from '../core/log';

export type EnqueueInit = Omit<InputItem, 'id' | 'state' | 'createdAt' | 'sentAt' | 'error'> & { id?: string };

const KEEP_FINISHED = 50;
const FINISHED: ReadonlySet<InputState> = new Set(['sent', 'steered', 'failed', 'cancelled']);

/**
 * Messages the user or automation queued for a session. Persisted as one JSON file; the caller decides
 * when a session is idle (`nextFor`) and when a running turn can take steering input (`takeSteerable`).
 */
export class Outbox {
  private readonly path: string;
  private readonly items = new Map<string, InputItem>();
  private readonly emitter = new Emitter<{ change: InputItem[] }>();
  private readonly log = createLogger('outbox');

  constructor(path: string) {
    this.path = path;
    const stored = readJsonSync<unknown>(path, []);
    const loaded = Array.isArray(stored) ? (stored as InputItem[]) : [];
    let interrupted = false;
    for (const item of loaded) {
      if (item.state === 'sending') {
        this.items.set(item.id, { ...item, state: 'failed', error: 'Interrupted by app restart' });
        interrupted = true;
      } else {
        this.items.set(item.id, item);
      }
    }
    if (interrupted) this.commit();
  }

  /** Queues an item. Enqueuing an id that already exists returns the existing item unchanged. */
  enqueue(init: EnqueueInit): InputItem {
    const id = init.id ?? randomUUID();
    const existing = this.items.get(id);
    if (existing) return existing;
    const item: InputItem = {
      id,
      sessionId: init.sessionId,
      text: init.text,
      attachments: init.attachments,
      delivery: init.delivery,
      source: init.source,
      state: 'queued',
      createdAt: Date.now(),
      sentAt: null,
      error: null
    };
    this.items.set(id, item);
    this.commit();
    return item;
  }

  get(id: string): InputItem | undefined {
    return this.items.get(id);
  }

  /** Pending items first, then the rest; oldest first within each group. */
  list(sessionId?: string): InputItem[] {
    const rank = (item: InputItem) => (item.state === 'queued' || item.state === 'sending' ? 0 : 1);
    return [...this.items.values()]
      .filter((item) => sessionId === undefined || item.sessionId === sessionId)
      .sort((a, b) => rank(a) - rank(b) || a.createdAt - b.createdAt);
  }

  /** Edits a queued item. Returns undefined once it has left the queue. */
  update(id: string, patch: { text?: string; delivery?: InputDelivery }): InputItem | undefined {
    const item = this.items.get(id);
    if (!item) return undefined;
    return this.transition(id, 'queued', { text: patch.text ?? item.text, delivery: patch.delivery ?? item.delivery });
  }

  cancel(id: string): InputItem | undefined {
    return this.transition(id, 'queued', { state: 'cancelled' });
  }

  /** The oldest queued item for the session. The caller guarantees the session is idle. */
  nextFor(sessionId: string): InputItem | undefined {
    return this.list(sessionId).find((item) => item.state === 'queued');
  }

  /** Atomically claims the queued `now` items of a session for a tool result to carry. */
  takeSteerable(sessionId: string): InputItem[] {
    const taken: InputItem[] = [];
    const at = Date.now();
    for (const item of this.list(sessionId)) {
      if (item.state !== 'queued' || item.delivery !== 'now') continue;
      const steered: InputItem = { ...item, state: 'steered', sentAt: at };
      this.items.set(item.id, steered);
      taken.push(steered);
    }
    if (taken.length > 0) this.commit();
    return taken;
  }

  markSending(id: string): InputItem | undefined {
    return this.transition(id, 'queued', { state: 'sending' });
  }

  markSent(id: string): InputItem | undefined {
    return this.transition(id, 'sending', { state: 'sent', sentAt: Date.now() });
  }

  markFailed(id: string, error: string): InputItem | undefined {
    return this.transition(id, 'sending', { state: 'failed', error });
  }

  /** Puts a send that failed recoverably back in the queue. */
  requeue(id: string): InputItem | undefined {
    return this.transition(id, 'sending', { state: 'queued' });
  }

  onChange(listener: (items: InputItem[]) => void): () => void {
    return this.emitter.on('change', listener);
  }

  private transition(id: string, from: InputState, fields: Partial<InputItem>): InputItem | undefined {
    const item = this.items.get(id);
    if (!item || item.state !== from) return undefined;
    const next: InputItem = { ...item, ...fields };
    this.items.set(id, next);
    this.commit();
    return next;
  }

  private commit(): void {
    const finished = [...this.items.values()]
      .filter((item) => FINISHED.has(item.state))
      .sort((a, b) => b.createdAt - a.createdAt);
    for (const item of finished.slice(KEEP_FINISHED)) this.items.delete(item.id);

    writeJson(this.path, [...this.items.values()]).catch((error: unknown) =>
      this.log.error('could not save outbox', error)
    );
    this.emitter.emit('change', this.list());
  }
}
