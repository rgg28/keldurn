// Keep the game's encrypted byte stream alive across a short browser/network interruption.
// The protocol is advertised by the authenticated realm before any control bytes are sent.
const LIMIT = 1024 * 1024;
const GRACE = 90_000;
const validOffset = n => Number.isSafeInteger(n) && n >= 0;
const bytes = data => data instanceof ArrayBuffer ? new Uint8Array(data)
  : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : null;
const packet = (offset, data) => {
  const out = new Uint8Array(8 + data.length);
  new DataView(out.buffer).setBigUint64(0, BigInt(offset)); out.set(data, 8);
  return out;
};

export function installRelayResume(target = window, options = {}) {
  if (target.WebSocket.keldurnResumable) return;
  const Raw = target.WebSocket;
  const now = options.now ?? (() => Date.now());
  const later = options.setTimeout ?? target.setTimeout.bind(target);
  const cancel = options.clearTimeout ?? target.clearTimeout.bind(target);
  const every = options.setInterval ?? target.setInterval.bind(target);
  const stop = options.clearInterval ?? target.clearInterval.bind(target);
  const E = target.Event ?? Event;
  const ET = target.EventTarget ?? EventTarget;
  const event = (name, values = {}) => Object.assign(new E(name), values);

  class Socket extends ET {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    constructor(url, protocols) {
      super();
      const path = new URL(url, target.location?.href).pathname;
      if (path !== '/ws/8085') return protocols === undefined ? new Raw(url) : new Raw(url, protocols);
      this.url = String(url); this.protocol = ''; this.extensions = ''; this.binaryType = 'arraybuffer';
      this.readyState = 0; this.onopen = this.onmessage = this.onerror = this.onclose = null;
      this.token = null; this.mode = null; this.inputStart = 0; this.input = new Uint8Array(0);
      this.output = 0; this.raw = null; this.generation = 0; this.recoverAt = null;
      this.attempt = 0; this.lastReceived = now(); this.retry = null; this.protocols = protocols;
      this.beat = every(() => this.heartbeat(), 5_000);
      this.connect();
    }
    get bufferedAmount() { return this.input.length + (this.raw?.bufferedAmount ?? 0); }
    emit(name, values) {
      const e = event(name, values); this.dispatchEvent(e); this['on' + name]?.call(this, e);
    }
    status(recovering) {
      target.__keldurnTransportRecovering = recovering;
      if (recovering) target.dispatchEvent?.(event('blur'));
      target.dispatchEvent?.(event('keldurn-transport-state', { detail: { recovering } }));
    }
    connect() {
      if (this.readyState === 3) return;
      const generation = ++this.generation;
      const url = new URL(this.url, target.location?.href); url.searchParams.set('resume', '1');
      let raw;
      try { raw = this.protocols === undefined ? new Raw(url.href) : new Raw(url.href, this.protocols); }
      catch { this.interrupted(); return; }
      this.raw = raw; raw.binaryType = 'arraybuffer';
      // The observed constructor records final transport failure, not an intermediate leg.
      raw.keldurnClosedByGame = true;
      const current = () => generation === this.generation && this.readyState !== 3;
      raw.addEventListener('message', e => { if (current()) this.receive(e.data); });
      raw.addEventListener('error', () => { if (current()) this.interrupted(); });
      raw.addEventListener('close', e => {
        if (!current()) return;
        if ([1000, 1001, 1008].includes(e.code)) this.finish(e.code, e.reason, e.wasClean);
        else this.interrupted();
      });
    }
    receive(data) {
      this.lastReceived = now();
      if (typeof data === 'string') {
        let value; try { value = JSON.parse(data); } catch { return this.finish(1002, 'Invalid relay control'); }
        if (value.keldurnRelay === 1) {
          this.mode = 'resume'; this.transmit(JSON.stringify({ token: this.token, out: this.output }));
        } else if (value.ready === 1 && this.mode === 'resume') {
          if (!/^[a-f0-9]{32}$/.test(value.token) || (this.token && this.token !== value.token)
              || value.out !== this.output || !this.acknowledge(value.in)) return this.finish(1002, 'Invalid relay checkpoint');
          this.token = value.token; this.recoverAt = null; this.attempt = 0; this.status(false);
          this.protocol = this.raw.protocol; this.extensions = this.raw.extensions;
          if (this.readyState === 0) { this.readyState = 1; this.emit('open'); }
          // Retransmit only bytes the relay has not written to this SAME upstream connection.
          for (let i = 0; i < this.input.length; i += 65536) {
            if (!this.transmit(packet(this.inputStart + i, this.input.subarray(i, i + 65536)))) return;
          }
        } else if (validOffset(value.ack) && this.mode === 'resume') {
          if (!this.acknowledge(value.ack)) this.finish(1002, 'Invalid relay acknowledgement');
        } else this.finish(1002, 'Unknown relay control');
        return;
      }
      const payload = bytes(data);
      if (!payload) return this.finish(1002, 'Invalid relay data');
      if (this.mode === null) {
        this.mode = 'legacy'; this.readyState = 1; this.emit('open');
      }
      if (this.mode === 'legacy') return this.emit('message', { data });
      if (!this.token || payload.length < 8) return this.finish(1002, 'Invalid relay frame');
      const offset = Number(new DataView(payload.buffer, payload.byteOffset, payload.byteLength).getBigUint64(0));
      if (!validOffset(offset) || offset > this.output) return this.finish(1002, 'Missing relay bytes');
      const skip = this.output - offset;
      if (skip < payload.length - 8) {
        const fresh = payload.slice(8 + skip); this.output += fresh.length;
        this.emit('message', { data: fresh.buffer });
      }
      this.transmit(JSON.stringify({ ack: this.output }));
    }
    transmit(data) {
      try { this.raw.send(data); return true; }
      catch { this.interrupted(); return false; }
    }
    acknowledge(offset) {
      if (!validOffset(offset) || offset < this.inputStart || offset > this.inputStart + this.input.length) return false;
      this.input = this.input.slice(offset - this.inputStart); this.inputStart = offset; return true;
    }
    send(data) {
      if (this.readyState !== 1) throw new Error('WebSocket is not open');
      if (this.mode === 'legacy') return this.raw.send(data);
      const payload = bytes(data);
      if (!payload) throw new TypeError('The world transport requires binary data');
      if (this.input.length + payload.length > LIMIT) return this.finish(1009, 'Relay buffer full');
      const offset = this.inputStart + this.input.length;
      const next = new Uint8Array(this.input.length + payload.length);
      next.set(this.input); next.set(payload, this.input.length); this.input = next;
      if (this.recoverAt === null) {
        try { this.raw.send(packet(offset, payload)); } catch { this.interrupted(); }
      }
    }
    interrupted() {
      if (this.readyState === 3 || this.retry !== null) return;
      if (!this.token || this.mode === 'legacy') return this.finish(1006, 'Connection lost');
      if (this.recoverAt === null) { this.recoverAt = now(); this.status(true); }
      if (now() - this.recoverAt >= GRACE) return this.finish(1006, 'Connection recovery expired');
      // Supersede a half-open leg immediately. An abnormal application close retains its TCP.
      ++this.generation;
      try { this.raw?.close(4000, 'Replacing connection'); } catch {}
      const delay = [0, 500, 1_000, 2_000, 5_000][Math.min(this.attempt++, 4)];
      this.retry = later(() => { this.retry = null; this.connect(); }, delay);
    }
    heartbeat() {
      if (this.readyState === 3 || this.mode !== 'resume') return;
      if (this.recoverAt !== null) {
        if (now() - this.recoverAt >= GRACE) this.finish(1006, 'Connection recovery expired');
      } else if (now() - this.lastReceived >= 20_000) this.interrupted();
      else if (this.raw?.readyState === 1 && this.token) {
        try { this.raw.send(JSON.stringify({ ack: this.output })); } catch { this.interrupted(); }
      }
    }
    finish(code, reason = '', wasClean = false) {
      if (this.readyState === 3) return;
      this.readyState = 3; ++this.generation; stop(this.beat);
      if (this.retry !== null) cancel(this.retry);
      this.retry = null; this.input = new Uint8Array(0); this.status(false);
      try { this.raw?.close(1000); } catch {}
      if (this.keldurnClosedByGame !== true) target.dispatchEvent?.(event('keldurn-transport-ended', { detail: { code, wasClean } }));
      this.emit('close', { code, reason, wasClean });
    }
    close(code = 1000, reason = '') { this.finish(code, reason, true); }
  }
  Socket.keldurnResumable = true;
  target.WebSocket = Socket;
  // A stale world view must not accept new touch/keyboard actions while transport recovers.
  for (const name of ['keydown', 'pointerdown', 'mousedown', 'touchstart', 'wheel', 'click']) {
    target.document?.addEventListener(name, e => {
      if (target.__keldurnTransportRecovering && (e.target?.id === 'keldurn'
          || e.target?.closest?.('#keldurn-mobile-controls'))) {
        e.preventDefault(); e.stopImmediatePropagation();
      }
    }, { capture: true, passive: false });
  }
  const label = target.document?.createElement('div');
  if (label) {
    label.textContent = /^es/i.test(target.navigator?.language ?? '') ? 'Reconectando…' : 'Reconnecting…';
    label.setAttribute('role', 'status'); label.hidden = true;
    Object.assign(label.style, { position: 'fixed', top: '64px', left: '50%', transform: 'translateX(-50%)',
      zIndex: '100000', background: '#171b22', color: 'white', padding: '12px 20px', pointerEvents: 'none' });
    target.document.body?.appendChild(label);
    target.addEventListener?.('keldurn-transport-state', e => { label.hidden = !e.detail.recovering; });
  }
  return Socket;
}
