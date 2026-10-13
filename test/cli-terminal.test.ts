import { Terminal as Emulator } from '@xterm/xterm';
import { expect, it, vi } from 'vitest';
import { Terminal } from '../src/cli/terminal';

it('keeps the activity line next to output when long attachment footers redraw in a narrow terminal', async () => {
  const columns = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
  const rows = Object.getOwnPropertyDescriptor(process.stdout, 'rows');
  const raw = Object.getOwnPropertyDescriptor(process.stdin, 'setRawMode');
  const output: string[] = [];
  vi.useFakeTimers();
  Object.defineProperty(process.stdout, 'columns', { configurable: true, value: 40 });
  Object.defineProperty(process.stdout, 'rows', { configurable: true, value: 30 });
  Object.defineProperty(process.stdin, 'setRawMode', { configurable: true, value: () => process.stdin });
  vi.spyOn(process.stdin, 'resume').mockReturnValue(process.stdin);
  vi.spyOn(process.stdin, 'pause').mockReturnValue(process.stdin);
  vi.spyOn(process.stdout, 'write').mockImplementation((text) => { output.push(String(text)); return true; });
  const terminal = new Terminal();
  const emulator = new Emulator({ cols: 40, rows: 30, allowProposedApi: true });
  try {
    terminal.print('Attached image.png');
    terminal.busy = { verb: 'Working', since: Date.now() };
    for (let i = 0; i < 12; i++) {
      terminal.hint = `Image attached: clipboard-${'long-filename-'.repeat(8)}${i}.png`;
      terminal.draw();
    }
    terminal.hint = '? for shortcuts';
    terminal.editor.set('x'.repeat(37));
    terminal.draw();
    const screen = output.join('').replace(/\r?\n/g, '\r\n');
    vi.useRealTimers();
    await new Promise<void>((resolve) => emulator.write(screen, resolve));
    const lines = Array.from({ length: emulator.buffer.active.length }, (_, row) => emulator.buffer.active.getLine(row)?.translateToString(true) ?? '');
    const attached = lines.findIndex((line) => line.includes('Attached image.png'));
    const activity = lines.findLastIndex((line) => line.includes('Working'));
    expect(attached).toBeGreaterThanOrEqual(0);
    expect(activity - attached).toBeLessThanOrEqual(3);
    expect(lines.filter((line) => line.includes('Working'))).toHaveLength(1);
    expect(emulator.buffer.active.baseY).toBe(0);
    expect(emulator.buffer.active.cursorX).toBe(39);
    expect(emulator.buffer.active.cursorY).toBe(lines.findIndex((line) => line.startsWith('❯ ')));
  } finally {
    terminal.close();
    emulator.dispose();
    vi.restoreAllMocks();
    vi.useRealTimers();
    for (const [target, name, descriptor] of [[process.stdout, 'columns', columns], [process.stdout, 'rows', rows], [process.stdin, 'setRawMode', raw]] as const) {
      if (descriptor) Object.defineProperty(target, name, descriptor);
      else Reflect.deleteProperty(target, name);
    }
  }
});
