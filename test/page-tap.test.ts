import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFetchTap } from '../src/page/tap';

afterEach(() => vi.unstubAllGlobals());

describe('serialized fetch tap', () => {
  it.each(['body', 'reader'] as const)('lets the native page cancel through its %s without waiting for the observer', async (mode) => {
    const cancel = vi.fn();
    let close!: () => void;
    const response = new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: partial\n\n')); close = () => controller.close(); },
      cancel
    }));
    const page = { fetch: vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response), postMessage: vi.fn() };
    vi.stubGlobal('window', page);
    vi.stubGlobal('location', { href: 'https://chatgpt.com/', origin: 'https://chatgpt.com' });
    const install = new Function(`return (${installFetchTap.toString()});`)() as typeof installFetchTap;
    install(`cancel-${mode}`);
    const tapped = await page.fetch('/backend-api/f/conversation', { method: 'POST' });
    const body = tapped.body!;
    let finished = false;
    const cancellation = (mode === 'body' ? body.cancel('done') : body.getReader().cancel('done')).then(() => { finished = true; });
    try {
      await vi.waitFor(() => expect(finished).toBe(true), { timeout: 200, interval: 10 });
      expect(cancel).toHaveBeenCalledOnce();
    } finally { if (!finished) close(); await cancellation; }
  });

  it('preserves the native response identity and metadata while independently observing its body', async () => {
    const response = new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream', 'x-oai-request-id': 'request' } });
    Object.defineProperty(response, 'url', { value: 'https://chatgpt.com/backend-api/f/conversation' });
    Object.defineProperty(response, 'redirected', { value: true });
    const page = { fetch: vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response), postMessage: vi.fn() };
    vi.stubGlobal('window', page);
    vi.stubGlobal('location', { href: 'https://chatgpt.com/', origin: 'https://chatgpt.com' });
    installFetchTap('metadata');
    const tapped = await page.fetch('/backend-api/f/conversation', { method: 'POST' });
    expect(tapped).toBe(response);
    expect(tapped.url).toBe('https://chatgpt.com/backend-api/f/conversation');
    expect(tapped.redirected).toBe(true);
    expect(await tapped.text()).toBe('data: [DONE]\n\n');
    await vi.waitFor(() => expect(page.postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'end' }), 'https://chatgpt.com'));
  });

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
