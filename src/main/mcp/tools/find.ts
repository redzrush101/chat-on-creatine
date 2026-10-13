import { spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import nodePath from 'node:path';
import readline from 'node:readline';

import { z } from 'zod';

import { effectiveCapabilities, type Config } from '@shared/config';
import { NO_ROOTS_MESSAGE } from '../../fs/roots';
import { defineTool, ToolError, type ToolContext, type ToolResult } from '../tool';

const TIMEOUT_MS = 10_000;
const MAX_LINE_CHARS = 300;
const MAX_CONTENT_FILE_BYTES = '2M';
const FALLBACK_ENTRY_LIMIT = 50_000;
const EXCLUDED_DIRS = [
  'node_modules', '.git', 'dist', 'build', 'out', 'target', '.next', '.venv', 'venv', '__pycache__', 'coverage', '.idea', '.vscode'
];
const GLOB_CHARS = /[*?]/;

interface Hit {
  path: string;
  line?: number;
  text?: string;
}

interface Query {
  mode: 'files' | 'content';
  pattern: string;
  glob: string | null;
  caseSensitive: boolean;
  limit: number;
}

type Stop = 'limit' | 'timeout' | 'scan' | null;

function fold(value: string, caseSensitive: boolean): string {
  return caseSensitive ? value : value.toLowerCase();
}

function isGlobPattern(pattern: string): boolean {
  return GLOB_CHARS.test(pattern);
}

/** Runs ripgrep, handing each stdout line to `onLine`; returning true stops the search. */
function runRipgrep(args: string[], signal: AbortSignal, onLine: (line: string) => boolean): Promise<Stop> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.CREATINE_RG || 'rg', args, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    let stop: Stop = null;
    const kill = () => child.kill();
    const timer = setTimeout(() => {
      stop = 'timeout';
      child.kill();
    }, TIMEOUT_MS);
    signal.addEventListener('abort', kill, { once: true });
    const lines = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    const cleanup = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', kill);
      lines.close();
    };
    lines.on('line', (line) => {
      if (stop === null && onLine(line)) {
        stop = 'limit';
        child.kill();
      }
    });
    child.once('error', (error) => {
      cleanup();
      reject(error);
    });
    child.once('close', (code) => {
      cleanup();
      // ripgrep exits 1 for "no matches"; a deliberate kill can exit with any code.
      if (stop !== null || code === 0 || code === 1) resolve(stop);
      else reject(new ToolError('FAILED', 'search failed'));
    });
  });
}

function excludeArgs(): string[] {
  return EXCLUDED_DIRS.flatMap((dir) => ['--glob', `!${dir}`]);
}

async function searchWithRipgrep(query: Query, targets: string[], signal: AbortSignal, hits: Hit[]): Promise<Stop> {
  const globFlag = query.caseSensitive ? '--glob' : '--iglob';
  const globArgs = query.glob ? [globFlag, query.glob] : [];

  if (query.mode === 'files') {
    const nameGlob = isGlobPattern(query.pattern) ? [globFlag, query.pattern] : [];
    const args = ['--files', '--hidden', '--no-ignore', '--no-config', ...excludeArgs(), ...globArgs, ...nameGlob, '--', ...targets];
    const substring = !isGlobPattern(query.pattern) ? fold(query.pattern, query.caseSensitive) : null;
    return runRipgrep(args, signal, (line) => {
      if (substring !== null && !fold(nodePath.basename(line), query.caseSensitive).includes(substring)) return false;
      hits.push({ path: line });
      return hits.length >= query.limit;
    });
  }

  const args = [
    '--json',
    '--line-number',
    '--color',
    'never',
    '--no-config',
    '--hidden',
    '--no-ignore',
    '--max-filesize',
    MAX_CONTENT_FILE_BYTES,
    '--fixed-strings',
    ...(query.caseSensitive ? [] : ['--ignore-case']),
    ...excludeArgs(),
    ...globArgs,
    '--',
    query.pattern,
    ...targets
  ];
  return runRipgrep(args, signal, (line) => {
    let event: { type?: string; data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } } };
    try {
      event = JSON.parse(line);
    } catch {
      return false;
    }
    if (event.type !== 'match') return false;
    hits.push({
      path: event.data?.path?.text ?? '',
      line: event.data?.line_number,
      text: (event.data?.lines?.text ?? '').replace(/\r?\n$/, '').trim().slice(0, MAX_LINE_CHARS)
    });
    return hits.length >= query.limit;
  });
}

/** Filename search without ripgrep: a bounded walk that skips build and dependency folders. */
async function searchNamesInNode(query: Query, target: string, signal: AbortSignal, hits: Hit[], deadline: number): Promise<Stop> {
  const globFilter = (relative: string): boolean => {
    if (!query.glob) return true;
    return nodePath.matchesGlob(relative, query.glob.includes('/') ? query.glob : `**/${query.glob}`);
  };
  const nameFilter = (name: string, relative: string): boolean => {
    if (isGlobPattern(query.pattern)) {
      return nodePath.matchesGlob(query.pattern.includes('/') ? relative : name, query.pattern);
    }
    return fold(name, query.caseSensitive).includes(fold(query.pattern, query.caseSensitive));
  };

  const info = await stat(target).catch(() => null);
  if (info?.isFile()) {
    const name = nodePath.basename(target);
    if (nameFilter(name, name) && globFilter(name)) hits.push({ path: target });
    return null;
  }

  const stack: Array<{ dir: string; relative: string }> = [{ dir: target, relative: '' }];
  let scanned = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) break;
    let entries;
    try {
      entries = await readdir(current.dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (signal.aborted) return 'timeout';
      if (Date.now() > deadline) return 'timeout';
      if (++scanned > FALLBACK_ENTRY_LIMIT) return 'scan';
      const relative = current.relative ? `${current.relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.includes(entry.name)) stack.push({ dir: nodePath.join(current.dir, entry.name), relative });
      } else if (entry.isFile() && nameFilter(entry.name, relative) && globFilter(relative)) {
        hits.push({ path: nodePath.join(current.dir, entry.name) });
        if (hits.length >= query.limit) return 'limit';
      }
    }
  }
  return null;
}

function stopNote(stop: Stop, limit: number): string {
  if (stop === 'limit') return `(stopped at ${limit} results; narrow the pattern or raise max_results)`;
  if (stop === 'timeout') return '(search stopped after the time limit; narrow the path)';
  if (stop === 'scan') return `(stopped after ${FALLBACK_ENTRY_LIMIT} entries; narrow the path)`;
  return '';
}

async function resolveScopes(path: string | undefined, ctx: ToolContext): Promise<string[]> {
  const guard = ctx.services.paths;
  const cwd = ctx.caller?.cwd ?? null;
  if (path !== undefined) return [await guard.resolve(path, { cwd, mustExist: true })];
  if (cwd !== null) return [await guard.resolve(cwd, { cwd: null, mustExist: true })];
  const roots = await guard.roots();
  if (roots.length === 0) throw new ToolError('PATH_NOT_ALLOWED', NO_ROOTS_MESSAGE);
  return roots;
}

function gate(config: Config): void {
  const caps = effectiveCapabilities(config);
  if (!caps.search || caps.exec) {
    throw new ToolError('TOOL_DISABLED', 'find is not available here; it is used only when search is on and command execution is off.');
  }
}

export const findTool = defineTool({
  name: 'find',
  surface: 'core',
  title: 'Find files or text',
  description:
    'Find files by name, or find literal text inside files, without running a command. ' +
    'mode "files" (default) matches names: a plain pattern is a substring, a pattern with * or ? is a glob such as *.test.ts. ' +
    'mode "content" matches the pattern as fixed text and returns path:line: text; files over 2 MB are skipped. ' +
    'glob limits which files are searched, e.g. **/*.ts. Searches the path, else the working folder, else every approved folder. ' +
    'Build and dependency folders (node_modules, .git, dist, ...) are skipped.',
  input: {
    pattern: z.string().min(1).max(1000).describe('Name substring or glob (files mode), or literal text (content mode).'),
    path: z.string().min(1).max(4096).optional().describe('File or folder to search. Must be inside an approved folder.'),
    glob: z.string().min(1).max(200).optional().describe('Only search files whose path matches, e.g. **/*.ts.'),
    mode: z.enum(['files', 'content']).optional().describe('Default files.'),
    case_sensitive: z.boolean().optional().describe('Default false.'),
    max_results: z.number().int().min(1).max(500).optional().describe('Default 50.')
  },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  exposed: (config) => {
    const caps = effectiveCapabilities(config);
    return caps.search && !caps.exec;
  },
  async run(args, ctx): Promise<ToolResult> {
    gate(ctx.config);
    const query: Query = {
      mode: args.mode ?? 'files',
      pattern: args.pattern,
      glob: args.glob ?? null,
      caseSensitive: args.case_sensitive ?? false,
      limit: args.max_results ?? 50
    };
    const scopes = await resolveScopes(args.path, ctx);
    const hits: Hit[] = [];
    let stop: Stop = null;

    try {
      stop = await searchWithRipgrep(query, scopes, ctx.signal, hits);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (query.mode === 'content') {
        throw new ToolError('FAILED', 'content search needs ripgrep (rg) on PATH, or CREATINE_RG set to its path');
      }
      const deadline = Date.now() + TIMEOUT_MS;
      for (const scope of scopes) {
        stop = await searchNamesInNode(query, scope, ctx.signal, hits, deadline);
        if (stop !== null) break;
      }
    }

    const noun = query.mode === 'files' ? 'files' : 'matches';
    const lines = hits.map((hit) => (hit.line === undefined ? hit.path : `${hit.path}:${hit.line}: ${hit.text ?? ''}`));
    const body = hits.length === 0 ? `No ${noun}.` : `${hits.length} ${noun}\n${lines.join('\n')}`;
    const note = stopNote(stop, query.limit);
    return { content: [{ type: 'text', text: note ? `${body}\n${note}` : body }] };
  }
});
