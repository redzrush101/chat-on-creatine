import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { ConversationStreamParser } from '../../src/shared/chatgpt-stream';
import type { PageEvent } from '../../src/shared/page-protocol';
import type { SessionEvent } from '../../src/shared/types';
import { ROOT, answer, useLive } from './harness';

const run = useLive('performance');
type Sample = { at: number; length: number };
type Tap = { at: number; kind: string; chunk?: string };

it('compares ChatGPT stream arrival with backend, GUI and CLI delivery on the same turns', async () => {
  const live = run();
  const profile = await live.main((services) => services.paths.userData, undefined);
  const model = live.state.models.models.find((entry) => /instant|mini|fast/i.test(`${entry.id} ${entry.label}`)) ?? live.state.models.models[0]!;
  const results: Record<string, unknown>[] = [];
  for (let trial = 0; trial < 3; trial++) {
    const meta = await live.main((services, arg) => services.store.create({ kind: 'chat', title: `Streaming benchmark ${arg.trial}`, cwd: services.config.get().roots[0]!.path, model: arg.model }), { trial, model: model.id });
    const tab = await live.main((services, meta) => services.router.ensureTab(meta, false), meta);
    await live.main(async (services, tab) => {
      await services.host.command(tab, { type: 'models' });
      const require = process.getBuiltinModule('module').createRequire(process.execPath);
      const electron = require('electron') as typeof import('electron');
      const tabs = Reflect.get(services.host, 'tabsById') as Map<string, { view: Electron.WebContentsView }>;
      const contents = tabs.get(tab)!.view.webContents;
      services.host.reveal(tab);
      await contents.executeJavaScript(`(() => {
        const taps = [];
        const native = [];
        Reflect.set(window, 'creatineBenchmark', { taps, native });
        window.addEventListener('message', (event) => {
          if (event.source === window && event.origin === location.origin && event.data?.channel?.startsWith('creatine-tap-')) {
            const { kind, chunk } = event.data;
            taps.push({ at: Date.now(), kind, chunk });
          }
        });
        let last = '';
        new MutationObserver(() => {
          const text = [...document.querySelectorAll('[data-search-result-target], .text-size-chat, [dir="auto"]')].map((item) => item.textContent.trim()).find((text) => /^1[.)]\\s/.test(text) || text.startsWith('The lighthouse')) ?? '';
          if (text && text !== last) { last = text; native.push({ at: Date.now(), length: text.length }); }
        }).observe(document.documentElement, { subtree: true, childList: true, characterData: true });
      })()`);
      const page: { at: number; length: number }[] = [];
      const listener = (event: Electron.IpcMainEvent, payload: PageEvent) => {
        if (event.sender.id === contents.id && payload.type === 'message' && payload.message.role === 'assistant' && payload.message.recipient === 'all' && payload.message.contentType === 'text' && (payload.message.channel === 'final' || payload.message.channel === null) && payload.message.text) page.push({ at: Date.now(), length: payload.message.text.length });
      };
      electron.ipcMain.on('creatine-page:event', listener);
      Reflect.set(globalThis, 'creatineBenchmark', { page, contents, dispose: () => electron.ipcMain.off('creatine-page:event', listener) });
      return services.host.tabs().length;
    }, tab);
    await live.open(meta.id);
    await live.ui.evaluate(`(() => {
      const samples = [];
      Reflect.set(window, 'creatineBenchmark', samples);
      let last = '';
      new MutationObserver(() => {
        const text = [...document.querySelectorAll('.msg-assistant .md')].map((item) => item.textContent).join('');
        if (text && text !== last) { last = text; samples.push({ at: Date.now(), length: text.length }); }
      }).observe(document.querySelector('.timeline'), { subtree: true, childList: true, characterData: true });
    })()`);
    const frontend: Sample[] = [];
    const off = live.api.on('session:events', (batch) => {
      if (batch.sessionId !== meta.id) return;
      for (const event of batch.events) if (event.kind === 'assistant' && event.channel === 'final' && event.text) frontend.push({ at: Date.now(), length: event.text.length });
    });
    const cli: Sample[] = [];
    const started = Date.now();
    const child = spawn(process.execPath, [join(ROOT, 'scripts', 'creatine.mjs'), 'exec', '--json', '--user-data', profile, '-C', live.workspace, '-r', meta.id,
      'Write exactly 40 numbered lines about a fictional lighthouse, one short sentence per line. Start with "1. The lighthouse" and end the last line with STREAM_BENCHMARK_DONE. Do not use tools.'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let buffer = '';
    let errors = '';
    child.stderr.on('data', (chunk: Buffer) => { errors += chunk.toString(); });
    child.stdout.on('data', (chunk: Buffer) => {
      buffer += chunk.toString();
      let end: number;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        const record = JSON.parse(line) as { type: string; event?: SessionEvent };
        if (record.type === 'event' && record.event?.kind === 'assistant' && record.event.channel === 'final' && record.event.text) cli.push({ at: Date.now(), length: record.event.text.length });
      }
    });
    const code = await new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
    off();
    expect(code, errors).toBe(0);
    const captured = await live.main(() => {
      const benchmark = Reflect.get(globalThis, 'creatineBenchmark') as { page: Sample[]; contents: Electron.WebContents; dispose(): void };
      benchmark.dispose();
      return benchmark.contents.executeJavaScript('Reflect.get(window, "creatineBenchmark")').then((value: { taps: Tap[]; native: Sample[] }) => ({ ...value, page: benchmark.page }));
    }, undefined);
    const gui = await live.ui.evaluate<Sample[]>('Reflect.get(window, "creatineBenchmark")');
    const upstream: Sample[] = [];
    let at = 0;
    const parser = new ConversationStreamParser({ message: (message) => { if (message.role === 'assistant' && message.recipient === 'all' && message.contentType === 'text' && (message.channel === 'final' || message.channel === null) && message.text) upstream.push({ at, length: message.text.length }); } });
    for (const tap of captured.taps) { at = tap.at; if (tap.kind === 'chunk') parser.push(tap.chunk ?? ''); else if (tap.kind === 'end') parser.end(); }
    const first = (samples: Sample[]) => samples[0]?.at ?? NaN;
    const lags = frontend.flatMap((sample) => {
      const source = upstream.find((entry) => entry.length >= sample.length);
      return source ? [sample.at - source.at] : [];
    }).sort((a, b) => a - b);
    const events = await live.events(meta.id);
    expect(answer(events)).toContain('STREAM_BENCHMARK_DONE');
    expect(upstream.length).toBeGreaterThan(0);
    expect(frontend.length).toBeGreaterThan(1);
    expect(gui.length).toBeGreaterThan(0);
    expect(cli.length).toBeGreaterThan(1);
    expect(captured.native.length).toBeGreaterThan(0);
    const result = { trial, model: model.id, totalMs: Date.now() - started, firstUpstreamMs: first(upstream) - started,
      firstNativeMs: first(captured.native) - started, firstPageOverheadMs: first(captured.page) - first(upstream),
      firstFrontendOverheadMs: first(frontend) - first(upstream), firstGuiOverheadMs: first(gui) - first(upstream), firstCliOverheadMs: first(cli) - first(upstream),
      frontendLagMedianMs: lags[Math.floor(lags.length / 2)], frontendLagP95Ms: lags[Math.floor(lags.length * 0.95)],
      samples: { upstream: upstream.length, page: captured.page.length, frontend: frontend.length, gui: gui.length, cli: cli.length } };
    live.log('benchmark', result);
    results.push(result);
    await writeFile(join(live.dir, 'performance.json'), JSON.stringify(results, null, 2));
    await live.timeline(meta.id, `benchmark-${trial}`);
    await live.main((services, tab) => services.host.closeTab(tab), tab);
  }
});
