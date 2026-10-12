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

  async forSelection(): Promise<ModelsValue> {
    if (this.catalog.state === 'unknown' || this.catalog.state === 'loading') await this.refresh();
    if (this.catalog.state !== 'ready') throw new Error(this.catalog.error ?? 'Sign in to ChatGPT to load its models.');
    return { models: this.catalog.models, defaultModel: this.catalog.defaultModel };
  }

  onAuth(signedIn: boolean): void {
    if (!signedIn) {
      this.inflight = null;
      this.set({ state: 'unknown', models: [], defaultModel: null, fetchedAt: null, error: null });
    } else if (this.catalog.state === 'unknown' || this.catalog.state === 'error') {
      void this.refresh();
    }
  }

  refresh(): Promise<void> {
    if (!this.inflight) {
      const inflight = this.load().finally(() => {
        if (this.inflight === inflight) this.inflight = null;
      });
      this.inflight = inflight;
    }
    return this.inflight;
  }

  private async load(): Promise<void> {
    const loading: ModelCatalog = { ...this.catalog, state: 'loading', error: null };
    this.set(loading);
    const existing = this.host.tabs().find((tab) => tab.signedIn !== false);
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
      if (this.catalog === loading) {
        this.set({ state: 'ready', models: value.models, defaultModel: value.defaultModel, fetchedAt: Date.now(), error: null });
      }
    } catch (error) {
      if (this.catalog === loading) {
        const message = errorMessage(error);
        log.warn(`model list unavailable: ${message}`);
        this.set({ ...this.catalog, state: 'error', error: message });
      }
    } finally {
      if (opened && tabId) await this.host.closeTab(tabId);
    }
  }

  private set(next: ModelCatalog): void {
    this.catalog = next;
    this.onChange();
  }
}
