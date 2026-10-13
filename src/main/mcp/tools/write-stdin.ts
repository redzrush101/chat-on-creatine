import { z } from 'zod';
import { effectiveCapabilities } from '@shared/config';
import { defineTool } from '../tool';
import { execOutputSchema, execOwner, execToolResult } from './exec-command';

const WRITE_STDIN_DESCRIPTION =
  'Writes characters to an existing unified exec session and returns recent output.';

export const writeStdinTool = defineTool({
  name: 'write_stdin',
  surface: 'core',
  title: 'Write to command',
  description: WRITE_STDIN_DESCRIPTION,
  input: {
    session_id: z.number().int().min(0).describe('Running session ID returned by exec_command.'),
    chars: z.string().optional().describe('Bytes to write to stdin. Defaults to empty, which polls without writing.'),
    yield_time_ms: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Wait before yielding output. Non-empty writes default to 250 ms (max 30000); empty polls wait up to 5000-300000 ms but return early when output arrives.'),
    max_output_tokens: z
      .number()
      .int()
      .min(0)
      .optional()
      .describe('Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.')
  },
  annotations: { destructiveHint: true },
  outputSchema: execOutputSchema,
  exposed: (config) => effectiveCapabilities(config).exec,
  async run(args, ctx) {
    const result = await ctx.services.processes.writeStdin(
      {
        sessionId: String(args.session_id),
        chars: args.chars ?? '',
        yieldTimeMs: args.yield_time_ms,
        maxOutputTokens: args.max_output_tokens
      },
      execOwner(ctx)
    );
    return execToolResult(result);
  }
});
