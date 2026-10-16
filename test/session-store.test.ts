import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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
  it('updates context incrementally through streaming, reconciliation, compaction and reload', async () => {
    const store = openStore();
    const meta = store.create({ kind: 'chat' });
    const reply: SessionEvent = { kind: 'assistant', id: 'reply', at: 1, messageId: 'm', text: 'x'.repeat(400), channel: 'final', model: null, streaming: true };
    store.append(meta.id, [reply]);
    expect(meta.contextTokens).toBe(100);
    store.append(meta.id, [{ ...reply, text: 'x'.repeat(800) }]);
    expect(meta.contextTokens).toBe(200);
    store.update(meta.id, { contextTokens: 300, contextUsage: { input: 0, output: 800, toolCalls: 0, toolResults: 0, other: 400 } });
    store.append(meta.id, [{ ...reply, text: 'x'.repeat(1200), streaming: false }]);
    expect(store.get(meta.id)?.contextTokens).toBe(400);
    await store.flush();
    const reopened = openStore();
    reopened.append(meta.id, [{ ...reply, text: 'x'.repeat(1600), streaming: false }]);
    expect(reopened.get(meta.id)?.contextTokens).toBe(500);
    reopened.append(meta.id, [{ kind: 'handoff', id: 'handoff', at: 2, fromConversationId: 'old', toConversationId: 'new', brief: '' }]);
    reopened.append(meta.id, [{ ...reply, text: 'late snapshot', streaming: false }]);
    expect(reopened.get(meta.id)?.contextTokens).toBe(0);
    reopened.append(meta.id, [{ ...reply, id: 'fresh', text: 'x'.repeat(80) }]);
    expect(reopened.get(meta.id)?.contextTokens).toBe(20);
    for (let length = 81; length <= 84; length++) reopened.append(meta.id, [{ ...reply, id: 'fresh', text: 'x'.repeat(length) }]);
    expect(reopened.get(meta.id)?.contextTokens).toBe(21);
    await reopened.flush();
  });

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
    reopened.append(meta.id, [note('c', 'after compaction')]);
    await reopened.flush();
    expect(openStore().events(meta.id).map((event) => event.id)).toEqual(['a', 'b', 'c']);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(3);
  });

  it('restores assistant and reasoning text without a stale live streaming state', async () => {
    const store = openStore();
    const meta = store.create({ kind: 'chat' });
    store.append(meta.id, [
      { id: 'answer', at: 1, kind: 'assistant', messageId: 'a1', text: 'Hello', channel: 'final', model: null, streaming: true },
      { id: 'thought', at: 2, kind: 'reasoning', messageId: 'r1', text: 'Thinking', streaming: true }
    ]);
    await store.flush();

    expect(store.events(meta.id).every((event) => 'streaming' in event && event.streaming)).toBe(true);
    expect(openStore().events(meta.id)).toEqual([
      expect.objectContaining({ id: 'answer', text: 'Hello', streaming: false }),
      expect.objectContaining({ id: 'thought', text: 'Thinking', streaming: false })
    ]);
  });

  it('coalesces streaming records while retaining live updates and persists the final text before shutdown', async () => {
    const store = openStore();
    const meta = store.create({ kind: 'chat' });
    const message: SessionEvent = { id: 'answer', at: 1, kind: 'assistant', messageId: 'a1', text: 'First', channel: 'final', model: null, streaming: true };
    const updates: string[] = [];
    store.onEvents((id, events) => { if (id === meta.id) for (const event of events) if (event.kind === 'assistant') updates.push(event.text); });
    store.append(meta.id, [message]);
    store.append(meta.id, [{ ...message, text: 'Second' }]);
    store.append(meta.id, [{ ...message, text: 'Final', streaming: false }]);
    await flushWrites();
    const lines = readFileSync(join(dir, meta.id, 'events.jsonl'), 'utf8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({ text: 'Final', streaming: false });
    expect(updates).toEqual(['First', 'Second', 'Final']);
    await store.flush();
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

  it('writes session metadata and messages with owner-only permissions on POSIX', async () => {
    const store = openStore();
    const meta = store.create({ kind: 'chat' });
    store.append(meta.id, [note('a', 'private conversation')]);
    await store.flush();
    if (process.platform !== 'win32') for (const name of ['meta.json', 'events.jsonl']) expect(statSync(join(dir, meta.id, name)).mode & 0o777).toBe(0o600);
  });
});
