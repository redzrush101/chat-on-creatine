import type { PageCommand, PageResult } from '@shared/page-protocol';
import { createLogger } from '../core/log';
import type { ChatHost, HostEvents, HostStatus, TabInfo } from './host';

const log = createLogger('host');

/**
 * The one ChatHost the rest of the app holds. It delegates to the host chosen in settings and
 * swaps hosts at runtime; tabs of the old host close with it and sessions reopen on demand.
 */
export class HostSwitch implements ChatHost {
  private listener: HostEvents | null = null;
  private switching: Promise<void> = Promise.resolve();

  constructor(private current: ChatHost, private readonly create: (kind: ChatHost['kind']) => ChatHost) {}

  get kind(): ChatHost['kind'] {
    return this.current.kind;
  }

  /** Switches to `kind`; `force` recreates the current host too (e.g. after a port change). */
  use(kind: ChatHost['kind'], force = false): Promise<void> {
    this.switching = this.switching.then(async () => {
      if (this.current.kind === kind && !force) return;
      const previous = this.current;
      for (const tab of previous.tabs()) this.listener?.closed(tab.tabId);
      await previous.stop().catch((error: unknown) => log.error('stopping host failed', error));
      this.current = this.create(kind);
      if (this.listener) this.current.setListener(this.listener);
      await this.current.start();
      log.info(`ChatGPT host is now ${kind}`);
      this.listener?.status();
    });
    return this.switching;
  }

  setListener(events: HostEvents): void {
    this.listener = events;
    this.current.setListener(events);
  }

  start(): Promise<void> {
    return this.current.start();
  }
  stop(): Promise<void> {
    return this.current.stop();
  }
  status(): HostStatus {
    return this.current.status();
  }
  tabs(): TabInfo[] {
    return this.current.tabs();
  }
  openTab(url: string, options?: { reveal?: boolean }): Promise<string> {
    return this.current.openTab(url, options);
  }
  navigate(tabId: string, url: string): Promise<void> {
    return this.current.navigate(tabId, url);
  }
  closeTab(tabId: string): Promise<void> {
    return this.current.closeTab(tabId);
  }
  command(tabId: string, command: PageCommand, timeoutMs?: number): Promise<PageResult> {
    return this.current.command(tabId, command, timeoutMs);
  }
  reveal(tabId: string | null): void {
    this.current.reveal(tabId);
  }
  hide(): void {
    this.current.hide();
  }
}
