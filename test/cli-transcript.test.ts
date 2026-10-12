import { expect, it } from 'vitest';
import type { SessionEvent } from '../src/shared/types';
import { stripVTControlCharacters } from 'node:util';
import { wrap } from '../src/cli/format';
import { markdown } from '../src/cli/markdown';
import { Transcript } from '../src/cli/transcript';

const command = (status: 'running' | 'ok', output = ''): SessionEvent => ({
  id: 'command', at: 1, kind: 'tool', surface: 'core', name: 'exec_command', args: { cmd: 'uname -r' }, status, endedAt: status === 'ok' ? 2 : null,
  output: status === 'ok' ? [{ type: 'exec', command: 'uname -r', cwd: null, exitCode: 0, sessionId: null, running: false, output }] : []
});

it('commits finished blocks of a streamed answer once and keeps the growing block live', () => {
  const output: string[] = [];
  const transcript = new Transcript((text) => output.push(text), false);
  const answer: SessionEvent = { id: 'long', at: 1, kind: 'assistant', messageId: 'm', channel: 'final', model: null, text: 'Para 1.\n\nPara 2.\n\nPartial', streaming: true };
  transcript.consume([answer]);
  expect(output.join('')).toBe('\n● Para 1.\n\n  Para 2.\n');
  expect(transcript.preview(80)).toEqual(['', '  Partial']);
  const finished = { ...answer, text: 'Para 1.\n\nPara 2.\n\nLast paragraph.', streaming: false };
  transcript.consume([finished, finished]);
  expect(output.join('')).toBe('\n● Para 1.\n\n  Para 2.\n\n  Last paragraph.\n');
  expect(transcript.preview(80)).toEqual([]);
});

it('prints a reply once when its citation metadata changes after the cited block is committed', () => {
  const output: string[] = [];
  const transcript = new Transcript((text) => output.push(text), false);
  const marker = '\ue200cite\ue202turn0search0\ue201';
  const source = { title: 'Announcing Rust', url: 'https://blog.rust-lang.org/1.99', domain: 'blog.rust-lang.org', ref: 'turn0search0' };
  const answer: SessionEvent = { id: 'cite', at: 1, kind: 'assistant', messageId: 'm', channel: 'final', model: null, streaming: true,
    text: `Rust 1.99 is out ${marker}.\n\nMore`, citations: [{ marker, sources: [source] }] };
  transcript.consume([answer, { ...answer, streaming: false, text: `Rust 1.99 is out ${marker}.\n\nMore detail.`, citations: [{ marker, sources: [{ ...source, domain: 'Rust Blog' }] }] }]);
  expect(output.join('')).toBe('\n● Rust 1.99 is out (blog.rust-lang.org).\n\n  More detail.\n');
});

it('highlights fenced code without its fences and accepts a late final extension', () => {
  const output: string[] = [];
  const transcript = new Transcript((text) => output.push(text), true);
  const answer: SessionEvent = { id: 'code', at: 1, kind: 'assistant', messageId: 'm', channel: 'final', model: null, text: '```ts\n', streaming: true };
  transcript.consume([answer, { ...answer, text: '```ts\nconst value = 42;\n' }]);
  expect(output).toHaveLength(0);
  const final = { ...answer, text: '```ts\nconst value = 42;\n```\nDone.', streaming: false };
  transcript.consume([final]);
  transcript.consume([{ ...final, text: `${final.text} All checks passed.` }]);
  const raw = output.join('');
  const text = stripVTControlCharacters(raw);
  expect(raw).toContain('\x1b[35mconst');
  expect(text).toContain('All checks passed.');
  expect(text).not.toContain('```');
  expect(text.split('const value = 42;')).toHaveLength(2);
  expect(text.split('●')).toHaveLength(2);
});

it.each([
  ['a table', '| Name | Size |\n|:--|--:|\n| **a.ts** | 12 |', ['┌──────┬──────┐', '│ Name │ Size │', '├──────┼──────┤', '│ a.ts │   12 │', '└──────┴──────┘']],
  ['nested and task lists', '- one\n  - inner\n- [x] done\n\n1. first\n2. second', ['• one', '  ◦ inner', '☒ done', '', '1. first', '2. second']],
  ['quotes, rules and links', '> quoted *text*\n\n---\n\n[docs](https://example.com) and ~~old~~', ['│ quoted text', '', '───', '', 'docs (https://example.com) and old']]
])('renders %s', (_name, source, rows) => {
  expect(markdown(source, false, 40).map((line) => line.text.replace(/─{4,}$/, '───'))).toEqual(rows);
});

it('shows running calls live, prints each finished call once and folds long output', () => {
  const output: string[] = [];
  const transcript = new Transcript((text) => output.push(text), false);
  const assistant: SessionEvent = { id: 'answer', at: 1, kind: 'assistant', messageId: 'm', channel: 'final', model: null, text: 'Hello', streaming: true };
  transcript.consume([assistant, command('running')]);
  expect(output).toHaveLength(0);
  expect(transcript.preview(80)).toEqual(['', '● Hello', '', '● Bash(uname -r)', '  ⎿  Running…']);
  expect(transcript.activity()).toBe('Running');
  const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
  transcript.consume([command('ok', lines.join('\n')), { ...assistant, text: 'Hello world', streaming: false }]);
  transcript.consume([command('ok', lines.join('\n')), { ...assistant, text: 'Hello world', streaming: false }]);
  expect(output.join('')).toBe('\n● Bash(uname -r)\n  ⎿  line 1\n     line 2\n     line 3\n     … +17 lines (ctrl+o to expand)\n\n● Hello world\n');
  expect(transcript.preview(80)).toEqual([]);
});

it('leaves plan, script and agent plumbing to the rows that tell it better', () => {
  const output: string[] = [];
  const transcript = new Transcript((text) => output.push(text), false);
  transcript.consume([
    { id: 'plan-call', at: 1, kind: 'tool', surface: 'core', name: 'update_plan', args: { plan: [] }, status: 'ok', endedAt: 2, output: [{ type: 'text', text: 'Plan: 1 of 2 done.', truncated: false }] },
    { id: 'script', at: 1, kind: 'tool', surface: 'core', name: 'exec', args: { code: 'text(await tools.exec_command({cmd:"ls"}))' }, status: 'ok', endedAt: 2, output: [{ type: 'text', text: '{"isError":false}', truncated: false }] },
    { id: 'poll', at: 1, kind: 'tool', surface: 'core', name: 'agents', args: { action: 'status' }, status: 'ok', endedAt: 2, output: [{ type: 'text', text: 'Workers in this run: none', truncated: false }] },
    { id: 'plan', at: 2, kind: 'plan', explanation: null, items: [{ step: 'Inspect', status: 'completed' }, { step: 'Fix', status: 'in_progress' }] }
  ]);
  expect(output.join('')).toBe('\n● Update Todos\n  ⎿  ☒ Inspect\n     ☐ Fix\n');
});

it('prints a stopped partial reply once and keeps errors readable without terminal escapes', () => {
  const output: string[] = [];
  const transcript = new Transcript((text) => output.push(text), false);
  transcript.consume([{ id: 'm', at: 1, kind: 'assistant', messageId: 'm', channel: 'commentary', model: null, text: 'Partial\x1b[2J', streaming: true }]);
  transcript.finish(); transcript.finish();
  expect(output).toHaveLength(1);
  expect(output[0]).toContain('Partial');
  expect(output[0]).not.toContain('\x1b');
});

it('builds the full Ctrl+O transcript without appending to scrollback', () => {
  const output: string[] = [];
  const transcript = new Transcript((text) => output.push(text), false);
  const lines = Array.from({ length: 20 }, (_, index) => `line ${index + 1}`);
  transcript.consume([{ id: 'read', at: 0, kind: 'tool', surface: 'core', name: 'read', args: { paths: ['notes.txt'] }, status: 'ok', endedAt: 1,
    output: [{ type: 'text', text: 'Earlier tool output', truncated: false }] }, command('ok', lines.join('\n'))]);
  const recorded = output.join('');
  const full = transcript.transcript(80).join('\n');
  for (const text of ['Earlier tool output', 'line 20', 'notes.txt', '$ uname -r']) expect(full).toContain(text);
  expect(transcript.transcript(80)).toBe(transcript.transcript(80));
  expect(output.join('')).toBe(recorded);
});

it.each([
  ['breaks at spaces and indents continuation rows', 'alpha beta gamma delta', 10, 2, ['alpha beta', '  gamma', '  delta']],
  ['hard-breaks a word longer than the row', 'abcdefghijkl', 5, 0, ['abcde', 'fghij', 'kl']],
  ['reopens a color across the break', '\x1b[1mbold words here\x1b[0m', 10, 0, ['\x1b[1mbold words\x1b[0m', '\x1b[1mhere\x1b[0m']]
])('wraps text that %s', (_name, text, columns, hang, rows) => {
  expect(wrap(text, columns, hang)).toEqual(rows);
});
