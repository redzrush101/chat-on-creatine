import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { selectModel } from '../src/page/dom';

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function picker(ignoreSlider = false, transitionMs = 0, triggerMs = 0) {
  const state = { open: false, modelsVisible: false, selected: 'Current', effort: 1 };
  let transitioning = false;
  let mounted = triggerMs === 0;
  if (triggerMs) setTimeout(() => { mounted = true; }, triggerMs);
  const node = (text: string, attrs: () => Record<string, string>, hidden: () => boolean, click: () => void) => ({
    id: '', innerText: text, textContent: text, isConnected: true,
    getClientRects: () => [1], closest: () => hidden() ? {} : null,
    getAttribute: (key: string) => attrs()[key] ?? null,
    click: vi.fn(click), focus: () => {},
    dispatchEvent: (event: KeyboardEvent) => {
      if (event.key === 'Escape') state.open = false;
    }
  });
  const trigger = node('', () => ({ 'aria-expanded': String(state.open),
    'data-selected-reasoning-effort': ['none', 'medium', 'high'][state.effort]! }), () => false,
    () => { state.open = !state.open; });
  trigger.id = 'picker';
  const toggle = node('Effort', () => ({}), () => false, () => { state.modelsVisible = !state.modelsVisible; });
  const model = node('Legacy', () => ({ 'aria-checked': String(state.selected === 'Legacy') }),
    () => !state.modelsVisible, () => {
      state.selected = 'Legacy';
      state.modelsVisible = false;
      if (transitionMs) {
        transitioning = true;
        setTimeout(() => { transitioning = false; }, transitionMs);
      }
    });
  const control = node('', () => ({ 'aria-disabled': String(state.modelsVisible || transitioning) }), () => state.modelsVisible, () => {});
  control.dispatchEvent = (event: KeyboardEvent) => {
    if (!ignoreSlider && event.key === 'ArrowRight') state.effort++;
    if (!ignoreSlider && event.key === 'ArrowLeft') state.effort--;
  };
  const slider = node('', () => ({ 'aria-valuenow': String(state.effort), 'aria-valuemin': '0', 'aria-valuemax': '2' }),
    () => false, () => {});
  const menu = { ...node('', () => ({ 'aria-labelledby': trigger.id }), () => !state.open, () => {}),
    querySelectorAll: () => [toggle, control, model],
    querySelector: (selector: string) => selector.includes('view-toggle') ? toggle
      : selector.includes('reasoning-slider') ? control : slider
  };
  vi.stubGlobal('document', {
    querySelectorAll: (selector: string) => selector.includes('data-codex-intelligence-trigger') && mounted ? [trigger]
      : selector === '[role="menu"]' && state.open ? [menu] : []
  });
  vi.stubGlobal('KeyboardEvent', class extends Event {
    key: string;
    constructor(type: string, init: KeyboardEventInit) {
      super(type, init);
      this.key = init.key ?? '';
    }
  });
  return { state, model, toggle };
}

describe('native model picker', () => {
  it.each([['none', 0], ['medium', 1], ['high', 2]] as const)(
    'opens the inert model list and confirms %s before closing', async (effort, index) => {
      const { state, model, toggle } = picker();
      const selecting = selectModel('Legacy', effort, index);
      await vi.runAllTimersAsync();
      await expect(selecting).resolves.toBe(true);
      expect(toggle.click).toHaveBeenCalledOnce();
      expect(model.click).toHaveBeenCalledOnce();
      expect(state).toEqual({ open: false, modelsVisible: false, selected: 'Legacy', effort: index });
    }
  );

  it('refuses a slider that ignores the requested change', async () => {
    const { state } = picker(true);
    const selecting = selectModel('Legacy', 'high', 2);
    await vi.runAllTimersAsync();
    await expect(selecting).resolves.toBe(false);
    expect(state.effort).toBe(1);
    expect(state.open).toBe(false);
  });

  it('waits for the native pane transition before setting the effort', async () => {
    const { state } = picker(false, 500);
    const selecting = selectModel('Legacy', 'high', 2);
    await vi.runAllTimersAsync();
    await expect(selecting).resolves.toBe(true);
    expect(state.effort).toBe(2);
  });

  it('waits for the native trigger to mount on a fresh chat', async () => {
    const { state } = picker(false, 0, 500);
    const selecting = selectModel('Legacy', 'none', 0);
    await vi.runAllTimersAsync();
    await expect(selecting).resolves.toBe(true);
    expect(state.effort).toBe(0);
  });
});
