import { WebSocket } from 'ws';

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** A DevTools protocol connection; the harness uses it only for the main process's Node inspector. */
export class Cdp {
  private nextId = 0;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>();

  private constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as { id?: number; result?: unknown; error?: { message: string } };
      const waiter = message.id === undefined ? undefined : this.pending.get(message.id);
      if (!waiter) return;
      this.pending.delete(message.id!);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
  }

  static async connect(url: string): Promise<Cdp> {
    const socket = new WebSocket(url, { perMessageDeflate: false });
    await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
    return new Cdp(socket);
  }

  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluates an expression and returns its value; a thrown error rejects with its message. */
  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send<{ result: { value?: T }; exceptionDetails?: { exception?: { description?: string }; text: string } }>('Runtime.evaluate', {
      expression, awaitPromise: true, returnByValue: true
    });
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    return result.result.value as T;
  }

  close(): void { this.socket.close(); }
}

const KEYS: Record<string, { keyCode: string; modifiers: string[] }> = {
  Enter: { keyCode: 'Enter', modifiers: [] },
  Escape: { keyCode: 'Escape', modifiers: [] },
  'Control+o': { keyCode: 'O', modifiers: ['control'] }
};

/**
 * The app's window, driven from the main process through Electron's own webContents APIs. No
 * DevTools port is opened: with one, ChatGPT refuses the account on every tab.
 */
export class Ui {
  constructor(private readonly main: Cdp) {}

  /** Runs `body` in the main process with `contents`, the app window's webContents. */
  private web<T>(body: string): Promise<T> {
    return this.main.evaluate<T>(`(async () => {
      const { BrowserWindow } = process.mainModule.require('electron');
      const contents = BrowserWindow.getAllWindows().find((item) => item.getTitle() === 'Chat on Creatine').webContents;
      return (${body});
    })()`);
  }

  /** Evaluates an expression in the window. */
  evaluate<T>(expression: string): Promise<T> { return this.web<T>(`contents.executeJavaScript(${JSON.stringify(expression)}, true)`); }

  /** Waits for the last element matching `selector` (and containing `text`), then runs `body` on it as `element`. */
  async on<T>(selector: string, body: string, text = '', timeoutMs = 30_000): Promise<T> {
    const find = `[...document.querySelectorAll(${JSON.stringify(selector)})].filter((item) => item.textContent.includes(${JSON.stringify(text)})).at(-1)`;
    for (const deadline = Date.now() + timeoutMs; ; await sleep(250)) {
      if (await this.evaluate<boolean>(`!!${find}`)) return this.evaluate<T>(`((element) => (${body}))(${find})`);
      if (Date.now() > deadline) throw new Error(`No element matches ${selector}${text ? ` with "${text}"` : ''}`);
    }
  }

  click(selector: string, text = ''): Promise<void> { return this.on(selector, 'element.click()', text); }
  focus(selector: string): Promise<void> { return this.on(selector, 'element.focus()'); }
  text(selector: string): Promise<string> { return this.on(selector, 'element.innerText'); }
  box(selector: string): Promise<{ x: number; y: number; width: number; height: number }> {
    return this.on(selector, '(({ x, y, width, height }) => ({ x, y, width, height }))(element.getBoundingClientRect())');
  }

  /** Types into the focused element; a newline presses Enter. */
  async type(text: string): Promise<void> {
    for (const [index, line] of text.split('\n').entries()) {
      if (index) await this.press('Enter');
      if (line) await this.web(`contents.insertText(${JSON.stringify(line)})`);
    }
  }

  /** Presses `Enter`, `Escape` or `Control+o`. */
  async press(chord: string): Promise<void> {
    const key = JSON.stringify(KEYS[chord]!);
    await this.web(`(contents.sendInputEvent({ type: 'keyDown', ...${key} }), contents.sendInputEvent({ type: 'keyUp', ...${key} }))`);
  }
}
