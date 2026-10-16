import { errorMessage as rawErrorMessage } from '@shared/errors';
import type { SessionEvent } from '@shared/types';

export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (minutes < 60) return seconds ? `${minutes}m ${seconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes ? `${hours}h ${restMinutes}m` : `${hours}h`;
}

/** "01:16", or "1:02:05" past an hour: elapsed time of a task. */
export function formatClock(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${pad(minutes)}:${pad(seconds)}`;
}

export { formatTokens } from '@shared/format';

const relativeTime = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "3 minutes ago", for message timestamps. */
export function formatAgo(at: number, now = Date.now()): string {
  const seconds = Math.round((at - now) / 1000);
  if (seconds > -45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes > -60) return relativeTime.format(minutes, 'minute');
  const hours = Math.round(minutes / 60);
  if (hours > -24) return relativeTime.format(hours, 'hour');
  const days = Math.round(hours / 24);
  if (days > -7) return relativeTime.format(days, 'day');
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

export { basename } from '@shared/format';

/** The path below `root` (either separator, so Windows paths work), or the full path when it is outside. */
export function relativeTo(root: string, path: string): string {
  const base = root.replace(/[\\/]+$/, '');
  const separator = path.charAt(base.length);
  return path.startsWith(base) && (separator === '/' || separator === '\\') ? path.slice(base.length + 1) : path;
}

/** Electron prefixes IPC rejections with the channel name; the user only needs the reason. */
export function errorMessage(error: unknown): string {
  const raw = rawErrorMessage(error);
  return raw.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') || 'Something went wrong';
}

export function eventTime(event: SessionEvent): number {
  return event.kind === 'tool' && event.endedAt ? event.endedAt : event.at;
}

/** Joins class names, dropping falsy entries. */
export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}
