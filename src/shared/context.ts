import type { ChatMessage } from './page-protocol';
import type { SessionEvent, ToolOutputPart } from './types';

/** About four characters per token for prose and source code (measured against o200k). */
export const CHARS_PER_TOKEN = 4;
/** What one image costs the model, in characters: a 512-pixel tile is about 765 tokens. */
const IMAGE_CHARS = 3_000;

/** Character counts preserve small deltas until the total is converted to estimated tokens. */
export interface ContextUsage {
  input: number;
  output: number;
  toolCalls: number;
  toolResults: number;
  other: number;
}

export const CONTEXT_PARTS = { input: 'Your messages', output: 'Assistant replies', toolCalls: 'Tool calls', toolResults: 'Tool results', other: 'Opening context & other' } as const;

export function eventContextUsage(event?: SessionEvent): ContextUsage {
  const usage: ContextUsage = { input: 0, output: 0, toolCalls: 0, toolResults: 0, other: 0 };
  if (event?.kind === 'user') usage.input = event.text.length + event.attachments.filter((file) => file.mime.startsWith('image/')).length * IMAGE_CHARS;
  if (event?.kind === 'assistant') usage.output = event.text.length;
  if (event?.kind === 'tool' && !event.nested) {
    usage.toolCalls = event.argsChars ?? JSON.stringify(event.args ?? null).length;
    usage.toolResults = event.resultChars ?? event.output.reduce((sum, part) => sum + outputChars(part), 0);
  }
  return usage;
}

export function usageTokens(usage: ContextUsage): number {
  return Math.ceil(Object.values(usage).reduce((sum, chars) => sum + chars, 0) / CHARS_PER_TOKEN);
}

export function contextPercent(tokens: number, advisory: number): { used: number; remaining: number } {
  const used = Math.max(0, Math.round(tokens / Math.max(1, advisory) * 100));
  return { used, remaining: Math.max(0, 100 - used) };
}

/**
 * Estimated tokens of the conversation a session is bound to: the events since its last Compact &
 * Resume. `transcript` is ChatGPT's own record of that conversation when it could be read; it holds
 * the user and assistant text exactly as sent (opening context and messages typed in ChatGPT
 * included) but blanks every tool result, so tool results always come from the local record.
 */
export function contextUsage(events: SessionEvent[], transcript: ChatMessage[] | null = null): ContextUsage {
  const current = events.slice(events.findLastIndex((event) => event.kind === 'handoff') + 1);
  const usage = eventContextUsage();
  for (const event of current) {
    const part = eventContextUsage(event);
    usage.input += part.input;
    usage.output += part.output;
    usage.toolCalls += part.toolCalls;
    usage.toolResults += part.toolResults;
  }
  if (transcript) {
    const input = transcript.filter((message) => message.role === 'user').reduce((sum, message) => sum + message.text.length, 0);
    const localInput = current.reduce((sum, event) => sum + (event.kind === 'user' ? event.text.length : 0), 0);
    usage.other = Math.max(0, input - localInput);
    usage.input = input - usage.other + usage.input - localInput;
    usage.output = 0;
    usage.toolCalls = 0;
  }
  for (const message of transcript ?? []) {
    if (message.role === 'system') usage.other += message.text.length;
    // Reasoning from earlier turns is not carried forward; its summaries are not the reasoning anyway.
    if (message.role === 'assistant' && message.contentType !== 'thoughts' && message.contentType !== 'reasoning_recap') {
      if (message.recipient === 'all') usage.output += message.text.length;
      else usage.toolCalls += message.text.length;
    }
  }
  return usage;
}

/** Characters a tool result adds to the model's context: its text blocks and images. */
export function resultChars(content: readonly { type: string; text?: string }[]): number {
  return content.reduce((sum, block) => sum + (block.type === 'text' ? (block.text?.length ?? 0) : IMAGE_CHARS), 0);
}

function outputChars(part: ToolOutputPart): number {
  if (part.type === 'text') return part.text.length;
  if (part.type === 'exec') return part.output.length;
  if (part.type === 'image') return IMAGE_CHARS;
  return 0;
}
