/**
 * Isolated-world entry of the companion extension: runs the page driver and relays its traffic
 * over a runtime port to the extension's service worker. Bundled by scripts/build-extension.mjs.
 */
import type { PageCommand, PageEvent, PageResult } from '@shared/page-protocol';
import { startDriver } from './driver';

/** Must match the channel the MAIN-world tap is installed with (scripts/build-extension.mjs). */
const TAP_CHANNEL = 'creatine-tap';
const PORT_NAME = 'creatine-driver';
const RECONNECT_MS = 500;

interface RuntimePort {
  postMessage(message: unknown): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

declare const chrome: { runtime: { connect(info: { name: string }): RuntimePort } };

/** Messages the service worker sends down the port. */
type ToPage =
  | { type: 'command'; id: string; command: PageCommand }
  /** Re-send the driver's last `hello`: the app lost track of this page, e.g. after a restart. */
  | { type: 'replay' }
  /** This tab is not managed by the bridge; stay quiet and do not reconnect. */
  | { type: 'detach' };

let port: RuntimePort | null = null;
let detached = false;
let lastHello: PageEvent | null = null;
let handler: ((command: PageCommand) => Promise<PageResult>) | null = null;

function post(message: unknown): void {
  try {
    port?.postMessage(message);
  } catch {
    // The port went away; the next connection replays what matters.
  }
}

function connect(): void {
  let next: RuntimePort;
  try {
    next = chrome.runtime.connect({ name: PORT_NAME });
  } catch {
    // The extension was reloaded or removed: this page is orphaned until it is reloaded.
    return;
  }
  port = next;
  next.onMessage.addListener((message) => {
    const msg = message as ToPage;
    if (msg.type === 'replay') {
      if (lastHello) post({ type: 'event', event: lastHello });
    } else if (msg.type === 'detach') {
      detached = true;
    } else if (msg.type === 'command') {
      const run = handler
        ? handler(msg.command).catch((error: unknown): PageResult => ({ ok: false, error: String(error), code: 'failed' }))
        : Promise.resolve<PageResult>({ ok: false, error: 'Driver not started', code: 'not-ready' });
      void run.then((result) => post({ type: 'result', id: msg.id, result }));
    }
  });
  next.onDisconnect.addListener(() => {
    if (port === next) port = null;
    if (!detached) setTimeout(connect, RECONNECT_MS);
  });
}

const transport = {
  send(event: PageEvent): void {
    if (event.type === 'hello') lastHello = event;
    post({ type: 'event', event });
  },
  onCommand(next: (command: PageCommand) => Promise<PageResult>): void {
    handler = next;
  }
};

connect();

const start = (): void => startDriver(transport, TAP_CHANNEL);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, { once: true });
else start();
