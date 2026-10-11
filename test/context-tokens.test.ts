import { describe, expect, it } from 'vitest';
import type { ChatMessage } from '@shared/page-protocol';
import type { SessionEvent } from '@shared/types';
import { contextTokens } from '../src/main/sessions/tokens';

const user = (text: string): SessionEvent => ({ id: text, at: 1, kind: 'user', text, inputId: null, attachments: [], source: 'app' });
const tool = (resultChars: number | undefined, display: string): SessionEvent => ({
  id: `tool${display}`, at: 1, kind: 'tool', surface: 'core', name: 'read', args: null, status: 'ok',
  output: [{ type: 'text', text: display }], endedAt: 2, ...(resultChars === undefined ? {} : { resultChars })
});
const message = (role: ChatMessage['role'], contentType: string, text: string): ChatMessage => ({
  id: text, conversationId: 'c', role, authorName: null, recipient: 'all', channel: null, contentType, text, status: 'finished_successfully',
  endTurn: null, model: null, requestId: null, turnId: null, parentId: null, createTime: null, hidden: false, sources: [], citations: []
});

describe('contextTokens', () => {
  it('counts what the model received from a tool, not the shortened display copy', () => {
    // 4 characters of args ("null") plus 40,000 characters of result.
    expect(contextTokens([tool(40_000, 'short display')])).toBe(10_001);
  });

  it('starts over after Compact & Resume', () => {
    const handoff: SessionEvent = { id: 'h', at: 1, kind: 'handoff', fromConversationId: 'a', toConversationId: 'b', brief: 'brief' };
    expect(contextTokens([user('x'.repeat(4_000)), handoff, user('y'.repeat(400))])).toBe(100);
  });

  it("takes text from ChatGPT's transcript and tool results from the local record", () => {
    const transcript = [
      message('user', 'text', 'opening context and question'.padEnd(800, '.')),
      message('assistant', 'thoughts', 'r'.repeat(4_000)),
      message('tool', 'text', ''),
      message('assistant', 'text', 'a'.repeat(400))
    ];
    expect(contextTokens([user('question'), tool(1_600, 'display')], transcript)).toBe((800 + 400 + 1_600) / 4);
  });
});
