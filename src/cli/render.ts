import { diffRows, describeTool, toolBaseName, type ToolLabel } from '@shared/tool-labels';
import type { SessionEvent, ToolOutputPart } from '@shared/types';
import { ACCENT, DIM, color, ellipsis, indent, safeText, tilde, width } from './format';
import { CITE, markdown } from './markdown';

type ToolEvent = Extract<SessionEvent, { kind: 'tool' }>;

export interface RenderOptions {
  colored: boolean;
  columns: number;
  /** The Ctrl+O transcript: arguments, full output and thinking. */
  expanded?: boolean;
  /** When the agent of a `finished` row started, for its run time. */
  agentStarted?: number;
}

/** Rows of a normal-view tool result before the rest folds into "… +N lines". */
const PREVIEW_ROWS = 3;
const DIFF_ROWS = 12;

type Citation = NonNullable<Extract<SessionEvent, { kind: 'assistant' }>['citations']>[number];

/** The host a citation points at; stable while ChatGPT is still filling in its source titles. */
function host(source: Citation['sources'][number]): string {
  return URL.canParse(source.url) ? new URL(source.url).hostname.replace(/^www\./, '') : source.domain;
}

/** Text with ChatGPT's citation markers as source hosts; markers without metadata are dropped. */
export function cited(text: string, citations: Citation[] = []): string {
  for (const citation of citations) {
    const hosts = [...new Set(citation.sources.map(host))];
    text = text.split(citation.marker).map((part, index, parts) => index < parts.length - 1 ? part.trimEnd() : part)
      .join(hosts.length ? ` ${CITE[0]}${hosts.join(', ')}${CITE[1]}` : '');
  }
  return text.replace(/\ue200[^\ue201]*\ue201/g, '').replace(/\ue200[^\ue201]*$/, '');
}

export function assistantText(event: Extract<SessionEvent, { kind: 'assistant' }>): string {
  return cited(safeText(event.text), event.citations);
}

/** A prompt on its own shaded band, as Claude Code shows what you typed. */
export function userRows(text: string, options: RenderOptions): string[] {
  const rows = indent(safeText(text).split('\n').map((line) => ({ text: line, hang: 0 })), options.columns, '❯ ');
  return options.colored ? rows.map((row) => color('bg-input', `${row}${' '.repeat(Math.max(0, options.columns - width(row)))}`, true)) : rows;
}

/** Result rows under a `⎿` elbow, the way Claude Code nests output below its call. */
export function nested(lines: string[], options: RenderOptions, hang = 0): string[] {
  return indent(lines.map((text) => ({ text, hang })), options.columns, `  ${color(DIM, '⎿', options.colored)}  `, '     ');
}

function bullet(code: number | string, options: RenderOptions): string {
  return `${color(code, '●', options.colored)} `;
}

/** Claude Code's tool names, so a step reads `Bash(npm test)` or `Update(app.ts)`. */
function toolTitle(event: ToolEvent, label: ToolLabel): { name: string; target: string | null } {
  const target = label.target;
  switch (label.category) {
    case 'command':
      if (toolBaseName(event.name) === 'write_stdin') return { name: label.verb === 'Checked' ? 'BashOutput' : 'BashInput', target };
      return { name: 'Bash', target: label.code ? target : null };
    case 'script': return { name: 'Script', target: target?.replace(/^using /, '') ?? null };
    case 'read': return { name: 'Read', target };
    case 'search': return { name: 'Search', target };
    case 'edit': return { name: 'Update', target };
    case 'create': return { name: 'Write', target };
    case 'delete': return { name: 'Delete', target };
    case 'web': return { name: 'Web Search', target };
    case 'open': return { name: 'Fetch', target };
    case 'plan': return { name: 'Update Todos', target: null };
    case 'image': return { name: 'View', target };
    default: return { name: `${label.verb}${target ? ` ${target}` : ''}`, target: null };
  }
}

/**
 * Steps whose story another row tells: plans print as todos, scripts as their nested calls, and
 * agent calls (spawning, messaging, polling) as the agent rows and live worker progress.
 */
function hiddenTool(event: ToolEvent, label: ToolLabel): boolean {
  return event.status !== 'error' && ['plan', 'script', 'agent'].includes(label.category);
}

/** `Bash(npm test)`: a call as one plain line, for worker progress. */
export function toolHeadline(event: ToolEvent): string {
  const title = toolTitle(event, describeTool(event));
  return title.target === null ? title.name : `${title.name}(${safeText(title.target)})`;
}

function fold(lines: string[], limit: number, options: RenderOptions): string[] {
  if (lines.length <= limit) return lines;
  return [...lines.slice(0, limit), color(DIM, `… +${lines.length - limit} lines (ctrl+o to expand)`, options.colored)];
}

function trimmed(text: string): string[] {
  const lines = safeText(text).replace(/^(\s*\n)+/, '').replace(/\s+$/, '').split('\n');
  return lines.length === 1 && !lines[0] ? [] : lines;
}

function diffLines(part: Extract<ToolOutputPart, { type: 'diff' }>, options: RenderOptions): string[] {
  const rows = diffRows(part.diff);
  const digits = String(rows.reduce((max, row) => Math.max(max, row.line ?? 0), 0)).length;
  const room = options.columns - 7 - digits - 3;
  return rows.map((row) => {
    if (row.kind === 'gap') return color(DIM, `${' '.repeat(digits)}   ⋮`, options.colored);
    const mark = row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' ';
    const text = `${String(row.line ?? '').padStart(digits)} ${mark} ${ellipsis(safeText(row.text), room)}`;
    return color(row.kind === 'add' ? 32 : row.kind === 'del' ? 31 : DIM, text, options.colored);
  });
}

function diffSummary(part: Extract<ToolOutputPart, { type: 'diff' }>, options: RenderOptions): string {
  const path = color(1, tilde(safeText(part.path)), options.colored);
  const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? '' : 's'}`;
  if (/^--- \/dev\/null/m.test(part.diff)) return `Wrote ${plural(part.added, 'line')} to ${path}`;
  if (/^\+\+\+ \/dev\/null/m.test(part.diff)) return `Deleted ${path}`;
  return `Updated ${path} with ${plural(part.added, 'addition')} and ${plural(part.removed, 'removal')}`;
}

/** "Read 13 lines" from the read tool's per-path headers; anything else stays as written. */
function readSummary(lines: string[]): string[] {
  const parsed = lines.map((line) => /lines (\d+)-(\d+) of \d+\)$/.exec(line) ?? /\((\d+) entries\)$/.exec(line));
  if (!parsed.every(Boolean)) return lines.map(tilde);
  if (lines.length > 1) return [`Read ${lines.length} paths`];
  const match = parsed[0]!;
  const count = match.length === 3 ? Number(match[2]) - Number(match[1]) + 1 : Number(match[1]);
  return [match.length === 3 ? `Read ${count} line${count === 1 ? '' : 's'}` : `Listed ${count} entr${count === 1 ? 'y' : 'ies'}`];
}

function toolResult(event: ToolEvent, label: ToolLabel, options: RenderOptions): string[] {
  const { colored, expanded } = options;
  if (event.status === 'running') return [color(DIM, 'Running…', colored)];
  const preview = (lines: string[]) => fold(lines.map((line) => ellipsis(line, options.columns - 5)), PREVIEW_ROWS, options);
  const rows: string[] = [];
  let diffBudget = expanded ? Infinity : DIFF_ROWS;
  for (const part of event.output) {
    switch (part.type) {
      case 'exec': {
        const lines = trimmed(part.output);
        rows.push(...expanded ? lines : preview(lines));
        if (part.running) rows.push(color(DIM, `Running in the background · process ${part.sessionId}`, colored));
        else if (part.exitCode !== 0 && part.exitCode !== null) rows.push(color(31, `Exit code ${part.exitCode}`, colored));
        else if (!lines.length) rows.push(color(DIM, '(No output)', colored));
        break;
      }
      case 'diff': {
        rows.push(diffSummary(part, options));
        const lines = diffLines(part, options);
        const shown = lines.slice(0, Math.max(0, diffBudget));
        diffBudget -= shown.length;
        rows.push(...shown);
        if (shown.length < lines.length) rows.push(color(DIM, `… +${lines.length - shown.length} lines (ctrl+o to expand)`, colored));
        break;
      }
      case 'image': rows.push(`Viewed ${tilde(safeText(part.path))}`); break;
      case 'sources': {
        const lines = part.sources.map((source) => `${safeText(source.title || source.url)} ${color(DIM, `· ${safeText(source.domain)}`, colored)}`);
        rows.push(...expanded ? part.sources.map((source) => `${safeText(source.title)} · ${safeText(source.url)}`) : fold(lines, PREVIEW_ROWS, options));
        break;
      }
      case 'text': {
        const lines = trimmed(part.text);
        if (event.status === 'error') rows.push(...lines.map((line) => color(31, line, colored)));
        else if (expanded) rows.push(...lines);
        else rows.push(...preview(label.category === 'read' ? readSummary(lines) : lines));
      }
    }
  }
  return rows.length ? rows : [color(DIM, event.status === 'error' ? 'Failed' : 'Done', colored)];
}

/** What the model sent, for the expanded view: the full command, script or arguments. */
function toolArguments(event: ToolEvent, label: ToolLabel, colored: boolean): string[] {
  const args = (event.args ?? {}) as Record<string, unknown>;
  if (label.category === 'command') {
    const command = event.output.find((part) => part.type === 'exec');
    const text = command?.type === 'exec' ? command.command : typeof args.cmd === 'string' ? args.cmd : null;
    if (text) return safeText(text).split('\n').map((line, index) => color(DIM, `${index ? ' ' : '$'} ${line}`, colored));
  }
  if (label.category === 'script' && typeof args.code === 'string') return safeText(args.code).split('\n').map((line) => color(DIM, line, colored));
  // Reads list their paths in the result, and edits show their diffs.
  if (label.category === 'read' || ['edit', 'create', 'delete'].includes(label.category) && event.output.some((part) => part.type === 'diff')) return [];
  const text = typeof event.args === 'string' ? event.args : JSON.stringify(event.args, null, 2) ?? '';
  return text && text !== '{}' ? safeText(text).split('\n').map((line) => color(DIM, line, colored)) : [];
}

export function toolRows(event: ToolEvent, options: RenderOptions): string[] {
  const label = describeTool(event);
  if (!options.expanded && hiddenTool(event, label)) return [];
  const { colored, columns } = options;
  const title = toolTitle(event, label);
  const dot = event.status === 'error' ? 31 : event.status === 'running' ? DIM : 32;
  const head = title.target === null ? color(1, title.name, colored)
    : `${color(1, title.name, colored)}(${ellipsis(safeText(title.target), Math.max(10, columns - width(title.name) - 4))})`;
  const files = label.files.length > 1 ? color(DIM, ` · ${label.files.length} files`, colored) : '';
  const result = toolResult(event, label, options);
  const args = options.expanded ? toolArguments(event, label, colored) : [];
  return [`${bullet(dot, options)}${head}${files}`, ...indent(args.map((text) => ({ text, hang: 2 })), columns, '     ', '     '), ...result.length ? nested(result, options) : []];
}

export function planRows(event: Extract<SessionEvent, { kind: 'plan' }>, options: RenderOptions): string[] {
  const { colored } = options;
  const items = event.items.map((item) => item.status === 'completed' ? color(DIM, `☒ ${safeText(item.step)}`, colored)
    : item.status === 'in_progress' ? color(1, `☐ ${safeText(item.step)}`, colored) : `☐ ${safeText(item.step)}`);
  const explanation = event.explanation ? [color(DIM, safeText(event.explanation), colored)] : [];
  return [`${bullet(32, options)}${color(1, 'Update Todos', colored)}`, ...nested([...items, ...explanation], options, 2)];
}

/** Scrollback rows for one event, or nothing when the normal view leaves it out. */
export function eventRows(event: SessionEvent, options: RenderOptions): string[] {
  const { colored, columns, expanded } = options;
  switch (event.kind) {
    case 'user': {
      const rows = userRows(event.text, options);
      return event.attachments.length ? [...rows, ...nested([color(DIM, `Attached ${event.attachments.map((file) => safeText(file.name)).join(', ')}`, colored)], options)] : rows;
    }
    case 'assistant': {
      const text = assistantText(event);
      return text.trim() ? indent(markdown(text, colored, columns - 2), columns, bullet(event.channel === 'final' ? 39 : DIM, options)) : [];
    }
    case 'tool': return toolRows(event, options);
    case 'plan': return planRows(event, options);
    case 'notice': return indent([{ text: safeText(event.text), hang: 0 }], columns, bullet(event.level === 'error' ? 31 : event.level === 'warn' ? 33 : DIM, options));
    case 'agent': {
      // Claude Code's shape: a compact start row, message rows, and a finish line; Ctrl+O has the text.
      const name = safeText(event.label);
      const details = expanded ? nested(trimmed(event.text), options) : [];
      const hint = expanded ? '' : color(DIM, ' (ctrl+o to expand)', colored);
      switch (event.action) {
        case 'spawned': return [`${bullet(32, options)}${color(1, 'Agent', colored)}(${name})`, ...nested([`Started in the background${hint}`], options), ...details];
        case 'messaged': return [`${color(DIM, '›', colored)} ${color(DIM, `Message to @${name}`, colored)}${hint}`, ...details];
        case 'woke': return [`${color(DIM, '›', colored)} ${color(DIM, `@${name} picked up a new message`, colored)}`, ...details];
        case 'finished': {
          const took = options.agentStarted === undefined ? '' : color(DIM, ` · ${duration(event.at - options.agentStarted)}`, colored);
          return [`${bullet(32, options)}Agent "${name}" finished${took}${hint}`, ...details];
        }
      }
    }
    case 'handoff': return [color(ACCENT, '✻ Compacted · continuing in a fresh conversation', colored)];
    case 'reasoning': return expanded && event.text.trim() ? indent(safeText(event.text).split('\n').map((text) => ({ text: color(DIM, text, colored), hang: 0 })), columns, color(DIM, '✻ ', colored)) : [];
    case 'turn':
      if (event.phase !== 'end' || event.outcome === 'done' || event.outcome === null) return [];
      return nested([color(event.outcome === 'error' ? 31 : 33, event.error ?? (event.outcome === 'stopped' ? 'Interrupted' : `Turn ${event.outcome}`), colored)], options);
  }
}

/** One block of scrollback text: a blank line, then the rows. */
export function formatEvent(event: SessionEvent, options: RenderOptions): string | null {
  const rows = eventRows(event, options);
  return rows.length ? `\n${rows.join('\n')}\n` : null;
}

export function duration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  return minutes < 60 ? `${minutes}m ${String(seconds % 60).padStart(2, '0')}s` : `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}
