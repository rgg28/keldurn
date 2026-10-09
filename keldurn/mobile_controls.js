import { mobilePlatform } from './platform.js';

const STICK_DEAD_ZONE = 0.14;
const TAP_MAX_DURATION_MS = 360;
const TAP_MAX_TRAVEL_PX = 14;
const LOOK_SLOP_PX = 4;
const HUD_PRESENT = 1 << 0;
const HUD_USABLE = 1 << 1;
const HUD_NOT_ENOUGH_MANA = 1 << 2;
const HUD_OUT_OF_RANGE = 1 << 3;
const HUD_CURRENT = 1 << 4;
const HUD_EQUIPPED = 1 << 5;
const CHAT_MAX_CHARS = 255;
const QUICK_COMMANDS = Object.freeze([
  ['Character', 1],
  ['Bags', 2],
  ['Talents', 13],
  ['Spellbook', 3],
  ['Quests', 4],
  ['Map', 5],
  ['Social', 6],
  ['Menu', 7],
  ['Controls', 9],
  ['Group', 12],
  ['Gamepad', 18],
  ['Edit HUD', 19],
  ['Performance', 20],
  ['Run/Stop', 21],
  ['Next window', 11],
]);
const CONTROLS_MODE_KEY = 'keldurn:controls-mode';
const CONTROLS_MODES = new Set(['auto', 'desktop', 'touch']);
let nextGeneration = 1;

export function normalizeStick(dx, dy, radius, deadZone = STICK_DEAD_ZONE) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(radius) || radius <= 0) {
    return { x: 0, y: 0 };
  }
  const magnitude = Math.hypot(dx, dy);
  const normalized = Math.min(magnitude / radius, 1);
  if (normalized <= deadZone || magnitude === 0) return { x: 0, y: 0 };
  const scaled = (normalized - deadZone) / (1 - deadZone);
  return { x: (dx / magnitude) * scaled, y: (dy / magnitude) * scaled };
}

function queryControlsMode(target) {
  const query = new URLSearchParams(target.location?.search ?? '');
  if (query.get('mobile') === '1') return 'touch';
  if (query.get('mobile') === '0') return 'desktop';
  return null;
}

function mediaMatches(target, query) {
  return Boolean(target.matchMedia?.(query)?.matches);
}

export function inputCapabilities(target = globalThis) {
  const primaryCoarse = mediaMatches(target, '(pointer: coarse)');
  const anyCoarse = mediaMatches(target, '(any-pointer: coarse)');
  const primaryFine = mediaMatches(target, '(pointer: fine)');
  const anyFine = mediaMatches(target, '(any-pointer: fine)');
  const primaryHover = mediaMatches(target, '(hover: hover)');
  const anyHover = mediaMatches(target, '(any-hover: hover)');
  return {
    touch: (target.navigator?.maxTouchPoints ?? 0) > 0 || primaryCoarse || anyCoarse,
    primaryCoarse,
    fine: primaryFine || anyFine,
    hover: primaryHover || anyHover,
  };
}

export function readControlsMode(target = globalThis) {
  try {
    const mode = target.localStorage?.getItem(CONTROLS_MODE_KEY);
    return CONTROLS_MODES.has(mode) ? mode : 'auto';
  } catch {
    return 'auto';
  }
}

export function writeControlsMode(target = globalThis, mode = 'auto') {
  if (!CONTROLS_MODES.has(mode)) return false;
  try {
    const storage = target.localStorage;
    if (!storage) return false;
    if (mode === 'auto') storage.removeItem(CONTROLS_MODE_KEY);
    else storage.setItem(CONTROLS_MODE_KEY, mode);
    return true;
  } catch {
    return false;
  }
}

export function resolveControlsMode(
  target = globalThis,
  preference = readControlsMode(target),
  automaticDesktopLatch = false,
) {
  if (preference === 'touch' || preference === 'desktop') return preference;
  const queryMode = queryControlsMode(target);
  if (queryMode) return queryMode;
  if (automaticDesktopLatch) return 'desktop';
  const capabilities = inputCapabilities(target);
  if (mobilePlatform(target) === null) return 'desktop';
  return capabilities.touch
    && capabilities.primaryCoarse
    && !capabilities.fine
    && !capabilities.hover
    ? 'touch'
    : 'desktop';
}

export function shouldEnableMobileControls(target = globalThis) {
  return resolveControlsMode(target) === 'touch';
}

export function isTapGesture(durationMs, travelPx) {
  return Number.isFinite(durationMs)
    && Number.isFinite(travelPx)
    && durationMs >= 0
    && durationMs <= TAP_MAX_DURATION_MS
    && travelPx <= TAP_MAX_TRAVEL_PX;
}

export function actionIconUrl(texture) {
  if (typeof texture !== 'string' || texture.length === 0) return '';
  let path = texture.replaceAll('/', '\\');
  if (!path.toLowerCase().endsWith('.blp')) path += '.blp';
  return `/icon/${encodeURIComponent(path)}`;
}

export function setActionIcon(image, url, schedule = setTimeout) {
  if (image.mobileIconUrl === url) return;
  image.mobileIconUrl = url;
  image.hidden = !url;
  if (!url) return;
  let retries = 0;
  image.onerror = () => {
    if (image.mobileIconUrl !== url || retries >= 3) return;
    const attempt = ++retries;
    schedule(() => {
      if (image.mobileIconUrl === url) image.src = `${url}?retry=${attempt}`;
    }, attempt * 1000);
  };
  image.src = url;
}

export function mobileLayout(width, height) {
  const w = Number.isFinite(width) && width > 0 ? width : 800;
  const h = Number.isFinite(height) && height > 0 ? height : 600;
  const short = Math.min(w, h);
  const family = short < 600 ? 'phone' : 'tablet';
  return `${family}-${h >= w ? 'portrait' : 'landscape'}`;
}

export function mobileViewportLayout({ width = 800, height = 600, left = 0, top = 0,
  safe = {}, barBottom = 0, large = false } = {}) {
  const finite = (v, fallback = 0) => Number.isFinite(v) ? v : fallback;
  width = Math.max(1, finite(width, 800)); height = Math.max(1, finite(height, 600));
  left = finite(left); top = finite(top);
  const inset = side => Math.max(0, finite(safe[side]));
  const x = left + inset('left') + 8;
  const y = Math.max(top + inset('top') + 8, Math.min(finite(barBottom), top + inset('top') + 52) + 8);
  const w = Math.max(1, width - inset('left') - inset('right') - 16);
  const h = Math.max(1, top + height - inset('bottom') - 8 - y);
  const portrait = height >= width;
  const action = large ? 48 : 44;
  const stick = large ? 96 : 88;
  let columns = 6, gap = 2;
  if (portrait && columns * action + 5 * gap + stick + 6 > w) {
    if (columns * action + stick + 6 <= w) gap = 0;
    else columns = 4;
  }
  return { left: x, top: y, width: w, height: h, action, stick, portrait, columns, gap,
    shortLandscape: !portrait && w >= 500 && h < 300, utility: portrait && w < 324 ? 50 : 0,
    grid: columns * action + (columns - 1) * gap,
    dock: (12 / columns) * (action + gap) - gap, layout: mobileLayout(width, height) };
}

export function actionArcLayout({ left = 0, top = 0, width = 800, height = 400 } = {}) {
  const unit = Math.max(0.72, Math.min(1.25, height / 356));
  const primary = Math.round(64 * unit), skill = Math.max(44, Math.round(50 * unit));
  const utility = Math.max(34, Math.round(40 * unit));
  const inner = Math.max(Math.round(104 * unit), Math.ceil((skill + 4) / (2 * Math.sin(Math.PI / 12))));
  const outer = Math.round(inner + skill / 2 + utility / 2 + 18);
  const cx = left + width - primary / 2 - 4, cy = top + height - primary / 2 - 4;
  const at = (radius, degrees, size) => {
    const a = degrees * Math.PI / 180;
    return { x: Math.round(cx + radius * Math.cos(a) - size / 2), y: Math.round(cy - radius * Math.sin(a) - size / 2), size };
  };
  return {
    primary: { x: Math.round(cx - primary / 2), y: Math.round(cy - primary / 2), size: primary },
    skills: [180, 150, 120, 90].map(d => at(inner, d, skill)),
    jump: at(outer, 180, utility), target: at(outer, 150, utility),
    page: at(outer, 120, utility), stop: at(outer, 90, utility),
    reach: outer + utility / 2,
  };
}

export const ARC_SKILLS = 4;
export function arcPageSlots(page, total = 12) {
  const pages = Math.ceil((total - 1) / ARC_SKILLS);
  const p = ((page % pages) + pages) % pages;
  const first = 2 + p * ARC_SKILLS;
  return { page: p, pages, slots: Array.from({ length: ARC_SKILLS }, (_, i) => first + i).filter(s => s <= total) };
}

export function fitHudGroup(rect, safe, [dx, dy, scale]) {
  if (!rect.concat(safe, [dx, dy, scale]).every(Number.isFinite) || rect[2] <= 0 || rect[3] <= 0 || safe[2] <= 0 || safe[3] <= 0) return null;
  const width = rect[2] * scale, height = rect[3] * scale;
  if (width > safe[2] || height > safe[3] || scale  { selected = null; identity = ''; values.fill(0); };
  for (const event of ['blur', 'pagehide', 'gamepaddisconnected', 'keldurn:input-reset']) target.addEventListener?.(event, reset);
  return {
    reset,
    poll(enabled = true) {
      values.fill(0);
      if (!enabled || target.document?.hidden || target.document?.hasFocus?.() === false) { selected = null; identity = ''; return 0; }
      let pads;
      try { pads = target.navigator?.getGamepads?.() ?? []; } catch { return 0; }
let pad = selected === null ? null : pads[selected];
if (!pad?.connected || pad.mapping !== 'standard') pad = Array.from(pads).find(p => p?.connected && p.mapping === 'standard');
if (!pad) { selected = null; identity = ''; return 0; }
selected = pad.index;
const next = ${pad.index}:${pad.id};
if (next !== identity) { identity = next; generation = (generation + 1) >>> 0 || 1; }
values[0] = generation;
for (let i = 0; i < 4; i++) values[i + 1] = Number.isFinite(pad.axes[i]) ? Math.max(-1, Math.min(1, pad.axes[i])) : 0;
for (let i = 0; i < Math.min(17, pad.buttons.length); i++) {
if (pad.buttons[i]?.pressed || pad.buttons[i]?.value > 0.5) values[5] |= 1 << i;
}
return generation;
},
value(index) { return values[index] ?? 0; },
};
}
export function createMobileInputBridge(target = globalThis) {
const gamepad = createGamepadReader(target);
const generation = nextGeneration++ >>> 0;
let inWorldChanged = () => {};
let actionStateChanged = () => {};
let actionPageChanged = () => {};
let runStateChanged = () => {};
let hudProfileChanged = () => true;
let actionPromptsChanged = () => {};
let characterCreateChanged = () => {};
let characterCreating = false;
let pendingCharacterName = null;
let panelOpen = false;
let panelChanged = () => {};
let confirmationChanged = () => {};
let editorChanged = () => {};
let editorCompleted = () => {};
let pendingEditor = null;
let layoutRevision = 0, layoutSnapshot = '';
let interaction = {revision: 0, label: 'Interact', name: '', available: false};
let interactionChanged = () => {}, pendingInteraction = 0;
let group = null, groupChanged = () => {}, pendingGroup = null;
const state = {
enabled: false,
inWorld: false,
suspended: false,
moveX: 0,
moveY: 0,
lookX: 0,
lookY: 0,
lookActive: false,
zoomTotal: 0,
jumpSequence: 0,
actionSequence: 0,
actionSlot: 0,
quickSequence: 0,
quickCommand: 0,
worldTapSequence: 0,
worldTapX: 0,
worldTapY: 0,
chatOpenSequence: 0,
chatSubmitSequence: 0,
chatCancelSequence: 0,
chatText: '',
};
const resetContinuous = () => {
pendingInteraction = 0;
pendingGroup = null;
state.moveX = 0;
state.moveY = 0;
state.lookActive = false;
};
const controls = {
setGroupSink(change) { groupChanged = change; change(group); },
pressGroup(slot, revision) {
if (state.enabled && state.inWorld && !state.suspended && !panelOpen && group
&& revision === group[0] && Number.isInteger(slot) && slot >= 0 && slot <= 5
&& (slot === 5 || group[2][slot])) {
pendingGroup = JSON.stringify([revision, slot, state.actionSequence]);
}
},
setInteractionSink(change) { interactionChanged = change; change(interaction); },
pressInteraction() {
if (state.enabled && state.inWorld && !state.suspended && !panelOpen && interaction.available) pendingInteraction = interaction.revision;
},
setLayout(values) {
const next = JSON.stringify(values);
if (next !== layoutSnapshot) { layoutSnapshot = next; layoutRevision++; }
},
setEnabled(value) {
state.enabled = Boolean(value);
if (!state.enabled) { resetContinuous(); pendingEditor = null; editorChanged(null); }
},
setInWorld(value) {
if (state.inWorld === Boolean(value)) return;
state.inWorld = Boolean(value);
if (!state.inWorld) { resetContinuous(); pendingEditor = null; editorChanged(null); }
inWorldChanged(state.inWorld);
},
setSuspended(value) {
state.suspended = Boolean(value);
if (state.suspended) {
gamepad.reset();
resetContinuous();
if (pendingEditor !== null) { pendingEditor = null; editorCompleted(false); }
}
},
setInWorldSink(callback) {
inWorldChanged = typeof callback === 'function' ? callback : () => {};
inWorldChanged(state.inWorld);
},
setActionPromptsSink(callback) { actionPromptsChanged = callback; },
setActionPageSink(callback) { actionPageChanged = callback; },
setRunStateSink(callback) { runStateChanged = callback; },
setHudProfileSink(callback) { hudProfileChanged = callback; },
setActionStateSink(callback) {
actionStateChanged = typeof callback === 'function' ? callback : () => {};
},
setMove(x, y) {
if (state.suspended) return;
state.moveX = Math.max(-1, Math.min(1, Number(x) || 0));
state.moveY = Math.max(-1, Math.min(1, Number(y) || 0));
},
addLook(dx, dy) {
if (state.suspended) return;
if (Number.isFinite(dx)) state.lookX += dx;
if (Number.isFinite(dy)) state.lookY += dy;
},
addZoom(amount) {
if (state.suspended) return;
if (Number.isFinite(amount)) state.zoomTotal += amount;
},
setLookActive(value) {
state.lookActive = !state.suspended && Boolean(value);
},
pressJump() {
if (!state.suspended) state.jumpSequence = (state.jumpSequence + 1) >>> 0;
},
pressAction(slot) {
if (state.suspended) return;
if (!Number.isInteger(slot) || slot < 1 || slot > 12) return;
state.actionSlot = slot;
state.actionSequence = (state.actionSequence + 1) >>> 0;
},
pressQuick(command) {
if (state.suspended) return;
if (!Number.isInteger(command) || !((command >= 1 && command <= 13) || (command >= 16 && command <= 22))) return;
state.quickCommand = command;
state.quickSequence = (state.quickSequence + 1) >>> 0;
},
pressWorldTap(x, y) {
if (state.suspended) return;
if (!Number.isFinite(x) || !Number.isFinite(y)) return;
state.worldTapX = Math.max(0, Math.min(1, x));
state.worldTapY = Math.max(0, Math.min(1, y));
state.worldTapSequence = (state.worldTapSequence + 1) >>> 0;
},
openChat() {
if (!state.suspended) state.chatOpenSequence = (state.chatOpenSequence + 1) >>> 0;
},
submitChat(text) {
if (state.suspended) return;
if (typeof text !== 'string') return;
state.chatText = Array.from(text).slice(0, CHAT_MAX_CHARS).join('');
state.chatSubmitSequence = (state.chatSubmitSequence + 1) >>> 0;
},
cancelChat() {
if (!state.suspended) state.chatCancelSequence = (state.chatCancelSequence + 1) >>> 0;
},
resetContinuous,
setEditorSink(change, complete) { editorChanged = change; editorCompleted = complete; },
submitEditor(request) {
if (!state.enabled || !state.inWorld || state.suspended || pendingEditor !== null) return false;
if (!request || typeof request.session !== 'string' || !Number.isInteger(request.id)
|| typeof request.original !== 'string' || typeof request.text !== 'string'
|| !['apply', 'enter', 'next', 'cancel'].includes(request.action)) return false;
const encoded = JSON.stringify(request);
if (encoded.length > 100_000 || request.text.length > 16_384) return false;
pendingEditor = encoded;
resetContinuous();
return true;
},
};
const api = Object.freeze({
setGroup(text) {
if (typeof text !== 'string' || text.length > 2048) return;
let next = null;
if (text) {
try { next = JSON.parse(text); } catch { return; }
if (!Array.isArray(next) || next.length !== 3 || !Number.isInteger(next[0])
|| next[0] <= 0 || next[0] > 0xffffffff || !Number.isInteger(next[1]) || next[1] < 0 || next[1] > 9
|| !Array.isArray(next[2]) || next[2].length !== 5 || next[2].some(row => row !== null &&
(!Array.isArray(row) || row.length !== 5 || typeof row[0] !== 'string' || Array.from(row[0]).length > 18
|| !Number.isInteger(row[1]) || row[1] < 0 || row[1] > 100 || row.slice(2).some(v => typeof v !== 'boolean')))) return;
}
group = next; groupChanged(group);
if (!group) pendingGroup = null;
},
takeGroup() {
const value = pendingGroup; pendingGroup = null;
return state.enabled && state.inWorld && !state.suspended && !panelOpen ? value : null;
},
setInteraction(revision, label, name, available) {
if (!Number.isInteger(revision) || revision < 0 || revision > 0xffffffff) return;
interaction = {revision, label: String(label).slice(0, 30), name: String(name).slice(0, 120), available: Boolean(available)};
interactionChanged(interaction);
},
takeInteraction() {
const value = pendingInteraction; pendingInteraction = 0;
return state.enabled && state.inWorld && !state.suspended && !panelOpen ? value : 0;
},
setEditorState(value) {
let field = null;
try { field = value ? JSON.parse(value) : null; } catch { return; }
if (field && (typeof field.session !== 'string' || !Number.isInteger(field.id)
|| typeof field.text !== 'string')) return;
editorChanged(field);
},
takeEditorRequest() {
const request = pendingEditor; pendingEditor = null;
return state.enabled && state.inWorld && !state.suspended ? request : null;
},
editorResult(accepted) { editorCompleted(Boolean(accepted)); },
setConfirmationOpen(value) { confirmationChanged(Boolean(value)); },
setPanelOpen(value) {
const next = Boolean(value);
if (next === panelOpen) return;
panelOpen = next;
panelChanged(next);
},
setCharacterCreate(value) {
const next = Boolean(value);
if (next === characterCreating) return;
characterCreating = next;
pendingCharacterName = null;
characterCreateChanged(next);
},
takeCharacterName() {
const value = pendingCharacterName;
pendingCharacterName = null;
return state.enabled && characterCreating && !state.suspended ? value : null;
},
generation: () => generation,
layoutRevision: () => layoutRevision,
layoutSnapshot: () => layoutSnapshot,
layoutEnabled: () => state.enabled && state.inWorld,
setHudMode: mode => target.__keldurnMobileController?.setMode(mode === 'mobile' ? 'touch' : mode),
enabled: () => state.enabled && state.inWorld && !state.suspended,
moveX: () => state.moveX,
moveY: () => state.moveY,
lookX: () => state.lookX,
lookY: () => state.lookY,
lookActive: () => state.lookActive,
zoomTotal: () => state.zoomTotal,
jumpSequence: () => state.jumpSequence,
actionSequence: () => state.actionSequence,
actionSlot: () => state.actionSlot,
quickSequence: () => state.quickSequence,
quickCommand: () => state.quickCommand,
worldTapSequence: () => state.worldTapSequence,
worldTapX: () => state.worldTapX,
worldTapY: () => state.worldTapY,
chatOpenSequence: () => state.chatOpenSequence,
chatSubmitSequence: () => state.chatSubmitSequence,
chatCancelSequence: () => state.chatCancelSequence,
chatText: () => state.chatText,
setInWorld: (value) => controls.setInWorld(value),
pollGamepad: () => {
const root = target.document?.querySelector?.('#keldurn-mobile-controls');
const modal = root && ['quickOpen', 'chatOpen', 'textOpen'].some(key => root.dataset[key] === 'true');
const field = ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.document?.activeElement?.tagName);
return gamepad.poll(state.inWorld && !state.suspended && !modal && !field);
},
isPageHidden: () => Boolean(target.document?.hidden),
isMobileDevice: () => mobilePlatform(target) !== null,
gamepadValue: index => gamepad.value(index),
setActionPrompts: text => {
if (typeof text !== 'string' || text.length > 512) return;
try { const prompts = JSON.parse(text);
if (Array.isArray(prompts) && prompts.length === 12 && prompts.every(p => typeof p === 'string' && p.length <= 20)) actionPromptsChanged(prompts);
} catch {}
},
setActionPage: (page, latched) => actionPageChanged(page, Boolean(latched)),
setRunState: running => runStateChanged(Boolean(running)),
setHudProfile: text => {
if (typeof text !== 'string' || text.length > 2048) return false;
try { return hudProfileChanged(JSON.parse(text)); } catch { return false; }
},
setActionState: (button, texture, count, flags, cooldownRemainingMs, cooldownDurationMs) => {
if (!Number.isInteger(button) || button < 1 || button > 12) return;
actionStateChanged({
button,
texture: typeof texture === 'string' ? texture : '',
count: Number.isFinite(count) ? Math.max(0, Math.trunc(count)) : 0,
flags: Number.isFinite(flags) ? Math.trunc(flags) & 0xff : 0,
cooldownRemainingMs: Number.isFinite(cooldownRemainingMs)
? Math.max(0, cooldownRemainingMs) : 0,
cooldownDurationMs: Number.isFinite(cooldownDurationMs)
? Math.max(0, cooldownDurationMs) : 0,
});
},
});
controls.setCharacterCreateSink = callback => { characterCreateChanged = callback; };
controls.setPanelSink = callback => { panelChanged = callback; };
controls.setConfirmationSink = callback => { confirmationChanged = callback; };
controls.setCharacterName = text => {
if (typeof text === 'string' && state.enabled && characterCreating && !state.suspended) {
pendingCharacterName = text.replace(/[^a-z]/gi, '').slice(0, 12);
}
};
return { api, controls, state };
}
function directPointer(event, allowMouse) {
return event.pointerType !== 'mouse' || (allowMouse && event.button === 0);
}
function stopPointer(event) {
event.preventDefault();
}
function bindDrag(element, { start, move, end, tap, allowMouse }) {
let pointerId = null;
let previous = null;
let origin = null;
let startedAt = 0;
let maxTravel = 0;
let dragging = false;
const finish = (event) => {
if (pointerId === null || (event && event.pointerId !== pointerId)) return;
const point = event ? { x: event.clientX, y: event.clientY } : previous;
const duration = event ? event.timeStamp - startedAt : Number.POSITIVE_INFINITY;
const tapped = event?.type === 'pointerup'
&& tap
&& isTapGesture(duration, maxTravel);
pointerId = null;
previous = null;
origin = null;
dragging = false;
end();
if (tapped && point) tap(point);
if (event) stopPointer(event);
};
element.addEventListener('pointerdown', (event) => {
if (pointerId !== null || !directPointer(event, allowMouse)) return;
pointerId = event.pointerId;
previous = { x: event.clientX, y: event.clientY };
origin = previous;
startedAt = event.timeStamp;
maxTravel = 0;
dragging = !tap;
element.setPointerCapture?.(pointerId);
start(previous);
stopPointer(event);
});
element.addEventListener('pointermove', (event) => {
if (event.pointerId !== pointerId || !previous) return;
const current = { x: event.clientX, y: event.clientY };
maxTravel = Math.max(maxTravel, Math.hypot(current.x - origin.x, current.y - origin.y));
if (!dragging && maxTravel > TAP_MAX_TRAVEL_PX) {
dragging = true;
} else if (dragging) {
move(current, previous);
}
previous = current;
stopPointer(event);
});
element.addEventListener('pointerup', finish);
element.addEventListener('pointercancel', finish);
element.addEventListener('lostpointercapture', finish);
return () => finish();
}
export function bindLookGesture(element, { start, move, end, tap, zoom, allowMouse }) {
const pointers = new Map();
let primaryId = null;
let origin = null;
let previous = null;
let startedAt = 0;
let maxTravel = 0;
let dragging = false;
let pinching = false;
let pinchDistance = 0;
let tapAllowed = true;
const distance = () => {
const pair = Array.from(pointers.values());
return pair.length === 2 ? Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y) : 0;
};
const clear = () => {
const captured = [...pointers.keys()];
pointers.clear();
primaryId = null;
origin = null;
previous = null;
maxTravel = 0;
dragging = false;
pinching = false;
pinchDistance = 0;
tapAllowed = true;
end();
for (const id of captured) {
try { element.releasePointerCapture?.(id); } catch {}
}
};
const accepted = (event) => event.pointerType !== 'mouse'
|| (allowMouse && event.isPrimary !== false && event.button === 0);
element.addEventListener('pointerdown', (event) => {
if (!accepted(event) || pointers.size >= 2 || pointers.has(event.pointerId)) return;
if (dragging) {
stopPointer(event);
return;
}
const point = { x: event.clientX, y: event.clientY };
pointers.set(event.pointerId, point);
element.setPointerCapture?.(event.pointerId);
if (pointers.size === 1) {
primaryId = event.pointerId;
origin = point;
previous = point;
startedAt = event.timeStamp;
maxTravel = 0;
dragging = false;
pinching = false;
tapAllowed = true;
} else {
pinching = true;
tapAllowed = false;
dragging = false;
pinchDistance = distance();
end();
}
stopPointer(event);
});
element.addEventListener('pointermove', (event) => {
if (!pointers.has(event.pointerId)) return;
const current = { x: event.clientX, y: event.clientY };
pointers.set(event.pointerId, current);
if (pinching) {
const nextDistance = distance();
const amount = pinchZoomDelta(pinchDistance, nextDistance);
if (amount !== 0) zoom(amount);
pinchDistance = nextDistance;
} else if (event.pointerId === primaryId && previous) {
maxTravel = Math.max(maxTravel, Math.hypot(current.x - origin.x, current.y - origin.y));
if (!dragging && maxTravel > LOOK_SLOP_PX) {
dragging = true;
tapAllowed = false;
start(current);
const travel = Math.hypot(current.x - origin.x, current.y - origin.y);
const fraction = LOOK_SLOP_PX / travel;
move(current, { x: origin.x + (current.x - origin.x) * fraction,
y: origin.y + (current.y - origin.y) * fraction });
} else if (dragging) {
move(current, previous);
}
previous = current;
}
stopPointer(event);
});
const finish = (event) => {
if (!pointers.has(event.pointerId)) return;
const wasPrimary = event.pointerId === primaryId;
const wasPinching = pinching;
const point = { x: event.clientX, y: event.clientY };
if (origin) maxTravel = Math.max(maxTravel, Math.hypot(point.x - origin.x, point.y - origin.y));
pointers.delete(event.pointerId);
if (!wasPinching && wasPrimary) {
const duration = event.timeStamp - startedAt;
if (event.type === 'pointerup' && tapAllowed && maxTravel <= LOOK_SLOP_PX
&& isTapGesture(duration, maxTravel)) tap(point);
clear();
} else if (wasPinching && pointers.size === 1 && event.type === 'pointerup') {
[primaryId, previous] = pointers.entries().next().value;
origin = previous; maxTravel = 0; pinching = false; dragging = false;
tapAllowed = false; pinchDistance = 0;
} else if (event.type !== 'pointerup') {
clear();
} else if (pointers.size === 0) {
clear();
}
stopPointer(event);
};
element.addEventListener('pointerup', finish);
element.addEventListener('pointercancel', finish);
element.addEventListener('lostpointercapture', finish);
return clear;
}
const WORDS = {
en: { coachMove: 'Move: rest your thumb here', coachLook: 'Look: swipe · Zoom: pinch', coachOk: 'Got it',
rotate: 'Turn your phone sideways to play', chat: 'Chat', menu: 'Menu', camera: 'Play', panels: 'Panels', target: 'Target', jump: 'Jump', send: 'Send', stop: 'Cancel cast or targeting', quick: ['Character', 'Bags', 'Spellbook', 'Quests', 'Map', 'Social', 'Menu', 'Target', 'Controls', 'Cancel', 'Next window', 'Group', 'Talents', 'Downloads', 'Interact', 'Next bar', 'Previous bar', 'Gamepad', 'Edit HUD', 'Performance'] },
es: { coachMove: 'Mueve: apoya el pulgar aquí', coachLook: 'Mira: desliza · Zoom: pellizca', coachOk: 'Entendido',
rotate: 'Gira el teléfono para jugar', chat: 'Chat', menu: 'Menú', camera: 'Jugar', panels: 'Paneles', target: 'Objetivo', jump: 'Saltar', send: 'Enviar', stop: 'Cancelar lanzamiento o destino', quick: ['Personaje', 'Bolsas', 'Hechizos', 'Misiones', 'Mapa', 'Social', 'Menú', 'Objetivo', 'Controles', 'Cancelar', 'Otra ventana', 'Grupo', 'Talentos', 'Descargas', 'Interactuar', 'Siguiente barra', 'Barra anterior', 'Mando', 'Editar HUD', 'Rendimiento'] },
};
function mobileWords(target) {
const language = target.document?.querySelector?.('#bar-language')?.value
|| target.__keldurn_env?.locale || target.navigator?.language || 'en';
return WORDS[String(language).toLowerCase().startsWith('es') ? 'es' : 'en'];
}
function mobileMarkup(document) {
const root = document.createElement('div');
root.id = 'keldurn-mobile-controls';
root.dataset.inWorld = 'false';
root.dataset.chatOpen = 'false';
root.dataset.quickOpen = 'false';
root.dataset.interfaceMode = 'false';
root.innerHTML =  <div class="keldurn-mobile-group" data-mobile-group hidden></div> <button class="keldurn-mobile-interact" data-mobile-interact type="button" disabled>Interact</button> <div class="keldurn-mobile-quick" data-mobile-quick> <button class="keldurn-mobile-quick__toggle" data-mobile-quick-toggle type="button" aria-label="Quick access" aria-expanded="false">☰</button> <div class="keldurn-mobile-quick__panel" data-mobile-quick-panel hidden> <button data-mobile-chat type="button" aria-label="Open chat">Chat</button> </div> </div> <button class="keldurn-mobile-interface-mode" data-mobile-interface-mode type="button" aria-label="Interface controls">Panels</button> <form class="keldurn-mobile-composer" data-mobile-composer hidden> <input data-mobile-chat-input type="text" maxlength="${CHAT_MAX_CHARS}" enterkeyhint="send" autocomplete="off" autocapitalize="sentences" spellcheck="true" aria-label="Chat message"> <button data-mobile-chat-send type="submit">Send</button> <button data-mobile-chat-cancel type="button" aria-label="Cancel chat">×</button> </form> <div class="keldurn-mobile-stick" data-mobile-stick aria-label="Movement joystick"> <span class="keldurn-mobile-stick__ring"></span> <span class="keldurn-mobile-stick__thumb" data-mobile-stick-thumb></span> </div> <div class="keldurn-mobile-right"> <div class="keldurn-mobile-look" data-mobile-look aria-label="Camera control"> <span aria-hidden="true">◌</span> </div> <div class="keldurn-mobile-actions" data-mobile-actions></div> <button class="keldurn-mobile-target" data-mobile-target type="button" aria-label="Next enemy"><span aria-hidden="true">◎</span><small>Target</small></button> <button class="keldurn-mobile-layer" data-mobile-layer type="button" aria-label="Next action bar">Bar 1</button> <button class="keldurn-mobile-shift" data-mobile-shift type="button" aria-label="Use bar 2 for one action" aria-pressed="false">Shift</button> <button class="keldurn-mobile-page" data-mobile-page type="button" aria-label="Switch action page">1–6</button> <button class="keldurn-mobile-jump" data-mobile-jump type="button" aria-label="Jump">↑</button> <button class="keldurn-mobile-stop" data-mobile-stop type="button" aria-label="Cancel cast or targeting">×</button> </div>;
return root;
}
export function installMobileControls(target = globalThis) {
if (target.__keldurnMobileController) return target.__keldurnMobileController;
const bridge = createMobileInputBridge(target);
target.KeldurnMobileInput = bridge.api;
let preference = readControlsMode(target);
let automaticDesktopLatch = false;
const initialMode = resolveControlsMode(target, preference, automaticDesktopLatch);
bridge.controls.setEnabled(initialMode === 'touch');
bridge.controls.setSuspended(Boolean(target.document?.hidden));
const controller = {
enabled: initialMode === 'touch',
inputMode: initialMode,
mode: preference,
bridge,
root: null,
reset: bridge.controls.resetContinuous,
setMode: null,
setOverlayOpen(value) {
controller.reset();
bridge.controls.setSuspended(Boolean(value) || Boolean(target.document?.hidden));
},
};
bridge.controls.setInWorldSink(value => target.__keldurnMobileApp?.setInWorld(value));
const applyInputMode = () => {
const nextMode = resolveControlsMode(target, preference, automaticDesktopLatch);
const wasEnabled = controller.enabled;
controller.inputMode = nextMode;
controller.enabled = nextMode === 'touch';
bridge.controls.setEnabled(controller.enabled);
if (controller.root) {
controller.root.dataset.controlsEnabled = String(controller.enabled);
target.document.documentElement?.classList?.toggle('keldurn-touch', controller.enabled);
}
if (wasEnabled && !controller.enabled) controller.reset();
};
controller.setMode = (mode) => {
if (!CONTROLS_MODES.has(mode)) return false;
preference = mode;
automaticDesktopLatch = false;
controller.mode = mode;
writeControlsMode(target, mode);
applyInputMode();
return true;
};
target.__keldurnMobileController = controller;
const capabilities = inputCapabilities(target);
if (!target.document?.body) return controller;
const root = mobileMarkup(target.document);
controller.root = root;
let words = mobileWords(target);
root.querySelector('[data-mobile-chat]').textContent = words.chat;
root.querySelector('[data-mobile-quick-toggle]').textContent = '☰ ' + words.menu;
root.querySelector('[data-mobile-chat-send]').textContent = words.send;
root.querySelector('[data-mobile-interface-mode]').textContent = words.panels;
root.querySelector('[data-mobile-target]').setAttribute('aria-label', words.target);
root.querySelector('[data-mobile-target] small').textContent = words.target;
root.querySelector('[data-mobile-jump]').setAttribute('aria-label', words.jump);
target.document.documentElement?.classList?.toggle('keldurn-touch', controller.enabled);
root.dataset.controlsEnabled = String(controller.enabled);
let metrics = null;
let paintCoachWords = null;
let syncCoach = () => {};
let applyArc = () => {};
let reapplyHudProfile = () => {};
let layoutBeforeKeyboard = null;
const viewport = () => target.visualViewport
? { width: target.visualViewport.width, height: target.visualViewport.height }
: { width: target.innerWidth, height: target.innerHeight };
const updateLayout = () => {
const size = viewport();
root.style.setProperty('--keldurn-visual-height', ${Math.max(1, size.height || target.innerHeight || 1)}px);
root.style.setProperty('--keldurn-visual-top', ${Math.max(0, target.visualViewport?.offsetTop || 0)}px);
const composing = root.dataset.textOpen === 'true' || root.dataset.chatOpen === 'true'
|| target.document.activeElement?.id === 'keldurn-mobile-character-name';
if (composing && layoutBeforeKeyboard) return;
const style = target.getComputedStyle?.(root);
const canvas = target.document.querySelector?.('#keldurn')?.getBoundingClientRect?.();
const bar = target.document.querySelector?.('#bar')?.getBoundingClientRect?.();
const previousMetrics = metrics;
metrics = mobileViewportLayout({ ...size,
left: target.visualViewport?.offsetLeft || 0, top: target.visualViewport?.offsetTop || 0,
safe: { left: parseFloat(style?.paddingLeft) || 0, right: parseFloat(style?.paddingRight) || 0,
top: parseFloat(style?.paddingTop) || 0, bottom: parseFloat(style?.paddingBottom) || 0 },
barBottom: bar?.bottom || 0,
large: target.document.documentElement?.dataset?.keldurnLargeActions === 'true' });
if (previousMetrics && JSON.stringify(previousMetrics) !== JSON.stringify(metrics)) {
controller.cancelGestures?.();
}
layoutBeforeKeyboard = metrics;
root.dataset.layout = metrics.layout;
root.dataset.adaptive = 'true';
const choices = target.document.documentElement?.dataset ?? {};
root.dataset.hud = metrics.layout === 'phone-landscape' && choices.keldurnRightMovement !== 'true'
&& choices.keldurnFullBar !== 'true' ? 'arc' : 'grid';
root.dataset.shortLandscape = String(metrics.shortLandscape);
root.style.setProperty('--mobile-columns', String(metrics.columns));
for (const key of ['left', 'top', 'width', 'height', 'action', 'stick', 'dock', 'grid', 'gap', 'utility']) {
root.style.setProperty(--mobile-${key}, ${metrics[key]}px);
}
bridge.controls.setLayout([metrics.left - (canvas?.left || 0),
metrics.top - (canvas?.top || 0), metrics.width, metrics.height,
metrics.action, canvas?.height || size.height || 600]);
reapplyHudProfile();
applyArc();
syncCoach();
};
target.document.body.append(root);
updateLayout();
controller.updateLayout = updateLayout;
const characterName = target.document.createElement('input');
characterName.id = 'keldurn-mobile-character-name';
characterName.type = 'text';
characterName.maxLength = 12;
characterName.autocomplete = 'off';
characterName.spellcheck = false;
characterName.placeholder = words === WORDS.es ? 'Nombre del personaje' : 'Character name';
characterName.setAttribute('aria-label', characterName.placeholder);
characterName.setAttribute('enterkeyhint', 'done');
characterName.hidden = true;
characterName.addEventListener('input', () => {
if (characterName.composing) return;
characterName.value = characterName.value.replace(/[^a-z]/gi, '').slice(0, 12);
bridge.controls.setCharacterName(characterName.value);
});
characterName.addEventListener('compositionstart', () => { characterName.composing = true; });
characterName.addEventListener('compositionend', () => {
characterName.composing = false;
characterName.value = characterName.value.replace(/[^a-z]/gi, '').slice(0, 12);
bridge.controls.setCharacterName(characterName.value);
});
for (const type of ['keydown', 'keyup']) characterName.addEventListener(type, event => {
event.stopPropagation();
if (event.key === 'Enter') { event.preventDefault(); characterName.blur(); }
});
bridge.controls.setCharacterCreateSink(creating => {
characterName.hidden = !creating;
if (creating) characterName.value = '';
else characterName.blur();
});
target.document.body.append(characterName);
const profileElements = ['[data-mobile-stick]', '.keldurn-mobile-right', '[data-mobile-interact]'].map(selector => root.querySelector(selector));
let activeProfile = Array.from({length: 10}, () => [0, 0, 1]);
const applyHudProfile = profile => {
if (!Array.isArray(profile) || profile.length !== 10 || profile.some(t => !Array.isArray(t) || ![3,4].includes(t.length)
|| !t.every(Number.isFinite) || (t[3] ?? 1) < .4 || (t[3] ?? 1) > 1 || Math.abs(t[0]) > 1 || Math.abs(t[1]) > 1 || t[2] < .75 || t[2] > 1.5)) return false;
for (const element of profileElements) for (const property of ['left', 'top', 'transform', 'transform-origin', 'opacity']) element.style.removeProperty(property);
if (!metrics || !controller.enabled || !bridge.state.inWorld) return true;
const rect = element => {
const hidden = element.hidden;
const visibility = element.style.getPropertyValue?.('visibility') || '';
const priority = element.style.getPropertyPriority?.('visibility') || '';
if (hidden) { element.style.setProperty('visibility', 'hidden', 'important'); element.hidden = false; }
const r = element.getBoundingClientRect();
if (hidden) {
element.hidden = true;
if (visibility) element.style.setProperty('visibility', visibility, priority);
else element.style.removeProperty('visibility');
}
return [r.x ?? r.left, r.y ?? r.top, r.width, r.height];
};
const original = profileElements.map(rect);
const next = original.map((r, i) => fitHudGroup(r, [metrics.left, metrics.top, metrics.width, metrics.height], profile[i]));
if (next.some(r => r === null) || profile[0][2] * metrics.stick < 88
|| profile[1][2] * metrics.action < 44 || profile[2][2] * original[2][3] < 44) return false;
const locked = [...root.querySelectorAll('[data-mobile-quick-toggle],[data-mobile-interface-mode]')].map(rect);
const overlap = (a, b) => Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]) > .1
&& Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]) > .1;
if (next.some((r, i) => next.slice(i + 1).some(other => overlap(r, other)) || locked.some(other => overlap(r, other)))) return false;
for (let i = 0; i < profileElements.length; i++) {
if (i === 1 && root.dataset.hud === 'arc') continue;
const element = profileElements[i];
element.style.setProperty('left', ${next[i][0]}px, 'important');
element.style.setProperty('top', ${next[i][1]}px, 'important');
element.style.setProperty('transform-origin', '0 0', 'important');
element.style.setProperty('transform', scale(${profile[i][2]}), 'important');
element.style.setProperty('opacity', String(profile[i][3] ?? 1));
}
return true;
};
reapplyHudProfile = () => { if (!applyHudProfile(activeProfile)) applyHudProfile(Array.from({length: 10}, () => [0, 0, 1])); };
bridge.controls.setHudProfileSink(payload => {
const profile = Array.isArray(payload) ? payload : payload?.transforms;
const hand = payload?.rightMovement;
if (hand != null && typeof hand !== 'boolean') return false;
const doc = target.document.documentElement;
const previousHand = doc.dataset.keldurnRightMovement;
if (typeof hand === 'boolean') doc.dataset.keldurnRightMovement = String(hand);
const accepted = applyHudProfile(profile);
if (accepted) {
activeProfile = profile; controller.cancelGestures?.();
if (typeof hand === 'boolean') target.__keldurnMobileApp?.setHandedness?.(hand);
} else { doc.dataset.keldurnRightMovement = previousHand; reapplyHudProfile(); }
return accepted;
});
const composer = root.querySelector('[data-mobile-composer]');
const chatInput = root.querySelector('[data-mobile-chat-input]');
const openChat = () => {
resetGestures();
composer.hidden = false;
root.dataset.chatOpen = 'true';
chatInput.value = '';
try {
chatInput.focus({ preventScroll: true });
} catch {
chatInput.focus();
}
bridge.controls.openChat();
};
const closeChat = () => {
chatInput.blur();
chatInput.value = '';
composer.hidden = true;
root.dataset.chatOpen = 'false';
};
root.querySelector('[data-mobile-chat]').addEventListener('click', (event) => {
setQuickOpen(false);
openChat();
stopPointer(event);
});
composer.addEventListener('submit', (event) => {
event.preventDefault();
bridge.controls.submitChat(chatInput.value);
closeChat();
});
root.querySelector('[data-mobile-chat-cancel]').addEventListener('click', (event) => {
bridge.controls.cancelChat();
closeChat();
stopPointer(event);
});
chatInput.addEventListener('keydown', (event) => {
event.stopPropagation();
if (event.key !== 'Escape') return;
event.preventDefault();
bridge.controls.cancelChat();
closeChat();
});
chatInput.addEventListener('keyup', (event) => event.stopPropagation());
const quickToggle = root.querySelector('[data-mobile-quick-toggle]');
const quickPanel = root.querySelector('[data-mobile-quick-panel]');
const interfaceMode = root.querySelector('[data-mobile-interface-mode]');
let cancelLook = () => {};
const setQuickOpen = (open) => {
if (open) { controller.cancelGestures?.(); cancelLook(); bridge.controls.resetContinuous(); }
root.dataset.quickOpen = String(open);
quickPanel.hidden = !open;
quickToggle.setAttribute('aria-expanded', String(open));
};
const setInterfaceMode = (open) => {
root.dataset.interfaceMode = String(open);
interfaceMode.hidden = false;
interfaceMode.textContent = open ? words.camera : words.panels;
interfaceMode.setAttribute('aria-pressed', String(open));
if (open) {
cancelLook();
cancelStick();
bridge.controls.resetContinuous();
}
};
let nativePanelOpen = false, nativeConfirmationOpen = false;
const applyNativeHandoff = () => {
root.dataset.confirmationOpen = String(nativeConfirmationOpen);
root.dataset.panelOpen = String(nativePanelOpen && !nativeConfirmationOpen);
setInterfaceMode(nativePanelOpen && !nativeConfirmationOpen);
if (nativeConfirmationOpen) { cancelLook(); cancelStick(); bridge.controls.resetContinuous(); }
};
applyNativeHandoff();
bridge.controls.setConfirmationSink(open => { nativeConfirmationOpen = open; applyNativeHandoff(); });
bridge.controls.setPanelSink(open => { nativePanelOpen = open; applyNativeHandoff(); });
const textEntryActive = () => root.dataset.chatOpen === 'true' || root.dataset.textOpen === 'true'
|| target.document.activeElement?.matches?.('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
|| target.document.activeElement?.isContentEditable;
const preserveTextFocus = (event) => { if (textEntryActive()) event.preventDefault(); };
quickToggle.addEventListener('pointerdown', preserveTextFocus);
quickToggle.addEventListener('click', (event) => {
setQuickOpen(quickPanel.hidden);
stopPointer(event);
});
const quickButtons = [];
for (const [label, command] of QUICK_COMMANDS) {
const button = target.document.createElement('button');
button.type = 'button';
button.textContent = words.quick[command - 1] || (words === WORDS.es ? 'Correr/Parar' : 'Run/Stop');
if (command === 21) button.addEventListener('pointerdown', preserveTextFocus);
button.addEventListener('click', (event) => {
if (command === 21 && !textEntryActive()) {
const canvas = target.document.querySelector?.('#keldurn');
try { canvas?.focus?.({ preventScroll: true }); } catch { canvas?.focus?.(); }
}
bridge.controls.pressQuick(command);
setQuickOpen(false);
setInterfaceMode(![12,21,22].includes(command));
stopPointer(event);
});
quickPanel.append(button);
quickButtons.push([button, command]);
}
const localize = () => {
words = mobileWords(target);
paintCoachWords?.();
root.querySelector('[data-mobile-chat]').textContent = words.chat;
root.querySelector('[data-mobile-chat]').setAttribute('aria-label', words.chat);
quickToggle.textContent = '☰';
quickToggle.setAttribute('aria-label', words.menu);
root.querySelector('[data-mobile-chat-send]').textContent = words.send;
root.querySelector('[data-mobile-target] small').textContent = words.target;
root.querySelector('[data-mobile-target]').setAttribute('aria-label', words.target);
interfaceMode.textContent = root.dataset.interfaceMode === 'true' ? words.camera : words.panels;
root.querySelector('[data-mobile-stop]').setAttribute('aria-label', words.stop);
for (const [button, command] of quickButtons) {
const label = words.quick[command - 1] || (words === WORDS.es ? 'Correr/Parar' : 'Run/Stop');
button.textContent = label;
button.setAttribute('aria-label', label);
}
};
bridge.controls.setRunStateSink(running => {
const button = quickButtons.find(([, command]) => command === 21)?.[0];
if (button) {
button.textContent = words === WORDS.es ? (running ? 'Parar carrera' : 'Correr') : (running ? 'Stop running' : 'Auto run');
button.setAttribute('aria-pressed', String(running));
}
});
localize();
const language = target.document.querySelector?.('#bar-language');
language?.addEventListener?.('change', localize);
if (target.MutationObserver && target.document.documentElement) {
const observer = new target.MutationObserver(localize);
observer.observe(target.document.documentElement, { attributes: true, attributeFilter: ['lang'] });
}
const accountBar = target.document.querySelector?.('#bar');
if (accountBar) {
const mode = target.document.createElement('button');
mode.type = 'button';
mode.id = 'bar-touch';
mode.textContent = '☝';
mode.setAttribute('aria-label', 'Touch controls / Controles táctiles');
mode.setAttribute('aria-pressed', String(controller.enabled));
mode.addEventListener('click', () => {
controller.setMode(controller.enabled ? 'desktop' : 'touch');
mode.setAttribute('aria-pressed', String(controller.enabled));
});
accountBar.append(mode);
}
interfaceMode.addEventListener('pointerdown', (event) => {
if (!directPointer(event, forced)) return;
setInterfaceMode(root.dataset.interfaceMode !== 'true');
stopPointer(event);
});
const stick = root.querySelector('[data-mobile-stick]');
const groupStrip = root.querySelector('[data-mobile-group]');
let groupView = null;
const groupButtons = Array.from({length: 6}, (_, slot) => {
const button = target.document.createElement('button'); button.type = 'button';
button.addEventListener('pointerdown', event => {
if (!directPointer(event, forced) || !groupView) return;
bridge.controls.pressGroup(slot, groupView[0]); stopPointer(event);
});
groupStrip.append(button); return button;
});
bridge.controls.setGroupSink(view => {
groupView = view; groupStrip.hidden = !view;
if (!view) return;
const es = target.document?.documentElement?.lang?.startsWith('es');
groupButtons.forEach((button, slot) => {
const row = view[2][slot];
button.disabled = slot < 5 && !row;
button.textContent = slot === 5 ? ${es ? 'Grupo' : 'Group'} ${view[1] + 1} ›
: !row ? '—' : ${row[0]}\n${!row[3] ? (es ? 'Sin conexión' : 'Offline') : row[2] ? (es ? 'Muerto' : 'Dead') : row[1] + '%'};
button.dataset.selected = String(Boolean(row?.[4]));
button.style.setProperty('--health', ${row?.[3] && !row?.[2] ? row[1] : 0}%);
button.setAttribute('aria-label', button.textContent);
});
});
const interact = root.querySelector('[data-mobile-interact]');
bridge.controls.setInteractionSink(value => {
const es = target.document?.documentElement?.lang?.startsWith('es');
const verbs = {Interact: 'Interactuar', Mine: 'Minar', Harvest: 'Recolectar', Skin: 'Desollar', Loot: 'Saquear', Talk: 'Hablar', Trade: 'Comerciar', Mail: 'Correo', Read: 'Leer'};
const verb = es ? (verbs[value.label] || value.label) : value.label;
interact.textContent = verb + (value.name ? '\n' + value.name : '');
interact.disabled = !value.available;
interact.hidden = !value.available;
interact.setAttribute('aria-label', verb + (value.name ? ': ' + value.name : ''));
});
interact.addEventListener('pointerdown', event => {
if (!directPointer(event, forced)) return;
bridge.controls.pressInteraction(); stopPointer(event);
});
const thumb = root.querySelector('[data-mobile-stick-thumb]');
const COACH_KEY = 'keldurn:mobile-coach:v1';
const make = (tag, className) => {
const element = target.document.createElement(tag);
if (className) element.className = className;
return element;
};
const coach = make('div', 'keldurn-mobile-coach');
coach.hidden = true;
const coachLabels = ['keldurn-mobile-coach__move', 'keldurn-mobile-coach__look'].map((className) => {
const hint = make('div', className), label = make('b');
hint.append(make('i'), label);
coach.append(hint);
return label;
});
const coachButton = make('button');
coachButton.type = 'button';
coach.append(coachButton);
const rotateHint = make('div', 'keldurn-mobile-rotate');
rotateHint.setAttribute('role', 'status');
root.append(coach, rotateHint);
paintCoachWords = () => {
coachLabels[0].textContent = words.coachMove;
coachLabels[1].textContent = words.coachLook;
coachButton.textContent = words.coachOk;
rotateHint.textContent = words.rotate;
};
paintCoachWords();
let coachSeen = false;
try { coachSeen = target.localStorage?.getItem(COACH_KEY) === '1'; } catch {}
const coachDone = { moved: false, looked: false };
const finishCoach = () => {
coach.hidden = true;
if (coachSeen) return;
coachSeen = true;
try { target.localStorage?.setItem(COACH_KEY, '1'); } catch {}
};
function noteCoach(kind) {
coachDone[kind] = true;
coach.dataset[kind] = 'true';
if (coachDone.moved && coachDone.looked) finishCoach();
}
syncCoach = () => {
coach.hidden = coachSeen || root.dataset.hud !== 'arc' || root.dataset.inWorld !== 'true';
};
coachButton.addEventListener('pointerdown', (event) => {
if (!directPointer(event, true)) return;
finishCoach(); stopPointer(event);
});
let floatCenter = null;
const stickCenter = () => {
const box = stick.getBoundingClientRect();
if (floatCenter) return { ...floatCenter, radius: box.width * 0.36 };
return { x: box.left + box.width / 2, y: box.top + box.height / 2, radius: box.width * 0.36 };
};
const moveStick = (point) => {
const center = stickCenter();
const rawX = point.x - center.x;
const rawY = point.y - center.y;
const length = Math.hypot(rawX, rawY) || 1;
const scale = Math.min(1, center.radius / length);
thumb.style.transform = translate(${rawX * scale}px, ${rawY * scale}px);
const value = normalizeStick(rawX, rawY, center.radius);
bridge.controls.setMove(value.x, -value.y);
if (value.x || value.y) noteCoach('moved');
};
const releaseStick = () => {
thumb.style.transform = 'translate(0px, 0px)';
bridge.controls.setMove(0, 0);
};
const cancelFixedStick = bindDrag(stick, {
start: moveStick,
move: (current) => moveStick(current),
end: releaseStick,
allowMouse: forced,
});
const stickZone = target.document.createElement('div');
stickZone.className = 'keldurn-mobile-stick-zone';
stickZone.setAttribute('aria-hidden', 'true');
root.append(stickZone);
const cancelFloatingStick = bindDrag(stickZone, {
start: (point) => {
floatCenter = { x: point.x, y: point.y };
stick.dataset.floating = 'true';
const half = (metrics?.stick ?? 88) / 2;
stick.style.setProperty('left', ${point.x - half}px, 'important');
stick.style.setProperty('top', ${point.y - half}px, 'important');
stick.style.setProperty('transform', 'none', 'important');
moveStick(point);
},
move: (current) => moveStick(current),
end: () => {
floatCenter = null; delete stick.dataset.floating; releaseStick();
for (const property of ['left', 'top', 'transform']) stick.style.removeProperty(property);
reapplyHudProfile();
},
allowMouse: forced,
});
const cancelStick = () => { cancelFixedStick(); cancelFloatingStick(); };
const look = root.querySelector('[data-mobile-look]');
root.append(look);
cancelLook = bindLookGesture(look, {
start: () => bridge.controls.setLookActive(true),
move: (current, previous) => {
const delta = mobileLookDelta(current.x - previous.x, current.y - previous.y,
metrics && Math.min(metrics.width, metrics.height));
bridge.controls.addLook(delta.x, delta.y);
noteCoach('looked');
},
end: () => bridge.controls.setLookActive(false),
tap: (point) => {
const normalized = normalizedCanvasPoint(target, point);
if (normalized) bridge.controls.pressWorldTap(normalized.x, normalized.y);
},
zoom: bridge.controls.addZoom,
allowMouse: forced,
});
