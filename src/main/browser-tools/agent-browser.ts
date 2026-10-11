import { BrowserWindow, nativeImage } from 'electron';

import { formatAxTree } from './snapshot-format';
import { BrowserCapture, type ConsoleEntry, type NetworkEntry, type Page } from './capture';
import { CDP_TIMEOUT_MS, send, viewportSize, withTimeout, type CdpEvent } from './cdp';
import { BrowserInput, type ActionInput } from './input';
import type { Tab } from './tab';
import { loadSettled, parseWebUrl } from './navigation';

/** Separate from the ChatGPT browser pages; cookies persist across app restarts. */
const PARTITION = 'persist:agent-browser';
const CDP_VERSION = '1.3';
const NAV_TIMEOUT_MS = 20_000;
const SCREENSHOT_MAX_WIDTH = 1280;
const JPEG_QUALITY = 80;

interface TabInfo {
  id: string;
  url: string;
  title: string;
  loading: boolean;
}

interface Screenshot {
  mimeType: 'image/jpeg';
  data: string;
  /** Pixel size of the returned image. */
  width: number;
  height: number;
  /** CSS size of the viewport the image shows; input coordinates are CSS pixels. */
  viewport: { width: number; height: number };
}

function tabInfo(tab: Tab): TabInfo {
  return { id: tab.id, url: tab.wc.getURL(), title: tab.wc.getTitle(), loading: tab.wc.isLoading() };
}

/**
 * App-owned browser for the Desktop browser tools. Pages render offscreen and are
 * driven through the Chrome DevTools Protocol, so they keep rendering while the window is hidden.
 */
export class AgentBrowser {
  private readonly tabs = new Map<string, Tab>();
  private tabCount = 0;
  private refCount = 0;
  private readonly input = new BrowserInput();

  dispose(): void {
    for (const tab of [...this.tabs.values()]) this.closeTab(tab);
  }

  listTabs(): TabInfo[] {
    return [...this.tabs.values()].map(tabInfo);
  }

  async newTab(url?: string): Promise<TabInfo> {
    const target = url === undefined ? null : parseWebUrl(url);
    // Offscreen pages produce compositor frames while hidden, including full-page captures.
    const window = new BrowserWindow({
      show: false,
      frame: false,
      useContentSize: true,
      width: 1280,
      height: 900,
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        offscreen: true
      }
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    const tab: Tab = {
      id: `t${++this.tabCount}`,
      window,
      wc: window.webContents,
      refs: new Map(),
      refIds: new Map(),
      capture: new BrowserCapture()
    };
    this.tabs.set(tab.id, tab);
    tab.wc.once('destroyed', () => this.tabs.delete(tab.id));
    try {
      // A WebContents without a first navigation has no renderer to answer CDP yet.
      await tab.wc.loadURL('about:blank');
      await this.attach(tab);
    } catch (error) {
      this.closeTab(tab);
      throw error;
    }
    if (target) await this.navigate(tab.id, 'url', target.href);
    return tabInfo(tab);
  }

  private closeTab(tab: Tab): void {
    if (!tab.wc.isDestroyed()) {
      try {
        tab.wc.debugger.detach();
      } catch {
        // Already detached, for example after DevTools took the session.
      }
    }
    if (!tab.window.isDestroyed()) tab.window.destroy();
    this.tabs.delete(tab.id);
  }

  async navigate(tabId: string | undefined, action: 'url' | 'back' | 'forward' | 'reload', url?: string): Promise<TabInfo> {
    const tab = this.tab(tabId);
    const wc = tab.wc;
    if (action === 'back' && !wc.navigationHistory.canGoBack()) throw new Error('There is no earlier page in this tab.');
    if (action === 'forward' && !wc.navigationHistory.canGoForward()) throw new Error('There is no later page in this tab.');
    const href = action === 'url' ? parseWebUrl(url ?? '').href : '';
    const start = (): void => {
      if (action === 'url') void wc.loadURL(href).catch(() => undefined);
      else if (action === 'back') wc.navigationHistory.goBack();
      else if (action === 'forward') wc.navigationHistory.goForward();
      else wc.reload();
    };
    tab.refs.clear();
    tab.refIds.clear();
    const settled = loadSettled(wc, NAV_TIMEOUT_MS);
    start();
    await settled;
    return tabInfo(tab);
  }

  close(tabId: string | undefined): void {
    this.closeTab(this.tab(tabId));
  }

  async snapshot(tabId: string | undefined, options: { filter?: string; maxChars: number }): Promise<{ url: string; title: string; text: string; truncated: boolean }> {
    const tab = this.tab(tabId);
    const { nodes } = await send(tab, 'Accessibility.getFullAXTree');
    const tree = formatAxTree(nodes, {
      refFor: (backendNodeId) => this.refFor(tab, backendNodeId),
      maxLines: 2000,
      maxChars: options.maxChars,
      filter: options.filter
    });
    return { url: tab.wc.getURL(), title: tab.wc.getTitle(), text: tree.text, truncated: tree.truncated };
  }

  async screenshot(tabId: string | undefined, fullPage: boolean): Promise<Screenshot> {
    const tab = this.tab(tabId);
    let image: Electron.NativeImage;
    if (fullPage) {
      const metrics = await send(tab, 'Page.getLayoutMetrics');
      const clip = { x: 0, y: 0, width: metrics.cssContentSize.width, height: metrics.cssContentSize.height, scale: 1 };
      const shot = await send(tab, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip });
      image = nativeImage.createFromBuffer(Buffer.from(shot.data, 'base64'));
    } else {
      // CDP waits for a compositor frame that a hidden window never produces; capturePage does not.
      image = await withTimeout(tab.wc.capturePage(undefined, { stayHidden: true, stayAwake: true }), CDP_TIMEOUT_MS, 'capturePage');
    }
    if (image.getSize().width > SCREENSHOT_MAX_WIDTH) image = image.resize({ width: SCREENSHOT_MAX_WIDTH });
    const { width, height } = image.getSize();
    return {
      mimeType: 'image/jpeg',
      data: image.toJPEG(JPEG_QUALITY).toString('base64'),
      width,
      height,
      viewport: await viewportSize(tab)
    };
  }

  action(tabId: string | undefined, input: ActionInput): Promise<string> {
    return this.input.action(this.tab(tabId), input);
  }

  async evaluate(tabId: string | undefined, expression: string): Promise<unknown> {
    const tab = this.tab(tabId);
    const result = await send(tab, 'Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    const value = result.result;
    if (value.type === 'undefined') return null;
    return 'value' in value ? value.value : { type: value.type, description: value.description };
  }

  consoleEntries(
    tabId: string | undefined,
    options: { after: number; limit: number; level: 'all' | ConsoleEntry['level']; filter?: string; clear: boolean }
  ): Page<ConsoleEntry> {
    const tab = this.tab(tabId);
    const needle = options.filter?.toLowerCase();
    const page = tab.capture.console.page(
      options.after,
      options.limit,
      (entry) => (options.level === 'all' || entry.level === options.level) && (!needle || entry.text.toLowerCase().includes(needle))
    );
    if (options.clear) tab.capture.console.clear();
    return page;
  }

  networkEntries(
    tabId: string | undefined,
    options: { after: number; limit: number; filter?: string; clear: boolean }
  ): Page<NetworkEntry> {
    const tab = this.tab(tabId);
    const needle = options.filter?.toLowerCase();
    const page = tab.capture.network.page(options.after, options.limit, (entry) => !needle || entry.url.toLowerCase().includes(needle));
    if (options.clear) tab.capture.network.clear();
    return page;
  }

  async networkBody(tabId: string | undefined, requestId: string): Promise<{ body: string; base64Encoded: boolean }> {
    const tab = this.tab(tabId);
    try {
      const response = await send(tab, 'Network.getResponseBody', { requestId });
      return { body: response.body, base64Encoded: response.base64Encoded };
    } catch {
      throw new Error('Response body is unavailable (not captured, evicted, or a redirect).');
    }
  }

  private tab(tabId: string | undefined): Tab {
    const tab = tabId === undefined ? [...this.tabs.values()].at(-1) : this.tabs.get(tabId);
    if (!tab) throw new Error(tabId === undefined ? 'No tab is open. Open one with browser_tabs action new.' : `Unknown tab ${tabId}. Call browser_tabs with action list.`);
    return tab;
  }

  private async attach(tab: Tab): Promise<void> {
    const debuggerApi = tab.wc.debugger;
    debuggerApi.attach(CDP_VERSION);
    debuggerApi.on('message', (_event, method, params) => {
      if (tab.capture.record({ method, params } as CdpEvent)) {
        tab.refs.clear();
        tab.refIds.clear();
      }
    });
    for (const domain of ['Page', 'Runtime', 'Log', 'Network', 'DOM', 'Accessibility']) {
      await send(tab, `${domain}.enable`);
    }
    // Hidden pages keep rendering and accepting input without becoming the foreground page.
    await send(tab, 'Emulation.setFocusEmulationEnabled', { enabled: true });
  }

  private refFor(tab: Tab, backendNodeId: number): string {
    const known = tab.refIds.get(backendNodeId);
    if (known) return known;
    const ref = `e${++this.refCount}`;
    tab.refIds.set(backendNodeId, ref);
    tab.refs.set(ref, backendNodeId);
    return ref;
  }

}
