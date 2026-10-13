import type { ExecRequest, ExecResult, WriteStdinRequest } from '@shared/exec';
export type { ExecRequest, ExecResult, WriteStdinRequest } from '@shared/exec';
import type { z } from 'zod';
import type { Config } from '@shared/config';
import type { PlanItem, SurfaceId, ToolOutputPart } from '@shared/types';

/** The chat a tool call was attributed to. */
export interface Caller {
  sessionId: string;
  conversationId: string;
  /** Working directory the session prefers (project folder), already validated against roots. */
  cwd: string | null;
  kind: 'chat' | 'worker' | 'helper';
  /** ChatGPT's streamed message for this call, when attribution matched it (one timeline event). */
  streamCallId?: string;
}

export type ToolContent = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

export interface ToolResult {
  content: ToolContent[];
  structuredContent?: unknown;
  isError?: boolean;
  /** What the app records and shows for this call; defaults to the text content. */
  display?: ToolOutputPart[];
}

type ToolErrorCode =
  | 'TOOL_DISABLED'
  | 'PATH_NOT_ALLOWED'
  | 'NOT_FOUND'
  | 'INVALID_ARGUMENT'
  | 'PATCH_FAILED'
  | 'COMMAND_NOT_ALLOWED'
  | 'UNKNOWN_SESSION'
  | 'CALLER_IDENTITY_REQUIRED'
  | 'CHAT_BLOCKED'
  | 'LIMIT_EXCEEDED'
  | 'FAILED';

/** Thrown by tools for expected failures; the server turns it into an `isError` result. */
export class ToolError extends Error {
  constructor(readonly code: ToolErrorCode, message: string) {
    super(message);
  }
}

/** Path access decisions; implemented by `fs/roots.ts`. */
export interface PathGuard {
  /**
   * Resolves a model-supplied path (absolute, `~`, or relative to `cwd`) to a canonical real path
   * inside an approved root, or throws `ToolError('PATH_NOT_ALLOWED')`. `mustExist` false allows
   * a not-yet-existing file whose parent chain resolves inside a root.
   */
  resolve(path: string, options: { cwd: string | null; mustExist: boolean }): Promise<string>;
  /** Approved root paths (canonical). */
  roots(): string[] | Promise<string[]>;
}

/** Implemented by `exec/process-manager.ts`. */
export interface ProcessRunner {
  exec(request: ExecRequest, owner: string): Promise<ExecResult>;
  writeStdin(request: WriteStdinRequest, owner: string): Promise<ExecResult>;
}

/** Everything tools may touch, injected by the server so tools stay unit-testable. */
export interface ToolServices {
  paths: PathGuard;
  processes: ProcessRunner;
  /** Records a plan for the caller's session (update_plan). */
  setPlan(caller: Caller, explanation: string | null, items: PlanItem[]): void;
  /** Multi-agent controller; null when multi-agent is unavailable. */
  agents: AgentsApi | null;
  /** Holds a finishing turn open and returns queued user instructions (session_finish). */
  finish: ((caller: Caller, signal: AbortSignal) => Promise<string>) | null;
}

export interface AgentsApi {
  spawn(caller: Caller, request: { context: string; workers: { label?: string; task: string; model?: string | null; reasoning_effort?: string | null }[] }): Promise<string>;
  message(caller: Caller, request: { messages: { to: string; text: string }[] }): Promise<string>;
  status(caller: Caller): Promise<string>;
  finish(caller: Caller, request: { result: string }): Promise<string>;
}

/** What code mode (`exec`) needs from its surface: the tools it may call and a nested dispatch. */
interface NestedToolHost {
  /** Tools this surface exposes right now. */
  list(): Array<{ name: string; description: string }>;
  /** Runs one tool as a nested call: live permission check, the parent's identity, hooks, no steering. */
  call(name: string, args: unknown, signal: AbortSignal): Promise<ToolResult>;
}

export interface ToolContext {
  surface: SurfaceId;
  /** `x-request-id` join key, null for local/test calls. */
  requestId: string | null;
  caller: Caller | null;
  config: Config;
  services: ToolServices;
  signal: AbortSignal;
  /** Set by the server for every call; only code mode reads it. */
  nested?: NestedToolHost;
}

interface ToolAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export interface ToolSpec<Shape extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  surface: SurfaceId;
  title: string;
  description: string;
  input: Shape;
  /** Advertised verbatim instead of a schema derived from `input` (external MCP tools). */
  jsonSchema?: Record<string, unknown>;
  outputSchema?: z.ZodObject;
  annotations?: ToolAnnotations;
  /** Whether the tool is advertised under this config. Handlers still re-check permissions. */
  exposed(config: Config): boolean;
  /** Tools that act on a chat's behalf (plans, agents) need an attributed caller. */
  requiresCaller?: boolean;
  run(args: z.infer<z.ZodObject<Shape>>, ctx: ToolContext): Promise<ToolResult>;
}

export function defineTool<Shape extends z.ZodRawShape>(spec: ToolSpec<Shape>): ToolSpec<Shape> {
  return spec;
}

export function textResult(text: string, extra: Partial<ToolResult> = {}): ToolResult {
  return { content: [{ type: 'text', text }], ...extra };
}
