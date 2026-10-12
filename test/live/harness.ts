import { spawn, type ChildProcess } from 'node:child_process';
import { cpSync, createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { join, resolve } from 'node:path';
import { GIFEncoder, applyPalette, quantize } from 'gifenc';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { Cdp, Ui } from './cdp';
import { connectBackend, defaultProfile, type BackendClient } from '../../src/cli/connection';
import type { Services } from '../../src/main/app/services';
import type { AppState, SessionEvent } from '../../src/shared/types';

export const ROOT = resolve(__dirname, '../..');
const RESULTS = join(ROOT, 'live-results');
/** What a signed-in session needs from the real profile; caches, history and logs stay behind. */
const PROFILE_FILES = ['config.json', 'secrets.json', 'Local State', 'Preferences', 'state/mcp-tokens.json', 'Partitions/chatgpt'];
const SKIP = /[/\\](Cache|Code Cache|GPUCache|DawnGraphiteCache|DawnWebGPUCache|blob_storage|Shared Dictionary)$/;
/** Set LIVE_DOCS=1 to also refresh the README images from this run. */
const DOCS = process.env.LIVE_DOCS === '1';
const README_IMAGES = ['chat-dark.png', 'chat-light.png', 'cli.gif'];

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
type Frame = { width: number; height: number; data: string; at: number };

/**
 * One live run of the real app against the signed-in ChatGPT account. It works on a copy of the
 * real profile and a fresh workspace, so a run never changes your settings or history, and it
 * keeps screenshots, GIFs, timelines and logs in `live-results/<run>`.
 */
export class Live {
  private readonly logFile;
  /** The app's window. */
  readonly ui: Ui;

  private constructor(readonly dir: string, readonly workspace: string, private readonly profile: string,
    private readonly app: ChildProcess, private readonly inspector: Cdp, readonly api: BackendClient) {
    this.ui = new Ui(inspector);
    this.logFile = join(dir, 'run.log');
  }

  static async launch(name: string, config: Record<string, unknown> = {}): Promise<Live> {
    const source = process.env.CREATINE_LIVE_PROFILE ?? defaultProfile();
    if (existsSync(join(source, 'state', 'frontend.json'))) throw new Error('Quit Chat on Creatine first: a live run uses the same ChatGPT login and tunnel.');
    if (!existsSync(join(ROOT, 'out', 'main', 'index.js'))) throw new Error('Build the app first: npm run build.');
    const dir = join(RESULTS, `${new Date().toISOString().replace(/[:.]/g, '-')}-${name}`);
    mkdirSync(dir, { recursive: true });
    // Outside the repo and home folder, so screenshots show a neutral path; copied into the run at the end.
    const workspace = mkdtempSync(join(process.platform === 'win32' ? os.tmpdir() : '/tmp', 'project-'));
    // A crashed run can leave its profile copy behind; it holds the login, so it goes first.
    for (const entry of readdirSync(os.tmpdir())) if (entry.startsWith('creatine-live-')) rmSync(join(os.tmpdir(), entry), { recursive: true, force: true });
    const profile = mkdtempSync(join(os.tmpdir(), 'creatine-live-'));
    for (const file of PROFILE_FILES) {
      if (existsSync(join(source, file))) cpSync(join(source, file), join(profile, file), { recursive: true, filter: (path) => !SKIP.test(path) });
    }
    const settings = existsSync(join(profile, 'config.json')) ? JSON.parse(readFileSync(join(profile, 'config.json'), 'utf8')) as Record<string, unknown> : {};
    writeFileSync(join(profile, 'config.json'), JSON.stringify({ ...settings, yolo: false, readOnly: false, ...config, roots: [{ id: 'live', path: workspace, label: 'live' }] }));

    const env: Record<string, string> = { ...process.env as Record<string, string>, CREATINE_USER_DATA: profile, CREATINE_DEBUG_GLOBAL: '1' };
    // An unfocused window must keep painting, or captures wait forever.
    // Only the main process gets a debugger. A DevTools port makes ChatGPT refuse the account.
    const args = ['--inspect=0', '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', ROOT];
    if (process.platform === 'linux') {
      // X11 everywhere (Xvfb or XWayland), so windows render the same and capture works.
      delete env.WAYLAND_DISPLAY;
      delete env.NIXOS_OZONE_WL;
      env.XDG_SESSION_TYPE = 'x11';
      args.unshift('--ozone-platform=x11', '--no-sandbox');
    }
    const app = spawn(createRequire(join(ROOT, 'package.json'))('electron') as string, args, { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const output = createWriteStream(join(dir, 'app.log'));
    app.stdout.pipe(output);
    let log = '';
    app.stderr.on('data', (chunk: Buffer) => { log += chunk.toString(); output.write(chunk); });
    const address = (pattern: RegExp) => pattern.exec(log)?.[1];
    for (const deadline = Date.now() + 60_000; !address(/Debugger listening on (ws:\S+)/); await sleep(200)) {
      if (Date.now() > deadline || app.exitCode !== null) throw new Error(`The app did not start its inspector. See ${join(dir, 'app.log')}.`);
    }
    const inspector = await Cdp.connect(address(/Debugger listening on (ws:\S+)/)!);
    for (const deadline = Date.now() + 60_000; !await inspector.evaluate<boolean>("process.mainModule?.require('electron').BrowserWindow.getAllWindows().some((window) => window.getTitle() === 'Chat on Creatine') ?? false"); await sleep(300)) {
      if (Date.now() > deadline) throw new Error('The app window did not open.');
    }
    await inspector.evaluate("process.mainModule.require('electron').BrowserWindow.getAllWindows().find((window) => window.getTitle() === 'Chat on Creatine').setSize(1440, 900)");
    // Connect only to this instance: connectBackend would start a second one if it is not up yet.
    const frontend = join(profile, 'state', 'frontend.json');
    for (const deadline = Date.now() + 60_000; !existsSync(frontend); await sleep(200)) if (Date.now() > deadline) throw new Error('The app did not start its frontend server.');
    const api = await connectBackend(ROOT, profile);
    const live = new Live(dir, workspace, profile, app, inspector, api);
    live.log(`run ${dir}`);
    return live;
  }

  log(...parts: unknown[]): void {
    const line = `${new Date().toISOString()} ${parts.map((part) => typeof part === 'string' ? part : JSON.stringify(part)).join(' ')}\n`;
    writeFileSync(this.logFile, line, { flag: 'a' });
    process.stdout.write(line);
  }

  get state(): AppState { return this.api.state!; }

  /** Waits until ChatGPT is signed in and the tools are connected, so a failure says which. */
  async ready(): Promise<void> {
    const state = await this.api.waitFor((value) => value.browser.signedIn !== null && value.connection.state !== 'connecting', 90_000);
    if (!state.browser.signedIn) throw new Error('The copied profile is not signed in to ChatGPT. Sign in in the app, then rerun.');
    if (state.connection.state !== 'connected') {
      await this.api.invoke('connection:connect');
      const connected = await this.api.waitFor((value) => ['connected', 'auth-failed', 'error'].includes(value.connection.state), 60_000);
      if (connected.connection.state !== 'connected') throw new Error(`Local tools are offline: ${connected.connection.detail}`);
    }
    this.log('ready', { model: state.models.defaultModel, connection: this.state.connection.state });
  }

  /** Sends like the composer does and returns the chat's ID. */
  async send(text: string, options: { sessionId?: string; delivery?: 'now' | 'after-turn'; attachments?: string[]; model?: string | null; automation?: 'off' | 'goal' | 'loop' } = {}): Promise<string> {
    const result = await this.api.invoke('chat:send', {
      sessionId: options.sessionId ?? null, text, attachments: options.attachments ?? [], delivery: options.delivery ?? 'now',
      cwd: this.workspace, model: options.model, automation: options.automation
    });
    this.log('sent', result.sessionId, text.slice(0, 120));
    return result.sessionId;
  }

  events(sessionId: string): Promise<SessionEvent[]> { return this.api.invoke('sessions:events', sessionId); }

  /**
   * Runs `run` in the main process with the app's services, for checks the frontend API does not
   * offer. It is sent as source, so it can use only its arguments.
   */
  main<A, R>(run: (services: Services, arg: A) => R | Promise<R>, arg: A): Promise<R> {
    // Vitest's transform may name functions with a `__name` helper the main process lacks.
    return this.inspector.evaluate(`(globalThis.__name ??= (fn) => fn, (${run.toString()})(globalThis.creatine, ${JSON.stringify(arg)}))`);
  }

  /** Polls a condition over the chat's events and state; `label` names what timed out. */
  async until(label: string, test: (events: SessionEvent[], state: AppState) => boolean, sessionId: string, timeoutMs = 300_000): Promise<SessionEvent[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const events = await this.events(sessionId);
      if (test(events, this.state)) return events;
      if (Date.now() > deadline) { await this.timeline(sessionId, `timeout-${label}`); throw new Error(`Timed out waiting for ${label}`); }
      await sleep(1500);
    }
  }

  /** The chat has ended at least `turns` turns and nothing is running or queued. */
  idle(sessionId: string, turns = 1): (events: SessionEvent[], state: AppState) => boolean {
    return (events, state) => events.filter((event) => event.kind === 'turn' && event.phase === 'end').length >= turns &&
      (state.live[sessionId]?.turn ?? 'idle') === 'idle' &&
      !state.inputs.some((input) => input.sessionId === sessionId && ['queued', 'sending'].includes(input.state)) &&
      !['deciding', 'waiting-workers'].includes(state.sessions.find((session) => session.id === sessionId)?.goal.status ?? '');
  }

  /** Writes the chat's timeline (`kind | surface | name | status | text | outcome`) and returns its rows. */
  async timeline(sessionId: string, name: string): Promise<string[]> {
    const rows = (await this.events(sessionId)).map((event) => [event.kind, 'surface' in event ? event.surface : '',
      'name' in event ? event.name : 'channel' in event ? event.channel : 'phase' in event ? event.phase : 'action' in event ? event.action : '',
      'status' in event ? event.status : '', ('text' in event ? event.text : '').replace(/\s+/g, ' ').slice(0, 160), 'outcome' in event ? event.outcome ?? '' : ''].join(' | '));
    writeFileSync(join(this.dir, `${name}.timeline.txt`), `${rows.join('\n')}\n`);
    return rows;
  }

  /** Opens a chat in the window by its sidebar entry. */
  async open(sessionId: string): Promise<void> {
    const title = (await this.api.refresh()).sessions.find((session) => session.id === sessionId)?.title ?? '';
    await this.ui.click('.session-row-main', title);
  }

  /** A PNG of the window or one element, captured by Electron (CDP screenshots stall under Xvfb). */
  async shot(name: string, target?: string): Promise<string> {
    const file = join(this.dir, `${name}.png`);
    writeFileSync(file, Buffer.from(await this.capture(target, 'png'), 'base64'));
    this.publish(file, `${name}.png`);
    return file;
  }

  /** Records `target` as a GIF while `run` works; unchanged frames collapse into one longer frame. */
  async record<T>(name: string, run: () => Promise<T>, target?: string, fps = 3): Promise<T> {
    const frames: Frame[] = [];
    let recording = true;
    const loop = (async () => {
      while (recording) {
        const started = Date.now();
        frames.push(await this.frame(target, started));
        await sleep(Math.max(0, 1000 / fps - (Date.now() - started)));
      }
    })();
    try { return await run(); } finally {
      recording = false;
      await loop;
      const file = join(this.dir, `${name}.gif`);
      writeFileSync(file, encode(frames));
      this.publish(file, `${name}.gif`);
      this.log('recorded', file, `${frames.length} frames`);
    }
  }

  private async frame(target: string | undefined, at: number): Promise<Frame> {
    const [width, height, data] = (await this.capture(target, 'bitmap')).split(':');
    return { width: Number(width), height: Number(height), data: data!, at };
  }

  /** Base64 PNG, or `width:height:base64 BGRA` scaled to at most 960 px wide for GIF frames; `target` is a CSS selector. */
  private async capture(target: string | undefined, format: 'png' | 'bitmap'): Promise<string> {
    const box = target ? await this.ui.box(target) : null;
    const rect = box && { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) };
    return this.inspector.evaluate(`(async () => {
      const { BrowserWindow } = process.mainModule.require('electron');
      const window = BrowserWindow.getAllWindows().find((item) => item.getTitle() === 'Chat on Creatine' && item.isVisible());
      const image = await window.webContents.capturePage(${JSON.stringify(rect ?? undefined) ?? 'undefined'});
      if (${JSON.stringify(format)} === 'png') return image.toPNG().toString('base64');
      const scaled = image.getSize().width > 960 ? image.resize({ width: 960, quality: 'good' }) : image;
      return scaled.getSize().width + ':' + scaled.getSize().height + ':' + scaled.toBitmap().toString('base64');
    })()`);
  }

  /** Keeps what a failed test saw: the window and the visible text. */
  async failed(test: string): Promise<void> {
    const name = `failed-${test.replace(/\W+/g, '-').slice(0, 60)}`;
    await this.shot(name);
    writeFileSync(join(this.dir, `${name}.txt`), await this.ui.evaluate<string>('document.body.innerText'));
    this.log('failed', test);
  }

  private publish(file: string, name: string): void {
    if (DOCS && README_IMAGES.includes(name)) cpSync(file, join(ROOT, 'docs', 'screenshots', name));
  }

  async close(): Promise<void> {
    this.api.close();
    const exited = new Promise((done) => this.app.once('exit', done));
    await this.inspector.evaluate("process.mainModule.require('electron').app.quit()").catch((error: unknown) => this.log('quit failed', String(error)));
    this.inspector.close();
    if (await Promise.race([exited.then(() => true), sleep(20_000).then(() => false)]) === false) this.app.kill();
    const logs = join(this.profile, 'logs');
    if (existsSync(logs)) for (const file of readdirSync(logs)) cpSync(join(logs, file), join(this.dir, file));
    cpSync(this.workspace, join(this.dir, 'workspace'), { recursive: true });
    rmSync(this.workspace, { recursive: true, force: true });
    // The copy holds the ChatGPT cookies and tunnel key; it never outlives the run.
    rmSync(this.profile, { recursive: true, force: true });
  }
}

/** One app for a test file: launched and ready before the tests, with failures captured. */
export function useLive(name: string, config?: Record<string, unknown>): () => Live {
  let live: Live | undefined;
  beforeAll(async () => { live = await Live.launch(name, config); await live.ready(); });
  afterEach(async ({ task }) => { if (task.result?.state === 'fail') await live?.failed(task.name); });
  afterAll(async () => { await live?.close(); });
  return () => live!;
}

export const tools = (events: SessionEvent[]) => events.flatMap((event) => event.kind === 'tool' ? [event] : []);
export const answer = (events: SessionEvent[]) => events.flatMap((event) => event.kind === 'assistant' && event.channel === 'final' ? [event.text] : []).at(-1) ?? '';
export const outcomes = (events: SessionEvent[]) => events.flatMap((event) => event.kind === 'turn' && event.phase === 'end' ? [event.outcome] : []);

/** Frames as a GIF, playing waits at most 1.5 s per unchanged stretch. */
function encode(frames: Frame[]): Uint8Array {
  const gif = GIFEncoder();
  const first = frames[0];
  const kept = frames.filter((frame, index) => frame.width === first?.width && frame.height === first.height && frame.data !== frames[index - 1]?.data);
  kept.forEach((frame, index) => {
    const bgra = Buffer.from(frame.data, 'base64');
    for (let offset = 0; offset < bgra.length; offset += 4) { const blue = bgra[offset]!; bgra[offset] = bgra[offset + 2]!; bgra[offset + 2] = blue; }
    const palette = quantize(bgra, 256);
    const next = kept[index + 1]?.at ?? frame.at + 1500;
    gif.writeFrame(applyPalette(bgra, palette), frame.width, frame.height, { palette, delay: Math.min(1500, Math.max(100, next - frame.at)) });
  });
  gif.finish();
  return gif.bytes();
}
