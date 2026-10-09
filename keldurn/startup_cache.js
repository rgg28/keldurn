import { mobilePlatform } from './platform.js';

const DEFAULT_CONCURRENCY = 16;
const CACHE_PROPERTY = '__keldurn_data_cache';
const INDEX_PROPERTY = '__keldurn_data_catalog';
const STATE_PROPERTY = '__keldurn_startup_preload';
const WASM_STATE_PROPERTY = '__keldurn_wasm_startup';

export function startupPolicy(target = globalThis) {
  const query = new URLSearchParams(target.location?.search ?? '');
  const platform = mobilePlatform(target);
  const mobile = platform !== null;
  const safe = query.get('startup') === 'safe';
  const choice = (name, allowed, fallback) => {
    const raw = query.get(name);
    return raw !== null && allowed.includes(Number(raw)) ? Number(raw) : fallback;
  };
  return Object.freeze({
    mode: safe ? 'safe' : mobile ? 'mobile' : 'desktop',
    concurrency: choice('preload', [4, 8, 16], mobile || safe ? 4 : DEFAULT_CONCURRENCY),
    workers: choice('pool', [0, 1, 2, 3, 4], safe || platform === 'ios' ? 0 : mobile ? 1 : desktopWorkers(target.navigator)),
    heapHeadroomMb: choice('heap_headroom_mb', [0, 32, 64], safe || platform === 'ios' ? 0 : mobile ? 32 : 64),
  });
}

export function desktopWorkers(navigator) {
  const cores = Number(navigator?.hardwareConcurrency) || 2;
  const memory = Number(navigator?.deviceMemory);
  const base = Math.min(2, Math.max(1, cores - 2));
  if (!Number.isFinite(memory) || memory < 8) return base;
  if (cores >= 12 && memory >= 16) return 4;
  if (cores >= 8) return 3;
  return base;
}

export async function startComputeForPolicy(policy, initComputePool, target = globalThis) {
  target.__keldurn_compute_ready = false;
  if (policy.workers === 0) return false;
  try {
    await initComputePool(policy.workers);
    target.__keldurn_compute_ready = true;
    return true;
  } catch { return false; }
}

function defaultNow() {
  return globalThis.performance?.now?.() ?? Date.now();
}

function mark(target, name) {
  try {
    target.performance?.mark?.(`keldurn:${name}`);
  } catch {
  }
}

export async function beginWasmCompilation(options = {}) {
  const target = options.target ?? globalThis;
  const fetchImpl = options.fetchImpl ?? target.fetch?.bind(target);
  const wasm = options.webAssembly ?? target.WebAssembly;
  const now = options.now ?? defaultNow;
  const onProgress = options.onProgress ?? (() => {});
  const origin = options.origin ?? target.location?.origin;
  const url = options.url ?? `${origin}/${mobilePlatform(target) === 'ios' ? 'keldurn_bg.ios.wasm' : 'keldurn_bg.wasm'}`;

  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  if (!wasm || typeof wasm.compile !== 'function') throw new Error('WebAssembly.compile is unavailable');
  if (typeof origin !== 'string' || !origin) throw new Error('window.location.origin is unavailable');

  const startedAt = now();
  const state = {
    version: 1,
    status: 'fetching',
    mode: null,
    responseMs: null,
    elapsedMs: 0,
    error: null,
  };
  target[WASM_STATE_PROPERTY] = state;
  mark(target, 'wasm-fetch-start');
  onProgress({ ...state });

  try {
    const response = await fetchImpl(url, { cache: 'no-cache', priority: 'high' });
    if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
    state.responseMs = now() - startedAt;
    state.status = 'compiling';
    mark(target, 'wasm-headers');
    onProgress({ ...state });

    const contentType = response.headers?.get?.('Content-Type')
      ?.split(';', 1)[0].trim().toLowerCase();
    let module;
    if (contentType === 'application/wasm' && typeof wasm.compileStreaming === 'function') {
      state.mode = 'streaming';
      module = await wasm.compileStreaming(Promise.resolve(response));
    } else {
      state.mode = 'buffered';
      module = await wasm.compile(await response.arrayBuffer());
    }

    state.status = 'ready';
    state.elapsedMs = now() - startedAt;
    mark(target, 'wasm-compiled');
    onProgress({ ...state });
    return module;
  } catch (error) {
    state.status = 'failed';
    state.elapsedMs = now() - startedAt;
    state.error = String(error);
    mark(target, 'wasm-failed');
    onProgress({ ...state });
    throw error;
  }
}

function validatePaths(paths, label, seen) {
  if (!Array.isArray(paths)) throw new Error(`${label} must be an array`);
  for (const path of paths) {
    if (typeof path !== 'string' || path.length === 0) {
      throw new Error('startup manifest entries must be non-empty strings');
    }
    let decoded;
    try {
      decoded = decodeURIComponent(path);
    } catch {
      throw new Error(`startup manifest contains invalid percent encoding: ${path}`);
    }
    if (encodeURIComponent(decoded) !== path) {
      throw new Error(`startup manifest path is not one encoded component: ${path}`);
    }
    if (seen.has(path)) {
      throw new Error(`startup manifest contains a duplicate: ${path}`);
    }
    seen.add(path);
  }
  return paths;
}

function validateManifest(manifest) {
  if (Array.isArray(manifest)) {
    if (manifest.length === 0) throw new Error('startup manifest must not be empty');
    return { files: validatePaths(manifest, 'startup manifest', new Set()), missing: [] };
  }
  if (!manifest || manifest.version !== 2) {
    throw new Error('startup manifest must be a v1 array or a version 2 object');
  }
  const seen = new Set();
  const files = validatePaths(manifest.files, 'startup manifest files', seen);
  const missing = validatePaths(manifest.missing ?? [], 'startup manifest missing entries', seen);
  if (files.length === 0) throw new Error('startup manifest files must not be empty');
  return { files, missing };
}

function dataUrl(origin, encodedPath) {
  return `${origin}/data/${encodedPath}`;
}

function cacheKey(key) {
  if (typeof key !== 'string') return key;
  const start = key.indexOf('/data/');
  if (start < 0) return key;
  const nameStart = start + 6;
  const suffix = key.slice(nameStart).search(/[?#]/);
  const nameEnd = suffix < 0 ? key.length : nameStart + suffix;
  const name = key.slice(nameStart, nameEnd)
    .replace(/%2f|%5c|[\\/]/gi, '%5c').toLowerCase();
  return key.slice(0, nameStart) + name + key.slice(nameEnd);
}

class AssetMemoryCache extends Map {
  get(key) { return super.get(cacheKey(key)); }
  has(key) { return super.has(cacheKey(key)); }
  set(key, value) { return super.set(cacheKey(key), value); }
  delete(key) { return super.delete(cacheKey(key)); }
}

async function fetchRequired(fetchImpl, url, responseKind, options = {}) {
  const attempts = options.attempts ?? 3;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const wait = options.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let retryable = false;
    try {
      const response = await fetchImpl(url, { cache: 'force-cache', signal: controller.signal });
      if (!response.ok) {
        retryable = response.status === 408 || (response.status >= 500 && response.status <= 504);
        throw new Error(`${url}: HTTP ${response.status}`);
      }
      return responseKind === 'json'
        ? await response.json()
        : new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      retryable ||= controller.signal.aborted || error?.name === 'TypeError';
      if (!retryable || attempt + 1 === attempts) throw error;
    } finally {
      clearTimeout(timer);
    }
    await wait(250 * (attempt + 1));
  }
}

function publishAvailabilityIndex(target, origin) {
  const bytes = target[CACHE_PROPERTY].get(dataUrl(origin, 'catalog-v1'));
  if (!(bytes instanceof Uint8Array)) return 0;
  const names = JSON.parse(new TextDecoder().decode(bytes));
  if (!Array.isArray(names) || names.some((name) => typeof name !== 'string')) {
    throw new Error('/data/catalog-v1 must contain a JSON string array');
  }
  target[INDEX_PROPERTY] = new Set(
    names.map((name) => dataUrl(origin, encodeURIComponent(name)).toLowerCase()),
  );
  return names.length;
}

export async function preloadStartupData(options = {}) {
  const target = options.target ?? globalThis;
  const fetchImpl = options.fetchImpl ?? target.fetch?.bind(target);
  const now = options.now ?? defaultNow;
  const concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
  const onProgress = options.onProgress ?? (() => {});
  const origin = options.origin ?? target.location?.origin;
  const manifestUrl = options.manifestUrl ?? `${origin}/startup_manifest.json`;

  if (typeof fetchImpl !== 'function') throw new Error('fetch is unavailable');
  if (typeof origin !== 'string' || !origin) throw new Error('window.location.origin is unavailable');
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 64) {
    throw new Error('startup preload concurrency must be an integer from 1 to 64');
  }

  const startedAt = now();
  mark(target, 'data-manifest-start');
  const state = {
    version: 2,
    status: 'manifest',
    total: 0,
    completed: 0,
    bytes: 0,
    negativeEntries: 0,
    indexedEntries: 0,
    failures: [],
    concurrency,
    elapsedMs: 0,
  };
  target[STATE_PROPERTY] = state;
  target[CACHE_PROPERTY] = new AssetMemoryCache();
  target.__keldurn_data_cache_policy = mobilePlatform(target) === 'ios' ? 'release' : 'retain';
  target.__keldurn_texture_base_mip = mobilePlatform(target) === 'ios' ? 1 : 0;
  target.__keldurn_memory_budget = mobilePlatform(target) === 'ios';
  onProgress({ ...state });

  let paths;
  let missing;
  try {
    ({ files: paths, missing } = validateManifest(
      await fetchRequired(fetchImpl, manifestUrl, 'json'),
    ));
  } catch (error) {
    state.status = 'failed';
    state.failures.push(String(error));
    state.elapsedMs = now() - startedAt;
    onProgress({ ...state, failures: [...state.failures] });
    throw error;
  }

  state.status = 'loading';
  mark(target, 'data-manifest-ready');
  state.total = paths.length;
  state.negativeEntries = missing.length;
  for (const path of missing) target[CACHE_PROPERTY].set(dataUrl(origin, path), null);
  onProgress({ ...state });
  let cursor = 0;

  async function worker() {
    for (;;) {
      const index = cursor++;
      if (index >= paths.length) return;
      const url = dataUrl(origin, paths[index]);
      try {
        const bytes = await fetchRequired(fetchImpl, url, 'bytes');
        target[CACHE_PROPERTY].set(url, bytes);
        state.bytes += bytes.byteLength;
      } catch (error) {
        state.failures.push(String(error));
      } finally {
        state.completed += 1;
        state.elapsedMs = now() - startedAt;
        onProgress({ ...state, failures: [...state.failures] });
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, worker));
  state.elapsedMs = now() - startedAt;
  if (state.failures.length) {
    state.status = 'failed';
    onProgress({ ...state, failures: [...state.failures] });
    throw new AggregateError(state.failures, `startup preload failed for ${state.failures.length} files`);
  }

  try {
    state.indexedEntries = publishAvailabilityIndex(target, origin);
  } catch (error) {
    state.status = 'failed';
    state.failures.push(String(error));
    onProgress({ ...state, failures: [...state.failures] });
    throw error;
  }

  state.status = 'ready';
  mark(target, 'data-ready');
  onProgress({ ...state });
  return { ...state, failures: [] };
}

export const startupCacheInternals = {
  AssetMemoryCache, cacheKey, dataUrl, fetchRequired, publishAvailabilityIndex, validateManifest,
};
