import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeAll, expect, it } from 'vitest';
import { ROOT, answer, outcomes, tools, useLive, type Live } from './harness';

const run = useLive('interface');
let sessionId: string;

async function copyImage(live: Live): Promise<string> {
  return live.main(async (services) => {
    const { clipboard, ClipboardItem, nativeImage } = process.getBuiltinModule('module').createRequire(process.execPath)('electron') as typeof import('electron');
    const file = process.getBuiltinModule('path').join(services.config.get().roots[0]!.path, 'screen shot.png');
    const pixels = Buffer.alloc(64 * 64 * 4);
    for (let at = 0; at < pixels.length; at += 4) { pixels[at] = 255; pixels[at + 3] = 255; }
    const image = nativeImage.createFromBitmap(pixels, { width: 64, height: 64 }).toPNG();
    await process.getBuiltinModule('fs').promises.writeFile(file, image);
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(image)], { type: 'image/png' }) })]);
    return file;
  }, undefined);
}

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

it('pastes clipboard images into the GUI composer and uploads them with the prompt', async () => {
  const live = run();
  await copyImage(live);
  await live.open(sessionId);
  await live.ui.focus('textarea[aria-label="Message"]');
  await live.ui.type('What is the dominant color of the pasted images? Reply with just the color name.');
  await live.ui.press('Control+v');
  await live.ui.press('Control+v');
  await live.ui.press('Enter');
  const events = await live.until('GUI pasted images', live.idle(sessionId, 3), sessionId);
  const user = events.filter((event) => event.kind === 'user').at(-1)!;
  expect(user.attachments).toHaveLength(2);
  expect(user.attachments.every((file) => file.mime === 'image/png' && file.name.startsWith('clipboard-'))).toBe(true);
  expect(answer(events)).toMatch(/^blue[.!]?$/i);
  await live.timeline(sessionId, 'gui-clipboard');
  await live.main(async () => {
    const { clipboard } = process.getBuiltinModule('module').createRequire(process.execPath)('electron') as typeof import('electron');
    await clipboard.writeText('pasted draft');
  }, undefined);
  await live.ui.press('Control+v');
  expect(await live.ui.on('textarea[aria-label="Message"]', 'element.value')).toBe('pasted draft');
  await live.ui.press('Control+a');
  await live.ui.press('Backspace');
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
  await waitFor('the CLI prompt after closing the transcript', /\? for shortcuts/, 10_000);

  const file = await copyImage(live);
  await live.ui.focus('.xterm-helper-textarea');
  await live.ui.press('Control+v');
  await live.ui.press('Enter');
  const imageOnly = (input: typeof live.state.inputs[number]) => !input.text && input.attachments.some((file) => file.name.startsWith('clipboard-'));
  const state = await live.api.waitFor((state) => state.inputs.some(imageOnly), 30_000);
  const cliId = state.inputs.find(imageOnly)!.sessionId;
  await live.shot('cli-image-working', terminal);
  const pasted = await live.until('CLI pasted image', live.idle(cliId, 2), cliId);
  expect(pasted.filter((event) => event.kind === 'user').at(-1)?.attachments).toHaveLength(1);
  expect(answer(pasted)).toMatch(/\bblue\b/i);

  await live.ui.type(file);
  await live.ui.press('Control+j');
  const pathPrompt = 'Describe the color of the image from this path. Reply with just the color name.';
  await live.ui.type(`${pathPrompt}\n`);
  const fromPath = await live.until('CLI image path', live.idle(cliId, 3), cliId);
  await live.timeline(cliId, 'cli-images');
  const user = fromPath.filter((event) => event.kind === 'user').at(-1)!;
  expect(user.text).toBe(pathPrompt);
  expect(user.attachments.map((image) => image.name)).toEqual(['screen shot.png']);
  expect(answer(fromPath)).toMatch(/^blue[.!]?$/i);
  expect(await live.ui.text('.xterm-rows')).not.toMatch(/Unknown command/);
  await live.main(async () => {
    const { clipboard } = process.getBuiltinModule('module').createRequire(process.execPath)('electron') as typeof import('electron');
    await clipboard.writeText('Reply with just CLIPBOARD_TEXT_OK.');
  }, undefined);
  await live.ui.press('Control+v');
  await live.ui.press('Enter');
  const clipboardText = await live.until('CLI clipboard text', live.idle(cliId, 4), cliId);
  expect(clipboardText.filter((event) => event.kind === 'user').at(-1)?.text).toBe('Reply with just CLIPBOARD_TEXT_OK.');
  expect(answer(clipboardText)).toBe('CLIPBOARD_TEXT_OK');
  await live.ui.type('/exit\n');
  expect(existsSync(join(live.workspace, 'notes.md'))).toBe(true);
});
