import hljs from 'highlight.js/lib/common';
import { Lexer, type Token, type Tokens } from 'marked';
import { DIM, safeText, screenColumns, width, wrap } from './format';

/** One logical row; `hang` indents its wrapped continuation rows. */
export interface Line { text: string; hang: number }

/** Brackets for a citation's source names, set by `cited` and shown dim. */
export const CITE = ['', ''] as const;

const OPTIONS = { gfm: true, breaks: true };

/** Highlight.js scopes in the terminal's own palette, so every theme keeps its contrast. */
const SCOPES: Record<string, number> = {
  keyword: 35, 'selector-tag': 35, symbol: 35, bullet: 35,
  built_in: 36, type: 36, attr: 36, attribute: 36, property: 36, 'selector-class': 36,
  title: 34, section: 34, function: 34,
  string: 32, regexp: 32, addition: 32, 'selector-attr': 32,
  number: 33, literal: 33,
  variable: 31, 'template-variable': 31, name: 31, deletion: 31,
  comment: DIM, doc: DIM, meta: DIM, quote: DIM
};
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', '#x27': "'", '#39': "'" };

function decode(text: string): string {
  return text.replace(/&(amp|lt|gt|quot|#x27|#39);/g, (_match, name: string) => ENTITIES[name]!);
}

/** Styles with their own off codes, so a nested span never cancels the one around it. */
function style(on: number | string, off: number, text: string, colored: boolean): string {
  return colored && text ? `\x1b[${on}m${text}\x1b[${off}m` : text;
}

/** Highlighted code lines; colors that span lines are reopened on each one. */
function code(text: string, lang: string | undefined, colored: boolean): string[] {
  const source = text.replace(/\n$/, '');
  if (!colored) return source.split('\n');
  const language = lang && hljs.getLanguage(lang) ? lang : null;
  const html = language ? hljs.highlight(source, { language, ignoreIllegals: true }).value
    : source.length < 4000 ? hljs.highlightAuto(source).value : source.replace(/[&<>]/g, (char) => `&${{ '&': 'amp', '<': 'lt', '>': 'gt' }[char]};`);
  const stack: (number | null)[] = [];
  return html.split('\n').map((line) => {
    const open = stack.findLast((value) => value !== null);
    const body = line.replace(/<span class="([^"]+)">|<\/span>|&(amp|lt|gt|quot|#x27|#39);/g, (_match, scope: string | undefined, entity: string | undefined) => {
      if (entity) return ENTITIES[entity]!;
      if (scope) {
        const value = SCOPES[scope.split(' ')[0]!.replace(/^hljs-/, '')] ?? null;
        stack.push(value);
        return value === null ? '' : `\x1b[${value}m`;
      }
      const closed = stack.pop();
      return closed === null || closed === undefined ? '' : `\x1b[${stack.findLast((value) => value !== null) ?? 39}m`;
    });
    return `${open ? `\x1b[${open}m` : ''}${body}\x1b[39m`;
  });
}

function inline(tokens: Token[] | undefined, colored: boolean): string {
  return (tokens ?? []).map((token) => {
    switch (token.type) {
      case 'strong': return style(1, 22, inline(token.tokens, colored), colored);
      case 'em': return style(3, 23, inline(token.tokens, colored), colored);
      case 'del': return style(9, 29, inline(token.tokens, colored), colored);
      case 'codespan': return style(36, 39, decode(token.text), colored);
      case 'br': return '\n';
      case 'link': {
        const label = inline(token.tokens, colored);
        const plain = decode(token.text);
        return plain === token.href || `mailto:${plain}` === token.href ? style(4, 24, plain, colored)
          : `${style(4, 24, label, colored)}${style(DIM, 39, ` (${token.href})`, colored)}`;
      }
      case 'image': return style(DIM, 39, `[image: ${decode(token.text) || token.href}]`, colored);
      case 'text': case 'escape':
        if ('tokens' in token && token.tokens?.length) return inline(token.tokens, colored);
        return decode(token.text).replace(new RegExp(`${CITE[0]}([^${CITE[1]}]*)${CITE[1]}`, 'g'), (_match, sources: string) => style(DIM, 39, `(${sources})`, colored));
      default: return 'raw' in token ? token.raw : '';
    }
  }).join('');
}

const text = (value: string, hang = 0): Line[] => value.split('\n').map((row) => ({ text: row, hang }));

/** A table with box-drawn borders; columns shrink and wrap their cells to fit `columns`. */
function table(token: Tokens.Table, colored: boolean, columns: number): Line[] {
  const cells = [token.header, ...token.rows].map((row, index) => row.map((cell) => index ? inline(cell.tokens, colored) : style(1, 22, inline(cell.tokens, colored), colored)));
  const count = Math.max(...cells.map((row) => row.length));
  const widths = Array.from({ length: count }, (_, column) => Math.max(1, ...cells.map((row) => width(row[column] ?? ''))));
  const room = Math.max(count * 3, columns - 3 * count - 1);
  while (widths.reduce((sum, value) => sum + value, 0) > room) {
    const widest = widths.indexOf(Math.max(...widths));
    if (widths[widest]! <= 3) break;
    widths[widest]!--;
  }
  const border = (left: string, middle: string, right: string) => style(DIM, 39, `${left}${widths.map((size) => '─'.repeat(size + 2)).join(middle)}${right}`, colored);
  const bar = style(DIM, 39, '│', colored);
  const pad = (cell: string, column: number) => {
    const space = Math.max(0, widths[column]! - width(cell));
    const align = token.align[column];
    const left = align === 'right' ? space : align === 'center' ? Math.floor(space / 2) : 0;
    return `${' '.repeat(left)}${cell}${' '.repeat(space - left)}`;
  };
  const lines = [border('┌', '┬', '┐')];
  cells.forEach((row, index) => {
    const wrapped = widths.map((size, column) => wrap(row[column] ?? '', size));
    const height = Math.max(...wrapped.map((cell) => cell.length));
    for (let line = 0; line < height; line++) lines.push(`${bar}${wrapped.map((cell, column) => ` ${pad(cell[line] ?? '', column)} `).join(bar)}${bar}`);
    if (index === 0 && cells.length > 1) lines.push(border('├', '┼', '┤'));
  });
  lines.push(border('└', '┴', '┘'));
  return lines.map((line) => ({ text: line, hang: 0 }));
}

const BULLETS = ['•', '◦', '▪'];

function list(token: Tokens.List, colored: boolean, columns: number, depth: number): Line[] {
  const start = typeof token.start === 'number' ? token.start : 1;
  const markers = token.items.map((item, index) => item.task ? (item.checked ? '☒' : '☐') : token.ordered ? `${start + index}.` : BULLETS[depth % BULLETS.length]!);
  const size = Math.max(...markers.map(width)) + 1;
  return token.items.flatMap((item, index) => {
    const body = blocks(item.tokens.filter((child) => child.type !== 'checkbox'), colored, columns - size, !token.loose, depth + 1);
    const marker = markers[index]!;
    const head = item.checked ? style(DIM, 39, marker, colored) : marker;
    const rows = body.map((line, row) => ({ text: `${row ? ' '.repeat(size) : `${head}${' '.repeat(size - width(marker))}`}${line.text}`, hang: size + line.hang }));
    return token.loose && index ? [{ text: '', hang: 0 }, ...rows] : rows;
  });
}

function block(token: Token, colored: boolean, columns: number, depth: number): Line[] {
  switch (token.type) {
    case 'heading': {
      const body = inline(token.tokens, colored);
      return text(token.depth === 1 ? style('1;4', 0, body, colored) : style(1, 22, body, colored));
    }
    case 'paragraph': return text(inline(token.tokens, colored));
    case 'text': return text('tokens' in token && token.tokens ? inline(token.tokens, colored) : decode(token.text));
    case 'code': return code(token.text, token.lang, colored).map((row) => ({ text: `  ${row}`, hang: 2 }));
    case 'blockquote': return blocks(token.tokens ?? [], colored, columns - 2, false, depth).map((line) => ({ text: `${style(DIM, 39, '│', colored)} ${line.text}`, hang: line.hang + 2 }));
    case 'list': return list(token as Tokens.List, colored, columns, depth);
    case 'table': return table(token as Tokens.Table, colored, columns);
    case 'hr': return [{ text: style(DIM, 39, '─'.repeat(Math.min(columns, 40)), colored), hang: 0 }];
    case 'html': return text(token.raw.replace(/\n+$/, ''));
    case 'space': case 'def': return [];
    default: return 'raw' in token ? text(String(token.raw).replace(/\n+$/, '')) : [];
  }
}

/** Blocks separated by blank lines, or stacked when `tight` (the items of a tight list). */
function blocks(tokens: Token[], colored: boolean, columns: number, tight: boolean, depth = 0): Line[] {
  const lines: Line[] = [];
  for (const token of tokens) {
    const rows = block(token, colored, columns, depth);
    if (!rows.length) continue;
    if (lines.length && !tight) lines.push({ text: '', hang: 0 });
    lines.push(...rows);
  }
  return lines;
}

/** GitHub-flavored Markdown as terminal rows for a block `columns` wide. */
export function markdown(source: string, colored: boolean, columns = screenColumns() - 2): Line[] {
  return blocks(Lexer.lex(safeText(source), OPTIONS), colored, columns, false);
}

/**
 * How much of a streamed reply is final: every block but the last, which may still grow. A list
 * stays open until another block follows it, since its next item may come after a blank line.
 */
export function settled(source: string): number {
  const tokens = Lexer.lex(source, OPTIONS);
  let end = tokens.reduce((sum, token) => sum + token.raw.length, 0);
  for (let index = tokens.length - 1; index >= 0; index--) {
    const token = tokens[index]!;
    end -= token.raw.length;
    if (token.type !== 'space') {
      const closed = tokens[index + 1]?.type === 'space' && token.type !== 'list';
      return closed ? end + token.raw.length : end;
    }
  }
  return 0;
}
