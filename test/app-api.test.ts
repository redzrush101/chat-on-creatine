import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { createApi } from '../src/main/app/api';
import type { Services } from '../src/main/app/services';
import { defaultConfig } from '../src/shared/config';
import { SessionStore } from '../src/main/sessions/store';
import { Outbox } from '../src/main/sessions/outbox';
import { flushWrites } from '../src/main/core/durable';
import { ProcessManager } from '../src/main/exec/process-manager';

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

it('shell commands use the backend cwd and policy, while YOLO bypasses the root and command restrictions', async () => {
  dir = await mkdtemp(join(tmpdir(), 'creatine-api-command-'));
  const config = defaultConfig();
  config.roots = [{ id: 'test', path: dir, label: '' }];
  const processes = new ProcessManager();
  const services = { config: { get: () => config }, processes } as unknown as Services;
  const api = createApi(() => services, () => { throw new Error('Unused'); }, { show: () => {}, quit: () => {} });
  try {
    let result = await api['commands:exec']('pwd', dir);
    let output = result.output;
    while (result.sessionId) { result = await api['commands:poll'](result.sessionId, ''); output += result.output; }
    expect(output).toContain(dir);
    config.readOnly = true;
    await expect(api['commands:exec']('pwd', dir)).rejects.toThrow('disabled');
    config.readOnly = false;
    config.commandPolicy = { enabled: true, mode: 'denylist', rules: ['pwd'] };
    await expect(api['commands:exec']('pwd', dir)).rejects.toThrow('not allowed');
    config.roots = [];
    config.yolo = true;
    let unrestricted = await api['commands:exec']('pwd', dir);
    let unrestrictedOutput = unrestricted.output;
    while (unrestricted.sessionId) { unrestricted = await api['commands:poll'](unrestricted.sessionId, ''); unrestrictedOutput += unrestricted.output; }
    expect(unrestrictedOutput).toContain(dir);
  } finally { await processes.dispose(); }
});
