import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { relative, isAbsolute } from 'node:path';
import type { AppState, InputDelivery, ModelOption, ModelSelection, SessionMeta } from '@shared/types';
import type { ReasoningEffort } from '@shared/config';
import { effortLabel, findModel, modelSelection } from '@shared/model-selection';
import { BackendClient } from './connection';
import type { CliOptions } from './options';
import { Terminal } from './terminal';
import { Transcript } from './transcript';
import { safeText } from './format';
import { extractImagePaths } from './attachments';

export function contains(base: string, path: string): boolean {
  const part = relative(base, path);
  return !isAbsolute(part) && part !== '..' && !part.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`);
}

export class CliSession {
  id: string | null = null;
  cwd: string;
  selection: ModelSelection;
  attachments: string[];
  mode: CliOptions['mode'];

  constructor(readonly client: BackendClient, readonly options: CliOptions, readonly terminal: Terminal | null, public transcript: Transcript) {
    this.cwd = options.cwd;
    this.selection = { model: options.model ?? null, reasoning: options.effort ?? null };
    this.attachments = options.attachments;
    this.mode = options.mode;
  }

  get state(): AppState {
    if (!this.client.state) throw new Error('The backend is still starting.');
    return this.client.state;
  }

  get meta(): SessionMeta | undefined { return this.state.sessions.find((session) => session.id === this.id); }

  get busy(): boolean {
    return !!this.id && (this.state.live[this.id]?.turn !== undefined && this.state.live[this.id]?.turn !== 'idle' ||
      this.state.inputs.some((input) => input.sessionId === this.id && ['queued', 'sending'].includes(input.state)) ||
      ['deciding', 'waiting-workers'].includes(this.meta?.goal.status ?? ''));
  }

  async initialize(): Promise<void> {
    this.cwd = await realpath(this.cwd);
    if (this.options.yolo) {
      await this.client.invoke('config:update', { yolo: true, readOnly: false });
      await this.client.refresh();
    }
    const config = this.state.config;
    this.selection = { model: this.options.model ?? config.ui.defaultModel, reasoning: this.options.effort ?? config.ui.defaultReasoning };
    if (this.options.resume) {
      const sessions = this.chats();
      const matches = this.options.resume === 'latest'
        ? sessions.filter((session) => this.sessionCwd(session) === this.cwd).slice(0, 1)
        : sessions.filter((session) => session.id.startsWith(this.options.resume!));
      if (matches.length !== 1) throw new Error(matches.length ? 'That session prefix is ambiguous. Use a longer ID from creatine sessions.' : 'No matching chat. Use creatine sessions to list shared history.');
      await this.resume(matches[0]!);
    }
  }

  chats(): SessionMeta[] { return this.state.sessions.filter((session) => session.kind === 'chat').sort((a, b) => b.updatedAt - a.updatedAt); }

  sessionCwd(session: SessionMeta): string | null {
    return session.cwd ?? this.state.projects.find((project) => project.id === session.projectId)?.path ?? null;
  }

  async resume(meta: SessionMeta): Promise<void> {
    this.id = meta.id;
    this.cwd = this.sessionCwd(meta) ?? this.cwd;
    this.selection = { model: this.options.model ?? meta.model, reasoning: this.options.effort ?? meta.reasoning };
    this.mode = meta.goal.mode;
    if (this.options.model !== undefined || this.options.effort !== undefined) await this.client.invoke('sessions:update', meta.id, this.selection);
    const events = await this.client.invoke('sessions:events', meta.id);
    this.transcript.consume(events.slice(-60));
  }

  async approve(): Promise<void> {
    await this.client.refresh();
    if (this.state.config.yolo || this.state.config.roots.some((root) => contains(root.path, this.cwd))) return;
    let trust = this.options.trust;
    if (!trust && this.terminal) {
      trust = await this.terminal.pick(`Approve local tool access to ${safeText(this.cwd)}?`, [
        { label: 'Approve this folder', detail: 'Files and commands use your normal user permissions', value: true },
        { label: 'Cancel', value: false }
      ]) ?? false;
    }
    if (!trust) throw new Error('The working folder is not approved. Use --trust to approve it, or approve it in GUI Settings → Setup.');
    await this.client.invoke('config:update', { roots: [...this.state.config.roots, { id: randomUUID(), path: this.cwd, label: '' }] });
    await this.client.refresh();
  }

  async send(text: string, delivery: InputDelivery = 'now', automation = this.mode): Promise<{ sessionId: string; inputId: string }> {
    if (this.state.browser.signedIn === false) throw new Error('Sign in first with /login or creatine login. The GUI and CLI share the account.');
    await this.approve();
    if (this.state.connection.state !== 'connected') {
      await this.client.invoke('connection:connect');
      const connected = await this.client.waitFor((state) => ['connected', 'auth-failed', 'error'].includes(state.connection.state), 45_000);
      if (connected.connection.state !== 'connected') throw new Error(`Local tools are offline: ${connected.connection.detail}. Use /setup or GUI Connection settings.`);
    }
    if (this.selection.model !== null || this.selection.reasoning !== null) await this.validateSelection();
    const project = await this.client.invoke('projects:add', this.cwd);
    const wasBusy = this.busy;
    const result = await this.client.invoke('chat:send', {
      sessionId: this.id, text, attachments: this.attachments, delivery,
      cwd: this.cwd, projectId: project.id, ...this.selection,
      automation: wasBusy ? undefined : automation
    });
    this.id = result.sessionId;
    this.attachments = [];
    this.transcript.echo(result.input);
    await this.client.refresh();
    return { sessionId: result.sessionId, inputId: result.input.id };
  }

  async attachImages(text: string): Promise<string> {
    const parsed = await extractImagePaths(text, this.cwd);
    this.attachments = [...new Set([...this.attachments, ...parsed.paths])];
    return parsed.text;
  }

  async paste(): Promise<void> {
    const clipboard = await this.client.invoke('app:clipboard');
    if (clipboard.imagePath) {
      this.attachments.push(clipboard.imagePath);
      return;
    }
    this.terminal?.editor.insert(await this.attachImages(clipboard.text));
  }

  async models(): Promise<AppState['models']['models']> {
    if (this.state.models.state !== 'ready') {
      await this.client.invoke('browser:refreshModels');
      await this.client.waitFor((state) => ['ready', 'error'].includes(state.models.state), 60_000);
    }
    if (this.state.models.state !== 'ready') throw new Error(this.state.models.error ?? 'Sign in to load models.');
    return this.state.models.models;
  }

  async setModel(id?: string, effort?: ReasoningEffort): Promise<void> {
    const models = await this.models();
    let option = findModel(models, id ?? this.selection.model ?? this.state.models.defaultModel);
    if (!id && this.terminal) {
      const current = this.selection.model === null ? -1 : models.findIndex((model) => model.id === option?.id);
      const picked = await this.terminal.pick<ModelOption | 'default'>('Select model', [
        { label: 'Account default', detail: 'The model ChatGPT picks for new chats', value: 'default', current: current < 0 },
        ...models.map((model, index) => ({ label: model.label, detail: model.id, value: model, current: index === current }))
      ], current + 1);
      if (picked === null) return;
      if (picked === 'default') { await this.setModel('default'); return; }
      option = picked;
      if (!effort && picked.efforts.length) {
        const selected = await this.terminal.pick(`Effort · ${picked.label}`, picked.efforts.map((level) => ({ label: effortLabel(picked, level), value: level, current: level === this.selection.reasoning })),
          Math.max(0, picked.efforts.findIndex((level) => level === this.selection.reasoning)));
        if (selected === null) return;
        effort = selected;
      }
    }
    if (id === 'default') this.selection = { model: null, reasoning: null };
    else {
      if (!option) throw new Error(`Unknown model ${id ?? ''}. Use /model to choose from your account.`);
      if (effort && !option.efforts.includes(effort)) throw new Error(`${option.label} offers ${option.efforts.join(', ') || 'no reasoning levels'}.`);
      this.selection = modelSelection(option, effort ?? this.selection.reasoning);
    }
    if (this.id) await this.client.invoke('sessions:update', this.id, this.selection);
    await this.client.invoke('config:update', { ui: { defaultModel: this.selection.model, defaultReasoning: this.selection.reasoning } });
    await this.client.refresh();
  }

  async stop(): Promise<void> {
    if (!this.id) return;
    for (const input of this.state.inputs.filter((item) => item.sessionId === this.id && item.state === 'queued')) await this.client.invoke('inputs:cancel', input.id);
    await this.client.invoke('chat:stop', this.id);
  }

  async login(): Promise<void> {
    await this.client.invoke('browser:signIn');
    this.terminal?.print('\nChatGPT sign-in opened. Login is shared with the GUI.\n');
    await this.client.waitFor((state) => state.browser.signedIn === true, 600_000);
  }

  private async validateSelection(): Promise<void> {
    const models = await this.models();
    const model = findModel(models, this.selection.model ?? this.state.models.defaultModel);
    if (!model) throw new Error('This model is unavailable on your account. Choose a model with /model.');
    if (this.selection.reasoning && !model.efforts.includes(this.selection.reasoning)) throw new Error(`${model.label} does not offer ${this.selection.reasoning} reasoning. Use /effort.`);
  }
}
