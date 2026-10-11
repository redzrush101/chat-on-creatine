import { randomUUID } from 'node:crypto';
import type { Config } from '@shared/config';
import type { AutomationMode, GoalState, InputItem, SessionEvent, SessionMeta } from '@shared/types';
import type { TurnOutcome } from '../chatgpt/router';
import type { Outbox } from '../sessions/outbox';
import type { SessionStore } from '../sessions/store';
import { buildDecisionPrompt, callApiDecider, parseDecision, transcriptFor, type Decision } from './decider';

/** The fixed first line of the message that opens the fresh chat after Compact & Resume. */
export const CONTINUATION_MARKER = 'This chat continues earlier work that was moved here because the previous chat got too long.';

const HELPER_TIMEOUT_MS = 10 * 60_000;

export interface AutomationDeps {
  store: SessionStore;
  outbox: Outbox;
  getConfig(): Config;
  getSecret(key: 'automationApiKey'): string | null;
  setTurn(sessionId: string, turn: 'idle' | 'compacting'): void;
  workersBusy(sessionId: string): boolean;
  /** Test seam: answers every decision prompt, bypassing the configured backend. */
  decide?(prompt: string): Promise<string>;
}

interface Compaction {
  itemId: string;
  /** The handoff prompt has been delivered; the next finished turn is its reply. */
  sent: boolean;
}

interface HelperWaiter {
  resolve(text: string): void;
  reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Goal/Loop continuations and Compact & Resume. Driven by the router's turn-end callback: every
 * finished turn of every session passes through `onTurnEnd`.
 */
export class Automation {
  private readonly compactions = new Map<string, Compaction>();
  private readonly helperWaiters = new Map<string, HelperWaiter>();
  private readonly deciding = new Set<string>();
  /** Bumped whenever a chat's Goal/Loop setting changes, so an in-flight decision can tell it is stale. */
  private readonly epochs = new Map<string, number>();

  constructor(private readonly deps: AutomationDeps) {
    deps.outbox.onChange(() => this.reconcileCompactions());
  }

  setMode(sessionId: string, mode: AutomationMode, objective?: string): void {
    const meta = this.deps.store.get(sessionId);
    if (!meta) return;
    if (meta.kind !== 'chat') throw new Error('Only a chat can run Goal or Loop.');
    this.epochs.set(sessionId, this.epoch(sessionId) + 1);
    if (mode === 'off') this.cancelGoalInputs(sessionId);
    this.setGoal(sessionId, {
      mode,
      objective: objective ?? meta.goal.objective,
      steps: 0,
      status: 'idle',
      lastDecision: null
    });
  }

  /** Entry point after every finished turn of any session. Never throws. */
  onTurnEnd(session: SessionMeta, outcome: TurnOutcome): void {
    if (this.resolveHelperWait(session.id, outcome)) return;
    const meta = this.deps.store.get(session.id) ?? session;
    if (meta.kind !== 'chat') return;

    const compaction = this.compactions.get(meta.id);
    if (compaction) {
      if (compaction.sent) this.finishCompaction(meta, outcome);
      return;
    }

    if (outcome === 'stopped') {
      this.pauseGoal(meta);
      return;
    }
    if (outcome === 'error') return;
    if (this.hasQueued(meta.id)) return;

    if (this.shouldAutoCompact(meta)) {
      this.startCompaction(meta.id);
      return;
    }
    if (meta.goal.mode !== 'off' && meta.goal.status !== 'done') this.runGoal(meta.id);
  }

  /** Manual Compact & Resume. Throws when the chat cannot be compacted now. */
  compact(sessionId: string): void {
    const meta = this.deps.store.get(sessionId);
    if (!meta || meta.kind !== 'chat') throw new Error('Only a chat can be compacted.');
    if (!meta.conversationId) throw new Error('Nothing to compact yet: the chat has no conversation.');
    if (this.compactions.has(sessionId)) throw new Error('The chat is already compacting.');
    this.startCompaction(sessionId);
  }

  // ------------------------------------------------------------------ Goal / Loop

  private runGoal(sessionId: string): void {
    if (this.deciding.has(sessionId)) return;
    this.deciding.add(sessionId);
    void this.decideNext(sessionId).finally(() => this.deciding.delete(sessionId));
  }

  private async decideNext(sessionId: string): Promise<void> {
    const meta = this.deps.store.get(sessionId);
    if (!meta) return;
    const config = this.deps.getConfig();
    const { mode, objective, steps } = meta.goal;
    const maxSteps = config.automation.maxSteps;

    if (steps >= maxSteps) {
      this.setGoal(sessionId, { status: 'stopped' });
      this.notify(sessionId, 'warn', `Paused after ${steps} automatic steps (limit ${maxSteps}).`);
      return;
    }
    if (config.agents.waitForWorkers && this.deps.workersBusy(sessionId)) {
      this.setGoal(sessionId, { status: 'waiting-workers' });
      return;
    }

    const epoch = this.epoch(sessionId);
    const anchor = lastUserEventId(this.deps.store.events(sessionId));
    const prompt = buildDecisionPrompt({
      mode,
      objective,
      transcript: transcriptFor(this.deps.store.events(sessionId)),
      steps,
      maxSteps
    });

    this.setGoal(sessionId, { status: 'deciding' });
    let decision: Decision;
    try {
      decision = parseDecision(await this.ask(meta, prompt), mode);
    } catch (error) {
      if (this.epoch(sessionId) !== epoch) return;
      const message = error instanceof Error ? error.message : String(error);
      this.setGoal(sessionId, { status: 'error' });
      this.notify(sessionId, 'error', `Goal decision failed: ${message}`);
      return;
    }

    // The conversation moved on (user input, a new turn, a changed goal) while deciding: this
    // decision describes a state that no longer exists. The next finished turn decides again.
    const stale =
      this.epoch(sessionId) !== epoch ||
      this.hasQueued(sessionId) ||
      lastUserEventId(this.deps.store.events(sessionId)) !== anchor;
    if (stale) {
      if (this.epoch(sessionId) === epoch) this.setGoal(sessionId, { status: 'idle' });
      return;
    }

    if (decision.done && mode === 'goal') {
      this.setGoal(sessionId, { status: 'done', lastDecision: decision.reason });
      this.notify(sessionId, 'info', decision.reason ? `Goal reached: ${decision.reason}` : 'Goal reached.');
      return;
    }

    const next = steps + 1;
    this.setGoal(sessionId, { steps: next, status: 'idle', lastDecision: decision.reason });
    this.deps.outbox.enqueue({ sessionId, text: decision.message, attachments: [], delivery: 'after-turn', source: 'automation' });
    this.notify(sessionId, 'info', `Step ${next} of ${maxSteps}${decision.reason ? `: ${decision.reason}` : ''}`);
  }

  private async ask(meta: SessionMeta, prompt: string): Promise<string> {
    if (this.deps.decide) return this.deps.decide(prompt);
    const { automation } = this.deps.getConfig();
    if (automation.backend === 'api') {
      const apiKey = this.deps.getSecret('automationApiKey');
      if (!apiKey) throw new Error('No API key is set for the decider.');
      return callApiDecider({ baseUrl: automation.apiBaseUrl, model: automation.apiModel, apiKey, prompt });
    }
    return this.askHelper(meta, prompt);
  }

  /** Sends the prompt into the chat's one helper session and waits for that turn to finish. */
  private askHelper(meta: SessionMeta, prompt: string): Promise<string> {
    const helper = this.helperFor(meta);
    const answer = new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.helperWaiters.delete(helper.id);
        reject(new Error('The decider chat did not answer within 10 minutes.'));
      }, HELPER_TIMEOUT_MS);
      this.helperWaiters.set(helper.id, { resolve, reject, timer });
    });
    this.deps.outbox.enqueue({ sessionId: helper.id, text: prompt, attachments: [], delivery: 'after-turn', source: 'automation' });
    return answer;
  }

  private helperFor(meta: SessionMeta): SessionMeta {
    const { helperModel } = this.deps.getConfig().automation;
    const existing = this.deps.store.list().find((session) => session.kind === 'helper' && session.parentId === meta.id);
    if (existing) {
      return existing.model === helperModel ? existing : (this.deps.store.update(existing.id, { model: helperModel }) ?? existing);
    }
    return this.deps.store.create({
      kind: 'helper',
      parentId: meta.id,
      projectId: meta.projectId,
      title: `Goal decider: ${meta.title}`,
      model: helperModel
    });
  }

  private resolveHelperWait(sessionId: string, outcome: TurnOutcome): boolean {
    const waiter = this.helperWaiters.get(sessionId);
    if (!waiter) return false;
    this.helperWaiters.delete(sessionId);
    clearTimeout(waiter.timer);
    if (outcome === 'stopped' || outcome === 'error') {
      waiter.reject(new Error(`The decider chat ${outcome === 'stopped' ? 'was stopped' : 'failed'}.`));
      return true;
    }
    const text = lastFinalText(this.deps.store.events(sessionId));
    if (text) waiter.resolve(text);
    else waiter.reject(new Error('The decider chat gave no answer.'));
    return true;
  }

  private pauseGoal(meta: SessionMeta): void {
    if (meta.goal.mode === 'off' || meta.goal.status === 'done') return;
    this.cancelGoalInputs(meta.id);
    this.setGoal(meta.id, { status: 'stopped' });
    this.notify(meta.id, 'info', 'Paused: the turn was stopped.');
  }

  /** Drops queued Goal/Loop follow-ups; a pending handoff is not a Goal input and stays. */
  private cancelGoalInputs(sessionId: string): void {
    for (const item of this.deps.outbox.list(sessionId)) {
      if (item.state === 'queued' && item.source === 'automation' && !this.isHandoff(item)) this.deps.outbox.cancel(item.id);
    }
  }

  private isHandoff(item: InputItem): boolean {
    return [...this.compactions.values()].some((compaction) => compaction.itemId === item.id);
  }

  private setGoal(sessionId: string, patch: Partial<GoalState>): void {
    const meta = this.deps.store.get(sessionId);
    if (!meta) return;
    this.deps.store.update(sessionId, { goal: { ...meta.goal, ...patch } });
  }

  // ------------------------------------------------------------------ Compact & Resume

  private shouldAutoCompact(meta: SessionMeta): boolean {
    const { context } = this.deps.getConfig();
    return (
      context.autoCompact &&
      meta.conversationId !== null &&
      meta.contextTokens >= context.advisoryTokens &&
      !this.compactions.has(meta.id)
    );
  }

  /**
   * Marks the chat compacting and queues the handoff prompt. The router delivers queued inputs only
   * while a chat is idle, so the prompt goes out at the next idle point; `reconcileCompactions`
   * notices the moment it is sent.
   */
  private startCompaction(sessionId: string): void {
    const meta = this.deps.store.get(sessionId);
    if (!meta?.conversationId) return;
    const itemId = randomUUID();
    this.compactions.set(sessionId, { itemId, sent: false });
    this.deps.outbox.enqueue({
      id: itemId,
      sessionId,
      text: this.deps.getConfig().context.handoffPrompt,
      attachments: [],
      delivery: 'after-turn',
      source: 'automation'
    });
    this.deps.setTurn(sessionId, 'compacting');
  }

  private reconcileCompactions(): void {
    for (const [sessionId, compaction] of this.compactions) {
      const item = this.deps.outbox.get(compaction.itemId);
      if (!item) continue;
      if (item.state === 'sent') {
        compaction.sent = true;
      } else if (item.state === 'failed' || item.state === 'cancelled') {
        this.compactions.delete(sessionId);
        this.deps.setTurn(sessionId, 'idle');
        this.notify(sessionId, 'warn', 'Compact & Resume cancelled: the handoff prompt was not sent.');
      }
    }
  }

  /** The handoff turn ended: its final answer becomes the brief for a fresh conversation. */
  private finishCompaction(meta: SessionMeta, outcome: TurnOutcome): void {
    this.compactions.delete(meta.id);
    if (outcome === 'stopped' || outcome === 'error') {
      this.notify(meta.id, 'warn', 'Compact & Resume cancelled: the handoff turn did not finish.');
      return;
    }
    const brief = lastFinalText(this.deps.store.events(meta.id));
    const fromConversationId = meta.conversationId;
    if (!brief || !fromConversationId) {
      this.notify(meta.id, 'error', 'Compact & Resume failed: the chat did not write a brief.');
      return;
    }

    // Hold the queue while the continuation goes in front of the user inputs that are waiting.
    this.deps.setTurn(meta.id, 'compacting');
    const queued = this.deps.outbox.list(meta.id).filter((item) => item.state === 'queued');
    for (const item of queued) this.deps.outbox.cancel(item.id);

    this.deps.store.append(meta.id, [
      { kind: 'handoff', id: `handoff:${randomUUID()}`, at: Date.now(), fromConversationId, toConversationId: null, brief }
    ]);
    this.deps.store.update(meta.id, {
      conversationId: null,
      lineage: [...meta.lineage, fromConversationId],
      contextTokens: 0
    });
    this.deps.outbox.enqueue({
      sessionId: meta.id,
      text: `${CONTINUATION_MARKER}\n\n${brief}\n\nContinue the work from here.`,
      attachments: [],
      delivery: 'after-turn',
      source: 'automation'
    });
    for (const item of queued) {
      this.deps.outbox.enqueue({
        sessionId: meta.id,
        text: item.text,
        attachments: item.attachments,
        delivery: item.delivery,
        source: item.source
      });
    }
    this.deps.setTurn(meta.id, 'idle');
    this.notify(meta.id, 'info', 'Compacted: continuing in a fresh chat.');
  }

  // ------------------------------------------------------------------ helpers

  private hasQueued(sessionId: string): boolean {
    return this.deps.outbox.list(sessionId).some((item) => item.state === 'queued');
  }

  private epoch(sessionId: string): number {
    return this.epochs.get(sessionId) ?? 0;
  }

  private notify(sessionId: string, level: 'info' | 'warn' | 'error', text: string): void {
    this.deps.store.append(sessionId, [{ kind: 'notice', id: `notice:${randomUUID()}`, at: Date.now(), level, text }]);
  }
}

function lastFinalText(events: SessionEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.kind === 'assistant' && event.channel === 'final' && event.text.trim()) return event.text.trim();
  }
  return '';
}

function lastUserEventId(events: SessionEvent[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i];
    if (event?.kind === 'user') return event.id;
  }
  return null;
}
