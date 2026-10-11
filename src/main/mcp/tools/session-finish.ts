import { defineTool, textResult, ToolError } from '../tool';

export const sessionFinishTool = defineTool({
  name: 'session_finish',
  surface: 'core',
  title: 'Finish turn',
  description:
    'Only when explicitly requested by a user prompt, with any model. Call near actual completion, after implementing the requested work. ' +
    'Receives queued instructions; complete and verify them before calling again. Do not use for progress updates or queue collection. ' +
    'While HELD with no work remaining, call to wait. Each call waits at most 25 seconds.',
  input: {},
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  exposed: (config) => config.automation.finishTool,
  requiresCaller: true,
  async run(_args, ctx) {
    const finish = ctx.services.finish;
    if (!finish || !ctx.config.automation.finishTool) {
      throw new ToolError('TOOL_DISABLED', 'Session finish is turned off. Ask the user to enable it in the app settings.');
    }
    if (!ctx.caller) throw new ToolError('CALLER_IDENTITY_REQUIRED', 'session_finish needs the chat that made the call.');
    return textResult(await finish(ctx.caller, ctx.signal));
  }
});
