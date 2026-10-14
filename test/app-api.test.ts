import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { clipboard, type ClipboardItem } from 'electron';
import { createApi } from '../src/main/app/api';
import type { Services } from '../src/main/app/services';
import { defaultConfig } from '../src/shared/config';
import { SessionStore } from '../src/main/sessions/store';
import { Outbox } from '../src/main/sessions/outbox';
import { flushWrites } from '../src/main/core/durable';
import { ProcessManager } from '../src/main/exec/process-manager';
import { execFileSync } from 'node:child_process';

vi.mock('electron', () => ({ clipboard: { read: vi.fn(), readText: vi.fn() } }));

let dir = '';
beforeEach(() => { vi.stubEnv('WAYLAND_DISPLAY', ''); });
afterEach(async () => { vi.unstubAllEnvs(); await flushWrites(); if (dir) await rm(dir, { recursive: true, force: true }); });

it('the shared send boundary preserves cwd, stages attachments, and resumes the same recorded chat', async () => {
  dir = await mkdtemp(join(tmpdir(), 'creatine-api-'));
  const store = new SessionStore(join(dir, 'sessions'), { recording: () => true });
  store.load();
  const outbox = new Outbox(join(dir, 'outbox.json'));
  const config = defaultConfig();
  const services = { store, outbox, config: { get: () => config }, skills: { list: () => [] }, sessionCwd: () => dir, paths: { userData: dir, attachments: join(dir, 'attachments') } } as unknown as Services;
  const api = createApi(() => services, () => { throw new Error('Unused'); }, { show: () => {}, quit: () => {} });
  const source = join(dir, 'reference.txt');
  await writeFile(source, 'attached context');
  const created = await api['chat:send']({ sessionId: null, cwd: dir, projectId: null, title: 'User named task', text: 'Read this', attachments: [source], delivery: 'now' });
  expect(store.get(created.sessionId)?.cwd).toBe(dir);
  expect(store.get(created.sessionId)?.title).toBe('User named task');
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

it('prepares templates, file ranges and literal shell output for both frontends before creating a chat', async () => {
  dir = await mkdtemp(join(tmpdir(), 'creatine-api-prompts-'));
  const store = new SessionStore(join(dir, 'sessions'), { recording: () => true });
  store.load();
  const outbox = new Outbox(join(dir, 'outbox.json'));
  const config = defaultConfig();
  config.roots = [{ id: 'test', path: dir, label: '' }];
  const services = { store, outbox, config: { get: () => config }, skills: { list: () => [] }, sessionCwd: () => dir,
    paths: { userData: dir, attachments: join(dir, 'attachments') } } as unknown as Services;
  const api = createApi(() => services, () => { throw new Error('Unused'); }, { show: () => {}, quit: () => {} });
  await mkdir(join(dir, '.creatine', 'prompts'), { recursive: true });
  await writeFile(join(dir, '.creatine', 'prompts', 'audit.md'), 'Review @source.ts:2. Focus on ${1:-correctness}');
  await writeFile(join(dir, 'source.ts'), 'ignore\nshared context\nignore');
  expect(await api['chat:templates'](dir)).toMatchObject([{ name: 'audit' }]);
  const request = { sessionId: null, text: '/audit streaming', attachments: [], delivery: 'now' as const };
  const gui = await api['chat:send'](request);
  const cli = await api['chat:send']({ ...request, cwd: dir, shellContext: '$ test\n@missing.ts is literal command output' });
  expect(gui.input.text).toContain('Focus on streaming');
  expect(gui.input.text).toContain('2: shared context');
  expect(gui.input.text).not.toContain('1: ignore');
  expect(cli.input.text).toContain(gui.input.text);
  expect(cli.input.text).toContain('@missing.ts is literal command output');
  const count = store.list().length;
  await expect(api['chat:send']({ ...request, text: '@missing.ts' })).rejects.toThrow('Cannot include');
  await expect(api['chat:send']({ ...request, text: 'x'.repeat(80_001) })).rejects.toThrow('too large');
  await expect(api['chat:send']({ ...request, attachments: [join(dir, 'missing.png')] })).rejects.toThrow();
  expect(store.list()).toHaveLength(count);
});

it('stopping from either frontend cancels queued inputs before interrupting the turn', async () => {
  dir = await mkdtemp(join(tmpdir(), 'creatine-api-stop-'));
  const store = new SessionStore(join(dir, 'sessions'), { recording: () => true });
  store.load();
  const outbox = new Outbox(join(dir, 'outbox.json'));
  const session = store.create({ kind: 'chat' });
  const queued = outbox.enqueue({ sessionId: session.id, text: 'Follow up', attachments: [], delivery: 'after-turn', source: 'app' });
  const stopTurn = vi.fn(async () => { expect(outbox.list(session.id).find((input) => input.id === queued.id)?.state).toBe('cancelled'); });
  const services = { store, outbox, router: { stopTurn } } as unknown as Services;
  const api = createApi(() => services, () => { throw new Error('Unused'); }, { show: () => {}, quit: () => {} });
  await api['chat:stop'](session.id);
  expect(stopTurn).toHaveBeenCalledWith(session.id);
});

it('selects account models and shared defaults atomically, rejecting unavailable efforts and active turns', async () => {
  dir = await mkdtemp(join(tmpdir(), 'creatine-api-model-'));
  const store = new SessionStore(join(dir, 'sessions'), { recording: () => true });
  store.load();
  const outbox = new Outbox(join(dir, 'outbox.json'));
  const session = store.create({ kind: 'chat' });
  const update = vi.fn();
  let busy = false;
  const services = { store, outbox, config: { update }, compacting: new Set<string>(), router: { turnOf: () => busy ? 'generating' : 'idle' },
    models: { forSelection: async () => ({ defaultModel: 'test-model', models: [{ id: 'test-model', label: 'Test model', efforts: ['low', 'high'] }] }) } } as unknown as Services;
  const api = createApi(() => services, () => { throw new Error('Unused'); }, { show: () => {}, quit: () => {} });
  const selected = { model: 'test-model', reasoning: 'high' as const };
  expect(await api['chat:selectModel'](session.id, selected)).toEqual(selected);
  expect(store.get(session.id)).toMatchObject(selected);
  expect(update).toHaveBeenCalledWith({ ui: { defaultModel: 'test-model', defaultReasoning: 'high' } });
  await expect(api['chat:selectModel'](session.id, { model: 'test-model', reasoning: 'max' })).rejects.toThrow('does not offer');
  await expect(api['chat:selectModel'](session.id, { model: 'missing', reasoning: null })).rejects.toThrow('unavailable');
  busy = true;
  await expect(api['chat:selectModel'](session.id, { model: null, reasoning: null })).rejects.toThrow('Stop');
  expect(update).toHaveBeenCalledTimes(1);
});

it('an explicit one-shot submission turns off existing automation without replacing its objective', async () => {
  dir = await mkdtemp(join(tmpdir(), 'creatine-api-automation-'));
  const store = new SessionStore(join(dir, 'sessions'), { recording: () => true });
  store.load();
  const outbox = new Outbox(join(dir, 'outbox.json'));
  const session = store.create({ kind: 'chat' });
  store.update(session.id, { goal: { ...session.goal, mode: 'loop', objective: 'Original objective' } });
  const setMode = vi.fn();
  const services = { store, outbox, config: { get: defaultConfig }, automation: { setMode }, skills: { list: () => [] }, sessionCwd: () => null, paths: { attachments: join(dir, 'attachments') } } as unknown as Services;
  const api = createApi(() => services, () => { throw new Error('Unused'); }, { show: () => {}, quit: () => {} });
  await api['chat:send']({ sessionId: session.id, text: 'Review once', attachments: [], delivery: 'now', automation: 'off' });
  expect(setMode).toHaveBeenCalledWith(session.id, 'off', undefined);
});

it('both frontends submit validated coding tasks through the shared API and invalid reviews leave no session behind', async () => {
  dir = await mkdtemp(join(tmpdir(), 'creatine-api-workflows-'));
  execFileSync('git', ['init', '-q', dir]);
  const store = new SessionStore(join(dir, 'sessions'), { recording: () => true });
  store.load();
  const outbox = new Outbox(join(dir, 'outbox.json'));
  const config = defaultConfig();
  config.roots = [{ id: 'test', path: dir, label: '' }];
  const services = {
    store, outbox, config: { get: () => config }, skills: { list: () => [] }, projects: { list: () => [] },
    paths: { attachments: join(dir, 'attachments') }, router: { turnOf: () => 'idle' }, compacting: new Set<string>(), sessionCwd: () => dir
  } as unknown as Services;
  const api = createApi(() => services, () => { throw new Error('Unused'); }, { show: () => {}, quit: () => {} });
  const request = { sessionId: null, cwd: dir, text: 'Focus on error handling', attachments: [], delivery: 'now' as const };
  await expect(api['chat:send']({ ...request, task: { kind: 'review', target: { kind: 'commit', revision: 'missing' } } })).rejects.toThrow('not a commit');
  expect(store.list()).toHaveLength(0);
  const reviewed = await api['chat:send']({ ...request, task: { kind: 'review', target: { kind: 'uncommitted' } } });
  expect(reviewed.input.text).toContain('staged, unstaged and untracked');
  expect(reviewed.input.text).toContain('Additional review focus: Focus on error handling');
  expect(reviewed.input.text).toContain('Do not edit files');
  await writeFile(join(dir, 'AGENTS.md'), 'Existing project instructions');
  const initialized = await api['chat:send']({ ...request, task: { kind: 'init' } });
  expect(initialized.input.text).toContain('without overwriting it');
  expect(await readFile(join(dir, 'AGENTS.md'), 'utf8')).toBe('Existing project instructions');
  await expect(api['chat:send']({ ...request, sessionId: reviewed.sessionId, task: { kind: 'init' } })).rejects.toThrow('Stop the current turn');
  expect(outbox.list(reviewed.sessionId)).toHaveLength(1);
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
