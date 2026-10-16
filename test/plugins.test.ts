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
import { resourceTools } from '../src/main/mcp/tools/resources';
import { exposedNames } from '../src/main/plugins/exposure';

const SERVER_SCRIPT = `
import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { z } from 'zod';

const server = new McpServer({ name: process.argv[2], version: '1.0.0' });
server.registerResource('guide', 'guide://intro', { mimeType: 'text/plain' }, async (uri) => ({ contents: [{ uri: uri.href, text: 'Shared resource content' }] }));
server.registerTool('echo', { description: 'Echoes text.', inputSchema: z.object({ text: z.string() }), outputSchema: z.object({ text: z.string() }) }, async ({ text }) => ({
  content: [{ type: 'text', text: 'echo:' + text + ':' + (process.env.PLUGIN_TOKEN ?? 'missing') }],
  structuredContent: { text: 'echo:' + text + ':' + (process.env.PLUGIN_TOKEN ?? 'missing') }
}));
server.registerTool('crash', { description: 'Exits the process.' }, async () => {
  setTimeout(() => process.exit(1), 20);
  return { content: [{ type: 'text', text: 'crashing' }] };
});
await server.connect(new StdioServerTransport());
`;

const SECRET = 'secret-value';
const PAGINATED_SERVER_SCRIPT = `
import { Server } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
const server = new Server({ name: 'pages', version: '1.0.0' }, { capabilities: { tools: { listChanged: true } } });
let grown = false;
server.setRequestHandler('tools/list', async (request) => {
  const page = Number(request.params?.cursor ?? 0);
  return {
    tools: [{ name: 'page_' + page, inputSchema: { type: 'object' } }],
    ...(page < (grown ? 65 : 64) ? { nextCursor: String(page + 1) } : {})
  };
});
server.setRequestHandler('tools/call', async () => {
  grown = true;
  await server.sendToolListChanged();
  return { content: [{ type: 'text', text: 'Catalog changed' }] };
});
await server.connect(new StdioServerTransport());
`;
let dir = '';
let script = '';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'plugins-test-'));
  // A symlink lets the script resolve the project's SDK and zod with plain bare imports.
  symlinkSync(fileURLToPath(new URL('../node_modules', import.meta.url)), join(dir, 'node_modules'), 'dir');
  script = join(dir, 'echo-server.mjs');
  writeFileSync(script, SERVER_SCRIPT);
  writeFileSync(join(dir, 'pages.mjs'), PAGINATED_SERVER_SCRIPT);
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
  it('keeps exposed names unique and stable when readable server prefixes collide', () => {
    const sources = [
      { id: 'one', name: 'a b', toolNames: ['echo'] },
      { id: 'two', name: 'a_b', toolNames: ['echo'] },
      { id: 'three', name: 'raw', toolNames: ['a_b_echo'] }
    ];
    const names = exposedNames(sources);
    const all = [...names.values()].flatMap((server) => [...server.values()]);
    expect(new Set(all).size).toBe(3);
    expect(names.get('three')?.get('a_b_echo')).toBe('a_b_echo');
    expect(exposedNames(sources.reverse())).toEqual(names);
  });

  it('loads catalogs beyond the SDK default page limit', async () => {
    const { manager, state } = createManager([stdioServer('pages', { args: [join(dir, 'pages.mjs')] })]);
    manager.start();
    try {
      await waitFor(() => manager.status()[0]?.state === 'running', 'all catalog pages');
      const names = manager.tools().map((tool) => tool.name);
      expect(names).toHaveLength(65);
      expect(names.at(-1)).toBe('page_64');
      await manager.tools()[0]!.run({}, toolContext(state.config));
      await waitFor(() => manager.tools().length === 66, 'the changed catalog');
      expect(manager.tools().at(-1)?.name).toBe('page_65');
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
      tools: () => [...manager.tools(), ...resourceTools(manager)],
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
      expect(listed?.outputSchema).toMatchObject({ properties: { text: { type: 'string' } }, required: ['text'] });
      const result = await client.callTool({ name: 'echo', arguments: { text: 'hi' } });
      expect(result.isError).toBeFalsy();
      expect(result.content).toEqual([{ type: 'text', text: `echo:hi:${SECRET}` }]);
      expect(result.structuredContent).toEqual({ text: `echo:hi:${SECRET}` });
      const core = new Client({ name: 'resources-test', version: '1.0.0' });
      try {
        await core.connect(new StreamableHTTPClientTransport(new URL(http.localUrl('core')!)));
        const resources = await core.callTool({ name: 'list_mcp_resources', arguments: {} });
        expect(resources.structuredContent).toMatchObject({ resources: [{ server: 'alpha', uri: 'guide://intro' }], errors: [] });
        const content = await core.callTool({ name: 'read_mcp_resource', arguments: { server: 'alpha', uri: 'guide://intro' } });
        expect(content.structuredContent).toMatchObject({ contents: [{ uri: 'guide://intro', text: 'Shared resource content' }] });
      } finally { await core.close(); }
    } finally {
      await client.close();
      await http.stop();
      await manager.stop();
    }
  });
});
