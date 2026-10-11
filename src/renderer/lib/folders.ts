import type { AppState, SessionMeta } from '@shared/types';

/** The folder a chat works in: its own cwd, then its project, then the first approved folder. */
export function chatFolder(app: AppState, session: SessionMeta | null): string | null {
  const project = session?.projectId ? app.projects.find((item) => item.id === session.projectId) : undefined;
  return session?.cwd ?? project?.path ?? app.config.roots[0]?.path ?? null;
}
