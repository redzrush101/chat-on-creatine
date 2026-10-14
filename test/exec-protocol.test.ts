import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { defaultConfig } from '@shared/config';
import { ProcessManager } from '../src/main/exec/process-manager';
import { RootGuard } from '../src/main/fs/roots';
import { McpHttpServer, generateToken } from '../src/main/mcp/server';
import { execCommandTool } from '../src/main/mcp/tools/exec-command';
import { writeStdinTool } from '../src/main/mcp/tools/write-stdin';

it('passes a running command ID directly from exec_command to write_stdin over MCP', async () => {
  const root = await mkdtemp(join(os.tmpdir(), 'creatine-exec-'));
  const config = defaultConfig();
  config.roots = [{ id: 'test', path: root, label: 'Test' }];
  const processes = new ProcessManager();
  let callerCwd: string | null = null;
  const server = new McpHttpServer({
    getConfig: () => config,
    tools: [execCommandTool, writeStdinTool],
    services: { paths: new RootGuard(() => config), processes, setPlan: () => {}, agents: null, finish: null },
    tokens: { core: generateToken(), desktop: generateToken(), plugins: generateToken() },
    resolveCaller: async () => callerCwd ? { sessionId: 'chat', conversationId: 'conversation', cwd: callerCwd, kind: 'chat' } : null,
    steering: () => []
  });
  const client = new Client({ name: 'test', version: '1' });
  try {
    await server.start(0);
    await client.connect(new StreamableHTTPClientTransport(new URL(server.localUrl('core')!)));
    const started = await client.callTool({ name: 'exec_command', arguments: {
      // Node reads the line, so the command means the same in bash, zsh and PowerShell.
      cmd: `node -e "process.stdin.once('data', (d) => { process.stdout.write('received:' + String(d).trim() + '\\n'); process.exit(0); })"`,
      workdir: root,
      yield_time_ms: 250
    } });
    expect(started.isError, JSON.stringify(started.content)).toBe(false);
    const { session_id: sessionId } = z.object({ session_id: z.number().int().nonnegative() }).parse(started.structuredContent);
    const finished = await client.callTool({ name: 'write_stdin', arguments: {
      session_id: sessionId, chars: 'roundtrip\n', yield_time_ms: 2000
    } });
    expect(finished.isError, JSON.stringify(finished.content)).toBe(false);
    const data = z.object({ output: z.string(), exit_code: z.number().optional() }).parse(finished.structuredContent);
    expect(data.output).toBe('received:roundtrip\n');
    const exit = data.exit_code === undefined
      ? await client.callTool({ name: 'write_stdin', arguments: { session_id: sessionId, yield_time_ms: 2000 } })
      : finished;
    expect(exit.structuredContent).toMatchObject({ exit_code: 0 });
    const patch = `*** Begin Patch\n*** Add File: ${join(root, 'from-shell.txt')}\n+PATCH_OK\n*** End Patch`;
    const patched = await client.callTool({ name: 'exec_command', arguments: { cmd: `apply_patch <<'EOF'\n${patch}\nEOF` } });
    expect(patched.isError, JSON.stringify(patched.content)).toBe(false);
    expect(patched.structuredContent).toMatchObject({ exit_code: 0, output: expect.stringContaining('Success. Updated') });
    expect(await readFile(join(root, 'from-shell.txt'), 'utf8')).toBe('PATCH_OK\n');
    callerCwd = os.tmpdir();
    const outside = await client.callTool({ name: 'exec_command', arguments: { cmd: 'echo should-not-run' } });
    expect(outside.isError).toBe(true);
    expect(JSON.stringify(outside.content)).toContain('outside the approved folders');
  } finally {
    await client.close();
    await server.stop();
    await processes.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
