import type { Key } from 'node:readline';
import { ACCENT, DIM, clip, color } from './format';

/**
 * The Ctrl+O transcript on the terminal's alternate screen. Scrolling it never touches scrollback,
 * and leaving it restores the conversation exactly as it was.
 */
export class Viewer {
  private offset = 0;
  private follow = true;
  private end = 0;

  constructor(private readonly rows: (columns: number) => string[], private readonly colored: boolean) {}

  frame(columns: number, height: number): string {
    const body = Math.max(1, height - 2);
    const rows = this.rows(columns);
    this.end = Math.max(0, rows.length - body);
    this.offset = this.follow ? this.end : Math.min(this.offset, this.end);
    const visible = rows.slice(this.offset, this.offset + body);
    const position = rows.length ? `${this.offset + 1}–${this.offset + visible.length} of ${rows.length}` : 'empty';
    const head = `${color(ACCENT, color(1, ' Transcript', this.colored), this.colored)}${color(DIM, clip(` · ctrl+o or esc to return · ↑↓ pgup pgdn g G to scroll · ${position}`, columns - 11), this.colored)}`;
    const lines = [head, ...visible];
    while (lines.length < height) lines.push('');
    return `\x1b[H${lines.map((line) => `${line}\x1b[K`).join('\n')}\x1b[J`;
  }

  /** Handles a key; false means the viewer should close. */
  key(sequence: string, key: Key, height: number): boolean {
    const page = Math.max(1, height - 3);
    const scroll = (delta: number) => { this.offset = Math.max(0, Math.min(this.end, this.offset + delta)); this.follow = this.offset >= this.end; };
    if (key.name === 'escape' || key.name === 'q' || key.ctrl && (key.name === 'o' || key.name === 'c')) return false;
    if (key.name === 'up' || key.name === 'k') scroll(-1);
    else if (key.name === 'down' || key.name === 'j') scroll(1);
    else if (key.name === 'pageup' || key.name === 'b') scroll(-page);
    else if (key.name === 'pagedown' || key.name === 'space' || sequence === ' ') scroll(page);
    else if (key.name === 'home' || sequence === 'g') scroll(-Infinity);
    else if (key.name === 'end' || sequence === 'G') scroll(Infinity);
    return true;
  }
}
