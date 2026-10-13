import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { truncateToTokens } from '../../exec/output';
import { ToolError, type ToolContent, type ToolResult } from '../tool';
import { runCodeMode } from './runtime';

const pragmaSchema = z.strictObject({
  yield_time_ms: z.number().int().nonnegative().optional(),
  max_output_tokens: z.number().int().nonnegative().optional()
});

interface Cell {
  owner: string;
  controller: AbortController;
  output: ToolContent[];
  delivered: number;
  result: ToolResult | null;
  completion: Promise<ToolResult>;
  yielded: boolean;
  observing: boolean;
  terminated: boolean;
  wake: Set<() => void>;
}

/** Cells and serializable values belong to one server and one chat, never to an HTTP connection. */
export class CodeModeSession {
  private readonly cells = new Map<string, Cell>();
  private readonly stores = new Map<string, Map<string, string>>();

  async exec(
    code: string, tools: { name: string; description: string }[],
    invoke: (name: string, args: unknown, signal: AbortSignal) => Promise<ToolResult>, owner: string, signal: AbortSignal
  ): Promise<ToolResult> {
    let options: z.infer<typeof pragmaSchema> = {};
    const match = /^[ \t]*\/\/ @exec:([^\r\n]*)\r?\n/.exec(code);
    if (code.trimStart().startsWith('// @exec:')) {
      if (!match || !code.slice(match[0].length).trim()) throw new ToolError('INVALID_ARGUMENT', 'exec pragma must be followed by JavaScript source.');
      try { options = pragmaSchema.parse(JSON.parse(match[1]!)); }
      catch { throw new ToolError('INVALID_ARGUMENT', 'exec pragma must be JSON with non-negative safe integers yield_time_ms and max_output_tokens only.'); }
    }
    if (this.cells.size >= 64) {
      for (const [id, cell] of this.cells) if (cell.result) this.cells.delete(id);
      if (this.cells.size >= 64) throw new ToolError('LIMIT_EXCEEDED', 'Too many exec cells are running. Wait for or terminate a cell first.');
    }
    let stored = this.stores.get(owner);
    if (!stored) this.stores.set(owner, (stored = new Map()));
    const controller = new AbortController();
    const cell: Cell = {
      owner, controller, output: [], delivered: 0, result: null,
      completion: Promise.resolve({ content: [] }), yielded: false, observing: false, terminated: false, wake: new Set()
    };
    const wake = () => { for (const listener of cell.wake) listener(); };
    cell.completion = runCodeMode(code, tools, (name, args) => invoke(name, args, controller.signal), controller.signal,
      (block) => { cell.output.push(block); wake(); },
      () => { cell.yielded = true; wake(); }, stored
    ).then((result) => { cell.result = result; wake(); return result; });
    const id = randomUUID();
    this.cells.set(id, cell);
    return this.observe(id, cell, options.yield_time_ms ?? 30_000, options.max_output_tokens ?? 10_000, signal, false);
  }

  async wait(id: string, owner: string, signal: AbortSignal, yieldMs: number, maxTokens: number, terminate: boolean): Promise<ToolResult> {
    const cell = this.cells.get(id);
    if (!cell || cell.owner !== owner) throw new ToolError('UNKNOWN_SESSION', `No exec cell ${id} is available to this chat.`);
    if (terminate && !cell.result) { cell.terminated = true; cell.controller.abort(); }
    return this.observe(id, cell, yieldMs, maxTokens, signal, true);
  }

  async dispose(): Promise<void> {
    for (const cell of this.cells.values()) cell.controller.abort();
    await Promise.all([...this.cells.values()].map((cell) => cell.completion));
    this.cells.clear();
    this.stores.clear();
  }

  private async observe(id: string, cell: Cell, yieldMs: number, maxTokens: number, signal: AbortSignal, poll: boolean): Promise<ToolResult> {
    if (cell.observing) throw new ToolError('INVALID_ARGUMENT', 'Another call is already waiting on this exec cell.');
    cell.observing = true;
    const started = Date.now();
    const abort = () => cell.controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    try {
      await new Promise<void>((resolve) => {
        const done = () => { clearTimeout(timer); cell.wake.delete(check); resolve(); };
        const check = () => {
          if (cell.result || cell.yielded || (poll && cell.output.length > cell.delivered)) done();
        };
        const timer = setTimeout(done, Math.min(yieldMs, 60_000));
        cell.wake.add(check);
        check();
      });
      const result = cell.result;
      const status = cell.terminated ? 'Script terminated' : result ? result.isError ? 'Script failed' : 'Script completed' : `Script running with cell ID ${id}`;
      const content = cell.output.slice(cell.delivered);
      cell.delivered = cell.output.length;
      cell.yielded = false;
      // Runtime diagnostics were not emitted by the script and must survive earlier yields.
      if (result) content.unshift(...result.content.filter((block) => !cell.output.includes(block)));
      let budget = Math.min(maxTokens, 10_000);
      const bounded = content.map((block) => {
        if (block.type !== 'text') return block;
        const truncated = truncateToTokens(block.text, budget).text;
        budget = Math.max(0, budget - Math.ceil(Buffer.byteLength(block.text) / 4));
        return { type: 'text' as const, text: truncated };
      });
      if (result) this.cells.delete(id);
      return {
        content: [{ type: 'text', text: `${status}\nWall time ${((Date.now() - started) / 1000).toFixed(1)} seconds\nOutput:\n` }, ...bounded],
        isError: cell.terminated ? false : result?.isError ?? false
      };
    } finally {
      signal.removeEventListener('abort', abort);
      cell.observing = false;
    }
  }
}
