import type { ChatMessage } from '@shared/page-protocol';
import type { Caller } from '../mcp/tool';
import { createLogger } from '../core/log';

const log = createLogger('router');

/** How long an MCP call may wait for the page to report the message that issued it. */
const ATTRIBUTION_WAIT_MS = 2_500;
/** Index entries older than this cannot attribute new calls. */
const INDEX_TTL_MS = 6 * 60 * 60_000;
interface IndexEntry {
  sessionId: string;
  at: number;
}

interface PendingCall extends IndexEntry {
  tool: string;
  argsKey: string;
  /** The streamed call message, or null for an MCP call that arrived before its message. */
  messageId: string | null;
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value as object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

interface AttributionDeps {
  callerFor(sessionId: string): Caller | null;
  generatingSessions(): string[];
  markOwnCall(sessionId: string, messageId: string): void;
}

export class CallerAttribution {
  private readonly requestIndex = new Map<string, IndexEntry>();
  private pendingCalls: PendingCall[] = [];
  /** MCP calls attributed before ChatGPT streamed their call message; that message is ours when it comes. */
  private earlyCalls: PendingCall[] = [];
  private readonly messageWaiters = new Set<() => void>();

  constructor(private readonly deps: AttributionDeps) {}

  /**
   * Finds the chat behind an MCP tool call. The `x-request-id` join key matches the
   * `request_id` ChatGPT puts on the messages of that request; a call message with the same
   * tool and arguments is the second proof; a single generating chat is the last resort.
   */
  async resolve(requestId: string | null, call: { tool: string; args: unknown }): Promise<Caller | null> {
    const argsKey = canonicalJson(call.args ?? {});
    const deadline = Date.now() + ATTRIBUTION_WAIT_MS;
    for (;;) {
      const entry = this.lookup(requestId, call.tool, argsKey);
      if (entry) return this.claim(entry, call.tool, argsKey);
      if (Date.now() >= deadline) break;
      await this.nextMessage(Math.max(50, deadline - Date.now()));
    }
    const generating = this.deps.generatingSessions();
    if (generating.length === 1) {
      const sessionId = generating[0]!;
      return this.claim({ sessionId, at: Date.now() }, call.tool, argsKey);
    }
    log.info(`unattributed ${call.tool} call (request ${requestId ?? 'none'}, ${generating.length} chats generating)`);
    return null;
  }

  private lookup(requestId: string | null, tool: string, argsKey: string): IndexEntry | null {
    const now = Date.now();
    if (requestId) {
      const hit = this.requestIndex.get(requestId);
      if (hit && now - hit.at < INDEX_TTL_MS) return hit;
    }
    return this.pendingCalls.find((pending) => pending.tool === tool && pending.argsKey === argsKey) ?? null;
  }

  /**
   * Builds the caller and ties the call to ChatGPT's streamed call message, so the timeline shows
   * one event: the server's, under the message's id. A call that beats its message is remembered
   * and its message is marked as ours on arrival.
   */
  private claim(entry: IndexEntry, tool: string, argsKey: string): Caller | null {
    const caller = this.deps.callerFor(entry.sessionId);
    if (!caller) return null;
    const index = this.pendingCalls.findIndex((pending) => pending.sessionId === entry.sessionId && pending.tool === tool && pending.argsKey === argsKey);
    if (index >= 0) {
      const [pending] = this.pendingCalls.splice(index, 1);
      if (pending!.messageId) {
        this.deps.markOwnCall(entry.sessionId, pending!.messageId);
        return { ...caller, streamCallId: pending!.messageId };
      }
    }
    this.earlyCalls.push({ sessionId: entry.sessionId, at: Date.now(), tool, argsKey, messageId: null });
    this.earlyCalls = this.earlyCalls.slice(-50);
    return caller;
  }

  private nextMessage(timeoutMs: number): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.messageWaiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.messageWaiters.add(done);
    });
  }

  noteMessage(sessionId: string, message: ChatMessage): void {
    const now = Date.now();
    if (message.requestId) this.requestIndex.set(message.requestId, { sessionId, at: now });
    if (message.role === 'assistant' && message.recipient === 'api_tool.call_tool' && message.status !== 'in_progress') {
      try {
        const parsed = JSON.parse(message.text) as { path?: string; args?: unknown };
        const tool = parsed.path?.split('/').filter(Boolean).at(-1);
        const argsKey = canonicalJson(parsed.args ?? {});
        const early = this.earlyCalls.findIndex((call) => call.sessionId === sessionId && call.tool === tool && call.argsKey === argsKey);
        if (early >= 0) {
          this.earlyCalls.splice(early, 1);
          this.deps.markOwnCall(sessionId, message.id);
        } else if (tool && !this.pendingCalls.some((call) => call.messageId === message.id)) {
          this.pendingCalls.push({ sessionId, at: now, tool, argsKey, messageId: message.id });
        }
      } catch {
        // Partial or non-JSON call text; the request id still attributes it.
      }
    }
    this.pendingCalls = this.pendingCalls.filter((call) => now - call.at < 5 * 60_000).slice(-200);
    if (this.requestIndex.size > 5_000) {
      for (const [key, entry] of this.requestIndex) if (now - entry.at > INDEX_TTL_MS) this.requestIndex.delete(key);
    }
    for (const waiter of [...this.messageWaiters]) waiter();
  }
}
