'use strict';
// --- PER-REQUEST TELEMETRY FOR EVERY LANE (2026-10-22) ---
// Kyle: "in monitor, 'no telemetry samples for this request', always...". A Monitor row's chart came from one place:
// the samples LL-Dash takes while a server IT launched works (stdout progress lines), kept for the last 30 requests in
// memory. The queue lanes' servers -- Strata and llama.cpp, here or on the laptop -- never fed it, and their rows
// (LANE_COMPLETION) carried no run id at all, so every lane row asked for `runId=undefined`.
//
// Now every lane request gets a series, cut from the per-lane live state the rest of the dashboard already reads
// (server4.js lanesLive(): the lane's engine poll -- Strata /metrics, llama /slots -- folded with its record-proxy tap by
// lib/lanetps.js laneRates; the sidebar, Monitor's lane lines and the Live view's strip read the same records). Nothing
// here polls anything:
//   begin(lane, ev)  the tap's `request` frame opens a series (one per tap id; side requests too: Monitor lists them)
//   tick(lanes)      every telemetry-loop tick appends the lane's record to each series open on that lane
//   end(lane, ev)    the tap's `end` closes it, and the engine's own timings (prompt_ms / predicted_ms and the exact
//                    rates) place the read / answer boundary and fill what the ticks could not see -- most agent
//                    requests are shorter than one tick (0.8-1.9 s on Strata at 94k context, 2026-10-22)
// The run id is `rec:<queue item label>:<tap id>`: the tap id IS the proxy recording's `seq`, so it is also the id
// codebench's db-import-llama-logs.py gives the request when it imports the recording (a Strata leg's History rows).
//
// createStore() keeps them in the request-log SQLite (table request_samples, db/schema.sql), bounded by count and age,
// written in one transaction every FLUSH_MS (better-sqlite3 is synchronous, and the queue runner and the importers
// write the same file), so a dashboard restart no longer loses them. Samples are stored without their nulls, deflated.
// missingReason() says why a row has none, for the expand modal (Monitor and History share it).

const zlib = require('zlib');

const MAX_SAMPLES = 900;              // ~15 min at 1 s; a longer request is thinned (every other sample), never cut
const MAX_OPEN_PER_LANE = 32;         // series whose `end` never came (a proxy killed mid-request) go first
const KEEP_ROWS = 50000;              // ~0.6 KB a request deflated (measured on local-gpu 2026-10-22): ~30 MB; a busy day of 3-4 lanes
const KEEP_MS = 14 * 24 * 3600 * 1000;
const FLUSH_MS = 5000;
const SINCE_KEY = 'lldash.request_samples_since';

const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const pos = (v) => (num(v) != null && Number(v) > 0 ? Number(v) : null);
const ENGINE_SRC = new Set(['metrics', 'slots']);   // lib/lanetps.js: the engine's own live counters (else the tap's guess)

function laneRunId(label, tapId) { return `rec:${label}:${tapId}`; }

/** One lane record (lanesLive().lanes[i]) -> one chart sample, in the field names the omni chart reads. Only THIS
 *  request's own live rates: the tap's prefill is the previous request's, and its text-based gen rate is ~30% off --
 *  end() fills both from the engine's exact timings instead. */
function sampleFromLane(l, devices, now) {
    const s = { t: now, phase: l.phase || null };
    let engine = false;
    if (l.phase === 'prefill') {
        if (pos(l.prefill) && ENGINE_SRC.has(l.prefillSrc)) { s.prefillTps = Number(l.prefill); engine = true; }
        if (num(l.progress) != null) s.prefillProgress = Number(l.progress);
        if (num(l.read) != null) s.prefillPos = Number(l.read);
        if (pos(l.total)) s.prefillTotal = Number(l.total);
    } else if (l.phase === 'gen') {
        if (pos(l.gen) && ENGINE_SRC.has(l.genSrc)) { s.genTps = Number(l.gen); engine = true; }
        if (num(l.generated) != null) s.genTokens = Number(l.generated);
    }
    if (pos(l.ctx)) { s.ctx = Number(l.ctx); engine = true; }
    if (pos(l.ctxMax)) s.ctxMax = Number(l.ctxMax);
    if (Array.isArray(devices) && devices.length) s.devices = devices;
    s.src = engine ? 'engine' : 'tap';
    return s;
}

function createRecorder(opts = {}) {
    const maxSamples = opts.maxSamples || MAX_SAMPLES;
    const open = new Map();   // `${lane}\n${tapId}` -> series
    const key = (lane, id) => `${lane}\n${id}`;

    /** A `request` frame. ctx: { itemId, label, engine, devices } of the lane right now. A replayed frame (the tap's
     *  catch-up on connect) opens a PARTIAL series: the request may be over (its end follows in the same burst) or
     *  still running (live frames follow). */
    function begin(lane, ev, ctx = {}, now = Date.now()) {
        if (!lane || !ev || ev.id == null) return null;
        const live = !ev.replay;
        const sr = { lane, tapId: ev.id, itemId: ctx.itemId ?? null, label: ctx.label || lane, engine: ctx.engine || null,
            side: !!ev.side, live, tStart: num(ev.t), startedAt: now, samples: [], stride: 1, ticks: 0 };
        // the moment it was sent: a request shorter than one tick still has its start
        if (live) sr.samples.push({ t: now, phase: 'prefill', ...(Array.isArray(ctx.devices) && ctx.devices.length ? { devices: ctx.devices } : {}), src: 'tap' });
        open.set(key(lane, ev.id), sr);
        const mine = [...open.values()].filter((x) => x.lane === lane);
        if (mine.length > MAX_OPEN_PER_LANE) open.delete(key(lane, mine[0].tapId));
        return sr;
    }

    /** One telemetry tick: lanes = lanesLive().lanes (every busy lane's record), devicesFor(lane) = its cards' readings. */
    function tick(lanes, devicesFor, now = Date.now()) {
        if (!open.size) return;
        const byLane = new Map((lanes || []).map((l) => [l.lane, l]));
        for (const sr of open.values()) {
            const l = byLane.get(sr.lane);
            if (!l) continue;
            if (l.engine) sr.engine = l.engine;
            if (sr.ticks++ % sr.stride) continue;
            let dev = null;
            try { dev = devicesFor ? devicesFor(sr.lane) : null; } catch { dev = null; }
            sr.samples.push(sampleFromLane(l, dev, now));
            if (sr.samples.length > maxSamples) {   // keep the whole request at half the resolution, and record at half from here
                sr.samples = sr.samples.filter((_, i, a) => i % 2 === 0 || i === a.length - 1);
                sr.stride *= 2;
            }
        }
    }

    /** An `end` frame -> the finished record { runId, lane, itemId, label, engine, live, tStart, completedAt, samples,
     *  reason, note }, or null for a frame that is no request of ours (no id). */
    function end(lane, ev, ctx = {}, now = Date.now()) {
        if (!lane || !ev || ev.id == null) return null;
        const k = key(lane, ev.id);
        const sr = open.get(k) || { lane, tapId: ev.id, itemId: ctx.itemId ?? null, label: ctx.label || lane, engine: ctx.engine || null,
            side: false, live: false, tStart: null, startedAt: null, samples: [], stride: 1, ticks: 0 };
        open.delete(k);
        // When it ended: now, for an end seen as it happened; the proxy's own stamp for one replayed on connect (the proxy
        // runs on this machine for every lane, the laptop's included), unless that is implausible.
        const stamped = num(ev.t) != null ? Number(ev.t) * 1000 : null;
        const endAt = sr.live || stamped == null || Math.abs(now - stamped) > 86400000 ? now : Math.min(now, stamped);
        const out = finish(sr, ev, endAt);
        return { runId: laneRunId(sr.label, sr.tapId), lane, itemId: sr.itemId, label: sr.label, engine: sr.engine,
            live: sr.live, tStart: sr.tStart, completedAt: endAt, ...out };
    }

    return { begin, tick, end, openCount: () => open.size };
}

/** The engine's timings place the read / answer boundary in the series and fill what the ticks could not see (the
 *  same fallback logCompletedRequest gives LL-Dash's own requests: a sample's live rate stands, the exact average only
 *  fills a gap), plus four anchors at the read's start and end and the answer's start and end, so a request shorter
 *  than a tick still draws both phases. */
function finish(sr, ev, endAt) {
    const t = (ev && ev.timings) || {};
    const pms = num(t.prompt_ms), gms = num(t.predicted_ms), pps = pos(t.prompt_per_second), gps = pos(t.predicted_per_second);
    const cacheN = num(t.cache_n), promptN = num(t.prompt_n), predN = num(t.predicted_n);
    const tGen = gms != null ? endAt - gms : null;
    const tStart = tGen != null && pms != null ? tGen - pms : null;
    const live = sr.samples.filter((s) => s.src !== 'timings');
    const samples = live.map((s) => ({ ...s }));
    const ctxMax = (samples.find((s) => s.ctxMax) || {}).ctxMax || null;
    for (const s of samples) {
        const reading = tGen != null ? s.t < tGen : s.phase === 'prefill';
        if (reading) {
            delete s.genTps;
            if (s.prefillTps == null && pps && (tStart == null || s.t >= tStart - 1000)) s.prefillTps = pps;
            if (pps && (tStart == null || s.t >= tStart - 1000)) s.prefillTpsAvg = pps;
        } else {
            delete s.prefillTps;
            if (s.genTps == null && gps) s.genTps = gps;
        }
    }
    const devicesNear = (at) => {
        let best = null;
        for (const s of samples) if (s.devices && (!best || Math.abs(s.t - at) < Math.abs(best.t - at))) best = s;
        return best && Math.abs(best.t - at) < 2500 ? { devices: best.devices } : {};
    };
    // the context: what the slot held before the read (cache_n), plus the read, plus the answer -- only when cache_n says
    const ctxAt = (n) => (cacheN != null && n != null ? { ctx: cacheN + n } : {});
    const anchors = [];
    const a = (o) => anchors.push({ ...o, ...(ctxMax ? { ctxMax } : {}), ...devicesNear(o.t), src: 'timings' });
    if (tStart != null && pps) {
        a({ t: Math.round(tStart), phase: 'prefill', prefillTps: pps, prefillTpsAvg: pps, prefillProgress: 0, ...ctxAt(0) });
        a({ t: Math.round(tGen) - 1, phase: 'prefill', prefillTps: pps, prefillTpsAvg: pps, prefillProgress: 1, ...ctxAt(promptN) });
    }
    if (tGen != null && gps) {
        a({ t: Math.round(tGen), phase: 'gen', genTps: gps, genTokens: 0, ...ctxAt(promptN) });
        a({ t: Math.round(endAt), phase: 'gen', genTps: gps, ...(predN != null ? { genTokens: predN } : {}),
            ...ctxAt(promptN != null && predN != null ? promptN + predN : null) });
    }
    const all = samples.concat(anchors).sort((x, y) => x.t - y.t);
    const lane = sr.engine ? `lane ${sr.lane} (${sr.engine})` : `lane ${sr.lane}`;
    const ticked = sr.live ? live.length - 1 : live.length;   // tick samples: begin() put the start point first
    let reason = null, note = null;
    if (all.length < 2) {
        reason = ev && (ev.error || (ev.status != null && Number(ev.status) !== 200))
            ? `the request failed (${[ev.status, ev.error].filter((x) => x != null && x !== '').join(' ') || 'no status'}) before ${lane} reported timings`
            : `${lane} reported no timings for this request, and it ended within one sample tick`;
    } else if (!sr.live && !live.length) {
        note = `it ran while the dashboard was not connected to ${lane}: the lines are the engine's final timings`;
    } else if (!sr.live) {
        note = `the dashboard connected to ${lane} mid-request: the live samples start then`;
    } else if (!ticked) {
        note = 'shorter than one sample tick: the lines are the engine\'s own averages for the read and the answer';
    } else if (!live.some((s) => s.src === 'engine')) {
        note = `${lane} gave no live counters (its engine could not be polled): the rates are the engine's final averages`;
    }
    return { samples: all, reason, note };
}

// ---- the store (request-log SQLite, table request_samples) ----
const pack = (samples) => zlib.deflateRawSync(Buffer.from(JSON.stringify(samples.map((s) => {
    const o = {};
    for (const [k, v] of Object.entries(s)) if (v != null) o[k] = v;   // the chart reads a missing field as null
    return o;
})), 'utf-8'));
const unpack = (buf) => { try { return JSON.parse(zlib.inflateRawSync(buf).toString('utf-8')); } catch { return []; } };

/**
 * db: () => a better-sqlite3 handle (lib/db.js open()) or null. put() queues, flush() writes the queue in one
 * transaction and prunes to keepRows / keepMs; get() / identity() read the queue first. Every call swallows database
 * errors (the dashboard's request handling must never break on it) and reports them once through `warn`.
 */
function createStore(opts = {}) {
    const getDb = opts.db || (() => null);
    const keepRows = opts.keepRows || KEEP_ROWS;
    const keepMs = opts.keepMs || KEEP_MS;
    const clock = opts.now || Date.now;
    const warn = opts.warn || (() => {});
    const pending = new Map();   // run_id -> row
    let since = null;
    let warned = false;
    const fail = (what, err) => { if (!warned) { warned = true; warn(`[request-samples] ${what}: ${err && err.message ? err.message : err}`); } };
    function db() {
        let d = null;
        try { d = getDb(); } catch (err) { fail('open', err); d = null; }
        if (d && since == null) {
            try {
                d.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)').run(SINCE_KEY, String(clock()));
                since = Number((d.prepare('SELECT value FROM meta WHERE key = ?').get(SINCE_KEY) || {}).value) || null;
            } catch (err) { fail('since', err); }
        }
        return d;
    }

    /** rec: end()'s record, or { runId, source: 'lldash', completedAt, samples } for LL-Dash's own server. */
    function put(rec) {
        if (!rec || !rec.runId) return;
        pending.set(rec.runId, { run_id: rec.runId, source: rec.source || 'lane', lane: rec.lane || null, item_id: rec.itemId ?? null,
            t_start: rec.tStart ?? null, completed_at: Math.round(rec.completedAt || clock()), samples: rec.samples || [],
            reason: rec.reason || null, note: rec.note || null });
    }
    function readRow(runId) {
        if (pending.has(runId)) return pending.get(runId);
        const d = db();
        if (!d) return null;
        try {
            const r = d.prepare('SELECT run_id, source, lane, item_id, t_start, completed_at, reason, note, samples_z FROM request_samples WHERE run_id = ?').get(runId);
            return r ? { ...r, samples: unpack(r.samples_z) } : null;
        } catch (err) { fail('read', err); return null; }
    }
    /** -> { samples, reason, note, lane, completedAt } or null (not kept). */
    function get(runId) {
        const r = runId ? readRow(runId) : null;
        return r ? { samples: r.samples, reason: r.reason, note: r.note, lane: r.lane, completedAt: r.completed_at } : null;
    }
    /** Is this request (by run id and its proxy stamp) kept already? 'same' | 'other' (the id is another request's: a
     *  queue label run again restarts the proxy's seq) | null (not kept). */
    function identity(runId, tStart, itemId) {
        let r = pending.get(runId) || null;
        if (!r) {
            const d = db();
            if (!d) return null;
            try { r = d.prepare('SELECT item_id, t_start FROM request_samples WHERE run_id = ?').get(runId) || null; } catch (err) { fail('identity', err); return null; }
        }
        if (!r) return null;
        if (itemId != null && r.item_id != null && Number(itemId) !== Number(r.item_id)) return 'other';
        if (tStart != null && r.t_start != null && Math.abs(Number(tStart) - Number(r.t_start)) > 0.5) return 'other';
        return 'same';
    }
    function flush() {
        const d = db();
        if (!d) return { written: 0, pruned: 0 };
        const rows = [...pending.values()];
        let pruned = 0;
        try {
            const ins = d.prepare(`INSERT OR REPLACE INTO request_samples (run_id, source, lane, item_id, t_start, completed_at, n, reason, note, samples_z)
                                   VALUES (?,?,?,?,?,?,?,?,?,?)`);
            const byAge = d.prepare('DELETE FROM request_samples WHERE completed_at < ?');
            const byCount = d.prepare('DELETE FROM request_samples WHERE id <= (SELECT id FROM request_samples ORDER BY id DESC LIMIT 1 OFFSET ?)');
            d.transaction(() => {
                for (const r of rows) ins.run(r.run_id, r.source, r.lane, r.item_id, r.t_start, r.completed_at, r.samples.length, r.reason, r.note, pack(r.samples));
                pruned += byAge.run(clock() - keepMs).changes;
                pruned += byCount.run(keepRows).changes;
            })();
            for (const r of rows) if (pending.get(r.run_id) === r) pending.delete(r.run_id);
            return { written: rows.length, pruned };
        } catch (err) { fail('flush', err); return { written: 0, pruned: 0 }; }
    }
    /** What is kept: { since (ms: the first time this store ran), oldest (ms), count, keepRows, keepMs }. */
    function bounds() {
        const d = db();
        let oldest = null, count = 0;
        if (d) {
            try { const r = d.prepare('SELECT min(completed_at) AS oldest, count(*) AS n FROM request_samples').get(); oldest = r.oldest; count = r.n; }
            catch (err) { fail('bounds', err); }
        }
        return { since, oldest, count: count + pending.size, keepRows, keepMs };
    }
    return { put, get, identity, flush, bounds, pendingCount: () => pending.size };
}

// ---- why a row has no samples (GET /api/logs/samples) ----
const fmtDay = (ms) => new Date(ms).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
/** When a run id says it was made: LL-Dash's own `<base36 ms>_<hex>` (server4.js generateRunId). */
function runIdTime(runId) {
    const m = /^([0-9a-z]{6,10})_[0-9a-f]{2,8}$/.exec(String(runId || ''));
    if (!m) return null;
    const ms = parseInt(m[1], 36);
    return ms > 1.5e12 && ms < 4e12 ? ms : null;
}
/**
 * runId: the row's; at: its timestamp (ms) when the client knows it; b: store.bounds(). -> one sentence for the modal.
 */
function missingReason(runId, at, b = {}) {
    const keep = `the last ${Number(b.keepRows || KEEP_ROWS).toLocaleString('en-US')} requests or ${Math.round((b.keepMs || KEEP_MS) / 86400000)} days`;
    if (!runId) return 'this row has no run id: it was recorded before per-request telemetry existed for queue lanes';
    if (/^log:/.test(runId)) return 'imported from a llama-server log after the run: a log has no live progress, so this row has no samples (the same request\'s Monitor row, rec:<label>:<n>, has them)';
    const when = num(at) || runIdTime(runId);
    if (when != null && b.since != null && when < b.since) return `recorded before per-request telemetry was kept (from ${fmtDay(b.since)}; before that only the last 30 requests of LL-Dash's own server were held, in memory)`;
    if (when != null && b.oldest != null && when < b.oldest) return `older than the telemetry kept (${keep})`;
    if (/^rec:/.test(runId)) return b.since == null ? 'no telemetry was recorded for this request (the request log is unavailable)' : `no telemetry was recorded for this request: it predates ${fmtDay(b.since)}, or is older than ${keep}`;
    return 'no sample was taken while this request ran (it finished within one telemetry tick)';
}

module.exports = { createRecorder, createStore, missingReason, sampleFromLane, laneRunId, runIdTime, finish, pack, unpack,
    MAX_SAMPLES, KEEP_ROWS, KEEP_MS, FLUSH_MS, SINCE_KEY };
