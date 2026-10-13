import { expect, it, vi } from 'vitest';
import { mcpCommand } from '../src/cli/mcp';
import type { BackendClient } from '../src/cli/connection';
import { defaultConfig, type PluginServerConfig } from '../src/shared/config';
import type { AppState } from '../src/shared/types';

function setup() {
  const state = { config: defaultConfig(), plugins: [] } as unknown as AppState;
  const invoke = vi.fn(async (channel: string, patch: { plugins?: PluginServerConfig[] } | string) => {
    if (channel === 'config:update' && typeof patch !== 'string' && patch.plugins) state.config.plugins = patch.plugins;
  });
  const client = { state, refresh: async () => state, invoke } as unknown as BackendClient;
  return { client, state, invoke };
}

it('manages shared stdio and HTTP servers while preserving command arguments and per-tool settings', async () => {
  const { client, state, invoke } = setup();
  await mcpCommand(client, ['add', 'local', '--', 'node', 'server.js', '--flag', 'two words']);
  await mcpCommand(client, ['add', 'remote', '--url', 'https://example.com/mcp']);
  const local = state.config.plugins[0]!;
  expect(local).toMatchObject({ name: 'local', transport: 'stdio', command: 'node', args: ['server.js', '--flag', 'two words'], enabled: true });
  expect(state.config.plugins[1]).toMatchObject({ transport: 'http', url: 'https://example.com/mcp' });
  local.disabledTools = ['blocked'];
  state.plugins = [{ id: local.id, name: local.name, state: 'running', detail: '', tools: [{ name: 'read', enabled: true, description: 'Read files' }] }];
  expect(await mcpCommand(client, [])).toContain('✓ read');
  await mcpCommand(client, ['disable', 'local']);
  expect(state.config.plugins[0]).toMatchObject({ enabled: false, disabledTools: ['blocked'] });
  await expect(mcpCommand(client, ['restart', 'local'])).rejects.toThrow('Enable');
  await mcpCommand(client, ['enable', local.id]);
  await mcpCommand(client, ['restart', 'local']);
  expect(invoke).toHaveBeenCalledWith('plugins:restart', local.id);
  await mcpCommand(client, ['remove', 'local']);
  expect(state.config.plugins.map((server) => server.name)).toEqual(['remote']);
});

it('lists server details and tools as JSON without exposing environment values', async () => {
  const { client, state } = setup();
  await mcpCommand(client, ['add', 'tools', '--', 'node', 'server.js']);
  state.config.plugins[0]!.env = { PRIVATE_VALUE: 'do-not-print-this', SECRET_FROM_STORE: '' };
  state.config.readOnly = true;
  const result = await mcpCommand(client, ['get', 'tools', '--json']);
  expect(JSON.parse(result)).toMatchObject({ name: 'tools', env: ['PRIVATE_VALUE', 'SECRET_FROM_STORE'], tools: [] });
  expect(result).not.toContain('do-not-print-this');
  expect(JSON.parse(await mcpCommand(client, ['list', '--json']))).toHaveLength(1);
});

it('rejects duplicate servers and malformed operations without changing configuration', async () => {
  const { client, state, invoke } = setup();
  await mcpCommand(client, ['add', 'tools', '--', 'node', 'server.js']);
  invoke.mockClear();
  for (const args of [
    ['add', 'tools', '--', 'node'], ['add', 'bad', '--url', 'file:///tmp/server'],
    ['add', 'bad', '--url', 'invalid'], ['add', 'bad', '--'], ['remove', 'missing'],
    ['get', 'tools', '--flag'], ['list', 'unexpected'], ['disable', 'tools', 'extra']
  ]) await expect(mcpCommand(client, args)).rejects.toThrow();
  expect(state.config.plugins).toHaveLength(1);
  expect(invoke).not.toHaveBeenCalled();
});
