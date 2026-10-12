import { stripVTControlCharacters } from 'node:util';
import os from 'node:os';

/** External text cannot issue terminal commands, alter the title or write to the clipboard. */
export function safeText(text: string): string {
  return stripVTControlCharacters(text).replace(/\r\n?/g, '\n').replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, '').replace(/\t/g, '  ');
}

const segments = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
export function graphemes(text: string): string[] { return Array.from(segments.segment(text), (entry) => entry.segment); }

export function width(text: string): number {
  return graphemes(stripVTControlCharacters(text)).reduce((total, part) => {
    const point = part.codePointAt(0) ?? 0;
    if (/^\p{Mark}+$/u.test(part)) return total;
    return total + (/\p{Extended_Pictographic}/u.test(part) || point >= 0x1100 && (
      point <= 0x115f || point >= 0x2e80 && point <= 0xa4cf || point >= 0xac00 && point <= 0xd7a3 ||
      point >= 0xf900 && point <= 0xfaff || point >= 0xfe10 && point <= 0xfe6f || point >= 0xff01 && point <= 0xff60 || point >= 0x20000
    ) ? 2 : 1);
  }, 0);
}

export function clip(text: string, columns: number): string {
  let result = '';
  for (const part of graphemes(safeText(text))) {
    if (width(result + part) > columns) break;
    result += part;
  }
  return result;
}

/** Like clip, but marks the cut with an ellipsis. */
export function ellipsis(text: string, columns: number): string {
  return width(text) <= columns ? text : `${clip(text, Math.max(0, columns - 1))}…`;
}

/** The clay accent of the desktop app. */
export const ACCENT = '38;5;173';
export const DIM = 90;

export const color = (code: number | string, text: string, enabled = true): string => enabled && text ? `\x1b[${code}m${text}\x1b[0m` : text;

/** Usable columns; one short of the edge so a full row never triggers the terminal's own wrap. */
export function screenColumns(): number { return Math.max(20, (process.stdout.columns || 80) - 1); }

export function tilde(path: string): string {
  const home = os.homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

const SGR = /(\x1b\[[0-9;]*m)/;

/**
 * Word-wraps one line that may carry SGR colors. Continuation rows start `hang` spaces in and
 * reopen the colors that were active at the break.
 */
export function wrap(line: string, columns: number, hang = 0): string[] {
  const tokens = line.split(SGR).flatMap((part, index) => index % 2 ? [{ text: part, cells: 0 }] : graphemes(part).map((text) => ({ text, cells: width(text) })));
  const pad = Math.min(hang, columns - 1);
  const rows: string[] = [];
  let row: typeof tokens = [];
  let start = 0;
  let cells = 0;
  const emit = () => {
    let active = '';
    for (const token of row) if (token.text.startsWith('\x1b')) active = token.text === '\x1b[0m' ? '' : active + token.text;
    rows.push(row.map((token) => token.text).join('').replace(/ +$/, '') + (active ? '\x1b[0m' : ''));
    row = [{ text: ' '.repeat(pad), cells: pad }, ...active ? [{ text: active, cells: 0 }] : []];
    start = row.length;
    cells = pad;
  };
  for (const token of tokens) {
    if (token.cells && cells + token.cells > columns && cells > (rows.length ? pad : 0)) {
      if (token.text === ' ') { emit(); continue; }
      const space = row.findLastIndex((item) => item.text === ' ');
      const tail = space > start ? row.splice(space + 1) : [];
      emit();
      row.push(...tail);
      cells += tail.reduce((sum, item) => sum + item.cells, 0);
    }
    row.push(token);
    cells += token.cells;
  }
  if (!rows.length || cells > pad) rows.push(row.map((token) => token.text).join('').replace(/ +$/, ''));
  return rows;
}

/** A block of rows behind a first-row marker such as `● ` and an indent for the rest. */
export function indent(lines: { text: string; hang: number }[], columns: number, first: string, rest = '  '): string[] {
  const inner = Math.max(10, columns - width(rest));
  return lines.flatMap((line) => wrap(line.text, inner, line.hang)).map((row, index) => index ? row ? `${rest}${row}` : '' : `${first}${row}`);
}
