import { errorMessage } from '@shared/errors';
import type { ModelCatalog } from '@shared/types';
import type { ModelsValue } from '@shared/page-protocol';
import { createLogger } from '../core/log';
import type { ChatHost } from '../chatgpt/host';

const log = createLogger('models');

/** The account's model list, read from ChatGPT through any signed-in tab. */
export class ModelService {
  private catalog: ModelCatalog = { state: 'unknown', models: [], defaultModel: null, fetchedAt: null, error: null };
  private inflight: Promise<void> | null = null;

  constructor(private readonly host: ChatHost, private readonly onChange: () => void) {}

  get(): ModelCatalog {
    return this.catalog;
  }

  refresh(): Promise<void> {
    this.inflight ??= this.load().finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async load(): Promise<void> {
    this.set({ ...this.catalog, state: 'loading', error: null });
    const existing = this.host.tabs().find((tab) => tab.driverReady && tab.signedIn !== false);
    let tabId = existing?.tabId ?? null;
    let opened = false;
    try {
      if (!tabId) {
        tabId = await this.host.openTab('https://chatgpt.com/');
        opened = true;
      }
      const result = await this.host.command(tabId, { type: 'models' }, 45_000);
      if (!result.ok) throw new Error(result.error);
      const value = result.value as ModelsValue;
      this.set({ state: 'ready', models: value.models, defaultModel: value.defaultModel, fetchedAt: Date.now(), error: null });
    } catch (error) {
      const message = errorMessage(error);
      log.warn(`model list unavailable: ${message}`);
      this.set({ ...this.catalog, state: 'error', error: message });
    } finally {
      if (opened && tabId) await this.host.closeTab(tabId);
    }
  }

  private set(next: ModelCatalog): void {
    this.catalog = next;
    this.onChange();
  }
}
