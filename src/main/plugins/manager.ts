import { createHash } from 'node:crypto';
import { Client, StreamableHTTPClientTransport, type Transport, type CallToolResult, type Tool } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import type { Config, PluginServerConfig, SecretKey } from '@shared/config';
import type { PluginStatus } from '@shared/types';
import { createLogger } from '../core/log';
import { childEnv } from '../exec/env';
import { ToolError, type ToolContent, type ToolContext, type ToolResult, type ToolSpec } from '../mcp/tool';
import { exposedNames } from './exposure';

const log = createLogger('plugins');

export const MAX_RECONNECTS = 5;
const RECONNECT_BASE_MS = 1_000;
/** A connection that stays up this long resets the reconnect budget. */
const STABLE_MS = 30_000;
const START_TIMEOUT_MS = 60_000;
const TOOL_TIMEOUT_MS = 120_000;

export interface PluginManagerDeps {
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

  constructor(private readonly deps: PluginManagerDeps) {}

  start(): void {
    this.reconcile();
  }

  async stop(): Promise<void> {
    await Promise.all([...this.entries.keys()].map((id) => this.close(id)));
    this.deps.onChange();
  }

  /** Brings connections in line with the current config. Call after every config change. */
  reconcile(): void {
    const wanted = this.deps.getConfig().plugins.filter((server) => server.enabled);
    const wantedIds = new Set(wanted.map((server) => server.id));
    for (const id of [...this.entries.keys()]) {
      if (!wantedIds.has(id)) void this.close(id);
    }
    for (const server of wanted) {
      const fingerprint = this.fingerprint(server);
      if (this.entries.get(server.id)?.fingerprint === fingerprint) continue;
      void this.close(server.id);
      this.launch(server, fingerprint);
    }
    this.deps.onChange();
  }

  restart(id: string): void {
    const server = this.deps.getConfig().plugins.find((item) => item.id === id);
    if (!server?.enabled) return;
    void this.close(id);
    this.launch(server, this.fingerprint(server));
    this.deps.onChange();
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
    const live = [...this.entries.values()].filter((entry) => entry.state === 'running');
    const exposed = (entry: Entry) => entry.tools.filter((tool) => this.isExposed(entry.id, tool.name, config));
    const names = exposedNames(
      live.map((entry) => ({ id: entry.id, name: entry.config.name, toolNames: exposed(entry).map((tool) => tool.name) }))
    );
    return live.flatMap((entry) =>
      exposed(entry).map((tool) => this.spec(entry.id, tool, names.get(entry.id)!.get(tool.name)!))
    );
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
    const client = new Client({ name: 'chat-on-creatine', version: '0.1.0' });
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
    this.deps.onChange();
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
    this.deps.onChange();
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
