import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { beforeAll, expect, it } from 'vitest';
import { ROOT, answer, outcomes, useLive } from './harness';

const run = useLive('coding-workflows');
const exec = promisify(execFile);
let reviewId = '';
const bug = 'exports.total = items => items.slice(0, -1).reduce((sum, item) => sum + item, 0);\n';

async function cli(args: string[]) {
  const live = run();
  const profile = await live.main((services) => services.paths.userData, undefined);
  const child = exec(process.execPath, [join(ROOT, 'scripts', 'creatine.mjs'), '--user-data', profile, ...args], { timeout: 300_000, maxBuffer: 4 * 1024 * 1024 });
  child.child.stdin?.end();
  return child;
}

beforeAll(async () => {
  const live = run();
  await writeFile(join(live.workspace, 'package.json'), JSON.stringify({ name: 'review-fixture', scripts: { test: 'node total.test.cjs' } }));
  await writeFile(join(live.workspace, 'total.cjs'), 'exports.total = items => items.reduce((sum, item) => sum + item, 0);\n');
  await writeFile(join(live.workspace, 'total.test.cjs'), "const { total } = require('./total.cjs');\nrequire('node:assert/strict').equal(total([1, 2]), 3);\n");
  await exec('git', ['init', '-q', '-b', 'main', live.workspace]);
  await exec('git', ['add', '.'], { cwd: live.workspace });
  await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'Initial sum implementation'], { cwd: live.workspace });
  await exec('git', ['checkout', '-qb', 'feature'], { cwd: live.workspace });
  await writeFile(join(live.workspace, 'total.cjs'), bug);
});

it('reviews uncommitted code from the CLI, saves its final answer and resumes the same chat', async () => {
  const live = run();
  const file = join(live.dir, 'cli-review.md');
  const result = await cli(['review', '-C', live.workspace, '--uncommitted', '--json', '-o', file, 'Focus on total.cjs and whether it sums every element.']);
  const records = result.stdout.trim().split('\n').map((line) => JSON.parse(line) as { type: string; sessionId: string; text?: string });
  const final = records.find((record) => record.type === 'result')!;
  reviewId = final.sessionId;
  expect(final.text).toMatch(/total\.cjs/);
  expect(final.text).toMatch(/last|final|slice/i);
  expect(await readFile(file, 'utf8')).toBe(`${final.text}\n`);
  expect(await readFile(join(live.workspace, 'total.cjs'), 'utf8')).toBe(bug);
  expect(outcomes(await live.events(reviewId)).at(-1)).toBe('done');
  const resumed = await cli(['exec', 'resume', reviewId, '--json', 'Reply with exactly REVIEW_RESUME_OK.']);
  const resumedRecords = resumed.stdout.trim().split('\n').map((line) => JSON.parse(line) as { type: string; sessionId: string; text?: string });
  expect(resumedRecords.find((record) => record.type === 'result')).toMatchObject({ sessionId: reviewId, text: 'REVIEW_RESUME_OK' });
  await live.timeline(reviewId, 'cli-review');
  await writeFile(join(live.dir, 'cli-review.jsonl'), result.stdout);
});

it('starts a base review from the GUI workflow picker and copies its final answer', async () => {
  const live = run();
  const turns = outcomes(await live.events(reviewId)).length;
  await exec('git', ['add', 'total.cjs'], { cwd: live.workspace });
  await exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'Introduce regression'], { cwd: live.workspace });
  await live.open(reviewId);
  await live.ui.focus('textarea[aria-label="Message"]');
  await live.ui.type('Preserve this draft');
  await live.ui.click('button[aria-label="Coding workflows"]');
  await live.ui.on('select[aria-label="Review scope"]', '(() => { element.value = "base"; element.dispatchEvent(new Event("change", { bubbles: true })); })()');
  await live.ui.focus('.coding-task-form input');
  await live.ui.type('main');
  await live.shot('gui-review-picker');
  await live.ui.click('.coding-task-form button[type="submit"]');
  const events = await live.until('GUI base review', live.idle(reviewId, turns + 1), reviewId);
  expect(answer(events)).toMatch(/total\.cjs/);
  expect(await readFile(join(live.workspace, 'total.cjs'), 'utf8')).toBe(bug);
  expect(await live.ui.on('textarea[aria-label="Message"]', 'element.value')).toBe('Preserve this draft');
  const copied = await live.main(async () => {
    const { clipboard } = process.getBuiltinModule('module').createRequire(process.execPath)('electron') as typeof import('electron');
    return clipboard.readText();
  }, undefined);
  try {
    await live.ui.click('button[aria-label="Copy answer"]');
    expect(await live.main(async () => {
      const { clipboard } = process.getBuiltinModule('module').createRequire(process.execPath)('electron') as typeof import('electron');
      return clipboard.readText();
    }, undefined)).toBe(answer(events));
  } finally {
    await live.api.invoke('app:copyText', copied);
  }
  expect(await live.ui.on('button[aria-label="Save answer"]', 'element.title')).toBe('Save answer as Markdown');
  const saved = join(live.dir, 'gui-review.md');
  await live.main((services, file) => {
    const { BrowserWindow } = process.getBuiltinModule('module').createRequire(process.execPath)('electron') as typeof import('electron');
    const window = BrowserWindow.getAllWindows().find((window) => window.getTitle() === 'Chat on Creatine')!;
    window.webContents.session.once('will-download', (...args) => args[1].setSavePath(file));
    return services.paths.userData;
  }, saved);
  await live.ui.click('button[aria-label="Save answer"]');
  for (const deadline = Date.now() + 10_000; !existsSync(saved); await new Promise((resolve) => setTimeout(resolve, 100))) {
    if (Date.now() > deadline) throw new Error('The GUI answer download did not complete.');
  }
  expect(await readFile(saved, 'utf8')).toBe(`${answer(events)}\n`);
  await live.shot('gui-review-answer');
  await live.timeline(reviewId, 'gui-base-review');
});

it('creates AGENTS.md from the GUI and preserves an existing file on a second initialization', async () => {
  const live = run();
  const turns = outcomes(await live.events(reviewId)).length;
  await live.ui.click('button[aria-label="Coding workflows"]');
  await live.ui.on('select[aria-label="Coding task"]', '(() => { element.value = "init"; element.dispatchEvent(new Event("change", { bubbles: true })); })()');
  await live.ui.click('.coding-task-form button[type="submit"]');
  await live.until('GUI project instructions', live.idle(reviewId, turns + 1), reviewId);
  const file = join(live.workspace, 'AGENTS.md');
  const original = await readFile(file, 'utf8');
  expect(original).toMatch(/total|npm test|node total\.test\.cjs/);
  const initialized = await live.api.invoke('chat:send', { sessionId: reviewId, text: '', task: { kind: 'init' }, attachments: [], delivery: 'now' });
  const events = await live.until('existing instructions preservation', live.idle(initialized.sessionId, turns + 2), initialized.sessionId);
  expect(await readFile(file, 'utf8')).toBe(original);
  expect(outcomes(events).at(-1)).toBe('done');
  await live.timeline(reviewId, 'gui-init');
});

it('manages a real stdio MCP server from the CLI and shows its tools in GUI settings', async () => {
  const live = run();
  const fixture = join(live.dir, 'mcp-fixture');
  await mkdir(fixture);
  await symlink(join(ROOT, 'node_modules'), join(fixture, 'node_modules'), 'dir');
  const script = join(fixture, 'server.mjs');
  await writeFile(script, `import { McpServer } from '@modelcontextprotocol/server';
import { StdioServerTransport } from '@modelcontextprotocol/server/stdio';
const server = new McpServer({ name: 'live-workflow-tools', version: '1.0.0' });
server.registerTool('workflow_marker', { description: 'Return the workflow marker.' }, async () => ({ content: [{ type: 'text', text: 'MCP_WORKFLOW_OK' }] }));
await server.connect(new StdioServerTransport());\n`);
  try {
    await cli(['mcp', 'add', 'live-workflow-tools', '--', process.execPath, script]);
    await live.api.waitFor((state) => state.plugins.some((plugin) => plugin.name === 'live-workflow-tools' && plugin.state === 'running'), 30_000);
    const listed = JSON.parse((await cli(['mcp', 'get', 'live-workflow-tools', '--json'])).stdout) as { tools: { name: string }[] };
    expect(listed.tools.map((tool) => tool.name)).toContain('workflow_marker');
    await live.ui.click('button[aria-label="Settings"]');
    await live.ui.click('button', 'Plugins');
    expect(await live.ui.text('.st-plugin')).toContain('workflow_marker');
    await live.shot('gui-mcp-server');
    await cli(['mcp', 'disable', 'live-workflow-tools']);
    await live.api.waitFor((state) => state.plugins.some((plugin) => plugin.name === 'live-workflow-tools' && plugin.state === 'stopped'), 15_000);
    await cli(['mcp', 'enable', 'live-workflow-tools']);
    await live.api.waitFor((state) => state.plugins.some((plugin) => plugin.name === 'live-workflow-tools' && plugin.state === 'running'), 30_000);
  } finally {
    await cli(['mcp', 'remove', 'live-workflow-tools']);
    await rm(fixture, { recursive: true, force: true });
  }
});

it('approves an extra folder from the CLI and shows the shared approval in GUI Setup', async () => {
  const live = run();
  const extra = await mkdtemp(join(tmpdir(), 'project-extra-'));
  try {
    await cli(['status', '--add-dir', extra, '--add-dir', extra]);
    const state = await live.api.refresh();
    expect(state.config.roots.filter((root) => root.path === extra)).toHaveLength(1);
    await live.ui.click('button[aria-label="Settings"]');
    await live.ui.click('.st-nav button', 'Setup');
    expect(await live.ui.on('.st-plain-list', 'element.innerText', extra)).toContain(extra);
    await live.shot('gui-additional-folder');
  } finally {
    const state = await live.api.refresh();
    await live.api.invoke('config:update', { roots: state.config.roots.filter((root) => root.path !== extra) });
    await rm(extra, { recursive: true, force: true });
  }
});
