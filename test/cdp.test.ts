import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { expect, it } from 'vitest';
import { WebSocketServer } from 'ws';
import { Cdp } from './live/cdp';

it('rejects an outstanding inspector command when the process disconnects', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  server.on('connection', (socket) => socket.once('message', () => socket.close()));
  const client = await Cdp.connect(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`);
  try { await expect(client.evaluate('1')).rejects.toThrow('disconnected'); }
  finally { client.close(); await new Promise<void>((resolve) => server.close(() => resolve())); }
});
