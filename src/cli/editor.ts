import type { Key } from 'node:readline';
import { graphemes, safeText, width } from './format';

/** Editing is independent of rendering so streams cannot disturb the draft or its cursor. */
export class Editor {
  text = '';
  cursor = 0;
  private readonly history: string[] = [];
  private historyIndex = 0;
  private savedDraft = '';

  insert(text: string): void {
    const value = safeText(text);
    this.text = this.text.slice(0, this.cursor) + value + this.text.slice(this.cursor);
    this.cursor += value.length;
  }

  set(text: string): void { this.text = text; this.cursor = text.length; }

  submit(): string {
    const text = this.text.trim();
    if (text && this.history.at(-1) !== text) this.history.push(text);
    this.historyIndex = this.history.length;
    this.savedDraft = '';
    this.set('');
    return text;
  }

  key(sequence: string, key: Key): 'submit' | 'interrupt' | 'stop' | 'complete' | 'expand' | 'exit' | 'edit' {
    if (key.ctrl && key.name === 'c') return 'interrupt';
    if (key.ctrl && key.name === 'd' && !this.text) return 'exit';
    if (key.name === 'escape') return 'stop';
    if (key.name === 'tab') return 'complete';
    if (key.ctrl && key.name === 'o') return 'expand';
    if (key.name === 'return' && !key.meta && !key.shift) {
      if (this.text.endsWith('\\')) { this.text = this.text.slice(0, -1); this.cursor = this.text.length; this.insert('\n'); return 'edit'; }
      return 'submit';
    }
    if (key.name === 'return' || key.name === 'enter' || key.ctrl && key.name === 'j') { this.insert('\n'); return 'edit'; }
    const before = this.text.slice(0, this.cursor);
    const after = this.text.slice(this.cursor);
    if (key.ctrl && key.name === 'a' || key.name === 'home') this.cursor = before.lastIndexOf('\n') + 1;
    else if (key.ctrl && key.name === 'e' || key.name === 'end') this.cursor += after.indexOf('\n') < 0 ? after.length : after.indexOf('\n');
    else if (key.ctrl && key.name === 'u') { const start = before.lastIndexOf('\n') + 1; this.text = this.text.slice(0, start) + after; this.cursor = start; }
    else if (key.ctrl && key.name === 'k') this.text = before + after.slice(after.indexOf('\n') < 0 ? after.length : after.indexOf('\n'));
    else if (key.ctrl && key.name === 'w') { const shortened = before.replace(/\s*\S+\s*$/, ''); this.text = shortened + after; this.cursor = shortened.length; }
    else if (key.name === 'backspace') {
      const count = graphemes(before).at(-1)?.length ?? 0;
      this.text = before.slice(0, -count || before.length) + after; this.cursor -= count;
    } else if (key.name === 'delete') this.text = before + after.slice(graphemes(after)[0]?.length ?? 0);
    else if (key.name === 'left') this.cursor -= key.ctrl || key.meta ? before.length - before.replace(/\s*\S+\s*$/, '').length : graphemes(before).at(-1)?.length ?? 0;
    else if (key.name === 'right') this.cursor += key.ctrl || key.meta ? /^\s*\S+\s*/.exec(after)?.[0].length ?? after.length : graphemes(after)[0]?.length ?? 0;
    else if (key.name === 'up' || key.name === 'down') {
      const direction = key.name === 'up' ? -1 : 1;
      const lines = this.text.split('\n');
      const row = before.split('\n').length - 1;
      const column = width(before.slice(before.lastIndexOf('\n') + 1));
      if (lines.length > 1 && row + direction >= 0 && row + direction < lines.length) {
        const target = lines[row + direction]!;
        let offset = 0;
        let cells = 0;
        for (const part of graphemes(target)) {
          if (cells + width(part) > column) break;
          cells += width(part); offset += part.length;
        }
        this.cursor = lines.slice(0, row + direction).reduce((n, line) => n + line.length + 1, 0) + offset;
      } else if (lines.length === 1) {
        if (this.historyIndex === this.history.length) this.savedDraft = this.text;
        this.historyIndex = Math.max(0, Math.min(this.history.length, this.historyIndex + direction));
        this.set(this.history[this.historyIndex] ?? this.savedDraft);
      }
    } else if (!key.ctrl && !key.meta && sequence && !sequence.startsWith('\x1b')) this.insert(sequence);
    return 'edit';
  }
}
