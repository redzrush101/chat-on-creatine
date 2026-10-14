import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { resolve } from 'node:path';
import { REASONING_EFFORTS, type ReasoningEffort } from '@shared/config';
import { CliSession } from './session';
import { DIM, color, safeText, screenColumns } from './format';
import { nested } from './render';
import { COMMANDS, COMMAND_PATTERN } from '@shared/commands';
import { parseArguments } from '@shared/arguments';
import { parseOptions } from './options';
import { mcpCommand } from './mcp';

export { COMMANDS, COMMAND_PATTERN } from '@shared/commands';

function pathArgument(text: string): string { return text.replace(/^(['"])(.*)\1$/, '$2'); }

export function statusText(session: CliSession): string {
  const state = session.state;
  return `Chat on Creatine ${state.version}\nChatGPT: ${state.browser.signedIn ? 'signed in' : 'sign in with /login'}\n` +
    `Tools: ${state.connection.state} · ${state.connection.detail}\nFolder: ${session.cwd}\n` +
    `Model: ${session.selection.model ?? 'account default'} · reasoning ${session.selection.reasoning ?? 'default'}\n` +
    `Permissions: ${state.config.yolo ? 'unrestricted' : state.config.readOnly ? 'read only' : 'approved folders'}\n` +
    `Session: ${session.id ?? 'new'}${session.id ? ` · ${state.live[session.id]?.turn ?? 'idle'} · ~${session.meta?.contextTokens ?? 0} context tokens` : ''}\n` +
    `Automation: ${session.meta?.goal.mode ?? session.mode}${session.meta ? ` · ${session.meta.goal.status}` : ''}\n`;
}

export interface CommandHooks { newChat(): void; exit(): void }

export async function runCommand(text: string, session: CliSession, hooks: CommandHooks): Promise<void> {
  const terminal = session.terminal;
  if (!terminal) return;
  const body = await session.attachImages(text);
  const match = body === text ? COMMAND_PATTERN.exec(text) : null;
  if (!match) {
    if (body.trim() || session.attachments.length) await session.send(body);
    return;
  }
  const name = match[1]!;
  const argument = match[2]?.trim() ?? '';
  const print = (body: string) => terminal.print(nested(safeText(body).split('\n'), { colored: terminal.colored, columns: screenColumns() }).join('\n'));
  const id = (): string => { if (!session.id) throw new Error('Send a message or resume a chat first.'); return session.id; };
  const client = session.client;
  await client.refresh();
  switch (name) {
    case 'help':
      print(Object.entries(COMMANDS).map(([command, hint]) => `/${command.padEnd(13)} ${color(DIM, hint, terminal.colored)}`).join('\n') +
        '\n\nenter send · ctrl+j or alt+enter newline · tab complete · ↑↓ history · ? shortcuts\nesc interrupt · ctrl+c clear or exit · ctrl+o full transcript · ctrl+v or alt+v paste\nctrl+g external editor · ctrl+p next model · shift+tab cycle reasoning · ctrl+l clear screen\n@file includes text; @file:10-30 selects lines; @"file with spaces" quotes a path.\n!<command> runs a shell command and includes its output with the next message.\n!!<command> runs locally; /context clear removes pending shell output.\nSending while busy steers the current turn; /queue holds a message for later.'); break;
    case 'new': hooks.newChat(); print('New chat.'); break;
    case 'review': {
      const args = parseArguments(argument);
      if (args.some((arg) => arg.startsWith('-') && !['--base', '--commit', '--uncommitted'].includes(arg))) throw new Error('Usage: /review [--uncommitted | --base <ref> | --commit <ref>] [focus]');
      const options = parseOptions(['review', ...args], session.cwd);
      await session.send(options.prompt, 'now', 'off', { kind: 'review', target: options.review }); break;
    }
    case 'init':
      if (argument) throw new Error('Usage: /init');
      if (session.busy) throw new Error('Stop the current turn with /stop before initializing project instructions.');
      await session.send('', 'now', 'off', { kind: 'init' }); break;
    case 'copy': {
      if (argument) throw new Error('Usage: /copy');
      const events = await client.invoke('sessions:events', id());
      const final = events.filter((event) => event.kind === 'assistant' && event.channel === 'final' && !event.streaming).at(-1);
      if (!final || final.kind !== 'assistant') throw new Error('There is no completed final answer to copy yet.');
      await client.invoke('app:copyText', safeText(final.text).replace(/\ue200[^\ue201]*\ue201/g, ''));
      print('Copied the latest final answer.'); break;
    }
    case 'resume': {
      if (argument === '--list' || argument.startsWith('--list ')) {
        print(session.chats(argument.slice(6).trim()).map((chat) => `${chat.id.slice(0, 8)} · ${chat.title}\n  ${session.sessionCwd(chat) ?? 'no folder'}`).join('\n') || 'No matching chats.'); break;
      }
      if (session.busy) throw new Error('Stop the current turn with /stop before switching chats.');
      if (argument === '--search' || argument.startsWith('--search ')) {
        const query = argument.slice(8).trim();
        if (!query) throw new Error('Usage: /resume --search <text>');
        const hits = await client.invoke('sessions:search', query);
        const chats = session.chats();
        const picked = await terminal.pick('Search chat messages', hits.flatMap((hit) => {
          const chat = chats.find((chat) => chat.id === hit.sessionId);
          return chat ? [{ label: chat.title, detail: hit.snippet, value: chat }] : [];
        }));
        if (picked) { hooks.newChat(); await session.resume(picked); print(`Resumed ${picked.id}`); }
        else if (!hits.length) print('No matching messages.');
        break;
      }
      const picked = await session.pickSession(argument);
      if (picked) { hooks.newChat(); await session.resume(picked); print(`Resumed ${picked.id}`); }
      break;
    }
    case 'name':
      if (!argument) { print(session.meta?.title ?? session.name ?? 'New chat'); break; }
      session.name = argument.slice(0, 120);
      if (session.id) await client.invoke('sessions:update', session.id, { title: session.name });
      print(`Chat name: ${session.name}`); break;
    case 'context':
      if (argument === 'templates') {
        await session.reloadTemplates();
        print(session.templates.map((template) => `/${template.name}${template.argumentHint ? ` ${template.argumentHint}` : ''} · ${template.description}\n  ${template.path}`).join('\n') || 'No templates. Add Markdown files to .creatine/prompts/ or your profile\'s prompts/ folder.'); break;
      }
      if (argument === 'reload') { await session.reloadTemplates(); print(`Loaded ${session.templates.length} prompt templates.`); break; }
      if (argument === 'clear') session.shellContext = '';
      else if (argument) throw new Error('Usage: /context [clear | templates | reload]');
      print(session.shellContext || 'No pending shell context.'); break;
    case 'model': {
      const [model, effort] = argument.split(/\s+/);
      if (effort && !REASONING_EFFORTS.includes(effort as ReasoningEffort)) throw new Error(`Unknown effort ${effort}.`);
      await session.setModel(model || undefined, effort as ReasoningEffort | undefined);
      print(`Model: ${session.selection.model ?? 'account default'} · ${session.selection.reasoning ?? 'default reasoning'}`); break;
    }
    case 'status':
      if (argument === 'connect') { await client.invoke('connection:connect'); print('Connecting…'); }
      else if (argument === 'disconnect') { await client.invoke('connection:disconnect'); print('Disconnected.'); }
      else if (argument === 'browser') await client.invoke('browser:show', session.id);
      else if (argument === 'logs') print((await client.invoke('app:logs', 30)).map((entry) => `${entry.level} [${entry.scope}] ${entry.message}`).join('\n'));
      else if (argument) throw new Error('Usage: /status [connect | disconnect | browser | logs]');
      else print(statusText(session));
      break;
    case 'login': await session.login(); print('Signed in. The GUI uses this same login.'); break;
    case 'gui': await client.invoke('app:show'); break;
    case 'attach':
      if (argument === 'clear') session.attachments = [];
      else if (argument) session.attachments.push(await realpath(resolve(session.cwd, pathArgument(argument))));
      print(session.attachments.length ? `Pending attachments:\n${session.attachments.join('\n')}` : 'No pending attachments.'); break;
    case 'cd': {
      if (!argument) { print(session.cwd); break; }
      const cwd = await realpath(resolve(session.cwd, pathArgument(argument)));
      const project = await client.invoke('projects:add', cwd);
      if (session.id) await client.invoke('sessions:update', session.id, { cwd, projectId: project.id });
      session.cwd = cwd;
      session.shellContext = '';
      await session.reloadTemplates();
      print(`Working in ${cwd}`); break;
    }
    case 'plan': {
      const events = await client.invoke('sessions:events', id());
      const plan = events.filter((event) => event.kind === 'plan').at(-1);
      print(plan ? plan.items.map((item) => `${item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '›' : '○'} ${item.step}`).join('\n') : 'No plan yet.'); break;
    }
    case 'tasks': {
      const workers = session.state.agents.find((run) => run.primeSessionId === session.id)?.workers ?? [];
      if (argument.startsWith('stop ')) {
        const prefix = argument.slice(5);
        const found = workers.filter((worker) => worker.sessionId.startsWith(prefix));
        if (found.length !== 1) throw new Error('Choose a worker ID listed by /tasks.');
        await client.invoke('agents:stopWorker', found[0]!.sessionId); break;
      }
      if (argument) {
        const found = workers.filter((worker) => worker.sessionId.startsWith(argument));
        if (found.length !== 1) throw new Error('Choose a worker ID listed by /tasks.');
        const worker = found[0]!;
        print(`${worker.label} · ${worker.sessionId}\n${worker.task}\n${worker.lastResult ?? worker.state}`);
        const events = await client.invoke('sessions:events', worker.sessionId);
        for (const event of events.filter((event) => event.kind === 'assistant' && !event.streaming).slice(-3)) if (event.kind === 'assistant') print(event.text);
        break;
      }
      print((await client.invoke('commands:list')).filter((process) => process.owner === session.id || process.owner === 'frontend').map((process) => `${process.sessionId} · ${process.command}`).join('\n') || 'No running commands.');
      print(workers.map((worker) => `${worker.sessionId.slice(0, 8)} · ${worker.label}: ${worker.state}`).join('\n') || 'No workers.');
      print(session.state.inputs.filter((input) => input.sessionId === session.id && ['queued', 'sending', 'failed'].includes(input.state)).map((input) => `${input.id.slice(0, 8)} ${input.state} ${input.text}`).join('\n') || 'No pending inputs.'); break;
    }
    case 'queue': {
      const [action, prefix] = argument.split(/\s+/);
      if (['cancel', 'now', 'retry', 'edit'].includes(action ?? '')) {
        const found = session.state.inputs.filter((input) => input.sessionId === session.id && prefix && input.id.startsWith(prefix));
        if (found.length !== 1) throw new Error('Choose one input ID listed by /queue.');
        if (action === 'cancel') await client.invoke('inputs:cancel', found[0]!.id);
        if (action === 'now') await client.invoke('inputs:sendNow', found[0]!.id);
        const input = found[0]!;
        if (action === 'edit') {
          if (input.state !== 'queued') throw new Error('Only queued messages can be edited. Retry a failed message first.');
          const text = await terminal.ask('Edit pending message', false, input.text);
          if (text?.trim()) await client.invoke('inputs:update', input.id, { text });
        }
        if (action === 'retry') {
          if (input.state !== 'failed') throw new Error('Only failed messages can be retried.');
          await client.invoke('inputs:retry', input.id);
        }
      } else if (argument) await session.send(argument, 'after-turn');
      else print(session.state.inputs.filter((input) => input.sessionId === session.id && ['queued', 'sending', 'failed'].includes(input.state)).map((input) => `${input.id.slice(0, 8)} · ${input.state} · ${input.text}`).join('\n') || 'No pending messages.');
      break;
    }
    case 'stop': await session.stop(); break;
    case 'goal': case 'loop':
      if (argument === 'off') { if (session.id) await client.invoke('chat:setAutomation', session.id, 'off'); session.mode = 'off'; }
      else if (argument) { session.mode = name; await session.send(argument, 'now', name); }
      else print(`${name}: ${session.meta?.goal.status ?? session.mode}\n${session.meta?.goal.objective ?? `Usage: /${name} <objective>`}`); break;
    case 'compact': await client.invoke('chat:compact', id()); print('Compacting and resuming…'); break;
    case 'diff': {
      const status = await client.invoke('files:gitStatus', session.cwd);
      if (!status.isRepo) { print('This folder is not a Git repository.'); break; }
      print(`${status.branch ?? 'detached HEAD'} · +${status.added} -${status.removed}\n${status.changes.map((change) => `${change.status} ${change.path}`).join('\n')}`);
      const file = argument || await terminal.pick('Changed file', status.changes.map((change) => ({ label: change.path, detail: change.status, value: change.path })));
      if (file) print(await client.invoke('files:gitDiff', session.cwd, pathArgument(file))); break;
    }
    case 'skills':
      if (argument.startsWith('import ')) await client.invoke('skills:import', resolve(session.cwd, pathArgument(argument.slice(7))));
      else if (argument.startsWith('remove ')) await client.invoke('skills:remove', argument.slice(7));
      else print(session.state.skills.map((skill) => `/${skill.id} · ${skill.name}\n  ${skill.description}`).join('\n') || 'No skills. Import a folder containing SKILL.md with /skills import <folder>.'); break;
    case 'mcp': print(await mcpCommand(client, parseArguments(argument))); break;
    case 'permissions': {
      if (argument === 'approve' || argument.startsWith('approve ')) {
        const folder = await realpath(resolve(session.cwd, pathArgument(argument.slice(7).trim()) || '.'));
        if (!session.state.config.roots.some((root) => root.path === folder)) await client.invoke('config:update', { roots: [...session.state.config.roots, { id: randomUUID(), path: folder, label: '' }] });
        print(`Approved ${folder}`); break;
      }
      if (argument) throw new Error('Usage: /permissions [approve [folder]]');
      const mode = await terminal.pick('Tool permissions · shared with the GUI', [
        { label: 'Approved folders', detail: 'Read, edit and run commands under configured rules', value: 'normal' },
        { label: 'Read only', detail: 'Disable edits and command execution', value: 'read' },
        { label: 'Unrestricted', detail: 'All capabilities and paths, without command policy', value: 'yolo' }
      ]);
      if (mode) await client.invoke('config:update', { readOnly: mode === 'read', yolo: mode === 'yolo' }); break;
    }
    case 'setup': {
      const tunnel = await terminal.ask('OpenAI tunnel ID (from platform.openai.com/settings/organization/tunnels)', true);
      if (!tunnel) break;
      const key = await terminal.ask('Restricted API key with Tunnels: Read + Use (hidden)', true);
      if (!key) break;
      await client.invoke('secrets:set', 'tunnelApiKey', key.trim());
      await client.invoke('config:update', { connection: { kind: 'openai', tunnelId: tunnel.trim(), autoConnect: true } });
      await client.invoke('connection:connect');
      print('Connection started. In ChatGPT, add the tunnel as an MCP App with no authentication, named Chat on Creatine Core. Use /status to check it.'); break;
    }
    case 'exit': hooks.exit(); break;
    default:
      if (!session.state.skills.some((skill) => skill.id === name) && !session.templates.some((template) => template.name === name)) throw new Error(`Unknown command /${name}. Use /help.`);
      await session.send(text);
  }
  await client.refresh();
}
