import { contextBridge, ipcRenderer } from 'electron';
import { PAGE_COMMAND_CHANNEL, PAGE_EVENT_CHANNEL, PAGE_RESULT_CHANNEL, type PageCommand, type PageEvent, type PageResult } from '@shared/page-protocol';
import { startDriver } from '../page/driver';
import { installFetchTap } from '../page/tap';


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
