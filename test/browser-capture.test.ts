import { describe, expect, it } from 'vitest';
import { BrowserCapture } from '../src/main/browser-tools/capture';

describe('browser capture state', () => {
  it('updates one request through its response and completion', () => {
    const capture = new BrowserCapture();
    capture.record({ method: 'Network.requestWillBeSent', params: { requestId: 'r1', request: { method: 'GET', url: 'https://example.com/' } } });
    capture.record({ method: 'Network.responseReceived', params: { requestId: 'r1', response: { status: 200, mimeType: 'text/html' } } });
    capture.record({ method: 'Network.loadingFinished', params: { requestId: 'r1' } });
    capture.record({ method: 'Network.loadingFailed', params: { requestId: 'unknown', errorText: 'lost' } });
    expect(capture.network.page(0, 10, () => true)).toEqual({
      items: [{ seq: 1, requestId: 'r1', method: 'GET', url: 'https://example.com/', type: 'Other', status: 200, mimeType: 'text/html', failed: null, finished: true }],
      cursor: 1
    });
  });

  it('keeps cursors monotonic through eviction and clearing', () => {
    const capture = new BrowserCapture();
    const log = (text: string) => capture.record({ method: 'Runtime.consoleAPICalled', params: { type: 'log', args: [{ type: 'string', value: text }] } });
    for (let i = 0; i < 205; i++) log(String(i));
    const first = capture.console.page(0, 2, () => true);
    expect(first.items.map((item) => item.seq)).toEqual([6, 7]);
    expect(capture.console.page(first.cursor, 2, () => true).items.map((item) => item.seq)).toEqual([8, 9]);
    capture.console.clear();
    log('after clear');
    expect(capture.console.page(205, 10, () => true)).toMatchObject({ cursor: 206, items: [{ seq: 206, text: 'after clear' }] });
  });

  it('invalidates document refs only for a top-level navigation', () => {
    const capture = new BrowserCapture();
    expect(capture.record({ method: 'Page.frameNavigated', params: { frame: { parentId: 'parent' } } })).toBe(false);
    expect(capture.record({ method: 'Page.frameNavigated', params: { frame: {} } })).toBe(true);
  });
});
