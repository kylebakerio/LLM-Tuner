// Pure helpers for Launch mode's profile-first flow (no ink/React imports --
// the unit tests and cli.js load this directly):
//   profile list   -- one display row per saved profile (profileRow), with
//                     whether it can run on this machine (the server's
//                     `availability`), the list order, its fuzzy filter and
//                     column widths
//   launch plan    -- saved profile -> the /api/start body (profileLaunchPlan)
//   confirm panel  -- the cards a launch uses, the busy-card list from
//                     /api/preview-command or a 409, what needs a second "yes"
//   running line   -- what the dashboard's server is running right now
//
// The config <-> command contract itself stays in launchconfig.js; nothing
// here invents a field the dashboard doesn't already read.

import { modelName, fmtUptime, fuzzyScore, clipLabel } from './format.js';
import {
  DEFAULT_DRAFT, configToDraft, draftToConfig, convertLegacyConfig, needsDeviceConversion,
  sanitizeDevices, enabledDevices, legacyToDevices, sharePercents, unnamedDeviceNotes, uniqueWarnings,
  splitProblem, splitModeOf, configSplitMode, describeSplitMode,
} from './launchconfig.js';
import { deviceLabel, placementText, normalizeAvailability } from './topology.js';

// ---- engines ----

// A Strata-engine profile (web: engine select = strata) has no model path,
// build or device list: its launch is a base config file plus overrides, and
// /api/preview-command + /api/start resolve it through lib/strata.js. The
// llama-server config editor has no fields for it; `e` opens the Strata editor
// instead (strataform.js; 2026-10-17 -- it was launch-only here before).
export function isStrataConfig(cfg) {
  return !!cfg && typeof cfg === 'object' && cfg.engine === 'strata';
}

// The server's lib/strata.js OVERRIDE_KEYS (test/strataform.test.js holds the
// two lists equal). 2026-10-17: + pipeline windows, resident budget, the cards
// (gpu) and their layer split, and the two env switches.
export const STRATA_OVERRIDE_KEYS = ['maxContext', 'kv', 'kvResident', 'ropeScaling', 'ropeScale', 'spec', 'specMinP',
  'pipelineWindows', 'residentBudgetGib', 'gpu', 'layerSplit', 'stageTrim', 'kernelCopy', 'temperature', 'topK', 'topP'];

// Strata profile -> launch body: engine, base file and the overrides only
// (never rawCommand). Profiles store the sampling temperature as `temp` (the
// shared field's key); lib/strata.js reads `temperature`, which is what the
// web sends after restoring the profile into its form -- mapped the same way.
export function strataLaunchConfig(cfg) {
  const c = cfg || {};
  const src = { ...c, temperature: c.temperature ?? c.temp };
  const out = { engine: 'strata', strataBase: typeof c.strataBase === 'string' ? c.strataBase : '' };
  for (const k of STRATA_OVERRIDE_KEYS) {
    if (src[k] !== undefined && src[k] !== null && src[k] !== '') out[k] = src[k];
  }
  const port = Number(c.port);
  if (c.port != null && c.port !== '' && Number.isFinite(port)) out.port = port;
  return out;
}

// Saved profile -> what Launch sends. A llama-server profile goes through the
// same configToDraft -> draftToConfig path as loading it into the editor
// (legacy device fields converted by the server, verbosity floor, no
// rawCommand), so launching a profile directly and launching it after
// opening the editor are the same request. Returns
// { config, notes, problem }: `notes` are conversion warnings, `problem` a
// reason the profile can't launch as saved (null when it can).
export async function profileLaunchPlan(client, cfg) {
  if (isStrataConfig(cfg)) {
    const config = strataLaunchConfig(cfg);
    return { config, notes: [], problem: config.strataBase ? null : 'This Strata profile has no base config file.' };
  }
  const conv = needsDeviceConversion(cfg) ? await convertLegacyConfig(client, cfg) : null;
  const draft = configToDraft(cfg, DEFAULT_DRAFT, { devices: conv ? conv.devices : undefined });
  const config = draftToConfig(draft);
  const problem = config.modelPath ? splitProblem(config.devices) : 'This profile has no model set — press e to edit it.';
  return { config, notes: uniqueWarnings(conv ? conv.warnings : [], unnamedDeviceNotes(draft.devices)), problem };
}

// ---- display bits ----

// 131072 -> "131k", 65536 -> "65k", 1048576 -> "1M" (thousands, floored: the
// same figures the profile names use -- "262k", "229k", "131k").
export function fmtCtx(n) {
  const v = Number(n);
  if (n == null || n === '' || !Number.isFinite(v) || v <= 0) return '—';
  if (v >= 1e6) return `${Math.round(v / 1e5) / 10}M`;
  if (v >= 1000) return `${Math.floor(v / 1000)}k`;
  return String(v);
}

// "3m ago" / "5h ago" / "12d ago" for a last-used stamp.
export function ago(ms) {
  if (!Number.isFinite(ms) || ms < 0) return 'just now';
  const m = Math.floor(ms / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const hrs = Math.floor(m / 60);
  if (hrs < 48) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

// One line about a GET /api/devices answer that did not come from a probe
// made for this request ('' when it did, or from a server that does not say):
// the dashboard re-probes only when nothing is running on a local card, and a
// failed probe no longer replaces a good earlier listing. Not a failure --
// the rows are the build's last good listing -- so it says how old that is
// and why (`error`: the probe just now failed; `note`: it was not made).
export function devicesListingNote(d, now = Date.now()) {
  if (!d || d.cached !== true) return '';
  const at = Number(d.cachedAt);
  const age = Number.isFinite(Number(d.ageMs)) && d.ageMs != null ? Number(d.ageMs) : (Number.isFinite(at) && at > 0 ? now - at : null);
  const when = age == null ? '' : (age < 60000 ? ' from just now' : ` from ${ago(age)}`);
  const why = typeof d.error === 'string' && d.error.trim() ? `the probe just now failed: ${d.error.trim()}`
    : (typeof d.note === 'string' && d.note.trim() ? d.note.trim() : '');
  return `device list${when} (cached)${why ? ` — ${why}` : ''}`;
}

// A config's enabled devices, whichever shape it's in.
function configDevices(cfg) {
  return cfg && Array.isArray(cfg.devices) ? enabledDevices(cfg.devices) : legacyToDevices(cfg || {});
}

// Where a config's launch sits, for a one-line cell, when the server did not
// say (`availability.placement`): the same wording, from the config's own
// device list and the topology's labels (topology.js placementText) --
// "RX 7900 XTX #1 alone", "2x RX 7900 XTX, 1:1". "auto" when llama-server
// picks the devices; a Strata-engine config places itself.
export function cardsCell(cfg, topology = null) {
  if (isStrataConfig(cfg)) return 'Strata engine';
  const list = configDevices(cfg);
  return list.length === 0 ? 'auto' : placementText(list, topology);
}

// " · tensor" for a config on two or more devices that is not split by layer
// (the default), else '': two profiles that differ only in their split mode
// would otherwise be the same row.
export function splitTag(cfg) {
  if (isStrataConfig(cfg) || configDevices(cfg).length < 2) return '';
  const mode = describeSplitMode(configSplitMode(cfg)).mode;
  return mode === 'layer' ? '' : ` · ${mode}`;
}

// The model a profile launches, as shown in lists: the gguf name without its
// extension, or a Strata base config's name ("strata coder-iq1_m-262k-int8").
export function profileModelLabel(cfg) {
  if (isStrataConfig(cfg)) {
    const base = String((cfg && cfg.strataBase) || '').split('/').pop().replace(/\.json$/, '').replace(/^strata-/, '');
    return base ? `strata ${base}` : 'strata (no base config)';
  }
  return cfg && cfg.modelPath ? modelName(cfg.modelPath, { ext: false }) : '(no model)';
}

// Is `p` a model file the dashboard's scan (/api/models) knows -- by path,
// resolved path or alias? null when the catalog isn't loaded (unknown, so no
// marker). The scan lists only files that exist, so "not known" means the
// file is gone (or was never under a scanned directory).
export function modelKnown(models, p) {
  if (!p || !Array.isArray(models) || models.length === 0) return null;
  return models.some((m) => m && (m.path === p || m.realPath === p || (Array.isArray(m.aliases) && m.aliases.includes(p))));
}

// What the list says about a profile that is not simply ready, from the
// server's availability entry: '' when ready.
export function availabilityNote(avail) {
  const reason = avail.reason || '';
  if (avail.status === 'unavailable') return `can't run on this machine${reason ? ` — ${reason}` : ''}`;
  if (avail.status === 'substitute') return `stand-in card${reason ? ` — ${reason}` : ' — not validated on this machine'}`;
  if (avail.status === 'moved') return `device ids changed${reason ? ` — ${reason}` : ''}`;
  return '';
}

// The version of the Strata install a base config belongs to: the server's
// own (`version` on its /api/strata/configs entry), else read off the install
// directory's name ("<anything>-0.1.43.1/strata-x.json" -> "0.1.43.1"); ''
// when neither says.
export function strataVersionOf(base, filePath) {
  if (base && typeof base.version === 'string' && base.version.trim()) return base.version.trim();
  const dir = String((base && base.install) || filePath || '').replace(/\/[^/]*\.json$/, '').split('/').filter(Boolean).pop() || '';
  const m = /[-_]v?(\d+(?:\.\d+)+)$/.exec(dir);
  return m ? m[1] : '';
}

// One profile list row from a listProfileEntries() entry.
//   models       -- /api/models (unfiltered), for the missing-file marker
//   strata       -- /api/strata/configs `configs` ([{ path, maxContext?,
//                   install?, version? }]; null = not loaded): the
//                   missing-file marker for Strata profiles, their context
//                   size and their install's version when the server lists
//                   them. The list spans every Strata install the dashboard
//                   is configured with.
//   strataScope  -- the one directory an OLDER server's list covers (its
//                   `dir`, from a server that sends no `installs`): a base
//                   config outside it is not in that list either way, so it
//                   is not marked missing. null = the list is complete.
//   availability -- /api/profiles `availability` ({ name: { status, reason,
//                   placement } }); a server without it = every profile ready
//   topology     -- normalizeTopology() of the machine, for the placement text
//                   when the server sent none
// `missing` is true only when the catalog says so; `missingWhy` is the text
// for the detail line and the confirm panel. `avail` is the profile's fit on
// this machine and `runnable` false only for status 'unavailable'; `cards` is
// the server's placement text (its reason, for a profile that can't run).
export function profileRow(entry, { models = [], strata: strataConfigs = null, strataScope = null, now = Date.now(), availability = null, topology = null } = {}) {
  const cfg = (entry && entry.config) || {};
  const strata = isStrataConfig(cfg);
  const filePath = strata ? (cfg.strataBase || '') : (cfg.modelPath || '');
  const base = strata && Array.isArray(strataConfigs) ? strataConfigs.find((c) => c && c.path === filePath) : null;
  const listed = !strataScope || filePath.startsWith(`${String(strataScope).replace(/\/+$/, '')}/`);
  let missing = false;
  let missingWhy = '';
  if (!filePath) {
    missing = true;
    missingWhy = strata ? 'no Strata base config set' : 'no model set';
  } else if (strata) {
    if (Array.isArray(strataConfigs) && !base && listed) { missing = true; missingWhy = 'Strata base config not found'; }
  } else if (modelKnown(models, filePath) === false) {
    missing = true;
    missingWhy = 'model file not found';
  }
  const neverUsed = !(entry && entry.lastLoadedAt);
  const name = (entry && entry.name) || '';
  const avail = normalizeAvailability(availability && typeof availability === 'object' ? availability[name] : null);
  const runnable = avail.status !== 'unavailable';
  const row = {
    name,
    config: cfg,
    strata,
    model: profileModelLabel(cfg),
    ctxTokens: strata ? (cfg.maxContext || (base && base.maxContext) || null) : (cfg.ctx ?? null),
    cards: runnable ? `${avail.placement || cardsCell(cfg, topology)}${splitTag(cfg)}` : (avail.reason || 'not on this machine'),
    build: strata ? 'strata' : (cfg.build || 'default'),
    strataVersion: strata ? strataVersionOf(base, filePath) : '',
    filePath,
    missing,
    missingWhy,
    avail,
    runnable,
    availNote: availabilityNote(avail),
    neverUsed,
    used: neverUsed ? 'never used' : ago(now - entry.lastLoadedAt),
    note: typeof cfg.tuningNote === 'string' ? cfg.tuningNote : '',
    lastLoadedAt: (entry && entry.lastLoadedAt) || null,
  };
  row.ctx = fmtCtx(row.ctxTokens);
  row.status = missing ? 'MISSING' : (runnable ? row.used : 'unavailable');
  return row;
}

// The list's rows, in list order: the profiles this machine can run first
// (most recently used first, as the entries arrive), then the ones it can't.
// The one place that order is decided -- the list, the click hit-test and the
// "select the profile I just renamed" lookup all read it from here.
export function profileListRows(entries, opts = {}) {
  const rows = (entries || []).map((e) => profileRow(e, opts));
  return [...rows.filter((r) => r.runnable), ...rows.filter((r) => !r.runnable)];
}

// Counts for the list's title line.
export function availabilityCounts(rows) {
  const n = (st) => rows.filter((r) => r.avail && r.avail.status === st).length;
  return { total: rows.length, unavailable: n('unavailable'), moved: n('moved'), substitute: n('substitute'), runnable: rows.filter((r) => r.runnable).length };
}

// Rows matching the filter. Rows where every word of the query appears as
// written ("terse 128" in "Terse-Coder ... 128k") are the result, in list
// order -- a plain search keeps most-recently-used order and shows nothing
// else. Only when no row matches that way does it fall back to a fuzzy
// (subsequence) match, best first: across six columns a subsequence matches
// nearly everything, which is noise next to an exact hit.
export function filterRows(rows, query) {
  const words = String(query || '').toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return rows;
  const hay = (r) => `${r.name} ${r.model} ${r.ctx} ${r.cards} ${r.build}${r.strataVersion ? ` ${r.strataVersion}` : ''} ${r.status}`.toLowerCase();
  const exact = rows.filter((r) => words.every((w) => hay(r).includes(w)));
  if (exact.length > 0) return exact;
  const q = words.join('');
  return rows
    .map((r, i) => ({ r, i, score: fuzzyScore(q, hay(r)) }))
    .filter((x) => x.score != null)
    .sort((a, b) => a.score - b.score || a.i - b.i)
    .map((x) => x.r);
}

// Column widths for the one-line rows at a terminal width. Fixed columns
// (ctx, build, status) take what they need; name / model / placement share
// the rest. The placement cell goes first, up to 45% of it -- "RX 7900 XTX #2
// alone" cut short would hide which card -- then the model (25%), and the
// name takes what is left; each is capped at its longest value, and whatever
// one of them doesn't need goes to the others (placement, then name, then
// model). The build column is dropped under 90 columns.
export const PROFILE_GUTTER = 4; // '› ' + the missing / availability flag
export function profileColumns(rows, cols) {
  const longest = (k, min, cap) => Math.min(cap, rows.reduce((m, r) => Math.max(m, String(r[k]).length), min));
  const status = 11; // 'unavailable'
  const ctx = longest('ctx', 3, 5);
  const build = cols >= 90 ? longest('build', 5, 9) : 0;
  const gaps = build ? 5 : 4;
  const rest = Math.max(30, cols - 1 - PROFILE_GUTTER - status - ctx - build - gaps);
  const need = { cards: longest('cards', 9, 30), model: longest('model', 10, 40), name: longest('name', 10, 90) };
  const w = {
    cards: Math.min(need.cards, Math.max(9, Math.floor(rest * 0.45))),
    model: Math.min(need.model, Math.max(10, Math.floor(rest * 0.25))),
  };
  w.name = Math.max(10, Math.min(need.name, rest - w.cards - w.model));
  let left = rest - w.cards - w.model - w.name;
  for (const k of ['cards', 'name', 'model']) {
    const add = Math.max(0, Math.min(left, need[k] - w[k]));
    w[k] += add;
    left -= add;
  }
  return { name: w.name, model: w.model, ctx, cards: w.cards, build, status };
}

// Pad or cut `s` to exactly `w` columns ("…" marks a cut).
export function fit(s, w) {
  const str = String(s == null ? '' : s);
  if (w <= 0) return '';
  if (str.length > w) return w === 1 ? '…' : `${str.slice(0, w - 1)}…`;
  return str + ' '.repeat(w - str.length);
}

// fit() for a cell that names a card ("RX 7900 XTX #2 alone"): a cut keeps
// the ordinal that tells identical cards apart (format.js clipLabel).
export function fitLabel(s, w) {
  return fit(clipLabel(s, w), w);
}

// ---- confirm panel ----

// Greedy word wrap to `width` columns (a word longer than the line is cut),
// at most `maxLines` lines: the last one ends in "…" when text was left out.
// The confirm panel wraps the command and the note itself so it knows how
// tall they are and can keep the whole panel on the screen.
export function wrapLines(text, width, maxLines = Infinity) {
  const w = Math.max(8, Math.floor(width));
  const lines = [];
  let cur = '';
  for (let word of String(text == null ? '' : text).split(/\s+/).filter(Boolean)) {
    while (word.length > w) {
      if (cur) { lines.push(cur); cur = ''; }
      lines.push(word.slice(0, w));
      word = word.slice(w);
    }
    if (!cur) cur = word;
    else if (cur.length + 1 + word.length <= w) cur += ` ${word}`;
    else { lines.push(cur); cur = word; }
  }
  if (cur) lines.push(cur);
  if (lines.length <= maxLines) return lines;
  const kept = lines.slice(0, Math.max(1, maxLines));
  const last = kept[kept.length - 1];
  kept[kept.length - 1] = last.length >= w ? `${last.slice(0, w - 1)}…` : `${last}…`;
  return kept;
}

// The cards a launch will use, for the confirm panel: the resolved device
// list from /api/preview-command when there is one (ids re-pointed, RPC ids
// assigned -- what actually runs), else the config's own enabled devices.
// Each is named by its topology label ("RX 7900 XTX #2"; the short form of
// its stored name without a topology), with the id that reaches it.
// Returns [{ text, share }] with share '75%' | 'auto' | ''.
export function planCards(previewDevices, config, topology = null) {
  const fromPreview = Array.isArray(previewDevices) && previewDevices.length > 0;
  // Preview entries are already the launch's devices (disabled rows left out);
  // a worker entry carries both `worker` and its assigned RPC<n> id.
  const raw = fromPreview ? previewDevices : ((config && config.devices) || []);
  const rpcIds = new Map((fromPreview ? previewDevices : []).filter((d) => d && d.worker && d.id).map((d) => [d.worker, d.id]));
  const list = sanitizeDevices(raw).filter((d) => d.enabled);
  const pct = sharePercents(list);
  return list.map((d, i) => {
    const label = d.worker ? '' : deviceLabel(topology, d);
    return {
      text: d.worker
        ? `RPC ${d.worker}${rpcIds.has(d.worker) ? ` (${rpcIds.get(d.worker)})` : ''}`
        : `${label}${label !== d.id ? ` (${d.id})` : ''}`,
      share: list.length < 2 ? '' : (pct[i] === 'auto' ? 'auto' : `${pct[i]}%`),
    };
  });
}

// How a launch on two or more devices splits the model, for the confirm
// panel: describeSplitMode() of what will run -- the preview's own
// `splitMode` when the server sends one, else the last -sm / --split-mode of
// the resolved command, else (until the command is known) what the config
// asks for. null for a launch on one device, where no split happens.
//   preview -- { command, splitMode } of /api/preview-command
export function planSplit(deviceCount, preview, config) {
  if (!(deviceCount > 1)) return null;
  const pv = preview || {};
  const said = typeof pv.splitMode === 'string' && pv.splitMode.trim() ? pv.splitMode.trim().toLowerCase() : null;
  return describeSplitMode(said || splitModeOf(pv.command) || configSplitMode(config));
}

// `busy` from /api/preview-command or a 409 CARD_BUSY body: benchmark-queue
// items running on a card the launch needs ({ lane, device, card, itemId,
// label }). An older server sends no such field -- that is an empty list.
export function normalizeBusy(list) {
  if (!Array.isArray(list)) return [];
  return list.filter((b) => b && typeof b === 'object').map((b) => ({
    lane: b.lane != null ? String(b.lane) : '',
    device: b.device != null ? String(b.device) : '',
    card: b.card != null ? String(b.card) : '',
    itemId: b.itemId != null ? b.itemId : null,
    label: b.label != null ? String(b.label) : '',
  }));
}

// "<card label> (<device id>) — queue item 879 “<label>” · lane <lane>". The
// card is the server's label for the physical card ("RX 7900 XTX #2"), so
// with two identical cards the line still says which one.
export function busyText(b) {
  const card = b.card || b.device || 'a card this launch needs';
  const dev = b.card && b.device ? ` (${b.device})` : '';
  const item = b.itemId != null ? `queue item ${b.itemId}` : 'a queue item';
  const label = b.label ? ` “${b.label}”` : '';
  const lane = b.lane ? ` · lane ${b.lane}` : '';
  return `${card}${dev} — ${item}${label}${lane}`;
}

// /api/start refusing because a queue item holds a needed card (HTTP 409
// { code: 'CARD_BUSY', busy }). McClient puts the status and body on the error.
export function isCardBusyError(err) {
  return !!err && err.status === 409 && !!err.data && err.data.code === 'CARD_BUSY';
}

// /api/start refusing a config this machine can't run as saved (HTTP 409
// { code: 'UNAVAILABLE_HERE', availability: { status, reason } }; servers
// from 2026-10-13). It is lifted by `allowUnavailable: true` on the request.
export function isUnavailableHereError(err) {
  return !!err && err.status === 409 && !!err.data && err.data.code === 'UNAVAILABLE_HERE';
}

// That refusal as a profile availability ({ status, reason, placement }): the
// server's own reason, else its error text.
export function availabilityFromError(err) {
  const a = (err && err.data && err.data.availability) || {};
  const reason = typeof a.reason === 'string' && a.reason.trim() ? a.reason.trim() : String((err && err.message) || '').trim();
  return { status: 'unavailable', reason, placement: null };
}

// The /api/start body for a launch: the config as it stands plus the one-off
// answers the confirm step collected. Both flags belong to the request only
// (the server strips them; neither is ever written into a draft or a
// profile), and each lifts exactly one refusal:
//   force            -- 409 CARD_BUSY: a benchmark holds a card this needs
//   allowUnavailable -- 409 UNAVAILABLE_HERE: this machine can't run it as saved
export function startBody(config, { force = false, allowUnavailable = false } = {}) {
  const body = { ...(config || {}) };
  delete body.force;
  delete body.allowUnavailable;
  if (force) body.force = true;
  if (allowUnavailable) body.allowUnavailable = true;
  return body;
}

// /api/start's "a server is already running / still exiting" answer.
export function isRunningError(err) {
  return !!err && err.status === 400 && /^running$/i.test(String(err.message || '').trim());
}

// ---- what is running ----

// One summary of the dashboard's own server for the top of Launch mode.
//   active  -- anything but stopped (ready, starting, loading, stopping)
//   uptime  -- 'HH:MM:SS' when known. The SSE frame has no start time for a
//              model that was already up when the TUI connected; a server
//              that sends `startedAt` (ms) fixes that (state.js reads it).
export function runningSummary(server, modelUpSince, now = Date.now(), topology = null) {
  const sv = server || {};
  const state = sv.state || 'stopped';
  const cfg = sv.launchConfig || null;
  const active = state !== 'stopped';
  const loading = state === 'starting' || state === 'loading';
  return {
    state,
    active,
    loading,
    model: sv.model ? modelName(sv.model, { ext: false }) : (cfg ? profileModelLabel(cfg) : ''),
    ctx: cfg && !isStrataConfig(cfg) && cfg.ctx != null && Number.isFinite(Number(cfg.ctx)) ? Number(cfg.ctx) : (cfg && cfg.maxContext ? Number(cfg.maxContext) : null),
    cards: cfg ? cardsCell(cfg, topology) : '',
    uptime: state === 'ready' && modelUpSince ? fmtUptime(now - modelUpSince) : null,
    loadingFor: loading && sv.loadStartTime ? Math.max(0, Math.round((now - sv.loadStartTime) / 1000)) : null,
    external: !active && sv.external ? sv.external : null,
  };
}

// What a launch would do beyond starting a server -- each needs the explicit
// second confirmation. Returns [{ kind, text }], kind one of
// 'unavailable' | 'substitute' | 'split' | 'stop' | 'busy' | 'missing' | 'port'.
//   running     -- runningSummary() of the current server (stopped first)
//   busy        -- normalizeBusy() list
//   missingWhy  -- the profile row's missingWhy ('' when the file is known)
//   avail       -- the profile's availability on this machine (profileRow's
//                  `avail`); 'unavailable' only gets here through the explicit
//                  override (O, or the dashboard's own refusal of the launch:
//                  either way the yes sends `allowUnavailable`), 'substitute'
//                  always asks
//   split       -- planSplit() of the launch (a deprecated mode asks)
export function launchRisks({ running, busy = [], missingWhy = '', filePath = '', port = 8080, avail = null, split = null } = {}) {
  const risks = [];
  if (avail && avail.status === 'unavailable') {
    risks.push({ kind: 'unavailable', text: `launch a profile this machine can't run as saved${avail.reason ? ` — ${avail.reason}` : ''}` });
  } else if (avail && avail.status === 'substitute') {
    risks.push({ kind: 'substitute', text: `use a stand-in card${avail.reason ? ` — ${avail.reason}` : ' — not validated on this machine'}` });
  }
  if (split && split.level === 'bad') risks.push({ kind: 'split', text: `probably fail to load — split mode ${split.text}` });
  if (running && running.active) {
    risks.push({
      kind: 'stop',
      text: `stop the running server${running.model ? ` (${running.model}${running.uptime ? `, up ${running.uptime}` : ''})` : ''} first`,
    });
  }
  for (const b of busy) risks.push({ kind: 'busy', text: `take ${busyText(b)}` });
  if (missingWhy) risks.push({ kind: 'missing', text: `probably fail to start — ${missingWhy}${filePath ? `: ${filePath}` : ''}` });
  const ext = running && running.external;
  if (ext && Number(ext.port || 8080) === Number(port || 8080)) {
    risks.push({ kind: 'port', text: `collide with the external llama-server already on :${ext.port || 8080}` });
  }
  return risks;
}
