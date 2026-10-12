import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdir, open, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import os from 'node:os';
import { WebSocket } from 'ws';
import type { MainEvent, MainEvents, PreloadBridge, RendererApi, RendererChannel } from '@shared/ipc';
import type { AppState } from '@shared/types';
import { FRONTEND_MAX_BYTES, frontendAddressSchema, type FrontendMessage } from '@shared/frontend-protocol';

export function defaultProfile(): string {
  if (process.env.CREATINE_USER_DATA) return process.env.CREATINE_USER_DATA;
  const base = process.platform === 'win32' ? process.env.APPDATA ?? join(os.homedir(), 'AppData', 'Roaming')
    : process.platform === 'darwin' ? join(os.homedir(), 'Library', 'Application Support')
    : process.env.XDG_CONFIG_HOME ?? join(os.homedir(), '.config');
  return join(base, 'Chat on Creatine');
}

/** Node client implements the GUI bridge contract without loading an Electron renderer. */
export class BackendClient implements PreloadBridge {
  private readonly events = new EventEmitter();
  private nextId = 0;
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  state: AppState | null = null;

  constructor(private readonly socket: WebSocket) {
    socket.on('message', (data) => {
      const message = JSON.parse(data.toString()) as FrontendMessage;
      if (message.type === 'reply') {
        const pending = this.pending.get(message.id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        if (message.error) pending.reject(new Error(message.error));
        else pending.resolve(message.result);
      } else {
        if (message.event === 'state') this.state = message.payload;
        this.events.emit(message.event, message.payload);
      }
    });
    socket.on('error', (error) => this.events.emit('disconnect', error));
    socket.on('close', () => {
      const error = new Error('The Electron backend disconnected. Restart creatine to reconnect.');
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
      this.pending.clear();
      this.events.emit('disconnect', error);
    });
  }

  invoke<C extends RendererChannel>(channel: C, ...args: Parameters<RendererApi[C]>): Promise<Awaited<ReturnType<RendererApi[C]>>> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      if (this.socket.readyState !== WebSocket.OPEN) { reject(new Error('The Electron backend is not connected.')); return; }
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`The backend did not answer ${channel} within 2 minutes.`)); }, 120_000);
      this.pending.set(id, { resolve: (value) => resolve(value as Awaited<ReturnType<RendererApi[C]>>), reject, timer });
      this.socket.send(JSON.stringify({ id, channel, args }));
    });
  }

  on<E extends MainEvent>(event: E, listener: (payload: MainEvents[E]) => void): () => void {
    this.events.on(event, listener);
    return () => this.events.off(event, listener);
  }

  onDisconnect(listener: (error: Error) => void): () => void {
    this.events.on('disconnect', listener);
    return () => this.events.off('disconnect', listener);
  }

  async refresh(): Promise<AppState> {
    const state = await this.invoke('app:state');
    this.state = state;
    return state;
  }

  waitFor(test: (state: AppState) => boolean, timeoutMs: number): Promise<AppState> {
    if (this.state && test(this.state)) return Promise.resolve(this.state);
    return new Promise((resolve, reject) => {
      const clean = () => { clearTimeout(timer); offState(); offDisconnect(); };
      const offState = this.on('state', (state) => { if (test(state)) { clean(); resolve(state); } });
      const offDisconnect = this.onDisconnect((error) => { clean(); reject(error); });
      const timer = setTimeout(() => { clean(); reject(new Error('Timed out waiting for the backend. Use /status to check the connection.')); }, timeoutMs);
    });
  }

  close(): void { this.socket.close(); }
}

async function connect(file: string): Promise<BackendClient | null> {
  let raw: unknown;
  try { raw = JSON.parse(await readFile(file, 'utf8')); } catch { return null; }
  const parsed = frontendAddressSchema.safeParse(raw);
  if (!parsed.success) return null;
  const { port, token } = parsed.data;
  return new Promise((resolve) => {
    const socket = new WebSocket(`ws://127.0.0.1:${port}`, { headers: { Authorization: `Bearer ${token}` }, maxPayload: FRONTEND_MAX_BYTES, handshakeTimeout: 1500 });
    socket.once('error', () => { socket.terminate(); resolve(null); });
    socket.once('open', () => resolve(new BackendClient(socket)));
  });
}

export async function connectBackend(root: string, profile: string): Promise<BackendClient> {
  const file = join(profile, 'state', 'frontend.json');
  const existing = await connect(file);
  if (existing) { await existing.refresh(); return existing; }
  await mkdir(join(profile, 'logs'), { recursive: true });
  const logFile = join(profile, 'logs', 'cli-backend.log');
  const output = await open(logFile, 'a', 0o600);
  // Nix's bin wrapper sets Chromium's library paths; its libexec binary cannot launch alone.
  const executable = existsSync('/etc/NIXOS') ? 'electron' : createRequire(join(root, 'package.json'))('electron') as string;
  const args = [root, '--creatine-headless'];
  // Detached WebContents run without windows. Xvfb provides Chromium's display on Linux servers.
  const virtual = process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
  const child = spawn(virtual ? 'xvfb-run' : executable, virtual ? ['-a', executable, '--ozone-platform=x11', ...args] : args, {
    cwd: root, env: { ...process.env, CREATINE_USER_DATA: profile },
    stdio: ['ignore', output.fd, output.fd], detached: true, windowsHide: true
  });
  let failure: string | null = null;
  child.on('error', (error) => { failure = error.message; });
  child.on('exit', (code, signal) => { if (code || signal) failure = `Electron exited ${signal ?? `with code ${code}`}`; });
  child.unref();
  await output.close();
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline && !failure) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    const client = await connect(file);
    if (client) { await client.refresh(); return client; }
  }
  throw new Error(`Could not start the Electron backend${failure ? `: ${failure}` : ''}. See ${logFile}${virtual ? '. Install xvfb-run for displayless Linux' : ''}.`);
}
