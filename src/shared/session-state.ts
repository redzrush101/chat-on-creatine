import type { AppState } from './types';

/** A turn, queued delivery or automation decision must finish before a workflow can start. */
export function sessionBusy(state: Pick<AppState, 'live' | 'inputs' | 'sessions'>, id: string | null): boolean {
  if (!id) return false;
  const live = state.live[id];
  return !!live && live.turn !== 'idle' || state.inputs.some((input) => input.sessionId === id && (input.state === 'queued' || input.state === 'sending')) ||
    state.sessions.some((session) => session.id === id && (session.goal.status === 'deciding' || session.goal.status === 'waiting-workers'));
}
