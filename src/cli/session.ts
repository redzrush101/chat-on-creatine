import { randomUUID } from 'node:crypto';
import { realpath, stat } from 'node:fs/promises';
import type { AppState, CodingTask, InputDelivery, ModelOption, ModelSelection, PromptTemplate, SessionMeta } from '@shared/types';
import type { ReasoningEffort } from '@shared/config';
import { effortLabel, findModel, modelSelection } from '@shared/model-selection';
import { BackendClient } from './connection';
import type { CliOptions } from './options';
import { Terminal } from './terminal';
import { Transcript } from './transcript';
import { safeText } from './format';
import { extractImagePaths } from '../main/app/image-paths';
import { sessionBusy } from '@shared/session-state';
import { isInside } from '@shared/paths';

export class CliSession {
  id: string | null = null;
  cwd: string;
  selection: ModelSelection;
  attachments: string[];
  mode: CliOptions['mode'];
  name: string | null;
  templates: PromptTemplate[] = [];
  shellContext = '';

  constructor(readonly client: BackendClient, readonly options: CliOptions, readonly terminal: Terminal | null, public transcript: Transcript) {
    this.cwd = options.cwd;
    this.selection = { model: options.model ?? null, reasoning: options.effort ?? null };
    this.attachments = options.attachments;
    this.mode = options.mode;
    this.name = options.name ?? null;
  }

  get state(): AppState {
    if (!this.client.state) throw new Error('The backend is still starting.');
    return this.client.state;
  }

  get meta(): SessionMeta | undefined { return this.state.sessions.find((session) => session.id === this.id); }

  get busy(): boolean {
    return sessionBusy(this.state, this.id);
  }

  async initialize(): Promise<void> {
    this.cwd = await realpath(this.cwd);
    if (!(await stat(this.cwd)).isDirectory()) throw new Error('Choose a working folder with -C, not a file.');
    if (this.options.yolo) {
      await this.client.invoke('config:update', { yolo: true, readOnly: false });
      await this.client.refresh();
    }
    const roots = [...this.state.config.roots];
    for (const folder of this.options.additionalRoots) {
      const path = await realpath(folder);
      if (!(await stat(path)).isDirectory()) throw new Error('--add-dir needs a folder, not a file.');
      if (!roots.some((root) => isInside(root.path, path))) roots.push({ id: randomUUID(), path, label: '' });
    }
    if (roots.length !== this.state.config.roots.length) {
      await this.client.invoke('config:update', { roots });
      await this.client.refresh();
    }
    const config = this.state.config;
    this.selection = { model: this.options.model ?? config.ui.defaultModel, reasoning: this.options.effort ?? config.ui.defaultReasoning };
    if (this.options.resume) {
      if (this.options.resume === 'picker') {
        if (!this.terminal) throw new Error('Noninteractive --resume needs a session ID.');
        const picked = await this.pickSession('', !this.options.allSessions);
        if (picked) await this.resume(picked);
      } else {
        const sessions = this.chats();
        const matches = this.options.resume === 'latest'
          ? sessions.filter((session) => this.options.allSessions || this.sessionCwd(session) === this.cwd).slice(0, 1)
          : sessions.filter((session) => session.id.startsWith(this.options.resume!));
        if (matches.length !== 1) throw new Error(matches.length ? 'That session prefix is ambiguous. Use a longer ID from creatine sessions.' : 'No matching chat. Use creatine sessions to list shared history.');
        await this.resume(matches[0]!);
      }
    }
    if (this.id && this.name) await this.client.invoke('sessions:update', this.id, { title: this.name });
    await this.reloadTemplates();
  }

  chats(query = ''): SessionMeta[] {
    const needle = query.toLowerCase();
    return this.state.sessions.filter((session) => session.kind === 'chat' && `${session.id} ${session.title}`.toLowerCase().includes(needle)).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async pickSession(query = '', currentFolderOnly = false): Promise<SessionMeta | null> {
    const chats = this.chats(query).filter((chat) => !currentFolderOnly || this.sessionCwd(chat) === this.cwd);
    const exact = chats.filter((chat) => chat.id.startsWith(query));
    if (query && exact.length === 1) return exact[0]!;
    if (!chats.length) throw new Error('No matching chats. Use /resume --list to list shared history.');
    return await this.terminal!.pick('Resume a shared chat · current folder first', chats.sort((a, b) => Number(this.sessionCwd(b) === this.cwd) - Number(this.sessionCwd(a) === this.cwd))
      .map((chat) => ({ label: chat.title, detail: `${chat.id.slice(0, 8)} · ${this.sessionCwd(chat) ?? 'no folder'}`, value: chat })));
  }

  async reloadTemplates(): Promise<void> {
    this.templates = await this.client.invoke('chat:templates', this.cwd);
  }

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
    this.terminal?.editor.restoreHistory(events.flatMap((event) => event.kind === 'user' ? [event.text] : []));
    this.shellContext = '';
    await this.reloadTemplates();
  }

  async approve(): Promise<void> {
    await this.client.refresh();
    if (this.state.config.yolo || this.state.config.roots.some((root) => isInside(root.path, this.cwd))) return;
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

  async send(text: string, delivery: InputDelivery = 'now', automation = this.mode, task?: CodingTask): Promise<{ sessionId: string; inputId: string }> {
    if (this.state.browser.signedIn === false) throw new Error('Sign in first with /login or creatine login. The GUI and CLI share the account.');
    await this.approve();
    if (text.length + this.shellContext.length > 80_000) throw new Error('This prompt and its file or shell context are too large. Select smaller @file line ranges or use /context clear.');
    if (this.state.connection.state !== 'connected') {
      await this.client.invoke('connection:connect');
      const connected = await this.client.waitFor((state) => ['connected', 'auth-failed', 'error'].includes(state.connection.state), 45_000);
      if (connected.connection.state !== 'connected') throw new Error(`Local tools are offline: ${connected.connection.detail}. Use /setup or GUI Connection settings.`);
    }
    if (this.selection.model !== null || this.selection.reasoning !== null) await this.validateSelection();
    const project = await this.client.invoke('projects:add', this.cwd);
    const wasBusy = this.busy;
    const result = await this.client.invoke('chat:send', {
      sessionId: this.id, text, shellContext: this.shellContext, attachments: this.attachments, delivery, title: this.name ?? undefined,
      cwd: this.cwd, projectId: project.id, ...this.selection,
      automation: wasBusy ? undefined : automation, task
    });
    this.id = result.sessionId;
    if (task) this.mode = 'off';
    this.attachments = [];
    this.shellContext = '';
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
      this.terminal?.flash(`Image attached: ${clipboard.imagePath.split(/[\\/]/).at(-1)}`);
      return;
    }
    if (!clipboard.text) throw new Error('The clipboard has no image or text. Copy an image, then use Ctrl+V or Alt+V. Terminal paste shortcuts may only paste text.');
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
    let selection: ModelSelection;
    if (id === 'default') selection = { model: null, reasoning: null };
    else {
      if (!option) throw new Error(`Unknown model ${id ?? ''}. Use /model to choose from your account.`);
      if (effort && !option.efforts.includes(effort)) throw new Error(`${option.label} offers ${option.efforts.join(', ') || 'no reasoning levels'}.`);
      selection = modelSelection(option, effort ?? this.selection.reasoning);
    }
    this.selection = await this.client.invoke('chat:selectModel', this.id, selection);
    await this.client.refresh();
  }

  async cycleModel(): Promise<void> {
    if (this.busy) throw new Error('Stop the current turn before changing models.');
    const models = await this.models();
    const current = findModel(models, this.selection.model ?? this.state.models.defaultModel);
    const next = models[(models.findIndex((model) => model.id === current?.id) + 1) % models.length];
    if (next) await this.setModel(next.id);
    this.terminal?.flash(`Model: ${this.selection.model}`);
  }

  async cycleEffort(): Promise<void> {
    if (this.busy) throw new Error('Stop the current turn before changing reasoning.');
    const model = findModel(await this.models(), this.selection.model ?? this.state.models.defaultModel);
    const levels = model?.efforts ?? [];
    const next = levels[(levels.findIndex((level) => level === this.selection.reasoning) + 1) % levels.length];
    if (!model || !next) { this.terminal?.flash('This model has no reasoning levels.'); return; }
    await this.setModel(model.id, next);
    this.terminal?.flash(`Reasoning: ${next}`);
  }

  addShellContext(command: string, output: string, status: string): void {
    const context = `${this.shellContext ? `${this.shellContext}\n\n` : ''}$ ${command}\nWorking folder: ${this.cwd}\n${output}\n${status}`;
    this.shellContext = context.length > 24_000 ? `[Earlier shell output omitted]\n${context.slice(-24_000)}` : context;
  }

  async stop(): Promise<void> {
    if (!this.id) return;
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
    if (this.selection.reasoning && !model.efforts.includes(this.selection.reasoning)) throw new Error(`${model.label} does not offer ${this.selection.reasoning} reasoning. Use /model.`);
  }
}
