import type { InputItem, SessionEvent } from '@shared/types';
import { describeTool } from '@shared/tool-labels';
import { formatEvent, safeText } from './format';

export class Transcript {
  readonly events = new Map<string, SessionEvent>();
  private readonly printed = new Set<string>();
  private readonly active = new Map<string, SessionEvent>();
  expanded = false;

  constructor(private readonly write: (text: string) => void, private readonly colored: boolean) {}

  consume(events: SessionEvent[]): void {
    for (const event of events) {
      this.events.set(event.id, event);
      if ((event.kind === 'assistant' || event.kind === 'reasoning') && event.streaming || event.kind === 'tool' && event.status === 'running') {
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
      if (event.kind === 'assistant') return safeText(event.text).replace(/\ue200[^\ue201]*\ue201/g, '');
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

  expand(): void {
    this.expanded = !this.expanded;
  }

  details(): string | null {
    if (!this.expanded) return null;
    const last = [...this.events.values()].filter((event) => event.kind === 'tool').at(-1);
    return last ? formatEvent(last, false, true)?.trim() ?? null : null;
  }
}
