import { describe, expect, it } from 'vitest';
import {
  ConversationStreamParser,
  conversationToMessages,
  normalizeMessage
} from '@shared/chatgpt-stream';
import type { ChatMessage } from '@shared/page-protocol';

const CONV = '6aca0000-0000-4000-8000-000000000001';

function sse(events: { event?: string; data: string }[]): string {
  return events.map((e) => `${e.event ? `event: ${e.event}\n` : ''}data: ${e.data}\n\n`).join('');
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function feed(text: string, sizes = [1, 2, 3, 7, 5, 11, 4]): string[] {
  const pieces: string[] = [];
  let at = 0;
  for (let i = 0; at < text.length; i++) {
    const size = sizes[i % sizes.length]!;
    pieces.push(text.slice(at, at + size));
    at += size;
  }
  return pieces;
}

function run(text: string, sizes?: number[]) {
  const messages: ChatMessage[] = [];
  const conversations: string[] = [];
  const titles: [string, string][] = [];
  let completed = 0;
  const errors: string[] = [];
  const parser = new ConversationStreamParser({
    message: (m) => messages.push({ ...m }),
    conversation: (id) => conversations.push(id),
    title: (id, title) => titles.push([id, title]),
    complete: () => completed++,
    error: (text) => errors.push(text)
  });
  for (const piece of feed(text, sizes)) parser.push(piece);
  parser.end();
  // Last state per id: messages are emitted after every delta.
  const latest = new Map<string, ChatMessage>();
  for (const m of messages) latest.set(m.id, m);
  return { messages, latest, conversations, titles, completed, errors };
}

const systemMessage = {
  id: 'm1',
  author: { role: 'system', name: null, metadata: {} },
  create_time: null,
  content: { content_type: 'text', parts: [''] },
  status: 'finished_successfully',
  end_turn: null,
  metadata: { is_visually_hidden_from_conversation: true },
  recipient: 'all',
  channel: null
};

const userMessage = {
  id: 'm2',
  author: { role: 'user', name: null, metadata: {} },
  create_time: 1700000000.5,
  content: { content_type: 'text', parts: ['hello'] },
  status: 'finished_successfully',
  metadata: { request_id: '52c2aaaa', turn_exchange_id: 'bd85', parent_id: 'm1' },
  recipient: 'all',
  channel: null
};

const assistantMessage = {
  id: 'm3',
  author: { role: 'assistant', name: null, metadata: {} },
  create_time: null,
  content: { content_type: 'text', parts: [''] },
  status: 'in_progress',
  end_turn: null,
  metadata: { request_id: '52c2aaaa', turn_exchange_id: 'bd85', parent_id: 'm2', model_slug: 'gpt-5' },
  recipient: 'all',
  channel: 'final'
};

describe('ConversationStreamParser', () => {
  const stream = sse([
    { event: 'delta_encoding', data: json('v1') },
    { data: json({ type: 'resume_conversation_token', kind: 'topic', token: 't', conversation_id: CONV }) },
    { event: 'delta', data: json({ p: '', o: 'add', v: { message: systemMessage, conversation_id: CONV, error: null }, c: 0 }) },
    { event: 'delta', data: json({ v: { message: userMessage, conversation_id: CONV, error: null }, c: 1 }) },
    { data: json({ type: 'input_message', input_message: userMessage, conversation_id: CONV }) },
    { event: 'delta', data: json({ p: '', o: 'add', v: { message: assistantMessage, conversation_id: CONV, error: null }, c: 2 }) },
    { event: 'delta', data: json({ p: '/message/content/parts/0', o: 'append', v: 'Hi' }) },
    { event: 'delta', data: json({ v: ' there' }) },
    { event: 'delta', data: json({ p: '', o: 'patch', v: [
      { p: '/message/content/parts/0', o: 'append', v: ' friend.' },
      { p: '/message/status', o: 'replace', v: 'finished_successfully' },
      { p: '/message/end_turn', o: 'replace', v: true },
      { p: '/message/metadata/model_slug', o: 'remove' }
    ] }) },
    { data: json({ type: 'title_generation', title: 'Greeting', conversation_id: CONV }) },
    { data: json({ type: 'message_marker', conversation_id: CONV }) },
    { data: json({ type: 'message_stream_complete', conversation_id: CONV }) },
    { data: '[DONE]' }
  ]).replace('event: delta\ndata: {"p":"","o":"patch"', ': ping\n\nevent: delta\ndata: {"p":"","o":"patch"');

  it('tracks conversation, messages, implicit appends and patches across awkward chunk boundaries', () => {
    const { latest, conversations, titles, completed, errors } = run(stream, [1, 2, 3, 5, 8]);
    expect(conversations).toEqual([CONV]);
    expect(titles).toEqual([[CONV, 'Greeting']]);
    expect(completed).toBe(2); // message_stream_complete and [DONE]
    expect(errors).toEqual([]);

    const user = latest.get('m2')!;
    expect(user.role).toBe('user');
    expect(user.text).toBe('hello');
    expect(user.requestId).toBe('52c2aaaa');
    expect(user.turnId).toBe('bd85');
    expect(user.parentId).toBe('m1');
    expect(user.createTime).toBe(1700000000.5);

    expect(latest.get('m1')!.hidden).toBe(true);

    const assistant = latest.get('m3')!;
    expect(assistant.text).toBe('Hi there friend.');
    expect(assistant.status).toBe('finished_successfully');
    expect(assistant.endTurn).toBe(true);
    expect(assistant.model).toBeNull(); // removed by the patch
    expect(assistant.channel).toBe('final');
  });

  it('gives the same result for CRLF line endings and for a single chunk', () => {
    const crlf = stream.replace(/\n/g, '\r\n');
    const a = run(crlf, [1, 4, 2]).latest.get('m3')!;
    const b = run(stream).latest.get('m3')!;
    expect(a).toEqual(b);
    expect(a.text).toBe('Hi there friend.');
  });

  it('normalizes tool calls, tool results and code content', () => {
    const call = {
      id: 'tool1',
      author: { role: 'assistant', name: null, metadata: {} },
      content: { content_type: 'code', language: 'json', text: '' },
      status: 'in_progress',
      recipient: 'api_tool.call_tool',
      channel: 'commentary',
      metadata: { request_id: 'req-1' }
    };
    const result = {
      id: 'tool2',
      author: { role: 'tool', name: 'web.run', metadata: {} },
      content: { content_type: 'text', parts: ['result'] },
      status: 'finished_successfully',
      recipient: 'assistant',
      metadata: {}
    };
    const events = sse([
      { event: 'delta', data: json({ p: '', o: 'add', v: { message: call, conversation_id: CONV, error: null }, c: 0 }) },
      { event: 'delta', data: json({ p: '/message/content/text', o: 'append', v: '{"path":"/Files/link_1/read",' }) },
      { event: 'delta', data: json({ v: '"args":{}}' }) },
      { event: 'delta', data: json({ p: '', o: 'add', v: { message: result, conversation_id: CONV, error: null }, c: 1 }) },
      { data: '[DONE]' }
    ]);
    const { latest } = run(events, [6, 9, 13]);
    const tool = latest.get('tool1')!;
    expect(tool.recipient).toBe('api_tool.call_tool');
    expect(tool.contentType).toBe('code');
    expect(tool.text).toBe('{"path":"/Files/link_1/read","args":{}}');
    const web = latest.get('tool2')!;
    expect(web.role).toBe('tool');
    expect(web.authorName).toBe('web.run');
    expect(web.text).toBe('result');
  });

  it('removes array items, reports envelope errors and completes on [DONE] alone', () => {
    const msg = { ...assistantMessage, content: { content_type: 'text', parts: ['a', 'b', 'c'] } };
    const events = sse([
      { event: 'delta', data: json({ p: '', o: 'add', v: { message: msg, conversation_id: CONV, error: null } }) },
      { event: 'delta', data: json({ p: '/message/content/parts/1', o: 'remove' }) },
      { event: 'delta', data: json({ p: '/message/content/parts/0', o: 'truncate', v: 0 }) },
      { event: 'delta', data: json({ p: '/error', o: 'replace', v: 'boom' }) },
      { data: '[DONE]' }
    ]);
    const result = run(events);
    expect(result.latest.get('m3')!.text).toBe('c');
    expect(result.errors).toEqual(['boom']);
    expect(result.completed).toBe(1);
  });

  it('ends without completion when the stream stops early', () => {
    const result = run(sse([{ event: 'delta', data: json({ p: '', o: 'add', v: { message: userMessage, conversation_id: CONV, error: null } }) }]));
    expect(result.completed).toBe(0);
    expect(result.latest.get('m2')!.text).toBe('hello');
  });
});

describe('conversationToMessages', () => {
  it('returns only the current branch, oldest first, without hidden system messages', () => {
    const node = (id: string, parent: string | null, message: unknown, children: string[] = []) => ({
      id,
      message,
      parent,
      children
    });
    const user = (id: string, text: string) => ({
      id,
      author: { role: 'user', metadata: {} },
      content: { content_type: 'text', parts: [text] },
      status: 'finished_successfully',
      metadata: {},
      recipient: 'all'
    });
    const assistant = (id: string, text: string) => ({ ...user(id, text), author: { role: 'assistant', metadata: {} } });
    const json = {
      conversation_id: CONV,
      current_node: 'u2',
      mapping: {
        root: node('root', null, null, ['sys']),
        sys: node('sys', 'root', { ...systemMessage, id: 'sys' }, ['u1']),
        u1: node('u1', 'sys', user('u1', 'first'), ['a1', 'a-alt']),
        a1: node('a1', 'u1', assistant('a1', 'answer one'), ['u2']),
        'a-alt': node('a-alt', 'u1', assistant('a-alt', 'other branch'), []),
        u2: node('u2', 'a1', user('u2', 'second'), []),
        empty: node('empty', null, null)
      }
    };
    const messages = conversationToMessages(json);
    expect(messages.map((m) => [m.id, m.text])).toEqual([
      ['u1', 'first'],
      ['a1', 'answer one'],
      ['u2', 'second']
    ]);
    expect(messages.every((m) => m.conversationId === CONV)).toBe(true);
  });

  it('returns nothing for a payload without a mapping', () => {
    expect(conversationToMessages({ current_node: 'x' })).toEqual([]);
    expect(normalizeMessage({ id: 'x' }, CONV)).toBeNull();
  });
});
