import { readFile } from 'node:fs/promises';
import type { Config } from '@shared/config';
import type { ChatMessage, PageEvent, PageFile } from '@shared/page-protocol';
import { conversationUrl, newChatUrl } from '@shared/page-protocol';
import type { InputItem, SessionEvent, SessionLive, SessionMeta } from '@shared/types';
import { createLogger } from '../core/log';
import type { Caller } from '../mcp/tool';
import type { Outbox } from '../sessions/outbox';
import type { Recorder } from '../sessions/recorder';
import type { SessionStore } from '../sessions/store';
import { contextTokens } from '../sessions/tokens';
import type { ChatHost } from './host';

const log = createLogger('router');

/** How long an MCP call may wait for the page to report the message that issued it. */
const ATTRIBUTION_WAIT_MS = 2_500;
/** Index entries older than this cannot attribute new calls. */
const INDEX_TTL_MS = 6 * 60 * 60_000;
/** A page that stopped generating without a stream end is treated as idle after this. */
const GENERATING_SETTLE_MS = 6_000;
const MAX_AUTO_CONTINUES = 3;

export type TurnOutcome = 'done' | 'stopped' | 'error' | 'incomplete';

interface RouterDeps {
  host: ChatHost;
  store: SessionStore;
  recorder: Recorder;
  outbox: Outbox;
  getConfig(): Config;
  /** The context block for the first message of a brand-new chat, or null. */
  openingContext(session: SessionMeta): Promise<string | null>;
  /** Resolves a session's working directory (session cwd or project folder). */
  sessionCwd(session: SessionMeta): string | null;
  /** May this session start a new turn now? (worker slots) */
  canStart(session: SessionMeta): boolean;
  /** Called after every finished turn, before the next queued input is delivered. */
  onTurnEnd(session: SessionMeta, outcome: TurnOutcome): void;
  onLiveChange(): void;
}

interface IndexEntry {
  sessionId: string;
  conversationId: string;
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

/**
 * Binds ChatGPT tabs to local sessions and moves work between them: delivers queued inputs,
 * routes page events to the recorder, tracks live turn state and attributes MCP tool calls to
 * the chat that made them.
 */
export class ChatRouter {
  private readonly tabSession = new Map<string, string>();
  private readonly sessionTab = new Map<string, string>();
  private readonly live = new Map<string, SessionLive>();
  private readonly requestIndex = new Map<string, IndexEntry>();
  private pendingCalls: PendingCall[] = [];
  /** MCP calls attributed before ChatGPT streamed their call message; that message is ours when it comes. */
  private earlyCalls: PendingCall[] = [];
  private readonly messageWaiters = new Set<() => void>();
  private readonly pumping = new Set<string>();
  private readonly settleTimers = new Map<string, NodeJS.Timeout>();
  private readonly autoContinues = new Map<string, number>();
  private readonly incompleteTurns = new Set<string>();
  /** Sessions whose running turn the user stopped; that turn ends as `stopped` whatever the page says. */
  private readonly userStopped = new Set<string>();
  /** Conversation streams that started and have not ended, per session. */
  private readonly openStreams = new Map<string, Set<string>>();
  /** Inputs steered into tool results during the running turn. */
  private readonly steeredThisTurn = new Map<string, InputItem[]>();

  /** The ChatGPT turn (`turn_exchange_id`) each session is in, for end-of-turn reconciliation. */
  private readonly currentTurnIds = new Map<string, string>();
  private gcTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: RouterDeps) {
    deps.host.setListener({
      page: (tabId, event) => this.onPage(tabId, event),
      closed: (tabId) => this.unbindTab(tabId),
      status: () => deps.onLiveChange()
    });
    deps.outbox.onChange(() => this.pumpAll());
  }

  start(): void {
    this.gcTimer = setInterval(() => void this.collectIdleTabs(), 60_000);
    this.gcTimer.unref?.();
    this.pumpAll();
  }

  stop(): void {
    if (this.gcTimer) clearInterval(this.gcTimer);
    for (const timer of this.settleTimers.values()) clearTimeout(timer);
  }

  liveState(): Record<string, SessionLive> {
    return Object.fromEntries(this.live);
  }

  turnOf(sessionId: string): SessionLive['turn'] {
    return this.live.get(sessionId)?.turn ?? 'idle';
  }

  // ------------------------------------------------------------------ public actions

  /** Shows the session's ChatGPT tab (opening it when needed), or the browser window. */
  async show(sessionId: string | null): Promise<void> {
    if (!sessionId) {
      this.deps.host.reveal(null);
      return;
    }
    const session = this.deps.store.get(sessionId);
    if (!session) return;
    const tabId = await this.ensureTab(session, false);
    this.deps.host.reveal(tabId);
  }

  async stopTurn(sessionId: string): Promise<void> {
    const tabId = this.sessionTab.get(sessionId);
    if (!tabId) return;
    if (this.turnOf(sessionId) !== 'idle') this.userStopped.add(sessionId);
    const result = await this.deps.host.command(tabId, { type: 'stop' }, 10_000);
    if (!result.ok) log.warn(`stop failed: ${result.error}`);
  }

  setTurn(sessionId: string, turn: SessionLive['turn']): void {
    this.patchLive(sessionId, { turn });
  }

  /** Delivers queued inputs of every idle session. */
  pumpAll(): void {
    const sessions = new Set(this.deps.outbox.list().filter((item) => item.state === 'queued').map((item) => item.sessionId));
    for (const sessionId of sessions) void this.pump(sessionId);
  }

  /**
   * Opens (or reuses) the tab of a session. A session without a conversation gets a fresh chat
   * with its model preselected; otherwise its conversation is loaded.
   */
  async ensureTab(session: SessionMeta, fresh: boolean): Promise<string> {
    const url = session.conversationId && !fresh ? conversationUrl(session.conversationId) : newChatUrl(session.model);
    const existing = this.sessionTab.get(session.id);
    if (existing && this.deps.host.tabs().some((tab) => tab.tabId === existing)) {
      const info = this.deps.host.tabs().find((tab) => tab.tabId === existing)!;
      const wanted = fresh || !session.conversationId ? null : session.conversationId;
      if (info.conversationId !== wanted) await this.deps.host.navigate(existing, url);
      return existing;
    }
    const tabId = await this.deps.host.openTab(url);
    this.bind(tabId, session.id);
    return tabId;
  }

  // ------------------------------------------------------------------ attribution

  /**
   * Finds the chat behind an MCP tool call. The `x-request-id` join key matches the
   * `request_id` ChatGPT puts on the messages of that request; a call message with the same
   * tool and arguments is the second proof; a single generating chat is the last resort.
   */
  async resolveCaller(requestId: string | null, call: { tool: string; args: unknown }): Promise<Caller | null> {
    const argsKey = canonicalJson(call.args ?? {});
    const deadline = Date.now() + ATTRIBUTION_WAIT_MS;
    for (;;) {
      const entry = this.lookup(requestId, call.tool, argsKey);
      if (entry) return this.claim(entry, call.tool, argsKey);
      if (Date.now() >= deadline) break;
      await this.nextMessage(Math.max(50, deadline - Date.now()));
    }
    const generating = [...this.live.values()].filter((live) => live.turn === 'generating');
    if (generating.length === 1) {
      const sessionId = generating[0]!.sessionId;
      return this.claim({ sessionId, conversationId: '', at: Date.now() }, call.tool, argsKey);
    }
    log.info(`unattributed ${call.tool} call (request ${requestId ?? 'none'}, ${generating.length} chats generating)`);
    return null;
  }

  /** Inputs handed to the model inside a tool result during the current turn. */
  noteSteered(sessionId: string, items: InputItem[]): void {
    this.steeredThisTurn.set(sessionId, [...(this.steeredThisTurn.get(sessionId) ?? []), ...items]);
  }

  /**
   * Models treat tool output as data, not instructions, and ChatGPT's code runner may never print
   * it, so a message steered into a tool result is not reliably acted on. After the turn it is sent
   * again as a real user message, worded so a model that already handled it just confirms.
   */
  private resendUnseenSteering(session: SessionMeta): void {
    const steered = this.steeredThisTurn.get(session.id) ?? [];
    this.steeredThisTurn.delete(session.id);
    for (const item of steered) {
      this.deps.outbox.enqueue({
        sessionId: session.id,
        text: `While you were working I sent this message; if you have not handled it yet, do it now, otherwise just confirm:\n\n${item.text}`,
        attachments: [],
        delivery: 'after-turn',
        source: 'automation'
      });
    }
  }

  noteToolRunning(sessionId: string, delta: 1 | -1): void {
    const live = this.ensureLive(sessionId);
    this.patchLive(sessionId, { runningTools: Math.max(0, live.runningTools + delta), lastActivityAt: Date.now() });
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
    const caller = this.callerFor(entry.sessionId);
    if (!caller) return null;
    const index = this.pendingCalls.findIndex((pending) => pending.sessionId === entry.sessionId && pending.tool === tool && pending.argsKey === argsKey);
    if (index >= 0) {
      const [pending] = this.pendingCalls.splice(index, 1);
      if (pending!.messageId) {
        this.deps.recorder.markOwnCall(entry.sessionId, pending!.messageId);
        return { ...caller, streamCallId: pending!.messageId };
      }
    }
    this.earlyCalls.push({ sessionId: entry.sessionId, conversationId: caller.conversationId, at: Date.now(), tool, argsKey, messageId: null });
    this.earlyCalls = this.earlyCalls.slice(-50);
    return caller;
  }

  private callerFor(sessionId: string): Caller | null {
    const session = this.deps.store.get(sessionId);
    if (!session || !session.conversationId) return null;
    return { sessionId, conversationId: session.conversationId, cwd: this.deps.sessionCwd(session), kind: session.kind };
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

  private indexMessage(sessionId: string, message: ChatMessage): void {
    const now = Date.now();
    if (message.requestId) this.requestIndex.set(message.requestId, { sessionId, conversationId: message.conversationId, at: now });
    if (message.role === 'assistant' && message.recipient === 'api_tool.call_tool' && message.status !== 'in_progress') {
      try {
        const parsed = JSON.parse(message.text) as { path?: string; args?: unknown };
        const tool = parsed.path?.split('/').filter(Boolean).at(-1);
        const argsKey = canonicalJson(parsed.args ?? {});
        const early = this.earlyCalls.findIndex((call) => call.sessionId === sessionId && call.tool === tool && call.argsKey === argsKey);
        if (early >= 0) {
          this.earlyCalls.splice(early, 1);
          this.deps.recorder.markOwnCall(sessionId, message.id);
        } else if (tool && !this.pendingCalls.some((call) => call.messageId === message.id)) {
          this.pendingCalls.push({ sessionId, conversationId: message.conversationId, at: now, tool, argsKey, messageId: message.id });
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

  // ------------------------------------------------------------------ page events

  private onPage(tabId: string, event: PageEvent): void {
    let sessionId = this.tabSession.get(tabId) ?? null;
    const eventConversation =
      event.type === 'message' ? event.message.conversationId : 'conversationId' in event ? event.conversationId : null;

    if (!sessionId && eventConversation) {
      const known = this.deps.store.byConversation(eventConversation);
      if (known && !this.sessionTab.has(known.id)) {
        this.bind(tabId, known.id);
        sessionId = known.id;
      }
    }
    if (!sessionId) return;
    const session = this.deps.store.get(sessionId);
    if (!session) return;

    if (eventConversation && session.conversationId !== eventConversation) {
      if (!session.conversationId || this.turnOf(sessionId) === 'sending' || this.turnOf(sessionId) === 'generating') {
        // The first send of a new chat (or a compaction successor) just got its id.
        this.deps.store.update(sessionId, { conversationId: eventConversation });
      } else if (event.type === 'location') {
        // The user navigated this tab elsewhere; it no longer belongs to the session.
        this.unbindTab(tabId);
        this.onPage(tabId, event);
        return;
      }
    }

    switch (event.type) {
      case 'turn-start':
        this.streamsOf(sessionId).add(event.streamId);
        this.patchLive(sessionId, { turn: 'generating', lastActivityAt: Date.now() });
        break;
      case 'message':
        this.indexMessage(sessionId, event.message);
        if (event.message.turnId) this.currentTurnIds.set(sessionId, event.message.turnId);
        if (event.message.role === 'assistant' && /partial|incomplete/.test(event.message.status)) this.incompleteTurns.add(sessionId);
        this.patchLive(sessionId, { lastActivityAt: Date.now() });
        break;
      case 'turn-end':
        this.streamsOf(sessionId).delete(event.streamId);
        this.deps.recorder.handle(sessionId, event);
        this.finishTurn(sessionId, event.outcome === 'complete' ? 'done' : event.outcome === 'aborted' ? 'stopped' : 'error');
        return;
      case 'generating':
        this.onGenerating(sessionId, event.value);
        break;
      case 'notice':
        this.record(sessionId, [{ kind: 'notice', id: `notice:${Date.now()}`, at: Date.now(), level: event.level, text: event.text }]);
        break;
      default:
        break;
    }
    this.deps.recorder.handle(sessionId, event);
  }

  private onGenerating(sessionId: string, value: boolean): void {
    clearTimeout(this.settleTimers.get(sessionId));
    this.settleTimers.delete(sessionId);
    if (value) {
      if (this.turnOf(sessionId) === 'idle') this.patchLive(sessionId, { turn: 'generating', lastActivityAt: Date.now() });
      return;
    }
    // Resumed/websocket turns end without our stream tap seeing an end; settle on the button state.
    const timer = setTimeout(() => {
      this.settleTimers.delete(sessionId);
      const live = this.live.get(sessionId);
      // An open conversation stream means ChatGPT is still working (e.g. thinking between tools).
      if (live?.turn === 'generating' && live.runningTools === 0 && this.streamsOf(sessionId).size === 0) this.finishTurn(sessionId, 'done');
    }, GENERATING_SETTLE_MS);
    this.settleTimers.set(sessionId, timer);
  }

  private finishTurn(sessionId: string, outcome: TurnOutcome): void {
    const live = this.live.get(sessionId);
    if (live && live.turn === 'idle') return;
    clearTimeout(this.settleTimers.get(sessionId));
    this.settleTimers.delete(sessionId);
    const incomplete = this.incompleteTurns.delete(sessionId);
    const stoppedByUser = this.userStopped.delete(sessionId);
    const finalOutcome: TurnOutcome = stoppedByUser ? 'stopped' : outcome === 'done' && incomplete ? 'incomplete' : outcome;
    this.patchLive(sessionId, { turn: 'idle', lastActivityAt: Date.now() });

    const session = this.deps.store.get(sessionId);
    if (!session) return;
    const tokens = contextTokens(this.deps.store.events(sessionId));
    const updated = this.deps.store.update(sessionId, { contextTokens: tokens }) ?? session;
    void this.reconcile(updated);
    this.resendUnseenSteering(updated);
    this.maybeAutoContinue(updated, finalOutcome);
    this.deps.onTurnEnd(updated, finalOutcome);
    void this.pump(sessionId);
  }

  private maybeAutoContinue(session: SessionMeta, outcome: TurnOutcome): void {
    if (outcome === 'done' || outcome === 'stopped') {
      this.autoContinues.delete(session.id);
      return;
    }
    if (!this.deps.getConfig().automation.autoContinue) return;
    const count = this.autoContinues.get(session.id) ?? 0;
    if (count >= MAX_AUTO_CONTINUES) {
      this.record(session.id, [
        { kind: 'notice', id: `notice:${Date.now()}`, at: Date.now(), level: 'warn', text: 'The answer stopped unfinished again; not continuing automatically.' }
      ]);
      return;
    }
    this.autoContinues.set(session.id, count + 1);
    this.deps.outbox.enqueue({ sessionId: session.id, text: 'Continue.', attachments: [], delivery: 'after-turn', source: 'automation' });
  }

  /**
   * Re-reads the finished turn from ChatGPT's conversation API and upserts its messages. The
   * stream is the live view; this is the authoritative final text if a delta was ever misread.
   */
  private async reconcile(session: SessionMeta): Promise<void> {
    const turnId = this.currentTurnIds.get(session.id);
    const tabId = this.sessionTab.get(session.id);
    if (!turnId || !tabId || !session.conversationId) return;
    const result = await this.deps.host.command(tabId, { type: 'conversation', conversationId: session.conversationId }, 20_000);
    if (!result.ok || !Array.isArray(result.value)) return;
    for (const message of result.value as ChatMessage[]) {
      if (message.turnId === turnId && message.role !== 'user') this.deps.recorder.handle(session.id, { type: 'message', streamId: null, message });
    }
  }

  // ------------------------------------------------------------------ delivery

  private async pump(sessionId: string): Promise<void> {
    if (this.pumping.has(sessionId)) return;
    this.pumping.add(sessionId);
    try {
      for (;;) {
        if (this.turnOf(sessionId) !== 'idle') return;
        const session = this.deps.store.get(sessionId);
        if (!session || session.blocked) return;
        const item = this.deps.outbox.nextFor(sessionId);
        if (!item || !this.deps.canStart(session)) return;
        const delivered = await this.deliver(session, item);
        if (!delivered) return;
        // A delivered input starts a turn; the next one waits for its end.
        return;
      }
    } finally {
      this.pumping.delete(sessionId);
    }
  }

  private async deliver(session: SessionMeta, item: InputItem): Promise<boolean> {
    this.patchLive(session.id, { turn: 'sending', lastActivityAt: Date.now() });
    this.deps.outbox.markSending(item.id);
    try {
      const fresh = !session.conversationId;
      const tabId = await this.ensureTab(session, fresh);
      if (fresh && session.reasoning) {
        const selected = await this.deps.host.command(tabId, { type: 'select-model', model: session.model ?? '', effort: session.reasoning }, 20_000);
        if (!selected.ok) log.info(`could not preselect reasoning ${session.reasoning}: ${selected.error}`);
      }
      const opening = fresh ? await this.deps.openingContext(session) : null;
      const text = opening ? `${opening}\n\n${item.text}` : item.text;
      const files = await Promise.all(item.attachments.map(async (file): Promise<PageFile> => ({
        name: file.name,
        mime: file.mime,
        data: (await readFile(file.path)).toString('base64')
      })));

      const eventId = `input:${item.id}`;
      this.deps.recorder.expectUserEcho(session.id, eventId, item.text);
      const result = await this.deps.host.command(tabId, { type: 'send', text, files }, 60_000);
      if (!result.ok) {
        this.deps.outbox.markFailed(item.id, result.error);
        this.patchLive(session.id, { turn: 'idle' });
        this.record(session.id, [{ kind: 'notice', id: `notice:${item.id}`, at: Date.now(), level: 'error', text: `Could not send: ${result.error}` }]);
        return false;
      }
      this.deps.outbox.markSent(item.id);
      this.record(session.id, [
        { kind: 'user', id: eventId, at: Date.now(), text: item.text, inputId: item.id, attachments: item.attachments, source: item.source === 'app' || item.source === 'control-api' ? 'app' : item.source }
      ]);
      const value = result.value as { conversationId?: string | null } | undefined;
      if (value?.conversationId && !session.conversationId) this.deps.store.update(session.id, { conversationId: value.conversationId });
      if (this.turnOf(session.id) === 'sending') this.patchLive(session.id, { turn: 'generating' });
      return true;
    } catch (error) {
      log.error(`delivery to ${session.id} failed`, error);
      this.deps.outbox.markFailed(item.id, error instanceof Error ? error.message : String(error));
      this.patchLive(session.id, { turn: 'idle' });
      return false;
    }
  }

  // ------------------------------------------------------------------ tabs

  private bind(tabId: string, sessionId: string): void {
    const previous = this.sessionTab.get(sessionId);
    if (previous && previous !== tabId) this.tabSession.delete(previous);
    this.tabSession.set(tabId, sessionId);
    this.sessionTab.set(sessionId, tabId);
    this.patchLive(sessionId, { tabOpen: true });
  }

  private unbindTab(tabId: string): void {
    const sessionId = this.tabSession.get(tabId);
    this.tabSession.delete(tabId);
    if (sessionId && this.sessionTab.get(sessionId) === tabId) {
      this.sessionTab.delete(sessionId);
      this.openStreams.delete(sessionId);
      const live = this.live.get(sessionId);
      // A tab that disappears mid-turn cannot finish it.
      this.patchLive(sessionId, { tabOpen: false, turn: live?.turn === 'compacting' ? 'compacting' : 'idle', runningTools: 0 });
    }
  }

  /** Closes idle app-owned tabs; history stays and the tab reopens on the next send. */
  private async collectIdleTabs(): Promise<void> {
    const limit = this.deps.getConfig().browser.idleTabMinutes * 60_000;
    const now = Date.now();
    const pending = new Set(this.deps.outbox.list().filter((item) => item.state === 'queued').map((item) => item.sessionId));
    const visible = this.deps.host.status().windowVisible;
    for (const tab of this.deps.host.tabs()) {
      const sessionId = this.tabSession.get(tab.tabId);
      const live = sessionId ? this.live.get(sessionId) : undefined;
      if (tab.generating || (live && (live.turn !== 'idle' || live.runningTools > 0))) continue;
      if (sessionId && pending.has(sessionId)) continue;
      const lastActive = live?.lastActivityAt ?? tab.createdAt;
      if (now - lastActive < limit) continue;
      if (visible && this.deps.host.tabs().length === 1) continue;
      await this.deps.host.closeTab(tab.tabId);
    }
  }

  // ------------------------------------------------------------------ helpers

  private record(sessionId: string, events: SessionEvent[]): void {
    this.deps.store.append(sessionId, events);
  }

  private streamsOf(sessionId: string): Set<string> {
    let streams = this.openStreams.get(sessionId);
    if (!streams) this.openStreams.set(sessionId, (streams = new Set()));
    return streams;
  }

  private ensureLive(sessionId: string): SessionLive {
    let live = this.live.get(sessionId);
    if (!live) {
      live = { sessionId, turn: 'idle', tabOpen: this.sessionTab.has(sessionId), runningTools: 0, lastActivityAt: null };
      this.live.set(sessionId, live);
    }
    return live;
  }

  private patchLive(sessionId: string, patch: Partial<SessionLive>): void {
    const live = this.ensureLive(sessionId);
    this.live.set(sessionId, { ...live, ...patch });
    this.deps.onLiveChange();
  }
}
