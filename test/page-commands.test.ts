import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageCommands } from '../src/page/commands';
import { StreamRelay } from '../src/page/streams';

const state = vi.hoisted(() => ({ editor: true, mounted: false, draft: '', click: (): boolean => true }));
vi.mock('../src/page/dom', () => ({
  findComposer: () => state.editor ? {} : null,
  composerForm: () => null,
  isGenerating: () => false,
  setComposerText: (text: string) => { if (!state.editor) return false; state.draft = text; return true; },
  findSendButton: () => state.mounted && state.draft ? { disabled: false, getAttribute: () => null } : null,
  clickSend: () => state.click()
}));

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(state, { editor: true, mounted: false, draft: '' });
});
afterEach(() => vi.useRealTimers());

function setup() {
  const streams = new StreamRelay(() => {}, () => 'conversation');
  const click = vi.fn(() => {
    if (!state.draft) return false;
    streams.handle({ channel: 'test', kind: 'start', streamId: 'stream' });
    return true;
  });
  state.click = click;
  const commands = new PageCommands({ getSession: async () => null, request: async () => ({}) }, streams);
  return { commands, click };
}

describe('page send readiness', () => {
  it('restores a draft lost during hydration and sends once the controls mount', async () => {
    const { commands, click } = setup();
    const sending = commands.run({ type: 'send', text: 'message', files: [] });
    await vi.advanceTimersByTimeAsync(500);
    state.editor = false;
    state.draft = '';
    await vi.advanceTimersByTimeAsync(6000);
    expect(click).not.toHaveBeenCalled();
    state.editor = true;
    state.mounted = true;
    await vi.advanceTimersByTimeAsync(100);
    await expect(sending).resolves.toMatchObject({ ok: true });
    expect(state.draft).toBe('message');
    expect(click).toHaveBeenCalledOnce();
  });

  it('reports unavailable controls without trying to submit', async () => {
    const { commands, click } = setup();
    const sending = commands.run({ type: 'send', text: 'message', files: [] });
    await vi.advanceTimersByTimeAsync(15_000);
    await expect(sending).resolves.toMatchObject({ ok: false, code: 'not-ready' });
    expect(click).not.toHaveBeenCalled();
  });
});
