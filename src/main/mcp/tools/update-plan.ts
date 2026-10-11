import { z } from 'zod';

import type { PlanItem } from '@shared/types';
import { defineTool, textResult, ToolError } from '../tool';

const MARKS: Record<PlanItem['status'], string> = { pending: '[ ]', in_progress: '[>]', completed: '[x]' };

export const updatePlanTool = defineTool({
  name: 'update_plan',
  surface: 'core',
  title: 'Update plan',
  description:
    'Updates your task plan in the user’s app. Use for work with several meaningful steps; skip simple tasks. ' +
    'Send the complete plan with short step headlines, useful details and current statuses. Keep at most one step in_progress. ' +
    'Update after completing a step or changing approach. This only displays a plan; it does not execute steps or advance queued stages.',
  input: {
    explanation: z.string().max(2000).optional().describe('Why the plan changed, in a sentence.'),
    plan: z
      .array(
        z.object({
          step: z.string().min(1).max(500),
          status: z.enum(['pending', 'in_progress', 'completed'])
        })
      )
      .min(1)
      .max(50)
      .describe('The complete plan, in order.')
  },
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  exposed: (config) => config.sessions.recording,
  requiresCaller: true,
  async run({ explanation, plan }, ctx) {
    if (!ctx.caller) throw new ToolError('CALLER_IDENTITY_REQUIRED', 'update_plan needs the chat that made the call.');
    if (plan.filter((item) => item.status === 'in_progress').length > 1) {
      throw new ToolError('INVALID_ARGUMENT', 'At most one plan step may be in_progress.');
    }
    const items: PlanItem[] = plan.map((item) => ({ step: item.step, status: item.status }));
    ctx.services.setPlan(ctx.caller, explanation ?? null, items);
    const done = items.filter((item) => item.status === 'completed').length;
    const summary = [
      `Plan: ${done} of ${items.length} done.`,
      ...items.map((item) => `${MARKS[item.status]} ${item.step}`)
    ].join('\n');
    return textResult('Plan updated', { display: [{ type: 'text', text: summary }] });
  }
});
