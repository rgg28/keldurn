// Same-origin, version-pinned asset delivery. Account/API traffic and WASM streaming stay native.
import { installAssetByteRecovery } from './asset_recovery.js';
const VERSION = /^[a-f0-9]{64}$/;
const PARAM = 'keldurn_asset';
const WEB = new Set(['/addons/questie.json', '/startup_manifest.json', '/keldurn_bg.wasm', '/keldurn_bg.ios.wasm']);
const PREFERENCE = 'keldurn:keep-assets';

export function storageClass(target) {
  try {
    if (target.navigator?.userAgentData?.mobile === true) return 'mobile';
    if (target.matchMedia?.('(any-pointer: fine)').matches) return 'desktop';
    if (target.matchMedia?.('(pointer: coarse)').matches) return 'mobile';
  } catch { /* unknown capability stays conservative */ }
  return 'unknown';
}
function keepCached(target) {
  // Existing and new browsers inherit the default; an explicit opt-out survives releases.
  try { return target.localStorage?.getItem(PREFERENCE) !== '0'; } catch { return false; }
}

export function assetDescriptor(input, config, origin) {
  const url = new URL(input, origin);
  if (url.origin !== origin || url.username || url.password || url.hash) return null;
  const data = url.pathname.startsWith('/data/');
  if (!data && !WEB.has(url.pathname)) return null;
  if ([...url.searchParams.keys()].some(k => k !== PARAM) || url.searchParams.getAll(PARAM).length > 1) return null;
  const version = data ? config.dataVersion : config.webVersion;
  if (!VERSION.test(version)) return null;
  if (url.searchParams.has(PARAM) && url.searchParams.get(PARAM) !== version) return null;
  let name;
  try { name = decodeURIComponent(data ? url.pathname.slice(6) : url.pathname.slice(1)).replaceAll('\\', '/').toLowerCase(); }
  catch { return null; }
  if (!name || name.length > 1024 || /[\x00-\x1f\x7f%?#]/.test(name) || name.split('/').some(x => !x || x === '.' || x === '..')) return null;
  url.searchParams.set(PARAM, version);
  return { url:url.href, version, key:`${data ? 'data' : 'web'}/${version}/${name}`, persistent:!url.pathname.startsWith('/keldurn_bg.') };
}

export async function installAssetCache(target = globalThis) {
  try { return await initializeAssetCache(target); }
  finally { installAssetByteRecovery(target); }
}

async function initializeAssetCache(target) {
  if (target.__keldurn_asset_cache) return target.__keldurn_asset_cache;
  const state = { version:1, status:'initializing', hits:0, misses:0, bytesFromDisk:0, fallbacks:0, directReads:0, directBytes:0 };
  target.__keldurn_asset_cache = state;
  const metadata = () => ({keepCached:keepCached(target), deviceClass:storageClass(target)});
  state.snapshot = async () => ({mode:state.status, ...metadata()});
  // Even the optional module download is deferred: a missing collector cannot block startup.
  if (target.document && target.setTimeout) target.setTimeout(() => {
    import('./cache_telemetry.js').then(({installCacheTelemetry}) => installCacheTelemetry(target, state, 0)).catch(() => {});
  }, 20000);
  const nativeFetch = target.fetch.bind(target);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 1500);
  let config;
  try {
    const response = await nativeFetch('/asset-delivery.json', { credentials:'same-origin', cache:'no-store', signal:controller.signal });
    if (!response.ok) throw new Error('delivery disabled');
    config = await response.json();
    if (config.version !== 1 || !VERSION.test(config.dataVersion) || !VERSION.test(config.webVersion)) throw new Error('invalid config');
  } catch { state.status = 'disabled'; return state; }
  finally { clearTimeout(timer); }

  let worker = null, nextId = 0;
  const pending = new Map();
  const origin = target.location.origin;
  function stopWorker() {
    worker?.terminate(); worker = null;
    state.status = 'network';
    for (const task of pending.values()) task.reject(new Error('asset worker unavailable'));
    pending.clear();
  }
  try {
    if (config.opfsEnabled !== false && target.isSecureContext && target.Worker && target.navigator?.storage?.getDirectory) {
      worker = new target.Worker(`/asset_cache_worker.js?${PARAM}=${config.webVersion}`, { type:'module', name:'keldurn-assets' });
      worker.onmessage = ({ data }) => {
        const task = pending.get(data.id);
        if (!task) return;
        pending.delete(data.id);
        if (data.error) task.reject(Object.assign(new Error(data.error), { name:data.name || 'Error' }));
        else task.resolve(data);
      };
      worker.onerror = stopWorker;
      worker.onmessageerror = stopWorker;
      worker.postMessage({ op:'init', config:{...config, storageClass:storageClass(target), keepCached:keepCached(target)} });
    }
  } catch { stopWorker(); }
  state.status = worker ? 'ready' : 'network';
  state.dataVersion = config.dataVersion;
  state.webVersion = config.webVersion;
  function call(message, signal, observer = false) {
    return new Promise((resolve, reject) => {
      if (!worker) { reject(new Error('asset worker unavailable')); return; }
      if (signal?.aborted) { reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); return; }
      const id = ++nextId;
      const timeout = setTimeout(() => {
        if (!observer) { stopWorker(); return; }
        pending.delete(id); done(); reject(new Error('asset observation timed out'));
      }, observer ? 3000 : 30000);
      const abort = () => {
        worker?.postMessage({ op:'abort', id });
        pending.delete(id); done();
        reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
      };
      function done() { clearTimeout(timeout); signal?.removeEventListener('abort', abort); }
      pending.set(id, { resolve(value) { done(); resolve(value); }, reject(error) { done(); reject(error); } });
      signal?.addEventListener('abort', abort, { once:true });
      try { worker.postMessage({ ...message, id }); } catch (error) {
        if (observer) { pending.delete(id); done(); reject(error); } else stopWorker();
      }
    });
  }
  async function workerBytes(descriptor, headers, cache, signal) {
    const result = await call({ op:'get', descriptor, headers, cache }, signal);
    if (signal?.aborted) throw signal.reason;
    if (result.source === 'opfs') { state.hits++; state.bytesFromDisk += result.body.byteLength; }
    else state.misses++;
    return result;
  }
  target.fetch = async function(input, init) {
    // Delegate unusual Request modes/headers unchanged: range, validators, integrity and custom
    // credentials are owned by the caller and must not be converted into a synthetic cache hit.
    let request, descriptor;
    try {
      const inputUrl = input instanceof Request ? input.url : String(input);
      descriptor = assetDescriptor(inputUrl, config, origin);
      if (!descriptor) return nativeFetch(input, init);
      request = new Request(new URL(inputUrl, origin), input instanceof Request ? input : undefined);
      if (init) request = new Request(request, init);
    } catch { return nativeFetch(input, init); }
    if (!['GET', 'HEAD'].includes(request.method) || request.credentials === 'omit' ||
        request.redirect !== 'follow' || request.integrity ||
        [...request.headers.keys()].some(k => k !== 'accept') ||
        ['no-store', 'reload', 'only-if-cached'].includes(request.cache)) return nativeFetch(input, init);
    const pinned = new Request(descriptor.url, request);
    if (!worker || !descriptor.persistent || request.method !== 'GET') return nativeFetch(pinned);
    try {
      const result = await workerBytes(descriptor, [...request.headers], request.cache, request.signal);
      const headers = new Headers(result.headers);
      // fetch() already decoded transport compression in the worker.
      headers.delete('content-encoding'); headers.set('content-length', String(result.body.byteLength));
      const response = new Response([204, 205, 304].includes(result.status) ? null : result.body, { status:result.status, statusText:result.statusText, headers });
      Object.defineProperty(response, 'url', { value:result.url || descriptor.url });
      return response;
    } catch (error) {
      if (request.signal.aborted) throw request.signal.reason ?? error;
      state.fallbacks++;
      return nativeFetch(pinned);
    }
  };
  // Internal plain-GET byte reader. The worker already transferred an exclusively owned
  // ArrayBuffer: wrapping it in Response and consuming arrayBuffer() makes two further full
  // copies on the window. Pass its view directly to the Wasm reader instead. Public fetch keeps
  // its standard Response/clone/body semantics. No byte buffer is retained by this bridge.
  const responseBytes = async response => [response.status, new Uint8Array(
    response.ok ? await response.arrayBuffer() : new ArrayBuffer(0))];
  target.__keldurn_fetch_asset_bytes = async function(url, signal) {
    let descriptor;
    try { descriptor = typeof url === 'string' && assetDescriptor(url, config, origin); } catch { /* native validation */ }
    if (!worker || !descriptor || !descriptor.key.startsWith('data/')) {
      return responseBytes(await target.fetch(url, {signal}));
    }
    try {
      const result = await workerBytes(descriptor, [], 'default', signal);
      state.directReads++; state.directBytes += result.body.byteLength;
      return [result.status, new Uint8Array(result.body)];
    } catch (error) {
      if (signal?.aborted) throw signal.reason ?? error;
      state.fallbacks++;
      return responseBytes(await nativeFetch(descriptor.url, {signal, credentials:'same-origin'}));
    }
  };
  // Remaining synchronous reads retain their existing semantics. They benefit from R2 and
  // generation-aware HTTP caching, but never block waiting for an asynchronous OPFS worker.
  const xhr = target.XMLHttpRequest?.prototype;
  if (xhr?.open) {
    const open = xhr.open;
    xhr.open = function(method, url, ...args) {
      let pinned = url;
      try { if (String(method).toUpperCase() === 'GET') pinned = assetDescriptor(String(url), config, origin)?.url ?? url; } catch { /* native validation */ }
      return open.call(this, method, pinned, ...args);
    };
  }
  state.flush = () => worker ? call({ op:'flush' }).then(x => x.stats) : Promise.resolve({ status:'network' });
  state.snapshot = async () => {
    let stats = {mode:config.opfsEnabled === false ? 'disabled' : 'network'};
    if (worker) {
      try { stats = (await call({op:'snapshot'}, undefined, true)).stats; }
      catch { stats = {mode:'unknown'}; }
    }
    return {...stats, ...metadata(), hits:state.hits, bytesFromDisk:state.bytesFromDisk};
  };
  target.addEventListener?.('storage', event => {
    if (event.key === PREFERENCE && worker) call({op:'configure', keepCached:keepCached(target)}).catch(() => {});
  });
  return state;
}
