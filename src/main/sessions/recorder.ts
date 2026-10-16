import type { ChatMessage, PageEvent } from '@shared/page-protocol';
import type { SessionEvent, ToolOutputPart } from '@shared/types';
import type { SessionStore } from './store';

const DEFAULT_TITLE = 'New chat';
const OUTPUT_LIMIT = 4000;
const ARGS_LIMIT = 20000;
const ECHO_LIMIT = 20;
const CONTEXT_FRAME = /^\s*\\?<creatine_context>[\s\S]*?\\?<\/creatine_context>/;
const CONTEXT_START = /^\s*\\?<creatine_context>/;

interface SessionState {
  /** App-sent user texts waiting for ChatGPT's echo, oldest first. */
  echoes: { eventId: string; text: string }[];
  /** ChatGPT message ids already matched to an app-sent event (the stream repeats user messages). */
  claimed: Set<string>;
  /** Call message ids the MCP server records itself; ChatGPT's copy of them is skipped. */
  ownCalls: Set<string>;
  /** Tool result message id → the call it answers. A tool can answer in a chain of messages. */
  resultCalls: Map<string, string>;
}

interface RecorderDeps {
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

  /** The call message `messageId` is one of our MCP calls; its timeline event belongs to the server. */
  markOwnCall(sessionId: string, messageId: string): void {
    const own = this.state(sessionId).ownCalls;
    own.add(messageId);
    if (own.size > 500) own.delete(own.values().next().value!);
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
      case 'turn-end': {
        const now = Date.now();
        const settled = this.store.events(sessionId).flatMap<SessionEvent>((e) => {
          if ((e.kind === 'assistant' || e.kind === 'reasoning') && e.streaming) return [{ ...e, streaming: false }];
          // Our MCP tools can outlive the turn; ChatGPT's own tools cannot.
          if (e.kind === 'tool' && e.surface === 'chatgpt' && e.status === 'running') return [{ ...e, status: 'ok', endedAt: now }];
          return [];
        });
        if (settled.length) this.store.append(sessionId, settled);
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
      }
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
    if (!state) this.states.set(sessionId, (state = { echoes: [], claimed: new Set(), ownCalls: new Set(), resultCalls: new Map() }));
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
        streaming: message.status === 'in_progress',
        ...(message.citations.length ? { citations: message.citations } : {})
      }));
      return;
    }

    this.onToolCall(sessionId, message);
  }

  private onUserMessage(sessionId: string, message: ChatMessage): void {
    if (message.hidden) return;
    const state = this.state(sessionId);
    if (state.claimed.has(message.id)) return;
    // ChatGPT can echo Markdown-escaped tags or publish the frame before its closing tag.
    if (CONTEXT_START.test(message.text) && !CONTEXT_FRAME.test(message.text)) return;
    const text = message.text.replace(CONTEXT_FRAME, '').trim();
    if (!text) return;
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
    if (this.state(sessionId).ownCalls.has(message.id)) return;

    const parsed = parseJson(message.text);
    let name = message.recipient;
    if (message.recipient === 'api_tool.call_tool') {
      // The connector path decides whose call this is; until it has streamed in, record nothing.
      const path = recordPath(parsed) ?? streamedPath(message.text);
      if (!path || this.isOwnConnectorPath(path)) return;
      name = path;
    }

    const id = toolEventId(message.id);
    const args = message.text.length > ARGS_LIMIT ? message.text.slice(0, ARGS_LIMIT) : (parsed ?? message.text);
    const previous = this.store.event(sessionId, id);
    if (previous?.kind === 'tool') {
      this.store.append(sessionId, [{ ...previous, name, args, argsChars: message.text.length }]);
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
        argsChars: message.text.length,
        status: 'running',
        output: [],
        endedAt: null
      }
    ]);
  }

  private onToolResult(sessionId: string, message: ChatMessage): void {
    if (!message.parentId) return;
    const state = this.state(sessionId);
    // web.run answers in a chain (status, then results), each parented to the previous message.
    const callId = state.resultCalls.get(message.parentId) ?? message.parentId;
    if (state.ownCalls.has(callId)) return;
    const previous = this.store.event(sessionId, toolEventId(callId));
    if (previous?.kind !== 'tool') return;
    state.resultCalls.set(message.id, callId);
    if (state.resultCalls.size > 500) state.resultCalls.delete(state.resultCalls.keys().next().value!);

    const running = message.status === 'in_progress';
    const text: ToolOutputPart[] = message.text
      ? [{ type: 'text', text: message.text.slice(0, OUTPUT_LIMIT), truncated: message.text.length > OUTPUT_LIMIT }]
      : previous.output.filter((part) => part.type === 'text');
    // Web results: the pages a search found or a fetch opened, which the answer's citations point to.
    const known = previous.output.flatMap((part) => (part.type === 'sources' ? part.sources : []));
    const sources = [...known, ...message.sources.filter((source) => !known.some((seen) => seen.url === source.url && seen.ref === source.ref))];
    const output: ToolOutputPart[] = sources.length ? [...text, { type: 'sources', sources }] : text;
    this.store.append(sessionId, [
      {
        ...previous,
        status: running ? 'running' : 'ok',
        output,
        endedAt: running ? null : Date.now(),
        resultChars: message.text ? message.text.length : previous.resultChars
      }
    ]);
  }

  /** Upserts an event by id, keeping its original timestamp so streaming never reorders the transcript. */
  private put(sessionId: string, id: string, build: (id: string, at: number) => SessionEvent): void {
    const previous = this.store.event(sessionId, id);
    const next = build(id, previous?.at ?? Date.now());
    // A delayed conversation snapshot must not restart a completed message or replace its final text.
    if (previous && 'streaming' in previous && !previous.streaming && 'streaming' in next && next.streaming) return;
    this.store.append(sessionId, [next]);
  }
}

function toolEventId(callMessageId: string): string {
  return `tool:${callMessageId}`;
}

function normalize(text: string): string {
  return text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/\s+/g, ' ').trim();
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** The `path` of call_tool arguments that are still streaming, once its string is complete. */
function streamedPath(text: string): string | null {
  return /^\s*\{\s*"path"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(text)?.[1] ?? null;
}

function recordPath(parsed: unknown): string | null {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const path = (parsed as { path?: unknown }).path;
  return typeof path === 'string' ? path : null;
}
