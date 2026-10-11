import { randomUUID } from 'node:crypto';
import { REASONING_EFFORTS, type Config, type ReasoningEffort } from '@shared/config';
import type { AgentRun, InputDelivery, SessionMeta, WorkerInfo, WorkerState } from '@shared/types';
import type { TurnOutcome } from '../chatgpt/router';
import { type AgentsApi, type Caller, ToolError } from '../mcp/tool';
import type { Outbox } from '../sessions/outbox';
import type { SessionStore } from '../sessions/store';

interface AgentControllerDeps {
  store: SessionStore;
  outbox: Outbox;
  getConfig(): Config;
  turnOf(sessionId: string): 'idle' | 'sending' | 'generating' | 'compacting';
  onChange(): void;
}

type AgentAction = 'spawned' | 'messaged' | 'finished' | 'woke';

interface WorkerRuntime {
  state: WorkerState;
  /** Not persisted: empty for workers restored after a restart, where the label alone identifies them. */
  task: string;
  lastResult: string | null;
  /** The worker reported or was stopped during its current turn, so that turn's end must not report again. */
  handled: boolean;
}

interface WorkerSpec {
  label?: string;
  task: string;
  model?: string | null;
  reasoning_effort?: string | null;
}

interface WorkerPlan {
  label: string;
  task: string;
  model: string | null;
  reasoning: ReasoningEffort | null;
}

interface Step {
  from: SessionMeta;
  to: SessionMeta;
  text: string;
}

const MAX_WORKERS = 8;
const MAX_EXCERPT = 200;
const WORKER_SPAWN_REFUSAL =
  'Workers must not create workers of their own. Send the prime chat a message instead and let it decide.';

/**
 * Multi-agent runs: a prime chat spawns worker chats (sessions with `parentId` set to the prime), and
 * workers report back to it. Concurrency is the number of workers in the `working` state per prime.
 */
export class AgentController implements AgentsApi {
  private readonly runtime = new Map<string, WorkerRuntime>();

  constructor(private readonly deps: AgentControllerDeps) {}

  runs(): AgentRun[] {
    const primeIds = new Set(this.allWorkers().map((worker) => worker.parentId!));
    return [...primeIds].map((primeSessionId) => ({
      primeSessionId,
      workers: this.workersOf(primeSessionId).map((worker) => this.info(worker))
    }));
  }

  async spawn(caller: Caller, request: { context: string; workers: WorkerSpec[] }): Promise<string> {
    const prime = this.session(caller.sessionId);
    if (prime.kind === 'worker') throw new ToolError('INVALID_ARGUMENT', WORKER_SPAWN_REFUSAL);
    if (prime.kind !== 'chat') throw new ToolError('INVALID_ARGUMENT', 'Only a chat can start workers.');
    if (request.workers.length < 1 || request.workers.length > MAX_WORKERS) {
      throw new ToolError('INVALID_ARGUMENT', `spawn needs 1 to ${MAX_WORKERS} workers.`);
    }

    // Everything is validated before the first session is created.
    const config = this.deps.getConfig();
    const plans = request.workers.map((worker, index) => planWorker(worker, index, config));
    const labels = new Set<string>();
    for (const plan of plans) {
      const key = plan.label.toLowerCase();
      if (labels.has(key)) throw new ToolError('INVALID_ARGUMENT', `Worker labels must be unique; "${plan.label}" is used twice.`);
      labels.add(key);
    }
    const existing = this.workersOf(prime.id);
    const matches = plans.map((plan) => {
      const found = existing.find((worker) => worker.title.toLowerCase() === plan.label.toLowerCase());
      if (found && this.rt(found).task && this.rt(found).task !== plan.task) {
        throw new ToolError(
          'INVALID_ARGUMENT',
          `A worker named "${plan.label}" already exists in this run with another task. Use a different label, or message it.`
        );
      }
      return found ?? null;
    });

    const lines: string[] = [];
    plans.forEach((plan, index) => {
      const match = matches[index];
      if (match) {
        const state = this.rt(match).state;
        lines.push(`- ${match.title} (${match.id}): already exists and is ${state}; reused, not duplicated.`);
        return;
      }
      const worker = this.deps.store.create({
        kind: 'worker',
        parentId: prime.id,
        title: plan.label,
        projectId: prime.projectId,
        cwd: prime.cwd,
        model: plan.model,
        reasoning: plan.reasoning
      });
      this.runtime.set(worker.id, { state: 'queued', task: plan.task, lastResult: null, handled: false });
      this.enqueue(worker.id, briefFor(plan.label, plan.task, request.context), 'after-turn');
      this.record(prime.id, 'spawned', worker, plan.task);
      lines.push(`- ${plan.label} (${worker.id}): queued`);
    });
    this.deps.onChange();
    return `Workers for this run:\n${lines.join('\n')}\n${this.slotSummary(prime.id)} Reports arrive with later tool results; there is nothing to poll. Carry on with your own work.`;
  }

  async message(caller: Caller, request: { messages: { to: string; text: string }[] }): Promise<string> {
    const session = this.session(caller.sessionId);
    if (request.messages.length === 0) throw new ToolError('INVALID_ARGUMENT', 'message needs at least one message.');
    // Every recipient is resolved before anything is queued: a batch is all or nothing.
    const steps = request.messages.map((message): Step => {
      const text = messageText(message.text);
      if (session.kind === 'chat') return { from: session, to: this.workerOf(session, message.to), text };
      if (session.kind === 'worker') {
        recipientPrime(message.to);
        return { from: session, to: this.primeOf(session), text };
      }
      throw new ToolError('INVALID_ARGUMENT', 'Only a chat or a worker can send agent messages.');
    });
    const outcomes = steps.map((step) => this.dispatch(step));
    this.deps.onChange();
    return outcomes.join('\n');
  }

  async status(caller: Caller): Promise<string> {
    const session = this.session(caller.sessionId);
    const prime = session.kind === 'worker' ? this.primeOf(session) : session;
    const workers = this.workersOf(prime.id);
    if (workers.length === 0) return 'No workers in this run yet. Use action=spawn to start some.';
    const lines = workers.map((worker) => {
      const info = this.info(worker);
      const model = info.model ?? 'default model';
      return `- ${info.label} (${info.sessionId}): ${info.state}, ${model}. Last result: ${excerpt(info.lastResult)}`;
    });
    return `Workers in this run:\n${lines.join('\n')}\n${this.slotSummary(prime.id)}`;
  }

  async finish(caller: Caller, request: { result: string }): Promise<string> {
    const worker = this.session(caller.sessionId);
    if (worker.kind !== 'worker') throw new ToolError('INVALID_ARGUMENT', 'Only a worker reports with finish; a chat has no prime to report to.');
    const result = request.result.trim();
    if (!result) throw new ToolError('INVALID_ARGUMENT', 'finish needs a result: what you changed, what you verified and what is left.');
    const prime = this.primeOf(worker);
    const runtime = this.rt(worker);
    runtime.state = 'asleep';
    runtime.lastResult = result;
    runtime.handled = true;
    this.report(prime, worker, `Worker "${worker.title}" finished:`, result, 'finished');
    this.deps.onChange();
    return 'Reported to the prime. Your worker slot is free and this chat stays asleep. End your turn now: stop working and stop calling tools.';
  }

  /** Whether a queued input for this session may start a turn now. Workers take a slot when they start. */
  canStart(session: SessionMeta): boolean {
    if (session.kind !== 'worker') return true;
    const runtime = this.rt(session);
    if (runtime.state === 'working') return true;
    const working = this.workersOf(session.parentId ?? '').filter((worker) => this.rt(worker).state === 'working').length;
    if (working >= this.deps.getConfig().agents.maxConcurrent) return false;
    runtime.state = 'working';
    return true;
  }

  /** Called after every finished turn. A worker that did not report is put to sleep and its last reply forwarded. */
  onTurnEnd(session: SessionMeta, outcome: TurnOutcome): void {
    if (session.kind !== 'worker') return;
    const runtime = this.rt(session);
    const handled = runtime.handled;
    runtime.handled = false;
    if (this.deps.outbox.list(session.id).some((item) => item.state === 'queued')) return;

    if (!handled) {
      const prime = this.deps.store.get(session.parentId ?? '');
      const reply = this.lastReply(session.id);
      runtime.lastResult = reply;
      if (outcome === 'error') {
        runtime.state = 'failed';
        if (prime) this.report(prime, session, `Worker "${session.title}" failed before finishing:`, reply ?? 'No reply was produced.', 'finished');
      } else {
        runtime.state = 'asleep';
        if (prime) this.report(prime, session, `Worker "${session.title}" finished:`, reply ?? 'The worker ended its turn without a reply.', 'finished');
      }
    }
    this.deps.onChange();
  }

  /** Cancels a worker's queued inputs and puts it to sleep. The app stops its running turn. */
  stopWorker(workerSessionId: string): void {
    const worker = this.deps.store.get(workerSessionId);
    if (!worker || worker.kind !== 'worker') return;
    for (const item of this.deps.outbox.list(worker.id)) {
      if (item.state === 'queued') this.deps.outbox.cancel(item.id);
    }
    const runtime = this.rt(worker);
    runtime.state = 'asleep';
    // A running turn ends stopped and must not be reported as a finished worker.
    runtime.handled = this.deps.turnOf(worker.id) !== 'idle';
    this.deps.onChange();
  }

  private dispatch(step: Step): string {
    const { from, to, text } = step;
    if (from.kind === 'worker') {
      this.enqueue(to.id, `Message from worker "${from.title}":\n\n${text}`, 'now');
      this.record(to.id, 'messaged', from, text);
      return 'Sent to the prime.';
    }

    const prime = from;
    const runtime = this.rt(to);
    const label = `${to.title} (${to.id})`;
    if (runtime.state === 'asleep' || runtime.state === 'failed') {
      runtime.state = 'queued';
      this.enqueue(to.id, text, 'after-turn');
      this.record(prime.id, 'woke', to, text);
      return `Waking ${label} in its existing chat.`;
    }
    const delivery: InputDelivery = runtime.state === 'working' ? 'now' : 'after-turn';
    this.enqueue(to.id, text, delivery);
    this.record(prime.id, 'messaged', to, text);
    return `Sent to ${label}${delivery === 'now' ? '; it is working and reads this with its next tool result' : ''}.`;
  }

  private report(prime: SessionMeta, worker: SessionMeta, heading: string, text: string, action: AgentAction): void {
    this.record(prime.id, action, worker, text);
    this.enqueue(prime.id, `${heading}\n\n${text}`, 'now');
  }

  private enqueue(sessionId: string, text: string, delivery: InputDelivery): void {
    this.deps.outbox.enqueue({ sessionId, text, attachments: [], delivery, source: 'agent' });
  }

  private record(primeId: string, action: AgentAction, worker: SessionMeta, text: string): void {
    this.deps.store.append(primeId, [
      { id: `agent:${randomUUID()}`, at: Date.now(), kind: 'agent', workerSessionId: worker.id, label: worker.title, action, text }
    ]);
  }

  private session(sessionId: string): SessionMeta {
    const meta = this.deps.store.get(sessionId);
    if (!meta) throw new ToolError('UNKNOWN_SESSION', 'This chat is not known to the app.');
    return meta;
  }

  private primeOf(worker: SessionMeta): SessionMeta {
    const prime = this.deps.store.get(worker.parentId ?? '');
    if (!prime) throw new ToolError('UNKNOWN_SESSION', 'The prime chat of this worker no longer exists.');
    return prime;
  }

  private workerOf(prime: SessionMeta, to: string): SessionMeta {
    const key = to.trim().toLowerCase();
    const found = this.workersOf(prime.id).find((worker) => worker.id === to.trim() || worker.title.toLowerCase() === key);
    if (!found) throw new ToolError('INVALID_ARGUMENT', `No worker "${to}" in this run. Use a label or session id from status.`);
    return found;
  }

  private allWorkers(): SessionMeta[] {
    return this.deps.store.list().filter((meta) => meta.kind === 'worker' && meta.parentId !== null);
  }

  private workersOf(primeId: string): SessionMeta[] {
    return this.allWorkers()
      .filter((meta) => meta.parentId === primeId)
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  private rt(worker: SessionMeta): WorkerRuntime {
    let runtime = this.runtime.get(worker.id);
    if (!runtime) {
      runtime = { state: 'asleep', task: '', lastResult: null, handled: false };
      this.runtime.set(worker.id, runtime);
    }
    return runtime;
  }

  private info(worker: SessionMeta): WorkerInfo {
    const runtime = this.rt(worker);
    return {
      sessionId: worker.id,
      label: worker.title,
      task: runtime.task,
      state: runtime.state,
      model: worker.model,
      reasoning: worker.reasoning,
      lastResult: runtime.lastResult,
      updatedAt: worker.updatedAt
    };
  }

  private slotSummary(primeId: string): string {
    const max = this.deps.getConfig().agents.maxConcurrent;
    const states = this.workersOf(primeId).map((worker) => this.rt(worker).state);
    const working = states.filter((state) => state === 'working').length;
    const queued = states.filter((state) => state === 'queued').length;
    return `Working: ${working} of ${max} slots, ${Math.max(0, max - working)} free. Queued: ${queued}.`;
  }

  /** The newest final answer of the worker's conversation, falling back to its newest commentary. */
  private lastReply(sessionId: string): string | null {
    let fallback: string | null = null;
    const events = this.deps.store.events(sessionId);
    for (let index = events.length - 1; index >= 0; index--) {
      const event = events[index]!;
      if (event.kind !== 'assistant' || !event.text.trim()) continue;
      if (event.channel === 'final') return event.text.trim();
      fallback ??= event.text.trim();
    }
    return fallback;
  }
}

function planWorker(spec: WorkerSpec, index: number, config: Config): WorkerPlan {
  const task = spec.task.trim();
  if (!task) throw new ToolError('INVALID_ARGUMENT', `Worker ${index + 1} has no task.`);
  const effort = spec.reasoning_effort ?? null;
  if (effort !== null && !(REASONING_EFFORTS as readonly string[]).includes(effort)) {
    throw new ToolError('INVALID_ARGUMENT', `Worker ${index + 1}'s reasoning_effort must be one of: ${REASONING_EFFORTS.join(', ')}`);
  }
  return {
    label: spec.label?.trim() || `Worker ${index + 1}`,
    task,
    model: spec.model?.trim() || config.agents.defaultModel,
    reasoning: effort === null ? config.agents.defaultReasoning : (effort as ReasoningEffort)
  };
}

function messageText(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) throw new ToolError('INVALID_ARGUMENT', 'Every message needs text.');
  return trimmed;
}

/** Workers may only address their prime. */
function recipientPrime(to: string): void {
  if (to.trim().toLowerCase() !== 'prime') {
    throw new ToolError('INVALID_ARGUMENT', 'Workers may only message the prime. Send it there and let the prime decide.');
  }
}

function briefFor(label: string, task: string, context: string): string {
  const shared = context.trim() ? `Shared context for every worker in this run:\n${context.trim()}\n\n` : '';
  return [
    `You are worker "${label}" in a run coordinated by a prime chat. You share the prime's tools and working folder.`,
    '',
    `${shared}Your task:\n${task.trim()}`,
    '',
    'Rules:',
    '- Do the task yourself. You cannot spawn workers.',
    '- If you need a decision from the prime, call the agents tool with action=message and to="prime".',
    '- When the task is complete, call the agents tool with action=finish and a complete result: what you changed, what you verified and what is left. Then end your turn.'
  ].join('\n');
}

function excerpt(text: string | null): string {
  if (!text) return 'none yet';
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > MAX_EXCERPT ? `${flat.slice(0, MAX_EXCERPT)}...` : flat;
}
