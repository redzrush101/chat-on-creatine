import type { AppState, SessionMeta } from './types';

/** The folder a chat works in: its own cwd, then its project, then the first approved folder. */
export function chatFolder(app: Pick<AppState, 'projects' | 'config'>, session: Pick<SessionMeta, 'cwd' | 'projectId'> | null): string | null {
  const project = session?.projectId ? app.projects.find((item) => item.id === session.projectId) : undefined;
  return session?.cwd ?? project?.path ?? app.config.roots[0]?.path ?? null;
}
