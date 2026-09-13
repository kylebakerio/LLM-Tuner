// Pure launch-config helpers shared by Launch mode, cli.js and the tests (no
// ink/React imports -- `profile list` and the unit tests load this directly).
//
// Two shapes live here:
//   launch config -- exactly what /api/start, /api/preview-command and
//                    /api/profiles take (the dashboard's launchConfig keys)
//   draft         -- the Launch form's state: the launch config PLUS the
//                    UI-only RPC switch (rpcEnabled) and worker host
//                    (workerHost), which collapse into `rpcTarget` on the way
//                    out (host when on, '' when off) and expand back from it
//                    on the way in (non-empty rpcTarget => RPC on).

// Every launch-config key, in form order -- the draft shape minus the two
// UI-only keys. null = unset (the server's toFiniteNumber/toNonEmptyString
// skip both null and ''), false for toggles.
export const DEFAULT_CONFIG = {
  modelPath: '', build: '', ctx: 8192, ngl: 99, port: 8080,
  deviceA: null, deviceB: null, tensorSplit: 50, rpcTarget: '', transport: null,
  fa: false, cacheK: '', cacheV: '',
  specType: '', specDraftNMax: null, specDraftNMin: null, specDraftModel: '',
  specDraftNgl: null, specNgramSizeN: null, specNgramSizeM: null, specNgramMinHits: null,
  nCpuMoe: null,
  temp: null, topK: null, topP: null, minP: null, presencePenalty: null, repeatPenalty: null,
  jinja: false, reasoningPreserve: false, chatTemplateFile: '',
  // verbosity defaults to 3, same as the web field: below 3 llama-server
  // suppresses the log lines the dashboard's status detection parses.
  mmprojEnabled: false, mmprojPath: '', mmprojOffload: true, loadMode: '', verbosity: 3,
  argString: '',
};

// The draft adds the RPC switch + host. transport defaults to WiFi in the
// draft (the web select's first option) but is only SENT while RPC is on.
export const DEFAULT_DRAFT = { ...DEFAULT_CONFIG, rpcEnabled: false, workerHost: '', transport: 'WiFi' };

// Keys the CLI accepts from / sends to the server. Legacy `preserveThinking`
// is still honored by buildLlamaArgs, so it's carried through even though
// the form has no field for it. Everything else -- notably the web's
// `rawCommand` (which /api/start would run VERBATIM, ignoring every field
// here), `model`, `launchMode` -- is dropped.
export const DRAFT_KEYS = [...Object.keys(DEFAULT_CONFIG), 'preserveThinking'];

export const TRANSPORTS = [
  ['WiFi', 'Wi-Fi / LAN'],
  ['TB4', 'Thunderbolt 4'],
  ['WAN', 'remote / over the internet'],
];

export const VERBOSITY_MIN = 3;

// Keep only DRAFT_KEYS (drops rawCommand and any other unknown key).
export function sanitizeConfig(cfg) {
  const out = {};
  if (!cfg || typeof cfg !== 'object') return out;
  for (const k of DRAFT_KEYS) {
    if (cfg[k] !== undefined) out[k] = cfg[k];
  }
  return out;
}

// Clamp a stored verbosity up to the floor (a config saved when the default
// was 0 would otherwise launch a server the dashboard can't parse). Unset
// becomes the floor too, matching the web's restore.
export function clampVerbosity(v) {
  const n = Number(v);
  return v != null && v !== '' && Number.isFinite(n) && n >= VERBOSITY_MIN ? n : VERBOSITY_MIN;
}

// launch config (profile / running launchConfig) -> draft.
//   base      -- draft to start from (DEFAULT_DRAFT for a REPLACE load, the
//                current draft for the prefill merge)
//   skipEmpty -- don't copy null/'' values over base (prefill semantics)
export function configToDraft(cfg, base = DEFAULT_DRAFT, { skipEmpty = false } = {}) {
  const clean = sanitizeConfig(cfg);
  const next = { ...base };
  for (const [k, v] of Object.entries(clean)) {
    if (skipEmpty && (v === null || v === '')) continue;
    next[k] = v;
  }
  const target = typeof clean.rpcTarget === 'string' ? clean.rpcTarget.trim() : '';
  next.rpcEnabled = !!target;
  if (target) {
    next.workerHost = target;
    // The split is exactly 2-way (local GPU A vs the worker): GPU B can't
    // coexist with RPC.
    next.deviceB = null;
  }
  // transport is null in a local config -- keep the draft's pick so turning
  // RPC on later doesn't land on an empty list value.
  if (!next.transport) next.transport = base.transport || DEFAULT_DRAFT.transport;
  next.rpcTarget = target;
  next.verbosity = clampVerbosity(next.verbosity);
  return next;
}

// draft -> launch config for /api/start, /api/preview-command and profile
// saves. The only path out of the form: never carries rawCommand or the
// UI-only keys.
export function draftToConfig(draft) {
  const d = draft || {};
  const rpc = !!d.rpcEnabled;
  const out = sanitizeConfig(d);
  out.rpcTarget = rpc ? String(d.workerHost || '').trim() : '';
  out.transport = rpc ? (d.transport || DEFAULT_DRAFT.transport) : null;
  if (rpc) out.deviceB = null;
  // A blanked verbosity field is null in the draft -- the server would omit
  // -lv entirely, so enforce the floor on the way out too.
  out.verbosity = clampVerbosity(out.verbosity);
  return out;
}

// Row labels that depend on whether the second compute target is a local
// GPU or the RPC worker (web: updateTensorSplitVisibility).
export function nodeLabels(rpcEnabled) {
  return rpcEnabled ? { a: 'Local', b: 'Worker' } : { a: 'GPU A', b: 'GPU B' };
}

// "Local 60% / Worker 40%" -- tensorSplit is the FIRST (local) node's share.
export function splitText(draft) {
  const v = draft && draft.tensorSplit;
  if (v == null || !Number.isFinite(Number(v))) return null;
  const { a, b } = nodeLabels(draft.rpcEnabled);
  const n = Number(v);
  return `${a} ${n}% / ${b} ${100 - n}%`;
}

// "RPC" when the profile targets a worker, else "Local" (web profile dropdown).
export function profileTag(cfg) {
  return cfg && typeof cfg.rpcTarget === 'string' && cfg.rpcTarget.trim() ? 'RPC' : 'Local';
}

// Server profiles doc ({ name: { config, savedAt, lastLoadedAt } }) -> an
// array sorted most-recently-used first; a never-loaded profile falls back to
// its save time (same order as the web dropdown).
export function sortProfileEntries(profiles) {
  return Object.entries(profiles || {})
    .map(([name, e]) => ({
      name,
      config: e && e.config ? e.config : (e || {}),
      savedAt: (e && e.savedAt) || 0,
      lastLoadedAt: (e && e.lastLoadedAt) || 0,
    }))
    .sort((a, b) => (b.lastLoadedAt || b.savedAt) - (a.lastLoadedAt || a.savedAt) || a.name.localeCompare(b.name));
}
