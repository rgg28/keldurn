// Lua error signatures only. Never send raw messages, macro bodies, chat or local paths.
(() => {
  'use strict';
  const send = typeof window.fetch === 'function' ? window.fetch.bind(window) : null;
  const page = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const pending = new Map();
  let timer = null, inFlight = false, stopped = false;
  function signature(row) {
    const message = String(row.message || '').slice(0, 8192);
    const path = /Interface[\\/]AddOns[\\/]([!A-Za-z0-9_.\\/ -]{1,180}\.(?:lua|xml))(?::(\d{1,7}))?/i.exec(message)
      // The built-in UI's own files: without this a FrameXML load failure reported only 'FrameXML'.
      || /Interface[\\/]((?:FrameXML|GlueXML)[\\/][A-Za-z0-9_.\\/ -]{1,170}\.(?:lua|xml))(?::(\d{1,7}))?/i.exec(message);
    const api = /attempt to call (?:global|method|field) ['"]([A-Za-z_][A-Za-z0-9_.]{0,79})['"] \(a nil value\)/.exec(message)?.[1]
      || /\[C\]: in function ['"]([A-Za-z_][A-Za-z0-9_.]{0,79})['"]/.exec(message)?.[1] || '';
    let category = row.kind === 'load' ? 'load' : 'other';
    for (const [pattern, code] of [
      [/nil to (?:u32|i32|f32|f64|number)/i, 'nil-number'],
      [/attempt to index.*nil/i, 'nil-index'], [/attempt to call.*nil/i, 'nil-call'],
      [/arithmetic/i, 'arithmetic'], [/instruction|execution limit/i, 'instruction-limit'],
      [/syntax|unexpected symbol/i, 'syntax'], [/bad argument|expected|converting Lua/i, 'type'],
    ]) { if (pattern.test(message)) { category = code; break; } }
    return {sequence: row.sequence, count: Math.min(row.count, 2147483647),
      source: path ? path[1].replaceAll('\\', '/') : 'FrameXML',
      line: path && path[2] ? Number(path[2]) : 0, api, category};
  }
  function arm(delay = 30000) {
    if (timer === null && !stopped && pending.size) timer = setTimeout(flush, delay);
  }
  async function flush() {
    timer = null;
    if (stopped || inFlight || !pending.size) return;
    const [key, batch] = pending.entries().next().value;
    const errors = [...batch.rows.values()].slice(0, 16);
    inFlight = true;
    try {
      const response = await send('/api/diagnostics/lua', {
        method: 'POST', credentials: 'same-origin', cache: 'no-store',
        headers: {'Content-Type':'application/json', 'X-Requested-With':'keldurn'},
        body: JSON.stringify({version:1, instance:key, release:batch.release, errors}),
      });
      if (response.ok) {
        for (const row of errors) if (batch.rows.get(row.sequence) === row) batch.rows.delete(row.sequence);
        if (!batch.rows.size) pending.delete(key);
      } else if ([401,403,404].includes(response.status)) { stopped = true; pending.clear(); }
    } catch { /* A failed diagnostic upload never interrupts gameplay. Retry is bounded. */ }
    finally { inFlight = false; arm(); }
  }
  window.__keldurn_lua_diagnostics = raw => {
    if (!send || stopped) return false;
    try {
      const data = JSON.parse(raw);
      if (!Number.isSafeInteger(data.vm) || !Array.isArray(data.rows) || data.rows.length > 16 ||
          !/^[A-Za-z0-9_.-]{1,64}$/.test(data.release)) return false;
      const key = `${page}-${data.vm}`;
      if (!pending.has(key)) {
        if (pending.size >= 4) return false;
        pending.set(key, {release:data.release, rows:new Map()});
      }
      const batch = pending.get(key);
      for (const row of data.rows) {
        if (!Number.isSafeInteger(row.sequence) || row.sequence < 1 ||
            !Number.isSafeInteger(row.count) || row.count < 1) continue;
        if (!batch.rows.has(row.sequence) && batch.rows.size >= 256) return false;
        batch.rows.set(row.sequence, signature(row));
      }
      arm();
      return true;
    } catch { return false; }
  };
})();
