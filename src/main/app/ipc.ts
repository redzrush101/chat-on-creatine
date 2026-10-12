import { ipcMain, type WebContents } from 'electron';
import type { ApiHandlers } from './api';

export function registerIpc(handlers: ApiHandlers, isAppContents: (contents: WebContents) => boolean): void {
  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, (event, ...args: unknown[]) => {
      if (!isAppContents(event.sender)) throw new Error('Unauthorized sender');
      return (handler as (...a: unknown[]) => unknown)(...args);
    });
  }
}
