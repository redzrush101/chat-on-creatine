import { appendFile } from 'node:fs/promises';
import type { LogEntry } from '@shared/types';
import { redact } from './redact';

const RING_SIZE = 2000;
const ring: LogEntry[] = [];
const listeners = new Set<(entry: LogEntry) => void>();
let logFile: string | null = null;

/** Routes log lines to a file as well as the in-memory ring (set once at startup). */
export function setLogFile(path: string | null): void {
  logFile = path;
}

export function onLog(listener: (entry: LogEntry) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function recentLogs(limit = 500): LogEntry[] {
  return ring.slice(-limit);
}

function write(level: LogEntry['level'], scope: string, message: string): void {
  const entry: LogEntry = { at: Date.now(), level, scope, message: redact(message).slice(0, 4000) };
  ring.push(entry);
  if (ring.length > RING_SIZE) ring.splice(0, ring.length - RING_SIZE);
  for (const listener of listeners) listener(entry);
  if (level !== 'debug' || process.env.CREATINE_DEBUG) {
    const line = `${new Date(entry.at).toISOString()} ${level.toUpperCase()} [${scope}] ${entry.message}`;
    (level === 'error' ? console.error : console.log)(line);
    if (logFile) void appendFile(logFile, `${line}\n`).catch(() => {});
  }
}

interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string, error?: unknown): void;
}

export function createLogger(scope: string): Logger {
  return {
    debug: (message) => write('debug', scope, message),
    info: (message) => write('info', scope, message),
    warn: (message) => write('warn', scope, message),
    error: (message, error) =>
      write('error', scope, error === undefined ? message : `${message}: ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
  };
}
