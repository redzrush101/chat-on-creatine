import { errorMessage } from '../lib/format';
import { useCallback, useEffect, useState } from 'react';
import type { JSX } from 'react';
import { ArrowLeft, GitBranch, RefreshCw } from 'lucide-react';
import type { GitFileChange, GitStatus } from '@shared/types';
import { invoke } from '../lib/bridge';
import { Empty, Notice } from './common';

export function ChangesTab({ rootDir }: { rootDir: string | null }): JSX.Element {
  const [status, setStatus] = useState<GitStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<GitFileChange | null>(null);

  const refresh = useCallback(() => {
    if (!rootDir) return;
    setLoading(true);
    setError(null);
    invoke('files:gitStatus', rootDir)
      .then(setStatus)
      .catch((failure: unknown) => setError(errorMessage(failure)))
      .finally(() => setLoading(false));
  }, [rootDir]);

  useEffect(() => {
    setStatus(null);
    setSelected(null);
    refresh();
  }, [refresh]);

  if (!rootDir) return <Empty title="No folder for this chat">Approve a project folder in Settings to see its changes.</Empty>;
  if (selected) return <FileDiff rootDir={rootDir} change={selected} onBack={() => setSelected(null)} />;

  return (
    <div className="wp-changes">
      <div className="wp-toolbar">
        <GitBranch size={14} aria-hidden />
        <span className="wp-path">{status?.branch ?? (status?.isRepo === false ? 'Not a git repository' : '…')}</span>
        {status?.isRepo && (status.ahead > 0 || status.behind > 0) && (
          <span className="wp-muted">
            {status.ahead > 0 && `↑${status.ahead} `}
            {status.behind > 0 && `↓${status.behind}`}
          </span>
        )}
        <span className="wp-spacer" />
        <button type="button" className="wp-btn is-ghost" aria-label="Refresh changes" disabled={loading} onClick={refresh}>
          <RefreshCw size={14} aria-hidden className={loading ? 'wp-spin' : undefined} />
        </button>
      </div>

      {error && <Notice tone="error">{error}</Notice>}
      {status && !status.isRepo && <Empty title="Not a git repository">Changes appear here once this folder is under git.</Empty>}
      {status?.isRepo && status.changes.length === 0 && <Empty title="No changes">The working tree matches the last commit.</Empty>}
      {status?.isRepo && status.changes.length > 0 && (
        <ul className="wp-change-list">
          {status.changes.map((change) => (
            <li key={change.path}>
              <button type="button" className="wp-change" onClick={() => setSelected(change)} title={change.path}>
                <span className={`wp-status is-${statusLetter(change.status).toLowerCase()}`}>{statusLetter(change.status)}</span>
                <span className="wp-change-path">{change.path}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** One letter for a porcelain XY pair: the worktree side wins, untracked files read as added. */
function statusLetter(code: string): string {
  if (code === '??') return 'U';
  const letter = code.replace(/\s/g, '').charAt(0);
  return letter || '?';
}

function FileDiff({ rootDir, change, onBack }: { rootDir: string; change: GitFileChange; onBack(): void }): JSX.Element {
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setDiff(null);
    setError(null);
    invoke('files:gitDiff', rootDir, change.path)
      .then((text) => {
        if (alive) setDiff(text);
      })
      .catch((failure: unknown) => {
        if (alive) setError(errorMessage(failure));
      });
    return () => {
      alive = false;
    };
  }, [rootDir, change.path]);

  return (
    <div className="wp-diff-view">
      <div className="wp-toolbar">
        <button type="button" className="wp-btn is-ghost" onClick={onBack}>
          <ArrowLeft size={14} aria-hidden /> Changes
        </button>
        <span className="wp-path" title={change.path}>
          {change.path}
        </span>
      </div>
      {error && <Notice tone="error">{error}</Notice>}
      {!error && diff === null && <div className="wp-tree-status">Loading diff…</div>}
      {diff !== null && <UnifiedDiff text={diff} />}
    </div>
  );
}

function UnifiedDiff({ text }: { text: string }): JSX.Element {
  if (text.trim() === '') return <Empty title="No text changes">The file is binary or only its mode changed.</Empty>;
  const lines = text.split('\n');
  return (
    <pre className="wp-diff" role="region" aria-label="Diff">
      {lines.map((line, index) => (
        <div key={index} className={`wp-diff-line ${classForLine(line)}`}>
          {line || ' '}
        </div>
      ))}
    </pre>
  );
}

function classForLine(line: string): string {
  if (line.startsWith('@@')) return 'is-hunk';
  if (line.startsWith('+++') || line.startsWith('---') || line.startsWith('diff ') || line.startsWith('index ')) return 'is-meta';
  if (line.startsWith('+')) return 'is-add';
  if (line.startsWith('-')) return 'is-del';
  return 'is-context';
}
