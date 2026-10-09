// Shared-memory bootstrap adapter for wasm-bindgen-rayon 1.3. The stable filename is
// part of the authenticated web release, including its immutable R2 generation.
// Keep strong Worker references: Firefox can otherwise collect shared-memory workers.
let computeWorkers = [];

// wasm-bindgen uses one temporary stack while allocating each thread's own stack. Its
// contended lock uses Atomics.wait, which AudioWorkletGlobalScope forbids. Finish audio
// instantiation before starting Rayon; later rendering and compute remain concurrent.
let audioInitialization = Promise.resolve();
let audioInitialized;
export function beginAudioInitialization() {
  if (!audioInitialized) audioInitialization = new Promise(resolve => { audioInitialized = resolve; });
}
export function finishAudioInitialization() {
  audioInitialized?.();
  audioInitialized = undefined;
}

export function installAudioInitialization(scope) {
  if (typeof scope.registerProcessor === 'function') {
    const register = scope.registerProcessor.bind(scope);
    scope.registerProcessor = (name, Processor) => register(name, name !== 'CpalProcessor' ? Processor
      : class extends Processor {
        constructor(...args) {
          super(...args);
          // Construction includes initSync and unpack; no user gesture or render callback needed.
          this.port.postMessage({ type: 'keldurn-audio-initialized' });
        }
      });
  } else if (scope.document) {
    scope.__keldurn_begin_audio_initialization = beginAudioInitialization;
    scope.__keldurn_finish_audio_initialization = finishAudioInitialization;
    const Original = scope.AudioWorkletNode;
    if (!Original) return;
    const pending = new Set();
    const Wrapped = function (...args) {
      let node;
      try { node = new Original(...args); }
      catch (error) { if (args[1] === 'CpalProcessor') finishAudioInitialization(); throw error; }
      if (args[1] === 'CpalProcessor') {
        pending.add(node);
        const done = () => {
          node.port.removeEventListener('message', ready);
          node.removeEventListener('processorerror', done);
          pending.delete(node);
          finishAudioInitialization();
        };
        const ready = event => { if (event.data?.type === 'keldurn-audio-initialized') done(); };
        node.port.addEventListener('message', ready);
        node.port.start();
        node.addEventListener('processorerror', done);
      }
      return node;
    };
    Wrapped.prototype = Original.prototype;
    Object.setPrototypeOf(Wrapped, Original);
    scope.AudioWorkletNode = Wrapped;
  }
}
installAudioInitialization(globalThis);

async function waitForAudio(signal) {
  let abort;
  try {
    await Promise.race([audioInitialization, new Promise((_, reject) => {
      abort = () => reject(new Error('Audio initialization did not finish; compute workers not started'));
      signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener('abort', abort); }
}

if (typeof document === 'undefined' && typeof self !== 'undefined') {
  self.addEventListener('message', async function initialize(event) {
    if (event.data?.type !== 'keldurn-compute-init') return;
    self.removeEventListener('message', initialize);
    const { mainJS, module, memory, receiver } = event.data;
    try {
      const pkg = await import(mainJS);
      await pkg.default({ module_or_path: module, memory });
      self.postMessage({ type: 'keldurn-compute-ready' });
      pkg.wbg_rayon_start_worker(receiver);
    } catch {
      self.postMessage({ type: 'keldurn-compute-failed' });
    }
  });
}

function ready(worker, payload, signal) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      worker.removeEventListener('message', message);
      worker.removeEventListener('error', failed);
      worker.removeEventListener('messageerror', failed);
      signal.removeEventListener('abort', failed);
    };
    const failed = () => { cleanup(); reject(new Error('Compute worker initialization failed')); };
    const message = event => {
      if (event.data?.type === 'keldurn-compute-ready') { cleanup(); resolve(); }
      else if (event.data?.type === 'keldurn-compute-failed') failed();
    };
    worker.addEventListener('message', message);
    worker.addEventListener('error', failed);
    worker.addEventListener('messageerror', failed);
    signal.addEventListener('abort', failed);
    if (signal.aborted) failed();
    else {
      try { worker.postMessage(payload); } catch { failed(); }
    }
  });
}

export async function startWorkers(module, memory, builder, options = {}) {
  const count = builder.numThreads();
  if (!Number.isInteger(count) || count < 1 || count > 4) throw new Error('Invalid compute worker count');
  const WorkerClass = options.WorkerClass ?? Worker;
  const fetchImpl = options.fetchImpl ?? fetch;
  const urls = options.urls ?? URL;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  const workers = [];
  let blobUrl;
  try {
    await waitForAudio(controller.signal);
    const response = await fetchImpl(import.meta.url, { signal: controller.signal });
    if (!response.ok) throw new Error('Compute worker script unavailable');
    blobUrl = urls.createObjectURL(await response.blob());
    await Promise.all(Array.from({ length: count }, async () => {
      const worker = new WorkerClass(blobUrl, { type: 'module', name: 'keldurn-compute' });
      workers.push(worker);
      await ready(worker, { type: 'keldurn-compute-init', module, memory,
        receiver: builder.receiver(), mainJS: builder.mainJS() }, controller.signal);
    }));
    builder.build();
    computeWorkers = workers;
  } catch (error) {
    controller.abort();
    for (const worker of workers) worker.terminate();
    throw error;
  } finally {
    clearTimeout(timeout);
    if (blobUrl) urls.revokeObjectURL(blobUrl);
  }
}
