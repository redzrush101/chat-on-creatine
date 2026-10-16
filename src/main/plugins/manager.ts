import { errorMessage } from '@shared/errors';
import { createHash } from 'node:crypto';
import { Client, StreamableHTTPClientTransport, type Transport, type CallToolResult, type Resource, type ResourceTemplateType, type Tool } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { Config, PluginServerConfig, SecretKey } from '@shared/config';
import type { PluginStatus } from '@shared/types';
import { createLogger } from '../core/log';
import { childEnv } from '../exec/env';
import { ToolError, type ToolContent, type ToolContext, type ToolResult, type ToolSpec } from '../mcp/tool';
import { exposedNames } from './exposure';
import { fromJsonSchema, type JsonSchemaType } from '@modelcontextprotocol/server';
import { version } from '../../../package.json';

const log = createLogger('plugins');

const MAX_RECONNECTS = 5;
const RECONNECT_BASE_MS = 1_000;
/** A connection that stays up this long resets the reconnect budget. */
const STABLE_MS = 30_000;
const START_TIMEOUT_MS = 60_000;
const TOOL_TIMEOUT_MS = 120_000;

interface PluginManagerDeps {
  getConfig(): Config;
  getSecret(key: SecretKey): string | null;
  /** Called whenever a server's status or tool list changes. */
  onChange(): void;
}

/** One live (or retrying) connection to a configured plugin server. */
interface Entry {
  id: string;
  /** Config the connection was made from; a change in the fingerprint replaces the entry. */
  config: PluginServerConfig;
  fingerprint: string;
  state: 'starting' | 'running' | 'error';
  detail: string;
  client: Client | null;
  tools: Tool[];
  failures: number;
  timer: ReturnType<typeof setTimeout> | null;
}

/**
 * Connects to the user's external MCP servers as a client and re-exposes their tools on the
 * Plugins surface. A server stays connected until it is disabled, removed or changed; a dropped
 * connection is retried with exponential backoff.
 *
 * Secret env values live in the secret store under `plugin:<id>:env:<NAME>`. A name in
 * `config.env` with an empty value marks that variable as secret.
 */
export class PluginManager {
  private readonly entries = new Map<string, Entry>();
  private cachedTools: { config: Config; specs: ToolSpec[] } | null = null;

  constructor(private readonly deps: PluginManagerDeps) {}

  start(): void {
    this.reconcile();
  }

  async stop(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.close(id)));
    this.changed();
  }

  /** Brings connections in line with the current config. Call after every config change. */
  reconcile(): void {
    const wanted = this.deps.getConfig().plugins.filter((server) => server.enabled);
    const wantedIds = new Set(wanted.map((server) => server.id));
    let changed = false;
    for (const id of [...this.entries.keys()]) {
      if (!wantedIds.has(id)) { void this.close(id); changed = true; }
    }
    for (const server of wanted) {
      const fingerprint = this.fingerprint(server);
      if (this.entries.get(server.id)?.fingerprint === fingerprint) continue;
      void this.close(server.id);
      this.launch(server, fingerprint);
      changed = true;
    }
    if (changed) this.changed();
  }

  restart(id: string): void {
    const server = this.deps.getConfig().plugins.find((item) => item.id === id);
    if (!server?.enabled) return;
    void this.close(id);
    this.launch(server, this.fingerprint(server));
    this.changed();
  }

  status(): PluginStatus[] {
    return this.deps.getConfig().plugins.map((server) => {
      const entry = this.entries.get(server.id);
      return {
        id: server.id,
        name: server.name,
        state: entry?.state ?? 'stopped',
        detail: entry?.detail ?? (server.enabled ? '' : 'Disabled'),
        tools: (entry?.tools ?? []).map((tool) => ({
          name: tool.name,
          description: tool.description ?? '',
          enabled: !server.disabledTools.includes(tool.name)
        }))
      };
    });
  }

  /** Live ToolSpecs for the Plugins surface: running servers, enabled tools, collision-free names. */
  tools(): ToolSpec[] {
    const config = this.deps.getConfig();
    if (this.cachedTools?.config === config) return this.cachedTools.specs;
    const live = [...this.entries.values()].filter((entry) => entry.state === 'running');
    const exposed = (entry: Entry) => entry.tools.filter((tool) => this.isExposed(entry.id, tool.name, config));
    const names = exposedNames(
      live.map((entry) => ({ id: entry.id, name: entry.config.name, toolNames: exposed(entry).map((tool) => tool.name) }))
    );
    const specs = live.flatMap((entry) =>
      exposed(entry).map((tool) => this.spec(entry.id, tool, names.get(entry.id)!.get(tool.name)!))
    );
    this.cachedTools = { config, specs };
    return specs;
  }

  async resources(kind: 'resources' | 'templates', server: string | undefined, signal: AbortSignal): Promise<Array<{ server: string; resources?: Resource[]; resourceTemplates?: ResourceTemplateType[]; error?: string }>> {
    const configured = this.deps.getConfig().plugins.filter((entry) => entry.enabled && (!server || entry.id === server || entry.name === server));
    if (server && configured.length !== 1) throw new ToolError('NOT_FOUND', 'Choose one enabled MCP server by its name or ID.');
    return Promise.all(configured.map(async (config) => {
      try {
        signal.throwIfAborted();
        const client = this.resourceClient(config.id);
        if (!client.getServerCapabilities()?.resources) return { server: config.name };
        const options = { signal, timeout: TOOL_TIMEOUT_MS };
        const result = kind === 'resources' ? await client.listResources(undefined, options) : await client.listResourceTemplates(undefined, options);
        return { server: config.name, ...result };
      } catch (error) {
        if (signal.aborted) throw error;
        return { server: config.name, error: errorMessage(error) };
      }
    }));
  }

  async readResource(server: string, uri: string, signal: AbortSignal) {
    const matches = this.deps.getConfig().plugins.filter((entry) => entry.enabled && (entry.id === server || entry.name === server));
    if (matches.length !== 1) throw new ToolError('NOT_FOUND', 'Choose one enabled MCP server by its name or ID.');
    return this.resourceClient(matches[0]!.id).readResource({ uri }, { signal, timeout: TOOL_TIMEOUT_MS });
  }

  private resourceClient(id: string): Client {
    const entry = this.entries.get(id);
    if (!entry?.client || entry.state !== 'running') throw new ToolError('FAILED', 'This MCP server is offline. Reconnect it in Settings → Plugins or /mcp restart.');
    return entry.client;
  }

  private changed(): void {
    this.cachedTools = null;
    this.deps.onChange();
  }

  private launch(server: PluginServerConfig, fingerprint: string): void {
    const entry: Entry = {
      id: server.id,
      config: server,
      fingerprint,
      state: 'starting',
      detail: '',
      client: null,
      tools: [],
      failures: 0,
      timer: null
    };
    this.entries.set(server.id, entry);
    void this.open(entry);
  }

  private async open(entry: Entry): Promise<void> {
    // Plugin catalogs can paginate beyond the client's default 64-page limit.
    const client = new Client({ name: 'chat-on-creatine', version }, {
      listMaxPages: 0,
      versionNegotiation: entry.config.transport === 'http' ? { mode: 'auto' } : undefined,
      listChanged: { tools: { debounceMs: 50, onChanged: (error, tools) => {
        if (entry.client !== client) return;
        if (error) {
          entry.detail = `Could not refresh tools: ${errorMessage(error)}`;
          log.warn(`${entry.config.name}: ${entry.detail}`);
        } else if (tools) {
          entry.tools = tools;
          entry.detail = '';
        }
        this.changed();
      } } }
    });
    entry.state = 'starting';
    entry.client = client;
    client.onclose = () => this.lost(entry, client);
    try {
      await client.connect(this.createTransport(entry.config), { timeout: START_TIMEOUT_MS });
      const { tools } = await client.listTools(undefined, { timeout: START_TIMEOUT_MS });
      if (entry.client !== client) return;
      entry.state = 'running';
      entry.detail = '';
      entry.tools = tools;
      entry.timer = setTimeout(() => {
        entry.timer = null;
        entry.failures = 0;
      }, STABLE_MS);
      log.info(`${entry.config.name} connected with ${tools.length} tools`);
    } catch (error) {
      if (entry.client !== client) return;
      entry.client = null;
      await client.close().catch(() => undefined);
      this.failed(entry, errorMessage(error));
      return;
    }
    this.changed();
  }

  /** The connection dropped on its own (crash, closed stream). */
  private lost(entry: Entry, client: Client): void {
    if (entry.client !== client) return;
    entry.client = null;
    entry.tools = [];
    this.failed(entry, 'Connection lost');
  }

  private failed(entry: Entry, reason: string): void {
    this.clearTimer(entry);
    entry.state = 'error';
    entry.tools = [];
    entry.failures += 1;
    if (entry.failures > MAX_RECONNECTS) {
      entry.detail = `${reason}; gave up after ${MAX_RECONNECTS} reconnect attempts`;
      log.warn(`${entry.config.name}: ${entry.detail}`);
    } else {
      const delay = RECONNECT_BASE_MS * 2 ** (entry.failures - 1);
      entry.detail = `${reason}; reconnecting (${entry.failures}/${MAX_RECONNECTS})`;
      log.warn(`${entry.config.name}: ${entry.detail}`);
      entry.timer = setTimeout(() => {
        entry.timer = null;
        void this.open(entry);
      }, delay);
    }
    this.changed();
  }

  /** Removes the entry first, so a late close event cannot schedule a reconnect. */
  private async close(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    this.clearTimer(entry);
    const client = entry.client;
    entry.client = null;
    await client?.close().catch(() => undefined);
  }

  private clearTimer(entry: Entry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
  }

  private isExposed(id: string, toolName: string, config: Config): boolean {
    if (config.readOnly) return false;
    const server = config.plugins.find((item) => item.id === id);
    return (
      server?.enabled === true &&
      !server.disabledTools.includes(toolName) &&
      this.entries.get(id)?.state === 'running'
    );
  }

  private spec(serverId: string, tool: Tool, exposedName: string): ToolSpec {
    return {
      name: exposedName,
      surface: 'plugins',
      title: tool.title ?? tool.annotations?.title ?? tool.name,
      description: tool.description ?? '',
      input: {},
      jsonSchema: tool.inputSchema as Record<string, unknown>,
      outputSchema: tool.outputSchema ? fromJsonSchema(tool.outputSchema as JsonSchemaType) : undefined,
      annotations: {
        readOnlyHint: tool.annotations?.readOnlyHint,
        destructiveHint: tool.annotations?.destructiveHint,
        idempotentHint: tool.annotations?.idempotentHint,
        openWorldHint: tool.annotations?.openWorldHint
      },
      exposed: (config) => this.isExposed(serverId, tool.name, config),
      run: (args, ctx) => this.call(serverId, tool.name, args, ctx)
    };
  }

  private async call(serverId: string, toolName: string, args: unknown, ctx: ToolContext): Promise<ToolResult> {
    const entry = this.entries.get(serverId);
    const client = entry?.client;
    if (!entry || !client || entry.state !== 'running') {
      throw new ToolError('FAILED', `${toolName} is unavailable: its plugin server is not connected.`);
    }
    let result: CallToolResult;
    try {
      result = await client.callTool(
        { name: toolName, arguments: args as Record<string, unknown> },
        { timeout: TOOL_TIMEOUT_MS, signal: ctx.signal }
      );
    } catch (error) {
      throw new ToolError('FAILED', `${entry.config.name} did not complete ${toolName}: ${errorMessage(error)}`);
    }
    return toToolResult(result);
  }

  private createTransport(server: PluginServerConfig): Transport {
    if (server.transport === 'http') return new StreamableHTTPClientTransport(new URL(server.url));
    if (!server.command) throw new Error('no command configured');
    return new StdioClientTransport({
      command: server.command,
      args: server.args,
      env: this.processEnv(server)
    });
  }

  private processEnv(server: PluginServerConfig): Record<string, string> {
    const extra: Record<string, string> = {};
    for (const [name, value] of Object.entries(server.env)) {
      if (value !== '') extra[name] = value;
      else {
        const secret = this.deps.getSecret(secretKey(server.id, name));
        if (secret !== null) extra[name] = secret;
      }
    }
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(childEnv(extra))) {
      if (value !== undefined) env[name] = value;
    }
    return env;
  }

  /** Hash over everything that requires a new connection; secret values are hashed, never kept. */
  private fingerprint(server: PluginServerConfig): string {
    const secrets = Object.entries(server.env)
      .filter(([, value]) => value === '')
      .map(([name]) => this.deps.getSecret(secretKey(server.id, name)));
    const material = [server.name, server.transport, server.command, server.args, server.url, server.env, secrets];
    return createHash('sha256').update(JSON.stringify(material)).digest('hex');
  }
}

function secretKey(id: string, name: string): SecretKey {
  return `plugin:${id}:env:${name}`;
}

function toToolResult(result: CallToolResult): ToolResult {
  const content = (result.content ?? []).map((block): ToolContent => {
    if (block.type === 'text') return { type: 'text', text: block.text };
    if (block.type === 'image') return { type: 'image', data: block.data, mimeType: block.mimeType };
    return { type: 'text', text: JSON.stringify(block) };
  });
  return {
    content,
    ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
    isError: result.isError === true
  };
}
