/**
 * Plans an apply_patch run in memory, then commits it. Nothing touches disk until every hunk has
 * resolved, permission-checked and matched, so a failing hunk leaves every file as it was.
 */

import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { Capabilities } from '@shared/config';
import { ToolError, type PathGuard } from '../../mcp/tool';
import type { Hunk, UpdateChunk } from './parser';
import { seekSequence } from './seek';

interface PatchPlan {
  /** Summary lines in Codex order: added, modified, deleted. */
  added: string[];
  modified: string[];
  deleted: string[];
  /** Per-file change as a unified diff. */
  files: FileChange[];
  /** Final content per absolute path; null means the file is removed. */
  writes: Map<string, string | null>;
}

interface FileChange {
  path: string;
  diff: string;
  added: number;
  removed: number;
}

interface Touched {
  abs: string;
  display: string;
  before: string | null;
  after: string | null;
}

interface PlanOptions {
  paths: PathGuard;
  cwd: string | null;
  capabilities: Capabilities;
}

export async function planPatch(hunks: readonly Hunk[], options: PlanOptions): Promise<PatchPlan> {
  const { paths, cwd, capabilities } = options;
  const touched = new Map<string, Touched>();
  const added: string[] = [];
  const modified: string[] = [];
  const deleted: string[] = [];

  const load = async (abs: string, display: string): Promise<string | null> => {
    let entry = touched.get(abs);
    if (entry === undefined) {
      const before = await readText(abs, display);
      entry = { abs, display, before, after: before };
      touched.set(abs, entry);
    }
    return entry.after;
  };
  const store = (abs: string, content: string | null): void => {
    touched.get(abs)!.after = content;
  };

  for (const [index, hunk] of hunks.entries()) {
    const label = `hunk ${index + 1} (${describe(hunk)})`;
    try {
      if (hunk.kind === 'add') {
        requireCapability(capabilities, 'create', 'add files');
        const abs = await paths.resolve(hunk.path, { cwd, mustExist: false });
        if ((await load(abs, hunk.path)) !== null) {
          throw new ToolError('PATCH_FAILED', `Cannot add '${hunk.path}': the file already exists.`);
        }
        store(abs, hunk.contents);
        added.push(hunk.path);
      } else if (hunk.kind === 'delete') {
        requireCapability(capabilities, 'delete', 'delete files');
        const abs = await paths.resolve(hunk.path, { cwd, mustExist: true });
        if ((await load(abs, hunk.path)) === null) {
          throw new ToolError('PATCH_FAILED', `Cannot delete '${hunk.path}': the file does not exist.`);
        }
        store(abs, null);
        deleted.push(hunk.path);
      } else {
        const abs = await paths.resolve(hunk.path, { cwd, mustExist: true });
        const original = await load(abs, hunk.path);
        if (original === null) {
          throw new ToolError('PATCH_FAILED', `Cannot update '${hunk.path}': the file does not exist.`);
        }
        const updated = applyChunks(original, hunk.chunks, hunk.path);
        const changed = updated !== original;

        if (hunk.moveTo === null) {
          if (changed) {
            requireCapability(capabilities, 'write', 'change files');
            store(abs, updated);
            modified.push(hunk.path);
          }
          continue;
        }

        requireCapability(capabilities, 'move', 'move files');
        if (changed) requireCapability(capabilities, 'write', 'change files');
        const dest = await paths.resolve(hunk.moveTo, { cwd, mustExist: false });
        if (dest === abs) {
          throw new ToolError('PATCH_FAILED', `Cannot move '${hunk.path}' onto itself.`);
        }
        if ((await load(dest, hunk.moveTo)) !== null) {
          throw new ToolError('PATCH_FAILED', `Cannot move '${hunk.path}' to '${hunk.moveTo}': the destination already exists.`);
        }
        store(abs, null);
        store(dest, updated);
        modified.push(hunk.moveTo);
      }
    } catch (error) {
      if (error instanceof ToolError && error.code === 'PATCH_FAILED') {
        throw new ToolError('PATCH_FAILED', `${label}: ${error.message}`);
      }
      throw error;
    }
  }

  const files: FileChange[] = [];
  const writes = new Map<string, string | null>();
  for (const [abs, entry] of touched) {
    if (entry.before === entry.after) continue;
    writes.set(abs, entry.after);
    files.push({ path: entry.display, ...describeChange(entry.display, entry.before, entry.after) });
  }
  return { added, modified, deleted, files, writes };
}

/** Writes the planned changes: new and moved-to files first, then removals, each atomically. */
export async function commitPlan(plan: PatchPlan): Promise<void> {
  for (const [abs, content] of plan.writes) {
    if (content !== null) await writeFileAtomic(abs, content);
  }
  for (const [abs, content] of plan.writes) {
    if (content === null) await fs.rm(abs, { force: true });
  }
}

function describe(hunk: Hunk): string {
  if (hunk.kind === 'add') return `Add File: ${hunk.path}`;
  if (hunk.kind === 'delete') return `Delete File: ${hunk.path}`;
  return `Update File: ${hunk.path}`;
}

function requireCapability(capabilities: Capabilities, capability: keyof Capabilities, action: string): void {
  if (!capabilities[capability]) {
    throw new ToolError('TOOL_DISABLED', `apply_patch cannot ${action}: the '${capability}' permission is off.`);
  }
}

async function readText(abs: string, display: string): Promise<string | null> {
  let bytes: Buffer;
  try {
    bytes = await fs.readFile(abs);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ToolError('PATCH_FAILED', `Failed to read '${display}': ${(error as Error).message}`);
  }
  if (bytes.includes(0)) {
    throw new ToolError('PATCH_FAILED', `'${display}' looks binary; apply_patch only edits text files.`);
  }
  return bytes.toString('utf8');
}

async function writeFileAtomic(target: string, content: string): Promise<void> {
  const dir = path.dirname(target);
  await fs.mkdir(dir, { recursive: true });
  let mode: number | null = null;
  try {
    mode = (await fs.stat(target)).mode & 0o7777;
  } catch {
    // A new file takes the default mode.
  }
  const temp = path.join(dir, `.${path.basename(target)}.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await fs.writeFile(temp, content, { encoding: 'utf8', flag: 'wx' });
    if (mode !== null) await fs.chmod(temp, mode);
    await fs.rename(temp, target);
  } catch (error) {
    await fs.rm(temp, { force: true });
    throw error;
  }
}

// ----------------------------------------------------------------- chunks

interface SourceLine {
  text: string;
  /** Line terminator as written in the file; empty only for an unterminated last line. */
  eol: string;
}

interface Replacement {
  start: number;
  length: number;
  lines: SourceLine[];
}

/** Applies update chunks to file text, keeping the file's line endings and final-newline state. */
function applyChunks(content: string, chunks: readonly UpdateChunk[], display: string): string {
  const source = splitLines(content);
  const finalNewline = content === '' || content.endsWith('\n');
  const preferred = source.find((line) => line.eol !== '')?.eol ?? '\n';
  const texts = source.map((line) => line.text);

  const replacements: Replacement[] = [];
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.context !== null) {
      const at = seekSequence(texts, [chunk.context], cursor, false);
      if (at === null) {
        throw new ToolError('PATCH_FAILED', `Failed to find context '${chunk.context}' in '${display}'. ${GUIDANCE}`);
      }
      cursor = at + 1;
    }

    const ops = [...chunk.lines];
    const oldOps = ops.filter((op) => op.kind !== '+');
    if (oldOps.length === 0) {
      // Pure insertion: appended at the end of the file, as Codex does.
      replacements.push({
        start: texts.length,
        length: 0,
        lines: ops.map((op) => ({ text: op.text, eol: preferred }))
      });
      continue;
    }

    let pattern = oldOps.map((op) => op.text);
    let found = seekSequence(texts, pattern, cursor, chunk.endOfFile);
    if (found === null && pattern.at(-1) === '') {
      // Diffs often end with an empty line standing for the final newline, which the file lacks.
      const trailing = ops.lastIndexOf(oldOps.at(-1)!);
      ops.splice(trailing, 1);
      pattern = pattern.slice(0, -1);
      found = seekSequence(texts, pattern, cursor, chunk.endOfFile);
    }
    if (found === null) {
      throw new ToolError(
        'PATCH_FAILED',
        `Failed to find expected lines in '${display}':\n${pattern.slice(0, 8).join('\n')}${pattern.length > 8 ? '\n… (truncated)' : ''}\n${GUIDANCE}`
      );
    }

    const lines: SourceLine[] = [];
    let index = found;
    for (const op of ops) {
      if (op.kind === ' ') {
        lines.push(source[index]!);
        index++;
      } else if (op.kind === '-') {
        index++;
      } else {
        lines.push({ text: op.text, eol: preferred });
      }
    }
    replacements.push({ start: found, length: pattern.length, lines });
    cursor = found + pattern.length;
  }

  const result: SourceLine[] = [];
  let position = 0;
  for (const replacement of replacements) {
    result.push(...source.slice(position, replacement.start), ...replacement.lines);
    position = replacement.start + replacement.length;
  }
  result.push(...source.slice(position));

  for (let index = 0; index < result.length - 1; index++) {
    if (result[index]!.eol === '') result[index]!.eol = preferred;
  }
  const lastLine = result.at(-1);
  if (lastLine !== undefined) lastLine.eol = finalNewline ? lastLine.eol || preferred : '';
  return result.map((line) => line.text + line.eol).join('');
}

const GUIDANCE = 'Quote the current file text exactly for context and removed lines; do not reformat them.';

function splitLines(content: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  while (start < content.length) {
    const newline = content.indexOf('\n', start);
    if (newline === -1) {
      lines.push({ text: content.slice(start), eol: '' });
      break;
    }
    const crlf = newline > start && content[newline - 1] === '\r';
    lines.push({ text: content.slice(start, crlf ? newline - 1 : newline), eol: crlf ? '\r\n' : '\n' });
    start = newline + 1;
  }
  return lines;
}

// ------------------------------------------------------------------- diff

const CONTEXT = 3;
/** Above this many cells the LCS table is skipped and the middle is shown as a full replacement. */
const LCS_CELL_LIMIT = 2_000_000;

type Op = { tag: ' ' | '-' | '+'; text: string };

/** Unified diff plus added and removed line counts for one file. */
function describeChange(display: string, before: string | null, after: string | null): Omit<FileChange, 'path'> {
  const ops = diffLines(toLines(before ?? ''), toLines(after ?? ''));
  const added = ops.filter((op) => op.tag === '+').length;
  const removed = ops.filter((op) => op.tag === '-').length;
  const header = [
    `--- ${before === null ? '/dev/null' : `a/${display}`}`,
    `+++ ${after === null ? '/dev/null' : `b/${display}`}`
  ];
  return { diff: [...header, ...renderHunks(ops)].join('\n') + '\n', added, removed };
}

function toLines(content: string): string[] {
  if (content === '') return [];
  const lines = content.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

function diffLines(a: string[], b: string[]): Op[] {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) {
    suffix++;
  }
  const middleA = a.slice(prefix, a.length - suffix);
  const middleB = b.slice(prefix, b.length - suffix);

  const ops: Op[] = a.slice(0, prefix).map((text) => ({ tag: ' ', text }));
  ops.push(...lcsOps(middleA, middleB));
  ops.push(...a.slice(a.length - suffix).map((text) => ({ tag: ' ' as const, text })));
  return ops;
}

function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n === 0 || m === 0 || (n + 1) * (m + 1) > LCS_CELL_LIMIT) {
    return [...a.map((text) => ({ tag: '-' as const, text })), ...b.map((text) => ({ tag: '+' as const, text }))];
  }
  const width = m + 1;
  const table = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * width + j] =
        a[i] === b[j] ? table[(i + 1) * width + j + 1]! + 1 : Math.max(table[(i + 1) * width + j]!, table[i * width + j + 1]!);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ tag: ' ', text: a[i]! });
      i++;
      j++;
    } else if (table[(i + 1) * width + j]! >= table[i * width + j + 1]!) {
      ops.push({ tag: '-', text: a[i]! });
      i++;
    } else {
      ops.push({ tag: '+', text: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ tag: '-', text: a[i++]! });
  while (j < m) ops.push({ tag: '+', text: b[j++]! });
  return ops;
}

function renderHunks(ops: Op[]): string[] {
  const out: string[] = [];
  const changed = ops.flatMap((op, index) => (op.tag === ' ' ? [] : [index]));
  let group: [number, number] | null = null;
  const groups: [number, number][] = [];
  for (const index of changed) {
    if (group !== null && index - group[1] <= 2 * CONTEXT) group[1] = index;
    else {
      if (group !== null) groups.push(group);
      group = [index, index];
    }
  }
  if (group !== null) groups.push(group);

  for (const [first, last] of groups) {
    const from = Math.max(0, first - CONTEXT);
    const to = Math.min(ops.length - 1, last + CONTEXT);
    let oldBefore = 0;
    let newBefore = 0;
    for (let index = 0; index < from; index++) {
      if (ops[index]!.tag !== '+') oldBefore++;
      if (ops[index]!.tag !== '-') newBefore++;
    }
    let oldCount = 0;
    let newCount = 0;
    const body: string[] = [];
    for (let index = from; index <= to; index++) {
      const op = ops[index]!;
      if (op.tag !== '+') oldCount++;
      if (op.tag !== '-') newCount++;
      body.push(`${op.tag}${op.text}`);
    }
    const range = (start: number, count: number): string => `${count === 0 ? start : start + 1},${count}`;
    out.push(`@@ -${range(oldBefore, oldCount)} +${range(newBefore, newCount)} @@`, ...body);
  }
  return out;
}
