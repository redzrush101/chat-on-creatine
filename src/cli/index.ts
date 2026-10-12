import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connectBackend, defaultProfile, type BackendClient } from './connection';
import { CLI_HELP, parseOptions } from './options';
import { Terminal } from './terminal';
import { Transcript } from './transcript';
import { CliSession } from './session';
import { interactive } from './interactive';
import { execute } from './execute';
import { statusText } from './commands';
import { clip, color, safeText } from './format';

export async function runCli(args: string[], root: string): Promise<void> {
  let client: BackendClient | null = null;
  let terminal: Terminal | null = null;
  let json = false;
  try {
    const options = parseOptions(args);
    json = options.json;
    if (options.help) { process.stdout.write(CLI_HELP); return; }
    if (options.version) {
      const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { version: string };
      process.stdout.write(`${pkg.version}\n`); return;
    }
    if (!process.stdin.isTTY && (options.command === 'chat' || options.command === 'exec')) {
      let input = '';
      for await (const chunk of process.stdin) input += String(chunk);
      options.prompt = [options.prompt, input.trim()].filter(Boolean).join('\n\n');
      options.print = true;
    }
    const isInteractive = options.command === 'chat' && !options.print;
    if (!isInteractive && options.mode === 'loop') throw new Error('Loop needs interactive mode so you can stop it.');
    if (isInteractive && !process.stdout.isTTY) throw new Error('Interactive mode needs a terminal. Use creatine exec <prompt>.');
    if (options.print && ['chat', 'exec'].includes(options.command) && !options.prompt && !options.attachments.length) throw new Error('Provide a prompt, an attachment, or piped input. See creatine --help.');
    client = await connectBackend(root, options.profile ?? defaultProfile());
    if (isInteractive) terminal = new Terminal();
    const transcript = new Transcript((text) => terminal?.print(text), terminal?.colored ?? false);
    const session = new CliSession(client, options, terminal, transcript);
    if (terminal) {
      const title = ` Chat on Creatine ${session.state.version} `;
      const columns = Math.max(12, Math.min(72, (process.stdout.columns || 80) - 4));
      const label = clip(title, columns - 1);
      terminal.print(`\n${color(36, `╭─${label}${'─'.repeat(Math.max(0, columns - label.length - 1))}╮`, terminal.colored)}\n` +
        `  ChatGPT · your account · your local tools\n  ${safeText(options.cwd)}\n` +
        `${color(36, `╰${'─'.repeat(columns)}╯`, terminal.colored)}\n\n` +
        `Type a task to get started. /help for commands.\n`);
    }
    await session.initialize();
    switch (options.command) {
      case 'status': process.stdout.write(statusText(session)); break;
      case 'models': {
        const models = await session.models();
        process.stdout.write(models.map((model) => `${model.id.padEnd(24)} ${model.label} · ${model.efforts.join(', ') || 'default effort'}`).join('\n') + '\n'); break;
      }
      case 'sessions':
        process.stdout.write(session.chats().map((chat) => `${chat.id}  ${safeText(chat.title)}\n  ${safeText(session.sessionCwd(chat) ?? '')}`).join('\n') + '\n'); break;
      case 'stop': await client.invoke('app:quit'); process.stdout.write('The shared Electron backend is shutting down.\n'); break;
      case 'login':
        if (session.state.browser.signedIn) process.stdout.write('Already signed in to ChatGPT. The GUI and CLI share this login.\n');
        else { process.stdout.write('Opening the ChatGPT login page. Complete sign-in in the browser window.\n'); await session.login(); process.stdout.write('Signed in. Login is shared with the GUI.\n'); }
        break;
      case 'chat': case 'exec':
        if (isInteractive) await interactive(session);
        else await execute(session);
    }
  } catch (error) {
    const message = safeText(error instanceof Error ? error.message : String(error));
    if (json) process.stdout.write(`${JSON.stringify({ type: 'error', message })}\n`);
    else if (terminal) terminal.print(`\n${color(31, message, terminal.colored)}\n`);
    else process.stderr.write(`creatine: ${message}\n`);
    process.exitCode ||= 1;
  } finally {
    terminal?.close();
    client?.close();
  }
}
