import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clipboard } from 'electron';
import { readClipboard } from '../src/main/app/attachments';

vi.mock('electron', () => ({ clipboard: { read: vi.fn(async () => []), readText: vi.fn(async () => 'Electron text') } }));

let dir = '';
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'creatine-wayland-'));
  vi.stubEnv('WAYLAND_DISPLAY', 'wayland-test');
  vi.stubEnv('PATH', `${dir}${delimiter}${process.env.PATH}`);
  vi.stubEnv('TASK_CLIPBOARD_SOURCE', join(process.cwd(), 'resources', 'icon.png'));
  vi.stubEnv('TASK_CLIPBOARD_MIME', 'image/png');
  vi.stubEnv('TASK_CLIPBOARD_MODE', 'normal');
  await writeFile(join(dir, 'wl-paste'), `#!${process.execPath}
const fs = require('node:fs');
if (process.env.TASK_CLIPBOARD_MODE === 'empty') { process.stderr.write('Nothing is copied'); process.exit(1); }
if (process.env.TASK_CLIPBOARD_MODE === 'error') process.exit(2);
if (process.argv.includes('--list-types')) process.stdout.write(process.env.TASK_CLIPBOARD_MIME + '\\n');
else process.stdout.write(fs.readFileSync(process.env.TASK_CLIPBOARD_SOURCE));
`, { mode: 0o700 });
});
afterEach(async () => { vi.unstubAllEnvs(); vi.clearAllMocks(); await rm(dir, { recursive: true, force: true }); });

if (process.platform === 'linux') {
  it('reads exact Wayland image bytes through a real child process and stages a private attachment', async () => {
    const result = await readClipboard(join(dir, 'attachments'));
    expect(result.text).toBe('');
    expect(await readFile(result.imagePath!)).toEqual(await readFile(process.env.TASK_CLIPBOARD_SOURCE!));
    expect((await stat(result.imagePath!)).mode & 0o777).toBe(0o600);
    expect(clipboard.read).not.toHaveBeenCalled();
  });

  it('preserves text newlines, reports an empty clipboard and surfaces Wayland failures', async () => {
    const source = join(dir, 'text.txt');
    await writeFile(source, 'multiline\ntext\n');
    vi.stubEnv('TASK_CLIPBOARD_SOURCE', source);
    vi.stubEnv('TASK_CLIPBOARD_MIME', 'text/plain;charset=utf-8');
    expect(await readClipboard(dir)).toEqual({ imagePath: null, text: 'multiline\ntext\n' });
    vi.stubEnv('TASK_CLIPBOARD_MODE', 'empty');
    expect(await readClipboard(dir)).toEqual({ imagePath: null, text: '' });
    vi.stubEnv('TASK_CLIPBOARD_MODE', 'error');
    await expect(readClipboard(dir)).rejects.toThrow('Cannot read the Wayland clipboard');
    expect(clipboard.read).not.toHaveBeenCalled();
  });

}

it('uses Electron when wl-clipboard is unavailable or the session is not Wayland', async () => {
  await rm(join(dir, 'wl-paste'));
  vi.stubEnv('PATH', dir);
  expect(await readClipboard(dir)).toEqual({ imagePath: null, text: 'Electron text' });
  vi.stubEnv('WAYLAND_DISPLAY', '');
  expect(await readClipboard(dir)).toEqual({ imagePath: null, text: 'Electron text' });
  expect(clipboard.read).toHaveBeenCalledTimes(2);
});
