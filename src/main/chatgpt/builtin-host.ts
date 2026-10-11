import { randomUUID } from 'node:crypto';
import { BaseWindow, WebContentsView, ipcMain, session, shell, type Session, type WebContents } from 'electron';
import type { PageCommand, PageEvent, PageResult } from '@shared/page-protocol';
import { conversationIdFromUrl } from '@shared/page-protocol';
import { createLogger } from '../core/log';
import type { ChatHost, HostEvents, HostStatus, TabInfo } from './host';

const log = createLogger('browser');

const PAGE_EVENT_CHANNEL = 'creatine-page:event';
const PAGE_COMMAND_CHANNEL = 'creatine-page:command';
const PAGE_RESULT_CHANNEL = 'creatine-page:result';

const PARTITION = 'persist:chatgpt';

/** Hosts a ChatGPT tab may navigate to in place: ChatGPT itself and the sign-in providers it redirects through. */
const IN_APP_HOSTS = [
  /(^|\.)chatgpt\.com$/,
  /(^|\.)openai\.com$/,
  /(^|\.)oaistatic\.com$/,
  /(^|\.)oaiusercontent\.com$/,
  /^accounts\.google\.com$/,
  /^login\.(microsoftonline|live)\.com$/,
  /^appleid\.apple\.com$/,
  /(^|\.)challenges\.cloudflare\.com$/
];

function staysInApp(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && IN_APP_HOSTS.some((pattern) => pattern.test(parsed.hostname));
  } catch {
    return url === 'about:blank';
  }
}

interface Tab {
  info: TabInfo;
  view: WebContentsView;
  title: string;
  /** Resolvers waiting for the driver to (re)announce itself after a navigation. */
  readyWaiters: Array<() => void>;
}

interface PendingCommand {
  tabId: string;
  resolve(result: PageResult): void;
  timer: NodeJS.Timeout;
}

/**
 * ChatGPT inside the app: one persistent partition, one hidden-by-default window, one
 * WebContentsView per tab. Only the revealed tab is attached to the window; the rest keep
 * running detached with throttling disabled.
 */
export class BuiltinHost implements ChatHost {
  readonly kind = 'builtin' as const;
  private window: BaseWindow | null = null;
  private readonly tabsById = new Map<string, Tab>();
  private readonly byContentsId = new Map<number, string>();
  private readonly pending = new Map<string, PendingCommand>();
  private selected: string | null = null;
  private listener: HostEvents | null = null;
  private browserSession: Session | null = null;
  private signedIn: boolean | null = null;
  private quitting = false;
  private readonly ipcHandlers: Array<() => void> = [];

  constructor(private readonly options: { preloadPath: string; iconPath?: string }) {}

  setListener(events: HostEvents): void {
    this.listener = events;
  }

  async start(): Promise<void> {
    const ses = session.fromPartition(PARTITION);
    this.browserSession = ses;
    // Present as the Chrome this is; the Electron/app tokens make some sign-in providers refuse.
    ses.setUserAgent(ses.getUserAgent().replace(/\s(?:Electron|chat-on-creatine)\/\S+/g, ''));
    ses.setPermissionRequestHandler((_wc, permission, callback) => callback(permission === 'clipboard-sanitized-write'));
    this.signedIn = await this.readSessionCookie();

    const onEvent = (event: Electron.IpcMainEvent, payload: PageEvent) => {
      const tabId = this.byContentsId.get(event.sender.id);
      if (tabId) this.handlePageEvent(tabId, payload);
    };
    const onResult = (event: Electron.IpcMainEvent, payload: { id: string; result: PageResult }) => {
      const pending = this.pending.get(payload.id);
      if (!pending || this.byContentsId.get(event.sender.id) !== pending.tabId) return;
      this.pending.delete(payload.id);
      clearTimeout(pending.timer);
      pending.resolve(payload.result);
    };
    ipcMain.on(PAGE_EVENT_CHANNEL, onEvent);
    ipcMain.on(PAGE_RESULT_CHANNEL, onResult);
    this.ipcHandlers.push(
      () => ipcMain.removeListener(PAGE_EVENT_CHANNEL, onEvent),
      () => ipcMain.removeListener(PAGE_RESULT_CHANNEL, onResult)
    );
  }

  async stop(): Promise<void> {
    this.quitting = true;
    for (const dispose of this.ipcHandlers.splice(0)) dispose();
    for (const tabId of [...this.tabsById.keys()]) await this.closeTab(tabId);
    this.window?.destroy();
    this.window = null;
  }

  status(): HostStatus {
    const tabs = this.tabs();
    return {
      ready: this.browserSession !== null,
      signedIn: this.signedIn,
      windowVisible: this.window?.isVisible() ?? false,
      extensionConnected: false,
      detail:
        this.signedIn === false
          ? 'Sign in to ChatGPT in the built-in browser.'
          : `${tabs.length} ChatGPT tab${tabs.length === 1 ? '' : 's'} open.`
    };
  }

  tabs(): TabInfo[] {
    return [...this.tabsById.values()].map((tab) => ({ ...tab.info }));
  }

  async openTab(url: string, options: { reveal?: boolean } = {}): Promise<string> {
    if (!this.browserSession) throw new Error('Browser host is not started');
    const tabId = randomUUID();
    const view = new WebContentsView({
      webPreferences: {
        session: this.browserSession,
        preload: this.options.preloadPath,
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        spellcheck: true
      }
    });
    const tab: Tab = {
      view,
      title: 'ChatGPT',
      readyWaiters: [],
      info: {
        tabId,
        url,
        conversationId: conversationIdFromUrl(url),
        driverReady: false,
        signedIn: null,
        generating: false,
        createdAt: Date.now()
      }
    };
    this.tabsById.set(tabId, tab);
    this.byContentsId.set(view.webContents.id, tabId);
    this.wireContents(tab, view.webContents);
    if (options.reveal) this.reveal(tabId);
    void view.webContents.loadURL(url).catch((error: Error) => log.warn(`tab load failed: ${error.message}`));
    return tabId;
  }

  async navigate(tabId: string, url: string): Promise<void> {
    const tab = this.requireTab(tabId);
    tab.info.driverReady = false;
    await tab.view.webContents.loadURL(url).catch((error: Error) => log.warn(`navigation failed: ${error.message}`));
  }

  async closeTab(tabId: string): Promise<void> {
    const tab = this.tabsById.get(tabId);
    if (!tab) return;
    this.tabsById.delete(tabId);
    this.byContentsId.delete(tab.view.webContents.id);
    for (const [id, pending] of this.pending) {
      if (pending.tabId !== tabId) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.resolve({ ok: false, error: 'Tab closed', code: 'failed' });
    }
    if (this.selected === tabId) {
      this.window?.contentView.removeChildView(tab.view);
      this.selected = null;
    }
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close();
    this.listener?.closed(tabId);
    this.listener?.status();
  }

  async command(tabId: string, command: PageCommand, timeoutMs = 30_000): Promise<PageResult> {
    const tab = this.tabsById.get(tabId);
    if (!tab) return { ok: false, error: 'No such tab', code: 'failed' };
    if (!tab.info.driverReady) {
      const ready = await this.waitForDriver(tab, Math.min(timeoutMs, 45_000));
      if (!ready) return { ok: false, error: 'ChatGPT page did not finish loading', code: 'not-ready' };
    }
    const id = randomUUID();
    return new Promise<PageResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: `Timed out waiting for the ChatGPT page (${command.type})`, code: 'timeout' });
      }, timeoutMs);
      this.pending.set(id, { tabId, resolve, timer });
      tab.view.webContents.send(PAGE_COMMAND_CHANNEL, { id, command });
    });
  }

  reveal(tabId: string | null): void {
    const window = this.ensureWindow();
    const target = tabId ?? this.selected ?? [...this.tabsById.keys()].at(-1) ?? null;
    if (target && target !== this.selected) {
      const previous = this.selected ? this.tabsById.get(this.selected) : null;
      if (previous) window.contentView.removeChildView(previous.view);
      const tab = this.tabsById.get(target);
      if (tab) {
        window.contentView.addChildView(tab.view);
        this.selected = target;
        this.layout();
        window.setTitle(`${tab.title} — ChatGPT`);
      }
    }
    if (!target) void this.openTab('https://chatgpt.com/', { reveal: true });
    window.show();
    window.focus();
    this.listener?.status();
  }

  hide(): void {
    this.window?.hide();
    this.listener?.status();
  }

  private requireTab(tabId: string): Tab {
    const tab = this.tabsById.get(tabId);
    if (!tab) throw new Error(`No such tab ${tabId}`);
    return tab;
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
    if (this.signedIn !== signedIn) {
      this.signedIn = signedIn;
      this.listener?.status();
    }
  }

  private wireContents(tab: Tab, contents: WebContents): void {
    contents.on('did-start-navigation', (details) => {
      if (details.isMainFrame && !details.isSameDocument) tab.info.driverReady = false;
    });
    contents.on('will-navigate', (event, url) => {
      if (staysInApp(url)) return;
      event.preventDefault();
      void shell.openExternal(url);
    });
    contents.setWindowOpenHandler(({ url }) => {
      if (staysInApp(url)) {
        // Sign-in popups (Google/Apple/Microsoft) must share the partition to land the session.
        return {
          action: 'allow',
          overrideBrowserWindowOptions: { width: 520, height: 720, autoHideMenuBar: true, webPreferences: { session: this.browserSession! } }
        };
      }
      void shell.openExternal(url);
      return { action: 'deny' };
    });
    contents.on('page-title-updated', (_event, title) => {
      tab.title = title;
      if (this.selected === tab.info.tabId) this.window?.setTitle(`${title} — ChatGPT`);
    });
    contents.on('render-process-gone', (_event, details) => {
      log.warn(`ChatGPT tab renderer gone (${details.reason}); reloading`);
      tab.info.driverReady = false;
      contents.reload();
    });
    contents.on('did-navigate', () => void this.refreshSignIn());
  }

  private async refreshSignIn(): Promise<void> {
    const signedIn = await this.readSessionCookie();
    if (signedIn !== this.signedIn && signedIn === false) {
      this.signedIn = signedIn;
      this.listener?.status();
    }
  }

  private async readSessionCookie(): Promise<boolean> {
    if (!this.browserSession) return false;
    const cookies = await this.browserSession.cookies.get({ domain: 'chatgpt.com' }).catch(() => []);
    return cookies.some((cookie) => cookie.name.startsWith('__Secure-next-auth.session-token'));
  }

  private ensureWindow(): BaseWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const window = new BaseWindow({ width: 1100, height: 820, show: false, title: 'ChatGPT', autoHideMenuBar: true });
    window.on('resize', () => this.layout());
    window.on('close', (event) => {
      if (this.quitting) return;
      // Closing hides; the tabs keep running for the app.
      event.preventDefault();
      window.hide();
      this.listener?.status();
    });
    this.window = window;
    if (this.selected) {
      const tab = this.tabsById.get(this.selected);
      if (tab) window.contentView.addChildView(tab.view);
    }
    return window;
  }

  private layout(): void {
    if (!this.window || !this.selected) return;
    const tab = this.tabsById.get(this.selected);
    const { width, height } = this.window.getContentBounds();
    tab?.view.setBounds({ x: 0, y: 0, width, height });
  }
}
