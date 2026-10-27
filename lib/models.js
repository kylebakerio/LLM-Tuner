// Models tab: one record per model, assembled from every data source that mentions it.
//
// The hard part is IDENTITY. The same model appears as:
//   a gguf path        /home/kyle/.../Qwen3.8-27B-UD-Q3_K_XL.gguf
//   an opencode id     llama-local/qwen38-27b-q3-64k
//   a claude id        haiku  /  claude-haiku-4-5  /  claude-haiku-4-5-20251001
//   an agy id          gemini-3.8-flash-low
// Getting this wrong SILENTLY MERGES two models, so:
//   - resolution is ordered, and every result records WHY it resolved that way (`via`)
//   - opencode ids that were reused across quants are marked `ambiguous` and never
//     resolve on their own -- they need a battery-dir override
//   - anything unresolved becomes its own pseudo-model; it is never folded into a real one
//   - every raw identifier that folded into a model is kept in `sources`, for the UI
//
// Nothing here spawns a process (no run.py --list / --show: they are python starts and the
// box is usually busy benchmarking). Task metadata is read straight off tasks/*/*/task.yaml.

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const pathsModel = require('./paths');   // ~ and ${ROOT} in dashboard.config.json paths
const weightsId = require('./weightsid'); // content identity of a gguf (2026-10-15): which FILE a row ran on
const tpsModel = require('./tps');         // per-run prefill / generation t/s from the request log (runSpeed, 2026-10-18)
const strataLog = require('./stratalog'); // the same sums from a Strata engine's own log, for runs the request log missed (2026-10-22)
// a context size in words, and a merged row's agent-window note: the one rule each, shared with every page (2026-10-25)
const { ctxLabel, commonWindow } = require('../ui/shared/ctxlabel.js');

const ROOT_DIR = path.join(__dirname, '..', '..');
const DASH_DIR = path.join(__dirname, '..');

const DEFAULT_PATHS = {
    csv: path.join(ROOT_DIR, 'logs', 'benchmarks.csv'),
    benchLog: path.join(ROOT_DIR, 'logs', 'bench-history.log'),
    sweepState: path.join(DASH_DIR, 'sweep-state.json'),
    bestConfigs: path.join(DASH_DIR, 'BEST-CONFIGS.md'),
    dashboardConfig: path.join(DASH_DIR, 'dashboard.config.json'),
    codebenchRoot: path.join(os.homedir(), 'code', 'codebench'),
};

let PATHS = { ...DEFAULT_PATHS };
let codebenchLib = null;                 // lazy: require('./codebench') (read-only use)
let queueLaunchStub;                     // tests: a Map battery -> launch command instead of bench.sqlite's queue_items
function configure(o) {
    PATHS = { ...DEFAULT_PATHS, ...(o && o.paths ? o.paths : {}) };
    queueLaunchStub = o && o.queueLaunch !== undefined ? o.queueLaunch : undefined;
    // A full reset unless a stub is passed: configure({}) is how tests restore defaults, and keeping an
    // earlier test's stub here made later tests see no results and skip themselves (2026-09-29).
    codebenchLib = o && o.codebench !== undefined ? o.codebench : null;
    weightsId.configure({ registry: o && o.weightsRegistry });
    resetCaches();
    return PATHS;
}
function cb() {
    if (codebenchLib === null) codebenchLib = require('./codebench');
    return codebenchLib;
}

// ============================ identity ============================

const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');

// Quant token at the tail of a gguf basename. Deliberately loose: it has to cope with
// Q6_K_XL, UD-Q3_K_XL, IQ1_S, IQ4_NL, Q4_K_L, PTQ1_0 (PrismML ternary), PQ2_0, F16, BF16.
const QUANT_RE = /[-_.](UD-)?((?:I?Q\d+(?:_[0-9A-Za-z]+)*)|(?:PTQ\d+_\d+)|(?:PQ\d+_\d+)|BF16|F16|F32)$/i;
// Multi-part gguf: Qwen3.8-Flash-Next-UD-Q2_K_XL-00001-of-00003.gguf
const SPLIT_RE = /-\d{5}-of-\d{5}$/;

// Org prefixes HF sometimes bakes into the filename (Qwen_Qwen3.6-35B-A3B-Q4_K_M.gguf).
const FAMILY_ALIAS = {
    'qwen-qwen3.6-35b-a3b': 'qwen3.6-35b-a3b',
    'qwen-qwen3.8-27b': 'qwen3.8-27b',
};

/** Split a gguf basename into { family, quant }. Pure; exported for tests. */
function splitGgufName(nameIn) {
    let name = String(nameIn || '').trim();
    name = name.replace(/\\/g, '/');
    if (name.includes('/')) name = name.slice(name.lastIndexOf('/') + 1);
    name = name.replace(/\.gguf$/i, '');
    name = name.replace(SPLIT_RE, '');
    let quant = null;
    const m = QUANT_RE.exec(name);
    if (m) { quant = m[2].toUpperCase(); name = name.slice(0, m.index); }
    let familySlug = slug(name).replace(/_/g, '-');
    if (FAMILY_ALIAS[familySlug]) familySlug = FAMILY_ALIAS[familySlug];
    return { family: name, familySlug, quant };
}

// ---- cloud vocabulary -------------------------------------------------------
// Each entry: canonical slug -> { vendor, display, match: [regexes] }.
// Date suffixes are stripped. EFFORT IS PART OF THE KEY (changed 2026-09-22): it was an axis,
// on the reasoning that haiku is haiku whatever you set thinking to. Measurement says otherwise --
// haiku-4.5 low and medium with the same scaffold fail DIFFERENT tasks, and their solve counts
// differ too. Folding them produced
// a single number for two configurations that behave differently, which is the same confound the
// advisor axis was run to avoid. See effortKey() below.
const CLOUD = [
    { id: 'claude-opus-5', vendor: 'anthropic', display: 'Claude Opus 5',
      match: [/^opus$/i, /^claude-opus-5(\[[^\]]*\])?(-\d{8})?$/i, /^claude-opus-5-1m$/i] },
    // Claude-week models (2026-09-29). Explicit ids only: the bare CLI aliases (sonnet/opus) keep their
    // historical meaning above, since what an alias resolved to on a past date is not recorded.
    { id: 'claude-opus-5-5', vendor: 'anthropic', display: 'Claude Opus 5.5',
      match: [/^claude-opus-5-5(\[[^\]]*\])?(-\d{8})?$/i] },
    { id: 'claude-sonnet-5-5', vendor: 'anthropic', display: 'Claude Sonnet 5.5',
      match: [/^claude-sonnet-5-5(\[[^\]]*\])?(-\d{8})?$/i] },
    { id: 'claude-opus-4-6', vendor: 'anthropic', display: 'Claude Opus 4.6',
      match: [/^claude-opus-4-6(\[[^\]]*\])?(-\d{8})?$/i] },
    { id: 'claude-sonnet-4-5', vendor: 'anthropic', display: 'Claude Sonnet 4.5',
      match: [/^sonnet$/i, /^claude-sonnet-4-5(-\d{8})?$/i] },
    { id: 'claude-haiku-4-5', vendor: 'anthropic', display: 'Claude Haiku 4.5',
      match: [/^haiku$/i, /^claude-haiku-4-5(-\d{8})?$/i, /^haiku45$/i] },
    // first queued 2026-10-07; without an entry its runs would be filed as "claude-haiku-5-5 (model not recorded)"
    { id: 'claude-haiku-5-5', vendor: 'anthropic', display: 'Claude Haiku 5.5',
      match: [/^claude-haiku-5-5(\[[^\]]*\])?(-\d{8})?$/i] },
    { id: 'claude-fable-5-1', vendor: 'anthropic', display: 'Claude Fable 5.1',
      match: [/^fable$/i, /^claude-fable-5-1(-\d{8})?$/i] },
    { id: 'gemini-3.8-flash', vendor: 'google', display: 'Gemini 3.8 Flash',
      match: [/^gemini-3\.8-flash$/i], effortSuffix: /^gemini-3\.8-flash-(low|medium|high|xhigh|max)$/i },
    { id: 'gemini-3.8-pro', vendor: 'google', display: 'Gemini 3.8 Pro',
      match: [/^gemini-3\.8-pro$/i], effortSuffix: /^gemini-3\.8-pro-(low|medium|high|xhigh|max)$/i },
];

// ---- opencode ids -----------------------------------------------------------
// `target` is a gguf basename. `ambiguous: true` means the SAME id was used for more than
// one underlying model over time -- it resolves only with a battery-dir override, and the
// note says why. This is the landmine the whole module exists to defuse.
const OPENCODE_ALIAS = {
    'swift-27b-64k': { target: 'Swift-Qwen3.8-27B-Q4_K_L.gguf' },
    'qwen38-27b-q3-64k': { target: 'Qwen3.8-27B-UD-Q3_K_XL.gguf' },
    'qwen38-27b-q4-64k': { target: 'Qwen3.8-27B-UD-Q4_K_XL.gguf' },
    'bonsai2-27b-64k': { target: 'Ternary-Bonsai-2-27B-PTQ1_0.gguf' },
    'qwen25-coder-7b-64k': { target: 'qwen2.5-coder-7b-instruct-q4_k_m.gguf' },
    'gemma4-12b-64k': { target: 'gemma-4-12b-it-UD-Q8_K_XL.gguf' },
    'gemma4-26b-a4b-64k': { target: 'gemma-4-26B-A4B-it-UD-Q6_K_XL.gguf', ambiguous: true,
        note: 'two quants (Q6_K_XL / Q8_K_XL) were pulled for this entry; the id does not say which' },
    'qwen3.8-27b-q6': { ambiguous: true,
        note: 'the opencode entry was never renamed: batteries night-q4 / night-q6 / night-abliterated / q4-262k-* all report this id for DIFFERENT weights' },
    'flash-next-32k': { ambiguous: true,
        note: 'used for IQ1_S, IQ4_XS and Q3_K_XL batteries -- the quant lives in the battery dir name, not the id' },
    'flash-next-64k': { ambiguous: true,
        note: 'used for Q2_K_XL batteries and (once) an MTP variant; confirm against the battery dir' },
    'flash-next-128k': { ambiguous: true,
        note: 'used for IQ1_S at 128k; the id carries context, not quant' },
};

// ---- battery-dir overrides --------------------------------------------------
// The authoritative answer for every results/ dir whose result JSONs carry no
// `server.model_path` (the harness only started recording it on 2026-09-21). Written by
// hand from the dir names + BEST-CONFIGS + the run logs. An entry here WINS over every
// heuristic; it is the correction mechanism the brief asks for.
const BATTERY_MODEL = {
    // Qwen3.8-27B dense, the "night-*" and "*-mtp" series (opencode id says q6 for all of them)
    'night-q4': 'Qwen3.8-27B-UD-Q4_K_XL.gguf',
    'night-q4-229k': 'Qwen3.8-27B-UD-Q4_K_XL.gguf',
    'night-q6': 'Qwen3.8-27B-UD-Q6_K_XL.gguf',
    'night-abliterated': 'Huihui-Qwen3.8-27B-abliterated-UD-Q3_K_XL.gguf',
    'q4-262k-f16-mtp': 'Qwen3.8-27B-UD-Q4_K_XL.gguf',
    'q4-262k-f16-mtp-v2': 'Qwen3.8-27B-UD-Q4_K_XL.gguf',
    'q4-262k-f16-mtp-v3': 'Qwen3.8-27B-UD-Q4_K_XL.gguf',
    'q6-131k-q8-mtp': 'Qwen3.8-27B-UD-Q6_K_XL.gguf',
    // Qwen3.8-Flash-Next, quant only in the dir name
    'flash-iq1s-32k': 'Qwen3.8-Flash-Next-UD-IQ1_S.gguf',
    'flash-iq1s-32k-v2': 'Qwen3.8-Flash-Next-UD-IQ1_S.gguf',
    'flash-iq1s-32k-v4': 'Qwen3.8-Flash-Next-UD-IQ1_S.gguf',
    'flash-iq1s-32k-v4-csvfix': 'Qwen3.8-Flash-Next-UD-IQ1_S.gguf',
    'INVALID-flash-iq1s-32k-v3-output-cap-4096': 'Qwen3.8-Flash-Next-UD-IQ1_S.gguf',
    'flash-iq1s-128k': 'Qwen3.8-Flash-Next-UD-IQ1_S.gguf',
    'flash-iq1s-128k-prio1h': 'Qwen3.8-Flash-Next-UD-IQ1_S.gguf',
    'flash-iq4xs-32k': 'Qwen3.8-Flash-Next-UD-IQ4_XS.gguf',
    'flash-q3kxl-32k': 'Qwen3.8-Flash-Next-UD-Q3_K_XL.gguf',
    'flash-q3-cmoe': 'Qwen3.8-Flash-Next-UD-Q3_K_XL.gguf',
    'flash-q2kxl-64k': 'Qwen3.8-Flash-Next-UD-Q2_K_XL.gguf',
    'flash-q2kxl-64k-csvfix': 'Qwen3.8-Flash-Next-UD-Q2_K_XL.gguf',
    'flash-q2kxl-64k-prio1h': 'Qwen3.8-Flash-Next-UD-Q2_K_XL.gguf',
    'flash-q2kxl-64k-prio1h-v2': 'Qwen3.8-Flash-Next-UD-Q2_K_XL.gguf',
    't1-q2kxl-mtp-64k': 'Qwen3.8-Flash-Next-UD-Q2_K_XL.gguf',
    'INVALID-t1-q2kxl-32k-context-overflow': 'Qwen3.8-Flash-Next-UD-Q2_K_XL.gguf',
};

// Quant tokens that appear in battery dir names, for dirs added after this map was written.
// Lower confidence than BATTERY_MODEL: the result is flagged `via: 'dir_heuristic'`.
const DIR_QUANT_HINTS = [
    [/\biq1s\b|iq1_s/i, 'IQ1_S'], [/\biq4xs\b|iq4_xs/i, 'IQ4_XS'],
    [/\bq2kxl\b|q2_k_xl/i, 'Q2_K_XL'], [/\bq3kxl\b|q3_k_xl/i, 'Q3_K_XL'],
    [/\bq4kxl\b|q4_k_xl/i, 'Q4_K_XL'], [/\bq6kxl\b|q6_k_xl/i, 'Q6_K_XL'],
    [/\bq8kxl\b|q8_k_xl/i, 'Q8_K_XL'],
];

// BEST-CONFIGS.md states this explicitly: the `claude` runner with no --model is
// claude-opus-5[1m] at CLI default effort. Recorded with its own `via` so the UI can say so.
const RUNNER_DEFAULT_MODEL = { claude: 'claude-opus-5' };

function cloudLookup(idIn) {
    const id = String(idIn || '').trim();
    if (!id) return null;
    for (const c of CLOUD) {
        for (const re of c.match) if (re.test(id)) return { spec: c, effort: null };
        if (c.effortSuffix) {
            const m = c.effortSuffix.exec(id);
            if (m) return { spec: c, effort: m[1].toLowerCase() };
        }
    }
    return null;
}

function localModel(ggufName, extra) {
    const { family, familySlug, quant } = splitGgufName(ggufName);
    return {
        key: `local:${familySlug}:${slug(quant || 'unknown')}`,
        display: `${family}${quant ? ' ' + quant : ''}`,
        family, familySlug, quant: quant || null,
        provider: 'local', vendor: null, effort: null,
        ambiguous: false, unresolved: false,
        ...extra,
    };
}

function cloudModel(spec, effort, extra) {
    return {
        key: `cloud:${spec.vendor}:${spec.id}`,
        display: spec.display,
        family: spec.display, familySlug: slug(spec.id), quant: null,
        provider: 'cloud', vendor: spec.vendor, effort: effort || null,
        ambiguous: false, unresolved: false,
        ...extra,
    };
}

/**
 * Fold an effort level into a canonical model's identity.
 *
 * Cloud only: a local gguf has no thinking level, and giving one an effort suffix would split a
 * model in two over a field that is always null for it. A cloud row with no recorded effort keeps
 * the bare key rather than being guessed into one of the buckets -- "effort not recorded" is a
 * real third state and the rows that have it predate the runner writing the field.
 */
// Effort tokens in a battery dir name. Only ONE stored battery ever recorded `config.effort`
// (t1-haiku45-medium-64kref); for every other cloud battery the thinking level exists solely in
// the directory someone named. That is weaker evidence than a recorded field, so a model resolved
// this way is flagged `effortVia: 'dir_heuristic'` and the UI says so. Local models are never
// matched -- a gguf has no thinking level, and `flash-iq1s-*` would otherwise read as an effort.
const DIR_EFFORT_HINTS = [
    [/(^|[-_])xhigh([-_]|$)/i, 'xhigh'], [/(^|[-_])max([-_]|$)/i, 'max'],
    [/(^|[-_])high([-_]|$)/i, 'high'], [/(^|[-_])medium([-_]|$)/i, 'medium'],
    [/(^|[-_])low([-_]|$)/i, 'low'],
];
function effortFromDir(dir) {
    for (const [re, e] of DIR_EFFORT_HINTS) if (re.test(dir || '')) return e;
    return null;
}

function withEffort(c, effort, via) {
    const e = (effort || '').trim().toLowerCase();
    if (!c || c.provider !== 'cloud' || !e) return c;
    return { ...c, key: `${c.key}@${e}`, display: `${c.display} (${e})`, effort: e, effortVia: via || 'recorded' };
}

/**
 * Fold the SCAFFOLD into identity too, for the same reason as effort: it is not a detail of how
 * a model was run, it is part of what was run. haiku-4.5-low scored 6/12 solo and 9/12 with a
 * Fable advisor on the same twelve tasks -- averaging those to 7.5/12 describes neither, and the
 * advisor axis was run precisely to separate them.
 *
 * `default` means the CLI's own configuration (which, on this machine, has always included the
 * Fable advisor -- a whole battery once ran with one unnoticed). A battery that recorded no
 * scaffold keeps the bare key: unknown is its own state, not an assumed `default`.
 */
//
// pi's scaffold is NOT folded. It is pi's extension set (none | sol-pi, harness/runners/pi.py), and
// SoL-Pi's reducer runs on the SAME local model: no second model is consulted, so the weights are
// the same weights. "pi" vs "pi + SoL-Pi" is a harness difference, like opencode vs pi, and it is
// kept apart where harnesses are: runDescriptor's harness facet (runner + scaffold), i.e. as two
// configs of one model, never as two models.
const SCAFFOLD_LABEL = { solo: 'solo', default: '+advisor' };
function withScaffold(c, scaffold, runner) {
    const sc = (scaffold || '').trim().toLowerCase();
    // pi's and tau's scaffold is THEIR OWN option (pi: SoL-Pi; tau: its sub-agents), not Claude's advisor: no fold
    // jeff's scaffold is its mode (Jeff on | Jeff on, CPU | plain | nothink: harness/runners/jeff.py), no fold either
    if (!c || !sc || runner === 'pi' || runner === 'tau' || runner === 'jeff') return c;
    const label = SCAFFOLD_LABEL[sc] || sc;
    const sep = /\)$/.test(c.display) ? null : '(';
    return {
        ...c,
        key: `${c.key}/${sc}`,
        display: sep ? `${c.display} (${label})` : c.display.replace(/\)$/, `, ${label})`),
        scaffold: sc,
    };
}

/**
 * LOCAL VARIANTS (Kyle, 2026-10-01): a local gguf run with thinking off, or under another harness (pi,
 * pi + SoL-Pi), gets its OWN row and its own weights key, the way a cloud effort level does. Pooling them
 * dragged Qwen3.8-27B UD-Q4_K_XL down with uncharacteristic thinking-off and pi failures, while Opus's
 * effort levels were never pooled -- and a cloud model can only be compared against a local model's
 * strongest, most robust setup, not a deliberately weakened one. Context, KV type and the other launch
 * facets still separate CONFIGS within a row; only these two axes split rows.
 */
const THINK_OFF = /(?:^|\s)(?:--reasoning|-rea)\s+off(?:\s|$)|enable_thinking["'\\]*\s*:\s*false|(?:^|\s)--reasoning-budget\s+0(?:\s|$)/;
const LOCAL_HARNESS_LABEL = { pi: 'pi', jeff: 'Jeff-Code' };
const LOCAL_SCAFFOLD_LABEL = { 'sol-pi': 'SoL-Pi', 'no-subagents': 'no sub-agents',
    // Jeff-Code's modes: scaffold jeff = Jeff on (its normal mode, no suffix); the others say what differs
    'jeff+cpu': 'Jeff on CPU', plain: 'Jeff off', nothink: 'thinking off, guards' };
/**
 * STRATA VARIANTS (Kyle, 2026-10-07: "make sure the refusal projection test is filed as a separate row").
 * A Strata run records no launch command (the harness reads it from llama-server's /props; Strata's server has
 * none), so every Strata battery of one model file + context had the same, empty launch facets and pooled into
 * one row -- the stock pack together with the same pack run with a refusal-direction projection or with another
 * chat template. What tells them apart is the queue item that launched the battery:
 * `queue-serve.sh <engine dir>/<config>.json` (queueLaunchByBattery below).
 * -> { keys, bits } for withLocalVariant, or null for the stock setup. STOCK is deliberately wide, so the rows
 * that existed keep exactly their runs (most predate the queue and have no item at all): a config name made only
 * of the word "strata", words of the model file's own path (iq3_xxs, coder, orca), a context size (128k, 1m), a
 * KV type (int8, q4) or a memory setting (resident, ram44) is stock -- context already separates configs, and the
 * others were pooled before and change speed, not answers. Anything else in the name is a variant: named in
 * STRATA_VARIANT_LABEL when known, shown as written when not -- an unknown variant gets its own row rather than
 * silently joining the stock one.
 * The ENGINE VERSION is not a variant (Kyle, same day: "engine version not separate for quality, but indeed
 * separate for speed"): each result records it (server.build_info "Strata 0.1.40.3"), which puts it in the
 * `build` facet next to a llama.cpp commit -- off for quality grouping, on for speed, a chip either way.
 */
const STRATA_VARIANT_LABEL = { esp: 'projection on', unslothtpl: 'regular chat template' };
/**
 * SPEED-ONLY NAME PARTS (Kyle, 2026-10-19: "settings that only change speed, not answers, should not split rows"). Each
 * was checked against Strata 0.1.44.1's docs and the config files that carry the name:
 *   2xtx, 2gpu, split, auto   both cards with `"gpu": [0, 1]` and `"layer_split": "auto"`: placement (docs/MULTI_GPU.md)
 *   pw<N>     `--pipeline-windows N`: "the last card only ever runs windows that are verified ... the tokens are the
 *             serial loop's" (MULTI_GPU.md). The pw2-kcopy configs also set STRATA_STAGE_TRIM=1, which only moves experts
 *             between devices
 *   kcopy     STRATA_HIP_ADAPT_KERNEL_COPY=1: the adaptive tier's swaps copied by a kernel instead of the SDMA engine
 *             (docs/AMD_HIP.md)
 *   rb<N>     `--resident-budget-gib N`: how much of the experts stays in RAM, the rest read from the SSD (UNSLOTH_Q4.md)
 *   nopin     STRATA_RESIDENT_PIN=0: pageable instead of page-locked RAM, so the CPU computes every expert miss
 *   spec<N>   `--spec N` (with `--spec-min-p`): how many MTP drafts one checking pass holds. Every config has drafting on
 *             (the stock ones `--spec 4 --spec-min-p 0.5`); under sampling "the engine keeps a draft only when it equals
 *             the token the model sampled for that position" (DETAILS.md, "Sampled drafting"), so the drafts set the
 *             speed and the model's own sample sets every token. None of these configs sets the opt-in
 *             STRATA_SPEC_PROB / STRATA_SPEC_COUPLED / STRATA_SPEC_GUMBEL
 *   pdirect   STRATA_PROMPT_DIRECT: how the prompt is fed in (speed only; added 2026-10-19 for queue items 1192/1193)
 *   iopf      STRATA_IO_PREFETCH: SSD expert reads prefetched ahead of use (speed only; same day)
 *   pf<N>     `--prefill N`: the prompt is read in chunks of N tokens instead of `auto` (8192 on a split). Only how many
 *             passes a long prompt takes and how much of the expert cache the prompt path borrows (generate.cpp
 *             part_slots); added 2026-10-22 so the UD-Q4_K_XL lend fits its RAM copy (Kyle: "no experts should be on nvme")
 *   mtpfirst  STRATA_MTP_STAGE0=1: the MTP draft layer runs on the first card of a two-card split instead of the last.
 *             "Same tokens" (docs/MULTI_GPU.md, "Where the draft layer sits"); default on gfx12, off on gfx1100 (2026-10-22)
 *   cpushare  STRATA_PREFILL_CPU_SHARE=auto: while a prompt chunk is read, the idle decode CPU pool computes the experts few of its
 *             tokens route to, from RAM, instead of streaming them to the GPU (src/prefill/prefill.cpp). Rounding only (the CPU
 *             rounds differently, as the rest of this list); off by default on HIP and on a layer split (2026-10-22)
 * What these change besides speed is rounding: which experts run on a GPU and which on the CPU, and how many tokens share
 * an expert in a window, "round differently" (DETAILS.md), so a near-tie can flip. Kyle counts that as speed-only.
 * NOT here, so still a row of their own: yarn<N> (rope scaling), esp (refusal-direction projection), unslothtpl (chat
 * template), loweffort, and the parts no queued config carries yet (split27, trim, pffused, peer, helper ...): a part
 * nobody checked keeps its own row, as before.
 */
const STRATA_NEUTRAL = /^(?:strata|dash|\d+(?:k|m)|int8|q4|q8|f16|resident|ram\d+|2xtx|2gpu|split|auto|pw\d+|kcopy|rb\d+|nopin|spec\d+|pdirect|iopf|pf\d+|mtpfirst|cpushare)$/;
/**
 * THE ENGINE, where both engines serve the same file (2026-10-19). With the speed-only parts above neutral, a Strata run
 * of Unsloth's UD-IQ4_XS would have had no part left and joined the llama.cpp UD-IQ4_XS row, which the 2xtx part had kept
 * apart until then. They are not the same setup: Strata samples at the config's temperature 1.0 / top_p 0.95 / top_k 20
 * with int8 KV, the llama.cpp launches send no sampling flags (llama-server's defaults) with q8_0 KV. So a Strata run of
 * an Unsloth UD file (the GGUFs llama.cpp runs here; Strata reads them with --native, docs/UNSLOTH_Q4.md) carries the
 * part `strata`. Strata's own GSQ-RCO packs and the other Strata-only files keep the rows they have, so no existing row
 * changes key for this. Decided from the run alone (its model file and its launch), so a running battery, a stored one
 * and the planner (lib/configid.js) all land on the same row.
 */
const STRATA_SHARED_WEIGHTS = /(?:^|[-_.])UD-/i;
const STRATA_QUEUE = /\/Strata[^/\s]*\/queue-serve\.sh/;
/** The Strata config a queue item launched (`queue-serve.sh <dir>/<config>.json`), as its base name; null when the command
 *  is not a Strata launch. A dashboard-derived copy (lib/strata.js): `<base>.<install version>.dash.json` since 2026-10-17,
 *  `<base>.dash.json` before -- the version's digits are not part of the name (they would read as tokens "0", "1", "44"). */
function strataLaunchName(queueCmd) {
    const cmd = String(queueCmd || '');
    if (!STRATA_QUEUE.test(cmd)) return null;
    return ((/([\w.-]+)\.json(?:\s|$)/.exec(cmd) || [])[1] || '').replace(/(?:\.\d+(?:\.\d+)*)?\.dash$/, '') || null;
}
/**
 * HOW A STRATA BATTERY WAS LAUNCHED, for display (2026-10-20, Kyle: hovering the Solve map's Flash-Next Q4_K_XL (Strata)
 * row, its "Configs rolled up" read "launch flags not recorded" on almost every line). By design a Strata run carries no
 * launch_command (describeRunning / lib/configid.js delete it, and runDescriptor then keys the battery on its own dir):
 * its launch is `queue-serve.sh <config>.json`, and the config FILE is what says how it ran. This reads that file -- the
 * exact one the queue item named, a dashboard-derived copy (GUI overrides) included -- and never touches the row's
 * identity, launchUnknown or launchCommand (lib/tps.js matches requests to a run by its exact launch command).
 * -> { engine ("Strata 0.1.44.1" | null), config ("<base>.json" | null), derived (a .dash.json copy), file ('read' |
 *    'missing' | 'not recorded'), facts (lib/strata.js launchFacts | null), editedSince (the file was written after
 *    `ranAt`, ms: its settings are as it reads NOW, possibly not as it ran -- 4 batteries of 2026-10-01 on the real
 *    data) }, or null for a run that is not Strata. No path is kept (only the file's base name).
 */
const strataFileCache = new Map();   // path -> { sig, facts, mtimeMs }
function strataConfigFacts(p) {
    let sig, mtimeMs;
    try { const st = fs.statSync(p); sig = `${st.mtimeMs}:${st.size}`; mtimeMs = st.mtimeMs; } catch { return null; }
    const hit = strataFileCache.get(p);
    if (hit && hit.sig === sig) return hit;
    let facts = null;
    try { const S = require('./strata'); facts = S.launchFacts(S.readConfig(p)); } catch { facts = null; }
    const v = { sig, facts, mtimeMs };
    strataFileCache.set(p, v);
    return v;
}
/** The Strata config file a queue item launched (its full path), or null when the command is not a Strata launch. */
function strataConfigPath(queueCmd) {
    const cmd = String(queueCmd || '').replace(/\s+#row-variant=\S+\s*$/, '');
    return STRATA_QUEUE.test(cmd) ? (/(\S+\.json)(?:\s|$)/.exec(cmd) || [])[1] || null : null;
}
function strataLaunchInfo(queueCmd, srv, ranAt) {
    const cmd = String(queueCmd || '').replace(/\s+#row-variant=\S+\s*$/, '');
    const buildInfo = String((srv && srv.build_info) || '');
    const viaQueue = STRATA_QUEUE.test(cmd);
    if (!viaQueue && !/^Strata\b/.test(buildInfo)) return null;
    const engine = /^Strata\b/.test(buildInfo) ? buildInfo : null;
    const name = viaQueue ? strataLaunchName(cmd) : null;
    const p = strataConfigPath(cmd);
    const rec = p ? strataConfigFacts(p) : null;
    const facts = rec ? rec.facts : null;
    return { engine, config: name ? `${name}.json` : null, derived: !!(p && /\.dash\.json$/.test(p)),
        file: !p ? 'not recorded' : facts ? 'read' : 'missing', facts,
        editedSince: !!(facts && Number(ranAt) > 0 && rec.mtimeMs > Number(ranAt)) };
}
function strataVariant(run, queueCmd) {
    const srv = (run && run.server) || {};
    const viaQueue = STRATA_QUEUE.test(String(queueCmd || ''));
    if (!viaQueue && !/^Strata\b/.test(String(srv.build_info || ''))) return null;   // not Strata
    const keys = [], bits = [];
    if (STRATA_SHARED_WEIGHTS.test(String(srv.model_path || '').split('/').pop())) { keys.push('strata'); bits.push('Strata'); }
    const cfgName = strataLaunchName(queueCmd) || '';
    const own = new Set(String(srv.model_path || '').toLowerCase().split(/[\/.-]+/));
    for (const t of cfgName.toLowerCase().split(/[-.]+/)) {
        if (!t || STRATA_NEUTRAL.test(t) || own.has(t) || keys.includes(t)) continue;
        keys.push(t); bits.push(STRATA_VARIANT_LABEL[t] || t);
    }
    return keys.length ? { keys, bits } : null;
}
/** battery dir -> the launch command of the queue item that produced it (bench.sqlite queue_items: label or
 *  basename(result_dir); the expanded command the runner recorded when it has one). Read-only, once per index
 *  build; an empty map when the database is not this machine's (fixture tests) or cannot be read. */
function queueLaunchByBattery() {
    if (queueLaunchStub !== undefined) return queueLaunchStub || new Map();
    const out = new Map();
    if (PATHS.codebenchRoot !== DEFAULT_PATHS.codebenchRoot) return out;
    try {
        const Database = require('better-sqlite3');
        const ro = new Database(require('./db').DB_PATH, { readonly: true, fileMustExist: true });
        try {
            for (const r of ro.prepare('SELECT label, result_dir, launch_cmd, outcome_json, env_json FROM queue_items WHERE launch_cmd IS NOT NULL ORDER BY id').all()) {
                let cmd = null; try { cmd = JSON.parse(r.outcome_json || '{}').launch_expanded || null; } catch { cmd = null; }
                const battery = r.result_dir ? String(r.result_dir).split('/').pop() : r.label;
                // CODEBENCH_ROW_VARIANT in the item's env: an experiment that must be its own row (rowVariant below).
                // Carried as a trailing marker on the command, so every reader of this map sees it.
                let rv = ''; try { rv = String((JSON.parse(r.env_json || '{}') || {}).CODEBENCH_ROW_VARIANT || '').trim(); } catch { rv = ''; }
                if (battery) out.set(battery, (cmd || r.launch_cmd) + (/^[\w.-]+$/.test(rv) ? ` #row-variant=${rv}` : ''));
            }
        } finally { ro.close(); }
    } catch { /* no database: every Strata battery is the stock one, as before */ }
    return out;
}
const HELPER_LABEL = { 'qwen3.8-27b-gsq-rco-iq2-xs': 'Qwen3.8-27B GSQ-RCO IQ2_XS',
    'qwen3.8-27b-ud-q8-k-xl': 'Qwen3.8-27B UD-Q8_K_XL', 'qwen3.8-27b-ud-q4-k-xl': 'Qwen3.8-27B UD-Q4_K_XL' };
/**
 * ROW VARIANTS BY DECLARATION (Kyle, 2026-10-10: the large-context and sub-agent composite runs "would be their own
 * 'row'"). Context and the opencode agent config are facets INSIDE a row, so such a run would pool into the model's
 * main row and its composite passes or fails would be averaged with the standard setup's. A queue item that sets
 * CODEBENCH_ROW_VARIANT=<slug> in its env files its battery under `<model>~rv:<slug>` instead: an experiment's own
 * row, named from ROW_VARIANT_LABEL (shown as written when the slug is new).
 */
const ROW_VARIANT_LABEL = { subagents: 'sub-agents reminder in the system prompt', ctx229k: '229k context', ctx197k: '197k context', ctx1m: '1M context',
    'review-fn-iq3xxs': "reviewing Strata Flash-Next IQ3_XXS's work", 'review-fn-iq1m': "reviewing Strata Flash-Next coder IQ1_M's work", taskfile: 'task kept in a file',
    'review-swift': "reviewing Swift-Qwen3.8-27B Q4_K_L's work" };
function rowVariant(queueCmd) {
    const m = /(?:^|\s)#row-variant=([\w.-]+)\s*$/.exec(String(queueCmd || ''));
    return m ? { key: 'rv:' + m[1].toLowerCase(), bit: ROW_VARIANT_LABEL[m[1].toLowerCase()] || m[1] } : null;
}
function withLocalVariant(c, run, scaffold, queueCmd) {
    if (!c || c.provider !== 'local') return c;
    const cfg = run.config || {}, srv = run.server || {};
    const bits = [], keys = [];
    if (THINK_OFF.test(String(srv.launch_command || ''))) { bits.push('thinking off'); keys.push('nothink'); }
    const sv = strataVariant(run, queueCmd);
    if (sv) { bits.push(...sv.bits); keys.push(...sv.keys); }
    // TWO MODELS IN ONE HARNESS (Kyle, 2026-10-09: "a UNIQUE row per COMBINATION of models, they are NOT flash-next rows").
    // sweeps/dual-serve.sh starts a helper model beside the main one; the helper is named by `--helper <id>` or is the
    // wrapper's default (the 27B GSQ-RCO IQ2_XS on the 3060). Blocking vs background delegation is a prompt variant
    // (L2+helper / L2+helper-bg): two configs inside the combination's row.
    const hv = /\/dual-serve\.sh(?:\s+--helper\s+(\S+))?/.exec(String(queueCmd || ''));
    if (hv) { const h = (hv[1] || 'qwen3.8-27b-gsq-rco-iq2-xs').toLowerCase(); bits.push('+ helper ' + (HELPER_LABEL[h] || h)); keys.push('helper:' + h); }
    // sweeps/swap-serve/swap-serve.sh (2026-10-17): the same pair of models, but on the SAME GPU(s) taking turns (one resident at a
    // time, a model swap per hand-off) instead of one card each. Answers are the pair's; time to solve carries the swaps, so
    // it is its own row next to the side-by-side one. The helper is always named (`--helper <preset id>`, before the `--`);
    // which card a one-card pair ran on is not part of the row (the preset is the same on either card).
    const sv2 = /\/swap-serve\/swap-serve\.sh\s((?:(?!\s--\s).)*)/.exec(String(queueCmd || ''));
    if (sv2 && !hv) {
        const hm = /(?:^|\s)--helper\s+(\S+)/.exec(' ' + sv2[1]);
        const h = (hm ? hm[1] : 'unnamed').toLowerCase();
        bits.push('+ helper ' + (HELPER_LABEL[h] || h) + ', swapped on the same GPUs'); keys.push('helper:' + h, 'swap');
    }
    const rv = rowVariant(queueCmd);
    if (rv) { bits.push(rv.bit); keys.push(rv.key); }
    const runner = String(cfg.runner || '').toLowerCase();
    if (runner && runner !== 'opencode') {
        const sc = String(scaffold || cfg.scaffold || '').toLowerCase();
        // tau records its sub-agents as scaffold default (on, its normal mode) / solo (off)
        const scBit = runner === 'tau' ? (sc === 'solo' ? 'no-subagents' : '') : (sc && sc !== 'none' && !(runner === 'jeff' && sc === 'jeff') ? sc : '');
        bits.push((LOCAL_HARNESS_LABEL[runner] || runner) + (scBit ? ' + ' + (LOCAL_SCAFFOLD_LABEL[scBit] || scBit) : ''));
        keys.push(runner + (scBit ? '+' + scBit : ''));
    }
    if (!keys.length) return c;
    return { ...c, key: `${c.key}~${keys.join('~')}`, display: `${c.display} (${bits.join(', ')})`, localVariant: bits.join(', ') };
}

/**
 * WEIGHTS FILE (2026-10-15, Kyle: "a different file must not blend"). The key above is the file NAME; two different
 * files with one name (an HF repo that re-uploaded the quant: Qwen3.8-27B-UD-Q6_K_XL.gguf at snapshot fe1e2a2 is LFS
 * sha256 739202..., at 27af057 and 4ca720 it is 701d8fa9...) must not be one row. lib/weightsid.js resolves a path to a
 * CONTENT id (the run's recorded fingerprint, the registry's evidence, or the file on disk); the name's reference file
 * (the newest that still exists) keeps the plain key, and any other VERIFIED file of that name gets `~file:<8 hex>`
 * right after the name part, so the variant suffixes that follow and every fold (tensor-split, f32ssm copies) work
 * as before. A path with no verifiable content (gone, no evidence) is never split off on no evidence: it keeps the
 * plain key, marked `weightsVia: null`. Local only; a no-op without a path.
 */
function withWeightsFile(c, modelPath, recorded) {
    if (!c || c.provider !== 'local' || !modelPath) return c;
    const w = weightsId.weightsIdOf(modelPath, recorded);
    if (!w.id) return { ...c, weightsId: null, weightsVia: null };
    const parts = String(c.key).split('~');
    const ref = weightsId.referenceId(parts[0]);
    if (!ref || ref === w.id) return { ...c, weightsId: w.id, weightsVia: w.via };
    const short = weightsId.shortId(w.id);
    const bit = `other file ${short}`;
    return {
        ...c, key: [parts[0], `file:${short}`, ...parts.slice(1)].join('~'),
        display: /\)$/.test(c.display) ? c.display.replace(/\)$/, `, ${bit})`) : `${c.display} (${bit})`,
        weightsId: w.id, weightsVia: w.via, weightsFile: short,
    };
}

function unresolvedModel(label, why, extra) {
    return {
        key: `unresolved:${slug(label)}`,
        display: `${label} (model not recorded)`,
        family: label, familySlug: slug(label), quant: null,
        provider: 'unknown', vendor: null, effort: null,
        ambiguous: false, unresolved: true, why: why || null,
        ...extra,
    };
}

/**
 * canonicalModel(x) -> stable identity for any identifier shape we have.
 *
 * `x` is either a string (gguf path/basename, opencode id, cloud model id) or an object:
 *   { model_path, model, runner, dir }   -- as carried by a codebench battery summary
 * Returns null only for genuinely empty input.
 *
 * `via` records the winning rule, in priority order:
 *   'model_path' > 'battery_override' > 'dir_heuristic' > 'alias' > 'gguf' > 'cloud'
 *   > 'runner_default' > 'unresolved'
 */
// DISPLAY NAMES (2026-10-07, Kyle: "why do I not see orca anywhere in the solve map?"): a model is named after its
// gguf file, and a file does not always carry the name it goes by -- the Orca packs are "Qwen3.8-27B-Uncensored"
// and "Qwen3.8-Flash-Next-Uncensored". dashboard.config.json `modelDisplayNames` maps a model KEY to its full
// display text, or a FAMILY (as shown, or its slug) to the family's name (the quant is appended). Only the words
// change: key, familySlug and grouping stay, and effort / scaffold / variant suffixes are added after as usual.
let displayNamesCache = { sig: null, map: {} };
// dashboard.config.json as written, re-read when the file changes (its stat is part of catalogSignature()).
let dashConfigCache = { sig: null, cfg: {} };
function dashConfig() {
    let sig = '-';
    try { const x = fs.statSync(PATHS.dashboardConfig); sig = `${PATHS.dashboardConfig}:${x.mtimeMs}:${x.size}`; } catch { sig = '-:' + PATHS.dashboardConfig; }
    if (dashConfigCache.sig === sig) return dashConfigCache.cfg;
    let cfg = {};
    try { const j = JSON.parse(fs.readFileSync(PATHS.dashboardConfig, 'utf-8')); if (j && typeof j === 'object' && !Array.isArray(j)) cfg = j; } catch { cfg = {}; }
    dashConfigCache = { sig, cfg };
    return cfg;
}
function displayNames() {
    const cfg = dashConfig();
    if (displayNamesCache.sig === cfg) return displayNamesCache.map;
    const j = cfg.modelDisplayNames;
    displayNamesCache = { sig: cfg, map: j && typeof j === 'object' && !Array.isArray(j) ? j : {} };
    return displayNamesCache.map;
}
/**
 * INTERNAL ROW VARIANTS (2026-10-13). dashboard.config.json `internalRowVariants: ["plan-only-stage"]` names row
 * variants (the <slug> of `<model>~rv:<slug>`, rowVariant above) whose rows are working material, not results: the
 * first stage of a two-stage experiment writes only a plan and scores as a fail by design. Such a row is left out of
 * the catalog -- so of every board, grid, picker and the public site, which are all built from it -- and is not a
 * peer in another row's relative solve time. Nothing is deleted or re-keyed: the batteries stay under
 * Bench -> codebench, the result files and database rows stay where the second stage reads them.
 */
function internalRowVariants() {
    const list = dashConfig().internalRowVariants;
    return new Set((Array.isArray(list) ? list : []).filter((x) => typeof x === 'string' && /^[\w.-]+$/.test(x.trim())).map((x) => x.trim().toLowerCase()));
}
/** Is this model key an internal row? The variant is one `~`-separated part of the key, not always the last. */
function isInternalRow(key, set = internalRowVariants()) {
    if (!set.size) return false;
    return String(key || '').split('~').some((part) => part.startsWith('rv:') && set.has(part.slice(3).toLowerCase()));
}
function withDisplayName(c) {
    if (!c) return c;
    const names = displayNames();
    const pick = (k) => (k && typeof names[k] === 'string' && names[k].trim() ? names[k].trim() : null);
    const byKey = pick(c.key);
    if (byKey) return { ...c, display: byKey, family: c.quant && byKey.endsWith(` ${c.quant}`) ? byKey.slice(0, -(c.quant.length + 1)) : byKey };
    const byFamily = pick(c.family) || pick(c.familySlug);
    if (byFamily) return { ...c, display: `${byFamily}${c.quant ? ' ' + c.quant : ''}`, family: byFamily };
    return c;
}
function canonicalModel(x) { return withDisplayName(canonicalModelAsFiled(x)); }
function canonicalModelAsFiled(x) {
    if (x == null) return null;
    if (typeof x === 'string') {
        const s = x.trim();
        if (!s) return null;
        // a path or a *.gguf name
        if (/\.gguf(\.|$)/i.test(s) || s.includes('/') && !/^llama-local\//i.test(s)) {
            return localModel(s, { via: 'gguf', raw: s });
        }
        const oc = /^llama-local\/(.+)$/i.exec(s);
        if (oc) {
            const a = OPENCODE_ALIAS[oc[1].toLowerCase()];
            if (a && a.target && !a.ambiguous) return localModel(a.target, { via: 'alias', raw: s });
            if (a && a.ambiguous) {
                const base = a.target ? localModel(a.target, {}) : null;
                return {
                    ...(base || unresolvedModel(oc[1], a.note)),
                    key: base ? base.key : `ambiguous:${slug(oc[1])}`,
                    ambiguous: true, ambiguousNote: a.note, via: 'alias_ambiguous', raw: s,
                    display: base ? base.display : `${oc[1]} (opencode id reused across models)`,
                };
            }
            return unresolvedModel(oc[1], 'unknown opencode entry', { via: 'unresolved', raw: s });
        }
        const c = cloudLookup(s);
        if (c) return cloudModel(c.spec, c.effort, { via: 'cloud', raw: s });
        // Bare name that looks like a gguf family+quant (e.g. from the CSV's model_name column)
        if (QUANT_RE.test(s)) return localModel(s, { via: 'gguf', raw: s });
        return unresolvedModel(s, 'unrecognised identifier', { via: 'unresolved', raw: s });
    }

    const o = x || {};
    const raw = { model_path: o.model_path || null, model: o.model || null, runner: o.runner || null, dir: o.dir || null };

    // 1. the server's own model_path -- the only self-describing source
    if (o.model_path) return { ...localModel(o.model_path, {}), via: 'model_path', raw };

    // 2. explicit battery-dir override
    if (o.dir && BATTERY_MODEL[o.dir]) {
        return { ...localModel(BATTERY_MODEL[o.dir], {}), via: 'battery_override', raw };
    }

    // 3. cloud / opencode id from the harness
    if (o.model) {
        const c = cloudLookup(o.model);
        if (c) return { ...cloudModel(c.spec, c.effort, {}), via: 'cloud', raw };
        const oc = /^llama-local\/(.+)$/i.exec(String(o.model));
        if (oc) {
            const a = OPENCODE_ALIAS[oc[1].toLowerCase()];
            if (a && a.target && !a.ambiguous) return { ...localModel(a.target, {}), via: 'alias', raw };
            // 3b. ambiguous id + a quant token in the dir name: resolvable, but say it was a guess
            if (a && a.ambiguous && o.dir) {
                const famFromAlias = a.target ? splitGgufName(a.target).family : familyGuessFromId(oc[1]);
                for (const [re, q] of DIR_QUANT_HINTS) {
                    if (re.test(o.dir) && famFromAlias) {
                        return { ...localModel(`${famFromAlias}-UD-${q}.gguf`, {}), via: 'dir_heuristic', raw,
                            heuristicNote: `quant "${q}" read out of the battery dir name; the opencode id is ambiguous` };
                    }
                }
            }
            if (a && a.ambiguous) {
                return { ...(a.target ? localModel(a.target, {}) : unresolvedModel(oc[1], a.note)),
                    ambiguous: true, ambiguousNote: a.note, via: 'alias_ambiguous', raw,
                    key: a.target ? `ambiguous:${slug(oc[1])}` : `ambiguous:${slug(oc[1])}`,
                    display: `${oc[1]} — opencode id reused across models`, provider: 'local' };
            }
            return { ...unresolvedModel(oc[1], 'unknown opencode entry'), via: 'unresolved', raw };
        }
        if (QUANT_RE.test(String(o.model)) || /\.gguf$/i.test(String(o.model))) {
            return { ...localModel(o.model, {}), via: 'gguf', raw };
        }
        return { ...unresolvedModel(String(o.model), 'unrecognised model id'), via: 'unresolved', raw };
    }

    // 4. runner default (documented in BEST-CONFIGS for `claude`)
    if (o.runner && RUNNER_DEFAULT_MODEL[o.runner]) {
        const c = cloudLookup(RUNNER_DEFAULT_MODEL[o.runner]);
        return { ...cloudModel(c.spec, null, {}), via: 'runner_default', raw,
            heuristicNote: 'the run recorded no --model; BEST-CONFIGS states the claude runner default is claude-opus-5[1m]' };
    }

    // 5. give up loudly
    return { ...unresolvedModel(o.runner || 'unknown', 'the run recorded neither a model nor a model_path'), via: 'unresolved', raw };
}

function familyGuessFromId(id) {
    if (/flash-next/i.test(id)) return 'Qwen3.8-Flash-Next';
    if (/qwen3\.8-27b|qwen38-27b/i.test(id)) return 'Qwen3.8-27B';
    return null;
}

// ============================ launch-flag parsing ============================

/**
 * Loose flag reader over a llama-server / llama-bench command line (or a BEST-CONFIGS
 * flag block). Everything is optional; unknown flags are ignored, never fatal.
 */
// Memoised by command string (2026-10-06): the catalog re-parsed the launch command of every logged request --
// 44,418 requests, 424 distinct strings, ~20 regexes each -- on EVERY open of the Models page (750 ms of a ~1 s
// request). Callers assign into the result (f.ctx = ...), so each call gets its own copy.
const parseFlagsMemo = new Map();
function parseFlags(cmdIn) {
    const key = String(cmdIn || '');
    let hit = parseFlagsMemo.get(key);
    if (!hit) {
        hit = parseFlagsUncached(key);
        if (parseFlagsMemo.size > 4000) parseFlagsMemo.clear();
        parseFlagsMemo.set(key, hit);
    }
    const out = { ...hit };
    for (const k of Object.keys(out)) if (Array.isArray(out[k])) out[k] = out[k].slice();
    return out;
}
function parseFlagsUncached(cmdIn) {
    const cmd = String(cmdIn || '');
    // Launch commands come from a textarea as often as from argv, so a value can arrive
    // quoted ("-dev 'CUDA0,ROCm0'"). Unquote, or the same config reads as two configs.
    const unq = (s) => (s == null ? null : String(s).replace(/^['"]|['"]$/g, ''));
    const one = (re) => { const m = re.exec(cmd); return m ? unq(m[1]) : null; };
    const numOr = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
    const binary = one(/(^|\s)(\/\S*llama-(?:server|bench))(?=\s|$)/) || (/(\/\S*llama-(?:server|bench))/.exec(cmd) || [])[1] || null;
    return {
        binary,
        buildDir: binary ? (binary.replace(/\/bin\/llama-(server|bench)$/, '').split('/').slice(-2).join('/') || null) : null,
        modelPath: one(/(?:^|\s)-m\s+(\S+)/),
        devices: one(/(?:^|\s)-dev\s+(\S+)/),
        ts: one(/(?:^|\s)-ts\s+(\S+)/),
        ctx: numOr(one(/(?:^|\s)-c\s+(\d+)/)),
        ngl: numOr(one(/(?:^|\s)(?:-ngl|--n-gpu-layers)\s+(\d+)/)),
        kvK: one(/--cache-type-k\s+(\S+)/),
        kvV: one(/--cache-type-v\s+(\S+)/),
        ncmoe: numOr(one(/(?:^|\s)(?:-ncmoe|--n-cpu-moe)\s+(\d+)/)),
        ot: one(/(?:^|\s)-ot\s+'([^']+)'/) || one(/(?:^|\s)-ot\s+(\S+)/),
        specType: one(/--spec-type\s+(\S+)/),
        specDraftN: numOr(one(/--spec-draft-n-max\s+(\d+)/)),
        specPMin: numOr(one(/--spec-draft-p-min\s+([\d.]+)/)),
        draftModel: one(/(?:^|\s)-md\s+(\S+)/),
        draftDev: one(/(?:^|\s)-devd\s+(\S+)/),
        fa: /(?:^|\s)-fa(\s+on|\s+1)?(?=\s|$)/.test(cmd) ? true : (/-fa\s+off/.test(cmd) ? false : null),
        splitMode: one(/(?:^|\s)-sm\s+(\S+)/),
    };
}

/** A short, stable label for "which configuration was this". */
function configKey(f) {
    const bits = [];
    if (f.buildDir) bits.push(f.buildDir);
    if (f.devices) bits.push(f.devices);
    if (f.ts) bits.push('ts' + f.ts);
    if (f.ctx) bits.push(ctxLabel(f.ctx));
    if (f.kvK || f.kvV) bits.push('kv' + (f.kvK || '?') + (f.kvV && f.kvV !== f.kvK ? '/' + f.kvV : ''));
    if (f.ncmoe != null) bits.push('ncmoe' + f.ncmoe);
    if (f.specType) bits.push(f.specType + (f.specDraftN != null ? '-n' + f.specDraftN : ''));
    return bits.join(' · ') || 'unlabelled';
}

/**
 * A launch command reduced to the part that defines a CONFIG: the build it ran from and every flag,
 * in a fixed order. Dropped: the weights path (that is the model, not its config) and flags that
 * only change where the server listens or how much it logs. Two runs are the same config only if
 * these strings are identical -- a perfect match, nothing looser.
 */
const NON_CONFIG_FLAGS = new Set(['-m', '--model', '--port', '--host', '-lv', '--log-verbosity', '--log-file', '--metrics', '--verbose', '-v', '--log-colors', '--no-webui', '--slots']);
const NON_CONFIG_BARE = new Set(['--metrics', '--verbose', '-v', '--log-colors', '--no-webui', '--slots']);
function shellSplit(cmd) {
    const out = [];
    const re = /'([^']*)'|"((?:[^"\\]|\\.)*)"|(\S+)/g;
    let m;
    while ((m = re.exec(String(cmd || '')))) out.push(m[1] ?? m[2] ?? m[3]);
    return out;
}
const normalizeLaunchMemo = new Map();   // same reason as parseFlagsMemo; the result is a string (or null)
function normalizeLaunch(cmd) {
    if (!cmd) return null;
    const key = String(cmd);
    if (normalizeLaunchMemo.has(key)) return normalizeLaunchMemo.get(key);
    const v = normalizeLaunchUncached(cmd);
    if (normalizeLaunchMemo.size > 4000) normalizeLaunchMemo.clear();
    normalizeLaunchMemo.set(key, v);
    return v;
}
function normalizeLaunchUncached(cmd) {
    if (!cmd) return null;
    const tok = shellSplit(cmd);
    const f = parseFlags(cmd);
    let i = tok.findIndex((t) => /llama-(server|bench)$/.test(t));
    const pairs = [];
    for (i = i + 1; i < tok.length; i++) {
        const t = tok[i];
        if (!t.startsWith('-')) continue;
        const next = tok[i + 1];
        const hasVal = next != null && !(next.startsWith('-') && !/^-?\d/.test(next));
        if (NON_CONFIG_BARE.has(t) && !hasVal) continue;
        if (NON_CONFIG_FLAGS.has(t)) { if (hasVal) i++; continue; }
        const canon = canonicalFlag(t, hasVal ? next : null);
        if (hasVal) i++;
        if (canon != null) pairs.push(canon);
    }
    pairs.sort();
    return [f.buildDir || '?build', ...pairs].join(' ');
}

/**
 * Every launch flag belongs to exactly one FACET. Each board decides which facets separate two
 * runs and which it folds together (GROUPING below) -- MTP cannot change an answer, so Quality
 * folds it; it changes every timing, so Speed and solve time keep it apart.
 * A flag this table does not know lands in `other`, which every board keeps: an unknown flag
 * could change anything, so it must never be what merges two runs.
 */
const FLAG_FACET = (() => {
    const t = {};
    const put = (facet, names) => { for (const n of names) t[n] = facet; };
    put('context', ['-c', '--ctx-size', '-np', '--parallel']);
    put('output', ['--temp', '--top-k', '--top-p', '--min-p', '--typical', '--presence-penalty', '--repeat-penalty',
        '--frequency-penalty', '--repeat-last-n', '--seed', '--samplers', '--jinja', '--chat-template', '--chat-template-file',
        '--reasoning-preserve', '--reasoning-format', '--reasoning-budget', '--reasoning', '-rea', '--reasoning-effort', '--reasoning-budget-message', '-n', '--n-predict', '--rope-scaling', '--rope-freq-base',
        '--yarn-orig-ctx', '--override-kv', '--mmproj', '--no-mmproj']);
    put('kv', ['--cache-type-k', '--cache-type-v', '-ctk', '-ctv']);
    put('speculative', ['--spec-type', '--spec-draft-n-max', '--spec-draft-n-min', '--spec-draft-p-min', '--spec-draft-device', '-devd',
        '-md', '--model-draft', '--draft', '--draft-max', '--draft-min', '-ngld', '--gpu-layers-draft', '--spec-ngram-size-n',
        '--spec-ngram-size-m', '--spec-ngram-min-hits', '-cd', '--ctx-size-draft']);
    put('placement', ['-dev', '--device', '-ts', '--tensor-split', '-ngl', '--n-gpu-layers', '-ncmoe', '--n-cpu-moe', '-ot',
        '--override-tensor', '-sm', '--split-mode', '-mg', '--main-gpu', '-fa', '--flash-attn', '--mlock', '--no-mmap', '--load-mode', '-lm', '--mmap', '-t',
        '--threads', '-tb', '--threads-batch', '-b', '--batch-size', '-ub', '--ubatch-size', '-fitt', '--fit', '--rpc', '--no-kv-offload', '-nkvo',
        // 2026-10-09: where the MoE experts live and how weights are packed is placement, not a different test. Unclassified,
        // these three put the single-card Flash-Next runs in a row of their own beside the two-card runs of the same setup.
        '-cmoe', '--cpu-moe', '--moe-cache-mib', '--no-repack']);
    return t;
})();

/**
 * One spelling per setting. The same launch arrives as `--spec-draft-device ROCm0 -ts '75,25'` from an
 * LL-Dash profile and `-devd ROCm0 -ts 3,1` from a battery script; unnormalised, those are two
 * "configs" of one config. Long flags map to their short form, a tensor split reduces to its
 * ratio, and a flag given at llama-server's default value is dropped.
 */
const FLAG_ALIAS = {
    '--ctx-size': '-c', '--parallel': '-np', '--n-gpu-layers': '-ngl', '--device': '-dev', '--tensor-split': '-ts',
    '--split-mode': '-sm', '--main-gpu': '-mg', '--flash-attn': '-fa', '--n-cpu-moe': '-ncmoe', '--override-tensor': '-ot',
    '--spec-draft-device': '-devd', '--model-draft': '-md', '--gpu-layers-draft': '-ngld', '--ctx-size-draft': '-cd',
    '-ctk': '--cache-type-k', '-ctv': '--cache-type-v', '--threads': '-t', '--threads-batch': '-tb',
    '--batch-size': '-b', '--ubatch-size': '-ub', '--n-predict': '-n', '--no-kv-offload': '-nkvo',
};
const FLAG_DEFAULT = { '-sm': 'layer', '-np': '1', '--cache-type-k': 'f16', '--cache-type-v': 'f16' };
function canonicalFlag(flag, value) {
    const f = FLAG_ALIAS[flag] || flag;
    let v = value;
    if (v != null) v = String(v).replace(/^['"]|['"]$/g, '');
    if (f === '-ts' && v) {
        const n = v.split(/[,/]/).map(Number);
        if (n.every((x) => Number.isFinite(x) && x > 0)) {
            const gcd = (a, b) => (b ? gcd(b, a % b) : a);
            const ints = n.every(Number.isInteger) ? n : n.map((x) => Math.round(x * 1000));
            const g = ints.reduce(gcd);
            v = ints.map((x) => x / g).join(',');
        }
    }
    if (f === '-fa' && (v == null || v === '1' || v === 'true')) v = 'on';
    if (f === '-fa' && (v === '0' || v === 'false')) v = 'off';
    if (FLAG_DEFAULT[f] != null && v === FLAG_DEFAULT[f]) return null;
    return v == null ? f : `${f} ${v}`;
}

/** Split a launch command into facets: { build, context, output, kv, speculative, placement, other }. */
function launchFacets(cmd) {
    const tok = shellSplit(cmd);
    const f = parseFlags(cmd);
    const facets = { build: f.buildDir || '?build', context: [], output: [], kv: [], speculative: [], placement: [], other: [] };
    let i = tok.findIndex((t) => /llama-(server|bench)$/.test(t));
    for (i = i + 1; i < tok.length; i++) {
        const t = tok[i];
        if (!t.startsWith('-')) continue;
        const next = tok[i + 1];
        const hasVal = next != null && !(next.startsWith('-') && !/^-?\d/.test(next));
        if (NON_CONFIG_FLAGS.has(t)) { if (hasVal && !NON_CONFIG_BARE.has(t)) i++; continue; }
        const canon = canonicalFlag(t, hasVal ? next : null);
        if (hasVal) i++;
        if (canon == null) continue;
        const name = canon.split(' ')[0];
        (facets[FLAG_FACET[name] || FLAG_FACET[t] || 'other']).push(canon);
    }
    for (const k of Object.keys(facets)) if (Array.isArray(facets[k])) facets[k].sort();
    return facets;
}

/**
 * Which facets separate two runs, per board. Anything not listed is folded together.
 *   quality -- solve rate and tokens/solve: what the model was asked, with what context, sampling
 *              and KV precision. MTP, GPU placement and the build do not change an answer.
 *   full    -- everything: speed, solve time, and the model page, where every run that is not a
 *              perfect match of every recorded parameter is its own row.
 */
const GROUPING = {
    quality: ['weights', 'harness', 'context', 'output', 'kv', 'other'],
    full: ['weights', 'harness', 'context', 'output', 'kv', 'other', 'speculative', 'placement', 'build', 'machine', 'served'],
};
const LAUNCH_FACETS = new Set(['context', 'output', 'kv', 'other', 'speculative', 'placement']);

/**
 * Everything recorded about how a codebench battery ran, by facet. `identity(policy)` is the
 * grouping key for one board. A local battery with no trustworthy launch command has unknown
 * launch facets, so under any policy that needs them it cannot be shown to match another run and
 * keys on its own dir.
 */
// A context size in words: ctxLabel(), required above from ui/shared/ctxlabel.js -- the one rule, shared with every page
// (2026-10-25; it lived here for the morning). The catalog carries its result (ctx_label, agentWindow.label / serverLabel).

/**
 * THE CONTEXT A RUN IS FILED UNDER (2026-10-25, Kyle on the Ornith "262k" runs that compacted at a 128k agent window:
 * "I think we just leave it at 128k on the solve map"). The harness decides it (harness/agent_window.py effective_ctx:
 * the server's n_ctx while the agent's window is in step with it; when it is not, the server size that window normally
 * runs on in step -- local-128k's 128000 -> 131072, nominal_ctx -- since ~13:00 10-25: the 128000 of the morning made a
 * row of its own) and records it as `agent_window.effective_ctx` on the result and on the battery config; this reads
 * that value and never re-derives it. No record (every result before 2026-10-25 but the backfilled Ornith ones, cloud
 * runners, a pre-launch spec: the harness puts the alias in step) -> the server's n_ctx, exactly as before.
 * -> { n_ctx, agentWindow } where agentWindow is set only when the run is filed under something other than its server's
 * context: { window, effective_ctx, server_n_ctx, model, compaction_at, action, label, serverLabel } (numbers and the
 * alias: display only, in no key; the key moves through n_ctx and runDescriptor's context flags).
 */
function effectiveContext(c, s) {
    const srv = s && s.n_ctx ? Number(s.n_ctx) || null : null;
    const aw = c && c.agent_window && typeof c.agent_window === 'object' ? c.agent_window : null;
    const eff = aw && Number(aw.effective_ctx) > 0 ? Number(aw.effective_ctx) : null;
    if (!eff || eff === srv) return { n_ctx: srv, agentWindow: null };
    const server = srv || (Number(aw.server_n_ctx) || null);
    return { n_ctx: eff, agentWindow: { window: Number(aw.window) || null, effective_ctx: eff, server_n_ctx: server, model: aw.model || null,
        compaction_at: Number(aw.compaction_at) || null, action: aw.action || null, label: ctxLabel(eff), serverLabel: ctxLabel(server) } };
}

/**
 * FILED AT THE EFFECTIVE SIZE (2026-10-25, Kyle on the two Ornith 128k rows -- local-128k on a 262144 server, local-128k on
 * a 131072 one: "They differ only in the server's size, which the agent never sees"). A run filed under its agent window
 * (effectiveContext's agentWindow) carries `-c <effective>` in its context flags, exactly as an in-step run launched at
 * that size does; any other context flag (-np) stays. The server's own size moves to the placement facet: like a GPU
 * split it changes speed and memory (the 262k server needed -ncmoe 2), never what the agent saw. So the quality row, the
 * Solve map's cell (lib/configid.js cellKey: QUALITY_FACETS) and the schedule key (n_ctx) join the in-step runs, while
 * the speed / `full` rows, which keep placement, still tell the two servers apart. Facets only: the real launch is
 * shown as it ran (launchCommand, launchSummary, the 'full' texts). No agent window, or no launch facets -> unchanged.
 */
function filedFacets(facets, ctx) {
    if (!facets || !ctx || !ctx.agentWindow || !ctx.n_ctx) return facets;
    const server = ctx.agentWindow.server_n_ctx;
    return { ...facets, context: [...facets.context.filter((f) => !/^-c\s/.test(f)), `-c ${ctx.n_ctx}`].sort(),
        placement: [...facets.placement, ...(server ? [`-c ${server}`] : [])].sort() };
}

function runDescriptor(run, provider, modelKey) {
    const c = run.config || {}, s = run.server || {};
    // A recorded command that disagrees with what the server itself reported is someone else's
    // launch (LL-Dash remembers the last server IT started, even after a script restarted the
    // same weights at another context). Unrecorded is honest; that would be wrong.
    const lf = s.launch_command ? parseFlags(s.launch_command) : null;
    const baseName = (x) => String(x || '').split('/').pop();
    const conflict = !!(lf && ((lf.ctx && s.n_ctx && Number(lf.ctx) !== Number(s.n_ctx))
        || (lf.modelPath && s.model_path && baseName(lf.modelPath) !== baseName(s.model_path))));
    const local = provider === 'local';
    const lc = local && !conflict && s.launch_command ? s.launch_command : null;
    // the context this run is filed under: the server's, or -- the harness recorded the agent's window out of step -- the
    // size that window runs on in step. AFTER the conflict check above, which compares the launch -c with what the
    // server reported, not with the window; its launch facets are filed at that size too (filedFacets).
    const ctx = effectiveContext(c, s);
    const facets = lc ? filedFacets(launchFacets(lc), ctx) : null;
    const build = s.build || {};
    const d = {
        weights: modelKey,
        // For a LOCAL run the runner's model id is an opencode/pi ALIAS ("llama-local/local-128k",
        // "llama-local/qwen38-27b-q4-128k", even a misnamed "qwen3.8-27b-q6") -- a label for a context
        // size, not a model: the weights are `weights`. Keeping it split identical configs into separate
        // rows (Kyle, 2026-09-29). A cloud runner's id IS the model, so it stays. prompt_level /
        // harness_mode were not recorded before ~09-20; every run then used prompt.md (L2) agentically.
        // prompt_level here is the prompt VARIANT only, spelled at L2 ('L2', 'L2+careful-tone'): the LEVEL is the
        // problem's (`level` below, problemId), not the config's (2026-10-17). An L3 run is filed in its L2 row.
        harness: { runner: c.runner || null, runnerModel: local ? null : (c.model || null), effort: c.effort || null, scaffold: c.scaffold || null,
            prompt_level: promptWithoutLevel(c.prompt_level), harness_mode: c.harness_mode || 'agentic', timeout_s: c.timeout_s || null },
        // n_ctx: effectiveContext; flags: the launch's, with -c at that size for a run filed under its agent window (the
        // server's own -c is then in `placement`: filedFacets)
        context: { n_ctx: ctx.n_ctx || null, flags: facets ? facets.context : null },
        output: facets ? facets.output : null, kv: facets ? facets.kv : null, other: facets ? facets.other : null,
        speculative: facets ? facets.speculative : null, placement: facets ? facets.placement : null,
        // The llama.cpp build: its commit (build_info) and, when the harness recorded it, the build
        // directory's own fingerprint (backend flags + library identities). Two builds of one
        // commit with different backends are different builds.
        build: local ? { build_info: s.build_info || null, dir: facets ? facets.build : null, fingerprint: build.fingerprint || null } : null,
        // The hardware. Recorded by run.py since 2026-09-24 (CPU, RAM, each GPU with VRAM, driver,
        // power cap and the narrowest PCIe hop). Older runs recorded nothing (not even a host,
        // reliably): they group with each other as "hardware not recorded", never with a run
        // whose hardware was, since it may have changed since.
        // A cloud model behind one name is not one model over time: the provider updates what
        // serves it. The day it served this run is part of what the run measured.
        served: !local && run.ranAt ? new Date(run.ranAt).toISOString().slice(0, 10) : null,
        machine: local ? (s.machine && s.machine.fingerprint
            ? { fingerprint: s.machine.fingerprint }
            : { recorded: false }) : null,
    };
    const launchUnknown = local && !lc;
    const identity = (policy) => {
        const want = GROUPING[policy] || GROUPING.full;
        if (launchUnknown && want.some((f) => LAUNCH_FACETS.has(f))) return JSON.stringify(['UNRECORDED', run.dir]);
        return JSON.stringify(want.map((f) => [f, d[f]]));
    };
    return {
        identity, facets: d, launchUnknown, launchConflict: conflict, launchCommand: lc || s.launch_command || null,
        launchSummary: lc ? configKey(parseFlags(lc)) : null,
        mtp: facets ? facets.speculative.some((x) => /draft-mtp/.test(x)) : null,
        // the run's prompt LEVEL (L1 / L2 / L3): which problem its results answer (problemId), in no identity. lib/configid
        // scheduleKey puts it back: "already ran" compares problems
        level: promptLevelOf(c.prompt_level),
        // flat fields the UI already reads
        runner: d.harness.runner, runnerModel: d.harness.runnerModel, effort: d.harness.effort, scaffold: d.harness.scaffold,
        prompt_level: d.harness.prompt_level, harness_mode: d.harness.harness_mode, timeout_s: d.harness.timeout_s,
        n_ctx: d.context.n_ctx, build_info: s.build_info || null,
        // the context in words (ctxLabel), and -- only for a run filed under its agent window -- what ran (effectiveContext)
        ctx_label: ctxLabel(d.context.n_ctx), ...(ctx.agentWindow ? { agentWindow: ctx.agentWindow } : {}),
    };
}

/**
 * RESIDENCY -- the single biggest lever on local speed, so it is a first-class attribute of a
 * config, not a flag buried in a command string.
 * Measured 2026-09-22 on gemma-4-26B-A4B: fully resident across both cards 66.4 gen / 2378
 * prefill / 16.4 s wall; the SAME model with 12 expert layers pushed to the host 30.6 / 890 /
 * 38.5 s -- 54% of generation and 65% of prefill gone. And splitting a model that already fits
 * on ONE card costs ~30% (12B dense: 43.9-46.5 solo vs 31.3 on the pair), so "use both GPUs" is
 * the intuitive wrong answer. Both facts have to be visible in the row.
 */
function residencyOf(f) {
    if (!f) return null;
    const devices = f.devices ? String(f.devices).split(',').filter(Boolean) : [];
    const otCpu = f.ot && /=\s*CPU\b/i.test(f.ot);
    const off = f.ncmoe != null && f.ncmoe > 0 ? f.ncmoe : (otCpu ? -1 : 0);
    let label;
    if (off > 0) label = `${off} MoE layers on CPU`;
    else if (off === -1) label = 'some tensors on CPU (-ot)';
    else if (devices.length > 1) label = `split across ${devices.length} GPUs`;
    else if (devices.length === 1) label = 'resident on 1 GPU';
    else label = 'unknown';
    return {
        offloadLayers: off > 0 ? off : (off === -1 ? null : 0),
        cpuOffload: off !== 0,
        gpus: devices.length || null,
        devices: f.devices || null,
        label,
        // Sorts worst-last: fully resident on one card first, CPU offload last.
        rank: off !== 0 ? 3 : (devices.length > 1 ? 2 : 1),
    };
}

/**
 * Selection criteria that are NOT benchmark numbers. A board that ranks only t/s cannot say
 * "this config dies under load", so the rows carry the note and the reader decides.
 * What is known about a machine's hardware belongs to that machine: the notes come from dashboard.config.json
 * `reliabilityNotes: [{ id, devicesMatch, note }]` -- `devicesMatch` is a case-insensitive pattern tried on the
 * config's device list ("Vulkan" matches `Vulkan0,Vulkan1`). None are built in (until 2026-10-13 one note about one
 * card was, and was shown for any Vulkan config on any machine).
 */
function reliabilityRules() {
    const list = dashConfig().reliabilityNotes;
    const out = [];
    for (const r of Array.isArray(list) ? list : []) {
        if (!r || typeof r.note !== 'string' || !r.note.trim() || typeof r.devicesMatch !== 'string' || !r.devicesMatch) continue;
        let re; try { re = new RegExp(r.devicesMatch, 'i'); } catch { continue; }
        out.push({ id: r.id || null, test: (f) => !!f && typeof f.devices === 'string' && re.test(f.devices), note: r.note.trim() });
    }
    return out;
}
function reliabilityNotes(f) {
    return reliabilityRules().filter((r) => { try { return r.test(f); } catch { return false; } }).map((r) => r.note);
}

function buildIdFor(binary) {
    if (!binary) return null;
    const cfg = dashConfig();
    const ctx = pathsModel.context(cfg);   // a build path may be written ~/... or ${ROOT}/... (lib/paths.js)
    const dirOf = (p) => String(p || '').replace(/\/bin\/llama-(server|bench)$/, '');
    const want = dirOf(binary);
    for (const b of (Array.isArray(cfg.llamaServerBuilds) ? cfg.llamaServerBuilds : [])) if (b && b.path && dirOf(pathsModel.expand(b.path, ctx)) === want) return b.id;
    return null;
}

// ============================ small stats ============================

const finite = (a) => a.filter((v) => v != null && Number.isFinite(Number(v))).map(Number);
function mean(a) { const n = finite(a); return n.length ? n.reduce((x, y) => x + y, 0) / n.length : null; }
function median(a) {
    const n = finite(a).sort((x, y) => x - y);
    if (!n.length) return null;
    const m = n.length >> 1;
    return n.length % 2 ? n[m] : (n[m - 1] + n[m]) / 2;
}
const sum = (a) => finite(a).reduce((x, y) => x + y, 0);
// Spread across reps, as half the range -- the same +/- the sweep's own note prints. Printing
// 43.9 vs 46.4 without it invites a conclusion the reps may not support (one config here was
// +/-1.0 and another +/-0.1 on the same metric).
function spread(a) {
    const n = finite(a);
    if (n.length < 2) return null;
    return (Math.max(...n) - Math.min(...n)) / 2;
}
// Half-range is only a "+/-" when the values are REPEATS of the same measurement. Over a few
// hundred real requests of wildly different sizes the range is workload variation, not
// measurement noise, so those get a quartile band instead -- half-range there would print a
// +/- four times the median and mean nothing.
function quantile(a, q) {
    const n = finite(a).sort((x, y) => x - y);
    if (!n.length) return null;
    const i = (n.length - 1) * q, lo = Math.floor(i), hi = Math.ceil(i);
    return lo === hi ? n[lo] : n[lo] + (n[hi] - n[lo]) * (i - lo);
}

// Prompt-token buckets for the prefill curve. Log-ish, and the first bucket is the
// cache-hit floor: a "prompt t/s" over <=64 tokens is per-request overhead, not prefill.
const PROMPT_BUCKETS = [64, 256, 1024, 2048, 4096, 8192, 16384, 32768, 65536, 131072, 262144];
function bucketPrompt(n) {
    if (n == null || !Number.isFinite(Number(n))) return null;
    const v = Number(n);
    for (const b of PROMPT_BUCKETS) if (v <= b) return b;
    return PROMPT_BUCKETS[PROMPT_BUCKETS.length - 1] * 2;
}
const COLD_PREFILL_MIN_TOKENS = 64;   // same rule the Bench/History views already use

// ============================ CSV (per-request history) ============================

function splitCsvLine(line) {
    if (!line) return [];
    const cols = []; let field = ''; let q = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (q) {
            if (c === '"') { if (line[i + 1] === '"') { field += '"'; i++; } else q = false; }
            else field += c;
        } else if (c === '"' && field.length === 0) q = true;
        else if (c === ',') { cols.push(field); field = ''; }
        else field += c;
    }
    cols.push(field);
    return cols;
}
const numOrNull = (s) => {
    if (s == null) return null;
    const t = String(s).trim(); if (t === '') return null;
    const n = Number(t); return Number.isFinite(n) ? n : null;
};

let dbCache = { n: -1, last: null, rows: [] };
let csvCache = { sig: null, rows: null };
/** Every completed request logged by logCompletedRequest(), newest last. mtime-cached. */
function readRequests() {
    // SQLite (lib/db.js) is the request record from 2026-09-24; it also holds the imported CSV
    // history. The CSV is read only when the database is unavailable.
    // Only when the request source is the real one: a caller that points PATHS.csv elsewhere (the
    // fixture tests) means that file, not the live database.
    const useDb = PATHS.csv === DEFAULT_PATHS.csv;
    // Ask the table whether it changed (count + highest id: 3 ms) before reading all of it (2026-10-06: the full
    // SELECT of 44k rows cost ~500 ms per index rebuild, only to find nothing new).
    const stamp = useDb ? (() => { try { return require('./db').requestsStamp(); } catch { return null; } })() : null;
    if (stamp && dbCache.rows.length && dbCache.n === stamp.n && dbCache.maxId === stamp.maxId) return dbCache.rows;
    const dbRows = useDb ? (() => { try { return require('./db').readRequests(); } catch { return null; } })() : null;
    if (dbRows && dbRows.length) {
        if (dbCache.n === dbRows.length && dbCache.last === (dbRows[dbRows.length - 1] || {}).id) { if (stamp) dbCache.maxId = stamp.maxId; return dbCache.rows; }
        // What each request's own record says about its hardware (lib/runlabel.js names device ids from it, never
        // from the machine that reads the row): the `machines` row its machine_fp points at, and the device list
        // logged with it. Read with the rows, so the two never disagree about which requests exist.
        const machines = (() => { try { return require('./db').readMachines(); } catch { return null; } })() || new Map();
        const deviceNames = (() => { try { return require('./db').readRequestDeviceNames(); } catch { return null; } })() || new Map();
        const rows = dbRows.map((r) => {
            const t = Date.parse(r.completed_at);
            const cfg = (() => { try { return JSON.parse(r.config_json || 'null') || {}; } catch { return {}; } })();
            return {
                timestamp: r.completed_at, t: Number.isFinite(t) ? t : null, runId: r.csv_run_id,
                modelName: (r.model_path || '').split('/').pop(), modelPath: r.model_path || '', weights: cfg.weights && cfg.weights.id ? { id: String(cfg.weights.id) } : null,
                ctx: r.n_ctx, ngl: numOrNull(cfg.ngl), launchCommand: r.launch_command || '', argString: cfg.argString || '',
                promptTps: r.prefill_tps, genTps: r.gen_tps, promptLatency: r.prompt_latency_s, promptTokens: r.prompt_tokens,
                genTokens: r.gen_tokens, wallTime: r.wall_s, loadTime: null,
                draftAcceptRate: r.draft_accept_rate, aborted: !!r.aborted,
                // Context DEPTH. `ctxDepth` is how full the context was when prefill finished
                // (tokens already there + the new ones) -- the number a prefill rate depends on.
                // Null for rows that never recorded it; those must not be placed on a depth axis.
                depthStart: r.depth_start, depthEnd: r.depth_end, depthSource: r.depth_source || null,
                ctxDepth: r.depth_start != null && r.prompt_tokens != null ? r.depth_start + r.prompt_tokens : null,
                buildFp: r.build_fp || null, machineFp: r.machine_fp || null, source: r.source,
                machine: (r.machine_fp && machines.get(r.machine_fp)) || null, deviceNames: deviceNames.get(r.id) || null,
            };
        });
        dbCache = { n: dbRows.length, last: (dbRows[dbRows.length - 1] || {}).id, rows, maxId: stamp && stamp.n === dbRows.length ? stamp.maxId : null };
        return rows;
    }
    let st;
    try { st = fs.statSync(PATHS.csv); } catch { return []; }
    const sig = `${st.mtimeMs}:${st.size}`;
    if (csvCache.sig === sig) return csvCache.rows;
    let text; try { text = fs.readFileSync(PATHS.csv, 'utf-8'); } catch { return []; }
    const lines = text.trim().split('\n');
    const rows = [];
    for (let i = 1; i < lines.length; i++) {
        const c = splitCsvLine(lines[i]);
        if (c.length < 32) continue;
        const ts = Date.parse(c[0]);
        rows.push({
            timestamp: c[0], t: Number.isFinite(ts) ? ts : null, runId: c[1],
            modelName: c[2], modelPath: c[3],
            ctx: numOrNull(c[4]), ngl: numOrNull(c[5]),
            launchCommand: c[9] || '', argString: c[8] || '',
            promptTps: numOrNull(c[10]), genTps: numOrNull(c[11]),
            promptLatency: numOrNull(c[12]), promptTokens: numOrNull(c[13]),
            genTokens: numOrNull(c[28]), wallTime: numOrNull(c[30]),
            loadTime: numOrNull(c[31]),
            draftAcceptRate: c.length > 33 ? numOrNull(c[33]) : null,
            aborted: c.length > 37 ? c[37] === '1' : false,
        });
    }
    csvCache = { sig, rows };
    return rows;
}

// ============================ sweep-state.json ============================

/** Launch-sweep rows: a label, the exact rawCommand, and per-rep llama-server results. */
function readSweepRows() {
    let s; try { s = JSON.parse(fs.readFileSync(PATHS.sweepState, 'utf-8')); } catch { return []; }
    const out = [];
    for (const r of (s.rows || [])) {
        const cmd = r.rawCommand || (r.config && r.config.rawCommand) || '';
        const f = parseFlags(cmd);
        out.push({
            label: r.label || '', status: r.status || null, error: r.error || null,
            rawCommand: cmd, flags: f, configKey: configKey(f),
            modelRef: f.modelPath || null,
            startedAt: s.startedAt || null,
            results: (r.results || []).map((x) => ({
                promptTps: x.promptTps ?? null, genTps: x.genTps ?? null,
                promptTokens: x.promptTokens ?? null, genTokens: x.genTokens ?? null,
                wallTime: x.wallTime ?? null, draftAcceptRate: x.draftAcceptRate ?? null,
            })),
        });
    }
    return out;
}

// ============================ llama-bench transcript ============================

// logs/bench-history.log is the persisted Bench-tab transcript. Blocks look like:
//   ===== llama-bench 1/3: <label> =====
//   --- <time> ---
//   $ /path/llama-bench -m /path/model.gguf -p 8192 -n 128 -d 8192 ...
//   | model | size | ... | test | t/s |
// The `model` COLUMN is llama.cpp's own description ("qwen3 27B Q4_K - Medium"), not our
// file; identity comes from `-m` on the `$` line.
function parseLlamaBenchLog(text) {
    const lines = String(text || '').split('\n');
    const blocks = [];
    let cur = null;
    const push = () => { if (cur && cur.rows.length) blocks.push(cur); };
    for (const raw of lines) {
        const line = raw.replace(/\s+$/, '');
        if (line.startsWith('===== ')) { push(); cur = { title: line.replace(/=+/g, '').trim(), time: null, cmd: null, flags: null, rows: [], header: null }; continue; }
        if (!cur) cur = { title: '', time: null, cmd: null, flags: null, rows: [], header: null };
        if (/^---\s/.test(line)) { cur.time = line.replace(/---/g, '').trim(); continue; }
        if (line.startsWith('$ ')) {
            const cmd = line.slice(2).trim();
            if (!/llama-bench/.test(cmd)) { cur.skip = true; continue; }
            push();
            cur = { title: cur.title, time: cur.time, cmd, flags: parseFlags(cmd), rows: [], header: null };
            continue;
        }
        if (cur.skip) continue;
        if (/^\s*\|/.test(line)) {
            const cells = line.split('|').slice(1, -1).map((s) => s.trim());
            if (!cells.length) continue;
            if (/^-+$/.test(cells[0].replace(/[: ]/g, '')) || cells.every((c) => /^:?-+:?$/.test(c))) continue;
            if (!cur.header) { cur.header = cells; continue; }
            const rec = {};
            cur.header.forEach((h, i) => { rec[h] = cells[i]; });
            const test = rec.test || rec.Test || '';
            const tps = numOrNull(String(rec['t/s'] || '').split('±')[0].trim());
            if (!test || tps == null) continue;
            // "pp8192", "tg128", "pp8192 @ d16384"
            const depth = (/@\s*d(\d+)/.exec(test) || [])[1];
            const kind = /^pp/.test(test) ? 'prefill' : (/^tg/.test(test) ? 'gen' : 'other');
            const n = (/^(?:pp|tg)(\d+)/.exec(test) || [])[1];
            cur.rows.push({
                test, kind, n: n ? Number(n) : null, depth: depth ? Number(depth) : 0,
                tps, stddev: numOrNull((String(rec['t/s'] || '').split('±')[1] || '').trim()),
                backend: rec.backend || null, ngl: numOrNull(rec.ngl), raw: rec,
            });
        }
    }
    push();
    return blocks.filter((b) => b.cmd && b.rows.length);
}

let benchLogCache = { sig: null, blocks: null };
function readBenchBlocks() {
    // mtime-cached like the CSV: the transcript is a few hundred KB and buildIndex is called by
    // the overview, three boards and the live baseline poll.
    let st; try { st = fs.statSync(PATHS.benchLog); } catch { return []; }
    const sig = `${st.mtimeMs}:${st.size}`;
    if (benchLogCache.sig === sig) return benchLogCache.blocks;
    let text; try { text = fs.readFileSync(PATHS.benchLog, 'utf-8'); } catch { return []; }
    const blocks = parseLlamaBenchLog(text);
    benchLogCache = { sig, blocks };
    return blocks;
}

// ============================ codebench task metadata ============================

// tasks/<repo>/<id>/task.yaml. A two-key line scan -- no YAML dependency, and no python:
// getTaskInfo()/listTasks() spawn run.py and the box is usually mid-benchmark.
function parseTaskYaml(text) {
    const out = { id: null, tier: null, sample_group: null, category: [] };
    let inCat = false;
    for (const raw of String(text || '').split('\n')) {
        const line = raw.replace(/\s+$/, '');
        if (inCat) {
            const m = /^\s*-\s*(.+)$/.exec(line);
            if (m) { out.category.push(m[1].trim().replace(/^['"]|['"]$/g, '')); continue; }
            inCat = false;
        }
        let m;
        if ((m = /^id:\s*(.+)$/.exec(line))) out.id = m[1].trim().replace(/^['"]|['"]$/g, '');
        else if ((m = /^tier_predicted:\s*(.+)$/.exec(line))) out.tier = m[1].trim().replace(/^['"]|['"]$/g, '');
        else if ((m = /^sample_group:\s*(.+)$/.exec(line))) out.sample_group = m[1].trim().replace(/^['"]|['"]$/g, '');
        // `retired: true` (+ retired_reason): gone from the suite -- never run again, not in the catalog,
        // and its old results are dropped from every fold (codebench run.py load_tasks skips it too)
        else if ((m = /^retired:\s*(.+)$/.exec(line))) out.retired = /^['"]?(true|yes|on|1)['"]?$/i.test(m[1].trim());
        // `hold: true` (+ hold_reason): not run until fixed. Read so a bonus can follow its parent (readTaskMeta).
        else if ((m = /^hold:\s*(.+)$/.exec(line))) out.hold = /^['"]?(true|yes|on|1)['"]?$/i.test(m[1].trim());
        // `extra_tests:` (a list, 2026-10-14): the task has a bonus test, scored as its own result `<id>+bonus`
        else if ((m = /^extra_tests:\s*(.*)$/.exec(line))) out.extra_tests = !/^(\[\s*\]|null|~|false)$/.test(m[1].trim());
        else if (/^category:\s*$/.test(line)) inCat = true;
        else if ((m = /^category:\s*(.+)$/.exec(line))) out.category = m[1].replace(/^\[|\]$/g, '').split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
    }
    if (!out.tier) {
        const t = out.category.find((c) => /^tier-/.test(c));
        if (t) out.tier = t.replace(/^tier-/, '');
    }
    Object.assign(out, parseTaskScalars(text));
    return out;
}

// The short, public description fields the Models tab's task page shows. story / probes /
// weak_model_failure wrap over several lines (plain, quoted or folded scalars), so a one-line
// regex would cut them off. prompt, hidden tests and fix shas are deliberately NOT read here:
// they are the answer key and must never reach the browser.
const TASK_SCALARS = ['variant', 'incident_date', 'timeout_s', 'story', 'probes', 'weak_model_failure', 'retired_reason', 'extra_skill'];
function parseTaskScalars(text) {
    const lines = String(text || '').split('\n');
    const out = {};
    for (let i = 0; i < lines.length; i++) {
        const m = /^([a-z_]+):[ \t]*(.*)$/.exec(lines[i]);
        if (!m || !TASK_SCALARS.includes(m[1])) continue;
        let first = m[2].replace(/\s+$/, '');
        const cont = [];
        // continuation = every following indented (or blank) line, up to the next top-level key
        while (i + 1 < lines.length && (/^\s/.test(lines[i + 1]) || lines[i + 1] === '')) cont.push(lines[++i].trim());
        while (cont.length && cont[cont.length - 1] === '') cont.pop();
        let v;
        if (/^[>|][-+]?$/.test(first)) v = first[0] === '|' ? cont.join('\n') : cont.join(' ').replace(/\s+/g, ' ');
        else {
            v = [first, ...cont].filter((x) => x !== '').join(' ');
            if (/^'.*'$/s.test(v)) v = v.slice(1, -1).replace(/''/g, "'");
            else if (/^".*"$/s.test(v)) v = v.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n').replace(/\\\\/g, '\\');
        }
        v = v.trim();
        if (v) out[m[1]] = m[1] === 'timeout_s' && Number.isFinite(Number(v)) ? Number(v) : v;
    }
    return out;
}

const BONUS_SUFFIX = '+bonus';   // a result's bonus test, as its own task (lib/codebench.js bonusRow)

// ---- PROMPT LEVELS ARE PROBLEMS (2026-10-17) ----
// Kyle: "every different prompt is a different PROBLEM. Now q2 looks stronger than q8 because l3 prompts have been
// attempted by one not the other but the passes and fails of the easy version and hard versions are all mixed up."
// A battery's `prompt_level` is `<level>[+<variant>]` (lib/runlabel.js describeRun splits it the same way). The LEVEL
// (L1 / L2 / L3: which prompt file the model was given) is part of WHAT was asked: a result of task T at L3 is the
// problem `T@L3`, with its own difficulty, strength points, grid column and task page. L2, or no level recorded (every
// run before ~09-20 used prompt.md), is T itself. A bonus test at L3 is `T@L3+bonus`, the bonus of problem T@L3, so
// every `+bonus$` test still reads it as a bonus. The level is no longer part of a config's identity (runDescriptor):
// one model + launch + harness run at L2 and at L3 is ONE row that attempted two problems. The prompt VARIANT
// (careful-tone, review, docs, helper, plan ...) is unchanged: still in the harness facet and the fit's `prompt:` facet.
// No task id holds an `@` (tasks/<repo>/<id>/), and a task NAMED ...-L3 (a composite's level copy) has none: it stays
// its own task. The browser has the same functions (ui/shared/leaderboard.js); test/promptlevel.test.js holds them equal.
const PROBLEM_RE = /^(.+?)@(L\d+)(\+bonus)?$/;
// MINIMUM CONFIGS FIRST (Kyle, 2026-10-17, picking the points rule): a level problem earns strength points -- and counts
// in the problem total ("/N") and in a row's coverage -- only once at least LEVEL_MIN_CONFIGS distinct config rows have a
// scored result on it (not excluded, not in an INVALID- battery; a config row = the Models page's default quality row:
// folded weights + the quality facets, lib/configid cellKey). Below that it is "not scored yet": its results stay in
// the rows, the grid and its task page, marked so. Plain L2 tasks are never held back. The browser's copy is
// ui/shared/leaderboard.js LEVEL_MIN_CONFIGS (the fit counts the same rows); test/promptlevel.test.js holds them equal.
const LEVEL_MIN_CONFIGS = 5;
let levelUnscored = new Map();   // level problem -> distinct config rows with a scored result, for those below the minimum
/** Is `id` a level problem that does not earn points yet (as of the last index build)? */
function isUnscoredProblem(id) { return levelUnscored.has(String(id)); }
/** 'L3' / 'L3+careful-tone' -> 'L3'; null, '' or 'L2+docs' -> 'L2'. */
function promptLevelOf(pl) {
    const l = String(pl == null ? '' : pl).split('+')[0].trim().toUpperCase();
    return /^L\d+$/.test(l) ? l : 'L2';
}
/** The prompt with its level taken out: 'L2', or 'L2+<variant>' -- the spelling every L2 row already had, so the identity
 *  of every L2 config is what it was. */
function promptWithoutLevel(pl) {
    const bits = String(pl == null ? '' : pl).split('+').slice(1).filter(Boolean);
    return bits.length ? `L2+${bits.join('+')}` : 'L2';
}
/** The problem a result of `task` at prompt level `level` answers: T at L2, `T@L3` at L3, `T@L3+bonus` for T's bonus. */
function problemId(task, level) {
    const t = String(task), l = promptLevelOf(level);
    if (l === 'L2') return t;
    return t.endsWith(BONUS_SUFFIX) ? `${t.slice(0, -BONUS_SUFFIX.length)}@${l}${BONUS_SUFFIX}` : `${t}@${l}`;
}
/** A problem id -> { id, task (the result's own task id: T or T+bonus), base (T), level, bonus }. */
function problemOf(id) {
    const s = String(id), m = PROBLEM_RE.exec(s);
    if (m) return { id: s, task: m[1] + (m[3] || ''), base: m[1], level: m[2], bonus: !!m[3] };
    const bonus = s.endsWith(BONUS_SUFFIX);
    return { id: s, task: s, base: bonus ? s.slice(0, -BONUS_SUFFIX.length) : s, level: 'L2', bonus };
}
/** The metadata of a level problem (`T@L3`, `T@L3+bonus`): its task's (tier, category, sample_group, repo, cap,
 *  diagnostic ...), with `level` / `base` and its own label. null for an L2 id or a task the metadata does not have. */
function levelProblemMeta(id, taskMeta) {
    const p = problemOf(id);
    if (p.level === 'L2' || !taskMeta || typeof taskMeta.get !== 'function') return null;
    const t = taskMeta.get(p.task);
    if (!t) return null;
    return { ...t, id: p.id, level: p.level, base: p.base,
        ...(p.bonus ? { parent: `${p.base}@${p.level}`, label: `${p.base} (bonus, prompt ${p.level})` } : { label: `${p.base} (prompt ${p.level})` }) };
}
/** A task's or problem's metadata: the map's own entry, else (a level problem) its task's. */
function metaOf(taskMeta, id) {
    if (!taskMeta || typeof taskMeta.get !== 'function') return null;
    return taskMeta.get(id) || levelProblemMeta(id, taskMeta);
}
/** The task metadata plus an entry for each level problem in `ids`: the problem universe (coverage counts it). */
function withLevelProblems(taskMeta, ids) {
    const out = new Map(taskMeta);
    for (const id of [...(ids || [])].sort()) { const t = levelProblemMeta(id, taskMeta); if (t) out.set(id, t); }
    return out;
}

let taskMetaCache = { at: 0, map: null };
const TASK_META_TTL = 60000;
function readTaskMeta() {
    if (taskMetaCache.map && Date.now() - taskMetaCache.at < TASK_META_TTL) return taskMetaCache.map;
    const map = new Map(), retired = new Set(), diagnostics = new Set();
    const root = path.join(PATHS.codebenchRoot, 'tasks');
    let repos = [];
    try { repos = fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { repos = []; }
    for (const repo of repos) {
        let ids = [];
        try { ids = fs.readdirSync(path.join(root, repo), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { continue; }
        for (const id of ids) {
            let text; try { text = fs.readFileSync(path.join(root, repo, id, 'task.yaml'), 'utf-8'); } catch { continue; }
            const t = parseTaskYaml(text);
            const tid = t.id || id;
            // a retired task is not part of the suite: no catalog entry, no grid column, no task page -- and neither is
            // its bonus test (`<id>+bonus`, below): a retired or held parent takes its bonus with it
            if (t.retired) { retired.add(tid); retired.add(tid + BONUS_SUFFIX); continue; }
            // a side experiment (multi-issue composites, tools/build-multitask.py, 2026-10-01) is not part of the suite
            // either: its runs stay on disk and in the queue/live views, but never in a model's record or strength
            if (t.side_experiment) { retired.add(tid); retired.add(tid + BONUS_SUFFIX); continue; }
            // DIAGNOSTIC tasks (category `diagnostic`, 2026-10-17; Kyle on the first one: "a special test for functionality,
            // like a speed test, that isn't a quality test"): in the metadata (task page, live views) with `diagnostic: true`,
            // but out of everything that scores -- strength fit, coverage, task points, solve rates, the planner's
            // candidates (foldQualityRows / scoredTaskTotal / allTaskIds). Their results are kept apart as `diagnostics`
            // (foldDiagnosticRows), shown on the model page as their own results and never counted as fails.
            const diagnostic = (t.category || []).includes('diagnostic');
            if (diagnostic) { diagnostics.add(tid); diagnostics.add(tid + BONUS_SUFFIX); }
            map.set(tid, { ...t, id: tid, repo, ...(diagnostic ? { diagnostic: true } : {}) });
            // A bonus test (task.yaml `extra_tests:`, 2026-10-14) is a task of its own for everything that scores --
            // catalog, grid, strength fit -- under its parent's metadata (repo, tier, cap), labelled "(bonus)". Its
            // results are the `<id>+bonus` rows (lib/codebench.js bonusRow). Not a sample_group sibling: it is not the
            // same bug at another stage. A task on hold (`hold: true`) keeps its bonus off the board until it is back.
            if (t.extra_tests && t.hold) retired.add(tid + BONUS_SUFFIX);
            else if (t.extra_tests) map.set(tid + BONUS_SUFFIX, { ...t, id: tid + BONUS_SUFFIX, repo, sample_group: null, extra_tests: undefined,
                bonus: true, parent: tid, label: `${tid} (bonus)`, ...(diagnostic ? { diagnostic: true } : {}) });
        }
    }
    taskMetaCache = { at: Date.now(), map, retired, diagnostics };
    return map;
}

/** Is `task` a diagnostic task (task.yaml category `diagnostic`; a diagnostic task's bonus test too)? */
function isDiagnosticTask(task, taskMeta) {
    const m = metaOf(taskMeta, task);   // a level problem (`T@L3`) is diagnostic when T is
    return !!(m && m.diagnostic);
}
/** How many tasks a coverage figure is out of: the suite less its diagnostic tasks, and less the level problems that
 *  are not scored yet (LEVEL_MIN_CONFIGS). null for none. */
function scoredTaskTotal(taskMeta) {
    if (!taskMeta || !taskMeta.size) return null;
    let n = 0; for (const t of taskMeta.values()) if (!t.diagnostic && !t.unscored) n++;
    return n || null;
}
/** Ids of diagnostic tasks (read with the task metadata). */
function diagnosticTaskIds() { readTaskMeta(); return taskMetaCache.diagnostics || new Set(); }

// ---- skill tags per task (codebench tasks/skills.json, 2026-10-14): the report card's input ----
// {tags: {tag: one-line definition}, tasks: {taskId: [tag, ...]}} (1-3 tags, main tag first). Outside every task dir on
// purpose: harness/taskinfo.py task_version hashes tasks/<repo>/<id>/ only, so retagging changes no task's version.
// A `<id>+bonus` task takes its parent's tags. Public (Kyle 2026-10-14 ~18:45): the report card shows on the public site too.
let skillsCache = { sig: null, v: null };
const skillsFile = () => PATHS.skills || path.join(PATHS.codebenchRoot, 'tasks', 'skills.json');
function readSkills() {
    const f = skillsFile();
    let st; try { st = fs.statSync(f); } catch { return { tags: {}, tasks: {} }; }
    const sig = `${f}:${st.mtimeMs}:${st.size}`;
    if (skillsCache.sig === sig) return skillsCache.v;
    let j = null; try { j = JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { j = null; }
    const v = { tags: (j && j.tags && typeof j.tags === 'object') ? j.tags : {}, tasks: (j && j.tasks && typeof j.tasks === 'object') ? j.tasks : {} };
    skillsCache = { sig, v };
    return v;
}
function skillsOf(id, sk = readSkills()) {
    const p = problemOf(id);   // a level problem takes its task's tags
    const t = sk.tasks[p.task] || sk.tasks[p.base];
    return Array.isArray(t) ? t.filter((x) => typeof x === 'string' && sk.tags[x]) : [];
}

/** Ids of tasks whose task.yaml says `retired: true` (read with the task metadata). */
function retiredTaskIds() { readTaskMeta(); return taskMetaCache.retired || new Set(); }

// ============================ BEST-CONFIGS.md ============================

// Deliberately loose markdown reading. Rules that matter:
//  - a section can hold MORE THAN ONE config block, oldest first; a block introduced by an
//    explicit "SUPERSEDED ... Use instead" marker replaces everything above it
//  - a section marked PROVISIONAL has nothing measured: it is "not yet tuned", never advice
function parseBestConfigs(text) {
    const lines = String(text || '').split('\n');
    const sections = [];
    let cur = null;
    const flush = () => { if (cur) sections.push(cur); };
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const h = /^##\s+(.+?)\s*$/.exec(line);
        if (h) {
            flush();
            const title = h[1];
            cur = {
                title: title.replace(/\*\*/g, '').trim(),
                provisional: /provisional/i.test(title),
                blocks: [], tables: [], notes: [], line: i + 1,
            };
            continue;
        }
        if (!cur) continue;
        // supersede marker: everything collected so far in this section is history
        if (/\bSUPERSEDED\b/i.test(line)) {
            for (const b of cur.blocks) b.superseded = true;
            cur.notes.push(line.replace(/\*\*/g, '').trim());
            cur.supersedeNote = line.replace(/\*\*/g, '').trim();
            continue;
        }
        if (/\bPROVISIONAL\b/i.test(line)) cur.provisional = true;
        // indented code block (4 spaces) = a flag set
        if (/^ {4}\S/.test(line)) {
            const buf = [];
            while (i < lines.length && (/^ {4}/.test(lines[i]) || lines[i].trim() === '')) {
                if (lines[i].trim() !== '') buf.push(lines[i].slice(4));
                else if (buf.length && /^ {4}\S/.test(lines[i + 1] || '')) buf.push('');
                else break;
                i++;
            }
            i--;
            const body = buf.join('\n');
            cur.blocks.push({ flags: body, parsed: parseFlags(body.replace(/\n/g, ' ')), superseded: false });
            continue;
        }
        if (/^\|/.test(line)) { cur.tables.push(line); continue; }
        if (/^Build:/i.test(line)) { cur.build = line.replace(/^Build:\s*/i, '').replace(/`/g, '').trim(); cur.notes.push(line.trim()); continue; }
        if (line.trim().startsWith('- ') || /^\*\*/.test(line.trim())) cur.notes.push(line.trim().replace(/\*\*/g, ''));
    }
    flush();
    // A KV type that was rejected because it OOMs is a CONSTRAINT, not a preference: "Flash-Next
    // prefers q8_0" and "f16 does not fit alongside MTP at 64k" look identical in a table and
    // mean opposite things to someone choosing a config. Pull those lines out explicitly.
    const CONSTRAINT_RE = /(cannot be combined|does not fit|will not fit|OOM|failed to allocate|out of memory|is dropped|no ROCm backend|required)/i;
    for (const s of sections) {
        s.constraints = s.notes.filter((n) => CONSTRAINT_RE.test(n));
    }
    // current = the last non-superseded block in the section
    for (const s of sections) {
        const live = s.blocks.filter((b) => !b.superseded);
        // A section's indented blocks are not all flag sets -- one may be the command that
        // would RUN the sweep. Take the last one that actually looks like launch flags.
        const isFlags = (b) => b.parsed && (b.parsed.devices || b.parsed.ctx != null || b.parsed.kvK || b.parsed.ngl != null);
        const flagLike = live.filter(isFlags);
        s.current = flagLike.length ? flagLike[flagLike.length - 1] : (live.length ? live[live.length - 1] : null);
        s.history = s.blocks.filter((b) => b.superseded);
        s.tuned = !s.provisional && !!s.current;
    }
    return sections;
}

let bestCache = { sig: null, sections: null };
function readBestConfigs() {
    let st; try { st = fs.statSync(PATHS.bestConfigs); } catch { return []; }
    const sig = `${st.mtimeMs}:${st.size}`;
    if (bestCache.sig === sig) return bestCache.sections;
    let text; try { text = fs.readFileSync(PATHS.bestConfigs, 'utf-8'); } catch { return []; }
    const sections = parseBestConfigs(text);
    bestCache = { sig, sections };
    return sections;
}

/**
 * Which BEST-CONFIGS section (if any) covers this model.
 *
 * Matched on the section title's HEAD -- the text before the first "(" or em-dash, since the
 * titles carry qualifiers ("Qwen3.8-27B (dense, all quants) — including Swift", "Gemma 4
 * (added 2026-09-22) — PROVISIONAL"). Scored rather than first-match so a finetune
 * (Swift-Qwen3.8-27B, Huihui-...-abliterated) lands on its base model's entry without a
 * shorter, less specific head stealing it.
 */
function matchBestConfigs(model, sections) {
    if (!model || model.provider !== 'local') return null;
    const compact = (s) => String(s || '').replace(/-/g, '');
    const fam = compact(model.familySlug);
    if (!fam) return null;
    let best = null, bestScore = 0;
    for (const s of sections) {
        const head = compact(slug(String(s.title).split(/[(—]|--/)[0]));
        if (!head || head.length < 4) continue;
        let score = 0;
        if (fam === head) score = 100;
        else if (fam.startsWith(head)) score = 60 + head.length;          // gemma-4-12b-it vs "Gemma 4"
        else if (head.startsWith(fam)) score = 50 + fam.length;
        else if (head.length >= 6 && fam.includes(head)) score = 30 + head.length;   // Swift-Qwen3.8-27B vs "Qwen3.8-27B"
        if (score > bestScore) { bestScore = score; best = s; }
    }
    return best;
}

// ============================ codebench aggregation ============================

// CAP_TOO_LOW (2026-09-23): the row timed out under a cap below today's 2 h standard, so it
// never had the budget the rest of the corpus is judged against. A task solved at 75 minutes
// once the cap was lifted, which makes every 1 h timeout a row that might have solved -- not a
// model answer, and not a failure to hold against the model.
const EXCLUDED_STATUS = new Set(['OVERFLOW', 'KILLED', 'PROVIDER_ERROR', 'ABORTED', 'CAP_TOO_LOW', 'HARNESS_ERROR', 'CONTAMINATED', 'TASK_INVALID', 'CUTOFF']);
const SOLVED_STATUS = new Set(['pass', 'pass*']);
const STATUS_ORDER = ['pass', 'pass*', 'TIMEOUT', 'OVERFLOW', 'KILLED', 'PROVIDER_ERROR', 'ABORTED', 'CAP_TOO_LOW', 'HARNESS_ERROR', 'CONTAMINATED', 'TASK_INVALID', 'CUTOFF', 'fail'];

/**
 * Fold a model's battery rows into ONE sample per task, then one per sample_group.
 *
 * Two reasons this is not just a count:
 *  - the same task is re-run across batteries (flash-q2kxl-64k, -csvfix, -prio1h, -v2):
 *    counting every run inflates "attempted 18/102". Latest scored run wins.
 *  - `sample_group` (tasks built from THE SAME BUG: a fix variant, an avoid/origin variant, a
 *    trap twin) used to fold into ONE sample, keeping whichever ran last -- so a model's pass on
 *    one variant could be discarded by a later fail on the other. Kyle, 2026-09-25: each variant
 *    tests something different, so each counts as its own task. The group is kept as a label.
 *
 * `entries` = [{ dir, ended, invalid, row }] where row is codebench's taskRow().
 */
// Off since 2026-09-25 (see above): every task in a sample_group counts as its own sample.
const FOLD_SAMPLE_GROUPS = false;
// What scores: every task but the diagnostic ones (isDiagnosticTask). foldDiagnosticRows: the diagnostic ones alone, folded
// the same way (one sample per task, fractional credit), for the `diagnostics` maps -- nothing aggregates those.
function foldQualityRows(entries, taskMeta) {
    return foldRows((entries || []).filter((e) => !isDiagnosticTask(e.row && e.row.task, taskMeta)), taskMeta);
}
function foldDiagnosticRows(entries, taskMeta) {
    return foldRows((entries || []).filter((e) => isDiagnosticTask(e.row && e.row.task, taskMeta)), taskMeta);
}
/** Diagnostic samples -> { <task>: { status, solved, credit, attempts, passes, wall_s, tokens_out, ran_at, diagnostic } }. */
function diagnosticMap(samples) {
    const out = {};
    for (const s of samples || []) {
        const noAttempts = !s.attempts;
        out[s.row.task] = {
            diagnostic: true, status: s.row.status, solved: noAttempts ? false : (s.credit != null ? s.credit > 0 : !!s.row.solved),
            excluded: noAttempts, credit: s.credit, attempts: s.attempts || 0, passes: s.passes || 0,
            wall_s: s.row.wall_s, tokens_out: s.row.tokens_out, ran_at: s.row.ran_at || s.ended || null, dir: s.dir || null,
            ...(s.overflowed ? { overflowed: s.overflowed } : {}),   // passed after outgrowing the context (display only; overflowedOfRuns)
        };
    }
    return out;
}
/** ANSWERED (2026-10-19, Kyle): the task's runs whose question was answered with the original prompt (a re-send at the
 *  end of the run, or a continuation; taskRow `answered`) -> { passed, failed, compacted, answeredNotes } or null.
 *  passed / failed: how many of them then passed / did not (scored runs); compacted: how many asked after a compaction.
 *  answeredNotes (lab only: lib/publicdata.js drops the key) -- [{ via, status, dir, at_s, compactions, asked, history }].
 *  Display only: the cell is dark green when the task passed and such a run is among its passes. */
function answeredOfRuns(runs) {
    const hit = (runs || []).filter((r) => r.row && r.row.answered && !EXCLUDED_STATUS.has(r.row.status));
    if (!hit.length) return null;
    const passed = hit.filter((r) => SOLVED_STATUS.has(r.row.status)).length;
    return { passed, failed: hit.length - passed, compacted: hit.filter((r) => Number(r.row.answered.compactions) > 0).length,
        answeredNotes: hit.map((r) => ({ via: r.row.answered.via, status: r.row.status || null, dir: r.dir || null, at_s: r.row.answered.at_s ?? null,
            compactions: r.row.answered.compactions ?? null, asked: r.row.answered.asked || null, history: r.row.history || [] })) };
}
/** OVERFLOWED, THEN PASSED (2026-10-24, Kyle: "these should be 'dark green' cases"): the task's PASSING, scored runs whose
 *  conversation outgrew the context window (the runner reported a context overflow) and that passed anyway -- the agent
 *  compacted and carried on. codebench harness/status.py (2026-10-24) makes such a run `pass` and keeps the anomaly
 *  string "context_overflow" in the result's `anomalies`; an overflow that did not solve stays OVERFLOW (excluded, and so
 *  never here). -> { passed } or null. Counts only (public, like `answered`'s counts). Display only: the cell is dark
 *  green when the task passed and such a run is among its passes; attempts, passes and credit are untouched. */
const OVERFLOW_ANOMALY = 'context_overflow';
function overflowedOfRuns(runs) {
    const passed = (runs || []).filter((r) => r.row && SOLVED_STATUS.has(r.row.status) && !EXCLUDED_STATUS.has(r.row.status)
        && Array.isArray(r.row.anomalies) && r.row.anomalies.includes(OVERFLOW_ANOMALY)).length;
    return passed ? { passed } : null;
}
function foldRows(entries, taskMeta) {
    // All runs of a task are one sample, and the sample's value is the FRACTION of its scored
    // attempts that passed: 4 passes of 5 is 0.8 of a solve, 1 of 1 is a whole one. Latest-wins
    // (what this did before) throws away every earlier attempt, which is the wrong answer the
    // moment `--runs N` is used: a task that passes once and fails four times would read as a
    // clean pass or a clean fail depending only on which run happened to be last.
    // Excluded runs (OVERFLOW / KILLED / PROVIDER_ERROR / ABORTED) are not attempts -- they are
    // not model answers -- so they never enter the denominator. A task whose every run was
    // excluded stays excluded.
    const byTask = new Map();
    for (const e of entries) {
        if (e.invalid) continue;
        const t = e.row.task;
        const g = byTask.get(t);
        if (!g) { byTask.set(t, { ...e, runs: [e] }); continue; }
        g.runs.push(e);
        // the representative row (used for wall/tokens/tool-calls) stays the latest one
        if ((e.ended || 0) >= (g.ended || 0)) { const runs = g.runs; Object.assign(g, e, { runs }); }
    }
    for (const g of byTask.values()) {
        const scored = g.runs.filter((r) => !EXCLUDED_STATUS.has(r.row.status));
        const passed = scored.filter((r) => SOLVED_STATUS.has(r.row.status));
        g.attempts = scored.length;
        g.passes = passed.length;
        // t/s over EVERY run of the task, passed, failed or excluded: speed is not an outcome (runSpeed)
        g.speedAll = sumRunSpeed(g.runs.map((r) => r.speed));
        g.credit = scored.length ? passed.length / scored.length : null;   // null = nothing scoreable
        // PASSES AFTER A RE-SENT PROMPT (2026-10-19, Kyle): the harness put the original task back into the session once
        // after an early stop (taskRow `resent`). Display only, as pass* is: the credit above is untouched. The first such
        // pass's moment and reason, and how many of the passes it covers.
        const rsp = passed.filter((r) => r.row.resent);
        g.resentPass = rsp.length ? { n: rsp.length, at_s: rsp[0].row.resent.at_s, reason: rsp[0].row.resent.reason } : null;
        // runs whose question was ANSWERED with the original prompt (2026-10-19, Kyle): the cell's dark green when one of
        // them then passed. Display only: attempts, passes and credit above are untouched.
        g.answered = answeredOfRuns(g.runs);
        // passing runs that outgrew the context window and carried on (2026-10-24, Kyle): dark green too. Display only.
        g.overflowed = overflowedOfRuns(g.runs);
        // Hidden-test assertions summed over every scored run (score.py writes them since 2026-09),
        // for the grid's sub-test view: 7 of 9 assertions is a near miss, 0 of 9 is not.
        const withA = scored.filter((r) => r.row.assertions && Number(r.row.assertions.total) > 0);
        g.assertionsAll = withA.length ? { passed: withA.reduce((a2, r) => a2 + Number(r.row.assertions.passed || 0), 0),
            total: withA.reduce((a2, r) => a2 + Number(r.row.assertions.total), 0), runs: withA.length } : null;
        // Cases passed BEYOND the base (lib/codebench.js progressOf, from the task's baseline.json),
        // summed over the scored runs that have it: "+1 of 6 new" instead of "2 of 7", which mostly
        // counts cases the untouched base already passes. approx: any run's figure is net/totals-only.
        const withP = scored.filter((r) => r.row.progress && Number(r.row.progress.of) >= 0);
        g.progressAll = withP.length ? { count: withP.reduce((a2, r) => a2 + Number(r.row.progress.count || 0), 0),
            of: withP.reduce((a2, r) => a2 + Number(r.row.progress.of || 0), 0),
            regressions: withP.reduce((a2, r) => a2 + Number(r.row.progress.regressions || 0), 0),
            runs: withP.length, approx: withP.some((r) => !r.row.progress.exact || r.row.progress.stale) } : null;
        // Cost fields come from the runs that PASSED (or, with no pass, the scored ones), never
        // just the latest row: that row can be a 1-second provider error sitting on top of a real
        // solve, and it was feeding wall/solve, tok/solve and relative solve time with 0s.
        const pool = passed.length ? passed : scored;
        if (pool.length) {
            const avgOf = (k, pos) => { const v = pool.map((r) => r.row[k]).filter((x) => x != null && (!pos || x > 0)); return v.length ? v.reduce((a2, b2) => a2 + b2, 0) / v.length : null; };
            g.row = { ...g.row, wall_s: avgOf('wall_s', true), tokens_out: avgOf('tokens_out', true), tool_calls: avgOf('tool_calls', false) };
        }
    }
    const byGroup = new Map();
    const samples = [];
    for (const e of byTask.values()) {
        const meta = metaOf(taskMeta, e.row.task);
        const rec = { ...e, tier: (meta && meta.tier) || null, sample_group: (meta && meta.sample_group) || null, folded: [], foldedRecs: [],
 };
        if (rec.sample_group && FOLD_SAMPLE_GROUPS) {
            const prev = byGroup.get(rec.sample_group);
            if (prev) {
                prev.folded.push(e.row.task);
                if ((e.ended || 0) > (prev.ended || 0)) {
                    // keep the newer result but carry the fold list forward; the displaced record
                    // is kept too (foldedRecs) so the grid can show the sibling's own outcome
                    const displaced = { ...prev, folded: [], foldedRecs: [] };
                    const folded = prev.folded.concat([prev.row.task]).filter((x) => x !== e.row.task);
                    Object.assign(prev, rec, { folded, foldedRecs: prev.foldedRecs.concat([displaced]) });
                } else prev.foldedRecs.push(rec);
                continue;
            }
            byGroup.set(rec.sample_group, rec);
        }
        samples.push(rec);
    }
    return samples.filter((s) => !s.sample_group || !FOLD_SAMPLE_GROUPS || byGroup.get(s.sample_group) === s);
}

/**
 * Half-width of the Wilson 95% score interval for k successes in n trials, in percentage points.
 * k may be fractional (partial credit). Returns null for n = 0.
 */
function wilsonHalfWidth(k, n) {
    if (!n) return null;
    const z = 1.959964, p = k / n, d = 1 + (z * z) / n;
    const half = (z / d) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
    return half * 100;
}

/**
 * Bytes on disk for a local model's weights, summed over shards. A sharded gguf names itself
 * `...-00001-of-00003.gguf`, and only counting the first shard would make a 3-part model look a
 * third of its size -- which is the number someone would then divide by to get "GB per solve".
 * Cloud models have no answer here and get null rather than 0.
 */
const diskCache = new Map();
function diskBytesFor(modelPath) {
    if (!modelPath) return null;
    if (diskCache.has(modelPath)) return diskCache.get(modelPath);
    let total = null;
    try {
        const m = /^(.*)-(\d{5})-of-(\d{5})\.gguf$/.exec(modelPath);
        if (m) {
            total = 0;
            const n = Number(m[3]);
            for (let i = 1; i <= n; i++) {
                const part = `${m[1]}-${String(i).padStart(5, '0')}-of-${m[3]}.gguf`;
                try { total += fs.statSync(part).size; } catch { /* a missing shard just under-counts */ }
            }
            if (!total) total = null;
        } else {
            total = fs.statSync(modelPath).size;
        }
    } catch { total = null; }
    diskCache.set(modelPath, total);
    return total;
}

/** Report-card numbers over a folded sample list. */
function aggregateQuality(samples) {
    const counts = {}; for (const s of STATUS_ORDER) counts[s] = 0;
    let scored = 0, solved = 0, excluded = 0, timedSolved = 0;
    let aPassed = 0, aTotal = 0, aTasks = 0;
    const solveTokens = [], solveWall = [], solveTools = [], allWall = [];
    const byTier = {};
    let attemptsTotal = 0, repeatedTasks = 0;
    let anyToolCall = false, anyEdit = false;
    for (const s of samples) {
        const st = s.row.status;
        // Every TASK contributes exactly 1.0 to the status mix, split across its runs. Counting
        // runs instead made a model that attempted 36 tasks draw a bar three times longer than
        // one that attempted 12, which is a measure of how much was run, not of how it did.
        // Split each task's one unit across its SCORED runs, so the pass/fail keys sum to
        // `scored` and the excluded keys to `excluded`. Splitting across ALL runs let an excluded
        // run take a share of a task that was scored, which is how `counts` came to disagree with
        // solved/scored -- and why a bar could read 9 while the row read 10/11.
        const all = s.runs && s.runs.length ? s.runs : [{ row: s.row }];
        const share = all.filter((r) => !EXCLUDED_STATUS.has(r.row.status));
        const runs = share.length ? share : all;
        for (const r of runs) counts[r.row.status] = (counts[r.row.status] || 0) + 1 / runs.length;
        attemptsTotal += (s.attempts || 0);
        for (const r of runs) {
            if ((r.row.tool_calls || 0) > 0) anyToolCall = true;
            if ((r.row.edits || 0) > 0 || (r.row.tool_edits || 0) > 0 || (r.row.shell_edits || 0) > 0) anyEdit = true;
        }
        if ((s.attempts || 0) > 1) repeatedTasks++;
        const tier = s.tier || 'untiered';
        byTier[tier] = byTier[tier] || { scored: 0, solved: 0, excluded: 0 };
        if (EXCLUDED_STATUS.has(st) && !s.attempts) { excluded++; byTier[tier].excluded++; continue; }
        scored++; byTier[tier].scored++;
        if (s.row.wall_s != null) allWall.push(s.row.wall_s);
        if (s.row.assertions && Number.isFinite(Number(s.row.assertions.total))) {
            aPassed += Number(s.row.assertions.passed || 0); aTotal += Number(s.row.assertions.total); aTasks++;
        }
        // Fractional: a task passed 4 of 5 attempts is 0.8 of a solve. With one attempt per task
        // -- every row stored today -- credit is 1 or 0 and this is identical to the old count.
        const credit = (s.credit == null ? (SOLVED_STATUS.has(st) ? 1 : 0) : s.credit);
        solved += credit; byTier[tier].solved += credit;
        // a bonus test's result (row.bonus) costs no time of its own: its run's wall clock is the main row's, so
        // solves per hour counts only the results that carry the hours (else every bonus pass is a free solve)
        if (!s.row.bonus) timedSolved += credit;
        if (credit > 0) {
            // 0 output tokens on a SOLVED task is an unrecorded count, not a free solve -- it
            // topped the efficiency board at "0 tok/solve" before this.
            if (s.row.tokens_out > 0) solveTokens.push(s.row.tokens_out);
            if (s.row.wall_s != null) solveWall.push(s.row.wall_s);
            if (s.row.tool_calls != null) solveTools.push(s.row.tool_calls);
        }
    }
    const wallTotal = sum(allWall);
    const rate = scored ? solved / scored : null;
    return {
        attempted: samples.length, scored, solved: Math.round(solved * 1000) / 1000, excluded, counts,
        // How many runs are behind those samples, and how many tasks were tried more than once.
        // `repeatedTasks: 0` is the honest caveat on every number here: one attempt per task means
        // a solve rate is a single draw, not an estimate that repeats have narrowed.
        attemptsTotal, repeatedTasks,
        // A model that made ZERO tool calls and ZERO edits across every task never engaged the
        // harness at all -- it is a wire-format or protocol mismatch, not a model that was tried
        // and found wanting. qwen2.5-coder-7b is the standing case: 12 tasks, 0 tool calls, 0
        // edits, 0 solves. Scoring that as 0% puts a number on an experiment that never ran, and
        // it drags every average that includes it. Flagged here, excluded by the charts, still
        // visible in the catalogue so the failure itself is not hidden.
        harnessIncompatible: (scored > 0 && !anyToolCall && !anyEdit),
        solveRate: rate,
        // Wilson 95% half-width on solved/scored -- the "more research needed" number. Wilson
        // rather than normal because it stays sane at 0/12 and 12/12, where the normal interval
        // collapses to zero width and claims certainty from the least evidence.
        solveRateCI: wilsonHalfWidth(solved, scored),
        assertions: aTasks ? { passed: aPassed, total: aTotal, tasks: aTasks } : null,
        tokensPerSolve: solveTokens.length ? { mean: mean(solveTokens), median: median(solveTokens), n: solveTokens.length } : null,
        wallPerSolve: solveWall.length ? { mean: mean(solveWall), median: median(solveWall), n: solveWall.length } : null,
        toolCallsPerSolve: solveTools.length ? { mean: mean(solveTools), median: median(solveTools), n: solveTools.length } : null,
        // "how much wall clock does one solved task cost" -- the throughput leaderboard.
        // Denominator is EVERY scored task's wall, including the failures you paid for.
        solvesPerHour: wallTotal > 0 ? (timedSolved / (wallTotal / 3600)) : null,
        wallTotal_s: wallTotal || null,
        byTier,
    };
}

// ============================ assembly ============================

function emptyModel(c) {
    return {
        key: c.key, display: c.display, family: c.family, familySlug: c.familySlug,
        quant: c.quant, provider: c.provider, vendor: c.vendor,
        ambiguous: !!c.ambiguous, unresolved: !!c.unresolved,
        ambiguousNote: c.ambiguousNote || null, why: c.why || null,
        sources: [], efforts: [],
        counts: { requests: 0, benchRuns: 0, sweepRows: 0, qualityBatteries: 0, qualityTasks: 0 },
        _requests: [], _bench: [], _sweep: [], _batteries: [], _qualityEntries: [],
    };
}

function addSource(m, kind, raw, via, extra) {
    if (!raw) return;
    const id = `${kind}:${raw}`;
    let s = m.sources.find((x) => x.id === id);
    if (!s) { s = { id, kind, raw, via, count: 0, ...(extra || {}) }; m.sources.push(s); }
    s.count++;
    if (extra && extra.note && !s.note) s.note = extra.note;
}

// buildIndex() walks 7.5k CSV rows, 44 batteries and 102 task files (~400 ms). The overview,
// three leaderboards and the Live baseline poll all want it, and this box is usually running a
// battery -- so memoise on the inputs' signatures with a short TTL.
let indexCache = { sig: null, requests: null, at: 0, value: null };
const INDEX_TTL_MS = 20000;
// Every battery dir's result files -- how many *.json it holds and the newest one's mtime -- so a task result
// landing in an EXISTING battery changes the index signature. Until 2026-10-06 this was only the number of dirs,
// and a finished task waited for the TTL below. Like lib/codebench.js dirSignature but WITHOUT the dir's own mtime
// and without dirs that hold no json yet: a running battery creates a work dir per task and the queue creates
// battery dirs ahead of time, and neither changes anything the index reads (results, battery.json, control.json
// are all *.json) -- counting them rebuilt the catalog twice per finished task. ~12 ms for 340 dirs / 2,500 files.
function resultsSignature() {
    const root = path.join(PATHS.codebenchRoot, 'results');
    let dirs;
    try { dirs = fs.readdirSync(root); } catch { return '-'; }
    const h = crypto.createHash('sha1');
    let live = 0;
    for (const d of dirs) {
        let n = 0, latest = 0;
        try {
            for (const f of fs.readdirSync(path.join(root, d))) {
                if (!f.endsWith('.json')) continue;
                try { const s = fs.statSync(path.join(root, d, f)); n++; if (s.mtimeMs > latest) latest = s.mtimeMs; } catch { /* gone */ }
            }
        } catch { continue; }   // not a directory
        if (n) { live++; h.update(`${d}=${n}:${latest};`); }
    }
    return `${live}:${h.digest('hex').slice(0, 16)}`;
}
function inputSignature() {
    const st = (f) => { try { const x = fs.statSync(f); return `${x.mtimeMs}:${x.size}`; } catch { return '-'; } };
    return [st(PATHS.csv), st(PATHS.benchLog), st(PATHS.sweepState), st(PATHS.bestConfigs), st(PATHS.dashboardConfig), st(skillsFile()), resultsSignature(),
        // run annotations (lib/annotations.js): a review file that lands or changes rebuilds the catalog
        annotationsSignature()].join('|');   // dashboardConfig: modelDisplayNames
}
function annotationsSignature() { try { return require('./annotations').signature(PATHS.codebenchRoot); } catch { return '-'; } }
// The request table's stamp as text ('-' when the database is not the request source, as in readRequests).
function requestsSignature() {
    if (PATHS.csv !== DEFAULT_PATHS.csv) return '-';
    try { const s = require('./db').requestsStamp(); return s ? `${s.n}:${s.maxId}` : '-'; } catch { return '-'; }
}
/**
 * What the catalog would be built from right now, for server4.js's prebuilt catalog answer (lib/catalogcache.js,
 * 2026-10-06): `inputs` covers every file and battery dir the index reads, `requests` the request table. Cheap
 * (~15 ms) next to listModels(); nothing is read beyond stats and one count query.
 */
function catalogSignature() { return { inputs: inputSignature(), requests: requestsSignature() }; }

/** Build the whole index. Memoised: see indexCache above. `fresh`: also not older than the request table
 *  (the TTL alone lets up to 20 s of logged requests go unseen, which a caller keeping its own copy must not bake in). */
function buildIndex(fresh) {
    const sig = inputSignature();
    if (indexCache.value && indexCache.sig === sig && Date.now() - indexCache.at < INDEX_TTL_MS
        && !(fresh && indexCache.requests !== requestsSignature())) return indexCache.value;
    const requests = requestsSignature();   // before the read: a request logged meanwhile leaves the stamp behind, never ahead
    const built = buildIndexUncached();
    indexCache = { sig, requests, at: Date.now(), value: built };
    return built;
}
/** Which catalog model a battery belongs to: its weights with effort, scaffold and local variant folded in.
 *  ONE function for a stored battery (buildIndexUncached) and for one that is running with no result yet
 *  (describeRunning), so a live cell can only land on the row its results will land on. */
function batteryIdentity(run, scaffolds, queueCmd) {
    const cfg = run.config || {}, srv = run.server || {};
    const c0 = canonicalModel({ model_path: srv.model_path || null, model: cfg.model || null, runner: cfg.runner || null, dir: run.dir });
    if (!c0) return null;
    // The effort can arrive two ways: inside the model id (agy's `gemini-3.8-flash-medium`,
    // which canonicalModel already split off) or as its own config field (Claude's `--effort`).
    const recordedEffort = c0.effort || cfg.effort;
    const cE = recordedEffort
        ? withEffort(c0, recordedEffort, c0.effort ? 'model_id' : 'config')
        : withEffort(c0, effortFromDir(run.dir), 'dir_heuristic');
    const one = scaffolds && scaffolds.length === 1 ? scaffolds[0] : null;
    return withWeightsFile(withLocalVariant(withScaffold(cE, one || cfg.scaffold || null, cfg.runner || null), run, one, queueCmd), srv.model_path || null, srv.weights || null);
}
/**
 * The catalog row a RUNNING battery belongs to, before it has a single result (2026-10-07, Kyle: the blue
 * "testing now" cells sat in new rows at the bottom "as if they were untested configs"). The models grid found a
 * running battery's row by its dir, and a battery is only in the catalog once a task has been scored -- up to two
 * hours in. Everything that keys a row is known at launch: battery.json has the runner, its model id, effort,
 * scaffold, prompt level and cap; the queue item has the launch command (`server`: lib/codebench.js queueServer,
 * the expanded command the runner started, with the model file and context read from it).
 * -> { modelKey, display, facets } with facets as runDescriptor builds them for a stored row, or null.
 */
function describeRunning(rec, server) {
    const b = (rec && rec.battery) || {};
    const cfg = { runner: b.runner || null, model: b.model || null, timeout_s: b.timeout_s ?? null, ...(b.config || {}) };
    const srv = server ? { ...server } : {};
    // + the item's declared row variant (CODEBENCH_ROW_VARIANT), so the "testing now" cell sits in the experiment's row
    let rvMark = ''; try { const rv = rowVariant(queueLaunchByBattery().get(rec.dir)); if (rv) rvMark = ` #row-variant=${rv.key.slice(3)}`; } catch { rvMark = ''; }
    const queueCmd = srv.launch_command ? srv.launch_command + rvMark : (rvMark ? rvMark.trim() : null);
    // a Strata result records no launch command (see strataVariant): the running one must not carry one either
    if (srv.engine === 'strata' || /\/Strata[^/\s]*\/queue-serve\.sh/.test(String(queueCmd || ''))) delete srv.launch_command;
    delete srv.engine; delete srv.launch_command_source;
    const run = { dir: rec.dir, config: cfg, server: srv };
    const c = batteryIdentity(run, [], queueCmd);
    if (!c || c.unresolved) return null;   // the model cannot be told from the launch: no row is guessed
    const d = runDescriptor(run, c.provider, c.key);
    // `level`: the prompt level it runs at, so its current task is shown in its problem's column (`T@L3`)
    return { modelKey: c.key, display: c.display, facets: d.facets, level: d.level };
}

/** Rows nobody can use (Kyle, 2026-10-07: "useless early throw away data at this point"): a model that was never
 *  identified ("local-128k (model not recorded)", an opencode id reused across models) AND has no scored task --
 *  every run of it was excluded (OVERFLOW / KILLED / ABORTED...) -- AND no speed data. Left out of the catalog,
 *  so of every board, grid and picker built from it; nothing is deleted: the batteries are still under
 *  Bench -> codebench, and getModel(key) still answers a direct link. */
const neverIdentified = (m) => !!m.unresolved && m.counts.qualityBatteries > 0 && !(m.quality && m.quality.scored > 0)
    && !m.counts.requests && !m.counts.benchRuns && !m.counts.sweepRows;
// ... and rows declared internal (dashboard.config.json `internalRowVariants`, see isInternalRow).
const hiddenFromCatalog = (m) => neverIdentified(m) || isInternalRow(m.key);

/** Every model path the index will key (requests, llama-bench, sweep, batteries) with its row count, handed to
 *  weightsid.prime() so each name's reference file is decided once, before the first key is made. */
function primeWeights(runs) {
    // rows counted per distinct (path, recorded id) first: 44k request rows name a few dozen files, and parsing a name
    // per row is what made the index build slow before (2026-10-06)
    const count = new Map();
    const note = (ref, rows, recorded) => {
        if (!ref) return;
        const k = `${ref}\u0000${recorded && recorded.id ? recorded.id : ''}`;
        const x = count.get(k);
        if (x) x.rows += rows; else count.set(k, { ref, rows, recorded: recorded || null });
    };
    try { for (const r of readRequests()) note(r.modelPath, 1, r.weights); } catch { /* no requests */ }
    try { for (const b of readBenchBlocks()) note(b.flags && b.flags.modelPath, 1); } catch { /* no transcript */ }
    try { for (const row of readSweepRows()) note(row.modelRef, 1); } catch { /* no sweep */ }
    for (const run of runs || []) { const s = run.server || {}; note(s.model_path, run.tasks || 1, s.weights || null); }
    const out = [];
    for (const x of count.values()) {
        if (!/\.gguf$|\//.test(String(x.ref))) continue;
        const c = canonicalModelAsFiled(x.ref);
        if (c && c.provider === 'local') out.push({ baseKey: c.key, path: x.ref, rows: x.rows, recorded: x.recorded });
    }
    weightsId.prime(out);
}

let out_allTaskIds = [];
/**
 * One codebench run's prefill / generation token sums from the request log (lib/tps.js runRates), for the compare
 * page's t/s (2026-10-18). null for a run no local server served (no model path: cloud) and for a run that occupied
 * no time of its own (a `+bonus` row: the main row carries the run's wall clock). Otherwise {..sums, n} or, when its
 * server logged nothing in its window (a Strata leg without a proxy recording, a run before the request log),
 * {none: true}: a local run whose speed is unknown, still counted in "measured k of n runs".
 * Only a run whose start is RECORDED (the manifest's started_at, or the result file's mtime less its wall clock) is
 * placed in time. ran_at from a transcript's mtime (~350 local runs, all before 2026-09-24) is unknown: on the real
 * log, 243 of 308 such runs have requests of their own server both in the wall clock before that mtime and in the
 * wall clock after it (a battery's tasks run back to back on one server), so it cannot say which window was the run.
 */
function runSpeed(timeline, row, run) {
    const srv = (row.rowConfig && row.rowConfig.server) || (run && run.server) || {};
    const wall = Number(row.wall_s);
    if (!srv.model_path || !(wall > 0)) return null;
    if (!row.ran_at || row.ran_at_source === 'transcript_mtime') return { none: true };
    const from = row.ran_at;
    const r = tpsModel.runRates(timeline, { from, to: from + wall * 1000, modelPath: srv.model_path,
        launchCommand: srv.launch_command || null, machineFp: (srv.machine && srv.machine.fingerprint) || null });
    return r || { none: true };
}
/** Runs' speed records -> one cell's, in the catalog's short form (~2,100 cells carry one): pn / pms = prompt tokens
 *  and prefill ms, gn / gms = generated tokens and generation ms, req = requests, runs = runs with request data,
 *  of = local runs with a wall clock. Sums, so cells and configs add up (ui/shared/leaderboard.js mergeTasks,
 *  speedOf). null when no run was a local one.
 *  2026-10-22 (each row's fastest config): pn0 / pms0 / gn0 / gms0 / rq0 the same over the requests below
 *  lib/tps.js SPEED_BAND_SPLIT tokens of context, pn1 ... rq1 at or above it; sl = runs whose sums came from the Strata
 *  engine log (lib/stratalog.js), sh = of those, runs that shared one engine start with others (token counts shared out
 *  by wall clock). Each only when not zero, so a cell without them keeps its old shape. */
const SPEED_BAND_FIELDS = [['prompt_n', 'pn'], ['prompt_ms', 'pms'], ['predicted_n', 'gn'], ['predicted_ms', 'gms'], ['n', 'rq']];
function sumRunSpeed(list) {
    let out = null;
    const extra = {};
    const add = (k, v) => { if (v) extra[k] = Math.round(((extra[k] || 0) + v) * 100) / 100; };
    for (const s of list) {
        if (!s) continue;
        out = out || { pn: 0, pms: 0, gn: 0, gms: 0, req: 0, runs: 0, of: 0 };
        out.of++;
        if (s.none) continue;
        out.runs++;
        out.pn += s.prompt_n || 0; out.pms += s.prompt_ms || 0; out.gn += s.predicted_n || 0; out.gms += s.predicted_ms || 0; out.req += s.n || 0;
        ['lo', 'hi'].forEach((b, i) => { if (s[b]) for (const [from, to] of SPEED_BAND_FIELDS) add(to + i, s[b][from]); });
        if (s.src === 'strata-log') { add('sl', 1); if (s.shared) add('sh', 1); }
    }
    if (out) { out.req = Math.round(out.req * 100) / 100; Object.assign(out, extra); }
    return out;
}

function buildIndexUncached() {
    const models = new Map();
    const get = (c) => {
        if (!models.has(c.key)) models.set(c.key, emptyModel(c));
        const m = models.get(c.key);
        // an ambiguous resolution never un-flags a model, but a confident one can name it
        if (c.ambiguous) { m.ambiguous = true; m.ambiguousNote = m.ambiguousNote || c.ambiguousNote; }
        return m;
    };

    // --- which file each name's plain key belongs to (lib/weightsid.js prime): every recorded path, before any key
    let runs = [];
    try { runs = cb().listRuns(PATHS.codebenchRoot); } catch { runs = []; }
    primeWeights(runs);

    // --- per-request history (logs/benchmarks.csv) ---
    // one canonicalModel() per distinct model string, not per row: 44k rows name a few dozen models, and parsing
    // the name each time was a sixth of the whole build (2026-10-06)
    const canonByRef = new Map();
    for (const r of readRequests()) {
        const ref = r.modelPath || r.modelName;
        const mk = r.weights ? `${ref}\u0000${r.weights.id}` : ref;     // a recorded fingerprint can file a row apart
        if (!canonByRef.has(mk)) canonByRef.set(mk, withWeightsFile(canonicalModel(ref), r.modelPath || null, r.weights));
        const c = canonByRef.get(mk);
        if (!c) continue;
        const m = get(c);
        m._requests.push(r);
        m.counts.requests++;
        addSource(m, 'gguf', (r.modelPath || r.modelName || '').split('/').pop(), c.via);
    }

    // --- llama-bench transcript ---
    for (const b of readBenchBlocks()) {
        const ref = b.flags && b.flags.modelPath;
        if (!ref) continue;
        const c = withWeightsFile(canonicalModel(ref), ref);
        if (!c) continue;
        const m = get(c);
        m._bench.push(b);
        m.counts.benchRuns++;
        addSource(m, 'llama-bench -m', ref.split('/').pop(), c.via);
    }

    // --- launch sweep ---
    for (const row of readSweepRows()) {
        if (!row.modelRef) continue;
        const c = withWeightsFile(canonicalModel(row.modelRef), row.modelRef);
        if (!c) continue;
        const m = get(c);
        m._sweep.push(row);
        m.counts.sweepRows++;
        addSource(m, 'sweep -m', row.modelRef.split('/').pop(), c.via);
    }

    // --- codebench batteries ---
    const taskMeta = readTaskMeta();
    // the planner's candidates: no diagnostic task, and no level problem (`T@L3`): a config runs the suite's tasks at
    // its own prompt level, so its candidates are task ids (ui/autoqueue/derive.js maps its record back to them)
    out_allTaskIds = [...taskMeta.keys()].filter((t) => !isDiagnosticTask(t, taskMeta));
    const levelProblems = new Set();
    const queueLaunch = queueLaunchByBattery();
    const timeline = tpsModel.requestTimeline(readRequests());   // the same rows as above (readRequests is cached)
    // UNFINISHED AND SUPERSEDED ROWS (lib/codebench.js getRun, 2026-10-19, Kyle): a row whose question is not answered
    // yet (`unfinished`) or that a continuation replaced (`superseded`) is NOT a quality entry -- so it is in no count,
    // x/y, pass rate, fit, leaderboard, planner record or lib/configid "scored" index, all built from _qualityEntries.
    // A battery with no other row creates no model row and no battery count. Unfinished rows are kept apart
    // (`held`: the Solve map's neutral cells, lib/configid's `unfinished` index); every row is kept by its file for the
    // history a continuation shows ("first stopped at 24 min asking: ...").
    const held = [];
    const rowsByKey = new Map();
    // A Strata run the request log has nothing for (no record proxy recording) takes its sums from the engine's own log
    // (lib/stratalog.js, 2026-10-22). Every row of such a battery is listed, the ones no record reads included (an
    // unfinished, superseded or retired run used the engine too, and takes its share of a start it shared).
    const strataRuns = [];
    for (const run of runs) {
        const cfg = run.config || {};
        const srv = run.server || {};
        // Rows are read here rather than below because the scaffold lives on them, and the
        // scaffold is part of the key -- the model has to be looked up with it already folded in.
        let rows = [];
        try { rows = cb().getRun(run.dir, PATHS.codebenchRoot).rows || []; } catch { rows = []; }
        const c = batteryIdentity(run, [...new Set(rows.map((r) => r.scaffold).filter(Boolean))], queueLaunch.get(run.dir));
        if (!c) continue;
        const invalid = /^INVALID-/i.test(run.dir);
        const bat = { run, invalid, canonical: c, strataLaunch: strataLaunchName(queueLaunch.get(run.dir)), queueCmd: queueLaunch.get(run.dir) || null };
        let m = null;
        const model = () => {
            if (m) return m;
            m = get(c);
            // the Strata config it ran (groupEntriesByConfig: its speed facet, now that the speed-only name parts no longer split rows)
            m._batteries.push(bat);
            m.counts.qualityBatteries++;
            if (cfg.effort && !m.efforts.includes(cfg.effort)) m.efforts.push(cfg.effort);
            if (c.effort && !m.efforts.includes(c.effort)) m.efforts.push(c.effort);
            addSource(m, 'codebench', cfg.model || srv.model_path || `${cfg.runner || '?'} (no model recorded)`, c.via,
                { dir: run.dir, note: c.ambiguousNote || c.heuristicNote || null });
            if (srv.model_path) addSource(m, 'server.model_path', String(srv.model_path).split('/').pop(), 'model_path');
            return m;
        };
        // an empty battery still names its model, as before; one whose every row is unfinished or superseded does not
        if (!rows.length) model();
        // results of retired tasks stay on disk but are not part of any model's record
        const retired = retiredTaskIds();
        const engineLog = bat.strataLaunch ? strataLog.logOfConfig(strataConfigPath(bat.queueCmd)) : null;
        for (const row of rows) {
            // this run's place in its engine's log: placed only with a recorded start and its own wall clock (as runSpeed)
            const placed = engineLog && Number(row.wall_s) > 0 && row.ran_at && row.ran_at_source !== 'transcript_mtime'
                ? { key: {}, log: engineLog, from: row.ran_at, to: row.ran_at + Number(row.wall_s) * 1000, weight: Number(row.wall_s) } : null;
            if (placed) strataRuns.push(placed);
            if (retired.has(row.task)) { if (!row.superseded && !row.unfinished) model(); continue; }   // the battery still names its model, as before
            // the PROBLEM the row answers (2026-10-17): its task at its own prompt level -- read from the config that
            // runDescriptor files the row by (the row's own, else the battery's), so the row's column and its config row
            // can never disagree. An L2 row is kept as it is; a level row is `T@L3`, its result file's id kept as
            // `base_task` (transcripts, results and battery views are by file).
            const lc = (row.rowConfig && row.rowConfig.config) || cfg;
            const level = promptLevelOf(lc.prompt_level);
            const pid = problemId(row.task, level);
            const r = pid === row.task ? row
                : { ...row, task: pid, base_task: row.task, level, ...(row.bonus && row.parent ? { parent: problemId(row.parent, level) } : {}) };
            if (!row.bonus) rowsByKey.set(`${run.dir}/${String(row.file || '').replace(/\.json$/, '')}`, r);
            if (row.superseded) continue;
            if (row.unfinished) { if (!invalid) held.push({ c, bat, dir: run.dir, ended: run.ended || 0, row: r }); continue; }
            // the problem universe: a level problem is a problem once any result of it exists (any status, outside an
            // INVALID- battery); L2 tasks are in it from their task.yaml, run or not
            if (pid !== row.task && !invalid) levelProblems.add(pid);
            const entry = { dir: run.dir, ended: run.ended || 0, invalid, row: r, speed: runSpeed(timeline, row, run) };
            if (placed && entry.speed && entry.speed.none) placed.key = entry;   // the engine log answers only where the request log had nothing
            model()._qualityEntries.push(entry);
        }
    }
    if (strataRuns.length) for (const [e, sp] of strataLog.runSpeeds(strataRuns)) if (e.speed) e.speed = sp;
    // A CONTINUATION'S HISTORY: the run(s) it replaced, oldest first (a continuation of a continuation walks back the
    // chain). Display only: lab text (the question) goes under DROP-listed keys (lib/publicdata.js).
    const historyOf = (row) => {
        const out = [];
        let ct = row.continuation, guard = 0;
        while (ct && ct.src_dir && ct.src_file && guard++ < 10) {
            const src = rowsByKey.get(`${ct.src_dir}/${String(ct.src_file).replace(/\.json$/, '')}`) || null;
            const asked = (src && src.superseded && src.superseded.asked) || (src && src.unfinished && src.unfinished.question) || (src && src.answered && src.answered.asked) || null;
            out.unshift({ dir: ct.src_dir, file: ct.src_file, status: src ? src.status : (ct.previous_status || null),
                wall_s: src ? src.wall_s : (ct.previous_wall_s ?? null), at_s: ct.at_s ?? null, asked });
            ct = src && src.continuation;
        }
        return out;
    };
    for (const m of models.values()) for (const e of m._qualityEntries) {
        if (e.row.continuation && !e.row.bonus) e.row = { ...e.row, history: historyOf(e.row) };
    }
    // the unfinished rows of each model that has a row (the Solve map draws them in their config's row)
    for (const h of held) { const mm = models.get(h.c.key); if (mm) (mm._unfinishedEntries = mm._unfinishedEntries || []).push(h); }
    // every task of the suite + every level problem with a result: the catalog's taskMeta (the problems that are not
    // scored yet are in it, marked, and out of the total)
    const problemMeta = withLevelProblems(taskMeta, levelProblems);

    // --- BEST-CONFIGS ---
    const sections = readBestConfigs();
    levelUnscored = new Map();   // the samples below are folded before the minimum is known: nothing is marked yet
    for (const m of models.values()) {
        const s = matchBestConfigs(m, sections);
        m._tuning = s || null;
        const samples = foldQualityRows(m._qualityEntries, problemMeta);
        m._samples = samples;
        m.counts.qualityTasks = samples.length;
        m.quality = aggregateQuality(samples);
        m._diagSamples = foldDiagnosticRows(m._qualityEntries, problemMeta);
    }
    // --- which level problems earn points (LEVEL_MIN_CONFIGS) ---
    const rows = levelConfigRows(models, levelProblems);
    for (const id of levelProblems) {
        const t = problemMeta.get(id); if (!t) continue;
        const k = (rows.get(id) || new Set()).size;
        problemMeta.set(id, { ...t, scoredConfigs: k, ...(k < LEVEL_MIN_CONFIGS ? { unscored: true } : {}) });
        if (k < LEVEL_MIN_CONFIGS) levelUnscored.set(id, k);
    }
    for (const m of models.values()) { m.quality.counted = countedOf(m._samples); m.taskTotal = scoredTaskTotal(problemMeta); }
    return { models, sections, taskMeta: problemMeta, unfinished: held };
}
/** Level problem -> Set of the config rows (lib/configid cellKey: the Models page's default quality rows, tensor-split
 *  and f32ssm copies folded) with a scored result on it: outside INVALID- batteries, not an excluded status, and only
 *  rows the Models page fits (in the catalog, not harness-incompatible). */
function levelConfigRows(models, ids) {
    const out = new Map();
    if (!ids || !ids.size) return out;
    const { cellKey } = require('./configid');   // lazy: configid requires this module
    const internal = internalRowVariants();
    for (const m of models.values()) {
        if (neverIdentified(m) || isInternalRow(m.key, internal) || (m.quality && m.quality.harnessIncompatible)) continue;
        const byDir = new Map(m._batteries.map((b) => [b.run.dir, b]));
        for (const e of m._qualityEntries) {
            if (e.invalid || !ids.has(e.row.task) || EXCLUDED_STATUS.has(e.row.status)) continue;
            const b = byDir.get(e.dir); if (!b) continue;
            const rc0 = e.row.rowConfig;
            const run = rc0 ? { ...b.run, config: rc0.config || b.run.config, server: rc0.server || b.run.server } : b.run;
            if (!out.has(e.row.task)) out.set(e.row.task, new Set());
            out.get(e.row.task).add(cellKey(m.key, runDescriptor(run, m.provider, m.key).facets));
        }
    }
    return out;
}
/** Samples that count in a coverage figure: all but the level problems that are not scored yet. */
function countedOf(samples) { let n = 0; for (const s of samples || []) if (!isUnscoredProblem(s.row.task)) n++; return n; }

/**
 * Speed at a STATED context. `targetCtx` is honoured on BOTH sources: a request whose prompt
 * was 900 tokens says nothing about behaviour at 64k, so it is not allowed to answer for it.
 * Returns null when nothing was measured in the band -- an empty cell is honest, a number
 * borrowed from a different context is not.
 */
function speedAtContext(m, targetCtx) {
    return speedAtContextOf(m._bench, m._requests, targetCtx);
}

/**
 * The overview speed board's figures, per LAUNCH config, so the board can show a model under its
 * fastest config instead of a median across every config it was ever launched with.
 */
function speedConfigsFor(m) {
    const groups = new Map();
    // Grouped on the FULL launch command (normalizeLaunch), labelled with the short configKey.
    const at = (flags, cmd) => {
        const k = normalizeLaunch(cmd) || configKey(flags);
        if (!groups.has(k)) groups.set(k, { id: k, configKey: configKey(flags), flags, bench: [], requests: [] });
        return groups.get(k);
    };
    for (const b of m._bench) at(b.flags || {}, b.cmd).bench.push(b);
    for (const r of m._requests) {
        if (r.aborted) continue;
        const f = parseFlags(r.launchCommand || '');
        if (!f.ctx && r.ctx) f.ctx = r.ctx;
        at(f, r.launchCommand).requests.push(r);
    }
    return [...groups.values()].map((g) => ({
        id: g.id, configKey: g.configKey, buildId: buildIdFor(g.flags.binary),
        ctx: g.flags.ctx || null, specType: g.flags.specType || null,
        requests: g.requests.length, benchRuns: g.bench.length,
        at64k: speedAtContextOf(g.bench, g.requests, 65536),
        at8k: speedAtContextOf(g.bench, g.requests, 8192),
        // THE comparison point for the overview speed board: one context for every model, in a
        // tight band (24k-40k) so a config measured at 20k never stands in for 32k.
        at32k: speedAtContextOf(g.bench, g.requests, 32768, [0.75, 1.25]),
    })).filter((c) => c.at64k || c.at8k || c.at32k);
}

function speedAtContextOf(bench, requests, targetCtx, band = [0.5, 1.5]) {
    if (targetCtx == null) return null;
    const lo = targetCtx * band[0], hi = targetCtx * band[1];
    const inBand = (v) => v != null && v >= lo && v <= hi;
    const benchPre = [], benchGen = [];
    for (const b of bench) {
        for (const r of b.rows) {
            if (!inBand(r.depth || 0)) continue;
            if (r.kind === 'prefill') benchPre.push(r.tps);
            else if (r.kind === 'gen') benchGen.push(r.tps);
        }
    }
    if (benchPre.length || benchGen.length) {
        return { source: 'llama-bench', ctx: targetCtx, band: [lo, hi],
            prefillTps: median(benchPre), genTps: median(benchGen), n: benchPre.length + benchGen.length };
    }
    // Banded by context DEPTH (tokens in the context when prefill finished), never by the request's
    // new tokens: a 2k-token request on a 60k cache runs at 60k's speed. Requests that never recorded
    // their depth are left out rather than placed at a context they did not run at.
    const reqs = requests.filter((r) => !r.aborted && r.ctxDepth != null && (r.promptTokens ?? 0) > COLD_PREFILL_MIN_TOKENS && inBand(r.ctxDepth));
    if (!reqs.length) return null;
    return {
        source: 'logged requests', ctx: Math.round(median(reqs.map((r) => r.ctxDepth))), band: [lo, hi], depth: true,
        prefillTps: median(reqs.map((r) => r.promptTps)),
        genTps: median(reqs.map((r) => r.genTps)),
        n: reqs.length,
    };
}

// One key per distinct hardware record a request carries (prefillCurve): its machine and its own device list.
const namesSig = new WeakMap();
function evidenceKey(r) {
    const m = r.machine || null, n = r.deviceNames || null;
    let ns = '';
    if (n) { ns = namesSig.get(n); if (ns === undefined) { ns = JSON.stringify(Object.entries(n).sort()); namesSig.set(n, ns); } }
    return `${m ? (m.fingerprint || JSON.stringify([m.host || null, m.gpus || null])) : ''}|${ns}`;
}

function prefillCurve(m) {
    // median prefill t/s per prompt-token bucket, from the logged requests, split by config.
    const buckets = new Map();
    // The same buckets per LAUNCH config (normalizeLaunch): a model's all-config curve mixes XTX-only
    // with split, MTP with none, q8 with f16 KV -- Qwen3.8-27B Q4_K_XL has 19 configs -- so the chart
    // draws each model at its most-used config and offers every config on request.
    const perCfg = new Map();
    for (const r of m._requests) {
        if (r.aborted) continue;
        if ((r.promptTokens ?? 0) <= COLD_PREFILL_MIN_TOKENS) continue;   // cache hit, not a prefill rate
        if (r.promptTps == null) continue;
        if (r.ctxDepth == null) continue;   // no recorded depth: cannot be placed on a context axis
        const b = bucketPrompt(r.ctxDepth);
        if (!buckets.has(b)) buckets.set(b, []);
        buckets.get(b).push(r.promptTps);
        const id = normalizeLaunch(r.launchCommand) || 'unrecorded';
        if (!perCfg.has(id)) perCfg.set(id, { id, cmd: r.launchCommand || null, ctx: r.ctx || null, n: 0, buckets: new Map(), evidence: new Map() });
        const g = perCfg.get(id); g.n++;
        // which hardware record these requests carry: the group is one launch command, and one command has run on
        // more than one machine (the desktop before and after its second card; rows from before machines were recorded)
        const ek = evidenceKey(r);
        if (!g.evidence.has(ek)) g.evidence.set(ek, { machine: r.machine || null, names: r.deviceNames || null, n: 0 });
        g.evidence.get(ek).n++;
        if (!g.buckets.has(b)) g.buckets.set(b, []);
        g.buckets.get(b).push(r.promptTps);
    }
    const toPoints = (bm) => [...bm.entries()].sort((a, b) => a[0] - b[0])
        .map(([bucket, vals]) => ({ bucket, n: vals.length, median: median(vals), min: Math.min(...vals), max: Math.max(...vals) }));
    const fromRequests = toPoints(buckets);
    const describe = (g) => {
        if (!g.cmd) return { label: 'launch not recorded', configKey: 'unlabelled' };
        const f = parseFlags(g.cmd); if (!f.ctx && g.ctx) f.ctx = g.ctx;
        // The cards are named from the machine each request ran on (its `machines` row, the device list logged with
        // it), never from the machine building this catalog: `-dev CUDA0` was the laptop's RTX 4090 and the desktop's
        // RTX 3060 on the same day (2026-10-13: laptop runs read "RTX 3060 only" on the lab page and the public site).
        // One label per distinct record, then one for the config (lib/runlabel.js mergeDeviceLabels).
        const RL = require('./runlabel');
        let d = null; const seen = [];
        for (const e of (g.evidence.size ? g.evidence.values() : [{ machine: null, names: null, n: g.n }])) {
            let x = null;
            try { x = RL.describeRun({}, { launch_command: g.cmd, n_ctx: f.ctx || null, machine: e.machine, device_names: e.names }); } catch { x = null; }
            if (!x) continue;
            if (!d) d = x;
            seen.push({ label: x.devices ? x.devices.label : null, n: e.n, recorded: !!(e.machine || e.names) });
        }
        const devices = d ? RL.mergeDeviceLabels(seen) : null;
        const bits = d ? [devices, d.ctx && ctxLabel(d.ctx), d.kv && `KV ${d.kv}`, d.mtp ? 'MTP' : (d.spec ? d.spec : null)].filter(Boolean) : [];
        return { label: bits.join(' · ') || configKey(f), configKey: configKey(f) };
    };
    const byConfig = [...perCfg.values()].sort((a, b) => b.n - a.n || String(a.id).localeCompare(String(b.id)))
        .map((g) => ({ id: g.id, ...describe(g), n: g.n, points: toPoints(g.buckets) }));
    // Most-used = most depth-bearing requests. A primary config with a single bucket draws a dot, not
    // a curve: then the model's all-config aggregate is the better line, and the UI says which it drew.
    const primary = byConfig.length && byConfig[0].points.length >= 2 ? byConfig[0].id : null;
    // llama-bench gives the same curve measured cleanly, by depth
    const dm = new Map();
    for (const b of m._bench) for (const r of b.rows) {
        if (r.kind !== 'prefill') continue;
        const d = r.depth || 0;
        if (!dm.has(d)) dm.set(d, []);
        dm.get(d).push(r.tps);
    }
    const fromBench = [...dm.entries()].sort((a, b) => a[0] - b[0])
        .map(([depth, vals]) => ({ depth, n: vals.length, median: median(vals) }));
    return { fromRequests, fromBench, byConfig, primary };
}

function speedByConfig(m) {
    const map = new Map();
    const put = (key, flags, src, rec) => {
        if (!map.has(key)) map.set(key, { id: key, configKey: configKey(flags), flags, sources: new Set(), buildId: buildIdFor(flags && flags.binary), prefill: [], gen: [], wall: [], draft: [], n: 0 });
        const e = map.get(key);
        e.sources.add(src); e.n++;
        if (rec.promptTps != null && (rec.promptTokens ?? 0) > COLD_PREFILL_MIN_TOKENS) e.prefill.push(rec.promptTps);
        if (rec.genTps != null) e.gen.push(rec.genTps);
        if (rec.wallTime != null) e.wall.push(rec.wallTime);
        if (rec.draftAcceptRate != null) e.draft.push(rec.draftAcceptRate);
    };
    for (const r of m._requests) {
        if (r.aborted) continue;
        const f = parseFlags(r.launchCommand || '');
        if (!f.ctx && r.ctx) f.ctx = r.ctx;
        // Merged only on a perfect launch match; the short configKey is just the label.
        put(normalizeLaunch(r.launchCommand) || configKey(f), f, 'requests', r);
    }
    for (const row of m._sweep) for (const res of row.results) put(`${row.label} — ${row.configKey}`, row.flags, 'sweep', res);
    return [...map.values()].map((e) => {
        // Repeats of one measurement (sweep reps) get a +/-; a pile of differently sized real
        // requests gets a quartile band and no +/-.
        const reps = e.sources.size === 1 && e.sources.has('sweep');
        const band = (arr) => ({ p25: quantile(arr, 0.25), p75: quantile(arr, 0.75) });
        return {
        id: e.id, configKey: e.configKey, buildId: e.buildId,
        devices: e.flags && e.flags.devices, ts: e.flags && e.flags.ts, ctx: e.flags && e.flags.ctx,
        kvK: e.flags && e.flags.kvK, kvV: e.flags && e.flags.kvV, ncmoe: e.flags && e.flags.ncmoe,
        specType: e.flags && e.flags.specType, specDraftN: e.flags && e.flags.specDraftN,
        build: e.flags && e.flags.buildDir,
        ot: e.flags && e.flags.ot,
        residency: residencyOf(e.flags),
        reliability: reliabilityNotes(e.flags),
        sources: [...e.sources], n: e.n,
        repeats: reps,
        prefillTps: { median: median(e.prefill), n: e.prefill.length, spread: reps ? spread(e.prefill) : null, ...band(e.prefill) },
        genTps: { median: median(e.gen), n: e.gen.length, spread: reps ? spread(e.gen) : null, ...band(e.gen) },
        wall_s: { median: median(e.wall), n: e.wall.length, spread: reps ? spread(e.wall) : null, ...band(e.wall) },
        draftAcceptRate: { median: median(e.draft), n: e.draft.length },
        };
    }).sort((a, b) => (b.n - a.n));
}

/** Per-task map for the overview's "common tasks only" comparison. */
function taskMap(m) {
    const out = {};
    for (const s of m._samples || []) {
        // `excluded` means EVERY run of this task was excluded -- there is nothing to score. A
        // task whose latest run hit a provider error but which passed on another run is scored,
        // and solved. Taking both fields off the representative row produced rows that were
        // `excluded: true` AND `solved: true` at the same time, and made this map disagree with
        // aggregateQuality by two tasks on the same data (8/9 here, 10/11 there).
        const noAttempts = !s.attempts;
        out[s.row.task] = {
            status: s.row.status,
            solved: noAttempts ? false : (s.credit != null ? s.credit > 0 : !!s.row.solved),
            credit: s.credit, attempts: s.attempts || 0, passes: s.passes || 0,
            excluded: noAttempts,
            tier: s.tier, sample_group: s.sample_group, folded: s.folded,
            tokens_out: s.row.tokens_out, wall_s: s.row.wall_s, tool_calls: s.row.tool_calls,
            assertions: s.row.assertions, progress: s.progressAll || null, dir: s.dir,
            ...(s.resentPass ? { resent: s.resentPass } : {}),   // passed after a re-sent prompt (display only)
            ...(s.answered ? { answered: s.answered } : {}),   // answered with the original prompt (display only; answeredOfRuns)
            ...(s.overflowed ? { overflowed: s.overflowed } : {}),   // passed after outgrowing the context (display only; overflowedOfRuns)
            ...(isUnscoredProblem(s.row.task) ? { unscored: true } : {}),   // a level problem below LEVEL_MIN_CONFIGS
        };
    }
    return out;
}

/**
 * One row per (runner, effort, scaffold, n_ctx) within a model, scored the same way the model as
 * a whole is: fold all runs of a task to one fractional sample, then aggregate. Same grouping
 * key as the quality master list, so the two cannot disagree.
 */
/**
 * Per-ROW grouping of a model's codebench entries. Each result file records the config and server
 * that produced it; the battery's summary is only its first file's. Grouping on the row means a
 * battery whose server changed mid-run splits correctly instead of inheriting one config.
 */
function groupEntriesByConfig(m, policy, entries = m._qualityEntries) {
    const byDir = new Map(m._batteries.map((b) => [b.run.dir, b]));
    const groups = new Map();
    for (const e of entries) {
        const b = e.bat || byDir.get(e.dir);   // an unfinished entry carries its battery (it may be the only row of it)
        if (!b || b.invalid) continue;
        const rc0 = e.row.rowConfig;
        const run = rc0 ? { ...b.run, config: rc0.config || b.run.config, server: rc0.server || b.run.server } : b.run;
        run.ranAt = e.row.ran_at || null;
        const { identity, level, ...rc } = runDescriptor(run, m.provider, m.key);
        // SPEED PER STRATA CONFIG (2026-10-19). A Strata result records no launch command, so its launch facets are empty;
        // the row key used to carry the config name's speed parts (2xtx, pw2, kcopy, spec3, rb30, nopin) and now does not
        // (strataVariant). The config file it ran goes into the PLACEMENT facet instead: off for quality, so the configs of
        // one setup pool there, and on for speed, so the time groups (the solve-time fit, the compare page's per-config
        // token rates) stay one per launch config. A config pinned and one not pinned (rb30 / rb30-nopin, one engine
        // version) would otherwise be one time group. Not in the planner's or the solve map's keys (lib/configid.js
        // scheduleKey / cellKey: quality facets only).
        if (b.strataLaunch && rc.facets.placement == null) rc.facets.placement = [`${b.strataLaunch}.json`];
        // what the Strata config file says (strataLaunchInfo): display only, in no key
        if (b.strataInfo === undefined) b.strataInfo = new Map();
        // (keyed by engine version and whether the file was written after this run: one read per battery either way)
        const ranMs = Number(run.ranAt) || null;
        let si = strataLaunchInfo(b.queueCmd, run.server, ranMs);
        if (si) { const sk = JSON.stringify([si.engine, si.editedSince]); if (!b.strataInfo.has(sk)) b.strataInfo.set(sk, si); si = b.strataInfo.get(sk); rc.strata = si; }
        const gk = identity(policy);
        if (!groups.has(gk)) groups.set(gk, { key: gk, policy, ...rc, prompt_levels: [], devices: (run.server || {}).devices || null, dirs: [], entries: [], mixed: new Set() });
        const g = groups.get(gk);
        // THE AGENT WINDOW OF A MERGED ROW (2026-10-25). The group took its first run's fields (`...rc`), agentWindow with
        // them; since a run filed under its agent window shares a row with the in-step runs of that size (filedFacets), a
        // group can pool both (the Benchmarks board's quality rows: the Ornith 128k row). commonWindow (ui/shared/ctxlabel.js)
        // keeps the note only while every run so far carries the same one; otherwise the row reads plainly at its size.
        if (g.agentWindow && !commonWindow([g, rc])) delete g.agentWindow;
        if (si && si.editedSince && g.strata && !g.strata.editedSince) g.strata = si;   // any run of the group older than the file says so
        // Folded facets can differ inside one group (e.g. MTP on and off under Quality). Say so.
        g.mixed.add(JSON.stringify([rc.mtp, rc.facets.placement, rc.facets.build, rc.facets.machine]));
        // the prompt levels this config ran (its problems: T at L2, T@L3 at L3); not part of the row
        if (!g.prompt_levels.includes(level)) { g.prompt_levels.push(level); g.prompt_levels.sort(); }
        if (!g.dirs.includes(e.dir)) g.dirs.push(e.dir);
        g.entries.push(e);
    }
    return groups;
}

/** Unfinished entries -> { task: { n, compacted, saved, pruned, unknown, unfinishedNotes: [...] } }. `saved`: a saved
 *  session (and not known unrebuildable) waits for a continuation; pruned / unrebuildable may run fresh. */
function unfinishedMap(entries) {
    const out = {};
    for (const e of entries) {
        const u = e.row.unfinished || {};
        const t = out[e.row.task] || (out[e.row.task] = { n: 0, compacted: 0, saved: 0, pruned: 0, unknown: 0, unfinishedNotes: [] });
        t.n++;
        if (Number(u.compactions) > 0) t.compacted++;
        if (u.session === 'saved' && u.rebuildable !== false) t.saved++; else if (u.session === 'pruned' || u.rebuildable === false) t.pruned++; else t.unknown++;
        t.unfinishedNotes.push({ dir: e.dir, file: e.row.file || null, status: e.row.status || null, wall_s: e.row.wall_s ?? null,
            question: u.question || null, compactions: u.compactions ?? null, session: u.session || null, rebuildable: u.rebuildable ?? null,
            ai: e.row.askedAnswerable ? { answerable: e.row.askedAnswerable.answerable, note: e.row.askedAnswerable.note } : null });
    }
    return out;
}
function configsFor(m, policy = 'full') {
    const groups = groupEntriesByConfig(m, policy);
    const out = [];
    for (const g of groups.values()) {
        const samples = foldQualityRows(g.entries, readTaskMeta());
        if (!samples.length) continue;
        const agg = aggregateQuality(samples);
        const tasks = {};
        for (const s of samples) {
            // Same semantics as taskMap(): the overview's "common tasks only" recomputes a config
            // row from these, so they must agree with aggregateQuality on the same samples.
            const noAttempts = !s.attempts;
            tasks[s.row.task] = {
                status: s.row.status,
                solved: noAttempts ? false : (s.credit != null ? s.credit > 0 : !!s.row.solved),
                excluded: noAttempts,
                credit: s.credit, attempts: s.attempts, passes: s.passes,
                wall_s: s.row.wall_s, tokens_out: s.row.tokens_out, tool_calls: s.row.tool_calls,
                assertions: s.row.assertions, assertionsAll: s.assertionsAll || null, progressAll: s.progressAll || null, tier: s.tier,
                // when the latest run of it ran (the task page's date column)
                ran_at: s.row.ran_at || s.ended || null,
                // passed after a re-sent prompt (foldQualityRows resentPass): the Solve map marks it; display only
                ...(s.resentPass ? { resent: s.resentPass } : {}),
                // its question was answered with the original prompt on some run (answeredOfRuns): the Solve map's dark green
                ...(s.answered ? { answered: s.answered } : {}),
                // a passing run of it outgrew the context window and carried on (overflowedOfRuns): the Solve map's dark green too
                ...(s.overflowed ? { overflowed: s.overflowed } : {}),
                ...(isUnscoredProblem(s.row.task) ? { unscored: true } : {}),   // a level problem below LEVEL_MIN_CONFIGS: no points yet
                // prefill / generation token sums over its local runs (sumRunSpeed); absent for a cloud row
                ...(s.speedAll ? { speed: s.speedAll } : {}),
            };
            // Sample-group siblings count once (the kept one above). The others still RAN: keep
            // them in the map with their own outcome, out of scoring (excluded, no credit), so the
            // grid shows what happened instead of "never attempted" (Kyle, 2026-09-25).
            for (const f of (s.foldedRecs || [])) {
                tasks[f.row.task] = {
                    status: f.row.status, solved: !!(f.credit && f.credit > 0), excluded: true, credit: null,
                    folded_into: s.row.task, sample_group: s.sample_group, own_credit: f.credit,
                    attempts: f.attempts, passes: f.passes, wall_s: f.row.wall_s, tokens_out: f.row.tokens_out,
                    tool_calls: f.row.tool_calls, assertions: f.row.assertions, assertionsAll: f.assertionsAll || null,
                    progressAll: f.progressAll || null, tier: f.tier, ran_at: f.row.ran_at || f.ended || null,
                    ...(f.speedAll ? { speed: f.speedAll } : {}),
                    ...(f.answered ? { answered: f.answered } : {}),
                    ...(f.overflowed ? { overflowed: f.overflowed } : {}),
                };
            }
        }
        // diagnostic results of this config: shown, never scored
        const diagnostics = diagnosticMap(foldDiagnosticRows(g.entries, readTaskMeta()));
        agg.counted = countedOf(samples);
        out.push({ ...g, entries: undefined, mixed: undefined, foldedVariants: g.mixed.size, agg, tasks, ...(Object.keys(diagnostics).length ? { diagnostics } : {}) });
    }
    // UNFINISHED rows of each config (2026-10-19): `unfinished` beside `tasks`, never inside it -- so no tally that reads
    // `tasks` can see them. { task: { n, compacted, saved, pruned, unknown, unfinishedNotes } }; the notes (the question,
    // a reviewer's note) are lab only. A config with only unfinished rows has no row of its own (nothing scored).
    if (m._unfinishedEntries && m._unfinishedEntries.length) {
        const hg = groupEntriesByConfig(m, policy, m._unfinishedEntries);
        for (const o of out) { const h = hg.get(o.key); if (h) o.unfinished = unfinishedMap(h.entries); }
    }
    // best first, and a config with more evidence ahead of an equal one with less
    return out.sort((a, b) => (b.agg.solveRate ?? -1) - (a.agg.solveRate ?? -1) || b.agg.attempted - a.agg.attempted);
}

// The advisor a cloud row ran with: '' for the CLI default (/default, the Fable advisor of the early runs), the advisor's
// model id for the named scaffolds (advisor:<model>, solo+advisor:<model>; 2026-10-08), null for none. 2026-10-09: the
// named scaffolds were not recognised, so Haiku 5.5 + Opus/Sonnet advisor runs pooled into the solo Haiku 5.5 row.
const advisorOf = (key) => {
    const k = String(key);
    if (/\/default$/.test(k)) return '';
    const m = /\/(?:solo\+)?advisor:([\w.-]+)$/.exec(k);
    return m ? m[1] : null;
};
const isAdvisorKey = (key) => advisorOf(key) !== null;
const cloudEffortLabel = (key) => { const m = /@([a-z0-9]+)/.exec(String(key)); return m ? ` (${m[1]})` : ''; };
const advisorSuffix = (key) => { const a = advisorOf(key); return a === null ? '' : '+advisor' + (a ? ':' + a : ''); };
const advisorLabel = (key) => { const a = advisorOf(key); return a === null ? '' : ' + advisor' + (a ? ' ' + a.replace(/^claude-/, '') : ''); };

function publicSummary(m) {
    return {
        key: m.key, display: m.display, family: m.family, quant: m.quant,
        // One ROW of the combined boards. A local key already is one (one gguf, plus its thinking-off / other-runner /
        // helper variants). A cloud key carries effort and scaffold: the EFFORT LEVEL IS ITS OWN ROW (Kyle, 2026-10-09:
        // "cloud rows should NOT pool effort levels, as those aren't standardizable across different models from other
        // providers! that is the same reason no-thinking is its own row"), and so is an advisor scaffold -- a second
        // model is consulted (Kyle, 2026-09-24: Haiku solo vanished from the weighted charts behind +advisor). Only
        // solo vs unrecorded scaffold of one effort still share a row.
        weightsKey: m.provider === 'cloud' ? String(m.key).split('/')[0] + advisorSuffix(m.key) : m.key,
        weightsDisplay: m.provider === 'cloud' ? `${m.family || m.display}${cloudEffortLabel(m.key)}${advisorLabel(m.key)}` : m.display,
        provider: m.provider, vendor: m.vendor, efforts: m.efforts,
        ambiguous: m.ambiguous, ambiguousNote: m.ambiguousNote, unresolved: m.unresolved, why: m.why,
        counts: m.counts,
        sources: m.sources,
        quality: m.quality,
        // Per-CONFIG breakdown, not just the model-wide roll-up. A model's headline number can
        // hide two configurations that behave differently -- the same battery set at two context
        // sizes, or the same effort with and without an advisor -- and the roll-up averages them
        // into a figure that describes neither. The detail page is where that has to be visible.
        // `configs`: one row per distinct run config (every facet). The boards regroup these rows themselves
        // (ui/models/index.js); the pre-folded `qualityConfigs` copy was dropped 2026-10-06 -- nothing read it and
        // it was 30% of the catalog (729 KB).
        configs: configsFor(m, 'full'),
        tasks: taskMap(m),
        // diagnostic tasks' results (category `diagnostic`): their own section on the model page, out of every score
        diagnostics: diagnosticMap(m._diagSamples),
        taskTotal: m.taskTotal,
        batteries: m._batteries.map((b) => ({
            dir: b.run.dir, invalid: b.invalid, ended: b.run.ended, started: b.run.started,
            tasks: b.run.tasks, solved: b.run.solved, scored: b.run.scored, excluded: b.run.excluded, diagnostic: b.run.diagnostic || null,
            counts: b.run.counts, assertions: b.run.assertions,
            runner: (b.run.config || {}).runner || null, effort: (b.run.config || {}).effort || null,
            scaffold: (b.run.config || {}).scaffold || null,
            // the context the battery is filed under (effectiveContext: its agent's window when the harness recorded it out of
            // step) in words; agentWindow (display only) only then
            ...(() => { const x = effectiveContext(b.run.config || {}, b.run.server || {}); return { n_ctx: x.n_ctx || null, ctx_label: ctxLabel(x.n_ctx), ...(x.agentWindow ? { agentWindow: x.agentWindow } : {}) }; })(),
            devices: (b.run.server || {}).devices || null,
            build_info: (b.run.server || {}).build_info || null,
            via: b.canonical.via, note: b.canonical.ambiguousNote || b.canonical.heuristicNote || null,
        })),
        // Speed for the overview leaderboard. Cloud rows have no measured prefill: their only
        // speed number is tokens / wall, which is COARSE and must be labelled as such.
        speed: m.provider === 'cloud'
            ? { coarse: true, note: 'cloud: output tokens ÷ wall clock from codebench runs, not a measured prefill/decode rate',
                tokensPerSec: coarseCloudRate(m) }
            // The three summary points are for the leaderboard columns. `curve` is every bucket
            // we have: the overview chart used to plot at8k/at64k/atAny and draw a straight line
            // between them, which is a two-point sketch of a curve whose shape is the point.
            : { coarse: false, at64k: speedAtContext(m, 65536), at8k: speedAtContext(m, 8192), at32k: speedAtContext(m, 32768),
                curve: prefillCurve(m) },
        speedConfigs: m.provider === 'local' ? speedConfigsFor(m) : null,
        diskBytes: m.provider === 'local'
            ? diskBytesFor((m._batteries.find((b) => (b.run.server || {}).model_path) || { run: { server: {} } }).run.server.model_path
                || (m._requests.find((r) => r.modelPath) || {}).modelPath)
            : null,
        tuning: m._tuning ? { title: m._tuning.title, provisional: m._tuning.provisional, tuned: m._tuning.tuned } : null,
    };
}

function coarseCloudRate(m) {
    let tok = 0, wall = 0;
    for (const s of m._samples || []) {
        if (EXCLUDED_STATUS.has(s.row.status)) continue;
        if (s.row.tokens_out != null && s.row.wall_s) { tok += s.row.tokens_out; wall += s.row.wall_s; }
    }
    return wall > 0 ? tok / wall : null;
}

// ============================ public API ============================

/**
 * RELATIVE SOLVE TIME -- replaces "solves per hour", which never said solves OF WHAT: a config that
 * only ran easy tasks out-scored one that ran hard ones. For each task a config SOLVED, its wall
 * clock is divided by the median wall clock of every OTHER config (any model) that solved the same
 * task; the index is the geometric mean of those ratios. 0.5 = solves in half the time its peers
 * took on the same tasks; 2.0 = twice as long. Tasks nobody else solved have no peer and are
 * counted, not scored. Computed on FULL configs: MTP, build and placement all change a wall clock.
 */
const relTimeCache = new WeakMap();
function relativeSolveTimes(models) {
    if (relTimeCache.has(models)) return relTimeCache.get(models);
    const all = [];                           // {id, tasks}
    const byTask = new Map();                 // task -> [{id, wall}]
    const internal = internalRowVariants();
    for (const m of models.values()) {
        if (isInternalRow(m.key, internal)) continue;
        for (const c of configsFor(m, 'full')) {
            const id = m.key + '|' + c.key;
            all.push({ id, tasks: c.tasks });
            for (const [t, r] of Object.entries(c.tasks)) {
                if (!r.solved || r.excluded || !(r.wall_s > 0)) continue;
                if (!byTask.has(t)) byTask.set(t, []);
                byTask.get(t).push({ id, wall: r.wall_s });
            }
        }
    }
    const out = new Map();
    for (const { id, tasks } of all) {
        const logs = [];
        let noPeer = 0;
        for (const [t, r] of Object.entries(tasks)) {
            if (!r.solved || r.excluded || !(r.wall_s > 0)) continue;
            const peers = (byTask.get(t) || []).filter((x) => x.id !== id).map((x) => x.wall);
            if (!peers.length) { noPeer++; continue; }
            logs.push(Math.log(r.wall_s / median(peers)));
        }
        out.set(id, logs.length
            ? { index: Math.exp(logs.reduce((a, b) => a + b, 0) / logs.length), tasks: logs.length, noPeer }
            : { index: null, tasks: 0, noPeer });
    }
    relTimeCache.set(models, out);
    return out;
}
function withRelTimes(summary, models) {
    const rel = relativeSolveTimes(models);
    for (const c of summary.configs || []) c.agg.relSolveTime = rel.get(summary.key + '|' + c.key) || null;
    return summary;
}

function listModels(opts) {
    const { models, taskMeta } = buildIndex(!!(opts && opts.fresh));
    const skills = readSkills();
    const out = [...models.values()]
        .filter((m) => m.counts.requests || m.counts.benchRuns || m.counts.sweepRows || m.counts.qualityBatteries)
        .filter((m) => !hiddenFromCatalog(m))
        .map((m) => withRelTimes(publicSummary(m), models));
    out.sort((a, b) => (b.counts.qualityTasks - a.counts.qualityTasks) || (b.counts.requests - a.counts.requests) || a.display.localeCompare(b.display));
    return {
        models: out,
        taskTotal: scoredTaskTotal(taskMeta),
        levelMinConfigs: LEVEL_MIN_CONFIGS,
        allTaskIds: out_allTaskIds.slice(),
        diagnosticTaskIds: [...taskMeta.values()].filter((t) => t.diagnostic).map((t) => t.id),
        // Public metadata per task for the task page. Built field by field so nothing from the
        // answer key (prompt, hidden tests, fix sha) can ride along by accident.
        taskMeta: Object.fromEntries([...taskMeta.values()].map((t) => [t.id, {
            repo: t.repo || null, variant: t.variant || (t.repo === '_synthetic' ? 'synthetic' : null), tier: t.tier || null, category: t.category || [],
            ...(t.diagnostic ? { diagnostic: true } : {}),
            sample_group: t.sample_group || null, incident_date: t.incident_date || null, timeout_s: t.timeout_s ?? null,
            story: t.story || null, probes: t.probes || null, weak_model_failure: t.weak_model_failure || null,
            // a bonus test (`<id>+bonus`): its parent and display label; skill tags + the bonus's skill note (report card)
            ...(t.bonus ? { bonus: true, parent: t.parent, label: t.label, bonus_note: t.extra_skill || null } : {}),
            // a level problem (`T@L3`, 2026-10-17): its level, its task (the task page's info and link) and its label
            ...(t.level ? { level: t.level, base: t.base, label: t.label, scoredConfigs: t.scoredConfigs ?? 0, ...(t.unscored ? { unscored: true } : {}) } : {}),
            skills: skillsOf(t.id, skills),
        }])),
        // the report card's tag definitions (tasks/skills.json); public, like the tags
        skillTags: skills.tags,
        generatedAt: Date.now(),
        sources: {
            requests: PATHS.csv, llamaBench: PATHS.benchLog, sweep: PATHS.sweepState,
            codebench: path.join(PATHS.codebenchRoot, 'results'), bestConfigs: PATHS.bestConfigs,
        },
    };
}

function getModel(key, opts) {
    const { models, sections } = buildIndex();
    const m = models.get(key);
    if (!m) return null;
    // an internal row is not in the catalog and has no page; `includeInternal` is the lab's own way to look at one
    if (isInternalRow(m.key) && !(opts && opts.includeInternal)) return null;
    const base = withRelTimes(publicSummary(m), models);
    const section = m._tuning;
    return {
        ...base,
        speedDetail: {
            curve: prefillCurve(m),
            byConfig: speedByConfig(m),
            benchBlocks: m._bench.map((b) => ({ title: b.title, time: b.time, cmd: b.cmd, buildId: buildIdFor(b.flags.binary), flags: b.flags, rows: b.rows })),
            sweepRows: m._sweep.map((r) => ({
                label: r.label, status: r.status, error: r.error, configKey: r.configKey, flags: r.flags,
                reps: r.results.length,
                prefillTps: median(r.results.filter((x) => (x.promptTokens ?? 0) > COLD_PREFILL_MIN_TOKENS).map((x) => x.promptTps)),
                genTps: median(r.results.map((x) => x.genTps)),
                wall_s: median(r.results.map((x) => x.wallTime)),
                draftAcceptRate: median(r.results.map((x) => x.draftAcceptRate)),
            })),
        },
        qualityDetail: {
            samples: (m._samples || []).map((s) => ({
                // base_task: a level problem's result file id (`T` for `T@L3`), what the battery / transcript views open
                task: s.row.task, ...(s.row.base_task ? { base_task: s.row.base_task, level: s.row.level } : {}),
                dir: s.dir, tier: s.tier, sample_group: s.sample_group, folded: s.folded,
                status: s.row.status, status_derived: s.row.status_derived, solved: !!s.row.solved,
                excluded: EXCLUDED_STATUS.has(s.row.status),
                assertions: s.row.assertions, p2p: s.row.p2p, p2p_broken: s.row.p2p_broken,
                tokens_in: s.row.tokens_in, tokens_out: s.row.tokens_out, tool_calls: s.row.tool_calls,
                wall_s: s.row.wall_s, anomalies: s.row.anomalies,
                progress: s.progressAll || null,
                ...(s.answered ? { answered: s.answered } : {}),   // display only (answeredOfRuns)
                ...(s.overflowed ? { overflowed: s.overflowed } : {}),   // display only (overflowedOfRuns)
            })).sort((a, b) => String(a.task).localeCompare(String(b.task))),
            // runs whose question is not answered yet (lab only: lib/publicdata.js drops the key): listed, never counted
            unfinishedRuns: (m._unfinishedEntries || []).filter((e) => !e.row.bonus).map((e) => ({ task: e.row.task, dir: e.dir, file: e.row.file || null,
                status: e.row.status || null, wall_s: e.row.wall_s ?? null, question: (e.row.unfinished || {}).question || null,
                compactions: (e.row.unfinished || {}).compactions ?? null, session: (e.row.unfinished || {}).session || null,
                rebuildable: (e.row.unfinished || {}).rebuildable ?? null,
                ai: e.row.askedAnswerable ? { answerable: e.row.askedAnswerable.answerable, note: e.row.askedAnswerable.note } : null }))
                .sort((a, b) => String(a.task).localeCompare(String(b.task))),
        },
        history: {
            // the per-request series, oldest first; every field the History tab already trusts
            series: m._requests.map((r) => ({
                t: r.t, runId: r.runId, promptTokens: r.promptTokens, promptTps: r.promptTps,
                genTokens: r.genTokens, genTps: r.genTps, wall_s: r.wallTime, ctx: r.ctx,
                draftAcceptRate: r.draftAcceptRate, aborted: r.aborted,
            })),
            total: m._requests.length,
        },
        tunings: section ? {
            title: section.title,
            provisional: section.provisional,
            tuned: section.tuned,
            build: section.build || null,
            current: section.current ? { flags: section.current.flags, parsed: section.current.parsed } : null,
            superseded: section.history.map((b) => ({ flags: b.flags, parsed: b.parsed })),
            supersedeNote: section.supersedeNote || null,
            constraints: section.constraints || [],
            notes: section.notes.slice(0, 40),
            tables: section.tables,
            file: PATHS.bestConfigs,
        } : { missing: true, file: PATHS.bestConfigs, available: sections.map((s) => s.title) },
    };
}

/**
 * Leaderboard rows. Deliberately NOT per model:
 *  - quality rows are CONFIGS (model + runner + effort + scaffold + n_ctx). "claude at default
 *    scaffold" and "claude solo" are different contestants -- the default scaffold inherits a
 *    Fable advisor, and the suite has already been bitten by treating them alike.
 *  - speed rows are CONFIGS too (build + devices + ts + n_ctx + KV type + offload flags),
 *    because the same binary measured 6.6x apart on ROCm vs Vulkan for one model.
 */
function listLeaderboards() {
    const { models, taskMeta } = buildIndex();
    const quality = [];
    const speed = [];

    for (const m of models.values()) {
        if (hiddenFromCatalog(m)) continue;
        // ---- quality: one row per config under the Quality grouping, per ROW's own config ----
        const groups = groupEntriesByConfig(m, 'quality');
        for (const g of groups.values()) { g.modelKey = m.key; g.model = m.display; g.provider = m.provider; delete g.mixed; }
        for (const g of groups.values()) {
            const samples = foldQualityRows(g.entries, taskMeta);
            if (!samples.length) continue;
            const agg = aggregateQuality(samples);
            const tasks = {};
            for (const s of samples) {
                // Same semantics as taskMap()/configsFor(): fractional credit across runs, and
                // `excluded` only when no run was scoreable. The codebench board recomputes from this.
                const noAttempts = !s.attempts;
                tasks[s.row.task] = {
                    status: s.row.status,
                    solved: noAttempts ? false : (s.credit != null ? s.credit > 0 : !!s.row.solved),
                    excluded: noAttempts, credit: s.credit, attempts: s.attempts, passes: s.passes,
                    tokens_out: s.row.tokens_out, wall_s: s.row.wall_s, tool_calls: s.row.tool_calls,
                    assertions: s.row.assertions, tier: s.tier,
                    ...(isUnscoredProblem(s.row.task) ? { unscored: true } : {}),
                };
            }
            agg.counted = countedOf(samples);
            quality.push({ ...g, entries: undefined, agg, tasks, taskTotal: scoredTaskTotal(taskMeta) });
        }

        // ---- speed: local models only; a cloud model has no measured prefill ----
        if (m.provider !== 'local') continue;
        for (const b of m._bench) {
            // ONE row per depth. Median-ing pp8192 and "pp8192 @ d98304" together would print a
            // rate that was never measured at any context -- the exact thing this board forbids.
            const depths = [...new Set(b.rows.map((r) => r.depth || 0))].sort((a, x) => a - x);
            for (const d of depths) {
                const at = b.rows.filter((r) => (r.depth || 0) === d);
                const pre = at.filter((r) => r.kind === 'prefill');
                const gen = at.filter((r) => r.kind === 'gen');
                const title = /^(llama-server:|sweep:)/.test(b.title || '') ? 'llama-bench' : (b.title || 'llama-bench');
                speed.push({
                    key: `bench|${m.key}|${b.title}|${b.time}|d${d}`, source: 'llama-bench', measured: true,
                    modelKey: m.key, model: m.display, label: `${title} @ d${d}`,
                    flags: b.flags, buildId: buildIdFor(b.flags.binary), configKey: configKey(b.flags),
                    ctx: d || b.flags.ctx || 0,
                    prefillTps: median(pre.map((r) => r.tps)), genTps: median(gen.map((r) => r.tps)),
                    // llama-bench reports its own +/- per row; carry it rather than dropping it.
                    prefillSpread: median(pre.map((r) => r.stddev)), genSpread: median(gen.map((r) => r.stddev)),
                    kv: b.flags.kvK ? `${b.flags.kvK}${b.flags.kvV && b.flags.kvV !== b.flags.kvK ? '/' + b.flags.kvV : ''}` : (at[0] && at[0].raw ? (at[0].raw.type_k || null) : null),
                    workload: { promptTokens: (pre[0] && pre[0].n) || null, genTokens: (gen[0] && gen[0].n) || null },
                    n: at.length, wall: null, draftAcceptRate: null,
                    residency: residencyOf(b.flags),
                    warnings: ['llama-bench measures raw decode with NO speculative decoding — its gen number is a no-spec baseline', 'no wall time: llama-bench reports rates, not a workload', ...reliabilityNotes(b.flags)],
                });
            }
        }
        for (const r of m._sweep) {
            const cold = r.results.filter((x) => (x.promptTokens ?? 0) > COLD_PREFILL_MIN_TOKENS);
            const warnings = [];
            // Reps 2+ of a sweep send the identical prompt, so llama.cpp serves them from the
            // prompt cache: their "prompt t/s" is per-request overhead over ~4 tokens, which
            // reads ~2.7x too slow if averaged in. Cold reps only, and say how many that was.
            if (cold.length < r.results.length) warnings.push(`${r.results.length - cold.length} of ${r.results.length} reps were prompt-cache hits; prefill uses the ${cold.length} cold rep(s) only`);
            if (r.results.length < 3) warnings.push(`only ${r.results.length} rep(s)`);
            speed.push({
                key: `sweep|${m.key}|${r.label}`, source: 'launch sweep', measured: true,
                modelKey: m.key, model: m.display, label: r.label,
                flags: r.flags, buildId: buildIdFor(r.flags.binary), configKey: r.configKey,
                ctx: r.flags.ctx || null,
                prefillTps: median(cold.map((x) => x.promptTps)), genTps: median(r.results.map((x) => x.genTps)),
                prefillSpread: spread(cold.map((x) => x.promptTps)), genSpread: spread(r.results.map((x) => x.genTps)),
                kv: r.flags.kvK ? `${r.flags.kvK}${r.flags.kvV && r.flags.kvV !== r.flags.kvK ? '/' + r.flags.kvV : ''}` : null,
                // The wall clock IS the answer to "which config is fastest for real work":
                // generation t/s alone ranks the wrong config when the workload is prefill-heavy,
                // which codebench's is. Stated with the workload it was measured on.
                workload: { promptTokens: (r.results[0] || {}).promptTokens ?? null, genTokens: (r.results[0] || {}).genTokens ?? null },
                wall: median(r.results.map((x) => x.wallTime)), wallSpread: spread(r.results.map((x) => x.wallTime)),
                draftAcceptRate: median(r.results.map((x) => x.draftAcceptRate)),
                n: r.results.length, status: r.status,
                residency: residencyOf(r.flags),
                warnings: warnings.concat(reliabilityNotes(r.flags)),
            });
        }
        // The BEST-CONFIGS entry is a CLAIM, not a measurement of its own -- marked as such so
        // it can never outrank a measured row without the reader noticing.
        if (m._tuning && m._tuning.current) {
            speed.push({
                key: `best|${m.key}`, source: 'BEST-CONFIGS.md', measured: false,
                modelKey: m.key, model: m.display, label: m._tuning.title,
                flags: m._tuning.current.parsed, buildId: buildIdFor(m._tuning.current.parsed.binary),
                configKey: configKey(m._tuning.current.parsed),
                ctx: m._tuning.current.parsed.ctx || null,
                prefillTps: null, genTps: null, wall: null, draftAcceptRate: null, n: null,
                prefillSpread: null, genSpread: null, wallSpread: null,
                kv: m._tuning.current.parsed.kvK ? `${m._tuning.current.parsed.kvK}${m._tuning.current.parsed.kvV && m._tuning.current.parsed.kvV !== m._tuning.current.parsed.kvK ? '/' + m._tuning.current.parsed.kvV : ''}` : null,
                workload: null,
                provisional: !!m._tuning.provisional,
                residency: residencyOf(m._tuning.current.parsed),
                warnings: m._tuning.provisional
                    ? ['PROVISIONAL — nothing measured yet; a starting point, not a recommendation']
                    : ['documented best-known config, not a measurement in this table'],
            });
        }
    }
    return { quality, speed, taskTotal: scoredTaskTotal(taskMeta), generatedAt: Date.now() };
}

/**
 * Per-task historical baseline, for the Live view: "solved by 7 of 9 configs · median 4m 00s
 * · median 12k tok". Aggregated over every non-INVALID battery, one sample per (task, config)
 * so re-running the same config does not inflate the denominator, and sample_group siblings
 * share one baseline (they are the same bug at two stages).
 */
function taskHistory() {
    const { models, taskMeta } = buildIndex();
    // task -> config -> latest row
    const byTask = new Map();
    for (const m of models.values()) {
        if (hiddenFromCatalog(m)) continue;   // never identified, nothing scored: off the task page as off the grid
        const byDir = new Map(m._batteries.map((b) => [b.run.dir, b]));
        for (const e of m._qualityEntries) {
            const b = byDir.get(e.dir);
            if (!b || b.invalid) continue;
            // per ROW config, as in groupEntriesByConfig
            const rc0 = e.row.rowConfig;
            const run = rc0 ? { ...b.run, config: rc0.config || b.run.config, server: rc0.server || b.run.server } : b.run;
            run.ranAt = e.row.ran_at || null;
            const desc = runDescriptor(run, m.provider, m.key);
            const meta = { invalid: false, ended: b.run.ended || 0, config: desc.identity('full'),
                modelKey: m.key, modelDisplay: m.display, cfgShort: shortAttemptLabel(desc) };
            const t = e.row.task;
            if (!byTask.has(t)) byTask.set(t, new Map());
            const per = byTask.get(t);
            const prev = per.get(meta.config);
            if (!prev || meta.ended >= prev.ended) per.set(meta.config, { ...meta, row: e.row, dir: e.dir });
        }
    }
    const out = {};
    for (const [task, per] of byTask.entries()) {
        const list = [...per.values()];
        const scored = list.filter((x) => !EXCLUDED_STATUS.has(x.row.status));
        const solved = scored.filter((x) => SOLVED_STATUS.has(x.row.status));
        out[task] = {
            task,
            tier: (taskMeta.get(task) || {}).tier || null,
            sample_group: (taskMeta.get(task) || {}).sample_group || null,
            ...(isDiagnosticTask(task, taskMeta) ? { diagnostic: true } : {}),
            configs: scored.length, solvedBy: solved.length, excluded: list.length - scored.length,
            wall_s: { median: median(solved.map((x) => x.row.wall_s)), mean: mean(solved.map((x) => x.row.wall_s)), max: solved.length ? Math.max(...solved.map((x) => x.row.wall_s || 0)) : null },
            tokens_out: { median: median(solved.map((x) => x.row.tokens_out)), mean: mean(solved.map((x) => x.row.tokens_out)) },
            tokens_in: { median: median(solved.map((x) => x.row.tokens_in)), mean: mean(solved.map((x) => x.row.tokens_in)) },
            // Every scored config's latest attempt, pass or fail (Live view's per-task chart: where does
            // this run sit among everyone who tried the task?). Fastest first.
            attempts: scored.map((x) => ({ model: x.modelDisplay, cfg: x.cfgShort, status: x.row.status,
                solved: SOLVED_STATUS.has(x.row.status), wall_s: x.row.wall_s ?? null, tokens_out: x.row.tokens_out ?? null,
                tokens_in: x.row.tokens_in ?? null, dir: x.dir }))
                .sort((a, b) => (a.wall_s ?? Infinity) - (b.wall_s ?? Infinity)),
            allWall_s: { median: median(scored.map((x) => x.row.wall_s)) },
            best: solved.length ? { model: solved.map((x) => x.modelDisplay)[0], wall_s: Math.min(...solved.map((x) => x.row.wall_s || Infinity)) } : null,
        };
    }
    // sample_group siblings share a baseline: the same bug measured twice is one history.
    const groups = new Map();
    for (const t of Object.keys(out)) { const g = out[t].sample_group; if (g) { if (!groups.has(g)) groups.set(g, []); groups.get(g).push(t); } }
    for (const [g, ids] of groups.entries()) {
        if (ids.length < 2) continue;
        const merged = {
            configs: Math.max(...ids.map((t) => out[t].configs)),
            solvedBy: Math.max(...ids.map((t) => out[t].solvedBy)),
            wall_s: { median: median(ids.map((t) => out[t].wall_s.median)), max: Math.max(...ids.map((t) => out[t].wall_s.max || 0)) || null },
            tokens_out: { median: median(ids.map((t) => out[t].tokens_out.median)) },
        };
        for (const t of ids) out[t] = { ...out[t], ...merged, folded_with: ids.filter((x) => x !== t) };
    }
    return { tasks: out, taskTotal: scoredTaskTotal(taskMeta), generatedAt: Date.now() };
}

function mean(a) { const v = (a || []).filter((x) => typeof x === 'number' && Number.isFinite(x)); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : null; }
// "Swift-Qwen3.8-27B Q4_K_L" is the model; this is what else made the attempt distinct, briefly:
// harness (when not opencode), effort / scaffold (cloud), context, KV, MTP.
function shortAttemptLabel(d) {
    const f = d.facets || {}, parts = [];
    if (d.runner === 'claude' || d.runner === 'agy') return f.served || '';   // the display name already says effort/scaffold
    if (d.runner && d.runner !== 'opencode') parts.push(d.runner);
    if (d.n_ctx) parts.push(d.ctx_label || ctxLabel(d.n_ctx));
    const kv = Array.isArray(f.kv) ? f.kv.join(' ') : (f.kv || '');
    const km = /cache-type-k\s+(\S+)/.exec(kv) || /-ctk\s+(\S+)/.exec(kv);
    if (km) parts.push(`kv ${km[1].replace('_0', '')}`);
    if (d.mtp) parts.push('MTP');
    if (f.served) parts.push(f.served);
    return parts.join(' · ');
}

function resetCaches() {
    csvCache = { sig: null, rows: null };
    benchLogCache = { sig: null, blocks: null };
    indexCache = { sig: null, requests: null, at: 0, value: null };
    bestCache = { sig: null, sections: null };
    taskMetaCache = { at: 0, map: null };
    skillsCache = { sig: null, v: null };
    displayNamesCache = { sig: null, map: {} };
    dashConfigCache = { sig: null, cfg: {} };
}

module.exports = {
    listModels, getModel, listLeaderboards, taskHistory, canonicalModel, configure, resetCaches, catalogSignature,
    // pure pieces, exported for tests
    splitGgufName, parseFlags, configKey, ctxLabel, effectiveContext, filedFacets, withScaffold, withLocalVariant, withWeightsFile, batteryIdentity, primeWeights, queueLaunchByBattery, buildIndex, rowVariant, isInternalRow, reliabilityNotes, buildIdFor, strataVariant, strataLaunchName, strataLaunchInfo, describeRunning, runDescriptor, parseBestConfigs, parseTaskYaml, retiredTaskIds, diagnosticTaskIds, isDiagnosticTask, scoredTaskTotal, foldDiagnosticRows, diagnosticMap,
    parseLlamaBenchLog, foldQualityRows, aggregateQuality, bucketPrompt, prefillCurve, readSkills, skillsOf, readTaskMeta, overflowedOfRuns,
    promptLevelOf, promptWithoutLevel, problemId, problemOf, metaOf, withLevelProblems, LEVEL_MIN_CONFIGS, isUnscoredProblem,
    mean, median, spread, quantile, matchBestConfigs, splitCsvLine, runSpeed, sumRunSpeed,
    OPENCODE_ALIAS, BATTERY_MODEL, CLOUD, STATUS_ORDER, EXCLUDED_STATUS,
};
