'use strict';
// --- PER-TASK TOKEN RATES: prefill / generation t/s averaged over one codebench task ---
// The Bench -> Live view shows, per task of the running battery, the average prefill and
// generation rate the server delivered while that task ran. Averages are TOKEN-WEIGHTED
// (sum tokens / sum time), never a mean of per-request rates: a 30-token cached prefill at
// 40 t/s must not pull a task that also prefilled 20k tokens at 900 t/s down to ~470.
//
// Three sources, in order of preference (server4.js picks):
//   'tap'   the proxy tap's `end` event carries llama-server's own `timings` (prompt_n/prompt_ms,
//           predicted_n/predicted_ms): exact. Only seen while lib/livechat.js has the tap dialled.
//   'slots' lib/slots.js's `finished` request from the 1 Hz GET /slots poll: token counts are
//           exact, the rates are sampled, so time is derived as tokens / rate. Always on, but
//           server4.js feeds it generation only: 1 Hz cannot time a prefill of a few seconds.
//   'db'    the `requests` table (lib/db.js) over the task's time window: for tasks that ran
//           before this process saw them. Queue-launched servers only get rows once codebench's
//           tools/db-import-llama-logs.py has run, so no rows means null ("—"), never a guess.
// Pure; unit-tested in test/tps.test.js.

const MAX_KEYS = 200;

function fresh() { return { prompt_n: 0, prompt_ms: 0, predicted_n: 0, predicted_ms: 0, n: 0, src: {} }; }
const pos = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };

// One phase's contribution: only when both its tokens and its time are known and positive.
function addPhase(acc, which, tokens, ms) {
    const t = pos(tokens), m = pos(ms);
    if (!t || !m) return false;
    acc[which + '_n'] += t; acc[which + '_ms'] += m;
    return true;
}
function mark(acc, used, src) { if (!used) return; acc.n++; acc.src[src] = (acc.src[src] || 0) + 1; }

// llama-server `timings` (from the tap's end event).
function addTimings(acc, t, src) {
    if (!t || typeof t !== 'object') return acc;
    const a = addPhase(acc, 'prompt', t.prompt_n, t.prompt_ms);
    const b = addPhase(acc, 'predicted', t.predicted_n, t.predicted_ms);
    mark(acc, a || b, src || 'tap');
    return acc;
}
// Tokens + rate (lib/slots.js `finished`, or a request-log row): time = tokens / rate.
function addRates(acc, r, src) {
    if (!r || typeof r !== 'object') return acc;
    const pt = pos(r.promptTokens), pr = pos(r.promptTps), gt = pos(r.genTokens), gr = pos(r.genTps);
    const a = addPhase(acc, 'prompt', pt, pr ? (pt / pr) * 1000 : 0);
    const b = addPhase(acc, 'predicted', gt, gr ? (gt / gr) * 1000 : 0);
    mark(acc, a || b, src || 'slots');
    return acc;
}

// {pp, gen, n, prompt_n, predicted_n, src} -- null when nothing was ever counted.
function summarize(acc) {
    if (!acc || !acc.n) return null;
    const rate = (n, ms) => (n && ms ? +(n / (ms / 1000)).toFixed(2) : null);
    return { pp: rate(acc.prompt_n, acc.prompt_ms), gen: rate(acc.predicted_n, acc.predicted_ms), n: acc.n,
        prompt_n: acc.prompt_n, predicted_n: acc.predicted_n, src: Object.keys(acc.src).sort().join('+') || null };
}

// Request-log rows (prompt_tokens, prefill_tps, gen_tokens, gen_tps) -> the same summary.
function fromRows(rows) {
    const acc = fresh();
    for (const r of rows || []) addRates(acc, { promptTokens: r.prompt_tokens, promptTps: r.prefill_tps, genTokens: r.gen_tokens, genTps: r.gen_tps }, 'db');
    return summarize(acc);
}

const ModelName = require('../ui/shared/modelname.js');
// "Qwen3.8-Flash-Next-UD-IQ4_XS" from ".../Qwen3.8-Flash-Next-UD-IQ4_XS-00001-of-00003.gguf":
// the same model can sit behind two paths (a /data/models symlink, a split first shard).
function modelKey(p) {
    return ModelName.modelName(p, { ext: false }) || null;
}
// Rows that belong to `modelPath` (rows without a model_path are kept: nothing says otherwise).
function rowsForModel(rows, modelPath) {
    const want = modelKey(modelPath);
    if (!want) return rows || [];
    return (rows || []).filter((r) => !r.model_path || modelKey(r.model_path) === want);
}

function taskKey(battery, task, run) { return `${battery}|${task}#${run || 1}`; }

// --- PER-RUN RATES OVER THE REQUEST LOG (2026-10-18, Kyle: "on the a/b compare pages, I'd like to see the avg tg and
// pp speeds for each config being compared") ---
// lib/models.js gives every finished local codebench run the requests its server logged while it ran, with the same
// window as server4.js resultWindow ([start - 1 s, start + wall + 5 s]) and the same token-weighted sum as above.
// The window alone is not enough: two lanes can serve the SAME weights at once (Qwen3.8-27B UD-Q4_K_XL on the XTX
// and on the laptop 4090 + 3060), and 253 of 2,328 local run windows held requests from more than one launch. So:
//   - a run that recorded its launch command (llama.cpp) takes only requests logged under that command (quotes,
//     whitespace and --port aside); none match -> null, never another server's requests;
//   - a run with no launch command (Strata results record none) takes the model's requests on its own machine (rows
//     with no machine recorded included), and only when they all came from one launch; two launches in the window -> null (cannot tell which served it);
//   - requests with no model path are never taken (nothing says which server they were).
// One request can be in the log twice (the dashboard's own `live` row and the llama-log import of the same server):
// when a window holds more than one source, the source with the most rows is used.
// Rows: lib/models.js readRequests() shape ({t, modelPath, launchCommand, machineFp, source, aborted, promptTokens,
// promptTps, genTokens, genTps}). Pure.
const WINDOW_BEFORE_MS = 1000, WINDOW_AFTER_MS = 5000;
const normLaunch = (c) => String(c || '').replace(/['"]/g, '').replace(/(^|\s)--port[= ]\S+/g, ' ').replace(/\s+/g, ' ').trim();
const timelineMemo = new WeakMap();
/** Requests sorted by completion time, for runRates. Memoised per rows array (readRequests keeps one array until the table changes). */
function requestTimeline(rows) {
    if (rows && timelineMemo.has(rows)) return timelineMemo.get(rows);
    const list = (rows || []).filter((r) => r && Number.isFinite(r.t) && r.modelPath && !r.aborted).sort((a, b) => a.t - b.t);
    const keys = new Map();
    const tl = { rows: list, ts: Float64Array.from(list.map((r) => r.t)),
        modelKey: (p) => { if (!keys.has(p)) keys.set(p, modelKey(p)); return keys.get(p); },
        launch: new Map() };
    if (rows) timelineMemo.set(rows, tl);
    return tl;
}
function firstAtOrAfter(ts, t) {
    let lo = 0, hi = ts.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (ts[mid] < t) lo = mid + 1; else hi = mid; }
    return lo;
}
/** The requests one run's server logged while it ran. run: {from, to (ms), modelPath, launchCommand, machineFp}. */
function runRequests(tl, run) {
    if (!tl || !run || !run.modelPath || !Number.isFinite(run.from) || !Number.isFinite(run.to) || run.to < run.from) return [];
    const want = tl.modelKey(run.modelPath);
    if (!want) return [];
    const nl = (c) => { if (!tl.launch.has(c)) tl.launch.set(c, normLaunch(c)); return tl.launch.get(c); };
    const end = run.to + WINDOW_AFTER_MS;
    let hit = [];
    for (let i = firstAtOrAfter(tl.ts, run.from - WINDOW_BEFORE_MS); i < tl.rows.length && tl.ts[i] <= end; i++) {
        const r = tl.rows[i];
        if (tl.modelKey(r.modelPath) === want) hit.push(r);
    }
    if (!hit.length) return [];
    if (run.launchCommand) {
        const lc = nl(run.launchCommand);
        hit = hit.filter((r) => r.launchCommand && nl(r.launchCommand) === lc);
    } else {
        if (run.machineFp) hit = hit.filter((r) => !r.machineFp || r.machineFp === run.machineFp);   // a row with no machine recorded does not say it was another
        if (new Set(hit.map((r) => nl(r.launchCommand))).size > 1) return [];
    }
    const bySrc = new Map();
    for (const r of hit) bySrc.set(r.source || '', (bySrc.get(r.source || '') || 0) + 1);
    if (bySrc.size > 1) {
        const top = [...bySrc.entries()].sort((a, b) => b[1] - a[1])[0][0];
        hit = hit.filter((r) => (r.source || '') === top);
    }
    return hit;
}
// CONTEXT-DEPTH BANDS (2026-10-22, the compare page's speed at each row's fastest config): a rate means little without
// the depth it ran at -- Flash-Next UD-Q4_K_XL's prompt rate on Strata v0.2.2 was 518 tok/s under 30k tokens of context
// and 312 above -- so every run's sums are also split at SPEED_BAND_SPLIT tokens of context (how full the context was
// when prefill finished: lib/models.js ctxDepth). Band 0 = below it, 1 = at or above; a request with no recorded depth
// counts in the totals only. ui/shared/leaderboard.js SPEED_BANDS names the two bands (its test checks they agree).
const SPEED_BAND_SPLIT = 30000;
const bandOf = (depth) => (depth == null || !Number.isFinite(Number(depth)) ? null : Number(depth) < SPEED_BAND_SPLIT ? 0 : 1);
const bandSums = (a) => ({ prompt_n: a.prompt_n, prompt_ms: Math.round(a.prompt_ms), predicted_n: a.predicted_n, predicted_ms: Math.round(a.predicted_ms), n: a.n });
/** One run's token sums: {prompt_n, prompt_ms, predicted_n, predicted_ms, n (requests)} -- null when no request of
 *  its own server is in its window. Sums, not rates, so runs and configs can be added up before dividing.
 *  `lo` / `hi`: the same sums over its requests below / at or above SPEED_BAND_SPLIT tokens of context (only when there
 *  are any). */
function runRates(tl, run) {
    const acc = fresh(), band = [fresh(), fresh()];
    for (const r of runRequests(tl, run)) {
        addRates(acc, r, r.source || 'db');
        const b = bandOf(r.ctxDepth);
        if (b != null) addRates(band[b], r, r.source || 'db');
    }
    if (!acc.n) return null;
    return { ...bandSums(acc), ...(band[0].n ? { lo: bandSums(band[0]) } : {}), ...(band[1].n ? { hi: bandSums(band[1]) } : {}) };
}

// The per-(battery, task) accumulators, oldest dropped past MAX_KEYS (a Map keeps insertion order).
function createBook(opts) {
    const max = (opts && opts.max) || MAX_KEYS;
    const book = new Map();
    function acc(key) {
        let a = book.get(key);
        if (!a) { a = fresh(); book.set(key, a); while (book.size > max) book.delete(book.keys().next().value); }
        return a;
    }
    return {
        addTimings: (key, t, src) => { if (key) addTimings(acc(key), t, src); },
        addRates: (key, r, src) => { if (key) addRates(acc(key), r, src); },
        get: (key) => summarize(book.get(key)),
        size: () => book.size,
    };
}

module.exports = { fresh, addTimings, addRates, summarize, fromRows, modelKey, rowsForModel, taskKey, createBook,
    requestTimeline, runRequests, runRates, normLaunch, SPEED_BAND_SPLIT, bandOf };
