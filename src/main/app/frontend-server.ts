import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { AddressInfo } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import type { MainEvent, MainEvents } from '@shared/ipc';
import { FRONTEND_MAX_BYTES, frontendRequestSchema, type FrontendMessage } from '@shared/frontend-protocol';
import { errorMessage } from '@shared/errors';
import type { ApiHandlers } from './api';

/** Private local transport to the same handlers the GUI uses. The discovery file is owner-only. */
export class FrontendServer {
  private server: WebSocketServer | null = null;
  private readonly clients = new Set<WebSocket>();

  constructor(private readonly file: string, private readonly handlers: ApiHandlers, private readonly clientsChanged: (count: number) => void) {}

  get clientCount(): number { return this.clients.size; }

  async start(): Promise<void> {
    const token = randomBytes(32).toString('hex');
    const server = new WebSocketServer({
      host: '127.0.0.1', port: 0, maxPayload: FRONTEND_MAX_BYTES,
      verifyClient: ({ req }: { req: IncomingMessage }) => {
        const provided = Buffer.from(req.headers.authorization ?? '');
        const expected = Buffer.from(`Bearer ${token}`);
        return !req.headers.origin && provided.length === expected.length && timingSafeEqual(provided, expected);
      }
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => {
      server.once('listening', resolve);
      server.once('error', reject);
    });
    server.on('connection', (client) => {
      this.clients.add(client);
      this.clientsChanged(this.clients.size);
      client.on('error', () => client.close());
      client.on('close', () => {
        this.clients.delete(client);
        this.clientsChanged(this.clients.size);
      });
      client.on('message', (data) => { void this.request(client, data.toString()); });
    });
    await mkdir(dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, JSON.stringify({ port: (server.address() as AddressInfo).port, token, pid: process.pid }), { mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, this.file);
  }

  broadcast<E extends MainEvent>(event: E, payload: MainEvents[E]): void {
    const data = JSON.stringify({ type: 'event', event, payload });
    for (const client of this.clients) {
      if (client.bufferedAmount > FRONTEND_MAX_BYTES) client.terminate();
      else if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  }

  async close(): Promise<void> {
    await rm(this.file, { force: true });
    for (const client of this.clients) client.close(1001, 'Backend is shutting down');
    for (const client of this.clients) client.terminate();
    if (this.server) await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = null;
  }

  private async request(client: WebSocket, data: string): Promise<void> {
    let raw: unknown;
    try { raw = JSON.parse(data); } catch { client.close(1008, 'Invalid JSON'); return; }
    const parsed = frontendRequestSchema.safeParse(raw);
    if (!parsed.success) { client.close(1008, 'Invalid request'); return; }
    const { id, channel, args } = parsed.data;
    let reply: FrontendMessage;
    try {
      const handler = this.handlers[channel] as (...args: unknown[]) => unknown;
      reply = { type: 'reply', id, result: await handler(...args) };
    } catch (error) {
      reply = { type: 'reply', id, error: errorMessage(error) };
    }
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(reply));
  }
}
