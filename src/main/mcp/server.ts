import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Config } from '@shared/config';
import type { SurfaceId } from '@shared/types';
import { createLogger } from '../core/log';
import { serverInstructions } from './instructions';
import { SURFACE_IDS, SURFACES } from './surfaces';
import { ToolError, type Caller, type ToolContent, type ToolContext, type ToolResult, type ToolServices, type ToolSpec } from './tool';

const log = createLogger('mcp');
const SERVER_VERSION = '0.1.0';
const MAX_BODY_BYTES = 8 * 1024 * 1024;
/** Tool text returned to the model in one result; a larger output is cut and marked. */
const MAX_TEXT_CHARS = 200_000;
const PRM_PREFIX = '/.well-known/oauth-protected-resource';

/** One executed tool call, as reported to hooks. */
export interface CallRecord {
  id: string;
  surface: SurfaceId;
  tool: string;
  args: unknown;
  requestId: string | null;
  caller: Caller | null;
  startedAt: number;
}

export interface McpHttpServerOptions {
  getConfig(): Config;
  tools: ToolSpec[];
  services: ToolServices;
  /** Secret path token per surface, supplied by the caller and persisted there. */
  tokens: Record<SurfaceId, string>;
  /** Attributes a call to a chat from its `x-request-id` join key (null when the header is absent). */
  resolveCaller(requestId: string | null, call: { surface: SurfaceId; tool: string; args: unknown }): Promise<Caller | null>;
  /** User messages typed to this chat while it was working; appended to the result. */
  steering(caller: Caller): string[];
  hooks?: {
    onRequest?(surface: SurfaceId): void;
    onCallStart?(call: CallRecord): void;
    onCallEnd?(call: CallRecord, result: ToolResult): void;
  };
}

export function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}

/**
 * The join key inside an `x-request-id` header: `wfr_<id>/<suffix>` yields `wfr_<id>`. The suffix
 * differs per hop, so only the part before the slash identifies the chat. A repeated header is
 * ambiguous and therefore unattributable.
 */
export function requestIdFromHeader(value: string | string[] | undefined): string | null {
  if (Array.isArray(value) && value.length !== 1) return null;
  const raw = Array.isArray(value) ? value[0] : value;
  if (typeof raw !== 'string') return null;
  const id = raw.split('/')[0]!.trim();
  return id.length > 0 && id.length <= 100 && /^[a-z0-9_-]+$/i.test(id) ? id : null;
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

type BodyResult = { ok: true; body: unknown } | { ok: false; reason: 'too_large' | 'invalid' };

function readJsonBody(req: http.IncomingMessage): Promise<BodyResult> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let settled = false;
    const finish = (result: BodyResult) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) finish({ ok: false, reason: 'too_large' });
      else chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        finish({ ok: true, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
      } catch {
        finish({ ok: false, reason: 'invalid' });
      }
    });
    req.on('error', () => finish({ ok: false, reason: 'invalid' }));
  });
}

/** Bounds text across all blocks of one result; images pass through untouched. */
function boundContent(content: ToolContent[]): ToolContent[] {
  let budget = MAX_TEXT_CHARS;
  return content.map((block) => {
    if (block.type !== 'text') return block;
    const text = block.text.length > budget ? `${block.text.slice(0, budget)}\n[output truncated]` : block.text;
    budget = Math.max(0, budget - block.text.length);
    return { type: 'text', text };
  });
}

/**
 * The local MCP endpoint: one path per surface, each guarded by its own secret token. Stateless:
 * every HTTP request gets a fresh McpServer built from live config, so a permission change takes
 * effect on the next call without a restart.
 */
export class McpHttpServer {
  private server: http.Server | null = null;
  private port = 0;

  constructor(private readonly options: McpHttpServerOptions) {}

  async start(port: number): Promise<{ port: number }> {
    if (this.server) throw new Error('MCP server already started');
    const server = http.createServer((req, res) => {
      void this.handle(req, res).catch((error: unknown) => {
        log.error('request failed', error);
        if (!res.headersSent) sendJson(res, 500, { error: 'internal' });
      });
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    this.server = server;
    this.port = (server.address() as AddressInfo).port;
    log.info(`listening on 127.0.0.1:${this.port}`);
    return { port: this.port };
  }

  async stop(): Promise<void> {
    const server = this.server;
    if (!server) return;
    this.server = null;
    this.port = 0;
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      server.closeIdleConnections();
    });
  }

  localUrl(surface: SurfaceId): string | null {
    if (!this.server) return null;
    return `http://127.0.0.1:${this.port}/mcp/${this.options.tokens[surface]}`;
  }

  toolCount(surface: SurfaceId): number {
    return this.toolsFor(surface, this.options.getConfig()).length;
  }

  private toolsFor(surface: SurfaceId, config: Config): ToolSpec[] {
    return this.options.tools.filter((tool) => tool.surface === surface && tool.exposed(config));
  }

  private surfaceForPath(path: string, prefix = ''): SurfaceId | null {
    if (!path.startsWith(prefix)) return null;
    const match = /^\/mcp\/([^/]+)$/.exec(path.slice(prefix.length));
    if (!match) return null;
    let found: SurfaceId | null = null;
    for (const id of SURFACE_IDS) {
      const token = this.options.tokens[id];
      if (token && safeEqual(match[1]!, token)) found = id;
    }
    return found;
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const path = (req.url ?? '').split('?')[0]!;
    if (path === '/healthz') {
      sendJson(res, 200, { ok: true });
      return;
    }
    // RFC 9728 metadata, served only at the token-qualified path. tunnel-client's discovery
    // requires it; it names the resource and no authorization server: the token is the auth.
    const metadataSurface = this.surfaceForPath(path, PRM_PREFIX);
    if (metadataSurface) {
      sendJson(res, 200, {
        resource: this.localUrl(metadataSurface),
        resource_name: SURFACES[metadataSurface].serverName,
        authorization_servers: [],
        scopes_supported: []
      });
      return;
    }
    const surface = this.surfaceForPath(path);
    if (!surface) {
      sendJson(res, 404, { error: 'not_found' });
      return;
    }
    const method = req.method ?? '';
    if (method !== 'POST' && method !== 'GET' && method !== 'DELETE') {
      sendJson(res, 405, { error: 'method_not_allowed' });
      return;
    }
    this.options.hooks?.onRequest?.(surface);

    let body: unknown;
    if (method === 'POST') {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) {
        res.setHeader('connection', 'close');
        if (parsed.reason === 'too_large') sendJson(res, 413, { error: 'payload_too_large' });
        else sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
        return;
      }
      body = parsed.body;
    }

    const requestId = requestIdFromHeader(req.headers['x-request-id']);
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    const mcp = this.buildServer(surface, requestId, abort.signal);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void mcp.close();
    });
    await mcp.connect(transport);
    await transport.handleRequest(req, res, body);
  }

  private buildServer(surface: SurfaceId, requestId: string | null, signal: AbortSignal): McpServer {
    const config = this.options.getConfig();
    const server = new McpServer(
      { name: SURFACES[surface].serverName, version: SERVER_VERSION },
      { instructions: serverInstructions(surface, config) }
    );
    for (const tool of this.toolsFor(surface, config)) {
      server.registerTool(
        tool.name,
        { title: tool.title, description: tool.description, inputSchema: tool.input, annotations: tool.annotations },
        (args: unknown) => this.dispatch(tool, args, requestId, signal)
      );
    }
    return server;
  }

  /**
   * Runs one tool call. Expected refusals (disabled tool, missing caller) come back as a normal
   * `isError` result, not a protocol error, so the model can read them and adjust.
   */
  private async dispatch(tool: ToolSpec, args: unknown, requestId: string | null, signal: AbortSignal): Promise<CallToolResult> {
    const { options } = this;
    const config = options.getConfig();
    let caller: Caller | null = null;
    try {
      if (!tool.exposed(config)) throw new ToolError('TOOL_DISABLED', `${tool.name} is turned off in Settings.`);
      caller = await options.resolveCaller(requestId, { surface: tool.surface, tool: tool.name, args });
      if ((tool.requiresCaller || !config.browser.allowUnattributed) && !caller) {
        throw new ToolError('CALLER_IDENTITY_REQUIRED', `${tool.name} needs the chat that issued it, and that chat could not be identified.`);
      }
    } catch (error) {
      if (!(error instanceof ToolError)) log.error(`${tool.name} could not be attributed`, error);
      return this.toCallResult(error instanceof ToolError ? toolErrorResult(error) : unexpectedResult(error));
    }

    const call: CallRecord = { id: randomUUID(), surface: tool.surface, tool: tool.name, args, requestId, caller, startedAt: Date.now() };
    options.hooks?.onCallStart?.(call);
    const run = tool.run as (input: unknown, ctx: ToolContext) => Promise<ToolResult>;
    let result: ToolResult;
    try {
      result = await run(args, { surface: tool.surface, requestId, caller, config, services: options.services, signal });
    } catch (error) {
      if (!(error instanceof ToolError)) log.error(`${tool.name} failed`, error);
      result = error instanceof ToolError ? toolErrorResult(error) : unexpectedResult(error);
    }
    options.hooks?.onCallEnd?.(call, result);

    const steering = caller ? options.steering(caller) : [];
    const content = [
      ...boundContent(result.content),
      ...steering.map((message): ToolContent => ({
        type: 'text',
        text: `The user sent this message while you were working; read it and adjust: ${message}`
      }))
    ];
    return this.toCallResult({ ...result, content });
  }

  private toCallResult(result: ToolResult): CallToolResult {
    return {
      content: result.content as CallToolResult['content'],
      ...(result.structuredContent ? { structuredContent: result.structuredContent } : {}),
      isError: result.isError ?? false
    };
  }
}

function toolErrorResult(error: ToolError): ToolResult {
  return { content: [{ type: 'text', text: `${error.code}: ${error.message}` }], isError: true };
}

function unexpectedResult(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return { content: [{ type: 'text', text: `FAILED: ${message}` }], isError: true };
}
