import { execFile, spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { expect, it } from 'vitest';
import { ROOT, answer, useLive } from './harness';

const run = useLive('cli-agent');
const exec = promisify(execFile);
const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;

async function copyWayland(bytes: Buffer, type: string): Promise<void> {
  const child = spawn('wl-copy', ['--type', type], { stdio: ['pipe', 'ignore', 'ignore'] });
  child.stdin.end(bytes);
  await new Promise<void>((resolve, reject) => {
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`wl-copy exited with code ${code}.`)));
  });
}

it('uses prompt templates, file ranges, shell context, an external editor and session controls in a real CLI', async () => {
  const live = run();
  const prompts = join(live.workspace, '.creatine', 'prompts');
  await mkdir(prompts, { recursive: true });
  await writeFile(join(live.workspace, 'context.txt'), 'IGNORE_FIRST_LINE\nFILE_CONTEXT_OK\nIGNORE_LAST_LINE\n');
  await writeFile(join(prompts, 'check-context.md'), '---\ndescription: Check CLI context\n---\nRead @context.txt:2 and the provided shell output. Reply with exactly FILE_CONTEXT_OK SHELL_CONTEXT_OK. $1\n');
  const editor = join(live.workspace, 'editor.cjs');
  await writeFile(editor, "require('node:fs').writeFileSync(process.argv.at(-1), 'Reply with just EXTERNAL_EDITOR_OK.');\n");
  const profile = await live.main((services) => services.paths.userData, undefined);
  const terminal = await live.api.invoke('terminal:open', { cwd: live.workspace, cols: 120, rows: 40 });
  let output = '';
  const off = live.api.on('terminal:data', (event) => { if (event.terminalId === terminal) output += event.data; });
  const wait = async (label: string, pattern: RegExp) => {
    for (const deadline = Date.now() + 30_000; !pattern.test(stripVTControlCharacters(output)); await new Promise((resolve) => setTimeout(resolve, 100))) {
      if (Date.now() > deadline) throw new Error(`CLI did not show ${label}.`);
    }
  };
  const type = (text: string) => live.api.invoke('terminal:write', terminal, text);
  try {
    await type(`VISUAL=${quote(`${quote(process.execPath)} ${quote(editor)}`)} ${quote(process.execPath)} ${quote(join(ROOT, 'scripts', 'creatine.mjs'))} --user-data ${quote(profile)} -C ${quote(live.workspace)} --name 'CLI context task'\r`);
    await wait('welcome', /Welcome to Chat on Creatine/);
    await type('/templates\r');
    await wait('template command', /Check CLI context/);
    await type('!printf SHELL_CONTEXT_OK\r');
    await wait('pending context', /shell context pending/);
    await type('!!printf LOCAL_ONLY_OK\r');
    await wait('local shell output', /LOCAL_ONLY_OK/);
    await type('/check-context\r');
    const state = await live.api.waitFor((state) => state.sessions.some((session) => session.title === 'CLI context task'), 30_000);
    const id = state.sessions.find((session) => session.title === 'CLI context task')!.id;
    const events = await live.until('template answer', live.idle(id), id);
    const user = events.filter((event) => event.kind === 'user').at(-1)!;
    expect(user.text).toContain('2: FILE_CONTEXT_OK');
    expect(user.text).toContain('$ printf SHELL_CONTEXT_OK');
    expect(user.text).not.toContain('IGNORE_FIRST_LINE');
    expect(user.text).not.toContain('LOCAL_ONLY_OK');
    expect(answer(events).trim()).toBe('FILE_CONTEXT_OK SHELL_CONTEXT_OK');
    await type('\x07');
    await wait('edited draft', /Reply with just EXTERNAL_EDITOR_OK/);
    await type('\r');
    expect(answer(await live.until('editor answer', live.idle(id, 2), id)).trim()).toBe('EXTERNAL_EDITOR_OK');
    const previousModel = live.state.sessions.find((session) => session.id === id)!.model;
    await type('\x10');
    const cycled = await live.api.waitFor((state) => state.sessions.some((session) => session.id === id && session.model !== previousModel), 10_000);
    const selection = cycled.sessions.find((session) => session.id === id)!;
    const model = cycled.models.models.find((model) => model.id === selection.model)!;
    if (model.efforts.length > 1) {
      await type('\x1b[Z');
      await live.api.waitFor((state) => state.sessions.some((session) => session.id === id && session.reasoning !== selection.reasoning), 10_000);
    }
    await type('/name Named from CLI\r');
    await live.api.waitFor((state) => state.sessions.some((session) => session.id === id && session.title === 'Named from CLI'), 10_000);
    await type('/sessions Named from CLI\r');
    await wait('session list', new RegExp(`${id.slice(0, 8)} · Named from CLI`));
    await type('/new\r');
    await wait('new chat', /New chat\./);
    await type(`/resume ${id.slice(0, 8)}\r`);
    await wait('resumed session', new RegExp(`Resumed ${id}`));
    await type('Reply with just RESUME_OK.\r');
    expect(answer(await live.until('resumed answer', live.idle(id, 3), id)).trim()).toBe('RESUME_OK');
    await type('/new\r/search EXTERNAL_EDITOR_OK\r');
    await wait('message search', /Search chat messages/);
    await type('\rReply with just SEARCH_RESUME_OK.\r');
    expect(answer(await live.until('search resumed answer', live.idle(id, 4), id)).trim()).toBe('SEARCH_RESUME_OK');
    await live.timeline(id, 'cli-agent');
  } finally {
    await writeFile(join(live.dir, 'cli-agent.terminal.txt'), stripVTControlCharacters(output));
    await type('/exit\r');
    off();
    await live.api.invoke('terminal:close', terminal);
  }
});

it('expands a template in JSON exec mode and reserves stdout for JSON records', async () => {
  const live = run();
  const prompts = join(live.workspace, '.creatine', 'prompts');
  await mkdir(prompts, { recursive: true });
  await writeFile(join(prompts, 'say.md'), 'Reply with just $1.');
  const profile = await live.main((services) => services.paths.userData, undefined);
  const task = exec(process.execPath, [join(ROOT, 'scripts', 'creatine.mjs'), 'exec', '--json', '--user-data', profile, '-C', live.workspace, '/say JSON_TEMPLATE_OK'], { timeout: 120_000, maxBuffer: 4 * 1024 * 1024 });
  task.child.stdin?.end();
  const result = await task;
  const records = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as { type: string; text?: string });
  expect(records.find((record) => record.type === 'result')?.text).toBe('JSON_TEMPLATE_OK');
  expect(records.some((record) => record.type === 'session')).toBe(true);
  await writeFile(join(live.dir, 'cli-json.txt'), result.stdout);
});

if (process.platform === 'linux' && process.env.WAYLAND_DISPLAY) {
  it('pastes a real wl-copy image into the CLI and uploads it to ChatGPT', async () => {
    const live = run();
    const display = process.env.WAYLAND_DISPLAY!;
    let types: string[];
    try { types = (await exec('wl-paste', ['--list-types'])).stdout.trim().split('\n'); }
    catch (error) {
      if (!(error instanceof Error) || !/Nothing is copied/.test(error.message)) throw error;
      types = [];
    }
    const restoreType = types.find((type) => type === 'image/png' || type.startsWith('text/plain'));
    if (types.length && !restoreType) throw new Error('Cannot preserve the existing clipboard for this test.');
    const saved = restoreType ? (await exec('wl-paste', ['--no-newline', '--type', restoreType], { encoding: 'buffer' })).stdout : null;
    const image = join(live.workspace, 'wayland-blue.png');
    await live.main(async (services, file) => {
      const require = process.getBuiltinModule('module').createRequire(process.execPath);
      const { nativeImage } = require('electron') as typeof import('electron');
      const pixels = Buffer.alloc(32 * 32 * 4);
      for (let at = 0; at < pixels.length; at += 4) { pixels[at] = 255; pixels[at + 3] = 255; }
      await process.getBuiltinModule('fs').promises.writeFile(file, nativeImage.createFromBitmap(pixels, { width: 32, height: 32 }).toPNG());
      return services.paths.userData;
    }, image);
    const profile = await live.main((services) => services.paths.userData, undefined);
    const terminal = await live.api.invoke('terminal:open', { cwd: live.workspace, cols: 120, rows: 32 });
    let output = '';
    const off = live.api.on('terminal:data', (event) => { if (event.terminalId === terminal) output += event.data; });
    const type = (text: string) => live.api.invoke('terminal:write', terminal, text);
    try {
      await copyWayland(await readFile(image), 'image/png');
      await live.main((services, display) => { process.env.WAYLAND_DISPLAY = display; return services.paths.userData; }, display);
      const staged = await live.api.invoke('app:clipboard');
      expect(await readFile(staged.imagePath!)).toEqual(await readFile(image));
      await type(`${quote(process.execPath)} ${quote(join(ROOT, 'scripts', 'creatine.mjs'))} --user-data ${quote(profile)} -C ${quote(live.workspace)} --name 'Wayland image task'\r`);
      for (const deadline = Date.now() + 30_000; !output.includes('Welcome to'); await new Promise((resolve) => setTimeout(resolve, 100))) if (Date.now() > deadline) throw new Error('The CLI did not open.');
      await type('\x16');
      for (const deadline = Date.now() + 10_000; !stripVTControlCharacters(output).includes('Image attached:'); await new Promise((resolve) => setTimeout(resolve, 100))) if (Date.now() > deadline) throw new Error('The clipboard image was not attached.');
      await type('What is the dominant color in the image? Reply with just the color name.\r');
      const state = await live.api.waitFor((state) => state.sessions.some((session) => session.title === 'Wayland image task'), 30_000);
      const id = state.sessions.find((session) => session.title === 'Wayland image task')!.id;
      const events = await live.until('Wayland image answer', live.idle(id), id);
      expect(events.filter((event) => event.kind === 'user').at(-1)?.attachments).toHaveLength(1);
      expect(answer(events)).toMatch(/^blue[.!]?$/i);
      await live.timeline(id, 'wayland-image');
    } finally {
      await type('/exit\r');
      off();
      await live.api.invoke('terminal:close', terminal);
      await live.main(() => { delete process.env.WAYLAND_DISPLAY; }, undefined);
      if (saved && restoreType) await copyWayland(saved, restoreType);
      else await exec('wl-copy', ['--clear']);
      await writeFile(join(live.dir, 'wayland.terminal.txt'), stripVTControlCharacters(output));
    }
  });
}
