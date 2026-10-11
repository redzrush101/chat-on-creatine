import { contextBridge, ipcRenderer } from 'electron';
import type { PageCommand, PageEvent, PageResult } from '@shared/page-protocol';
import { startDriver } from '../page/driver';
import { installFetchTap } from '../page/tap';

// Must match builtin-host.ts (not imported: that module pulls in the main-process Electron API).
const PAGE_EVENT_CHANNEL = 'creatine-page:event';
const PAGE_COMMAND_CHANNEL = 'creatine-page:command';
const PAGE_RESULT_CHANNEL = 'creatine-page:result';

const tapChannel = `creatine-tap-${crypto.randomUUID()}`;

// Runs before any page script, so the tap sees the very first conversation request.
contextBridge.executeInMainWorld({ func: installFetchTap, args: [tapChannel] });

let commandHandler: ((command: PageCommand) => Promise<PageResult>) | null = null;

ipcRenderer.on(PAGE_COMMAND_CHANNEL, (_event, payload: { id: string; command: PageCommand }) => {
  const run = commandHandler
    ? commandHandler(payload.command).catch((error: unknown): PageResult => ({ ok: false, error: String(error), code: 'failed' }))
    : Promise.resolve<PageResult>({ ok: false, error: 'Driver not started', code: 'not-ready' });
  void run.then((result) => ipcRenderer.send(PAGE_RESULT_CHANNEL, { id: payload.id, result }));
});

const start = () =>
  startDriver(
    {
      send: (event: PageEvent) => ipcRenderer.send(PAGE_EVENT_CHANNEL, event),
      onCommand: (handler) => {
        commandHandler = handler;
      }
    },
    tapChannel
  );

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();
