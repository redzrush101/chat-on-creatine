import type { InputItem, SessionEvent } from '@shared/types';
import { describeTool } from '@shared/tool-labels';
import { DIM, color, indent, screenColumns } from './format';
import { markdown } from './markdown';
import { settled } from '@shared/markdown-stream';
import { safeText } from './format';
import { cited, duration, eventRows, formatEvent, type RenderOptions } from './render';
import { EventHistory } from '@shared/event-history';

/** Streams one session into scrollback: finished rows are written once, unfinished ones stay live. */
export class Transcript {
  expanded = false;
  private readonly history = new EventHistory();
  readonly events = this.history.events;
  private readonly printed = new Set<string>();
  private readonly active = new Map<string, SessionEvent>();
  /**
   * The part of each streamed message already in scrollback, as ChatGPT's raw text: it always ends
   * between two blocks, and citation metadata arriving later cannot shift it.
   */
  private readonly written = new Map<string, string>();
  private live: { key: string; rows: string[] } | null = null;
  private turnStart: number | null = null;
  private version = 0;
  private details: { key: string; rows: string[] } | null = null;
  private readonly detailRows = new Map<string, { event: SessionEvent; columns: number; rows: string[] }>();

  constructor(private readonly write: (text: string) => void, private readonly colored: boolean) {}

  private options(expanded = this.expanded, columns = screenColumns()): RenderOptions {
    return { colored: this.colored, columns, expanded };
  }

  consume(events: SessionEvent[]): void {
    for (const event of events) {
      this.history.merge([event]);
      if (this.events.get(event.id) !== event) continue;
      this.version++;
      if (event.kind === 'assistant') {
        if (event.streaming && this.printed.has(event.id)) continue;
        if (event.streaming) this.active.set(event.id, event);
        else this.active.delete(event.id);
        this.writeAssistant(event);
        if (!event.streaming) this.printed.add(event.id);
        continue;
      }
      if (event.kind === 'reasoning' && event.streaming || event.kind === 'tool' && event.status === 'running') {
        this.active.set(event.id, event); continue;
      }
      this.active.delete(event.id);
      if (this.printed.has(event.id)) continue;
      this.printed.add(event.id);
      if (event.kind === 'turn') this.onTurn(event);
      const text = formatEvent(event, { ...this.options(), agentStarted: this.agentStarted(event) });
      if (text) this.write(text);
    }
  }

  /** When the current turn started, for the spinner's elapsed time. */
  get since(): number | null { return this.turnStart; }

  /** The gerund for the spinner line: what the turn is doing right now. */
  activity(): string {
    const latest = [...this.active.values()].at(-1);
    if (latest?.kind === 'tool') return describeTool(latest).active;
    if (latest?.kind === 'reasoning') return 'Thinking';
    if (latest?.kind === 'assistant') return 'Responding';
    return 'Working';
  }

  /** Live rows: the unfinished block of a streamed reply and the calls still running. */
  preview(columns = screenColumns()): string[] {
    const key = `${this.version}:${columns}`;
    if (this.live?.key === key) return this.live.rows;
    const rows = [...this.active.values()].flatMap((event) => {
      if (event.kind === 'assistant') {
        const text = safeText(event.text);
        const written = this.written.get(event.id) ?? '';
        const rest = cited(text.startsWith(written) ? text.slice(written.length) : text, event.citations);
        if (!rest.trim()) return [];
        return ['', ...indent(markdown(rest, this.colored, columns - 2), columns, written ? '  ' : this.marker(event))];
      }
      if (event.kind === 'tool') return ['', ...eventRows(event, this.options(false, columns))];
      return [];
    });
    this.live = { key, rows };
    return rows;
  }

  echo(input: InputItem): void {
    this.turnStart ??= input.createdAt;
    this.consume([{ kind: 'user', id: `input:${input.id}`, at: input.createdAt, text: input.text, inputId: input.id, attachments: input.attachments, source: 'app' }]);
  }

  finish(): void {
    this.consume([...this.active.values()].map((event): SessionEvent =>
      event.kind === 'assistant' || event.kind === 'reasoning' ? { ...event, streaming: false } : event));
    this.active.clear();
  }

  /** Every event in full, for the Ctrl+O transcript. */
  transcript(columns: number): string[] {
    const key = `${this.version}:${columns}`;
    if (this.details?.key !== key) {
      const options = this.options(true, columns);
      this.details = { key, rows: [...this.events.values()].flatMap((event) => {
        const cached = this.detailRows.get(event.id);
        if (cached?.event === event && cached.columns === columns) return cached.rows;
        const rows = eventRows(event, options);
        const result = rows.length ? ['', ...rows] : [];
        this.detailRows.set(event.id, { event, columns, rows: result });
        return result;
      }) };
    }
    return this.details.rows;
  }

  private agentStarted(event: SessionEvent): number | undefined {
    if (event.kind !== 'agent' || event.action !== 'finished') return undefined;
    return [...this.events.values()].find((item) => item.kind === 'agent' && item.action === 'spawned' && item.workerSessionId === event.workerSessionId)?.at;
  }

  private onTurn(event: Extract<SessionEvent, { kind: 'turn' }>): void {
    if (event.phase === 'start') { this.turnStart ??= event.at; return; }
    if (event.outcome === 'done' && this.turnStart !== null) this.write(`\n${color(DIM, `✻ Worked for ${duration(event.at - this.turnStart)}`, this.colored)}\n`);
    this.turnStart = null;
  }

  private writeAssistant(event: Extract<SessionEvent, { kind: 'assistant' }>): void {
    const text = safeText(event.text);
    const committed = this.written.get(event.id) ?? '';
    if (!text.startsWith(committed)) {
      // A printed reply stays as printed, and a final snapshot may only trim trailing whitespace.
      if (this.printed.has(event.id) || committed.startsWith(text.trimEnd()) && !text.slice(committed.trimEnd().length).trim()) return;
      // Otherwise the reply was revised; it is committed once it settles.
      if (!event.streaming) this.write(formatEvent(event, this.options())!);
      return;
    }
    const end = event.streaming ? committed.length + settled(text.slice(committed.length)) : text.length;
    const chunk = cited(text.slice(committed.length, end), event.citations);
    if (!chunk.trim()) return;
    const columns = screenColumns();
    const rows = indent(markdown(chunk, this.colored, columns - 2), columns, committed ? '  ' : this.marker(event));
    if (rows.length) this.write(`\n${rows.join('\n')}\n`);
    this.written.set(event.id, text.slice(0, end));
  }

  private marker(event: Extract<SessionEvent, { kind: 'assistant' }>): string {
    return `${color(event.channel === 'final' ? 39 : DIM, '●', this.colored)} `;
  }
}
