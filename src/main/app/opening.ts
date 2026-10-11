import { open } from 'node:fs/promises';
import { join } from 'node:path';
import type { Config } from '@shared/config';
import { effectiveCapabilities } from '@shared/config';
import type { Project, SessionMeta } from '@shared/types';
import { MAX_MESSAGE_CHARS, openingContext } from '../mcp/instructions';

const AGENTS_MD_BYTES = 64 * 1024;

async function readPrefix(path: string, bytes: number): Promise<{ text: string; truncated: boolean } | null> {
  try {
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(bytes + 1);
      const { bytesRead } = await handle.read(buffer, 0, bytes + 1, 0);
      return { text: buffer.subarray(0, Math.min(bytesRead, bytes)).toString('utf8'), truncated: bytesRead > bytes };
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/**
 * The context block for the first message of a brand-new chat: tool instructions, the working
 * folder and the project's root AGENTS.md (only when the model may read files anyway).
 */
export async function buildOpeningContext(
  config: Config,
  session: SessionMeta,
  project: Project | null,
  cwd: string | null,
  userTextLength: number
): Promise<string | null> {
  if (session.kind === 'helper') return null;
  const agents =
    cwd && config.instructions.includeAgentsMd && effectiveCapabilities(config).read ? await readPrefix(join(cwd, 'AGENTS.md'), AGENTS_MD_BYTES) : null;
  return openingContext({
    config,
    cwd,
    projectName: project?.name ?? null,
    agentsMd: agents?.text ?? null,
    agentsMdTruncated: agents?.truncated ?? false,
    reserveChars: Math.min(userTextLength + 2, MAX_MESSAGE_CHARS)
  });
}
