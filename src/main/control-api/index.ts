import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { createLogger } from '../core/log';
import { actionsAllowed, isActionRoute, serveAction } from './actions';
import { serveRead } from './reads';
import { ApiError, type ApiReply, type ControlApiDeps } from './types';

export type { ControlApiDeps } from './types';

/**
 * Opt-in loopback API for a local agent that watches the app. Off unless `controlApi.enabled`;
 * actions need `controlApi.allowActions` as well. Every request needs the bearer token from the
 * token file, and a request carrying an Origin header is refused, so no web page can reach it.
 */

const log = createLogger('control-api');
const TOKEN_FILE = 'token';
const ENDPOINT_FILE = 'endpoint.json';
const RATE_LIMIT = 20;
const RATE_WINDOW_MS = 1_000;
const MAX_BODY_BYTES = 512 * 1024;
const ROUTES = [
  'GET /v1/health',
  'GET /v1/status',
  'GET /v1/sessions',
  'GET /v1/sessions/{id}',
  'GET /v1/sessions/{id}/events',
  'GET /v1/inputs',
  'GET /v1/agents',
  'GET /v1/log'
];
const ACTION_ROUTES = ['POST /v1/inputs', 'POST /v1/inputs/{id}/cancel'];

export class ControlApi {
  private server: http.Server | null = null;
  private queue: Promise<void> = Promise.resolve();
  private readonly requestTimes: number[] = [];

  constructor(private readonly deps: ControlApiDeps) {}

  /** Starts the listener when the API is on and stops it when off. Calls run one at a time. */
  sync(): Promise<void> {
    return this.serial(async () => {
      const enabled = this.deps.getConfig().controlApi.enabled;
      if (enabled && !this.server) await this.start();
      else if (!enabled && this.server) await this.stop();
    });
  }

  /** Stops the listener and removes its files, for app quit. */
  close(): Promise<void> {
    return this.serial(() => this.stop());
  }

  private serial(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async start(): Promise<void> {
    const token = randomBytes(32).toString('base64url');
    const server: http.Server = http.createServer((req, res) => {
      this.handle(req, res, token, server).catch((error: unknown) => {
        log.error('request failed', error);
        if (!res.headersSent) send(res, 500, { error: 'internal_error' });
        else res.destroy();
      });
    });
    server.headersTimeout = 15_000;
    server.requestTimeout = 30_000;
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const { port } = server.address() as AddressInfo;
    const { dir } = this.deps;
    try {
      await mkdir(dir, { recursive: true });
      await removeFiles(dir);
      // The token lands first, so a caller that finds the endpoint can always read the matching token.
      await writeFile(path.join(dir, TOKEN_FILE), `${token}\n`, { mode: 0o600 });
      const endpoint = { port, pid: process.pid, version: this.deps.version };
      await writeFile(path.join(dir, ENDPOINT_FILE), `${JSON.stringify(endpoint, null, 2)}\n`, { mode: 0o600 });
    } catch (error) {
      server.close();
      await removeFiles(dir);
      throw error;
    }
    this.server = server;
    log.info(`listening on 127.0.0.1:${port}`);
  }

  private async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    await removeFiles(this.deps.dir);
    if (!server) return;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
      setTimeout(() => server.closeAllConnections(), 2_000).unref();
    });
    log.info('stopped');
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse, token: string, server: http.Server): Promise<void> {
    if (req.headers.origin !== undefined) return send(res, 403, { error: 'origin_forbidden' });
    const { port } = server.address() as AddressInfo;
    const host = req.headers.host;
    if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return send(res, 403, { error: 'host_forbidden' });
    const header = req.headers.authorization ?? '';
    if (!header.startsWith('Bearer ') || !safeEqual(header.slice(7), token)) return send(res, 401, { error: 'unauthorized' });
    if (this.rateLimited()) return send(res, 429, { error: 'rate_limited' }, { 'retry-after': '1' });
    try {
      const reply = await this.dispatch(req, new URL(req.url ?? '/', 'http://127.0.0.1'));
      return send(res, reply.status, reply.body);
    } catch (error) {
      if (error instanceof ApiError) {
        return send(res, error.status, { error: error.code, ...(error.detail ? { detail: error.detail } : {}) });
      }
      throw error;
    }
  }

  private async dispatch(req: http.IncomingMessage, url: URL): Promise<ApiReply> {
    const method = req.method ?? 'GET';
    const route = url.pathname;
    if (method === 'POST' && isActionRoute(route)) {
      // Refused before the body is read, so a disabled API learns nothing from what is sent.
      if (!actionsAllowed(this.deps.getConfig())) throw new ApiError(403, 'actions_disabled');
      return serveAction(this.deps, route, await readJson(req));
    }
    if (method !== 'GET') throw new ApiError(405, 'method_not_allowed');
    if (route === '/v1/health') {
      return {
        status: 200,
        body: {
          ok: true,
          pid: process.pid,
          appVersion: this.deps.version,
          uptimeSeconds: Math.round(process.uptime()),
          routes: ROUTES,
          actions: { enabled: actionsAllowed(this.deps.getConfig()), routes: ACTION_ROUTES }
        }
      };
    }
    const body = serveRead(this.deps, route, url.searchParams);
    if (body === undefined) throw new ApiError(404, 'not_found');
    return { status: 200, body };
  }

  private rateLimited(): boolean {
    const now = Date.now();
    while (this.requestTimes.length && now - this.requestTimes[0]! >= RATE_WINDOW_MS) this.requestTimes.shift();
    if (this.requestTimes.length >= RATE_LIMIT) return true;
    this.requestTimes.push(now);
    return false;
  }
}

async function removeFiles(dir: string): Promise<void> {
  // The endpoint goes first: a caller that can no longer find the port stops trying.
  await rm(path.join(dir, ENDPOINT_FILE), { force: true });
  await rm(path.join(dir, TOKEN_FILE), { force: true });
}

function send(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(text)),
    'cache-control': 'no-store',
    ...(status >= 400 ? { connection: 'close' } : {}),
    ...headers
  });
  res.end(text);
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  return left.length === right.length && timingSafeEqual(left, right);
}

/** The JSON body of an action, or undefined when there is none. */
async function readJson(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new ApiError(413, 'body_too_large');
    chunks.push(chunk as Buffer);
  }
  if (size === 0) return undefined;
  if (!/^application\/json\b/i.test(req.headers['content-type'] ?? '')) throw new ApiError(415, 'unsupported_media_type');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new ApiError(400, 'invalid_json');
  }
}
