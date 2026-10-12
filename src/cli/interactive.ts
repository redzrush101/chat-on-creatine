import { readdir } from 'node:fs/promises';
import { dirname, resolve, basename } from 'node:path';
import { COMMANDS, runCommand } from './commands';
import { ACCENT, DIM, color, safeText, screenColumns, tilde } from './format';
import { nested, userRows } from './render';
import type { CliSession } from './session';
import { Transcript } from './transcript';

export async function interactive(session: CliSession): Promise<void> {
  const terminal = session.terminal!;
  const client = session.client;
  let lastInterrupt = 0;
  let handling = false;
  let shellId: string | null = null;
  let shellStopped = false;
  let done: () => void = () => {};
  const finished = new Promise<void>((resolve) => { done = resolve; });
  const error = (reason: unknown) => terminal.print(`\n${color(31, '●', terminal.colored)} ${color(31, safeText(reason instanceof Error ? reason.message : String(reason)), terminal.colored)}\n`);
  const echo = (text: string) => terminal.print(`\n${userRows(text, { colored: terminal.colored, columns: screenColumns() }).join('\n')}`);
  let busySince: number | null = null;
  const reset = () => {
    session.id = null;
    session.mode = 'off';
    session.transcript = new Transcript((text) => terminal.print(text), terminal.colored);
  };
  const update = () => {
    const meta = session.meta;
    if (meta) session.selection = { model: meta.model, reasoning: meta.reasoning };
    const model = session.state.models.models.find((item) => item.id === session.selection.model || item.slugs?.includes(session.selection.model ?? ''));
    const remaining = Math.max(0, Math.round(100 * (1 - (meta?.contextTokens ?? 0) / session.state.config.context.advisoryTokens)));
    terminal.info = `${model?.label ?? session.selection.model ?? 'Account default'}${session.selection.reasoning ? ` ${session.selection.reasoning}` : ''} · ${remaining}% context · ${tilde(session.cwd)}`;
    terminal.hint = shellId ? 'ctrl+c to interrupt the shell' : session.attachments.length ? `${session.attachments.length} attached · /attach clear removes them` : '? for shortcuts';
    terminal.mode = session.state.config.yolo ? 'unrestricted tools' : session.state.config.readOnly ? 'read only' : '';
    terminal.commands = [
      ...Object.entries(COMMANDS).map(([name, detail]) => ({ label: `/${name}`, value: `/${name}`, detail })),
      ...session.state.skills.map((skill) => ({ label: `/${skill.id}`, value: `/${skill.id}`, detail: skill.description }))
    ];
    const working = !!shellId || session.busy;
    busySince = working ? busySince ?? Date.now() : null;
    terminal.busy = working ? { verb: shellId ? 'Running shell command' : session.transcript.activity(), since: session.transcript.since ?? busySince! } : null;
    terminal.draw();
  };
  const offState = client.on('state', () => update());
  const offEvents = client.on('session:events', (batch) => {
    if (batch.sessionId === session.id) { session.transcript.consume(batch.events); update(); }
    else if (session.state.agents.some((run) => run.primeSessionId === session.id && run.workers.some((worker) => worker.sessionId === batch.sessionId))) {
      for (const event of batch.events) if (event.kind === 'notice' && event.level === 'error') terminal.print(`\nAgent: ${safeText(event.text)}\n`);
    }
  });
  const offDisconnect = client.onDisconnect((reason) => { error(reason); process.exitCode = 1; done(); });
  const stop = async () => {
    if (shellId) {
      shellStopped = true;
      if (shellId !== 'starting') {
        const result = await client.invoke('commands:poll', shellId, '\x03');
        if (result.output) terminal.print(safeText(result.output));
      }
    }
    else { await session.stop(); session.transcript.finish(); }
    update();
  };
  const shell = async (command: string) => {
    await session.approve();
    shellId = 'starting';
    shellStopped = false;
    terminal.print(`\n${color(ACCENT, '!', terminal.colored)} ${safeText(command)}\n`);
    update();
    try {
      let result = await client.invoke('commands:exec', command, session.cwd);
      for (;;) {
        if (result.output) terminal.print(safeText(result.output));
        shellId = result.sessionId;
        if (!shellId) {
          const status = shellStopped ? 'Interrupted' : result.exitCode === null ? 'Shell exited' : `Exit code ${result.exitCode}`;
          terminal.print(nested([color(result.exitCode === 0 ? DIM : 31, status, terminal.colored)], { colored: terminal.colored, columns: screenColumns() }).join('\n'));
          break;
        }
        result = await client.invoke('commands:poll', shellId, shellStopped ? '\x03' : '');
      }
    } catch (reason) {
      if (!shellStopped) throw reason;
      terminal.print(nested([color(31, 'Interrupted', terminal.colored)], { colored: terminal.colored, columns: screenColumns() }).join('\n'));
    } finally {
      shellId = null;
    }
  };
  terminal.onSubmit = (text) => {
    if (text === '/exit' || text === '/quit') { done(); return; }
    if (handling) { terminal.editor.set(text); return; }
    handling = true;
    if (text.startsWith('/') && text !== '/clear') echo(text);
    void (text.startsWith('!') ? shell(text.slice(1)) : runCommand(text, session, { newChat: reset, exit: done }))
      .catch(error).finally(() => { handling = false; update(); });
  };
  terminal.onStop = () => { void stop().catch(error); };
  terminal.onInterrupt = (exit) => {
    if (exit) { done(); return; }
    if (session.busy || shellId) { void stop().catch(error); return; }
    if (terminal.editor.text) { terminal.editor.set(''); return; }
    if (Date.now() - lastInterrupt < 1500) done();
    else { lastInterrupt = Date.now(); terminal.flash('Press Ctrl+C again to exit'); }
  };
  terminal.live = (columns) => session.transcript.preview(columns);
  terminal.transcript = (columns) => session.transcript.transcript(columns);
  terminal.onComplete = () => {
    void (async () => {
      const text = terminal.editor.text;
      if (text.startsWith('/') && !text.includes(' ')) {
        const names = [...Object.keys(COMMANDS), ...session.state.skills.map((skill) => skill.id)].filter((name) => `/${name}`.startsWith(text));
        if (names.length === 1) terminal.editor.set(`/${names[0]} `);
        else {
          const picked = await terminal.pick('Commands', names.map((name) => ({ label: `/${name}`, detail: COMMANDS[name] ?? 'Invoke skill', value: name })));
          if (picked) terminal.editor.set(`/${picked} `);
        }
      } else {
        const match = /(?:^|\s)(@[^\s]*)$/.exec(text.slice(0, terminal.editor.cursor));
        if (!match) return;
        const prefix = match[1]!.slice(1);
        const path = resolve(session.cwd, prefix || '.');
        const dir = prefix.endsWith('/') || !prefix ? path : dirname(path);
        const stem = prefix.endsWith('/') || !prefix ? '' : basename(path);
        const entries = (await readdir(dir, { withFileTypes: true })).filter((entry) => entry.name.startsWith(stem));
        const picked = entries.length === 1 ? entries[0] : await terminal.pick('Files', entries.map((entry) => ({ label: entry.name + (entry.isDirectory() ? '/' : ''), value: entry })));
        if (picked) {
          const lead = prefix.slice(0, prefix.length - stem.length);
          const replacement = `@${lead}${picked.name}${picked.isDirectory() ? '/' : ' '}`;
          const at = terminal.editor.cursor - match[1]!.length;
          terminal.editor.text = text.slice(0, at) + replacement + text.slice(terminal.editor.cursor);
          terminal.editor.cursor = at + replacement.length;
        }
      }
      update();
    })().catch(error);
  };
  const signal = () => { void stop().finally(done); };
  process.on('SIGTERM', signal);
  try {
    update();
    if (session.options.prompt || session.attachments.length) {
      await session.send(session.options.prompt);
      update();
    }
    await finished;
    if (shellId) await stop();
    else if (session.busy) await session.stop();
  } finally {
    offState(); offEvents(); offDisconnect();
    process.off('SIGTERM', signal);
  }
}
