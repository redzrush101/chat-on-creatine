import { glob, readFile, stat } from 'node:fs/promises';
import nodePath from 'node:path';

import { z } from 'zod';

import { effectiveCapabilities } from '@shared/config';
import {
  DEFAULT_READ_BYTES,
  MAX_IMAGE_BYTES,
  MAX_READ_BYTES,
  formatBytes,
  imageMimeOf,
  isBinarySample,
  listDirectory,
  readHead,
  readTextWindow,
  type ImageMime
} from '../../fs/files';
import { defineTool, ToolError, type PathGuard, type ToolContent, type ToolContext, type ToolResult } from '../tool';

const MAX_PATHS = 20;
const MAX_TARGETS = 40;
const MAX_GLOB_MATCHES = 20;
const GLOB_SCAN_LIMIT = 5_000;
const MAX_DIR_ENTRIES = 500;
const MAX_IMAGES = 4;
/** Base64 characters of images returned by one call. */
const MAX_IMAGE_BASE64 = 12 * 1024 * 1024;
const GLOB_CHARS = /[*?]/;
const GLOB_EXCLUDES = ['**/node_modules/**', '**/.git/**'];
const KIND_MARK = { dir: 'd', file: 'f', link: 'l', other: '?' } as const;

interface Target {
  path: string;
  start?: number;
  end?: number;
}

/** Splits a trailing `:12` or `:12-40` line range off a path. */
function splitLineRange(raw: string): Target {
  const match = /^(.*[^\\/:]):(\d{1,9})(?:-(\d{1,9}))?$/.exec(raw);
  if (!match) return { path: raw };
  const start = Number(match[2]);
  const end = match[3] === undefined ? undefined : Number(match[3]);
  if (start < 1 || (end !== undefined && end < start)) return { path: raw };
  return { path: match[1] ?? raw, start, end };
}

/** Expands a glob to canonical paths inside the roots. Returns a note when the expansion was bounded. */
async function expandGlob(
  pattern: string,
  cwd: string | null,
  guard: PathGuard
): Promise<{ matches: string[]; note: string | null }> {
  const segments = (process.platform === 'win32' ? pattern.replace(/\\/g, '/') : pattern).split('/');
  const firstGlob = segments.findIndex((segment) => GLOB_CHARS.test(segment));
  const base = segments.slice(0, firstGlob).join('/') || (pattern.startsWith('/') ? '/' : '.');
  const rest = segments.slice(firstGlob).join('/');
  const baseDir = await guard.resolve(base, { cwd, mustExist: true });

  const found: string[] = [];
  let scanned = 0;
  let scanStopped = false;
  for await (const relative of glob(rest, { cwd: baseDir, exclude: GLOB_EXCLUDES })) {
    if (++scanned > GLOB_SCAN_LIMIT) {
      scanStopped = true;
      break;
    }
    try {
      found.push(await guard.resolve(nodePath.join(baseDir, relative), { cwd: null, mustExist: true }));
    } catch {
      // A match that is a link leaving the roots is skipped, not reported.
    }
    if (found.length > MAX_GLOB_MATCHES) break;
  }

  const matches = [...new Set(found)].sort();
  if (matches.length === 0) {
    return {
      matches,
      note: scanStopped
        ? `${pattern}: scan stopped after ${GLOB_SCAN_LIMIT} entries before finding a match; narrow the pattern or start from a deeper folder`
        : `${pattern}: no matches`
    };
  }
  if (matches.length > MAX_GLOB_MATCHES) {
    return { matches: matches.slice(0, MAX_GLOB_MATCHES), note: `${pattern}: more than ${MAX_GLOB_MATCHES} matches, showing the first ${MAX_GLOB_MATCHES}; narrow the pattern` };
  }
  return { matches, note: scanStopped ? `${pattern}: scan stopped after ${GLOB_SCAN_LIMIT} entries; more matches may exist` : null };
}

interface Budget {
  /** Text bytes still available to this call. */
  remaining: number;
  images: number;
  imageBase64: number;
}

interface Section {
  text: string;
  bytes: number;
  summary: string;
  image?: { data: string; mimeType: ImageMime };
}

interface ReadArgs {
  start_line?: number | undefined;
  end_line?: number | undefined;
  max_bytes?: number | undefined;
}

function describeError(error: unknown): string {
  if (error instanceof ToolError) return error.message;
  const code = (error as NodeJS.ErrnoException).code;
  return `could not be read${code ? ` (${code})` : ''}`;
}

async function readTarget(target: Target, args: ReadArgs, cwd: string | null, guard: PathGuard, budget: Budget): Promise<Section> {
  const real = await guard.resolve(target.path, { cwd, mustExist: true });
  const info = await stat(real);

  if (info.isDirectory()) {
    const { entries, total } = await listDirectory(real, MAX_DIR_ENTRIES);
    const header = total === 0 ? `--- ${real} — empty folder ---` : `--- ${real} — ${total} entries, one level ---`;
    const body = entries
      .map((entry) => `${KIND_MARK[entry.kind]} ${entry.name}${entry.bytes === null ? '' : `  ${formatBytes(entry.bytes)}`}`)
      .join('\n');
    const note = total > entries.length ? `\n(showing the first ${entries.length} of ${total}; read a subfolder or use a glob)` : '';
    const text = total === 0 ? header : `${header}\n${body}${note}`;
    return { text, bytes: Buffer.byteLength(text, 'utf8'), summary: `${real}/ (${total} entries)` };
  }

  if (!info.isFile()) {
    const text = `--- ${real} ---\nNot a regular file, so there is nothing to read.`;
    return { text, bytes: Buffer.byteLength(text, 'utf8'), summary: real };
  }

  const size = formatBytes(info.size);
  const head = await readHead(real);
  const mime = imageMimeOf(real, head);
  if (mime) {
    if (info.size > MAX_IMAGE_BYTES) {
      throw new ToolError('LIMIT_EXCEEDED', `image is too large to return (${size}; limit ${formatBytes(MAX_IMAGE_BYTES)}). Crop or resize it first.`);
    }
    const projected = Math.ceil(info.size / 3) * 4;
    if (budget.images >= MAX_IMAGES || budget.imageBase64 + projected > MAX_IMAGE_BASE64) {
      throw new ToolError('LIMIT_EXCEEDED', 'image budget for this call is used up; read the rest in another call or with view_image');
    }
    const data = (await readFile(real)).toString('base64');
    budget.images++;
    budget.imageBase64 += data.length;
    const text = `--- ${real} — ${size} ${mime} ---`;
    return { text, bytes: Buffer.byteLength(text, 'utf8'), summary: `${real} (${size}, image)`, image: { data, mimeType: mime } };
  }

  if (info.size === 0) {
    const text = `--- ${real} — empty file ---`;
    return { text, bytes: Buffer.byteLength(text, 'utf8'), summary: `${real} (empty)` };
  }
  if (isBinarySample(head, info.size <= head.length)) {
    const text = `--- ${real} — ${size} ---\nBinary file, so its bytes are not returned. view_image shows PNG, JPEG, GIF and WebP files.`;
    return { text, bytes: Buffer.byteLength(text, 'utf8'), summary: `${real} (${size}, binary)` };
  }

  const window = await readTextWindow(real, info.size, {
    startLine: target.start ?? args.start_line ?? 1,
    endLine: target.end ?? args.end_line ?? Infinity,
    maxBytes: Math.min(args.max_bytes ?? DEFAULT_READ_BYTES, budget.remaining)
  });
  const lines =
    window.firstLine > window.lastLine
      ? 'no lines in that range'
      : `lines ${window.firstLine}-${window.lastLine}${window.totalLines === null ? '' : ` of ${window.totalLines}`}`;
  const more = window.hasMore ? `\n(more lines follow; continue with start_line=${window.lastLine + 1})` : '';
  const text = `--- ${real} — ${size}, ${lines} ---\n${window.text}${more}`;
  return { text, bytes: Buffer.byteLength(text, 'utf8'), summary: `${real} (${size}, ${lines})` };
}

function gate(ctx: ToolContext): void {
  if (!effectiveCapabilities(ctx.config).read) {
    throw new ToolError('TOOL_DISABLED', 'read is turned off. Ask the user to enable reading files in the app.');
  }
}

export const readTool = defineTool({
  name: 'read',
  surface: 'core',
  title: 'Read files and folders',
  description:
    'Read files and folders inside approved folders. A folder lists one level, directories first. A text file comes back as ' +
    'numbered lines under a header with its size and line count; the number prefix is display only, so strip it before quoting. ' +
    'PNG, JPEG, GIF and WebP files come back as images. Other binary files return only their size. ' +
    'Paths may use * ? ** globs (up to 20 matches each), and a path may carry its own range, as path:12-40. ' +
    `start_line and end_line apply to every file that has no range of its own. Text is capped at ${formatBytes(MAX_READ_BYTES)} per call and ` +
    `${formatBytes(DEFAULT_READ_BYTES)} per file unless max_bytes says otherwise. When a header says more lines follow, continue with start_line.`,
  input: {
    paths: z
      .array(z.string().min(1).max(4096))
      .min(1)
      .max(MAX_PATHS)
      .describe('Absolute paths, paths starting with ~, or paths relative to the working folder. Each must be inside an approved folder.'),
    start_line: z.number().int().min(1).optional().describe('First line, 1-based.'),
    end_line: z.number().int().min(1).optional().describe('Last line, inclusive.'),
    max_bytes: z
      .number()
      .int()
      .min(1)
      .max(MAX_READ_BYTES)
      .optional()
      .describe(`Per-file text cap. Default ${formatBytes(DEFAULT_READ_BYTES)}; maximum ${formatBytes(MAX_READ_BYTES)}.`)
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  exposed: (config) => effectiveCapabilities(config).read,
  async run(args, ctx): Promise<ToolResult> {
    gate(ctx);
    const cwd = ctx.caller?.cwd ?? null;
    const guard = ctx.services.paths;
    const notes: string[] = [];
    const targets: Target[] = [];

    for (const raw of args.paths) {
      if (targets.length >= MAX_TARGETS) {
        notes.push(`(stopped expanding at ${MAX_TARGETS} paths)`);
        break;
      }
      const target = splitLineRange(raw);
      if (!GLOB_CHARS.test(target.path)) {
        targets.push(target);
        continue;
      }
      const expanded = await expandGlob(target.path, cwd, guard);
      if (expanded.note) notes.push(expanded.note);
      for (const match of expanded.matches.slice(0, MAX_TARGETS - targets.length)) {
        targets.push({ ...target, path: match });
      }
    }

    const budget: Budget = { remaining: MAX_READ_BYTES, images: 0, imageBase64: 0 };
    const sections: string[] = [];
    const images: ToolContent[] = [];
    const summaries: string[] = [];
    let failures = 0;

    for (const target of targets) {
      ctx.signal.throwIfAborted();
      if (budget.remaining <= 0) {
        sections.push('(output cap reached; read the remaining paths in another call)');
        break;
      }
      try {
        const section = await readTarget(target, args, cwd, guard, budget);
        budget.remaining -= section.bytes;
        sections.push(section.text);
        summaries.push(section.summary);
        if (section.image) images.push({ type: 'image', data: section.image.data, mimeType: section.image.mimeType });
      } catch (error) {
        failures++;
        const message = describeError(error);
        sections.push(`--- ${target.path} — ERROR ---\n${message}`);
        summaries.push(`${target.path}: ${message}`);
      }
    }

    const text = [...sections, ...notes].join('\n\n') || 'Nothing to read.';
    return {
      content: [{ type: 'text', text }, ...images],
      isError: targets.length > 0 && failures === targets.length,
      display: [{ type: 'text', text: summaries.join('\n') || 'Nothing read.' }]
    };
  }
});
