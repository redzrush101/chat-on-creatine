import { stripVTControlCharacters } from 'node:util';
import { diffRows, describeTool } from '@shared/tool-labels';
import type { SessionEvent, ToolOutputPart } from '@shared/types';

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

export const color = (code: number, text: string, enabled = true): string => enabled ? `\x1b[${code}m${text}\x1b[0m` : text;

export function markdown(text: string, colored: boolean): string {
  let fenced = false;
  return safeText(text).split('\n').map((line) => {
    if (line.startsWith('```')) { fenced = !fenced; return color(90, line, colored); }
    if (fenced) return color(line.startsWith('+') ? 32 : line.startsWith('-') ? 31 : 36, line, colored);
    return line.replace(/^#{1,6}\s+(.+)$/, (_match, heading: string) => color(1, heading, colored))
      .replace(/\*\*(.+?)\*\*/g, (_match, body: string) => color(1, body, colored))
      .replace(/`([^`]+)`/g, (_match, body: string) => color(36, body, colored));
  }).join('\n');
}

function output(part: ToolOutputPart, colored: boolean): string[] {
  switch (part.type) {
    case 'text': return safeText(part.text).split('\n');
    case 'exec': return safeText(part.output).split('\n').concat(part.running ? [`Running · process ${part.sessionId}`] : [`Exit code ${part.exitCode}`]);
    case 'image': return [`Image: ${safeText(part.path)}`];
    case 'sources': return part.sources.map((source) => `${safeText(source.title)} — ${safeText(source.url)}`);
    case 'diff': return [`${safeText(part.path)} (+${part.added} -${part.removed})`, ...diffRows(part.diff).map((row) => {
      const prefix = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' ';
      return color(row.kind === 'add' ? 32 : row.kind === 'del' ? 31 : 90, `${String(row.line ?? '·').padStart(4)} ${prefix} ${safeText(row.text)}`, colored);
    })];
  }
}

export function formatEvent(event: SessionEvent, colored: boolean, expanded = false): string | null {
  switch (event.kind) {
    case 'user': return `\n${color(1, '›', colored)} ${safeText(event.text)}${event.attachments.length ? `\n  Attached: ${event.attachments.map((file) => safeText(file.name)).join(', ')}` : ''}\n`;
    case 'assistant': {
      let text = event.text;
      for (const citation of event.citations ?? []) text = text.replaceAll(citation.marker, citation.sources.map((source) => ` [${source.title}](${source.url})`).join(''));
      text = text.replace(/\ue200[^\ue201]*\ue201/g, '').replace(/\ue200[^\ue201]*$/, '');
      return text.trim() ? `\n${color(event.channel === 'final' ? 32 : 90, '●', colored)} ${markdown(text, colored)}\n` : null;
    }
    case 'tool': {
      const label = describeTool(event);
      const title = `${event.status === 'running' ? label.active : label.verb}${label.target ? ` ${safeText(label.target)}` : ''}`;
      const lines = event.output.flatMap((part) => output(part, colored)).filter((line) => line.trim());
      const limit = Math.max(30, (process.stdout.columns || 100) - 6);
      const selected = expanded || event.status === 'error' ? lines : lines.slice(0, 5);
      const shown = expanded ? selected : selected.map((line) => width(line) > limit ? `${clip(line, limit - 1)}…` : line);
      const hidden = shown.length < lines.length || selected.some((line) => width(line) > limit);
      return `\n${color(event.status === 'error' ? 31 : 36, '•', colored)} ${title}${label.files.length ? ` (+${label.files.reduce((n, f) => n + f.added, 0)} -${label.files.reduce((n, f) => n + f.removed, 0)})` : ''}\n` +
        shown.map((line, index) => `  ${index ? ' ' : '└'} ${line}`).join('\n') +
        (hidden ? color(90, `\n    ${lines.length > shown.length ? `+${lines.length - shown.length} lines · ` : ''}Ctrl+O to expand`, colored) : '') + '\n';
    }
    case 'plan': return `\n${color(36, 'Plan', colored)}${event.explanation ? ` · ${safeText(event.explanation)}` : ''}\n` + event.items.map((item) => `  ${item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '›' : '○'} ${safeText(item.step)}`).join('\n') + '\n';
    case 'notice': return `\n${color(event.level === 'error' ? 31 : event.level === 'warn' ? 33 : 90, safeText(event.text), colored)}\n`;
    case 'agent': return `\n${color(35, 'Agent', colored)} ${safeText(event.label)} · ${event.action}\n  ${safeText(event.text)}\n`;
    case 'handoff': return `\n${color(36, 'Compacted · continuing in a fresh conversation', colored)}\n`;
    case 'reasoning': return expanded && event.text.trim() ? `\n${color(90, safeText(event.text), colored)}\n` : null;
    case 'turn': return event.phase === 'end' && event.outcome !== 'done' ? `\n${color(event.outcome === 'error' ? 31 : 33, event.error ?? `Turn ${event.outcome}`, colored)}\n` : null;
  }
}
