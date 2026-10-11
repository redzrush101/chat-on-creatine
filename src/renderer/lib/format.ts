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

export function formatTokens(count: number): string {
  if (count < 1000) return String(count);
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 1 : 0)}k`;
  return `${(count / 1_000_000).toFixed(1)}M`;
}

export function formatRelative(at: number, now = Date.now()): string {
  const diff = Math.max(0, now - at);
  const minute = 60_000;
  if (diff < minute) return 'now';
  if (diff < 60 * minute) return `${Math.floor(diff / minute)}m`;
  if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))}h`;
  if (diff < 7 * 24 * 60 * minute) return `${Math.floor(diff / (24 * 60 * minute))}d`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path;
}

/** Electron prefixes IPC rejections with the channel name; the user only needs the reason. */
export function errorMessage(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^Error invoking remote method '[^']*': (Error: )?/, '') || 'Something went wrong';
}

function singleLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

const ARG_KEYS = ['command', 'cmd', 'path', 'file', 'paths', 'query', 'pattern', 'url', 'name', 'objective', 'text', 'message'];

/** One line that tells what a tool call is about, from its arguments. */
export function toolArgSummary(args: unknown): string {
  if (typeof args === 'string') return singleLine(args, 160);
  if (!args || typeof args !== 'object') return '';
  const record = args as Record<string, unknown>;
  for (const key of ARG_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return singleLine(value, 160);
    if (Array.isArray(value) && value.every((item) => typeof item === 'string') && value.length) {
      return singleLine(value.join(' '), 160);
    }
  }
  try {
    return singleLine(JSON.stringify(args), 160);
  } catch {
    return '';
  }
}

export function eventTime(event: SessionEvent): number {
  return event.kind === 'tool' && event.endedAt ? event.endedAt : event.at;
}

/** Joins class names, dropping falsy entries. */
export function cx(...names: (string | false | null | undefined)[]): string {
  return names.filter(Boolean).join(' ');
}
