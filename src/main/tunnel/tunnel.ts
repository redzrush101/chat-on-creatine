import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ConnectionState } from '@shared/types';
import { createLogger } from '../core/log';
import {
  describeNetworkError,
  isAuthRejection,
  isUnreachable,
  outageConfirmed,
  outageRecovered,
  POLL_FRESH_MS,
  probeReady,
  readPollHealth,
  type OutageRun
} from './health';

export type TunnelAdapter = 'openai' | 'cloudflared' | 'manual';

interface TunnelReport {
  state: ConnectionState;
  detail: string;
  publicUrl: string | null;
  /** Epoch ms of the last proven round trip to OpenAI, when known. */
  handshakeAt: number | null;
}

interface TunnelOptions {
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

class TunnelError extends Error {}

const TUNNEL_ID_PATTERN = /^tunnel_[0-9a-f]{32}$/;
const READY_TIMEOUT_MS = 60_000;
const WATCH_MS = 15_000;
const OFFLINE_WATCH_MS = 5_000;
/** A client that stays unready this long is replaced; a single missed probe is not enough. */
const UNREADY_CONFIRM_MS = 15_000;
const MAX_BACKOFF_MS = 60_000;
const CLOUDFLARED_START_MS = 45_000;

/** Starts one tunnel and reports its state until stopped. Returns once the attempt has begun. */
export async function startTunnel(opts: TunnelOptions): Promise<TunnelHandle> {
  switch (opts.adapter) {
    case 'manual':
      opts.report({
        state: 'connected',
        detail: 'Local server running. Expose it with your own tunnel and use the URL below.',
        publicUrl: null,
        handshakeAt: null
      });
      return { stop: async () => {} };
    case 'cloudflared':
      return startCloudflared(opts);
    case 'openai':
      return startOpenAi(opts);
  }
}

function signalTree(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => {});
    return;
  }
  try {
    process.kill(-pid, signal);
  } catch {
    // Already gone.
  }
}

/** Terminates the child and anything it started, escalating to SIGKILL if it lingers. */
async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  signalTree(pid, 'SIGTERM');
  const escalate = setTimeout(() => signalTree(pid, 'SIGKILL'), 3000);
  await exited;
  clearTimeout(escalate);
}

/** Calls back once per complete line of a child's output. */
function onLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
  let carry = '';
  stream.on('data', (chunk: Buffer) => {
    carry += chunk.toString('utf8');
    let at = carry.indexOf('\n');
    while (at !== -1) {
      const line = carry.slice(0, at).trimEnd();
      carry = carry.slice(at + 1);
      if (line) onLine(line);
      at = carry.indexOf('\n');
    }
    if (carry.length > 16_384) carry = '';
  });
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// ------------------------------------------------------------------ OpenAI

/**
 * Runs tunnel-client and keeps it running: an unready client is replaced with backoff, a client
 * that cannot reach OpenAI is reported and left to retry on its own, and a rejected key stops
 * everything, because restarting cannot fix it.
 */
async function startOpenAi(opts: TunnelOptions): Promise<TunnelHandle> {
  if (!opts.binary) throw new TunnelError('tunnel-client was not found. Install it, or point Connection settings at it.');
  if (!TUNNEL_ID_PATTERN.test(opts.tunnelId)) {
    throw new TunnelError('Enter a tunnel ID that looks like tunnel_ followed by 32 hex characters.');
  }
  if (!opts.apiKey) throw new TunnelError('Add your OpenAI tunnel API key first.');

  const log = createLogger(`tunnel.${opts.label}`);
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'creatine-tunnel-'));
  const healthFile = path.join(workDir, 'health.url');

  let stopped = false;
  let current: ChildProcess | null = null;
  let timer: NodeJS.Timeout | null = null;
  let attempts = 0;
  let healthBase: string | null = null;
  let lastHandshake: number | null = null;
  let outage: OutageRun | null = null;
  let unreachableReason = '';
  let unreadySince = 0;
  let lastError = '';
  let shownOffline = false;

  const later = (fn: () => void, ms: number): void => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, ms);
    timer.unref?.();
  };

  const reportConnected = (): void => {
    opts.report({
      state: 'connected',
      detail: lastHandshake
        ? `Connected. Last verified handshake with OpenAI ${secondsAgo(lastHandshake)}. Pick the tunnel in ChatGPT.`
        : 'Connected. Pick the tunnel in ChatGPT.',
      publicUrl: null,
      handshakeAt: lastHandshake
    });
  };

  const reportOffline = (): void => {
    opts.report({
      state: 'offline',
      detail: `This PC cannot reach OpenAI: ${unreachableReason || 'it stopped answering'}. ChatGPT cannot use the connector until it is back; the tunnel keeps retrying.`,
      publicUrl: null,
      handshakeAt: lastHandshake
    });
  };

  const reportFailed = (state: ConnectionState, detail: string): void => {
    opts.report({ state, detail, publicUrl: null, handshakeAt: lastHandshake });
  };

  /** Ends this process as the current one and schedules a replacement. */
  const restart = (proc: ChildProcess, detail: string, terminate: boolean): void => {
    if (stopped || current !== proc) return;
    current = null;
    healthBase = null;
    outage = null;
    unreadySince = 0;
    attempts += 1;
    const wait = Math.min(MAX_BACKOFF_MS, 2000 * 2 ** (attempts - 1));
    reportFailed('connecting', `${detail} Reconnecting in ${Math.round(wait / 1000)}s.`);
    void (async () => {
      if (terminate) await stopProcess(proc);
      if (!stopped) later(() => void launch(), wait);
    })();
  };

  const observeRoute = async (proc: ChildProcess): Promise<void> => {
    if (stopped || current !== proc || !healthBase) return;
    const poll = await readPollHealth(healthBase);
    if (stopped || current !== proc) return;
    if (poll?.lastSuccessMs) lastHandshake = poll.lastSuccessMs;
    if (outageRecovered(outage, lastHandshake)) {
      outage = null;
      unreachableReason = '';
    }
    if (poll === null) {
      reportFailed('connecting', 'Tunnel client is ready, but its OpenAI poll metrics are unavailable.');
    } else if (outageConfirmed(outage, Date.now()) || (lastHandshake !== null && Date.now() - lastHandshake > POLL_FRESH_MS)) {
      if (!shownOffline) log.warn(`offline: ${unreachableReason || 'it stopped answering'}`);
      shownOffline = true;
      reportOffline();
    } else {
      if (shownOffline) log.info('connected again');
      shownOffline = false;
      reportConnected();
    }
  };

  /** Readiness and freshness, on a timer, for as long as this process is the current one. */
  const watch = (proc: ChildProcess): void => {
    later(() => {
      void (async () => {
        if (stopped || current !== proc || !healthBase) return;
        const ready = await probeReady(healthBase);
        if (stopped || current !== proc) return;
        if (!ready.ok) {
          const now = Date.now();
          if (unreadySince === 0) {
            unreadySince = now;
            log.warn(`not ready: ${ready.detail || 'no detail'}; rechecking before replacing it`);
          } else if (now - unreadySince >= UNREADY_CONFIRM_MS) {
            restart(proc, ready.detail || 'The tunnel stopped responding.', true);
            return;
          }
        } else {
          unreadySince = 0;
          await observeRoute(proc);
        }
        if (!stopped && current === proc) watch(proc);
      })();
    }, shownOffline ? OFFLINE_WATCH_MS : WATCH_MS);
  };

  const handleLine = (proc: ChildProcess, line: string): void => {
    if (stopped || current !== proc) return;
    let message = line;
    let error = '';
    let statusCode: unknown;
    let level = '';
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      level = String(event['level'] ?? '').toUpperCase();
      message = String(event['msg'] ?? '');
      error = event['error'] ? String(event['error']) : '';
      statusCode = event['status_code'];
    } catch {
      // Plain text from an older client or a crash path.
    }
    if (isAuthRejection(message, error, statusCode)) {
      stopped = true;
      current = null;
      if (timer) clearTimeout(timer);
      void stopProcess(proc);
      log.error('OpenAI refused the tunnel credentials');
      reportFailed(
        'auth-failed',
        'OpenAI refused access to this tunnel. Check its account, organization, API key and tunnel ID in Connection settings.'
      );
      return;
    }
    if (isUnreachable(`${message}: ${error}`) || isUnreachable(line)) {
      unreachableReason = describeNetworkError(error || message || line);
      if (outage === null) {
        outage = { since: Date.now(), handshakeBefore: lastHandshake };
        log.info(`${unreachableReason}; the client is retrying`);
      }
      return;
    }
    // Harpoon is an optional side channel that refuses loopback http targets; it never affects MCP.
    if (/harpoon/i.test(message) || /unsupported channel\s*["']harpoon/i.test(message)) return;
    if (level === 'ERROR' || level === 'FATAL' || level === 'WARN') {
      lastError = `${message}${error ? `: ${error}` : ''}`.slice(0, 400);
      log.warn(lastError);
    }
  };

  const launch = async (): Promise<void> => {
    if (stopped || current) return;
    await rm(healthFile, { force: true });
    const proc = spawn(opts.binary!, ['run', '--control-plane.tunnel-id', opts.tunnelId, '--health.listen-addr', '127.0.0.1:0', '--health.url-file', healthFile, '--log.format', 'json', '--log.level', 'info'], {
      // Credentials go in the environment, never argv, where other software could read them.
      env: {
        ...process.env,
        CONTROL_PLANE_API_KEY: opts.apiKey ?? '',
        MCP_SERVER_URL: `url=${opts.localUrl},channel=main`
      },
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    current = proc;
    reportFailed('connecting', attempts === 0 ? 'Starting tunnel client…' : 'Reconnecting…');
    onLines(proc.stdout!, (line) => handleLine(proc, line));
    onLines(proc.stderr!, (line) => handleLine(proc, line));
    proc.on('exit', (code) => {
      if (stopped || current !== proc) return;
      log.warn(`client exited with code ${code}`);
      restart(proc, lastError || `Tunnel client stopped (exit ${code}).`, false);
    });
    proc.on('error', (err) => {
      if (stopped || current !== proc) return;
      log.error(`client failed to start: ${err.message}`);
      restart(proc, `Could not start tunnel-client: ${err.message}`, true);
    });

    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (!stopped && current === proc && Date.now() < deadline) {
      const base = await readHealthBase(healthFile);
      if (base) {
        const ready = await probeReady(base);
        if (stopped || current !== proc) return;
        if (ready.ok) {
          attempts = 0;
          healthBase = base;
          await observeRoute(proc);
          watch(proc);
          return;
        }
        lastError = ready.detail || lastError;
      }
      await delay(1000);
    }
    if (!stopped && current === proc) restart(proc, lastError || 'The tunnel did not become ready within 60 seconds.', true);
  };

  void launch();

  return {
    stop: async () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      const proc = current;
      current = null;
      if (proc) await stopProcess(proc);
      await rm(workDir, { recursive: true, force: true });
    }
  };
}

async function readHealthBase(file: string): Promise<string | null> {
  try {
    const text = (await readFile(file, 'utf8')).trim();
    return text.startsWith('http') ? text.replace(/\/$/, '') : null;
  } catch {
    return null;
  }
}

function secondsAgo(ms: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 90) return `${seconds}s ago`;
  return `${Math.round(seconds / 60)}m ago`;
}

// ------------------------------------------------------------- cloudflared

/** A quick tunnel: a public trycloudflare URL that forwards to this surface's loopback path. */
async function startCloudflared(opts: TunnelOptions): Promise<TunnelHandle> {
  if (!opts.binary) throw new TunnelError('cloudflared was not found. Install it, or point Connection settings at it.');
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
