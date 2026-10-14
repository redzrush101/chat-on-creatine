import { randomBytes } from 'node:crypto';
import os from 'node:os';
import { z } from 'zod';
import { effectiveCapabilities } from '@shared/config';
import { checkCommandPolicy } from '../../exec/command-policy';
import { parseApplyPatchInvocationWithCwd, runApplyPatch } from '../../fs/apply-patch';
import { defineTool, textResult, ToolError, type ExecResult, type ToolContext, type ToolResult } from '../tool';

const WINDOWS_SHELL_NOTE =
  '\n\nWindows: PowerShell 5.1 has no && or ||; use the cmds array for a sequence, or A; if ($?) { B }. Do not compose destructive filesystem commands across shells; prefer PowerShell cmdlets such as Remove-Item and Move-Item with -LiteralPath, and verify resolved target paths first.';

const EXEC_COMMAND_DESCRIPTION =
  'Runs a command in a PTY, returning output or a session ID for ongoing interaction.' +
  (process.platform === 'win32' ? WINDOWS_SHELL_NOTE : '');

const EXEC_COMMAND_INPUT = {
  cmd: z.string().optional().describe('Shell command to execute.'),
  cmds: z
    .array(z.string())
    .min(1)
    .max(20)
    .optional()
    .describe(
      'Use cmd or cmds, not both. cmds runs sequentially in one shell session; sections show exit codes. It continues after ordinary non-zero exits; the first non-zero exit wins.'
    ),
  workdir: z.string().optional().describe('Working directory for the command. Defaults to the chat folder.'),
  shell: z
    .string()
    .optional()
    .describe("Shell binary to launch. Defaults to the user's default shell."),
  login: z.boolean().optional().describe('True runs the shell with -l/-i semantics; false disables them. Defaults to true.'),
  tty: z
    .boolean()
    .optional()
    .describe('True allocates a PTY for the command; false or omitted uses plain pipes.'),
  yield_time_ms: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms.'),
  max_output_tokens: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe('Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.')
};

const DISPLAY_OUTPUT_CHARS = 20_000;

export const execOutputSchema = z.object({
  chunk_id: z.string().optional(),
  wall_time_seconds: z.number(),
  exit_code: z.number().optional(),
  session_id: z.number().optional(),
  original_token_count: z.number().optional(),
  output: z.string()
});

/** Formats a process result in the Codex exec layout the model is used to reading. */
export function execToolResult(result: ExecResult): ToolResult {
  const chunkId = randomBytes(3).toString('hex');
  const seconds = (result.wallTimeMs / 1000).toFixed(4);
  const lines = [`Chunk ID: ${chunkId}`, `Wall time: ${seconds} seconds`];
  if (result.exitCode !== null) lines.push(`Process exited with code ${result.exitCode}`);
  if (result.sessionId !== null) lines.push(`Process running with session ID ${result.sessionId}`);
  if (result.originalTokenCount !== null) {
    lines.push(`Warning: truncated output (original token count: ${result.originalTokenCount})`);
  }
  lines.push('Output:', result.output);

  const displayOutput =
    result.output.length > DISPLAY_OUTPUT_CHARS ? `…${result.output.slice(-DISPLAY_OUTPUT_CHARS)}` : result.output;
  return textResult(lines.join('\n'), {
    structuredContent: {
      chunk_id: chunkId,
      wall_time_seconds: result.wallTimeMs / 1000,
      ...(result.exitCode === null ? {} : { exit_code: result.exitCode }),
      ...(result.sessionId === null ? {} : { session_id: Number(result.sessionId) }),
      ...(result.originalTokenCount === null ? {} : { original_token_count: result.originalTokenCount }),
      output: result.output
    },
    display: [
      {
        type: 'exec',
        command: result.command,
        cwd: result.cwd,
        exitCode: result.exitCode,
        output: displayOutput,
        running: result.sessionId !== null,
        sessionId: result.sessionId
      }
    ]
  });
}

/** The caller's session when attributed; otherwise a shared owner for unattributed calls. */
export function execOwner(ctx: ToolContext): string {
  return ctx.caller?.sessionId ?? 'unattributed';
}

export const execCommandTool = defineTool({
  name: 'exec_command',
  surface: 'core',
  title: 'Run command',
  description: EXEC_COMMAND_DESCRIPTION,
  input: EXEC_COMMAND_INPUT,
  outputSchema: execOutputSchema,
  annotations: { destructiveHint: true },
  exposed: (config) => effectiveCapabilities(config).exec,
  async run(args, ctx) {
    if ((args.cmd === undefined) === (args.cmds === undefined)) {
      throw new ToolError('INVALID_ARGUMENT', 'exec_command requires exactly one of cmd or cmds.');
    }
    const commands = args.cmd !== undefined ? [args.cmd] : args.cmds!;

    const chatFolder = ctx.caller?.cwd ?? (await ctx.services.paths.roots())[0] ?? os.homedir();
    const workdir = await ctx.services.paths.resolve(args.workdir ?? chatFolder, { cwd: chatFolder, mustExist: true });

    // YOLO mode runs every command; otherwise the user's policy decides.
    const policy = ctx.config.yolo ? { ...ctx.config.commandPolicy, enabled: false } : ctx.config.commandPolicy;
    for (const [index, command] of commands.entries()) {
      const decision = checkCommandPolicy(policy, command);
      if (!decision.allowed) {
        const where = commands.length > 1 ? ` in command ${index + 1}` : '';
        throw new ToolError('COMMAND_NOT_ALLOWED', `Command${where} is not allowed: ${decision.reason} No command was run.`);
      }
    }

    // A single apply_patch invocation is run by the patch engine instead of spawning a shell.
    if (args.cmd !== undefined) {
      const patch = parseApplyPatchInvocationWithCwd(args.cmd);
      if (patch) {
        const started = Date.now();
        const result = await runApplyPatch(patch.patch, ctx, patch.cd);
        return { ...result, structuredContent: {
          wall_time_seconds: (Date.now() - started) / 1000, exit_code: 0,
          output: result.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n')
        } };
      }
    }

    const result = await ctx.services.processes.exec(
      {
        cmd: args.cmd,
        cmds: args.cmds,
        workdir,
        shell: args.shell,
        login: args.login,
        tty: args.tty,
        yieldTimeMs: args.yield_time_ms,
        maxOutputTokens: args.max_output_tokens
      },
      execOwner(ctx)
    );
    return execToolResult(result);
  }
});
