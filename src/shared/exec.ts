export interface ExecRequest {
  /** Exactly one of `cmd` / `cmds`. */
  cmd?: string;
  cmds?: string[];
  workdir: string | null;
  shell?: string;
  login?: boolean;
  tty?: boolean;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
}

export interface WriteStdinRequest {
  sessionId: string;
  chars: string;
  yieldTimeMs?: number;
  maxOutputTokens?: number;
}

export interface ExecResult {
  /** Present while the process keeps running; pass it to write_stdin. */
  sessionId: string | null;
  exitCode: number | null;
  output: string;
  wallTimeMs: number;
  /** Original token estimate when the output was truncated. */
  originalTokenCount: number | null;
  command: string;
  cwd: string | null;
}
