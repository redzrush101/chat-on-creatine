import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFetchTap } from '../src/page/tap';

afterEach(() => vi.unstubAllGlobals());

describe('serialized fetch tap', () => {
  it.each([
    [new Error('stream failed'), 'error'],
    [new DOMException('cancelled', 'AbortError'), 'end']
  ])('reports a stream failure in the page world: %s', async (error, expectedKind) => {
    let report!: (event: Record<string, unknown>) => void;
    const reported = new Promise<Record<string, unknown>>((resolve) => { report = resolve; });
    const response = new Response(new ReadableStream({ start(controller) { controller.error(error); } }));
    const page = {
      fetch: vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response),
      postMessage(event: Record<string, unknown>) {
        if (event.kind === 'error' || event.kind === 'end') report(event);
      }
    };
    vi.stubGlobal('window', page);
    vi.stubGlobal('location', { href: 'https://chatgpt.com/', origin: 'https://chatgpt.com' });
    // The preload serializes this function into another JS world; imports cannot follow it.
    const install = new Function(`return (${installFetchTap.toString()});`)() as typeof installFetchTap;
    install('test');
    const tapped = await page.fetch('/backend-api/f/conversation', { method: 'POST' });
    await tapped.text().catch(() => undefined);
    expect(await reported).toMatchObject({ channel: 'test', kind: expectedKind });
  });
});
