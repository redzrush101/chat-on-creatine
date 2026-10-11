import { useEffect, useState } from 'react';
import type { GitStatus } from '@shared/types';
import { invoke } from './bridge';
import { errorMessage } from './format';

const REFRESH_MS = 15_000;

/**
 * Git status of a chat folder, reloaded on window focus, every 15 s while the window is visible,
 * whenever `refreshKey` changes (a turn starting or ending) and on `refresh()`.
 */
export function useGitStatus(
  rootDir: string | null,
  refreshKey: unknown
): { status: GitStatus | null; error: string | null; loading: boolean; refresh(): void } {
  const [state, setState] = useState<{ dir: string | null; status: GitStatus | null; error: string | null }>({ dir: null, status: null, error: null });
  const [loading, setLoading] = useState(false);
  const [requested, setRequested] = useState(0);

  useEffect(() => {
    if (!rootDir) return;
    let alive = true;
    const load = () => {
      if (document.visibilityState === 'hidden') return;
      setLoading(true);
      invoke('files:gitStatus', rootDir)
        .then((status) => alive && setState({ dir: rootDir, status, error: null }))
        .catch((failure: unknown) => alive && setState({ dir: rootDir, status: null, error: errorMessage(failure) }))
        .finally(() => alive && setLoading(false));
    };
    load();
    const timer = window.setInterval(load, REFRESH_MS);
    window.addEventListener('focus', load);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener('focus', load);
    };
  }, [rootDir, refreshKey, requested]);

  const current = state.dir === rootDir ? state : { status: null, error: null };
  return { status: current.status, error: current.error, loading, refresh: () => setRequested((count) => count + 1) };
}
