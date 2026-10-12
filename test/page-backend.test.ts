import { afterEach, expect, it, vi } from 'vitest';
import { createBackend } from '../src/page/backend';

afterEach(() => vi.unstubAllGlobals());

it('shares authentication with a concurrent model request and reuses the cached session', async () => {
  let resolveSession!: (response: Response) => void;
  const fetch = vi.fn<typeof globalThis.fetch>().mockImplementationOnce(() => new Promise((resolve) => { resolveSession = resolve; }))
    .mockResolvedValueOnce(Response.json({ models: [] }));
  vi.stubGlobal('fetch', fetch);
  const backend = createBackend();
  const auth = backend.getSession(true);
  const models = backend.request('/backend-api/models');
  expect(fetch).toHaveBeenCalledOnce();
  resolveSession(Response.json({ accessToken: 'test-access' }));
  await Promise.all([auth, models]);
  await backend.getSession();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fetch.mock.calls[1]?.[1]).toMatchObject({ headers: { Authorization: 'Bearer test-access' } });
});

it('clears a completed request so a later authentication check can observe sign-out', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValueOnce(Response.json({ accessToken: 'test-access' }))
    .mockResolvedValueOnce(Response.json({}));
  vi.stubGlobal('fetch', fetch);
  const backend = createBackend();
  expect(await backend.getSession()).toMatchObject({ signedIn: true });
  expect(await backend.getSession(true)).toMatchObject({ signedIn: false, accessToken: null });
});
