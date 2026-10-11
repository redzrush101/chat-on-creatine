import type { SessionEvent } from '@shared/types';

/** Work narration: tool calls, thinking and interim prose between them. */
function isWork(event: SessionEvent): boolean {
  return event.kind === 'tool' || event.kind === 'reasoning' || (event.kind === 'assistant' && event.channel === 'commentary');
}

/** Turn bookkeeping that is not worth a row: starts and clean ends. */
function isSilent(event: SessionEvent): boolean {
  return event.kind === 'turn' && (event.phase === 'start' || event.outcome === null || event.outcome === 'done');
}

export type TimelineBlock =
  | { type: 'event'; event: SessionEvent }
  | { type: 'work'; id: string; events: SessionEvent[]; running: boolean; tools: number };

/**
 * Folds runs of work events into one collapsible block. A run of one event stays a plain row
 * unless it is still in progress at the tail of a live turn.
 */
export function buildBlocks(events: SessionEvent[], live: boolean): TimelineBlock[] {
  const blocks: TimelineBlock[] = [];
  let run: SessionEvent[] = [];

  const flush = (tail: boolean) => {
    if (run.length === 0) return;
    const grouped = run.length > 1 || (tail && live);
    if (grouped) {
      blocks.push({
        type: 'work',
        id: `work:${run[0]?.id ?? ''}`,
        events: run,
        running: tail && live,
        tools: run.filter((event) => event.kind === 'tool').length
      });
    } else if (run[0]) {
      blocks.push({ type: 'event', event: run[0] });
    }
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
