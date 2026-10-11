/**
 * DOM primitives for the chatgpt.com composer. Selectors are ported from the reference extension
 * (chatgpt-dom.js) and kept in one place: ChatGPT changes them often.
 */
import type { ReasoningEffort } from '@shared/config';

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
  fileInput: 'input[type="file"]',
  uploadBusy: '[aria-busy="true"], [role="progressbar"], [data-inline-file-uploading]',
  alert: '[role="alert"]',
  dialog: '[role="dialog"], [role="alertdialog"]',
  loginLink: '[data-testid="login-button"], a[href^="/auth/login"]',
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

function composerForm(): HTMLFormElement | null {
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

export function findStopButton(): HTMLButtonElement | null {
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

/**
 * Attaches files through the composer's own file input and waits until every upload has finished
 * (no progress markers, send enabled). Resolves false on a missing input or a timeout.
 */
export async function attachFiles(files: File[], timeoutMs = 120_000): Promise<boolean> {
  const form = composerForm() ?? document;
  const inputs = [...form.querySelectorAll<HTMLInputElement>(SELECTORS.fileInput)].filter((input) => !input.disabled);
  const images = files.every((file) => file.type.startsWith('image/'));
  const input =
    inputs.find((candidate) => (images ? candidate.accept.includes('image') : !candidate.accept)) ?? inputs[0];
  if (!input) return false;

  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  input.files = transfer.files;
  input.dispatchEvent(new Event('change', { bubbles: true }));

  // Done when every file has a tile and nothing in the composer is still uploading. The send
  // button is no evidence here: with tiles present it is not reliably identifiable.
  const deadline = Date.now() + timeoutMs;
  await new Promise((resolve) => setTimeout(resolve, 300));
  while (Date.now() < deadline) {
    const current = composerForm();
    const labels = [...(current?.querySelectorAll<HTMLElement>('button[aria-label]') ?? [])].map((b) => b.getAttribute('aria-label') ?? '');
    // ChatGPT renames repeat uploads ("notes(1).txt"), so match on the name without extension.
    const tiled = files.every((file) => labels.some((label) => label.includes(file.name.replace(/\.[^.]*$/, ''))));
    const busy = current?.querySelector(SELECTORS.uploadBusy) != null;
    if (tiled && !busy) return true;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return false;
}

/** Signed-out heuristics for the page itself; the session endpoint is the authority. */
export function isSignedOut(): boolean {
  return location.pathname.startsWith('/auth') || document.querySelector(SELECTORS.loginLink) !== null;
}

export interface ErrorNotice {
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

/**
 * Best-effort: opens the composer's model picker and clicks the item named `model` (a picker label
 * or an id), then the effort item. Returns false when the picker or an item cannot be found.
 */
export async function selectModel(model: string, effort: ReasoningEffort | null): Promise<boolean> {
  const menuButtons = composerForm()?.querySelectorAll<HTMLElement>('button[aria-haspopup="menu"]') ?? [];
  const trigger = first(
    [...document.querySelectorAll<HTMLElement>(SELECTORS.modelTrigger.join(', ')), ...menuButtons],
    visible
  );
  if (!trigger) return false;
  trigger.click();
  await wait(300);

  const clickItem = (pattern: (text: string) => boolean): boolean => {
    const item = first(document.querySelectorAll<HTMLElement>(SELECTORS.menuItem), (node) => {
      if (!visible(node)) return false;
      const label = normalize((node.innerText || node.textContent || '').split('\n')[0] ?? '');
      return pattern(label);
    });
    if (!item) return false;
    item.click();
    return true;
  };

  const wanted = normalize(model);
  let ok = clickItem((label) => label === wanted || label.startsWith(`${wanted} `));
  if (ok && effort) {
    await wait(300);
    const pattern = EFFORT_LABELS[effort];
    ok = pattern !== null && clickItem((label) => pattern.test(label));
  }
  if (!ok) document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  return ok;
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
