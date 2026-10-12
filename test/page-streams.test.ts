import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PageEvent } from '@shared/page-protocol';
import { PageCommands } from '../src/page/commands';
import { StreamRelay, type TapMessage } from '../src/page/streams';

afterEach(() => vi.useRealTimers());

function setup() {
  const events: PageEvent[] = [];
  const relay = new StreamRelay((event) => events.push(event), () => null);
  const tap = (message: Omit<TapMessage, 'channel' | 'streamId'>) => relay.handle({ channel: 'test', streamId: 's1', ...message });
  const message = (text: string) => tap({ kind: 'chunk', chunk: `data: ${JSON.stringify({ v: { conversation_id: 'c1', message: {
    id: 'm1', author: { role: 'assistant' }, content: { content_type: 'text', parts: [text] }, status: 'in_progress'
  } } })}\n\n` });
  return { relay, events, tap, message };
}

describe('page stream relay', () => {
  it('becomes ready at the finished final answer without waiting for a later completion marker', () => {
    const { relay, events, tap } = setup();
    tap({ kind: 'start' });
    tap({ kind: 'chunk', chunk: `data: ${JSON.stringify({ v: { conversation_id: 'c1', message: {
      id: 'answer', author: { role: 'assistant' }, recipient: 'all', channel: 'final',
      content: { content_type: 'text', parts: ['Done.'] }, status: 'finished_successfully', end_turn: true
    } } })}\n\n` });
    expect(relay.idle()).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'message', message: { text: 'Done.' } });
    tap({ kind: 'end' });
    expect(events.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'complete' });
  });

  it('allows the next send after completion while retaining the stream for trailing metadata', () => {
    const { relay, events, tap } = setup();
    tap({ kind: 'start' });
    expect(relay.idle()).toBe(false);
    tap({ kind: 'chunk', chunk: 'data: [DONE]\n\n' });
    expect(relay.idle()).toBe(true);
    expect(events.some((event) => event.type === 'turn-end')).toBe(false);
    tap({ kind: 'end' });
    expect(events.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'complete' });
  });

  it('resolves send waiters on start and expires absent starts', async () => {
    vi.useFakeTimers();
    const { relay, tap } = setup();
    const started = relay.waitForStart(100);
    tap({ kind: 'start', requestId: 'r1' });
    await expect(started).resolves.toEqual({ conversationId: null, streamId: 's1' });
    const absent = relay.waitForStart(100);
    await vi.advanceTimersByTimeAsync(100);
    await expect(absent).resolves.toBeNull();
  });

  it('flushes the latest throttled message before ending and cancels its timer', () => {
    vi.useFakeTimers();
    const { events, tap, message } = setup();
    tap({ kind: 'start' });
    message('first');
    message('latest');
    expect(events.filter((event) => event.type === 'message')).toHaveLength(1);
    tap({ kind: 'chunk', chunk: 'data: [DONE]\n\n' });
    tap({ kind: 'end' });
    expect(events.at(-2)).toMatchObject({ type: 'message', message: { text: 'latest' } });
    expect(events.at(-1)).toMatchObject({ type: 'turn-end', outcome: 'complete', conversationId: 'c1' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('distinguishes aborted and failed streams, ignoring repeated ends', () => {
    const { events, tap } = setup();
    tap({ kind: 'start' });
    tap({ kind: 'end' });
    tap({ kind: 'end' });
    expect(events.filter((event) => event.type === 'turn-end')).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({ outcome: 'aborted', error: null });
    tap({ kind: 'start' });
    tap({ kind: 'error', error: 'connection interrupted' });
    expect(events.at(-1)).toMatchObject({ outcome: 'error', error: 'connection interrupted' });
  });

  it('encodes a conversation id before requesting the authoritative history', async () => {
    const { relay } = setup();
    const request = vi.fn(async () => ({}));
    const commands = new PageCommands({ getSession: async () => null, request }, relay);
    await expect(commands.run({ type: 'conversation', conversationId: 'id/../other?x=1' })).resolves.toEqual({ ok: true, value: [] });
    expect(request).toHaveBeenCalledWith('/backend-api/conversation/id%2F..%2Fother%3Fx%3D1');
  });
});
