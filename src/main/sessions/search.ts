import type { SessionStore } from './store';

export interface SearchHit {
  sessionId: string;
  eventId: string;
  snippet: string;
}

const CONTEXT_CHARS = 40;

/** Case-insensitive substring search over user and assistant text, most recently updated sessions first. */
export function searchSessions(store: SessionStore, query: string, limit = 50): SearchHit[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [];
  const hits: SearchHit[] = [];
  for (const meta of store.list()) {
    for (const event of store.events(meta.id)) {
      if (event.kind !== 'user' && event.kind !== 'assistant') continue;
      const index = event.text.toLowerCase().indexOf(needle);
      if (index < 0) continue;
      hits.push({ sessionId: meta.id, eventId: event.id, snippet: snippetAround(event.text, index, needle.length) });
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}

function snippetAround(text: string, index: number, length: number): string {
  const start = Math.max(0, index - CONTEXT_CHARS);
  const end = Math.min(text.length, index + length + CONTEXT_CHARS);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ')}${end < text.length ? '…' : ''}`;
}
