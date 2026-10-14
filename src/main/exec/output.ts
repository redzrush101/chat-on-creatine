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
    if (this.omitted === 0) return Buffer.concat([...this.head, ...this.tail]).toString('utf8');
    const head = new TextDecoder().decode(Buffer.concat(this.head), { stream: true });
    const bytes = Buffer.concat(this.tail);
    let start = 0;
    while (start < bytes.length && (bytes[start]! & 0xc0) === 0x80) start++;
    const tail = bytes.subarray(start).toString('utf8');
    return `${head}\n... ${this.omitted} bytes omitted ...\n${tail}`;
  }
}

/** Keeps the start and end of `text` within about `maxTokens`, marking the removed middle in tokens. */
export function truncateToTokens(
  text: string,
  maxTokens: number
): { text: string; originalTokenCount: number | null } {
  const maxBytes = maxTokens * BYTES_PER_TOKEN;
  const totalBytes = Buffer.byteLength(text, 'utf8');
  if (totalBytes <= maxBytes) return { text, originalTokenCount: null };
  const bytes = Buffer.from(text, 'utf8');
  let end = Math.floor(maxBytes / 2);
  let start = totalBytes - (maxBytes - end);
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  while (start < totalBytes && (bytes[start]! & 0xc0) === 0x80) start++;
  const removedTokens = Math.ceil((totalBytes - maxBytes) / BYTES_PER_TOKEN);
  const marker = `…${removedTokens} tokens truncated…`;
  return {
    text: `${bytes.subarray(0, end).toString('utf8')}${marker}${bytes.subarray(start).toString('utf8')}`,
    originalTokenCount: Math.ceil(totalBytes / BYTES_PER_TOKEN)
  };
}
