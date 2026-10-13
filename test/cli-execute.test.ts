import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { execute } from '../src/cli/execute';
import { CliSession } from '../src/cli/session';
import { parseOptions } from '../src/cli/options';
import { Transcript } from '../src/cli/transcript';
import { BackendClient } from '../src/cli/connection';
import { FrontendServer } from '../src/main/app/frontend-server';
import type { ApiHandlers } from '../src/main/app/api';
import { frontendAddressSchema } from '../src/shared/frontend-protocol';
import { RENDERER_CHANNELS } from '../src/shared/ipc';
import { defaultConfig } from '../src/shared/config';
import type { AppState, SessionEvent } from '../src/shared/types';

let dir = '';
let server: FrontendServer | null = null;
let socket: WebSocket | null = null;
afterEach(async () => { socket?.terminate(); await server?.close(); await rm(dir, { recursive: true, force: true }); vi.restoreAllMocks(); });

it.each(['done', 'stopped'] as const)('saves only a successful final answer and ignores resumed history: %s', async (outcome) => {
  dir = await mkdtemp(join(tmpdir(), 'creatine-execute-'));
  const output = join(dir, 'answer.txt');
  await writeFile(output, 'Previous output');
  const config = defaultConfig();
  config.roots = [{ id: 'test', path: dir, label: '' }];
  const state = { config, browser: { signedIn: true }, connection: { state: 'connected' }, models: { state: 'ready' }, skills: [], inputs: [], agents: [], sessions: [], live: {} } as unknown as AppState;
  const assistant = (id: string, text: string, channel: 'final' | 'commentary' = 'final'): SessionEvent => ({ id, text, channel, kind: 'assistant', at: 1, messageId: id, model: null, streaming: false });
  const events: SessionEvent[] = [assistant('old', 'Old answer')];
  const handlers = Object.fromEntries(RENDERER_CHANNELS.map((channel) => [channel, () => {
    if (channel === 'app:state') return state;
    if (channel === 'projects:add') return { id: 'project' };
    if (channel === 'sessions:events') return events;
    if (channel === 'chat:stop') return;
    if (channel === 'chat:send') {
      events.push(assistant('comment', 'Working', 'commentary'), assistant('answer', 'Final answer'), { id: 'end', kind: 'turn', at: 1, phase: 'end', outcome, error: null });
      return { sessionId: 'chat', input: { id: 'input', text: 'Task', attachments: [], createdAt: 1 } };
    }
    throw new Error(`Unexpected channel ${channel}`);
  }])) as unknown as ApiHandlers;
  const addressFile = join(dir, 'frontend.json');
  server = new FrontendServer(addressFile, handlers, () => {});
  await server.start();
  const address = frontendAddressSchema.parse(JSON.parse(await readFile(addressFile, 'utf8')));
  socket = new WebSocket(`ws://127.0.0.1:${address.port}`, { headers: { Authorization: `Bearer ${address.token}` } });
  await once(socket, 'open');
  const client = new BackendClient(socket);
  await client.refresh();
  const session = new CliSession(client, parseOptions(['exec', '--json', '-o', output, 'Task'], dir), null, new Transcript(() => {}, false));
  session.id = 'chat';
  const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  if (outcome === 'done') {
    await execute(session);
    expect(await readFile(output, 'utf8')).toBe('Final answer\n');
    const records = stdout.mock.calls.map(([text]) => JSON.parse(String(text)) as { type: string; text?: string; event?: { id: string } });
    expect(records.at(-1)).toMatchObject({ type: 'result', text: 'Final answer' });
    expect(records.some((record) => record.event?.id === 'old')).toBe(false);
  } else {
    await expect(execute(session)).rejects.toThrow('Turn stopped');
    expect(await readFile(output, 'utf8')).toBe('Previous output');
  }
});
