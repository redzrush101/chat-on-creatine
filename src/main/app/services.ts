import { existsSync } from 'node:fs';
import os from 'node:os';
import { join } from 'node:path';
import { safeStorage } from 'electron';
import type { Config, SecretKey } from '@shared/config';
import type { SessionMeta, SurfaceId } from '@shared/types';
import { AgentController } from '../agents/controller';
import { Automation } from '../automation/automation';
import { BuiltinHost } from '../chatgpt/builtin-host';
import { ChatRouter } from '../chatgpt/router';
import { ConfigStore } from '../core/config-store';
import { readJsonSync, writeJson } from '../core/durable';
import type { AppPaths } from '../core/paths';
import { SecretStore, type Cipher } from '../core/secret-store';
import { ProcessManager } from '../exec/process-manager';
import { RootGuard } from '../fs/roots';
import { McpHttpServer, generateToken } from '../mcp/server';
import { CONNECTOR_BRAND } from '../mcp/surfaces';
import { CORE_TOOLS } from '../mcp/tools';
import { agentsTool } from '../mcp/tools/agents';
import { browserTools, setAgentBrowser } from '../mcp/tools/browser';
import { AgentBrowser } from '../browser-tools/agent-browser';
import { sessionFinishTool } from '../mcp/tools/session-finish';
import { updatePlanTool } from '../mcp/tools/update-plan';
import { resourceTools } from '../mcp/tools/resources';
import { ToolError } from '../mcp/tool';
import { ControlApi } from '../control-api';
import { recentLogs, createLogger } from '../core/log';
import { PluginManager } from '../plugins/manager';
import { ProjectStore } from '../projects/projects';
import { Outbox } from '../sessions/outbox';
import { Recorder } from '../sessions/recorder';
import { SessionStore } from '../sessions/store';
import { SkillLibrary } from '../skills/library';
import { TerminalManager } from '../terminal/terminals';
import { ConnectionManager } from '../tunnel/connection';
import { ModelService } from './models';
import { buildOpeningContext } from './opening';
import { ToolActivity } from './tool-activity';

const log = createLogger('services');

const safeCipher: Cipher = {
  available: () => safeStorage.isEncryptionAvailable(),
  encrypt: (plain) => safeStorage.encryptString(plain).toString('base64'),
  decrypt: (cipher) => safeStorage.decryptString(Buffer.from(cipher, 'base64'))
};

/** Stable per-install secret path tokens, so manual/cloudflared URLs survive restarts. */
function loadTokens(file: string): Record<SurfaceId, string> {
  const stored = readJsonSync<Partial<Record<SurfaceId, string>>>(file, {});
  const tokens: Record<SurfaceId, string> = {
    core: stored.core ?? generateToken(),
    desktop: stored.desktop ?? generateToken(),
    plugins: stored.plugins ?? generateToken()
  };
  if (stored.core !== tokens.core || stored.desktop !== tokens.desktop || stored.plugins !== tokens.plugins) void writeJson(file, tokens);
  return tokens;
}

export interface Services {
  paths: AppPaths;
  config: ConfigStore;
  secrets: SecretStore;
  store: SessionStore;
  outbox: Outbox;
  projects: ProjectStore;
  skills: SkillLibrary;
  processes: ProcessManager;
  terminals: TerminalManager;
  host: BuiltinHost;
  router: ChatRouter;
  agents: AgentController;
  automation: Automation;
  server: McpHttpServer;
  connection: ConnectionManager;
  models: ModelService;
  plugins: PluginManager;
  controlApi: ControlApi;
  /** Sessions whose Compact & Resume is in progress (shown as the `compacting` turn). */
  compacting: Set<string>;
  sessionCwd(session: SessionMeta): string | null;
  dispose(): Promise<void>;
}

interface ServiceHooks {
  version: string;
  /** Something in AppState changed. */
  changed(): void;
  terminalData(id: string, data: string): void;
  terminalExit(id: string, code: number | null): void;
}

/** Builds every long-lived service and wires them together. No windows here. */
export function createServices(paths: AppPaths, preloadDir: string, resourcesBin: string | null, hooks: ServiceHooks): Services {
  const config = new ConfigStore(paths.config);
  const getConfig = (): Config => config.get();
  const secrets = new SecretStore(paths.secrets, safeCipher);
  secrets.upgrade();
  const store = new SessionStore(paths.sessions, { recording: () => getConfig().sessions.recording });
  store.load();
  store.prune(getConfig().sessions.retentionDays);
  const outbox = new Outbox(join(paths.state, 'outbox.json'));
  const projects = new ProjectStore(join(paths.state, 'projects.json'));
  const skills = new SkillLibrary(paths.skills);
  skills.load();
  const processes = new ProcessManager();
  const terminals = new TerminalManager({ onData: hooks.terminalData, onExit: hooks.terminalExit });
  const roots = new RootGuard(getConfig);
  const host = new BuiltinHost({ preloadPath: join(preloadDir, 'chatgpt.js') });
  const models = new ModelService(host, hooks.changed);
  const recorder = new Recorder({
    store,
    // `/<Connector Name>/link_…/<tool>`: our own calls are recorded by the MCP server itself.
    // Connectors created before the app was renamed still carry its old name.
    isOwnConnectorPath: (path) => [CONNECTOR_BRAND, 'Chat on Steroids'].some((brand) => path.replace(/^\//, '').toLowerCase().startsWith(brand.toLowerCase()))
  });
  const compacting = new Set<string>();

  const sessionCwd = (session: SessionMeta): string | null => {
    const candidate = session.cwd ?? (session.projectId ? projects.get(session.projectId)?.path ?? null : null);
    if (candidate && existsSync(candidate)) return candidate;
    // YOLO mode needs no approved folder; a chat without one works in the home folder.
    return getConfig().roots[0]?.path ?? (getConfig().yolo ? os.homedir() : null);
  };

  // Router, agents and automation reference each other through these late-bound closures.
  let router: ChatRouter;
  const agents = new AgentController({
    store,
    outbox,
    getConfig,
    turnOf: (id) => router.turnOf(id),
    interrupt: (id) => router.interrupt(id),
    onChange: hooks.changed
  });
  const automation = new Automation({
    store,
    outbox,
    getConfig,
    getSecret: (key) => secrets.get(key),
    setTurn: (sessionId, turn) => {
      if (turn === 'compacting') compacting.add(sessionId);
      else compacting.delete(sessionId);
      hooks.changed();
    },
    workersBusy: (sessionId) => agents.runs().some((run) => run.primeSessionId === sessionId && run.workers.some((worker) => worker.state === 'working' || worker.state === 'queued'))
  });
  router = new ChatRouter({
    host,
    store,
    recorder,
    outbox,
    getConfig,
    openingContext: (session) => {
      const project = session.projectId ? projects.get(session.projectId) : null;
      return buildOpeningContext(getConfig(), session, project ?? null, sessionCwd(session), 0);
    },
    sessionCwd,
    canStart: (session) => agents.canStart(session),
    onTurnEnd: (session, outcome) => {
      agents.onTurnEnd(session, outcome);
      automation.onTurnEnd(session, outcome);
    },
    onAuth: (signedIn) => models.onAuth(signedIn),
    models: () => models.forSelection(),
    onLiveChange: hooks.changed
  });

  let connection: ConnectionManager | null = null;
  const activity = new ToolActivity({ store, outbox, router, connection: () => connection });
  const plugins = new PluginManager({ getConfig, getSecret: (key) => secrets.get(key), onChange: () => { hooks.changed(); server.toolsChanged(); } });
  const agentBrowser = new AgentBrowser();
  setAgentBrowser(agentBrowser);
  const coreTools = [...CORE_TOOLS, updatePlanTool, agentsTool, sessionFinishTool, ...browserTools, ...resourceTools(plugins)];
  const server = new McpHttpServer({
    getConfig,
    tools: () => [...coreTools, ...plugins.tools()],
    services: {
      paths: roots,
      processes,
      setPlan: (caller, explanation, items) => activity.setPlan(caller, explanation, items),
      agents,
      finish: (caller, signal) => activity.finish(caller, signal)
    },
    tokens: loadTokens(join(paths.state, 'mcp-tokens.json')),
    resolveCaller: async (requestId, call) => {
      const caller = await router.resolveCaller(requestId, { tool: call.tool, args: call.args });
      if (caller && store.get(caller.sessionId)?.blocked) {
        throw new ToolError('CHAT_BLOCKED', 'Local tools are blocked for this chat in the app.');
      }
      return caller;
    },
    steering: (caller) => activity.steering(caller),
    hooks: {
      onRequest: (surface) => activity.onRequest(surface),
      onCallStart: (call) => activity.onCallStart(call),
      onCallEnd: (call, result) => activity.onCallEnd(call, result)
    }
  });
  connection = new ConnectionManager({
    getConfig,
    getSecret: (key: SecretKey) => secrets.get(key),
    server,
    binDir: paths.bin,
    resourcesBinDir: resourcesBin,
    onConfigChange: (listener) => config.onChange((next) => listener(next))
  });
  connection.onStatus(hooks.changed);

  store.onMeta(hooks.changed);
  outbox.onChange(hooks.changed);
  projects.onChange(hooks.changed);
  skills.onChange(hooks.changed);
  const controlApi = new ControlApi({
    dir: join(paths.userData, 'control-api'),
    version: hooks.version,
    getConfig,
    store,
    outbox,
    turnOf: (id) => router.turnOf(id),
    connectionStatus: () => connection!.status(),
    agents: () => agents.runs(),
    logs: (limit) => recentLogs(limit)
  });
  const syncControlApi = () => void Promise.resolve(controlApi.sync()).catch((error: unknown) => log.error('control API', error));
  config.onChange((next, previous) => {
    hooks.changed();
    void plugins.reconcile();
    if (JSON.stringify([next.capabilities, next.readOnly, next.yolo, next.agents.enabled, next.automation.finishTool]) !==
      JSON.stringify([previous.capabilities, previous.readOnly, previous.yolo, previous.agents.enabled, previous.automation.finishTool])) server.toolsChanged();
    syncControlApi();
  });
  void plugins.start();
  syncControlApi();

  return {
    paths,
    config,
    secrets,
    store,
    outbox,
    projects,
    skills,
    processes,
    terminals,
    host,
    router,
    agents,
    automation,
    server,
    connection,
    models,
    plugins,
    controlApi,
    compacting,
    sessionCwd,
    async dispose() {
      router.stop();
      await connection?.dispose();
      await plugins.stop();
      await controlApi.close();
      agentBrowser.dispose();
      setAgentBrowser(null);
      await server.stop();
      await processes.dispose();
      terminals.disposeAll();
      await host.stop();
      await store.flush();
    }
  };
}
