/**
 * DOM primitives for the chatgpt.com composer. Selectors are ported from the reference extension
 * (chatgpt-dom.js) and kept in one place: ChatGPT changes them often.
 */
import type { ReasoningEffort } from '@shared/config';
import { wait, waitFor } from './wait';

const SELECTORS = {
  composer: [
    'form[data-chatgpt-composer] [contenteditable="true"][role="textbox"]',
    'form [data-composer-markdown][contenteditable="true"][role="textbox"]'
  ],
  classicComposer: '#prompt-textarea',
  sendButton: [
    'button[data-testid="send-button"]',
    'form button[aria-label^="Send" i]',
    'form[data-chatgpt-composer] button[type="submit"]'
  ],
  stopButton: [
    'button[data-testid="stop-button"]',
    'button[data-testid="composer-stop-button"]',
    'button[aria-label="Stop streaming"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label="Stop answering"]'
  ],
  /** The primary-action slot (voice, send or stop) in the composer form; icon-matched when unlabelled. */
  primarySlot: 'button[class*="size-token-button-composer"][class*="bg-composer-primary"]',
  alert: '[role="alert"]',
  dialog: '[role="dialog"], [role="alertdialog"]',
  modelTrigger: [
    '[data-codex-intelligence-trigger]',
    '[data-composer-navigation-target="reasoning"]'
  ],
  menuItem: '[role="menuitem"], [role="menuitemradio"], [role="option"], button'
} as const;

/** The rounded stop square: the one part of the stop control no locale translates. */
const STOP_SQUARE = /^\s*M4\.5 5\.75/;
const TRANSPORT_FAILURE =
  /^(?:message delivery timed out|connection interrupted|chatgpt stream recovery polling timed out|stream cache expired|unknown error occurred|there was an error generating|error in message stream|network error|a network error occurred|resume stream unavailable|something went wrong)/i;

const EFFORT_LABELS: Record<ReasoningEffort, RegExp | null> = {
  none: null,
  pro: null,
  minimal: /minimal/i,
  low: /light|low/i,
  medium: /standard|medium/i,
  high: /extended|high/i,
  xhigh: /heavy|xhigh|max/i,
  max: /max/i
};

function visible(node: Element): boolean {
  if (!node.isConnected || node.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  return node.getClientRects().length > 0;
}

function first<T extends Element>(nodes: Iterable<T>, keep: (node: T) => boolean = () => true): T | null {
  for (const node of nodes) if (keep(node)) return node;
  return null;
}

function normalize(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

function compact(text: string): string {
  return text.replace(/\s+/g, '');
}

function isStopSquare(button: Element): boolean {
  if (button.hasAttribute('data-state')) return false;
  const paths = button.querySelectorAll('svg path');
  return paths.length === 1 && STOP_SQUARE.test(paths[0]!.getAttribute('d') ?? '');
}

export function findComposer(): HTMLElement | null {
  const classic = first(document.querySelectorAll<HTMLElement>(SELECTORS.classicComposer), visible);
  if (classic) return classic;
  return first(
    document.querySelectorAll<HTMLElement>(SELECTORS.composer.join(', ')),
    (node) => visible(node) && !node.closest('[data-turn-key], .markdown')
  );
}

export function composerForm(): HTMLFormElement | null {
  return findComposer()?.closest('form') ?? null;
}

function composerText(box: HTMLElement): string {
  return box.innerText ?? box.textContent ?? '';
}

function primaryButtons(form: HTMLFormElement): HTMLButtonElement[] {
  return [...form.querySelectorAll<HTMLButtonElement>(SELECTORS.primarySlot)].filter(visible);
}

/** Replaces the composer content with `text`. Returns true only when the editor shows exactly it. */
export function setComposerText(text: string): boolean {
  const box = findComposer();
  if (!box) return false;
  const selectAll = (): void => {
    box.focus();
    const selection = document.getSelection();
    if (!selection) return;
    selection.selectAllChildren(box);
  };
  const clear = (): void => {
    selectAll();
    document.execCommand('delete', false);
  };
  const insert = (): void => {
    selectAll();
    document.execCommand('insertText', false, text);
  };
  const paste = (): void => {
    selectAll();
    const data = new DataTransfer();
    data.setData('text/plain', text);
    box.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  };
  const matches = (): boolean => compact(composerText(box)) === compact(text);
  if (matches()) return true;

  const attempts = text.length > 2000 ? [paste, insert] : [insert, paste];
  for (const attempt of attempts) {
    clear();
    if (text === '') return matches();
    attempt();
    if (matches()) return true;
  }
  return false;
}

/** The page's send control, or null when absent or ambiguous. */
export function findSendButton(): HTMLButtonElement | null {
  for (const selector of SELECTORS.sendButton) {
    const found = first(document.querySelectorAll<HTMLButtonElement>(selector), visible);
    if (found) return found;
  }
  // Locale-free fallback: the only primary-slot control that is neither stop nor dictation.
  const form = composerForm();
  const box = findComposer();
  if (!form || !box || composerText(box).trim() === '' || isGenerating()) return null;
  const candidates = primaryButtons(form).filter((button) => {
    if (button.hasAttribute('data-state') || isStopSquare(button)) return false;
    const paths = button.querySelectorAll('svg path').length;
    return paths >= 1 && paths <= 2;
  });
  return candidates.length === 1 ? candidates[0]! : null;
}

function findStopButton(): HTMLButtonElement | null {
  for (const selector of SELECTORS.stopButton) {
    const found = first(document.querySelectorAll<HTMLButtonElement>(selector), visible);
    if (found) return found;
  }
  const form = composerForm();
  if (!form) return null;
  return first(primaryButtons(form), isStopSquare);
}

export function isGenerating(): boolean {
  return findStopButton() !== null;
}

function enabled(button: HTMLButtonElement | null): button is HTMLButtonElement {
  return !!button && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
}

/** Clicks Send, or submits with Enter in the composer when the button cannot be identified. */
export function clickSend(): boolean {
  const button = findSendButton();
  if (enabled(button)) {
    button.click();
    return true;
  }
  const box = findComposer();
  if (!box || composerText(box).trim() === '' || isGenerating()) return false;
  box.focus();
  box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true }));
  return true;
}

export function clickStop(): boolean {
  const button = findStopButton();
  if (!button) return false;
  button.click();
  return true;
}


interface ErrorNotice {
  level: 'warn' | 'error';
  text: string;
}

/** A visible native transport-failure banner or a rate-limit dialog, or null. */
export function readErrorNotice(): ErrorNotice | null {
  for (const dialog of document.querySelectorAll<HTMLElement>(SELECTORS.dialog)) {
    if (!visible(dialog)) continue;
    const heading = dialog.querySelector('h1, h2, h3, [role="heading"]')?.textContent?.trim() ?? '';
    if (/^too many requests$/i.test(heading)) {
      return { level: 'warn', text: `${heading}: access to this conversation is temporarily limited.` };
    }
  }
  for (const alert of document.querySelectorAll<HTMLElement>(SELECTORS.alert)) {
    if (!visible(alert)) continue;
    const text = (alert.innerText || alert.textContent || '').replace(/\s+/g, ' ').trim();
    if (text.length > 2 && text.length < 500 && TRANSPORT_FAILURE.test(text)) return { level: 'error', text };
  }
  return null;
}

/** Calls `listener` whenever the user (not a script) operates ChatGPT's model picker or a menu. */
export function onUserModelPick(listener: () => void): void {
  const picker = `${SELECTORS.modelTrigger.join(', ')}, [role="menu"]`;
  const handle = (event: Event): void => {
    if (event.isTrusted && event.target instanceof Element && event.target.closest(picker)) listener();
  };
  document.addEventListener('pointerdown', handle, true);
  document.addEventListener('keydown', handle, true);
}

/** Confirms the native family and effort before dismissing the picker. */
export async function selectModel(model: string, effort: ReasoningEffort | null, presetIndex?: number): Promise<boolean> {
  const findTrigger = () => first(
    [...document.querySelectorAll<HTMLElement>(SELECTORS.modelTrigger.join(', ')),
      ...composerForm()?.querySelectorAll<HTMLElement>('button[aria-haspopup="menu"]') ?? []],
    visible
  );
  // ChatGPT mounts the editor before its native model control on a fresh chat.
  if (!(await waitFor(() => findTrigger() !== null))) return false;
  const trigger = findTrigger()!;
  const menu = () => first(document.querySelectorAll<HTMLElement>('[role="menu"]'), (node) =>
    visible(node) && node.getAttribute('aria-labelledby') === trigger.id);
  const item = (pattern: (text: string) => boolean, includeHidden = false) => first(
    menu()?.querySelectorAll<HTMLElement>(SELECTORS.menuItem) ?? [], (node) => {
      if (!includeHidden && !visible(node)) return false;
      const label = normalize((node.innerText || node.textContent || '').split('\n')[0] ?? '');
      return pattern(label);
    });
  const wanted = normalize(model);
  const modelItem = (includeHidden = false) => item((label) => label === wanted, includeHidden);
  try {
    if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
    if (!(await waitFor(() => menu() !== null))) return false;
    // Native v2 keeps the model list inert until the effort/view toggle is opened.
    if (presetIndex !== undefined && !modelItem()) menu()?.querySelector<HTMLElement>('[data-model-picker-view-toggle]')?.click();
    if (!(await waitFor(() => modelItem() !== null))) return false;
    modelItem()!.click();
    await wait(200);

    if (presetIndex !== undefined) {
      if (!menu()) trigger.click();
      if (!(await waitFor(() => modelItem(true)?.getAttribute('aria-checked') === 'true'))) return false;
      const control = () => menu()?.querySelector<HTMLElement>('[data-reasoning-slider]');
      const slider = () => menu()?.querySelector<HTMLElement>('[role="slider"]');
      if (!(await waitFor(() => {
        const node = control();
        return !!node && visible(node) && node.getAttribute('aria-disabled') !== 'true' && !!slider();
      }))) return false;
      const current = () => Number(slider()?.getAttribute('aria-valuenow'));
      const min = Number(slider()!.getAttribute('aria-valuemin'));
      const max = Number(slider()!.getAttribute('aria-valuemax'));
      if (presetIndex < min || presetIndex > max) return false;
      control()!.focus();
      for (let steps = 0; current() !== presetIndex && steps <= max - min; steps++) {
        const next = current() + (current() < presetIndex ? 1 : -1);
        const key = next > current() ? 'ArrowRight' : 'ArrowLeft';
        control()!.dispatchEvent(new KeyboardEvent('keydown', { key, code: key, bubbles: true, cancelable: true }));
        if (!(await waitFor(() => current() === next))) return false;
      }
      return await waitFor(() => current() === presetIndex && modelItem(true)?.getAttribute('aria-checked') === 'true'
        && trigger.getAttribute('data-selected-reasoning-effort') === effort);
    }

    if (!effort) return true;
    if (!menu()) trigger.click();
    const pattern = EFFORT_LABELS[effort];
    if (!pattern || !(await waitFor(() => item((label) => pattern.test(label)) !== null))) return false;
    item((label) => pattern.test(label))!.click();
    return true;
  } finally {
    menu()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  }
}
