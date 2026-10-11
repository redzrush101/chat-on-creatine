import { createContext } from 'react';
import type { SessionEvent, WebSource } from '@shared/types';

/** Web pages the chat's searches found or opened, by the ref id citations use. */
export const SourcesContext = createContext<ReadonlyMap<string, WebSource>>(new Map());

export function sourcesByRef(events: SessionEvent[]): Map<string, WebSource> {
  const map = new Map<string, WebSource>();
  for (const event of events) {
    if (event.kind !== 'tool') continue;
    for (const part of event.output) {
      if (part.type !== 'sources') continue;
      for (const source of part.sources) if (source.ref) map.set(source.ref, source);
    }
  }
  return map;
}
