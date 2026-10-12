import { createRequire } from 'node:module';
import { afterAll, describe, expect, it } from 'vitest';
import { ToolError, type ExecResult } from '../src/main/mcp/tool';
import { ProcessManager } from '../src/main/exec/process-manager';
import { HeadTailBuffer, truncateToTokens } from '../src/main/exec/output';
import { defaultShell } from '../src/main/exec/shell';
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
      { cmd: `node -e "setTimeout(() => { process.stdout.write('late'); process.exit(3); }, 1500)"`, workdir: os.homedir(), yieldTimeMs: 250 },
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
      { cmds: ['echo one', 'node -e "process.exit(1)"', 'echo three'], workdir: os.homedir(), yieldTimeMs: 10_000 },
      'chat-a'
    );
    expect(result.exitCode).toBe(1);
    expect(result.output).toContain('--- command 2/3 ---');
    expect(result.output).toContain('one');
    expect(result.output).toContain('three');
  });

  it('interrupts a piped command instead of writing a literal Ctrl+C byte', async () => {
    const started = await manager.exec({
      cmd: `node -e "setInterval(() => {}, 1000)"`, workdir: os.homedir(), yieldTimeMs: 250
    }, 'chat-a');
    expect(started.sessionId).not.toBeNull();
    const stopped = await manager.writeStdin({ sessionId: started.sessionId!, chars: '\u0003', yieldTimeMs: 10_000 }, 'chat-a');
    expect(stopped.sessionId).toBeNull();
  });

  it('refuses a session id that belongs to another owner', async () => {
    const started = await manager.exec({ cmd: `node -e "process.stdin.pipe(process.stdout)"`, workdir: os.homedir(), yieldTimeMs: 250 }, 'chat-owner');
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
    const result = await manager.exec({ cmd: `node -e "for (let i = 1; i <= 2000; i++) console.log(i)"`, workdir: os.homedir(), yieldTimeMs: 2000, maxOutputTokens: 20 }, 'chat-a');
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

describe('defaultShell', () => {
  const login = process.platform === 'win32' ? '' : os.userInfo().shell ?? '';
  // Only meaningful where the account's login shell is a POSIX shell other than /bin/sh.
  it.runIf(/\/(zsh|bash)$/.test(login))('starts the account login shell even when $SHELL points elsewhere', () => {
    const saved = process.env.SHELL;
    process.env.SHELL = '/bin/sh';
    try {
      expect(defaultShell().path).toBe(login);
    } finally {
      process.env.SHELL = saved;
    }
  });
});
