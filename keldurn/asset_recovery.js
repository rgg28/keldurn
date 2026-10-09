// Bevy retains failed asset loads. Keep transient network failures inside the byte read so
// dependent models/materials receive their original handle's result when the network recovers.
const DELAYS = [250, 1000, 3000, 8000];
const aborted = signal => signal?.reason ?? new DOMException('Aborted', 'AbortError');
const transient = status => status === 0 || status === 408 || status === 425 || status === 429 || status >= 500 && status <= 599;

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(aborted(signal)); return; }
    const cancel = () => { clearTimeout(timer); reject(aborted(signal)); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', cancel); resolve(); }, ms);
    signal?.addEventListener('abort', cancel, {once:true});
  });
}

async function attempt(read, url, signal, timeoutMs) {
  const controller = new AbortController();
  let timer, cancel;
  try {
    return await Promise.race([
      new Promise((_, reject) => {
        cancel = () => { const error = aborted(signal); controller.abort(error); reject(error); };
        if (signal?.aborted) { cancel(); return; }
        signal?.addEventListener('abort', cancel, {once:true});
        timer = setTimeout(() => {
          const error = new DOMException('Asset download timed out', 'TimeoutError');
          controller.abort(error); reject(error);
        }, timeoutMs);
      }),
      Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason;
        return read(url, controller.signal);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

export async function retryAssetBytes(read, url, signal, {delays=DELAYS, timeoutMs=15000, wait=delay}={}) {
  for (let index=0; ; index++) {
    if (signal?.aborted) throw aborted(signal);
    try {
      const result = await attempt(read, url, signal, timeoutMs);
      if (!transient(result[0]) || index >= delays.length) return result;
    } catch (error) {
      if (signal?.aborted) throw aborted(signal);
      if (index >= delays.length) throw error;
    }
    await wait(delays[index], signal);
  }
}

export function installAssetByteRecovery(target=globalThis) {
  if (target.__keldurn_fetch_asset_bytes?.keldurnRecovery) return;
  const read = target.__keldurn_fetch_asset_bytes?.bind(target) ?? (async (url, signal) => {
    const response = await target.fetch(url, {signal, credentials:'same-origin'});
    return [response.status, new Uint8Array(response.ok ? await response.arrayBuffer() : new ArrayBuffer(0))];
  });
  const recovered = (url, signal) => {
    let eligible = false;
    try {
      const parsed = new URL(url, target.location?.origin);
      eligible = parsed.origin === target.location?.origin && parsed.pathname.startsWith('/data/');
    } catch { /* Leave ordinary URL validation to the existing reader. */ }
    return eligible ? retryAssetBytes(read, url, signal) : read(url, signal);
  };
  recovered.keldurnRecovery = true;
  target.__keldurn_fetch_asset_bytes = recovered;
}
