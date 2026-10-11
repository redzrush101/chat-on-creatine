import { useSyncExternalStore } from 'react';
import { X } from 'lucide-react';
import { cx, errorMessage } from '../../lib/format';

type Tone = 'info' | 'error' | 'success';
interface Toast {
  id: number;
  tone: Tone;
  message: string;
}

let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

function emit(next: Toast[]): void {
  toasts = next;
  for (const listener of listeners) listener();
}

export function dismissToast(id: number): void {
  emit(toasts.filter((toast) => toast.id !== id));
}

export function notify(message: string, tone: Tone = 'info'): void {
  const id = nextId++;
  emit([...toasts.slice(-4), { id, tone, message }]);
  window.setTimeout(() => dismissToast(id), tone === 'error' ? 8000 : 4000);
}

/** Shows an invoke rejection or other thrown error as a toast. */
export function reportError(error: unknown): void {
  notify(errorMessage(error), 'error');
}

export function Toaster() {
  const list = useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => toasts
  );
  return (
    <div className="toaster" role="status" aria-live="polite">
      {list.map((toast) => (
        <div key={toast.id} className={cx('toast', `toast-${toast.tone}`)}>
          <span className="toast-text">{toast.message}</span>
          <button type="button" className="icon-btn toast-close" aria-label="Dismiss" onClick={() => dismissToast(toast.id)}>
            <X size={14} />
          </button>
        </div>
      ))}
    </div>
  );
}
