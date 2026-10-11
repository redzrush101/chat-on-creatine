import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { FileContent } from '@shared/ipc';
import type { FileEntry } from '@shared/types';

const MAX_ENTRIES = 2000;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

/** One level of a folder for the file browser: folders first, then files, each alphabetical. */
export async function listDir(dir: string): Promise<FileEntry[]> {
  const dirents = await readdir(dir, { withFileTypes: true });
  const rows = await Promise.all(
    dirents.map(async (dirent) => {
      const full = path.join(dir, dirent.name);
      const isDir =
        dirent.isDirectory() || (dirent.isSymbolicLink() && (await statOrNull(full))?.isDirectory() === true);
      return { name: dirent.name, full, isDir };
    })
  );
  rows.sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));

  return Promise.all(
    rows.slice(0, MAX_ENTRIES).map(async (row) => ({
      name: row.name,
      path: row.full,
      kind: row.isDir ? 'dir' : 'file',
      size: row.isDir ? 0 : (await statOrNull(row.full))?.size ?? 0
    }))
  );
}

/** Text of at most 2 MB. Files containing NUL bytes or invalid UTF-8 come back as binary with no text. */
export async function readFileForView(file: string): Promise<FileContent> {
  const info = await stat(file);
  if (!info.isFile()) throw new Error('Choose a regular file');

  const truncated = info.size > MAX_TEXT_BYTES;
  const handle = await open(file, 'r');
  let bytes: Buffer;
  try {
    bytes = Buffer.alloc(Math.min(info.size, MAX_TEXT_BYTES));
    const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
    bytes = bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }

  const text = bytes.includes(0) ? null : decodeUtf8(bytes, truncated);
  return { path: file, size: info.size, binary: text === null, text, truncated };
}

function statOrNull(file: string) {
  return stat(file).catch(() => null);
}

/** A cut at the byte limit may split a multi-byte character; that tail is not invalid UTF-8. */
function decodeUtf8(bytes: Buffer, truncated: boolean): string | null {
  let body = bytes;
  if (truncated) {
    for (let back = 1; back <= Math.min(4, bytes.length); back++) {
      const byte = bytes[bytes.length - back]!;
      if ((byte & 0xc0) === 0x80) continue;
      const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
      if (width > back) body = bytes.subarray(0, bytes.length - back);
      break;
    }
  }
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(body);
  } catch {
    return null;
  }
}
