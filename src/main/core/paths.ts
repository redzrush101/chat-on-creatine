import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export interface AppPaths {
  userData: string;
  config: string;
  secrets: string;
  state: string;
  sessions: string;
  attachments: string;
  skills: string;
  bin: string;
  logs: string;
}

/** Resolves (and creates) every directory the app persists to under one user-data root. */
export function resolvePaths(userData: string): AppPaths {
  const paths: AppPaths = {
    userData,
    config: join(userData, 'config.json'),
    secrets: join(userData, 'secrets.json'),
    state: join(userData, 'state'),
    sessions: join(userData, 'sessions'),
    attachments: join(userData, 'attachments'),
    skills: join(userData, 'skills'),
    bin: join(userData, 'bin'),
    logs: join(userData, 'logs')
  };
  for (const dir of [paths.state, paths.sessions, paths.attachments, paths.skills, paths.bin, paths.logs]) {
    mkdirSync(dir, { recursive: true });
  }
  return paths;
}
