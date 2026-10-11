import { randomUUID } from 'node:crypto';
import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { type IPty, spawn } from 'node-pty';
import { childEnv } from '../exec/env';
import { defaultShell } from '../exec/shell';

const FLUSH_MS = 16;

export interface TerminalCallbacks {
  onData(terminalId: string, data: string): void;
  onExit(terminalId: string, code: number | null): void;
}

interface Entry {
  pty: IPty;
  pending: string[];
  flush: NodeJS.Timeout | null;
}

/** Interactive shells for the terminal pane. Output is batched so a chatty program does not flood IPC. */
export class TerminalManager {
  private readonly terminals = new Map<string, Entry>();

  constructor(private readonly callbacks: TerminalCallbacks) {}

  open({ cwd, cols, rows }: { cwd: string | null; cols: number; rows: number }): string {
    const shell = defaultShell();
    const id = randomUUID();
    const env = childEnv({ TERM: 'xterm-256color', COLORTERM: 'truecolor' });
    for (const key of ['NO_COLOR', 'PAGER', 'GIT_PAGER', 'GH_PAGER']) delete env[key];

    const pty = spawn(shell.path, shell.type === 'powershell' ? ['-NoLogo'] : shell.type === 'cmd' ? [] : ['-l'], {
      name: 'xterm-256color',
      cols,
      rows,
      cwd: cwd && isDirectory(cwd) ? cwd : homedir(),
      env
    });

    const entry: Entry = { pty, pending: [], flush: null };
    this.terminals.set(id, entry);
    pty.onData((data) => {
      if (this.terminals.get(id) !== entry) return;
      entry.pending.push(data);
      entry.flush ??= setTimeout(() => this.flush(id, entry), FLUSH_MS);
    });
    pty.onExit(({ exitCode }) => {
      if (this.terminals.get(id) !== entry) return;
      this.flush(id, entry);
      this.terminals.delete(id);
      this.callbacks.onExit(id, exitCode);
    });
    return id;
  }

  write(id: string, data: string): void {
    this.terminals.get(id)?.pty.write(data);
  }

  resize(id: string, cols: number, rows: number): void {
    try {
      this.terminals.get(id)?.pty.resize(cols, rows);
    } catch {
      /* The shell exited between the request and the resize. */
    }
  }

  /** Kills the shell; no further output or exit event is reported for it. */
  close(id: string): void {
    const entry = this.terminals.get(id);
    if (!entry) return;
    this.terminals.delete(id);
    if (entry.flush) clearTimeout(entry.flush);
    try {
      entry.pty.kill();
    } catch {
      /* Already exited. */
    }
  }

  disposeAll(): void {
    for (const id of [...this.terminals.keys()]) this.close(id);
  }

  private flush(id: string, entry: Entry): void {
    if (entry.flush) clearTimeout(entry.flush);
    entry.flush = null;
    if (!entry.pending.length) return;
    const data = entry.pending.join('');
    entry.pending = [];
    this.callbacks.onData(id, data);
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
