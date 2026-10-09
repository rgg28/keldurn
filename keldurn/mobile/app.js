// Optional home-screen installation and comfort controls for iOS/Android only.
// No service worker: authenticated game/API responses retain their existing cache policy.
import { mobilePlatform } from './platform.js';
export { mobilePlatform } from './platform.js';

export function isStandalone(target = globalThis) {
  return target.navigator?.standalone === true
    || Boolean(target.matchMedia?.('(display-mode: standalone)').matches)
    || Boolean(target.matchMedia?.('(display-mode: fullscreen)').matches);
}

// Browsers require a user gesture. Attempt once on the first game touch; leaving fullscreen
// deliberately must not cause the following touch to enter it again. iPhone uses its PWA.
export function createGameFullscreen(target = globalThis) {
  const doc = target.document;
  const available = mobilePlatform(target) === 'android' && Boolean(doc?.fullscreenEnabled)
    && typeof doc?.documentElement?.requestFullscreen === 'function';
  let attempted = false;
  const request = async () => {
    if (!available || doc.fullscreenElement || isStandalone(target)) return false;
    attempted = true;
    try { await doc.documentElement.requestFullscreen(); return true; }
    catch { return false; }
  };
  return { available, request, firstTouch(inWorld) {
    if (inWorld && !attempted) return request();
    return Promise.resolve(false);
  } };
}

export function createGameWakeLock(target = globalThis) {
  let inWorld = false, enabled = true, sentinel = null, pending = null, generation = 0, retryAfter = 0;
  const now = () => target.performance?.now?.() ?? Date.now();
  const desired = () => enabled && inWorld && !target.document?.hidden;
  const release = () => {
    generation++;
    const old = sentinel; sentinel = null;
    if (old) Promise.resolve(old.release()).catch(() => {});
  };
  const sync = async () => {
    if (!desired()) { release(); return; }
    if (sentinel || pending || now() < retryAfter || !target.navigator?.wakeLock) return;
    const current = generation;
    pending = Promise.resolve().then(() => target.navigator.wakeLock.request('screen'));
    try {
      const next = await pending;
      if (current !== generation || !desired()) { await next.release(); return; }
      sentinel = next;
      next.addEventListener?.('release', () => {
        if (sentinel === next) { sentinel = null; retryAfter = now() + 30_000; }
      });
    } catch { retryAfter = now() + 30_000; /* No repeated requests on every touch after denial. */ }
    finally {
      pending = null;
      // A hide/show can race a pending grant. Release the old grant, then acquire for this visit.
      if (current !== generation && desired()) void sync();
    }
  };
  return {
    setInWorld(value) { if (inWorld !== Boolean(value)) { inWorld = Boolean(value); void sync(); } },
    setEnabled(value) { if (enabled !== Boolean(value)) retryAfter = 0; enabled = Boolean(value); void sync(); },
    sync,
    release,
  };
}

const KEY = 'keldurn:mobile-comfort:v1';
// Public release metadata is an explicit deployment gate. Never offer a private-QA APK,
// another package/origin, or mistake a PWA install event for the native application.
export function validateAndroidRelease(value) {
  if (!value || value.schemaVersion !== 1 || value.package !== 'com.keldurn.game'
    || value.origin !== 'https://play.keldurn.com' || value.abi !== 'arm64-v8a'
    || value.minSdk !== 26 || value.url !== '/download/keldurn-android.apk'
    || !Number.isSafeInteger(value.versionCode) || value.versionCode < 4
    || !/^[0-9]+\.[0-9]+\.[0-9]+$/.test(value.versionName || '')
    || !/^[a-f0-9]{64}$/.test(value.sha256 || '')
    || !/^[a-f0-9]{64}$/.test(value.signingCertificateSha256 || '')
    || !Number.isSafeInteger(value.bytes) || value.bytes <= 0 || value.bytes > 250_000_000
    || !Number.isSafeInteger(value.initialDownloadBytes) || value.initialDownloadBytes < 0
    || value.initialDownloadBytes > 10_000_000_000) return null;
  return Object.freeze({...value});
}

export async function loadAndroidRelease(target = globalThis) {
  if (mobilePlatform(target) !== 'android' || target.location?.origin !== 'https://play.keldurn.com'
    || typeof target.fetch !== 'function') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const response = await target.fetch('/mobile/android-release.json', {
      cache: 'no-store', credentials: 'omit', redirect: 'error', signal: controller.signal,
    });
    if (!response.ok || !response.headers.get('content-type')?.includes('application/json')) return null;
    const text = await response.text();
    if (text.length > 16384) return null;
    return validateAndroidRelease(JSON.parse(text));
  } catch { return null; }
  finally { clearTimeout(timer); }
}

export function readComfort(target = globalThis) {
  try {
    const saved = JSON.parse(target.localStorage?.getItem(KEY) || '{}');
    return { awake: saved.awake !== false, large: saved.large === true, left: saved.left === true,
      bar: saved.bar === true };
  } catch { return { awake: true, large: false, left: false, bar: false }; }
}

export function installMobileApp(target = globalThis) {
  const platform = mobilePlatform(target);
  if (!platform || !target.document?.body) return null;
  if (target.__keldurnMobileApp) return target.__keldurnMobileApp;
  const doc = target.document;
  const say = (en, spanish) => (doc.documentElement.lang || target.navigator.language || 'en').toLowerCase().startsWith('es') ? spanish : en;
  const comfort = readComfort(target);
  const wake = createGameWakeLock(target);
  const fullscreen = createGameFullscreen(target);
  let installed = isStandalone(target), prompt = null, promptBusy = false, inWorld = false;
  let overlayOpen = false;
  let overlayVisited = false;
  let nativeRelease = null;

  function link(rel, href, extra = {}) {
    const el = doc.createElement('link'); el.rel = rel; el.href = href;
    Object.assign(el, extra); doc.head.append(el);
  }
  // With no manifest link or promotion on desktop, Keldurn does not solicit desktop installation.
  link('manifest', '/mobile/manifest.webmanifest');
  link('apple-touch-icon', '/mobile/icon-180.png', { sizes: '180x180' });
  link('stylesheet', '/mobile/app.css');
  // Black-translucent: the standalone app draws the world under the status bar and cutout
  // instead of leaving an opaque strip; the HUD already keeps to the safe-area insets.
  for (const [name, content] of [['apple-mobile-web-app-capable', 'yes'],
    ['apple-mobile-web-app-title', 'Keldurn'], ['apple-mobile-web-app-status-bar-style', 'black-translucent'],
    ['theme-color', '#000000']]) {
    if (doc.head.querySelector?.(`meta[name="${name}"]`)) continue;
    const meta = doc.createElement('meta'); meta.name = name; meta.content = content; doc.head.append(meta);
  }
  doc.documentElement.dataset.keldurnMobilePlatform = platform;

  const entry = doc.createElement('button');
  entry.id = 'keldurn-mobile-app-entry'; entry.type = 'button';
  entry.textContent = say('Play as an app', 'Jugar como app');
  const bar = doc.getElementById('bar');
  if (bar) bar.append(entry); else { entry.className = 'keldurn-app-onboarding'; doc.body.append(entry); }

  const dialog = doc.createElement('dialog'); dialog.id = 'keldurn-mobile-app-dialog';
  dialog.setAttribute('aria-labelledby', 'keldurn-mobile-app-title');
  // Static product copy only. Account, chat and quest content never enter this HTML.
  dialog.innerHTML = `<div class="keldurn-app-heading"><h2 id="keldurn-mobile-app-title">${say('Make yourself comfortable', 'Juega a tu gusto')}</h2><button type="button" data-app-close aria-label="${say('Close', 'Cerrar')}">×</button></div>
    <fieldset data-app-comfort><legend>${say('In game', 'Durante la partida')}</legend>
      <button type="button" data-app-fullscreen></button><p data-app-screen-status role="status"></p>
      <label><input type="checkbox" data-app-awake><span></span></label>
      <label><input type="checkbox" data-app-large><span></span></label>
      <label><input type="checkbox" data-app-bar><span></span></label>
      <label><input type="checkbox" data-app-left><span></span></label>
      <p data-app-hand-hint>${say('Movement and camera switch sides together. You can change this at any time.', 'El movimiento y la cámara intercambian sus lados. Puedes cambiarlo cuando quieras.')}</p>
    </fieldset><details data-app-installation><summary>${say('Install Keldurn', 'Instalar Keldurn')}</summary>
      <p data-app-description></p><ol data-app-steps></ol>
      <button type="button" data-app-install></button><p role="status" data-app-status></p>
    </details><button type="button" data-app-done>${say('Continue playing', 'Seguir jugando')}</button>`;
  doc.body.append(dialog);
  const $ = selector => dialog.querySelector(selector);
  $('[data-app-comfort]').hidden = !doc.getElementById('keldurn');
  $('[data-app-done]').textContent = bar ? say('Continue playing', 'Seguir jugando') : say('Continue in browser', 'Seguir en el navegador');
  function redraw() {
    entry.textContent = nativeRelease
      ? say('Download for Android', 'Descargar para Android')
      : say('Play as an app', 'Jugar como app');
    $('#keldurn-mobile-app-title').textContent = nativeRelease
      ? say('Play on Android', 'Juega en Android')
      : say('Make yourself comfortable', 'Juega a tu gusto');
    $('[data-app-close]').setAttribute('aria-label', say('Close', 'Cerrar'));
    $('[data-app-installation] summary').textContent = say('Install Keldurn', 'Instalar Keldurn');
    $('[data-app-comfort] legend').textContent = say('In game', 'Durante la partida');
    $('[data-app-fullscreen]').hidden = !fullscreen.available || installed;
    $('[data-app-fullscreen]').textContent = say('Full screen', 'Pantalla completa');
    for (const [key, en, es] of [
      ['awake', 'Keep the screen awake while playing', 'Mantener la pantalla encendida al jugar'],
      ['large', 'Larger action buttons', 'Botones de acción más grandes'],
      ['bar', 'Show all 12 skills (full bar)', 'Ver las 12 habilidades (barra completa)'],
      ['left', 'Movement on the right', 'Movimiento a la derecha'],
    ]) $(`[data-app-${key}]`).nextElementSibling.textContent = say(en, es);
    $('[data-app-hand-hint]').textContent = say('Movement and camera switch sides together. You can change this at any time.', 'El movimiento y la cámara intercambian sus lados. Puedes cambiarlo cuando quieras.');
    $('[data-app-done]').textContent = bar ? say('Continue playing', 'Seguir jugando') : say('Continue in browser', 'Seguir en el navegador');
    const quick = target.__keldurnMobileController?.root?.querySelector('[data-mobile-comfort]');
    if (quick) quick.textContent = say('Comfort / App', 'Comodidad / App');
    installed = installed || isStandalone(target);
    entry.hidden = (installed && !nativeRelease) || inWorld;
    $('[data-app-description]').textContent = installed
      ? say('Keldurn is open as an app. Your adventure is saved to your account.', 'Keldurn está abierto como app. Tu aventura se guarda en tu cuenta.')
      : say('Open Keldurn from your home screen with more room for the game. Installation is optional; your account and characters stay the same.', 'Abre Keldurn desde tu pantalla de inicio con más espacio para jugar. Es opcional; tu cuenta y tus personajes siguen siendo los mismos.');
    const steps = $('[data-app-steps]'); steps.replaceChildren();
    if (!installed && (platform === 'ios' || !prompt)) {
      const instructions = platform === 'ios'
        ? [say('Open the browser Share menu.', 'Abre el menú Compartir del navegador.'),
          say('Choose Add to Home Screen. Enable Open as Web App if shown, then Add.', 'Elige Añadir a pantalla de inicio. Activa Abrir como app si aparece y pulsa Añadir.'),
          say('If the option is missing, open play.keldurn.com directly in Safari.', 'Si no aparece la opción, abre play.keldurn.com directamente en Safari.')]
        : [say('Open the browser menu.', 'Abre el menú del navegador.'),
          say('Choose Install app or Add to Home screen.', 'Elige Instalar aplicación o Añadir a pantalla de inicio.')];
      for (const instruction of instructions) { const li = doc.createElement('li'); li.textContent = instruction; steps.append(li); }
    }
    steps.hidden = !steps.children.length;
    $('[data-app-install]').hidden = installed || platform !== 'android' || !prompt;
    $('[data-app-install]').disabled = promptBusy;
    $('[data-app-install]').textContent = say('Install Keldurn', 'Instalar Keldurn');
    if (nativeRelease) {
      const apkMb = Math.ceil(nativeRelease.bytes / 1_000_000);
      const dataMb = Math.ceil(nativeRelease.initialDownloadBytes / 1_000_000);
      $('[data-app-description]').textContent = say(
        'Native Keldurn for Android. Your account and characters stay the same. Installation is optional.',
        'Keldurn nativo para Android. Conservas tu cuenta y personajes. La instalación es opcional.');
      steps.replaceChildren();
      for (const instruction of [
        say('Requires Android 8 or newer and a 64-bit ARM device.', 'Requiere Android 8 o posterior y un dispositivo ARM de 64 bits.'),
        say(`APK: ${apkMb} MB. Initial game download: about ${dataMb} MB; Wi-Fi recommended.`,
          `APK: ${apkMb} MB. Descarga inicial del juego: unos ${dataMb} MB; recomendamos Wi-Fi.`),
        say('Open the downloaded APK and allow installation from this browser if Android asks. Confirm the installation.',
          'Abre la APK descargada y permite la instalación desde este navegador si Android lo pide. Confirma la instalación.'),
        say('Open Keldurn and sign in through your browser. Updates use the same app signature and preserve your local data.',
          'Abre Keldurn e inicia sesión mediante tu navegador. Las actualizaciones mantienen la firma y tus datos locales.'),
      ]) { const li = doc.createElement('li'); li.textContent = instruction; steps.append(li); }
      steps.hidden = false;
      $('[data-app-install]').hidden = false;
      $('[data-app-install]').disabled = false;
      $('[data-app-install]').textContent = say('Download Android APK', 'Descargar APK de Android');
    }
  }
  function applyComfort() {
    doc.documentElement.dataset.keldurnLargeActions = String(comfort.large);
    doc.documentElement.dataset.keldurnRightMovement = String(comfort.left);
    // Phones default to the action fan; the full twelve-slot bar stays one tap away.
    doc.documentElement.dataset.keldurnFullBar = String(comfort.bar);
    target.__keldurnMobileController?.updateLayout?.();
    wake.setEnabled(comfort.awake);
    try { target.localStorage?.setItem(KEY, JSON.stringify(comfort)); } catch { /* Session preference works. */ }
  }
  function close() {
    dialog.close(); overlayOpen = false;
    target.__keldurnMobileController?.setOverlayOpen?.(false);
  }
  function open() {
    if (overlayOpen) return;
    overlayVisited = true;
    redraw(); overlayOpen = true;
    $('[data-app-installation]').open = !inWorld;
    target.__keldurnMobileController?.setOverlayOpen?.(true);
    dialog.showModal();
  }
  entry.addEventListener('click', open);
  $('[data-app-close]').addEventListener('click', close);
  $('[data-app-done]').addEventListener('click', close);
  $('[data-app-fullscreen]').addEventListener('click', async () => {
    if (await fullscreen.request()) close();
    else $('[data-app-screen-status]').textContent = say('Full screen is unavailable in this browser right now.', 'La pantalla completa no está disponible ahora en este navegador.');
  });
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  dialog.addEventListener('click', event => { if (event.target === dialog) close(); });
  dialog.addEventListener('keydown', event => event.stopPropagation());
  dialog.addEventListener('keyup', event => event.stopPropagation());
  for (const key of ['awake', 'large', 'left', 'bar']) {
    const input = $(`[data-app-${key}]`); input.checked = comfort[key];
    input.addEventListener('change', () => { comfort[key] = input.checked; applyComfort(); });
  }
  $('[data-app-install]').addEventListener('click', async () => {
    if (nativeRelease) {
      // Only an explicit player click starts a download; never navigate/reload their game.
      const download = doc.createElement('a');
      download.href = nativeRelease.url; download.download = 'keldurn-android.apk';
      download.target = '_blank'; download.rel = 'noopener';
      doc.body.append(download); download.click(); download.remove();
      return;
    }
    if (!prompt || promptBusy) return;
    const event = prompt; prompt = null; promptBusy = true; redraw();
    try {
      await event.prompt(); const choice = await event.userChoice;
      $('[data-app-status]').textContent = choice?.outcome === 'accepted'
        ? say('Finish installation in your browser. You can continue your game.', 'Termina la instalación en el navegador. Puedes continuar tu partida.')
        : say('You can keep playing here and install later.', 'Puedes seguir jugando aquí e instalarla después.');
    } catch { $('[data-app-status]').textContent = say('Use your browser menu to add Keldurn to the home screen.', 'Usa el menú del navegador para añadir Keldurn a la pantalla de inicio.'); }
    finally { promptBusy = false; redraw(); }
  });
  target.addEventListener('beforeinstallprompt', event => { event.preventDefault(); prompt = event; redraw(); });
  target.addEventListener('appinstalled', () => { installed = true; prompt = null; redraw(); });
  target.matchMedia?.('(display-mode: standalone)').addEventListener?.('change', redraw);
  // The shell restores the account language after boot and changes it without a page reload.
  if (target.MutationObserver) new target.MutationObserver(redraw).observe(doc.documentElement, { attributes: true, attributeFilter: ['lang'] });
  doc.addEventListener('visibilitychange', () => { void wake.sync(); });
  target.addEventListener('pagehide', () => { wake.release(); });
  target.addEventListener('pageshow', () => { redraw(); void wake.sync(); });
  doc.addEventListener('pointerdown', () => { void wake.sync(); }, { passive: true });
  if (fullscreen.available) doc.addEventListener('pointerup', event => {
    if (event.target?.id === 'keldurn' || event.target?.closest?.('[data-mobile-look], [data-mobile-stick]')) {
      void fullscreen.firstTouch(inWorld && !overlayOpen);
    }
  }, { passive: true });
  const app = { open, close,
    setHandedness(rightMovement) {
      if (comfort.left === rightMovement) return;
      comfort.left = rightMovement; $('[data-app-left]').checked = rightMovement; applyComfort();
    },
    get overlayOpen() { return overlayOpen; },
    setInWorld(value) { inWorld = Boolean(value); wake.setInWorld(inWorld); redraw(); },
    attachControls(controller) {
      if (!controller.root || controller.root.querySelector('[data-mobile-comfort]')) return;
      const panel = controller.root.querySelector('.keldurn-mobile-quick__panel');
      if (!panel) return;
      const button = doc.createElement('button'); button.type = 'button'; button.dataset.mobileComfort = '';
      button.textContent = say('Comfort / App', 'Comodidad / App');
      button.addEventListener('click', open); panel.append(button);
      controller.setOverlayOpen?.(overlayOpen);
      this.setInWorld(controller.root.dataset.inWorld === 'true');
    },
  };
  target.__keldurnMobileApp = app;
  applyComfort(); redraw();
  void loadAndroidRelease(target).then(release => {
    nativeRelease = release; redraw();
    // Offer the validated APK once per tab session, before gameplay. Opening this
    // dialog never starts a download; the player must still press Download.
    if (platform !== 'android' || !release || inWorld || overlayVisited
      || target.location?.pathname?.startsWith('/native/')) return;
    const offerKey = 'keldurn:android-apk-offer:v1';
    try {
      if (target.sessionStorage?.getItem(offerKey)) return;
    } catch { /* Blocked storage still allows this page's single offer. */ }
    open();
    try { target.sessionStorage?.setItem(offerKey, '1'); }
    catch { /* Installation and browser play do not depend on storage access. */ }
  });
  if (target.__keldurnMobileController) app.attachControls(target.__keldurnMobileController);
  return app;
}

if (typeof window !== 'undefined' && window.document?.body) installMobileApp(window);
