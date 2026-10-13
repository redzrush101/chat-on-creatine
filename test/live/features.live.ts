import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { answer, outcomes, tools, useLive } from './harness';

const run = useLive('features');
const running = (name: RegExp) => (events: Parameters<typeof tools>[0]) => tools(events).some((event) => name.test(event.name) && event.status === 'running');

describe.concurrent('a chat', () => {
  it('runs yielding code mode and waits for nested commands and patches', async () => {
    const live = run();
    const code = `text('START'); yield_control();
await new Promise(resolve => setTimeout(resolve, 1000));
text(await tools.exec_command({cmd: "printf CODE_MODE_OK", login: false}));
text(await tools.apply_patch({patch: "*** Begin Patch\\n*** Add File: code-mode.txt\\n+CODE_MODE_OK\\n*** End Patch"}));
store('live_marker', 'CODE_MODE_OK');`;
    const id = await live.send(`Use the local Core tools. Run exactly this JavaScript with exec: \n${code}\nNext, run a fresh exec with text(await tools.wait({cell_id: "the returned cell ID"})), using the actual returned ID. Repeat wait until its result says Script completed. Only then run a fresh exec with text(load('live_marker')), and reply with just that value.`);
    const events = await live.until('code mode completion', live.idle(id), id);
    await live.timeline(id, 'code-mode');
    expect(tools(events).map((event) => event.name)).toEqual(expect.arrayContaining(['exec', 'wait', 'exec_command', 'apply_patch']));
    expect(tools(events).every((event) => event.status === 'ok')).toBe(true);
    expect(readFileSync(join(live.workspace, 'code-mode.txt'), 'utf8')).toBe('CODE_MODE_OK\n');
    expect(answer(events).trim()).toBe('CODE_MODE_OK');
  });

  it('follows a plan and takes a steered message while a command runs', async () => {
    const live = run();
    const id = await live.send('Using the local tools: first call update_plan with exactly 3 steps (create a.txt, wait, finish). Then create a.txt containing A, run `sleep 20` with exec_command (yield_time_ms 25000), update the plan as you go, then reply "done".');
    await live.until('the sleep', running(/exec_command/), id);
    await live.send('Also create steer.txt containing STEER before you finish.', { sessionId: id, delivery: 'now' });
    const events = await live.until('the steered file', (events, state) => existsSync(join(live.workspace, 'steer.txt')) && live.idle(id)(events, state), id);
    await live.timeline(id, 'plan-steer');
    expect(events.some((event) => event.kind === 'plan' && event.items.length === 3)).toBe(true);
    expect(readFileSync(join(live.workspace, 'a.txt'), 'utf8').trim()).toBe('A');
    expect(readFileSync(join(live.workspace, 'steer.txt'), 'utf8').trim()).toBe('STEER');
  });

  it('stops a running turn', async () => {
    const live = run();
    const id = await live.send('Using exec_command run `sleep 120` with yield_time_ms 30000, then poll it with write_stdin until it finishes, then say finished.');
    await live.until('the long command', running(/exec_command|write_stdin/), id);
    await live.api.invoke('chat:stop', id);
    const events = await live.until('the stopped turn', live.idle(id), id);
    await live.timeline(id, 'stop');
    expect(outcomes(events).at(-1)).toBe('stopped');
  });

  it('reads an attached file', async () => {
    const live = run();
    const file = join(live.dir, 'attach-me.txt');
    writeFileSync(file, 'The magic number is 4817.\n');
    const id = await live.send('What is the magic number in the attached file? Reply with just the number.', { attachments: [file] });
    const events = await live.until('the answer', live.idle(id), id);
    await live.timeline(id, 'attachment');
    expect(answer(events)).toContain('4817');
  });

  it('answers with the model it was given', async () => {
    const live = run();
    const models = live.state.models.models;
    const pick = models.find((model) => model.id !== live.state.models.defaultModel && /instant|mini|fast/i.test(`${model.id} ${model.label}`)) ?? models.at(-1);
    expect(pick).toBeDefined();
    const id = await live.send('Reply with one word: hello', { model: pick!.id });
    const events = await live.until('the answer', live.idle(id), id);
    await live.timeline(id, 'model');
    expect(live.state.sessions.find((session) => session.id === id)?.model).toBe(pick!.id);
    expect(answer(events).toLowerCase()).toContain('hello');
  });

  it('follows an imported skill', async () => {
    const live = run();
    const folder = join(live.dir, 'skills', 'haiku-reply');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'SKILL.md'), '---\nname: haiku-reply\ndescription: Reply only with a haiku.\n---\n\nReply with exactly one haiku of three lines and nothing else.\n');
    await live.api.invoke('skills:import', folder);
    const id = await live.send('/haiku-reply Describe the sea.');
    const events = await live.until('the haiku', live.idle(id), id);
    await live.timeline(id, 'skill');
    expect(answer(events).trim().split('\n').filter((line) => line.trim())).toHaveLength(3);
  });
});
