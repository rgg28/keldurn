// Release every keyboard modifier when the page loses or regains the user's attention.
//
// Ctrl+Tab (or Alt+Tab, or the Windows key) is pressed while the game has the keyboard, so its
// keydown reaches the canvas; the release happens in another tab or window and never does. Nothing
// else tells the engine: the canvas gets no blur on a tab switch, so Bevy's focus-loss release
// never runs, and the modifier stays held. Movement ignores modifiers, so WASD still walks, but
// every typed letter is a Ctrl chord (the chat box refuses it) and every hotkey becomes CTRL-x
// with no binding — "I lose use of my keyboard and have to refresh … WASD still works but can't
// type in chat or use hotkeys" (player, 2026-09-29; reproduced in Chrome with a held Ctrl and a
// tab switch). A synthetic keyup on the canvas goes through the same winit listener as a real one,
// so the engine releases the key; for a modifier that is not held it changes nothing.

const MODIFIERS = [
  ['Control', 'ControlLeft', 1], ['Control', 'ControlRight', 2],
  ['Alt', 'AltLeft', 1], ['Alt', 'AltRight', 2],
  ['Shift', 'ShiftLeft', 1], ['Shift', 'ShiftRight', 2],
  ['Meta', 'MetaLeft', 1], ['Meta', 'MetaRight', 2],
];

export function releaseModifiers(canvas, KeyboardEventCtor = globalThis.KeyboardEvent) {
  if (!canvas || !KeyboardEventCtor) return 0;
  for (const [key, code, location] of MODIFIERS) {
    canvas.dispatchEvent(new KeyboardEventCtor('keyup', { key, code, location, bubbles: true, cancelable: true }));
  }
  return MODIFIERS.length;
}

// `win` is the window (blur/focus), `doc` its document (visibilitychange). Returns the uninstaller.
export function installModifierRelease(canvas, win = globalThis.window, doc = globalThis.document) {
  if (!canvas || !win || !doc) return () => {};
  const release = () => releaseModifiers(canvas, win.KeyboardEvent);
  doc.addEventListener('visibilitychange', release);
  win.addEventListener('blur', release);
  win.addEventListener('focus', release);
  return () => {
    doc.removeEventListener('visibilitychange', release);
    win.removeEventListener('blur', release);
    win.removeEventListener('focus', release);
  };
}
