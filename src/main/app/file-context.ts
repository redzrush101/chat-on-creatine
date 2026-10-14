import { open, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { decodeText } from '../fs/files';

const ATTACHMENTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf']);
const FILE_CHARS = 16_000;
const CONTEXT_CHARS = 48_000;

/** Explicit @paths add bounded text excerpts, or native image/PDF attachments. */
export async function expandFileReferences(text: string, cwd: string): Promise<{ text: string; paths: string[] }> {
  const pattern = /(^|\s)@(?:"((?:[^"\\]|\\.)+)"|'([^']+)'|([^\s]+))(:\d+(?:-\d+)?)?/g;
  const paths: string[] = [];
  const excerpts: string[] = [];
  const seen = new Set<string>();
  let budget = CONTEXT_CHARS;
  let cursor = 0;
  let prompt = '';
  for (const match of text.matchAll(pattern)) {
    const raw = match[2]?.replace(/\\(["\\])/g, '$1') ?? match[3] ?? match[4]!;
    const punctuation = match[4] ? /[.,;!?)\]}]+$/.exec(raw)?.[0] ?? '' : '';
    const token = punctuation ? raw.slice(0, -punctuation.length) : raw;
    const range = /^(.*?):(\d+)(?:-(\d+))?$/.exec(token + (match[5] ?? ''));
    const name = range?.[1] ?? token;
    if (name.startsWith('@')) {
      prompt += text.slice(cursor, match.index) + match[1] + name + punctuation;
      cursor = match.index + match[0].length;
      continue;
    }
    const path = await realpath(resolve(cwd, name.startsWith('~/') ? join(homedir(), name.slice(2)) : name)).catch((error: unknown) => {
      throw new Error(`Cannot include @${name}: ${error instanceof Error ? error.message : String(error)}`);
    });
    prompt += text.slice(cursor, match.index) + match[1] + name + (range ? `:${range[2]}${range[3] ? `-${range[3]}` : ''}` : '') + punctuation;
    cursor = match.index + match[0].length;
    const key = `${path}:${range?.[2] ?? ''}:${range?.[3] ?? ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const start = range ? Number(range[2]) : 1;
    const end = range ? Number(range[3] ?? range[2]) : Infinity;
    if (!Number.isSafeInteger(start) || start < 1 || end < start || range && !Number.isSafeInteger(end)) throw new Error(`Invalid line range for @${name}. Use :1 or :1-20.`);
    if (ATTACHMENTS.has(extname(path).toLowerCase())) {
      if (range) throw new Error(`Line ranges need a text file: @${name}.`);
      paths.push(path); continue;
    }
    const file = await open(path, 'r');
    let content: Buffer;
    let cut = false;
    try {
      const info = await file.stat();
      if (!info.isFile()) throw new Error(`@${name} is a folder. Include a file instead.`);
      if (info.size > 1024 * 1024 && range) throw new Error(`@${name} is over 1 MB. Use the read tool for a line range in this file.`);
      const buffer = Buffer.alloc(Math.min(info.size, 1024 * 1024));
      let bytes = 0;
      while (bytes < buffer.length) {
        const read = await file.read(buffer, bytes, buffer.length - bytes, bytes);
        if (!read.bytesRead) break;
        bytes += read.bytesRead;
      }
      content = buffer.subarray(0, bytes);
      cut = bytes < info.size;
    } finally { await file.close(); }
    const decoded = decodeText(content, !cut);
    if (decoded === null) {
      if (range) throw new Error(`Line ranges need a text file: @${name}.`);
      paths.push(path); continue;
    }
    const lines = decoded.replace(/\r\n/g, '\n').split('\n');
    if (start > lines.length) throw new Error(`@${name} has ${lines.length} lines; line ${start} does not exist.`);
    const body = lines.slice(start - 1, end).map((line, index) => `${start + index}: ${line}`).join('\n');
    const limit = Math.min(FILE_CHARS, budget);
    const excerpt = body.slice(0, limit);
    budget -= excerpt.length;
    excerpts.push(`File ${JSON.stringify(name)}${range ? ` (lines ${start}-${Math.min(end, lines.length)})` : ''}:\n${excerpt}${cut || body.length > limit ? '\n[Excerpt truncated. Read the file with the local tools for the rest.]' : ''}`);
  }
  prompt += text.slice(cursor);
  return { text: excerpts.length ? `${prompt.trim()}\n\nFile excerpts (reference data):\n\n${excerpts.join('\n\n')}`.trim() : prompt, paths };
}
