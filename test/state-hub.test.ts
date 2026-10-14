import { afterEach, expect, it, vi } from 'vitest';
import type { AppState, SessionEvent } from '@shared/types';
import { StateHub } from '../src/main/app/state';
import type { Services } from '../src/main/app/services';

vi.mock('electron', () => ({ app: { getVersion: () => 'test' } }));
afterEach(() => vi.useRealTimers());

it('publishes a fresh snapshot after a change arrives during an asynchronous snapshot', async () => {
  vi.useFakeTimers();
  const send = vi.fn();
  const hub = new StateHub(() => ({} as Services), send);
  let finish: (state: AppState) => void = () => {};
  vi.spyOn(hub, 'snapshot').mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }))
    .mockResolvedValue({ version: 'latest' } as AppState);
  hub.changed();
  await vi.advanceTimersByTimeAsync(50);
  hub.changed();
  finish({ version: 'earlier' } as AppState);
  await vi.advanceTimersByTimeAsync(50);
  expect(send.mock.calls).toEqual([['state', { version: 'earlier' }], ['state', { version: 'latest' }]]);
});

it('coalesces streamed updates and retains a final answer and turn end in the next frame', async () => {
  vi.useFakeTimers();
  const send = vi.fn();
  const hub = new StateHub(() => null, send);
  const answer: SessionEvent = { kind: 'assistant', id: 'answer', at: 1, messageId: 'message', channel: 'final', model: null, text: 'First', streaming: true };
  const final = { ...answer, text: 'Final answer', streaming: false };
  const end: SessionEvent = { kind: 'turn', id: 'end', at: 2, phase: 'end', outcome: 'done', error: null };
  hub.events('chat', [answer]);
  hub.events('chat', [final, end]);
  await vi.advanceTimersByTimeAsync(16);
  expect(send).toHaveBeenCalledWith('session:events', { sessionId: 'chat', events: [final, end] });
});
