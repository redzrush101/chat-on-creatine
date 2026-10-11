import { z } from 'zod';
import type {
  InputItem,
  InputState,
  SessionEvent,
  SessionEventKind,
  SessionMeta,
  ToolOutputPart
} from '@shared/types';
import { ApiError, clip, line, type ControlApiDeps } from './types';

/**
 * Read routes. Each projection names every field it publishes, so a field added to an owner later
 * stays private until it is listed here. Free text is redacted and cut to a fixed size.
 */

const PAGE = 50;
const TEXT_CAP = 4_000;
const TOOL_CAP = 2_000;
const TITLE_CAP = 200;
const SUMMARY_CAP = 300;
const TASK_CAP = 1_000;

const EVENT_KINDS: Record<SessionEventKind, true> = {
  user: true, assistant: true, reasoning: true, tool: true, plan: true,
  turn: true, notice: true, agent: true, handoff: true
};
const INPUT_STATES: Record<InputState, true> = {
  queued: true, sending: true, sent: true, steered: true, failed: true, cancelled: true
};
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;

const int = (min: number, max: number) =>
  z.string().regex(/^\d{1,16}$/).transform(Number).pipe(z.number().int().min(min).max(max));

const csv = <V extends string>(allowed: readonly V[]) =>
  z
    .string()
    .transform((value) => value.split(','))
    .pipe(z.array(z.enum(allowed as [V, ...V[]])).min(1));

/** Unknown or repeated parameters are refused rather than ignored. */
function parseQuery<T extends z.core.$ZodLooseShape>(params: URLSearchParams, shape: T) {
  const raw: Record<string, string> = Object.create(null);
  for (const [key, value] of params) {
    if (key in raw) throw new ApiError(400, 'invalid_query', 'a parameter was given more than once');
    raw[key] = value;
  }
  const parsed = z.strictObject(shape).safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const detail = issue?.code === 'unrecognized_keys' ? 'unknown parameter' : `${issue?.path.join('.') || 'query'} is not valid`;
    throw new ApiError(400, 'invalid_query', detail);
  }
  return parsed.data;
}

// ----------------------------------------------------------- projections

function projectSession(meta: SessionMeta) {
  return {
    id: meta.id,
    kind: meta.kind,
    title: line(meta.title, TITLE_CAP),
    projectId: meta.projectId,
    conversationId: meta.conversationId,
    lineage: meta.lineage,
    model: meta.model,
    reasoning: meta.reasoning,
    createdAt: meta.createdAt,
    updatedAt: meta.updatedAt,
    pinned: meta.pinned,
    parentId: meta.parentId,
    blocked: meta.blocked,
    contextTokens: meta.contextTokens,
    goal: { mode: meta.goal.mode, status: meta.goal.status, steps: meta.goal.steps }
  };
}

function toolPart(part: ToolOutputPart): Record<string, unknown> {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: clip(part.text, TOOL_CAP) };
    case 'image':
      return { type: 'image', mime: part.mime };
    case 'diff':
      return { type: 'diff', path: line(part.path, TITLE_CAP), added: part.added, removed: part.removed, diff: clip(part.diff, TOOL_CAP) };
    case 'exec':
      return { type: 'exec', command: clip(part.command, TOOL_CAP), exitCode: part.exitCode, running: part.running, output: clip(part.output, TOOL_CAP) };
  }
}

function projectEvent(event: SessionEvent, position: number): Record<string, unknown> {
  const base = { id: event.id, position, at: event.at, kind: event.kind };
  switch (event.kind) {
    case 'user':
      return { ...base, source: event.source, inputId: event.inputId, attachments: event.attachments.length, text: clip(event.text, TEXT_CAP) };
    case 'assistant':
      return { ...base, messageId: event.messageId, channel: event.channel, model: event.model, streaming: event.streaming, text: clip(event.text, TEXT_CAP) };
    case 'reasoning':
      return { ...base, messageId: event.messageId, streaming: event.streaming, text: clip(event.text, TEXT_CAP) };
    case 'tool':
      return {
        ...base,
        surface: event.surface,
        name: line(event.name, TITLE_CAP),
        status: event.status,
        endedAt: event.endedAt,
        args: clip(JSON.stringify(event.args) ?? 'null', TOOL_CAP),
        output: event.output.map(toolPart)
      };
    case 'plan':
      return {
        ...base,
        explanation: event.explanation ? clip(event.explanation, TEXT_CAP) : null,
        items: event.items.map((item) => ({ step: line(item.step, TOOL_CAP), status: item.status }))
      };
    case 'turn':
      return { ...base, phase: event.phase, outcome: event.outcome, error: event.error ? line(event.error, SUMMARY_CAP) : null };
    case 'notice':
      return { ...base, level: event.level, text: clip(event.text, TEXT_CAP) };
    case 'agent':
      return { ...base, workerSessionId: event.workerSessionId, label: line(event.label, TITLE_CAP), action: event.action, text: clip(event.text, TEXT_CAP) };
    case 'handoff':
      return { ...base, fromConversationId: event.fromConversationId, toConversationId: event.toConversationId, brief: clip(event.brief, TEXT_CAP) };
  }
}

/** `sent` and `steered` reached ChatGPT; `failed` came from a send in flight, so it may have. */
function deliveryOf(state: InputState): 'sent' | 'not_sent' | 'unconfirmed' | 'pending' {
  switch (state) {
    case 'queued':
      return 'pending';
    case 'cancelled':
      return 'not_sent';
    case 'sending':
    case 'failed':
      return 'unconfirmed';
    case 'sent':
    case 'steered':
      return 'sent';
  }
}

export function projectInput(item: InputItem) {
  return {
    id: item.id,
    sessionId: item.sessionId,
    state: item.state,
    delivery: deliveryOf(item.state),
    mode: item.delivery,
    source: item.source,
    createdAt: item.createdAt,
    sentAt: item.sentAt,
    error: item.error ? line(item.error, SUMMARY_CAP) : null,
    text: clip(item.text, TEXT_CAP),
    attachments: item.attachments.length
  };
}

// ---------------------------------------------------------------- routes

const CURSOR = /^(\d{1,16})\.([0-9a-f-]{8,64})$/;
const SESSION_ROUTE = /^\/v1\/sessions\/([0-9a-f-]{8,64})(\/events)?$/;

/** Newest first; ties broken by id so a cursor names one exact position. */
const newestFirst = (a: SessionMeta, b: SessionMeta) =>
  b.updatedAt - a.updatedAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);

function sessionList(deps: ControlApiDeps, params: URLSearchParams) {
  const query = parseQuery(params, { cursor: z.string().max(100).optional() });
  const match = query.cursor === undefined ? null : CURSOR.exec(query.cursor);
  if (query.cursor !== undefined && !match) throw new ApiError(400, 'invalid_query', 'cursor is not valid');
  const cursor = match ? { updatedAt: Number(match[1]), id: match[2]! } : null;
  const ordered = deps.store.list().sort(newestFirst);
  const rest = cursor
    ? ordered.filter((meta) => meta.updatedAt < cursor.updatedAt || (meta.updatedAt === cursor.updatedAt && meta.id < cursor.id))
    : ordered;
  const page = rest.slice(0, PAGE);
  const last = page.at(-1);
  return {
    sessions: page.map(projectSession),
    nextCursor: rest.length > PAGE && last ? `${last.updatedAt}.${last.id}` : null
  };
}

function sessionDetail(deps: ControlApiDeps, id: string, params: URLSearchParams) {
  const query = parseQuery(params, { live: z.literal('1').optional() });
  const meta = deps.store.get(id);
  if (!meta) throw new ApiError(404, 'session_not_found');
  // Only the turn is known here; the waits and deadlines the app holds are not in the deps.
  return query.live ? { session: projectSession(meta), live: { turn: deps.turnOf(id) } } : { session: projectSession(meta) };
}

function sessionEvents(deps: ControlApiDeps, id: string, params: URLSearchParams) {
  const query = parseQuery(params, {
    from: int(0, 10_000_000).optional(),
    before: int(1, 10_000_000).optional(),
    after: int(0, 10_000_000).optional(),
    limit: int(1, 100).optional(),
    kinds: csv(Object.keys(EVENT_KINDS) as SessionEventKind[]).optional()
  });
  if (query.from !== undefined && (query.before !== undefined || query.after !== undefined)) {
    throw new ApiError(400, 'invalid_query', 'from cannot be combined with before or after');
  }
  if (!deps.store.get(id)) throw new ApiError(404, 'session_not_found');
  const kinds = query.kinds ? new Set<SessionEventKind>(query.kinds) : null;
  // A position is the event's place in the chat. Upserts keep their place, so it is stable.
  const matches = deps.store
    .events(id)
    .map((event, index) => ({ event, position: index + 1 }))
    .filter(({ event }) => !kinds || kinds.has(event.kind));
  const limit = query.limit ?? 50;
  const indexAfter = (test: (position: number) => boolean) => {
    const found = matches.findIndex(({ position }) => test(position));
    return found < 0 ? matches.length : found;
  };
  let start: number;
  let end: number;
  if (query.before !== undefined) {
    end = indexAfter((position) => position >= query.before!);
    start = Math.max(0, end - limit);
  } else if (query.after !== undefined) {
    start = indexAfter((position) => position > query.after!);
    end = Math.min(matches.length, start + limit);
  } else if (query.from !== undefined) {
    start = indexAfter((position) => position >= query.from!);
    end = Math.min(matches.length, start + limit);
  } else {
    start = Math.max(0, matches.length - limit);
    end = matches.length;
  }
  return {
    events: matches.slice(start, end).map(({ event, position }) => projectEvent(event, position)),
    total: matches.length,
    // Pass as `before` for older events, or as `after` for newer ones; null when none remain.
    nextBefore: start > 0 ? matches[start]!.position : null,
    nextAfter: end < matches.length ? matches[end - 1]!.position : null
  };
}

function inputs(deps: ControlApiDeps, params: URLSearchParams) {
  const query = parseQuery(params, {
    state: csv(Object.keys(INPUT_STATES) as InputState[]).optional(),
    limit: int(1, 500).optional()
  });
  const matching = deps.outbox
    .list()
    .filter((item) => !query.state || query.state.includes(item.state))
    .sort((a, b) => a.createdAt - b.createdAt);
  return { inputs: matching.slice(-(query.limit ?? 100)).map(projectInput), total: matching.length };
}

function agents(deps: ControlApiDeps) {
  return {
    agents: deps.agents().map((run) => ({
      primeSessionId: run.primeSessionId,
      workers: run.workers.map((worker) => ({
        sessionId: worker.sessionId,
        label: line(worker.label, TITLE_CAP),
        task: clip(worker.task, TASK_CAP),
        state: worker.state,
        model: worker.model,
        reasoning: worker.reasoning,
        lastResult: worker.lastResult ? clip(worker.lastResult, TEXT_CAP) : null,
        updatedAt: worker.updatedAt
      }))
    }))
  };
}

function activityLog(deps: ControlApiDeps, params: URLSearchParams) {
  const query = parseQuery(params, {
    limit: int(1, 500).optional(),
    since: int(0, Number.MAX_SAFE_INTEGER).optional(),
    level: csv([...LOG_LEVELS]).optional()
  });
  // Inclusive `since`: lines share a millisecond, so the caller drops the repeats itself.
  const matching = deps
    .logs(2_000)
    .filter((entry) => (query.since === undefined || entry.at >= query.since) && (!query.level || query.level.includes(entry.level)));
  return {
    entries: matching.slice(-(query.limit ?? 200)).map((entry) => ({
      at: entry.at,
      level: entry.level,
      scope: entry.scope,
      message: clip(entry.message, TEXT_CAP)
    }))
  };
}

function status(deps: ControlApiDeps) {
  const connection = deps.connectionStatus();
  return {
    appVersion: deps.version,
    connection: {
      state: connection.state,
      detail: line(connection.detail, SUMMARY_CAP),
      // The surfaces' URLs carry the secret MCP path, so they are not projected.
      surfaces: connection.surfaces.map((surface) => ({
        id: surface.id,
        enabled: surface.enabled,
        state: surface.state,
        detail: line(surface.detail, SUMMARY_CAP),
        toolCount: surface.toolCount,
        handshakeAt: surface.handshakeAt,
        lastRequestAt: surface.lastRequestAt,
        lastToolCallAt: surface.lastToolCallAt
      }))
    }
  };
}

/** Undefined when the path is not a read route. */
export function serveRead(deps: ControlApiDeps, route: string, params: URLSearchParams): unknown {
  if (route === '/v1/status') return status(deps);
  if (route === '/v1/sessions') return sessionList(deps, params);
  if (route === '/v1/inputs') return inputs(deps, params);
  if (route === '/v1/agents') {
    parseQuery(params, {});
    return agents(deps);
  }
  if (route === '/v1/log') return activityLog(deps, params);
  const session = SESSION_ROUTE.exec(route);
  if (session) return session[2] ? sessionEvents(deps, session[1]!, params) : sessionDetail(deps, session[1]!, params);
  return undefined;
}
