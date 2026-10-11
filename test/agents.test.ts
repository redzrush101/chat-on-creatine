import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultConfig } from '@shared/config';
import type { SessionMeta } from '@shared/types';
import { AgentController } from '../src/main/agents/controller';
import { type Caller, ToolError } from '../src/main/mcp/tool';
import { Outbox } from '../src/main/sessions/outbox';
import { SessionStore } from '../src/main/sessions/store';

let dir: string;
let stores: SessionStore[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'agents-test-'));
});

afterEach(async () => {
  // Saves are debounced; flushing the stores keeps a late save from racing the removal.
  await Promise.all(stores.map((store) => store.flush()));
  stores = [];
  rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const store = new SessionStore(dir, { recording: () => true });
  stores.push(store);
  store.load();
  const outbox = new Outbox(join(dir, 'outbox.json'));
  const interrupt = vi.fn();
  const controller = new AgentController({
    store,
    outbox,
    getConfig: () => defaultConfig(),
    turnOf: () => 'idle',
    interrupt,
    onChange: () => {}
  });
  const prime = store.create({ kind: 'chat', title: 'Prime', conversationId: 'conv-prime' });
  const callerOf = (session: SessionMeta): Caller => ({
    sessionId: session.id,
    conversationId: session.conversationId ?? 'conv',
    cwd: null,
    kind: session.kind as Caller['kind']
  });
  const worker = (label: string): SessionMeta => {
    const found = store.list().find((meta) => meta.kind === 'worker' && meta.title === label);
    if (!found) throw new Error(`no worker ${label}`);
    return found;
  };
  return { store, outbox, controller, prime, callerOf, worker, interrupt };
}

const THREE = {
  context: 'Repo: app. Do not touch the lockfile.',
  workers: [
    { label: 'A', task: 'Write the parser' },
    { label: 'B', task: 'Write the tests' },
    { label: 'C', task: 'Write the docs' }
  ]
};

describe('AgentController', () => {
  it('spawn creates worker sessions with queued briefs', async () => {
    const { store, outbox, controller, prime, callerOf } = setup();
    const text = await controller.spawn(callerOf(prime), THREE);

    const workers = store.list().filter((meta) => meta.kind === 'worker');
    expect(workers.map((meta) => meta.title).sort()).toEqual(['A', 'B', 'C']);
    expect(workers.every((meta) => meta.parentId === prime.id)).toBe(true);
    const brief = outbox.list(workers[0]!.id)[0]!;
    expect(brief.source).toBe('agent');
    expect(brief.delivery).toBe('after-turn');
    expect(brief.text).toContain('Repo: app.');
    expect(brief.text).toContain('action=finish');
    expect(text).toContain('A (');
    expect(store.events(prime.id).some((event) => event.kind === 'agent' && event.action === 'spawned')).toBe(true);
  });

  it('allows maxConcurrent workers at once and holds the next until a slot frees', async () => {
    const { controller, prime, callerOf, worker } = setup();
    await controller.spawn(callerOf(prime), THREE);

    expect(controller.canStart(worker('A'))).toBe(true);
    expect(controller.canStart(worker('B'))).toBe(true);
    expect(controller.canStart(worker('C'))).toBe(false);

    await controller.finish(callerOf(worker('A')), { result: 'parser done' });
    expect(controller.canStart(worker('C'))).toBe(true);
  });

  it('finish marks the worker asleep and sends its result to the prime as a steering message', async () => {
    const { outbox, controller, prime, callerOf, worker } = setup();
    await controller.spawn(callerOf(prime), THREE);
    controller.canStart(worker('A'));

    await controller.finish(callerOf(worker('A')), { result: 'parser done' });

    const report = outbox.list(prime.id).find((item) => item.text.startsWith('Worker "A" finished:'));
    expect(report).toMatchObject({ delivery: 'now', source: 'agent', text: 'Worker "A" finished:\n\nparser done' });
    const run = controller.runs().find((entry) => entry.primeSessionId === prime.id)!;
    expect(run.workers.find((info) => info.label === 'A')).toMatchObject({ state: 'asleep', lastResult: 'parser done' });
  });

  it('message wakes an asleep worker with a queued user message', async () => {
    const { outbox, controller, prime, callerOf, worker } = setup();
    await controller.spawn(callerOf(prime), THREE);
    controller.canStart(worker('A'));
    for (const item of outbox.list(worker('A').id)) outbox.markSending(item.id) && outbox.markSent(item.id);
    await controller.finish(callerOf(worker('A')), { result: 'parser done' });

    await controller.message(callerOf(prime), { messages: [{ to: 'A', text: 'Also cover errors.' }] });

    expect(outbox.list(worker('A').id).find((item) => item.state === 'queued')).toMatchObject({
      delivery: 'after-turn',
      text: 'Message from the prime chat:\n\nAlso cover errors.'
    });
    const run = controller.runs().find((entry) => entry.primeSessionId === prime.id)!;
    expect(run.workers.find((info) => info.label === 'A')?.state).toBe('queued');
  });

  it('a message to a working worker is sent as its next message and stops its turn', async () => {
    const { outbox, controller, prime, callerOf, worker, interrupt } = setup();
    await controller.spawn(callerOf(prime), THREE);
    controller.canStart(worker('A'));
    for (const item of outbox.list(worker('A').id)) outbox.markSending(item.id) && outbox.markSent(item.id);

    const reply = await controller.message(callerOf(prime), { messages: [{ to: 'A', text: 'Stop, use the other API.' }] });

    expect(interrupt).toHaveBeenCalledExactlyOnceWith(worker('A').id);
    expect(outbox.list(worker('A').id).filter((item) => item.state === 'queued')).toEqual([
      expect.objectContaining({ delivery: 'after-turn', text: 'Message from the prime chat:\n\nStop, use the other API.' })
    ]);
    expect(reply).toContain('its turn was stopped');
  });

  it('reports that have not reached the prime yet travel as one message', async () => {
    const { outbox, controller, prime, callerOf, worker } = setup();
    await controller.spawn(callerOf(prime), THREE);
    controller.canStart(worker('A'));
    controller.canStart(worker('B'));

    await controller.finish(callerOf(worker('A')), { result: 'parser done' });
    await controller.finish(callerOf(worker('B')), { result: 'tests done' });

    const queued = outbox.list(prime.id).filter((item) => item.state === 'queued');
    expect(queued).toHaveLength(1);
    expect(queued[0]!.text).toBe('Worker "A" finished:\n\nparser done\n\n---\n\nWorker "B" finished:\n\ntests done');
  });

  it('a worker cannot spawn workers', async () => {
    const { controller, prime, callerOf, worker } = setup();
    await controller.spawn(callerOf(prime), THREE);

    await expect(controller.spawn(callerOf(worker('A')), THREE)).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    await expect(controller.spawn(callerOf(worker('A')), THREE)).rejects.toBeInstanceOf(ToolError);
  });

  it('a turn that ends without finish puts the worker to sleep and forwards its last answer', async () => {
    const { store, outbox, controller, prime, callerOf, worker } = setup();
    await controller.spawn(callerOf(prime), THREE);
    controller.canStart(worker('B'));
    // The brief was delivered and its turn ran; only then does the turn end.
    for (const item of outbox.list(worker('B').id)) {
      outbox.markSending(item.id);
      outbox.markSent(item.id);
    }
    store.append(worker('B').id, [
      { id: 'a1', at: 1, kind: 'assistant', messageId: 'm1', text: 'Half way.', channel: 'commentary', model: null, streaming: false },
      { id: 'a2', at: 2, kind: 'assistant', messageId: 'm2', text: 'Tests written.', channel: 'final', model: null, streaming: false }
    ]);

    controller.onTurnEnd(store.get(worker('B').id)!, 'done');

    expect(outbox.list(prime.id).find((item) => item.text.startsWith('Worker "B" finished:'))?.text).toBe(
      'Worker "B" finished:\n\nTests written.'
    );
    const run = controller.runs().find((entry) => entry.primeSessionId === prime.id)!;
    expect(run.workers.find((info) => info.label === 'B')?.state).toBe('asleep');
  });

  it('a message batch with an unknown recipient queues nothing', async () => {
    const { outbox, controller, prime, callerOf, worker } = setup();
    await controller.spawn(callerOf(prime), THREE);

    await expect(
      controller.message(callerOf(prime), {
        messages: [
          { to: 'A', text: 'first' },
          { to: 'Nobody', text: 'second' }
        ]
      })
    ).rejects.toMatchObject({ code: 'INVALID_ARGUMENT' });
    expect(outbox.list(worker('A').id).map((item) => item.text)).toEqual([expect.stringContaining('Repo: app.')]);
  });

  it('re-spawning an identical worker returns the existing one', async () => {
    const { store, controller, prime, callerOf } = setup();
    await controller.spawn(callerOf(prime), THREE);
    const text = await controller.spawn(callerOf(prime), { context: THREE.context, workers: [THREE.workers[0]!] });

    expect(store.list().filter((meta) => meta.kind === 'worker')).toHaveLength(3);
    expect(text).toContain('already exists');
  });
});
