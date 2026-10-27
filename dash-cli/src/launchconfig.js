// Pure launch-config helpers shared by Launch mode, cli.js and the tests (no
// ink/React imports -- `profile list` and the unit tests load this directly).
//
// Two shapes live here:
//   launch config -- exactly what /api/start, /api/preview-command and
//                    /api/profiles take (the dashboard's launchConfig keys)
//   draft         -- the Launch form's state: the same keys, with `devices`
//                    holding EVERY row the editor shows (enabled or not) and
//                    `transport` kept even while no worker row is enabled.
//
// Devices (HETERO-DEVICES-PLAN.md; the server's lib/devices.js) are an
// ordered list -- list order is -dev order is -ts order:
//   local  { id, name?, vramMib?, share?, enabled? }
//                                           id a llama.cpp device (<backend><n>: Vulkan1),
//                                           name the card, so a profile survives ids shifting;
//                                           vramMib its size, which is what lets the server
//                                           offer a stand-in card on a machine without it
//   worker { worker, share?, enabled? }     worker an rpcWorkers name; its RPC<n> id
//                                           is assigned by the server, never stored
// Older configs carry deviceA/deviceB/rpcTarget/tensorSplit instead. They're
// converted on the way in -- preferably by the server's preview, which also
// re-points ids whose card moved (convertLegacyConfig) -- and never sent.

import { gpuKey, shortGpuName } from './format.js';

// Every launch-config key, in form order. null = unset (the server's
// toFiniteNumber/toNonEmptyString skip both null and ''), false for toggles.
export const DEFAULT_CONFIG = {
  modelPath: '', build: '', ctx: 8192, ngl: 99, port: 8080,
  devices: [], transport: null,
  fa: false, cacheK: '', cacheV: '',
  specType: '', specDraftNMax: null, specDraftNMin: null, specDraftModel: '',
  specDraftNgl: null, specDraftDevice: '', specNgramSizeN: null, specNgramSizeM: null, specNgramMinHits: null,
  nCpuMoe: null,
  temp: null, topK: null, topP: null, minP: null, presencePenalty: null, repeatPenalty: null,
  jinja: false, reasoningPreserve: false, chatTemplateFile: '',
  // verbosity defaults to 3, same as the web field: below 3 llama-server
  // suppresses the log lines the dashboard's status detection parses.
  // mmprojOffload false = projector in system RAM, the default in both clients
  // (true = VRAM, llama.cpp's own default).
  mmprojEnabled: false, mmprojPath: '', mmprojOffload: false, loadMode: '', verbosity: 3,
  argString: '',
};

// transport defaults to WiFi in the draft (the web select's first option) but
// is only SENT while a worker row is enabled.
export const DEFAULT_DRAFT = { ...DEFAULT_CONFIG, transport: 'WiFi' };

// Keys the CLI sends. Legacy `preserveThinking` is still honored by
// buildLlamaArgs, so it's carried through even though the form has no field
// for it. `tuningNote` is a profile's free-text note (the web profile picker
// and Launch's profile list show it) and `needs` its declared hardware
// requirements ({ hostRamMib, minCards, minVramMib, vendor } -- the server's
// availability check reads them): no flag reads either, they ride along so
// editing and re-saving a profile here doesn't lose them. `splitMode` is the
// server's field for how a multi-device launch is divided (see "split mode"
// below); it is sent only when a config carries it, so a server from before
// the field never sees it.
export const DRAFT_KEYS = [...Object.keys(DEFAULT_CONFIG), 'preserveThinking', 'tuningNote', 'needs', 'splitMode'];

// The older two-device fields: read from saved/running configs (and kept
// when a profile is copied verbatim), converted into `devices`, never sent.
export const LEGACY_DEVICE_KEYS = ['deviceA', 'deviceB', 'tensorSplit', 'rpcTarget'];

export const TRANSPORTS = [
  ['WiFi', 'Wi-Fi / LAN'],
  ['TB4', 'Thunderbolt 4'],
  ['WAN', 'remote / over the internet'],
];

export const VERBOSITY_MIN = 3;

const RPC_ID_RE = /^RPC\d+$/;
const LOCAL_ID_RE = /^[A-Za-z]+\d+$/;

// Keep only known keys: DRAFT_KEYS plus the legacy device fields (needed to
// convert, and to copy a web profile intact). Everything else -- notably the
// web's `rawCommand`, which /api/start would run VERBATIM, ignoring every
// field here -- is dropped.
export function sanitizeConfig(cfg) {
  const out = {};
  if (!cfg || typeof cfg !== 'object') return out;
  for (const k of [...DRAFT_KEYS, ...LEGACY_DEVICE_KEYS]) {
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

function finiteShare(v) {
  if (v === null || v === undefined || v === '' || typeof v === 'boolean') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// Normalize a devices list: a local entry needs a (non-RPC) device id, a
// worker entry a worker name; share is a finite >= 0 number or null; enabled
// defaults to true; a local entry keeps its card's size (vramMib) when it has
// one. Anything else is dropped. Always returns new objects.
export function sanitizeDevices(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const d of list) {
    if (!d || typeof d !== 'object') continue;
    const worker = typeof d.worker === 'string' ? d.worker.trim() : '';
    const id = typeof d.id === 'string' ? d.id.trim() : '';
    let entry;
    if (worker) {
      entry = { worker };
    } else if (id && LOCAL_ID_RE.test(id) && !RPC_ID_RE.test(id)) {
      entry = { id };
      if (typeof d.name === 'string' && d.name.trim()) entry.name = d.name.trim();
      const vram = Number(d.vramMib);
      if (d.vramMib != null && typeof d.vramMib !== 'boolean' && Number.isFinite(vram) && vram > 0) entry.vramMib = vram;
    } else {
      continue;
    }
    entry.share = finiteShare(d.share);
    entry.enabled = d.enabled !== false;
    out.push(entry);
  }
  return out;
}

export function enabledDevices(devices) {
  return sanitizeDevices(devices).filter((d) => d.enabled);
}

export function hasEnabledWorker(devices) {
  return enabledDevices(devices).some((d) => d.worker);
}

// Workers whose status badge should poll: enabled worker rows only.
export function pollableWorkers(devices) {
  return [...new Set(enabledDevices(devices).filter((d) => d.worker).map((d) => d.worker))];
}

// The server's lib/devices.js legacyToDevices, for when the server can't be
// asked: GPU A takes `tensorSplit` (0-99), GPU B or the worker the rest.
export function legacyToDevices(cfg) {
  const c = cfg || {};
  const str = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
  const a = str(c.deviceA);
  const bRaw = str(c.deviceB);
  const b = bRaw && bRaw !== a ? bRaw : null;
  const rpc = str(c.rpcTarget);
  const ts = Number(c.tensorSplit);
  const split = c.tensorSplit != null && c.tensorSplit !== '' && Number.isFinite(ts) && ts >= 0 && ts < 100 ? ts : null;
  const second = b ? { id: b } : (rpc ? { worker: rpc } : null);
  const out = [];
  if (a) out.push({ id: a, share: second && split != null ? split : null });
  if (second) out.push({ ...second, share: a && split != null ? 100 - split : null });
  return sanitizeDevices(out);
}

// A config that still needs converting: no `devices`, but old device fields.
export function needsDeviceConversion(cfg) {
  return !!cfg && typeof cfg === 'object' && !Array.isArray(cfg.devices)
    && !!(cfg.deviceA || cfg.deviceB || cfg.rpcTarget);
}

// Convert a config without `devices` the way the server does it at launch:
// POST /api/preview-command returns the resolved list (worker entries carry
// their assigned RPC<n> id, which sanitizeDevices drops in favor of `worker`)
// plus warnings such as "... moved from Vulkan0 to Vulkan1". Falls back to
// the local conversion when the server can't be asked or can't resolve the
// config. Returns { devices, warnings }.
export async function convertLegacyConfig(client, cfg) {
  try {
    const res = await client.postJson('/api/preview-command', sanitizeConfig(cfg));
    if (res && Array.isArray(res.devices)) {
      return { devices: sanitizeDevices(res.devices), warnings: Array.isArray(res.warnings) ? res.warnings : [] };
    }
  } catch {
    // fall through to the local conversion
  }
  return { devices: legacyToDevices(cfg), warnings: [] };
}

// Notes for local devices restored without a card name. Older configs stored
// bare ids, and a GPU added or removed since then silently moves an id to
// another card; the server can't re-point those (the web table says the same).
export function unnamedDeviceNotes(devices) {
  return sanitizeDevices(devices)
    .filter((d) => !d.worker && d.enabled && !d.name)
    .map((d) => `${d.id} was saved without a card name — check it's the card you meant`);
}

// Warning lines to show, in order, without repeats (the conversion preview and
// the live preview both report e.g. "Vulkan2 is not a device in this build").
export function uniqueWarnings(...lists) {
  return [...new Set(lists.flat().filter(Boolean))];
}

// launch config (profile / running launchConfig) -> draft.
//   base      -- draft to start from (DEFAULT_DRAFT for a REPLACE load, the
//                current draft for the prefill merge)
//   skipEmpty -- don't copy null/'' values over base (prefill semantics)
//   devices   -- the device list to use (convertLegacyConfig's result for a
//                config without `devices`); defaults to the config's own
//                list, else the local legacy conversion
export function configToDraft(cfg, base = DEFAULT_DRAFT, { skipEmpty = false, devices } = {}) {
  const clean = sanitizeConfig(cfg);
  const next = { ...base };
  for (const k of DRAFT_KEYS) {
    if (k === 'devices' || clean[k] === undefined) continue;
    if (skipEmpty && (clean[k] === null || clean[k] === '')) continue;
    next[k] = clean[k];
  }
  next.devices = devices
    ? sanitizeDevices(devices)
    : Array.isArray(clean.devices) ? sanitizeDevices(clean.devices) : legacyToDevices(clean);
  // transport is null in a local config -- keep the draft's pick so enabling
  // a worker later doesn't land on an empty list value.
  if (!next.transport) next.transport = base.transport || DEFAULT_DRAFT.transport;
  if (next.specDraftDevice == null) next.specDraftDevice = '';
  next.verbosity = clampVerbosity(next.verbosity);
  return next;
}

// draft -> launch config for /api/start, /api/preview-command and profile
// saves. The only path out of the form: never carries rawCommand or the
// legacy device fields.
export function draftToConfig(draft) {
  const d = draft || {};
  const out = {};
  for (const k of DRAFT_KEYS) {
    if (d[k] !== undefined) out[k] = d[k];
  }
  // Disabled rows are kept (enabled: false) so a profile remembers them; the
  // server leaves them out of the launch. An unset share is omitted.
  const devices = sanitizeDevices(d.devices);
  out.devices = devices.map(({ share, ...rest }) => (share == null ? rest : { ...rest, share }));
  out.transport = devices.some((x) => x.worker && x.enabled) ? (d.transport || DEFAULT_DRAFT.transport) : null;
  // --spec-draft-device must name an enabled LOCAL device (the server 400s
  // otherwise: drafting on a worker would round-trip the network every step).
  const draftDev = typeof d.specDraftDevice === 'string' ? d.specDraftDevice.trim() : '';
  out.specDraftDevice = draftDev && devices.some((x) => !x.worker && x.enabled && x.id === draftDev) ? draftDev : null;
  // A blanked verbosity field is null in the draft -- the server would omit
  // -lv entirely, so enforce the floor on the way out too.
  out.verbosity = clampVerbosity(out.verbosity);
  // The split-mode field is sent only when it says something: unset means the
  // default (layer), and a server from before the field never sees the key.
  if (typeof out.splitMode !== 'string' || !out.splitMode.trim()) delete out.splitMode;
  return out;
}

// Normalized share per row, aligned with `devices` (the web table's % column):
// null for a disabled row, 100 for the only enabled one, a rounded % when
// every enabled row has a share and one is > 0, else 'auto' (no -ts:
// llama-server splits by free VRAM).
export function sharePercents(devices) {
  const list = sanitizeDevices(devices);
  const on = list.filter((d) => d.enabled);
  const allSet = on.length > 1 && on.every((d) => d.share != null) && on.some((d) => d.share > 0);
  const total = allSet ? on.reduce((sum, d) => sum + d.share, 0) : 0;
  return list.map((d) => {
    if (!d.enabled) return null;
    if (on.length === 1) return 100;
    return allSet ? Math.round((d.share / total) * 100) : 'auto';
  });
}

// The split rule both clients enforce before launching (the web shows the same
// message in red and disables Load Model): with two or more enabled devices,
// either every share is blank (auto -- llama-server divides by free VRAM) or
// every share is set and they total exactly 100. Returns null when the split
// is fine, else why not.
export function splitProblem(devices) {
  const on = sanitizeDevices(devices).filter((d) => d.enabled);
  if (on.length < 2) return null;
  const set = on.filter((d) => d.share != null);
  if (set.length === 0) return null;
  if (set.length < on.length) return 'Set a share on every enabled device (or clear them all for auto).';
  const total = set.reduce((sum, d) => sum + d.share, 0);
  return total === 100 ? null : `Shares total ${total}% -- they must add up to 100%.`;
}

// ---- split mode (how a launch on two or more devices divides the model) ----
//
// llama-server's --split-mode. The two modes offered:
//   layer   whole layers per device, in -dev order, sized by the shares (the
//           default: what the dashboard emits for any multi-device launch)
//   tensor  tensors spread across devices (experimental)
// llama.cpp's third mode, `row`, is deprecated and fails to load: it is shown
// (in red) when a saved config still carries it, and never offered.
//
// A config says it in one of two places, and the server (lib/devices.js
// splitModeOf) reads both: its `splitMode` field ('layer' | 'tensor'), or --
// every profile saved before that field existed, and any server from before
// it -- a `-sm tensor` in its extra arguments, which comes later on the
// command line and wins.
export const SPLIT_MODES = ['layer', 'tensor'];
const SPLIT_FLAG_RE = /(^|\s)(?:-sm|--split-mode)(?:\s+|=)(?:'([^']*)'|"([^"]*)"|(\S+))/g;

// The split mode a string of arguments (a config's argString, or a resolved
// command) ends up with: the LAST -sm / --split-mode wins, as in llama-server.
// null when it names none.
export function splitModeOf(text) {
  let mode = null;
  for (const m of String(text || '').matchAll(SPLIT_FLAG_RE)) mode = (m[2] ?? m[3] ?? m[4] ?? '').toLowerCase();
  return mode || null;
}

// The split mode a config asks for: its extra arguments' -sm, else its
// `splitMode` field, else null (the default, layer).
export function configSplitMode(cfg) {
  const c = cfg || {};
  const field = typeof c.splitMode === 'string' && c.splitMode.trim() ? c.splitMode.trim().toLowerCase() : null;
  return splitModeOf(c.argString) || field;
}

// argString with its split mode set: every -sm / --split-mode is removed, and
// `-sm tensor` appended for tensor (layer is the dashboard's own default, so
// it needs no flag). Any other mode is treated as layer.
export function withSplitMode(argString, mode) {
  const rest = String(argString || '').replace(SPLIT_FLAG_RE, '$1').replace(/\s+/g, ' ').trim();
  return mode === 'tensor' ? `${rest}${rest ? ' ' : ''}-sm tensor` : rest;
}

// The { splitMode, argString } of a config switched to `mode` ('layer' or
// 'tensor'; anything else is layer). With `useField` (the server has said it
// knows the `splitMode` field) the mode goes in the field and the extra
// arguments lose their -sm; otherwise it goes in the extra arguments, which
// every server honours, and the field is cleared. Either way exactly one of
// the two places says it, so the config can never disagree with itself.
export function setSplitMode(cfg, mode, { useField = false } = {}) {
  const tensor = mode === 'tensor';
  const argString = cfg ? cfg.argString : '';
  return useField
    ? { splitMode: tensor ? 'tensor' : null, argString: withSplitMode(argString, 'layer') }
    : { splitMode: null, argString: withSplitMode(argString, tensor ? 'tensor' : 'layer') };
}

// How to show a split mode: { mode, text, level: 'ok' | 'warn' | 'bad' }.
export function describeSplitMode(mode) {
  const m = mode || 'layer';
  if (m === 'layer') return { mode: m, text: 'layer (default) — whole layers per card, in the order listed', level: 'ok' };
  if (m === 'tensor') return { mode: m, text: 'tensor (-sm tensor) — experimental', level: 'warn' };
  if (m === 'row') return { mode: m, text: 'row — deprecated in llama.cpp, fails to load (use layer)', level: 'bad' };
  if (m === 'none') return { mode: m, text: 'none (-sm none) — llama-server then uses one card only', level: 'warn' };
  return { mode: m, text: `${m} — not a split mode this client knows`, level: 'warn' };
}

// The /api/devices backend entry ({ id, totalMib, freeMib }) for a device id.
export function findBackend(cards, id) {
  for (const c of cards || []) {
    const b = (c.backends || []).find((x) => x.id === id);
    if (b) return b;
  }
  return null;
}

// Shares in proportion to available VRAM (the web's Suggest split): a local
// device's free MiB from this build's /api/devices cards; a worker's from the
// latest telemetry GPUs on its host (vram_total - vram_used), which the server
// only reports while a launch uses that worker -- without a reading it gets
// the average of the rest, noted as estimated. Returns { devices, notes };
// the list is unchanged with fewer than two enabled rows or nothing known.
export function suggestShares(devices, { cards = [], gpus = [] } = {}) {
  const list = sanitizeDevices(devices);
  const on = list.filter((d) => d.enabled);
  if (on.length < 2) return { devices: list, notes: [] };
  const avail = on.map((d) => {
    if (d.worker) {
      const mine = (gpus || []).filter((g) => g && g.host === d.worker && !g.error);
      return mine.length ? mine.reduce((sum, g) => sum + Math.max(0, (g.vram_total || 0) - (g.vram_used || 0)), 0) : null;
    }
    const b = findBackend(cards, d.id);
    return b && Number.isFinite(b.freeMib) ? b.freeMib : null;
  });
  const known = avail.filter((v) => v != null);
  if (known.length === 0) return { devices: list, notes: [] };
  const fill = known.reduce((a, b) => a + b, 0) / known.length;
  const notes = [];
  on.forEach((d, i) => {
    if (avail[i] == null) {
      avail[i] = fill;
      notes.push(`${d.worker || d.name || d.id}: no VRAM reading yet, estimated`);
    }
  });
  const total = avail.reduce((a, b) => a + b, 0) || 1;
  const shares = avail.map((v) => Math.round((v / total) * 100));
  shares[shares.indexOf(Math.max(...shares))] += 100 - shares.reduce((a, b) => a + b, 0);
  const byRow = new Map(on.map((d, i) => [d, shares[i]]));
  return { devices: list.map((d) => (byRow.has(d) ? { ...d, share: byRow.get(d) } : d)), notes };
}

// The editor's rows: the draft's devices (in order) matched to this build's
// /api/devices `cards` and the configured `workers`, then every card and
// worker not in the list as a disabled row -- so each physical card and each
// worker is always exactly one row, like the web table. Local entries are
// matched in two passes (the server's lib/topology.js resolveDevices does the
// same), so that with identical cards a saved "second card" stays the second:
//   1. an entry whose id reaches a card of its stored name (or that stored no
//      name) keeps that card and that id
//   2. the rest take a free card of their stored name (ids shift when a GPU is
//      added or removed) -- its id on the same backend, else its preferred id
//      -- and failing that the card their id reaches. Between identical cards
//      it is the one the saved id means: the card that id reaches in
//      `reference` (the machine's fullest topology, which knows ROCm1 is the
//      second card even when this build has no ROCm ids), else the one at the
//      id's own index; only when that one is taken, the first free.
// A worker entry matches by name or ssh target. Entries matching nothing stay,
// flagged `missing`. A matched entry takes the card's name and size; one whose
// id changed carries `repointed: { from, to, identical }` (`identical`: the
// card is one of several of its model, so which one was a choice) for
// repointNotes below. On a fresh draft (no devices at all) discrete cards
// start enabled on auto split, like the web's first detection; workers start
// off.
// Returns [{ entry, card, worker, missing, repointed }]; the entries are the
// draft's next `devices` (merging an already-merged list is a no-op).
export function mergeCatalog(devices, cards = [], workers = [], { reference = null } = {}) {
  const list = sanitizeDevices(devices);
  const fresh = list.length === 0;
  const all = cards || [];
  const usedCards = new Set();
  const usedWorkers = new Set();
  const backendOf = (id) => String(id || '').replace(/\d+$/, '');
  const reaches = (c, id) => (c.backends || []).some((b) => b.id === id);
  const sizeOf = (c) => Math.max(0, ...(c.backends || []).map((b) => Number(b.totalMib) || 0));
  // Position of the card a saved id means among the cards of its model (0-based), or -1.
  const meant = (d) => {
    const home = reference && Array.isArray(reference.cards) ? reference.cards.find((c) => (c.ids || []).includes(d.id)) : null;
    if (home && Number.isInteger(home.ordinal) && gpuKey(home.name) === gpuKey(d.name)) return home.ordinal - 1;
    const n = Number((String(d.id).match(/(\d+)$/) || [])[1]);
    return Number.isInteger(n) ? n : -1;
  };
  const cardOf = list.map((d) => {
    if (d.worker) return null;
    const c = all.find((x) => !usedCards.has(x) && reaches(x, d.id) && (!d.name || gpuKey(x.name) === gpuKey(d.name)));
    if (c) usedCards.add(c);
    return c || null;
  });
  const rows = [];
  list.forEach((d, i) => {
    if (d.worker) {
      const w = (workers || []).find((x) => x && !usedWorkers.has(x) && (x.name === d.worker || x.ssh === d.worker));
      if (w) {
        usedWorkers.add(w);
        rows.push({ entry: { ...d, worker: w.name }, card: null, worker: w, missing: false });
      } else {
        rows.push({ entry: d, card: null, worker: null, missing: true });
      }
      return;
    }
    const twins = d.name ? all.filter((c) => gpuKey(c.name) === gpuKey(d.name)) : [];
    const wanted = twins.length > 1 ? twins[meant(d)] : null;
    const card = cardOf[i]
      || (wanted && !usedCards.has(wanted) ? wanted : null)
      || twins.find((c) => !usedCards.has(c))
      || all.find((c) => !usedCards.has(c) && reaches(c, d.id));
    if (!card) {
      rows.push({ entry: d, card: null, worker: null, missing: true });
      return;
    }
    usedCards.add(card);
    const backends = card.backends || [];
    const id = (backends.find((b) => b.id === d.id)
      || backends.find((b) => backendOf(b.id) === backendOf(d.id))
      || { id: card.preferredId || d.id }).id;
    const { vramMib: _saved, ...rest } = d;
    const size = sizeOf(card);
    const row = { entry: { ...rest, id, name: card.name, ...(size > 0 ? { vramMib: size } : {}) }, card, worker: null, missing: false };
    if (id !== d.id) row.repointed = { from: d.id, to: id, identical: twins.length > 1 };
    rows.push(row);
  });
  for (const c of all) {
    if (usedCards.has(c)) continue;
    const id = c.preferredId || (c.backends && c.backends[0] && c.backends[0].id);
    if (!id) continue;
    // An integrated GPU starts off even on a fresh draft. There is no flag for
    // "integrated" in a device listing, so this goes by how such chips are
    // named: Intel's, and AMD APUs' "Radeon Graphics" / "Vega N Graphics"
    // (no model number). A discrete card named like that only starts unticked.
    const enabled = fresh && !/intel|iris|uhd graphics|radeon(\(tm\))? graphics|vega \d+ graphics/i.test(c.name || '');
    const size = sizeOf(c);
    rows.push({ entry: { id, name: c.name, ...(size > 0 ? { vramMib: size } : {}), share: null, enabled }, card: c, worker: null, missing: false });
  }
  for (const w of workers || []) {
    if (!w || !w.name || usedWorkers.has(w)) continue;
    rows.push({ entry: { worker: w.name, share: null, enabled: false }, card: null, worker: w, missing: false });
  }
  return rows;
}

// What to tell the user about rows mergeCatalog re-pointed between IDENTICAL
// cards: which of them a saved id means on this build is a choice (by the
// machine's fullest device listing, else by position), so it is said out loud
// rather than made silently. `labelOf(entry)` names the card (its topology
// label). A re-point to the only card of a model needs no note.
export function repointNotes(rows, labelOf = (e) => shortGpuName(e.name)) {
  return (rows || [])
    .filter((r) => r && r.repointed && r.repointed.identical)
    .map((r) => `${r.repointed.from} is not an id in this build: using ${labelOf(r.entry)} (${r.repointed.to}) — one of several identical cards, check it is the one you meant`);
}

// Row edits on a (merged) devices list; each returns a new list.
export function toggleDeviceAt(devices, i) {
  return sanitizeDevices(devices).map((d, j) => (j === i ? { ...d, enabled: !d.enabled } : d));
}

export function setShareAt(devices, i, share) {
  const v = finiteShare(share);
  return sanitizeDevices(devices).map((d, j) => (j === i ? { ...d, share: v } : d));
}

export function adjustShareAt(devices, i, delta) {
  const list = sanitizeDevices(devices);
  const cur = list[i] && list[i].share != null ? list[i].share : 0;
  return setShareAt(list, i, Math.max(0, cur + delta));
}

export function moveDeviceAt(devices, i, dir) {
  const list = sanitizeDevices(devices);
  const j = i + dir;
  if (!list[i] || j < 0 || j >= list.length) return list;
  [list[i], list[j]] = [list[j], list[i]];
  return list;
}

// Next backend id for a card reachable through several (its /api/devices
// `backends`, in order, wrapping).
export function cycleBackendAt(devices, i, card) {
  const list = sanitizeDevices(devices);
  const d = list[i];
  const backends = (card && card.backends) || [];
  if (!d || d.worker || backends.length < 2) return list;
  const k = backends.findIndex((b) => b.id === d.id);
  const next = backends[(k + 1) % backends.length].id;
  return list.map((x, j) => (j === i ? { ...x, id: next } : x));
}

// A config's enabled devices, whichever shape it's in.
function configDevices(cfg) {
  return cfg && Array.isArray(cfg.devices) ? enabledDevices(cfg.devices) : legacyToDevices(cfg || {});
}

// "RPC" when the config uses a worker, else "Local" (web profile dropdown).
export function profileTag(cfg) {
  return configDevices(cfg).some((d) => d.worker) ? 'RPC' : 'Local';
}

// Compact device summary for profile lists, enabled devices in order with
// their share when set: "<card> 50 · <worker> 30 · <card> 20" (card names
// shortened from the names the profile stored). Empty when the config leaves
// device choice to llama-server.
export function deviceSummary(cfg) {
  return configDevices(cfg)
    .map((d) => `${d.worker || (d.name ? shortGpuName(d.name) : d.id)}${d.share != null ? ` ${d.share}` : ''}`)
    .join(' · ');
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
