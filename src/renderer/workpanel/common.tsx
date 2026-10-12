import { errorMessage } from '../lib/format';
import { useCallback, useEffect, useState } from 'react';
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

/**
 * Runs `load` whenever `key` changes and keeps its value or error. `key` names everything `load`
 * reads; an answer for an older key is dropped.
 */
export function useLoaded<T>(key: string, load: () => Promise<T>): { value: T | null; error: string | null } {
  const [state, setState] = useState<{ key: string; value: T | null; error: string | null }>({ key, value: null, error: null });
  useEffect(() => {
    let alive = true;
    load().then(
      (value) => alive && setState({ key, value, error: null }),
      (failure: unknown) => alive && setState({ key, value: null, error: errorMessage(failure) })
    );
    return () => {
      alive = false;
    };
  }, [key]);
  return state.key === key ? state : { value: null, error: null };
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
