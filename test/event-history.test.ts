import { expect, it } from 'vitest';
import type { SessionEvent } from '@shared/types';
import { EventHistory } from '../src/shared/event-history';

const answer = (text: string, streaming: boolean): SessionEvent => ({ id: 'answer', kind: 'assistant', at: 1, messageId: 'message', model: null, channel: 'final', text, streaming });

it('preserves incoming stream updates while initial history loads and retains the original event order', () => {
  const history = new EventHistory();
  const final = answer('The completed response', false);
  const later: SessionEvent = { id: 'notice', kind: 'notice', level: 'info', text: 'Finished', at: 2 };
  history.merge([final, later]);
  expect(history.read()).toBeNull();
  history.load([{ id: 'user', kind: 'user', at: 0, text: 'Prompt', attachments: [], inputId: null, source: 'app' }, answer('The', true)]);
  expect(history.read()?.map((event) => event.id)).toEqual(['user', 'answer', 'notice']);
  expect(history.read()?.[1]).toBe(final);
  history.merge([answer('Delayed partial', true)]);
  expect(history.read()?.[1]).toBe(final);
});
