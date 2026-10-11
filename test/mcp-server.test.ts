import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { z } from 'zod';
import { defaultConfig, type Config } from '@shared/config';
import type { SurfaceId } from '@shared/types';
import { McpHttpServer, generateToken, type CallRecord } from '../src/main/mcp/server';
import { defineTool, textResult, ToolError, type Caller, type ToolServices, type ToolSpec } from '../src/main/mcp/tool';

const tokens: Record<SurfaceId, string> = { core: generateToken(), desktop: generateToken(), plugins: generateToken() };
const seenRequestIds: Array<string | null> = [];
const steeringQueue: string[] = ['stop after the next step'];

const echo = defineTool({
  name: 'echo',
  surface: 'core',
  title: 'Echo',
  description: 'Echoes text.',
  input: { text: z.string() },
  exposed: () => true,
  run: async (args, ctx) => textResult(`echo:${args.text}:${ctx.caller?.sessionId ?? 'none'}`)
});

const fail = defineTool({
  name: 'fail',
  surface: 'core',
  title: 'Fail',
  description: 'Always refuses.',
  input: {},
  exposed: () => true,
  run: async () => {
    throw new ToolError('PATH_NOT_ALLOWED', 'nope');
  }
});

const plan = defineTool({
  name: 'plan',
  surface: 'core',
  title: 'Plan',
  description: 'Needs a chat.',
  input: {},
  requiresCaller: true,
  exposed: () => true,
  run: async (_args, ctx) => textResult(`plan for ${ctx.caller?.sessionId}`)
});

const hidden = defineTool({
  name: 'hidden',
  surface: 'core',
  title: 'Hidden',
  description: 'Not exposed.',
  input: {},
  exposed: () => false,
  run: async () => textResult('should not run')
});

const browse = defineTool({
  name: 'browse',
  surface: 'desktop',
  title: 'Browse',
  description: 'Desktop only.',
  input: {},
  exposed: () => true,
  run: async () => textResult('browsing')
});

const tools: ToolSpec[] = [echo as ToolSpec, fail as ToolSpec, plan as ToolSpec, hidden as ToolSpec, browse as ToolSpec];
const caller: Caller = { sessionId: 's1', conversationId: 'c1', cwd: null, kind: 'chat' };
const calls: CallRecord[] = [];

const server = new McpHttpServer({
  getConfig: (): Config => defaultConfig(),
  tools,
  services: {} as ToolServices,
  tokens,
  resolveCaller: async (requestId) => {
    seenRequestIds.push(requestId);
    return requestId === 'wfr_abc' ? caller : null;
  },
  steering: (who) => (who.sessionId === 's1' ? steeringQueue.splice(0) : []),
  hooks: { onCallEnd: (call) => calls.push(call) }
});

async function connect(surface: SurfaceId, requestId?: string): Promise<Client> {
  const url = new URL(server.localUrl(surface)!);
  const transport = new StreamableHTTPClientTransport(url, {
    requestInit: requestId ? { headers: { 'x-request-id': requestId } } : undefined
  });
  const client = new Client({ name: 'test', version: '1.0.0' });
  await client.connect(transport);
  return client;
}

describe('McpHttpServer', () => {
  beforeAll(async () => {
    await server.start(0);
  });
  afterAll(async () => {
    await server.stop();
  });

  it('lists only the exposed tools of the surface whose token is used', async () => {
    const core = await connect('core');
    const names = (await core.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual(['echo', 'fail', 'plan']);
    const desktop = await connect('desktop');
    expect((await desktop.listTools()).tools.map((tool) => tool.name)).toEqual(['browse']);
    await core.close();
    await desktop.close();
  });

  it('attributes calls by the x-request-id join key and appends steering', async () => {
    const client = await connect('core', 'wfr_abc/def');
    const result = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
    expect(seenRequestIds).toContain('wfr_abc');
    const texts = (result.content as Array<{ type: string; text: string }>).map((block) => block.text);
    expect(texts[0]).toBe('echo:hi:s1');
    expect(texts[1]).toContain('read it and adjust: stop after the next step');
    expect(result.isError).toBeFalsy();
    expect(calls.at(-1)?.caller?.sessionId).toBe('s1');
    await client.close();
  });

  it('maps a ToolError to an isError result carrying its code', async () => {
    const client = await connect('core', 'wfr_abc/def');
    const result = await client.callTool({ name: 'fail', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'PATH_NOT_ALLOWED: nope' }]);
    await client.close();
  });

  it('refuses a tool that needs a caller when the request is unattributed', async () => {
    const client = await connect('core');
    const result = await client.callTool({ name: 'plan', arguments: {} });
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([
      { type: 'text', text: expect.stringMatching(/^CALLER_IDENTITY_REQUIRED: /) }
    ]);
    await client.close();
  });

  it('answers 404 for a wrong or foreign token and 200 for healthz', async () => {
    const port = new URL(server.localUrl('core')!).port;
    const wrong = await fetch(`http://127.0.0.1:${port}/mcp/not-the-token`, { method: 'POST', body: '{}' });
    expect(wrong.status).toBe(404);
    const health = await fetch(`http://127.0.0.1:${port}/healthz`);
    expect(health.status).toBe(200);
  });
});
