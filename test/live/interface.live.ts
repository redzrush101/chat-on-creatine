import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { ROOT, answer, outcomes, tools, useLive } from './harness';

const run = useLive('interface');
let sessionId: string;

beforeAll(() => {
  writeFileSync(join(run().workspace, 'hello.txt'), 'The secret word is MARIGOLD.\n');
  writeFileSync(join(run().workspace, 'notes.md'), '# Notes\n');
});

it('runs a tool task typed into the GUI composer and records every call once', async () => {
  const live = run();
  sessionId = await live.send('Reply with just OK.');
  await live.until('the first turn', live.idle(sessionId), sessionId);
  await live.open(sessionId);
  const events = await live.record('gui', async () => {
    await live.ui.focus('textarea[aria-label="Message"]');
    await live.ui.type('Using the local tools, read hello.txt and tell me the secret word. Then add a "## Files" section to notes.md with a Markdown table of the files in this folder, and show me the table.\n');
    return live.until('the tool turn', live.idle(sessionId, 2), sessionId);
  });
  await live.timeline(sessionId, 'gui');
  // Our connector's calls are recorded by the MCP server; ChatGPT's own copy of them must not appear.
  expect(tools(events).filter((event) => event.surface !== 'core').map((event) => event.name)).toEqual([]);
  expect(tools(events).map((event) => event.name)).toEqual(expect.arrayContaining(['read', 'apply_patch']));
  expect(tools(events).every((event) => event.status === 'ok')).toBe(true);
  expect(answer(events)).toMatch(/MARIGOLD/);
  expect(outcomes(events).every((outcome) => outcome === 'done')).toBe(true);

  await live.ui.click('.work-head');
  await live.shot('chat-dark');
  await live.api.invoke('config:update', { ui: { theme: 'light' } });
  await new Promise((done) => setTimeout(done, 500));
  await live.shot('chat-light');
  await live.api.invoke('config:update', { ui: { theme: 'dark' } });
});

it('runs the CLI in the GUI terminal against the same backend', async () => {
  const live = run();
  await live.ui.click('button[aria-label="Hide sidebar"]');
  await live.ui.click('button[aria-label="Terminal"]');
  await live.ui.click('button[aria-label="Widen panel"]');
  const terminal = '.xterm';
  const waitFor = async (label: string, pattern: RegExp, timeoutMs = 300_000) => {
    for (const deadline = Date.now() + timeoutMs; !pattern.test(await live.ui.text('.xterm-rows')); await new Promise((done) => setTimeout(done, 500))) {
      if (Date.now() > deadline) throw new Error(`Timed out waiting for ${label}:\n${await live.ui.text('.xterm-rows')}`);
    }
  };
  await live.ui.focus('.xterm-helper-textarea');
  // The panel's shell may not inherit the dev shell's Electron; pass it so the CLI starts at once.
  const electron = process.env.ELECTRON_OVERRIDE_DIST_PATH ? `ELECTRON_OVERRIDE_DIST_PATH=${JSON.stringify(process.env.ELECTRON_OVERRIDE_DIST_PATH)} ` : '';
  await live.ui.type(`clear; ${electron}node ${JSON.stringify(join(ROOT, 'scripts', 'creatine.mjs'))}\n`);
  await waitFor('the CLI to start', /Welcome to Chat on Creatine/, 90_000);
  await live.record('cli', async () => {
    await live.ui.type('Run uname -r and ls with the local tools, then summarize this folder in a short Markdown list with the kernel version in bold.\n');
    await waitFor('the CLI turn', /Worked for/);
  }, terminal);
  const text = await live.ui.text('.xterm-rows');
  live.log('cli screen', text);
  expect(text).toMatch(/Bash\(/);
  expect(text).not.toMatch(/api_tool/);
  await live.shot('cli', terminal);
  await live.ui.press('Control+o');
  await waitFor('the transcript', /Transcript/, 10_000);
  await live.shot('cli-transcript', terminal);
  await live.ui.press('Escape');
  await live.ui.type('/exit\n');
  expect(existsSync(join(live.workspace, 'notes.md'))).toBe(true);
});
