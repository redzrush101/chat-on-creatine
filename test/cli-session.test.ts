import { copyFile, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { CliSession } from '../src/cli/session';
import { parseOptions } from '../src/cli/options';
import { Transcript } from '../src/cli/transcript';
import { defaultConfig } from '../src/shared/config';
import type { AppState, InputItem } from '../src/shared/types';
import type { BackendClient } from '../src/cli/connection';
import type { Terminal } from '../src/cli/terminal';
import { runCommand } from '../src/cli/commands';

let dir = '';
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'creatine-session-')); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });

function setup() {
  const config = defaultConfig();
  config.roots = [{ id: 'test', path: dir, label: '' }];
  const state = { config, browser: { signedIn: true }, connection: { state: 'connected' }, models: { state: 'ready', models: [] }, skills: [], projects: [], sessions: [], inputs: [], live: {} } as unknown as AppState;
  let fail = false;
  const invoke = vi.fn(async (channel: string, ...args: unknown[]) => {
    if (channel === 'projects:add') return { id: 'project' };
    if (channel === 'chat:send') {
      if (fail) throw new Error('Remote send failed');
      const request = args[0] as { text: string; attachments: string[]; delivery: InputItem['delivery'] };
      const input: InputItem = { id: 'input', sessionId: 'chat', text: request.text, attachments: [], delivery: request.delivery, source: 'app', state: 'queued', createdAt: 1, sentAt: null, error: null };
      return { sessionId: 'chat', input };
    }
    throw new Error(`Unexpected channel ${channel}`);
  });
  const client = { state, invoke, refresh: async () => state } as unknown as BackendClient;
  const session = new CliSession(client, parseOptions([], dir), null, new Transcript(() => {}, false));
  return { session, invoke, fail: () => { fail = true; } };
}

it('expands templates and file context through the same send boundary in print and interactive modes', async () => {
  const { session, invoke } = setup();
  await writeFile(join(dir, 'source.ts'), 'first\nsecond\nthird');
  session.templates = [{ name: 'review', description: '', argumentHint: '', body: 'Review @"source.ts":2. Focus on $1', path: '' }];
  session.name = 'Review task';
  session.addShellContext('npm test', 'one test failed', 'Exit code 1');
  await session.send('/review correctness', 'after-turn');
  const call = invoke.mock.calls.find((call) => call[0] === 'chat:send')!;
  expect(call[1]).toMatchObject({ title: 'Review task', cwd: dir, delivery: 'after-turn', projectId: 'project' });
  const request = call[1] as { text: string };
  expect(request.text).toContain('Focus on correctness');
  expect(request.text).toContain('2: second');
  expect(request.text).not.toContain('1: first');
  expect(request.text).toContain('$ npm test');
  expect(request.text).toContain('one test failed');
  expect(session.shellContext).toBe('');
  expect(session.id).toBe('chat');
});

it('retains pending context and attachments when a send fails, and rejects oversized input before dispatch', async () => {
  const { session, invoke, fail } = setup();
  session.attachments = [join(dir, 'pending.png')];
  session.addShellContext('test', 'failure output', 'Exit code 1');
  fail();
  await expect(session.send('Fix it')).rejects.toThrow('Remote send failed');
  expect(session.attachments).toHaveLength(1);
  expect(session.shellContext).toContain('failure output');
  expect(session.id).toBeNull();
  invoke.mockClear();
  await expect(session.send('x'.repeat(80_001))).rejects.toThrow('too large');
  expect(invoke).not.toHaveBeenCalled();
});

it('sends a pasted image path and its prompt together through the actual CLI send boundary', async () => {
  const { session, invoke } = setup();
  const file = join(dir, 'screen shot.png');
  await copyFile(join(process.cwd(), 'resources', 'icon.png'), file);
  const terminal = { print: () => {}, colored: false } as unknown as Terminal;
  const interactive = new CliSession(session.client, session.options, terminal, new Transcript(() => {}, false));
  await runCommand(`${file}\nDescribe the image`, interactive, { newChat: () => {}, exit: () => {} });
  const request = invoke.mock.calls.find((call) => call[0] === 'chat:send')?.[1];
  expect(request).toMatchObject({ text: 'Describe the image', attachments: [await realpath(file)] });
});
