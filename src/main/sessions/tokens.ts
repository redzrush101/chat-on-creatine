import type { SessionEvent, ToolOutputPart } from '@shared/types';

/** Rough token count from characters (about four per token). Local accounting only. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Estimated tokens of the conversation text a session has accumulated. */
export function contextTokens(events: SessionEvent[]): number {
  let total = 0;
  for (const event of events) {
    switch (event.kind) {
      case 'user':
      case 'assistant':
      case 'reasoning':
        total += estimateTokens(event.text);
        break;
      case 'tool':
        total += event.output.reduce((sum, part) => sum + estimateOutput(part), 0);
        break;
      default:
        break;
    }
  }
  return total;
}

function estimateOutput(part: ToolOutputPart): number {
  if (part.type === 'text') return estimateTokens(part.text);
  if (part.type === 'exec') return estimateTokens(part.output);
  return 0;
}
