import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { answer, tools, useLive } from './harness';

const run = useLive('automation', { automation: { maxSteps: 2 }, agents: { enabled: true, maxConcurrent: 2 } });
const goal = (id: string) => run().state.sessions.find((session) => session.id === id)?.goal;

describe.concurrent('automation', () => {
  it('reaches a Goal across several turns', async () => {
    const live = run();
    const id = await live.send('Create g1.txt and g2.txt in this folder, each containing its number. Create exactly one file per turn, then stop and wait.', { automation: 'goal' });
    await live.until('the goal', (events, state) => ['done', 'stopped', 'error'].includes(goal(id)?.status ?? '') && live.idle(id)(events, state), id, 12 * 60_000);
    await live.timeline(id, 'goal');
    for (const number of [1, 2]) expect(readFileSync(join(live.workspace, `g${number}.txt`), 'utf8').trim()).toBe(String(number));
    expect(goal(id)?.status).toBe('done');
  });

  it('keeps what matters through Compact & Resume', async () => {
    const live = run();
    const id = await live.send('Remember this codeword for later: PELICAN-58. Reply with just OK.');
    await live.until('the first answer', live.idle(id), id);
    await live.api.invoke('chat:compact', id);
    await live.until('the resumed chat', (events, state) => (state.sessions.find((session) => session.id === id)?.lineage.length ?? 0) >= 1 && live.idle(id)(events, state), id);
    await live.send('What was the codeword I asked you to remember? Reply with just the codeword.', { sessionId: id });
    const events = await live.until('the codeword', (events, state) => /PELICAN-58/.test(answer(events)) || live.idle(id, 99)(events, state), id);
    await live.timeline(id, 'compact');
    expect(answer(events)).toContain('PELICAN-58');
  });

  it('repeats a Loop until its step limit', async () => {
    const live = run();
    const id = await live.send('Write one short fun fact about octopuses. No tools needed.', { automation: 'loop' });
    const events = await live.until('the loop to stop', (events, state) => ['done', 'stopped', 'error'].includes(goal(id)?.status ?? '') && live.idle(id)(events, state), id, 10 * 60_000);
    await live.timeline(id, 'loop');
    expect(goal(id)).toMatchObject({ status: 'stopped', steps: 2 });
    expect(events.filter((event) => event.kind === 'assistant' && event.channel === 'final').length).toBeGreaterThanOrEqual(3);
  });

  it('runs two agents and collects their results', async () => {
    const live = run();
    const id = await live.send('Use the agents tool with action "spawn" to start exactly 2 workers: worker "alpha" creates alpha.txt in this folder containing ALPHA, worker "beta" creates beta.txt containing BETA. Each reports back with action "finish". After spawning, end your turn. When both results are in, reply with a one-line summary.');
    await live.until('both workers', (events, state) => existsSync(join(live.workspace, 'alpha.txt')) && existsSync(join(live.workspace, 'beta.txt')) &&
      !!state.agents.find((agentRun) => agentRun.primeSessionId === id)?.workers.every((worker) => worker.state === 'asleep') && live.idle(id, 2)(events, state), id, 12 * 60_000);
    await live.timeline(id, 'agents');
    expect(readFileSync(join(live.workspace, 'alpha.txt'), 'utf8').trim()).toBe('ALPHA');
    expect(readFileSync(join(live.workspace, 'beta.txt'), 'utf8').trim()).toBe('BETA');
    expect(live.state.agents.find((agentRun) => agentRun.primeSessionId === id)?.workers).toHaveLength(2);
  });

  it('redirects a busy worker at once', async () => {
    const live = run();
    const prime = await live.send('Reply with just OK.');
    await live.until('the prime chat', live.idle(prime), prime);
    const caller = { sessionId: prime, conversationId: 'none', cwd: live.workspace, kind: 'chat' as const };
    const worker = await live.main(async (services, { caller, cwd }) => {
      await services.agents.spawn(caller, { context: '', workers: [{ label: 'sleeper', task: `Run \`sleep 45 && echo SLOW > slow.txt\` with exec_command in ${cwd} (yield_time_ms 50000), then finish.` }] });
      return services.store.list().find((session) => session.parentId === caller.sessionId)!.id;
    }, { caller, cwd: live.workspace });
    await live.until('the worker command', (events) => tools(events).some((event) => event.status === 'running'), worker);
    const sentAt = Date.now();
    await live.main((services, caller) => services.agents.message(caller, { messages: [{ to: 'sleeper', text: 'Change of plan: do not wait for the sleep. Create fast.txt containing FAST, then finish.' }] }), caller);
    const events = await live.until('the redirect', (events) => events.some((event) => event.kind === 'user' && /Change of plan/.test(event.text)), worker, 120_000);
    await live.until('fast.txt', () => existsSync(join(live.workspace, 'fast.txt')), worker);
    await live.timeline(worker, 'agent-interrupt');
    const redirect = events.find((event) => event.kind === 'user' && /Change of plan/.test(event.text))!;
    live.log('redirect delivered after', redirect.at - sentAt, 'ms');
    expect(redirect.at - sentAt).toBeLessThan(30_000);
  });
});
