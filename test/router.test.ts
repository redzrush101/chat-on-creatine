import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '@shared/config';
import { conversationIdFromUrl, type PageCommand, type PageResult } from '@shared/page-protocol';
import type { ChatHost } from '../src/main/chatgpt/host';
import { ChatRouter } from '../src/main/chatgpt/router';
import { flushWrites } from '../src/main/core/durable';
import { Outbox } from '../src/main/sessions/outbox';
import { Recorder } from '../src/main/sessions/recorder';
import { SessionStore } from '../src/main/sessions/store';

let dir: string;
let store: SessionStore;
let outbox: Outbox;
let router: ChatRouter;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'router-test-'));
  store = new SessionStore(join(dir, 'sessions'), { recording: () => true });
  store.load();
  outbox = new Outbox(join(dir, 'outbox.json'));
});

afterEach(async () => {
  router.stop();
  await store.flush();
  await flushWrites();
  rmSync(dir, { recursive: true, force: true });
});

function setup(selection: PageResult = { ok: true }) {
  const command = vi.fn(async (_tabId: string, cmd: PageCommand): Promise<PageResult> =>
    cmd.type === 'select-model' ? selection : { ok: true, value: { conversationId: 'conversation' } });
  const opened: ReturnType<ChatHost['tabs']> = [];
  const host: ChatHost = {
    kind: 'builtin', start: async () => {}, stop: async () => {},
    status: () => ({ ready: true, signedIn: true, windowVisible: false, extensionConnected: false, detail: '' }),
    tabs: () => opened,
    openTab: vi.fn(async (url: string) => {
      const tabId = `tab${opened.length}`;
      opened.push({ tabId, url, conversationId: conversationIdFromUrl(url), driverReady: true, signedIn: true, generating: false, createdAt: 1 });
      return tabId;
    }),
    navigate: async () => {}, closeTab: async () => {},
    command, reveal: () => {}, hide: () => {}, setListener: () => {}
  };
  router = new ChatRouter({ host, store, outbox,
    recorder: new Recorder({ store, isOwnConnectorPath: () => false }),
    getConfig: defaultConfig, openingContext: async () => null, sessionCwd: () => null,
    canStart: () => true, onTurnEnd: () => {}, onLiveChange: () => {}
  });
  return { command, host };
}

describe('model selection before delivery', () => {
  it('applies the account default instead of keeping the previous native selection', async () => {
    const { command } = setup();
    const session = store.create({ kind: 'chat' });
    const item = outbox.enqueue({ sessionId: session.id, text: 'message', attachments: [], delivery: 'now', source: 'app' });
    await vi.waitFor(() => expect(outbox.get(item.id)?.state).toBe('sent'));
    expect(command.mock.calls[0]?.[1]).toEqual({ type: 'select-model', model: '', effort: null });
  });

  it('applies changed model and effort on an existing conversation before sending', async () => {
    const { command, host } = setup();
    const session = store.create({ kind: 'chat', conversationId: 'conversation', model: 'thinking', reasoning: 'medium' });
    const first = outbox.enqueue({ sessionId: session.id, text: 'first', attachments: [], delivery: 'now', source: 'app' });
    await vi.waitFor(() => expect(outbox.get(first.id)?.state).toBe('sent'));
    router.setTurn(session.id, 'idle');
    store.update(session.id, { model: 'legacy-thinking', reasoning: 'high' });
    const second = outbox.enqueue({ sessionId: session.id, text: 'second', attachments: [], delivery: 'now', source: 'app' });
    await vi.waitFor(() => expect(outbox.get(second.id)?.state).toBe('sent'));
    expect(command.mock.calls.map((call) => call[1])).toEqual([
      { type: 'select-model', model: 'thinking', effort: 'medium' }, { type: 'send', text: 'first', files: [] },
      { type: 'select-model', model: 'legacy-thinking', effort: 'high' }, { type: 'send', text: 'second', files: [] }
    ]);
    expect(vi.mocked(host.openTab).mock.calls.filter(([url]) => url.includes('/c/'))).toHaveLength(1);
  });

  it('starts a new chat in the preloaded tab instead of loading chatgpt.com again', async () => {
    const { command, host } = setup();
    router.start();
    await vi.waitFor(() => expect(host.openTab).toHaveBeenCalledOnce());
    const session = store.create({ kind: 'chat' });
    const item = outbox.enqueue({ sessionId: session.id, text: 'message', attachments: [], delivery: 'now', source: 'app' });
    await vi.waitFor(() => expect(outbox.get(item.id)?.state).toBe('sent'));
    expect(command.mock.calls[0]?.[0]).toBe('tab0');
    // The adopted tab is replaced by a new preloaded one for the next chat.
    await vi.waitFor(() => expect(host.openTab).toHaveBeenCalledTimes(2));
  });

  it('keeps the input as a readable failure and never sends when selection fails', async () => {
    const { command } = setup({ ok: false, error: 'Could not confirm the thinking level.' });
    const session = store.create({ kind: 'chat', model: 'thinking', reasoning: 'high' });
    const item = outbox.enqueue({ sessionId: session.id, text: 'message', attachments: [], delivery: 'now', source: 'app' });
    await vi.waitFor(() => expect(outbox.get(item.id)).toMatchObject({ state: 'failed', error: 'Could not confirm the thinking level.' }));
    expect(command.mock.calls.map((call) => call[1].type)).toEqual(['select-model']);
    expect(router.turnOf(session.id)).toBe('idle');
  });
});

