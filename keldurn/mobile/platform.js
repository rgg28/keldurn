// Hardware identity shared by startup and UI. Touch input and screen size are not identity.
export function mobilePlatform(target = globalThis) {
  const nav = target.navigator || {};
  const ua = String(nav.userAgent || '');
  if (/Windows NT|CrOS/i.test(ua)) return null;
  if (/Android/i.test(ua)) return 'android';
  if (/iPhone|iPad|iPod/i.test(ua)
    || (/Macintosh/i.test(ua) && nav.platform === 'MacIntel' && nav.maxTouchPoints > 1)) return 'ios';
  return null;
}
