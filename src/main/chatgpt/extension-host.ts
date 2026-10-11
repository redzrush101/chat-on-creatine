import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { PageCommand, PageEvent, PageResult } from '@shared/page-protocol';
import { conversationIdFromUrl } from '@shared/page-protocol';
import { createLogger } from '../core/log';
import type { ChatHost, HostEvents, HostStatus, TabInfo } from './host';

const log = createLogger('extension');

const HELLO_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 30_000;
const READY_WAIT_MAX_MS = 45_000;
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_REPLACED = 4000;

export interface ExtensionHostDeps {
  port: number;
  loadToken(): string | null;
  saveToken(token: string): void;
}

interface TabEntry {
  tabId: string;
  url: string;
  loading: boolean;
}

/** Frames the companion extension's service worker sends. `hello` opens every connection. */
type InboundFrame =
  | { type: 'hello'; token: string | null; pair?: boolean }
  | { type: 'page-event'; tabId: string; event: PageEvent }
  | { type: 'tab-closed'; tabId: string }
  | { type: 'tabs'; tabs: TabEntry[] }
  | { type: 'result'; id: string; result: PageResult };

/** Requests the app sends; each is answered by a `result` frame carrying the same id. */
type Request =
  | { type: 'tab-open'; url: string; reveal: boolean }
  | { type: 'tab-navigate'; tabId: string; url: string }
  | { type: 'tab-close'; tabId: string }
  | { type: 'tab-reveal'; tabId: string }
  | { type: 'command'; tabId: string; command: PageCommand };

interface Tab {
  info: TabInfo;
  /** Last loading state the extension reported; a new load resets the driver until it says hello. */
  loading: boolean;
  readyWaiters: Array<() => void>;
}

interface Pending {
  tabId: string | null;
  resolve(result: PageResult): void;
  timer: NodeJS.Timeout;
}

/**
 * ChatGPT in the user's own Chromium-based browser, reached through the companion extension.
 * The extension connects to a loopback WebSocket; the first connection is paired with a token
 * the app stores, and every later one must present it. Tabs are the ones the app opened.
 */
export class ExtensionHost implements ChatHost {
  readonly kind = 'extension' as const;
  private server: WebSocketServer | null = null;
  /** The one authenticated connection; a newer one replaces it. */
  private socket: WebSocket | null = null;
  private token: string | null;
  private pairingOpen: boolean;
  private readonly tabsById = new Map<string, Tab>();
  private readonly pending = new Map<string, Pending>();
  private selected: string | null = null;
  private listener: HostEvents | null = null;
  private signedIn: boolean | null = null;

  constructor(private readonly deps: ExtensionHostDeps) {
    this.token = deps.loadToken();
    this.pairingOpen = this.token === null;
  }

  /** The port actually listening; differs from the configured one when that is 0 (tests). */
  get listeningPort(): number {
    const address = this.server?.address();
    return typeof address === 'object' && address !== null ? address.port : this.deps.port;
  }

  /** Accepts a new pairing, e.g. when the user re-pairs a browser. */
  openPairing(): void {
    this.pairingOpen = true;
  }

  setListener(events: HostEvents): void {
    this.listener = events;
  }

  async start(): Promise<void> {
    if (this.server) return;
    const server = new WebSocketServer({
      host: '127.0.0.1',
      port: this.deps.port,
      maxPayload: MAX_PAYLOAD_BYTES,
      verifyClient: ({ origin }, done) => (origin.startsWith('chrome-extension://') ? done(true) : done(false, 403))
    });
    server.on('connection', (socket) => this.accept(socket));
    server.on('error', (error) => log.warn(`bridge server error: ${error.message}`));
    await new Promise<void>((resolve, reject) => {
      server.once('listening', () => resolve());
      server.once('error', reject);
    });
    this.server = server;
  }

  async stop(): Promise<void> {
    for (const tabId of [...this.tabsById.keys()]) await this.closeTab(tabId);
    this.failPending(null, 'Chrome extension bridge stopped', 'failed');
    const server = this.server;
    this.server = null;
    this.socket = null;
    if (!server) return;
    for (const client of server.clients) client.terminate();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  status(): HostStatus {
    const connected = this.socket !== null;
    const count = this.tabsById.size;
    return {
      ready: this.server !== null,
      signedIn: this.signedIn,
      // The browser window belongs to the user; the app cannot observe it.
      windowVisible: false,
      extensionConnected: connected,
      detail: !connected
        ? `Waiting for the Chrome extension on port ${this.listeningPort}.`
        : this.signedIn === false
          ? 'Sign in to ChatGPT in your browser.'
          : `${count} ChatGPT tab${count === 1 ? '' : 's'} open.`
    };
  }

  tabs(): TabInfo[] {
    return [...this.tabsById.values()].map((tab) => ({ ...tab.info }));
  }

  async openTab(url: string, options: { reveal?: boolean } = {}): Promise<string> {
    const result = await this.request({ type: 'tab-open', url, reveal: options.reveal === true }, null);
    if (!result.ok) throw new Error(result.error);
    const tabId = (result.value as { tabId?: unknown } | undefined)?.tabId;
    if (typeof tabId !== 'string') throw new Error('Chrome extension returned no tab id');
    if (!this.tabsById.has(tabId)) this.adopt(tabId, url);
    if (options.reveal) this.selected = tabId;
    this.listener?.status();
    return tabId;
  }

  async navigate(tabId: string, url: string): Promise<void> {
    const tab = this.requireTab(tabId);
    tab.info.driverReady = false;
    const result = await this.request({ type: 'tab-navigate', tabId, url }, tabId);
    if (!result.ok) throw new Error(result.error);
    tab.info.url = url;
    tab.info.conversationId = conversationIdFromUrl(url);
  }

  async closeTab(tabId: string): Promise<void> {
    if (!this.tabsById.has(tabId)) return;
    this.send({ type: 'tab-close', tabId, id: randomUUID() });
    this.forget(tabId);
  }

  async command(tabId: string, command: PageCommand, timeoutMs = COMMAND_TIMEOUT_MS): Promise<PageResult> {
    const tab = this.tabsById.get(tabId);
    if (!tab) return { ok: false, error: 'No such tab', code: 'failed' };
    if (!tab.info.driverReady && !(await this.waitForDriver(tab, Math.min(timeoutMs, READY_WAIT_MAX_MS)))) {
      return { ok: false, error: 'ChatGPT page did not finish loading', code: 'not-ready' };
    }
    return this.request({ type: 'command', tabId, command }, tabId, timeoutMs);
  }

  reveal(tabId: string | null): void {
    const target = tabId ?? this.selected ?? [...this.tabsById.keys()].at(-1) ?? null;
    if (!target) {
      this.openTab('https://chatgpt.com/', { reveal: true }).catch((error: Error) => log.warn(`reveal failed: ${error.message}`));
      return;
    }
    this.selected = target;
    void this.request({ type: 'tab-reveal', tabId: target }, target);
    this.listener?.status();
  }

  hide(): void {
    // Nothing to hide: the browser window is the user's.
  }

  // ------------------------------------------------------------------ connections

  private accept(socket: WebSocket): void {
    let authorized = false;
    const helloTimer = setTimeout(() => socket.close(CLOSE_UNAUTHORIZED, 'no hello'), HELLO_TIMEOUT_MS);
    socket.on('message', (data) => {
      const frame = parseFrame(data);
      if (authorized) {
        if (frame) this.dispatch(frame);
        return;
      }
      clearTimeout(helloTimer);
      if (!frame || frame.type !== 'hello') {
        socket.close(CLOSE_UNAUTHORIZED, 'expected hello');
        return;
      }
      const verdict = this.authorize(frame);
      if (!verdict.ok) {
        socket.send(JSON.stringify({ type: 'hello', ok: false, error: verdict.error }));
        socket.close(CLOSE_UNAUTHORIZED, verdict.error);
        return;
      }
      socket.send(JSON.stringify({ type: 'hello', ok: true, token: verdict.minted ?? undefined }));
      authorized = true;
      if (this.socket) {
        this.socket.close(CLOSE_REPLACED, 'replaced');
        this.failPending(null, 'Chrome extension reconnected', 'not-ready');
      }
      this.socket = socket;
      this.listener?.status();
    });
    socket.on('close', () => {
      clearTimeout(helloTimer);
      if (this.socket !== socket) return;
      this.socket = null;
      this.failPending(null, 'Chrome extension disconnected', 'not-ready');
      this.listener?.status();
    });
  }

  /** Accepts the token, or mints the first one while pairing is open. */
  private authorize(hello: { token: string | null }): { ok: true; minted: string | null } | { ok: false; error: string } {
    if (this.token !== null && typeof hello.token === 'string' && safeEqual(hello.token, this.token)) {
      this.pairingOpen = false;
      return { ok: true, minted: null };
    }
    if (this.pairingOpen) {
      const token = randomBytes(32).toString('hex');
      this.deps.saveToken(token);
      this.token = token;
      this.pairingOpen = false;
      return { ok: true, minted: token };
    }
    return { ok: false, error: this.token === null ? 'Not paired: open pairing in the app.' : 'Invalid pairing token.' };
  }

  private dispatch(frame: InboundFrame): void {
    switch (frame.type) {
      case 'page-event':
        this.handlePageEvent(frame.tabId, frame.event);
        break;
      case 'tab-closed':
        this.forget(frame.tabId);
        break;
      case 'tabs':
        this.sync(frame.tabs);
        break;
      case 'result': {
        const pending = this.pending.get(frame.id);
        if (!pending) break;
        this.pending.delete(frame.id);
        clearTimeout(pending.timer);
        pending.resolve(frame.result);
        break;
      }
      case 'hello':
        break;
    }
  }

  private send(frame: Request & { id: string }): boolean {
    if (!this.socket || this.socket.readyState !== WebSocket.OPEN) return false;
    this.socket.send(JSON.stringify(frame));
    return true;
  }

  /** Sends one request and resolves with the extension's result, or with a failure if it cannot be sent or times out. */
  private request(body: Request, tabId: string | null, timeoutMs = REQUEST_TIMEOUT_MS): Promise<PageResult> {
    const id = randomUUID();
    return new Promise<PageResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: `Timed out waiting for the Chrome extension (${body.type})`, code: 'timeout' });
      }, timeoutMs);
      this.pending.set(id, { tabId, resolve, timer });
      if (this.send({ ...body, id })) return;
      clearTimeout(timer);
      this.pending.delete(id);
      resolve({ ok: false, error: 'Chrome extension is not connected', code: 'not-ready' });
    });
  }

  private failPending(tabId: string | null, error: string, code: 'failed' | 'not-ready'): void {
    for (const [id, pending] of this.pending) {
      if (tabId !== null && pending.tabId !== tabId) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.resolve({ ok: false, error, code });
    }
  }

  // ------------------------------------------------------------------ tabs and page events

  private requireTab(tabId: string): Tab {
    const tab = this.tabsById.get(tabId);
    if (!tab) throw new Error(`No such tab ${tabId}`);
    return tab;
  }

  private adopt(tabId: string, url: string): Tab {
    const tab: Tab = {
      info: {
        tabId,
        url,
        conversationId: conversationIdFromUrl(url),
        driverReady: false,
        signedIn: null,
        generating: false,
        createdAt: Date.now()
      },
      loading: false,
      readyWaiters: []
    };
    this.tabsById.set(tabId, tab);
    return tab;
  }

  /** Replaces what the app knows about its tabs with the extension's snapshot. */
  private sync(entries: unknown): void {
    const seen = new Set<string>();
    for (const entry of Array.isArray(entries) ? entries : []) {
      if (!isTabEntry(entry)) continue;
      seen.add(entry.tabId);
      const tab = this.tabsById.get(entry.tabId) ?? this.adopt(entry.tabId, entry.url);
      if (tab.info.url !== entry.url) {
        tab.info.url = entry.url;
        tab.info.conversationId = conversationIdFromUrl(entry.url);
      }
      // Only a transition to loading resets the driver; title and URL updates mid-load do not.
      if (entry.loading && !tab.loading) tab.info.driverReady = false;
      tab.loading = entry.loading;
    }
    for (const tabId of [...this.tabsById.keys()]) if (!seen.has(tabId)) this.forget(tabId);
    this.listener?.status();
  }

  private forget(tabId: string): void {
    if (!this.tabsById.delete(tabId)) return;
    this.failPending(tabId, 'Tab closed', 'failed');
    if (this.selected === tabId) this.selected = null;
    this.listener?.closed(tabId);
    this.listener?.status();
  }

  private handlePageEvent(tabId: string, event: PageEvent): void {
    const tab = this.tabsById.get(tabId);
    if (!tab) return;
    switch (event.type) {
      case 'hello':
        tab.info.driverReady = true;
        tab.info.url = event.url;
        tab.info.conversationId = event.conversationId;
        if (event.signedIn !== null) this.noteSignedIn(tab, event.signedIn);
        for (const waiter of tab.readyWaiters.splice(0)) waiter();
        break;
      case 'location':
        tab.info.url = event.url;
        tab.info.conversationId = event.conversationId;
        break;
      case 'auth':
        this.noteSignedIn(tab, event.signedIn);
        break;
      case 'generating':
        tab.info.generating = event.value;
        break;
      default:
        break;
    }
    this.listener?.page(tabId, event);
  }

  private noteSignedIn(tab: Tab, signedIn: boolean): void {
    tab.info.signedIn = signedIn;
    if (this.signedIn === signedIn) return;
    this.signedIn = signedIn;
    this.listener?.status();
  }

  private waitForDriver(tab: Tab, timeoutMs: number): Promise<boolean> {
    if (tab.info.driverReady) return Promise.resolve(true);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        tab.readyWaiters = tab.readyWaiters.filter((waiter) => waiter !== done);
        resolve(false);
      }, timeoutMs);
      const done = () => {
        clearTimeout(timer);
        resolve(true);
      };
      tab.readyWaiters.push(done);
    });
  }
}

function parseFrame(data: RawData): InboundFrame | null {
  try {
    const bytes = Array.isArray(data) ? Buffer.concat(data) : Buffer.isBuffer(data) ? data : Buffer.from(data);
    const value = JSON.parse(bytes.toString('utf8')) as unknown;
    return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string'
      ? (value as InboundFrame)
      : null;
  } catch {
    return null;
  }
}

function isTabEntry(value: unknown): value is TabEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Partial<TabEntry>;
  return typeof entry.tabId === 'string' && typeof entry.url === 'string' && typeof entry.loading === 'boolean';
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
