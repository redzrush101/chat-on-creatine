import { z } from 'zod';
import type { Config } from '@shared/config';
import { createLogger } from '../core/log';
import { projectInput } from './reads';
import { ApiError, type ApiReply, type ControlApiDeps } from './types';

/**
 * Action routes: send a message to an existing chat through the outbox, and withdraw one that has
 * not been handed to ChatGPT. The outbox stays the only owner of what was admitted and delivered.
 */

const log = createLogger('control-api');

const MAX_TEXT = 64_000;
const LOWER_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SESSION_ID = /^[0-9a-f-]{8,64}$/;
const CANCEL_ROUTE = /^\/v1\/inputs\/([^/]+)\/cancel$/;

const sendBody = z
  .strictObject({
    id: z.string().regex(LOWER_UUID, 'id must be a new lowercase UUID'),
    sessionId: z.string().regex(SESSION_ID),
    text: z.string().max(MAX_TEXT),
    /** Consent to send into an answer ChatGPT is writing right now. */
    interrupt: z.boolean().optional()
  })
  .refine((body) => body.text.trim().length > 0, 'text is empty');

export function actionsAllowed(config: Config): boolean {
  return config.controlApi.enabled && config.controlApi.allowActions;
}

export function isActionRoute(route: string): boolean {
  return route === '/v1/inputs' || CANCEL_ROUTE.test(route);
}

function parseBody<T>(schema: z.ZodType<T>, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const detail = issue?.code === 'unrecognized_keys' ? 'unknown field' : issue?.message ?? 'body is not valid';
    throw new ApiError(400, 'invalid_body', detail);
  }
  return parsed.data;
}

function send(deps: ControlApiDeps, body: unknown): ApiReply {
  const input = parseBody(sendBody, body);
  const text = input.text.trim();

  // A repeated id names the message that already exists. The caller must not reuse an id for other text.
  const existing = deps.outbox.get(input.id);
  if (existing) {
    if (existing.source !== 'control-api' || existing.sessionId !== input.sessionId || existing.text !== text) {
      throw new ApiError(409, 'id_conflict', 'this id belongs to a different message');
    }
    return { status: 200, body: { input: projectInput(existing), replayed: true } };
  }

  const session = deps.store.get(input.sessionId);
  if (!session) throw new ApiError(404, 'session_not_found');
  if (session.kind !== 'chat') throw new ApiError(409, 'session_not_controllable', 'worker and helper chats cannot be sent to');
  if (deps.turnOf(input.sessionId) === 'generating' && input.interrupt !== true) {
    throw new ApiError(409, 'would_interrupt', 'the chat is answering; pass interrupt:true to send into that answer');
  }

  const item = deps.outbox.enqueue({
    id: input.id,
    sessionId: input.sessionId,
    text,
    attachments: [],
    delivery: 'now',
    source: 'control-api'
  });
  log.info(`message ${item.id} admitted for session ${input.sessionId}`);
  // Admitted, not delivered: delivery is read later from GET /v1/inputs.
  return { status: 202, body: { input: projectInput(item), replayed: false } };
}

function cancel(deps: ControlApiDeps, id: string): ApiReply {
  const item = deps.outbox.get(id);
  if (!item) throw new ApiError(404, 'input_not_found');
  const session = deps.store.get(item.sessionId);
  if (session && session.kind !== 'chat') throw new ApiError(409, 'session_not_controllable');

  if (item.state === 'cancelled' || item.state === 'failed') {
    return { status: 200, body: { input: projectInput(item), cancelled: false } };
  }
  if (item.state !== 'queued') {
    const detail = item.state === 'sending' ? 'the send is in progress and may already be in ChatGPT' : 'already handed to ChatGPT';
    throw new ApiError(409, 'not_cancellable', detail);
  }
  const cancelled = deps.outbox.cancel(id);
  if (!cancelled) throw new ApiError(409, 'not_cancellable');
  log.info(`message ${id} cancelled before it was sent`);
  return { status: 200, body: { input: projectInput(cancelled), cancelled: true } };
}

/** Caller has already checked that actions are allowed and that the body was read. */
export function serveAction(deps: ControlApiDeps, route: string, body: unknown): ApiReply {
  if (route === '/v1/inputs') return send(deps, body);
  const match = CANCEL_ROUTE.exec(route);
  if (match) {
    if (body !== undefined && !(typeof body === 'object' && body !== null && Object.keys(body).length === 0)) {
      throw new ApiError(400, 'invalid_body', 'cancel takes no body');
    }
    return cancel(deps, match[1]!);
  }
  throw new ApiError(404, 'not_found');
}
