import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { ToolError, type ExecResult } from '../src/main/mcp/tool';
import { ProcessManager } from '../src/main/exec/process-manager';
import { HeadTailBuffer, truncateToTokens } from '../src/main/exec/output';
import os from 'node:os';

const manager = new ProcessManager();
afterAll(() => manager.dispose());

/** Polls a session until it reports an exit code; the output of each poll is concatenated. */
async function pollUntilExit(sessionId: string, owner: string): Promise<{ output: string; result: ExecResult }> {
  let output = '';
  for (let attempt = 0; attempt < 40; attempt++) {
    const result = await manager.writeStdin({ sessionId, chars: '' }, owner);
    output += result.output;
    if (result.exitCode !== null) return { output, result };
  }
  throw new Error('session did not exit');
}


// node-pty is built for Electron's ABI by `npm run rebuild-native`; plain Node may not load it.
const ptyLoads = (() => {
  try {
    createRequire(import.meta.url)('node-pty');
    return true;
  } catch {
    return false;
  }
})();

describe('ProcessManager', () => {
  it('returns output and the exit code of a command that finishes within the yield window', async () => {
    // A generous window: exec returns as soon as the command exits, and PowerShell starts slowly.
    const result = await manager.exec({ cmd: 'echo hello', workdir: os.homedir(), yieldTimeMs: 10_000 }, 'chat-a');
    expect(result.exitCode).toBe(0);
    expect(result.sessionId).toBeNull();
    expect(result.output).toContain('hello');
  });

  it('keeps a running command as a session and releases it once its exit is reported', async () => {
    const started = await manager.exec(
      { cmd: 'sleep 0.5; echo late; exit 3', workdir: os.homedir(), yieldTimeMs: 250 },
      'chat-a'
    );
    expect(started.sessionId).not.toBeNull();
    expect(started.exitCode).toBeNull();

    const { output, result } = await pollUntilExit(started.sessionId!, 'chat-a');
    expect(output).toContain('late');
    expect(result.exitCode).toBe(3);
    expect(result.sessionId).toBeNull();
    await expect(manager.writeStdin({ sessionId: started.sessionId!, chars: '' }, 'chat-a')).rejects.toMatchObject({
      code: 'UNKNOWN_SESSION'
    });
  });

  it('writes input to an interactive process and reads its echo', async () => {
    // A node echo behaves the same under every shell; PowerShell's `cat` is Get-Content.
    const echo = `node -e "process.stdin.pipe(process.stdout)"`;
    const started = await manager.exec({ cmd: echo, workdir: os.homedir(), yieldTimeMs: 250 }, 'chat-a');
    const echoed = await manager.writeStdin({ sessionId: started.sessionId!, chars: 'ping\n', yieldTimeMs: 2000 }, 'chat-a');
    expect(echoed.output).toContain('ping');
    expect(echoed.sessionId).toBe(started.sessionId);
  });

  it('runs a batch in one shell, continues past a failing item and exits with its code', async () => {
    const result = await manager.exec(
      { cmds: ['echo one', 'false', 'echo three'], workdir: os.homedir(), yieldTimeMs: 2000 },
      'chat-a'
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('--- command 2/3 ---');
    expect(result.output).toContain('one');
    expect(result.output).toContain('three');
  });

  it('refuses a session id that belongs to another owner', async () => {
    const started = await manager.exec({ cmd: 'cat', workdir: os.homedir(), yieldTimeMs: 250 }, 'chat-owner');
    const attempt = manager.writeStdin({ sessionId: started.sessionId!, chars: 'x' }, 'chat-other');
    await expect(attempt).rejects.toBeInstanceOf(ToolError);
    await expect(attempt).rejects.toMatchObject({ code: 'UNKNOWN_SESSION' });
  });

  it('rejects a working directory that does not exist', async () => {
    await expect(
      manager.exec({ cmd: 'true', workdir: '/definitely/not/a/dir', yieldTimeMs: 250 }, 'chat-a')
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
  });

  it('truncates output to the token budget and reports the original size', async () => {
    const result = await manager.exec({ cmd: 'seq 1 2000', workdir: os.homedir(), yieldTimeMs: 2000, maxOutputTokens: 20 }, 'chat-a');
    expect(result.originalTokenCount).toBeGreaterThan(20);
    expect(result.output).toContain('tokens truncated');
    expect(Buffer.byteLength(result.output)).toBeLessThan(200);
  });

  it.skipIf(!ptyLoads)('runs a command on a pseudo-terminal when tty is requested', async () => {
    const result = await manager.exec({ cmd: 'echo tty-ok', workdir: os.homedir(), tty: true, yieldTimeMs: 2000 }, 'chat-a');
    expect(result.output).toContain('tty-ok');
    expect(result.exitCode).toBe(0);
  });
});

describe('output buffers', () => {
  it('keeps head and tail of a bounded stream and counts the omitted middle', () => {
    const buffer = new HeadTailBuffer(10);
    buffer.push(Buffer.from('abcdefghijklmnop'));
    expect(buffer.text()).toBe('abcde\n... 6 bytes omitted ...\nlmnop');
  });

  it('leaves text within the budget untouched', () => {
    expect(truncateToTokens('short', 100)).toEqual({ text: 'short', originalTokenCount: null });
  });
});
