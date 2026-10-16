import { z } from 'zod';
import { effectiveCapabilities } from '@shared/config';
import type { Config } from '@shared/config';
import type { PluginManager } from '../../plugins/manager';
import { defineTool, textResult, type ToolSpec } from '../tool';

/** Codex resource tools read the same external servers managed by the GUI and CLI. */
export function resourceTools(plugins: PluginManager): ToolSpec[] {
  const exposed = (config: Config) => effectiveCapabilities(config).read && config.plugins.some((server) => server.enabled);
  const listing = (kind: 'resources' | 'templates') => defineTool({
    name: kind === 'resources' ? 'list_mcp_resources' : 'list_mcp_resource_templates',
    surface: 'core',
    title: kind === 'resources' ? 'List MCP resources' : 'List MCP resource templates',
    description: kind === 'resources'
      ? 'Lists resources shared by configured MCP servers. Optionally filter by server name or ID. Read a listed URI with read_mcp_resource.'
      : 'Lists parameterized resource URI templates from configured MCP servers. Optionally filter by server name or ID.',
    input: { server: z.string().optional().describe('Optional MCP server name or ID.') },
    annotations: { readOnlyHint: true, openWorldHint: true },
    exposed,
    run: async ({ server }, ctx) => {
      const servers = await plugins.resources(kind, server, ctx.signal);
      const output = kind === 'resources'
        ? { resources: servers.flatMap((entry) => (entry.resources ?? []).map((resource) => ({ server: entry.server, ...resource }))), errors: servers.filter((entry) => entry.error) }
        : { resourceTemplates: servers.flatMap((entry) => (entry.resourceTemplates ?? []).map((resource) => ({ server: entry.server, ...resource }))), errors: servers.filter((entry) => entry.error) };
      return textResult(JSON.stringify(output), { structuredContent: output });
    }
  });
  return [listing('resources'), listing('templates'), defineTool({
    name: 'read_mcp_resource', surface: 'core', title: 'Read MCP resource',
    description: 'Reads a resource URI from an MCP server, using a URI returned by list_mcp_resources or a resource template.',
    input: { server: z.string().describe('MCP server name or ID.'), uri: z.string().describe('Resource URI to read.') },
    annotations: { readOnlyHint: true, openWorldHint: true },
    exposed,
    run: async ({ server, uri }, ctx) => {
      const output = await plugins.readResource(server, uri, ctx.signal);
      return textResult(JSON.stringify(output), { structuredContent: output });
    }
  })];
}
