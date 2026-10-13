import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyFile, mkdtemp, readFile, realpath, rm, stat } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { expect, it, vi } from 'vitest';
import { Editor } from '../src/cli/editor';
import { parseOptions } from '../src/cli/options';
import { clip, safeText, width } from '../src/cli/format';
import { runCommand } from '../src/cli/commands';
import { CliSession } from '../src/cli/session';
import { Transcript } from '../src/cli/transcript';
import type { BackendClient } from '../src/cli/connection';
import type { Terminal } from '../src/cli/terminal';
import type { AppState } from '../src/shared/types';
import { editExternal } from '../src/cli/external-editor';

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
  expect(parseOptions(['-r', '-C', 'repo'], cwd)).toMatchObject({ resume: 'picker', cwd: join(cwd, 'repo') });
  expect(parseOptions(['-c', '--name', 'Fix tests'])).toMatchObject({ resume: 'latest', name: 'Fix tests' });
  expect(() => parseOptions(['exec', '-r'])).toThrow('session ID');
});

it('recalls resumed messages without losing the draft and exposes editor, model and effort shortcuts', () => {
  const editor = new Editor();
  editor.set('new draft');
  editor.restoreHistory(['earlier prompt', 'latest prompt']);
  editor.key('', { name: 'up' });
  expect(editor.text).toBe('latest prompt');
  editor.key('', { name: 'down' });
  expect(editor.text).toBe('new draft');
  expect(editor.key('', { name: 'g', ctrl: true })).toBe('external');
  expect(editor.key('', { name: 'p', ctrl: true })).toBe('model');
  expect(editor.key('', { name: 'tab', shift: true })).toBe('effort');
  expect(editor.text).toBe('new draft');
});

it('returns a draft from a real external editor and removes private temporary files after success or failure', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'creatine-editor-'));
  const observed = join(dir, 'observed.txt');
  const script = "const fs=require('node:fs'); const file=process.argv.at(-1); fs.writeFileSync(process.argv[1],file); fs.appendFileSync(file,' edited');";
  const command = [JSON.stringify(process.execPath), '-e', JSON.stringify(script), '--', JSON.stringify(observed)].join(' ');
  try {
    expect(await editExternal('draft', command)).toBe('draft edited');
    await expect(stat(await readFile(observed, 'utf8'))).rejects.toMatchObject({ code: 'ENOENT' });
    const failure = [JSON.stringify(process.execPath), '-e', JSON.stringify(`${script} process.exit(7);`), '--', JSON.stringify(observed)].join(' ');
    await expect(editExternal('original', failure)).rejects.toThrow('Your draft was kept');
    await expect(stat(await readFile(observed, 'utf8'))).rejects.toMatchObject({ code: 'ENOENT' });
  } finally { await rm(dir, { recursive: true, force: true }); }
});

it('attaches pasted image paths with a prompt instead of interpreting absolute paths as commands', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'creatine-cli-image-'));
  try {
    const file = join(dir, 'screen shot.png');
    await copyFile(join(process.cwd(), 'resources', 'icon.png'), file);
    const canonical = await realpath(file);
    const client = { state: { skills: [] } as unknown as AppState, refresh: async () => {} } as unknown as BackendClient;
    const terminal = { editor: new Editor(), print: () => {}, colored: false } as unknown as Terminal;
    const session = new CliSession(client, parseOptions([], dir), terminal, new Transcript(() => {}, false));
    const send = vi.spyOn(session, 'send').mockResolvedValue({ sessionId: 'test', inputId: 'input' });
    const hooks = { newChat: () => {}, exit: () => {} };
    const spellings = [file, JSON.stringify(file), `'${file}'`, pathToFileURL(file).href, '@screen shot.png', '"screen shot.png"'];
    if (process.platform !== 'win32') spellings.push(file.replaceAll(' ', '\\ '));
    for (const spelling of spellings) {
      session.attachments = [];
      await runCommand(`${spelling}\nDescribe the red thing`, session, hooks);
      expect(session.attachments).toEqual([canonical]);
      expect(send).toHaveBeenLastCalledWith('Describe the red thing');
    }
    session.attachments = [];
    const literal = `${join(dir, 'folder')}\nExplain this path`;
    await runCommand(literal, session, hooks);
    expect(send).toHaveBeenLastCalledWith(literal);
    expect(session.attachments).toEqual([]);
    await expect(runCommand('/unknown', session, hooks)).rejects.toThrow('Unknown command /unknown');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
