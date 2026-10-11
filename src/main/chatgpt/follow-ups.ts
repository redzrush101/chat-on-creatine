import type { Config } from '@shared/config';
import type { InputItem, SessionMeta } from '@shared/types';
import type { Outbox } from '../sessions/outbox';
import type { SessionStore } from '../sessions/store';
import type { TurnOutcome } from './router';

const MAX_AUTO_CONTINUES = 3;

/** Messages the app sends on its own once a turn ends: steering the model may have missed, and "Continue.". */
export class TurnFollowUps {
  /** Inputs steered into tool results during the running turn. */
  private readonly steeredThisTurn = new Map<string, InputItem[]>();
  private readonly autoContinues = new Map<string, number>();

  constructor(
    private readonly outbox: Outbox,
    private readonly store: SessionStore,
    private readonly getConfig: () => Config
  ) {}

  noteSteered(sessionId: string, items: InputItem[]): void {
    this.steeredThisTurn.set(sessionId, [...(this.steeredThisTurn.get(sessionId) ?? []), ...items]);
  }

  afterTurn(session: SessionMeta, outcome: TurnOutcome): void {
    this.resendUnseenSteering(session);
    this.maybeAutoContinue(session, outcome);
  }

  /**
   * Models treat tool output as data, not instructions, and ChatGPT's code runner may never print
   * it, so a message steered into a tool result is not reliably acted on. After the turn it is sent
   * again as a real user message, worded so a model that already handled it just confirms.
   */
  private resendUnseenSteering(session: SessionMeta): void {
    const steered = this.steeredThisTurn.get(session.id) ?? [];
    this.steeredThisTurn.delete(session.id);
    // Agent messages are reports and questions, which the model reads fine as data.
    for (const item of steered.filter((input) => input.source !== 'agent')) {
      this.outbox.enqueue({
        sessionId: session.id,
        text: `While you were working I sent this message; if you have not handled it yet, do it now, otherwise just confirm:\n\n${item.text}`,
        attachments: [],
        delivery: 'after-turn',
        source: 'automation'
      });
    }
  }

  private maybeAutoContinue(session: SessionMeta, outcome: TurnOutcome): void {
    if (outcome === 'done' || outcome === 'stopped') {
      this.autoContinues.delete(session.id);
      return;
    }
    if (!this.getConfig().automation.autoContinue) return;
    const count = this.autoContinues.get(session.id) ?? 0;
    if (count >= MAX_AUTO_CONTINUES) {
      this.store.append(session.id, [
        { kind: 'notice', id: `notice:${Date.now()}`, at: Date.now(), level: 'warn', text: 'The answer stopped unfinished again; not continuing automatically.' }
      ]);
      return;
    }
    this.autoContinues.set(session.id, count + 1);
    this.outbox.enqueue({ sessionId: session.id, text: 'Continue.', attachments: [], delivery: 'after-turn', source: 'automation' });
  }
}
