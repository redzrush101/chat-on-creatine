import type { ConnectionState } from '@shared/types';

export type TunnelAdapter = 'openai' | 'cloudflared' | 'manual';

interface TunnelReport {
  state: ConnectionState;
  detail: string;
  publicUrl: string | null;
  /** Epoch ms of the last proven round trip to OpenAI, when known. */
  handshakeAt: number | null;
}

export interface TunnelOptions {
  adapter: TunnelAdapter;
  /** Connector name for the log, e.g. "core". */
  label: string;
  /** Loopback MCP URL, including the secret path segment. */
  localUrl: string;
  /** tunnel-client or cloudflared executable; null for manual. */
  binary: string | null;
  /** OpenAI tunnel id. Used by the openai adapter only. */
  tunnelId: string;
  /** OpenAI control-plane key. Passed to the child in its environment and never logged. */
  apiKey: string | null;
  report(report: TunnelReport): void;
}

export interface TunnelHandle {
  stop(): Promise<void>;
}
