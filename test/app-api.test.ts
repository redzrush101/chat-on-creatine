import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { clipboard, type ClipboardItem } from 'electron';
import { createApi } from '../src/main/app/api';
import type { Services } from '../src/main/app/services';
import { defaultConfig } from '../src/shared/config';
import { SessionStore } from '../src/main/sessions/store';
import { Outbox } from '../src/main/sessions/outbox';
import { flushWrites } from '../src/main/core/durable';
import { ProcessManager } from '../src/main/exec/process-manager';

vi.mock('electron', () => ({ clipboard: { read: vi.fn(), readText: vi.fn() } }));

let dir = '';
afterEach(async () => { await flushWrites(); if (dir) await rm(dir, { recursive: true, force: true }); });

it('the shared send boundary preserves cwd, stages attachments, and resumes the same recorded chat', async () => {
  dir = await mkdtemp(join(tmpdir(), 'creatine-api-'));
  const store = new SessionStore(join(dir, 'sessions'), { recording: () => true });
  store.load();
  const outbox = new Outbox(join(dir, 'outbox.json'));
  const config = defaultConfig();
  const services = { store, outbox, config: { get: () => config }, skills: { list: () => [] }, paths: { attachments: join(dir, 'attachments') } } as unknown as Services;
  const api = createApi(() => services, () => { throw new Error('Unused'); }, { show: () => {}, quit: () => {} });
  const source = join(dir, 'reference.txt');
  await writeFile(source, 'attached context');
  const created = await api['chat:send']({ sessionId: null, cwd: dir, projectId: null, text: 'Read this', attachments: [source], delivery: 'now' });
  expect(store.get(created.sessionId)?.cwd).toBe(dir);
  const attachment = created.input.attachments[0]!;
  expect(attachment.path).not.toBe(source);
  expect(await readFile(attachment.path, 'utf8')).toBe('attached context');
  await rm(source);
  const resumed = await api['chat:send']({ sessionId: created.sessionId, text: 'Continue', attachments: [], delivery: 'after-turn' });
  expect(resumed.sessionId).toBe(created.sessionId);
  expect(store.list()).toHaveLength(1);
  expect(outbox.list(created.sessionId)).toHaveLength(2);
});

it('does not create a replacement session when an explicit session ID is stale', async () => {
  dir = await mkdtemp(join(tmpdir(), 'creatine-api-stale-'));
  const store = new SessionStore(join(dir, 'sessions'), { recording: () => true });
  store.load();
  const services = { store, config: { get: defaultConfig } } as unknown as Services;
  const api = createApi(() => services, () => { throw new Error('Unused'); }, { show: () => {}, quit: () => {} });
  await expect(api['chat:send']({ sessionId: 'deleted', text: 'Continue', attachments: [], delivery: 'now' })).rejects.toThrow('Unknown chat');
  expect(store.list()).toHaveLength(0);
});

it('stages native clipboard images once, sends them, and keeps text paste and size limits intact', async () => {
  dir = await mkdtemp(join(tmpdir(), 'creatine-api-clipboard-'));
  const store = new SessionStore(join(dir, 'sessions'), { recording: () => true });
  store.load();
  const outbox = new Outbox(join(dir, 'outbox.json'));
  const attachments = join(dir, 'attachments');
  const services = { store, outbox, config: { get: defaultConfig }, skills: { list: () => [] }, paths: { attachments } } as unknown as Services;
  const api = createApi(() => services, () => { throw new Error('Unused'); }, { show: () => {}, quit: () => {} });
  const image = await readFile(join(process.cwd(), 'resources', 'icon.png'));
  const item = (blob: Blob) => ({ types: ['image/png'], getType: async () => blob }) as unknown as ClipboardItem;
  vi.mocked(clipboard.read).mockResolvedValue([item(new Blob([new Uint8Array(image)], { type: 'image/png' }))]);
  const pasted = await api['app:clipboard']();
  expect(pasted.imagePath).not.toBeNull();
  expect(await readFile(pasted.imagePath!)).toEqual(image);
  const sent = await api['chat:send']({ sessionId: null, text: 'Describe this image', attachments: [pasted.imagePath!], delivery: 'now' });
  expect(sent.input.attachments[0]).toMatchObject({ path: pasted.imagePath, mime: 'image/png', size: image.length });
  expect(await readdir(attachments)).toHaveLength(1);

  vi.mocked(clipboard.read).mockResolvedValue([]);
  vi.mocked(clipboard.readText).mockResolvedValue('literal clipboard text');
  expect(await api['app:clipboard']()).toEqual({ imagePath: null, text: 'literal clipboard text' });
  vi.mocked(clipboard.read).mockResolvedValue([item(new Blob([new Uint8Array(50 * 1024 * 1024 + 1)]))]);
  await expect(api['app:clipboard']()).rejects.toThrow('larger than 50 MB');
  expect(await readdir(attachments)).toHaveLength(1);
});

it('shell commands use the backend cwd and policy, while YOLO bypasses the root and command restrictions', async () => {
  dir = await mkdtemp(join(tmpdir(), 'creatine-api-command-'));
  const marker = 'backend-working-directory';
  await writeFile(join(dir, 'cwd.txt'), marker);
  const command = `node -e "process.stdout.write(require('node:fs').readFileSync('cwd.txt', 'utf8'))"`;
  const config = defaultConfig();
  config.roots = [{ id: 'test', path: dir, label: '' }];
  const processes = new ProcessManager();
  const services = { config: { get: () => config }, processes } as unknown as Services;
  const api = createApi(() => services, () => { throw new Error('Unused'); }, { show: () => {}, quit: () => {} });
  try {
    let result = await api['commands:exec'](command, dir);
    let output = result.output;
    while (result.sessionId) { result = await api['commands:poll'](result.sessionId, ''); output += result.output; }
    expect(output).toContain(marker);
    config.readOnly = true;
    await expect(api['commands:exec'](command, dir)).rejects.toThrow('disabled');
    config.readOnly = false;
    config.commandPolicy = { enabled: true, mode: 'denylist', rules: [command] };
    await expect(api['commands:exec'](command, dir)).rejects.toThrow('not allowed');
    config.roots = [];
    config.yolo = true;
    let unrestricted = await api['commands:exec'](command, dir);
    let unrestrictedOutput = unrestricted.output;
    while (unrestricted.sessionId) { unrestricted = await api['commands:poll'](unrestricted.sessionId, ''); unrestrictedOutput += unrestricted.output; }
    expect(unrestrictedOutput).toContain(marker);
  } finally { await processes.dispose(); }
});
