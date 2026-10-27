'use strict';
/**
 * CONFIG IDENTITY -- one definition of "the same config" for everything that decides what has already run
 * (2026-10-15, Kyle: "Thinking off should NEVER be blended with thinking on... Why would a different q blend with this
 * one?" and "Prevent duplicate runs").
 *
 * Until now each consumer had its own predicate: the queue's cascade and dropScored took `model_path LIKE '%<name>%'`
 * + n_ctx + the 2 h cap (so a thinking-off, review-prompt, pi, tau or Jeff run of the same file counted as a run of
 * the plain config, and a profile preset's '%Qwen3.8-27B%' matched every 27B quant); idle-guard keyed on file name,
 * context, runner + prompt suffix and the literal `--reasoning off`; the planner on the catalog row + context + cap.
 *
 * The identity here IS the dashboard's: the catalog model a battery is filed under (lib/models.js batteryIdentity:
 * the weights FILE by content, effort, scaffold, thinking off, Strata variant, helper model, declared row variant,
 * runner + its scaffold), with the two folds the Models page applies by default -- tensor-split rows and the f32ssm
 * file copies join their base model (Kyle: same weights, same results) -- and then the harness (runner / runner model /
 * effort / scaffold / prompt level / harness mode / time cap) and the context size: scheduleKey() below. The Models
 * page's finer solve-map cell (cellKey: + KV type, every output flag, unclassified flags) is kept for reference; the
 * queue does not re-run a task over KV type alone.
 *
 * FOLD RULES: the browser's copy lives in ui/shared/leaderboard.js (tensorBaseKey, fileBaseKey, FACET_DEFAULTS) and
 * cannot be require()d from here (browser ESM, Node 20). TENSOR_PART / FILE_VARIANTS / QUALITY_FACETS below are the
 * same tables; test/configid.test.js loads leaderboard.js and fails if the two ever differ.
 */
const fs = require('fs');
const path = require('path');
const M = require('./models');

const TENSOR_PART = /^rv:tensor-split[\w.-]*$/i;
const FILE_VARIANTS = Object.freeze({
    'local:qwen3.8-27b-gsq-rco-iq2-xs-mtp-f32ssm:unknown': 'local:qwen3.8-27b-gsq-rco-iq2-xs-mtp:unknown',
    'local:qwen3.8-27b-gsq-rco-iq2-s-mtp-f32ssm:unknown': 'local:qwen3.8-27b-gsq-rco-iq2-s-mtp:unknown',
    'local:qwen3.8-27b-gsq-rco-iq3-xxs-mtp-f32ssm:unknown': 'local:qwen3.8-27b-gsq-rco-iq3-xxs-mtp:unknown',
});
const QUALITY_FACETS = Object.freeze(['harness', 'context', 'output', 'kv', 'other']);
const BONUS = /\+bonus$/;
const RUN_SUFFIX = /__r\d+$/;

/** A catalog model key as the Models page files it by default: tensor-split part dropped, f32ssm copy -> original. */
function rowKeyOf(key) {
    let parts = String(key || '').split('~');
    const kept = parts.filter((p) => !TENSOR_PART.test(p));
    if (kept.length && kept.length !== parts.length) parts = kept;
    if (FILE_VARIANTS[parts[0]]) parts = [FILE_VARIANTS[parts[0]], ...parts.slice(1)];
    return parts.join('~');
}

/** The solve-map cell key of a config: folded weights + the quality facets (leaderboard.js groupKeyOf). */
function cellKey(modelKey, facets) {
    const f = { ...(facets || {}), weights: rowKeyOf(modelKey) };
    return JSON.stringify(['weights', ...QUALITY_FACETS].map((k) => [k, f[k] ?? null]));
}

/**
 * THE SCHEDULING KEY -- what "already ran at this config" means for the queue, the cascade, idle-guard and the duplicate
 * guard: the folded catalog ROW (weights file by content, thinking off, row / Strata / helper variant, runner + scaffold,
 * effort), the whole HARNESS facet (runner, cloud model id, effort, scaffold, prompt level, harness mode, time cap), the
 * CONTEXT size, and any output flag other than --jinja (e.g. --reasoning-preserve; thinking off is already in the row).
 * KV type, unclassified flags, MTP, placement, build and machine are NOT in it: a task scored at KV q8_0 is not queued
 * again at f16 (the Q6_K_XL two-XTX KV q8 runs stay the Q6 benchmark config's, as the planner has had it since 10-14),
 * exactly as the old model/context/cap predicate behaved -- minus its blends. A launch-unrecorded run (output null,
 * no context flags) keys like a recorded one at the same context.
 */
// PROMPT LEVEL (2026-10-17): a config's row no longer includes its prompt level (lib/models.js runDescriptor: a result at
// L3 is the problem `T@L3` of the same row), but "already ran" still compares PROBLEMS: an L2 run of T does not cover T
// at L3, nor the other way round. So the level goes back into this key, inside the harness, exactly where it was
// (`level`: runDescriptor's): the key string is byte for byte what it was before (run.py's dedupe guard, idle-guard and
// tools/tier-list.py read it), and scoredIndex files each result under its task id within it.
function scheduleKey(modelKey, facets, level) {
    const f = facets || {};
    const out = (Array.isArray(f.output) ? f.output : []).filter((x) => x !== '--jinja' && !/^(?:--reasoning|-rea)\s+off$/.test(x)).sort();
    const lvl = level ? String(level).toUpperCase() : 'L2';
    const h = f.harness && lvl !== 'L2' ? { ...f.harness, prompt_level: String(f.harness.prompt_level || 'L2').replace(/^L2/, lvl) } : (f.harness ?? null);
    return JSON.stringify([['row', rowKeyOf(modelKey)], ['harness', h], ['n_ctx', (f.context && f.context.n_ctx) || null], ['output', out]]);
}

const STRATA = /\/Strata[^/\s]*\/queue-serve\.sh/;
/** The .gguf and the context a Strata config json names (its server records no launch command; the result's
 *  server.model_path / n_ctx are what /props reported). Best effort: nulls when the json cannot be read. */
function strataServer(cmd) {
    const m = /(\S+\.json)(?:\s|$)/.exec(String(cmd || ''));
    if (!m) return { model_path: null, n_ctx: null };
    try {
        const txt = fs.readFileSync(m[1], 'utf-8');
        const g = /"([^"]+\.gguf)"/.exec(txt);
        const c = /"--max-context"\s*,\s*"(\d+)"/.exec(txt);
        return { model_path: g ? g[1] : null, n_ctx: c ? Number(c[1]) : null };
    } catch { return { model_path: null, n_ctx: null }; }
}

/**
 * A config that has not produced a result yet, as a battery record: `spec` =
 *   { dir, config: {runner, model, prompt_level, harness_mode, timeout_s, effort, scaffold} (run.py's own battery
 *     config: harness/run.py --print-config), server?: the server dict run.py recorded (model_path, n_ctx,
 *     launch_command, weights) -- else derived from `launch`, launch: the EXPANDED launch command, env: the item's env
 *     (CODEBENCH_ROW_VARIANT), queueCmd?: the queue command as queueLaunchByBattery has it }
 * -> { run, queueCmd, scaffolds }
 *
 * THE CONTEXT (2026-10-25): the key's n_ctx is lib/models.js runDescriptor's -- `config.agent_window.effective_ctx`
 * when the config carries one (run.py's battery config since 10-25: the in-battery guard, a running item's battery.json),
 * else the server's n_ctx, which for a config not started yet is the launch command's -c or the Strata config's
 * --max-context: the harness puts the agent's alias in step with that server before the first task, so the result is
 * filed there. An item with CODEBENCH_AGENT_WINDOW=as-asked keeps a smaller window on purpose; its pre-launch identity
 * is still the -c one (the alias window is not modelled here), so such an item needs CODEBENCH_ALLOW_RERUN, or the
 * queue's pre-launch dedupe drops the tasks the server-context row already scored. Its results and its in-battery guard
 * are keyed at its effective_ctx.
 * Since ~13:00 10-25 effective_ctx out of step is the server size the window runs on in step (local-128k -> 131072, the
 * harness's nominal_ctx), and runDescriptor files such a run's context flags at that size too (lib/models.js
 * filedFacets; the server's own -c goes to placement): it has the schedule key and the solve-map cell of the in-step runs
 * of that window (Kyle 10-25: merge the two Ornith 128k rows). So an as-asked local-128k battery on a 262144 server now
 * skips, in battery, the tasks the real 128k row already scored -- it is the same config; give it CODEBENCH_ALLOW_RERUN
 * for a repeat.
 */
function specRun(spec) {
    const s = spec || {};
    const cfg = { harness_mode: 'agentic', ...(s.config || {}) };
    const launch = String(s.launch || '');
    const rv = s.env && typeof s.env.CODEBENCH_ROW_VARIANT === 'string' && /^[\w.-]+$/.test(s.env.CODEBENCH_ROW_VARIANT.trim()) ? s.env.CODEBENCH_ROW_VARIANT.trim() : '';
    const mark = rv ? ` #row-variant=${rv}` : '';
    // the queue command as queueLaunchByBattery has it: the expanded launch + the declared row variant as a trailing marker
    const qc0 = s.queueCmd != null ? String(s.queueCmd) : launch;
    const queueCmd = qc0 ? (mark && !/#row-variant=/.test(qc0) ? qc0 + mark : qc0) : (mark ? mark.trim() : null);
    let srv = s.server ? { ...s.server } : null;
    const local = !['claude', 'agy'].includes(String(cfg.runner || '').toLowerCase());
    if (!srv && local && launch) {
        const f = M.parseFlags(launch);
        const st = STRATA.test(launch) ? strataServer(launch) : null;
        srv = { model_path: f.modelPath || (st && st.model_path) || null, n_ctx: f.ctx || (st && st.n_ctx) || null, launch_command: launch };
    }
    // a Strata result records no launch command (lib/models.js strataVariant): neither may the config standing for it
    if (srv && STRATA.test(String(queueCmd || ''))) delete srv.launch_command;
    return { run: { dir: s.dir || null, config: cfg, server: srv || {} }, queueCmd, scaffolds: cfg.scaffold ? [cfg.scaffold] : [] };
}

/** The identity of a battery record. -> { modelKey, rowKey, key, display, weightsId, weightsVia } | null (the model
 *  cannot be told: no identity is guessed, and callers then skip nothing). */
function identityOfRun(run, { queueCmd = null, scaffolds = [] } = {}) {
    const c = M.batteryIdentity(run, scaffolds, queueCmd);
    if (!c || c.unresolved) return null;
    if (c.provider === 'local' && !(run.server && run.server.model_path)) return null;
    const d = M.runDescriptor(run, c.provider, c.key);
    return { modelKey: c.key, rowKey: rowKeyOf(c.key), key: scheduleKey(c.key, d.facets, d.level), cell: cellKey(c.key, d.facets), display: c.display,
        weightsId: c.weightsId || null, weightsVia: c.weightsVia || null };
}
function identityOfSpec(spec) {
    const { run, queueCmd, scaffolds } = specRun(spec);
    return identityOfRun(run, { queueCmd, scaffolds });
}

/**
 * Every scored result in the catalog, by scheduling key: Map(scheduleKey -> Map(task -> [{status, dir, ranAt}])). Reads the result
 * JSONs themselves (lib/codebench listRuns), not bench.sqlite, so a result written a second ago counts. Scored =
 * not an excluded status (OVERFLOW / KILLED / PROVIDER_ERROR / ABORTED / CAP_TOO_LOW / HARNESS_ERROR / CONTAMINATED /
 * TASK_INVALID / CUTOFF), not a +bonus row, not in an INVALID- battery. `__rN` repeat suffixes count as the task.
 * Also: dir -> [cellKey] (a battery can span cells when its rows differ).
 */
// A run under a longer cap that FINISHED (not TIMEOUT) inside 2 h counts as a 2 h-cap run (Kyle, 2026-09-24; the
// memory note on parity): such a row is indexed under its own cap's key AND under the 7200 s key.
const BASE_CAP = 7200;
// UNFINISHED rows (2026-10-19, Kyle): a run whose question is not answered yet is not `scored` -- it may be CONTINUED
// (a continuation is then its score). `unfinished` indexes them by the same keys: Map(scheduleKey -> Map(task ->
// [{dir, result, session, rebuildable}])). session 'saved' (and not rebuildable === false): it waits for a continuation;
// 'pruned' / rebuildable false: a fresh run is allowed; null: unknown (no session store found).
function scoredIndex({ fresh = false } = {}) {
    // `fresh` only adds the request table's stamp to the cache check; results are always current (the index is rebuilt
    // when a result dir changes), so callers in the dashboard process reuse the built index
    const idx = M.buildIndex(fresh);
    const cells = new Map(), byDir = new Map(), display = new Map(), unfinished = new Map();
    // the schedule key(s) of one result row: its own, and the 2 h key when it finished inside 2 h under a longer cap
    const keysOf = (mk, provider, mdisplay, b, e, { listDir = true } = {}) => {
        // the result file's task id (a level problem `T@L3` is T here: its level is in the key below)
        const task = String(e.row.base_task || e.row.task || '').replace(RUN_SUFFIX, '');
        if (!task || BONUS.test(task)) return null;
        const rc0 = e.row.rowConfig;
        const run = rc0 ? { ...b.run, config: rc0.config || b.run.config, server: rc0.server || b.run.server } : b.run;
        const { facets, level } = M.runDescriptor(run, provider, mk);
        const k = scheduleKey(mk, facets, level);
        if (listDir) {   // byDir / display: the batteries with scored rows (an unfinished row is not one)
            if (!byDir.has(e.dir)) byDir.set(e.dir, new Set());
            byDir.get(e.dir).add(k);
        }
        if (listDir && !display.has(k)) display.set(k, { modelKey: mk, rowKey: rowKeyOf(mk), display: mdisplay });
        const keys = [k];
        const cap = facets.harness && Number(facets.harness.timeout_s);
        const wall = Number(e.row.wall_s);
        if (cap > BASE_CAP && e.row.status !== 'TIMEOUT' && wall > 0 && wall <= BASE_CAP)
            keys.push(scheduleKey(mk, { ...facets, harness: { ...facets.harness, timeout_s: BASE_CAP } }, level));
        return { task, k, keys, cap };
    };
    const put = (map, kk, task, rec) => {
        if (!map.has(kk)) map.set(kk, new Map());
        const t = map.get(kk);
        if (!t.has(task)) t.set(task, []);
        t.get(task).push(rec);
    };
    for (const m of idx.models.values()) {
        const bats = new Map(m._batteries.map((b) => [b.run.dir, b]));
        for (const e of m._qualityEntries) {
            const b = bats.get(e.dir);
            if (!b || b.invalid) continue;
            const ks = keysOf(m.key, m.provider, m.display, b, e);
            if (!ks || M.EXCLUDED_STATUS.has(e.row.status)) continue;
            for (const kk of ks.keys) put(cells, kk, ks.task, { status: e.row.status || null, dir: e.dir, ranAt: e.row.ran_at || null, ...(kk !== ks.k ? { cap: ks.cap } : {}) });
        }
    }
    for (const h of idx.unfinished || []) {
        if (!h.bat || h.bat.invalid) continue;
        const ks = keysOf(h.c.key, h.c.provider, h.c.display, h.bat, h, { listDir: false });
        if (!ks) continue;
        const u = h.row.unfinished || {};
        for (const kk of ks.keys) put(unfinished, kk, ks.task, { dir: h.dir, result: u.result || null, session: u.session || null, rebuildable: u.rebuildable ?? null });
    }
    return { cells, byDir, display, unfinished };
}
/** Tasks of `tasks` (all when null) the identity `id` has UNFINISHED: { task: [{dir, result, session, rebuildable}] }. */
function unfinishedFor(id, tasks, index = scoredIndex()) {
    const out = {};
    if (!id || !index.unfinished) return out;
    const t = index.unfinished.get(id.key);
    if (!t) return out;
    for (const [task, list] of t) if (!tasks || tasks.includes(task)) out[task] = list;
    return out;
}
/** Does an unfinished record wait for a continuation (a saved, rebuildable-or-unknown session)? null session: unknown,
 *  read as waiting (no fresh run over a session that may exist). */
const awaitsContinuation = (u) => !!u && u.session !== 'pruned' && u.rebuildable !== false;

/** Tasks of `tasks` (all when null) the identity `id` has scored: { task: [{status, dir}] }. */
function scoredFor(id, tasks, index = scoredIndex()) {
    const out = {};
    if (!id) return out;
    const t = index.cells.get(id.key);
    if (!t) return out;
    for (const [task, list] of t) if (!tasks || tasks.includes(task)) out[task] = list;
    return out;
}

/**
 * Tasks another RUNNING queue item of the same identity has claimed and not finished: { task: {item, label} }. Only
 * items that started before `self` (started_at, then id), so two items never each wait for the other. An item's
 * identity is its battery.json config (written when its battery starts) with the server from its expanded launch.
 * `db`: a better-sqlite3 handle on bench.sqlite (read only).
 */
function claimedFor(id, tasks, { db, selfItem = null, selfStarted = null, index = null } = {}) {
    const out = {};
    if (!id || !db) return out;
    const rows = db.prepare("SELECT id, label, runner, model, launch_cmd, env_json, outcome_json, resolved_tasks_json, result_dir, started_at FROM queue_items WHERE status='running' AND kind IN ('run','stage')").all();
    for (const r of rows) {
        if (selfItem != null && Number(r.id) === Number(selfItem)) continue;
        if (selfStarted && r.started_at && (r.started_at > selfStarted || (r.started_at === selfStarted && selfItem != null && Number(r.id) > Number(selfItem)))) continue;
        let bat = null; try { bat = JSON.parse(fs.readFileSync(path.join(r.result_dir || '', 'battery.json'), 'utf-8')); } catch { bat = null; }
        const cfg = (bat && bat.config) || null;
        if (!cfg) continue;   // battery not started: it claims nothing yet
        let env = {}; try { env = JSON.parse(r.env_json || '{}') || {}; } catch { env = {}; }
        let oc = {}; try { oc = JSON.parse(r.outcome_json || '{}') || {}; } catch { oc = {}; }
        const other = identityOfSpec({ dir: path.basename(String(r.result_dir || r.label || '')), config: cfg, launch: oc.launch_expanded || r.launch_cmd || '', env });
        if (!other || other.key !== id.key) continue;
        let list = []; try { list = JSON.parse(r.resolved_tasks_json || '[]') || []; } catch { list = []; }
        const done = new Set();
        try { for (const f of fs.readdirSync(r.result_dir)) if (f.endsWith('.json') && f !== 'battery.json' && f !== 'summary.json' && f !== 'control.json') done.add(f.slice(0, -5).replace(RUN_SUFFIX, '')); } catch { /* no dir */ }
        for (const t of list) if ((!tasks || tasks.includes(t)) && !done.has(t) && !out[t]) out[t] = { item: r.id, label: r.label };
    }
    return out;
}

module.exports = { rowKeyOf, cellKey, scheduleKey, specRun, identityOfRun, identityOfSpec, scoredIndex, scoredFor, unfinishedFor, awaitsContinuation, claimedFor,
    TENSOR_PART, FILE_VARIANTS, QUALITY_FACETS };
