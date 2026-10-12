import { describe, expect, it } from 'vitest';
import type { SessionEvent, ToolOutputPart } from '@shared/types';
import { describeTool, diffRows, diffTotals, summarizeTools, toolBaseName } from '../src/shared/tool-labels';
import { buildBlocks } from '../src/renderer/components/chat/timeline-model';

type ToolEvent = Extract<SessionEvent, { kind: 'tool' }>;

let seq = 0;
function tool(name: string, args: unknown, output: ToolOutputPart[] = [], surface: ToolEvent['surface'] = 'core'): ToolEvent {
  seq += 1;
  return { id: `tool:${seq}`, at: seq, kind: 'tool', surface, name, args, status: 'ok', output, endedAt: seq + 1 };
}

const editDiff: ToolOutputPart = {
  type: 'diff',
  path: '/repo/report.md',
  diff: '--- a/report.md\n+++ b/report.md\n@@ -1,3 +1,3 @@\n # Report\n-Date: 2026-10-11\n+Date: 2026-10-11 17:00\n Repo\n',
  added: 1,
  removed: 1
};
const createDiff: ToolOutputPart = { type: 'diff', path: '/repo/notes.md', diff: '--- /dev/null\n+++ b/notes.md\n@@ -0,0 +1,2 @@\n+one\n+two\n', added: 2, removed: 0 };

describe('tool labels', () => {
  it('strips ChatGPT namespaces and connector paths from tool names', () => {
    expect(toolBaseName('functions.exec')).toBe('exec');
    expect(toolBaseName('/Chat On Creatine Core/link_6aca/read')).toBe('read');
    expect(toolBaseName('container.exec')).toBe('container.exec');
  });

  it('describes commands, reads, edits and agents', () => {
    expect(describeTool(tool('exec_command', { cmd: 'ls -la', workdir: '/repo' }))).toMatchObject({ category: 'command', verb: 'Ran', target: 'ls -la', code: true });
    expect(describeTool(tool('exec_command', { cmds: ['uname -r', 'ls'] }))).toMatchObject({ target: 'uname -r; ls', code: true });
    expect(describeTool(tool('read', { paths: ['/repo/a.ts', '/repo/b.ts'] }))).toMatchObject({ category: 'read', target: 'a.ts, b.ts' });
    expect(describeTool(tool('/Core/link_1/read', { path: '/Core/link_1/read', args: { paths: ['/x/hello.txt'] } }))).toMatchObject({ target: 'hello.txt' });
    expect(describeTool(tool('api_tool.call_tool', '{"path":"/Core/link_1/update_plan","args":{"pl', [], 'chatgpt'))).toMatchObject({ category: 'plan' });
    expect(describeTool(tool('apply_patch', { patch: '' }, [editDiff]))).toMatchObject({ category: 'edit', verb: 'Edited', target: 'report.md' });
    expect(describeTool(tool('apply_patch', { patch: '' }, [createDiff]))).toMatchObject({ category: 'create', verb: 'Created', target: 'notes.md' });
    // Before the result arrives, the patch headers name the file.
    expect(describeTool(tool('apply_patch', { patch: '*** Begin Patch\n*** Add File: /repo/new.txt\n+x\n*** End Patch' }))).toMatchObject({ category: 'create', target: 'new.txt' });
    expect(describeTool(tool('agents', { action: 'spawn', workers: [{ label: 'alpha', task: 't' }, { label: 'beta', task: 't' }] }))).toMatchObject({ verb: 'Started agents', target: 'alpha, beta' });
    expect(describeTool(tool('exec', { code: 'await tools.read({}); await tools.exec_command({})' }))).toMatchObject({ category: 'script', target: 'using read, exec_command' });
    const page = { title: '', url: 'https://cdn.kernel.org/x', domain: 'cdn.kernel.org', ref: 'turn1view0' };
    expect(describeTool(tool('web.run', '', [{ type: 'sources', sources: [page] }], 'chatgpt'))).toMatchObject({ verb: 'Opened', target: 'cdn.kernel.org' });
    expect(describeTool(tool('web.run', '', [{ type: 'sources', sources: [{ ...page, ref: 'turn1search0' }] }], 'chatgpt'))).toMatchObject({ verb: 'Searched the web', target: 'cdn.kernel.org' });
  });

  it('summarizes a group like "Ran 2 commands, edited report.md"', () => {
    const events = [tool('exec_command', { cmd: 'pwd' }), tool('exec_command', { cmd: 'date' }), tool('apply_patch', {}, [editDiff])];
    expect(summarizeTools(events)).toBe('Ran 2 commands, edited report.md');
    expect(summarizeTools([tool('exec_command', { cmd: 'pwd' })])).toBe('Ran a command');
    expect(summarizeTools([tool('read', { paths: ['/a/x.md', '/a/y.md'] }), tool('exec_command', { cmd: 'ls' })])).toBe('Read 2 files, ran a command');
    expect(summarizeTools([tool('exec', { code: 'await tools.read({})' }), tool('read', { paths: ['/a/x.md'] })])).toBe('Read x.md');
    expect(summarizeTools([tool('exec', { code: 'text(ALL_TOOLS)' })])).toBe('Ran a script');
    expect(summarizeTools([tool('agents', { action: 'spawn', workers: [{ label: 'Reviewer', task: 't' }] })])).toBe('Started agent Reviewer');
    expect(diffTotals(events)).toEqual({ added: 1, removed: 1 });
    expect(diffTotals([tool('exec_command', { cmd: 'pwd' })])).toBeNull();
  });

  it('numbers diff lines from the hunk header', () => {
    expect(diffRows(String((editDiff as { diff: string }).diff))).toEqual([
      { kind: 'ctx', line: 1, text: '# Report' },
      { kind: 'del', line: 2, text: 'Date: 2026-10-11' },
      { kind: 'add', line: 2, text: 'Date: 2026-10-11 17:00' },
      { kind: 'ctx', line: 3, text: 'Repo' }
    ]);
  });
});

describe('timeline blocks', () => {
  const assistant = (id: string, channel: 'final' | 'commentary'): SessionEvent => ({ id, at: 0, kind: 'assistant', messageId: id, text: 'x', channel, model: null, streaming: false });

  it('groups every run of tool calls, and keeps commentary as its own row', () => {
    const a = tool('exec_command', { cmd: 'pwd' });
    const b = tool('read', { paths: ['/a'] });
    const c = tool('exec_command', { cmd: 'ls' });
    const blocks = buildBlocks([a, b, assistant('m1', 'commentary'), c, assistant('m2', 'final')], false);
    expect(blocks.map((block) => (block.type === 'work' ? `work:${block.events.length}` : block.event.kind))).toEqual(['work:2', 'assistant', 'work:1', 'assistant']);
  });

  it('leaves a spawn call out when the agent rows it produced follow', () => {
    const spawn = tool('agents', { action: 'spawn', workers: [{ label: 'alpha', task: 't' }] });
    const spawned: SessionEvent = { id: 'agent:1', at: 0, kind: 'agent', workerSessionId: 'w1', label: 'alpha', action: 'spawned', text: 't' };
    const kinds = (events: SessionEvent[]) => buildBlocks(events, false).map((block) => (block.type === 'work' ? 'work' : block.event.kind));
    expect(kinds([spawn, spawned])).toEqual(['agent']);
    expect(kinds([tool('exec_command', { cmd: 'ls' }), spawn, spawned])).toEqual(['work', 'agent']);
  });
});
