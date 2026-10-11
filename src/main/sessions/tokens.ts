import type { ChatMessage } from '@shared/page-protocol';
import type { SessionEvent, ToolOutputPart } from '@shared/types';

/** About four characters per token for prose and source code (measured against o200k). */
const CHARS_PER_TOKEN = 4;
/** What one image costs the model, in characters: a 512-pixel tile is about 765 tokens. */
const IMAGE_CHARS = 3_000;

/**
 * Estimated tokens of the conversation a session is bound to: the events since its last Compact &
 * Resume. `transcript` is ChatGPT's own record of that conversation when it could be read; it holds
 * the user and assistant text exactly as sent (opening context and messages typed in ChatGPT
 * included) but blanks every tool result, so tool results always come from the local record.
 */
export function contextTokens(events: SessionEvent[], transcript: ChatMessage[] | null = null): number {
  const current = events.slice(events.findLastIndex((event) => event.kind === 'handoff') + 1);
  let chars = 0;
  for (const event of current) {
    if (event.kind === 'tool') chars += event.resultChars ?? event.output.reduce((sum, part) => sum + outputChars(part), 0);
    if (transcript) continue;
    if (event.kind === 'user' || event.kind === 'assistant') chars += event.text.length;
    if (event.kind === 'tool') chars += JSON.stringify(event.args ?? null).length;
  }
  for (const message of transcript ?? []) {
    // Reasoning from earlier turns is not carried forward; its summaries are not the reasoning anyway.
    if (message.role !== 'tool' && message.contentType !== 'thoughts' && message.contentType !== 'reasoning_recap') {
      chars += message.text.length;
    }
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
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
