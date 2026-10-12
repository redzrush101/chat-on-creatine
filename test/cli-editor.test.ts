import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Editor } from '../src/cli/editor';
import { parseOptions } from '../src/cli/options';
import { clip, safeText, width } from '../src/cli/format';

it('edits Unicode graphemes without splitting emoji, accents or their cursor positions', () => {
  const editor = new Editor();
  editor.insert('a👩‍💻é');
  editor.key('', { name: 'backspace' });
  expect(editor.text).toBe('a👩‍💻');
  editor.key('', { name: 'left' });
  editor.insert('!');
  expect(editor.text).toBe('a!👩‍💻');
  editor.key('', { name: 'delete' });
  expect(editor.text).toBe('a!');
  expect(width('a👩‍💻é界')).toBe(6);
  expect(clip('a👩‍💻é界', 4)).toBe('a👩‍💻é');
});

it('preserves a draft while walking history and handles multiline cursor movement', () => {
  const editor = new Editor();
  editor.insert('first'); editor.submit();
  editor.insert('draft'); editor.key('', { name: 'up' });
  expect(editor.text).toBe('first');
  editor.key('', { name: 'down' }); expect(editor.text).toBe('draft');
  editor.set('one\ntwo'); editor.key('', { name: 'up' }); editor.insert('!');
  expect(editor.text).toBe('one!\ntwo');
  editor.key('', { name: 'u', ctrl: true }); expect(editor.text).toBe('\ntwo');
  editor.set('a👩‍💻x\n123'); editor.key('', { name: 'up' }); editor.insert('!');
  expect(editor.text).toBe('a👩‍💻!x\n123');
});

it('inserts pasted multiline text without submitting and removes terminal control sequences', () => {
  const editor = new Editor();
  editor.insert('read\nthis\x1b[2J\x1b]52;c;payload\x07');
  expect(editor.text).toBe('read\nthis');
  expect(safeText('hello\x1b[31m world\x1b[0m\r\n')).toBe('hello world\n');
  expect(editor.key('', { name: 'return' })).toBe('submit');
  editor.set('next\\'); expect(editor.key('', { name: 'return' })).toBe('edit');
  expect(editor.text).toBe('next\n');
});

it('parses execution arguments without losing literal prompts or changing attachment resolution', () => {
  const cwd = tmpdir();
  const options = parseOptions(['exec', '-C', 'repo', '--attach', 'notes.txt', '--json', '--yolo', '-r', 'abc', '--', '--literal', 'task'], cwd);
  expect(options).toMatchObject({ cwd: join(cwd, 'repo'), attachments: [join(cwd, 'notes.txt')], json: true, print: true, yolo: true, resume: 'abc', prompt: '--literal task' });
  expect(() => parseOptions(['--effort', 'invalid'])).toThrow('Unknown effort');
  expect(() => parseOptions(['--timeout', 'NaN'])).toThrow('positive');
  expect(() => parseOptions(['--loop', '--print'])).toThrow('interactive');
  expect(() => parseOptions(['--model'])).toThrow('needs a value');
  expect(parseOptions(['--yolo', 'status'])).toMatchObject({ command: 'status', yolo: true, prompt: '' });
});
