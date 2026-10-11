import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushWrites } from '../src/main/core/durable';
import { Outbox, type EnqueueInit } from '../src/main/sessions/outbox';

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'outbox-test-'));
  file = join(dir, 'outbox.json');
});

afterEach(async () => {
  await flushWrites();
  rmSync(dir, { recursive: true, force: true });
});

function input(overrides: Partial<EnqueueInit> = {}): EnqueueInit {
  return { sessionId: 's1', text: 'do it', attachments: [], delivery: 'after-turn', source: 'app', ...overrides };
}

describe('Outbox', () => {
  it('is idempotent on id', () => {
    const outbox = new Outbox(file);
    const first = outbox.enqueue(input({ id: 'x', text: 'one' }));
    const again = outbox.enqueue(input({ id: 'x', text: 'two' }));

    expect(again).toBe(first);
    expect(outbox.list()).toHaveLength(1);
    expect(outbox.get('x')?.text).toBe('one');
  });

  it('delivers the oldest queued item of a session first', () => {
    const outbox = new Outbox(file);
    const a = outbox.enqueue(input({ text: 'a' }));
    outbox.enqueue(input({ sessionId: 's2', text: 'other' }));
    const b = outbox.enqueue(input({ text: 'b', delivery: 'now' }));

    expect(outbox.nextFor('s1')?.id).toBe(a.id);
    outbox.markSending(a.id);
    expect(outbox.nextFor('s1')?.id).toBe(b.id);
    expect(outbox.list('s1').map((item) => item.text)).toEqual(['a', 'b']);
  });

  it('steers a running turn with queued "now" items only, and marks them steered', () => {
    const outbox = new Outbox(file);
    outbox.enqueue(input({ text: 'later', delivery: 'after-turn' }));
    const now = outbox.enqueue(input({ text: 'urgent', delivery: 'now' }));

    const taken = outbox.takeSteerable('s1');
    expect(taken.map((item) => item.id)).toEqual([now.id]);
    expect(outbox.get(now.id)?.state).toBe('steered');
    expect(outbox.takeSteerable('s1')).toEqual([]);
    expect(outbox.nextFor('s1')?.text).toBe('later');
  });

  it('cancels and edits only queued items', () => {
    const outbox = new Outbox(file);
    const item = outbox.enqueue(input());
    expect(outbox.update(item.id, { text: 'edited' })?.text).toBe('edited');

    outbox.markSending(item.id);
    expect(outbox.cancel(item.id)).toBeUndefined();
    expect(outbox.update(item.id, { text: 'late' })).toBeUndefined();
    expect(outbox.markSent(item.id)?.state).toBe('sent');
  });

  it('turns items stuck in sending into failed after a restart', async () => {
    const outbox = new Outbox(file);
    const stuck = outbox.enqueue(input({ text: 'stuck' }));
    outbox.markSending(stuck.id);
    await flushWrites();

    const reopened = new Outbox(file);
    expect(reopened.get(stuck.id)).toMatchObject({ state: 'failed', error: 'Interrupted by app restart' });
    expect(reopened.nextFor('s1')).toBeUndefined();
  });
});
