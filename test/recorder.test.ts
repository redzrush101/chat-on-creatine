import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { flushWrites } from '../src/main/core/durable';
import type { ChatMessage, PageEvent } from '@shared/page-protocol';
import type { SessionEvent } from '@shared/types';
import { Recorder } from '../src/main/sessions/recorder';
import { SessionStore } from '../src/main/sessions/store';

let dir: string;
let store: SessionStore;
let recorder: Recorder;
let sessionId: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'recorder-test-'));
  store = new SessionStore(dir, { recording: () => true });
  store.load();
  sessionId = store.create({ kind: 'chat' }).id;
  recorder = new Recorder({ store, isOwnConnectorPath: (path) => path.startsWith('/mcp/') });
});

afterEach(async () => {
  await flushWrites();
  rmSync(dir, { recursive: true, force: true });
});

function message(overrides: Partial<ChatMessage> & { id: string }): PageEvent {
  return {
    type: 'message',
    streamId: 's1',
    message: {
      conversationId: 'c1',
      role: 'assistant',
      authorName: null,
      recipient: 'all',
      channel: 'final',
      contentType: 'text',
      text: '',
      status: 'finished_successfully',
      endTurn: null,
      model: 'gpt-6',
      requestId: null,
      turnId: null,
      parentId: null,
      createTime: null,
      hidden: false,
      ...overrides
    }
  };
}

function events(): SessionEvent[] {
  return store.events(sessionId);
}

describe('Recorder', () => {
  it('records the browser echo of an app-sent message once, keeping the app event', () => {
    store.append(sessionId, [
      { id: 'input:1', at: 1, kind: 'user', text: 'fix the bug', inputId: '1', attachments: [], source: 'app' }
    ]);
    recorder.expectUserEcho(sessionId, 'input:1', 'fix   the bug');

    recorder.handle(
      sessionId,
      message({
        id: 'u1',
        role: 'user',
        recipient: 'all',
        channel: null,
        text: '<creatine_context>\nworkspace notes\n</creatine_context>\n\nfix the bug'
      })
    );

    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ id: 'input:1', source: 'app' });
  });

  it('records a user message the app did not send as a browser event, without the context frame', () => {
    recorder.handle(
      sessionId,
      message({ id: 'u2', role: 'user', text: '<creatine_context>x</creatine_context>hello there' })
    );
    expect(events()).toEqual([expect.objectContaining({ id: 'msg:u2', kind: 'user', text: 'hello there', source: 'browser' })]);
  });

  it('streams an assistant answer into one event that ends as final', () => {
    recorder.handle(sessionId, message({ id: 'a1', text: 'Hel', status: 'in_progress' }));
    recorder.handle(sessionId, message({ id: 'a1', text: 'Hello world', status: 'finished_successfully' }));

    expect(events()).toEqual([
      expect.objectContaining({ id: 'msg:a1', kind: 'assistant', text: 'Hello world', channel: 'final', streaming: false, model: 'gpt-6' })
    ]);
  });

  it('pairs a native tool call with its result and ignores our own connector calls', () => {
    recorder.handle(
      sessionId,
      message({ id: 'own', recipient: 'api_tool.call_tool', contentType: 'code', text: '{"path":"/mcp/read_file"}', channel: 'commentary' })
    );
    recorder.handle(
      sessionId,
      message({ id: 'call', recipient: 'web.run', contentType: 'code', text: '{"q":"creatine"}', channel: 'commentary', status: 'finished_successfully' })
    );
    recorder.handle(
      sessionId,
      message({ id: 'res', role: 'tool', parentId: 'call', recipient: 'all', contentType: 'text', text: 'found it' })
    );
    recorder.handle(
      sessionId,
      message({ id: 'own-res', role: 'tool', parentId: 'own', recipient: 'all', contentType: 'text', text: 'ignored' })
    );

    expect(events()).toEqual([
      expect.objectContaining({
        id: 'tool:call',
        kind: 'tool',
        surface: 'chatgpt',
        name: 'web.run',
        args: { q: 'creatine' },
        status: 'ok',
        output: [{ type: 'text', text: 'found it', truncated: false }]
      })
    ]);
  });

  it('records turn start and end with the outcome mapped to the app vocabulary', () => {
    recorder.handle(sessionId, { type: 'turn-start', streamId: 's1', conversationId: 'c1', requestId: null });
    recorder.handle(sessionId, { type: 'turn-end', streamId: 's1', conversationId: 'c1', outcome: 'aborted', error: null });

    expect(events()).toEqual([
      expect.objectContaining({ id: 'turn:s1:start', kind: 'turn', phase: 'start' }),
      expect.objectContaining({ id: 'turn:s1:end', kind: 'turn', phase: 'end', outcome: 'stopped' })
    ]);
  });

  it('adopts a ChatGPT title only while the session still has the default title', () => {
    recorder.handle(sessionId, { type: 'title', conversationId: 'c1', title: 'Fix the parser' });
    recorder.handle(sessionId, { type: 'title', conversationId: 'c1', title: 'Something else' });

    expect(store.get(sessionId)?.title).toBe('Fix the parser');
  });
});
