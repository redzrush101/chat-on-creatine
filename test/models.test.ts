import { describe, expect, it, vi } from 'vitest';
import type { PageResult } from '@shared/page-protocol';
import { ModelService } from '../src/main/app/models';
import type { ChatHost } from '../src/main/chatgpt/host';

const catalog = { defaultModel: 'thinking', models: [{ id: 'thinking', label: 'Thinking', efforts: [] }] };

function setup() {
  const command = vi.fn<ChatHost['command']>().mockResolvedValue({ ok: true, value: catalog });
  const host: ChatHost = {
    start: async () => {}, stop: async () => {},
    status: () => ({ ready: true, signedIn: true, windowVisible: false, detail: '' }),
    tabs: () => [{ tabId: 'sign-in', url: 'https://chatgpt.com/', conversationId: null,
      driverReady: false, signedIn: null, generating: false, createdAt: 0 }],
    openTab: vi.fn(), closeTab: vi.fn(), navigate: async () => {},
    command, reveal: () => {}, hide: () => {}, setListener: () => {}
  };
  return { service: new ModelService(host, vi.fn()), host, command };
}

describe('model loading after authentication', () => {
  it('loads on first sign-in, reuses the loading browser tab and shares concurrent requests', async () => {
    const { service, host, command } = setup();
    service.onAuth(false);
    expect(command).not.toHaveBeenCalled();
    service.onAuth(true);
    await service.refresh();
    expect(service.get()).toMatchObject({ state: 'ready', ...catalog });
    expect(command).toHaveBeenCalledExactlyOnceWith('sign-in', { type: 'models' }, 45_000);
    expect(host.openTab).not.toHaveBeenCalled();
    expect(host.closeTab).not.toHaveBeenCalled();
    service.onAuth(true);
    expect(command).toHaveBeenCalledOnce();
  });

  it('shares its catalog with sends and keeps a failed fetch visible without a hidden retry', async () => {
    const { service, command } = setup();
    expect(await service.forSelection()).toEqual(catalog);
    expect(await service.forSelection()).toEqual(catalog);
    expect(command).toHaveBeenCalledOnce();
    command.mockResolvedValueOnce({ ok: false, error: 'Models unavailable.' });
    await service.refresh();
    await expect(service.forSelection()).rejects.toThrow('Models unavailable.');
    expect(command).toHaveBeenCalledTimes(2);
  });

  it('recovers from a failed fetch when the browser authenticates again', async () => {
    const { service, command } = setup();
    command.mockResolvedValueOnce({ ok: false, error: 'Sign in to ChatGPT.' });
    await service.refresh();
    expect(service.get().state).toBe('error');
    service.onAuth(true);
    await service.refresh();
    expect(service.get()).toMatchObject({ state: 'ready', ...catalog });
  });

  it('discards the previous account request when signing out during a fetch', async () => {
    const { service, command } = setup();
    let resolveOld!: (result: PageResult) => void;
    command.mockReturnValueOnce(new Promise((resolve) => { resolveOld = resolve; }));
    const first = service.refresh();
    service.onAuth(false);
    service.onAuth(true);
    resolveOld({ ok: true, value: { models: [], defaultModel: null } });
    await Promise.all([first, service.refresh()]);
    expect(service.get()).toMatchObject({ state: 'ready', ...catalog });
  });
});
