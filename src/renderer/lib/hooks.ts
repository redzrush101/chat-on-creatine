import { useEffect, useState, useSyncExternalStore, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';

/** Per-viewer convenience state (a collapsed section, a panel width); never authoritative. */
export function useStoredState<T>(key: string, fallback: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? fallback : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  });
  const update = (next: T) => {
    setValue(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // Storage can be blocked; the value still holds for this session.
    }
  };
  return [value, update];
}

export function useSystemDark(): boolean {
  return useSyncExternalStore(
    (listener) => {
      const query = window.matchMedia('(prefers-color-scheme: dark)');
      query.addEventListener('change', listener);
      return () => query.removeEventListener('change', listener);
    },
    () => window.matchMedia('(prefers-color-scheme: dark)').matches
  );
}

/** Ticks once a second while `active`, for live durations. */
export function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

interface ResizeOptions {
  min: number;
  max: number;
  /** +1 when growing the panel means moving the pointer right, -1 when left. */
  direction: 1 | -1;
  onCommit(width: number): void;
}

/** Pointer and keyboard resizing for a side panel. The width is committed once, when the drag ends. */
export function useResize(committed: number, { min, max, direction, onCommit }: ResizeOptions) {
  const [live, setLive] = useState<number | null>(null);
  const width = live ?? committed;
  const clamp = (value: number) => Math.min(max, Math.max(min, Math.round(value)));

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    const handle = event.currentTarget;
    const startX = event.clientX;
    const startWidth = width;
    let latest = startWidth;
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add('is-resizing');

    const move = (moveEvent: PointerEvent) => {
      latest = clamp(startWidth + direction * (moveEvent.clientX - startX));
      setLive(latest);
    };
    const end = () => {
      handle.removeEventListener('pointermove', move);
      handle.removeEventListener('pointerup', end);
      handle.removeEventListener('pointercancel', end);
      document.body.classList.remove('is-resizing');
      setLive(null);
      if (latest !== committed) onCommit(latest);
    };
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const step = event.shiftKey ? 48 : 16;
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault();
      const grow = (event.key === 'ArrowRight' ? 1 : -1) * direction;
      onCommit(clamp(committed + grow * step));
    }
  };

  return { width, onPointerDown, onKeyDown };
}

/** Current window width, updated on resize. */
export function useViewportWidth(): number {
  return useSyncExternalStore(
    (listener) => {
      window.addEventListener('resize', listener);
      return () => window.removeEventListener('resize', listener);
    },
    () => window.innerWidth
  );
}
