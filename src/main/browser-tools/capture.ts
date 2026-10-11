import type { CdpEvent, RemoteObject } from './cdp';

const RING_SIZE = 200;

export interface ConsoleEntry {
  level: 'error' | 'warning' | 'info' | 'debug';
  text: string;
  url: string | null;
}

export interface NetworkEntry {
  requestId: string;
  method: string;
  url: string;
  type: string;
  status: number | null;
  mimeType: string | null;
  failed: string | null;
  finished: boolean;
}

export interface Page<T> {
  items: Array<T & { seq: number }>;
  /** Pass as `after` to continue after the last returned item. */
  cursor: number;
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

function argText(arg: RemoteObject): string {
  if (arg.value !== undefined) return typeof arg.value === 'string' ? arg.value : JSON.stringify(arg.value);
  return arg.description ?? arg.type ?? '';
}

export class BrowserCapture {
  readonly console = new Ring<ConsoleEntry>();
  readonly network = new Ring<NetworkEntry>();

  record(event: CdpEvent): boolean {
    const { method, params } = event;
    switch (method) {
      case 'Runtime.consoleAPICalled':
        this.console.add({
          level: consoleLevel(params.type),
          text: (params.args ?? []).map(argText).join(' '),
          url: params.stackTrace?.callFrames?.[0]?.url || null
        });
        break;
      case 'Runtime.exceptionThrown': {
        const details = params.exceptionDetails;
        this.console.add({
          level: 'error',
          text: details.exception?.description ?? details.text,
          url: details.url || null
        });
        break;
      }
      case 'Log.entryAdded':
        this.console.add({ level: logLevel(params.entry.level), text: params.entry.text, url: params.entry.url || null });
        break;
      case 'Network.requestWillBeSent':
        this.network.add({
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
        const entry = this.network.find((item) => item.requestId === params.requestId);
        if (entry) {
          entry.status = params.response.status;
          entry.mimeType = params.response.mimeType;
        }
        break;
      }
      case 'Network.loadingFailed': {
        const entry = this.network.find((item) => item.requestId === params.requestId);
        if (entry) entry.failed = params.errorText;
        break;
      }
      case 'Network.loadingFinished': {
        const entry = this.network.find((item) => item.requestId === params.requestId);
        if (entry) entry.finished = true;
        break;
      }
      case 'Page.frameNavigated':
        return !params.frame.parentId;
    }
    return false;
  }
}
