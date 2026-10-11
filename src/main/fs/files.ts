import { createReadStream } from 'node:fs';
import { open, readdir, stat } from 'node:fs/promises';
import nodePath from 'node:path';
import { createInterface } from 'node:readline';

export const DEFAULT_READ_BYTES = 256 * 1024;
export const MAX_READ_BYTES = 512 * 1024;
/** Raw image bytes; base64 of this stays inside an 8 MiB wire envelope. */
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024;

const SNIFF_BYTES = 8192;
/** Files up to this size get a full line count; larger ones report the range only. */
const COUNT_LINES_BYTES = 4 * 1024 * 1024;

export type ImageMime = 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

/** The first bytes of a file, enough to sniff its type. */
export async function readHead(realPath: string, length = SNIFF_BYTES): Promise<Buffer> {
  const handle = await open(realPath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

/**
 * A sample is binary when it holds a NUL byte or is not valid UTF-8. A sample cut in the middle of
 * a character is still text when more of the file follows, so up to three trailing bytes may be
 * an incomplete sequence.
 */
export function isBinarySample(sample: Buffer, complete: boolean): boolean {
  if (sample.includes(0)) return true;
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const cuts = complete ? [0] : [0, 1, 2, 3];
  return !cuts.some((cut) => {
    try {
      decoder.decode(sample.subarray(0, Math.max(0, sample.length - cut)));
      return true;
    } catch {
      return false;
    }
  });
}

export function sniffImage(head: Buffer): ImageMime | null {
  const ascii = (start: number, end: number) => head.subarray(start, end).toString('latin1');
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'image/png';
  }
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 6 && (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a')) return 'image/gif';
  if (head.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** An image is recognised by an image extension and by the bytes it actually starts with. */
export function imageMimeOf(filePath: string, head: Buffer): ImageMime | null {
  if (!IMAGE_EXTENSIONS.has(nodePath.extname(filePath).toLowerCase())) return null;
  return sniffImage(head);
}

export interface TextWindow {
  /** Numbered lines, `N<TAB>text`, within the byte budget. */
  text: string;
  firstLine: number;
  lastLine: number;
  /** Null for large files where counting to the end was not worth it. */
  totalLines: number | null;
  /** A line exists after `lastLine` that was not returned. */
  hasMore: boolean;
}

/**
 * Streams a UTF-8 text file and returns the requested line window, numbered. The file is never
 * loaded whole, so a range from a large log stays cheap.
 */
export async function readTextWindow(
  realPath: string,
  size: number,
  options: { startLine: number; endLine: number; maxBytes: number }
): Promise<TextWindow> {
  const countAll = size <= COUNT_LINES_BYTES;
  const stream = createReadStream(realPath, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  const out: string[] = [];
  let bytes = 0;
  let lineNo = 0;
  let firstLine = 0;
  let lastLine = 0;
  let stopped = false;
  let hasMore = false;
  try {
    for await (const line of lines) {
      lineNo++;
      if (lineNo >= options.startLine && lineNo <= options.endLine && !stopped) {
        let rendered = `${lineNo}\t${line}`;
        const cost = Buffer.byteLength(rendered, 'utf8') + 1;
        if (out.length > 0 && bytes + cost > options.maxBytes) {
          stopped = true;
        } else {
          // One line larger than the whole budget is clipped rather than returned whole.
          if (cost > options.maxBytes) rendered = `${rendered.slice(0, options.maxBytes)} [line cut]`;
          out.push(rendered);
          bytes += Math.min(cost, options.maxBytes);
          firstLine ||= lineNo;
          lastLine = lineNo;
        }
      }
      if (stopped || lineNo > options.endLine) {
        hasMore = true;
        if (!countAll) break;
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  if (firstLine === 0) {
    firstLine = options.startLine;
    lastLine = options.startLine - 1;
  }
  return {
    text: out.join('\n'),
    firstLine,
    lastLine,
    totalLines: countAll ? lineNo : null,
    hasMore
  };
}

export interface DirectoryEntry {
  name: string;
  kind: 'dir' | 'file' | 'link' | 'other';
  bytes: number | null;
}

/** One level of a folder, directories first, then by name. Sizes are read for files only. */
export async function listDirectory(
  realDir: string,
  maxEntries: number
): Promise<{ entries: DirectoryEntry[]; total: number }> {
  const dirents = await readdir(realDir, { withFileTypes: true });
  dirents.sort((a, b) => {
    const dirOrder = Number(b.isDirectory()) - Number(a.isDirectory());
    return dirOrder !== 0 ? dirOrder : a.name.localeCompare(b.name);
  });
  const entries = await Promise.all(
    dirents.slice(0, maxEntries).map(async (dirent): Promise<DirectoryEntry> => {
      if (dirent.isDirectory()) return { name: dirent.name, kind: 'dir', bytes: null };
      if (dirent.isSymbolicLink()) return { name: dirent.name, kind: 'link', bytes: null };
      if (!dirent.isFile()) return { name: dirent.name, kind: 'other', bytes: null };
      const bytes = await stat(nodePath.join(realDir, dirent.name))
        .then((info) => info.size)
        .catch(() => null);
      return { name: dirent.name, kind: 'file', bytes };
    })
  );
  return { entries, total: dirents.length };
}
