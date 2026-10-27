// Pure helpers for Launch mode's Strata editor (no ink/React imports -- the
// tests load this directly). 2026-10-17: a Strata-engine profile used to be
// launch-only here ("edit it in the web dashboard"); the settings the
// benchmark's Strata configs use (--spec 3 --spec-min-p 0.7, --pipeline-windows
// 2, --resident-budget-gib, the cards and their layer split, STRATA_STAGE_TRIM /
// STRATA_HIP_ADAPT_KERNEL_COPY) are now fields, the same set the web's Strata
// group has.
//
// A Strata launch is a base config file (one of the strata-*.json files of a
// Strata install, GET /api/strata/configs) plus overrides; the dashboard merges
// them into a copy (lib/strata.js) and launches it through that install's own
// queue-serve.sh. A blank field keeps the base file's value -- which is shown
// next to it, from the config's `settings` in the configs answer.
//
// Two shapes:
//   draft    -- the editor's state: { strataBase, <override key>: string|null }
//               (text as typed; null = keep the base file's value)
//   profile  -- what is saved: the profile's own config with the base and the
//               overrides that are set (numbers as numbers), sampling stored
//               as `temp` / `topK` / `topP` like every other profile; keys it
//               already had (tuningNote, needs, port, ...) are kept, the web's
//               rawCommand is not (profiles.js saveProfile drops it anyway).

// [key, label, kind, options?]. kinds: base (config picker), num (whole
// number), float, text, choice (fixed list; '' = keep the base file's value).
export const STRATA_FIELDS = [
  ['strataBase', 'Base config', 'base'],
  ['maxContext', 'Max context', 'num'],
  ['kv', 'KV type', 'choice', [['int8', 'INT8 K and V'], ['fp16', '16-bit float'], ['q4_0', '4-bit, rotated'], ['k8v4', 'INT8 K + rotated Q4_0 V']]],
  ['kvResident', 'KV resident', 'num'],
  ['spec', 'Spec n', 'num'],
  ['specMinP', 'Spec min-p', 'float'],
  ['pipelineWindows', 'Pipeline win.', 'choice', [['0', 'off'], ['1', 'short prompt reads only'], ['2', 'next verify window on the first card (two-card configs)']]],
  ['residentBudgetGib', 'Resident GiB', 'float'],
  ['gpu', 'GPUs', 'text'],
  ['layerSplit', 'Layer split', 'text'],
  ['stageTrim', 'Stage trim', 'choice', [['on', 'STRATA_STAGE_TRIM=1'], ['off', 'not set']]],
  ['kernelCopy', 'Kernel copy', 'choice', [['on', 'STRATA_HIP_ADAPT_KERNEL_COPY=1 (#884)'], ['off', 'not set']]],
  ['ropeScaling', 'RoPE scaling', 'choice', [['yarn', 'context extension'], ['none', 'remove it from the file']]],
  ['ropeScale', 'RoPE scale', 'float'],
  ['temp', 'Temp', 'float'],
  ['topK', 'Top-k', 'num'],
  ['topP', 'Top-p', 'float'],
];

// The override keys of a profile, in the server's names (lib/strata.js
// OVERRIDE_KEYS less the sampling three, which profiles store as temp/topK/topP).
export const STRATA_PROFILE_KEYS = STRATA_FIELDS.map(([k]) => k).filter((k) => k !== 'strataBase');

const NUM_RANGES = {
  maxContext: [1, 1e8], kvResident: [1, 1e8], spec: [1, 64], specMinP: [0, 1], residentBudgetGib: [0.5, 4096],
  ropeScale: [0.01, 1024], temp: [0, 100], topK: [0, 1e6], topP: [0, 1],
};

export const fieldKind = (key) => (STRATA_FIELDS.find(([k]) => k === key) || [])[2] || 'text';
export const fieldLabel = (key) => (STRATA_FIELDS.find(([k]) => k === key) || [])[1] || key;
export const fieldChoices = (key) => (STRATA_FIELDS.find(([k]) => k === key) || [])[3] || [];

const blank = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

// profile config -> draft. `temperature` (what the web form saves) counts as
// `temp`; a legacy "f16" KV is the engine's fp16.
export function strataDraft(cfg) {
  const c = cfg || {};
  const d = { strataBase: typeof c.strataBase === 'string' ? c.strataBase : '' };
  for (const k of STRATA_PROFILE_KEYS) {
    let v = k === 'temp' ? (c.temp ?? c.temperature) : c[k];
    if (k === 'gpu' && Array.isArray(v)) v = v.join(',');
    if (k === 'kv' && v === 'f16') v = 'fp16';
    d[k] = blank(v) ? null : String(v);
  }
  return d;
}

// draft -> the config saved as the profile: `original` (the profile as
// loaded) with the base and every field written over it; a blank field removes
// its key, so "keep the base file's value" is what is saved. engine is always
// strata; rawCommand never rides along.
export function strataDraftToConfig(draft, original = {}) {
  const { rawCommand, temperature, ...keep } = original || {};
  const out = { ...keep, engine: 'strata', strataBase: (draft && draft.strataBase) || '' };
  for (const k of STRATA_PROFILE_KEYS) {
    const v = draft ? draft[k] : null;
    if (blank(v)) { delete out[k]; continue; }
    const kind = fieldKind(k);
    out[k] = kind === 'num' || kind === 'float' || k === 'pipelineWindows' ? Number(v) : String(v).trim();
  }
  return out;
}

// What the user typed for `key` -> { value } (string, null = blank) or
// { error }. The layer split rule is serve/server.py's (and lib/strata.js
// overrideProblems): "auto", or the first layer of each later card, rising
// from 2 -- the server checks it against the card count when it resolves.
export function commitStrataField(key, text) {
  const t = String(text ?? '').trim();
  if (t === '') return { value: null };
  const kind = fieldKind(key);
  if (kind === 'num' || kind === 'float') {
    const n = Number(t);
    const [lo, hi] = NUM_RANGES[key] || [-Infinity, Infinity];
    if (!Number.isFinite(n) || n < lo || n > hi || (kind === 'num' && !Number.isInteger(n))) {
      return { error: `${fieldLabel(key)} must be a ${kind === 'num' ? 'whole number' : 'number'} from ${lo} to ${hi} (blank = the base config's value)` };
    }
    return { value: String(n) };
  }
  if (key === 'gpu') {
    const parts = t.split(',').map((x) => x.trim());
    if (!parts.every((x) => /^\d+$/.test(x))) return { error: 'GPUs are card numbers as the engine counts them: 0, or 0,1 for both cards' };
    return { value: [...new Set(parts.map(Number))].join(',') };
  }
  if (key === 'layerSplit') {
    if (t.toLowerCase() === 'auto') return { value: 'auto' };
    const vals = t.replace(/\s+/g, '').split(',');
    const nums = vals.map((x) => (/^\d+$/.test(x) ? Number(x) : NaN));
    if (nums.some((x) => !Number.isInteger(x)) || nums[0] < 2 || nums.some((x, i) => i > 0 && x <= nums[i - 1])) {
      return { error: 'Layer split is "auto" or the first layer of each later card, rising from 2 (27 for two cards, 16,32 for three)' };
    }
    return { value: nums.join(',') };
  }
  if (kind === 'choice') {
    const ok = fieldChoices(key).some(([v]) => v === t);
    return ok ? { value: t } : { error: `${fieldLabel(key)} is one of ${fieldChoices(key).map(([v]) => v).join(', ')}` };
  }
  return { value: t };
}

// The configs answer's entry for a base path (null when it is not listed).
export function baseEntry(configs, p) {
  return (configs || []).find((c) => c && c.path === p) || null;
}

// What the base file sets for `key` ('' when it sets nothing / is unknown).
// Sampling is `temperature` / `topK` / `topP` in the server's settings.
export function baseValue(entry, key) {
  const s = entry && entry.settings;
  if (!s) return '';
  const v = s[key === 'temp' ? 'temperature' : key];
  return v === null || v === undefined || v === '' ? '' : String(v);
}

// One field's row text: the value set, else "base: <the file's value>".
export function displayStrataValue(draft, key, entry) {
  if (key === 'strataBase') {
    const p = (draft && draft.strataBase) || '';
    if (!p) return { text: '(none — press Enter to pick)', set: false, missing: true };
    const name = p.split('/').pop().replace(/^strata-/, '').replace(/\.json$/, '');
    return { text: `${name}${entry && entry.version ? `  (Strata ${entry.version})` : ''}`, set: true, missing: !entry };
  }
  const v = draft ? draft[key] : null;
  if (!blank(v)) {
    const ch = fieldChoices(key).find(([c]) => c === v);
    return { text: ch ? `${v} — ${ch[1]}` : String(v), set: true };
  }
  const b = baseValue(entry, key);
  return { text: b ? `base: ${b}` : 'base', set: false };
}

// The install line under the form: which Strata the base belongs to and
// whether its launcher turns THP off (0.1.44.1's queue-serve.sh; the
// server's /api/strata/configs `installs[].thpOff`).
export function installLine(entry, installs = []) {
  if (!entry) return '';
  const list = Array.isArray(installs) ? installs : [];
  const ins = list.find((i) => i && i.dir === entry.install) || null;
  const label = (ins && ins.label) || (entry.version ? `Strata ${entry.version}` : (entry.install || 'Strata'));
  const thp = ins && typeof ins.thpOff === 'boolean' ? (ins.thpOff ? ' — launcher runs the server with THP off' : ' — launcher leaves THP on') : '';
  const older = list.length > 1 && ins && list[0] && list[0].dir !== ins.dir ? ' · not the current install' : '';
  return `${label}${thp}${older}`;
}

// The base-config picker: every listed config, the current install first
// (the server's order), each with its install and context.
export function baseItems(configs, installs = [], current = '') {
  const label = (c) => {
    const ins = (installs || []).find((i) => i && i.dir === c.install);
    return (ins && ins.label) || (c.version ? `Strata ${c.version}` : '');
  };
  const items = (configs || []).filter((c) => c && c.path).map((c) => ({
    label: `${c.name.replace(/^strata-/, '').replace(/\.json$/, '')}`,
    hint: [label(c), c.maxContext ? `${Math.floor(Number(c.maxContext) / 1000)}k` : ''].filter(Boolean).join(' · '),
    value: c.path,
  }));
  if (current && !items.some((i) => i.value === current)) items.unshift({ label: current.split('/').pop(), hint: '(current — not listed by the dashboard)', value: current });
  return items;
}
