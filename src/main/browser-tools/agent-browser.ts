import { BaseWindow, nativeImage, WebContentsView, type Rectangle, type WebContents } from 'electron';

import { formatAxTree, type AxNode } from './snapshot-format';

/** Separate from the ChatGPT browser pages; cookies persist across app restarts. */
const PARTITION = 'persist:agent-browser';
const CDP_VERSION = '1.3';
const CDP_TIMEOUT_MS = 25_000;
const NAV_TIMEOUT_MS = 20_000;
const RING_SIZE = 200;
const DRAG_STEPS = 10;
const SCREENSHOT_MAX_WIDTH = 1280;
const JPEG_QUALITY = 80;
const SELECT_ALL = process.platform === 'darwin' ? 'Meta+a' : 'Control+a';

interface TabInfo {
  id: string;
  url: string;
  title: string;
  loading: boolean;
}

interface ConsoleEntry {
  level: 'error' | 'warning' | 'info' | 'debug';
  text: string;
  url: string | null;
}

interface NetworkEntry {
  requestId: string;
  method: string;
  url: string;
  type: string;
  status: number | null;
  mimeType: string | null;
  failed: string | null;
  finished: boolean;
}

interface Page<T> {
  items: Array<T & { seq: number }>;
  /** Pass as `after` to continue after the last returned item. */
  cursor: number;
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

interface ActionInput {
  action: 'click' | 'hover' | 'fill' | 'type' | 'select' | 'key' | 'scroll' | 'drag' | 'dialog';
  ref?: string;
  x?: number;
  y?: number;
  toRef?: string;
  toX?: number;
  toY?: number;
  text?: string;
  values?: string[];
  key?: string;
  holdMs?: number;
  button?: 'left' | 'middle' | 'right';
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
  accept?: boolean;
}

type MouseType = 'mouseMoved' | 'mousePressed' | 'mouseReleased';
interface Point {
  x: number;
  y: number;
}

/** Bounded ring buffer; each item gets a sequence number that serves as the pagination cursor. */
class Ring<T extends object> {
  private items: Array<T & { seq: number }> = [];
  private last = 0;

  add(item: T): T & { seq: number } {
    const stored = { ...item, seq: ++this.last };
    this.items.push(stored);
    if (this.items.length > RING_SIZE) this.items.shift();
    return stored;
  }

  find(match: (item: T) => boolean): (T & { seq: number }) | undefined {
    return this.items.find(match);
  }

  page(after: number, limit: number, keep: (item: T) => boolean): Page<T> {
    const items = this.items.filter((item) => item.seq > after && keep(item)).slice(0, limit);
    return { items, cursor: items.at(-1)?.seq ?? after };
  }

  clear(): void {
    this.items = [];
  }
}

interface Tab {
  id: string;
  view: WebContentsView;
  wc: WebContents;
  /** Ref to DOM backendNodeId for the current document; reset on navigation. */
  refs: Map<string, number>;
  refIds: Map<number, string>;
  console: Ring<ConsoleEntry>;
  network: Ring<NetworkEntry>;
}

const MODIFIERS: Record<string, number> = {
  alt: 1, option: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, super: 4, shift: 8
};

const NAMED_KEYS: Record<string, { key: string; code: string; vk: number; text?: string }> = {
  enter: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  return: { key: 'Enter', code: 'Enter', vk: 13, text: '\r' },
  escape: { key: 'Escape', code: 'Escape', vk: 27 },
  esc: { key: 'Escape', code: 'Escape', vk: 27 },
  tab: { key: 'Tab', code: 'Tab', vk: 9 },
  backspace: { key: 'Backspace', code: 'Backspace', vk: 8 },
  delete: { key: 'Delete', code: 'Delete', vk: 46 },
  space: { key: ' ', code: 'Space', vk: 32, text: ' ' },
  arrowup: { key: 'ArrowUp', code: 'ArrowUp', vk: 38 },
  arrowdown: { key: 'ArrowDown', code: 'ArrowDown', vk: 40 },
  arrowleft: { key: 'ArrowLeft', code: 'ArrowLeft', vk: 37 },
  arrowright: { key: 'ArrowRight', code: 'ArrowRight', vk: 39 },
  home: { key: 'Home', code: 'Home', vk: 36 },
  end: { key: 'End', code: 'End', vk: 35 },
  pageup: { key: 'PageUp', code: 'PageUp', vk: 33 },
  pagedown: { key: 'PageDown', code: 'PageDown', vk: 34 }
};

interface ParsedKey {
  key: string;
  code: string;
  vk: number;
  modifiers: number;
  text?: string;
}

/** Parses chords such as `Enter`, `Control+a` or `Shift+Tab` into CDP key-event fields. */
export function parseChord(chord: string): ParsedKey {
  const trimmed = chord.trim();
  const parts = trimmed.endsWith('+') && trimmed.length > 1 ? [...trimmed.slice(0, -2).split('+'), '+'] : trimmed.split('+');
  const name = parts.pop() ?? '';
  let modifiers = 0;
  for (const part of parts) {
    const bit = MODIFIERS[part.toLowerCase()];
    if (!bit) throw new Error(`Unknown modifier "${part}". Use Control, Shift, Alt or Meta.`);
    modifiers |= bit;
  }
  const textAllowed = (modifiers & 6) === 0;
  const named = NAMED_KEYS[name.toLowerCase()];
  if (named) return { ...named, modifiers, text: textAllowed ? named.text : undefined };
  if (name.length !== 1) throw new Error(`Unknown key "${name}".`);
  const isLetter = /[a-z]/i.test(name);
  const isDigit = /\d/.test(name);
  const key = isLetter && (modifiers & 8) !== 0 ? name.toUpperCase() : name;
  const code = isLetter ? `Key${name.toUpperCase()}` : isDigit ? `Digit${name}` : name === ' ' ? 'Space' : '';
  const vk = isLetter || isDigit ? name.toUpperCase().charCodeAt(0) : 0;
  return { key, code, vk, modifiers, text: textAllowed ? key : undefined };
}

/** Only http(s) pages can be opened; everything else is refused before reaching the browser. */
export function parseWebUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`Not a valid URL: ${raw}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Only http and https URLs can be opened.');
  return url;
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} timed out.`)), ms);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/** Resolves when the page stops loading or after `ms`, whichever comes first. */
function loadSettled(wc: WebContents, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      wc.removeListener('did-stop-loading', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    wc.on('did-stop-loading', done);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tabInfo(tab: Tab): TabInfo {
  return { id: tab.id, url: tab.wc.getURL(), title: tab.wc.getTitle(), loading: tab.wc.isLoading() };
}

function consoleLevel(type: string): ConsoleEntry['level'] {
  if (type === 'error' || type === 'assert') return 'error';
  if (type === 'warning') return 'warning';
  if (type === 'debug' || type === 'trace') return 'debug';
  return 'info';
}

function logLevel(level: string): ConsoleEntry['level'] {
  if (level === 'error') return 'error';
  if (level === 'warning') return 'warning';
  if (level === 'verbose') return 'debug';
  return 'info';
}

function argText(arg: { type?: string; value?: unknown; description?: string }): string {
  if (arg.value !== undefined) return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value);
  return arg.description ?? arg.type ?? '';
}

const SELECT_FUNCTION = `function (values) {
  if (this.tagName !== 'SELECT') throw new Error('Ref is not a select element.');
  const wanted = new Set(values);
  for (const option of this.options) option.selected = wanted.has(option.value) || wanted.has(option.label);
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return [...this.selectedOptions].map((option) => option.value);
}`;

/**
 * App-owned browser for the Desktop browser tools. Pages live in hidden WebContentsViews and are
 * driven through the Chrome DevTools Protocol, so they keep rendering while the window is hidden.
 */
export class AgentBrowser {
  private window: BaseWindow | null = null;
  private readonly tabs = new Map<string, Tab>();
  private tabCount = 0;
  private refCount = 0;
  private closing = false;

  show(): void {
    this.ensureWindow().show();
  }

  dispose(): void {
    this.closing = true;
    for (const tab of [...this.tabs.values()]) this.closeTab(tab);
    this.window?.destroy();
    this.window = null;
  }

  listTabs(): TabInfo[] {
    return [...this.tabs.values()].map(tabInfo);
  }

  async newTab(url?: string): Promise<TabInfo> {
    const target = url === undefined ? null : parseWebUrl(url);
    const win = this.ensureWindow();
    const view = new WebContentsView({
      webPreferences: {
        partition: PARTITION,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false
      }
    });
    view.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.contentView.addChildView(view);
    view.setBounds(this.contentBounds(win));
    const tab: Tab = {
      id: `t${++this.tabCount}`,
      view,
      wc: view.webContents,
      refs: new Map(),
      refIds: new Map(),
      console: new Ring(),
      network: new Ring()
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
    this.window?.contentView.removeChildView(tab.view);
    if (!tab.wc.isDestroyed()) tab.wc.close();
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
    const { nodes } = await this.send(tab, 'Accessibility.getFullAXTree');
    const tree = formatAxTree(nodes as AxNode[], {
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
      const metrics = await this.send(tab, 'Page.getLayoutMetrics');
      const clip = { x: 0, y: 0, width: metrics.cssContentSize.width, height: metrics.cssContentSize.height, scale: 1 };
      const shot = await this.send(tab, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip });
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
      viewport: await this.viewportSize(tab)
    };
  }

  async action(tabId: string | undefined, input: ActionInput): Promise<string> {
    const tab = this.tab(tabId);
    const button = input.button ?? 'left';
    const count = input.clickCount ?? 1;
    switch (input.action) {
      case 'click': {
        const point = await this.pointOf(tab, input.ref, input.x, input.y);
        await this.mouse(tab, 'mouseMoved', point);
        for (let i = 1; i <= count; i++) {
          await this.mouse(tab, 'mousePressed', point, button, i);
          await this.mouse(tab, 'mouseReleased', point, button, i);
        }
        return `clicked${input.ref ? ` ${input.ref}` : ''}`;
      }
      case 'hover': {
        await this.mouse(tab, 'mouseMoved', await this.pointOf(tab, input.ref, input.x, input.y));
        return 'hovered';
      }
      case 'fill': {
        if (input.ref === undefined) throw new Error('fill needs a ref.');
        await this.click(tab, input.ref, 'left', 1);
        await this.key(tab, SELECT_ALL);
        if (input.text) await this.insert(tab, input.text);
        else await this.key(tab, 'Backspace');
        return `filled ${input.ref}`;
      }
      case 'type': {
        if (input.ref !== undefined) await this.focusRef(tab, input.ref);
        if (input.text) await this.insert(tab, input.text);
        return 'typed';
      }
      case 'select': {
        if (input.ref === undefined || !input.values) throw new Error('select needs a ref and values.');
        const { object } = await this.send(tab, 'DOM.resolveNode', { backendNodeId: this.backendIdOf(tab, input.ref) });
        const result = await this.send(tab, 'Runtime.callFunctionOn', {
          objectId: object.objectId,
          functionDeclaration: SELECT_FUNCTION,
          arguments: [{ value: input.values }],
          returnByValue: true
        });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'Select failed.');
        return `selected ${JSON.stringify(result.result.value)}`;
      }
      case 'key': {
        if (!input.key) throw new Error('key needs a key chord.');
        if (input.ref !== undefined) await this.focusRef(tab, input.ref);
        await this.key(tab, input.key, input.holdMs ?? 0);
        return `pressed ${input.key}`;
      }
      case 'scroll': {
        const point = await this.pointOf(tab, input.ref, input.x, input.y, true);
        await this.send(tab, 'Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: point.x,
          y: point.y,
          deltaX: input.deltaX ?? 0,
          deltaY: input.deltaY ?? 0
        });
        return 'scrolled';
      }
      case 'drag': {
        const from = await this.pointOf(tab, input.ref, input.x, input.y);
        const to = await this.pointOf(tab, input.toRef, input.toX, input.toY);
        await this.mouse(tab, 'mouseMoved', from);
        await this.mouse(tab, 'mousePressed', from, 'left', 1);
        for (let step = 1; step <= DRAG_STEPS; step++) {
          const at = {
            x: from.x + ((to.x - from.x) * step) / DRAG_STEPS,
            y: from.y + ((to.y - from.y) * step) / DRAG_STEPS
          };
          await this.mouse(tab, 'mouseMoved', at, 'left');
        }
        await this.mouse(tab, 'mouseReleased', to, 'left', 1);
        return 'dragged';
      }
      case 'dialog': {
        await this.send(tab, 'Page.handleJavaScriptDialog', { accept: input.accept ?? true, promptText: input.text });
        return input.accept === false ? 'dismissed dialog' : 'accepted dialog';
      }
    }
  }

  async evaluate(tabId: string | undefined, expression: string): Promise<unknown> {
    const tab = this.tab(tabId);
    const result = await this.send(tab, 'Runtime.evaluate', {
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
    const page = tab.console.page(
      options.after,
      options.limit,
      (entry) => (options.level === 'all' || entry.level === options.level) && (!needle || entry.text.toLowerCase().includes(needle))
    );
    if (options.clear) tab.console.clear();
    return page;
  }

  networkEntries(
    tabId: string | undefined,
    options: { after: number; limit: number; filter?: string; clear: boolean }
  ): Page<NetworkEntry> {
    const tab = this.tab(tabId);
    const needle = options.filter?.toLowerCase();
    const page = tab.network.page(options.after, options.limit, (entry) => !needle || entry.url.toLowerCase().includes(needle));
    if (options.clear) tab.network.clear();
    return page;
  }

  async networkBody(tabId: string | undefined, requestId: string): Promise<{ body: string; base64Encoded: boolean }> {
    const tab = this.tab(tabId);
    try {
      const response = await this.send(tab, 'Network.getResponseBody', { requestId });
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

  private ensureWindow(): BaseWindow {
    if (this.window && !this.window.isDestroyed()) return this.window;
    const win = new BaseWindow({ show: false, width: 1280, height: 900, title: 'Agent browser' });
    win.on('resize', () => {
      for (const tab of this.tabs.values()) tab.view.setBounds(this.contentBounds(win));
    });
    win.on('close', (event) => {
      // The window is an app-owned surface; closing it only hides it, so tabs keep working.
      if (!this.closing) {
        event.preventDefault();
        win.hide();
      }
    });
    this.window = win;
    return win;
  }

  private contentBounds(win: BaseWindow): Rectangle {
    const { width, height } = win.getContentBounds();
    return { x: 0, y: 0, width, height };
  }

  private async attach(tab: Tab): Promise<void> {
    const debuggerApi = tab.wc.debugger;
    debuggerApi.attach(CDP_VERSION);
    debuggerApi.on('message', (_event, method: string, params: any) => this.onEvent(tab, method, params));
    for (const domain of ['Page', 'Runtime', 'Log', 'Network', 'DOM', 'Accessibility']) {
      await this.send(tab, `${domain}.enable`);
    }
    // Hidden pages keep rendering and accepting input without becoming the foreground page.
    await this.send(tab, 'Emulation.setFocusEmulationEnabled', { enabled: true });
  }

  private onEvent(tab: Tab, method: string, params: any): void {
    switch (method) {
      case 'Runtime.consoleAPICalled':
        tab.console.add({
          level: consoleLevel(params.type),
          text: (params.args ?? []).map(argText).join(' '),
          url: params.stackTrace?.callFrames?.[0]?.url || null
        });
        break;
      case 'Runtime.exceptionThrown': {
        const details = params.exceptionDetails;
        tab.console.add({
          level: 'error',
          text: details.exception?.description ?? details.text,
          url: details.url || null
        });
        break;
      }
      case 'Log.entryAdded':
        tab.console.add({ level: logLevel(params.entry.level), text: params.entry.text, url: params.entry.url || null });
        break;
      case 'Network.requestWillBeSent':
        tab.network.add({
          requestId: params.requestId,
          method: params.request.method,
          url: params.request.url,
          type: params.type ?? 'Other',
          status: null,
          mimeType: null,
          failed: null,
          finished: false
        });
        break;
      case 'Network.responseReceived': {
        const entry = tab.network.find((item) => item.requestId === params.requestId);
        if (entry) {
          entry.status = params.response.status;
          entry.mimeType = params.response.mimeType;
        }
        break;
      }
      case 'Network.loadingFailed': {
        const entry = tab.network.find((item) => item.requestId === params.requestId);
        if (entry) entry.failed = params.errorText;
        break;
      }
      case 'Network.loadingFinished': {
        const entry = tab.network.find((item) => item.requestId === params.requestId);
        if (entry) entry.finished = true;
        break;
      }
      case 'Page.frameNavigated':
        if (!params.frame.parentId) {
          tab.refs.clear();
          tab.refIds.clear();
        }
        break;
    }
  }

  private send(tab: Tab, method: string, params?: object): Promise<any> {
    return withTimeout(tab.wc.debugger.sendCommand(method, params), CDP_TIMEOUT_MS, method);
  }

  private refFor(tab: Tab, backendNodeId: number): string {
    const known = tab.refIds.get(backendNodeId);
    if (known) return known;
    const ref = `e${++this.refCount}`;
    tab.refIds.set(backendNodeId, ref);
    tab.refs.set(ref, backendNodeId);
    return ref;
  }

  private backendIdOf(tab: Tab, ref: string): number {
    const id = tab.refs.get(ref);
    if (id === undefined) throw new Error(`Unknown ref ${ref}. Take a fresh browser_snapshot; refs reset after navigation.`);
    return id;
  }

  private async viewportSize(tab: Tab): Promise<{ width: number; height: number }> {
    const metrics = await this.send(tab, 'Page.getLayoutMetrics');
    return {
      width: Math.round(metrics.cssVisualViewport.clientWidth),
      height: Math.round(metrics.cssVisualViewport.clientHeight)
    };
  }

  private async pointOf(tab: Tab, ref: string | undefined, x: number | undefined, y: number | undefined, centerFallback = false): Promise<Point> {
    if (ref !== undefined) return this.centerOf(tab, this.backendIdOf(tab, ref));
    if (x !== undefined && y !== undefined) return { x, y };
    if (centerFallback) {
      const size = await this.viewportSize(tab);
      return { x: size.width / 2, y: size.height / 2 };
    }
    throw new Error('Give a ref, or x and y coordinates from the screenshot.');
  }

  private async centerOf(tab: Tab, backendNodeId: number): Promise<Point> {
    await this.send(tab, 'DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => undefined);
    const box = await this.send(tab, 'DOM.getBoxModel', { backendNodeId }).catch(() => {
      throw new Error('Element is not rendered. Take a fresh browser_snapshot.');
    });
    const quad = box.model.content as [number, number, number, number, number, number, number, number];
    return {
      x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
      y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4
    };
  }

  private async focusRef(tab: Tab, ref: string): Promise<void> {
    await this.send(tab, 'DOM.focus', { backendNodeId: this.backendIdOf(tab, ref) });
  }

  private async click(tab: Tab, ref: string, button: 'left' | 'middle' | 'right', count: number): Promise<void> {
    const point = await this.centerOf(tab, this.backendIdOf(tab, ref));
    await this.mouse(tab, 'mouseMoved', point);
    for (let i = 1; i <= count; i++) {
      await this.mouse(tab, 'mousePressed', point, button, i);
      await this.mouse(tab, 'mouseReleased', point, button, i);
    }
  }

  private mouse(tab: Tab, type: MouseType, point: Point, button: 'left' | 'middle' | 'right' | 'none' = 'none', clickCount = 0): Promise<unknown> {
    return this.send(tab, 'Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button, clickCount });
  }

  private insert(tab: Tab, text: string): Promise<unknown> {
    return this.send(tab, 'Input.insertText', { text });
  }

  private async key(tab: Tab, chord: string, holdMs = 0): Promise<void> {
    const parsed = parseChord(chord);
    const base = { key: parsed.key, code: parsed.code, windowsVirtualKeyCode: parsed.vk, modifiers: parsed.modifiers };
    await this.send(tab, 'Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(parsed.text ? { text: parsed.text } : {}) });
    if (holdMs > 0) await sleep(holdMs);
    await this.send(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }
}
