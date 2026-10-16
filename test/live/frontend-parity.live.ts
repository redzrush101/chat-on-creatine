import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { expect, it } from 'vitest';
import { ROOT, answer, useLive } from './harness';

const run = useLive('frontend-parity');
const exec = promisify(execFile);

it('shares searchable settings, customization and usage between the desktop and terminal', async () => {
  const live = run();
  const terminal = await live.api.invoke('terminal:open', { cwd: live.workspace, cols: 120, rows: 40 });
  let output = '';
  const off = live.api.on('terminal:data', (event) => { if (event.terminalId === terminal) output += event.data; });
  const wait = async (pattern: RegExp) => {
    for (const deadline = Date.now() + 30_000; !pattern.test(stripVTControlCharacters(output)); await new Promise((resolve) => setTimeout(resolve, 100))) {
      if (Date.now() > deadline) throw new Error(`The CLI did not show ${pattern}`);
    }
  };
  const type = (text: string) => live.api.invoke('terminal:write', terminal, text);
  try {
    await type(`${JSON.stringify(process.execPath)} ${JSON.stringify(join(ROOT, 'scripts', 'creatine.mjs'))} -C ${JSON.stringify(live.workspace)}\r`);
    await wait(/Welcome to Chat on Creatine/);
    await type('/settings ui.density compact\r');
    await live.api.waitFor((state) => state.config.ui.density === 'compact', 10_000);
    await live.ui.on('html[data-density="compact"]', 'element.dataset.density');
    await type('/settings ui.chatWidth 1008\r');
    await live.api.waitFor((state) => state.config.ui.chatWidth === 1008, 10_000);
    await type('/settings ui.reducedMotion on\r');
    await live.ui.on('html[data-reduced-motion="true"]', 'element.dataset.reducedMotion');
    await live.ui.click('button[aria-label="Settings"]');
    await live.ui.click('.st-nav-item', 'Appearance');
    expect(await live.ui.on('button[aria-label="Reduce motion"]', 'element.getAttribute("aria-checked")')).toBe('true');
    await live.ui.click('button[aria-label="Reduce motion"]');
    await live.api.waitFor((state) => !state.config.ui.reducedMotion, 10_000);
    await type('/settings reset ui.density\r');
    await live.ui.on('html[data-density="comfortable"]', 'element.dataset.density');
    await type('/settings reset ui.chatWidth\r');
    await live.ui.click('.st-nav-item', 'Usage');
    expect(await live.ui.text('.st-content')).toContain('Both interfaces share this ChatGPT login');
    await type('/usage\r');
    await wait(/Send a message or resume a chat/);
    await live.shot('settings-usage');
    await live.ui.click('.st-back');
    await live.ui.focus('textarea[aria-label="Message"]');
    await live.ui.type('/settings ui.theme light\n');
    await live.ui.on('html[data-theme="light"]', 'element.dataset.theme');
    await live.ui.type('/settings reset ui.theme\n');
    await live.ui.on('html[data-theme="dark"]', 'element.dataset.theme');
    await live.ui.type('/usage\n');
    await live.ui.on('.st-main-head h1', 'element.textContent', 'Usage');
    await live.ui.click('.st-back');
    expect(await live.ui.on('textarea[aria-label="Message"]', 'element.value')).toBe('');
    expect(live.state.sessions).toHaveLength(0);
    await type('/exit\r');
  } finally { off(); await live.api.invoke('terminal:close', terminal); }
});

it('shares prompt templates, @file ranges and model defaults between the GUI and CLI', async () => {
  const live = run();
  const prompts = join(live.workspace, '.creatine', 'prompts');
  await mkdir(prompts, { recursive: true });
  await writeFile(join(live.workspace, 'context.txt'), 'IGNORE_THIS_LINE\nSHARED_PROMPT_OK\nIGNORE_THIS_TOO\n');
  await writeFile(join(prompts, 'shared-check.md'), '---\ndescription: Check shared file context\n---\nUse the provided excerpt of @context.txt:2. Reply with just its value. Do not use tools. $1');
  await live.ui.click('button[aria-label="Prompts and skills"]');
  await live.ui.click('.menu-item', '/shared-check');
  expect(await live.ui.on('textarea[aria-label="Message"]', 'element.value')).toBe('/shared-check ');
  await live.ui.press('Enter');
  const created = await live.api.waitFor((state) => state.sessions.some((session) => session.kind === 'chat'), 30_000);
  const id = created.sessions.find((session) => session.kind === 'chat')!.id;
  const guiEvents = await live.until('GUI shared prompt', live.idle(id), id);
  expect(answer(guiEvents).trim()).toBe('SHARED_PROMPT_OK');
  const guiInput = guiEvents.find((event) => event.kind === 'user')!;
  expect(guiInput.text).toContain('2: SHARED_PROMPT_OK');
  expect(guiInput.text).not.toContain('IGNORE_THIS_LINE');
  await live.open(id);
  await live.ui.click('.context-meter');
  expect(await live.ui.text('.context-breakdown')).toContain('Tool results');
  await live.shot('context-breakdown');
  await live.ui.press('Escape');
  const before = live.state.sessions.find((session) => session.id === id)!;
  await live.ui.focus('textarea[aria-label="Message"]');
  await live.ui.press('Control+p');
  const cycled = await live.api.waitFor((state) => state.sessions.some((session) => session.id === id && session.model !== before.model), 10_000);
  const model = cycled.sessions.find((session) => session.id === id)!;
  await live.ui.press('Shift+Tab');
  const adjusted = await live.api.waitFor((state) => state.sessions.some((session) => session.id === id && session.reasoning !== model.reasoning), 10_000);
  const selection = adjusted.sessions.find((session) => session.id === id)!;
  expect(adjusted.config.ui).toMatchObject({ defaultModel: selection.model, defaultReasoning: selection.reasoning });
  const profile = await live.main((services) => services.paths.userData, undefined);
  const task = exec(process.execPath, [join(ROOT, 'scripts', 'creatine.mjs'), 'exec', '--json', '--user-data', profile, '-C', live.workspace, '/shared-check'], { timeout: 120_000 });
  task.child.stdin?.end();
  const result = await task;
  const records = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as { type: string; text?: string; sessionId?: string });
  expect(records.find((record) => record.type === 'result')?.text).toBe('SHARED_PROMPT_OK');
  const cliId = records.find((record) => record.type === 'session')!.sessionId!;
  expect((await live.api.refresh()).sessions.find((session) => session.id === cliId)).toMatchObject({ model: selection.model, reasoning: selection.reasoning });
  live.log('GUI model defaults inherited by CLI', { model: selection.model, reasoning: selection.reasoning });
  const cliInput = (await live.events(cliId)).find((event) => event.kind === 'user')!;
  expect(cliInput.text).toBe(guiInput.text);
  expect(await readFile(join(live.workspace, 'context.txt'), 'utf8')).toContain('IGNORE_THIS_LINE');
  await live.timeline(id, 'gui-shared-prompt');
  await live.timeline(cliId, 'cli-shared-prompt');
  await live.shot('shared-prompts-dark');
  await live.api.invoke('config:update', { ui: { theme: 'light' } });
  await live.ui.on('html[data-theme="light"]', 'element.dataset.theme');
  await live.shot('shared-prompts-light');
});
