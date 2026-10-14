import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify, stripVTControlCharacters } from 'node:util';
import { beforeAll, expect, it } from 'vitest';
import { ROOT, answer, outcomes, tools, useLive } from './harness';

const run = useLive('documentation', { ui: { theme: 'dark', workPanelOpen: true, workPanelWidth: 420 } });
const exec = promisify(execFile);
let sessionId = '';

beforeAll(async () => {
  const live = run();
  await mkdir(join(live.workspace, 'src'));
  await mkdir(join(live.workspace, 'test'));
  await writeFile(join(live.workspace, 'package.json'), JSON.stringify({ name: 'checkout-utils', scripts: { test: 'node --test' } }, null, 2));
  await writeFile(join(live.workspace, 'src', 'subtotal.cjs'), 'exports.subtotal = items => items.slice(0, -1).reduce((sum, item) => sum + item.price * item.quantity, 0);\n');
  await writeFile(join(live.workspace, 'test', 'subtotal.test.cjs'), "const { test } = require('node:test');\nconst assert = require('node:assert/strict');\nconst { subtotal } = require('../src/subtotal.cjs');\n\ntest('counts every item in a cart', () => {\n  assert.equal(subtotal([{ price: 19, quantity: 2 }, { price: 7, quantity: 3 }]), 59);\n});\n");
  await exec('git', ['init', '-q', '-b', 'main', live.workspace]);
  await exec('git', ['add', '.'], { cwd: live.workspace });
  await exec('git', ['-c', 'user.name=Example', '-c', 'user.email=test@example.com', 'commit', '-qm', 'Add cart subtotal and regression test'], { cwd: live.workspace });
  const project = await live.api.invoke('projects:add', live.workspace, 'Checkout utils');
  const meta = await live.main((services, projectId) => services.store.create({ kind: 'chat', title: 'Fix cart subtotals', projectId, cwd: services.config.get().roots[0]!.path }), project.id);
  sessionId = meta.id;
  await live.open(sessionId);
  await live.ui.click('button[aria-label="Changes"]');
});

it('captures a real GUI coding workflow in dark and light, with a dark recording', async () => {
  const live = run();
  const events = await live.record('gui', async () => {
    await live.ui.focus('textarea[aria-label="Message"]');
    await live.ui.type('Fix the cart subtotal bug in src/subtotal.cjs. Make a short plan, reproduce the failure, add regression tests for empty and single-item carts, and run npm test. Summarize the fix and test result in a few lines.\n');
    return live.until('cart subtotal fix', live.idle(sessionId), sessionId);
  });
  expect(outcomes(events).at(-1)).toBe('done');
  expect(tools(events).map((event) => event.name)).toEqual(expect.arrayContaining(['exec_command', 'apply_patch']));
  expect(await readFile(join(live.workspace, 'src', 'subtotal.cjs'), 'utf8')).not.toContain('slice(0, -1)');
  await exec('npm', ['test'], { cwd: live.workspace });
  expect(answer(events)).toMatch(/test|pass/i);
  await live.timeline(sessionId, 'gui-cart-fix');
  await live.ui.click('.wp-change', 'src/subtotal.cjs');
  await live.ui.on('.wp-diff-view .diff-body[aria-label="Changes in subtotal.cjs"] .diff-row.is-add', 'element.textContent');
  await live.shot('chat-dark');
  await live.api.invoke('config:update', { ui: { theme: 'light' } });
  await live.ui.on('html[data-theme="light"]', 'element.dataset.theme');
  await live.shot('chat-light');
  await live.api.invoke('config:update', { ui: { theme: 'dark' } });
  await live.ui.on('html[data-theme="dark"]', 'element.dataset.theme');
});

it('continues the shared coding workflow in the CLI and captures both themes and a dark recording', async () => {
  const live = run();
  await live.ui.click('button[aria-label="Hide sidebar"]');
  await live.ui.click('button[aria-label="Terminal"]');
  await live.ui.click('button[aria-label="Widen panel"]');
  await live.ui.focus('.xterm-helper-textarea');
  const command = `clear; node ${JSON.stringify(join(ROOT, 'scripts', 'creatine.mjs'))} -r ${sessionId}`;
  const start = async () => {
    let output = '';
    const off = live.api.on('terminal:data', (event) => { output += event.data; });
    try {
      await live.ui.type(`${command}\n`);
      for (const deadline = Date.now() + 90_000; !stripVTControlCharacters(output).includes('Welcome to Chat on Creatine'); await new Promise((resolve) => setTimeout(resolve, 100))) {
        if (Date.now() > deadline) throw new Error('The coding CLI did not start.');
      }
    } finally { off(); }
  };
  const waitFor = async (pattern: RegExp) => {
    for (const deadline = Date.now() + 300_000; !pattern.test(await live.ui.text('.xterm-rows')); await new Promise((resolve) => setTimeout(resolve, 200))) {
      if (Date.now() > deadline) throw new Error('The coding CLI did not finish its documentation workflow.');
    }
  };
  await start();
  await live.record('cli', async () => {
    await live.ui.type('Now add a regression test for fractional prices: two items at 12.5 plus one at 4.25 must total 29.25. Run npm test and show a compact table of covered cases and the final test count.\n');
    await live.until('CLI fractional-price regression', live.idle(sessionId, 2), sessionId);
    await waitFor(/Worked for/);
  }, '.xterm');
  await exec('npm', ['test'], { cwd: live.workspace });
  await live.timeline(sessionId, 'cli-cart-regression');
  await live.shot('cli-dark', '.xterm');
  await live.ui.type('/exit\n');
  await live.api.invoke('config:update', { ui: { theme: 'light' } });
  await live.ui.on('html[data-theme="light"]', 'element.dataset.theme');
  await live.ui.focus('.xterm-helper-textarea');
  await start();
  await live.ui.type(`/resume ${sessionId}\n`);
  await waitFor(new RegExp(`Resumed ${sessionId}`));
  await live.shot('cli-light', '.xterm');
  await live.ui.type('/exit\n');
});
