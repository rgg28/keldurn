// Compare the authenticated origin paths during existing asset loading. Never hold up boot.
const KEY = 'keldurn.network-route.v1';
const TTL = 60 * 60 * 1000;
const validRoute = value => value === 'mad' || value === 'na';

export function chooseRoute(samples, previous = 'mad') {
  const score = route => {
    const values = samples[route];
    if (values?.length !== 3 || values.some(n => !Number.isFinite(n) || n < 0)) return Infinity;
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[1] + (sorted[2] - sorted[0]) / 2;
  };
  const current = validRoute(previous) ? previous : 'mad';
  const other = current === 'mad' ? 'na' : 'mad';
  const a = score(current), b = score(other);
  if (!Number.isFinite(b)) return current;
  return !Number.isFinite(a) || a - b > Math.max(15, a * 0.15) ? other : current;
}

export async function installNetworkRoute(target = globalThis, options = {}) {
  const now = options.now ?? Date.now;
  const clock = options.clock ?? (() => target.performance.now());
  const fetcher = options.fetch ?? target.fetch.bind(target);
  const timeoutMs = options.timeoutMs ?? 800;
  let previous = null;
  try {
    const cached = JSON.parse(target.localStorage.getItem(KEY));
    if (validRoute(cached?.route) && Number.isFinite(cached.at) && now() >= cached.at && now() - cached.at < TTL) {
      if (!target.__keldurnWsRouteLocked) target.__keldurnWsRoute = cached.route;
      return { route: cached.route, cached: true };
    }
  } catch { /* Private mode, disabled storage or a stale record must never block play. */ }
  const samples = { mad: [], na: [] };
  let available = false;
  async function probe(route) {
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      const start = clock();
      const response = await fetcher(`/api/network-probe?keldurn_route=${route}`, {
        credentials: 'same-origin', cache: 'no-store', signal: abort.signal,
        headers: { 'X-Requested-With': 'keldurn' },
      });
      if (!response.ok || response.headers.get('x-keldurn-network-route') !== route) return false;
      if ((await response.json()).version !== 1) return false;
      samples[route].push(clock() - start);
      available = response.headers.get('x-keldurn-relay-available') === '1';
      const defaultRoute = response.headers.get('x-keldurn-default-route');
      if (previous === null && validRoute(defaultRoute)) previous = defaultRoute;
      return true;
    } catch { return false; }
    finally { clearTimeout(timer); }
  }
  if (!await probe('mad') || !available) return { route: null, measured: false };
  // Alternate paths; a fallback response is labelled with its ACTUAL route and rejected above.
  for (const route of ['na', 'na', 'mad', 'mad', 'na']) {
    if (!await probe(route)) return { route: null, measured: false };
  }
  const route = chooseRoute(samples, previous);
  // Once the client opens a socket, keep its route for that boot. Save a late result for next boot.
  if (!target.__keldurnWsRouteLocked) target.__keldurnWsRoute = route;
  try { target.localStorage.setItem(KEY, JSON.stringify({ route, at: now() })); } catch { /* optional */ }
  return { route, measured: true, samples, applied: !target.__keldurnWsRouteLocked };
}
