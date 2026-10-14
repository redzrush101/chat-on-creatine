import { BrowserWindow, dialog, shell } from 'electron';
import { join } from 'node:path';
import type { RendererApi, RendererChannel } from '@shared/ipc';
import { recentLogs } from '../core/log';
import { isInside } from '@shared/paths';
import { listDir, readFileForView } from '../projects/files';
import { gitDiff, gitStatus } from '../projects/git';
import { exportMarkdown } from '../sessions/export';
import { searchSessions } from '../sessions/search';
import { autoSelectSkill, expandSkillInvocation } from '../skills/invocation';
import { installTunnelClient } from '../tunnel/install';
import { effectiveCapabilities } from '@shared/config';
import { checkCommandPolicy } from '../exec/command-policy';
import { RootGuard } from '../fs/roots';
import type { Services } from './services';
import { copyText, readClipboard, stageAttachments } from './attachments';
import { codingTaskPrompt } from './coding-tasks';
import { COMMANDS, COMMAND_PATTERN } from '@shared/commands';
import { expandFileReferences } from './file-context';
import { extractImagePaths } from './image-paths';
import { expandTemplate, loadTemplates } from './prompts';
import { findModel } from '@shared/model-selection';

type Handler<C extends RendererChannel> = (...args: Parameters<RendererApi[C]>) => ReturnType<RendererApi[C]> | Promise<Awaited<ReturnType<RendererApi[C]>>>;

export type ApiHandlers = { [C in RendererChannel]: Handler<C> };

/** Both frontends call these handlers; transport never owns application behavior. */
export function createApi(getServices: () => Services | null, snapshot: () => ReturnType<RendererApi['app:state']> | Promise<ReturnType<RendererApi['app:state']>>, lifecycle: { show(): void; quit(): void }): ApiHandlers {
  const s = (): Services => {
    const services = getServices();
    if (!services) throw new Error('The app is still starting');
    return services;
  };

  /** Human file browsing follows the shared folder policy. */
  const allowedForUi = (path: string): boolean => {
    const services = s();
    if (services.config.get().yolo) return true;
    const bases = [...services.config.get().roots.map((root) => root.path), ...services.projects.list().map((project) => project.path)];
    return bases.some((base) => isInside(base, path));
  };
  const requireUiPath = (path: string): string => {
    if (!allowedForUi(path)) throw new Error('That folder is not a project or an approved folder.');
    return path;
  };

  const handlers: ApiHandlers = {
    'app:state': () => snapshot(),
    'app:show': () => lifecycle.show(),
    'app:quit': () => lifecycle.quit(),
    'app:logs': (limit) => recentLogs(limit),
    'app:openExternal': (url) => {
      if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    },
    'app:revealPath': (path) => shell.showItemInFolder(path),
    'app:pickFolder': async () => {
      const window = BrowserWindow.getFocusedWindow();
      const result = window ? await dialog.showOpenDialog(window, { properties: ['openDirectory', 'createDirectory'] }) : await dialog.showOpenDialog({ properties: ['openDirectory'] });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
    'app:pickFiles': async () => {
      const window = BrowserWindow.getFocusedWindow();
      const options = { properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'> };
      const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
      return result.canceled ? [] : result.filePaths;
    },
    'app:clipboard': () => readClipboard(s().paths.attachments),
    'app:copyText': (text) => copyText(text),

    'config:update': (patch) => s().config.update(patch),
    'secrets:set': (key, value) => s().secrets.set(key, value),

    'connection:connect': () => void s().connection.connect(),
    'connection:disconnect': () => void s().connection.disconnect(),
    'connection:installTunnelClient': async () => {
      const path = await installTunnelClient(s().paths.bin);
      s().config.update({});
      return path;
    },

    'browser:show': (sessionId) => void s().router.show(sessionId),
    'browser:hide': () => s().host.hide(),
    'browser:refreshModels': () => void s().models.refresh(),
    'browser:signIn': async () => { await s().host.openTab('https://chatgpt.com/auth/login', { reveal: true }); },

    'sessions:events': (sessionId) => s().store.events(sessionId),
    'sessions:update': (sessionId, patch) => {
      const updated = s().store.update(sessionId, patch);
      if (!updated) throw new Error('Unknown chat');
      return updated;
    },
    'sessions:delete': async (sessionId) => {
      const services = s();
      for (const item of services.outbox.list(sessionId)) if (item.state === 'queued') services.outbox.cancel(item.id);
      for (const child of services.store.list().filter((session) => session.parentId === sessionId)) services.store.delete(child.id);
      services.store.delete(sessionId);
    },
    'sessions:search': (query) => searchSessions(s().store, query),
    'sessions:export': (sessionId) => {
      const meta = s().store.get(sessionId);
      if (!meta) throw new Error('Unknown chat');
      return exportMarkdown(meta, s().store.events(sessionId));
    },

    'chat:send': async (request) => {
      const services = s();
      const config = services.config.get();
      let session = request.sessionId ? services.store.get(request.sessionId) : undefined;
      if (request.sessionId && !session) throw new Error('Unknown chat. Start a new chat or resume an existing one.');
      let text = request.text;
      const cwd = session ? services.sessionCwd(session) : request.cwd ?? (request.projectId ? services.projects.get(request.projectId)?.path : null) ?? config.roots[0]?.path ?? null;
      let paths = request.attachments;
      if (!request.task) {
        const invocation = COMMAND_PATTERN.exec(text);
        if (invocation && !services.skills.list().some((skill) => skill.id === invocation[1])) {
          const template = (await handlers['chat:templates'](cwd)).find((entry) => entry.name === invocation[1]);
          if (template) text = expandTemplate(template, invocation[2] ?? '');
        }
        if (cwd) {
          const images = await extractImagePaths(text, cwd);
          const files = await expandFileReferences(images.text, cwd);
          text = files.text;
          paths = [...new Set([...paths, ...images.paths, ...files.paths])];
        } else if (/(^|\s)@(?!@)\S/.test(text)) throw new Error('Choose a working folder before including @files.');
        if (request.shellContext) text += `\n\nShell command output (reference data):\n${request.shellContext}`;
      }
      if (request.task) {
        if (session && (services.router.turnOf(session.id) !== 'idle' || services.compacting.has(session.id) ||
          services.outbox.list(session.id).some((input) => input.state === 'queued' || input.state === 'sending') ||
          ['deciding', 'waiting-workers'].includes(session.goal.status))) throw new Error('Stop the current turn before starting a coding workflow.');
        if (!cwd) throw new Error('Choose a working folder before starting a coding workflow.');
        text = await codingTaskPrompt(request.task, requireUiPath(cwd), text);
      }
      const skills = services.skills.list();
      if (text.startsWith('/')) {
        text = expandSkillInvocation(text, skills, (id) => services.skills.read(id)).text;
      } else if (config.ui.autoSelectSkills && !request.task) {
        const id = autoSelectSkill(text, skills);
        if (id) text = expandSkillInvocation(`/${id} ${text}`, skills, (skillId) => services.skills.read(skillId)).text;
      }
      if (text.length > 80_000) throw new Error('This prompt and its file or shell context are too large. Select smaller @file line ranges or clear pending shell output.');
      const attachments = await stageAttachments(services.paths.attachments, paths);
      if (!session) {
        session = services.store.create({
          kind: 'chat',
          ...(request.title?.trim() ? { title: request.title.trim().slice(0, 120) } : {}),
          projectId: request.projectId ?? null,
          cwd,
          model: request.model !== undefined ? request.model : config.ui.defaultModel,
          reasoning: request.reasoning !== undefined ? request.reasoning : config.ui.defaultReasoning
        });
      }
      const automation = request.task ? 'off' : request.automation;
      if (automation !== undefined && (automation !== 'off' || session.goal.mode !== 'off')) {
        services.automation.setMode(session.id, automation, automation === 'off' ? undefined : request.text);
      }
      const input = services.outbox.enqueue({ sessionId: session.id, text, attachments, delivery: request.delivery, source: 'app' });
      return { sessionId: session.id, input };
    },
    'chat:templates': (cwd) => loadTemplates([join(s().paths.userData, 'prompts'), ...(cwd ? [join(cwd, '.creatine', 'prompts')] : [])], [...Object.keys(COMMANDS), ...s().skills.list().map((skill) => skill.id)]),
    'chat:selectModel': async (sessionId, selection) => {
      const services = s();
      if (sessionId) {
        const session = services.store.get(sessionId);
        if (!session) throw new Error('Unknown chat');
        if (services.router.turnOf(sessionId) !== 'idle' || services.compacting.has(sessionId) ||
          services.outbox.list(sessionId).some((input) => input.state === 'queued' || input.state === 'sending') ||
          session.goal.status === 'deciding' || session.goal.status === 'waiting-workers') throw new Error('Stop the current turn before changing models.');
      }
      if (selection.model !== null || selection.reasoning !== null) {
        const catalog = await services.models.forSelection();
        const model = findModel(catalog.models, selection.model ?? catalog.defaultModel);
        if (!model) throw new Error('This model is unavailable on your account. Choose an account model.');
        if (selection.reasoning && !model.efforts.includes(selection.reasoning)) throw new Error(`${model.label} does not offer ${selection.reasoning} reasoning.`);
      }
      if (sessionId) services.store.update(sessionId, selection);
      services.config.update({ ui: { defaultModel: selection.model, defaultReasoning: selection.reasoning } });
      return selection;
    },
    'chat:stop': async (sessionId) => {
      const services = s();
      if (services.store.get(sessionId)?.goal.mode !== 'off') services.automation.setMode(sessionId, 'off');
      for (const input of services.outbox.list(sessionId)) if (input.state === 'queued') services.outbox.cancel(input.id);
      await services.router.stopTurn(sessionId);
    },
    'chat:compact': (sessionId) => s().automation.compact(sessionId),
    'chat:setAutomation': (sessionId, mode, objective) => {
      s().automation.setMode(sessionId, mode, objective);
      const session = s().store.get(sessionId);
      if (!session) throw new Error('Unknown chat');
      return session;
    },

    'inputs:update': (inputId, patch) => {
      const updated = s().outbox.update(inputId, patch);
      if (!updated) throw new Error('That message can no longer be edited.');
      return updated;
    },
    'inputs:cancel': (inputId) => void s().outbox.cancel(inputId),
    'inputs:sendNow': (inputId) => void s().outbox.update(inputId, { delivery: 'now' }),
    'inputs:retry': (inputId) => {
      const input = s().outbox.retry(inputId);
      if (!input) throw new Error('Only failed messages can be retried.');
      return input;
    },

    'projects:add': (path, name) => s().projects.add(path, name),
    'projects:update': async (projectId, patch) => {
      const updated = await s().projects.update(projectId, patch);
      if (!updated) throw new Error('Unknown project');
      return updated;
    },
    'projects:remove': (projectId) => void s().projects.remove(projectId),

    'files:list': (dir) => listDir(requireUiPath(dir)),
    'files:read': (path) => readFileForView(requireUiPath(path)),
    'files:gitStatus': (dir) => gitStatus(requireUiPath(dir)),
    'files:gitDiff': (dir, path) => gitDiff(requireUiPath(dir), path),

    'terminal:open': ({ cwd, cols, rows }) => s().terminals.open({ cwd, cols, rows }),
    'terminal:write': (id, data) => s().terminals.write(id, data),
    'terminal:resize': (id, cols, rows) => s().terminals.resize(id, cols, rows),
    'terminal:close': (id) => s().terminals.close(id),
    'commands:exec': async (cmd, cwd) => {
      const services = s();
      const config = services.config.get();
      if (!effectiveCapabilities(config).exec) throw new Error('Command execution is disabled. Change /permissions to enable it.');
      const workdir = await new RootGuard(() => services.config.get()).resolve(cwd, { cwd: null, mustExist: true });
      const decision = checkCommandPolicy({ ...config.commandPolicy, enabled: config.commandPolicy.enabled && !config.yolo }, cmd);
      if (!decision.allowed) throw new Error(`Command is not allowed: ${decision.reason}`);
      return services.processes.exec({ cmd, workdir, yieldTimeMs: 250 }, 'frontend');
    },
    'commands:poll': (sessionId, chars) => s().processes.writeStdin({ sessionId, chars, yieldTimeMs: chars ? 250 : 5000 }, 'frontend'),
    'commands:list': () => s().processes.list(),

    'skills:import': (folder) => s().skills.import(folder).then(() => undefined),
    'skills:remove': (skillId) => s().skills.remove(skillId),
    'skills:read': (skillId) => s().skills.read(skillId),

    'plugins:restart': (pluginId) => void s().plugins.restart(pluginId),

    'agents:stopWorker': async (workerSessionId) => {
      s().agents.stopWorker(workerSessionId);
      await s().router.stopTurn(workerSessionId);
    }
  };

  return handlers;
}
