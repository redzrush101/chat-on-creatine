import type { SessionEvent, SessionLive, SessionMeta } from '@shared/types';
import { describeTool } from './tool-labels';

export interface TurnActivity {
  label: string;
  active: boolean;
  failed?: boolean;
}

export function turnActivity(session: SessionMeta, live: SessionLive | undefined, events: SessionEvent[] | null): TurnActivity | null {
  if (live && live.turn !== 'idle') {
    const active = events?.findLast((event) => event.kind === 'tool' && event.status === 'running' || (event.kind === 'assistant' || event.kind === 'reasoning') && event.streaming);
    const step = active?.kind === 'tool' ? describeTool(active).active : active?.kind === 'reasoning' ? 'Thinking' : active?.kind === 'assistant' ? 'Responding' : 'Working';
    const label = live.turn === 'sending' ? 'Sending…' : live.turn === 'compacting' ? 'Compacting…' : `${step}…`;
    return { label, active: true };
  }
  if (session.goal.mode !== 'off') {
    if (session.goal.status === 'deciding') return { label: 'Deciding next step…', active: true };
    if (session.goal.status === 'waiting-workers') return { label: 'Waiting for workers…', active: true };
    const mode = session.goal.mode === 'loop' ? 'Loop' : 'Goal';
    if (session.goal.status === 'error') return { label: `${mode} failed`, active: false, failed: true };
    if (session.goal.status === 'stopped') return { label: `${mode} stopped`, active: false };
    if (session.goal.status === 'done') return { label: `${mode} complete`, active: false };
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
