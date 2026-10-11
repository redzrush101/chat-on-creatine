import { errorMessage } from '@shared/errors';
import { createRequire } from 'node:module';
import { Worker } from 'node:worker_threads';
import { MAX_IMAGE_BYTES, sniffImage } from '../../fs/files';
import type { ToolContent, ToolResult } from '../tool';
import { CODE_MODE_WORKER_SOURCE } from './worker';

export const CODE_MODE_LIMITS = Object.freeze({
  codeChars: 64_000,
  memoryBytes: 32 * 1024 * 1024,
  cpuMs: 2_000,
  wallMs: 60_000,
  calls: 32,
  concurrentCalls: 8,
  textBytes: 40_000,
  images: 4
});

interface CodeModeTool {
  name: string;
  description: string;
}

type Invoke = (name: string, args: unknown) => Promise<ToolResult>;

type WorkerMessage =
  | { type: 'call'; id: number; json: string }
  | { type: 'text' | 'image'; json: string }
  | { type: 'done'; status: string | null; detail: string };

const requireRuntime = createRequire(typeof __filename === 'string' ? __filename : import.meta.url);

/** Accepts a PNG/JPEG/GIF/WebP as a data URL or as MCP image content; anything else is refused. */
function toImage(value: unknown): ToolContent | null {
  let data: unknown;
  let mimeType: unknown;
  if (typeof value === 'string') {
    const match = /^data:([^;,]+);base64,(.*)$/s.exec(value);
    if (match) [, mimeType, data] = match;
  } else if (value && typeof value === 'object' && (value as { type?: unknown }).type === 'image') {
    ({ data, mimeType } = value as { data?: unknown; mimeType?: unknown });
  }
  if (typeof data !== 'string' || typeof mimeType !== 'string') return null;
  const bytes = Buffer.from(data, 'base64');
  if (bytes.length === 0 || bytes.length > MAX_IMAGE_BYTES || bytes.toString('base64') !== data) return null;
  const sniffed = sniffImage(bytes);
  return sniffed ? { type: 'image', data, mimeType: sniffed } : null;
}

/** Cuts a UTF-8 string to at most `bytes` bytes without splitting a character. */
function utf8Prefix(text: string, bytes: number): string {
  const buffer = Buffer.from(text, 'utf8');
  if (buffer.length <= bytes) return text;
  let end = Math.max(0, bytes);
  while (end > 0 && (buffer[end]! & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString('utf8');
}

/**
 * Runs model JavaScript once in a fresh QuickJS worker. Only text() and image() output is
 * returned; nested tool results stay in the script. Stopping the script does not undo calls it
 * already dispatched, and the result says so.
 */
export function runCodeMode(code: string, tools: CodeModeTool[], invoke: Invoke, signal: AbortSignal): Promise<ToolResult> {
  return new Promise<ToolResult>((resolve) => {
    const names = new Set(tools.map((tool) => tool.name));
    const content: ToolContent[] = [];
    let worker: Worker | null = null;
    let settled = false;
    let calls = 0;
    let inFlight = 0;
    let textBytes = 0;
    let images = 0;

    const finish = (status: string | null, detail = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      void worker?.terminate();
      const effects = calls
        ? `${calls} tool call(s) were dispatched; their effects are not rolled back, so inspect current state before retrying.`
        : 'No tool calls were dispatched.';
      const notes: string[] = [];
      if (status) notes.push(`${status}: ${detail} ${effects} Values that were not emitted were discarded.`);
      if (inFlight > 0) notes.push(`UNAWAITED_CALLS: ${inFlight} tool call(s) were still running when the script ended; they were not cancelled.`);
      const text = notes.map((note) => ({ type: 'text' as const, text: note }));
      resolve(notes.length ? { content: [...text, ...content], isError: true } : { content });
    };
    const onAbort = () => finish('ABORTED', 'the request was cancelled.');
    const timer = setTimeout(() => finish('TIME_LIMIT', `the script exceeded ${CODE_MODE_LIMITS.wallMs / 1000} s.`), CODE_MODE_LIMITS.wallMs);
    signal.addEventListener('abort', onAbort, { once: true });

    const post = (message: { type: 'result'; id: number; json: string }) => {
      if (!settled) worker?.postMessage(message);
    };

    const onCall = (id: number, json: string) => {
      if (calls >= CODE_MODE_LIMITS.calls) return finish('CALL_LIMIT', `more than ${CODE_MODE_LIMITS.calls} tool calls.`);
      if (inFlight >= CODE_MODE_LIMITS.concurrentCalls) {
        return finish('CONCURRENCY_LIMIT', `more than ${CODE_MODE_LIMITS.concurrentCalls} tool calls running at once; await Promise.all in smaller batches.`);
      }
      let request: { name?: unknown; args?: unknown };
      try {
        request = JSON.parse(json) as { name?: unknown; args?: unknown };
      } catch {
        return finish('BRIDGE_ERROR', 'a tool call was malformed.');
      }
      const name = request.name;
      if (typeof name !== 'string' || !names.has(name)) return finish('BRIDGE_ERROR', 'a tool call named an unknown tool.');
      calls++;
      inFlight++;
      Promise.resolve()
        .then(() => invoke(name, request.args))
        .catch((error: unknown) => ({
          content: [{ type: 'text' as const, text: `FAILED: ${errorMessage(error)}` }],
          isError: true
        }))
        .then((result) => post({ type: 'result', id, json: JSON.stringify(result) }))
        .finally(() => {
          inFlight--;
        });
    };

    const onEmit = (kind: 'text' | 'image', json: string) => {
      if (kind === 'text') {
        const value: unknown = JSON.parse(json);
        if (typeof value !== 'string') return finish('BRIDGE_ERROR', 'text() received a non-string value.');
        const size = Buffer.byteLength(value, 'utf8');
        if (textBytes + size > CODE_MODE_LIMITS.textBytes) {
          const kept = utf8Prefix(value, CODE_MODE_LIMITS.textBytes - textBytes);
          if (kept) content.push({ type: 'text', text: kept });
          return finish('OUTPUT_LIMIT', `text output is limited to ${CODE_MODE_LIMITS.textBytes} UTF-8 bytes; the rest was cut. Filter results or read smaller ranges.`);
        }
        textBytes += size;
        content.push({ type: 'text', text: value });
        return;
      }
      const image = toImage(JSON.parse(json));
      if (!image) return finish('IMAGE_INVALID', 'image() takes a PNG, JPEG, GIF or WebP image: a tool result image or a data URL.');
      if (++images > CODE_MODE_LIMITS.images) return finish('OUTPUT_LIMIT', `more than ${CODE_MODE_LIMITS.images} images.`);
      content.push(image);
    };

    try {
      worker = new Worker(CODE_MODE_WORKER_SOURCE, {
        eval: true,
        workerData: {
          code,
          tools: tools.map(({ name, description }) => ({ name, description })),
          memoryBytes: CODE_MODE_LIMITS.memoryBytes,
          cpuMs: CODE_MODE_LIMITS.cpuMs,
          coreModule: requireRuntime.resolve('quickjs-emscripten-core'),
          wasmModule: requireRuntime.resolve('@jitl/quickjs-wasmfile-release-sync')
        },
        resourceLimits: { maxOldGenerationSizeMb: 128, stackSizeMb: 4 }
      });
    } catch {
      finish('RUNTIME_ERROR', 'the code mode runtime could not start.');
      return;
    }
    worker.on('error', () => finish('RUNTIME_ERROR', 'the code mode runtime failed.'));
    worker.on('exit', () => finish('RUNTIME_ERROR', 'the code mode runtime stopped unexpectedly.'));
    worker.on('message', (message: WorkerMessage) => {
      if (settled) return;
      try {
        if (message.type === 'done') finish(message.status, message.detail);
        else if (message.type === 'call') onCall(message.id, message.json);
        else onEmit(message.type, message.json);
      } catch {
        finish('BRIDGE_ERROR', 'the script sent a value the bridge could not read.');
      }
    });
  });
}
