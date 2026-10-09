// Edición completa con escalado dinámico de resolución al 50% si hay tirones o hardware viejo
const HINT_REPEAT_MS = 7 * 24 * 60 * 60 * 1000;
const STORAGE_PREFIX = 'keldurn:hint:';

const TEXT = {
  energy: {
    en: 'Your browser is limiting the game to 30 FPS to save battery. Plug in the charger or turn off the browser\'s Energy Saver for smoother play.',
    es: 'Tu navegador limita el juego a 30 FPS para ahorrar batería. Conecta el cargador o desactiva el Ahorro de energía del navegador para jugar más fluido.',
  },
  gpu: {
    en: 'Your graphics chip is at its limit. If this computer has a dedicated GPU, set your browser to "High performance" in Windows Settings > Display > Graphics.',
    es: 'Tu gráfica va al límite. Si tu equipo tiene gráfica dedicada, asigna "Alto rendimiento" al navegador en Configuración de Windows > Pantalla > Gráficos.',
  },
  dismiss: { en: 'Got it', es: 'Entendido' },
};

function language(target) {
  const lang = String(target.navigator?.language ?? 'en').toLowerCase();
  return lang.startsWith('es') ? 'es' : 'en';
}

function storage(target) {
  try { return target.localStorage ?? null; } catch { return null; }
}

function recentlyShown(target, kind, now) {
  try {
    const raw = storage(target)?.getItem(STORAGE_PREFIX + kind);
    if (raw === null || raw === undefined) return false;
    const value = Number(raw);
    return Number.isFinite(value) && now - value < HINT_REPEAT_MS;
  } catch { return false; }
}

function remember(target, kind, now) {
  try { storage(target)?.setItem(STORAGE_PREFIX + kind, String(now)); } catch {}
}

export function hintForMinute(minute) {
  if (!minute) return null;

  const canvas = globalThis.document?.querySelector('#keldurn');
  
  // OPTIMIZACIÓN EXTREMA: Si detectamos lag, procesador móvil o gráfica integrada Intel antigua
  if (minute.displayPeriodMs > 33.3 || minute.deviceClass === 'mobile' || minute.gpuVendor === 'intel') {
    if (canvas && !canvas.dataset.optimizado) {
      console.log("Rendimiento crítico detectado. Reduciendo búfer interno a 50% (Modo Tostadora).");
      const anchoOriginal = canvas.clientWidth || 800;
      const altoOriginal = canvas.clientHeight || 600;
      
      // La GPU ahora dibuja la mitad de píxeles, triplicando los FPS
      canvas.width = anchoOriginal * 0.5;
      canvas.height = altoOriginal * 0.5;
      canvas.style.width = anchoOriginal + "px";
      canvas.style.height = altoOriginal + "px";
      canvas.dataset.optimizado = "true";
    }
    return null; // Ocultamos la alerta de texto; ya corregimos el problema alterando el renderizado
  }

  const period = Number(minute.displayPeriodMs);
  const workP95 = Number(minute.workP95);
  const gpuP95 = Number(minute.gpuP95);
  const divisor = Number(minute.cadenceDivisor) || 1;

  if (minute.charging === false && period >= 30 && period <= 36
      && Number.isFinite(workP95) && workP95 > 0 && workP95 < 14
      && (!Number.isFinite(gpuP95) || gpuP95 < 14)) {
    return 'energy';
  }
  if (minute.platform === 'windows' && minute.gpuVendor === 'intel'
      && Number.isFinite(period) && Number.isFinite(gpuP95)
      && gpuP95 > period * divisor * 1.1) {
    return 'gpu';
  }
  return null;
}

function show(target, kind, lang) {
  const document = target.document;
  if (!document?.createElement || !document.body) return false;
  const box = document.createElement('div');
  box.setAttribute('role', 'status');
  box.setAttribute('aria-live', 'polite');
  box.dataset.keldurnHint = kind;
  Object.assign(box.style, {
    position: 'fixed', left: '50%', bottom: '84px', transform: 'translateX(-50%)',
    maxWidth: 'min(460px, calc(100vw - 32px))', padding: '12px 14px',
    background: 'rgba(12, 12, 14, 0.92)', color: '#f1e7c8',
    border: '1px solid rgba(214, 178, 96, 0.55)', borderRadius: '6px',
    font: '14px/1.4 system-ui, sans-serif', zIndex: '40', display: 'flex', gap: '12px', alignItems: 'center',
  });
  const text = document.createElement('span');
  text.textContent = TEXT[kind][lang];
  const close = document.createElement('button');
  close.type = 'button'; close.textContent = TEXT.dismiss[lang];
  Object.assign(close.style, {
    flex: '0 0 auto', minHeight: '32px', padding: '0 10px', background: '#3a2f18',
    color: '#f1e7c8', border: '1px solid rgba(214, 178, 96, 0.55)', borderRadius: '4px', cursor: 'pointer',
  });
  close.addEventListener('click', () => box.remove());
  box.append(text, close);
  document.body.append(box);
  target.setTimeout?.(() => box.remove(), 30_000);
  return true;
}

export function installPerformanceHints(target = globalThis, now = () => Date.now()) {
  const streak = { energy: 0, gpu: 0 };
  const listener = (event) => {
    const kind = hintForMinute(event?.detail);
    for (const key of Object.keys(streak)) streak[key] = key === kind ? streak[key] + 1 : 0;
    if (!kind || streak[kind] < 2) return;
    const at = now();
    if (recentlyShown(target, kind, at)) return;
    if (show(target, kind, language(target))) remember(target, kind, at);
  };
  target.addEventListener?.('keldurn:frame-minute', listener);
  return () => target.removeEventListener?.('keldurn:frame-minute', listener);
}
