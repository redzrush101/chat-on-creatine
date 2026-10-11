import { useCallback, useEffect, useMemo, useState } from 'react';
import type { JSX } from 'react';
import { ArrowLeft, GitBranch, RefreshCw } from 'lucide-react';
import type { GitFileChange, GitStatus } from '@shared/types';
import { DiffBody } from '../components/chat/ToolCard';
import { diffRows } from '../components/chat/tool-labels';
import { invoke } from '../lib/bridge';
import { basename, errorMessage } from '../lib/format';
import { Empty, Notice, useLoaded } from './common';

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
  const { value: diff, error } = useLoaded(`${rootDir}\0${change.path}`, () => invoke('files:gitDiff', rootDir, change.path));
  const rows = useMemo(() => (diff === null ? null : diffRows(diff)), [diff]);

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
      {!error && rows === null && <div className="wp-tree-status">Loading diff…</div>}
      {rows?.length === 0 && <Empty title="No text changes">The file is binary or only its mode changed.</Empty>}
      {rows && rows.length > 0 && <DiffBody rows={rows} label={`Changes in ${basename(change.path)}`} />}
    </div>
  );
}
