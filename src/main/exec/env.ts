import { spawn } from 'node:child_process';

/** Keys the app itself holds; a child command must not inherit them. Matched case-insensitively. */
const SECRET_KEYS = new Set([
  'CONTROL_PLANE_API_KEY',
  'OPENAI_API_KEY',
  'OPENAI_ADMIN_KEY',
  'CLOUDFLARED_TOKEN',
  'CLOUDFLARED_TUNNEL_TOKEN'
]);

/** Makes output deterministic and pager-free for models reading it. */
function terminalEnv(platform: NodeJS.Platform): Record<string, string> {
  const locale = platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8';
  return {
    NO_COLOR: '1',
    TERM: 'dumb',
    LANG: locale,
    LC_CTYPE: locale,
    LC_ALL: locale,
    COLORTERM: '',
    PAGER: 'cat',
    GIT_PAGER: 'cat',
    GH_PAGER: 'cat'
  };
}

/** The environment a child process inherits: the user's env minus Electron internals and app secrets. */
export function childEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    const upper = key.toUpperCase();
    if (upper.startsWith('ELECTRON_') || SECRET_KEYS.has(upper)) continue;
    env[key] = value;
  }
  return { ...env, ...terminalEnv(process.platform), ...extra };
}

/** Ends a process and its descendants: the POSIX process group, or the Windows process tree. */
export function terminateProcessTree(pid: number, force = true): Promise<void> {
  if (process.platform === 'win32') {
    return new Promise((resolve) => {
      const args = ['/pid', String(pid), '/T'];
      if (force) args.push('/F');
      const killer = spawn('taskkill', args, { windowsHide: true, stdio: 'ignore' });
      const fallback = (): void => {
        try {
          process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
        } catch {
          /* already gone */
        }
        resolve();
      };
      killer.once('error', fallback);
      killer.once('close', (code) => (code === 0 || code === 128 ? resolve() : fallback()));
    });
  }

  const signal = force ? 'SIGKILL' : 'SIGTERM';
  try {
    process.kill(-pid, signal);
  } catch {
    try {
      process.kill(pid, signal);
    } catch {
      /* already gone */
    }
  }
  return Promise.resolve();
}
