import type { Config, ReasoningEffort } from './config';

export interface Project {
  id: string;
  name: string;
  /** Absolute folder. Access is still governed by approved roots, never by the project. */
  path: string;
  createdAt: number;
}

/** `chat`: a user-facing chat. `worker`: spawned by a prime chat. `helper`: Goal/Loop/handoff helper. */
type SessionKind = 'chat' | 'worker' | 'helper';
export type AutomationMode = 'off' | 'goal' | 'loop';

export interface GoalState {
  mode: AutomationMode;
  /** The finish line in the user's words. Loop uses it as the brief. */
  objective: string;
  /** Automatic follow-ups sent since this activation. */
  steps: number;
  status: 'idle' | 'deciding' | 'waiting-workers' | 'done' | 'stopped' | 'error';
  lastDecision: string | null;
}

export interface SessionMeta {
  id: string;
  kind: SessionKind;
  title: string;
  projectId: string | null;
  /** Working directory handed to the model; defaults to the project folder. */
  cwd: string | null;
  /** The ChatGPT conversation currently bound to this session, null before the first send. */
  conversationId: string | null;
  /** Earlier conversations of this session (Compact & Resume moves forward, never back). */
  lineage: string[];
  model: string | null;
  reasoning: ReasoningEffort | null;
  createdAt: number;
  updatedAt: number;
  pinned: boolean;
  /** Prime session for workers and helpers. */
  parentId: string | null;
  goal: GoalState;
  /** Rough token estimate of the bound conversation (local accounting, not the provider's). */
  contextTokens: number;
  /** Blocked chats get no local tool access. */
  blocked: boolean;
}

type TurnStatus = 'idle' | 'sending' | 'generating' | 'compacting';

/** Live, non-persisted session status. */
export interface SessionLive {
  sessionId: string;
  turn: TurnStatus;
  /** A ChatGPT tab is currently open for this session. */
  tabOpen: boolean;
  /** Tool calls currently executing for this session. */
  runningTools: number;
  lastActivityAt: number | null;
}

export interface Attachment {
  id: string;
  name: string;
  mime: string;
  size: number;
  /** Absolute local path the bytes were staged at. */
  path: string;
}

export interface PlanItem {
  step: string;
  status: 'pending' | 'in_progress' | 'completed';
}

type ToolStatus = 'running' | 'ok' | 'error';

/** One block of a recorded tool result, bounded for display. */
export type ToolOutputPart =
  | { type: 'text'; text: string; truncated?: boolean }
  | { type: 'image'; mime: string; path: string }
  | { type: 'diff'; path: string; diff: string; added: number; removed: number }
  | { type: 'exec'; command: string; cwd: string | null; exitCode: number | null; output: string; running: boolean; sessionId: string | null };

interface EventBase {
  /** Stable id; a later event with the same id replaces the earlier one (streaming upserts). */
  id: string;
  at: number;
}

export type SessionEvent =
  | (EventBase & { kind: 'user'; text: string; inputId: string | null; attachments: Attachment[]; source: 'app' | 'browser' | 'automation' | 'agent' })
  | (EventBase & {
      kind: 'assistant';
      messageId: string;
      text: string;
      /** `final` is the answer; `commentary` is interim prose between tool calls. */
      channel: 'final' | 'commentary';
      model: string | null;
      streaming: boolean;
    })
  | (EventBase & { kind: 'reasoning'; messageId: string; text: string; streaming: boolean })
  | (EventBase & {
      kind: 'tool';
      surface: 'core' | 'desktop' | 'plugins' | 'chatgpt';
      name: string;
      /** Arguments as the model sent them (bounded). */
      args: unknown;
      status: ToolStatus;
      output: ToolOutputPart[];
      endedAt: number | null;
    })
  | (EventBase & { kind: 'plan'; explanation: string | null; items: PlanItem[] })
  | (EventBase & { kind: 'turn'; phase: 'start' | 'end'; outcome: 'done' | 'stopped' | 'error' | 'incomplete' | null; error: string | null })
  | (EventBase & { kind: 'notice'; level: 'info' | 'warn' | 'error'; text: string })
  | (EventBase & { kind: 'agent'; workerSessionId: string; label: string; action: 'spawned' | 'messaged' | 'finished' | 'woke'; text: string })
  | (EventBase & { kind: 'handoff'; fromConversationId: string; toConversationId: string | null; brief: string });

export type SessionEventKind = SessionEvent['kind'];

export type InputDelivery = 'now' | 'after-turn';
export type InputState = 'queued' | 'sending' | 'sent' | 'steered' | 'failed' | 'cancelled';

export interface InputItem {
  id: string;
  sessionId: string;
  text: string;
  attachments: Attachment[];
  delivery: InputDelivery;
  state: InputState;
  source: 'app' | 'automation' | 'agent' | 'control-api';
  createdAt: number;
  sentAt: number | null;
  error: string | null;
}

export type SurfaceId = 'core' | 'desktop' | 'plugins';

export type ConnectionState =
  | 'disconnected'
  | 'starting'
  | 'connecting'
  | 'connected'
  | 'offline'
  | 'auth-failed'
  | 'error';

export interface SurfaceStatus {
  id: SurfaceId;
  enabled: boolean;
  /** Exactly what the user types as the app name in ChatGPT. */
  connectorName: string;
  connectorDescription: string;
  state: ConnectionState;
  detail: string;
  /** Public URL for cloudflared/manual; null for the OpenAI tunnel. */
  publicUrl: string | null;
  /** Loopback URL including the secret path. */
  localUrl: string | null;
  handshakeAt: number | null;
  lastRequestAt: number | null;
  lastToolCallAt: number | null;
  toolCount: number;
}

export interface ConnectionStatus {
  state: ConnectionState;
  detail: string;
  surfaces: SurfaceStatus[];
}

export interface ModelOption {
  /** ChatGPT model slug, e.g. `gpt-6-thinking`. */
  id: string;
  label: string;
  efforts: ReasoningEffort[];
}

export interface ModelCatalog {
  state: 'unknown' | 'loading' | 'ready' | 'error';
  models: ModelOption[];
  defaultModel: string | null;
  fetchedAt: number | null;
  error: string | null;
}

export interface BrowserStatus {
  host: 'builtin' | 'extension';
  /** The host is running and a page driver answered. */
  ready: boolean;
  /** ChatGPT session state: null while unknown. */
  signedIn: boolean | null;
  /** Companion extension connected (extension host only). */
  extensionConnected: boolean;
  openTabs: number;
  windowVisible: boolean;
  detail: string;
}

interface UsageInfo {
  /** Free text the provider shows, e.g. "Resets in 3h". */
  summary: string | null;
  fetchedAt: number | null;
}

export type WorkerState = 'queued' | 'working' | 'asleep' | 'finished' | 'failed';

export interface WorkerInfo {
  sessionId: string;
  label: string;
  task: string;
  state: WorkerState;
  model: string | null;
  reasoning: ReasoningEffort | null;
  lastResult: string | null;
  updatedAt: number;
}

export interface AgentRun {
  primeSessionId: string;
  workers: WorkerInfo[];
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  /** Absolute path of SKILL.md. */
  path: string;
}

export interface PluginStatus {
  id: string;
  name: string;
  state: 'stopped' | 'starting' | 'running' | 'error';
  detail: string;
  tools: { name: string; description: string; enabled: boolean }[];
}

export interface FileEntry {
  name: string;
  path: string;
  kind: 'file' | 'dir';
  size: number;
}

export interface GitFileChange {
  path: string;
  /** Porcelain XY status, e.g. ` M`, `??`, `A `. */
  status: string;
}

export interface GitStatus {
  isRepo: boolean;
  branch: string | null;
  ahead: number;
  behind: number;
  changes: GitFileChange[];
  /** Lines added and removed against HEAD, untracked files included. */
  added: number;
  removed: number;
}

export interface LogEntry {
  at: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  scope: string;
  message: string;
}

/** Everything the renderer needs that is not per-session history. Pushed whole on change. */
export interface AppState {
  version: string;
  platform: NodeJS.Platform;
  config: Config;
  connection: ConnectionStatus;
  browser: BrowserStatus;
  models: ModelCatalog;
  usage: UsageInfo;
  sessions: SessionMeta[];
  live: Record<string, SessionLive>;
  inputs: InputItem[];
  projects: Project[];
  agents: AgentRun[];
  skills: Skill[];
  plugins: PluginStatus[];
  /** Secrets that are set (never their values). */
  secretsSet: string[];
  /** Tunnel client binary found / path, for setup. */
  tools: { tunnelClient: string | null; cloudflared: string | null; ripgrep: string | null };
}
