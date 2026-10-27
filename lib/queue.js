// Benchmark queue (Bench -> codebench -> Queue): the dashboard side of the rows in bench.sqlite's
// queue_items / queue_lanes / queue_events (schema: db/schema.sql). The rows are stored commands;
// codebench/tools/queue_runner.py executes them, one process per lane. Everything here is edits:
// insert / edit / reorder / duplicate / cancel / skip / hold, lane pause, and the stop controls for the
// running item (written to the row AND straight to its battery's control.json, harness/CONTROL.md, so a
// stop works even while the runner is restarting). Nothing here starts or kills a process.
//
// Also: model presets for the "new item" form (Auto queue's runnable configs + logs/profiles.json bench-*),
// the launch variables a launch_cmd may use (queue-vars.env, flash-tuned.env), a JS mirror of the runner's
// task-source resolution (cascade.py's predicate) so the view can say what a stage WOULD run now, and
// batchToItems(): the Auto queue's approved batch -> rows (replaces writing a queueN.sh).
//
// Since 2026-10-07 each pending / running item also carries what Kyle kept asking an assistant for: the question
// it answers and his own note (side table queue_meta, written only by setMeta below) and how long it should take,
// timed from the past runs of the same tasks on the same model file + context (estimateItem), with a per-lane
// "starts about / done about" clock. All of it is read-only on queue_items / queue_lanes.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const HOME = os.homedir();
const CB = process.env.CODEBENCH_ROOT || path.join(HOME, 'code', 'codebench');
const QDIR = path.join(HOME, '.claude', 'jobs', 'a16f4bd9', 'tmp');
const ENV_FILES = [path.join(CB, 'tools', 'queue-vars.env'), path.join(QDIR, 'flash-tuned.env')];
const PROFILES = path.join(__dirname, '..', '..', 'logs', 'profiles.json');   // the dashboard's own store (server4.js PROFILES_FILE)
const DASH_CONFIG = path.join(__dirname, '..', 'dashboard.config.json');
const strata = require('./strata'); // bench profiles with engine=strata: resolve their queue-serve.sh launch command
const recipes = require('./recipes'); // bench profiles on llama.cpp: the launch command and lane a profile stands for
const pathsModel = require('./paths'); // ~ and ${ROOT} in config and profile paths
const SCHEMA = path.join(__dirname, '..', 'db', 'schema.sql');
// Planner rows and preset fills run without the offline docs (Kyle 2026-10-15): almost every hand-made item pins
// CODEBENCH_DOCS=off, and L2+docs is a different test, so a planner leg that ran with docs neither compared with nor
// filled the L2 cells it was planned for. Switching the whole bench to docs on is deferred, not dropped.
const PLANNER_ENV = Object.freeze({ CODEBENCH_DOCS: 'off' });
// Cloud rule (Kyle 2026-10-15: strong cloud models must NOT run without his explicit permission): every cloud row the
// planner or refill makes is inserted HELD (setStatus 'hold', inside the insert's transaction, so a runner never sees
// it pending) with this note; refill never makes cloud rows at all (lib/autoqueue.js).
const CLOUD_HOLD_NOTE = "HELD: needs Kyle's OK before it runs (Kyle 2026-10-15: no cloud run without his explicit permission; release it in the Queue view)";
/** A config's own env (settings.models[].env: CODEBENCH_DEVICES, CODEBENCH_ROW_VARIANT, a focus entry's CODEBENCH_PROMPT_LEVEL ...) as
 *  plain strings; anything that is not an env name is left out (insert() validates again). */
function configEnv(m) {
    const e = m && m.env && typeof m.env === 'object' && !Array.isArray(m.env) ? m.env : {};
    return Object.fromEntries(Object.entries(e).filter(([k, v]) => /^[A-Z_][A-Z0-9_]*$/.test(k) && v != null && typeof v !== 'object').map(([k, v]) => [k, String(v)]));
}
// The env names run.py --print-config can read (prompt level / variant, docs, effort, scaffold, runner, opencode config):
// what a row or a config hands the identity call. Cards, ports, rerun permits and the continue-once flag are not identity.
const NOT_HARNESS = new Set(['CODEBENCH_DEVICES', 'CODEBENCH_HELPER_HOST_PORT', 'CODEBENCH_ALLOW_RERUN', 'CODEBENCH_CONTINUE_ONCE', 'CODEBENCH_ROW_VARIANT']);
const harnessEnvOf = (env) => Object.fromEntries(Object.entries(env || {}).filter(([k]) => /^(CODEBENCH|OPENCODE)_/.test(k) && !NOT_HARNESS.has(k)).sort(([a], [b]) => (a < b ? -1 : 1)));
const levelOf = (env) => (['L1', 'L3'].includes(String((env || {}).CODEBENCH_PROMPT_LEVEL || '').toUpperCase()) ? String(env.CODEBENCH_PROMPT_LEVEL).toUpperCase() : 'L2');
const variantOf = (env) => String((env || {}).CODEBENCH_PROMPT_VARIANT || '');
const rowVariantOf = (env) => { const v = String((env || {}).CODEBENCH_ROW_VARIANT || ''); return /^tensor-split/i.test(v) ? '' : v; };   // tensor-split rows fold into their base

const LANES = ['local-gpu', 'cloud'];   // + every lane in queue_lanes (the GPU lanes are one per GPU, created by their runners)
const KINDS = new Set(['run', 'stage', 'wait', 'shell']);
const STATUSES = new Set(['pending', 'running', 'done', 'failed', 'skipped', 'paused', 'cancelled', 'interrupted']);
const MOVABLE = new Set(['pending', 'paused']);
const FINAL = new Set(['done', 'failed', 'skipped', 'cancelled', 'interrupted']);
const ID = /^[\w.-]+$/;
// A result's bonus test is its own `runs` row, task `<task>+bonus` (codebench tools/db-rebuild.py, 2026-10-14): a RESULT,
// never a task to run (it runs with its parent). Every task source below leaves it out, as queue_runner.py does.
const isBonus = (t) => /\+bonus$/.test(String(t));
const NOT_BONUS = "task NOT LIKE '%+bonus'";
const ENV_KEY = /^[A-Z_][A-Z0-9_]*$/;
const JSON_COLS = ['env_json', 'tasks_json', 'task_source_json', 'approved_json', 'wait_json', 'resolved_tasks_json', 'outcome_json'];
const EDITABLE = ['lane', 'kind', 'label', 'runner', 'model', 'launch_cmd', 'env', 'tasks', 'task_source', 'approved', 'wait', 'shell_cmd',
    'sandbox', 'timeout_s', 'record', 'notes'];

const META_MAX = 4000;                  // characters: queue_meta.question and .user_note, each
const EST_TTL_MS = 60000;               // the grouped read of `runs` behind the estimates is reused this long (the page polls every 5 s)
const CLOUD_RUNNERS = new Set(['claude', 'agy']);   // no local server: their past runs are keyed by the runner's model id
const NOTHINK = /--reasoning\s+off\b/;               // thinking off is its own config: ~4 min a task where thinking-on takes ~23
const LOCAL_ALL = 'l:*';                            // history key: every local opencode run, whatever the model (per-task means)

const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const isoOf = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
const jparse = (s, d = null) => { if (s == null || s === '') return d; try { return JSON.parse(s); } catch { return d; } };

function pidAlive(pid) {
    if (!pid) return false;
    try { process.kill(Number(pid), 0); } catch (e) { if (e.code !== 'EPERM') return false; }
    try { const st = fs.readFileSync(`/proc/${Number(pid)}/stat`, 'utf-8'); return !/^\S+ \(.*\) [ZX] /.test(st); } catch { return true; }
}

function writeControl(dir, action) {
    if (!dir) return false;
    try {
        fs.mkdirSync(dir, { recursive: true });
        const f = path.join(dir, 'control.json'); const tmp = `${f}.tmp${process.pid}`;
        fs.writeFileSync(tmp, JSON.stringify({ action, at: Date.now() / 1000, by: 'queue-ui' }, null, 2));
        fs.renameSync(tmp, f);
        return true;
    } catch { return false; }
}

/** Parse a bash env file's simple assignments (NAME=value / NAME="value"), expanding $VAR / ${VAR} from earlier ones. */
function parseEnvFile(file, into = {}) {
    let txt = ''; try { txt = fs.readFileSync(file, 'utf-8'); } catch { return into; }
    for (const line of txt.split('\n')) {
        const m = /^\s*([A-Za-z_]\w*)=(.*)$/.exec(line); if (!m) continue;
        let v = m[2].trim();
        if (v.startsWith('"')) v = v.slice(1, v.lastIndexOf('"') > 0 ? v.lastIndexOf('"') : undefined);
        else if (v.startsWith("'")) { into[m[1]] = v.slice(1, v.lastIndexOf("'")); continue; }
        else v = v.replace(/\s+#.*$/, '');
        into[m[1]] = v.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (all, k) => (k in into ? into[k] : all));
    }
    return into;
}
/** $VAR -> value for display (the runner does the real expansion with bash). */
function expandPreview(cmd, vars) {
    return String(cmd || '').replace(/\$\{?([A-Za-z_]\w*)\}?/g, (all, k) => (k in vars ? vars[k] : all));
}

// ---------------------------------------------------------------- estimates (pure: test/queue.test.js drives these)
/** `runs` grouped by (model_path, n_ctx, nothink, runner, provider, runner_model, effort, task) -> Map key ->
 *  { n, mean, tasks: {task: mean} }, seconds. Keys: "m:<model file>|<n_ctx>" for a local server, with "|nothink"
 *  when its launch command had --reasoning off; "c:<runner model>" and "c:<runner model>|<effort>" for a cloud
 *  runner (effort is a 5x factor there: opus medium 155 s a task, xhigh 849 s); and LOCAL_ALL, every local
 *  opencode run of each task whatever the model -- what a task costs when this config has never run it. */
const localKey = (model, ctx, nothink) => `m:${path.basename(String(model))}|${Number(ctx) || 0}${nothink ? '|nothink' : ''}`;
function buildHistory(rows) {
    const acc = new Map();
    const add = (key, r) => {
        let h = acc.get(key); if (!h) acc.set(key, h = { n: 0, s: 0, tasks: new Map() });
        h.n += r.n; h.s += r.s;
        const t = h.tasks.get(r.task) || { n: 0, s: 0 }; t.n += r.n; t.s += r.s; h.tasks.set(r.task, t);
    };
    for (const r of rows || []) {
        if (!r || !r.n || !Number.isFinite(Number(r.s))) continue;
        if (r.model_path) add(localKey(r.model_path, r.n_ctx, r.nothink), r);
        else if (r.runner_model) { add(`c:${r.runner_model}`, r); if (r.effort) add(`c:${r.runner_model}|${r.effort}`, r); }
        if (r.runner === 'opencode' && r.provider === 'local') add(LOCAL_ALL, r);
    }
    const out = new Map();
    for (const [k, h] of acc) out.set(k, { n: h.n, mean: h.s / h.n, tasks: Object.fromEntries([...h.tasks].map(([t, v]) => [t, v.s / v.n])) });
    return out;
}
/** The history keys that could time an item, most specific first. `readJson(file)` reads a Strata config
 *  (queue-serve.sh <config.json>: the weights are its --native, the context its --max-context). */
function historyKeys(item, vars = {}, readJson = null) {
    const env = item.env || jparse(item.env_json, {}) || {};
    if (!item.launch_cmd) {
        if (!item.model || !(CLOUD_RUNNERS.has(item.runner) || item.lane === 'cloud')) return [];
        return [...(env.CODEBENCH_CLAUDE_EFFORT ? [`c:${item.model}|${env.CODEBENCH_CLAUDE_EFFORT}`] : []), `c:${item.model}`];
    }
    const cmd = expandPreview(item.launch_cmd, vars);
    const tok = cmd.split(/\s+/).map((t) => t.replace(/^['"]|['"]$/g, ''));
    const after = (list, ...flags) => { const i = list.findIndex((t) => flags.includes(t)); return i >= 0 ? list[i + 1] : null; };
    let model = after(tok, '-m', '--model'); let ctx = after(tok, '-c', '--ctx-size');
    if (!model && readJson) {
        const cfg = tok.find((t) => /\.json$/.test(t));
        let args = []; try { args = (cfg && (readJson(cfg) || {}).args) || []; } catch { args = []; }
        model = after(args, '--native'); ctx = after(args, '--max-context');
    }
    return model ? [localKey(model, ctx, NOTHINK.test(cmd))] : [];
}
/**
 * How long one item should still take. `tasks`: the task ids still to run (null = not a task list: wait / shell,
 * or a source that could not be resolved); `total`: how many the item has in all; `hist`: its buildHistory()
 * entry or null; `local`: the LOCAL_ALL entry (null for a cloud item); `est_hours`: the hand estimate in
 * queue_meta or null; `elapsed_s`: time already spent on the task in flight (the first of `tasks`), for a running item.
 * Per task, the first that exists, capped at the item's per-task timeout:
 *   a. the mean wall time of this config's past runs OF THAT TASK                                  (measured)
 *   b. the task's mean over every local model's runs, times this config's speed: its mean over the tasks it has
 *      run / the all-local mean over those same tasks (1 when it has run nothing). A composite is long on every
 *      model and an easy task short on every model, which the config's own average knows nothing about (scaled)
 *   c. the config's mean over all its tasks, when no local model has run the task                  (config)
 *   d. est_hours spread evenly over the item's tasks                                               (guess)
 * A task none of them can time -> null for the item: no estimate is ever made up.
 * -> { hours, tasks, measured_tasks, scaled_tasks, config_tasks, guess_tasks, measured_hours, fallback_hours,
 *      speed_ratio, basis, rough, overdue }
 *    basis: history | guess (every task from d);  rough: more of the hours come from b-d than from a.
 *    (list() adds timed_from: the history key used, and hand_hours: queue_meta.est_hours, shown beside a timed one.)
 */
function estimateItem({ tasks = null, total = null, timeout_s = null, hist = null, local = null, est_hours = null, elapsed_s = 0 } = {}) {
    const r2 = (x) => Math.round(x * 100) / 100;
    const cap = (s) => (Number(timeout_s) > 0 ? Math.min(s, Number(timeout_s)) : s);
    const gone = Math.max(0, Number(elapsed_s) || 0);
    const guess = est_hours != null && Number.isFinite(Number(est_hours)) && Number(est_hours) >= 0 ? Number(est_hours) : null;
    const out = (o) => ({ hours: 0, tasks: tasks ? tasks.length : null, measured_tasks: 0, scaled_tasks: 0, config_tasks: 0, guess_tasks: 0, measured_hours: 0, fallback_hours: 0, speed_ratio: null, basis: 'history', rough: false, overdue: false, ...o });
    if (!tasks) {   // a shell / wait item: only the hand estimate, less the time it has been running
        if (guess == null) return null;
        const h = Math.max(0, guess - gone / 3600);
        return out({ hours: r2(h), fallback_hours: r2(h), basis: 'guess', rough: true, overdue: gone > 0 && gone / 3600 >= guess });
    }
    if (!tasks.length) return out({});   // nothing left to run
    const own = hist && hist.n > 0 && Number.isFinite(hist.mean) ? hist : null;
    const all = (local && local.tasks) || {};
    // this config's speed against the local field, over the tasks both have run
    let mine = 0; let theirs = 0;
    if (own) for (const [t, s] of Object.entries(own.tasks || {})) if (Number.isFinite(all[t]) && all[t] > 0) { mine += s; theirs += all[t]; }
    const ratio = theirs > 0 && mine > 0 ? mine / theirs : 1;
    const per = guess != null ? (guess * 3600) / (Number(total) > 0 ? Number(total) : tasks.length) : null;   // d: the hand estimate is for the whole item
    const sum = { measured: 0, scaled: 0, config: 0, guess: 0 }; const n = { measured: 0, scaled: 0, config: 0, guess: 0 };
    let overdue = false;
    for (let i = 0; i < tasks.length; i++) {
        const t = tasks[i];
        let tier; let s;
        if (own && Number.isFinite(own.tasks && own.tasks[t])) { tier = 'measured'; s = cap(own.tasks[t]); }
        else if (Number.isFinite(all[t])) { tier = 'scaled'; s = cap(all[t] * ratio); }
        else if (own) { tier = 'config'; s = cap(own.mean); }
        else if (per != null) { tier = 'guess'; s = per; }
        else return null;
        if (i === 0 && gone > 0 && tier !== 'guess') { overdue = gone >= s; s = Math.max(0, s - gone); }
        sum[tier] += s; n[tier]++;
    }
    const fallback = sum.scaled + sum.config + sum.guess;
    const guessOnly = n.guess === tasks.length;
    return out({ hours: r2((sum.measured + fallback) / 3600), measured_tasks: n.measured, scaled_tasks: n.scaled, config_tasks: n.config, guess_tasks: n.guess,
        measured_hours: r2(sum.measured / 3600), fallback_hours: r2(fallback / 3600), speed_ratio: n.scaled ? r2(ratio) : null,
        basis: guessOnly ? 'guess' : 'history', rough: guessOnly || fallback > sum.measured, overdue });
}
/** The per-lane clock: items run one at a time, the running one first, then the pending ones in order, back to
 *  back from `now` (held items are passed by, so they get no clock). `rows`: [{id, lane, status, started_at, est}]
 *  in running-then-position order. An item with no estimate stops the clock being exact: everything after it is
 *  `after_unknown` (no earlier than). -> { clocks: Map id -> {starts_at, done_at, after_unknown},
 *  lanes: {lane: {hours, items, unknown, done_at}} } */
function laneClocks(rows, now = Date.now()) {
    const clocks = new Map(); const lanes = {};
    for (const it of rows || []) {
        if (it.status !== 'running' && it.status !== 'pending') continue;
        const L = lanes[it.lane] || (lanes[it.lane] = { hours: 0, items: 0, unknown: 0, done_at: null, t: now });
        const h = it.est ? it.est.hours : null;
        const start = it.status === 'running' ? (Date.parse(it.started_at || '') || now) : L.t;
        if (h == null) { L.unknown++; clocks.set(it.id, { starts_at: isoOf(start), done_at: null, after_unknown: L.unknown > 1 }); continue; }
        const done = (it.status === 'running' ? now : L.t) + h * 3600000;
        clocks.set(it.id, { starts_at: isoOf(start), done_at: isoOf(done), after_unknown: L.unknown > 0 });
        L.hours += h; L.items++; L.t = Math.max(L.t, done);
    }
    for (const L of Object.values(lanes)) { L.hours = Math.round(L.hours * 100) / 100; L.done_at = L.items ? isoOf(L.t) : null; delete L.t; }
    return { clocks, lanes };
}

function createQueue(opts = {}) {
    const dbPath = opts.dbPath || require('./db').DB_PATH;
    const profilesPath = opts.profilesPath || PROFILES;
    const configFile = opts.configFile || DASH_CONFIG;
    // dashboard.config.json as the presets need it: its path roots, its builds, and `queue` -- { envFiles, stockBuild,
    // laneByCard } (lib/recipes.js). Read per call: the file is small and user-edited.
    function dashConfig() {
        let cfg = {}; try { cfg = JSON.parse(fs.readFileSync(configFile, 'utf-8')) || {}; } catch { cfg = {}; }
        const ctx = pathsModel.context(cfg);
        const qc = cfg.queue && typeof cfg.queue === 'object' ? cfg.queue : {};
        return { ctx, queue: qc, builds: (Array.isArray(cfg.llamaServerBuilds) ? cfg.llamaServerBuilds : []).filter((b) => b && b.id && b.path).map((b) => ({ id: b.id, path: pathsModel.expand(b.path, ctx) })) };
    }
    const configuredEnvFiles = () => { const q = dashConfig(); return Array.isArray(q.queue.envFiles) && q.queue.envFiles.length ? q.queue.envFiles.map((f) => pathsModel.expand(String(f), q.ctx)) : null; };
    const envFiles = opts.envFiles || configuredEnvFiles() || ENV_FILES;
    let db = null;
    function open() {
        if (db) return db;
        const Database = require('better-sqlite3');
        db = new Database(dbPath);
        db.pragma('journal_mode = WAL');
        db.pragma('busy_timeout = 10000');
        db.exec(fs.readFileSync(opts.schema || SCHEMA, 'utf-8'));
        for (const lane of LANES) db.prepare('INSERT OR IGNORE INTO queue_lanes (lane, paused) VALUES (?, 0)').run(lane);
        return db;
    }
    const ev = (itemId, lane, actor, event, detail) => open().prepare('INSERT INTO queue_events (at, item_id, lane, actor, event, detail_json) VALUES (?,?,?,?,?,?)')
        .run(nowIso(), itemId ?? null, lane ?? null, actor || 'dashboard', event, detail ? JSON.stringify(detail) : null);
    const getRow = (id) => open().prepare('SELECT * FROM queue_items WHERE id=?').get(Number(id));

    // ---------------------------------------------------------------- config identity (lib/configid.js, 2026-10-15)
    // What "already ran at this config" means everywhere: the dashboard's own cell -- weights file by content, thinking
    // off, row / Strata / helper variant, runner + scaffold, effort, prompt level, time cap, context, KV, output flags.
    // The prompt level is run.py's to decide (docs, prompt variant, L1/L3): it is asked (harness/run.py --print-config,
    // cached) rather than re-derived here. opts.harnessConfig replaces that call in tests; opts.identity replaces
    // lib/configid (tests); either failing -> null, and the caller falls back to the old model/context predicate.
    const HARNESS = opts.harnessPath || path.join(os.homedir(), 'code', 'codebench', 'harness', 'run.py');
    const hcCache = new Map();
    function harnessConfig({ runner, model, timeout_s = 7200, env = {} }) {
        if (opts.harnessConfig) return opts.harnessConfig({ runner, model, timeout_s, env });
        // a local runner's model id is an alias that is not part of the identity: one call per runner + env + cap, not per preset
        const local = runner !== 'claude' && runner !== 'agy';
        const k = JSON.stringify([runner, local ? '' : model, timeout_s, env]);
        const hit = hcCache.get(k);
        if (hit && Date.now() - hit.at < 600000) return hit.v && { ...hit.v, model };
        let v = null;
        try {
            const out = require('child_process').execFileSync('python3', [HARNESS, '--runner', runner, '--model', model || '', '--timeout-s', String(timeout_s), '--print-config'],
                { env: { ...process.env, ...env }, timeout: 30000, encoding: 'utf-8', cwd: path.dirname(path.dirname(HARNESS)) });
            v = JSON.parse(String(out).trim().split('\n').pop());
        } catch { v = null; }
        hcCache.set(k, { at: Date.now(), v });
        return v && { ...v, model };
    }
    const identityLib = () => (opts.identity && typeof opts.identity === 'object' ? opts.identity : require('./configid'));
    // The catalog behind lib/configid is THIS machine's results: used only for the real queue database (a test queue on a
    // temp database keeps the old predicate unless it hands in its own identity lib).
    const useIdentity = opts.identity !== undefined ? !!opts.identity : dbPath === require('./db').DB_PATH;
    /** An Auto queue config (settings.models entry) as an identity spec, or null. */
    function presetSpec(m) {
        if (!m || !useIdentity) return null;
        const cloud = (m.lane || (m.runner === 'claude' ? 'cloud' : 'local')) === 'cloud';
        // the config's own env (2026-10-15): a focus entry's CODEBENCH_PROMPT_LEVEL reaches run.py, a declared row variant the identity
        const own = configEnv(m);
        if (cloud) {
            if (!m.claudeModel || !m.effort) return null;
            const env = { ...harnessEnvOf(own), CODEBENCH_CLAUDE_EFFORT: m.effort, CODEBENCH_CLAUDE_SCAFFOLD: m.scaffold || 'solo', ...PLANNER_ENV };
            const config = harnessConfig({ runner: 'claude', model: m.claudeModel, env });
            return config ? { dir: null, config, launch: '', env: own } : null;
        }
        if (!m.cmd || !m.opencodeModel) return null;
        const config = harnessConfig({ runner: 'opencode', model: `llama-local/${m.opencodeModel}`, env: { ...harnessEnvOf(own), ...PLANNER_ENV } });
        return config ? { dir: null, config, launch: expandPreview(m.cmd, launchVars()), env: own } : null;
    }
    /** An ACTIVE queue row as an identity spec (its runner, model, cap, the env run.py reads, its expanded launch), or null. */
    function rowSpec(r) {
        if (!r || !useIdentity) return null;
        const env = jparse(r.env_json, {}) || {};
        const cloud = r.runner === 'claude' || r.runner === 'agy' || (r.lane === 'cloud' && !r.runner);
        const runner = r.runner || (cloud ? 'claude' : 'opencode');
        const config = harnessConfig({ runner, model: cloud ? (r.model || '') : `llama-local/${r.model || ''}`, timeout_s: Number(r.timeout_s) || 7200, env: harnessEnvOf(env) });
        return config ? { dir: null, config, launch: cloud ? '' : expandPreview(r.launch_cmd || '', launchVars()), env } : null;
    }
    const keyCache = new Map();   // 'm:<id>:<json>' | 'r:<id>:<updated_at>' -> identity key | null, for a minute
    function cachedKey(k, fn) {
        const hit = keyCache.get(k);
        if (hit && Date.now() - hit.at < 60000) return hit.v;
        let v = null; try { const sp = fn(); const id = sp ? identityLib().identityOfSpec(sp) : null; v = id ? id.key : null; } catch { v = null; }
        if (keyCache.size > 2000) keyCache.clear();
        keyCache.set(k, { at: Date.now(), v });
        return v;
    }
    const modelKeyOf = (m) => cachedKey(`m:${m.id}:${JSON.stringify([m.cmd, m.opencodeModel, m.claudeModel, m.effort, m.scaffold, m.env, m.promptLevel])}`, () => presetSpec(m));
    const rowKeyOf = (r) => cachedKey(`r:${r.id}:${r.updated_at}`, () => rowSpec(r));
    /** { identity, scored: {task: [...]}, pending: Set(task) } for a spec, or null when it cannot be answered. `pending`: tasks
     *  with an UNFINISHED row waiting for a continuation (lib/configid.js awaitsContinuation, 2026-10-19) -- not to be run
     *  fresh; an unfinished row whose session is pruned (or unrebuildable) leaves its task free for a fresh run. */
    function identityScored(spec, tasks) {
        if (!spec || !useIdentity) return null;
        try {
            const I = identityLib();
            const index = I.scoredIndex();
            const identity = I.identityOfSpec(spec);
            if (!identity) return null;
            const scored = I.scoredFor(identity, tasks || null, index);
            const pending = new Set();
            const unf = typeof I.unfinishedFor === 'function' ? I.unfinishedFor(identity, tasks || null, index) : {};
            for (const [t, list] of Object.entries(unf)) if (!scored[t] && list.some((u) => I.awaitsContinuation(u))) pending.add(t);
            return { identity, scored, pending };
        } catch { return null; }
    }
    function decorate(r) {
        if (!r) return r;
        const o = { ...r };
        for (const c of JSON_COLS) o[c.replace(/_json$/, '')] = jparse(r[c]);
        return o;
    }

    // ---------------------------------------------------------------- validation
    function validate(f, { partial = false, existing = null } = {}) {
        const out = {};
        const has = (k) => Object.prototype.hasOwnProperty.call(f, k);
        const kind = has('kind') ? f.kind : (existing ? existing.kind : 'run');
        if (!KINDS.has(kind)) throw new Error(`kind must be one of ${[...KINDS].join(', ')}`);
        if (has('kind') || !partial) out.kind = kind;
        if (has('lane') || !partial) { const lane = f.lane || 'local-gpu'; if (!ID.test(lane)) throw new Error('bad lane'); out.lane = lane; }
        if (has('label') && f.label != null && f.label !== '') { if (!ID.test(f.label)) throw new Error('label must be [A-Za-z0-9_.-] (it names results/<label> and the sandbox)'); out.label = f.label; }
        if (has('runner')) { if (f.runner != null && !['opencode', 'claude', 'pi'].includes(f.runner)) throw new Error('runner must be opencode, claude or pi'); out.runner = f.runner || null; }
        if (has('model')) { if (f.model != null && f.model !== '' && !/^[\w.:@/-]+$/.test(f.model)) throw new Error('bad model id'); out.model = f.model || null; }
        if (has('launch_cmd')) {
            const c = f.launch_cmd == null ? null : String(f.launch_cmd).trim();
            if (c && /[\n\r]/.test(c)) throw new Error('launch_cmd must be one line');
            if (c && /(^|[^\\])"/.test(c)) throw new Error('launch_cmd must not contain a bare " (it is expanded as if inside "..." in a queue script); use single quotes');
            if (c && /--port\b/.test(c)) throw new Error('leave --port out of launch_cmd: the runner adds --port 18080');
            out.launch_cmd = c || null;
        }
        if (has('env')) {
            const e = f.env || {};
            if (typeof e !== 'object' || Array.isArray(e)) throw new Error('env must be an object');
            for (const [k, v] of Object.entries(e)) { if (!ENV_KEY.test(k)) throw new Error(`bad env name ${k}`); if (typeof v === 'object') throw new Error(`env ${k} must be a string`); }
            out.env_json = Object.keys(e).length ? JSON.stringify(Object.fromEntries(Object.entries(e).map(([k, v]) => [k, String(v)]))) : null;
        }
        const taskList = (v, name) => {
            if (v == null) return null;
            const arr = Array.isArray(v) ? v : String(v).split(/[\s,]+/).filter(Boolean);
            for (const t of arr) if (!ID.test(t)) throw new Error(`bad task id in ${name}: ${t}`);
            return [...new Set(arr.map(String))];
        };
        if (has('tasks')) { const t = taskList(f.tasks, 'tasks'); out.tasks_json = t ? JSON.stringify(t) : null; }
        if (has('approved')) { const t = taskList(f.approved, 'approved'); out.approved_json = t ? JSON.stringify(t) : null; }
        if (has('task_source')) {
            const s = typeof f.task_source === 'string' && f.task_source.trim() ? JSON.parse(f.task_source) : (f.task_source || null);
            if (s != null) checkSource(s);
            out.task_source_json = s ? JSON.stringify(s) : null;
        }
        if (has('wait')) {
            const w = typeof f.wait === 'string' && f.wait.trim() ? JSON.parse(f.wait) : (f.wait || null);
            if (w != null && (typeof w !== 'object' || !['pid', 'log', 'seconds', 'file_absent'].some((k) => k in w))) throw new Error('wait needs pid, log (+pattern), seconds or file_absent');
            out.wait_json = w ? JSON.stringify(w) : null;
        }
        if (has('shell_cmd')) out.shell_cmd = f.shell_cmd ? String(f.shell_cmd) : null;
        if (has('sandbox')) { if (f.sandbox && !/^\/[\w./-]+$/.test(f.sandbox)) throw new Error('sandbox must be an absolute path'); out.sandbox = f.sandbox || null; }
        if (has('timeout_s')) { const n = f.timeout_s == null || f.timeout_s === '' ? null : Number(f.timeout_s); if (n != null && (!Number.isFinite(n) || n < 0)) throw new Error('timeout_s must be a number of seconds'); out.timeout_s = n == null ? null : Math.round(n); }
        if (has('record')) out.record = f.record ? 1 : 0;
        if (has('notes')) out.notes = f.notes == null ? null : String(f.notes);
        // whole-row checks against the merged result
        const m = { ...(existing || {}), ...out };
        const env = jparse(m.env_json, {}) || {};
        if (m.kind === 'run' || m.kind === 'stage') {
            const runner = m.runner || (m.lane === 'cloud' ? 'claude' : 'opencode');
            if (runner === 'claude' && (!env.CODEBENCH_CLAUDE_EFFORT || !env.CODEBENCH_CLAUDE_SCAFFOLD)) throw new Error('a claude item needs CODEBENCH_CLAUDE_EFFORT and CODEBENCH_CLAUDE_SCAFFOLD in env (runs without them cannot be labelled)');
            // pi talks to the same local server as opencode (queue_runner.py LOCAL_RUNNERS); its extension set is CODEBENCH_PI_EXT (none | sol-pi)
            if ((runner === 'opencode' || runner === 'pi') && m.lane !== 'cloud' && !m.launch_cmd) throw new Error(`a local ${runner} item needs a launch_cmd`);
            if (runner === 'pi' && env.CODEBENCH_PI_EXT && !['none', 'sol-pi'].includes(String(env.CODEBENCH_PI_EXT).toLowerCase())) throw new Error('CODEBENCH_PI_EXT must be none or sol-pi');
            if (!m.model) throw new Error('model is required');
            if (m.kind === 'stage' && !m.task_source_json) throw new Error('a stage needs a task_source');
            if (m.kind === 'run' && !m.tasks_json && !m.task_source_json) throw new Error('a run needs tasks (or a task_source)');
        }
        if (m.kind === 'wait' && !m.wait_json) throw new Error('a wait item needs wait');
        if (m.kind === 'shell' && !m.shell_cmd) throw new Error('a shell item needs shell_cmd');
        return out;
    }
    function checkSource(s, depth = 0) {
        if (depth > 32) throw new Error('task_source nests too deep');
        if (Array.isArray(s)) { for (const t of s) if (!ID.test(t)) throw new Error(`bad task id ${t}`); return; }
        if (!s || typeof s !== 'object') throw new Error('task_source must be an object');
        const k = s.from || ['tasks', 'file', 'item', 'sql'].find((x) => x in s);
        if (k === 'cascade') { if (!s.model_like || !s.n_ctx) throw new Error('a cascade source needs model_like and n_ctx'); return checkSource(s.input, depth + 1); }
        if (k === 'tasks') return checkSource(s.tasks || [], depth + 1);
        if (k === 'item') { if (!Number.isInteger(Number(s.item ?? s.id))) throw new Error('item source needs an item id'); return; }
        if (k === 'file') { if (!(s.file || s.path)) throw new Error('file source needs a path'); return; }
        if (k === 'sql') { if (!/^\s*(select|with)\b/i.test(s.query || s.sql || '')) throw new Error('sql source must be a SELECT'); return; }
        throw new Error(`unknown task_source ${k}`);
    }
    const inFields = (f) => {
        // accept both API names (tasks, env, ...) and column names (tasks_json, ...)
        const o = { ...f };
        for (const c of JSON_COLS) { const k = c.replace(/_json$/, ''); if (c in o && !(k in o)) o[k] = typeof o[c] === 'string' ? jparse(o[c]) : o[c]; delete o[c]; }
        return o;
    };

    // ---------------------------------------------------------------- positions
    function endPosition(lane) {
        const r = open().prepare('SELECT max(position) AS p FROM queue_items WHERE lane=?').get(lane);
        return (r && r.p != null ? Math.floor(r.p) : 0) + 1;
    }
    function positionAfter(row) {
        const next = open().prepare('SELECT min(position) AS p FROM queue_items WHERE lane=? AND position > ?').get(row.lane, row.position);
        return next && next.p != null ? (row.position + next.p) / 2 : row.position + 1;
    }
    function positionBefore(row) {
        const prev = open().prepare('SELECT max(position) AS p FROM queue_items WHERE lane=? AND position < ?').get(row.lane, row.position);
        return prev && prev.p != null ? (row.position + prev.p) / 2 : row.position - 1;
    }
    // The TOP of a lane's waiting items (2026-10-26): just ahead of its first pending or held row -- the place the
    // new-item form's "at the top (runs next)" gives (before: that row), so a held row at the head is passed too and
    // the new one shows as #1. Nothing waiting: the end, which is after the running item. The runner takes the
    // lowest-position PENDING row (queue_runner.py next_pending), so this runs next. Positions also order items ACROSS
    // GPU lanes (device_conflict: a pending item with a smaller position on a shared card goes first), so the new row
    // takes its lane head's place there too, as an item dragged to the top always has. When halving has run out of
    // float room (about 50 inserts into the same gap) one below the head still comes first: the row below it is
    // running or finished, never waiting, and only waiting rows are ordered.
    function topPosition(lane) {
        const first = open().prepare("SELECT id, lane, position FROM queue_items WHERE lane=? AND status IN ('pending','paused') ORDER BY position, id LIMIT 1").get(lane);
        if (!first) return endPosition(lane);
        const p = positionBefore(first);
        return p < first.position ? p : first.position - 1;
    }

    // ---------------------------------------------------------------- reads
    function lanes() {
        const now = Date.now();
        return open().prepare('SELECT * FROM queue_lanes ORDER BY lane').all().map((l) => {
            const age = l.heartbeat_at ? (now - Date.parse(l.heartbeat_at)) / 1000 : null;
            return { ...l, config: jparse(l.config_json), heartbeatAgeS: age, alive: l.runner_state !== 'stopped' && age != null && age < 60 && pidAlive(l.runner_pid) };
        });
    }
    function list({ history = 40 } = {}) {
        const d = open();
        const active = d.prepare("SELECT * FROM queue_items WHERE status IN ('pending','paused','running') ORDER BY lane, position, id").all().map(decorate);
        const hist = d.prepare(`SELECT * FROM queue_items WHERE status NOT IN ('pending','paused','running')
                                ORDER BY coalesce(finished_at, updated_at, created_at) DESC, id DESC LIMIT ?`).all(Math.max(1, Math.min(500, Number(history) || 40))).map(decorate);
        for (const it of active) if (it.status === 'running') it.harnessAlive = pidAlive(it.harness_pid);
        const laneNames = [...new Set([...LANES, ...lanes().map((l) => l.lane), ...active.map((i) => i.lane)])];
        const running = active.filter((i) => i.status === 'running'); const pending = active.filter((i) => i.status !== 'running');
        // question / note / estimate + the lanes' clocks, on the active items only (history is as it was)
        let laneEst = {}; let estError = null;
        try { laneEst = annotate(running, pending); } catch (e) { estError = e.message; for (const it of active) { it.question = it.question ?? null; it.user_note = it.user_note ?? ''; it.est = null; it.clock = null; } }
        return { lanes: lanes(), laneNames, running, pending, history: hist, now: nowIso(), lane_est: laneEst, ...(estError ? { est_error: estError } : {}) };
    }

    // ---------------------------------------------------------------- question / note / estimate (queue_meta)
    // The estimate reads `runs` ONCE, grouped, and keeps the answer for a minute (opts.estTtlMs): the Queue page
    // polls every 5 s and 2,500 rows do not change that fast. A waiting item's estimate is kept with it (it only
    // moves when the item, its hand estimate or that history does). What is read fresh on every call: queue_meta
    // (a note just typed must show) and the scored tasks of the RUNNING items' batteries (indexed; a handful of rows).
    let estCache = null;
    const estTtl = opts.estTtlMs != null ? Number(opts.estTtlMs) : EST_TTL_MS;
    function estData() {
        const now = Date.now();
        if (estCache && now - estCache.at < estTtl) return estCache;
        const rows = open().prepare(`SELECT model_path, n_ctx, coalesce(launch_command LIKE '%--reasoning off%', 0) AS nothink, runner, provider, runner_model, effort, task,
                                            count(*) AS n, sum(wall_s) AS s FROM runs
                                     WHERE coalesce(excluded, 0) = 0 AND wall_s IS NOT NULL GROUP BY model_path, n_ctx, nothink, runner, provider, runner_model, effort, task`).all();
        estCache = { at: now, hist: buildHistory(rows), vars: launchVars(), json: new Map(), sources: new Map(), items: new Map() };
        return estCache;
    }
    function metaRows() {
        return new Map(open().prepare(`SELECT m.* FROM queue_meta m JOIN queue_items i ON i.id = m.item_id
                                       WHERE i.status IN ('pending','paused','running')`).all().map((m) => [m.item_id, m]));
    }
    /** What a pending item would run: its list, or its task source resolved (files / SQL: once per cache lifetime). */
    function pendingTasks(it, c) {
        if (!it.task_source) return it.tasks || [];
        const k = `${it.id}:${it.updated_at || ''}`;
        if (!c.sources.has(k)) { let t = null; try { const pv = preview(it.id); t = pv.error ? null : pv.tasks; } catch { t = null; } c.sources.set(k, t); }
        return c.sources.get(k);
    }
    /** One item's estimate (estimateItem) from the cached history. A running item counts only the tasks its
     *  battery has not scored since it started, less the time already spent on the one in flight. */
    function estimateFor(it, meta, c, now) {
        const guess = meta && meta.est_hours != null ? meta.est_hours : null;
        const startMs = Date.parse(it.started_at || '') || null;
        if (it.kind !== 'run' && it.kind !== 'stage') {
            const gone = it.status === 'running' && startMs ? (now - startMs) / 1000 : 0;
            // a timed wait is its own estimate; anything else has only the hand estimate
            if (it.kind === 'wait' && it.wait && Number(it.wait.seconds) > 0) return { ...estimateItem({ est_hours: Number(it.wait.seconds) / 3600, elapsed_s: gone }), basis: 'wait', rough: false };
            return estimateItem({ est_hours: guess, elapsed_s: gone });
        }
        const readJson = (f) => { if (!c.json.has(f)) { let j = null; try { j = JSON.parse(fs.readFileSync(f, 'utf-8')); } catch { j = null; } c.json.set(f, j); } return c.json.get(f); };
        const keys = historyKeys(it, c.vars, readJson);
        let tasks; let total; let gone = 0;
        if (it.status === 'running') {
            const all = it.resolved_tasks || it.tasks || null;
            const battery = it.result_dir ? path.basename(it.result_dir) : it.label;
            const scored = !battery ? [] : open().prepare(`SELECT task, started_at, wall_s, model_path, n_ctx, launch_command FROM runs WHERE battery = ? AND ${NOT_BONUS}`).all(battery)
                .filter((r) => !r.started_at || !it.started_at || r.started_at >= it.started_at);   // not an older battery of the same name
            const done = new Set(scored.map((r) => r.task));
            tasks = all && all.filter((t) => !done.has(t)); total = all ? all.length : null;
            // the task in flight began when the last scored one ended (or when the item started)
            const lastEnd = Math.max(startMs || 0, ...scored.map((r) => (Date.parse(r.started_at || '') || 0) + (Number(r.wall_s) || 0) * 1000));
            if (lastEnd > 0) gone = Math.max(0, (now - lastEnd) / 1000);
            // what the server actually loaded, when the launch command could not be read
            const own = scored.find((r) => r.model_path);
            if (own) keys.push(localKey(own.model_path, own.n_ctx, NOTHINK.test(own.launch_command || '')));
        } else { tasks = pendingTasks(it, c); total = tasks ? tasks.length : null; }
        const key = keys.find((k) => c.hist.has(k)) || null;
        const isLocal = !!it.launch_cmd;   // a cloud item is timed from its own runner model only
        const est = estimateItem({ tasks, total, timeout_s: it.timeout_s, hist: key ? c.hist.get(key) : null, local: isLocal ? c.hist.get(LOCAL_ALL) : null, est_hours: guess, elapsed_s: gone });
        return est && { ...est, timed_from: est.basis === 'history' ? key : null, hand_hours: guess };
    }
    /** Put question / user_note / est / clock on the running + pending items (in place) -> the per-lane totals. */
    function annotate(running, pending) {
        const c = estData(); const meta = metaRows(); const now = Date.now();
        const rows = [...running, ...pending];
        for (const it of rows) {
            const m = meta.get(it.id);
            it.question = (m && m.question) || null; it.user_note = (m && m.user_note) || '';
            if (it.status === 'running') { it.est = estimateFor(it, m, c, now); continue; }
            const k = `${it.id}:${it.updated_at || ''}:${m && m.est_hours != null ? m.est_hours : ''}`;
            if (!c.items.has(k)) c.items.set(k, estimateFor(it, m, c, now));
            it.est = c.items.get(k);
        }
        const { clocks, lanes: laneEst } = laneClocks(rows, now);
        for (const it of rows) it.clock = clocks.get(it.id) || null;   // null: held, so not in the lane's run
        return laneEst;
    }
    /** The item that is RUNNING a battery (its label, or the name of its result dir), with its question and Kyle's
     *  note: the Live view shows them above the task (2026-10-07). Read-only; null when no running item made it. */
    function runningFor(battery) {
        if (!battery) return null;
        const r = open().prepare(`SELECT i.id, i.lane, i.label, i.kind, i.notes, i.result_dir, i.started_at, m.question, m.user_note
                                  FROM queue_items i LEFT JOIN queue_meta m ON m.item_id = i.id WHERE i.status = 'running' ORDER BY i.id DESC`).all()
            .find((x) => x.label === battery || (x.result_dir && path.basename(x.result_dir) === battery));
        return r ? { id: r.id, lane: r.lane, label: r.label, kind: r.kind, started_at: r.started_at, question: r.question || null, user_note: r.user_note || '', notes: r.notes || '' } : null;
    }
    /** Save Kyle's note and / or the question for an item: an upsert into queue_meta, the ONLY write here that
     *  is not a queue row (est_hours and whichever field was not sent are kept). Plain text, capped. */
    function setMeta(id, fields) {
        if (!Number.isInteger(Number(id)) || !getRow(id)) throw new Error(`no queue item ${id}`);
        const f = fields || {};
        const text = (k) => {
            if (!Object.prototype.hasOwnProperty.call(f, k)) return undefined;
            if (f[k] != null && typeof f[k] !== 'string') throw new Error(`${k} must be text`);
            const v = String(f[k] ?? '').replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
            if (v.length > META_MAX) throw new Error(`${k} is too long (${v.length} characters; the most is ${META_MAX})`);
            return v;
        };
        const note = text('user_note'); let question = text('question');
        if (note === undefined && question === undefined) throw new Error('user_note or question is required');
        if (question !== undefined) question = question.replace(/\s+/g, ' ').trim();   // one line
        const d = open();
        d.prepare(`INSERT INTO queue_meta (item_id, question, user_note, updated_at) VALUES (@id, @question, @note, @at)
                   ON CONFLICT(item_id) DO UPDATE SET question = coalesce(@question, question), user_note = coalesce(@note, user_note), updated_at = @at`)
            .run({ id: Number(id), question: question ?? null, note: note ?? null, at: nowIso() });
        return d.prepare('SELECT * FROM queue_meta WHERE item_id = ?').get(Number(id));
    }
    function get(id) {
        const r = decorate(getRow(id));
        if (!r) throw new Error(`no queue item ${id}`);
        r.events = open().prepare('SELECT * FROM queue_events WHERE item_id=? ORDER BY id').all(Number(id)).map((e) => ({ ...e, detail: jparse(e.detail_json) }));
        return r;
    }

    // ---------------------------------------------------------------- writes
    function insert(fields, { actor = 'dashboard', createdBy, after, before, top = false } = {}) {
        const f = inFields(fields || {});
        const status = f.status || 'pending';
        if (!['pending', 'paused'].includes(status)) throw new Error('a new item is pending or paused');
        const v = validate(f);
        const d = open();
        return d.transaction(() => {
            let pos = f.position != null && Number.isFinite(Number(f.position)) ? Number(f.position) : null;
            if (pos == null && after != null) { const a = getRow(after); if (a) pos = positionAfter(a); }
            if (pos == null && before != null) { const b = getRow(before); if (b) pos = positionBefore(b); }
            if (pos == null && top) pos = topPosition(v.lane);   // read in the insert's own transaction: the head as it is now
            if (pos == null) pos = endPosition(v.lane);
            const row = { ...v, position: pos, status, created_by: createdBy || f.created_by || 'kyle', created_at: nowIso(), updated_at: nowIso() };
            if (!('timeout_s' in row) && (row.kind === 'run' || row.kind === 'stage')) row.timeout_s = 7200;
            if (!('timeout_s' in row)) row.timeout_s = null;
            // 2026-10-22, Kyle: a leg records unless told not to. A Strata engine's log has no per-request time, so its
            // requests reach History only through the record-proxy's recording; 1055 onward (10-15) left record out,
            // took the column's 0, and no Strata request was logged after 10-18. llama-server legs import from their
            // own log and the importer skips their recording, so this never double counts.
            if (!('record' in row) && (row.kind === 'run' || row.kind === 'stage')) row.record = 1;
            const cols = Object.keys(row);
            const info = d.prepare(`INSERT INTO queue_items (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`).run(...cols.map((c) => row[c]));
            const id = Number(info.lastInsertRowid);
            if (!row.label && (row.kind === 'run' || row.kind === 'stage')) d.prepare('UPDATE queue_items SET label=? WHERE id=?').run(`q${id}`, id);
            ev(id, row.lane, actor, 'insert', { kind: row.kind, label: row.label || null, created_by: row.created_by });
            return decorate(getRow(id));
        })();
    }
    function update(id, fields, { actor = 'dashboard' } = {}) {
        const cur = getRow(id); if (!cur) throw new Error(`no queue item ${id}`);
        const f = inFields(fields || {});
        for (const k of Object.keys(f)) if (!EDITABLE.includes(k)) throw new Error(`${k} is not editable`);
        if (cur.status === 'running' && Object.keys(f).some((k) => k !== 'notes')) throw new Error('the item is running: only its notes can change (stop it first)');
        if (FINAL.has(cur.status) && Object.keys(f).some((k) => k !== 'notes')) throw new Error(`the item is ${cur.status}: duplicate it to run it again`);
        const v = validate(f, { partial: true, existing: cur });
        if (!Object.keys(v).length) return decorate(cur);
        if (v.lane && v.lane !== cur.lane) v.position = endPosition(v.lane);
        v.updated_at = nowIso();
        open().prepare(`UPDATE queue_items SET ${Object.keys(v).map((k) => `${k}=?`).join(', ')} WHERE id=?`).run(...Object.values(v), Number(id));
        ev(Number(id), cur.lane, actor, 'edit', { fields: Object.keys(f) });
        return decorate(getRow(id));
    }
    /** New order for a lane's movable (pending/paused) items: `ids` in the wanted order. Their existing
     *  positions are re-dealt in that order, so running and finished rows never move. */
    function reorder(lane, ids, { actor = 'dashboard' } = {}) {
        const d = open();
        return d.transaction(() => {
            const rows = d.prepare("SELECT id, position FROM queue_items WHERE lane=? AND status IN ('pending','paused') ORDER BY position, id").all(lane);
            const have = new Set(rows.map((r) => r.id));
            const want = (ids || []).map(Number).filter((x) => have.has(x));
            const rest = rows.map((r) => r.id).filter((x) => !want.includes(x));
            const order = [...want, ...rest];
            let slots = rows.map((r) => r.position);
            if (new Set(slots).size !== slots.length) slots = slots.map((p, i) => Math.floor(slots[0]) + i);   // ties: spread
            order.forEach((iid, i) => d.prepare('UPDATE queue_items SET position=?, updated_at=? WHERE id=?').run(slots[i], nowIso(), iid));
            ev(null, lane, actor, 'reorder', { order });
            return order;
        })();
    }
    function move(id, dir, opts) {
        const cur = getRow(id); if (!cur) throw new Error(`no queue item ${id}`);
        if (!MOVABLE.has(cur.status)) throw new Error(`a ${cur.status} item does not move`);
        const ids = open().prepare("SELECT id FROM queue_items WHERE lane=? AND status IN ('pending','paused') ORDER BY position, id").all(cur.lane).map((r) => r.id);
        const i = ids.indexOf(cur.id);
        const j = dir === 'up' ? i - 1 : dir === 'down' ? i + 1 : dir === 'top' ? 0 : dir === 'bottom' ? ids.length - 1 : Number(dir);
        if (!Number.isInteger(j) || j < 0 || j >= ids.length || j === i) return ids;
        ids.splice(i, 1); ids.splice(j, 0, cur.id);
        return reorder(cur.lane, ids, opts);
    }
    /** A copy of an item as a new pending row. `position`: where it goes --
     *    'top'   ahead of every waiting (pending / held) item of its lane: runs next (topPosition);
     *    'end'   after the lane's last row;
     *    'after' right after the item copied (a waiting item only);
     *    not given: as before 10-26 -- a waiting item's copy right after it, a finished one's at the end.
     *  2026-10-26, Kyle: "the default for adding an item back to the queue from the bottom should be adding it to the
     *  top, not the bottom" -- four cancelled items he re-queued from the Queue page's history ("again") landed at the
     *  bottom of their lanes and he dragged each one up (lab rule: a re-queued or retried item goes ahead of the
     *  floor-* / fill items). The page now sends position 'top' for "again". The default for a caller that names no
     *  position is unchanged on purpose: sweeps/watchers/replan.py duplicates a finished calibration item and only
     *  THEN edits its tasks and reorders the lane -- a copy born at the top of an idle, unpaused lane could be claimed
     *  by its runner in between, with the calibration's tasks. The runner's own re-queues (card-handoff.py "-rest",
     *  cloud-quota-watch.py "-deferred", idle-guard.py) write their rows in SQL and never come through here. */
    function duplicate(id, { actor = 'dashboard', position = null } = {}) {
        const cur = getRow(id); if (!cur) throw new Error(`no queue item ${id}`);
        const where = position == null || position === '' ? (MOVABLE.has(cur.status) ? 'after' : 'end') : String(position);
        if (!['top', 'end', 'after'].includes(where)) throw new Error('position must be top, end or after');
        if (where === 'after' && !MOVABLE.has(cur.status)) throw new Error(`the item is ${cur.status}: its copy goes to the top or the end of the lane, not after it`);
        const f = {};
        // not `record`: a copy takes insert()'s default (record), not the 0 every item from 10-15 to 10-22 was left with
        for (const k of ['lane', 'kind', 'runner', 'model', 'launch_cmd', 'shell_cmd', 'sandbox', 'timeout_s', 'notes']) f[k] = cur[k];
        for (const c of ['env_json', 'tasks_json', 'task_source_json', 'approved_json', 'wait_json']) f[c.replace(/_json$/, '')] = jparse(cur[c]);
        // a re-run of a finished item runs what it RESOLVED to unless it had an explicit list
        if (cur.kind === 'run' && !f.tasks && cur.resolved_tasks_json) f.tasks = jparse(cur.resolved_tasks_json);
        f.label = cur.label ? uniqueLabel(cur.label) : null;
        if (f.sandbox && cur.label && f.sandbox.endsWith(cur.label)) f.sandbox = null;
        const anchor = where === 'top' ? { top: true } : where === 'after' ? { after: cur.id } : {};
        const row = insert(f, { actor, createdBy: 'kyle', ...anchor });
        ev(row.id, row.lane, actor, 'duplicate', { from: cur.id, position: where });
        return row;
    }
    function uniqueLabel(base) {
        const stem = String(base).replace(/-r\d+$/, '');
        const d = open();
        for (let n = 2; n < 1000; n++) {
            const cand = `${stem}-r${n}`;
            if (!d.prepare('SELECT 1 FROM queue_items WHERE label=?').get(cand) && !fs.existsSync(path.join(CB, 'results', cand))) return cand;
        }
        return `${stem}-${Date.now()}`;
    }
    /** cancel / skip (drop a pending or held item, kept as history) | hold (paused: the lane passes it) | release (back to pending). */
    function setStatus(id, action, { actor = 'dashboard' } = {}) {
        const cur = getRow(id); if (!cur) throw new Error(`no queue item ${id}`);
        const to = { cancel: 'cancelled', skip: 'skipped', hold: 'paused', release: 'pending' }[action];
        if (!to) throw new Error('action must be cancel, skip, hold or release');
        if (!MOVABLE.has(cur.status)) throw new Error(`the item is ${cur.status}; ${cur.status === 'running' ? 'use stop-after-task / stop-now' : 'duplicate it to run it again'}`);
        const fin = FINAL.has(to) ? nowIso() : null;
        open().prepare('UPDATE queue_items SET status=?, finished_at=?, updated_at=? WHERE id=?').run(to, fin, nowIso(), cur.id);
        ev(cur.id, cur.lane, actor, action, { from: cur.status, to });
        return decorate(getRow(id));
    }
    /** stop-after-task | stop-now | clear, for the RUNNING item: recorded on the row (the runner passes it on)
     *  and written to the battery's control.json directly, so it works while the runner restarts. */
    function control(id, action, { actor = 'dashboard' } = {}) {
        const cur = getRow(id); if (!cur) throw new Error(`no queue item ${id}`);
        if (!['stop-after-task', 'stop-now', 'clear'].includes(action)) throw new Error('action must be stop-after-task, stop-now or clear');
        if (cur.status !== 'running') throw new Error(`the item is ${cur.status}, not running`);
        const val = action === 'clear' ? null : action;
        open().prepare('UPDATE queue_items SET control=?, updated_at=? WHERE id=?').run(val, nowIso(), cur.id);
        let wrote = false;
        if ((cur.kind === 'run' || cur.kind === 'stage') && cur.harness_pid && cur.result_dir) wrote = writeControl(cur.result_dir, val || 'run');
        ev(cur.id, cur.lane, actor, 'control', { action, controlJson: wrote });
        return { ...decorate(getRow(id)), controlJsonWritten: wrote };
    }
    function pauseLane(lane, paused, { actor = 'dashboard', note } = {}) {
        if (!ID.test(lane || '')) throw new Error('bad lane');
        const d = open();
        d.prepare('INSERT OR IGNORE INTO queue_lanes (lane, paused) VALUES (?, 0)').run(lane);
        d.prepare('UPDATE queue_lanes SET paused=?, paused_by=?, paused_at=?, note=coalesce(?, note) WHERE lane=?').run(paused ? 1 : 0, actor, nowIso(), note ?? null, lane);
        ev(null, lane, actor, paused ? 'pause-lane' : 'resume-lane', note ? { note } : null);
        return lanes().find((l) => l.lane === lane);
    }

    // ---------------------------------------------------------------- task sources (mirror of queue_runner.py)
    function cascadeFilter(tasks, rule, mode) {
        if (rule.identity_spec) {   // the stage's config identity (insertBatch, 2026-10-15); else the old predicate below
            const r = identityScored(rule.identity_spec, tasks);
            if (r) {
                const passed = (t) => (r.scored[t] || []).some((x) => x.status === 'pass' || x.status === 'pass*');
                // a task waiting for a continuation is neither run fresh here nor passed down as failed
                return mode === 'failed' ? tasks.filter((t) => !passed(t) && !r.pending.has(t)) : tasks.filter((t) => !r.scored[t] && !r.pending.has(t));
            }
        }
        let q = `select task, status from runs where excluded=0 and model_path like ? and n_ctx=? and timeout_s=? and ${NOT_BONUS}`;
        const a = [rule.model_like || '%', Number(rule.n_ctx) || 0, Number(rule.timeout_s) || 7200];
        if (rule.include_like) { q += ' and result_path like ?'; a.push(rule.include_like); }
        if (rule.exclude_like) { q += ' and result_path not like ?'; a.push(rule.exclude_like); }
        const ran = new Set(); const passed = new Set();
        for (const r of open().prepare(q).all(...a)) { ran.add(r.task); if (r.status === 'pass' || r.status === 'pass*') passed.add(r.task); }
        return mode === 'failed' ? tasks.filter((t) => !passed.has(t)) : tasks.filter((t) => !ran.has(t));
    }
    function resolveSource(src, depth = 0) {
        if (depth > 32) throw new Error('task source nests too deep');
        if (src == null) return [];
        if (Array.isArray(src)) return src.map(String);
        const k = src.from || ['tasks', 'file', 'item', 'sql'].find((x) => x in src);
        if (k === 'tasks') return (src.tasks || []).map(String);
        if (k === 'file') return fs.readFileSync(src.file || src.path, 'utf-8').split(/\s+/).filter(Boolean);
        if (k === 'item') return failedSet(Number(src.item ?? src.id), depth + 1);
        if (k === 'sql') {
            const Database = require('better-sqlite3');
            const ro = new Database(dbPath, { readonly: true, fileMustExist: true });
            try { return ro.prepare(src.query || src.sql).raw().all().map((r) => String(r[0])).filter((t) => t && !isBonus(t)); } finally { ro.close(); }
        }
        if (k === 'cascade') return cascadeFilter(resolveSource(src.input, depth + 1), src, src.mode || 'torun');
        throw new Error(`unknown task source ${k}`);
    }
    function failedSet(id, depth = 0) {
        const it = getRow(id); if (!it) throw new Error(`task source refers to missing item ${id}`);
        const src = jparse(it.task_source_json);
        if (src && src.from === 'cascade') return cascadeFilter(resolveSource(src.input, depth + 1), src, 'failed');
        const oc = jparse(it.outcome_json, {}) || {};
        if (Array.isArray(oc.failed_set)) return oc.failed_set;
        const tasks = jparse(it.resolved_tasks_json) || jparse(it.tasks_json) || [];
        return tasks.filter((t) => { try { const j = JSON.parse(fs.readFileSync(path.join(it.result_dir || '', `${t}.json`), 'utf-8')); return !['pass', 'pass*'].includes(j.status); } catch { return true; } });
    }
    /** What an item would run if it started now (the runner re-resolves after db-rebuild at start). */
    function preview(id) {
        const it = getRow(id); if (!it) throw new Error(`no queue item ${id}`);
        const src = jparse(it.task_source_json);
        let tasks; let error = null;
        try { tasks = (src == null ? (jparse(it.tasks_json) || []) : resolveSource(src)).filter((t) => !isBonus(t)); } catch (e) { error = e.message; tasks = []; }
        const appr = jparse(it.approved_json);
        if (appr) tasks = tasks.filter((t) => appr.includes(t));
        let input = null;
        try { if (src && src.from === 'cascade') input = resolveSource(src.input); } catch { /* shown via error */ }
        return { id: it.id, tasks, input, error, vars: launchVars(), expanded: it.launch_cmd ? expandPreview(it.launch_cmd, launchVars()) : null };
    }

    // ---------------------------------------------------------------- presets / variables
    function launchVars() {
        const v = {};
        for (const f of envFiles) parseEnvFile(f, v);
        return v;
    }
    function presets(settings) {
        const vars = launchVars();
        const out = [];
        const models = (settings && settings.models) || [];
        for (const m of models) {
            const cloud = (m.lane || (m.runner === 'claude' ? 'cloud' : 'local')) === 'cloud';
            if (cloud) {
                if (!m.effort) continue;
                out.push({ id: m.id, label: m.label || m.id, source: 'autoqueue', lane: 'cloud', runner: 'claude', model: m.claudeModel,
                    env: { CODEBENCH_CLAUDE_EFFORT: m.effort, CODEBENCH_CLAUDE_SCAFFOLD: m.scaffold || 'solo', ...PLANNER_ENV } });
            } else if (m.cmd && m.opencodeModel) {
                // the config's own lane and env (cards, row variant), as insertBatch writes them (2026-10-15)
                out.push({ id: m.id, label: m.label || m.id, source: 'autoqueue', lane: typeof m.queueLane === 'string' && ID.test(m.queueLane) ? m.queueLane : 'local-gpu', runner: 'opencode', model: m.opencodeModel,
                    launch_cmd: m.cmd, env: { ...configEnv(m), ...PLANNER_ENV }, nCtx: m.nCtx || null, dbLike: m.dbLike || null, dbExcludeLike: m.dbExcludeLike || null, dbIncludeLike: m.dbIncludeLike || null,
                    weights: m.weights || null, weightsOk: m.weights ? fs.existsSync(m.weights) : null });
            }
        }
        // logs/profiles.json bench-* entries: the GUI's saved benchmark configs. A llama.cpp profile becomes the
        // launch command its settings stand for (lib/recipes.js: the two scored recipes by their shape, else the
        // profile's own raw command); its opencode id comes from the Auto queue config with the same weights (if any).
        let prof = {}; try { prof = (JSON.parse(fs.readFileSync(profilesPath, 'utf-8')) || {}).profiles || {}; } catch { /* none */ }
        const dc = dashConfig();
        let topology = null; try { topology = typeof opts.topology === 'function' ? opts.topology() : (opts.topology || null); } catch { topology = null; }
        const recipeCtx = { vars, builds: dc.builds, stockBuild: typeof dc.queue.stockBuild === 'string' ? dc.queue.stockBuild : null, topology };
        const laneByCard = dc.queue.laneByCard && typeof dc.queue.laneByCard === 'object' && !Array.isArray(dc.queue.laneByCard) ? dc.queue.laneByCard : null;
        for (const [name, p] of Object.entries(prof)) {
            if (!/^bench(-| · )/.test(name)) continue;   // "bench · <model> · ..." since 2026-09-29 (explicit model names); "bench-..." before
            const c = pathsModel.expandProfile((p && p.config) || {}, dc.ctx);
            // Strata engine profiles: no llama-server model path -- the launch is the
            // queue-serve.sh command for the base config (+ overrides, merged by lib/strata).
            if (c.engine === 'strata') {
                let cmd = ''; let ok = false; let note = ''; let nCtx = null;
                try {
                    const r = strata.resolveLaunch(c.strataBase, c);
                    cmd = r.command;
                    ok = fs.existsSync(r.path);
                    nCtx = parseInt(r.maxContext, 10) || null;
                } catch (e) {
                    note = e.message;
                }
                const ocModel = nCtx >= 1000000 ? 'local-1024k' : nCtx >= 500000 ? 'local-512k' : nCtx >= 250000 ? 'local-258k' : 'local-128k';
                // 2026-10-15: the pack's own .gguf ('%IQ3_XXS%' also took the 27B GSQ-RCO IQ3_XXS and the Orca pack)
                let gguf = null; try { gguf = (/"([^"]+\.gguf)"/.exec(fs.readFileSync(c.strataBase, 'utf-8')) || [])[1] || null; } catch { gguf = null; }
                const dbLike = gguf ? `%/${path.basename(gguf)}` : (/iq3_xxs/i.test(name) || /iq3_xxs/i.test(c.strataBase || '') ? '%Flash-Next-GSQ-RCO-IQ3_XXS%' : '%coder-IQ1_M%');
                out.push({
                    id: `profile:${name}`, label: name, source: 'profiles.json', lane: 'local-gpu', runner: 'opencode',
                    model: ocModel, launch_cmd: cmd, nCtx, dbLike, weights: c.strataBase || null, weightsOk: ok,
                    note: ok ? (c.tuningNote || '') : (note || 'strata base config missing')
                });
                continue;
            }
            if (!c.modelPath) continue;
            const twin = models.find((m) => m.weights && path.basename(m.weights) === path.basename(c.modelPath) && m.opencodeModel && m.nCtx === c.ctx);
            const ocModel = twin ? twin.opencodeModel : (/27b/i.test(name) || /27b/i.test(c.modelPath) ? 'qwen38-27b-q4-128k' : '');
            // 2026-10-15: no twin -> this profile's own FILE ('%Qwen3.8-27B%' matched every 27B quant, GSQ-RCO, Swift, Terse,
            // Uncensored and abliterated alike: SQLite LIKE ignores case). The identity check above it is what decides now.
            const dbLike = twin ? twin.dbLike : `%/${path.basename(c.modelPath)}`;

            const rec = recipes.launchFor(c, recipeCtx);
            const launchCmd = rec.launchCmd;
            const isKnownRecipe = !!launchCmd;
            // 2026-10-10: a profile confined to one card that has a lane of its own belongs on that lane
            // (dashboard.config.json `queue.laneByCard`), and the agent's model id has to match the
            // context (a 64k server under the 128k id never compacts in time). Flash-Next keeps its tuned id.
            const lane = recipes.laneFor(c, { laneByCard, topology });
            const byCtx = { 65536: 'local-63k', 81920: 'local-80k', 131072: 'local-128k' }[c.ctx] || '';
            const model = twin ? ocModel : (/flash-next/i.test(c.modelPath) && c.ctx === 131072 ? 'flash-next-128k-tuned' : (c.ctx === 131072 && ocModel ? ocModel : (byCtx || ocModel)));
            const note = isKnownRecipe ? (c.tuningNote || '') : 'not a known recipe: fill in the launch command';
            out.push({
                id: `profile:${name}`, label: name, source: 'profiles.json', lane, runner: 'opencode',
                model, launch_cmd: launchCmd, nCtx: c.ctx || null, dbLike,
                weights: c.modelPath, weightsOk: fs.existsSync(c.modelPath),
                note: rec.warning ? `${rec.warning}${note ? ' · ' + note : ''}` : note
            });
        }
        return { presets: out, vars: Object.fromEntries(Object.entries(vars).map(([k, v2]) => [k, v2])), envFiles };
    }

    // ---------------------------------------------------------------- Auto queue: one run per task per config
    // (2026-10-14, Kyle: "let's avoid previously done tests by default"). The planner already leaves out what a config
    // ran (ui/shared/planner.js, on the folded catalog); this is the server's own check on what reaches the queue, so
    // a stale page, a hand-built batch or a planner bug cannot re-add a scored task.
    /** Tasks of `tasks` whose run at the config m is UNFINISHED and waits for a continuation (identityScored `pending`,
     *  2026-10-19): a fresh run of them is not inserted. Empty when the identity cannot be told (the SQL fallback has no
     *  unfinished rows: codebench tools/db-rebuild.py marks them excluded). */
    function pendingAtConfig(m, tasks) {
        if (!m || !tasks || !tasks.length) return new Set();
        const id = identityScored(presetSpec(m), tasks.map(String));
        return id ? id.pending : new Set();
    }
    /** The tasks of `tasks` that Auto queue config `m` already has a scored run of at its benchmark config in
     *  bench.sqlite, as a Set; null when the config cannot be looked up. Local: the cascade's predicate (model_path LIKE
     *  dbLike -- which also takes a tensor-split run of the same file and an f32ssm copy whose name extends it --, n_ctx
     *  when the config names one, the 2 h cap, result_path include / exclude). Cloud: the claude runner, model, effort,
     *  scaffold, the 2 h cap. Excluded rows and bonus results do not count. */
    function scoredAtConfig(m, tasks) {
        if (!m) return null;
        if (!tasks || !tasks.length) return new Set();
        // the config's identity (2026-10-15): only runs in ITS cell count -- a thinking-off, review-prompt, pi, tau, Jeff,
        // row-variant or other-file run of the same name does not. The predicate below is the fallback when it cannot be told.
        const id = identityScored(presetSpec(m), tasks.map(String));
        if (id) return new Set(Object.keys(id.scored));   // pendingAtConfig: the unfinished ones, apart
        const cloud = (m.lane || (m.runner === 'claude' ? 'cloud' : 'local')) === 'cloud';
        let q = `select distinct task from runs where excluded=0 and timeout_s=7200 and ${NOT_BONUS}`;
        const a = [];
        // a config that names its prompt level (a focus entry at L3, 2026-10-15) counts only runs at that level
        if (m.promptLevel) { q += " and coalesce(prompt_level, 'L2')=?"; a.push(String(m.promptLevel)); }
        if (cloud) {
            if (!m.claudeModel || !m.effort) return null;
            q += " and runner='claude' and runner_model=? and effort=? and coalesce(scaffold, 'solo')=?"; a.push(m.claudeModel, m.effort, m.scaffold || 'solo');
        } else {
            if (!m.dbLike) return null;
            q += ' and model_path like ?'; a.push(m.dbLike);
            if (m.nCtx) { q += ' and n_ctx=?'; a.push(Number(m.nCtx)); }
            if (m.dbIncludeLike) { q += ' and result_path like ?'; a.push(m.dbIncludeLike); }
            if (m.dbExcludeLike) { q += ' and result_path not like ?'; a.push(m.dbExcludeLike); }
        }
        const want = new Set(tasks.map(String));
        const out = new Set();
        for (const r of open().prepare(q).all(...a)) if (want.has(r.task)) out.add(r.task);
        return out;
    }
    /**
     * batch -> {batch, dropped: [{model, task}]}: the batch without the runs its config already scored. Kept: a run
     * marked `rerun: true` (a pin's "rerun", or the planner's "include re-runs"), every run when the batch says
     * `rerunScored: true`, cascade legs (a stage resolves its own "not run here yet" at run time: task_source torun),
     * and legs whose config cannot be looked up. Legs left empty stay in the list, empty (insertBatch skips them).
     */
    function dropScored(batch, settings, { modelForLeg = null } = {}) {
        if (!batch || !Array.isArray(batch.legs)) return { batch, dropped: [], queued: [] };
        const byId = new Map(((settings && settings.models) || []).map((m) => [m.id, m]));
        const dropped = [];
        // ALSO what is already QUEUED at the same config (2026-10-15: refill tops lanes up on a timer, so a second plan can
        // come before the first one ran): a pending / held / running row of the same identity holds the task. Kept: a run
        // marked rerun. Reported apart (`queued`), so the "already ran" message stays what it says.
        const queued = [];
        const pendingContinuation = [];   // unfinished at the config, waiting for a continuation (pendingAtConfig)
        let pend = null;
        const pendingOf = (id) => {
            if (!pend) { try { pend = pendingForPlanner(settings, modelForLeg || defaultModelForLeg).byModel; } catch { pend = {}; } }
            return new Set(pend[id] || []);
        };
        const seen = new Map();   // model -> tasks already in an earlier leg of THIS batch (two chunks never carry the same task)
        const legs = batch.legs.map((L) => {
            if (!L || L.cascade != null || !Array.isArray(L.runs)) return L;
            const asked = L.runs.filter((r) => r && r.rerun !== true).map((r) => r.task);
            const ran = batch.rerunScored === true ? new Set() : (scoredAtConfig(byId.get(L.model), asked) || new Set());
            // an UNFINISHED run of the task waits for its continuation (2026-10-19): no fresh run of it, even with rerunScored
            const waiting = pendingAtConfig(byId.get(L.model), asked);
            const inQueue = pendingOf(L.model);
            const mine = seen.get(L.model) || seen.set(L.model, new Set()).get(L.model);
            const runs = L.runs.filter((r) => {
                const t = String(r.task);
                if (r.rerun !== true && waiting.has(t)) { pendingContinuation.push({ model: L.model, task: t }); return false; }
                if (r.rerun !== true && ran.has(t)) { dropped.push({ model: L.model, task: t }); return false; }
                if (r.rerun !== true && (inQueue.has(t) || mine.has(t))) { queued.push({ model: L.model, task: t }); return false; }
                mine.add(t);
                return true;
            });
            return runs.length === L.runs.length ? L : { ...L, runs };
        });
        return { batch: { ...batch, legs }, dropped, queued, pendingContinuation };
    }
    /** The planner's own match of a row to a config (lib/autoqueue.js passes its fuller one): the exact launch it wrote. */
    function defaultModelForLeg(ms, om, cmd) { return ms.find((m) => m.opencodeModel === om && m.cmd === cmd) || null; }

    // ---------------------------------------------------------------- Auto queue: batch -> rows
    /** The Auto queue's approved batch as queue rows, IN THE BATCH'S ORDER (the planner sends interleaved chunks: one leg per
     *  row). Local legs -> run items on the config's `queueLane` (local-gpu when it names none) with the config's `env` under
     *  the planner's docs-off pin; cascade legs -> stage items chained by item id (stage k's input = stage k-1's failed set;
     *  a stage with no approved runs still passes its failures on); cloud legs -> run items on the cloud lane with explicit
     *  effort + scaffold, inserted HELD (the cloud rule: Kyle's OK first). A run its config already scored, or that is
     *  already queued at its identity, is not inserted (dropScored: unless marked rerun / the batch says rerunScored).
     *  Labels are collision-checked (uniqueLabel). */
    function insertBatch(batchIn, settings, { actor = 'planner', stamp, modelForLeg = null } = {}) {
        if (!batchIn || !Array.isArray(batchIn.legs) || !batchIn.legs.length) throw new Error('empty batch');
        const batch = dropScored(batchIn, settings, { modelForLeg }).batch;
        const byId = new Map(((settings && settings.models) || []).map((m) => [m.id, m]));
        const st = stamp || new Date().toISOString().replace(/[-:T]/g, '').slice(2, 12);
        const legs = batch.legs.filter((L) => L.runs && L.runs.length);
        const order = (batch.cascade && batch.cascade.order) || [];
        const stageLegs = new Map(legs.filter((L) => L.cascade != null).map((L) => [Number(L.cascade), L]));
        const maxStage = Math.max(0, ...stageLegs.keys());
        const d = open();
        // a label names results/<label>: an enqueue and a refill in the same minute must not share one
        const labelFor = (base) => (d.prepare('SELECT 1 FROM queue_items WHERE label=?').get(base) || fs.existsSync(path.join(CB, 'results', base)) ? uniqueLabel(base) : base);
        return d.transaction(() => {
            const made = [];
            let cascadeDone = false;
            legs.forEach((L, i) => {
                const m = byId.get(L.model); if (!m) throw new Error(`unknown model ${L.model}`);
                const tasks = L.runs.map((r) => r.task);
                if (L.cascade != null) {
                    if (cascadeDone) return;
                    cascadeDone = true;
                    let src = { tasks: ((batch.cascade && batch.cascade.seed) || []).map(String) };
                    for (let k = 1; k <= maxStage; k++) {
                        const sl = stageLegs.get(k);
                        const sm = sl ? byId.get(sl.model) : byId.get(order[k]);
                        const ispec = sm ? presetSpec(sm) : null;
                        const rule = sm && sm.dbLike ? { model_like: sm.dbLike, n_ctx: sm.nCtx || 0, ...(sm.dbIncludeLike ? { include_like: sm.dbIncludeLike } : {}), ...(sm.dbExcludeLike ? { exclude_like: sm.dbExcludeLike } : {}),
                            ...(ispec ? { identity_spec: ispec } : {}) } : null;
                        if (sl) {
                            if (!rule) throw new Error(`${sm ? sm.id : sl.model} has no dbLike: a cascade stage cannot find its rows`);
                            const row = insert({ lane: 'local-gpu', kind: 'stage', label: `aq${st}-${sm.id}-c${k}`, runner: 'opencode', model: sm.opencodeModel, launch_cmd: sm.cmd,
                                task_source: { from: 'cascade', input: src, ...rule }, approved: sl.runs.map((r) => r.task), timeout_s: 7200, env: { ...PLANNER_ENV },
                                notes: `Auto queue cascade stage ${k} (${batch.strategy || '?'}): ${sl.runs.length} approved` }, { actor, createdBy: 'planner' });
                            made.push(row); src = { item: row.id };
                        } else if (rule) {
                            src = { from: 'cascade', mode: 'failed', input: src, ...rule };      // stage k does not run here but still filters
                        }
                    }
                    return;
                }
                const cloud = L.lane === 'cloud' || m.runner === 'claude' || m.lane === 'cloud';
                // runs the planner marked as deliberate reruns: the runner's duplicate guard lets exactly those through
                // (CODEBENCH_ALLOW_RERUN, harness/config_identity.py); a batch that says rerunScored lets every task through
                const reruns = batchIn.rerunScored === true ? '1' : L.runs.filter((r) => r && r.rerun === true).map((r) => String(r.task)).join(',');
                const rr = reruns ? { CODEBENCH_ALLOW_RERUN: reruns } : {};
                // the config's own env (cards, row variant, a focus entry's prompt level) under the planner's pins (docs off)
                const own = configEnv(m);
                const chunkNote = L.chunks > 1 ? ` chunk ${L.chunk}/${L.chunks}` : '';
                const note = `Auto queue (${batch.strategy || '?'}${batchIn.source ? `, ${batchIn.source}` : ''})${chunkNote}`;
                // the queue lane of a local config: its `queueLane` (2026-10-15), else local-gpu as before
                const lane = cloud ? 'cloud' : (typeof m.queueLane === 'string' && ID.test(m.queueLane) ? m.queueLane : 'local-gpu');
                let row = cloud
                    ? insert({ lane, kind: 'run', label: labelFor(`aq${st}-${m.id}-${i + 1}`), runner: 'claude', model: m.claudeModel, tasks, timeout_s: 7200,
                        env: { ...own, CODEBENCH_CLAUDE_EFFORT: m.effort, CODEBENCH_CLAUDE_SCAFFOLD: m.scaffold || 'solo', ...PLANNER_ENV, ...rr }, notes: `${note} -- ${CLOUD_HOLD_NOTE}` }, { actor, createdBy: 'planner' })
                    : insert({ lane, kind: 'run', label: labelFor(`aq${st}-${m.id}-${i + 1}`), runner: 'opencode', model: m.opencodeModel, launch_cmd: m.cmd, tasks, timeout_s: 7200,
                        env: { ...own, ...PLANNER_ENV, ...rr }, notes: note }, { actor, createdBy: 'planner' });
                if (cloud) row = setStatus(row.id, 'hold', { actor });   // the cloud rule: held until Kyle releases it
                made.push(row);
            });
            return made;
        })();
    }

    /**
     * Which Auto queue config an ACTIVE row runs, or null (2026-10-15). Candidates: the configs on the row's weights (cloud:
     * model + effort + scaffold; local: `modelForLeg`'s file match, and every focus variant of it). Then THE CONFIG IDENTITY
     * decides between them (lib/configid scheduleKey: row, prompt level, docs, prompt variant, row variant, context, cap):
     * an L3 row of 27B Q4_K_XL is the L3 focus config's, not the L2 one's; a careful-tone or docs-on row is neither. Without
     * an identity (a test database, or the call failing) the env is compared instead: prompt level, prompt variant and a
     * declared (non tensor-split) row variant must equal the config's.
     */
    function rowConfig(r, models, modelForLeg) {
        const env = jparse(r.env_json, {}) || {};
        let cands = [];
        if (r.runner === 'claude') {
            cands = models.filter((x) => x.runner === 'claude' && x.claudeModel === r.model && x.effort === env.CODEBENCH_CLAUDE_EFFORT && (x.scaffold || 'solo') === env.CODEBENCH_CLAUDE_SCAFFOLD);
        } else if (modelForLeg) {
            const hit = modelForLeg(models, r.model, r.launch_cmd || '');
            if (hit) {
                const root = hit.focusOf || hit.id;
                cands = models.filter((x) => x === hit || (x.focusOf || x.id) === root);
            }
        }
        if (!cands.length) return null;
        const rk = useIdentity ? rowKeyOf(r) : null;
        if (rk) {
            const keyed = cands.map((m) => [m, modelKeyOf(m)]);
            if (keyed.some(([, k]) => k)) return (keyed.find(([, k]) => k === rk) || [null])[0];
        }
        const want = (m) => { const e = configEnv(m); return [m.promptLevel || levelOf(e), variantOf(e), rowVariantOf(e)].join('|'); };
        const have = [levelOf(env), variantOf(env), rowVariantOf(env)].join('|');
        return cands.find((m) => want(m) === have) || null;
    }
    /** Pending / running rows as the planner's "still queued" list (autoqueue.pendingRuns shape). */
    function pendingForPlanner(settings, modelForLeg) {
        const models = (settings && settings.models) || [];
        const rows = open().prepare("SELECT * FROM queue_items WHERE status IN ('pending','paused','running') AND kind IN ('run','stage') ORDER BY lane, position").all();
        const legs = []; const byModel = {};
        for (const r of rows) {
            let tasks = [];
            try { tasks = r.status === 'running' ? (jparse(r.resolved_tasks_json) || []) : preview(r.id).tasks; } catch { tasks = []; }
            const md = rowConfig(r, models, modelForLeg);
            legs.push({ lab: r.label, model: md ? md.id : null, om: r.model, tasks, kind: r.kind === 'stage' ? 'cascade stage' : (r.lane === 'cloud' ? 'cloud' : 'run'), itemId: r.id, status: r.status });
            if (md) { const s = byModel[md.id] || (byModel[md.id] = new Set()); for (const t of tasks) s.add(t); }
        }
        return { queue: { name: 'queue (db)', legs }, byModel: Object.fromEntries(Object.entries(byModel).map(([k, v]) => [k, [...v]])) };
    }

    // ---------------------------------------------------------------- a DRAFT row (lib/autoqueue.js lane floor, 2026-10-21)
    // The floor copies an existing item of a row (its launch, env, cap) instead of an Auto queue preset, so it asks the same
    // duplicate guard as dropScored by the row's own identity (lib/configid via rowSpec), not a preset's.
    const draftRow = (fields) => ({ id: null, lane: fields.lane, kind: 'run', status: 'pending', runner: fields.runner || 'opencode', model: fields.model || null,
        launch_cmd: fields.launch_cmd || null, timeout_s: fields.timeout_s || 7200, env_json: JSON.stringify(fields.env || {}), tasks: fields.tasks || [], updated_at: null });
    /** -> { key, scored: Set, waiting: Set, queued: Set } for `tasks` at the identity of a draft row: what that config already
     *  scored, what waits there for a continuation, and what an active (pending / held / running) row of the SAME identity
     *  already carries. key null: the identity cannot be told (then nothing is known and the caller must not queue). */
    function draftGuard(fields, tasks) {
        const want = (tasks || []).map(String);
        const spec = rowSpec(draftRow(fields));
        const id = identityScored(spec, want);
        const key = id && id.identity ? id.identity.key : null;
        const queued = new Set();
        if (key) {
            const rows = open().prepare("SELECT * FROM queue_items WHERE status IN ('pending','paused','running') AND kind='run'").all();
            for (const r of rows) {
                if (rowKeyOf(r) !== key) continue;
                let ts = [];
                try { ts = r.status === 'running' ? (jparse(r.resolved_tasks_json) || jparse(r.tasks_json) || []) : (preview(r.id).tasks || []); } catch { ts = jparse(r.tasks_json) || []; }
                for (const t of ts) queued.add(String(t));
            }
        }
        return { key, scored: new Set(id ? Object.keys(id.scored) : []), waiting: id ? id.pending : new Set(), queued };
    }
    /** Battery dirs (results/<dir>) holding a scored run at a draft row's identity: where the Models page files that config. */
    function draftDirs(fields) {
        const dirs = new Set();
        if (!useIdentity) return dirs;
        try {
            const I = identityLib();
            const identity = I.identityOfSpec(rowSpec(draftRow(fields)));
            if (!identity) return dirs;
            for (const list of Object.values(I.scoredFor(identity, null, I.scoredIndex()) || {})) for (const r of list || []) if (r && r.dir) dirs.add(r.dir);
        } catch { /* unknown: no dirs */ }
        return dirs;
    }
    /** The last `n` finished run items of a lane, newest first (id, status, launch_cmd, outcome). */
    function lastFinished(lane, n = 3) {
        return open().prepare("SELECT id, status, launch_cmd, outcome_json FROM queue_items WHERE lane=? AND kind='run' AND status IN ('done','failed','cancelled','interrupted','skipped') ORDER BY coalesce(finished_at, updated_at) DESC, id DESC LIMIT ?")
            .all(String(lane), Math.max(1, Number(n) || 3)).map((r) => ({ id: r.id, status: r.status, launch_cmd: r.launch_cmd, outcome: jparse(r.outcome_json, {}) || {} }));
    }
    /** The queue's own estimate (estimateFor: this config's history, else the local field scaled) of a draft row. */
    function estimateDraft(fields) {
        const it = { ...draftRow(fields), tasks: (fields.tasks || []).map(String) };
        return estimateFor(it, null, estData(), Date.now());
    }
    /** `base`, or base-rN when a row or a results dir already has that name (insertBatch's rule). */
    function freeLabel(base) {
        return open().prepare('SELECT 1 FROM queue_items WHERE label=?').get(base) || fs.existsSync(path.join(CB, 'results', base)) ? uniqueLabel(base) : base;
    }

    function close() { if (db) { db.close(); db = null; } }
    return { open, list, get, insert, update, reorder, move, duplicate, setStatus, control, pauseLane, lanes, preview, resolveSource, failedSet,
        presets, launchVars, insertBatch, dropScored, scoredAtConfig, pendingAtConfig, pendingForPlanner, draftGuard, draftDirs, lastFinished, estimateDraft, freeLabel, setMeta, runningFor, close, dbPath };
}

/**
 * The HTTP API, as a pure function so tests drive it without a server: server4.js hands over
 * {method, path, query (URLSearchParams), body (parsed JSON or null)} and writes back {code, body}.
 * `deps.loadSettings` supplies the Auto queue settings (model presets).
 */
function handleApi(q, { method, path: p, query, body }, deps = {}) {
    const b = body || {};
    const qs = query || new URLSearchParams();
    const ok = (obj) => ({ code: 200, body: obj });
    const need = (k) => { if (b[k] == null) throw new Error(`${k} is required`); return b[k]; };
    try {
        if (method === 'GET' && p === '/api/queue') return ok(q.list({ history: qs.get('history') }));
        if (method === 'GET' && p === '/api/queue/item') { const id = qs.get('id'); return ok({ item: q.get(id), preview: q.preview(id) }); }
        if (method === 'GET' && p === '/api/queue/preview') return ok(q.preview(qs.get('id')));
        if (method === 'GET' && p === '/api/queue/presets') return ok(q.presets(deps.loadSettings ? deps.loadSettings() : null));
        if (method !== 'POST') return { code: 404, body: { error: 'unknown queue route' } };
        const actor = b.actor && /^[\w.-]+$/.test(b.actor) ? b.actor : 'dashboard';
        if (p === '/api/queue/items') return ok({ item: q.insert(need('item'), { actor, createdBy: b.item.created_by || 'kyle', after: b.after, before: b.before }) });
        if (p === '/api/queue/item/update') return ok({ item: q.update(need('id'), need('fields'), { actor }) });
        if (p === '/api/queue/item/move') return ok({ order: q.move(need('id'), need('dir'), { actor }) });
        if (p === '/api/queue/reorder') return ok({ order: q.reorder(need('lane'), need('ids'), { actor }) });
        // {id, position?: 'top' | 'end' | 'after'} (2026-10-26; duplicate() above: the Queue page's "again" sends 'top')
        if (p === '/api/queue/item/duplicate') return ok({ item: q.duplicate(need('id'), { actor, position: b.position }) });
        if (p === '/api/queue/item/status') return ok({ item: q.setStatus(need('id'), need('action'), { actor }) });
        if (p === '/api/queue/item/control') return ok({ item: q.control(need('id'), need('action'), { actor }) });
        if (p === '/api/queue/lane') return ok({ lane: q.pauseLane(need('lane'), !!b.paused, { actor, note: b.note }) });
        // {id, user_note?, question?}: Kyle's note / the question on an item (queue_meta; never the queue row itself)
        if (p === '/api/queue/item/meta') return ok({ meta: q.setMeta(need('id'), b) });
        return { code: 404, body: { error: 'unknown queue route' } };
    } catch (err) {
        return { code: /^no queue item/.test(err.message) ? 404 : 400, body: { error: err.message } };
    }
}

/**
 * Each lane with the cards it sits on, for the lane widgets (2026-10-12). Lane names say nothing reliable about
 * hardware (a lane called after a card outlives the card), so the cards come from the lane's own runtime_json
 * (its device list, or a remote lane's published card name) read against this machine (lib/topology.js laneCards):
 *   card:   { label, here, remote }   label "RX 7900 XTX #2" / "2x RX 7900 XTX" / "RTX 4090 Laptop" / null
 *   parked: a lane that is not doing anything and cannot be asked to here -- paused with no live runner, or on cards
 *           this machine does not have. The UI folds those away; they are still there, with their note.
 * Pure: lanes as list() returns them, topology from lib/topology.js build().
 */
function laneCardInfo(lanes, topology) {
    const { laneCards } = require('./topology');
    return (lanes || []).map((l) => {
        let rt = {};
        try { rt = JSON.parse(l.runtime_json || '{}') || {}; } catch { rt = {}; }
        const c = laneCards(l.lane, rt, topology);
        const absent = c.here === false && !c.remote;
        return { ...l, card: { label: c.label, here: c.here, remote: c.remote }, parked: !!((l.paused && !l.alive) || absent) };
    });
}

module.exports = { createQueue, handleApi, parseEnvFile, expandPreview, buildHistory, historyKeys, estimateItem, laneClocks, laneCardInfo, META_MAX, LOCAL_ALL, ENV_FILES, LANES, PLANNER_ENV, CLOUD_HOLD_NOTE };
