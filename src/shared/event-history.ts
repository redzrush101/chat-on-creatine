import type { SessionEvent } from './types';

/** Event IDs own ordering; a snapshot must preserve updates received while it was loading. */
export class EventHistory {
  readonly events = new Map<string, SessionEvent>();
  private snapshot: SessionEvent[] | null = null;
  private loaded = false;

  merge(incoming: SessionEvent[]): void {
    for (const event of incoming) {
      const previous = this.events.get(event.id);
      if (previous && 'streaming' in previous && !previous.streaming && 'streaming' in event && event.streaming) continue;
      this.events.set(event.id, event);
    }
    this.snapshot = null;
  }

  load(snapshot: SessionEvent[]): void {
    const pending = [...this.events.values()];
    this.events.clear();
    this.merge(snapshot);
    this.merge(pending);
    this.loaded = true;
  }

  read(): SessionEvent[] | null {
    if (!this.loaded) return null;
    return this.snapshot ??= [...this.events.values()];
  }
}
