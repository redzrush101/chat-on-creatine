import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SessionEvent } from '@shared/types';
import { flushWrites } from '../src/main/core/durable';
import { SessionStore } from '../src/main/sessions/store';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'store-test-'));
});

afterEach(async () => {
  await flushWrites();
  rmSync(dir, { recursive: true, force: true });
});

function note(id: string, text: string, at = 1): SessionEvent {
  return { id, at, kind: 'notice', level: 'info', text };
}

function openStore(recording = true): SessionStore {
  const store = new SessionStore(dir, { recording: () => recording });
  store.load();
  return store;
}

describe('SessionStore', () => {
  it('upserts events by id, keeps first position, and reloads collapsed from disk', async () => {
    const store = openStore();
    const meta = store.create({ kind: 'chat' });
    store.append(meta.id, [note('a', 'first'), note('b', 'second')]);
    store.append(meta.id, [note('a', 'first, edited')]);
    await store.flush();

    const reopened = openStore();
    const events = reopened.events(meta.id);
    expect(events.map((event) => event.id)).toEqual(['a', 'b']);
    expect(events[0]).toMatchObject({ text: 'first, edited' });
  });

  it('compacts the log on load once superseded lines exceed half the file', async () => {
    const store = openStore();
    const meta = store.create({ kind: 'chat' });
    for (let i = 0; i < 10; i++) store.append(meta.id, [note('a', `version ${i}`)]);
    store.append(meta.id, [note('b', 'other')]);
    await store.flush();

    const file = join(dir, meta.id, 'events.jsonl');
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(11);

    const reopened = openStore();
    expect(reopened.events(meta.id)).toHaveLength(2);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(2);
  });

  it('skips a corrupt event line instead of failing the session', async () => {
    const store = openStore();
    const meta = store.create({ kind: 'chat' });
    store.append(meta.id, [note('a', 'ok')]);
    await store.flush();
    const file = join(dir, meta.id, 'events.jsonl');
    writeFileSync(file, `${readFileSync(file, 'utf8')}{not json\n`);

    expect(openStore().events(meta.id).map((event) => event.id)).toEqual(['a']);
  });

  it('finds a session by its current conversation or an earlier one in its lineage', () => {
    const store = openStore();
    const old = store.create({ kind: 'chat', conversationId: 'c-old', lineage: [] });
    store.update(old.id, { conversationId: 'c-new', lineage: ['c-old'] });
    const other = store.create({ kind: 'chat', conversationId: 'c-other' });

    expect(store.byConversation('c-new')?.id).toBe(old.id);
    expect(store.byConversation('c-old')?.id).toBe(old.id);
    expect(store.byConversation('c-other')?.id).toBe(other.id);
    expect(store.byConversation('missing')).toBeUndefined();
  });

  it('prunes old unpinned sessions and keeps pinned ones; retention 0 keeps everything', async () => {
    const store = openStore();
    const old = store.create({ kind: 'chat', updatedAt: 1 });
    const pinned = store.create({ kind: 'chat', updatedAt: 1, pinned: true });
    const fresh = store.create({ kind: 'chat' });

    expect(store.prune(0)).toEqual([]);
    expect(store.prune(30)).toEqual([old.id]);
    expect(store.get(old.id)).toBeUndefined();
    expect(store.get(pinned.id)).toBeDefined();
    expect(store.get(fresh.id)).toBeDefined();

    await store.flush();
    expect(existsSync(join(dir, old.id))).toBe(false);
  });

  it('keeps events in memory only while recording is off', () => {
    const store = openStore(false);
    const meta = store.create({ kind: 'chat' });
    store.append(meta.id, [note('a', 'not written')]);

    expect(store.events(meta.id)).toHaveLength(1);
    expect(existsSync(join(dir, meta.id, 'events.jsonl'))).toBe(false);
  });
});
