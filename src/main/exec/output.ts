/** Bounded command output: a head/tail byte buffer and token-based middle truncation (about 4 bytes per token). */

const OUTPUT_MAX_BYTES = 1024 * 1024;
export const DEFAULT_MAX_OUTPUT_TOKENS = 10_000;
const BYTES_PER_TOKEN = 4;

/** Keeps the first and last part of a stream; whatever falls out of the middle is counted. */
export class HeadTailBuffer {
  private readonly headBudget: number;
  private readonly tailBudget: number;
  private head: Buffer[] = [];
  private headBytes = 0;
  private tail: Buffer[] = [];
  private tailBytes = 0;
  private omitted = 0;

  constructor(maxBytes = OUTPUT_MAX_BYTES) {
    this.headBudget = Math.floor(maxBytes / 2);
    this.tailBudget = maxBytes - this.headBudget;
  }

  push(chunk: Buffer): void {
    let rest = chunk;
    const room = this.headBudget - this.headBytes;
    if (room > 0 && rest.length > 0) {
      const taken = rest.subarray(0, Math.min(room, rest.length));
      this.head.push(taken);
      this.headBytes += taken.length;
      rest = rest.subarray(taken.length);
    }
    if (rest.length === 0) return;

    if (rest.length >= this.tailBudget) {
      const kept = rest.subarray(rest.length - this.tailBudget);
      this.omitted += this.tailBytes + rest.length - kept.length;
      this.tail = [kept];
      this.tailBytes = kept.length;
      return;
    }
    this.tail.push(rest);
    this.tailBytes += rest.length;
    let excess = this.tailBytes - this.tailBudget;
    while (excess > 0) {
      const first = this.tail[0]!;
      if (first.length <= excess) {
        this.tail.shift();
        excess -= first.length;
        this.tailBytes -= first.length;
        this.omitted += first.length;
      } else {
        this.tail[0] = first.subarray(excess);
        this.tailBytes -= excess;
        this.omitted += excess;
        excess = 0;
      }
    }
  }

  totalBytes(): number {
    return this.headBytes + this.tailBytes + this.omitted;
  }

  /** Retained text; when bytes were dropped, a marker sits between head and tail. */
  text(): string {
    const head = Buffer.concat(this.head).toString('utf8');
    const tail = Buffer.concat(this.tail).toString('utf8');
    if (this.omitted === 0) return head + tail;
    return `${head}\n... ${this.omitted} bytes omitted ...\n${tail}`;
  }
}

function approxTokenCount(text: string): number {
  return Math.ceil(Buffer.byteLength(text, 'utf8') / BYTES_PER_TOKEN);
}

/** Longest prefix of `text` whose UTF-8 size fits in `budget` bytes, cut on a code point boundary. */
function prefixWithin(text: string, budget: number): string {
  let bytes = 0;
  let end = 0;
  for (const ch of text) {
    const size = Buffer.byteLength(ch, 'utf8');
    if (bytes + size > budget) break;
    bytes += size;
    end += ch.length;
  }
  return text.slice(0, end);
}

function suffixWithin(text: string, budget: number): string {
  let bytes = 0;
  let start = text.length;
  const chars = [...text];
  for (let index = chars.length - 1; index >= 0; index--) {
    const ch = chars[index]!;
    const size = Buffer.byteLength(ch, 'utf8');
    if (bytes + size > budget) break;
    bytes += size;
    start -= ch.length;
  }
  return text.slice(start);
}

/** Keeps the start and end of `text` within about `maxTokens`, marking the removed middle in tokens. */
export function truncateToTokens(
  text: string,
  maxTokens: number
): { text: string; originalTokenCount: number | null } {
  const maxBytes = maxTokens * BYTES_PER_TOKEN;
  const totalBytes = Buffer.byteLength(text, 'utf8');
  if (totalBytes <= maxBytes) return { text, originalTokenCount: null };
  const leftBudget = Math.floor(maxBytes / 2);
  const rightBudget = maxBytes - leftBudget;
  const removedTokens = Math.ceil((totalBytes - maxBytes) / BYTES_PER_TOKEN);
  const marker = `…${removedTokens} tokens truncated…`;
  return {
    text: `${prefixWithin(text, leftBudget)}${marker}${suffixWithin(text, rightBudget)}`,
    originalTokenCount: approxTokenCount(text)
  };
}
