import { z } from 'zod';
import { effectiveCapabilities } from '@shared/config';
import { defineTool } from '../tool';
import { execOwner, execToolResult } from './exec-command';

export const WRITE_STDIN_DESCRIPTION =
  'Polls or writes to a session returned by exec_command. Empty chars only reads new output and returns as soon as some arrives. Non-empty chars are written to the process input (use \\u0003 chars to interrupt). A process that has exited reports its exit code and output once, then the session is released.';

export const writeStdinTool = defineTool({
  name: 'write_stdin',
  surface: 'core',
  title: 'Write to command',
  description: WRITE_STDIN_DESCRIPTION,
  input: {
    session_id: z.number().int().min(0).describe('Running session ID returned by exec_command.'),
    chars: z.string().optional().describe('Text to write to the process input. Defaults to empty, which only polls.'),
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
      .describe('Maximum output tokens returned, middle-truncated beyond that. Defaults to 10000.')
  },
  annotations: { destructiveHint: true },
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
