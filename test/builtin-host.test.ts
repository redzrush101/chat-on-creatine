import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type { PageResult } from '@shared/page-protocol';
import { BuiltinHost } from '../src/main/chatgpt/builtin-host';

const cookies = vi.hoisted(() => ({ signedIn: false, changed: null as (() => void) | null, flush: vi.fn(async () => {}) }));

vi.mock('electron', () => ({
  ipcMain: new EventEmitter(),
  session: { fromPartition: () => ({ getUserAgent: () => '', setUserAgent: () => {},
    setPermissionRequestHandler: () => {}, cookies: {
      get: async () => cookies.signedIn ? [{ name: '__Secure-next-auth.session-token' }] : [],
      on: (_name: string, listener: () => void) => { cookies.changed = listener; },
      removeListener: () => { cookies.changed = null; }, flushStore: cookies.flush
    } }) },
  WebContentsView: class {
    setBounds() {}
    webContents = Object.assign(new EventEmitter(), { id: 1, setWindowOpenHandler: () => {}, loadURL: async () => {},
      isDestroyed: () => false, close: () => {} });
  }
}));

afterEach(() => { vi.useRealTimers(); cookies.signedIn = false; cookies.changed = null; cookies.flush.mockClear(); });

it('fails a command immediately when its tab closes before the driver is ready', async () => {
  vi.useFakeTimers();
  const host = new BuiltinHost({ preloadPath: '.' });
  try {
    await host.start();
    const tab = await host.openTab('https://chatgpt.com/');
    let result: PageResult | null = null;
    void host.command(tab, { type: 'models' }).then((value) => { result = value; });
    await host.closeTab(tab);
    await vi.advanceTimersByTimeAsync(1);
    expect(result).toEqual({ ok: false, error: 'Tab closed', code: 'failed' });
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    await host.stop();
  }
});

it('publishes login and logout cookie changes to both frontends and flushes the shared profile on shutdown', async () => {
  const host = new BuiltinHost({ preloadPath: '.' });
  const changed = vi.fn();
  host.setListener({ status: changed, page: () => {}, closed: () => {} });
  await host.start();
  cookies.signedIn = true;
  cookies.changed?.();
  await vi.waitFor(() => expect(host.status().signedIn).toBe(true));
  cookies.signedIn = false;
  cookies.changed?.();
  await vi.waitFor(() => expect(host.status().signedIn).toBe(false));
  expect(changed).toHaveBeenCalledTimes(2);
  await host.stop();
  expect(cookies.flush).toHaveBeenCalledOnce();
  expect(cookies.changed).toBeNull();
});
