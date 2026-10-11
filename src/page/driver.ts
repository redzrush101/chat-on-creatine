/**
 * Page driver: runs inside a chatgpt.com page, observes the conversation stream relayed by the
 * fetch tap, watches the composer state and executes commands from the app.
 */
import type { ReasoningEffort } from '@shared/config';
import { ConversationStreamParser, conversationToMessages } from '@shared/chatgpt-stream';
import {
  conversationIdFromUrl,
  DRIVER_VERSION,
  type ChatMessage,
  type ModelsValue,
  type PageCommand,
  type PageEvent,
  type PageFile,
  type PageResult,
  type PageStatus,
  type SendValue
} from '@shared/page-protocol';
import * as dom from './dom';

export interface DriverTransport {
  send(event: PageEvent): void;
  onCommand(handler: (command: PageCommand) => Promise<PageResult>): void;
}

interface TapMessage {
  channel: string;
  kind: 'start' | 'chunk' | 'end' | 'error';
  streamId: string;
  requestId?: string | null;
  chunk?: string;
  error?: string;
}

interface Stream {
  id: string;
  parser: ConversationStreamParser;
  conversationId: string | null;
  complete: boolean;
  error: string | null;
  lastEmit: Map<string, number>;
  pending: Map<string, ChatMessage>;
  timer: ReturnType<typeof setTimeout> | null;
}

interface Session {
  signedIn: boolean;
  accessToken: string | null;
  email: string | null;
  at: number;
}

type Failure = Extract<PageResult, { ok: false }>;
type FailureCode = NonNullable<Failure['code']>;

const MESSAGE_INTERVAL_MS = 100;
const SESSION_TTL_MS = 5 * 60_000;
const NOTICE_DEBOUNCE_MS = 200;
const LOCATION_POLL_MS = 500;
const MODELS_PATH = '/backend-api/models?iim=false&include_icons=false&is_gizmo=false';

/** Backend thinking-effort names mapped onto the app's reasoning efforts. */
const EFFORT_NAMES: Record<string, ReasoningEffort> = {
  light: 'low',
  standard: 'medium',
  extended: 'high',
  heavy: 'xhigh',
  max: 'xhigh'
};

class DriverError extends Error {
  readonly code: FailureCode;
  constructor(message: string, code: FailureCode) {
    super(message);
    this.code = code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(code: FailureCode, error: string): PageResult {
  return { ok: false, error, code };
}

const DONE: PageResult = { ok: true };

function toFile(file: PageFile): File {
  const bytes = Uint8Array.from(atob(file.data), (char) => char.charCodeAt(0));
  return new File([bytes], file.name, { type: file.mime });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await wait(100);
  }
  return true;
}

function parseModels(body: unknown): ModelsValue {
  const root = isRecord(body) ? body : {};
  const list = (Array.isArray(root.models) ? root.models : []).filter(isRecord);
  const models = list.flatMap((model) => {
    const id = typeof model.slug === 'string' ? model.slug : null;
    if (!id) return [];
    const label = typeof model.title === 'string' ? model.title : id;
    const efforts: ReasoningEffort[] = [];
    if (model.reasoning_type !== 'none' && Array.isArray(model.thinking_efforts)) {
      for (const entry of model.thinking_efforts) {
        const name = isRecord(entry) && typeof entry.thinking_effort === 'string' ? entry.thinking_effort : null;
        const effort = name ? EFFORT_NAMES[name] : undefined;
        if (effort && !efforts.includes(effort)) efforts.push(effort);
      }
    }
    return [{ id, label, efforts }];
  });
  const fallback = list.find((model) => model.is_default === true);
  const defaultModel =
    typeof root.default_model_slug === 'string'
      ? root.default_model_slug
      : typeof fallback?.slug === 'string'
        ? fallback.slug
        : null;
  return { defaultModel, models };
}

/**
 * Starts the driver in the current page. Call once per document; the tap must already be
 * installed on `tapChannel`.
 */
export function startDriver(transport: DriverTransport, tapChannel: string): void {
  const emit = (event: PageEvent): void => transport.send(event);
  const streams = new Map<string, Stream>();
  const startWaiters = new Set<(value: SendValue) => void>();
  let session: Session | null = null;
  let models: ModelsValue | null = null;
  let lastGenerating: boolean | null = null;
  let lastNotice: string | null = null;
  let lastUrl = location.href;

  // Conversation stream

  function queueMessage(stream: Stream, message: ChatMessage): void {
    const now = Date.now();
    const last = stream.lastEmit.get(message.id) ?? 0;
    if (message.status !== 'in_progress' || now - last >= MESSAGE_INTERVAL_MS) {
      stream.pending.delete(message.id);
      stream.lastEmit.set(message.id, now);
      emit({ type: 'message', streamId: stream.id, message });
      return;
    }
    stream.pending.set(message.id, message);
    stream.timer ??= setTimeout(() => flushMessages(stream), MESSAGE_INTERVAL_MS - (now - last));
  }

  function flushMessages(stream: Stream): void {
    stream.timer = null;
    const now = Date.now();
    for (const [id, message] of stream.pending) {
      stream.lastEmit.set(id, now);
      emit({ type: 'message', streamId: stream.id, message });
    }
    stream.pending.clear();
  }

  function openStream(streamId: string, requestId: string | null): void {
    const stream: Stream = {
      id: streamId,
      conversationId: conversationIdFromUrl(location.href),
      complete: false,
      error: null,
      lastEmit: new Map(),
      pending: new Map(),
      timer: null,
      parser: new ConversationStreamParser({
        message: (message) => queueMessage(stream, message),
        conversation: (id) => {
          stream.conversationId = id;
        },
        title: (conversationId, title) => emit({ type: 'title', conversationId, title }),
        complete: () => {
          stream.complete = true;
        },
        error: (text) => {
          stream.error = text;
        }
      })
    };
    streams.set(streamId, stream);
    emit({ type: 'turn-start', streamId, conversationId: stream.conversationId, requestId });
    for (const waiter of [...startWaiters]) waiter({ conversationId: stream.conversationId, streamId });
  }

  function closeStream(streamId: string, error: string | null): void {
    const stream = streams.get(streamId);
    if (!stream) return;
    streams.delete(streamId);
    if (stream.timer) clearTimeout(stream.timer);
    flushMessages(stream);
    const outcome = stream.complete ? 'complete' : error || stream.error ? 'error' : 'aborted';
    emit({
      type: 'turn-end',
      streamId,
      conversationId: stream.conversationId,
      outcome,
      error: error ?? stream.error
    });
  }

  window.addEventListener('message', (event: MessageEvent) => {
    if (event.source !== window || event.origin !== location.origin) return;
    const data = event.data as TapMessage | null;
    if (!data || typeof data !== 'object' || data.channel !== tapChannel) return;
    switch (data.kind) {
      case 'start':
        openStream(data.streamId, data.requestId ?? null);
        break;
      case 'chunk':
        streams.get(data.streamId)?.parser.push(data.chunk ?? '');
        break;
      case 'end':
        streams.get(data.streamId)?.parser.end();
        closeStream(data.streamId, null);
        break;
      case 'error':
        streams.get(data.streamId)?.parser.end();
        closeStream(data.streamId, data.error ?? 'stream failed');
        break;
    }
  });

  // Session and backend API

  async function getSession(force = false): Promise<Session | null> {
    if (!force && session && Date.now() - session.at < SESSION_TTL_MS) return session;
    try {
      const response = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) return session;
      const body = (await response.json()) as { accessToken?: unknown; user?: { email?: unknown } };
      const accessToken = typeof body.accessToken === 'string' && body.accessToken ? body.accessToken : null;
      session = {
        signedIn: accessToken !== null,
        accessToken,
        email: typeof body.user?.email === 'string' ? body.user.email : null,
        at: Date.now()
      };
      return session;
    } catch {
      return session;
    }
  }

  async function refreshAuth(): Promise<void> {
    const current = await getSession(true);
    if (current) emit({ type: 'auth', signedIn: current.signedIn, email: current.email });
  }

  async function backend(path: string): Promise<unknown> {
    const current = await getSession();
    const headers: Record<string, string> = {};
    if (current?.accessToken) headers.Authorization = `Bearer ${current.accessToken}`;
    const response = await fetch(path, { headers, credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401 || response.status === 403) {
      throw new DriverError(`ChatGPT refused ${path.split('?')[0]} (HTTP ${response.status})`, 'signed-out');
    }
    if (!response.ok) throw new DriverError(`${path.split('?')[0]} failed (HTTP ${response.status})`, 'failed');
    return response.json();
  }

  async function loadModels(): Promise<ModelsValue> {
    models = parseModels(await backend(MODELS_PATH));
    return models;
  }

  // Commands

  async function status(): Promise<PageStatus> {
    const current = await getSession();
    return {
      url: location.href,
      conversationId: conversationIdFromUrl(location.href),
      signedIn: current?.signedIn ?? null,
      generating: dom.isGenerating(),
      composerReady: dom.findComposer() !== null
    };
  }

  function waitForStart(ms: number): Promise<SendValue | null> {
    return new Promise((resolve) => {
      const waiter = (value: SendValue): void => done(value);
      const done = (value: SendValue | null): void => {
        clearTimeout(timer);
        startWaiters.delete(waiter);
        resolve(value);
      };
      const timer = setTimeout(() => done(null), ms);
      startWaiters.add(waiter);
    });
  }

  async function send(text: string, files: PageFile[]): Promise<PageResult> {
    if (!(await waitFor(() => dom.findComposer() !== null, 15_000))) return fail('not-ready', 'composer not found');
    if (dom.isGenerating()) return fail('busy', 'a response is still generating');
    if (!dom.setComposerText(text)) return fail('failed', 'could not type into the composer');
    if (files.length > 0 && !(await dom.attachFiles(files.map(toFile)))) {
      return fail('failed', 'attachments did not finish uploading');
    }
    const sendable = (): boolean => {
      const button = dom.findSendButton();
      return button !== null && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
    };
    // With attachments the button may not be identifiable; clickSend then submits with Enter.
    if (!(await waitFor(sendable, files.length > 0 ? 1_500 : 5_000)) && files.length === 0) return fail('not-ready', 'send button is not available');
    // Register before clicking: the stream can start before the click returns.
    const started = waitForStart(20_000);
    if (!dom.clickSend()) return fail('failed', 'send button could not be clicked');
    const value = await started;
    return value ? { ok: true, value } : fail('timeout', 'no conversation stream started after send');
  }

  async function selectModel(model: string, effort: ReasoningEffort | null): Promise<PageResult> {
    if (!models) await loadModels().catch(() => undefined);
    const label = models?.models.find((entry) => entry.id === model)?.label ?? model;
    return (await dom.selectModel(label, effort)) ? DONE : fail('not-found', `model ${model} not found in the picker`);
  }

  async function run(command: PageCommand): Promise<PageResult> {
    try {
      switch (command.type) {
        case 'status':
          return { ok: true, value: await status() };
        case 'send':
          return await send(command.text, command.files);
        case 'stop':
          return dom.clickStop() ? DONE : fail('not-found', 'no stop control is visible');
        case 'models':
          return { ok: true, value: await loadModels() };
        case 'conversation': {
          const json = await backend(`/backend-api/conversation/${encodeURIComponent(command.conversationId)}`);
          return { ok: true, value: conversationToMessages(json) };
        }
        case 'select-model':
          return await selectModel(command.model, command.effort);
        case 'usage':
          return { ok: false, error: 'unsupported' };
      }
    } catch (error) {
      if (error instanceof DriverError) return fail(error.code, error.message);
      return fail('failed', error instanceof Error ? error.message : String(error));
    }
  }

  // Page observation

  function checkPage(): void {
    const generating = dom.isGenerating();
    if (generating !== lastGenerating) {
      lastGenerating = generating;
      emit({ type: 'generating', value: generating });
    }
    const notice = dom.readErrorNotice();
    const key = notice ? `${notice.level}:${notice.text}` : null;
    if (notice && key !== lastNotice) emit({ type: 'notice', level: notice.level, text: notice.text });
    lastNotice = key;
  }

  let checkTimer: ReturnType<typeof setTimeout> | null = null;
  const scheduleCheck = (): void => {
    if (checkTimer) return;
    checkTimer = setTimeout(() => {
      checkTimer = null;
      checkPage();
    }, NOTICE_DEBOUNCE_MS);
  };
  new MutationObserver(scheduleCheck).observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-label', 'data-testid', 'data-state', 'class', 'hidden', 'aria-hidden']
  });

  const checkLocation = (): void => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    emit({ type: 'location', url: lastUrl, conversationId: conversationIdFromUrl(lastUrl) });
  };
  setInterval(checkLocation, LOCATION_POLL_MS);
  window.addEventListener('popstate', checkLocation);

  transport.onCommand(run);
  emit({
    type: 'hello',
    driverVersion: DRIVER_VERSION,
    url: location.href,
    conversationId: conversationIdFromUrl(location.href),
    signedIn: null
  });
  void refreshAuth();
  checkPage();
}
