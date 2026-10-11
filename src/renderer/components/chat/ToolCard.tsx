import { memo, useState } from 'react';
import { Check, ChevronRight, CircleAlert, Image, LoaderCircle, MessageSquare, Puzzle, Terminal, Wrench } from 'lucide-react';
import type { SessionEvent, ToolOutputPart } from '@shared/types';
import { basename, cx, formatDuration, toolArgSummary } from '../../lib/format';

type ToolEvent = Extract<SessionEvent, { kind: 'tool' }>;

const SURFACE_ICON = {
  core: Terminal,
  desktop: Wrench,
  plugins: Puzzle,
  chatgpt: MessageSquare
} as const;

export const ToolCard = memo(function ToolCard({ event }: { event: ToolEvent }) {
  const [open, setOpen] = useState(false);
  const Surface = SURFACE_ICON[event.surface];
  const duration = event.endedAt !== null ? formatDuration(event.endedAt - event.at) : null;
  const summary = toolArgSummary(event.args);

  return (
    <div className={cx('tool', `is-${event.status}`)}>
      <button type="button" className="tool-head" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <Surface size={13} className="tool-surface" aria-hidden="true" />
        <span className="tool-name">{event.name}</span>
        {summary && <span className="tool-arg">{summary}</span>}
        <span className="tool-trail">
          {duration && <span className="tool-duration">{duration}</span>}
          {event.status === 'running' && <LoaderCircle size={13} className="spin" aria-label="Running" />}
          {event.status === 'ok' && <Check size={13} className="tool-ok" aria-label="Done" />}
          {event.status === 'error' && <CircleAlert size={13} className="tool-error" aria-label="Failed" />}
          <ChevronRight size={12} className={cx('chevron', open && 'is-open')} aria-hidden="true" />
        </span>
      </button>
      {open && (
        <div className="tool-body">
          <pre className="tool-args">{safeJson(event.args)}</pre>
          {event.output.map((part, index) => (
            <OutputPart key={index} part={part} />
          ))}
          {event.status === 'running' && event.output.length === 0 && <p className="out-note">Running…</p>}
        </div>
      )}
    </div>
  );
});

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}

function OutputPart({ part }: { part: ToolOutputPart }) {
  if (part.type === 'exec') {
    return (
      <div className="term">
        <div className="term-cmd">
          <span className="term-prompt" aria-hidden="true">$</span>
          <code className="term-command">{part.command}</code>
          {part.cwd && <span className="term-cwd" title={part.cwd}>{basename(part.cwd)}</span>}
          {part.running ? (
            <span className="term-exit is-running">running</span>
          ) : part.exitCode !== null ? (
            <span className={cx('term-exit', part.exitCode === 0 ? 'is-ok' : 'is-fail')}>exit {part.exitCode}</span>
          ) : null}
        </div>
        {part.output && <pre className="term-out">{part.output}</pre>}
      </div>
    );
  }
  if (part.type === 'diff') return <DiffView path={part.path} diff={part.diff} added={part.added} removed={part.removed} />;
  if (part.type === 'image') {
    return (
      <div className="out-note">
        <Image size={13} aria-hidden="true" /> <span title={part.path}>{basename(part.path)}</span>
        <span className="out-muted">{part.mime}</span>
      </div>
    );
  }
  return (
    <pre className="out-pre">
      {part.text}
      {part.truncated && <span className="out-note"> …truncated</span>}
    </pre>
  );
}

export function DiffView({ path, diff, added, removed }: { path: string; diff: string; added: number; removed: number }) {
  const lines = diff.split('\n');
  return (
    <div className="diff">
      <div className="diff-head">
        <span className="diff-path" title={path}>{path}</span>
        <span className="diff-add">+{added}</span>
        <span className="diff-del">−{removed}</span>
      </div>
      <pre className="diff-body">
        {lines.map((line, index) => {
          const kind =
            line.startsWith('@@') ? 'hunk'
            : line.startsWith('+++') || line.startsWith('---') ? 'meta'
            : line.startsWith('+') ? 'add'
            : line.startsWith('-') ? 'del'
            : 'ctx';
          return (
            <span key={index} className={`diff-line is-${kind}`}>
              {line || ' '}
              {'\n'}
            </span>
          );
        })}
      </pre>
    </div>
  );
}

