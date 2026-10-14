import { isAbsolute, relative, sep } from 'node:path';

/** Both paths must be absolute and canonical; path components, rather than prefixes, decide containment. */
export function isInside(parent: string, child: string): boolean {
  const insensitive = process.platform === 'win32' || process.platform === 'darwin';
  const part = relative(insensitive ? parent.toLowerCase() : parent, insensitive ? child.toLowerCase() : child);
  return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`);
}
