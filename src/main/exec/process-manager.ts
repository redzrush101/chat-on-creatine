import { spawn, type ChildProcess } from 'node:child_process';
import { stat } from 'node:fs/promises';
import os from 'node:os';
import { ToolError, type ExecRequest, type ExecResult, type ProcessRunner, type WriteStdinRequest } from '../mcp/tool';
import { childEnv, terminateProcessTree } from './env';
import { DEFAULT_MAX_OUTPUT_TOKENS, HeadTailBuffer, truncateToTokens } from './output';
import { batchScript, resolveShell, shellArgv, type ShellSpec } from './shell';

const MIN_YIELD_MS = 250;
const MAX_YIELD_MS = 30_000;
const DEFAULT_EXEC_YIELD_MS = 10_000;
const DEFAULT_STDIN_YIELD_MS = 250;
const MIN_EMPTY_POLL_MS = 5_000;
const MAX_EMPTY_POLL_MS = 300_000;
const MAX_SESSIONS = 64;
const MAX_BATCH_COMMANDS = 20;
/** After a process exits, its output pipes get this long to close so the last bytes are not lost. */
const POST_EXIT_CLOSE_MS = 50;
const INTERRUPT = '\u0003';
const FIRST_SESSION_ID = 1000;

export interface ProcessInfo {
  sessionId: string;
  command: string;
  owner: string;
  startedAt: number;
}

interface PtyHandle {
  pid: number;
  onData(listener: (data: string) => void): unknown;
  onExit(listener: (event: { exitCode: number }) => void): unknown;
  write(data: string): void;
}

/** One live command: its output not yet returned to a caller, and its exit state. */
class Session {
  readonly startedAt = Date.now();
  lastUsedAt = this.startedAt;
  pending = new HeadTailBuffer();
  exited = false;
  exitCode: number | null = null;
  /** Output streams have closed (only meaningful once exited). */
  closed = false;
  pid: number | undefined;
  private writer: ((data: string) => boolean) | null = null;
  private waiters = new Set<() => void>();

  constructor(
    readonly id: string,
    readonly owner: string,
    readonly command: string,
    readonly cwd: string
  ) {}

  attach(pid: number | undefined, writer: (data: string) => boolean): void {
    this.pid = pid;
    this.writer = writer;
  }

  write(data: string): boolean {
    return this.writer?.(data) ?? false;
  }

  push(chunk: Buffer): void {
    this.pending.push(chunk);
    this.notify();
  }

  finish(exitCode: number | null): void {
    if (!this.exited) {
      this.exited = true;
      this.exitCode = exitCode;
    }
    this.notify();
  }

  close(): void {
    this.closed = true;
    this.notify();
  }

  takeOutput(): HeadTailBuffer {
    const output = this.pending;
    this.pending = new HeadTailBuffer();
    return output;
  }

  /** Resolves on the next output or state change, or after `ms`. */
  nextEvent(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.waiters.add(done);
    });
  }

  private notify(): void {
    for (const waiter of [...this.waiters]) waiter();
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

async function loadPty(): Promise<typeof import('node-pty')> {
  try {
    const module = await import('node-pty');
    return (module as { default?: typeof import('node-pty') }).default ?? module;
  } catch {
    throw new ToolError('FAILED', 'Terminal (tty) commands are not available on this machine.');
  }
}

/**
 * Runs commands for the exec_command and write_stdin tools. A command that finishes within its
 * yield window returns at once; one still running stays a session that the owning chat can poll
 * or write to until it exits.
 */
export class ProcessManager implements ProcessRunner {
  private readonly sessions = new Map<string, Session>();
  private nextId = FIRST_SESSION_ID;

  list(): ProcessInfo[] {
    return [...this.sessions.values()].map((session) => ({
      sessionId: session.id,
      command: session.command,
      owner: session.owner,
      startedAt: session.startedAt
    }));
  }

  async dispose(): Promise<void> {
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.all(sessions.map((session) => (session.pid === undefined ? undefined : terminateProcessTree(session.pid))));
  }

  async exec(request: ExecRequest, owner: string): Promise<ExecResult> {
    const started = Date.now();
    const commands = request.cmd !== undefined ? [request.cmd] : (request.cmds ?? []);
    if (commands.length === 0 || commands.length > MAX_BATCH_COMMANDS) {
      throw new ToolError('INVALID_ARGUMENT', `Pass one command, or between 1 and ${MAX_BATCH_COMMANDS} in cmds.`);
    }
    const cwd = request.workdir ?? os.homedir();
    await assertDirectory(cwd);

    const shell = resolveShell(request.shell, cwd);
    if (!shell) throw new ToolError('INVALID_ARGUMENT', `The shell ${request.shell} was not found.`);
    const script = request.cmd !== undefined ? request.cmd : batchOrThrow(commands, shell);
    const display = commands.join('\n');

    this.makeRoom();
    const session = await this.spawnSession(owner, display, shellArgv(shell, script), cwd, request.tty ?? false);
    this.sessions.set(session.id, session);

    const deadline = started + clamp(request.yieldTimeMs ?? DEFAULT_EXEC_YIELD_MS, MIN_YIELD_MS, MAX_YIELD_MS);
    const output = await collect(session, deadline, false);
    return this.result(session, output, started, request.maxOutputTokens);
  }

  async writeStdin(request: WriteStdinRequest, owner: string): Promise<ExecResult> {
    const started = Date.now();
    const session = this.sessions.get(request.sessionId);
    if (!session || session.owner !== owner) {
      throw new ToolError('UNKNOWN_SESSION', `No running session ${request.sessionId} is available to this chat.`);
    }
    session.lastUsedAt = started;

    const chars = request.chars;
    if (chars !== '') {
      if (session.exited) {
        throw new ToolError(
          'FAILED',
          `Process already exited with code ${session.exitCode ?? 'unknown'}; no input was sent. Poll with empty chars to read its final output.`
        );
      }
      if (!session.write(chars)) {
        throw new ToolError('FAILED', 'The process stdin is closed; no input was sent.');
      }
    }

    const base = Math.max(request.yieldTimeMs ?? DEFAULT_STDIN_YIELD_MS, MIN_YIELD_MS);
    const yieldMs =
      chars === ''
        ? clamp(base, MIN_EMPTY_POLL_MS, MAX_EMPTY_POLL_MS)
        : clamp(base, MIN_YIELD_MS, MAX_YIELD_MS);
    const output = await collect(session, started + yieldMs, chars === '');
    return this.result(session, output, started, request.maxOutputTokens);
  }

  /** Builds the reply, and releases the session once its exit has been reported. */
  private result(
    session: Session,
    output: HeadTailBuffer,
    started: number,
    maxOutputTokens: number | undefined
  ): ExecResult {
    const truncated = truncateToTokens(output.text(), maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS);
    if (session.exited) this.sessions.delete(session.id);
    return {
      sessionId: session.exited ? null : session.id,
      exitCode: session.exited ? session.exitCode : null,
      output: truncated.text,
      wallTimeMs: Date.now() - started,
      originalTokenCount: truncated.originalTokenCount,
      command: session.command,
      cwd: session.cwd
    };
  }

  /** Frees a slot before a new spawn: exited sessions first, then the least recently used running one. */
  private makeRoom(): void {
    if (this.sessions.size < MAX_SESSIONS) return;
    const byLastUse = [...this.sessions.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt);
    for (const session of byLastUse) {
      if (this.sessions.size < MAX_SESSIONS) return;
      if (session.exited) this.sessions.delete(session.id);
    }
    const oldest = byLastUse.find((session) => this.sessions.has(session.id));
    if (oldest && this.sessions.size >= MAX_SESSIONS) {
      this.sessions.delete(oldest.id);
      if (oldest.pid !== undefined) void terminateProcessTree(oldest.pid);
    }
  }

  private async spawnSession(owner: string, command: string, argv: string[], cwd: string, tty: boolean): Promise<Session> {
    const session = new Session(String(this.nextId++), owner, command, cwd);
    const [file, ...args] = argv as [string, ...string[]];
    const env = childEnv();

    if (tty) {
      const pty = await loadPty();
      const handle = pty.spawn(file, args, { name: 'dumb', cols: 80, rows: 24, cwd, env: env as Record<string, string> }) as unknown as PtyHandle;
      session.attach(handle.pid, (data) => {
        handle.write(data);
        return true;
      });
      handle.onData((data) => session.push(Buffer.from(data, 'utf8')));
      handle.onExit(({ exitCode }) => {
        session.finish(exitCode);
        session.close();
      });
      return session;
    }

    // Detached on POSIX so the whole process group can be signalled, including descendants.
    const child: ChildProcess = spawn(file, args, {
      cwd,
      env,
      detached: process.platform !== 'win32',
      windowsHide: true,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    child.stdin?.on('error', () => undefined);
    child.stdout?.on('data', (chunk: Buffer) => session.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => session.push(chunk));
    child.once('error', (error) => {
      session.push(Buffer.from(`${error.message}\n`, 'utf8'));
      session.finish(null);
      session.close();
    });
    child.once('exit', (code) => session.finish(code));
    child.once('close', () => session.close());
    session.attach(child.pid, (data) => {
      if (data === INTERRUPT && process.platform !== 'win32' && child.pid !== undefined) {
        try {
          process.kill(-child.pid, 'SIGINT');
        } catch {
          /* already gone */
        }
        return true;
      }
      const stdin = child.stdin;
      if (!stdin || stdin.destroyed || stdin.writableEnded) return false;
      stdin.write(data);
      return true;
    });
    return session;
  }
}

function batchOrThrow(commands: readonly string[], shell: ShellSpec): string {
  if (shell.type === 'cmd') throw new ToolError('INVALID_ARGUMENT', 'cmds needs a POSIX shell or PowerShell, not cmd.exe.');
  return batchScript(commands, shell.type);
}

async function assertDirectory(cwd: string): Promise<void> {
  const info = await stat(cwd).catch(() => null);
  if (!info?.isDirectory()) throw new ToolError('INVALID_ARGUMENT', `The working directory ${cwd} does not exist.`);
}

/**
 * Waits for output until the deadline, the process exits, or (for an empty poll) output arrives.
 * Output is taken once at the end, so everything read during the wait comes back together.
 */
async function collect(session: Session, deadline: number, returnOnFirstOutput: boolean): Promise<HeadTailBuffer> {
  let exitedAt: number | null = null;
  for (;;) {
    if (returnOnFirstOutput && session.pending.totalBytes() > 0) break;
    const now = Date.now();
    if (session.exited) {
      if (session.closed) break;
      exitedAt ??= now;
      const left = exitedAt + POST_EXIT_CLOSE_MS - now;
      if (left <= 0) break;
      await session.nextEvent(left);
      continue;
    }
    const left = deadline - now;
    if (left <= 0) break;
    await session.nextEvent(left);
  }
  return session.takeOutput();
}
