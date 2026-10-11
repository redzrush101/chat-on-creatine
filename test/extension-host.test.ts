import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import type { PageEvent } from '@shared/page-protocol';
import { ExtensionHost } from '../src/main/chatgpt/extension-host';

type Frame = { type: string; [key: string]: unknown };

/** A fake companion extension: records frames and lets a test wait for the next one of a type. */
class FakeBackground {
  private readonly frames: Frame[] = [];
  private waiters: Array<() => void> = [];
  closeCode: number | null = null;

  constructor(readonly socket: WebSocket) {
    socket.on('message', (data) => {
      this.frames.push(JSON.parse(data.toString()) as Frame);
      for (const wake of this.waiters.splice(0)) wake();
    });
    socket.on('close', (code) => {
      this.closeCode = code;
    });
  }

  static open(port: number, origin = 'chrome-extension://abc'): Promise<FakeBackground> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(`ws://127.0.0.1:${port}/`, { origin });
      socket.once('open', () => resolve(new FakeBackground(socket)));
      socket.once('error', reject);
    });
  }

  send(frame: unknown): void {
    this.socket.send(JSON.stringify(frame));
  }

  reply(id: string, result: unknown): void {
    this.send({ type: 'result', id, result });
  }

  async next(type: string): Promise<Frame> {
    for (;;) {
      const index = this.frames.findIndex((frame) => frame.type === type);
      if (index >= 0) return this.frames.splice(index, 1)[0]!;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }
}

const HELLO_EVENT: PageEvent = {
  type: 'hello',
  driverVersion: 1,
  url: 'https://chatgpt.com/c/abc12345',
  conversationId: 'abc12345',
  signedIn: true
};

let token: string | null;
let host: ExtensionHost;

beforeEach(async () => {
  token = null;
  host = new ExtensionHost({ port: 0, loadToken: () => token, saveToken: (next) => void (token = next) });
  await host.start();
});

afterEach(async () => {
  await host.stop();
});

/** Pairs a fresh fake extension and leaves it connected. */
async function pair(): Promise<FakeBackground> {
  const background = await FakeBackground.open(host.listeningPort);
  background.send({ type: 'hello', token: null, pair: true });
  const reply = await background.next('hello');
  expect(reply.ok).toBe(true);
  token = reply.token as string;
  return background;
}

describe('ExtensionHost pairing', () => {
  it('mints a token on the first connection and requires it afterwards', async () => {
    const first = await pair();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    first.socket.close();

    const again = await FakeBackground.open(host.listeningPort);
    again.send({ type: 'hello', token });
    expect((await again.next('hello')).ok).toBe(true);
    expect(host.status().extensionConnected).toBe(true);
    again.socket.close();
  });

  it('rejects a wrong token and closes the connection', async () => {
    await pair();
    const intruder = await FakeBackground.open(host.listeningPort);
    intruder.send({ type: 'hello', token: 'not-the-token' });
    const reply = await intruder.next('hello');
    expect(reply.ok).toBe(false);
    await vi.waitFor(() => expect(intruder.closeCode).toBe(4401));
  });

  it('rejects any origin that is not a chrome extension', async () => {
    await expect(FakeBackground.open(host.listeningPort, 'https://chatgpt.com')).rejects.toThrow(/403/);
  });
});

describe('ExtensionHost tabs and commands', () => {
  it('opens a tab, runs a command through the page and delivers page events', async () => {
    const background = await pair();
    const events: Array<[string, PageEvent]> = [];
    host.setListener({ page: (tabId, event) => events.push([tabId, event]), closed: () => {}, status: () => {} });

    const opened = host.openTab('https://chatgpt.com/');
    const openFrame = await background.next('tab-open');
    background.reply(openFrame.id as string, { ok: true, value: { tabId: '42' } });
    expect(await opened).toBe('42');

    background.send({ type: 'page-event', tabId: '42', event: HELLO_EVENT });
    background.send({ type: 'page-event', tabId: '42', event: { type: 'generating', value: true } });

    const result = host.command('42', { type: 'status' });
    const commandFrame = await background.next('command');
    expect(commandFrame.tabId).toBe('42');
    expect(commandFrame.command).toEqual({ type: 'status' });
    background.reply(commandFrame.id as string, { ok: true, value: { composerReady: true } });
    expect(await result).toEqual({ ok: true, value: { composerReady: true } });

    expect(events.map(([tabId, event]) => [tabId, event.type])).toEqual([
      ['42', 'hello'],
      ['42', 'generating']
    ]);
    expect(host.tabs()[0]).toMatchObject({ tabId: '42', driverReady: true, conversationId: 'abc12345' });
    background.socket.close();
  });

  it('reports a closed tab to the listener and fails its pending commands', async () => {
    const background = await pair();
    const closed = vi.fn();
    host.setListener({ page: () => {}, closed, status: () => {} });

    const opened = host.openTab('https://chatgpt.com/');
    background.reply((await background.next('tab-open')).id as string, { ok: true, value: { tabId: '7' } });
    await opened;
    background.send({ type: 'page-event', tabId: '7', event: HELLO_EVENT });

    const pendingCommand = host.command('7', { type: 'stop' });
    await background.next('command');
    background.send({ type: 'tab-closed', tabId: '7' });

    await vi.waitFor(() => expect(closed).toHaveBeenCalledWith('7'));
    expect(await pendingCommand).toMatchObject({ ok: false, code: 'failed' });
    expect(host.tabs()).toEqual([]);
    background.socket.close();
  });
});
