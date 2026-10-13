import { realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

async function imagePath(text: string, cwd: string): Promise<string | null> {
  let path = text.trim().replace(/^(['"])(.*)\1$/, '$2');
  if (path.startsWith('@')) path = path.slice(1);
  if (process.platform !== 'win32') path = path.replace(/\\([\s'"()])/g, '$1');
  if (path.startsWith('file://')) {
    try { path = fileURLToPath(path); } catch { return null; }
  }
  if (!['.png', '.jpg', '.jpeg', '.gif', '.webp'].includes(extname(path).toLowerCase())) return null;
  if (path.startsWith('~/') || path.startsWith('~\\')) path = join(homedir(), path.slice(2));
  try {
    const file = await realpath(resolve(cwd, path));
    return (await stat(file)).isFile() ? file : null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT' || (error as NodeJS.ErrnoException).code === 'ENOTDIR') return null;
    throw error;
  }
}

/** Leading image paths become attachments; the rest remains the user's prompt. */
export async function extractImagePaths(text: string, cwd: string): Promise<{ text: string; paths: string[] }> {
  const lines = text.split(/\r?\n/);
  const paths: string[] = [];
  while (lines.length) {
    const path = await imagePath(lines[0]!, cwd);
    if (!path) break;
    paths.push(path);
    lines.shift();
  }
  return { text: lines.join('\n'), paths };
}
