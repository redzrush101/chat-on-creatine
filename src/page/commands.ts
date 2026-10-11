import type { ReasoningEffort } from '@shared/config';
import { errorMessage } from '@shared/errors';
import { conversationToMessages } from '@shared/chatgpt-stream';
import { conversationIdFromUrl, type ModelsValue, type PageCommand, type PageFile, type PageResult, type PageStatus } from '@shared/page-protocol';
import * as dom from './dom';
import type { createBackend } from './backend';
import { DriverError, fail } from './errors';
import { parseModels } from './models';
import { attachFiles } from './attachments';
import type { StreamRelay } from './streams';

const MODELS_PATH = '/backend-api/models?iim=false&include_icons=false&is_gizmo=false';

const DONE: PageResult = { ok: true };

function toFile(file: PageFile): File {
  const bytes = Uint8Array.from(atob(file.data), (char) => char.charCodeAt(0));
  return new File([bytes], file.name, { type: file.mime });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await wait(100);
  }
  return true;
}

export class PageCommands {
  private models: ModelsValue | null = null;

  constructor(private readonly backend: ReturnType<typeof createBackend>, private readonly streams: StreamRelay) {}

  private async loadModels(): Promise<ModelsValue> {
    this.models = parseModels(await this.backend.request(MODELS_PATH));
    return this.models;
  }

  private async status(): Promise<PageStatus> {
    const current = await this.backend.getSession();
    return {
      url: location.href,
      conversationId: conversationIdFromUrl(location.href),
      signedIn: current?.signedIn ?? null,
      generating: dom.isGenerating(),
      composerReady: dom.findComposer() !== null
    };
  }

  private async send(text: string, files: PageFile[]): Promise<PageResult> {
    if (!(await waitFor(() => dom.findComposer() !== null, 15_000))) return fail('not-ready', 'composer not found');
    if (dom.isGenerating()) return fail('busy', 'a response is still generating');
    if (!dom.setComposerText(text)) return fail('failed', 'could not type into the composer');
    if (files.length > 0 && !(await attachFiles(files.map(toFile)))) {
      return fail('failed', 'attachments did not finish uploading');
    }
    const sendable = (): boolean => {
      // Hydration can replace the editor after it first accepts the draft.
      if (!dom.setComposerText(text)) return false;
      const button = dom.findSendButton();
      return button !== null && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
    };
    // With attachments the button may not be identifiable; clickSend then submits with Enter.
    if (!(await waitFor(sendable, files.length > 0 ? 1_500 : 15_000)) && files.length === 0) return fail('not-ready', 'send button is not available');
    // Register before clicking: the stream can start before the click returns.
    const started = this.streams.waitForStart(20_000);
    if (!dom.clickSend()) return fail('failed', 'send button could not be clicked');
    const value = await started;
    return value ? { ok: true, value } : fail('timeout', 'no conversation stream started after send');
  }

  private async selectModel(model: string, effort: ReasoningEffort | null): Promise<PageResult> {
    if (!this.models) await this.loadModels().catch(() => undefined);
    const label = this.models?.models.find((entry) => entry.id === model)?.label ?? model;
    return (await dom.selectModel(label, effort)) ? DONE : fail('not-found', `model ${model} not found in the picker`);
  }

  async run(command: PageCommand): Promise<PageResult> {
    try {
      switch (command.type) {
        case 'status':
          return { ok: true, value: await this.status() };
        case 'send':
          return await this.send(command.text, command.files);
        case 'stop':
          return dom.clickStop() ? DONE : fail('not-found', 'no stop control is visible');
        case 'models':
          return { ok: true, value: await this.loadModels() };
        case 'conversation': {
          const json = await this.backend.request(`/backend-api/conversation/${encodeURIComponent(command.conversationId)}`);
          return { ok: true, value: conversationToMessages(json) };
        }
        case 'select-model':
          return await this.selectModel(command.model, command.effort);
        case 'usage':
          return { ok: false, error: 'unsupported' };
      }
    } catch (error) {
      if (error instanceof DriverError) return fail(error.code, error.message);
      return fail('failed', errorMessage(error));
    }
  }

}
