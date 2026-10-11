import type { InputItem, PlanItem, SessionEvent, ToolOutputPart } from '@shared/types';
import { createLogger } from '../core/log';
import type { ChatRouter } from '../chatgpt/router';
import type { CallRecord } from '../mcp/server';
import type { Caller, ToolResult } from '../mcp/tool';
import type { Outbox } from '../sessions/outbox';
import type { SessionStore } from '../sessions/store';
import type { ConnectionManager } from '../tunnel/connection';

const log = createLogger('tools');
const DISPLAY_TEXT_LIMIT = 8_000;
const ARGS_TEXT_LIMIT = 20_000;
const FINISH_WAIT_MS = 25_000;

/** Shares the recorder's id for ChatGPT's streamed call message, so both sides upsert one event. */
function eventIdOf(call: CallRecord): string {
  return call.caller?.streamCallId ? `tool:${call.caller.streamCallId}` : `call:${call.id}`;
}

function boundArgs(args: unknown): unknown {
  const text = JSON.stringify(args ?? null);
  return text.length <= ARGS_TEXT_LIMIT ? args : `${text.slice(0, ARGS_TEXT_LIMIT)}…`;
}

function displayOf(result: ToolResult): ToolOutputPart[] {
  if (result.display?.length) return result.display;
  const text = result.content
    .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
    .map((block) => block.text)
    .join('\n');
  return [{ type: 'text', text: text.slice(0, DISPLAY_TEXT_LIMIT), truncated: text.length > DISPLAY_TEXT_LIMIT }];
}

/**
 * Everything the MCP server reports back into the app: recorded tool calls, plans, steering of
 * queued user messages into tool results, and the session_finish hold.
 */
export class ToolActivity {
  constructor(
    private readonly deps: { store: SessionStore; outbox: Outbox; router: ChatRouter; connection: () => ConnectionManager | null }
  ) {}

  onRequest(surface: CallRecord['surface']): void {
    this.deps.connection()?.noteRequest(surface);
  }

  onCallStart(call: CallRecord): void {
    this.deps.connection()?.noteToolCall(call.surface);
    if (!call.caller) {
      log.info(`unattributed ${call.surface}/${call.tool}`);
      return;
    }
    this.deps.router.noteToolRunning(call.caller.sessionId, 1);
    this.record(call.caller.sessionId, {
      kind: 'tool',
      id: eventIdOf(call),
      at: this.deps.store.event(call.caller.sessionId, eventIdOf(call))?.at ?? call.startedAt,
      surface: call.surface,
      name: call.tool,
      args: boundArgs(call.args),
      status: 'running',
      output: [],
      endedAt: null
    });
  }

  onCallEnd(call: CallRecord, result: ToolResult): void {
    if (!call.caller) return;
    this.deps.router.noteToolRunning(call.caller.sessionId, -1);
    this.record(call.caller.sessionId, {
      kind: 'tool',
      id: eventIdOf(call),
      at: this.deps.store.event(call.caller.sessionId, eventIdOf(call))?.at ?? call.startedAt,
      surface: call.surface,
      name: call.tool,
      args: boundArgs(call.args),
      status: result.isError ? 'error' : 'ok',
      output: displayOf(result),
      endedAt: Date.now()
    });
  }

  /** Messages queued while the model worked ride along with its next tool result, labelled by sender. */
  steering(caller: Caller): string[] {
    return this.take(caller).map((item) =>
      item.source === 'agent'
        ? `MESSAGE FROM ANOTHER AGENT IN THIS RUN (arrived while you were working). Read it and act on it before you finish:\n${item.text}`
        : `NEW MESSAGE FROM THE USER (sent while you were working). Treat it as part of the task and act on it before you finish:\n${item.text}`
    );
  }

  private take(caller: Caller): InputItem[] {
    const items = this.deps.outbox.takeSteerable(caller.sessionId);
    if (!items.length) return [];
    this.deps.router.noteSteered(caller.sessionId, items);
    this.deps.store.append(
      caller.sessionId,
      items.map((item): SessionEvent => ({
        kind: 'user',
        id: `input:${item.id}`,
        at: Date.now(),
        text: item.text,
        inputId: item.id,
        attachments: item.attachments,
        source: item.source === 'agent' ? 'agent' : item.source === 'automation' ? 'automation' : 'app'
      }))
    );
    return items;
  }

  /** One plan per user turn: later updates in the same turn replace it in place. */
  setPlan(caller: Caller, explanation: string | null, items: PlanItem[]): void {
    const events = this.deps.store.events(caller.sessionId);
    const lastUser = [...events].reverse().find((event) => event.kind === 'user');
    this.record(caller.sessionId, { kind: 'plan', id: `plan:${lastUser?.id ?? 'start'}`, at: Date.now(), explanation, items });
  }

  /** session_finish: waits briefly for queued instructions and hands them to the model. */
  async finish(caller: Caller, signal: AbortSignal): Promise<string> {
    const deadline = Date.now() + FINISH_WAIT_MS;
    while (!signal.aborted && Date.now() < deadline) {
      const queued = this.deps.outbox.list(caller.sessionId).filter((item) => item.state === 'queued');
      if (queued.length) {
        for (const item of queued) this.deps.outbox.update(item.id, { delivery: 'now' });
        const texts = this.take(caller).map((item) => item.text);
        if (texts.length) return `Queued instructions from the user — complete and verify them, then call session_finish again:\n\n${texts.map((text, i) => `${i + 1}. ${text}`).join('\n\n')}`;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    return 'No queued instructions. You may end your turn.';
  }

  private record(sessionId: string, event: SessionEvent): void {
    this.deps.store.append(sessionId, [event]);
  }
}
