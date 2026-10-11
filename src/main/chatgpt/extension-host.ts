import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { WebSocket, WebSocketServer, type RawData } from 'ws';
import type { PageCommand, PageEvent, PageResult } from '@shared/page-protocol';
import { conversationIdFromUrl } from '@shared/page-protocol';
import { createLogger } from '../core/log';
import type { ChatHost, HostStatus } from './host';
import { newTabInfo, TabHost, type HostTab } from './tab-host';

const log = createLogger('extension');

const HELLO_TIMEOUT_MS = 10_000;
const REQUEST_TIMEOUT_MS = 15_000;
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const CLOSE_UNAUTHORIZED = 4401;
const CLOSE_REPLACED = 4000;

interface ExtensionHostDeps {
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

interface Tab extends HostTab {
  /** Last loading state the extension reported; a new load resets the driver until it says hello. */
  loading: boolean;
}

/**
 * ChatGPT in the user's own Chromium-based browser, reached through the companion extension.
 * The extension connects to a loopback WebSocket; the first connection is paired with a token
 * the app stores, and every later one must present it. Tabs are the ones the app opened.
 */
export class ExtensionHost extends TabHost<Tab> implements ChatHost {
  readonly kind = 'extension' as const;
  private server: WebSocketServer | null = null;
  /** The one authenticated connection; a newer one replaces it. */
  private socket: WebSocket | null = null;
  private token: string | null;
  private pairingOpen: boolean;

  constructor(private readonly deps: ExtensionHostDeps) {
    super();
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
          : this.tabCountDetail()
    };
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

  protected sendCommand(tab: Tab, command: PageCommand, timeoutMs: number): Promise<PageResult> {
    return this.request({ type: 'command', tabId: tab.info.tabId, command }, tab.info.tabId, timeoutMs);
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
      case 'result':
        this.settle(frame.id, frame.result);
        break;
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
    const { id, result } = this.awaitResult(tabId, timeoutMs, `Timed out waiting for the Chrome extension (${body.type})`);
    if (!this.send({ ...body, id })) this.settle(id, { ok: false, error: 'Chrome extension is not connected', code: 'not-ready' });
    return result;
  }

  private adopt(tabId: string, url: string): Tab {
    const tab: Tab = { info: newTabInfo(tabId, url), loading: false, readyWaiters: [] };
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
