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
  name: 'flaky',
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
  resolveCaller: async (requestId) => (requestId === 'wfr_abc' ? caller : null),
  steering: () => [],
  hooks: { onCallEnd: (call) => calls.push(call) }
});

async function connect(): Promise<Client> {
  const transport = new StreamableHTTPClientTransport(new URL(server.localUrl('core')!), {
    requestInit: { headers: { 'x-request-id': 'wfr_abc/t' } }
  });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

/** Runs one exec call and returns its text blocks and error flag. */
async function run(client: Client, code: string): Promise<{ texts: string[]; isError: boolean }> {
  const result = await client.callTool({ name: 'exec', arguments: { code } });
  const texts = (result.content as Array<{ type: string; text: string }>).map((block) => block.text);
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
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toContain('exec');
    const { texts, isError } = await run(client, 'text(ALL_TOOLS)');
    expect(isError).toBe(false);
    const listed = (JSON.parse(texts[0]!) as Array<{ name: string }>).map((tool) => tool.name);
    expect(listed).toEqual(expect.arrayContaining(['echo', 'flaky', 'session_finish']));
    expect(listed).not.toContain('exec');
  });

  it('returns the nested result of a tool call', async () => {
    const { texts, isError } = await run(client, "const r = await tools.echo({value:'x'}); text(r)");
    expect(isError).toBe(false);
    expect((JSON.parse(texts[0]!) as { content: Array<{ text: string }> }).content[0]!.text).toBe('echo:x');
  });

  it('runs Promise.all over nested calls', async () => {
    const code = "const [a, b] = await Promise.all([tools.echo({value:'a'}), tools.echo({value:'b'})]); text(a.content[0].text + ' ' + b.content[0].text)";
    const { texts } = await run(client, code);
    expect(texts[0]).toBe('echo:a echo:b');
  });

  it('notes a tool the surface does not offer', async () => {
    const { texts, isError } = await run(client, "if (false) await tools.nope({}); text('ok')");
    expect(isError).toBe(false);
    expect(texts).toEqual(['ok', expect.stringContaining('UNKNOWN_TOOL_NAMES: this script used tools.nope')]);
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
    const { texts, isError } = await run(client, 'await tools.flaky({}); const r = await tools.flaky({}); text(r)');
    expect(isError).toBe(false);
    const parsed = JSON.parse(texts[0]!) as { isError: boolean; content: Array<{ text: string }> };
    expect(parsed.isError).toBe(true);
    expect(parsed.content[0]!.text).toMatch(/^TOOL_DISABLED: /);
  });

  it('refuses session_finish inside a script', async () => {
    const { texts } = await run(client, 'const r = await tools.session_finish({}); text(r)');
    expect(texts[0]).toContain('must be called directly');
  });
});
