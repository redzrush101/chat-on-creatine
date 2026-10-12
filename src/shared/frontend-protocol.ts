import { z } from 'zod';
import { RENDERER_CHANNELS, type MainEvent, type MainEvents } from './ipc';

export const frontendAddressSchema = z.object({
  port: z.number().int().min(1).max(65535),
  token: z.string().length(64),
  pid: z.number().int().positive()
});
export type FrontendAddress = z.infer<typeof frontendAddressSchema>;

export const frontendRequestSchema = z.object({
  id: z.number().int().nonnegative(),
  channel: z.enum(RENDERER_CHANNELS),
  args: z.array(z.unknown()).max(8)
});

export type FrontendMessage =
  | { type: 'reply'; id: number; result?: unknown; error?: string }
  | { [E in MainEvent]: { type: 'event'; event: E; payload: MainEvents[E] } }[MainEvent];

export const FRONTEND_MAX_BYTES = 32 * 1024 * 1024;
