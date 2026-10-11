import { memo, useMemo, useState } from 'react';
import hljs from 'highlight.js/lib/common';
import { ChevronDown, ChevronRight, CircleAlert, Copy, Check, Image, LoaderCircle } from 'lucide-react';
import type { SessionEvent, ToolOutputPart, WebSource } from '@shared/types';
import { basename, cx, formatDuration } from '../../lib/format';
import { useCopy } from '../../lib/hooks';
import { describeTool, diffRows } from './tool-labels';

type ToolEvent = Extract<SessionEvent, { kind: 'tool' }>;

/** One step inside a work group: "Ran `ls -la`", expandable to its command, output or diff. */
export const ToolRow = memo(function ToolRow({ event, defaultOpen = false }: { event: ToolEvent; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const described = describeTool(event);
  const totals = described.files.reduce((sum, file) => ({ added: sum.added + file.added, removed: sum.removed + file.removed }), { added: 0, removed: 0 });
  const hasTotals = event.output.some((part) => part.type === 'diff');
  const duration = event.endedAt !== null ? formatDuration(event.endedAt - event.at) : null;
  const running = event.status === 'running';

  return (
    <div className={cx('step', `is-${event.status}`, open && 'is-open')}>
      <button type="button" className="step-head" aria-expanded={open} title={duration ? `${event.name} · ${duration}` : event.name} onClick={() => setOpen(!open)}>
        <span className="step-label">
          <span className="step-verb">{running ? described.active : described.verb}</span>
          {described.target && <span className={cx('step-target', described.code && 'is-code')}>{described.target}</span>}
        </span>
        {hasTotals && <DiffBadge added={totals.added} removed={totals.removed} />}
        {running && <LoaderCircle size={12} className="spin step-state" aria-label="Running" />}
        {event.status === 'error' && <CircleAlert size={12} className="step-state is-error" aria-label="Failed" />}
        {open ? <ChevronDown size={13} className="step-chevron" aria-hidden="true" /> : <ChevronRight size={13} className="step-chevron" aria-hidden="true" />}
      </button>
      {open && <ToolDetails event={event} />}
    </div>
  );
});

/** What a call did: its command and output, its diffs, or its arguments and text result. */
export function ToolDetails({ event }: { event: ToolEvent }) {
  const described = describeTool(event);
  const shown = event.output.filter((part) => part.type !== 'text' || part.text.trim());
  const execs = shown.some((part) => part.type === 'exec');
  const code = described.category === 'script' ? scriptCode(event.args) : null;
  return (
    <div className="step-body">
      {code && <CodeBlock code={code} language="javascript" />}
      {!execs && !code && described.category !== 'edit' && described.category !== 'create' && described.category !== 'delete' && (
        <ArgsBlock args={event.args} />
      )}
      {shown.map((part, index) => (
        <OutputPart key={index} part={part} />
      ))}
      {event.status === 'running' && shown.length === 0 && <p className="out-note">Running…</p>}
    </div>
  );
}

function scriptCode(args: unknown): string | null {
  if (typeof args === 'string') return args || null;
  const record = (args ?? {}) as Record<string, unknown>;
  const inner = record.args && typeof record.args === 'object' ? (record.args as Record<string, unknown>) : record;
  return typeof inner.code === 'string' ? inner.code : null;
}

function safeJson(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2) ?? '';
  } catch {
    return String(value);
  }
}

function ArgsBlock({ args }: { args: unknown }) {
  const text = safeJson(args);
  if (!text || text === '{}' || text === '""') return null;
  return <pre className="out-pre is-args">{text}</pre>;
}

function highlight(code: string, language: string): string {
  try {
    return hljs.highlight(code, { language, ignoreIllegals: true }).value;
  } catch {
    return code.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
  }
}

function CodeBlock({ code, language }: { code: string; language: string }) {
  const html = useMemo(() => highlight(code, language), [code, language]);
  return (
    <pre className="cmd-block">
      <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
    </pre>
  );
}

/** `$ command` with shell highlighting, then its output in a bounded scroll area. */
function CommandOutput({ part }: { part: Extract<ToolOutputPart, { type: 'exec' }> }) {
  const html = useMemo(() => highlight(part.command, 'bash'), [part.command]);
  return (
    <div className="cmd">
      <pre className="cmd-block">
        <span className="cmd-prompt" aria-hidden="true">$ </span>
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
      <div className="cmd-meta">
        {part.cwd && <span title={part.cwd}>{basename(part.cwd)}</span>}
        {part.running ? (
          <span className="cmd-exit is-running">running{part.sessionId ? ` · #${part.sessionId}` : ''}</span>
        ) : part.exitCode !== null ? (
          <span className={cx('cmd-exit', part.exitCode === 0 ? 'is-ok' : 'is-fail')}>exit {part.exitCode}</span>
        ) : null}
      </div>
      {part.output && <pre className="cmd-out scroll">{part.output}</pre>}
    </div>
  );
}

function OutputPart({ part }: { part: ToolOutputPart }) {
  if (part.type === 'exec') return <CommandOutput part={part} />;
  if (part.type === 'diff') return <DiffCard path={part.path} diff={part.diff} />;
  if (part.type === 'sources') return <SourceList sources={part.sources} />;
  if (part.type === 'image') {
    return (
      <div className="out-note">
        <Image size={13} aria-hidden="true" /> <span title={part.path}>{basename(part.path)}</span>
        <span className="out-muted">{part.mime}</span>
      </div>
    );
  }
  return (
    <pre className="out-pre scroll">
      {part.text}
      {part.truncated && <span className="out-note"> …truncated</span>}
    </pre>
  );
}

/** Pages a web search found or opened; links open in the default browser. */
function SourceList({ sources }: { sources: WebSource[] }) {
  return (
    <ul className="sources">
      {sources.map((source, index) => (
        <li key={`${source.url}:${index}`}>
          <a className="source" href={source.url} data-external title={source.url}>
            <span className="source-domain">{source.domain}</span>
            <span className="source-title">{source.title || source.url}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

export function DiffBadge({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="diff-badge" aria-label={`${added} lines added, ${removed} removed`}>
      <span className="diff-add">+{added}</span>
      <span className="diff-del">-{removed}</span>
    </span>
  );
}

/** A file diff with line numbers, like the Claude app's edit cards. */
export function DiffCard({ path, diff }: { path: string; diff: string }) {
  const rows = useMemo(() => diffRows(diff), [diff]);
  const [copied, copy] = useCopy();
  return (
    <div className="diff">
      <div className="diff-head">
        <span className="diff-path" title={path}>{path}</span>
        <button type="button" className="icon-btn diff-copy" aria-label="Copy path" title="Copy path" onClick={() => copy(path)}>
          {copied ? <Check size={13} /> : <Copy size={13} />}
        </button>
      </div>
      <div className="diff-body scroll" role="table" aria-label={`Changes in ${basename(path)}`}>
        {rows.map((row, index) =>
          row.kind === 'gap' ? (
            <div key={index} className="diff-row is-gap" role="row">
              <span className="diff-num" />
              <span className="diff-mark" />
              <span className="diff-text">⋯</span>
            </div>
          ) : (
            <div key={index} className={`diff-row is-${row.kind}`} role="row">
              <span className="diff-num">{row.line}</span>
              <span className="diff-mark">{row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ''}</span>
              <span className="diff-text">{row.text || ' '}</span>
            </div>
          )
        )}
      </div>
    </div>
  );
}
