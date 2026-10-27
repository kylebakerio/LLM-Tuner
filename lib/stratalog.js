'use strict';
// --- REQUEST TIMINGS FROM THE STRATA ENGINE LOG (2026-10-22) ---
// Kyle: "the speed should separately be based on the fastest config ... I wouldn't want the speed to falsely be bogged
// down by having run low-speed quality runs". Picking a row's fastest config needs each config's measured rates, and a
// Strata queue item only lands in the request log when it ran with the record proxy recording (record=1). None of
// Flash-Next UD-Q4_K_XL's batteries did: the request log has no row for that model at all, so its rb30 and its rb42 /
// v0.2.2 runs both read "—" and nothing could tell them apart.
// The engine itself logs every request, to the config's `log` file (appended across starts; two configs that differ
// only in an environment variable, rb30 and rb30-nopin, share one):
//   [strata] 2026-10-22 03:24:04 engine started: <argv>                       (local time)
//   strata serve: prompt 7601 tokens = 7507 reused + 94 read in 1137 ms (82.7 tok/s), 103 generated in 1835 ms (...), ...
// "prompt N tokens" is how full the context was when the prompt was read (lib/models.js ctxDepth); "read" is the new
// tokens prefilled (the request log's prompt_tokens); "generated" is the decode. No request carries a time, only each
// engine start, so a run is placed in the START SEGMENT its window lies in (the queue starts an engine per item):
//   - a segment that served ONE run gives that run its requests, exactly;
//   - a segment that served several (a battery on one start) is shared out by the runs' wall clocks (`shared`): the
//     rates are exact (every share has the segment's rates), each run's token counts are approximate. By wall clock, not
//     by the result's token counts: the model's time is ~98% of an agent run's wall clock here (1265: 1551 s of engine
//     time in 1583 s of runs), while opencode's tokens_in / tokens_out leave out sub-agent sessions (1265: 90k / 52k
//     against the engine's 220k read / 72k generated) -- shared by them, a prompt-heavy run got too little prompt time.
// A run whose window crosses an engine start, or whose start was not recorded, gets nothing (unknown, never a guess).
// Read only; cached per file by mtime + size; a partial last line (a log being written) is ignored. Pure apart from the
// file reads; unit-tested in test/stratalog.test.js.

const fs = require('fs');
const { bandOf } = require('./tps');

const START_RE = /^\[strata\] (\d{4})-(\d\d)-(\d\d) (\d\d):(\d\d):(\d\d) engine started/;
const REQ_RE = /^strata serve: prompt (\d+) tokens = (\d+) reused \+ (\d+) read in (\d+) ms .*?, (\d+) generated in (\d+) ms/;
const SLACK_MS = 5000;   // the run's recorded start and the engine's own clock line are seconds apart at worst

/** Log text -> [{ start (ms; the engine's local wall clock), end (the next start, or Infinity), reqs: [{ depth, read,
 *  readMs, gen, genMs }] }]. Requests before the first start line (a log that was cut) are dropped. */
function parseLog(text) {
    const lines = String(text || '').split('\n');
    if (lines.length && !/\n$/.test(String(text || ''))) lines.pop();   // the line being written
    const segs = [];
    let cur = null;
    for (const l of lines) {
        const s = START_RE.exec(l);
        if (s) {
            const t = new Date(+s[1], +s[2] - 1, +s[3], +s[4], +s[5], +s[6]).getTime();
            if (cur) cur.end = t;
            cur = { start: t, end: Infinity, reqs: [] };
            segs.push(cur);
            continue;
        }
        if (!cur) continue;
        const r = REQ_RE.exec(l);
        if (r) cur.reqs.push({ depth: +r[1], read: +r[3], readMs: +r[4], gen: +r[5], genMs: +r[6] });
    }
    return segs;
}

const fileCache = new Map();   // path -> { sig, segs }
function readLog(file) {
    let st;
    try { st = fs.statSync(file); } catch { return null; }
    const sig = `${st.mtimeMs}:${st.size}`;
    const hit = fileCache.get(file);
    if (hit && hit.sig === sig) return hit.segs;
    let segs = null;
    try { segs = parseLog(fs.readFileSync(file, 'utf-8')); } catch { segs = null; }
    fileCache.set(file, { sig, segs });
    return segs;
}

const cfgCache = new Map();    // config path -> { sig, log }
/** The engine log a Strata config writes (its `log` field), or null. */
function logOfConfig(cfgPath) {
    if (!cfgPath) return null;
    let st;
    try { st = fs.statSync(cfgPath); } catch { return null; }
    const sig = `${st.mtimeMs}:${st.size}`;
    const hit = cfgCache.get(cfgPath);
    if (hit && hit.sig === sig) return hit.log;
    let log = null;
    try { const j = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')); log = j && typeof j.log === 'string' && j.log ? j.log : null; } catch { log = null; }
    cfgCache.set(cfgPath, { sig, log });
    return log;
}

// a segment's requests, summed in lib/tps.js runRates' shape and scaled by the run's `share` of the segment
function sums(reqs, share) {
    const out = { prompt_n: 0, prompt_ms: 0, predicted_n: 0, predicted_ms: 0, n: 0 };
    const band = [{ ...out }, { ...out }];
    const add = (a, q) => { a.prompt_n += q.read; a.prompt_ms += q.readMs; a.predicted_n += q.gen; a.predicted_ms += q.genMs; a.n++; };
    for (const q of reqs) { add(out, q); const b = bandOf(q.depth); if (b != null) add(band[b], q); }
    const scale = (a) => ({ prompt_n: Math.round(a.prompt_n * share), prompt_ms: Math.round(a.prompt_ms * share),
        predicted_n: Math.round(a.predicted_n * share), predicted_ms: Math.round(a.predicted_ms * share), n: Math.round(a.n * share * 100) / 100 });
    return { ...scale(out), ...(band[0].n ? { lo: scale(band[0]) } : {}), ...(band[1].n ? { hi: scale(band[1]) } : {}) };
}

/**
 * runs: [{ key, log (engine log path), from, to (ms: the run's window), weight (its share of a shared start: its wall
 * clock) }] -- every run of the batteries concerned, including ones nobody will read the result for (an
 * unfinished or superseded row still used the engine: it takes its share). readSegs: (path) -> segments (readLog).
 * -> Map key -> { prompt_n, prompt_ms, predicted_n, predicted_ms, n, lo?, hi?, src: 'strata-log', shared } for every run
 * placed in a segment that logged at least one request.
 */
function runSpeeds(runs, readSegs = readLog) {
    const bySeg = new Map();   // `${log}#${i}` -> { seg, members: [run] }
    for (const run of runs || []) {
        if (!run || !run.log || !Number.isFinite(run.from) || !Number.isFinite(run.to) || run.to < run.from) continue;
        const segs = readSegs(run.log);
        if (!segs || !segs.length) continue;
        let i = -1;
        for (let k = 0; k < segs.length; k++) { if (segs[k].start <= run.from + SLACK_MS) i = k; else break; }
        if (i < 0) continue;
        const seg = segs[i];
        if (run.to > seg.end + SLACK_MS) continue;   // the engine restarted inside the run: its requests are split
        const k = `${run.log}#${i}`;
        if (!bySeg.has(k)) bySeg.set(k, { seg, members: [] });
        bySeg.get(k).members.push(run);
    }
    const out = new Map();
    for (const { seg, members } of bySeg.values()) {
        if (!seg.reqs.length) continue;
        const w = members.map((r) => (Number(r.weight) > 0 ? Number(r.weight) : 1));
        const W = w.reduce((a, x) => a + x, 0);
        members.forEach((r, j) => out.set(r.key, { ...sums(seg.reqs, members.length === 1 ? 1 : w[j] / W), src: 'strata-log', shared: members.length > 1 }));
    }
    return out;
}

module.exports = { parseLog, readLog, logOfConfig, runSpeeds };
