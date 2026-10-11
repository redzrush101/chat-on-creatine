import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import type { GitStatus } from '@shared/types';
import { invoke } from '../../lib/bridge';
import { basename } from '../../lib/format';
import { useStoredState } from '../../lib/hooks';
import { DiffBadge } from '../chat/ToolCard';

const REFRESH_MS = 15_000;

/** Git status of the chat folder, refreshed on focus, on a timer and whenever `refreshKey` changes. */
function useGitStatus(rootDir: string | null, refreshKey: unknown): GitStatus | null {
  const [status, setStatus] = useState<GitStatus | null>(null);
  useEffect(() => {
    if (!rootDir) {
      setStatus(null);
      return;
    }
    let alive = true;
    const load = () => {
      if (document.visibilityState === 'hidden') return;
      invoke('files:gitStatus', rootDir)
        .then((next) => alive && setStatus(next))
        // Not a folder the app may read, or git missing: the bar just stays hidden.
        .catch(() => alive && setStatus(null));
    };
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    window.addEventListener('focus', load);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', load);
    };
  }, [rootDir, refreshKey]);
  return status;
}

/**
 * "nixos-config  main   +42 -21  Review changes  ×" above the composer, like the Claude app's repo bar.
 * Dismissing hides it until the change totals move.
 */
export function RepoBar({ rootDir, refreshKey, onReview }: { rootDir: string | null; refreshKey: unknown; onReview(): void }) {
  const status = useGitStatus(rootDir, refreshKey);
  const [dismissed, setDismissed] = useStoredState<Record<string, string>>('creatine.repoBar.dismissed', {});
  if (!rootDir || !status?.isRepo || status.changes.length === 0) return null;
  const signature = `${status.changes.length}:${status.added}:${status.removed}`;
  if (dismissed[rootDir] === signature) return null;
  const files = status.changes.length === 1 ? '1 file' : `${status.changes.length} files`;

  return (
    <div className="repo-bar">
      <span className="repo-name" title={rootDir}>{basename(rootDir)}</span>
      {status.branch && <span className="repo-branch">{status.branch}</span>}
      <span className="repo-spacer" />
      <button type="button" className="repo-stat" title={`${files} changed`} onClick={onReview}>
        <DiffBadge added={status.added} removed={status.removed} />
      </button>
      <button type="button" className="btn btn-small repo-review" onClick={onReview}>
        Review changes
      </button>
      <button
        type="button"
        className="icon-btn repo-close"
        aria-label="Hide until the changes move"
        title="Hide until the changes move"
        onClick={() => setDismissed({ ...dismissed, [rootDir]: signature })}
      >
        <X size={14} />
      </button>
    </div>
  );
}
