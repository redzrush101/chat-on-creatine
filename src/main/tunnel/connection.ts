import { errorMessage } from '@shared/errors';
import type { Config, SecretKey } from '@shared/config';
import type { ConnectionState, ConnectionStatus, SurfaceId, SurfaceStatus } from '@shared/types';
import { createLogger } from '../core/log';
import type { McpHttpServer } from '../mcp/server';
import { connectorName, SURFACE_IDS, SURFACES } from '../mcp/surfaces';
import { locateBinary } from './locate';
import { startTunnel } from './tunnel';
import type { TunnelAdapter, TunnelHandle } from './types';

const log = createLogger('connection');

interface ConnectionDeps {
  getConfig(): Config;
  getSecret(key: SecretKey): string | null;
  server: McpHttpServer;
  binDir: string;
  resourcesBinDir: string | null;
  /** Config saves; lets a live connection reconnect when its wiring changes. */
  onConfigChange?(listener: (next: Config) => void): () => void;
}

interface SurfaceRuntime {
  state: ConnectionState;
  detail: string;
  publicUrl: string | null;
  handshakeAt: number | null;
  handle: TunnelHandle | null;
  lastRequestAt: number | null;
  lastToolCallAt: number | null;
}

/** Surfaces this config publishes. Desktop and Plugins need their own OpenAI tunnel id. */
function enabledSurfaces(config: Config): SurfaceId[] {
  const openai = config.connection.kind === 'openai';
  const ids: SurfaceId[] = ['core'];
  if (config.capabilities.browser && (!openai || config.connection.desktopTunnelId.trim())) ids.push('desktop');
  if (config.plugins.some((plugin) => plugin.enabled) && (!openai || config.connection.pluginsTunnelId.trim())) ids.push('plugins');
  return ids;
}

function tunnelIdFor(config: Config, surface: SurfaceId): string {
  const { connection } = config;
  return surface === 'core' ? connection.tunnelId : surface === 'desktop' ? connection.desktopTunnelId : connection.pluginsTunnelId;
}

/** Every setting that a running connection was built from. A change to any of them reconnects. */
function wiringOf(config: Config): string {
  const { connection } = config;
  return JSON.stringify({
    kind: connection.kind,
    ids: [connection.tunnelId, connection.desktopTunnelId, connection.pluginsTunnelId],
    paths: [connection.tunnelClientPath, connection.cloudflaredPath],
    port: connection.port,
    enabled: enabledSurfaces(config)
  });
}

/**
 * Owns the lifecycle: the local MCP server, then one tunnel per enabled surface. Every state the
 * UI shows comes from here.
 */
export class ConnectionManager {
  private readonly runtimes = new Map<SurfaceId, SurfaceRuntime>();
  private readonly listeners = new Set<(status: ConnectionStatus) => void>();
  private readonly unsubscribe: (() => void) | null;
  private queue: Promise<void> = Promise.resolve();
  /** Bumped on every teardown so late tunnel reports from a previous run are ignored. */
  private generation = 0;
  private running = false;
  private wiring: string | null = null;
  private toolLocations: Promise<{ tunnelClient: string | null; cloudflared: string | null }> | null = null;

  constructor(private readonly deps: ConnectionDeps) {
    for (const id of SURFACE_IDS) {
      this.runtimes.set(id, {
        state: 'disconnected',
        detail: '',
        publicUrl: null,
        handshakeAt: null,
        handle: null,
        lastRequestAt: null,
        lastToolCallAt: null
      });
    }
    this.unsubscribe = deps.onConfigChange?.((next) => this.onConfigChange(next)) ?? null;
  }

  connect(): Promise<void> {
    return this.enqueue(() => this.connectNow());
  }

  disconnect(): Promise<void> {
    this.generation += 1;
    return this.enqueue(() => this.teardown());
  }

  /** Stops everything and releases the config subscription. Call once at app shutdown. */
  async dispose(): Promise<void> {
    this.unsubscribe?.();
    await this.disconnect();
  }

  onStatus(listener: (status: ConnectionStatus) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  noteRequest(surface: SurfaceId): void {
    this.runtimes.get(surface)!.lastRequestAt = Date.now();
    this.emit();
  }

  noteToolCall(surface: SurfaceId): void {
    this.runtimes.get(surface)!.lastToolCallAt = Date.now();
    this.emit();
  }

  status(): ConnectionStatus {
    const config = this.deps.getConfig();
    const enabled = enabledSurfaces(config);
    const surfaces: SurfaceStatus[] = SURFACE_IDS.map((id) => {
      const runtime = this.runtimes.get(id)!;
      const isOn = enabled.includes(id);
      return {
        id,
        enabled: isOn,
        connectorName: connectorName(id, config.connection.connectorSuffix),
        connectorDescription: SURFACES[id].description,
        state: this.running && isOn ? runtime.state : 'disconnected',
        detail: this.running && isOn ? runtime.detail : '',
        publicUrl: this.running && isOn ? runtime.publicUrl : null,
        localUrl: this.running && isOn ? this.deps.server.localUrl(id) : null,
        handshakeAt: runtime.handshakeAt,
        lastRequestAt: runtime.lastRequestAt,
        lastToolCallAt: runtime.lastToolCallAt,
        toolCount: this.deps.server.toolCount(id)
      };
    });
    const core = this.runtimes.get('core')!;
    return {
      state: this.running ? core.state : 'disconnected',
      detail: this.running ? core.detail : '',
      surfaces
    };
  }

  /** The tunnel executables this install can find, for the setup screen. */
  tools(): Promise<{ tunnelClient: string | null; cloudflared: string | null }> {
    return this.toolLocations ??= this.locateTools();
  }

  private async locateTools(): Promise<{ tunnelClient: string | null; cloudflared: string | null }> {
    const { connection } = this.deps.getConfig();
    const dirs = { binDir: this.deps.binDir, resourcesBinDir: this.deps.resourcesBinDir };
    const [tunnelClient, cloudflared] = await Promise.all([
      locateBinary('tunnel-client', { explicit: connection.tunnelClientPath, ...dirs }),
      locateBinary('cloudflared', { explicit: connection.cloudflaredPath, ...dirs })
    ]);
    return { tunnelClient, cloudflared };
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    const run = this.queue.then(task);
    this.queue = run.catch((error: unknown) => log.error('connection task failed', error));
    return run;
  }

  private onConfigChange(next: Config): void {
    this.toolLocations = null;
    if (!this.running || this.wiring === null || wiringOf(next) === this.wiring) return;
    log.info('connection settings changed; reconnecting');
    this.generation += 1;
    void this.enqueue(async () => {
      await this.teardown();
      await this.connectNow();
    });
  }

  private async connectNow(): Promise<void> {
    if (this.running) return;
    const config = this.deps.getConfig();
    const generation = ++this.generation;
    try {
      await this.deps.server.start(config.connection.port);
    } catch (error) {
      log.error('local server did not start', error);
      this.setSurface('core', 'error', errorMessage(error));
      this.emit();
      return;
    }
    this.running = true;
    this.wiring = wiringOf(config);
    for (const id of enabledSurfaces(config)) await this.startSurface(id, config, generation);
    this.emit();
  }

  private async startSurface(id: SurfaceId, config: Config, generation: number): Promise<void> {
    const runtime = this.runtimes.get(id)!;
    const adapter = config.connection.kind;
    const localUrl = this.deps.server.localUrl(id);
    this.setSurface(id, 'starting', 'Connecting…');
    try {
      const handle = await startTunnel({
        adapter,
        label: id,
        localUrl: localUrl ?? '',
        binary: await this.binaryFor(adapter, config),
        tunnelId: adapter === 'openai' ? tunnelIdFor(config, id) : '',
        apiKey: adapter === 'openai' ? this.deps.getSecret('tunnelApiKey') : null,
        report: (report) => {
          if (generation !== this.generation) return;
          runtime.state = report.state;
          runtime.detail = report.detail;
          runtime.publicUrl = report.publicUrl;
          runtime.handshakeAt = report.handshakeAt;
          this.emit();
        }
      });
      if (generation !== this.generation) {
        await handle.stop();
        return;
      }
      runtime.handle = handle;
    } catch (error) {
      const message = errorMessage(error);
      log.warn(`${id} tunnel not started: ${message}`);
      this.setSurface(id, 'error', message);
    }
  }

  private async binaryFor(adapter: TunnelAdapter, config: Config): Promise<string | null> {
    if (adapter === 'manual') return null;
    const { connection } = config;
    const dirs = { binDir: this.deps.binDir, resourcesBinDir: this.deps.resourcesBinDir };
    return adapter === 'openai'
      ? locateBinary('tunnel-client', { explicit: connection.tunnelClientPath, ...dirs })
      : locateBinary('cloudflared', { explicit: connection.cloudflaredPath, ...dirs });
  }

  private async teardown(): Promise<void> {
    this.generation += 1;
    const handles = SURFACE_IDS.map((id) => this.runtimes.get(id)!.handle);
    for (const id of SURFACE_IDS) {
      const runtime = this.runtimes.get(id)!;
      runtime.handle = null;
      runtime.state = 'disconnected';
      runtime.detail = '';
      runtime.publicUrl = null;
      runtime.handshakeAt = null;
    }
    await Promise.all(handles.map((handle) => handle?.stop().catch(() => {})));
    await this.deps.server.stop();
    this.running = false;
    this.wiring = null;
    this.emit();
  }

  private setSurface(id: SurfaceId, state: ConnectionState, detail: string): void {
    const runtime = this.runtimes.get(id)!;
    runtime.state = state;
    runtime.detail = detail;
    this.emit();
  }

  private emit(): void {
    const status = this.status();
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch (error) {
        log.error('status listener failed', error);
      }
    }
  }
}
