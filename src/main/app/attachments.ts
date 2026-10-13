import { copyFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { clipboard } from 'electron';
import type { Attachment } from '@shared/types';

const MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const;
const MIME: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.csv': 'text/csv', '.zip': 'application/zip'
};

/** Queued files live in app storage, including images captured from the clipboard. */
export async function stageAttachments(dir: string, paths: string[]): Promise<Attachment[]> {
  await mkdir(dir, { recursive: true });
  return Promise.all(paths.map(async (source) => {
    const info = await stat(source);
    if (!info.isFile()) throw new Error(`${basename(source)} is not a file`);
    if (info.size > MAX_ATTACHMENT_BYTES) throw new Error(`${basename(source)} is larger than 50 MB`);
    const id = randomUUID();
    const target = dirname(resolve(source)) === resolve(dir) ? source : join(dir, `${id}-${basename(source)}`);
    if (target !== source) await copyFile(source, target);
    return { id, name: basename(source), mime: MIME[extname(source).toLowerCase()] ?? 'application/octet-stream', size: info.size, path: target };
  }));
}

/** Clipboard bytes stay in the backend; both frontends receive a normal attachment path. */
export async function readClipboard(dir: string): Promise<{ imagePath: string | null; text: string }> {
  for (const item of await clipboard.read()) {
    const type = IMAGE_TYPES.find((type) => item.types.includes(type));
    if (!type) continue;
    const blob = await item.getType(type);
    if (blob.size > MAX_ATTACHMENT_BYTES) throw new Error('The clipboard image is larger than 50 MB.');
    const extension = Object.keys(MIME).find((key) => MIME[key] === type)!;
    const imagePath = join(dir, `clipboard-${randomUUID()}${extension}`);
    await mkdir(dir, { recursive: true });
    await writeFile(imagePath, Buffer.from(await blob.arrayBuffer()));
    return { imagePath, text: '' };
  }
  return { imagePath: null, text: await clipboard.readText() };
}
