import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig, type Config } from '@shared/config';
import type { SessionEvent, SessionMeta } from '@shared/types';
import { Automation, CONTINUATION_MARKER } from '../src/main/automation/automation';
import { buildDecisionPrompt, parseDecision, transcriptFor } from '../src/main/automation/decider';
import { flushWrites } from '../src/main/core/durable';
import { Outbox } from '../src/main/sessions/outbox';
import { SessionStore } from '../src/main/sessions/store';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'automation-test-'));
});

afterEach(async () => {
  await flushWrites();
  rmSync(dir, { recursive: true, force: true });
});

const NOT_DONE = '{"done": false, "message": "Keep going", "reason": "more to do"}';
const DONE = '```json\n{"done": true, "message": "", "reason": "all requested work is in"}\n```';

function setup(options: { reply?: string; maxSteps?: number; config?: (config: Config) => void } = {}) {
  const store = new SessionStore(join(dir, 'sessions'), { recording: () => true });
  const outbox = new Outbox(join(dir, 'outbox.json'));
  const config = defaultConfig();
  config.automation.maxSteps = options.maxSteps ?? 25;
  config.context.handoffPrompt = 'HANDOFF PROMPT';
  options.config?.(config);
  const setTurn = vi.fn();
  const decide = vi.fn(async (_prompt: string) => options.reply ?? NOT_DONE);
  const automation = new Automation({
    store,
    outbox,
    getConfig: () => config,
    getSecret: () => null,
    setTurn,
    workersBusy: () => false,
    decide
  });
  const chat = store.create({ kind: 'chat', conversationId: 'conv-1' });
  const current = (): SessionMeta => store.get(chat.id)!;
  const finish = (outcome: 'done' | 'stopped' = 'done') => automation.onTurnEnd(current(), outcome);
  const answer = (text: string) =>
    store.append(chat.id, [
      { kind: 'assistant', id: `answer:${text}`, at: Date.now(), messageId: text, text, channel: 'final', model: null, streaming: false }
    ]);
  const queued = () => outbox.list(chat.id).filter((item) => item.state === 'queued');
  return { store, outbox, automation, chat, current, finish, answer, queued, decide, setTurn };
}

async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 20));
}

describe('Goal and Loop', () => {
  it('sends the next instruction and counts the step when not done', async () => {
    const t = setup();
    t.automation.setMode(t.chat.id, 'goal', 'Build the thing');
    t.answer('partial');
    t.finish();
    await vi.waitFor(() => expect(t.queued().map((item) => item.text)).toEqual(['Keep going']));
    expect(t.queued()[0]?.source).toBe('automation');
    expect(t.current().goal).toMatchObject({ steps: 1, status: 'idle', lastDecision: 'more to do' });
  });

  it('stops with status done and sends nothing when the goal is reached', async () => {
    const t = setup({ reply: DONE });
    t.automation.setMode(t.chat.id, 'goal', 'Build the thing');
    t.answer('finished');
    t.finish();
    await vi.waitFor(() => expect(t.current().goal.status).toBe('done'));
    expect(t.queued()).toEqual([]);
    expect(t.current().goal.lastDecision).toBe('all requested work is in');
  });

  it('never stops on done in Loop mode', async () => {
    const t = setup({ reply: '{"done": true, "message": "Deeper pass on the same brief", "reason": "looks finished"}' });
    t.automation.setMode(t.chat.id, 'loop', 'Polish it');
    t.answer('finished');
    t.finish();
    await vi.waitFor(() => expect(t.queued().map((item) => item.text)).toEqual(['Deeper pass on the same brief']));
    expect(t.current().goal.status).toBe('idle');
  });

  it('pauses with status stopped once maxSteps automatic follow-ups were sent', async () => {
    const t = setup({ maxSteps: 1 });
    t.automation.setMode(t.chat.id, 'loop', 'Polish it');
    t.finish();
    await vi.waitFor(() => expect(t.queued()).toHaveLength(1));

    const sent = t.queued()[0]!;
    t.outbox.markSending(sent.id);
    t.outbox.markSent(sent.id);
    t.finish();
    await vi.waitFor(() => expect(t.current().goal.status).toBe('stopped'));
    expect(t.queued()).toEqual([]);
    expect(t.decide).toHaveBeenCalledTimes(1);
    expect(t.store.events(t.chat.id).some((event) => event.kind === 'notice' && event.text.includes('limit 1'))).toBe(true);
  });

  it('pauses on a stopped turn without deciding and drops queued Goal follow-ups', async () => {
    const t = setup();
    t.automation.setMode(t.chat.id, 'goal', 'Build the thing');
    t.outbox.enqueue({ sessionId: t.chat.id, text: 'queued follow-up', attachments: [], delivery: 'after-turn', source: 'automation' });
    t.finish('stopped');
    expect(t.current().goal.status).toBe('stopped');
    expect(t.queued()).toEqual([]);
    await settle();
    expect(t.decide).not.toHaveBeenCalled();
  });

  it('makes no decision while user input is queued', async () => {
    const t = setup();
    t.automation.setMode(t.chat.id, 'goal', 'Build the thing');
    t.outbox.enqueue({ sessionId: t.chat.id, text: 'my question', attachments: [], delivery: 'after-turn', source: 'app' });
    t.finish();
    await settle();
    expect(t.decide).not.toHaveBeenCalled();
  });

  it('discards a decision when the user sent something while it was being made', async () => {
    let release!: (reply: string) => void;
    const t = setup();
    t.decide.mockImplementationOnce(() => new Promise<string>((resolve) => (release = resolve)));
    t.automation.setMode(t.chat.id, 'goal', 'Build the thing');
    t.finish();
    await vi.waitFor(() => expect(t.decide).toHaveBeenCalled());
    t.outbox.enqueue({ sessionId: t.chat.id, text: 'actually, stop', attachments: [], delivery: 'after-turn', source: 'app' });
    release(NOT_DONE);
    await settle();
    expect(t.queued().map((item) => item.text)).toEqual(['actually, stop']);
    expect(t.current().goal.steps).toBe(0);
  });

  it('turns a decider failure into status error without throwing', async () => {
    const t = setup();
    t.decide.mockRejectedValueOnce(new Error('boom'));
    t.automation.setMode(t.chat.id, 'goal', 'Build the thing');
    t.finish();
    await vi.waitFor(() => expect(t.current().goal.status).toBe('error'));
    expect(t.queued()).toEqual([]);
  });
});

describe('Compact & Resume', () => {
  it('sends the handoff prompt, moves to a fresh conversation and queues the continuation first', async () => {
    const t = setup();
    t.automation.compact(t.chat.id);
    expect(t.setTurn).toHaveBeenLastCalledWith(t.chat.id, 'compacting');
    expect(t.queued().map((item) => item.text)).toEqual(['HANDOFF PROMPT']);

    // The router delivers the handoff prompt and then its turn ends with the brief as final answer.
    const [handoff] = t.queued();
    t.outbox.markSending(handoff!.id);
    t.outbox.markSent(handoff!.id);
    t.outbox.enqueue({ sessionId: t.chat.id, text: 'my next question', attachments: [], delivery: 'after-turn', source: 'app' });
    t.answer('THE BRIEF');
    t.finish();

    expect(t.current()).toMatchObject({ conversationId: null, lineage: ['conv-1'], contextTokens: 0 });
    const handoffEvent = t.store.events(t.chat.id).find((event) => event.kind === 'handoff');
    expect(handoffEvent).toMatchObject({ kind: 'handoff', fromConversationId: 'conv-1', toConversationId: null, brief: 'THE BRIEF' });

    const next = t.outbox.nextFor(t.chat.id);
    expect(next?.text).toBe(`${CONTINUATION_MARKER}\n\nTHE BRIEF\n\nContinue the work from here.`);
    expect(t.queued().map((item) => item.text)).toEqual([next?.text, 'my next question']);
    expect(t.setTurn).toHaveBeenLastCalledWith(t.chat.id, 'idle');
  });

  it('refuses to compact a chat without a conversation or while already compacting', () => {
    const t = setup();
    const empty = t.store.create({ kind: 'chat' });
    expect(() => t.automation.compact(empty.id)).toThrow(/no conversation/);
    t.automation.compact(t.chat.id);
    expect(() => t.automation.compact(t.chat.id)).toThrow(/already compacting/);
  });

  it('starts automatically once the context reaches the advisory size', () => {
    const t = setup({ config: (config) => (config.context.advisoryTokens = 10_000) });
    t.store.update(t.chat.id, { contextTokens: 10_000 });
    t.finish();
    expect(t.queued().map((item) => item.text)).toEqual(['HANDOFF PROMPT']);
  });

  it('abandons the compaction when the handoff turn is stopped', async () => {
    const t = setup();
    t.automation.compact(t.chat.id);
    const [handoff] = t.queued();
    t.outbox.markSending(handoff!.id);
    t.outbox.markSent(handoff!.id);
    t.finish('stopped');
    expect(t.current().conversationId).toBe('conv-1');
    expect(t.current().lineage).toEqual([]);
    expect(t.store.events(t.chat.id).some((event) => event.kind === 'handoff')).toBe(false);
  });
});

describe('parseDecision', () => {
  it('reads a bare object, a fenced block and an object followed by prose', () => {
    expect(parseDecision('{"done": false, "message": "Go", "reason": "r"}', 'goal')).toEqual({ done: false, message: 'Go', reason: 'r' });
    expect(parseDecision('```json\n{"done": true, "message": "", "reason": "ok"}\n```', 'goal')).toEqual({ done: true, message: '', reason: 'ok' });
    expect(parseDecision('Sure {not json} {"done": false, "message": "a {b} c", "reason": ""} hope it helps', 'goal')).toEqual({
      done: false,
      message: 'a {b} c',
      reason: ''
    });
  });

  it('forces done to false in Loop mode', () => {
    expect(parseDecision('{"done": true, "message": "Deeper pass", "reason": ""}', 'loop').done).toBe(false);
  });

  it('rejects replies that carry no usable decision', () => {
    expect(() => parseDecision('I think it is finished.', 'goal')).toThrow(/no JSON/);
    expect(() => parseDecision('{"message": "x"}', 'goal')).toThrow(/no JSON decision/);
    expect(() => parseDecision('{"done": false, "message": "  ", "reason": ""}', 'goal')).toThrow(/no instruction/);
  });
});

describe('decider prompt helpers', () => {
  it('keeps the newest transcript entries when the budget runs out', () => {
    const events: SessionEvent[] = [
      { kind: 'user', id: 'u1', at: 1, text: 'old request', inputId: null, attachments: [], source: 'app' },
      { kind: 'assistant', id: 'a1', at: 2, messageId: 'm1', text: 'x'.repeat(50), channel: 'final', model: null, streaming: false },
      { kind: 'assistant', id: 'a2', at: 3, messageId: 'm2', text: 'latest answer', channel: 'final', model: null, streaming: false }
    ];
    const transcript = transcriptFor(events, 40);
    expect(transcript).toContain('latest answer');
    expect(transcript).not.toContain('old request');
  });

  it('puts the objective and the step budget into the prompt', () => {
    const prompt = buildDecisionPrompt({ mode: 'goal', objective: 'Ship it', transcript: 'User: hi', steps: 2, maxSteps: 5 });
    expect(prompt).toContain('Ship it');
    expect(prompt).toContain('2 of 5');
    expect(prompt).toContain('"done": boolean');
  });
});
