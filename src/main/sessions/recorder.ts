import type { ChatMessage, PageEvent } from '@shared/page-protocol';
import type { SessionEvent, ToolOutputPart } from '@shared/types';
import type { SessionStore } from './store';

const DEFAULT_TITLE = 'New chat';
const OUTPUT_LIMIT = 4000;
const ARGS_LIMIT = 20000;
const ECHO_LIMIT = 20;
const CONTEXT_FRAME = /^\s*<creatine_context>[\s\S]*?<\/creatine_context>/;

interface SessionState {
  /** App-sent user texts waiting for ChatGPT's echo, oldest first. */
  echoes: { eventId: string; text: string }[];
  /** ChatGPT message ids already matched to an app-sent event (the stream repeats user messages). */
  claimed: Set<string>;
}

export interface RecorderDeps {
  store: SessionStore;
  /** True for calls to our own MCP connector; those are recorded by the MCP server itself. */
  isOwnConnectorPath(path: string): boolean;
}

/** Maps the page events of one bound session into durable SessionEvents. */
export class Recorder {
  private readonly store: SessionStore;
  private readonly isOwnConnectorPath: (path: string) => boolean;
  private readonly states = new Map<string, SessionState>();

  constructor(deps: RecorderDeps) {
    this.store = deps.store;
    this.isOwnConnectorPath = deps.isOwnConnectorPath;
  }

  /** Registers a user message the app sent, so ChatGPT's echo of it does not record a duplicate. */
  expectUserEcho(sessionId: string, eventId: string, text: string): void {
    const normalized = normalize(text);
    if (!normalized) return;
    const state = this.state(sessionId);
    state.echoes.push({ eventId, text: normalized });
    if (state.echoes.length > ECHO_LIMIT) state.echoes.shift();
  }

  handle(sessionId: string, event: PageEvent): void {
    switch (event.type) {
      case 'message':
        this.onMessage(sessionId, event.message);
        return;
      case 'turn-start':
        this.store.append(sessionId, [
          { id: `turn:${event.streamId}:start`, at: Date.now(), kind: 'turn', phase: 'start', outcome: null, error: null }
        ]);
        return;
      case 'turn-end':
        this.store.append(sessionId, [
          {
            id: `turn:${event.streamId}:end`,
            at: Date.now(),
            kind: 'turn',
            phase: 'end',
            outcome: event.outcome === 'complete' ? 'done' : event.outcome === 'aborted' ? 'stopped' : 'error',
            error: event.error
          }
        ]);
        return;
      case 'title': {
        const title = event.title.trim().slice(0, 120);
        if (title && this.store.get(sessionId)?.title === DEFAULT_TITLE) this.store.update(sessionId, { title });
        return;
      }
      default:
        return;
    }
  }

  private state(sessionId: string): SessionState {
    let state = this.states.get(sessionId);
    if (!state) this.states.set(sessionId, (state = { echoes: [], claimed: new Set() }));
    return state;
  }

  private onMessage(sessionId: string, message: ChatMessage): void {
    if (message.role === 'user') return this.onUserMessage(sessionId, message);
    if (message.role === 'tool') return this.onToolResult(sessionId, message);
    if (message.role !== 'assistant') return;

    if (message.contentType === 'thoughts' || message.contentType === 'reasoning_recap') {
      if (!message.text.trim()) return;
      this.put(sessionId, `reasoning:${message.id}`, (id, at) => ({
        id,
        at,
        kind: 'reasoning',
        messageId: message.id,
        text: message.text,
        streaming: message.status === 'in_progress'
      }));
      return;
    }

    if (message.recipient === 'all') {
      if (message.contentType !== 'text' || !message.text.trim()) return;
      this.put(sessionId, `msg:${message.id}`, (id, at) => ({
        id,
        at,
        kind: 'assistant',
        messageId: message.id,
        text: message.text,
        channel: message.channel === null || message.channel === 'final' ? 'final' : 'commentary',
        model: message.model,
        streaming: message.status === 'in_progress'
      }));
      return;
    }

    this.onToolCall(sessionId, message);
  }

  private onUserMessage(sessionId: string, message: ChatMessage): void {
    if (message.hidden) return;
    const state = this.state(sessionId);
    if (state.claimed.has(message.id)) return;
    const text = message.text.replace(CONTEXT_FRAME, '').trim();
    const incoming = normalize(text);

    const index = state.echoes.findIndex(
      (echo) => incoming === echo.text || incoming.endsWith(echo.text)
    );
    if (index >= 0) {
      state.echoes.splice(index, 1);
      state.claimed.add(message.id);
      if (state.claimed.size > 200) state.claimed.delete(state.claimed.values().next().value!);
      return;
    }

    this.put(sessionId, `msg:${message.id}`, (id, at) => ({
      id,
      at,
      kind: 'user',
      text,
      inputId: null,
      attachments: [],
      source: 'browser'
    }));
  }

  /** A native tool call. Our own connector calls are skipped; the MCP server records those. */
  private onToolCall(sessionId: string, message: ChatMessage): void {
    if (message.recipient === 'api_tool.list_resources') return;

    const parsed = parseJson(message.text);
    let name = message.recipient;
    if (message.recipient === 'api_tool.call_tool') {
      const path = recordPath(parsed);
      if (path && this.isOwnConnectorPath(path)) return;
      name = path ?? message.recipient;
    }

    const id = toolEventId(message.id);
    const args = message.text.length > ARGS_LIMIT ? message.text.slice(0, ARGS_LIMIT) : (parsed ?? message.text);
    const previous = this.store.event(sessionId, id);
    if (previous?.kind === 'tool') {
      this.store.append(sessionId, [{ ...previous, name, args }]);
      return;
    }
    this.store.append(sessionId, [
      {
        id,
        at: Date.now(),
        kind: 'tool',
        surface: 'chatgpt',
        name,
        args,
        status: 'running',
        output: [],
        endedAt: null
      }
    ]);
  }

  private onToolResult(sessionId: string, message: ChatMessage): void {
    if (!message.parentId) return;
    const previous = this.store.event(sessionId, toolEventId(message.parentId));
    if (previous?.kind !== 'tool') return;

    const running = message.status === 'in_progress';
    const output: ToolOutputPart[] = message.text
      ? [{ type: 'text', text: message.text.slice(0, OUTPUT_LIMIT), truncated: message.text.length > OUTPUT_LIMIT }]
      : [];
    this.store.append(sessionId, [
      { ...previous, status: running ? 'running' : 'ok', output, endedAt: running ? null : Date.now() }
    ]);
  }

  /** Upserts an event by id, keeping its original timestamp so streaming never reorders the transcript. */
  private put(sessionId: string, id: string, build: (id: string, at: number) => SessionEvent): void {
    const at = this.store.event(sessionId, id)?.at ?? Date.now();
    this.store.append(sessionId, [build(id, at)]);
  }
}

function toolEventId(callMessageId: string): string {
  return `tool:${callMessageId}`;
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function recordPath(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const path = (parsed as { path?: unknown }).path;
  return typeof path === 'string' ? path : null;
}
