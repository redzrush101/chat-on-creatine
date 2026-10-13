import { useEffect, useState, useSyncExternalStore } from 'react';
import type { AppState, SessionEvent } from '@shared/types';
import { invoke, subscribe } from './bridge';

let appState: AppState | null = null;
const appListeners = new Set<() => void>();

function setAppState(next: AppState): void {
  appState = next;
  for (const listener of appListeners) listener();
}

subscribe('state', setAppState);
void invoke('app:state').then((state) => {
  if (!appState) setAppState(state);
});

/** The latest app state pushed by main, or null until the first snapshot arrives. */
export function useAppState(): AppState | null {
  return useSyncExternalStore(
    (listener) => {
      appListeners.add(listener);
      return () => appListeners.delete(listener);
    },
    () => appState
  );
}

const histories = new Map<string, { events: SessionEvent[]; index: Map<string, number> }>();
const historyListeners = new Map<string, Set<() => void>>();

function upsert(sessionId: string, incoming: SessionEvent[]): void {
  const current = histories.get(sessionId);
  if (!current) return; // not loaded; it will be fetched whole when opened
  const next = current.events.slice();
  const index = current.index;
  for (const event of incoming) {
    const at = index.get(event.id);
    if (at === undefined) {
      index.set(event.id, next.length);
      next.push(event);
    } else {
      next[at] = event;
    }
  }
  current.events = next;
  for (const listener of historyListeners.get(sessionId) ?? []) listener();
}

subscribe('session:events', ({ sessionId, events }) => upsert(sessionId, events));

/** History of one session, loaded on first use and kept live through pushed upserts. */
export function useSessionEvents(sessionId: string | null): SessionEvent[] | null {
  const [, force] = useState(0);
  useEffect(() => {
    if (!sessionId) return;
    let listeners = historyListeners.get(sessionId);
    if (!listeners) historyListeners.set(sessionId, (listeners = new Set()));
    const listener = () => force((n) => n + 1);
    listeners.add(listener);
    if (!histories.has(sessionId)) {
      void invoke('sessions:events', sessionId).then((events) => {
        const pending = histories.get(sessionId);
        histories.set(sessionId, { events, index: new Map(events.map((event, i) => [event.id, i])) });
        if (pending) upsert(sessionId, pending.events);
        listener();
      });
    }
    return () => {
      listeners.delete(listener);
    };
  }, [sessionId]);
  return sessionId ? (histories.get(sessionId)?.events ?? null) : null;
}
