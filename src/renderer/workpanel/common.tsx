import { errorMessage } from '@shared/errors';
import { useCallback, useState } from 'react';
import type { JSX, ReactNode } from 'react';

/** Runs an action from a button and keeps its failure visible in the panel. */
export function useAction(): [string | null, (task: () => Promise<unknown>) => Promise<void>] {
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async (task: () => Promise<unknown>) => {
    setError(null);
    try {
      await task();
    } catch (failure) {
      setError(errorMessage(failure));
    }
  }, []);
  return [error, run];
}

export function Empty({ title, children }: { title: string; children?: ReactNode }): JSX.Element {
  return (
    <div className="wp-empty">
      <strong>{title}</strong>
      {children && <p>{children}</p>}
    </div>
  );
}

export function Notice({ tone = 'muted', children }: { tone?: 'muted' | 'error'; children: ReactNode }): JSX.Element {
  return <div className={tone === 'error' ? 'wp-notice is-error' : 'wp-notice'}>{children}</div>;
}

export function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/** The path relative to the folder it sits in, or the full path when it is outside. */
export function relativeTo(root: string, path: string): string {
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

