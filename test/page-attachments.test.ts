import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { attachFiles } from '../src/page/attachments';

const state = vi.hoisted(() => ({ inputs: [] as HTMLInputElement[], labels: [] as HTMLElement[], busy: false }));
vi.mock('../src/page/dom', () => ({
  composerForm: () => ({
    querySelectorAll: (selector: string) => selector.startsWith('input') ? state.inputs : state.labels,
    querySelector: () => state.busy ? {} : null
  })
}));

beforeEach(() => {
  vi.useFakeTimers();
  state.inputs = [];
  state.labels = [];
  state.busy = false;
  vi.stubGlobal('DataTransfer', class {
    files: File[] = [];
    items = { add: (file: File) => this.files.push(file) };
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('attachment readiness', () => {
  it('waits for a late file input, renamed tile and completed upload', async () => {
    const file = new File(['test'], 'attach-me.txt', { type: 'text/plain' });
    const input = { disabled: false, accept: '', files: [], dispatchEvent: vi.fn() };
    let settled = false;
    const uploading = attachFiles([file]).then(result => { settled = true; return result; });
    await vi.advanceTimersByTimeAsync(500);
    expect(input.dispatchEvent).not.toHaveBeenCalled();
    state.inputs = [input as unknown as HTMLInputElement];
    state.busy = true;
    await vi.advanceTimersByTimeAsync(100);
    expect(input.dispatchEvent).toHaveBeenCalledOnce();
    expect(input.files).toEqual([file]);
    state.labels = [{ getAttribute: () => 'Remove attach-me(1).txt' } as unknown as HTMLElement];
    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBe(false);
    state.busy = false;
    await vi.advanceTimersByTimeAsync(250);
    await expect(uploading).resolves.toBe(true);
  });

  it('times out when no upload input appears', async () => {
    const uploading = attachFiles([new File(['test'], 'a.txt')], 300);
    await vi.advanceTimersByTimeAsync(300);
    await expect(uploading).resolves.toBe(false);
  });
});
