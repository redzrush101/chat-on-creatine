import type { ChildProcess } from 'node:child_process';
import { terminateProcessTree } from '../exec/env';

/** Terminates the child and anything it started, escalating to SIGKILL if it lingers. */
export async function stopProcess(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  void terminateProcessTree(pid, 'SIGTERM');
  const escalate = setTimeout(() => void terminateProcessTree(pid, 'SIGKILL'), 3000);
  await exited;
  clearTimeout(escalate);
}

/** Calls back once per complete line of a child's output. */
export function onLines(stream: NodeJS.ReadableStream, onLine: (line: string) => void): void {
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

