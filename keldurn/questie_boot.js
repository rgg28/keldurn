// Questie itself stays in a separately prepared, attributed package, never in the game binary.
export const QUESTIE_SOURCE_SHA256 = '6951db68977c9e759ee79ace2f165ab2f84b9994c18f9c5fbf47e09841cdae1d';
const MAX_BYTES = 32 * 1024 * 1024;
const DOWNLOAD_MS = 20000;

// Three requests at most, all inside the original entry deadline. Invalid packages and access
// failures are permanent; a transient request failure must not leave the catalog stub installed.
export function questieRetryDelay(failures, elapsedMs) {
  const delay = [250, 750][failures - 1];
  return Number.isFinite(elapsedMs) && elapsedMs >= 0 && delay !== undefined
    && elapsedMs + delay < DOWNLOAD_MS ? delay : null;
}

function requestFailure(status) {
  const error = new Error(status === undefined ? 'Questie request failed' : `Questie could not load (${status})`);
  error.retryable = status === undefined || [408, 500, 502, 503, 504].includes(status);
  return error;
}

export async function prepareQuestie({ fetchImpl = fetch, url = './addons/questie.json', signal } = {}) {
  let response;
  try { response = await fetchImpl(url, { credentials: 'same-origin', signal }); }
  catch (error) { throw signal?.aborted || error?.name === 'AbortError' ? error : requestFailure(); }
  if (!response.ok) throw requestFailure(response.status);
  let text;
  try { text = await response.text(); }
  catch (error) { throw signal?.aborted || error?.name === 'AbortError' ? error : requestFailure(); }
  if (text.length > MAX_BYTES * 1.5) throw new Error('Questie package exceeds its size limit');
  const pack = JSON.parse(text);
  if (pack.schema !== 1 || pack.sourceSha256 !== QUESTIE_SOURCE_SHA256 ||
      pack.version !== '3.7.1-keldurn.4' || !Array.isArray(pack.files) || pack.files.length > 4096) {
    throw new Error('Questie package does not match this Keldurn release');
  }
  const files = new Map();
  const normalized = new Set();
  let size = 0;
  for (const [path, base64] of pack.files) {
    if (typeof path !== 'string' || typeof base64 !== 'string' ||
        !path.startsWith('!Questie/') || path.includes('\\') ||
        path.split('/').some(p => !p || p === '.' || p === '..' || p.includes(':'))) {
      throw new Error('Invalid Questie package path');
    }
    const key = path.toLowerCase();
    if (normalized.has(key)) throw new Error('Duplicate Questie package path');
    normalized.add(key);
    const binary = atob(base64);
    size += binary.length;
    if (size > MAX_BYTES) throw new Error('Questie package exceeds its size limit');
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    files.set(path, bytes);
  }
  if (!normalized.has('!questie/!questie.toc')) throw new Error('Questie manifest is missing');
  return files;
}

function withQuestHistory(files, history) {
  if (!Array.isArray(history) || history.length > 100) throw new Error('Invalid quest history');
  const names = new Set();
  let count = 0;
  const rows = history.map(row => {
    if (!row || typeof row.name !== 'string' || !row.name || row.name.length > 32 ||
        names.has(row.name) || !Array.isArray(row.completed_quests) ||
        row.completed_quests.some(id => !Number.isSafeInteger(id) || id <= 0 || id > 0xffffffff)) {
      throw new Error('Invalid quest history');
    }
    names.add(row.name);
    count += row.completed_quests.length;
    if (count > 100000) throw new Error('Quest history exceeds its size limit');
    // Decimal byte escapes preserve UTF-8 character names without allowing executable Lua.
    const name = '"' + Array.from(new TextEncoder().encode(row.name), b => '\\' + String(b).padStart(3, '0')).join('') + '"';
    return `[${name}]={${[...new Set(row.completed_quests)].join(',')}}`;
  });
  const source = `-- Keldurn-owned bridge from the authenticated account's server history.
local histories={${rows.join(',')}}
local frame=CreateFrame("Frame")
frame:RegisterEvent("PLAYER_LOGIN")
frame:SetScript("OnEvent",function()
  local ids=histories[UnitName("player")]
  KeldurnInitialCompletedQuestIds={}
  if not ids then return end
  QuestieSeenQuests=QuestieSeenQuests or {}
  QuestieCachedQuests=QuestieCachedQuests or {}
  local active={}
  for _,id in ipairs(KeldurnGetQuestLogActiveIds()) do active[id]=true end
  for _,id in ipairs(ids) do
    KeldurnInitialCompletedQuestIds[id]=true
    local hash=KeldurnQuestieHashById[id]
    if hash and not active[id] then QuestieSeenQuests[hash]=1; QuestieCachedQuests[hash]=nil end
  end
  Questie:AddEvent("CHECKLOG",0)
  Questie:AddEvent("DRAWNOTES",0.05)
end)
`;
  const mounted = new Map(files);
  const toc = [...mounted.keys()].find(path => path.toLowerCase() === '!questie/!questie.toc');
  if (!toc) throw new Error('Questie manifest is missing');
  const encoder = new TextEncoder();
  const original = mounted.get(toc);
  const suffix = encoder.encode('\nKeldurnHistory.lua\n');
  const manifest = new Uint8Array(original.length + suffix.length);
  manifest.set(original); manifest.set(suffix, original.length);
  mounted.set(toc, manifest);
  mounted.set('!Questie/KeldurnHistory.lua', encoder.encode(source));
  return mounted;
}

export function mountQuestie(files, target = window, history = []) {
  if (!(target.__keldurn_data_cache instanceof Map)) {
    throw new Error('Game data must be prepared before Questie');
  }
  files = withQuestHistory(files, history);
  target.__keldurn_addon_files = files;
  target.__keldurn_addon_revision = (target.__keldurn_addon_revision || 0) + 1;
  // The canonical texture decoder reads the same bytes as Lua's SetTexture probe. Every asset
  // is present before Wasm starts; no synchronous request is introduced while playing.
  for (const [path, bytes] of files) {
    if (!/\.(blp|tga|m2|mdx)$/i.test(path)) continue;
    const name = `interface\\addons\\${path.replaceAll('/', '\\')}`.toLowerCase();
    const url = `${target.location.origin}/data/${encodeURIComponent(name)}`;
    target.__keldurn_data_cache.set(url, bytes);
  }
  // Extensionless texture names probe both formats. Cache the absent alternate too so a
  // packaged TGA never causes a synchronous BLP request during an addon frame update.
  for (const [path] of files) {
    if (!/\.(blp|tga)$/i.test(path)) continue;
    const stem = `interface\\addons\\${path.replaceAll('/', '\\')}`.toLowerCase().slice(0, -4);
    for (const extension of ['.blp', '.tga']) {
      const url = `${target.location.origin}/data/${encodeURIComponent(stem + extension)}`;
      if (!target.__keldurn_data_cache.has(url)) target.__keldurn_data_cache.set(url, null);
    }
  }
}

// Only a tiny catalog entry is needed on character selection. The engine decides whether the
// selected character enabled Questie; downloading and decoding stay outside the render loop.
export function installLazyQuestie(target = window, history = [], {
  prepare = prepareQuestie, now = () => performance.now(),
  later = setTimeout, cancel = clearTimeout,
} = {}) {
  const stub = '## Interface: 11200\n## Title: Questie\n## Dependencies: KeldurnQuestiePackage\n';
  target.__keldurn_addon_files = new Map([['!Questie/!Questie.toc', new TextEncoder().encode(stub)]]);
  target.__keldurn_addon_revision = 1;
  let state = 'idle';
  target.__keldurn_prepare_addons = enabled => {
    if (!enabled) {
      if (state === 'failed') state = 'idle';
      return true;
    }
    if (state === 'ready' || state === 'failed') return true;
    if (state === 'idle') {
      state = 'loading';
      const controller = new AbortController();
      const started = now();
      const timeout = later(() => controller.abort(), DOWNLOAD_MS);
      const download = async () => {
        for (let failures = 1; ; failures++) {
          if (controller.signal.aborted || now() - started >= DOWNLOAD_MS) {
            throw new Error('Questie request deadline expired');
          }
          try {
            const files = await prepare({ signal: controller.signal });
            if (controller.signal.aborted || now() - started >= DOWNLOAD_MS) {
              throw new Error('Questie request deadline expired');
            }
            return files;
          }
          catch (error) {
            const delay = questieRetryDelay(failures, now() - started);
            if (error?.retryable !== true || controller.signal.aborted || delay === null) throw error;
            await new Promise((resolve, reject) => {
              let timer;
              const aborted = () => { cancel(timer); reject(error); };
              controller.signal.addEventListener('abort', aborted, {once:true});
              timer = later(() => {
                controller.signal.removeEventListener('abort', aborted);
                resolve();
              }, delay);
              if (controller.signal.aborted) aborted();
            });
          }
        }
      };
      Promise.resolve().then(download).then(files => {
        mountQuestie(files, target, history);
        state = 'ready';
      }).catch(error => {
        state = 'failed';
        target.console?.warn('Questie could not load; the game remains available.', error);
      }).finally(() => cancel(timeout));
    }
    return false;
  };
}
