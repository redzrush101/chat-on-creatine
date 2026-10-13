import { memo, useContext, useMemo } from 'react';
import { Check, CircleAlert, CircleDot, Copy, Download, Info, Paperclip, PencilLine, TriangleAlert } from 'lucide-react';
import type { Citation, SessionEvent, WorkerState } from '@shared/types';
import { resolveMarkers, stripMarkers } from '../../lib/citations';
import { renderMarkdown } from '../../lib/markdown';
import { useAppState } from '../../lib/store';
import { basename, cx, formatAgo } from '../../lib/format';
import { useCopy } from '../../lib/hooks';
import { ToolRow } from './ToolCard';
import { SourcesContext } from './sources';
import { downloadText } from '../../lib/download';

export interface EventActions {
  onOpenSession(sessionId: string): void;
  /** Puts a sent message back into the composer to edit and send again. */
  onReuse(text: string): void;
}

interface EventRowProps {
  event: SessionEvent;
  actions: EventActions;
}

/** One timeline row. Memoized by event object: the store keeps unchanged events' identity. */
export const EventRow = memo(function EventRow({ event, actions }: EventRowProps) {
  switch (event.kind) {
    case 'user':
      return (
        <div className="msg msg-user" data-event-id={event.id}>
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
          <div className="msg-actions">
            {event.source !== 'app' && <span className="msg-caption">sent from {event.source}</span>}
            <time className="msg-time" dateTime={new Date(event.at).toISOString()} title={new Date(event.at).toLocaleString()}>
              {formatAgo(event.at)}
            </time>
            <CopyButton text={event.text} />
            <button type="button" className="icon-btn msg-action" aria-label="Edit and resend" title="Edit and resend" onClick={() => actions.onReuse(event.text)}>
              <PencilLine size={13} />
            </button>
          </div>
        </div>
      );
    case 'assistant':
      return <AssistantText id={event.id} text={event.text} citations={event.citations} streaming={event.streaming} final={event.channel === 'final'} />;
    case 'reasoning':
      return (
        <details className="reasoning" open={event.streaming || undefined}>
          <summary>{event.streaming ? 'Thinking…' : 'Thought'}</summary>
          <div className="reasoning-text">{event.text}</div>
        </details>
      );
    case 'tool':
      return (
        <div className="steps">
          <ToolRow event={event} />
        </div>
      );
    case 'plan': {
      const done = event.items.filter((item) => item.status === 'completed').length;
      return (
        <section className="plan" aria-label="Plan">
          <header className="plan-head">
            <span>Plan</span>
            <span className="plan-count">
              {done} of {event.items.length} done
            </span>
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
    }
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
      return <AgentRow event={event} onOpen={() => actions.onOpenSession(event.workerSessionId)} />;
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

const AGENT_VERB = { spawned: 'Started agent', messaged: 'Messaged agent', finished: 'Agent finished', woke: 'Agent resumed' } as const;
const WORKER_STATE: Record<WorkerState, string> = { queued: 'Queued', working: 'Running', asleep: 'Idle', finished: 'Finished', failed: 'Stopped' };

/** "Started agent  Verify llm-agents flake  Running": the worker title opens its transcript. */
function AgentRow({ event, onOpen }: { event: Extract<SessionEvent, { kind: 'agent' }>; onOpen(): void }) {
  const app = useAppState();
  const worker = app?.agents.flatMap((run) => run.workers).find((item) => item.sessionId === event.workerSessionId);
  return (
    <div className="agent-row">
      <span className="agent-verb">{AGENT_VERB[event.action]}</span>
      <button type="button" className="agent-label" title={event.text || 'Open the agent transcript'} onClick={onOpen}>
        {event.label}
      </button>
      {worker && <span className={cx('agent-state', `is-${worker.state}`)}>{WORKER_STATE[worker.state]}</span>}
    </div>
  );
}

function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [copied, copy] = useCopy();
  return (
    <button type="button" className="icon-btn msg-action" aria-label={label} title={copied ? 'Copied' : label} onClick={() => copy(text)}>
      {copied ? <Check size={13} /> : <Copy size={13} />}
    </button>
  );
}

function AssistantText({ id, text, citations, streaming, final }: { id: string; text: string; citations: Citation[] | undefined; streaming: boolean; final: boolean }) {
  const sources = useContext(SourcesContext);
  const html = useMemo(() => renderMarkdown(resolveMarkers(text, citations, sources)), [text, citations, sources]);
  return (
    <div className={cx('msg msg-assistant', !final && 'is-commentary', streaming && 'is-streaming')} data-event-id={id}>
      <div className="md" dangerouslySetInnerHTML={{ __html: html }} />
      {streaming && <span className="caret" aria-hidden="true" />}
      {final && !streaming && text.trim() && (
        <div className="msg-actions is-start">
          <CopyButton text={stripMarkers(text)} label="Copy answer" />
          <button type="button" className="icon-btn msg-action" aria-label="Save answer" title="Save answer as Markdown" onClick={() => downloadText(`answer-${id}.md`, `${stripMarkers(text)}\n`)}>
            <Download size={13} aria-hidden="true" />
          </button>
        </div>
      )}
    </div>
  );
}
