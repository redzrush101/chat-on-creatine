import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { ConnectionState } from '@shared/types';
import { createLogger } from '../core/log';
import { onLines, stopProcess } from './process';
import { type TunnelHandle, type TunnelOptions } from './types';
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

const TUNNEL_ID_PATTERN = /^tunnel_[0-9a-f]{32}$/;
const READY_TIMEOUT_MS = 60_000;
const WATCH_MS = 15_000;
const OFFLINE_WATCH_MS = 5_000;
/** A client that stays unready this long is replaced; a single missed probe is not enough. */
const UNREADY_CONFIRM_MS = 15_000;
const MAX_BACKOFF_MS = 60_000;
const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function startOpenAi(opts: TunnelOptions): Promise<TunnelHandle> {
  if (!opts.binary) throw new Error('tunnel-client was not found. Install it, or point Connection settings at it.');
  if (!TUNNEL_ID_PATTERN.test(opts.tunnelId)) {
    throw new Error('Enter a tunnel ID that looks like tunnel_ followed by 32 hex characters.');
  }
  if (!opts.apiKey) throw new Error('Add your OpenAI tunnel API key first.');
  const workDir = await mkdtemp(path.join(os.tmpdir(), 'creatine-tunnel-'));
  const tunnel = new OpenAiTunnel(opts, workDir);
  tunnel.start();
  return tunnel;
}

class OpenAiTunnel implements TunnelHandle {
  private stopped = false;
  private current: ChildProcess | null = null;
  private timer: NodeJS.Timeout | null = null;
  private attempts = 0;
  private healthBase: string | null = null;
  private lastHandshake: number | null = null;
  private outage: OutageRun | null = null;
  private unreachableReason = '';
  private unreadySince = 0;
  private lastError = '';
  private shownOffline = false;
  private readonly log: ReturnType<typeof createLogger>;
  private readonly healthFile: string;

  constructor(private readonly opts: TunnelOptions, private readonly workDir: string) {
    this.log = createLogger(`tunnel.${opts.label}`);
    this.healthFile = path.join(workDir, 'health.url');
  }

  start(): void {
    void this.launch();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    const proc = this.current;
    this.current = null;
    if (proc) await stopProcess(proc);
    await rm(this.workDir, { recursive: true, force: true });
  }

  private later(fn: () => void, ms: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      fn();
    }, ms);
    this.timer.unref?.();
  }

  private reportConnected(): void {
    this.opts.report({
      state: 'connected',
      detail: this.lastHandshake
        ? `Connected. Last verified handshake with OpenAI ${secondsAgo(this.lastHandshake)}. Pick the tunnel in ChatGPT.`
        : 'Connected. Pick the tunnel in ChatGPT.',
      publicUrl: null,
      handshakeAt: this.lastHandshake
    });
  }

  private reportOffline(): void {
    this.opts.report({
      state: 'offline',
      detail: `This PC cannot reach OpenAI: ${this.unreachableReason || 'it stopped answering'}. ChatGPT cannot use the connector until it is back; the tunnel keeps retrying.`,
      publicUrl: null,
      handshakeAt: this.lastHandshake
    });
  }

  private reportFailed(state: ConnectionState, detail: string): void {
    this.opts.report({ state, detail, publicUrl: null, handshakeAt: this.lastHandshake });
  }

  private restart(proc: ChildProcess, detail: string, terminate: boolean): void {
    if (this.stopped || this.current !== proc) return;
    this.current = null;
    this.healthBase = null;
    this.outage = null;
    this.unreadySince = 0;
    this.attempts += 1;
    const wait = Math.min(MAX_BACKOFF_MS, 2000 * 2 ** (this.attempts - 1));
    this.reportFailed('connecting', `${detail} Reconnecting in ${Math.round(wait / 1000)}s.`);
    void (async () => {
      if (terminate) await stopProcess(proc);
      if (!this.stopped) this.later(() => void this.launch(), wait);
    })();
  }

  private async observeRoute(proc: ChildProcess): Promise<void> {
    if (this.stopped || this.current !== proc || !this.healthBase) return;
    const poll = await readPollHealth(this.healthBase);
    if (this.stopped || this.current !== proc) return;
    if (poll?.lastSuccessMs) this.lastHandshake = poll.lastSuccessMs;
    if (outageRecovered(this.outage, this.lastHandshake)) {
      this.outage = null;
      this.unreachableReason = '';
    }
    if (poll === null) {
      this.reportFailed('connecting', 'Tunnel client is ready, but its OpenAI poll metrics are unavailable.');
    } else if (outageConfirmed(this.outage, Date.now()) || (this.lastHandshake !== null && Date.now() - this.lastHandshake > POLL_FRESH_MS)) {
      if (!this.shownOffline) this.log.warn(`offline: ${this.unreachableReason || 'it stopped answering'}`);
      this.shownOffline = true;
      this.reportOffline();
    } else {
      if (this.shownOffline) this.log.info('connected again');
      this.shownOffline = false;
      this.reportConnected();
    }
  }

  private watch(proc: ChildProcess): void {
    this.later(() => {
      void (async () => {
        if (this.stopped || this.current !== proc || !this.healthBase) return;
        const ready = await probeReady(this.healthBase);
        if (this.stopped || this.current !== proc) return;
        if (!ready.ok) {
          const now = Date.now();
          if (this.unreadySince === 0) {
            this.unreadySince = now;
            this.log.warn(`not ready: ${ready.detail || 'no detail'}; rechecking before replacing it`);
          } else if (now - this.unreadySince >= UNREADY_CONFIRM_MS) {
            this.restart(proc, ready.detail || 'The tunnel stopped responding.', true);
            return;
          }
        } else {
          this.unreadySince = 0;
          await this.observeRoute(proc);
        }
        if (!this.stopped && this.current === proc) this.watch(proc);
      })();
    }, this.shownOffline ? OFFLINE_WATCH_MS : WATCH_MS);
  }

  private handleLine(proc: ChildProcess, line: string): void {
    if (this.stopped || this.current !== proc) return;
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
      this.stopped = true;
      this.current = null;
      if (this.timer) clearTimeout(this.timer);
      void stopProcess(proc);
      this.log.error('OpenAI refused the tunnel credentials');
      this.reportFailed(
        'auth-failed',
        'OpenAI refused access to this tunnel. Check its account, organization, API key and tunnel ID in Connection settings.'
      );
      return;
    }
    if (isUnreachable(`${message}: ${error}`) || isUnreachable(line)) {
      this.unreachableReason = describeNetworkError(error || message || line);
      if (this.outage === null) {
        this.outage = { since: Date.now(), handshakeBefore: this.lastHandshake };
        this.log.info(`${this.unreachableReason}; the client is retrying`);
      }
      return;
    }
    // Harpoon is an optional side channel that refuses loopback http targets; it never affects MCP.
    if (/harpoon/i.test(message) || /unsupported channel\s*["']harpoon/i.test(message)) return;
    if (level === 'ERROR' || level === 'FATAL' || level === 'WARN') {
      this.lastError = `${message}${error ? `: ${error}` : ''}`.slice(0, 400);
      this.log.warn(this.lastError);
    }
  }

  private async launch(): Promise<void> {
    if (this.stopped || this.current) return;
    await rm(this.healthFile, { force: true });
    const proc = spawn(this.opts.binary!, ['run', '--control-plane.tunnel-id', this.opts.tunnelId, '--health.listen-addr', '127.0.0.1:0', '--health.url-file', this.healthFile, '--log.format', 'json', '--log.level', 'info'], {
      // Credentials go in the environment, never argv, where other software could read them.
      env: {
        ...process.env,
        CONTROL_PLANE_API_KEY: this.opts.apiKey ?? '',
        MCP_SERVER_URL: `url=${this.opts.localUrl},channel=main`
      },
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    this.current = proc;
    this.reportFailed('connecting', this.attempts === 0 ? 'Starting tunnel client…' : 'Reconnecting…');
    onLines(proc.stdout!, (line) => this.handleLine(proc, line));
    onLines(proc.stderr!, (line) => this.handleLine(proc, line));
    proc.on('exit', (code) => {
      if (this.stopped || this.current !== proc) return;
      this.log.warn(`client exited with code ${code}`);
      this.restart(proc, this.lastError || `Tunnel client stopped (exit ${code}).`, false);
    });
    proc.on('error', (err) => {
      if (this.stopped || this.current !== proc) return;
      this.log.error(`client failed to start: ${err.message}`);
      this.restart(proc, `Could not start tunnel-client: ${err.message}`, true);
    });

    const deadline = Date.now() + READY_TIMEOUT_MS;
    while (!this.stopped && this.current === proc && Date.now() < deadline) {
      const base = await readHealthBase(this.healthFile);
      if (base) {
        const ready = await probeReady(base);
        if (this.stopped || this.current !== proc) return;
        if (ready.ok) {
          this.attempts = 0;
          this.healthBase = base;
          await this.observeRoute(proc);
          this.watch(proc);
          return;
        }
        this.lastError = ready.detail || this.lastError;
      }
      await delay(1000);
    }
    if (!this.stopped && this.current === proc) this.restart(proc, this.lastError || 'The tunnel did not become ready within 60 seconds.', true);
  }
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
