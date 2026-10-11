import type { AppState, SessionMeta, WorkerState } from '@shared/types';

const byRecent = (a: SessionMeta, b: SessionMeta) => b.updatedAt - a.updatedAt;

export function sidebarSessions(app: AppState) {
  const { sessions, projects, agents } = app;
  const sessionById = new Map(sessions.map((session) => [session.id, session]));
  const chats = sessions.filter((session) => session.kind === 'chat');
  const projectIds = new Set(projects.map((project) => project.id));
  const pinned = chats.filter((chat) => chat.pinned).sort(byRecent);
  const unpinned = chats.filter((chat) => !chat.pinned);
  const chatsByProject = new Map<string, SessionMeta[]>();
  for (const chat of unpinned) {
    if (chat.projectId === null) continue;
    const bucket = chatsByProject.get(chat.projectId) ?? [];
    bucket.push(chat);
    chatsByProject.set(chat.projectId, bucket);
  }
  for (const bucket of chatsByProject.values()) bucket.sort(byRecent);
  const loose = unpinned.filter((chat) => chat.projectId === null || !projectIds.has(chat.projectId)).sort(byRecent);

  const workersOf = new Map<string, SessionMeta[]>();
  for (const session of sessions) {
    if (session.kind !== 'worker' || !session.parentId || !sessionById.has(session.parentId)) continue;
    const bucket = workersOf.get(session.parentId) ?? [];
    bucket.push(session);
    workersOf.set(session.parentId, bucket);
  }
  const workerStates = new Map<string, WorkerState>();
  for (const run of agents) {
    for (const worker of run.workers) if (!workerStates.has(worker.sessionId)) workerStates.set(worker.sessionId, worker.state);
  }
  const workerStateOf = (sessionId: string): WorkerState | null => workerStates.get(sessionId) ?? null;

  return { chats, sessionById, pinned, chatsByProject, loose, workersOf, workerStateOf };
}
