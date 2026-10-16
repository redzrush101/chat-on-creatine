import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { emitKeypressEvents, type Key } from 'node:readline';
import { Editor } from './editor';
import { ACCENT, DIM, clip, color, ellipsis, graphemes, safeText, screenColumns, width } from './format';
import { duration } from './render';
import { Viewer } from './viewer';
import { editExternal } from './external-editor';

export interface Choice<T> { label: string; detail?: string; value: T; current?: boolean }
interface Picker {
  title: string;
  choices: Choice<unknown>[];
  index: number;
  query: string;
  resolve(value: unknown): void;
}

const SPINNER = ['·', '✢', '✳', '✶', '✻', '✽', '✽', '✻', '✶', '✳', '✢', '·'];
const SHORTCUTS = [
  ['/ for commands', '! for shell commands', '@ for file paths'],
  ['esc to interrupt', 'ctrl+o for transcript', 'tab to complete'],
  ['ctrl+j for newline', '↑↓ for history', 'ctrl+v or alt+v to paste'],
  ['ctrl+g for editor', 'ctrl+p next model', 'shift+tab reasoning'],
  ['ctrl+c to clear or exit', 'ctrl+l to clear screen']
];

/** Character-wraps the draft so the cursor maps onto the same rows; continuation rows are indented. */
function wrapDraft(text: string, columns: number): string[] {
  const rows: string[] = [];
  let row = '';
  let cells = 0;
  for (const part of graphemes(text)) {
    if (part === '\n') { rows.push(row); row = '  '; cells = 2; continue; }
    const size = width(part);
    if (cells + size > columns) { rows.push(row); row = '  '; cells = 2; }
    row += part;
    cells += size;
  }
  rows.push(row);
  return rows;
}

/** Scrollback holds completed work; only the live rows, the prompt and the footer are redrawn. */
export class Terminal {
  readonly editor = new Editor();
  readonly colored = !process.env.NO_COLOR && process.env.TERM !== 'dumb';
  /** Right side of the footer: model, effort, context and folder. */
  info = '';
  /** Left side of the footer, after the permission badge. */
  hint = '? for shortcuts';
  /** A permission mode worth a badge, such as unrestricted tools. */
  mode = '';
  reducedMotion = false;
  /** The running turn's gerund and start time, for the spinner line. */
  busy: { verb: string; since: number } | null = null;
  commands: Choice<string>[] = [];
  /** Working background agents, listed under the footer as Claude Code does. */
  agents: { label: string; detail: string; since: number }[] = [];
  /** Live rows above the prompt; read on every frame so running calls stay current. */
  live: (columns: number) => string[] = () => [];
  /** Every event in full, for the Ctrl+O transcript. */
  transcript: (columns: number) => string[] = () => [];
  private viewer: Viewer | null = null;
  private held: string[] = [];
  private shortcuts = false;
  private notice: { text: string; timer: NodeJS.Timeout } | null = null;
  private commandIndex = 0;
  private commandDraft = '';
  private commandsHidden = false;
  private rows = 0;
  private cursorRow = 0;
  private picker: Picker | null = null;
  private question: { title: string; secret: boolean; resolve(value: string | null): void } | null = null;
  private savedDraft = '';
  private paste: string | null = null;
  private pasteKeys: { sequence: string; key: Key }[] | null = null;
  private buffer = '';
  private closed = false;
  private suspended = false;
  private readonly decoder = new StringDecoder('utf8');
  private escapeTimer: NodeJS.Timeout | null = null;
  private readonly input = new PassThrough();
  private readonly onData = (chunk: Buffer) => this.data(this.decoder.write(chunk));
  private readonly onResize = () => { this.rendered = ''; this.draw(); };
  private readonly ticker: NodeJS.Timeout;
  private frame = 0;
  private rendered = '';
  private renderedLines: string[] = [];

  onSubmit: (text: string) => void = () => {};
  onInterrupt: (exit: boolean) => void = () => {};
  onStop: () => void = () => {};
  onComplete: () => void = () => {};
  onPaste: () => Promise<void> = async () => {};
  onModel: () => void = () => {};
  onEffort: () => void = () => {};
  onError: (error: unknown) => void = () => {};

  constructor() {
    emitKeypressEvents(this.input);
    this.input.on('keypress', (sequence: string, key: Key) => this.key(sequence, key));
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', this.onData);
    process.stdout.on('resize', this.onResize);
    process.stdout.write('\x1b[?2004h');
    this.ticker = setInterval(() => { if (this.busy && !this.viewer) { if (!this.reducedMotion) this.frame++; this.draw(); } }, 120);
  }

  print(text: string): void {
    if (this.closed) return;
    const block = text.endsWith('\n') ? text : `${text}\n`;
    if (this.viewer || this.suspended) { this.held.push(block); this.draw(); return; }
    this.render(block);
  }

  /** Clears the screen and its scrollback, then draws the prompt at the top. */
  clearScreen(): void {
    this.rows = 0;
    this.cursorRow = 0;
    this.rendered = '';
    process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
    this.draw();
  }

  /** A short message in the footer that clears itself. */
  flash(text: string): void {
    if (this.notice) clearTimeout(this.notice.timer);
    this.notice = { text, timer: setTimeout(() => { this.notice = null; this.draw(); }, 2000) };
    this.draw();
  }

  draw(): void {
    if (this.closed || this.suspended) return;
    if (this.viewer) {
      process.stdout.write(`\x1b[?2026h${this.viewer.frame(screenColumns(), process.stdout.rows || 24)}\x1b[?2026l`);
      return;
    }
    this.render('');
  }

  pick<T>(title: string, choices: Choice<T>[], selected = 0): Promise<T | null> {
    if (!choices.length) return Promise.resolve(null);
    this.closeViewer();
    return new Promise((resolve) => {
      this.picker = { title, choices, index: selected, query: '', resolve: (value) => resolve(value as T | null) };
      this.draw();
    });
  }

  ask(title: string, secret = false, initial = ''): Promise<string | null> {
    this.closeViewer();
    this.savedDraft = this.editor.text;
    this.editor.set(initial);
    return new Promise((resolve) => { this.question = { title, secret, resolve }; this.draw(); });
  }

  async editDraft(): Promise<void> {
    if (this.suspended || this.question || this.picker) return;
    this.closeViewer();
    this.suspended = true;
    process.stdout.write(`${this.erase()}\x1b[?2004l\x1b[?25h`);
    process.stdin.off('data', this.onData);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    try { this.editor.set(safeText(await editExternal(this.editor.text))); }
    finally {
      this.suspended = false;
      if (!this.closed) {
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on('data', this.onData);
        process.stdout.write('\x1b[?2004h');
        this.render(this.held.splice(0).join(''));
      }
    }
  }

  close(): void {
    if (this.closed) return;
    this.closeViewer();
    process.stdout.write(this.erase());
    this.closed = true;
    clearInterval(this.ticker);
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    if (this.notice) clearTimeout(this.notice.timer);
    this.picker?.resolve(null);
    this.question?.resolve(null);
    process.stdout.write('\x1b[?2004l\x1b[?25h\x1b[0m');
    process.stdin.off('data', this.onData);
    process.stdout.off('resize', this.onResize);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    this.input.destroy();
  }

  /** Writes `text` into scrollback above the live area and redraws it, as one synchronized update. */
  private render(text: string): void {
    const { lines, cursorRow, cursorCol } = this.layout();
    const frame = `${lines.join('\n')}|${cursorRow}:${cursorCol}`;
    if (!text && this.rows && frame === this.rendered) return;
    let output = '\x1b[?2026h\x1b[?25l';
    let row = this.cursorRow;
    const move = (target: number) => {
      const delta = target - row;
      if (delta) output += `\x1b[${Math.abs(delta)}${delta > 0 ? 'B' : 'A'}`;
      output += '\r';
      row = target;
    };
    // A stable viewport only needs its changed rows (usually the spinner or draft).
    if (!text && this.rendered && this.rows === lines.length) {
      for (let index = 0; index < lines.length; index++) {
        if (lines[index] === this.renderedLines[index]) continue;
        move(index);
        output += `\x1b[2K${lines[index]}`;
      }
    } else {
      output += `${this.erase()}${text}${lines.join('\n')}`;
      row = lines.length - 1;
    }
    move(cursorRow);
    if (cursorCol > 0) output += `\x1b[${cursorCol}C`;
    output += `${this.picker ? '' : '\x1b[?25h'}\x1b[?2026l`;
    process.stdout.write(output);
    this.rendered = frame;
    this.renderedLines = lines;
    this.rows = lines.length;
    this.cursorRow = cursorRow;
  }

  private erase(): string {
    if (!this.rows) return '';
    const text = `\r${this.cursorRow ? `\x1b[${this.cursorRow}A` : ''}\x1b[J`;
    this.rows = 0;
    this.cursorRow = 0;
    return text;
  }

  private layout(): { lines: string[]; cursorRow: number; cursorCol: number } {
    const columns = screenColumns();
    const height = Math.max(6, (process.stdout.rows || 24) - 1);
    const c = this.colored;
    const rule = color(DIM, '─'.repeat(columns), c);
    const bottom: string[] = [];
    let cursorRow = 0;
    let cursorCol = 0;
    if (this.picker) {
      bottom.push('', color(ACCENT, '─'.repeat(columns), c), ` ${color(1, clip(this.picker.title, columns - 1), c)}`);
      if (this.picker.query) bottom.push(color(DIM, ` ${clip(`Filter: ${this.picker.query}`, columns - 1)}`, c));
      bottom.push('');
      const choices = this.filteredChoices();
      const count = Math.max(1, Math.min(choices.length, height - bottom.length - 3));
      const start = Math.min(Math.max(0, this.picker.index - Math.floor(count / 2)), Math.max(0, choices.length - count));
      const labelWidth = Math.min(32, Math.max(...choices.map((choice) => width(choice.label) + (choice.current ? 2 : 0)), 0));
      for (let i = start; i < start + count && i < choices.length; i++) {
        const choice = choices[i]!;
        const selected = i === this.picker.index;
        const label = `${choice.label}${choice.current ? ' ✓' : ''}`;
        const padded = label + ' '.repeat(Math.max(0, labelWidth - width(label)));
        const row = ellipsis(`${padded}${choice.detail ? `  ${choice.detail}` : ''}`, columns - 3);
        bottom.push(`${selected ? color(ACCENT, ' ❯', c) : '  '} ${color(selected ? ACCENT : choice.current ? 32 : 39, row, c)}`);
      }
      if (!choices.length) bottom.push(color(DIM, '   No matches', c));
      bottom.push('', color(DIM, clip(' ↑↓ to select · enter to confirm · esc to cancel · type to filter', columns), c));
      cursorRow = bottom.length - 1;
    } else {
      if (this.busy) {
        const spinner = color(ACCENT, SPINNER[this.frame % SPINNER.length]!, c);
        bottom.push('', `${spinner} ${color(ACCENT, `${this.busy.verb}…`, c)} ${color(DIM, `(${duration(Date.now() - this.busy.since)} · esc to interrupt)`, c)}`);
      }
      bottom.push('');
      if (this.question) bottom.push(` ${color(1, clip(this.question.title, columns - 1), c)}`);
      bottom.push(rule);
      const secret = (text: string) => this.question?.secret ? '•'.repeat(graphemes(text).length) : text;
      const prefix = this.question ? '? ' : '❯ ';
      const draft = secret(this.editor.text);
      const rows = wrapDraft(prefix + draft, columns);
      const before = wrapDraft(prefix + secret(this.editor.text.slice(0, this.editor.cursor)), columns);
      const commands = this.commandMatches();
      if (commands.length) {
        const ghost = commands[this.commandIndex]!.value.slice(draft.length);
        rows[rows.length - 1] += color(DIM, clip(ghost, Math.max(0, columns - width(rows.at(-1)!))), c);
      }
      if (!draft && !this.question) rows[0] += color(DIM, clip(this.busy ? 'Steer the running task, or queue with /queue' : 'Try "fix the failing tests" or /help', columns - 2), c);
      const maxDraft = Math.max(1, height - bottom.length - 3);
      const first = Math.max(0, before.length - maxDraft);
      cursorRow = bottom.length + before.length - 1 - first;
      cursorCol = width(before.at(-1) ?? '');
      bottom.push(...rows.slice(first, first + maxDraft).map((row, index) => index === 0 && first === 0 ? `${color(1, row.slice(0, 2), c)}${row.slice(2)}` : row), rule);
      bottom.push(...this.below(commands, columns));
    }
    const room = Math.max(0, height - bottom.length);
    const live = room ? this.live(columns).slice(-room) : [];
    let lines = [...live, ...bottom];
    cursorRow += live.length;
    if (lines.length > height) {
      const cut = lines.length - height;
      lines = lines.slice(cut);
      cursorRow = Math.max(0, cursorRow - cut);
    }
    // Physical wrapping would add rows the cursor bookkeeping cannot see.
    return { lines: lines.map((line) => ellipsis(line, columns)), cursorRow, cursorCol };
  }

  /** Under the prompt: command suggestions, the shortcut list, or the footer. */
  private below(commands: Choice<string>[], columns: number): string[] {
    const c = this.colored;
    if (commands.length) {
      const count = Math.min(6, commands.length);
      const start = Math.min(Math.max(0, this.commandIndex - Math.floor(count / 2)), Math.max(0, commands.length - count));
      const name = Math.min(18, Math.max(...commands.map((command) => width(command.label))));
      return commands.slice(start, start + count).map((command, offset) => {
        const selected = start + offset === this.commandIndex;
        const text = ellipsis(`${command.label.padEnd(name)}  ${command.detail ?? ''}`, columns - 2);
        return `  ${selected ? color(ACCENT, text, c) : color(DIM, text, c)}`;
      });
    }
    if (this.shortcuts) {
      const cell = Math.floor((columns - 2) / 3);
      return cell >= 22
        ? SHORTCUTS.map((row) => `  ${row.map((item) => color(DIM, item.padEnd(cell), c)).join('')}`)
        : SHORTCUTS.flat().map((item) => `  ${color(DIM, item, c)}`);
    }
    const badge = this.mode ? `${color(ACCENT, `⏵⏵ ${this.mode}`, c)}${color(DIM, ' · ', c)}` : '';
    const left = `  ${badge}${color(DIM, this.notice?.text ?? this.hint, c)}`;
    const room = columns - width(left) - 2;
    const right = ellipsis(this.info, Math.max(0, room));
    const footer = room > 12 ? [`${left}${' '.repeat(Math.max(2, columns - width(left) - width(right)))}${color(DIM, right, c)}`]
      : [left, `  ${color(DIM, ellipsis(this.info, columns - 2), c)}`];
    if (!this.agents.length) return footer;
    const name = Math.min(24, Math.max(...this.agents.map((agent) => width(agent.label))));
    return [...footer, '', `  ${color(1, '● main', c)}`, ...this.agents.map((agent) => {
      const elapsed = duration(Date.now() - agent.since);
      const text = ellipsis(`○ ${ellipsis(agent.label, name).padEnd(name)}  ${agent.detail}`, columns - width(elapsed) - 6);
      return `  ${color(DIM, text, c)}${' '.repeat(Math.max(2, columns - 2 - width(text) - width(elapsed)))}${color(DIM, elapsed, c)}`;
    })];
  }

  private openViewer(): void {
    if (this.viewer || this.picker) return;
    process.stdout.write(`${this.erase()}\x1b[?1049h\x1b[?25l`);
    this.viewer = new Viewer(this.transcript, this.colored);
    this.draw();
  }

  private closeViewer(): void {
    if (!this.viewer) return;
    this.viewer = null;
    process.stdout.write('\x1b[?1049l');
    this.rows = 0;
    this.rendered = '';
    const held = this.held.join('');
    this.held = [];
    this.render(held);
  }

  private data(chunk: string): void {
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    this.buffer += chunk;
    while (this.buffer) {
      const marker = this.paste === null ? '\x1b[200~' : '\x1b[201~';
      const index = this.buffer.indexOf(marker);
      if (index >= 0) {
        const text = this.buffer.slice(0, index);
        if (this.paste === null) { this.input.write(text); this.paste = ''; }
        else { this.editor.insert(this.paste + text); this.paste = null; this.draw(); }
        this.buffer = this.buffer.slice(index + marker.length);
      } else {
        let partial = 0;
        for (let n = 1; n < marker.length; n++) if (this.buffer.endsWith(marker.slice(0, n))) partial = n;
        const text = this.buffer.slice(0, this.buffer.length - partial);
        this.buffer = this.buffer.slice(this.buffer.length - partial);
        if (this.paste !== null) this.paste += text;
        else this.input.write(text);
        if (partial && this.paste === null) this.escapeTimer = setTimeout(() => {
          this.input.write(this.buffer);
          this.buffer = '';
        }, 35);
        break;
      }
    }
  }

  private key(sequence: string, key: Key): void {
    if (this.pasteKeys && !this.question && !this.picker && key.name !== 'escape' && !(key.ctrl && key.name === 'c')) {
      this.pasteKeys.push({ sequence, key });
      return;
    }
    if (this.viewer) {
      if (!this.viewer.key(sequence, key, process.stdout.rows || 24)) this.closeViewer();
      else this.draw();
      return;
    }
    if (this.picker) {
      const picker = this.picker;
      const choices = this.filteredChoices();
      if (key.name === 'up' && choices.length) picker.index = (picker.index + choices.length - 1) % choices.length;
      if (key.name === 'down' && choices.length) picker.index = (picker.index + 1) % choices.length;
      if (key.name === 'escape' || key.ctrl && key.name === 'c' || key.name === 'return') {
        if (key.name !== 'return' || choices.length) {
          this.picker = null;
          picker.resolve(key.name === 'return' ? choices[picker.index]!.value : null);
        }
      } else if (key.name === 'backspace') {
        picker.query = graphemes(picker.query).slice(0, -1).join(''); picker.index = 0;
      } else if (!key.ctrl && !key.meta && sequence && !sequence.startsWith('\x1b')) {
        picker.query += safeText(sequence); picker.index = 0;
      }
      this.draw(); return;
    }
    if (!this.question && (key.ctrl || key.meta) && key.name === 'v') {
      this.pasteKeys = [];
      const resume = () => {
        const keys = this.pasteKeys ?? [];
        this.pasteKeys = null;
        if (this.closed) return;
        for (const { sequence, key } of keys) this.key(sequence, key);
        this.draw();
      };
      void this.onPaste().then(resume, resume);
      return;
    }
    if (sequence === '?' && !this.editor.text && !this.question) { this.shortcuts = !this.shortcuts; this.draw(); return; }
    this.shortcuts = false;
    const commands = this.commandMatches();
    if (commands.length && ['up', 'down', 'tab', 'return', 'escape'].includes(key.name ?? '') && !key.ctrl && !key.meta && !key.shift) {
      if (key.name === 'up') this.commandIndex = (this.commandIndex + commands.length - 1) % commands.length;
      if (key.name === 'down') this.commandIndex = (this.commandIndex + 1) % commands.length;
      if (key.name === 'escape') this.commandsHidden = true;
      if (key.name === 'tab' || key.name === 'return') {
        this.editor.set(commands[this.commandIndex]!.value + (key.name === 'tab' ? ' ' : ''));
        if (key.name === 'return') this.onSubmit(this.editor.submit());
      }
      this.draw(); return;
    }
    const action = this.editor.key(sequence, key);
    if (this.question && ['submit', 'stop', 'interrupt', 'exit'].includes(action)) {
      const question = this.question;
      const answer = action === 'submit' ? this.editor.text : null;
      this.question = null;
      this.editor.set(this.savedDraft);
      question.resolve(answer);
    } else if (!this.question) {
      if (action === 'submit') this.onSubmit(this.editor.submit());
      if (action === 'interrupt' || action === 'exit') this.onInterrupt(action === 'exit');
      if (action === 'stop') this.onStop();
      if (action === 'expand') { this.openViewer(); return; }
      if (action === 'clear') { this.clearScreen(); return; }
      if (action === 'complete') this.onComplete();
      if (action === 'external') { void this.editDraft().catch((error: unknown) => this.onError(error)); return; }
      if (action === 'model') this.onModel();
      if (action === 'effort') this.onEffort();
    }
    this.draw();
  }

  private filteredChoices(): Choice<unknown>[] {
    const picker = this.picker;
    if (!picker) return [];
    const query = picker.query.toLocaleLowerCase();
    return picker.choices.filter((choice) => `${choice.label} ${choice.detail ?? ''}`.toLocaleLowerCase().includes(query));
  }

  private commandMatches(): Choice<string>[] {
    const draft = this.editor.text;
    if (draft !== this.commandDraft) {
      this.commandDraft = draft;
      this.commandIndex = 0;
      this.commandsHidden = false;
    }
    if (this.question || this.commandsHidden || !/^\/\S*$/.test(draft)) return [];
    const matches = this.commands.filter((command) => command.value.startsWith(draft));
    this.commandIndex = Math.min(this.commandIndex, Math.max(0, matches.length - 1));
    return matches;
  }
}
