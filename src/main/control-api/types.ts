import type { Config } from '@shared/config';
import type { AgentRun, ConnectionStatus, LogEntry } from '@shared/types';
import { redact } from '../core/redact';
import type { Outbox } from '../sessions/outbox';
import type { SessionStore } from '../sessions/store';

export interface ControlApiDeps {
  /** `userData/control-api`: where endpoint.json and the token file are written. */
  dir: string;
  version: string;
  getConfig(): Config;
  store: SessionStore;
  outbox: Outbox;
  turnOf(sessionId: string): string;
  connectionStatus(): ConnectionStatus;
  agents(): AgentRun[];
  logs(limit: number): LogEntry[];
}

/** A refusal the caller can act on: an HTTP status and a stable error code. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    readonly detail?: string
  ) {
    super(code);
  }
}

export interface ApiReply {
  status: number;
  body: unknown;
}

interface Text {
  text: string;
  chars: number;
  truncated: boolean;
}

/** Redacts first, then cuts, so a cut cannot leave a recognisable prefix of a secret. */
export function clip(value: string, cap: number): Text {
  const redacted = redact(value);
  if (redacted.length <= cap) return { text: redacted, chars: value.length, truncated: false };
  return { text: redacted.slice(0, cap), chars: value.length, truncated: true };
}

export function line(value: string, cap: number): string {
  return clip(value, cap).text;
}
