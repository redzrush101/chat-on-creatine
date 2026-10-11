import { memo, useMemo } from 'react';
import { Bot, Check, CircleAlert, CircleDot, Info, ListTodo, Paperclip, TriangleAlert } from 'lucide-react';
import type { SessionEvent } from '@shared/types';
import { renderMarkdown } from '../../lib/markdown';
import { basename, cx } from '../../lib/format';
import { ToolCard } from './ToolCard';

interface EventRowProps {
  event: SessionEvent;
  onOpenSession(sessionId: string): void;
}

/** One timeline row. Memoized by event object: the store keeps unchanged events' identity. */
export const EventRow = memo(function EventRow({ event, onOpenSession }: EventRowProps) {
  switch (event.kind) {
    case 'user':
      return (
        <div className="msg msg-user">
          <div className="bubble">{event.text}</div>
          {event.attachments.length > 0 && (
            <div className="attachments">
              {event.attachments.map((file) => (
                <span key={file.id} className="file-chip" title={file.path}>
                  <Paperclip size={12} aria-hidden="true" />
                  {file.name || basename(file.path)}
                </span>
              ))}
            </div>
          )}
          {event.source !== 'app' && <div className="msg-caption">sent from {event.source}</div>}
        </div>
      );
    case 'assistant':
      return <AssistantText text={event.text} streaming={event.streaming} commentary={event.channel === 'commentary'} />;
    case 'reasoning':
      return (
        <details className="reasoning" open={event.streaming || undefined}>
          <summary>
            <span>{event.streaming ? 'Thinking…' : 'Thought'}</span>
          </summary>
          <div className="reasoning-text">{event.text}</div>
        </details>
      );
    case 'tool':
      return <ToolCard event={event} />;
    case 'plan':
      return (
        <section className="plan" aria-label="Plan">
          <header className="plan-head">
            <ListTodo size={13} aria-hidden="true" />
            <span>Plan</span>
          </header>
          {event.explanation && <p className="plan-explanation">{event.explanation}</p>}
          <ol className="plan-items">
            {event.items.map((item, index) => (
              <li key={index} className={cx('plan-item', `is-${item.status}`)}>
                <span className="plan-icon" aria-hidden="true">
                  {item.status === 'completed' ? <Check size={13} /> : item.status === 'in_progress' ? <CircleDot size={13} /> : <span className="plan-empty" />}
                </span>
                <span>{item.step}</span>
              </li>
            ))}
          </ol>
        </section>
      );
    case 'turn':
      if (event.outcome === null || event.outcome === 'done' || event.phase === 'start') return null;
      return (
        <div className={cx('turn-end', `is-${event.outcome}`)} role="status">
          <span>{event.outcome === 'stopped' ? 'Stopped' : event.outcome === 'incomplete' ? 'Answer cut off' : 'Turn failed'}</span>
          {event.error && <span className="turn-error">{event.error}</span>}
        </div>
      );
    case 'notice': {
      const Icon = event.level === 'error' ? CircleAlert : event.level === 'warn' ? TriangleAlert : Info;
      return (
        <div className={cx('notice', `is-${event.level}`)} role="status">
          <Icon size={13} aria-hidden="true" />
          <span>{event.text}</span>
        </div>
      );
    }
    case 'agent':
      return (
        <div className="agent-row">
          <Bot size={13} aria-hidden="true" />
          <span className="agent-label">{event.label}</span>
          <span className="agent-action">{event.text || event.action}</span>
          <button type="button" className="link-btn" onClick={() => onOpenSession(event.workerSessionId)}>
            Open worker
          </button>
        </div>
      );
    case 'handoff':
      return (
        <div className="handoff">
          <div className="divider">
            <span>Continued in a new ChatGPT chat</span>
          </div>
          {event.brief && (
            <details className="handoff-brief">
              <summary>Brief</summary>
              <div className="reasoning-text">{event.brief}</div>
            </details>
          )}
        </div>
      );
  }
  return null;
});

function AssistantText({ text, streaming, commentary }: { text: string; streaming: boolean; commentary: boolean }) {
  const html = useMemo(() => renderMarkdown(text), [text]);
  return (
    <div className={cx('msg msg-assistant', commentary && 'is-commentary', streaming && 'is-streaming')}>
      <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
      {streaming && <span className="caret" aria-hidden="true" />}
    </div>
  );
}
