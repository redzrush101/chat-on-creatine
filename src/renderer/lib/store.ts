import { useEffect, useState, useSyncExternalStore } from 'react';
import type { AppState, SessionEvent } from '@shared/types';
import { invoke, subscribe } from './bridge';
import { EventHistory } from '@shared/event-history';
import { reportError } from '../components/common/Toasts';

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

const histories = new Map<string, EventHistory>();
const historyListeners = new Map<string, Set<() => void>>();

function upsert(sessionId: string, incoming: SessionEvent[]): void {
  const current = histories.get(sessionId);
  if (!current) return; // not loaded; it will be fetched whole when opened
  current.merge(incoming);
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
      const history = new EventHistory();
      histories.set(sessionId, history);
      void invoke('sessions:events', sessionId).then((events) => {
        history.load(events);
        for (const listener of historyListeners.get(sessionId) ?? []) listener();
      }).catch(reportError);
    }
    return () => {
      listeners.delete(listener);
    };
  }, [sessionId]);
  return sessionId ? (histories.get(sessionId)?.read() ?? null) : null;
}
