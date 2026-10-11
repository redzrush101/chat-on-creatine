/**
 * Worker-thread bootstrap for code mode. The model's source runs only inside a QuickJS (WASM)
 * heap in this worker, so a runaway script cannot block the app's main thread. The worker
 * enforces the memory and CPU budgets; the main thread (runtime.ts) enforces wall time, call
 * counts and output. Values cross the bridge as JSON strings only.
 */
export const CODE_MODE_WORKER_SOURCE = String.raw`
const { parentPort, workerData } = require('node:worker_threads');
const { newQuickJSWASMModuleFromVariant } = require(workerData.coreModule);
const variant = require(workerData.wasmModule).default;

const describe = (vm, handle) => {
  let text;
  try {
    const dumped = vm.dump(handle);
    text = dumped && typeof dumped === 'object' && 'message' in dumped ? dumped.name + ': ' + dumped.message : String(dumped);
  } catch {
    text = 'error';
  }
  return text.slice(0, 500);
};

(async () => {
  const QuickJS = await newQuickJSWASMModuleFromVariant(variant);
  const runtime = QuickJS.newRuntime();
  runtime.setMemoryLimit(workerData.memoryBytes);
  runtime.setMaxStackSize(512 * 1024);
  const vm = runtime.newContext();

  let cpuUsed = 0;
  let sliceStart = 0;
  const cpuExceeded = () => cpuUsed + performance.now() - sliceStart > workerData.cpuMs;
  runtime.setInterruptHandler(cpuExceeded);
  const timed = fn => {
    sliceStart = performance.now();
    try { return fn(); } finally { cpuUsed += performance.now() - sliceStart; }
  };

  let reported = false;
  const settle = (status, detail) => {
    if (reported) return;
    reported = true;
    parentPort.postMessage({ type: 'done', status, detail: detail || '' });
  };

  const pending = new Map();
  let nextId = 0;
  const host = vm.newFunction('host', (operation, payload) => {
    const op = vm.getString(operation);
    const json = vm.getString(payload);
    if (op === 'call') {
      const id = ++nextId;
      const deferred = vm.newPromise();
      pending.set(id, deferred);
      parentPort.postMessage({ type: 'call', id, json });
      return deferred.handle.dup();
    }
    parentPort.postMessage({ type: op, json });
    return vm.undefined;
  });
  vm.setProp(vm.global, '__host', host);
  host.dispose();

  const bootstrap = '(() => {' +
    'const host = globalThis.__host; delete globalThis.__host;' +
    'const tools = Object.create(null);' +
    'const entries = Object.freeze(' + JSON.stringify(workerData.tools) + ');' +
    'for (const entry of entries) {' +
      'tools[entry.name] = (args = {}) => host("call", JSON.stringify({ name: entry.name, args })).then(json => JSON.parse(json));' +
    '}' +
    'const text = value => host("text", JSON.stringify(typeof value === "string" ? value : (JSON.stringify(value) ?? String(value))));' +
    'const image = value => host("image", JSON.stringify(value) ?? "null");' +
    'Object.defineProperties(globalThis, {' +
      'tools: { value: Object.freeze(tools) }, ALL_TOOLS: { value: entries },' +
      'text: { value: text }, image: { value: image }' +
    '});' +
  '})()';
  const setup = timed(() => vm.evalCode(bootstrap, 'bootstrap.js'));
  if (setup.error) {
    setup.error.dispose();
    settle('RUNTIME_ERROR', 'the code mode runtime could not start');
    return;
  }
  setup.value.dispose();

  const evaluated = timed(() => vm.evalCode(workerData.code, 'exec.js', { type: 'module' }));
  if (evaluated.error) {
    const detail = describe(vm, evaluated.error);
    evaluated.error.dispose();
    settle(cpuUsed > workerData.cpuMs ? 'CPU_LIMIT' : 'SCRIPT_ERROR', detail);
    return;
  }
  const execution = evaluated.value;

  // Runs queued JavaScript until the script settles or waits for a tool result from the host.
  const pump = () => {
    for (;;) {
      const jobs = timed(() => runtime.executePendingJobs(64));
      if (jobs.error) {
        const detail = describe(vm, jobs.error);
        jobs.error.dispose();
        settle(cpuUsed > workerData.cpuMs ? 'CPU_LIMIT' : 'SCRIPT_ERROR', detail);
        return;
      }
      const state = vm.getPromiseState(execution);
      if (state.type === 'fulfilled') {
        state.value.dispose();
        settle(null, '');
        return;
      }
      if (state.type === 'rejected') {
        const detail = describe(vm, state.error);
        state.error.dispose();
        settle(cpuUsed > workerData.cpuMs ? 'CPU_LIMIT' : 'SCRIPT_ERROR', detail);
        return;
      }
      if (!runtime.hasPendingJob()) return;
    }
  };

  parentPort.on('message', message => {
    if (reported) return;
    const deferred = pending.get(message.id);
    if (!deferred) return;
    pending.delete(message.id);
    timed(() => {
      const value = vm.newString(message.json);
      deferred.resolve(value);
      value.dispose();
      deferred.dispose();
    });
    pump();
  });

  pump();
})().catch(() => {
  parentPort.postMessage({ type: 'done', status: 'RUNTIME_ERROR', detail: 'the code mode runtime failed' });
});
`;
