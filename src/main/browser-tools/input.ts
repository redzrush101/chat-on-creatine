import { send, viewportSize } from './cdp';
import { parseChord } from './keys';
import type { Tab } from './tab';

const DRAG_STEPS = 10;
const SELECT_ALL = process.platform === 'darwin' ? 'Meta+a' : 'Control+a';

export interface ActionInput {
  action: 'click' | 'hover' | 'fill' | 'type' | 'select' | 'key' | 'scroll' | 'drag' | 'dialog';
  ref?: string;
  x?: number;
  y?: number;
  toRef?: string;
  toX?: number;
  toY?: number;
  text?: string;
  values?: string[];
  key?: string;
  holdMs?: number;
  button?: 'left' | 'middle' | 'right';
  clickCount?: number;
  deltaX?: number;
  deltaY?: number;
  accept?: boolean;
}

type MouseType = 'mouseMoved' | 'mousePressed' | 'mouseReleased';
interface Point {
  x: number;
  y: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const SELECT_FUNCTION = `function (values) {
  if (this.tagName !== 'SELECT') throw new Error('Ref is not a select element.');
  const wanted = new Set(values);
  for (const option of this.options) option.selected = wanted.has(option.value) || wanted.has(option.label);
  this.dispatchEvent(new Event('input', { bubbles: true }));
  this.dispatchEvent(new Event('change', { bubbles: true }));
  return [...this.selectedOptions].map((option) => option.value);
}`;

export class BrowserInput {
  async action(tab: Tab, input: ActionInput): Promise<string> {
    const button = input.button ?? 'left';
    const count = input.clickCount ?? 1;
    switch (input.action) {
      case 'click': {
        const point = await this.pointOf(tab, input.ref, input.x, input.y);
        await this.clickPoint(tab, point, button, count);
        return `clicked${input.ref ? ` ${input.ref}` : ''}`;
      }
      case 'hover': {
        await this.mouse(tab, 'mouseMoved', await this.pointOf(tab, input.ref, input.x, input.y));
        return 'hovered';
      }
      case 'fill': {
        if (input.ref === undefined) throw new Error('fill needs a ref.');
        await this.click(tab, input.ref, 'left', 1);
        await this.key(tab, SELECT_ALL);
        if (input.text) await this.insert(tab, input.text);
        else await this.key(tab, 'Backspace');
        return `filled ${input.ref}`;
      }
      case 'type': {
        if (input.ref !== undefined) await this.focusRef(tab, input.ref);
        if (input.text) await this.insert(tab, input.text);
        return 'typed';
      }
      case 'select': {
        if (input.ref === undefined || !input.values) throw new Error('select needs a ref and values.');
        const { object } = await send(tab, 'DOM.resolveNode', { backendNodeId: this.backendIdOf(tab, input.ref) });
        const result = await send(tab, 'Runtime.callFunctionOn', {
          objectId: object.objectId,
          functionDeclaration: SELECT_FUNCTION,
          arguments: [{ value: input.values }],
          returnByValue: true
        });
        if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? 'Select failed.');
        return `selected ${JSON.stringify(result.result.value)}`;
      }
      case 'key': {
        if (!input.key) throw new Error('key needs a key chord.');
        if (input.ref !== undefined) await this.focusRef(tab, input.ref);
        await this.key(tab, input.key, input.holdMs ?? 0);
        return `pressed ${input.key}`;
      }
      case 'scroll': {
        const point = await this.pointOf(tab, input.ref, input.x, input.y, true);
        await send(tab, 'Input.dispatchMouseEvent', {
          type: 'mouseWheel',
          x: point.x,
          y: point.y,
          deltaX: input.deltaX ?? 0,
          deltaY: input.deltaY ?? 0
        });
        return 'scrolled';
      }
      case 'drag': {
        const from = await this.pointOf(tab, input.ref, input.x, input.y);
        const to = await this.pointOf(tab, input.toRef, input.toX, input.toY);
        await this.mouse(tab, 'mouseMoved', from);
        await this.mouse(tab, 'mousePressed', from, 'left', 1);
        for (let step = 1; step <= DRAG_STEPS; step++) {
          const at = {
            x: from.x + ((to.x - from.x) * step) / DRAG_STEPS,
            y: from.y + ((to.y - from.y) * step) / DRAG_STEPS
          };
          await this.mouse(tab, 'mouseMoved', at, 'left');
        }
        await this.mouse(tab, 'mouseReleased', to, 'left', 1);
        return 'dragged';
      }
      case 'dialog': {
        await send(tab, 'Page.handleJavaScriptDialog', { accept: input.accept ?? true, promptText: input.text });
        return input.accept === false ? 'dismissed dialog' : 'accepted dialog';
      }
    }
  }
  private backendIdOf(tab: Tab, ref: string): number {
    const id = tab.refs.get(ref);
    if (id === undefined) throw new Error(`Unknown ref ${ref}. Take a fresh browser_snapshot; refs reset after navigation.`);
    return id;
  }

  private async pointOf(tab: Tab, ref: string | undefined, x: number | undefined, y: number | undefined, centerFallback = false): Promise<Point> {
    if (ref !== undefined) return this.centerOf(tab, this.backendIdOf(tab, ref));
    if (x !== undefined && y !== undefined) return { x, y };
    if (centerFallback) {
      const size = await viewportSize(tab);
      return { x: size.width / 2, y: size.height / 2 };
    }
    throw new Error('Give a ref, or x and y coordinates from the screenshot.');
  }

  private async centerOf(tab: Tab, backendNodeId: number): Promise<Point> {
    await send(tab, 'DOM.scrollIntoViewIfNeeded', { backendNodeId }).catch(() => undefined);
    const box = await send(tab, 'DOM.getBoxModel', { backendNodeId }).catch(() => {
      throw new Error('Element is not rendered. Take a fresh browser_snapshot.');
    });
    const quad = box.model.content;
    return {
      x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4,
      y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4
    };
  }

  private async focusRef(tab: Tab, ref: string): Promise<void> {
    await send(tab, 'DOM.focus', { backendNodeId: this.backendIdOf(tab, ref) });
  }

  private async click(tab: Tab, ref: string, button: 'left' | 'middle' | 'right', count: number): Promise<void> {
    await this.clickPoint(tab, await this.centerOf(tab, this.backendIdOf(tab, ref)), button, count);
  }

  private async clickPoint(tab: Tab, point: Point, button: 'left' | 'middle' | 'right', count: number): Promise<void> {
    await this.mouse(tab, 'mouseMoved', point);
    for (let i = 1; i <= count; i++) {
      await this.mouse(tab, 'mousePressed', point, button, i);
      await this.mouse(tab, 'mouseReleased', point, button, i);
    }
  }

  private mouse(tab: Tab, type: MouseType, point: Point, button: 'left' | 'middle' | 'right' | 'none' = 'none', clickCount = 0): Promise<unknown> {
    return send(tab, 'Input.dispatchMouseEvent', { type, x: point.x, y: point.y, button, clickCount });
  }

  private insert(tab: Tab, text: string): Promise<unknown> {
    return send(tab, 'Input.insertText', { text });
  }

  private async key(tab: Tab, chord: string, holdMs = 0): Promise<void> {
    const parsed = parseChord(chord);
    const base = { key: parsed.key, code: parsed.code, windowsVirtualKeyCode: parsed.vk, modifiers: parsed.modifiers };
    await send(tab, 'Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(parsed.text ? { text: parsed.text } : {}) });
    if (holdMs > 0) await sleep(holdMs);
    await send(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  }}
