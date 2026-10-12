import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { afterEach, expect, it } from 'vitest';
import { FrontendServer } from '../src/main/app/frontend-server';
import type { ApiHandlers } from '../src/main/app/api';
import { BackendClient } from '../src/cli/connection';
import { frontendAddressSchema } from '../src/shared/frontend-protocol';
import { RENDERER_CHANNELS } from '../src/shared/ipc';

let server: FrontendServer | null = null;
let dir = '';
const clients: WebSocket[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.terminate();
  await server?.close(); server = null;
  if (dir) await rm(dir, { recursive: true, force: true });
});

async function setup() {
  dir = await mkdtemp(join(tmpdir(), 'creatine-frontend-'));
  const file = join(dir, 'frontend.json');
  const calls: unknown[][] = [];
  const handlers = Object.fromEntries(RENDERER_CHANNELS.map((channel) => [channel, (...args: unknown[]) => {
    calls.push([channel, ...args]);
    if (channel === 'browser:signIn') return new Promise<void>(() => {});
    if (channel === 'sessions:events') return [];
    throw new Error('Readable backend failure');
  }])) as unknown as ApiHandlers;
  server = new FrontendServer(file, handlers, () => {});
  await server.start();
  const address = frontendAddressSchema.parse(JSON.parse(await readFile(file, 'utf8')));
  return { file, address, calls };
}

it('serves independent CLI clients, preserves typed calls and streams session upserts', async () => {
  const { file, address, calls } = await setup();
  if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
  const connections = await Promise.all([1, 2].map(async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}`, { headers: { Authorization: `Bearer ${address.token}` } });
    clients.push(socket); await once(socket, 'open'); return new BackendClient(socket);
  }));
  expect(await connections[0]!.invoke('sessions:events', 'chat')).toEqual([]);
  expect(calls).toEqual([['sessions:events', 'chat']]);
  await expect(connections[1]!.invoke('chat:stop', 'chat')).rejects.toThrow('Readable backend failure');
  const events = connections.map((client) => new Promise<unknown>((resolve) => { client.on('session:events', resolve); }));
  server!.broadcast('session:events', { sessionId: 'chat', events: [] });
  expect(await Promise.all(events)).toEqual([{ sessionId: 'chat', events: [] }, { sessionId: 'chat', events: [] }]);
});

it.each(['missing token', 'web origin'])('refuses an unauthorized connection: %s', async (kind) => {
  const { address, calls } = await setup();
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`, {
    headers: kind === 'missing token' ? {} : { Authorization: `Bearer ${address.token}`, Origin: 'https://example.com' }
  });
  clients.push(socket);
  const error = await new Promise<Error>((resolve) => socket.once('error', resolve));
  expect(error.message).toContain('401');
  expect(calls).toHaveLength(0);
});

it('refuses unknown channels and rejects pending RPCs when the backend closes', async () => {
  const { address, calls } = await setup();
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}`, { headers: { Authorization: `Bearer ${address.token}` } });
  clients.push(socket); await once(socket, 'open');
  const closed = once(socket, 'close');
  socket.send(JSON.stringify({ id: 1, channel: 'not:a:channel', args: [] }));
  expect((await closed)[0]).toBe(1008);
  expect(calls).toHaveLength(0);
  const pendingSocket = new WebSocket(`ws://127.0.0.1:${address.port}`, { headers: { Authorization: `Bearer ${address.token}` } });
  clients.push(pendingSocket); await once(pendingSocket, 'open');
  const pending = new BackendClient(pendingSocket).invoke('browser:signIn');
  const rejected = expect(pending).rejects.toThrow('disconnected');
  await server!.close(); server = null;
  await rejected;
});
