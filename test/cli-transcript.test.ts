import { expect, it } from 'vitest';
import type { SessionEvent } from '../src/shared/types';
import { Transcript } from '../src/cli/transcript';

it('upserts streamed messages and tools, prints each completion once, and retains drafts in the live preview', () => {
  const output: string[] = [];
  const transcript = new Transcript((text) => output.push(text), false);
  const assistant: SessionEvent = { id: 'answer', at: 1, kind: 'assistant', messageId: 'm', channel: 'final', model: null, text: 'Hello', streaming: true };
  const tool: SessionEvent = { id: 'tool', at: 2, kind: 'tool', surface: 'core', name: 'exec_command', args: { cmd: 'echo test' }, status: 'running', output: [], endedAt: null };
  transcript.consume([assistant, tool]);
  expect(output).toHaveLength(0);
  expect(transcript.preview()).toContain('Hello');
  expect(transcript.preview()).toContain('Running echo test');
  transcript.consume([{ ...tool, status: 'ok', endedAt: 3 }, { ...assistant, text: 'Hello world', streaming: false }]);
  transcript.consume([{ ...assistant, text: 'Hello world', streaming: false }]);
  expect(output).toHaveLength(2);
  expect(output.join('')).toContain('Hello world');
  expect(transcript.preview()).toBe('');
});

it('prints a stopped partial reply once and keeps errors readable without terminal escapes', () => {
  const output: string[] = [];
  const transcript = new Transcript((text) => output.push(text), false);
  transcript.consume([{ id: 'm', at: 1, kind: 'assistant', messageId: 'm', channel: 'commentary', model: null, text: 'Partial\x1b[2J', streaming: true }]);
  transcript.finish(); transcript.finish();
  expect(output).toHaveLength(1);
  expect(output[0]).toContain('Partial');
  expect(output[0]).not.toContain('\x1b');
});

it('toggles complete tool details without appending repeated tool results to history', () => {
  const output: string[] = [];
  const transcript = new Transcript((text) => output.push(text), false);
  const lines: string[] = [];
  for (let index = 1; index <= 20; index++) lines.push(`line ${index}`);
  transcript.consume([{ id: 'command', at: 1, kind: 'tool', surface: 'core', name: 'exec_command', args: { cmd: 'uname -r' }, status: 'ok', endedAt: 2,
    output: [{ type: 'exec', command: 'uname -r', cwd: null, exitCode: 0, sessionId: null, running: false, output: lines.join('\n') }] }]);
  const recorded = output.join('');
  for (let count = 0; count < 12; count++) {
    transcript.expand();
    if (count % 2 === 0) expect(transcript.details()).toContain('line 20');
    else expect(transcript.details()).toBeNull();
  }
  expect(output.join('')).toBe(recorded);
  expect(output).toHaveLength(1);
});
