// Telemetry since the dashboard started (2026-10-01, Kyle: the full-screen telemetry charts should
// show "the full recorded history since restart ... with a sliding time window and zoom-ability, like
// the history t/s graph"). The browser only ever held what it had seen since page load (and net /
// tokens-per-second were capped at 200 points), so the server keeps it instead: one sample per
// telemetry-loop tick, every GPU, every host, net throughput and the live generation rate.
//
// Stored COLUMNAR in a ring of typed arrays -- a day of 1 s ticks as objects would be ~100 MB; as
// Float32 columns it is ~4 bytes per number. A column is created the first time a series appears
// (a GPU, a host) and is NaN for ticks before that or without a reading, which the range query turns
// into null (a gap, never a fake zero). Kept for RETENTION_MS (6 h, Kyle 2026-10-01: "48 hours seems
// excessive"), by time rather than sample count so the fast 0.5 s polling rate gets the same 6 h; the ring
// is sized for that rate and older samples are dropped first.
//
// range() answers the full-screen chart's window queries the way /api/logs/range does for History:
// every sample in [from, to] when it fits under `max` points, else equal-width time buckets averaged
// per column (bucketMs reported so the client can tell a gap from a bucket boundary).

const RETENTION_MS = 6 * 3600 * 1000;
const CAPACITY = RETENTION_MS / 500;   // enough slots for 6 h at the fastest polling rate (0.5 s)

const GPU_FIELDS = ['util', 'pwr', 'temp', 'vram'];   // %, W, °C, GB used
const HOST_FIELDS = ['cpu', 'cpuTemp'];               // %, °C

function createTelemetryHistory(opts = {}) {
    const cap = opts.capacity || CAPACITY;
    const retention = opts.retentionMs || RETENTION_MS;
    const t = new Float64Array(cap);
    const cols = new Map();       // column key -> Float32Array(cap)
    const meta = new Map();       // column key -> { kind, id, host, name, field }
    let head = 0;                 // next write slot
    let size = 0;
    let lastNet = null;           // { t, bytes } per local host, for MB/s
    const lastPrefill = new Map(); // source (a lane, 'single') -> its last prefill rate, for the Tokens/sec prefill readings

    const column = (key, info) => {
        let c = cols.get(key);
        if (!c) { c = new Float32Array(cap).fill(NaN); cols.set(key, c); meta.set(key, info); }
        return c;
    };
    const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? NaN : Number(v));

    /** Record one monitor.py reading. `stats` is fetchCurrentTelemetry()'s object; `extra` = { genTps, prefillTps, lanes }. */
    function push(stats, extra = {}, now = Date.now()) {
        if (!stats) return;
        const slot = head;
        t[slot] = now;
        for (const c of cols.values()) c[slot] = NaN;
        const gpus = Array.isArray(stats.gpus) ? stats.gpus : [];
        for (const g of gpus) {
            const id = `${g.host || 'local'}|${g.pci || g.index || g.gpu_name}`;
            // label: the card as the rest of the dashboard names it ("RX 7900 XTX #2", server4.js fetchCurrentTelemetry);
            // two identical cards share a name, never a label
            const base = { kind: 'gpu', id, host: g.host || 'local', name: g.gpu_name || id, label: g.label || null };
            if (g.error) continue;
            column(`gpu:${id}:util`, { ...base, field: 'util' })[slot] = num(g.gpu_util);
            column(`gpu:${id}:pwr`, { ...base, field: 'pwr' })[slot] = num(g.gpu_pwr);
            column(`gpu:${id}:temp`, { ...base, field: 'temp' })[slot] = num(g.gpu_temp);
            column(`gpu:${id}:vram`, { ...base, field: 'vram' })[slot] = Number.isFinite(num(g.vram_used)) ? num(g.vram_used) / 1024 : NaN;
        }
        const hosts = stats.hosts && typeof stats.hosts === 'object' ? Object.entries(stats.hosts) : (stats.master ? [['local', stats.master]] : []);
        for (const [name, h] of hosts) {
            if (!h || h.error) continue;
            const base = { kind: 'host', id: name, host: name, name };
            column(`host:${name}:cpu`, { ...base, field: 'cpu' })[slot] = num(h.cpu_util);
            column(`host:${name}:cpuTemp`, { ...base, field: 'cpuTemp' })[slot] = num(h.cpu_temp);
        }
        // net MB/s on this machine's interfaces, from the byte counter's delta
        const local = (stats.hosts && stats.hosts.local) || stats.master;
        const bytes = local ? num(local.net_bytes) : NaN;
        if (Number.isFinite(bytes)) {
            if (lastNet && now > lastNet.t && bytes >= lastNet.bytes) {
                column('net', { kind: 'net', id: 'net', name: 'Net MB/s', field: 'net' })[slot] = (bytes - lastNet.bytes) / 1048576 / ((now - lastNet.t) / 1000);
            }
            lastNet = { t: now, bytes };
        }
        // Tokens/sec, the full-screen Tokens/s chart's two series (field 'tps'; 2026-10-27, Kyle: "clicking to zoom on
        // the t/s chart is broken" -- with queue lanes busy, genTps (the dashboard's own server, or an external one on
        // :8080, where Strata's /slots has no rates) was null or a flat 0, so the chart was empty).
        //   generation: the busy lanes' summed rate while any lane is busy (the sidebar's number), else genTps;
        //   prefill: a reading whenever a source's rate changes -- a lane's new request, a long read's live rate moving,
        //   the dashboard's own server's sample -- the mean if two change on one tick, else nothing. The chart joins the
        //   readings into a line: a lane's rate stays on its last request's value while busy, so per tick it is flat.
        const lanes = (Array.isArray(extra.lanes) ? extra.lanes : []).filter((l) => l && l.lane);
        const genNow = lanes.length ? lanes.reduce((a, l) => a + (num(l.gen) > 0 ? num(l.gen) : 0), 0) : extra.genTps;
        if (genNow != null) column('tps', { kind: 'tps', id: 'tps', name: 'Tokens/sec', field: 'tps' })[slot] = num(genNow);
        const readings = [], sources = [...lanes.map((l) => [l.lane, num(l.prefill)]), ['single', num(extra.prefillTps)]];
        for (const k of [...lastPrefill.keys()]) if (!sources.some(([src]) => src === k)) lastPrefill.delete(k);   // a lane gone idle
        for (const [src, v] of sources) {
            if (!(v > 0)) { lastPrefill.delete(src); continue; }
            if (lastPrefill.get(src) !== v) readings.push(v);
            lastPrefill.set(src, v);
        }
        if (readings.length) column('tps:prefill', { kind: 'tps', id: 'prefill', name: 'Prefill t/s', field: 'tps' })[slot] = readings.reduce((a, v) => a + v, 0) / readings.length;
        // Every busy server (queue lane) at this tick, its own generation and prompt-read rate (2026-10-06, Kyle: Monitor
        // should follow "all separate servers running concurrently", not the combined number). A lane's label is its
        // card + engine ("7900 XTX Strata"); the column keeps the latest label it was seen with.
        for (const l of lanes) {
            const base = { kind: 'lane', id: l.lane, name: l.label || l.lane };
            const g = column(`lane:${l.lane}:gen`, { ...base, field: 'laneGen' }); meta.get(`lane:${l.lane}:gen`).name = base.name;
            const pf = column(`lane:${l.lane}:prefill`, { ...base, field: 'lanePrefill' }); meta.get(`lane:${l.lane}:prefill`).name = base.name;
            g[slot] = l.phase === 'gen' ? num(l.gen) : NaN;
            pf[slot] = l.phase === 'prefill' && num(l.prefill) > 0 ? num(l.prefill) : NaN;   // 0 = rate not known yet (first chunk): a gap
        }
        head = (head + 1) % cap;
        size = Math.min(size + 1, cap);
        while (size > 1 && t[(head - size + cap) % cap] < now - retention) size--;   // age out past the retention
    }

    const at = (i) => (head - size + i + cap) % cap;   // logical index (0 = oldest) -> slot
    /** First logical index with t >= ms. */
    function lowerBound(ms) {
        let lo = 0, hi = size;
        while (lo < hi) { const mid = (lo + hi) >> 1; if (t[at(mid)] < ms) lo = mid + 1; else hi = mid; }
        return lo;
    }

    function extent() {
        return size ? { first: t[at(0)], last: t[at(size - 1)] } : null;
    }

    /**
     * Samples in [from, to] (epoch ms), at most `max` points (bucket means beyond that).
     * keys: optional column-key prefix filter (e.g. 'gpu:' + field) so a chart only ships its columns.
     * -> { extent, from, to, downsampled, bucketMs, count, t: [ms], series: [{ key, kind, id, host, name, field, data: [v|null] }] }
     */
    function range({ from, to, max = 1500, field = null } = {}) {
        const ext = extent();
        if (!ext) return { extent: null, from, to, downsampled: false, bucketMs: null, count: 0, t: [], series: [] };
        if (!Number.isFinite(to)) to = ext.last;
        if (!Number.isFinite(from)) from = to - 30 * 60 * 1000;
        const i0 = lowerBound(from), i1 = lowerBound(to + 1);   // [i0, i1)
        const count = Math.max(0, i1 - i0);
        const keys = [...cols.keys()].filter((k) => !field || meta.get(k).field === field);
        const out = { extent: ext, from, to, count, downsampled: false, bucketMs: null, t: [], series: keys.map((k) => ({ key: k, ...meta.get(k), data: [] })) };
        const clean = (v) => (Number.isFinite(v) ? Math.round(v * 100) / 100 : null);
        if (count <= max) {
            for (let i = i0; i < i1; i++) {
                const s = at(i);
                out.t.push(t[s]);
                keys.forEach((k, j) => out.series[j].data.push(clean(cols.get(k)[s])));
            }
            return out;
        }
        const bucketMs = Math.max(1, Math.ceil((to - from) / max));
        out.downsampled = true; out.bucketMs = bucketMs;
        let b = -1, n = 0, tSum = 0;
        const sums = new Float64Array(keys.length), cnts = new Uint32Array(keys.length);
        const flush = () => {
            if (!n) return;
            out.t.push(Math.round(tSum / n));
            keys.forEach((_, j) => out.series[j].data.push(cnts[j] ? clean(sums[j] / cnts[j]) : null));
            sums.fill(0); cnts.fill(0); n = 0; tSum = 0;
        };
        for (let i = i0; i < i1; i++) {
            const s = at(i), bi = Math.floor((t[s] - from) / bucketMs);
            if (bi !== b) { flush(); b = bi; }
            n++; tSum += t[s];
            keys.forEach((k, j) => { const v = cols.get(k)[s]; if (Number.isFinite(v)) { sums[j] += v; cnts[j]++; } });
        }
        flush();
        return out;
    }

    return { push, range, extent, get size() { return size; } };
}

module.exports = { createTelemetryHistory, CAPACITY, RETENTION_MS, GPU_FIELDS, HOST_FIELDS };
