import { afterEach, describe, expect, it, vi } from 'vitest';
import { normalizeMessage } from '@shared/chatgpt-stream';
import type { Caller } from '../src/main/mcp/tool';
import { CallerAttribution } from '../src/main/chatgpt/attribution';

afterEach(() => vi.useRealTimers());

const caller: Caller = { sessionId: 's1', conversationId: 'c1', cwd: null, kind: 'chat' };

function setup() {
  const markOwnCall = vi.fn();
  const state = { generating: [] as string[] };
  const attribution = new CallerAttribution({
    callerFor: (id) => id === caller.sessionId ? caller : null,
    generatingSessions: () => state.generating,
    markOwnCall
  });
  const note = (id: string, requestId: string | null, args: unknown) => attribution.noteMessage('s1', normalizeMessage({
    id, author: { role: 'assistant' }, recipient: 'api_tool.call_tool', status: 'finished_successfully',
    metadata: { request_id: requestId }, content: { parts: [JSON.stringify({ path: '/Core/link/read', args })] }
  }, 'c1')!);
  return { attribution, markOwnCall, state, note };
}

describe('MCP caller attribution', () => {
  it('joins a streamed call regardless of argument key order', async () => {
    const { attribution, markOwnCall, note } = setup();
    note('m1', null, { b: 2, a: { y: 2, x: 1 } });
    await expect(attribution.resolve(null, { tool: 'read', args: { a: { x: 1, y: 2 }, b: 2 } })).resolves.toEqual({ ...caller, streamCallId: 'm1' });
    expect(markOwnCall).toHaveBeenCalledExactlyOnceWith('s1', 'm1');
  });

  it('claims the later stream message when the MCP call arrived first', async () => {
    const { attribution, markOwnCall, note } = setup();
    note('other', 'request_1', { path: 'other' });
    await expect(attribution.resolve('request_1', { tool: 'read', args: { path: 'a' } })).resolves.toEqual(caller);
    expect(markOwnCall).not.toHaveBeenCalled();
    note('late', 'request_1', { path: 'a' });
    expect(markOwnCall).toHaveBeenCalledExactlyOnceWith('s1', 'late');
  });

  it('waits for message metadata before falling back to a generating chat', async () => {
    vi.useFakeTimers();
    const { attribution, note } = setup();
    const pending = attribution.resolve('request_2', { tool: 'read', args: { path: 'a' } });
    note('m2', 'request_2', { path: 'a' });
    await expect(pending).resolves.toEqual({ ...caller, streamCallId: 'm2' });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('refuses an ambiguous fallback and accepts one generating chat', async () => {
    vi.useFakeTimers();
    const { attribution, state } = setup();
    state.generating = ['s1', 's2'];
    const ambiguous = attribution.resolve(null, { tool: 'read', args: {} });
    await vi.advanceTimersByTimeAsync(2_500);
    await expect(ambiguous).resolves.toBeNull();
    state.generating = ['s1'];
    const single = attribution.resolve(null, { tool: 'read', args: {} });
    await vi.advanceTimersByTimeAsync(2_500);
    await expect(single).resolves.toEqual(caller);
  });
});
