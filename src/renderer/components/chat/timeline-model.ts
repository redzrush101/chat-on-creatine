import type { SessionEvent } from '@shared/types';
import { toolBaseName } from './tool-labels';

/** Work narration that folds into a group: tool calls and the thinking between them. */
function isWork(event: SessionEvent): boolean {
  return event.kind === 'tool' || event.kind === 'reasoning';
}

/** A spawn call says only what the agent rows right after it say again, and say better. */
function isAgentSpawn(event: SessionEvent): boolean {
  if (event.kind !== 'tool' || toolBaseName(event.name) !== 'agents') return false;
  const args = event.args as { action?: unknown; args?: { action?: unknown } } | null;
  return (args?.action ?? args?.args?.action) === 'spawn';
}

/** Turn bookkeeping that is not worth a row: starts and clean ends. */
function isSilent(event: SessionEvent): boolean {
  return event.kind === 'turn' && (event.phase === 'start' || event.outcome === null || event.outcome === 'done');
}

export type TimelineBlock =
  | { type: 'event'; event: SessionEvent }
  | { type: 'work'; id: string; events: SessionEvent[]; running: boolean; tools: number };

/**
 * Folds each run of tool calls (with the thinking between them) into one collapsible group, the way
 * the Claude app shows "Ran 5 commands". Interim prose stays a normal row and splits groups.
 */
export function buildBlocks(events: SessionEvent[], live: boolean): TimelineBlock[] {
  const blocks: TimelineBlock[] = [];
  let run: SessionEvent[] = [];

  const flush = (tail: boolean, next?: SessionEvent) => {
    if (run.length === 0) return;
    const tools = run.filter((event) => event.kind === 'tool');
    if (next?.kind === 'agent' && next.action === 'spawned' && tools.length > 0 && tools.every(isAgentSpawn)) {
      run = [];
      return;
    }
    blocks.push({
      type: 'work',
      id: `work:${run[0]?.id ?? ''}`,
      events: run,
      running: tail && live,
      tools: tools.length
    });
    run = [];
  };

  for (const event of events) {
    if (isWork(event)) {
      run.push(event);
    } else if (!isSilent(event)) {
      flush(false, event);
      blocks.push({ type: 'event', event });
    }
  }
  flush(true);
  return blocks;
}
