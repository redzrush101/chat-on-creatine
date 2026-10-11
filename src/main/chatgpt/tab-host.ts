import { randomUUID } from 'node:crypto';
import type { PageCommand, PageEvent, PageResult } from '@shared/page-protocol';
import { conversationIdFromUrl } from '@shared/page-protocol';
import type { HostEvents, TabInfo } from './host';

const COMMAND_TIMEOUT_MS = 30_000;
const READY_WAIT_MAX_MS = 45_000;

export interface HostTab {
  info: TabInfo;
  /** Resolvers waiting for the driver to (re)announce itself after a navigation. */
  readyWaiters: Array<() => void>;
}

interface Pending {
  tabId: string | null;
  resolve(result: PageResult): void;
  timer: NodeJS.Timeout;
}

export function newTabInfo(tabId: string, url: string): TabInfo {
  return { tabId, url, conversationId: conversationIdFromUrl(url), driverReady: false, signedIn: null, generating: false, createdAt: Date.now() };
}

/**
 * What both hosts track the same way: their tabs' driver state, the sign-in state the drivers
 * report, and requests waiting for a result. Subclasses own only the transport to the page.
 */
export abstract class TabHost<T extends HostTab> {
  protected readonly tabsById = new Map<string, T>();
  protected selected: string | null = null;
  protected listener: HostEvents | null = null;
  protected signedIn: boolean | null = null;
  private readonly pending = new Map<string, Pending>();

  setListener(events: HostEvents): void {
    this.listener = events;
  }

  tabs(): TabInfo[] {
    return [...this.tabsById.values()].map((tab) => ({ ...tab.info }));
  }

  /** Waits for the tab's driver (after load/navigation) and runs one command. */
  async command(tabId: string, command: PageCommand, timeoutMs = COMMAND_TIMEOUT_MS): Promise<PageResult> {
    const tab = this.tabsById.get(tabId);
    if (!tab) return { ok: false, error: 'No such tab', code: 'failed' };
    if (!(await this.waitForDriver(tab, Math.min(timeoutMs, READY_WAIT_MAX_MS)))) {
      return { ok: false, error: 'ChatGPT page did not finish loading', code: 'not-ready' };
    }
    return this.sendCommand(tab, command, timeoutMs);
  }

  protected abstract sendCommand(tab: T, command: PageCommand, timeoutMs: number): Promise<PageResult>;

  protected requireTab(tabId: string): T {
    const tab = this.tabsById.get(tabId);
    if (!tab) throw new Error(`No such tab ${tabId}`);
    return tab;
  }

  protected tabCountDetail(): string {
    const count = this.tabsById.size;
    return `${count} ChatGPT tab${count === 1 ? '' : 's'} open.`;
  }

  /** Registers a request before it is sent; `result` settles with its answer, a failure, or `timeoutError`. */
  protected awaitResult(tabId: string | null, timeoutMs: number, timeoutError: string): { id: string; result: Promise<PageResult> } {
    const id = randomUUID();
    const result = new Promise<PageResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ ok: false, error: timeoutError, code: 'timeout' });
      }, timeoutMs);
      this.pending.set(id, { tabId, resolve, timer });
    });
    return { id, result };
  }

  /** Settles one request; with `fromTab`, only when it was sent to that tab. */
  protected settle(id: string, result: PageResult, fromTab?: string): void {
    const pending = this.pending.get(id);
    if (!pending || (fromTab !== undefined && pending.tabId !== fromTab)) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(result);
  }

  /** Fails the requests sent to `tabId`, or every request when it is null. */
  protected failPending(tabId: string | null, error: string, code: 'failed' | 'not-ready'): void {
    for (const [id, pending] of this.pending) {
      if (tabId === null || pending.tabId === tabId) this.settle(id, { ok: false, error, code });
    }
  }

  protected handlePageEvent(tabId: string, event: PageEvent): void {
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

  private noteSignedIn(tab: T, signedIn: boolean): void {
    tab.info.signedIn = signedIn;
    if (this.signedIn === signedIn) return;
    this.signedIn = signedIn;
    this.listener?.status();
  }

  private waitForDriver(tab: T, timeoutMs: number): Promise<boolean> {
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
