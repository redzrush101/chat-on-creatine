import { COMMANDS, COMMAND_PATTERN, runCommand } from './commands';
import { ACCENT, DIM, color, safeText, screenColumns, setTerminalTheme, tilde } from './format';
import { nested, toolHeadline, userRows } from './render';
import type { CliSession } from './session';
import { Transcript } from './transcript';
import { completeFile } from './completion';
import { turnActivity } from '@shared/turn-activity';

export async function interactive(session: CliSession): Promise<void> {
  const terminal = session.terminal!;
  const client = session.client;
  let lastInterrupt = 0;
  let pendingInput = Promise.resolve();
  let shellId: string | null = null;
  let shellStopped = false;
  let done: () => void = () => {};
  const finished = new Promise<void>((resolve) => { done = resolve; });
  const error = (reason: unknown) => terminal.print(`\n${color(31, '●', terminal.colored)} ${color(31, safeText(reason instanceof Error ? reason.message : String(reason)), terminal.colored)}\n`);
  const echo = (text: string) => terminal.print(`\n${userRows(text, { colored: terminal.colored, columns: screenColumns() }).join('\n')}`);
  let busySince: number | null = null;
  /** Per worker chat: when it was first seen working, its tool calls and its latest step. */
  const progress = new Map<string, { since: number; tools: Set<string>; current: string | null }>();
  const workers = () => session.state.agents.find((run) => run.primeSessionId === session.id)?.workers ?? [];
  const reset = () => {
    session.id = null;
    session.mode = 'off';
    session.name = null;
    session.shellContext = '';
    session.transcript = new Transcript((text) => terminal.print(text), terminal.colored);
  };
  const update = () => {
    setTerminalTheme(session.state.config.ui.theme);
    const meta = session.meta;
    if (meta) session.selection = { model: meta.model, reasoning: meta.reasoning };
    const model = session.state.models.models.find((item) => item.id === session.selection.model || item.slugs?.includes(session.selection.model ?? ''));
    const remaining = Math.max(0, Math.round(100 * (1 - (meta?.contextTokens ?? 0) / session.state.config.context.advisoryTokens)));
    terminal.info = `${model?.label ?? session.selection.model ?? 'Account default'}${session.selection.reasoning ? ` ${session.selection.reasoning}` : ''} · ${remaining}% context · ${tilde(session.cwd)}`;
    terminal.hint = shellId ? 'ctrl+c to interrupt the shell' : [
      session.attachments.length ? `${session.attachments.length} attached: ${session.attachments.map((path) => path.split(/[\\/]/).at(-1)).join(', ')}` : '',
      session.shellContext ? 'shell context pending · /context' : ''
    ].filter(Boolean).join(' · ') || '? for shortcuts';
    terminal.mode = session.state.config.yolo ? 'unrestricted tools' : session.state.config.readOnly ? 'read only' : '';
    terminal.commands = [
      ...Object.entries(COMMANDS).map(([name, detail]) => ({ label: `/${name}`, value: `/${name}`, detail })),
      ...session.state.skills.map((skill) => ({ label: `/${skill.id}`, value: `/${skill.id}`, detail: skill.description })),
      ...session.templates.filter((template) => !session.state.skills.some((skill) => skill.id === template.name)).map((template) => ({ label: `/${template.name}`, value: `/${template.name}`, detail: `${template.argumentHint} ${template.description}`.trim() }))
    ];
    const active = workers().filter((worker) => worker.state === 'working' || worker.state === 'queued');
    terminal.agents = active.map((worker) => {
      const entry = progress.get(worker.sessionId) ?? { since: Date.now(), tools: new Set<string>(), current: null };
      progress.set(worker.sessionId, entry);
      const uses = entry.tools.size ? ` · ${entry.tools.size} tool use${entry.tools.size === 1 ? '' : 's'}` : '';
      return { label: worker.label, detail: `${entry.current ?? (worker.state === 'queued' ? 'Waiting for a free slot' : worker.task.split('\n')[0]!)}${uses}`, since: entry.since };
    });
    const working = !!shellId || session.busy;
    busySince = working || active.length ? busySince ?? Date.now() : null;
    const waiting = `Waiting for ${active.length} background agent${active.length === 1 ? '' : 's'} to finish`;
    const activity = meta ? turnActivity(meta, session.state.live[meta.id], [...session.transcript.events.values()]) : null;
    terminal.busy = working ? { verb: shellId ? 'Running shell command' : activity?.label.replace(/…$/, '') ?? session.transcript.activity(), since: session.transcript.since ?? busySince! }
      : active.length ? { verb: waiting, since: busySince! } : null;
    terminal.draw();
  };
  const offState = client.on('state', () => update());
  const offEvents = client.on('session:events', (batch) => {
    if (batch.sessionId === session.id) { session.transcript.consume(batch.events); update(); }
    else if (workers().some((worker) => worker.sessionId === batch.sessionId)) {
      const entry = progress.get(batch.sessionId) ?? { since: Date.now(), tools: new Set<string>(), current: null };
      for (const event of batch.events) {
        if (event.kind === 'tool') { entry.tools.add(event.id); entry.current = toolHeadline(event); }
        if (event.kind === 'notice' && event.level === 'error') terminal.print(`\nAgent: ${safeText(event.text)}\n`);
      }
      progress.set(batch.sessionId, entry);
      update();
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
  const shell = async (command: string, include: boolean) => {
    if (!command.trim()) throw new Error('Usage: !<command> (include output) or !!<command> (local only).');
    await session.approve();
    shellId = 'starting';
    shellStopped = false;
    terminal.print(`\n${color(ACCENT, '!', terminal.colored)} ${safeText(command)}\n`);
    update();
    let output = '';
    try {
      let result = await client.invoke('commands:exec', command, session.cwd);
      for (;;) {
        if (result.output) terminal.print(safeText(result.output));
        output = (output + result.output).slice(-24_000);
        shellId = result.sessionId;
        if (!shellId) {
          const status = shellStopped ? 'Interrupted' : result.exitCode === null ? 'Shell exited' : `Exit code ${result.exitCode}`;
          terminal.print(nested([color(result.exitCode === 0 ? DIM : 31, status, terminal.colored)], { colored: terminal.colored, columns: screenColumns() }).join('\n'));
          if (include) session.addShellContext(command, output, status);
          break;
        }
        result = await client.invoke('commands:poll', shellId, shellStopped ? '\x03' : '');
      }
    } catch (reason) {
      if (!shellStopped) throw reason;
      if (include) session.addShellContext(command, output, 'Interrupted');
      terminal.print(nested([color(31, 'Interrupted', terminal.colored)], { colored: terminal.colored, columns: screenColumns() }).join('\n'));
    } finally {
      shellId = null;
    }
  };
  terminal.onSubmit = (text) => {
    if (text === '/exit') { done(); return; }
    pendingInput = pendingInput.then(async () => {
      if (!text && !session.attachments.length) return;
      if (COMMAND_PATTERN.test(text)) echo(text);
      await (text.startsWith('!') ? shell(text.slice(text.startsWith('!!') ? 2 : 1), !text.startsWith('!!')) : runCommand(text, session, { newChat: reset, exit: done }));
    }).catch((reason: unknown) => {
      if (!text.startsWith('!')) terminal.editor.set([text, terminal.editor.text].filter(Boolean).join('\n'));
      error(reason);
    }).finally(update);
  };
  terminal.onPaste = () => {
    pendingInput = pendingInput.then(() => session.paste()).catch(error).finally(update);
    return pendingInput;
  };
  terminal.onError = error;
  terminal.onModel = () => { pendingInput = pendingInput.then(() => session.cycleModel()).catch(error).finally(update); };
  terminal.onEffort = () => { pendingInput = pendingInput.then(() => session.cycleEffort()).catch(error).finally(update); };
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
        const names = terminal.commands.filter((command) => command.value.startsWith(text));
        if (names.length === 1) terminal.editor.set(`${names[0]!.value} `);
        else {
          const picked = await terminal.pick('Commands', names);
          if (picked) terminal.editor.set(`${picked} `);
        }
      } else {
        await completeFile(terminal, session.cwd);
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
