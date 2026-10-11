import type { PageCommand, PageEvent, PageResult } from '@shared/page-protocol';

export interface TabInfo {
  tabId: string;
  url: string;
  conversationId: string | null;
  /** The driver in this tab has said hello since its last navigation. */
  driverReady: boolean;
  signedIn: boolean | null;
  generating: boolean;
  createdAt: number;
}

export interface HostStatus {
  ready: boolean;
  signedIn: boolean | null;
  windowVisible: boolean;
  extensionConnected: boolean;
  detail: string;
}

export interface HostEvents {
  /** An event from the driver running in one tab. */
  page(tabId: string, event: PageEvent): void;
  /** A tab was closed by the user or the host. */
  closed(tabId: string): void;
  /** Host-level status changed (sign-in, window visibility, connection). */
  status(): void;
}

/**
 * Where ChatGPT pages run. The built-in browser and the Chrome extension bridge both implement
 * this, so everything above it (routing, sending, recording) is host-agnostic.
 */
export interface ChatHost {
  readonly kind: 'builtin' | 'extension';
  start(): Promise<void>;
  stop(): Promise<void>;
  status(): HostStatus;
  tabs(): TabInfo[];
  /** Opens a ChatGPT tab at `url` without stealing focus unless `reveal` is set. */
  openTab(url: string, options?: { reveal?: boolean }): Promise<string>;
  navigate(tabId: string, url: string): Promise<void>;
  closeTab(tabId: string): Promise<void>;
  /** Waits for the tab's driver (after load/navigation) and runs one command. */
  command(tabId: string, command: PageCommand, timeoutMs?: number): Promise<PageResult>;
  /** Brings the browser window forward, showing `tabId` when given. */
  reveal(tabId: string | null): void;
  hide(): void;
  setListener(events: HostEvents): void;
}
