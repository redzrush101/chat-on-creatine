import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '@shared/config';
import { conversationIdFromUrl, type ChatMessage, type PageCommand, type PageResult } from '@shared/page-protocol';
import type { HostEvents } from '../src/main/chatgpt/host';
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
let page: HostEvents;

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

const catalog = { models: [], defaultModel: null };

function setup(selection: PageResult = { ok: true }) {
  const command = vi.fn(async (_tabId: string, cmd: PageCommand): Promise<PageResult> => {
    if (cmd.type === 'select-model') return selection;
    if (cmd.type === 'stop') return { ok: false, error: 'no stop control is visible' };
    return { ok: true, value: { conversationId: 'conversation' } };
  });
  const ends: string[] = [];
  const onAuth = vi.fn();
  const opened: ReturnType<ChatHost['tabs']> = [];
  const host: ChatHost = {
    start: async () => {}, stop: async () => {},
    status: () => ({ ready: true, signedIn: true, windowVisible: false, detail: '' }),
    tabs: () => opened,
    openTab: vi.fn(async (url: string) => {
      const tabId = `tab${opened.length}`;
      opened.push({ tabId, url, conversationId: conversationIdFromUrl(url), driverReady: true, signedIn: true, generating: false, createdAt: 1 });
      return tabId;
    }),
    navigate: async () => {}, closeTab: async () => {},
    command, reveal: () => {}, hide: () => {}, setListener: (events) => { page = events; }
  };
  router = new ChatRouter({ host, store, outbox,
    recorder: new Recorder({ store, isOwnConnectorPath: () => false }),
    getConfig: defaultConfig, openingContext: async () => null, sessionCwd: () => null,
    canStart: () => true, onTurnEnd: (_session, outcome) => ends.push(outcome), onAuth, models: async () => catalog, onLiveChange: () => {}
  });
  return { command, host, ends, onAuth };
}

it('reports sign-in from an unbound browser tab, including the first setup', () => {
  const { onAuth } = setup();
  page.page('sign-in-tab', { type: 'auth', signedIn: true });
  expect(onAuth).toHaveBeenCalledWith(true);
});

describe('model selection before delivery', () => {
  it('applies the account default instead of keeping the previous native selection', async () => {
    const { command } = setup();
    const session = store.create({ kind: 'chat' });
    const item = outbox.enqueue({ sessionId: session.id, text: 'message', attachments: [], delivery: 'now', source: 'app' });
    await vi.waitFor(() => expect(outbox.get(item.id)?.state).toBe('sent'));
    expect(command.mock.calls.find((call) => call[1].type === 'select-model')?.[1]).toEqual({ type: 'select-model', model: '', effort: null, catalog });
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
    expect(command.mock.calls.map((call) => call[1]).filter((cmd) => cmd.type !== 'ready')).toEqual([
      { type: 'select-model', model: 'thinking', effort: 'medium', catalog }, { type: 'send', text: 'first', files: [] },
      { type: 'select-model', model: 'legacy-thinking', effort: 'high', catalog }, { type: 'send', text: 'second', files: [] }
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

  it('does not adopt a preloaded error page and confirms composer readiness before reuse', async () => {
    const { command, host } = setup();
    command.mockImplementation(async (tab, cmd) => cmd.type === 'ready' && tab === 'tab0' ? { ok: false, error: 'Composer did not load' } : { ok: true });
    host.closeTab = vi.fn(async () => {});
    router.start();
    await vi.waitFor(() => expect(host.closeTab).toHaveBeenCalledWith('tab0'));
    const session = store.create({ kind: 'chat' });
    await router.ensureTab(session, true);
    expect(vi.mocked(host.openTab).mock.calls).toHaveLength(3);
    expect(command.mock.calls.some(([tab, cmd]) => tab === 'tab0' && cmd.type === 'select-model')).toBe(false);
  });

  it('keeps the input as a readable failure and never sends when selection fails', async () => {
    const { command } = setup({ ok: false, error: 'Could not confirm the thinking level.' });
    const session = store.create({ kind: 'chat', model: 'thinking', reasoning: 'high' });
    const item = outbox.enqueue({ sessionId: session.id, text: 'message', attachments: [], delivery: 'now', source: 'app' });
    await vi.waitFor(() => expect(outbox.get(item.id)).toMatchObject({ state: 'failed', error: 'Could not confirm the thinking level.' }));
    expect(command.mock.calls.map((call) => call[1].type).filter((type) => type !== 'ready')).toEqual(['select-model']);
    expect(router.turnOf(session.id)).toBe('idle');
  });
});

describe('turn end', () => {
  const answer: ChatMessage = {
    id: 'answer', conversationId: 'conversation', role: 'assistant', authorName: null, recipient: 'all', channel: 'final',
    contentType: 'text', text: 'Done.', status: 'finished_successfully', endTurn: true, model: null, requestId: null,
    turnId: null, parentId: null, createTime: null, hidden: false, sources: [], citations: []
  };

  it('ends the turn at the final answer and ignores the stream end that follows', async () => {
    setup();
    const session = store.create({ kind: 'chat', conversationId: 'conversation' });
    const first = outbox.enqueue({ sessionId: session.id, text: 'first', attachments: [], delivery: 'now', source: 'app' });
    await vi.waitFor(() => expect(outbox.get(first.id)?.state).toBe('sent'));
    page.page('tab0', { type: 'turn-start', streamId: 's1', conversationId: 'conversation', requestId: null });
    const next = outbox.enqueue({ sessionId: session.id, text: 'next', attachments: [], delivery: 'after-turn', source: 'app' });
    page.page('tab0', { type: 'message', streamId: 's1', message: answer });
    expect(router.turnOf(session.id)).not.toBe('generating');
    await vi.waitFor(() => expect(outbox.get(next.id)?.state).toBe('sent'));
    page.page('tab0', { type: 'turn-start', streamId: 's2', conversationId: 'conversation', requestId: null });
    page.page('tab0', { type: 'turn-end', streamId: 's1', conversationId: 'conversation', outcome: 'complete', error: null });
    expect(router.turnOf(session.id)).toBe('generating');
  });

  async function generating() {
    const session = store.create({ kind: 'chat', conversationId: 'conversation' });
    const first = outbox.enqueue({ sessionId: session.id, text: 'first', attachments: [], delivery: 'now', source: 'app' });
    await vi.waitFor(() => expect(outbox.get(first.id)?.state).toBe('sent'));
    page.page('tab0', { type: 'turn-start', streamId: 's1', conversationId: 'conversation', requestId: null });
    return session;
  }

  it('does not replace fresh context with a late snapshot from the previous conversation', async () => {
    const { command } = setup();
    const session = await generating();
    let finish: (result: PageResult) => void = () => {};
    command.mockImplementation(async (_tab, cmd) => cmd.type === 'conversation'
      ? new Promise((resolve) => { finish = resolve; }) : { ok: true });
    page.page('tab0', { type: 'message', streamId: 's1', message: answer });
    store.append(session.id, [{ kind: 'handoff', id: 'handoff', at: 2, fromConversationId: 'conversation', toConversationId: null, brief: '' }]);
    store.update(session.id, { conversationId: null });
    finish({ ok: true, value: [{ ...answer, text: 'old context'.repeat(1000) }] });
    await new Promise((resolve) => setImmediate(resolve));
    expect(store.get(session.id)?.contextTokens).toBe(0);
  });

  it('does not end a turn as stopped when the stop control was missing', async () => {
    const { ends } = setup();
    const session = await generating();
    await router.stopTurn(session.id);
    page.page('tab0', { type: 'message', streamId: 's1', message: answer });
    expect(ends).toEqual(['done']);
  });

  it("sends the user's steered messages again after the turn, but not agent reports", async () => {
    setup();
    const session = await generating();
    for (const source of ['app', 'agent'] as const) {
      outbox.enqueue({ sessionId: session.id, text: `from ${source}`, attachments: [], delivery: 'now', source });
    }
    router.noteSteered(session.id, outbox.takeSteerable(session.id));
    page.page('tab0', { type: 'message', streamId: 's1', message: answer });
    const resent = outbox.list(session.id).filter((item) => item.source === 'automation');
    expect(resent.map((item) => item.text)).toEqual([expect.stringContaining('from app')]);
  });
});
