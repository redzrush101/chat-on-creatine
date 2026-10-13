import type { Config, DeepPartial, ReasoningEffort, SecretKey } from './config';
import type { ExecResult } from './exec';
import type {
  AppState,
  CodingTask,
  AutomationMode,
  FileEntry,
  GitStatus,
  InputDelivery,
  InputItem,
  LogEntry,
  Project,
  SessionEvent,
  SessionMeta
} from './types';

interface SendRequest {
  /** Existing session, or null to start a new chat. */
  sessionId: string | null;
  text: string;
  /** Local file paths to attach (picked by the user). */
  attachments: string[];
  delivery: InputDelivery;
  /** Only used when starting a new chat. */
  projectId?: string | null;
  cwd?: string;
  model?: string | null;
  reasoning?: ReasoningEffort | null;
  /** Turn on Goal or Loop for this chat with the message as objective. */
  automation?: AutomationMode;
  /** Optional user-provided title for a new chat. */
  title?: string;
  /** A built-in coding workflow; text supplies optional review focus. */
  task?: CodingTask;
}

interface SendResult {
  sessionId: string;
  input: InputItem;
}

export type FileContent = {
  path: string;
  size: number;
  truncated: boolean;
} & ({ binary: true; text: null } | { binary: false; text: string });

/**
 * Renderer → main request/response calls. The preload exposes exactly these channels; main
 * registers one handler per key. Arguments and results must be structured-clone safe.
 */
export interface RendererApi {
  'app:state': () => AppState;
  'app:show': () => void;
  'app:quit': () => void;
  'app:logs': (limit: number) => LogEntry[];
  'app:openExternal': (url: string) => void;
  'app:revealPath': (path: string) => void;
  'app:pickFolder': () => string | null;
  'app:pickFiles': () => string[];
  'app:clipboard': () => { imagePath: string | null; text: string };
  'app:copyText': (text: string) => void;

  'config:update': (patch: DeepPartial<Config>) => Config;
  'secrets:set': (key: SecretKey, value: string | null) => void;

  'connection:connect': () => void;
  'connection:disconnect': () => void;
  'connection:installTunnelClient': () => string;

  'browser:show': (sessionId: string | null) => void;
  'browser:hide': () => void;
  'browser:refreshModels': () => void;
  'browser:signIn': () => void;

  'sessions:events': (sessionId: string) => SessionEvent[];
  'sessions:update': (
    sessionId: string,
    patch: Partial<Pick<SessionMeta, 'title' | 'pinned' | 'projectId' | 'cwd' | 'model' | 'reasoning' | 'blocked'>>
  ) => SessionMeta;
  'sessions:delete': (sessionId: string) => void;
  'sessions:search': (query: string) => { sessionId: string; eventId: string; snippet: string }[];
  'sessions:export': (sessionId: string) => string;

  'chat:send': (request: SendRequest) => SendResult;
  'chat:stop': (sessionId: string) => void;
  'chat:compact': (sessionId: string) => void;
  'chat:setAutomation': (sessionId: string, mode: AutomationMode, objective?: string) => SessionMeta;

  'inputs:update': (inputId: string, patch: { text?: string; delivery?: InputDelivery }) => InputItem;
  'inputs:cancel': (inputId: string) => void;
  'inputs:sendNow': (inputId: string) => void;
  'inputs:retry': (inputId: string) => InputItem;

  'projects:add': (path: string, name?: string) => Project;
  'projects:update': (projectId: string, patch: Partial<Pick<Project, 'name'>>) => Project;
  'projects:remove': (projectId: string) => void;

  'files:list': (dir: string) => FileEntry[];
  'files:read': (path: string) => FileContent;
  'files:gitStatus': (dir: string) => GitStatus;
  'files:gitDiff': (dir: string, path: string) => string;

  'terminal:open': (init: { cwd: string | null; cols: number; rows: number }) => string;
  'terminal:write': (terminalId: string, data: string) => void;
  'terminal:resize': (terminalId: string, cols: number, rows: number) => void;
  'terminal:close': (terminalId: string) => void;
  'commands:exec': (cmd: string, cwd: string) => ExecResult;
  'commands:poll': (sessionId: string, chars: string) => ExecResult;
  'commands:list': () => { sessionId: string; command: string; owner: string; startedAt: number }[];

  'skills:import': (folder: string) => void;
  'skills:remove': (skillId: string) => void;
  'skills:read': (skillId: string) => string;

  'plugins:restart': (pluginId: string) => void;

  'agents:stopWorker': (workerSessionId: string) => void;
}

export type RendererChannel = keyof RendererApi;

/** Main → renderer push events. */
export interface MainEvents {
  /** Full app state; sent on every coalesced change. */
  state: AppState;
  /** Upserted history events of one session (only for sessions the renderer subscribed to). */
  'session:events': { sessionId: string; events: SessionEvent[] };
  'terminal:data': { terminalId: string; data: string };
  'terminal:exit': { terminalId: string; code: number | null };
  log: LogEntry;
}

export type MainEvent = keyof MainEvents;

/** The object the preload exposes on `window.creatine`. */
export interface PreloadBridge {
  invoke<C extends RendererChannel>(channel: C, ...args: Parameters<RendererApi[C]>): Promise<Awaited<ReturnType<RendererApi[C]>>>;
  on<E extends MainEvent>(event: E, listener: (payload: MainEvents[E]) => void): () => void;
}

export const RENDERER_CHANNELS: readonly RendererChannel[] = [
  'app:state',
  'app:show',
  'app:quit',
  'app:logs',
  'app:openExternal',
  'app:revealPath',
  'app:pickFolder',
  'app:pickFiles',
  'app:clipboard',
  'app:copyText',
  'config:update',
  'secrets:set',
  'connection:connect',
  'connection:disconnect',
  'connection:installTunnelClient',
  'browser:show',
  'browser:hide',
  'browser:refreshModels',
  'browser:signIn',
  'sessions:events',
  'sessions:update',
  'sessions:delete',
  'sessions:search',
  'sessions:export',
  'chat:send',
  'chat:stop',
  'chat:compact',
  'chat:setAutomation',
  'inputs:update',
  'inputs:cancel',
  'inputs:sendNow',
  'inputs:retry',
  'projects:add',
  'projects:update',
  'projects:remove',
  'files:list',
  'files:read',
  'files:gitStatus',
  'files:gitDiff',
  'terminal:open',
  'terminal:write',
  'terminal:resize',
  'terminal:close',
  'commands:exec',
  'commands:poll',
  'commands:list',
  'skills:import',
  'skills:remove',
  'skills:read',
  'plugins:restart',
  'agents:stopWorker'
];

export const MAIN_EVENTS: readonly MainEvent[] = ['state', 'session:events', 'terminal:data', 'terminal:exit', 'log'];
