// The benchmark SQLite database (logs/bench.sqlite, schema in db/schema.sql).
//
// LL-Dash OWNS the `requests` table: every completed llama-server request is written here live,
// with the context depth the CSV never recorded. codebench's tools own `runs` (rebuilt from the
// result JSONs by codebench/tools/db-rebuild.py). Both sides share `machines` / `builds`, keyed by
// the fingerprints codebench/harness/run.py computes -- this module calls the same Python so the two
// sides can never disagree on what "the same machine" or "the same build" means.
//
// Everything here is best-effort: a database problem must never break request handling, so every
// public function swallows its errors (and logs once).

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DB_PATH = process.env.BENCH_DB || path.join(__dirname, '..', '..', 'logs', 'bench.sqlite');
const SCHEMA_PATH = path.join(__dirname, '..', 'db', 'schema.sql');
const HARNESS_DIR = process.env.CODEBENCH_HARNESS || path.join(process.env.HOME || '', 'code', 'codebench', 'harness');

let db = null;
let warned = false;
function warnOnce(msg, err) {
    if (warned) return;
    warned = true;
    console.error(`[bench-db] ${msg}:`, err && err.message ? err.message : err);
}

function open() {
    if (db) return db;
    try {
        const Database = require('better-sqlite3');
        // BENCH_DB_READONLY=1 (the public site, public/server.js): open read-only and touch nothing -- no WAL
        // pragma, no schema. That process must never write to this machine.
        if (process.env.BENCH_DB_READONLY === '1') {
            db = new Database(DB_PATH, { readonly: true, fileMustExist: true });
            db.pragma('busy_timeout = 5000');
            return db;
        }
        db = new Database(DB_PATH);
        db.pragma('journal_mode = WAL');
        db.pragma('busy_timeout = 5000');
        db.exec(fs.readFileSync(SCHEMA_PATH, 'utf-8'));
    } catch (err) {
        warnOnce('cannot open ' + DB_PATH, err);
        db = null;
    }
    return db;
}

// ---- identity (machine / build), from codebench's own implementation ----
let machineCache;             // undefined = not asked yet, null = unavailable
const buildCache = new Map(); // binary -> { key: "<mtime>", value }
function pyIdentity(expr) {
    const code = `import sys, json; sys.path.insert(0, ${JSON.stringify(HARNESS_DIR)}); import run as R; print(json.dumps(${expr}))`;
    return JSON.parse(execFileSync('python3', ['-c', code], { timeout: 20000, encoding: 'utf-8' }).trim() || 'null');
}
function machineIdentity() {
    if (machineCache !== undefined) return machineCache;
    try { machineCache = pyIdentity('R.machine_identity()'); } catch (err) { warnOnce('machine_identity failed', err); machineCache = null; }
    return machineCache;
}
function buildIdentity(binary) {
    if (!binary) return null;
    let key = '';
    try { key = String(fs.statSync(binary).mtimeMs); } catch { return null; }
    const hit = buildCache.get(binary);
    if (hit && hit.key === key) return hit.value;
    let value = null;
    try { value = pyIdentity(`R.build_identity(${JSON.stringify(binary)})`); } catch (err) { warnOnce('build_identity failed', err); }
    buildCache.set(binary, { key, value });
    return value;
}

function upsertMachine(d, m) {
    if (!m || !m.fingerprint) return null;
    d.prepare(`INSERT OR IGNORE INTO machines (fingerprint, host, cpu, cpu_threads, ram_gib, kernel, rocm, gpus_json, static_json, first_seen, source)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(m.fingerprint, m.host, m.cpu, m.cpu_threads, m.ram_gib, m.kernel, m.rocm,
        JSON.stringify(m.gpus || null), JSON.stringify(m.static || null), new Date().toISOString(), 'lldash');
    return m.fingerprint;
}
function upsertBuild(d, b) {
    if (!b || !b.fingerprint) return null;
    d.prepare(`INSERT OR IGNORE INTO builds (fingerprint, dir, build_info, cmake_json, built_at, source) VALUES (?,?,?,?,?,?)`)
        .run(b.fingerprint, b.dir, null, JSON.stringify(b.cmake || null), b.built_at || null, 'lldash');
    return b.fingerprint;
}

const num = (v) => (v === '' || v == null || !Number.isFinite(Number(v)) ? null : Number(v));
const int = (v) => { const n = num(v); return n == null ? null : Math.round(n); };

/**
 * One completed request. `row` is the object appendBenchmarkRow() receives (same field names),
 * plus `runId`, `completedAt` (ms) and `depthEnd` (llama's "stop processing: n_tokens").
 */
/** config_json + the model file's content fingerprint (lib/weightsid.js; cached by stat, two 1 MiB reads per new
 *  file), so a speed row keeps saying which FILE served it after the file is replaced (2026-10-15). Unchanged when the
 *  file is not readable here or the JSON is not an object. */
function withWeights(configJson, modelPath) {
    if (!modelPath) return configJson;
    let id = null; try { id = require('./weightsid').weightsIdOf(modelPath).id; } catch { id = null; }
    if (!id || !/^w1:/.test(id)) return configJson;
    let cfg = {}; try { cfg = configJson ? JSON.parse(configJson) : {}; } catch { return configJson; }
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return configJson;
    return JSON.stringify({ ...cfg, weights: { id } });
}
function insertRequest(row) {
    const d = open();
    if (!d) return;
    try {
        const binary = (/(\/\S*llama-server)(?=\s|$)/.exec(row.launchCommand || '') || [])[1] || null;
        const machineFp = upsertMachine(d, row.rpc === 'yes' ? null : machineIdentity());   // RPC spans two machines
        const buildFp = upsertBuild(d, buildIdentity(binary));
        const prompt = int(row.promptTokens), gen = int(row.genTokens), end = int(row.depthEnd);
        // Depth before this request = what the slot held at release minus what this request added.
        const start = end != null && prompt != null ? Math.max(0, end - prompt - (gen || 0)) : null;
        const tele = {
            gpuUtil: row.gpuUtil, gpuPwr: row.gpuPwr, masterGpuTemp: row.masterGpuTemp, cpuUtil: row.cpuUtil,
            masterCpuTemp: row.masterCpuTemp, gpuMem: row.gpuMem, ramUsage: row.ramUsage,
            workerGpuUtil: row.workerGpuUtil, workerGpuPwr: row.workerGpuPwr, workerGpuTemp: row.workerGpuTemp,
            workerVram: row.workerVram, workerRam: row.workerRam,
        };
        d.prepare(`INSERT OR IGNORE INTO requests (source, csv_run_id, completed_at, model_path, launch_command, build_fp, machine_fp, n_ctx,
                   prompt_tokens, depth_start, depth_end, depth_source, gen_tokens, reasoning_tokens, prefill_tps, gen_tps,
                   prompt_latency_s, wall_s, prefill_tps_min, prefill_tps_max, gen_tps_min, gen_tps_max,
                   draft_accept_rate, draft_accepted, draft_generated, draft_mean_len, aborted, telemetry_json, devices_json, config_json)
                   VALUES ('live',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
            row.runId || null, new Date(row.completedAt || Date.now()).toISOString().replace(/\.\d{3}Z$/, 'Z'),
            row.model || null, row.launchCommand || null, buildFp, machineFp, int(row.ctx),
            prompt, start, end, end != null ? 'llama-log' : null, gen, int(row.reasonTokens),
            num(row.promptTps), num(row.genTps), num(row.promptLatency), num(row.wallTime),
            num(row.prefillTpsMin), num(row.prefillTpsMax), num(row.genTpsMin), num(row.genTpsMax),
            num(row.draftAcceptRate), int(row.draftAccepted), int(row.draftGenerated), num(row.draftMeanLen),
            row.aborted ? 1 : 0, JSON.stringify(tele), row.devicesJson || null, withWeights(row.configJson || null, row.model));
    } catch (err) {
        warnOnce('insertRequest failed', err);
    }
}

/** How many requests there are and the highest id: lib/models.js asks this before reading the table again. */
function requestsStamp() {
    const d = open();
    if (!d) return null;
    try { const r = d.prepare('SELECT count(*) AS n, max(id) AS maxId FROM requests').get(); return { n: r.n, maxId: r.maxId }; }
    catch (err) { warnOnce('requestsStamp failed', err); return null; }
}

// 2026-10-22, Kyle: Strata legs that ran without a recording (10-15 to 10-22) are in History from their engine log,
// all stamped 10-22 12:00 MDT because that log has no per-request time. A reader that places requests in time (a
// run's window, lib/tps.js) or sums them per config (lib/models.js, which already reads those runs' engine logs
// itself through lib/stratalog.js) must not see them: they are History rows only.
const UNTIMED_SOURCE = 'strata-log-backfill';

/** Every request, oldest first, for lib/models.js. Null when the database is unavailable. The two large JSON
 *  columns nothing there reads (telemetry_json, devices_json) are left out: a third of the read's time. */
function readRequests() {
    const d = open();
    if (!d) return null;
    try {
        const cols = d.prepare('PRAGMA table_info(requests)').all().map((c) => c.name).filter((c) => c !== 'telemetry_json' && c !== 'devices_json');
        return d.prepare(`SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM requests WHERE source != ? ORDER BY completed_at`).all(UNTIMED_SOURCE);
    }
    catch (err) { warnOnce('readRequests failed', err); return null; }
}

/** Every machine a request or a run was recorded on, by fingerprint: { fingerprint, host, gpus: [{ vendor, name,
 *  vram_mib, ... }], source, first_seen }. lib/models.js names a logged request's device ids from the machine ITS row
 *  points at (lib/runlabel.js), not from the machine that reads it. Null when the database is unavailable. */
function readMachines() {
    const d = open();
    if (!d) return null;
    try {
        const out = new Map();
        for (const r of d.prepare('SELECT fingerprint, host, gpus_json, source, first_seen FROM machines').all()) {
            let gpus = null; try { const j = JSON.parse(r.gpus_json || 'null'); gpus = Array.isArray(j) ? j : null; } catch { gpus = null; }
            out.set(r.fingerprint, { fingerprint: r.fingerprint, host: r.host || null, gpus, source: r.source || null, first_seen: r.first_seen || null });
        }
        return out;
    }
    catch (err) { warnOnce('readMachines failed', err); return null; }
}

/** What each request's own device list (devices_json, written with the request) called its device ids:
 *  Map(request id -> { '<id>': '<card name>' }), this machine's devices only (an RPC worker's card is not an id of
 *  the launch's machine). Rows that recorded no list, or no name, are absent. Requests of one launch share one
 *  object. readRequests() leaves the column out (it is large: per-card telemetry rides in it); this reads it only
 *  where it is set -- about a tenth of the rows. Null when the database is unavailable. */
function readRequestDeviceNames() {
    const d = open();
    if (!d) return null;
    try {
        const out = new Map(), shared = new Map();
        for (const r of d.prepare("SELECT id, devices_json FROM requests WHERE devices_json IS NOT NULL AND devices_json NOT IN ('', '[]')").iterate()) {
            let list; try { list = JSON.parse(r.devices_json); } catch { continue; }
            if (!Array.isArray(list)) continue;
            const names = {};
            for (const x of list) {
                if (!x || typeof x.id !== 'string' || typeof x.name !== 'string' || !x.name.trim()) continue;
                if (x.host && x.host !== 'local') continue;
                names[x.id] = x.name.trim();
            }
            const sig = JSON.stringify(Object.entries(names).sort());
            if (sig === '[]') continue;
            if (!shared.has(sig)) shared.set(sig, names);
            out.set(r.id, shared.get(sig));
        }
        return out;
    }
    catch (err) { warnOnce('readRequestDeviceNames failed', err); return null; }
}

/** Requests completed in [fromIso, toIso] (ISO UTC, compared as text like `completed_at` is stored),
 *  just the columns lib/tps.js aggregates. Null when the database is unavailable. */
function requestsBetween(fromIso, toIso) {
    const d = open();
    if (!d) return null;
    try {
        return d.prepare(`SELECT completed_at, model_path, prompt_tokens, prefill_tps, gen_tokens, gen_tps FROM requests
                          WHERE completed_at >= ? AND completed_at <= ? AND source != ? ORDER BY completed_at`).all(fromIso, toIso, UNTIMED_SOURCE);
    } catch (err) { warnOnce('requestsBetween failed', err); return null; }
}

// ---- History: requests the CSV never saw (2026-09-30, Kyle) ----
// History (/api/logs/recent) used to read only logs/benchmarks.csv, which only gets requests from
// servers LL-Dash itself launched -- so once benchmark legs moved to the codebench queue (which
// launches its own llama-server/Strata and whose timings arrive here via db-import-llama-logs.py
// as source 'llama-log-import'), History went silent after the last dashboard-launched request.
// Which rows are already in the CSV is decided by SOURCE, not by csv_run_id: every row carries a
// csv_run_id (log imports use "log:<logfile>:<byte offset>"), but only 'csv-import' (imported FROM
// the CSV) and 'live' (insertRequest above, written alongside the CSV row with the same run_id)
// duplicate it. Checked 2026-09-30: all 10324 csv-import/live ids are in the CSV, none of the
// 14572 llama-log-import ids are, and no log-import row matches a CSV row on model+time+gen tokens.
const CSV_SOURCES_SQL = `source NOT IN ('csv-import', 'live')`;

/** How many requests exist ONLY in the database (not in benchmarks.csv). Null when unavailable. */
function countNonCsvRequests() {
    const d = open();
    if (!d) return null;
    try { return d.prepare(`SELECT COUNT(*) AS n FROM requests WHERE ${CSV_SOURCES_SQL}`).get().n; }
    catch (err) { warnOnce('countNonCsvRequests failed', err); return null; }
}

/** The newest `n` DB-only requests as light {id, completed_at} keys, newest first -- walks the
 *  requests_time index backwards, so paging History never loads the 25k full rows. */
function newestNonCsvRequestKeys(n) {
    const d = open();
    if (!d) return null;
    try {
        return d.prepare(`SELECT id, completed_at FROM requests WHERE ${CSV_SOURCES_SQL}
                          ORDER BY completed_at DESC, id DESC LIMIT ?`).all(Math.max(0, n | 0));
    } catch (err) { warnOnce('newestNonCsvRequestKeys failed', err); return null; }
}

/** Full rows for the given ids (one History page, <=500), any order. */
function requestsByIds(ids) {
    const d = open();
    if (!d || !ids.length) return [];
    try { return d.prepare(`SELECT * FROM requests WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids); }
    catch (err) { warnOnce('requestsByIds failed', err); return []; }
}

// ---- History chart window (2026-10-01, Kyle) ----
// /api/logs/range plots a time window instead of the table's loaded rows, so it needs the DB-only
// requests by completion time: same CSV_SOURCES_SQL dedupe as above, light columns only, walked on
// the requests_time index. Bounds are ISO text compared like completed_at is stored -- WITHOUT
// milliseconds ("...:10Z"); a "...:10.000Z" bound would sort before "...:10Z" ('.' < 'Z') and drop the
// boundary second, so callers pass second-granular bounds (floor from, ceil to) and filter exactly in JS.

/** DB-only requests completed in [fromIso, toIso], oldest first, chart columns only. Null when unavailable. */
function nonCsvPointsBetween(fromIso, toIso) {
    const d = open();
    if (!d) return null;
    try {
        return d.prepare(`SELECT completed_at, model_path, prompt_tokens, prefill_tps, gen_tokens, gen_tps FROM requests
                          WHERE ${CSV_SOURCES_SQL} AND completed_at >= ? AND completed_at <= ? ORDER BY completed_at`).all(fromIso, toIso);
    } catch (err) { warnOnce('nonCsvPointsBetween failed', err); return null; }
}

/** {first, last} completed_at (ISO) of the DB-only requests -- two index probes. Null when unavailable/empty. */
function nonCsvExtent() {
    const d = open();
    if (!d) return null;
    try {
        const first = d.prepare(`SELECT completed_at FROM requests WHERE ${CSV_SOURCES_SQL} ORDER BY completed_at ASC LIMIT 1`).get();
        const last = d.prepare(`SELECT completed_at FROM requests WHERE ${CSV_SOURCES_SQL} ORDER BY completed_at DESC LIMIT 1`).get();
        return first && last ? { first: first.completed_at, last: last.completed_at } : null;
    } catch (err) { warnOnce('nonCsvExtent failed', err); return null; }
}

module.exports = { open, insertRequest, withWeights, readRequests, readMachines, readRequestDeviceNames, requestsStamp, requestsBetween, machineIdentity, buildIdentity, DB_PATH,
    countNonCsvRequests, newestNonCsvRequestKeys, requestsByIds, nonCsvPointsBetween, nonCsvExtent, UNTIMED_SOURCE };
