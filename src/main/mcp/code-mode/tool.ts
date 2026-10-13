import { z } from 'zod';
import type { SurfaceId } from '@shared/types';
import { defineTool, ToolError, type ToolContext, type ToolResult, type ToolSpec } from '../tool';
import { CODE_MODE_LIMITS } from './runtime';
import { CodeModeSession } from './session';

const CODE_MODE_DESCRIPTION =
  "Run JavaScript to compose this connector's tools. Argument: {code: \"raw JavaScript\"}. " +
  'Inside code, use await tools.<tool_name>(args), await Promise.all([...]), text(value), image(dataUrlOrMcpImageContent), and exit() to end successfully. ' +
  'tools return their normal MCP result objects, including content and isError. Only explicit text/image output reaches the model; ' +
  'intermediate results stay in the runtime and local tool recording. ALL_TOOLS lists {name,description}; use the individual tools\' schemas for arguments. ' +
  'Fresh isolated JavaScript runtime, top-level await, no Node, filesystem, network, console or imports. ' +
  'Requires the chat identity or Allow unattributed calls enabled in app settings. ' +
  'Limits: 64k source characters, 32 MiB JS memory, 2s active JS time, 60s total, 32 calls, 8 concurrent calls, 40k text bytes, 4 images. ' +
  'Optional first-line pragma: // @exec: {"yield_time_ms": 10000, "max_output_tokens": 1000}. ' +
  'yield_time_ms returns early while the script keeps running (default 30000 ms); max_output_tokens bounds output (default 10000). ' +
  'After "Script running with cell ID ...", call wait with that cell_id for new output or completion, directly or using await tools.wait({...}) in a later exec. ' +
  'yield_control() yields accumulated output immediately. store(key, value) saves JSON values for later exec calls in this chat; load(key) returns a saved value or undefined. ' +
  'setTimeout(callback, delayMs) and clearTimeout(id) schedule callbacks; await an explicit promise to keep a script alive. ' +
  'Await every call. Termination stops JavaScript and new calls, not actions already dispatched. session_finish must be called directly. No recursive exec.';

/** Code mode never replaces a plugin's own exec or wait tools. */
export function canAddCodeMode(tools: readonly { name: string }[]): boolean {
  return tools.length > 0 && !tools.some((tool) => tool.name === 'exec' || tool.name === 'wait');
}

/** Refused inside exec: session_finish holds the turn open, which a script would hide. */
function directOnlyRefusal(name: string): ToolResult | null {
  if (name !== 'session_finish') return null;
  return { content: [{ type: 'text', text: 'INVALID_ARGUMENT: session_finish must be called directly, not from exec.' }], isError: true };
}

/** `name(required, optional?)` per tool, so a script can call tools without first listing them. */
const signatures = new WeakMap<ToolSpec, string>();
function toolSignatures(tools: readonly ToolSpec[]): string {
  return tools
    .map((tool) => {
      const cached = signatures.get(tool);
      if (cached) return cached;
      const schema = (tool.jsonSchema ?? z.toJSONSchema(z.object(tool.input))) as { properties?: object; required?: string[] };
      const required = new Set(schema.required ?? []);
      const args = Object.keys(schema.properties ?? {}).map((name) => (required.has(name) ? name : `${name}?`));
      const signature = `${tool.name}({${args.join(', ')}})`;
      signatures.set(tool, signature);
      return signature;
    })
    .join(', ');
}

function owner(ctx: ToolContext): string {
  return `${ctx.surface}:${ctx.caller?.sessionId ?? 'unattributed'}`;
}

export function codeModeTool(surface: SurfaceId, tools: readonly ToolSpec[], session: CodeModeSession): ToolSpec {
  return defineTool({
    name: 'exec',
    surface,
    title: 'Run JavaScript',
    // Tools first: ChatGPT may shorten a long description, and the list saves a discovery call.
    description: `Controls: exec({code}) and wait({cell_id, yield_time_ms?, max_tokens?, terminate?}). After exec yields, call wait directly or with await tools.wait({...}) in a later exec. Tools here: ${toolSignatures(tools)}. ${CODE_MODE_DESCRIPTION}`,
    input: {
      code: z.string().min(1).max(CODE_MODE_LIMITS.codeChars).describe('Raw JavaScript source with top-level await. Emit results with text(...) or image(...).')
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    exposed: () => true,
    async run({ code }, ctx) {
      const host = ctx.nested;
      if (!host) throw new ToolError('FAILED', 'code mode is not available on this call.');
      const tools = host.list().filter((tool) => tool.name !== 'exec');
      return session.exec(
        code,
        tools,
        async (name, args, signal) => directOnlyRefusal(name) ?? host.call(name, args, signal),
        owner(ctx), ctx.signal
      );
    }
  });
}

export function codeModeWaitTool(surface: SurfaceId, session: CodeModeSession): ToolSpec {
  return defineTool({
    name: 'wait', surface, title: 'Wait for JavaScript',
    description: 'Waits on a yielded exec cell and returns new output or completion. Use only after exec returns "Script running with cell ID ...". A completed cell returns its final result once, then closes.',
    input: {
      cell_id: z.string().describe('Identifier of the running exec cell.'),
      yield_time_ms: z.number().int().nonnegative().optional().describe('Wait before yielding more output. Defaults to 10000 ms.'),
      max_tokens: z.number().int().nonnegative().optional().describe('Output token budget for this wait call. Defaults to 10000 tokens.'),
      terminate: z.boolean().optional().describe('True stops the running exec cell; false or omitted waits for output.')
    },
    annotations: { destructiveHint: true }, exposed: () => true,
    async run(args, ctx) {
      return session.wait(args.cell_id, owner(ctx), ctx.signal, args.yield_time_ms ?? 10_000, args.max_tokens ?? 10_000, args.terminate ?? false);
    }
  });
}
