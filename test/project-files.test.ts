import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readFileForView } from '../src/main/projects/files';

let dir: string;
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'file-view-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

it.each([Buffer.from([0x61, 0xff]), Buffer.from([0x61, 0xe2]), Buffer.from([0x61, 0])])(
  'returns complete malformed or binary files without text: %j', async (bytes) => {
    const file = join(dir, 'binary');
    await writeFile(file, bytes);
    expect(await readFileForView(file)).toMatchObject({ binary: true, text: null, truncated: false });
  }
);

it('keeps UTF-8 text when the display limit splits a character', async () => {
  const file = join(dir, 'text');
  const prefix = 'a'.repeat(2 * 1024 * 1024 - 1);
  await writeFile(file, `${prefix}€tail`);
  expect(await readFileForView(file)).toMatchObject({ binary: false, text: prefix, truncated: true });
});
