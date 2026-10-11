import type { SessionEvent } from '@shared/types';

/** Work narration that folds into a group: tool calls and the thinking between them. */
function isWork(event: SessionEvent): boolean {
  return event.kind === 'tool' || event.kind === 'reasoning';
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

  const flush = (tail: boolean) => {
    if (run.length === 0) return;
    blocks.push({
      type: 'work',
      id: `work:${run[0]?.id ?? ''}`,
      events: run,
      running: tail && live,
      tools: run.filter((event) => event.kind === 'tool').length
    });
    run = [];
  };

  for (const event of events) {
    if (isWork(event)) {
      run.push(event);
    } else if (!isSilent(event)) {
      flush(false);
      blocks.push({ type: 'event', event });
    }
  }
  flush(true);
  return blocks;
}
