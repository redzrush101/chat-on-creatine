import { spawn } from 'node:child_process';
import { createLogger } from '../core/log';
import { onLines, stopProcess } from './process';
import { type TunnelHandle, type TunnelOptions } from './types';

const CLOUDFLARED_START_MS = 45_000;

/** A quick tunnel: a public trycloudflare URL that forwards to this surface's loopback path. */
export async function startCloudflared(opts: TunnelOptions): Promise<TunnelHandle> {
  if (!opts.binary) throw new Error('cloudflared was not found. Install it, or point Connection settings at it.');
  const log = createLogger(`tunnel.${opts.label}`);
  const local = new URL(opts.localUrl);
  const child = spawn(
    opts.binary,
    ['tunnel', '--no-autoupdate', '--url', `${local.protocol}//${local.host}`, '--http-host-header', local.host],
    { windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] }
  );

  let settled = false;
  let stopping = false;
  let lastError = '';
  const startup = setTimeout(() => {
    if (!settled) {
      settled = true;
      opts.report({ state: 'error', detail: lastError || `cloudflared did not report a public URL within ${CLOUDFLARED_START_MS / 1000} seconds.`, publicUrl: null, handshakeAt: null });
    }
  }, CLOUDFLARED_START_MS);

  const onLine = (line: string): void => {
    const match = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(line);
    if (match && !settled) {
      settled = true;
      clearTimeout(startup);
      log.info('quick tunnel connected');
      opts.report({
        state: 'connected',
        detail: 'Connected. Paste the URL below into ChatGPT as a custom connector.',
        publicUrl: `${match[0]}${local.pathname}`,
        handshakeAt: null
      });
      return;
    }
    if (/\b(err|error|fatal)\b/i.test(line)) {
      lastError = line.slice(0, 400);
      log.warn(lastError);
    }
  };
  onLines(child.stdout!, onLine);
  onLines(child.stderr!, onLine);

  const fail = (detail: string): void => {
    clearTimeout(startup);
    if (stopping) return;
    settled = true;
    opts.report({ state: 'error', detail, publicUrl: null, handshakeAt: null });
  };
  child.on('exit', (code) => fail(lastError || `cloudflared stopped (exit ${code}).`));
  child.on('error', (err) => fail(`Could not start cloudflared: ${err.message}`));

  return {
    stop: async () => {
      stopping = true;
      clearTimeout(startup);
      await stopProcess(child);
    }
  };
}
