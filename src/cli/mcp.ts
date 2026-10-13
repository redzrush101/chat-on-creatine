import { randomUUID } from 'node:crypto';
import type { PluginServerConfig } from '@shared/config';
import type { BackendClient } from './connection';

const USAGE = 'Usage: mcp list [--json], get <name> [--json], add <name> -- <command> [args], add <name> --url <URL>, remove|enable|disable|restart <name>.';

/** Both CLI entry points manage the same servers as desktop Settings → Plugins. */
export async function mcpCommand(client: BackendClient, args: string[]): Promise<string> {
  await client.refresh();
  const state = client.state;
  if (!state) throw new Error('The backend is still starting.');
  const [action = 'list', name, ...rest] = args;
  const servers = state.config.plugins;
  const summary = (server: PluginServerConfig) => {
    const status = state.plugins.find((plugin) => plugin.id === server.id);
    return {
      id: server.id, name: server.name, enabled: server.enabled, transport: server.transport,
      command: server.command, args: server.args, url: server.url,
      env: Object.keys(server.env), state: status?.state ?? 'stopped', detail: status?.detail ?? '', tools: status?.tools ?? []
    };
  };
  const describe = (server: PluginServerConfig) => {
    const item = summary(server);
    return `${item.name} · ${item.id} · ${item.enabled ? item.state : 'disabled'}\n` +
      `  ${item.transport === 'http' ? item.url : [item.command, ...item.args].map((arg) => JSON.stringify(arg)).join(' ')}\n` +
      (item.detail ? `  ${item.detail}\n` : '') +
      item.tools.map((tool) => `  ${tool.enabled && item.enabled && !state.config.readOnly ? '✓' : '○'} ${tool.name} · ${tool.description}`).join('\n');
  };
  if (action === 'list') {
    if (args.length > 2 || name && name !== '--json') throw new Error(USAGE);
    return name === '--json' ? JSON.stringify(servers.map(summary)) : servers.map(describe).join('\n') || 'No MCP servers configured. Use mcp add <name> -- <command> [args].';
  }
  if (!name || name.startsWith('-')) throw new Error(USAGE);
  if (action === 'add') {
    if (servers.some((server) => server.name === name || server.id === name)) throw new Error('That MCP server name already exists. Choose another name or remove the existing server.');
    const server: PluginServerConfig = { id: randomUUID(), name, enabled: true, transport: 'stdio', command: '', args: [], env: {}, url: '', disabledTools: [] };
    if (rest[0] === '--url' && rest.length === 2) {
      let url: URL;
      try { url = new URL(rest[1]!); } catch { throw new Error('MCP server URLs must be absolute HTTP or HTTPS URLs.'); }
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('MCP server URLs must use HTTP or HTTPS.');
      server.transport = 'http'; server.url = url.href;
    } else if (rest[0] === '--' && rest[1]) {
      server.command = rest[1]; server.args = rest.slice(2);
    } else throw new Error(USAGE);
    await client.invoke('config:update', { plugins: [...servers, server] });
    return `Added MCP server ${name}.`;
  }
  const exact = servers.find((server) => server.id === name);
  const matches = exact ? [exact] : servers.filter((server) => server.name === name);
  if (matches.length !== 1) throw new Error(matches.length ? 'That MCP server name is ambiguous. Use its ID from mcp list.' : 'No matching MCP server. Use mcp list to see configured servers.');
  const server = matches[0]!;
  if (action === 'get') {
    if (rest.length > 1 || rest[0] && rest[0] !== '--json') throw new Error(USAGE);
    return rest[0] === '--json' ? JSON.stringify(summary(server)) : describe(server);
  }
  if (rest.length) throw new Error(USAGE);
  if (action === 'restart') {
    if (!server.enabled) throw new Error('Enable this MCP server before restarting it.');
    await client.invoke('plugins:restart', server.id);
  } else if (action === 'remove') {
    await client.invoke('config:update', { plugins: servers.filter((item) => item.id !== server.id) });
  } else if (action === 'enable' || action === 'disable') {
    await client.invoke('config:update', { plugins: servers.map((item) => item.id === server.id ? { ...item, enabled: action === 'enable' } : item) });
  } else throw new Error(USAGE);
  return `${action === 'restart' ? 'Restarting' : action === 'remove' ? 'Removed' : action === 'enable' ? 'Enabled' : 'Disabled'} MCP server ${server.name}.`;
}
