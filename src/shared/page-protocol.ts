/**
 * Protocol between the app (main process) and the driver script running inside a chatgpt.com
 * page. The same protocol is used by the built-in browser (Electron IPC) and the companion
 * Chrome extension (WebSocket), so the driver never knows which host it runs in.
 */
import type { ReasoningEffort } from './config';
import type { ModelOption } from './types';

/** A ChatGPT message normalized from the conversation stream or the conversation API. */
export interface ChatMessage {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'tool' | 'system';
  /** Tool author name, e.g. `api_tool.call_tool`, `web.run`, `container.exec`. */
  authorName: string | null;
  /** `all` for normal prose; a tool name when the assistant addresses a tool. */
  recipient: string;
  /** `final`, `commentary`, `analysis` or null. */
  channel: string | null;
  /** `text`, `code`, `thoughts`, `execution_output`, `reasoning_recap`, `multimodal_text`, ... */
  contentType: string;
  /** Plain text of the content (parts joined, code text, or thought summaries). */
  text: string;
  /** `in_progress` while streaming, `finished_successfully`, `finished_partial_completion`, ... */
  status: string;
  endTurn: boolean | null;
  model: string | null;
  /** `metadata.request_id`, the join key with MCP requests (`x-request-id` prefix). */
  requestId: string | null;
  /** `metadata.turn_exchange_id`, groups all messages of one user turn. */
  turnId: string | null;
  parentId: string | null;
  createTime: number | null;
  /** Hidden from the native transcript (system prompts, tool plumbing). */
  hidden: boolean;
}

/** Events the page driver sends to the app. */
export type PageEvent =
  | { type: 'hello'; driverVersion: number; url: string; conversationId: string | null; signedIn: boolean | null }
  | { type: 'location'; url: string; conversationId: string | null }
  | { type: 'auth'; signedIn: boolean; email: string | null }
  /** A `POST /backend-api/f/conversation` stream opened. `streamId` is local to the page. */
  | { type: 'turn-start'; streamId: string; conversationId: string | null; requestId: string | null }
  | { type: 'message'; streamId: string | null; message: ChatMessage }
  | { type: 'title'; conversationId: string; title: string }
  | {
      type: 'turn-end';
      streamId: string;
      conversationId: string | null;
      /** `complete` saw message_stream_complete or [DONE]; `aborted` the page cancelled; `error` a failure. */
      outcome: 'complete' | 'aborted' | 'error';
      error: string | null;
    }
  /** The stop/send button state changed (covers resumed or websocket-delivered turns too). */
  | { type: 'generating'; value: boolean }
  /** A native ChatGPT error banner or rate-limit notice appeared. */
  | { type: 'notice'; level: 'warn' | 'error'; text: string }
  | { type: 'log'; level: 'debug' | 'info' | 'warn' | 'error'; message: string };

export interface PageFile {
  name: string;
  mime: string;
  /** Base64 file content. */
  data: string;
}

/** Commands the app sends to the page driver. Each resolves with `PageResult`. */
export type PageCommand =
  | { type: 'status' }
  /** Type the text into the composer, attach files, press send. Resolves once the stream started. */
  | { type: 'send'; text: string; files: PageFile[] }
  | { type: 'stop' }
  | { type: 'models' }
  /** Full conversation history via the backend API, oldest first, visible branch only. */
  | { type: 'conversation'; conversationId: string }
  /** Select model/effort in the native picker of the current chat. */
  | { type: 'select-model'; model: string; effort: ReasoningEffort | null }
  | { type: 'usage' };

export type PageResult =
  | { ok: true; value?: unknown }
  | { ok: false; error: string; code?: 'not-ready' | 'signed-out' | 'busy' | 'timeout' | 'not-found' | 'failed' };

export interface PageStatus {
  url: string;
  conversationId: string | null;
  signedIn: boolean | null;
  generating: boolean;
  composerReady: boolean;
}

export interface SendValue {
  conversationId: string | null;
  streamId: string;
}

export interface ModelsValue {
  defaultModel: string | null;
  models: ModelOption[];
}

/** Builds the URL a fresh chat opens with; ChatGPT honours `?model=` on `/`. */
export function newChatUrl(model: string | null, temporary = false): string {
  const url = new URL('https://chatgpt.com/');
  if (model) url.searchParams.set('model', model);
  if (temporary) url.searchParams.set('temporary-chat', 'true');
  return url.toString();
}

export function conversationUrl(conversationId: string): string {
  return `https://chatgpt.com/c/${encodeURIComponent(conversationId)}`;
}

/** Extracts the conversation id from a chatgpt.com URL (`/c/<id>` or `/g/<gizmo>/c/<id>`). */
export function conversationIdFromUrl(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (!/(^|\.)chatgpt\.com$/.test(parsed.hostname)) return null;
    const match = /\/c\/([0-9a-f-]{8,})/i.exec(parsed.pathname);
    return match ? match[1]!.toLowerCase() : null;
  } catch {
    return null;
  }
}

export const DRIVER_VERSION = 1;
