// Adoption is measured independently of hitch/error reports. No stable device identifier.
const MODES = new Set(['initializing','active','read-only','paused','unavailable','disabled','network','unknown']);
const CLASSES = new Set(['desktop','mobile','unknown']);
const count = n => Number.isSafeInteger(n) && n >= 0 ? Math.min(n, 2147483647) : 0;
export function observation(state, snapshot, instance, sequence) {
  return {version:1, instance, sequence,
    release:/^[a-f0-9]{64}$/.test(state.webVersion || '') ? state.webVersion : 'unknown',
    retention:snapshot.keepCached === true,
    mode:MODES.has(snapshot.mode) ? snapshot.mode : 'unknown',
    device_class:CLASSES.has(snapshot.deviceClass) ? snapshot.deviceClass : 'unknown',
    hits:count(snapshot.hits), writes:count(snapshot.writes), write_errors:count(snapshot.writeErrors),
    disk_mib:count(Math.floor((snapshot.bytesFromDisk || 0)/1048576))};
}
export function installCacheTelemetry(target, state, initialDelay = 20000) {
  if (!target.document || !target.setTimeout || !target.crypto?.randomUUID || !target.fetch) return null;
  if (state.telemetry) return state.telemetry;
  const instance = target.crypto.randomUUID(), nativeFetch = target.fetch.bind(target);
  let timer, controller, stopped = false, busy = false, sequence = 0;
  const schedule = delay => { if (!stopped) timer = target.setTimeout(tick, delay); };
  async function tick() {
    timer = null;
    if (stopped || busy) return;
    if (target.document.visibilityState !== 'visible') { schedule(300000); return; }
    busy = true;
    try {
      const snapshot = await state.snapshot();
      if (stopped || target.document.visibilityState !== 'visible') return;
      controller = new AbortController();
      const timeout = target.setTimeout(() => controller?.abort(), 5000);
      try {
        const response = await nativeFetch('/api/diagnostics/cache', {method:'POST', credentials:'same-origin',
          cache:'no-store', signal:controller.signal, headers:{'Content-Type':'application/json','X-Requested-With':'keldurn'},
          body:JSON.stringify(observation(state, snapshot, instance, ++sequence))});
        if ([401,403,404].includes(response.status)) stop();
      } finally { target.clearTimeout(timeout); controller = null; }
    } catch { /* Diagnostics never interrupt assets; bounded retry on the next heartbeat. */ }
    finally { busy = false; schedule(300000); }
  }
  function stop() {
    stopped = true; target.clearTimeout(timer); controller?.abort();
    target.removeEventListener?.('storage', changed);
  }
  function changed(event) {
    if (event.key !== 'keldurn:keep-assets' || stopped || busy) return;
    target.clearTimeout(timer); schedule(20000);
  }
  target.addEventListener?.('storage', changed);
  state.telemetry = {stop};
  schedule(initialDelay);
  return state.telemetry;
}
