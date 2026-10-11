import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defaultConfig, type Config, type PluginServerConfig, type SecretKey } from '@shared/config';
import type { SurfaceId } from '@shared/types';
import { PluginManager } from '../src/main/plugins/manager';
import { McpHttpServer, generateToken } from '../src/main/mcp/server';
import type { ToolContext, ToolServices, ToolSpec } from '../src/main/mcp/tool';

const SERVER_SCRIPT = `
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const server = new McpServer({ name: process.argv[2], version: '1.0.0' });
server.registerTool('echo', { description: 'Echoes text.', inputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({
  content: [{ type: 'text', text: 'echo:' + text + ':' + (process.env.PLUGIN_TOKEN ?? 'missing') }]
}));
server.registerTool('crash', { description: 'Exits the process.' }, async () => {
  setTimeout(() => process.exit(1), 20);
  return { content: [{ type: 'text', text: 'crashing' }] };
});
await server.connect(new StdioServerTransport());
`;

const SECRET = 'secret-value';
let dir = '';
let script = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plugins-test-'));
  // A symlink lets the script resolve the project's SDK and zod with plain bare imports.
  symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(dir, 'node_modules'), 'dir');
  script = join(dir, 'echo-server.mjs');
  writeFileSync(script, SERVER_SCRIPT);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function stdioServer(id: string, overrides: Partial<PluginServerConfig> = {}): PluginServerConfig {
  return {
    id,
    name: id,
    enabled: true,
    transport: 'stdio',
    command: process.execPath,
    args: [script, id],
    env: { PLUGIN_TOKEN: '' },
    url: '',
    disabledTools: [],
    ...overrides
  };
}

function makeConfig(plugins: PluginServerConfig[]): Config {
  return { ...defaultConfig(), plugins };
}

function createManager(initial: PluginServerConfig[]) {
  const state = { config: makeConfig(initial) };
  const manager = new PluginManager({
    getConfig: () => state.config,
    getSecret: (key: SecretKey) => (key === 'plugin:alpha:env:PLUGIN_TOKEN' ? SECRET : null),
    onChange: () => undefined
  });
  const setPlugins = (plugins: PluginServerConfig[]) => {
    state.config = makeConfig(plugins);
    manager.reconcile();
  };
  return { manager, setPlugins, state };
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function toolContext(config: Config): ToolContext {
  return {
    surface: 'plugins' as SurfaceId,
    requestId: null,
    caller: null,
    config,
    services: {} as ToolServices,
    signal: new AbortController().signal
  };
}

describe('PluginManager', () => {
  it('connects a stdio server, exposes its tools and calls them with the secret env', async () => {
    const { manager, state } = createManager([stdioServer('alpha')]);
    manager.start();
    try {
      await waitFor(() => manager.status()[0]?.state === 'running', 'alpha to run');
      const status = manager.status()[0]!;
      expect(status.tools.map((tool) => tool.name).sort()).toEqual(['crash', 'echo']);

      const tools = manager.tools();
      const echo = tools.find((tool) => tool.name === 'echo') as ToolSpec;
      expect(echo.jsonSchema).toMatchObject({ properties: { text: { type: 'string' } } });

      const result = await echo.run({ text: 'hi' }, toolContext(state.config));
      expect(result.isError).toBeFalsy();
      expect(result.content).toEqual([{ type: 'text', text: `echo:hi:${SECRET}` }]);
    } finally {
      await manager.stop();
    }
  });

  it('hides disabled tools from the surface and status', async () => {
    const { manager, setPlugins, state } = createManager([stdioServer('alpha')]);
    manager.start();
    try {
      await waitFor(() => manager.status()[0]?.state === 'running', 'alpha to run');
      const echo = manager.tools().find((tool) => tool.name === 'echo') as ToolSpec;
      setPlugins([stdioServer('alpha', { disabledTools: ['echo'] })]);

      expect(manager.tools().map((tool) => tool.name)).toEqual(['crash']);
      expect(manager.status()[0]!.state).toBe('running');
      expect(manager.status()[0]!.tools.find((tool) => tool.name === 'echo')?.enabled).toBe(false);
      expect(echo.exposed(state.config)).toBe(false);
    } finally {
      await manager.stop();
    }
  });

  it('prefixes a tool name that two servers both declare', async () => {
    const { manager } = createManager([stdioServer('alpha', { disabledTools: ['crash'] }), stdioServer('beta', { disabledTools: ['crash'] })]);
    manager.start();
    try {
      await waitFor(() => manager.status().every((item) => item.state === 'running'), 'both servers to run');
      expect(manager.tools().map((tool) => tool.name).sort()).toEqual(['alpha_echo', 'beta_echo']);
    } finally {
      await manager.stop();
    }
  });

  it('reconnects a server that crashed', async () => {
    const { manager, state } = createManager([stdioServer('alpha')]);
    manager.start();
    try {
      await waitFor(() => manager.status()[0]?.state === 'running', 'alpha to run');
      const crash = manager.tools().find((tool) => tool.name === 'crash') as ToolSpec;
      await crash.run({}, toolContext(state.config));
      await waitFor(() => manager.status()[0]?.state === 'error', 'alpha to drop');
      await waitFor(() => manager.status()[0]?.state === 'running', 'alpha to reconnect');
      expect(manager.tools().map((tool) => tool.name).sort()).toEqual(['crash', 'echo']);
    } finally {
      await manager.stop();
    }
  });

  it('serves the plugin tools verbatim through the plugins endpoint', async () => {
    const { manager, state } = createManager([stdioServer('alpha')]);
    manager.start();
    const tokens = { core: generateToken(), desktop: generateToken(), plugins: generateToken() };
    const http = new McpHttpServer({
      getConfig: () => state.config,
      tools: () => manager.tools(),
      services: {} as ToolServices,
      tokens,
      resolveCaller: async () => null,
      steering: () => []
    });
    const client = new Client({ name: 'test', version: '1.0.0' });
    try {
      await waitFor(() => manager.status()[0]?.state === 'running', 'alpha to run');
      await http.start(0);
      await client.connect(new StreamableHTTPClientTransport(new URL(http.localUrl('plugins')!)));
      const listed = (await client.listTools()).tools.find((tool) => tool.name === 'echo');
      expect(listed?.inputSchema).toMatchObject({ properties: { text: { type: 'string' } }, required: ['text'] });
      const result = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
      expect(result.content).toEqual([{ type: 'text', text: `echo:hi:${SECRET}` }]);
    } finally {
      await client.close();
      await http.stop();
      await manager.stop();
    }
  });
});
