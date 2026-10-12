import { PassThrough } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import { emitKeypressEvents, type Key } from 'node:readline';
import { Editor } from './editor';
import { clip, color, graphemes, safeText, width } from './format';

export interface Choice<T> { label: string; detail?: string; value: T }
interface Picker {
  title: string;
  choices: Choice<unknown>[];
  index: number;
  query: string;
  resolve(value: unknown): void;
}

function wrap(text: string, columns: number): string[] {
  const lines: string[] = [];
  for (const line of safeText(text).split('\n')) {
    let row = '';
    for (const part of graphemes(line)) {
      if (width(row + part) > columns) { lines.push(row); row = ''; }
      row += part;
    }
    lines.push(row);
  }
  return lines;
}

/** Scrollback holds completed work; only the draft and live preview are redrawn. */
export class Terminal {
  readonly editor = new Editor();
  readonly colored = !process.env.NO_COLOR && process.env.TERM !== 'dumb';
  status = '';
  live = '';
  hints: string[] = [];
  commands: Choice<string>[] = [];
  private detailText: string | null = null;
  private detailOffset = 0;
  private commandIndex = 0;
  private commandDraft = '';
  private commandsHidden = false;
  private rows = 0;
  private cursorRow = 0;
  private picker: Picker | null = null;
  private question: { title: string; secret: boolean; resolve(value: string | null): void } | null = null;
  private savedDraft = '';
  private paste: string | null = null;
  private buffer = '';
  private closed = false;
  private readonly decoder = new StringDecoder('utf8');
  private escapeTimer: NodeJS.Timeout | null = null;
  private readonly input = new PassThrough();
  private readonly onData = (chunk: Buffer) => this.data(this.decoder.write(chunk));
  private readonly onResize = () => { this.clear(); this.draw(); };
  private readonly ticker: NodeJS.Timeout;
  private frame = 0;
  private rendered = '';

  onSubmit: (text: string) => void = () => {};
  onInterrupt: (exit: boolean) => void = () => {};
  onStop: () => void = () => {};
  onExpand: () => void = () => {};
  onComplete: () => void = () => {};

  constructor() {
    emitKeypressEvents(this.input);
    this.input.on('keypress', (sequence: string, key: Key) => this.key(sequence, key));
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on('data', this.onData);
    process.stdout.on('resize', this.onResize);
    process.stdout.write('\x1b[?2004h');
    this.ticker = setInterval(() => { this.frame++; if (this.live) this.draw(); }, 150);
  }

  print(text: string): void {
    if (this.closed) return;
    this.clear();
    process.stdout.write(text.endsWith('\n') ? text : `${text}\n`);
    this.draw();
  }

  set details(text: string | null) {
    if (this.detailText !== text) this.detailOffset = 0;
    this.detailText = text;
  }

  draw(): void {
    if (this.closed) return;
    const columns = Math.max(12, (process.stdout.columns || 80) - 1);
    const height = Math.max(8, (process.stdout.rows || 24) - 2);
    const lines: string[] = [];
    let cursorRow = 0;
    let cursorCol = 0;
    if (this.picker) {
      lines.push(color(90, '─'.repeat(columns), this.colored));
      lines.push(color(36, clip(this.picker.title, columns), this.colored), this.picker.query ? clip(`Search: ${this.picker.query}`, columns) : '');
      const choices = this.filteredChoices();
      const count = Math.min(choices.length, height - 6);
      const start = Math.min(Math.max(0, this.picker.index - Math.floor(count / 2)), Math.max(0, choices.length - count));
      for (let i = start; i < start + count; i++) {
        const choice = choices[i]!;
        const text = clip(`${i === this.picker.index ? '›' : ' '} ${choice.label}${choice.detail ? `  ${choice.detail}` : ''}`, columns);
        lines.push(color(i === this.picker.index ? 36 : 39, text, this.colored));
      }
      if (!choices.length) lines.push('No matches.');
      lines.push('', color(90, clip('↑/↓ select · type to filter · Enter confirm · Esc cancel', columns), this.colored));
      cursorRow = lines.length - 1;
    } else {
      const commands = this.commandMatches();
      const commandCount = Math.min(6, commands.length);
      const reserved = 6 + (commandCount ? commandCount + 1 : 0) + (this.question ? 1 : 0);
      const liveCount = this.detailText ? 3 : Math.max(1, Math.min(8, height - reserved - 1));
      if (this.detailText) {
        const detailRows = wrap(this.detailText, columns);
        const count = Math.max(1, Math.min(12, height - reserved - (this.live ? liveCount + 1 : 0) - 2));
        this.detailOffset = Math.min(this.detailOffset, Math.max(0, detailRows.length - count));
        lines.push(color(36, clip(`Tool details · Ctrl+O hide · PgUp/PgDn scroll (${this.detailOffset + 1}–${Math.min(detailRows.length, this.detailOffset + count)}/${detailRows.length})`, columns), this.colored));
        lines.push(...detailRows.slice(this.detailOffset, this.detailOffset + count), '');
      }
      if (this.live) {
        const spinner = ['·', '✶', '✳', '✴'][this.frame % 4];
        const preview = wrap(`${spinner} ${this.live}`, columns);
        lines.push(...preview.slice(-liveCount), '');
      }
      lines.push(color(90, '─'.repeat(columns), this.colored));
      const prefix = this.question ? '? ' : '› ';
      if (this.question) lines.push(clip(this.question.title, columns));
      const draft = this.question?.secret ? '•'.repeat(graphemes(this.editor.text).length) : this.editor.text;
      const before = this.question?.secret ? '•'.repeat(graphemes(this.editor.text.slice(0, this.editor.cursor)).length) : this.editor.text.slice(0, this.editor.cursor);
      const draftRows = wrap(prefix + draft, columns);
      if (commands.length) {
        const ghost = commands[this.commandIndex]!.value.slice(draft.length);
        const last = draftRows.length - 1;
        draftRows[last] += color(90, clip(ghost, Math.max(0, columns - width(draftRows[last]!))), this.colored);
      }
      const beforeRows = wrap(prefix + before, columns);
      const maxDraft = Math.max(2, height - lines.length - 3);
      const start = Math.max(0, beforeRows.length - maxDraft);
      cursorRow = lines.length + beforeRows.length - 1 - start;
      cursorCol = width(beforeRows.at(-1) ?? '');
      lines.push(...draftRows.slice(start, start + maxDraft));
      if (commands.length) {
        lines.push(color(90, clip('Commands · ↑/↓ select · Tab complete · Enter run', columns), this.colored));
        const start = Math.min(Math.max(0, this.commandIndex - Math.floor(commandCount / 2)), Math.max(0, commands.length - commandCount));
        for (let i = start; i < start + commandCount; i++) {
          const command = commands[i]!;
          lines.push(color(i === this.commandIndex ? 36 : 39, clip(`${i === this.commandIndex ? '›' : ' '} ${command.label}  ${command.detail ?? ''}`, columns), this.colored));
        }
      }
      lines.push(color(90, '─'.repeat(columns), this.colored));
      lines.push(color(90, clip(this.status || 'Enter send · Ctrl+J newline · /help · /exit quit', columns), this.colored));
      if (this.hints.length && !this.question) {
        const hints = clip(this.hints.join('  '), columns);
        lines.push(hints.startsWith('/exit')
          ? `${color(36, '/exit', this.colored)}${color(90, hints.slice(5), this.colored)}`
          : color(90, hints, this.colored));
      }
    }
    const rendered = `${lines.join('\n')}|${cursorRow}:${cursorCol}`;
    if (this.rows && rendered === this.rendered) return;
    this.clear();
    this.rendered = rendered;
    process.stdout.write(`\x1b[?25l${lines.join('\n')}\r`);
    const up = lines.length - 1 - cursorRow;
    if (up > 0) process.stdout.write(`\x1b[${up}A`);
    if (cursorCol > 0) process.stdout.write(`\x1b[${cursorCol}C`);
    process.stdout.write(this.picker ? '\x1b[?25l' : '\x1b[?25h');
    this.rows = lines.length;
    this.cursorRow = cursorRow;
  }

  pick<T>(title: string, choices: Choice<T>[], selected = 0): Promise<T | null> {
    if (!choices.length) return Promise.resolve(null);
    return new Promise((resolve) => {
      this.picker = { title, choices, index: selected, query: '', resolve: (value) => resolve(value as T | null) };
      this.draw();
    });
  }

  ask(title: string, secret = false): Promise<string | null> {
    this.savedDraft = this.editor.text;
    this.editor.set('');
    return new Promise((resolve) => { this.question = { title, secret, resolve }; this.draw(); });
  }

  close(): void {
    if (this.closed) return;
    this.clear();
    this.closed = true;
    clearInterval(this.ticker);
    if (this.escapeTimer) clearTimeout(this.escapeTimer);
    this.picker?.resolve(null);
    this.question?.resolve(null);
    process.stdout.write('\x1b[?2004l\x1b[?25h\x1b[0m');
    process.stdin.off('data', this.onData);
    process.stdout.off('resize', this.onResize);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    this.input.destroy();
  }

  private clear(): void {
    if (!this.rows) return;
    process.stdout.write(`\r${this.cursorRow ? `\x1b[${this.cursorRow}A` : ''}\x1b[J`);
    this.rows = 0;
    this.cursorRow = 0;
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
    if (this.detailText && (key.name === 'pageup' || key.name === 'pagedown')) {
      this.detailOffset = Math.max(0, this.detailOffset + (key.name === 'pageup' ? -8 : 8));
      this.draw(); return;
    }
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
      if (action === 'submit') { const text = this.editor.submit(); if (text) this.onSubmit(text); }
      if (action === 'interrupt' || action === 'exit') this.onInterrupt(action === 'exit');
      if (action === 'stop') this.onStop();
      if (action === 'expand') this.onExpand();
      if (action === 'complete') this.onComplete();
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
