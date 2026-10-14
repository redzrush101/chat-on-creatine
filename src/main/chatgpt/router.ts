import { errorMessage } from '@shared/errors';
import { readFile } from 'node:fs/promises';
import type { Config } from '@shared/config';
import type { ChatMessage, ModelsValue, PageEvent, PageFile } from '@shared/page-protocol';
import { conversationUrl, isFinalAnswer, newChatUrl } from '@shared/page-protocol';
import type { InputItem, SessionEvent, SessionLive, SessionMeta } from '@shared/types';
import { createLogger } from '../core/log';
import type { Caller } from '../mcp/tool';
import type { Outbox } from '../sessions/outbox';
import type { Recorder } from '../sessions/recorder';
import type { SessionStore } from '../sessions/store';
import { contextTokens } from '../sessions/tokens';
import type { ChatHost } from './host';
import { CallerAttribution } from './attribution';
import { TurnFollowUps } from './follow-ups';

const log = createLogger('router');

/** A page that stopped generating without a stream end is treated as idle after this. */
const GENERATING_SETTLE_MS = 6_000;

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
  onAuth(signedIn: boolean): void;
  models(): Promise<ModelsValue>;
  onLiveChange(): void;
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
  private readonly attribution: CallerAttribution;
  private readonly followUps: TurnFollowUps;
  private readonly pumping = new Set<string>();
  private readonly settleTimers = new Map<string, NodeJS.Timeout>();
  private readonly incompleteTurns = new Set<string>();
  /** Sessions whose running turn the user stopped; that turn ends as `stopped` whatever the page says. */
  private readonly userStopped = new Set<string>();
  /** Conversation streams that started and have not ended, per session. */
  private readonly openStreams = new Map<string, Set<string>>();
  /** Streams whose turn already ended at the final answer; their late stream end is ignored. */
  private readonly answeredStreams = new Set<string>();

  /**
   * A new-chat tab loaded ahead of time, so a new chat or worker does not
   * wait the seconds chatgpt.com takes to load before its first message.
   */
  private spareTab: string | null = null;
  private warming: Promise<void> | null = null;
  private stopped = false;

  /** The ChatGPT turn (`turn_exchange_id`) each session is in, for end-of-turn reconciliation. */
  private readonly currentTurnIds = new Map<string, string>();
  private gcTimer: NodeJS.Timeout | null = null;

  constructor(private readonly deps: RouterDeps) {
    this.followUps = new TurnFollowUps(deps.outbox, deps.store, deps.getConfig);
    this.attribution = new CallerAttribution({
      callerFor: (id) => this.callerFor(id),
      generatingSessions: () => [...this.live.values()].filter((live) => live.turn === 'generating').map((live) => live.sessionId),
      markOwnCall: (id, messageId) => deps.recorder.markOwnCall(id, messageId)
    });
    deps.host.setListener({
      page: (tabId, event) => this.onPage(tabId, event),
      closed: (tabId) => this.unbindTab(tabId),
      status: () => {
        void this.warmSpare();
        deps.onLiveChange();
      }
    });
    deps.outbox.onChange(() => this.pumpAll());
  }

  start(): void {
    this.stopped = false;
    this.gcTimer = setInterval(() => void this.collectIdleTabs(), 60_000);
    this.gcTimer.unref?.();
    this.pumpAll();
    void this.warmSpare();
  }

  stop(): void {
    this.stopped = true;
    if (this.gcTimer) clearInterval(this.gcTimer);
    for (const timer of this.settleTimers.values()) clearTimeout(timer);
  }

  liveState(): Record<string, SessionLive> {
    return Object.fromEntries(this.live);
  }

  turnOf(sessionId: string): SessionLive['turn'] {
    return this.live.get(sessionId)?.turn ?? 'idle';
  }

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
    if (!result.ok) {
      // The turn goes on, so it must not end as stopped when it finishes.
      this.userStopped.delete(sessionId);
      log.warn(`stop failed: ${result.error}`);
    }
  }

  /** Stops a generating turn so the session's queued input is delivered as soon as it ends. */
  interrupt(sessionId: string): void {
    if (this.turnOf(sessionId) === 'generating') void this.stopTurn(sessionId);
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
    if (fresh || !session.conversationId) {
      await this.warming;
      const spare = this.takeSpare();
      if (spare) {
        this.bind(spare, session.id);
        void this.warmSpare();
        return spare;
      }
    }
    const tabId = await this.deps.host.openTab(url);
    this.bind(tabId, session.id);
    void this.warmSpare();
    return tabId;
  }

  private takeSpare(): string | null {
    const spare = this.spareTab;
    this.spareTab = null;
    return spare && this.deps.host.tabs().some((tab) => tab.tabId === spare && !tab.conversationId) ? spare : null;
  }

  private warmSpare(): Promise<void> {
    if (this.spareTab || this.stopped || this.deps.host.status().signedIn !== true) return Promise.resolve();
    return this.warming ??= this.preloadSpare().finally(() => { this.warming = null; });
  }

  private async preloadSpare(): Promise<void> {
    const { host } = this.deps;
    let tab: string | null = null;
    try {
      tab = await host.openTab(newChatUrl(null));
      const ready = await host.command(tab, { type: 'ready' }, 20_000);
      if (!ready.ok) throw new Error(ready.error);
      if (this.stopped) await host.closeTab(tab);
      else this.spareTab = tab;
    } catch (error) {
      if (tab) await host.closeTab(tab);
      log.warn(`could not preload a ChatGPT tab: ${errorMessage(error)}`);
    }
  }

  resolveCaller(requestId: string | null, call: { tool: string; args: unknown }): Promise<Caller | null> {
    return this.attribution.resolve(requestId, call);
  }

  /** Inputs handed to the model inside a tool result during the current turn. */
  noteSteered(sessionId: string, items: InputItem[]): void {
    this.followUps.noteSteered(sessionId, items);
  }

  noteToolRunning(sessionId: string, delta: 1 | -1): void {
    const live = this.ensureLive(sessionId);
    this.patchLive(sessionId, { runningTools: Math.max(0, live.runningTools + delta), lastActivityAt: Date.now() });
  }

  private callerFor(sessionId: string): Caller | null {
    const session = this.deps.store.get(sessionId);
    if (!session || !session.conversationId) return null;
    return { sessionId, conversationId: session.conversationId, cwd: this.deps.sessionCwd(session), kind: session.kind };
  }

  private onPage(tabId: string, event: PageEvent): void {
    if ((event.type === 'auth' || event.type === 'hello') && event.signedIn !== null) {
      this.deps.onAuth(event.signedIn);
    }
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
        this.attribution.noteMessage(sessionId, event.message);
        if (event.message.turnId) this.currentTurnIds.set(sessionId, event.message.turnId);
        if (event.message.role === 'assistant' && /partial|incomplete/.test(event.message.status)) this.incompleteTurns.add(sessionId);
        this.patchLive(sessionId, { lastActivityAt: Date.now() });
        this.deps.recorder.handle(sessionId, event);
        if (event.streamId && isFinalAnswer(event.message) && this.streamsOf(sessionId).has(event.streamId)) {
          this.answerEndsTurn(sessionId, event.streamId, event.message.conversationId);
        }
        return;
      case 'turn-end':
        if (this.answeredStreams.delete(event.streamId)) return;
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

  /**
   * ChatGPT keeps the stream open for seconds after the final answer (titles, metadata). The turn is
   * over once the answer is, so queued messages, worker reports and Goal steps need not wait.
   */
  private answerEndsTurn(sessionId: string, streamId: string, conversationId: string | null): void {
    this.streamsOf(sessionId).delete(streamId);
    this.answeredStreams.add(streamId);
    this.deps.recorder.handle(sessionId, { type: 'turn-end', streamId, conversationId, outcome: 'complete', error: null });
    this.finishTurn(sessionId, 'done');
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
    void this.reconcile(session);
    this.followUps.afterTurn(session, finalOutcome);
    this.deps.onTurnEnd(session, finalOutcome);
    void this.pump(sessionId);
  }

  /**
   * Re-reads the conversation from ChatGPT's API: it upserts the finished turn's messages (the
   * stream is the live view; this is the authoritative final text if a delta was ever misread) and
   * recounts the context from ChatGPT's transcript, or from the local record when it cannot be read.
   */
  private async reconcile(session: SessionMeta): Promise<void> {
    const turnId = this.currentTurnIds.get(session.id);
    const tabId = this.sessionTab.get(session.id);
    const result = tabId && session.conversationId
      ? await this.deps.host.command(tabId, { type: 'conversation', conversationId: session.conversationId }, 20_000)
      : null;
    const transcript = result?.ok && Array.isArray(result.value) ? (result.value as ChatMessage[]) : null;
    for (const message of transcript ?? []) {
      if (turnId && message.turnId === turnId && message.role !== 'user') this.deps.recorder.handle(session.id, { type: 'message', streamId: null, message });
    }
    this.deps.store.update(session.id, { contextTokens: contextTokens(this.deps.store.events(session.id), transcript) });
  }

  private async pump(sessionId: string): Promise<void> {
    if (this.pumping.has(sessionId)) return;
    this.pumping.add(sessionId);
    try {
      if (this.turnOf(sessionId) !== 'idle') return;
      const session = this.deps.store.get(sessionId);
      if (!session || session.blocked) return;
      const item = this.deps.outbox.nextFor(sessionId);
      if (item && this.deps.canStart(session)) await this.deliver(session, item);
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
      const catalog = await this.deps.models();
      const selected = await this.deps.host.command(tabId, { type: 'select-model', model: session.model ?? '', effort: session.reasoning, catalog }, 20_000);
      if (!selected.ok) throw new Error(selected.error);
      const opening = fresh ? await this.deps.openingContext(session) : null;
      const text = opening ? `${opening}\n\n${item.text}` : item.text;
      const files = await Promise.all(item.attachments.map(async (file): Promise<PageFile> => ({
        name: file.name,
        mime: file.mime,
        data: (await readFile(file.path)).toString('base64')
      })));

      const eventId = `input:${item.id}`;
      this.deps.recorder.expectUserEcho(session.id, eventId, item.text);
      // The page may first wait up to a minute for the previous turn's stream to close.
      const result = await this.deps.host.command(tabId, { type: 'send', text, files }, 120_000);
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
      this.deps.outbox.markFailed(item.id, errorMessage(error));
      this.patchLive(session.id, { turn: 'idle' });
      return false;
    }
  }

  private bind(tabId: string, sessionId: string): void {
    const previous = this.sessionTab.get(sessionId);
    if (previous && previous !== tabId) this.tabSession.delete(previous);
    this.tabSession.set(tabId, sessionId);
    this.sessionTab.set(sessionId, tabId);
    this.patchLive(sessionId, { tabOpen: true });
  }

  private unbindTab(tabId: string): void {
    if (this.spareTab === tabId) this.spareTab = null;
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
      if (tab.tabId === this.spareTab) continue;
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
