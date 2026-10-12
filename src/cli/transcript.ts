import type { InputItem, SessionEvent } from '@shared/types';
import { describeTool } from '@shared/tool-labels';
import { assistantText, color, formatEvent, markdown, safeText } from './format';

export class Transcript {
  readonly events = new Map<string, SessionEvent>();
  private readonly printed = new Set<string>();
  private readonly active = new Map<string, SessionEvent>();
  private readonly written = new Map<string, string>();
  expanded = false;

  constructor(private readonly write: (text: string) => void, private readonly colored: boolean) {}

  consume(events: SessionEvent[]): void {
    for (const event of events) {
      this.events.set(event.id, event);
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
      const text = formatEvent(event, this.colored);
      if (text) this.write(text);
      this.printed.add(event.id);
    }
  }

  preview(): string {
    return [...this.active.values()].slice(-3).map((event) => {
      if (event.kind === 'assistant') {
        const text = assistantText(event);
        const written = this.written.get(event.id) ?? '';
        return text.startsWith(written) ? text.slice(written.length) : text;
      }
      if (event.kind === 'reasoning') return this.expanded ? `Thinking · ${safeText(event.text)}` : 'Thinking…';
      if (event.kind === 'tool') {
        const label = describeTool(event);
        return `${label.active}${label.target ? ` ${safeText(label.target)}` : ''}`;
      }
      return '';
    }).filter(Boolean).join('\n');
  }

  echo(input: InputItem): void {
    this.consume([{ kind: 'user', id: `input:${input.id}`, at: input.createdAt, text: input.text, inputId: input.id, attachments: input.attachments, source: 'app' }]);
  }

  finish(): void {
    this.consume([...this.active.values()].map((event): SessionEvent =>
      event.kind === 'assistant' || event.kind === 'reasoning' ? { ...event, streaming: false } : event));
    this.active.clear();
  }

  private writeAssistant(event: Extract<SessionEvent, { kind: 'assistant' }>): void {
    const text = assistantText(event);
    const previous = this.written.get(event.id) ?? '';
    const next = event.streaming ? text.slice(0, text.lastIndexOf('\n') + 1) : text;
    if (next === previous) {
      if (!event.streaming && previous && !this.printed.has(event.id)) this.write('\n');
      return;
    }
    if (!next.trim()) return;
    // Completed lines belong to scrollback. A revised snapshot is committed when it settles.
    if (!next.startsWith(previous)) {
      if (event.streaming) return;
      this.write(formatEvent(event, this.colored)!);
    } else {
      const fenced = previous.split('\n').filter((line) => line.startsWith('```')).length % 2 === 1;
      const opening = previous ? '' : `\n${color(event.channel === 'final' ? 32 : 90, '●', this.colored)} `;
      this.write(`${opening}${markdown(next.slice(previous.length), this.colored, fenced)}${event.streaming ? '' : '\n'}`);
    }
    this.written.set(event.id, next);
  }

  expand(): void {
    this.expanded = !this.expanded;
  }

  details(): string | null {
    if (!this.expanded) return null;
    return [...this.events.values()].filter((event) => event.kind === 'tool')
      .map((event) => formatEvent(event, false, true)).join('\n').trim() || null;
  }
}
