import type { SessionEvent, SessionLive, SessionMeta } from '@shared/types';

export interface TurnActivity {
  label: string;
  active: boolean;
  failed?: boolean;
}

export function turnActivity(session: SessionMeta, live: SessionLive | undefined, events: SessionEvent[] | null): TurnActivity | null {
  if (live && live.turn !== 'idle') {
    const label = live.turn === 'sending' ? 'Sending…' : live.turn === 'compacting' ? 'Compacting…' : 'Working…';
    return { label, active: true };
  }
  if (session.goal.mode !== 'off') {
    if (session.goal.status === 'deciding') return { label: 'Deciding next step…', active: true };
    if (session.goal.status === 'waiting-workers') return { label: 'Waiting for workers…', active: true };
  }
  const turn = events?.findLast((event) => event.kind === 'turn');
  if (turn?.kind !== 'turn' || turn.phase !== 'end' || !turn.outcome) return null;
  switch (turn.outcome) {
    case 'done': return { label: 'Response complete', active: false };
    case 'stopped': return { label: 'Stopped', active: false };
    case 'incomplete': return { label: 'Response interrupted', active: false, failed: true };
    case 'error': return { label: 'Response failed', active: false, failed: true };
  }
}
