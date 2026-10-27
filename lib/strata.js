// Strata engine configs (Qwen3.8-Flash-Next IQ3_XXS / coder IQ1_M): the dashboard's launch
// path for the non-llama-server engine. The base configs live in a Strata install directory
// (strata-*.json) and are launched via that install's queue-serve.sh, which raises the locked-memory limit
// and runs serve/server.py --engine strata. Everything the engine takes comes from that JSON
// file -- there is no CLI override -- so a GUI tweak is merged into a COPY of the base config
// written under logs/strata-dashboard/, and the launch command points at that copy. A config
// with no overrides launches the base file as-is (nothing is rewritten).
//
// INSTALLS (2026-10-13). Until now one install directory was written into this file, so a profile pointing at a
// second install (a newer Strata beside the one the benchmark rows run on) was listed nowhere and read as "base
// config not found". The installs are now a list: the STRATA_DIR environment variable (still honoured, first), then
// dashboard.config.json `strataInstalls` -- directories, or { dir, label } -- written with ~ / ${ROOT} if wanted
// (lib/paths.js). No install configured = no Strata on this machine: nothing is listed and nothing is assumed.
//
// MORE OVERRIDES (2026-10-17). The configs the benchmark settled on (0.1.44.1, two XTX: --spec 3 --spec-min-p 0.7,
// --pipeline-windows 2, --resident-budget-gib 40, "gpu": [0, 1] + "layer_split", env STRATA_STAGE_TRIM=1 and
// STRATA_HIP_ADAPT_KERNEL_COPY=1) set things no GUI field could change. They are overrides now, like the rest:
//   pipelineWindows    --pipeline-windows 0..2 (0 is a value: "off"; blank keeps the file's)
//   residentBudgetGib  --resident-budget-gib N (host-RAM budget for the resident expert copy)
//   gpu                the config's "gpu": "0" / "0,1" / [0, 1] (the cards, by the engine's numbering)
//   layerSplit         the config's "layer_split": "auto", or the first layer of each later card ("27", "16,32")
//   stageTrim          'on' / 'off': env STRATA_STAGE_TRIM=1 (each card loads only its own layers' dense weights)
//   kernelCopy         'on' / 'off': env STRATA_HIP_ADAPT_KERNEL_COPY=1 (adaptive swaps copied by a kernel, #884)
// --kv takes what the engine takes (fp16 / int8 / q4_0 / k8v4); the GUI's old "f16" is read as fp16 (the engine
// refuses "f16"). A flag the config's own engine does not have (--pipeline-windows before 0.1.43.1) is refused here,
// with the engine named, instead of a server that exits at start. The THP-off launch of 0.1.44.1 is that install's own
// queue-serve.sh (it execs the server under ./nothp): a config launches through its own install's launcher, and
// `installs()` says which launchers turn THP off.
'use strict';
const fs = require('fs');
const path = require('path');
const pathsModel = require('./paths');

const CONFIG_FILE = path.join(__dirname, '..', 'dashboard.config.json');
const DERIVED_DIR = path.join(__dirname, '..', '..', 'logs', 'strata-dashboard');

// Installs given by a caller (tests; server4.js has no need: the config file is read here, by every process alike).
let configured = null;
let fileCache = { sig: null, list: [] };
function configure(o) { configured = o && Array.isArray(o.installs) ? o.installs : null; fileCache = { sig: null, list: [] }; }

/** "0.1.43.1" from an install: its VERSION file, else the number in its directory name; null when neither says. */
function versionOf(dir) {
    try { const v = fs.readFileSync(path.join(dir, 'VERSION'), 'utf-8').trim().split(/\s+/)[0]; if (/^v?\d+(\.\d+)+/.test(v)) return v.replace(/^v/, ''); } catch { /* no VERSION file */ }
    const m = /(\d+(?:\.\d+)+)[^/]*$/.exec(path.basename(String(dir || '').replace(/\/+$/, '')));
    return m ? m[1] : null;
}

function fromConfigFile() {
    let sig = '-';
    try { const x = fs.statSync(CONFIG_FILE); sig = `${x.mtimeMs}:${x.size}`; } catch { sig = '-'; }
    if (fileCache.sig === sig) return fileCache.list;
    let list = [], ctx = null;
    try { const j = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')); ctx = pathsModel.context(j); if (Array.isArray(j.strataInstalls)) list = j.strataInstalls; } catch { list = []; }
    fileCache = { sig, list: list.map((x) => (typeof x === 'string' ? { dir: x } : x)).filter((x) => x && typeof x.dir === 'string' && x.dir.trim())
        .map((x) => ({ ...x, dir: pathsModel.expand(x.dir.trim(), ctx) })) };
    return fileCache.list;
}

/** The Strata installs of this machine, in order: [{ dir, version, label, serveScript }]. [] = no Strata here. */
function installs({ env = process.env } = {}) {
    const raw = [];
    if (env.STRATA_DIR) raw.push({ dir: env.STRATA_DIR });
    for (const x of (configured ? configured.map((y) => (typeof y === 'string' ? { dir: y } : y)) : fromConfigFile())) if (x && x.dir) raw.push(x);
    const seen = new Set();
    const out = [];
    for (const x of raw) {
        const dir = path.resolve(String(x.dir));
        if (seen.has(dir)) continue; seen.add(dir);
        const version = (typeof x.version === 'string' && x.version.trim()) || versionOf(dir);
        const serveScript = path.join(dir, 'queue-serve.sh');
        out.push({ dir, version: version || null, label: (typeof x.label === 'string' && x.label.trim()) || (version ? `Strata ${version}` : path.basename(dir)), serveScript, thpOff: launcherTurnsThpOff(serveScript) });
    }
    return out;
}
const defaultInstall = () => installs()[0] || null;

/**
 * Does this launcher run the server with transparent huge pages off? 0.1.44.1's queue-serve.sh execs it under
 * `nothp` (prctl PR_SET_THP_DISABLE, inherited by the engine): the fix for the 5-7 minute page-lock starts of
 * 2026-10-16. Read from the script itself (a comment line does not count); false when it is missing or says nothing.
 */
function launcherTurnsThpOff(script) {
    try {
        const text = fs.readFileSync(script, 'utf-8');
        return text.split('\n').some((l) => !/^\s*#/.test(l) && /(^|[\s/])nothp(\s|$)|PR_SET_THP_DISABLE/.test(l));
    } catch { return false; }
}

// The strata-*.json files of one install directory, oldest name first (iq3_xxs, then coder 128k..1m).
function listDir(dir, install = null) {
    try {
        return fs.readdirSync(dir)
            .filter((f) => /^strata-.*\.json$/.test(f))
            .sort()
            .map((f) => {
                // maxContext: so a profile list can show a Strata profile's context without opening the file itself
                let maxContext = null, settings = null;
                try { const c = readConfig(path.join(dir, f)); maxContext = argValue(c, '--max-context') || null; settings = describe(c); } catch { maxContext = null; }
                // install / version: which Strata this config starts (two installs hold a file of the same name)
                // settings: what the file sets for each override field (describe), so a form can show the base's value
                return { path: path.join(dir, f), name: f, maxContext, install: install ? install.dir : dir, version: install ? install.version : versionOf(dir), settings };
            });
    } catch { return []; }
}
// Every base config this machine has: all installs, in their configured order. `dir` lists one directory only.
function listConfigs(dir) {
    if (dir) return listDir(dir);
    return installs().flatMap((i) => listDir(i.dir, i));
}

function readConfig(p) {
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(p, 'utf-8')); } catch (e) { throw new Error(`cannot read ${p}: ${e.message}`); }
    if (!cfg || !Array.isArray(cfg.args)) throw new Error(`not a strata config (no args[]): ${p}`);
    return cfg;
}

// Replace (or append) `--flag value` in the args list. A null/undefined value removes the flag
// and its value. Strata engine args are always `--flag value` pairs, so splicing two is safe.
function setFlag(args, flag, value) {
    const i = args.indexOf(flag);
    if (value === null || value === undefined) {
        if (i !== -1) args.splice(i, 2);
        return;
    }
    if (i === -1) args.push(flag, String(value));
    else args[i + 1] = String(value);
}

function argValue(cfg, flag) {
    const i = cfg.args.indexOf(flag);
    return i === -1 ? null : cfg.args[i + 1];
}

const OVERRIDE_KEYS = ['maxContext', 'kv', 'kvResident', 'ropeScaling', 'ropeScale', 'spec', 'specMinP',
    'pipelineWindows', 'residentBudgetGib', 'gpu', 'layerSplit', 'stageTrim', 'kernelCopy', 'temperature', 'topK', 'topP'];
// What `--kv` takes (the engine refuses anything else: "--kv must be fp16, int8, q4_0 or k8v4"), and the spellings read as one.
const KV_TYPES = ['int8', 'fp16', 'q4_0', 'k8v4'];
const KV_ALIASES = { f16: 'fp16', q4: 'q4_0' };
// The env switches a config may carry, by override key. 'on' writes VAR=1 into the copy's env; 'off' takes it out.
const ENV_TOGGLES = { stageTrim: 'STRATA_STAGE_TRIM', kernelCopy: 'STRATA_HIP_ADAPT_KERNEL_COPY' };
// Override -> the engine flag it writes, for the per-engine check (see engineHas).
const GATED_FLAGS = { pipelineWindows: '--pipeline-windows', residentBudgetGib: '--resident-budget-gib' };

function isPositive(v) {
    if (v === undefined || v === null || v === '') return false;
    const n = Number(v);
    return Number.isFinite(n) && n > 0;
}
const isGiven = (v) => v !== undefined && v !== null && v !== '';
const kvOf = (v) => { const k = String(v).trim().toLowerCase(); return KV_ALIASES[k] || k; };
// 'on' / 'off' / null (keep the file's) from what a form or a CLI sends: on|off, 1|0, true|false, yes|no.
function toggleOf(v) {
    if (v === true || v === 1) return 'on';
    if (v === false || v === 0) return 'off';
    const t = String(v ?? '').trim().toLowerCase();
    if (['on', '1', 'true', 'yes'].includes(t)) return 'on';
    if (['off', '0', 'false', 'no'].includes(t)) return 'off';
    return null;
}
// The cards a `gpu` override names: "0,1" / [0, 1] / 0 -> [0, 1] / [0]; null when it names none or is not a card list.
function gpuListOf(v) {
    if (!isGiven(v)) return null;
    const items = Array.isArray(v) ? v : String(v).split(',');
    const out = items.map((x) => String(x).trim()).filter((x) => x !== '');
    if (!out.length || !out.every((x) => /^\d+$/.test(x))) return null;
    return [...new Set(out.map(Number))];
}
// "auto" or the rising first layers ("27", "16,32"), as the file stores it; null = not given.
function layerSplitOf(v) {
    if (!isGiven(v)) return null;
    const t = Array.isArray(v) ? v.join(',') : String(v).trim();
    return t.toLowerCase() === 'auto' ? 'auto' : t.replace(/\s+/g, '');
}

/**
 * What is wrong with a set of overrides, as sentences ([] = nothing). `base` (the config) lets the layer split be
 * checked against the cards the launch will use. The layer split rule is serve/server.py's layer_split_value:
 * "auto", or one rising number per card after the first, the first one 2 or more.
 */
function overrideProblems(o = {}, base = null) {
    const out = [];
    if (isGiven(o.kv) && !KV_TYPES.includes(kvOf(o.kv))) out.push(`KV type "${o.kv}" is not one the engine takes (${KV_TYPES.join(', ')})`);
    if (isGiven(o.pipelineWindows)) {
        const n = Number(o.pipelineWindows);
        if (!Number.isInteger(n) || n < 0 || n > 2) out.push(`pipeline windows is a mode 0, 1 or 2 (got "${o.pipelineWindows}")`);
    }
    if (isGiven(o.residentBudgetGib) && !isPositive(o.residentBudgetGib)) out.push(`resident budget is a number of GiB above 0 (got "${o.residentBudgetGib}")`);
    if (isGiven(o.gpu) && !gpuListOf(o.gpu)) out.push(`GPUs are card numbers, e.g. "0" or "0,1" (got "${o.gpu}")`);
    for (const k of Object.keys(ENV_TOGGLES)) if (isGiven(o[k]) && !toggleOf(o[k])) out.push(`${k} is on or off (got "${o[k]}")`);
    const ls = layerSplitOf(o.layerSplit);
    if (ls && ls !== 'auto') {
        const vals = ls.split(',').map((x) => (/^\d+$/.test(x) ? Number(x) : NaN));
        const cards = gpuListOf(o.gpu) || (base ? gpuListOf(base.gpu) : null) || [];
        if (vals.some((x) => !Number.isInteger(x)) || vals[0] < 2 || vals.some((x, i) => i > 0 && x <= vals[i - 1])) {
            out.push(`layer split is "auto" or the first layer of each later card, rising from 2 or more (e.g. "27" for two cards, "16,32" for three); got "${o.layerSplit}"`);
        } else if (cards.length > 1 && vals.length !== cards.length - 1) {
            out.push(`layer split "${o.layerSplit}" has ${vals.length} number(s) for ${cards.length} cards (one per card after the first)`);
        }
    }
    return out;
}

function hasOverrides(o) {
    if (!o) return false;
    if (isPositive(o.maxContext)) return true;
    if (o.kv) return true;
    if (isPositive(o.kvResident)) return true;
    if (o.ropeScaling) return true;
    if (isPositive(o.ropeScale)) return true;
    if (isPositive(o.spec)) return true;
    if (isPositive(o.specMinP)) return true;
    if (isGiven(o.pipelineWindows)) return true;
    if (isPositive(o.residentBudgetGib)) return true;
    if (gpuListOf(o.gpu)) return true;
    if (layerSplitOf(o.layerSplit)) return true;
    if (Object.keys(ENV_TOGGLES).some((k) => toggleOf(o[k]))) return true;
    if (o.temperature !== undefined && o.temperature !== null && o.temperature !== '') return true;
    if (o.topK !== undefined && o.topK !== null && o.topK !== '') return true;
    if (o.topP !== undefined && o.topP !== null && o.topP !== '') return true;
    return false;
}

// Merge GUI overrides into a copy of the base config. Anything not given stays exactly as the
// base file has it (context, kv, rope, spec, pipeline windows, cards, env switches, sampling).
function merge(base, o = {}) {
    const cfg = JSON.parse(JSON.stringify(base));
    if (isPositive(o.maxContext)) setFlag(cfg.args, '--max-context', o.maxContext);
    if (o.kv) setFlag(cfg.args, '--kv', kvOf(o.kv));
    if (isPositive(o.kvResident)) setFlag(cfg.args, '--kv-resident', o.kvResident);
    if (o.ropeScaling === 'none') { setFlag(cfg.args, '--rope-scaling', null); setFlag(cfg.args, '--rope-scale', null); }
    else if (o.ropeScaling) {
        setFlag(cfg.args, '--rope-scaling', o.ropeScaling);
        if (isPositive(o.ropeScale)) setFlag(cfg.args, '--rope-scale', o.ropeScale);
    } else if (isPositive(o.ropeScale)) {
        setFlag(cfg.args, '--rope-scale', o.ropeScale);
    }
    if (isPositive(o.spec)) setFlag(cfg.args, '--spec', o.spec);
    if (isPositive(o.specMinP)) setFlag(cfg.args, '--spec-min-p', o.specMinP);
    if (isGiven(o.pipelineWindows)) setFlag(cfg.args, '--pipeline-windows', Number(o.pipelineWindows));
    if (isPositive(o.residentBudgetGib)) setFlag(cfg.args, '--resident-budget-gib', o.residentBudgetGib);
    const gpus = gpuListOf(o.gpu);
    if (gpus) cfg.gpu = gpus.length === 1 ? gpus[0] : gpus;   // the file's own shape: a number for one card, a list for several
    const ls = layerSplitOf(o.layerSplit);
    if (ls) cfg.layer_split = ls;
    for (const [k, envVar] of Object.entries(ENV_TOGGLES)) {
        const t = toggleOf(o[k]);
        if (t === 'on') cfg.env = Object.assign({}, cfg.env, { [envVar]: '1' });
        else if (t === 'off' && cfg.env && envVar in cfg.env) { cfg.env = { ...cfg.env }; delete cfg.env[envVar]; }
    }
    if (o.temperature !== undefined && o.temperature !== null && o.temperature !== '') {
        cfg.sampling = Object.assign({}, cfg.sampling, { temperature: Number(o.temperature) });
    }
    if (o.topK !== undefined && o.topK !== null && o.topK !== '') {
        cfg.sampling = Object.assign({}, cfg.sampling, { top_k: Number(o.topK) });
    }
    if (o.topP !== undefined && o.topP !== null && o.topP !== '') {
        cfg.sampling = Object.assign({}, cfg.sampling, { top_p: Number(o.topP) });
    }
    return cfg;
}

/**
 * What a config file sets for each override field, in the overrides' own names (null where the file sets nothing):
 * for a form's "base" placeholders and a CLI's summary line. Env switches read 'on' / 'off'.
 */
function describe(cfg) {
    const a = (f) => argValue(cfg, f);
    const num = (f) => { const v = a(f); return v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v); };
    const env = (cfg && cfg.env) || {};
    const gpus = gpuListOf(cfg && cfg.gpu);
    return {
        maxContext: num('--max-context'), kv: a('--kv'), kvResident: num('--kv-resident'),
        ropeScaling: a('--rope-scaling'), ropeScale: num('--rope-scale'),
        spec: num('--spec'), specMinP: num('--spec-min-p'),
        pipelineWindows: num('--pipeline-windows'), residentBudgetGib: num('--resident-budget-gib'),
        gpu: gpus ? gpus.join(',') : null, layerSplit: gpus && gpus.length > 1 ? (layerSplitOf(cfg.layer_split) || 'auto') : null,
        stageTrim: env.STRATA_STAGE_TRIM && env.STRATA_STAGE_TRIM !== '0' ? 'on' : 'off',
        kernelCopy: env.STRATA_HIP_ADAPT_KERNEL_COPY && String(env.STRATA_HIP_ADAPT_KERNEL_COPY)[0] === '1' ? 'on' : 'off',
        temperature: cfg && cfg.sampling && cfg.sampling.temperature !== undefined ? cfg.sampling.temperature : null,
        topK: cfg && cfg.sampling && cfg.sampling.top_k !== undefined ? cfg.sampling.top_k : null,
        topP: cfg && cfg.sampling && cfg.sampling.top_p !== undefined ? cfg.sampling.top_p : null,
    };
}

/**
 * A config file's launch settings as DISPLAY facts (2026-10-20, Kyle: the Solve map's "Configs rolled up" card read
 * "launch flags unrecorded" on every Strata config of Flash-Next UD-Q4_K_XL). A Strata run records no llama-server
 * launch command -- the engine takes everything from this JSON file -- so the file is what says how it ran. Only what
 * the file sets; never a path. -> { ctx, kv, kvResident, gpus, layerSplit, spec, specMinP, pipelineWindows,
 * residentBudgetGib, rope, switches: [...], sampling: { temperature, top_p, top_k } | null, backend } (null where unset).
 * Env switches named here are the ones the benchmark's configs carry (lib/models.js STRATA_NEUTRAL says what each does).
 */
const ENV_SWITCHES = [['STRATA_STAGE_TRIM', 'stage trim'], ['STRATA_HIP_ADAPT_KERNEL_COPY', 'kernel copy'], ['STRATA_PROMPT_DIRECT', 'prompt direct'],
    ['STRATA_IO_PREFETCH', 'IO prefetch'], ['STRATA_MTP_PREFILL_SYNC', 'MTP prefill sync']];
function launchFacts(cfg) {
    if (!cfg || !Array.isArray(cfg.args)) return null;
    const d = describe(cfg);
    const env = cfg.env || {};
    const on = (k) => env[k] !== undefined && env[k] !== null && String(env[k]) !== '' && String(env[k]) !== '0';
    const switches = ENV_SWITCHES.filter(([k]) => on(k)).map(([, label]) => label);
    if (env.STRATA_RESIDENT_PIN !== undefined && String(env.STRATA_RESIDENT_PIN) === '0') switches.push('pageable RAM (no pin)');
    const s = cfg.sampling && typeof cfg.sampling === 'object' ? cfg.sampling : null;
    const gpus = gpuListOf(cfg.gpu);
    return {
        ctx: d.maxContext, kv: d.kv, kvResident: d.kvResident, gpus: gpus || null, layerSplit: d.layerSplit,
        spec: d.spec, specMinP: d.specMinP, pipelineWindows: d.pipelineWindows, residentBudgetGib: d.residentBudgetGib,
        rope: d.ropeScaling ? `${d.ropeScaling}${d.ropeScale ? ` ×${d.ropeScale}` : ''}` : null,
        switches,
        sampling: s ? { temperature: s.temperature ?? null, top_p: s.top_p ?? null, top_k: s.top_k ?? null } : null,
        backend: typeof cfg.backend === 'string' ? cfg.backend : null,
    };
}

// Does the engine binary know an option? The way serve/server.py checks for --tail-role-token: the option's text is in
// the file. Read once per binary (by path + size + mtime). null = the binary could not be read (no refusal then).
const engineCache = new Map();
function engineHas(exe, flag) {
    if (!exe) return null;
    let sig;
    try { const st = fs.statSync(exe); sig = `${exe}:${st.size}:${st.mtimeMs}`; } catch { return null; }
    let hit = engineCache.get(sig);
    if (!hit) {
        hit = new Map();
        try {
            const buf = fs.readFileSync(exe);
            for (const f of Object.values(GATED_FLAGS)) hit.set(f, buf.includes(Buffer.from(f)));
        } catch { return null; }
        engineCache.set(sig, hit);
    }
    return hit.has(flag) ? hit.get(flag) : null;
}

// Resolve a launch for a base config + optional overrides. No overrides -> the base file itself
// (the command points at it directly). Overrides -> a merged copy under DERIVED_DIR (named
// <base>.<install version>.dash.json, with its own .dash.log so a tweaked run doesn't interleave into the base
// log) plus the queue-serve.sh command for that copy.
// The launcher script of the Strata install a config belongs to: its own `cwd` (every strata-*.json names its
// install there), else the directory the file sits in, else the first configured install. Until 2026-10-12 every launch used
// the default install's script, which starts THAT version's server whatever engine the config names.
function serveScriptFor(base, basePath) {
    for (const dir of [base && base.cwd, basePath && path.dirname(basePath)]) {
        if (!dir) continue;
        const s = path.join(dir, 'queue-serve.sh');
        try { if (fs.statSync(s).isFile()) return s; } catch { /* next */ }
    }
    const first = defaultInstall();
    if (!first) throw new Error(`no Strata launcher (queue-serve.sh) found for ${basePath || 'this config'}: it is not beside the config, and no Strata install is configured (dashboard.config.json "strataInstalls")`);
    return first.serveScript;
}

/**
 * The GPUs a Strata launch asks for, as the engine counts them (0-based): `--gpu 0,1` on the command line, else the
 * config file's own `gpu` (a number or a list). [] when neither says (the engine then takes its first GPU). Indexes
 * are returned as written -- whether this machine HAS that many cards is the caller's question (server4.js: a config
 * that lists GPU 1 on a one-card machine is refused by the launch gate instead of being run on card 0).
 */
function gpuIndexes(args = [], readFile = (p) => fs.readFileSync(p, 'utf-8')) {
    const list = (args || []).map(String);
    const at = list.lastIndexOf('--gpu');
    let raw = at !== -1 && at + 1 < list.length ? list[at + 1].split(',') : null;
    if (!raw) {
        const cfgPath = list.find((x) => /\.json$/.test(x));
        if (cfgPath) { try { const g = JSON.parse(readFile(cfgPath)).gpu; if (g !== undefined && g !== null) raw = [].concat(g).map(String); } catch { /* unreadable: says nothing */ } }
    }
    return [...new Set((raw || []).map((x) => Number(String(x).trim())).filter((n) => Number.isInteger(n) && n >= 0))];
}

// The arguments the availability check reads a launch's cards from (gpuIndexes): the base file, and a `gpu` override
// as `--gpu` (it wins over the file there, as it does in the copy the launch runs).
function availabilityArgs(cfg) {
    const c = cfg || {};
    const gpus = gpuListOf(c.gpu);
    return [...(c.strataBase ? [c.strataBase] : []), ...(gpus ? ['--gpu', gpus.join(',')] : [])];
}

// A derived copy's name: the base file's, plus its install's version (every install has a strata-iq3_xxs.json, and
// before 2026-10-17 two of them shared one strata-iq3_xxs.dash.json / .dash.log).
function derivedName(basePath, base) {
    const name = path.basename(basePath).replace(/\.json$/, '');
    const dir = (base && base.cwd) || path.dirname(basePath);
    const tag = String(versionOf(dir) || path.basename(String(dir).replace(/\/+$/, '')) || '').replace(/[^A-Za-z0-9._-]+/g, '_');
    return tag ? `${name}.${tag}` : name;
}

function resolveLaunch(basePath, overrides = {}, { outDir = DERIVED_DIR } = {}) {
    if (!basePath) throw new Error('no strata base config given');
    const base = readConfig(basePath);
    const o = overrides || {};
    const problems = overrideProblems(o, base);
    if (problems.length) throw new Error(`Strata overrides for ${path.basename(basePath)}: ${problems.join('; ')}`);
    for (const [k, flag] of Object.entries(GATED_FLAGS)) {
        if (!isGiven(o[k]) || base.args.includes(flag)) continue;
        if (engineHas(base.exe, flag) === false) throw new Error(`${flag} is not an option of this config's engine (${base.exe}); a newer Strata install has it`);
    }
    const port = o.port || base.port || 8080;
    const portFlag = `--port ${port}`;
    const SERVE_SCRIPT = serveScriptFor(base, basePath);   // shadows the default: the config's own install
    if (!hasOverrides(o)) {
        return { config: base, path: basePath, command: `${SERVE_SCRIPT} ${basePath} ${portFlag}`, maxContext: argValue(base, '--max-context') };
    }
    const merged = merge(base, o);
    // Overrides that only repeat the base file's own values (e.g. a profile storing the
    // base's sampling verbatim) change nothing -- launch the base file as-is.
    if (JSON.stringify(merged) === JSON.stringify(base)) {
        return { config: base, path: basePath, command: `${SERVE_SCRIPT} ${basePath} ${portFlag}`, maxContext: argValue(base, '--max-context') };
    }
    const name = derivedName(basePath, base);
    const out = path.join(outDir, `${name}.dash.json`);
    merged.log = path.join(outDir, `${name}.dash.log`);
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(out, JSON.stringify(merged, null, 1) + '\n');
    return { config: merged, path: out, command: `${SERVE_SCRIPT} ${out} ${portFlag}`, maxContext: argValue(merged, '--max-context') };
}

module.exports = { DERIVED_DIR, OVERRIDE_KEYS, KV_TYPES, ENV_TOGGLES, installs, configure, versionOf, listConfigs, readConfig, merge, hasOverrides,
    overrideProblems, describe, launchFacts, resolveLaunch, serveScriptFor, gpuIndexes, availabilityArgs, launcherTurnsThpOff, engineHas };
// The first install, for readers written when there was one (`null` on a machine without Strata).
Object.defineProperty(module.exports, 'STRATA_DIR', { enumerable: true, get: () => { const i = defaultInstall(); return i ? i.dir : null; } });
Object.defineProperty(module.exports, 'SERVE_SCRIPT', { enumerable: true, get: () => { const i = defaultInstall(); return i ? i.serveScript : null; } });
