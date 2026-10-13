import { execFile } from 'node:child_process';
import { open } from 'node:fs/promises';
import path from 'node:path';
import { childEnv } from '../exec/env';
import type { GitStatus, ReviewTarget } from '@shared/types';

const TIMEOUT_MS = 15_000;
const MAX_STATUS_BYTES = 4 * 1024 * 1024;
const MAX_DIFF_BYTES = 1024 * 1024;
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';
/** Untracked files are counted line by line; beyond these caps the totals stay a lower bound. */
const MAX_COUNTED_UNTRACKED = 200;
const MAX_COUNTED_BYTES = 1024 * 1024;

interface GitRun {
  code: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

/** Repository-selecting variables from the launching shell must not redirect reads elsewhere. */
const GIT_ENV = childEnv({ GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' });
for (const key of Object.keys(GIT_ENV)) {
  if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|COMMON_DIR|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES)$/.test(key)) delete GIT_ENV[key];
}

function runGit(cwd: string, args: string[], maxBytes: number): Promise<GitRun> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['-c', 'core.quotepath=off', ...args],
      { cwd, env: GIT_ENV, encoding: 'utf8', maxBuffer: maxBytes, timeout: TIMEOUT_MS, windowsHide: true },
      (error, stdout, stderr) => {
        if (!error) return resolve({ code: 0, stdout, stderr, truncated: false });
        if (error.code === 'ERR_CHILD_PROCESS_STDOUT_BUFFER_MAXBUFFER') {
          return resolve({ code: 0, stdout, stderr, truncated: true });
        }
        if (typeof error.code === 'number') return resolve({ code: error.code, stdout, stderr, truncated: false });
        reject(error.killed ? new Error('Git took too long to respond') : error);
      }
    );
  });
}

/**
 * `git status` of a folder, which may be a subfolder of its repository: only changes inside it,
 * with paths relative to it. A folder outside any repository reports `isRepo: false`.
 */
export async function gitStatus(dir: string): Promise<GitStatus> {
  const run = await runGit(
    dir,
    ['status', '--porcelain=v1', '-z', '-b', '--untracked-files=all', '--ignore-submodules=dirty', '--', '.'],
    MAX_STATUS_BYTES
  );
  if (run.code !== 0) {
    if (/not a git repository/i.test(run.stderr)) {
      return { isRepo: false, branch: null, ahead: 0, behind: 0, changes: [], added: 0, removed: 0 };
    }
    throw new Error(run.stderr || `git status failed with code ${run.code}`);
  }

  // Porcelain paths are relative to the repository root, whatever folder git runs in.
  const prefix = (await runGit(dir, ['rev-parse', '--show-prefix'], 4096)).stdout.trim();
  const status: GitStatus = { isRepo: true, branch: null, ahead: 0, behind: 0, changes: [], added: 0, removed: 0 };
  const records = run.stdout.split('\0');
  let index = 0;
  if (records[0]?.startsWith('## ')) {
    parseBranchLine(records[0].slice(3), status);
    index = 1;
  }
  for (; index < records.length; index++) {
    const record = records[index]!;
    if (record.length < 4) continue;
    const code = record.slice(0, 2);
    const file = record.slice(3);
    status.changes.push({ status: code, path: file.startsWith(prefix) ? file.slice(prefix.length) : file });
    // In -z output a rename or copy is followed by its source path as a separate record.
    if (code.includes('R') || code.includes('C')) index++;
  }
  await addLineTotals(dir, status);
  return status;
}

/** Lines added and removed in the working tree against HEAD, untracked files counted as added. */
async function addLineTotals(dir: string, status: GitStatus): Promise<void> {
  if (status.changes.length === 0) return;
  const hasHead = (await runGit(dir, ['rev-parse', '--verify', '--quiet', 'HEAD'], 4096)).code === 0;
  const numstat = await runGit(dir, ['diff', '--numstat', '--relative', '--no-ext-diff', '-M', hasHead ? 'HEAD' : EMPTY_TREE], MAX_STATUS_BYTES);
  for (const line of numstat.code === 0 ? numstat.stdout.split('\n') : []) {
    const [added, removed] = line.split('\t');
    // Binary files report `-` for both counts.
    status.added += Number(added) || 0;
    status.removed += Number(removed) || 0;
  }
  const untracked = status.changes.filter((change) => change.status === '??').slice(0, MAX_COUNTED_UNTRACKED);
  const counts = await Promise.all(untracked.map((change) => countLines(path.join(dir, change.path))));
  for (const count of counts) status.added += count;
}

async function countLines(file: string): Promise<number> {
  try {
    const handle = await open(file, 'r');
    try {
      const buffer = Buffer.alloc(MAX_COUNTED_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, MAX_COUNTED_BYTES, 0);
      const bytes = buffer.subarray(0, bytesRead);
      if (bytes.includes(0)) return 0;
      let lines = 0;
      for (const byte of bytes) if (byte === 10) lines++;
      return bytesRead > 0 && bytes[bytesRead - 1] !== 10 ? lines + 1 : lines;
    } finally {
      await handle.close();
    }
  } catch {
    return 0;
  }
}

/** Line shapes: `main...origin/main [ahead 1, behind 2]`, `main`, `No commits yet on main`, `HEAD (no branch)`. */
function parseBranchLine(line: string, status: GitStatus): void {
  const tracking = /\s\[([^\]]*)\]$/.exec(line);
  const head = tracking ? line.slice(0, tracking.index) : line;
  for (const part of tracking?.[1]?.split(',') ?? []) {
    const match = /^\s*(ahead|behind) (\d+)\s*$/.exec(part);
    if (!match) continue;
    if (match[1] === 'ahead') status.ahead = Number(match[2]);
    else status.behind = Number(match[2]);
  }
  const dots = head.indexOf('...');
  const local = (dots === -1 ? head : head.slice(0, dots)).replace(/^No commits yet on /, '');
  status.branch = local && !local.startsWith('HEAD (no branch') ? local : null;
}

/**
 * Unified diff of one file's working-tree content against HEAD. A file git does not track is
 * shown as entirely added. Output is capped at 1 MB.
 */
export async function gitDiff(dir: string, file: string): Promise<string> {
  const full = path.resolve(dir, file);
  const relative = path.relative(dir, full);
  if (!relative || path.isAbsolute(relative) || relative.split(path.sep)[0] === '..') {
    throw new Error('Choose a file inside the repository folder');
  }
  const pathspec = `:(literal)${relative.split(path.sep).join('/')}`;

  const hasHead = (await runGit(dir, ['rev-parse', '--verify', '--quiet', 'HEAD'], 4096)).code === 0;
  const diff = await runGit(
    dir,
    ['diff', '--no-ext-diff', '--no-color', '--no-textconv', hasHead ? 'HEAD' : EMPTY_TREE, '--', pathspec],
    MAX_DIFF_BYTES
  );
  if (diff.code !== 0) throw new Error(diff.stderr || `git diff failed with code ${diff.code}`);
  if (diff.stdout) return withTruncationNote(diff);

  const tracked = await runGit(dir, ['ls-files', '--', pathspec], 4096);
  if (tracked.stdout.trim()) return '';

  // `git diff --no-index` exits 1 when the files differ, which is the normal case here.
  const added = await runGit(
    dir,
    ['diff', '--no-index', '--no-ext-diff', '--no-color', '--', '/dev/null', relative],
    MAX_DIFF_BYTES
  );
  if (added.code > 1) throw new Error(added.stderr || `git diff failed with code ${added.code}`);
  return withTruncationNote(added);
}

function withTruncationNote(run: GitRun): string {
  return run.truncated ? `${run.stdout}\n[diff truncated at 1 MB]\n` : run.stdout;
}

/** Freeze review revisions so branch names and Git options cannot change the selected scope. */
export async function resolveReviewTarget(dir: string, target: ReviewTarget): Promise<ReviewTarget> {
  const repo = await runGit(dir, ['rev-parse', '--is-inside-work-tree'], 4096);
  if (repo.code !== 0 || repo.stdout.trim() !== 'true') throw new Error('Code review needs a Git working tree. Choose one with -C or /cd.');
  if (target.kind === 'uncommitted') return target;
  const revision = await runGit(dir, ['rev-parse', '--verify', '--end-of-options', `${target.revision}^{commit}`], 4096);
  if (revision.code !== 0) throw new Error('That review revision is not a commit. Choose an existing branch, tag or commit.');
  if (target.kind === 'commit') return { kind: 'commit', revision: revision.stdout.trim() };
  const base = await runGit(dir, ['merge-base', 'HEAD', revision.stdout.trim()], 4096);
  if (base.code !== 0) throw new Error('The base revision and HEAD have no common ancestor. Choose another base.');
  return { kind: 'base', revision: base.stdout.trim() };
}
