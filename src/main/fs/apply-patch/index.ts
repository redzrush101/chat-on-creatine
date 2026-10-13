import { promises as fs } from 'node:fs';
import { effectiveCapabilities } from '@shared/config';
import type { ToolOutputPart } from '@shared/types';
import { ToolError, textResult, type ToolContext, type ToolResult } from '../../mcp/tool';
import { commitPlan, planPatch } from './apply';
import { parsePatch, PatchParseError } from './parser';

/**
 * Runs a V4A patch: parse, plan in memory, then commit. `cwdOverride` is the directory a shell
 * `cd <dir> && apply_patch` named; relative paths in the patch resolve against it.
 */
export async function runApplyPatch(patch: string, ctx: ToolContext, cwdOverride: string | null = null): Promise<ToolResult> {
  let hunks;
  try {
    hunks = parsePatch(patch);
  } catch (error) {
    if (error instanceof PatchParseError) {
      throw new ToolError('PATCH_FAILED', `apply_patch verification failed: ${error.message}`);
    }
    throw error;
  }

  const { paths } = ctx.services;
  let cwd = ctx.caller?.cwd ?? null;
  if (cwdOverride !== null) {
    cwd = await paths.resolve(cwdOverride, { cwd, mustExist: true });
    if (!(await fs.stat(cwd)).isDirectory()) {
      throw new ToolError('INVALID_ARGUMENT', `apply_patch workdir '${cwdOverride}' is not a folder.`);
    }
  }

  const plan = await planPatch(hunks, { paths, cwd, capabilities: effectiveCapabilities(ctx.config) });
  await commitPlan(plan);

  const lines = ['Success. Updated the following files:'];
  lines.push(...plan.added.map((file) => `A ${file}`));
  lines.push(...plan.modified.map((file) => `M ${file}`));
  lines.push(...plan.deleted.map((file) => `D ${file}`));
  const display: ToolOutputPart[] = plan.files.map((file) => ({
    type: 'diff',
    path: file.path,
    diff: file.diff,
    added: file.added,
    removed: file.removed
  }));
  return textResult(lines.join('\n'), { display });
}

const INVOCATION_HEAD = /^(apply_patch|applypatch)[ \t]+/;
const HEREDOC_HEAD = /^<<(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1$/;

/**
 * Recognises `apply_patch <<'EOF' ... EOF`, `apply_patch "<patch>"`, each optionally preceded by
 * `cd <dir> &&`. Anything else (extra commands, pipes, expansions) is not an invocation, so the
 * caller runs it as an ordinary shell command.
 */
export function parseApplyPatchInvocationWithCwd(command: string): { patch: string; cd: string | null } | null {
  let cd: string | null = null;
  let at = skipBlanks(command, 0);

  const cdHead = /^cd[ \t]+/.exec(command.slice(at));
  if (cdHead) {
    const dir = readWord(command, at + cdHead[0].length);
    if (dir === null) return null;
    const ampersand = skipBlanks(command, dir.end);
    if (!command.startsWith('&&', ampersand)) return null;
    cd = dir.value;
    at = skipBlanks(command, ampersand + 2);
  }

  const head = INVOCATION_HEAD.exec(command.slice(at));
  if (!head) return null;
  at += head[0].length;

  if (command.startsWith('<<', at)) {
    const newline = command.indexOf('\n', at);
    if (newline === -1) return null;
    const heredoc = HEREDOC_HEAD.exec(command.slice(at, newline).trim());
    if (!heredoc) return null;
    const tag = heredoc[2];
    const lines = command.slice(newline + 1).split('\n');
    const close = lines.findIndex((line) => line.replace(/\r$/, '') === tag);
    if (close === -1 || lines.slice(close + 1).some((line) => line.trim() !== '')) return null;
    return { patch: lines.slice(0, close).join('\n').replace(/\n+$/, ''), cd };
  }

  const quoted = readWord(command, at);
  if (quoted === null || !/['"]/.test(command[at] ?? '') || command.slice(quoted.end).trim() !== '') return null;
  return { patch: quoted.value, cd };
}

function skipBlanks(text: string, from: number): number {
  let at = from;
  while (text[at] === ' ' || text[at] === '\t') at++;
  return at;
}

interface Word {
  value: string;
  end: number;
}

/** One shell word: bare, '...' or "...". Anything the shell would expand is refused. */
function readWord(text: string, at: number): Word | null {
  const quote = text[at];
  if (quote === "'" || quote === '"') {
    const close = text.indexOf(quote, at + 1);
    if (close === -1) return null;
    const value = text.slice(at + 1, close);
    if (quote === '"' && /[$`\\]/.test(value)) return null;
    return { value, end: close + 1 };
  }
  const bare = /^[^\s;&|<>()$`\\'"]+/.exec(text.slice(at));
  return bare ? { value: bare[0], end: at + bare[0].length } : null;
}
