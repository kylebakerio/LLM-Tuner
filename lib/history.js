// History tab's merged request stream (2026-09-30, Kyle).
//
// /api/logs/recent pages newest-first over benchmarks.csv PLUS the bench.sqlite requests the CSV
// never saw (codebench-queue legs -- see the History block at the bottom of lib/db.js for why and
// how those are picked). Kept pure here so the merge and the row mapping are unit-testable without
// the server; server4.js does the I/O.

'use strict';

/**
 * One page of the merged stream. `csvKeys` / `dbKeys` are each source's NEWEST entries, newest
 * first, as {t: epoch ms, ...} -- at least offset+limit of each (or all there are). The merged
 * top offset+limit can only come from those, so neither source has to be read in full.
 * Returns the page OLDEST-first (the order /api/logs/recent always returned rows in), each entry
 * tagged with `from: 'csv' | 'db'`. Ties go to the CSV entry (arbitrary but deterministic).
 * An unparseable timestamp sorts as oldest rather than poisoning the comparison.
 */
function mergeNewestFirst(csvKeys, dbKeys, offset, limit) {
    const want = offset + limit;
    const t = (e) => (Number.isFinite(e.t) ? e.t : -Infinity);
    const out = [];
    let i = 0, j = 0;
    while (out.length < want && (i < csvKeys.length || j < dbKeys.length)) {
        const takeCsv = j >= dbKeys.length || (i < csvKeys.length && t(csvKeys[i]) >= t(dbKeys[j]));
        out.push(takeCsv ? { ...csvKeys[i++], from: 'csv' } : { ...dbKeys[j++], from: 'db' });
    }
    return out.slice(offset, want).reverse();
}

const parseJson = (s) => { if (!s) return null; try { return JSON.parse(s); } catch { return null; } };
const numOrNull = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

/**
 * A bench.sqlite `requests` row -> the exact row shape /api/logs/recent builds from a CSV line,
 * so script.js (History table, chart, grouping, expanded row) needs no second code path.
 * telemetry_json uses insertRequest()'s key names (appendBenchmarkRow's), which differ from the
 * detail names the CSV reader uses -- mapped explicitly below. Log-imported rows have no
 * telemetry, load time or transport; those stay null, which every reader already handles.
 */
function dbRowToRecentRow(r) {
    const tele = parseJson(r.telemetry_json) || {};
    const modelPath = r.model_path || null;
    return {
        timestamp: r.completed_at,
        runId: r.csv_run_id || `db:${r.id}`,
        model: modelPath ? modelPath.split('/').pop() : null,
        transport: null,
        promptTps: numOrNull(r.prefill_tps),
        genTps: numOrNull(r.gen_tps),
        promptTokens: numOrNull(r.prompt_tokens),
        genTokens: numOrNull(r.gen_tokens),
        wallTime: numOrNull(r.wall_s),
        draftAcceptRate: numOrNull(r.draft_accept_rate),   // 0-1, same unit as the CSV column
        draftAccepted: numOrNull(r.draft_accepted),
        draftGenerated: numOrNull(r.draft_generated),
        draftMeanLen: numOrNull(r.draft_mean_len),
        aborted: !!r.aborted,
        prefillTpsMin: numOrNull(r.prefill_tps_min),
        prefillTpsMax: numOrNull(r.prefill_tps_max),
        genTpsMin: numOrNull(r.gen_tps_min),
        genTpsMax: numOrNull(r.gen_tps_max),
        detail: {
            modelPath,
            ctx: numOrNull(r.n_ctx),
            ngl: null,
            rpc: null,
            argString: null,
            launchCommand: r.launch_command || null,
            promptLatency: numOrNull(r.prompt_latency_s),
            reasonTokens: numOrNull(r.reasoning_tokens),
            loadTime: null,
            gpuUtil: numOrNull(tele.gpuUtil),
            gpuPwr: numOrNull(tele.gpuPwr),
            gpuTemp: numOrNull(tele.masterGpuTemp),
            cpuUtil: numOrNull(tele.cpuUtil),
            cpuTemp: numOrNull(tele.masterCpuTemp),
            vram: numOrNull(tele.gpuMem),
            ram: numOrNull(tele.ramUsage),
            wGpuUtil: numOrNull(tele.workerGpuUtil),
            wGpuPwr: numOrNull(tele.workerGpuPwr),
            wGpuTemp: numOrNull(tele.workerGpuTemp),
            wCpuTemp: null,
            wVram: numOrNull(tele.workerVram),
            wRam: numOrNull(tele.workerRam),
            netThroughput: null,
            config: parseJson(r.config_json),
            deviceStats: parseJson(r.devices_json),
            // Which server log the request was imported from ("log:queue/<leg>:<byte offset>" ->
            // "log:queue/<leg>"): one per queue leg, so History's launch grouping can tell two
            // back-to-back legs with a byte-identical command apart (there is no load time to do it).
            // log:<file>:<task> and rec:<battery>:<seq> (proxy recordings, e.g. Strata) -> one launch per log / battery
            launchLog: r.csv_run_id && /^(log|rec):/.test(r.csv_run_id) ? r.csv_run_id.replace(/:\d+$/, '') : null,
            source: r.source || null,
        },
    };
}

// ---- History chart: time-range window over both sources (2026-10-01, Kyle) ----
// Kyle: "the token/sec every completed request chart is now absolutely drowning in data points and
// the page chugs. We need a scrollable window that lets us pan into the chart's history ... but only
// loads the data range window we're looking at." The chart used to plot every row the TABLE had
// paged in -- and the table pages by runs, up to 6000 rows, so one agent day put thousands of points
// (two datasets, each a filled tensioned line) into Chart.js on every render. /api/logs/range now
// serves the chart on its own: the requests completed in [from, to], from BOTH sources, cut down to
// at most `max` REAL points server-side. Everything below is pure (no fs except the CSV index's
// injected reads) so it is unit-testable; server4.js does the wiring.

/** Light chart point. One shape for both sources, so the merge and downsample need no branches. */
function chartPoint(t, model, promptTps, genTps, promptTokens, genTokens) {
    return { t, model: model || null, promptTps, genTps, promptTokens, genTokens };
}

/**
 * Incremental index of benchmarks.csv as chart points, sorted by t (2026-10-01, Kyle).
 * The CSV is ~20 MB and the range endpoint is hit after every pan/zoom, so it is parsed ONCE
 * (~10k splitCsvLine calls) and after that only the bytes appended since are read: the file is
 * append-only and time-ordered (checked 2026-10-01: 10325 rows, none out of order). Two things
 * break that assumption and force a full reparse: the file shrinking, and migrateCsvHeader()
 * rewriting the header in place (same inode, every byte offset shifts) -- caught by re-reading the
 * 64 bytes just before the consumed offset and comparing them with what was there last time.
 * Only whole lines are consumed: appendBenchmarkRow's write can be observed half done.
 * `io` = { statSize(file) -> bytes | null, readRange(file, start, end) -> Buffer } so tests can run on
 * a temp file; `split` / `num` are server4.js's own splitCsvLine / parseNumOrNull (one CSV dialect).
 * Rows with < 32 columns are skipped, the same pre-v3 rule /api/logs/recent applies.
 * If a row ever arrives out of order the array is re-sorted, so binary search stays valid.
 */
function createCsvPointIndex(file, { io, split, num }) {
    let points = [], offset = 0, tailSig = null, headerSeen = false;
    const SIG = 64;
    const reset = () => { points = []; offset = 0; tailSig = null; headerSeen = false; };
    function refresh() {
        const size = io.statSize(file);
        if (size == null) { reset(); return points; }
        if (size < offset) reset();
        else if (offset > 0) {
            const sig = io.readRange(file, Math.max(0, offset - SIG), offset).toString('latin1');
            if (sig !== tailSig) reset();
        }
        if (size === offset) return points;
        const buf = io.readRange(file, offset, size);
        const lastNl = buf.lastIndexOf(0x0a);
        if (lastNl < 0) return points;                                  // no complete line yet
        const text = buf.subarray(0, lastNl + 1).toString('utf-8');
        let sorted = true, prevT = points.length ? points[points.length - 1].t : -Infinity;
        for (const line of text.split('\n')) {
            if (!line.trim()) continue;
            if (!headerSeen) { headerSeen = true; if (line.startsWith('Timestamp,')) continue; }
            const cols = split(line.replace(/\r$/, ''));
            if (cols.length < 32) continue;
            const t = Date.parse(cols[0]);
            if (!Number.isFinite(t)) continue;
            if (t < prevT) sorted = false;
            prevT = t;
            points.push(chartPoint(t, cols[2], num(cols[10]), num(cols[11]), num(cols[13]), num(cols[28])));
        }
        if (!sorted) points.sort((a, b) => a.t - b.t);
        offset += lastNl + 1;
        tailSig = io.readRange(file, Math.max(0, offset - SIG), offset).toString('latin1');
        return points;
    }
    return { refresh, get points() { return points; } };
}

/** First index whose t >= x in a t-sorted array (binary search). */
function lowerBound(arr, x) {
    let lo = 0, hi = arr.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (arr[mid].t < x) lo = mid + 1; else hi = mid; }
    return lo;
}
/** The points with from <= t <= to, as a slice (no copy of the rest). */
function sliceRange(sorted, from, to) {
    return sorted.slice(lowerBound(sorted, from), lowerBound(sorted, to + 1e-9));   // +eps: `to` inclusive for float ms too
}

/** Two t-sorted arrays -> one t-sorted array. Ties: the first array's point first (CSV before DB, as mergeNewestFirst). */
function mergeSorted(a, b) {
    const out = new Array(a.length + b.length);
    let i = 0, j = 0, k = 0;
    while (i < a.length && j < b.length) out[k++] = a[i].t <= b[j].t ? a[i++] : b[j++];
    while (i < a.length) out[k++] = a[i++];
    while (j < b.length) out[k++] = b[j++];
    return out;
}

/**
 * At most `max` points out of a t-sorted list (2026-10-01, Kyle). Splits [from, to] into max/4 equal
 * time buckets and keeps, per bucket, the points holding the min and max prompt t/s and the min and
 * max gen t/s (deduped, kept in time order). Why min/max of REAL points rather than a mean or LTTB:
 * the whole point of this chart is spotting slow outliers (a 3 t/s request among 40s), which a mean
 * erases and LTTB (one series at a time) can drop from the OTHER series; and keeping real requests
 * means the tooltip's model / token counts are true for whatever dot is under the pointer. Bursty
 * data is fine: empty buckets cost nothing, so idle hours don't eat the budget. A bucket keeps at
 * most 4 points; the first grid (max/4 buckets) therefore never exceeds `max`, and finer grids are only
 * accepted while they still fit. Under `max` the input is returned unchanged.
 */
function downsamplePoints(points, from, to, max) {
    return downsampleWithGrid(points, from, to, max).points;
}
/** downsamplePoints plus the bucket width it settled on (null = not downsampled). The chart breaks its
 *  line across gaps wider than a couple of buckets (2026-10-01, Kyle: lines, but not across idle
 *  hours), so it needs to know how far apart neighbouring downsampled points can legitimately be. */
function downsampleWithGrid(points, from, to, max) {
    max = Math.max(4, max | 0);
    if (points.length <= max) return { points, bucketMs: null };
    // Bursty data leaves most fixed buckets empty (checked 2026-10-01 on the real 25k: "all" at max/4
    // buckets kept only 440 of a 1500 budget), so the bucket count doubles while the result still
    // fits -- the finest grid that stays <= max wins. Not capped at nb <= n: ten 15-minute bursts in
    // ten days need buckets far finer than span/n before the bursts themselves get split. At most 24
    // passes of O(n) (25k points: a few ms each).
    let nbBest = Math.max(1, Math.floor(max / 4));
    let best = bucketMinMax(points, from, to, nbBest);
    for (let nb = Math.floor(max / 2), pass = 0; pass < 24; nb *= 2, pass++) {
        const next = bucketMinMax(points, from, to, nb);
        if (next.length > max) break;
        best = next; nbBest = nb;
        if (next.length === points.length) break;
    }
    return { points: best, bucketMs: Math.max(1, to - from) / nbBest };
}
function bucketMinMax(points, from, to, nb) {
    const span = Math.max(1, to - from);
    const out = [];
    let i = 0;
    while (i < points.length) {
        const b = Math.min(nb - 1, Math.max(0, Math.floor((points[i].t - from) / span * nb)));
        let j = i, pMin = -1, pMax = -1, gMin = -1, gMax = -1;
        for (; j < points.length && Math.min(nb - 1, Math.max(0, Math.floor((points[j].t - from) / span * nb))) === b; j++) {
            const p = points[j];
            if (Number.isFinite(p.promptTps)) {
                if (pMin < 0 || p.promptTps < points[pMin].promptTps) pMin = j;
                if (pMax < 0 || p.promptTps > points[pMax].promptTps) pMax = j;
            }
            if (Number.isFinite(p.genTps)) {
                if (gMin < 0 || p.genTps < points[gMin].genTps) gMin = j;
                if (gMax < 0 || p.genTps > points[gMax].genTps) gMax = j;
            }
        }
        const keep = [...new Set([pMin, pMax, gMin, gMax].filter(k => k >= 0))].sort((x, y) => x - y);
        if (!keep.length) keep.push(i);                     // a bucket with no rates at all: keep one so it still shows as "requests here"
        for (const k of keep) out.push(points[k]);
        i = j;
    }
    return out;
}

const DAY_MS = 24 * 3600 * 1000;
/**
 * The window the chart opens on (2026-10-01, Kyle): the 24 h ending at the NEWEST request (not at
 * "now" -- after a quiet day "now" would open on an empty chart), widened back to the `minPoints`-th
 * newest request when those 24 h are sparse, so a quiet stretch still opens on something readable.
 * `newestTs` = the newest timestamps (newest first, >= minPoints of them when that many exist).
 */
function defaultWindow(extent, newestTs, minPoints = 300) {
    if (!extent || !Number.isFinite(extent.last)) return null;
    const to = extent.last;
    let from = Math.max(extent.first, to - DAY_MS);
    const inDay = newestTs.filter(t => t >= from).length;
    if (inDay < minPoints && newestTs.length) from = Math.min(from, newestTs[Math.min(minPoints, newestTs.length) - 1]);
    return { from, to };
}

/**
 * One /api/logs/range response from both sources' points in [from, to] (each t-sorted).
 * Points go out compact -- {t, p, g, pt, gt, m} with m an index into `models` -- because "all" is
 * ~1500 points and every pan refetches: full key names + the model path string per point tripled it.
 */
function buildRangeResponse({ csvPoints, dbPoints, from, to, max, extent, defaultWin, view }) {
    const all = mergeSorted(csvPoints, dbPoints);
    // `view` = the visible window inside [from, to] (the client fetches a margin each side): its exact
    // request count, for the "downsampled from M" status. Two binary searches on the merged list.
    const totalInView = view ? lowerBound(all, view.to + 1e-9) - lowerBound(all, view.from) : all.length;
    const { points: shown, bucketMs } = downsampleWithGrid(all, from, to, max);
    const models = [], modelIdx = new Map();
    const points = shown.map(p => {
        let m = null;
        if (p.model) {
            if (!modelIdx.has(p.model)) { modelIdx.set(p.model, models.length); models.push(p.model); }
            m = modelIdx.get(p.model);
        }
        return { t: p.t, p: p.promptTps, g: p.genTps, pt: p.promptTokens, gt: p.genTokens, m };
    });
    return { from, to, extent, defaultWindow: defaultWin, total: all.length, totalInView, downsampled: shown.length < all.length, bucketMs, models, points };
}

module.exports = { mergeNewestFirst, dbRowToRecentRow,
    chartPoint, createCsvPointIndex, lowerBound, sliceRange, mergeSorted, downsamplePoints, downsampleWithGrid, defaultWindow, buildRangeResponse, DAY_MS };
