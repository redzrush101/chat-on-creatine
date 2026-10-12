import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { createMainWindow } from '../src/main/app/window';

const state = vi.hoisted(() => ({ trayAvailable: true }));
vi.mock('electron', () => ({
  BrowserWindow: class extends EventEmitter {
    webContents = Object.assign(new EventEmitter(), { getURL: () => '', setWindowOpenHandler: () => {} });
    show = vi.fn();
    hide = vi.fn();
    focus = vi.fn();
    loadFile = vi.fn(async () => {});
  },
  Tray: class extends EventEmitter {
    constructor() {
      super();
      if (!state.trayAvailable) throw new Error('No status area');
    }
    setToolTip() {}
    setContextMenu() {}
  },
  Menu: { buildFromTemplate: () => [] },
  nativeImage: { createFromPath: () => ({}) },
  shell: { openExternal: vi.fn() }
}));

afterEach(() => { state.trayAvailable = true; });

it.each([true, false])('hides on close only when a tray exists: %s', (available) => {
  state.trayAvailable = available;
  const quit = vi.fn();
  const window = createMainWindow({ preloadDir: '.', resourcesDir: '.', isQuitting: () => false,
    closeToTray: () => true, showChatGpt: () => {}, quit });
  const event = { preventDefault: vi.fn() };
  window.emit('close', event);
  expect(event.preventDefault).toHaveBeenCalledTimes(available ? 1 : 0);
  expect(window.hide).toHaveBeenCalledTimes(available ? 1 : 0);
  if (!available) {
    window.emit('closed');
    expect(quit).toHaveBeenCalledOnce();
  }
});
