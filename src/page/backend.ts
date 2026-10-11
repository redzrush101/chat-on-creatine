import { DriverError } from './errors';

const SESSION_TTL_MS = 5 * 60_000;

interface Session {
  signedIn: boolean;
  accessToken: string | null;
  email: string | null;
  at: number;
}

export function createBackend() {
  let session: Session | null = null;

  async function getSession(force = false): Promise<Session | null> {
    if (!force && session && Date.now() - session.at < SESSION_TTL_MS) return session;
    try {
      const response = await fetch('/api/auth/session', { credentials: 'same-origin', cache: 'no-store' });
      if (!response.ok) return session;
      const body = (await response.json()) as { accessToken?: unknown; user?: { email?: unknown } };
      const accessToken = typeof body.accessToken === 'string' && body.accessToken ? body.accessToken : null;
      session = {
        signedIn: accessToken !== null,
        accessToken,
        email: typeof body.user?.email === 'string' ? body.user.email : null,
        at: Date.now()
      };
      return session;
    } catch {
      return session;
    }
  }

  async function request(path: string): Promise<unknown> {
    const current = await getSession();
    const headers: Record<string, string> = {};
    if (current?.accessToken) headers.Authorization = `Bearer ${current.accessToken}`;
    const response = await fetch(path, { headers, credentials: 'same-origin', cache: 'no-store' });
    if (response.status === 401 || response.status === 403) {
      throw new DriverError(`ChatGPT refused ${path.split('?')[0]} (HTTP ${response.status})`, 'signed-out');
    }
    if (!response.ok) throw new DriverError(`${path.split('?')[0]} failed (HTTP ${response.status})`, 'failed');
    return response.json();
  }

  return { getSession, request };
}
