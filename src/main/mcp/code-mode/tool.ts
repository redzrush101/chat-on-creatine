import { z } from 'zod';
import type { SurfaceId } from '@shared/types';
import { defineTool, ToolError, type ToolResult, type ToolSpec } from '../tool';
import { CODE_MODE_LIMITS, runCodeMode } from './runtime';

const CODE_MODE_DESCRIPTION =
  "Run JavaScript to compose this connector's tools. Argument: {code: \"raw JavaScript\"}. " +
  'Inside code, use await tools.<tool_name>(args), await Promise.all([...]), text(value), and image(dataUrlOrMcpImageContent). ' +
  'tools return their normal MCP result objects, including content and isError. Only explicit text/image output reaches the model; ' +
  'intermediate results stay in the runtime and local tool recording. ALL_TOOLS lists {name,description}; use the individual tools\' schemas for arguments. ' +
  'Fresh isolated JavaScript runtime, top-level await, no Node, filesystem, network, console or imports. ' +
  'Requires the chat identity or Allow unattributed calls enabled in app settings. ' +
  'Limits: 64k source characters, 32 MiB JS memory, 2s active JS time, 60s total, 32 calls, 8 concurrent calls, 40k text bytes, 4 images. ' +
  'Await every call. Termination stops JavaScript and new calls, not actions already dispatched. Individual tools remain available. ' +
  'session_finish must be a direct call. No recursive exec and no persistent globals.';

/** Code mode is added only to a surface with tools, and never replaces a tool that is already named exec. */
export function canAddCodeMode(tools: readonly { name: string }[]): boolean {
  return tools.length > 0 && !tools.some((tool) => tool.name === 'exec');
}

/** Names a script calls on `tools` (dotted or quoted bracket access) that this surface lacks. */
function unknownToolReferences(code: string, available: readonly string[]): string[] {
  const names = new Set<string>();
  // Only calls count: `typeof tools.x` or `if (tools.x)` is a script checking, not failing.
  const pattern = /\btools\s*(?:\??\.\s*([A-Za-z_$][\w$]*)|\[\s*(['"`])([^'"`\n]{1,64})\2\s*\])\s*(?:\?\.\s*)?\(/g;
  for (const match of code.matchAll(pattern)) names.add(match[1] ?? match[3]!);
  return [...names].filter((name) => !available.includes(name)).slice(0, 8);
}

function unknownToolNote(unknown: readonly string[]): string {
  return (
    `UNKNOWN_TOOL_NAMES: this script used tools.${unknown.join(', tools.')}, which this connector does not offer; ` +
    'calling it fails with "not a function". ALL_TOOLS lists this connector\'s tools; other connectors have their own tools.'
  );
}

/** Refused inside exec: session_finish holds the turn open, which a script would hide. */
function directOnlyRefusal(name: string): ToolResult | null {
  if (name !== 'session_finish') return null;
  return { content: [{ type: 'text', text: 'INVALID_ARGUMENT: session_finish must be called directly, not from exec.' }], isError: true };
}

/** `name(required, optional?)` per tool, so a script can call tools without first listing them. */
function toolSignatures(tools: readonly ToolSpec[]): string {
  return tools
    .map((tool) => {
      const schema = (tool.jsonSchema ?? z.toJSONSchema(z.object(tool.input))) as { properties?: object; required?: string[] };
      const required = new Set(schema.required ?? []);
      const args = Object.keys(schema.properties ?? {}).map((name) => (required.has(name) ? name : `${name}?`));
      return `${tool.name}({${args.join(', ')}})`;
    })
    .join(', ');
}

export function codeModeTool(surface: SurfaceId, tools: readonly ToolSpec[]): ToolSpec {
  return defineTool({
    name: 'exec',
    surface,
    title: 'Run JavaScript',
    // Tools first: ChatGPT may shorten a long description, and the list saves a discovery call.
    description: `Tools here: ${toolSignatures(tools)}. ${CODE_MODE_DESCRIPTION}`,
    input: {
      code: z.string().min(1).max(CODE_MODE_LIMITS.codeChars).describe('Raw JavaScript source with top-level await. Emit results with text(...) or image(...).')
    },
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    exposed: () => true,
    async run({ code }, ctx) {
      const host = ctx.nested;
      if (!host) throw new ToolError('FAILED', 'code mode is not available on this call.');
      const tools = host.list().filter((tool) => tool.name !== 'exec');
      const result = await runCodeMode(
        code,
        tools,
        async (name, args) => directOnlyRefusal(name) ?? host.call(name, args),
        ctx.signal
      );
      const unknown = unknownToolReferences(code, tools.map((tool) => tool.name));
      if (!unknown.length) return result;
      return { ...result, content: [...result.content, { type: 'text', text: unknownToolNote(unknown) }] };
    }
  });
}
