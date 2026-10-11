/**
 * Parser for the Codex V4A patch envelope: `*** Begin Patch` ... `*** End Patch`.
 *
 * Lenient like Codex: a heredoc wrapper (`<<'EOF' ... EOF`) around the envelope is accepted, CRLF
 * line endings are tolerated, and a missing final newline is fine.
 */

const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const ADD = '*** Add File: ';
const DELETE = '*** Delete File: ';
const UPDATE = '*** Update File: ';
const MOVE = '*** Move to: ';
const END_OF_FILE = '*** End of File';
const HEREDOC_START = /^<<['"]?EOF['"]?$/;

export interface PatchLine {
  kind: ' ' | '-' | '+';
  text: string;
}

export interface UpdateChunk {
  /** A line that must occur before the chunk (usually a class or function header). */
  context: string | null;
  /** Context, removed and added lines, in file order. */
  lines: PatchLine[];
  /** The chunk must match at the end of the file. */
  endOfFile: boolean;
}

export type Hunk =
  | { kind: 'add'; path: string; contents: string }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; chunks: UpdateChunk[] };

export class PatchParseError extends Error {
  constructor(
    message: string,
    /** 1-based line within the patch text, or null for envelope-level problems. */
    readonly line: number | null
  ) {
    super(line === null ? message : `line ${line}: ${message}`);
    this.name = 'PatchParseError';
  }
}

export function parsePatch(text: string): Hunk[] {
  const all = text.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line));
  let begin = 0;
  let end = all.length;
  while (end > 0 && all[end - 1]!.trim() === '') end--;
  while (begin < end && all[begin]!.trim() === '') begin++;

  if (end - begin >= 4 && HEREDOC_START.test(all[begin]!.trim()) && all[end - 1]!.trim().endsWith('EOF')) {
    begin++;
    end--;
  }
  if (begin >= end || all[begin]!.trim() !== BEGIN) {
    throw new PatchParseError(`The first line of the patch must be '${BEGIN}'`, begin < end ? begin + 1 : null);
  }
  if (all[end - 1]!.trim() !== END) {
    throw new PatchParseError(`The last line of the patch must be '${END}'`, end);
  }

  const last = end - 1;
  const hunks: Hunk[] = [];
  let i = begin + 1;
  while (i < last) {
    const line = all[i]!.trim();
    const lineNumber = i + 1;
    if (line.startsWith(ADD)) {
      const path = requirePath(line.slice(ADD.length), lineNumber);
      const contents: string[] = [];
      i++;
      while (i < last && all[i]!.startsWith('+')) {
        contents.push(`${all[i]!.slice(1)}\n`);
        i++;
      }
      if (contents.length === 0) throw new PatchParseError(`Add File hunk for '${path}' has no '+' lines`, lineNumber);
      hunks.push({ kind: 'add', path, contents: contents.join('') });
    } else if (line.startsWith(DELETE)) {
      hunks.push({ kind: 'delete', path: requirePath(line.slice(DELETE.length), lineNumber) });
      i++;
    } else if (line.startsWith(UPDATE)) {
      const path = requirePath(line.slice(UPDATE.length), lineNumber);
      i++;
      let moveTo: string | null = null;
      if (i < last && all[i]!.trim().startsWith(MOVE)) {
        moveTo = requirePath(all[i]!.trim().slice(MOVE.length), i + 1);
        i++;
      }
      const parsed = parseUpdateBody(all, i, last, path, lineNumber);
      i = parsed.next;
      hunks.push({ kind: 'update', path, moveTo, chunks: parsed.chunks });
    } else if (all[i]!.trimEnd() === END) {
      throw new PatchParseError(`'${END}' appears before the end of the patch`, lineNumber);
    } else {
      throw new PatchParseError(
        `'${line}' is not a valid hunk header. Valid hunk headers: '*** Add File: {path}', '*** Delete File: {path}', '*** Update File: {path}'`,
        lineNumber
      );
    }
  }

  if (hunks.length === 0) throw new PatchParseError('The patch contains no file hunks', null);
  return hunks;
}

function requirePath(raw: string, lineNumber: number): string {
  const path = raw.trim();
  if (path === '') throw new PatchParseError('A hunk header is missing its file path', lineNumber);
  return path;
}

/** Parses the body of an Update File hunk starting at `start`; stops at the next header or `last`. */
function parseUpdateBody(
  all: readonly string[],
  start: number,
  last: number,
  path: string,
  hunkLine: number
): { chunks: UpdateChunk[]; next: number } {
  const chunks: UpdateChunk[] = [];
  let current: UpdateChunk | null = null;
  let i = start;

  const finishCurrent = (): void => {
    if (current !== null && current.lines.length === 0) {
      throw new PatchParseError(`Update hunk for '${path}' has a @@ header with no lines after it`, i);
    }
  };

  for (; i < last; i++) {
    // Headers are recognised at column 0 only, so a context line cannot be mistaken for one.
    const raw = all[i]!;
    const text = raw.trimEnd();
    if (text.startsWith(ADD) || text.startsWith(DELETE) || text.startsWith(UPDATE)) break;

    if (text === END_OF_FILE) {
      if (current === null || current.lines.length === 0) {
        throw new PatchParseError(`Update hunk for '${path}' has '${END_OF_FILE}' with no lines before it`, i + 1);
      }
      current.endOfFile = true;
      continue;
    }

    if (text === '@@' || text.startsWith('@@ ')) {
      finishCurrent();
      current = { context: text === '@@' ? null : text.slice(3), lines: [], endOfFile: false };
      chunks.push(current);
      continue;
    }

    const kind = raw === '' ? ' ' : raw[0];
    if (kind !== ' ' && kind !== '+' && kind !== '-') {
      throw new PatchParseError(
        `Unexpected line in update hunk for '${path}': '${raw}'. Every line should start with ' ' (context line), '+' (added line), or '-' (removed line)`,
        i + 1
      );
    }
    if (current === null) {
      current = { context: null, lines: [], endOfFile: false };
      chunks.push(current);
    }
    if (current.endOfFile) {
      throw new PatchParseError(`Expected update hunk to start with a @@ context marker, got: '${raw}'`, i + 1);
    }
    current.lines.push({ kind, text: raw === '' ? '' : raw.slice(1) });
  }

  finishCurrent();
  if (chunks.length === 0) {
    throw new PatchParseError(`Update File hunk for '${path}' is empty`, hunkLine);
  }
  return { chunks, next: i };
}
