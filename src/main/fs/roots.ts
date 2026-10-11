import { realpathSync } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import os from 'node:os';
import nodePath from 'node:path';

import type { Config } from '@shared/config';
import { ToolError, type PathGuard } from '../mcp/tool';

export const NO_ROOTS_MESSAGE = 'No folders are approved. Approve a folder in Settings → Workspace, then try again.';

const CASE_INSENSITIVE = process.platform === 'win32' || process.platform === 'darwin';

function fold(p: string): string {
  return CASE_INSENSITIVE ? p.toLowerCase() : p;
}

/** True when `child` is `parent` or lies below it. Both paths must be absolute and canonical. */
export function isInside(parent: string, child: string): boolean {
  const rel = nodePath.relative(fold(parent), fold(child));
  if (rel === '') return true;
  if (nodePath.isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${nodePath.sep}`);
}

function expandHome(p: string): string {
  if (p === '~') return os.homedir();
  if (p.startsWith('~/') || p.startsWith('~\\')) return nodePath.join(os.homedir(), p.slice(2));
  return p;
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Canonical path of `absolute`, which may not exist yet. The deepest existing ancestor is
 * resolved and the missing tail re-appended. A dangling symlink is refused: appending past it
 * would let a write follow the link to wherever it points.
 */
async function canonicalize(absolute: string): Promise<{ real: string; exists: boolean }> {
  let current = absolute;
  const tail: string[] = [];
  for (;;) {
    try {
      const real = await realpath(current);
      return { real: nodePath.join(real, ...tail.reverse()), exists: tail.length === 0 };
    } catch (error) {
      if (!isMissing(error)) throw new ToolError('PATH_NOT_ALLOWED', 'path cannot be accessed');
    }
    if (await isSymbolicLink(current)) {
      throw new ToolError('PATH_NOT_ALLOWED', 'path passes through a symbolic link that does not resolve');
    }
    const parent = nodePath.dirname(current);
    if (parent === current) throw new ToolError('PATH_NOT_ALLOWED', 'path has no existing ancestor');
    tail.push(nodePath.basename(current));
    current = parent;
  }
}

async function isSymbolicLink(p: string): Promise<boolean> {
  try {
    return (await lstat(p)).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Decides which model-supplied paths may be touched. Roots come from the live config on every
 * call, so approving or removing a folder takes effect without a restart.
 */
export class RootGuard implements PathGuard {
  constructor(private readonly getConfig: () => Config) {}

  roots(): string[] {
    const roots: string[] = [];
    for (const root of this.getConfig().roots) {
      try {
        roots.push(realpathSync(nodePath.resolve(expandHome(root.path))));
      } catch {
        // A folder that was moved or unmounted is no longer approved in practice.
      }
    }
    return roots;
  }

  async resolve(input: string, options: { cwd: string | null; mustExist: boolean }): Promise<string> {
    if (input.trim().length === 0) throw new ToolError('INVALID_ARGUMENT', 'path is empty');
    if (input.includes('\0')) throw new ToolError('INVALID_ARGUMENT', 'path contains a NUL byte');

    const expanded = expandHome(input);
    let absolute: string;
    if (nodePath.isAbsolute(expanded)) {
      absolute = expanded;
    } else if (options.cwd === null) {
      throw new ToolError('INVALID_ARGUMENT', `"${input}" is relative and no working folder is known; pass an absolute path.`);
    } else {
      absolute = nodePath.join(options.cwd, expanded);
    }

    const { real, exists } = await canonicalize(nodePath.resolve(absolute));
    // Containment is decided before existence so a caller cannot probe outside the roots.
    const roots = this.roots();
    if (!roots.some((root) => isInside(root, real))) throw new ToolError('PATH_NOT_ALLOWED', this.outsideMessage());
    if (options.mustExist && !exists) throw new ToolError('NOT_FOUND', `${input} does not exist`);
    return real;
  }

  private outsideMessage(): string {
    const config = this.getConfig();
    if (config.roots.length === 0) return NO_ROOTS_MESSAGE;
    const names = config.roots.map((root) => root.label || nodePath.basename(root.path) || 'unnamed folder');
    return `Path is outside the approved folders (${names.join(', ')}). Use a path inside one of them.`;
  }
}
