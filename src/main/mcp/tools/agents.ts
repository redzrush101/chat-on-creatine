import { z } from 'zod';

import { REASONING_EFFORTS } from '@shared/config';
import { defineTool, ToolError, textResult } from '../tool';

const FIELDS_BY_ACTION = {
  spawn: ['context', 'workers'],
  message: ['messages', 'to', 'text'],
  status: [],
  finish: ['result']
} as const;

const ALL_FIELDS = ['context', 'workers', 'messages', 'to', 'text', 'result'] as const;

const ACTION_OF_FIELD: Record<(typeof ALL_FIELDS)[number], string> = {
  context: 'spawn',
  workers: 'spawn',
  messages: 'message',
  to: 'message',
  text: 'message',
  result: 'finish'
};

export const agentsTool = defineTool({
  name: 'agents',
  surface: 'core',
  title: 'Multi-agent run',
  description:
    'Run ChatGPT worker chats. Omit model and reasoning_effort unless the user explicitly requests an override; saved app defaults apply. ' +
    'Do not ask the user to choose them. Reuse a suitable sleeping worker with message before spawn. ' +
    'message: prime↔worker. Reports ride tool results, never restart primes. Use status once to collect pending reports before finalizing; ' +
    'otherwise state that review is pending. Never poll repeatedly. ' +
    'status: this run’s workers, their state and free slots. finish: record the report, then normally sleep.',
  input: {
    action: z.enum(['spawn', 'message', 'status', 'finish']).describe('What to do.'),
    context: z
      .string()
      .max(4000)
      .optional()
      .describe('spawn: shared instructions prepended to every task, e.g. repo, conventions, edit limits and validation.'),
    workers: z
      .array(
        z
          .object({
            label: z.string().max(60).optional().describe('Name its job in 1-3 words, e.g. "Tests"; shown to the user.'),
            task: z
              .string()
              .min(1)
              .max(4000)
              .describe("This worker's job: objective, relevant files, constraints and expected handoff."),
            model: z
              .string()
              .max(80)
              .optional()
              .describe(
                'Omit unless explicitly requested by the user; app settings supply defaults. Use an exact ChatGPT model slug.'
              ),
            reasoning_effort: z
              .enum(REASONING_EFFORTS)
              .optional()
              .describe(
                'Omit unless explicitly requested by the user; app settings supply defaults. Do not ask just to spawn a worker. This selects reasoning only, never a model.'
              )
          })
          .strict()
      )
      .min(1)
      .max(8)
      .optional()
      .describe('spawn: fresh workers to create only after checking status for a suitable sleeping worker; revive one explicitly with message.'),
    messages: z
      .array(
        z
          .object({
            to: z.string().min(1).max(60).describe('Recipient: a worker label or session id, or "prime" from a worker.'),
            text: z.string().min(1).max(4000).describe('What to say.')
          })
          .strict()
      )
      .min(1)
      .max(16)
      .optional()
      .describe('message: atomic batch; prefer this to one call per recipient.'),
    to: z
      .string()
      .min(1)
      .max(60)
      .optional()
      .describe('message: one recipient; messaging a sleeping worker wakes it.'),
    text: z.string().min(1).max(4000).optional().describe('message: what to say.'),
    result: z
      .string()
      .min(1)
      .max(4000)
      .optional()
      .describe('finish: factual handoff: what you changed, what you verified and what is left.')
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  exposed: (config) => config.agents.enabled,
  requiresCaller: true,
  async run(args, ctx) {
    const agents = ctx.services.agents;
    if (!agents || !ctx.config.agents.enabled) {
      throw new ToolError('TOOL_DISABLED', 'Multi-agent mode is turned off. Ask the user to enable it in the app settings.');
    }
    if (!ctx.caller) throw new ToolError('CALLER_IDENTITY_REQUIRED', 'agents needs the chat that made the call.');
    const caller = ctx.caller;
    const { action } = args;
    const allowed: readonly string[] = FIELDS_BY_ACTION[action];
    for (const field of ALL_FIELDS) {
      if (args[field] !== undefined && !allowed.includes(field)) {
        throw new ToolError('INVALID_ARGUMENT', `${field} is only valid with action=${ACTION_OF_FIELD[field]}`);
      }
    }

    switch (action) {
      case 'spawn': {
        if (!args.workers) throw new ToolError('INVALID_ARGUMENT', 'action=spawn requires workers.');
        return textResult(await agents.spawn(caller, { context: args.context ?? '', workers: args.workers }));
      }
      case 'message': {
        if (args.messages && (args.to !== undefined || args.text !== undefined)) {
          throw new ToolError('INVALID_ARGUMENT', 'action=message takes either to+text or messages, not both.');
        }
        const messages = args.messages ?? (args.to !== undefined && args.text !== undefined ? [{ to: args.to, text: args.text }] : null);
        if (!messages) throw new ToolError('INVALID_ARGUMENT', 'action=message requires to and text, or a messages array.');
        return textResult(await agents.message(caller, { messages }));
      }
      case 'status':
        return textResult(await agents.status(caller));
      case 'finish': {
        if (!args.result) throw new ToolError('INVALID_ARGUMENT', 'action=finish requires result: the report the prime reads in your place.');
        return textResult(await agents.finish(caller, { result: args.result }));
      }
    }
  }
});
