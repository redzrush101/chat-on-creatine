import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import type { PageResult } from '@shared/page-protocol';
import { BuiltinHost } from '../src/main/chatgpt/builtin-host';

vi.mock('electron', () => ({
  ipcMain: new EventEmitter(),
  session: { fromPartition: () => ({ getUserAgent: () => '', setUserAgent: () => {},
    setPermissionRequestHandler: () => {}, cookies: { get: async () => [] } }) },
  WebContentsView: class {
    webContents = Object.assign(new EventEmitter(), { id: 1, setWindowOpenHandler: () => {}, loadURL: async () => {},
      isDestroyed: () => false, close: () => {} });
  }
}));

afterEach(() => { vi.useRealTimers(); });

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
