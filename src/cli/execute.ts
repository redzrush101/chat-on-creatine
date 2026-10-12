import type { SessionEvent } from '@shared/types';
import { safeText, screenColumns } from './format';
import { formatEvent } from './render';
import type { CliSession } from './session';

export async function execute(session: CliSession): Promise<void> {
  const client = session.client;
  const json = (value: unknown) => process.stdout.write(`${JSON.stringify(value)}\n`);
  const before = new Set(session.id ? (await client.invoke('sessions:events', session.id)).map((event) => event.id) : []);
  const printed = new Set<string>();
  const events = new Map<string, SessionEvent>();
  let inputId: string | null = null;
  let resolveDone: () => void = () => {};
  let rejectDone: (error: Error) => void = () => {};
  const done = new Promise<void>((resolve, reject) => { resolveDone = resolve; rejectDone = reject; });
  void done.catch(() => {});
  const check = () => {
    if (!session.id || !inputId) return;
    const input = session.state.inputs.find((item) => item.id === inputId);
    if (input?.state === 'failed' || input?.state === 'cancelled') { rejectDone(new Error(input.error ?? 'Input cancelled.')); return; }
    const ended = [...events.values()].some((event) => event.kind === 'turn' && event.phase === 'end' && !before.has(event.id));
    if (!ended || session.busy) return;
    if (session.state.agents.some((run) => run.primeSessionId === session.id && run.workers.some((worker) => worker.state === 'working' || worker.state === 'queued'))) return;
    if (session.mode === 'goal' && !['done', 'error', 'stopped'].includes(session.meta?.goal.status ?? '')) return;
    resolveDone();
  };
  const consume = (batch: SessionEvent[]) => {
    for (const event of batch) {
      if (before.has(event.id)) continue;
      events.set(event.id, event);
      if (session.options.json) json({ type: 'event', sessionId: session.id, event });
      else if (!printed.has(event.id) && (event.kind === 'tool' && event.status !== 'running' || event.kind === 'notice')) {
        process.stderr.write(formatEvent(event, { colored: false, columns: screenColumns() }) ?? ''); printed.add(event.id);
      }
    }
    check();
  };
  const offEvents = client.on('session:events', (batch) => { if (batch.sessionId === session.id) consume(batch.events); });
  const offState = client.on('state', check);
  const offDisconnect = client.onDisconnect(rejectDone);
  const timeout = setTimeout(() => rejectDone(new Error(`Task exceeded ${session.options.timeoutMs / 1000} seconds.`)), session.options.timeoutMs);
  const interrupt = () => { process.exitCode = 130; rejectDone(new Error('Task interrupted.')); };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    const result = await session.send(session.options.prompt);
    inputId = result.inputId;
    if (session.options.json) json({ type: 'session', sessionId: result.sessionId, inputId });
    consume(await client.invoke('sessions:events', result.sessionId));
    await done;
    consume(await client.invoke('sessions:events', result.sessionId));
    const ends = [...events.values()].filter((event) => event.kind === 'turn' && event.phase === 'end');
    const end = ends.at(-1);
    const finals = [...events.values()].filter((event) => event.kind === 'assistant' && event.channel === 'final');
    const final = finals.at(-1);
    if (end?.kind === 'turn' && end.outcome !== 'done') throw new Error(end.error ?? `Turn ${end.outcome}.`);
    if (session.mode === 'goal' && session.meta?.goal.status !== 'done') throw new Error(`Goal ${session.meta?.goal.status}.`);
    if (!final || final.kind !== 'assistant') throw new Error('ChatGPT completed the turn without a final answer. Resume the session to inspect its history.');
    const text = safeText(final.text).replace(/\ue200[^\ue201]*\ue201/g, '');
    if (session.options.json) json({ type: 'result', sessionId: session.id, outcome: 'done', text });
    else process.stdout.write(`${text}\n`);
  } catch (error) {
    await session.stop().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timeout);
    offEvents(); offState(); offDisconnect();
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', interrupt);
  }
}
