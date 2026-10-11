import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PageCommands } from '../src/page/commands';
import { StreamRelay } from '../src/page/streams';

const state = vi.hoisted(() => ({ editor: true, mounted: false, draft: '', click: (): boolean => true }));
const selectModel = vi.hoisted(() => vi.fn(async () => true));
vi.mock('../src/page/dom', () => ({
  findComposer: () => state.editor ? {} : null,
  composerForm: () => null,
  isGenerating: () => false,
  setComposerText: (text: string) => { if (!state.editor) return false; state.draft = text; return true; },
  findSendButton: () => state.mounted && state.draft ? { disabled: false, getAttribute: () => null } : null,
  clickSend: () => state.click(),
  selectModel
}));

beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(state, { editor: true, mounted: false, draft: '' });
  selectModel.mockReset().mockResolvedValue(true);
});

describe('page model selection', () => {
  const catalog = { default_model_slug: 'auto', models: [{ slug: 'auto' }, { slug: 'fast' }, { slug: 'think' }], versions: [
    { enabled: true, display_text_for_intelligence: 'Family', slugs: ['auto', 'fast', 'think'], intelligence_presets: [
      { model_slug: 'fast', lane: 'instant', title: 'Instant', preset_type: 'available' },
      { model_slug: 'think', lane: 'thinking', thinking_effort: 'standard', title: 'Medium', preset_type: 'available' },
      { model_slug: 'think', lane: 'thinking', thinking_effort: 'extended', title: 'High', preset_type: 'available' }
    ] }
  ] };
  function commands() {
    return new PageCommands({ getSession: async () => null, request: async () => catalog }, new StreamRelay(() => {}, () => null));
  }

  it.each([
    ['fast', null, 'none', 0], ['think', null, 'medium', 1], ['think', 'high', 'high', 2], ['', 'high', 'high', 2]
  ] as const)('selects the native family and preset for %s / %s', async (model, effort, expected, index) => {
    const selecting = commands().run({ type: 'select-model', model, effort });
    await expect(selecting).resolves.toEqual({ ok: true });
    expect(selectModel).toHaveBeenCalledExactlyOnceWith('Family', expected, index);
  });

  it.each([['internal', null], ['think', 'xhigh']] as const)('rejects unavailable model or effort %s / %s', async (model, effort) => {
    await expect(commands().run({ type: 'select-model', model, effort })).resolves.toMatchObject({ ok: false, code: 'not-found' });
    expect(selectModel).not.toHaveBeenCalled();
  });

  it('skips the picker for a choice it already confirmed until the user opens the picker', async () => {
    const page = commands();
    const select = () => page.run({ type: 'select-model', model: 'think', effort: 'high' });
    await select();
    await select();
    expect(selectModel).toHaveBeenCalledOnce();
    page.forgetSelection();
    await select();
    expect(selectModel).toHaveBeenCalledTimes(2);
  });

  it('reports failure when the native picker cannot confirm the selection', async () => {
    selectModel.mockResolvedValue(false);
    await expect(commands().run({ type: 'select-model', model: 'think', effort: 'high' })).resolves.toMatchObject({
      ok: false, error: expect.stringContaining('Could not confirm Family (high)')
    });
  });
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
