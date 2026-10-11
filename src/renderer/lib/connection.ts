import type { AppState, ConnectionState } from '@shared/types';

export type ConnectionTone = 'neutral' | 'progress' | 'ok' | 'bad';

export interface ConnectionView {
  label: string;
  tone: ConnectionTone;
}

/** Whether the tunnel has the credentials it needs. Without them nothing can connect yet. */
export function tunnelConfigured(app: Pick<AppState, 'config' | 'secretsSet' | 'tools'>): boolean {
  const { config, secretsSet, tools } = app;
  switch (config.connection.kind) {
    case 'openai':
      return secretsSet.includes('tunnelApiKey') && config.connection.tunnelId !== '';
    case 'cloudflared':
      return tools.cloudflared !== null;
    default:
      return true;
  }
}

/** Friendly wording for a connection state; setup that is not done yet is not an error. */
export function connectionView(state: ConnectionState, configured: boolean): ConnectionView {
  if (!configured && state !== 'connected') return { label: 'Setup needed', tone: 'neutral' };
  switch (state) {
    case 'connected':
      return { label: 'Connected', tone: 'ok' };
    case 'starting':
    case 'connecting':
      return { label: 'Connecting…', tone: 'progress' };
    case 'disconnected':
      return { label: 'Offline', tone: 'neutral' };
    case 'offline':
      return { label: 'Tunnel offline', tone: 'bad' };
    case 'auth-failed':
      return { label: 'Sign-in failed', tone: 'bad' };
    case 'error':
      return { label: 'Connection error', tone: 'bad' };
  }
}
