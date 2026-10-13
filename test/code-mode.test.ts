import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { z } from 'zod';
import { defaultConfig, type Config } from '@shared/config';
import type { SurfaceId } from '@shared/types';
import { McpHttpServer, generateToken, type CallRecord } from '../src/main/mcp/server';
import { defineTool, textResult, type Caller, type ToolServices } from '../src/main/mcp/tool';

const tokens: Record<SurfaceId, string> = { core: generateToken(), desktop: generateToken(), plugins: generateToken() };
const caller: Caller = { sessionId: 's1', conversationId: 'c1', cwd: null, kind: 'chat' };
const calls: CallRecord[] = [];
let disabled = false;

const echo = defineTool({
  name: 'echo',
  surface: 'core',
  title: 'Echo',
  description: 'Echoes text.',
  input: { value: z.string() },
  exposed: () => true,
  run: async (args) => textResult(`echo:${args.value}`)
});

/** Turns itself off after its first call, so a later nested call hits the live exposure check. */
const flaky = defineTool({
  name: 'flaky-tool',
  surface: 'core',
  title: 'Flaky',
  description: 'Disables itself.',
  input: {},
  exposed: () => !disabled,
  run: async () => {
    disabled = true;
    return textResult('ok');
  }
});

const sessionFinish = defineTool({
  name: 'session_finish',
  surface: 'core',
  title: 'Finish',
  description: 'Would finish the turn.',
  input: {},
  exposed: () => true,
  run: async () => textResult('finished')
});

const tools = [echo, flaky, sessionFinish];

const server = new McpHttpServer({
  getConfig: (): Config => defaultConfig(),
  tools,
  services: {} as ToolServices,
  tokens,
  resolveCaller: async (requestId) => requestId === 'wfr_abc' ? caller : requestId === 'wfr_other' ? { ...caller, sessionId: 's2' } : null,
  steering: () => [],
  hooks: { onCallEnd: (call) => calls.push(call) }
});

async function connect(requestId = 'wfr_abc'): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(server.localUrl('core')!), {
    requestInit: { headers: { 'x-request-id': `${requestId}/t` } }
  });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

/** Runs one exec call and returns its text blocks and error flag. */
async function run(client: Client, code: string): Promise<{ texts: string[]; isError: boolean }> {
  const result = await client.callTool({ name: 'exec', arguments: { code } });
  const texts = (result.content as Array<{ type: string; text: string }>).slice(1).map((block) => block.text);
  return { texts, isError: result.isError === true };
}

describe('code mode (exec)', () => {
  let client: Client;

  beforeAll(async () => {
    await server.start(0);
    client = await connect();
  });
  afterAll(async () => {
    await client.close();
    await server.stop();
  });
  beforeEach(() => {
    disabled = false;
    calls.length = 0;
  });

  it('is added to a surface with tools and lists them in ALL_TOOLS', async () => {
    const listedTools = (await client.listTools()).tools;
    expect(listedTools.find((tool) => tool.name === 'exec')?.description).toContain('Tools here: echo({value})');
    const { texts, isError } = await run(client, 'text(ALL_TOOLS)');
    expect(isError).toBe(false);
    const listed = (JSON.parse(texts[0]!) as Array<{ name: string }>).map((tool) => tool.name);
    expect(listed).toEqual(expect.arrayContaining(['echo', 'flaky-tool', 'session_finish']));
    expect(listed).not.toContain('exec');
  });

  it('returns the nested result of a tool call', async () => {
    const { texts, isError } = await run(client, "const r = await tools.echo({value:'x'}); text(r)");
    expect(isError).toBe(false);
    expect((JSON.parse(texts[0]!) as { content: Array<{ text: string }> }).content[0]!.text).toBe('echo:x');
  });

  it('validates nested arguments before executing the tool', async () => {
    const { texts, isError } = await run(client, 'text(await tools.echo({value: 42}))');
    const result = JSON.parse(texts[0]!) as { isError: boolean; content: Array<{ text: string }> };
    expect(isError).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain('INVALID_ARGUMENT');
    expect(result.content[0]!.text).toContain('value');
    expect(calls.map((call) => call.tool)).toEqual(['exec']);
  });

  it('runs Promise.all over nested calls', async () => {
    const code = "const [a, b] = await Promise.all([tools.echo({value:'a'}), tools.echo({value:'b'})]); text(a.content[0].text + ' ' + b.content[0].text)";
    const { texts } = await run(client, code);
    expect(texts[0]).toBe('echo:a echo:b');
  });

  it('stops a runaway loop with the CPU limit', async () => {
    const { texts, isError } = await run(client, 'while (true) {}');
    expect(isError).toBe(true);
    expect(texts[0]).toMatch(/^CPU_LIMIT: /);
  }, 20_000);

  it('cuts text past the byte limit and stops the script', async () => {
    const { texts, isError } = await run(client, "text('a'.repeat(50000)); text('never')");
    expect(isError).toBe(true);
    expect(texts[0]).toMatch(/^OUTPUT_LIMIT: /);
    expect(texts.join('').length).toBeLessThan(50_000);
    expect(texts.join('')).not.toContain('never');
  });

  it('records each nested call as its own event with the parent caller', async () => {
    await run(client, "await tools.echo({value:'h'}); text('ok')");
    const nested = calls.find((call) => call.tool === 'echo' && (call.args as { value?: string }).value === 'h');
    expect(nested?.caller?.sessionId).toBe('s1');
    expect(nested?.requestId).toBe('wfr_abc');
    expect(calls.some((call) => call.tool === 'exec')).toBe(true);
  });

  it('returns TOOL_DISABLED inside the script when a tool was turned off mid-run', async () => {
    const { texts, isError } = await run(client, 'await tools["flaky-tool"]({}); const r = await tools["flaky-tool"]({}); text(r)');
    expect(isError).toBe(false);
    const parsed = JSON.parse(texts[0]!) as { isError: boolean; content: Array<{ text: string }> };
    expect(parsed.isError).toBe(true);
    expect(parsed.content[0]!.text).toMatch(/^TOOL_DISABLED: /);
  });

  it('refuses session_finish inside a script', async () => {
    const { texts } = await run(client, 'const r = await tools.session_finish({}); text(r)');
    expect(texts[0]).toContain('must be called directly');
  });

  it('yields a cell, returns only new output, and refuses another chat or a consumed cell', async () => {
    const result = await client.callTool({ name: 'exec', arguments: {
      code: "text('before'); yield_control(); await new Promise(resolve => setTimeout(resolve, 150)); text('after');"
    } });
    const blocks = result.content as Array<{ type: string; text: string }>;
    const cellId = /Script running with cell ID (\S+)/.exec(blocks[0]!.text)?.[1];
    expect(cellId).toBeDefined();
    expect(blocks.slice(1).map((block) => block.text)).toEqual(['before']);
    const other = await connect('wfr_other');
    try {
      expect((await other.callTool({ name: 'wait', arguments: { cell_id: cellId } })).isError).toBe(true);
    } finally { await other.close(); }
    const output: string[] = [];
    for (;;) {
      const next = await client.callTool({ name: 'wait', arguments: { cell_id: cellId, yield_time_ms: 1000 } });
      const parts = next.content as Array<{ text: string }>;
      expect(next.isError).toBe(false);
      output.push(...parts.slice(1).map((part) => part.text));
      if (parts[0]!.text.startsWith('Script completed')) break;
    }
    expect(output).toEqual(['after']);
    expect((await client.callTool({ name: 'wait', arguments: { cell_id: cellId } })).isError).toBe(true);
  });

  it('stores JSON values across fresh isolates in the same chat only and exits without dispatching later calls', async () => {
    const first = await run(client, "store('saved', {value: 42}); globalThis.temporary = 1; text('before'); try { exit(); } finally { await tools.echo({value:'never'}); }");
    expect(first).toEqual({ texts: ['before'], isError: false });
    expect(calls.some((call) => call.tool === 'echo')).toBe(false);
    expect((await run(client, "text([load('saved'), typeof temporary, typeof process, typeof fetch]);")).texts).toEqual(['[{"value":42},"undefined","undefined","undefined"]']);
    const other = await connect('wfr_other');
    try { expect((await run(other, "text(load('saved')); ")).texts).toEqual(['undefined']); }
    finally { await other.close(); }
  });

  it('terminates a yielded script before later tools run', async () => {
    const result = await client.callTool({ name: 'exec', arguments: {
      code: '// @exec: {"yield_time_ms": 0}\nawait new Promise(resolve => setTimeout(resolve, 1000)); await tools.echo({value:"never"});'
    } });
    const cellId = /Script running with cell ID (\S+)/.exec((result.content as Array<{ text: string }>)[0]!.text)![1];
    const stopped = await client.callTool({ name: 'wait', arguments: { cell_id: cellId, terminate: true } });
    expect((stopped.content as Array<{ text: string }>)[0]!.text).toContain('Script terminated');
    expect(calls.some((call) => call.tool === 'echo')).toBe(false);
  });

  it('waits on an earlier cell from a fresh exec through the same MCP dispatch', async () => {
    const result = await client.callTool({ name: 'exec', arguments: {
      code: 'yield_control(); await new Promise(resolve => setTimeout(resolve, 100)); text("later");'
    } });
    const cellId = /Script running with cell ID (\S+)/.exec((result.content as Array<{ text: string }>)[0]!.text)![1];
    const { texts, isError } = await run(client, `const r = await tools.wait({cell_id: ${JSON.stringify(cellId)}}); text(r);`);
    expect(isError).toBe(false);
    const waited = JSON.parse(texts[0]!) as { content: Array<{ text: string }>; isError: boolean };
    expect(waited.isError).toBe(false);
    expect(waited.content.map((block) => block.text).join('')).toContain('later');
    expect(calls.some((call) => call.tool === 'wait' && call.nested && call.caller?.sessionId === 's1')).toBe(true);
  });

  it.each(['// @exec: {}', '// @exec: {"bad":1}\ntext("never")', '// @exec: {"yield_time_ms":-1}\ntext("never")'])('refuses a malformed pragma before dispatch: %s', async (code) => {
    const result = await client.callTool({ name: 'exec', arguments: { code } });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: expect.stringContaining('INVALID_ARGUMENT') }]);
    expect(calls.map((call) => call.tool)).toEqual(['exec']);
  });
});
