import { readFileSync, rmSync, mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultConfig, type Config } from '@shared/config';
import type { ConnectionStatus, SessionEvent } from '@shared/types';
import { flushWrites } from '../src/main/core/durable';
import { ControlApi } from '../src/main/control-api';
import { Outbox } from '../src/main/sessions/outbox';
import { SessionStore } from '../src/main/sessions/store';

const CONNECTION: ConnectionStatus = { state: 'connected', detail: 'ok', surfaces: [] };

let dir: string;
let config: Config;
let store: SessionStore;
let outbox: Outbox;
let turns: Map<string, string>;
let api: ControlApi;
let port: number;
let token: string;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'control-api-test-'));
  config = defaultConfig();
  config.controlApi.enabled = true;
  store = new SessionStore(join(dir, 'sessions'), { recording: () => true });
  store.load();
  outbox = new Outbox(join(dir, 'outbox.json'));
  turns = new Map();
  api = new ControlApi({
    dir: join(dir, 'control-api'),
    version: '0.0.0-test',
    getConfig: () => config,
    store,
    outbox,
    turnOf: (id) => turns.get(id) ?? 'idle',
    connectionStatus: () => CONNECTION,
    agents: () => [],
    logs: () => []
  });
  await api.sync();
  const endpoint = JSON.parse(readFileSync(join(dir, 'control-api', 'endpoint.json'), 'utf8')) as { port: number };
  port = endpoint.port;
  token = readFileSync(join(dir, 'control-api', 'token'), 'utf8').trim();
});

afterEach(async () => {
  await api.close();
  await store.flush();
  await flushWrites();
  rmSync(dir, { recursive: true, force: true });
});

type EventsPage = { events: Record<string, unknown>[]; total: number; nextBefore: number | null; nextAfter: number | null };

async function call<T = Record<string, unknown>>(
  method: string,
  route: string,
  options: { auth?: string | null; body?: unknown; headers?: Record<string, string> } = {}
): Promise<{ status: number; body: T }> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.auth !== null) headers.authorization = `Bearer ${options.auth ?? token}`;
  if (options.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`http://127.0.0.1:${port}${route}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });
  return { status: res.status, body: await res.json() as T };
}

function note(id: string, text: string): SessionEvent {
  return { id, at: 1, kind: 'notice', level: 'info', text };
}

describe('ControlApi lifecycle and access', () => {
  it('writes a private token and endpoint on start and removes both on stop', async () => {
    // Windows has no POSIX modes; there the per-user profile folder's ACL keeps the files private.
    if (process.platform !== 'win32') {
      expect(statSync(join(dir, 'control-api', 'token')).mode & 0o777).toBe(0o600);
      expect(statSync(join(dir, 'control-api', 'endpoint.json')).mode & 0o777).toBe(0o600);
    }
    config.controlApi.enabled = false;
    await api.sync();
    expect(() => readFileSync(join(dir, 'control-api', 'token'))).toThrow();
    expect(() => readFileSync(join(dir, 'control-api', 'endpoint.json'))).toThrow();
  });

  it('requires the bearer token', async () => {
    expect((await call('GET', '/v1/health', { auth: null })).status).toBe(401);
    expect((await call('GET', '/v1/health', { auth: 'wrong' })).status).toBe(401);
    const health = await call('GET', '/v1/health');
    expect(health.status).toBe(200);
    expect(health.body.actions).toMatchObject({ enabled: false });
  });

  it('refuses any request that carries an Origin header, even with the token', async () => {
    const res = await call('GET', '/v1/health', { headers: { origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
  });
});

describe('ControlApi reads', () => {
  it('pages sessions by cursor, 50 per page, without repeats', async () => {
    for (let i = 0; i < 55; i++) store.create({ kind: 'chat' });
    const first = await call<{ sessions: { id: string }[]; nextCursor: string | null }>('GET', '/v1/sessions');
    expect(first.body.sessions).toHaveLength(50);
    expect(first.body.nextCursor).not.toBeNull();
    const second = await call<{ sessions: { id: string }[]; nextCursor: string | null }>('GET', `/v1/sessions?cursor=${encodeURIComponent(first.body.nextCursor!)}`);
    expect(second.body.sessions).toHaveLength(5);
    expect(second.body.nextCursor).toBeNull();
    const ids = [...first.body.sessions, ...second.body.sessions].map((session: { id: string }) => session.id);
    expect(new Set(ids).size).toBe(55);
  });

  it('pages events by position, filters kinds, cuts and redacts text', async () => {
    const chat = store.create({ kind: 'chat' });
    store.append(chat.id, [
      { id: 'e1', at: 1, kind: 'user', text: 'x'.repeat(5_000), inputId: null, attachments: [], source: 'app' },
      note('e2', 'api_key=abcdefgh12345678'),
      { id: 'e3', at: 3, kind: 'turn', phase: 'end', outcome: 'done', error: null },
      { id: 'e4', at: 4, kind: 'tool', surface: 'core', name: 'read', args: { path: 'a' }, status: 'ok', output: [{ type: 'text', text: 'y'.repeat(3_000) }], endedAt: 4 },
      note('e5', 'last')
    ]);
    const base = `/v1/sessions/${chat.id}/events`;

    const latest = await call<EventsPage>('GET', `${base}?limit=2`);
    expect(latest.body.events.map((event) => event.position)).toEqual([4, 5]);
    expect(latest.body.total).toBe(5);
    expect(latest.body.nextBefore).toBe(4);
    expect(latest.body.nextAfter).toBeNull();

    const older = await call<EventsPage>('GET', `${base}?before=4&limit=2`);
    expect(older.body.events.map((event) => event.position)).toEqual([2, 3]);
    expect(older.body.nextBefore).toBe(2);
    expect(older.body.nextAfter).toBe(3);

    const forward = await call<EventsPage>('GET', `${base}?after=0&limit=2`);
    expect(forward.body.events.map((event) => event.position)).toEqual([1, 2]);
    expect(forward.body.nextAfter).toBe(2);

    const kinds = await call<EventsPage>('GET', `${base}?kinds=notice,turn`);
    expect(kinds.body.total).toBe(3);

    const [user, notice, , tool] = (await call<EventsPage>('GET', base)).body.events;
    expect(user).toMatchObject({ text: { text: 'x'.repeat(4_000), truncated: true, chars: 5_000 } });
    expect(notice).toMatchObject({ text: { text: expect.not.stringContaining('abcdefgh12345678') } });
    expect(tool).toMatchObject({ output: [{ text: { text: 'y'.repeat(2_000) } }] });

    expect((await call('GET', `${base}?from=0&before=3`)).status).toBe(400);
    expect((await call('GET', `${base}?limit=101`)).status).toBe(400);
    expect((await call('GET', '/v1/sessions/missing-session-id/events')).status).toBe(404);
  });
});

describe('ControlApi actions', () => {
  it('answers 403 to every action while actions are disabled', async () => {
    const chat = store.create({ kind: 'chat' });
    const send = await call('POST', '/v1/inputs', {
      body: { id: crypto.randomUUID(), sessionId: chat.id, text: 'hi' }
    });
    expect(send.status).toBe(403);
    expect(send.body.error).toBe('actions_disabled');
    const cancel = await call('POST', `/v1/inputs/${crypto.randomUUID()}/cancel`, { body: {} });
    expect(cancel.status).toBe(403);
    expect(outbox.list()).toHaveLength(0);
  });

  it('sends once per id, refuses a reused id with other text, and cancels a queued message', async () => {
    config.controlApi.allowActions = true;
    const chat = store.create({ kind: 'chat' });
    const id = crypto.randomUUID();
    const body = { id, sessionId: chat.id, text: '  hello  ' };

    const first = await call('POST', '/v1/inputs', { body });
    expect(first.status).toBe(202);
    expect(first.body.input).toMatchObject({ id, state: 'queued', delivery: 'pending', text: { text: 'hello' } });

    const again = await call('POST', '/v1/inputs', { body });
    expect(again.status).toBe(200);
    expect(again.body.replayed).toBe(true);
    expect(outbox.list()).toHaveLength(1);

    const conflict = await call('POST', '/v1/inputs', { body: { ...body, text: 'other' } });
    expect(conflict.status).toBe(409);
    expect(conflict.body.error).toBe('id_conflict');

    const cancelled = await call('POST', `/v1/inputs/${id}/cancel`, { body: {} });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body).toMatchObject({ cancelled: true, input: { state: 'cancelled', delivery: 'not_sent' } });

    const cancelAgain = await call('POST', `/v1/inputs/${id}/cancel`, { body: {} });
    expect(cancelAgain.body.cancelled).toBe(false);

    const listed = await call<{ inputs: { id: string }[] }>('GET', '/v1/inputs?state=cancelled');
    expect(listed.body.inputs.map((input: { id: string }) => input.id)).toEqual([id]);
  });

  it('refuses worker and helper chats, and sends into a generating chat only with interrupt', async () => {
    config.controlApi.allowActions = true;
    const worker = store.create({ kind: 'worker' });
    const chat = store.create({ kind: 'chat' });
    const refused = await call('POST', '/v1/inputs', {
      body: { id: crypto.randomUUID(), sessionId: worker.id, text: 'hi' }
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe('session_not_controllable');

    turns.set(chat.id, 'generating');
    const busy = await call('POST', '/v1/inputs', { body: { id: crypto.randomUUID(), sessionId: chat.id, text: 'hi' } });
    expect(busy.body.error).toBe('would_interrupt');
    const interrupting = await call('POST', '/v1/inputs', {
      body: { id: crypto.randomUUID(), sessionId: chat.id, text: 'hi', interrupt: true }
    });
    expect(interrupting.status).toBe(202);
  });
});
