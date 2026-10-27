'use strict';
// History chart time window (2026-10-01, Kyle: "a scrollable window that lets us pan into the chart's
// history ... but only loads the data range window we're looking at"): the pure parts of
// /api/logs/range (lib/history.js) and the client's window math (ui/shared/histwindow.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const H = require('../lib/history');
const W = require('../ui/shared/histwindow.js');

const pt = (t, p = 100, g = 10, model = 'm.gguf') => H.chartPoint(t, model, p, g, 1000, 50);

test('sliceRange is inclusive on both ends and binary-searches a sorted list', () => {
    const arr = [10, 20, 20, 30, 40].map((t) => pt(t));
    assert.deepEqual(H.sliceRange(arr, 20, 30).map((p) => p.t), [20, 20, 30]);
    assert.deepEqual(H.sliceRange(arr, 0, 9), []);
    assert.deepEqual(H.sliceRange(arr, 41, 99), []);
    assert.deepEqual(H.sliceRange(arr, 15, 35).map((p) => p.t), [20, 20, 30]);
    assert.equal(H.lowerBound(arr, 25), 3);
});

test('mergeSorted interleaves both sources by time, CSV first on ties', () => {
    const a = [pt(1, 1), pt(5, 1), pt(9, 1)], b = [pt(2, 2), pt(5, 2), pt(10, 2)];
    const m = H.mergeSorted(a, b);
    assert.deepEqual(m.map((p) => p.t), [1, 2, 5, 5, 9, 10]);
    assert.equal(m[2].promptTps, 1);
    assert.deepEqual(H.mergeSorted([], b).map((p) => p.t), [2, 5, 10]);
});

test('downsample returns small inputs untouched and never exceeds max', () => {
    const few = [pt(1), pt(2)];
    assert.equal(H.downsamplePoints(few, 0, 10, 100), few);
    const many = Array.from({ length: 20000 }, (_, i) => pt(i * 1000, 100 + (i % 37), 10 + (i % 11)));
    for (const max of [100, 1500, 4000]) {
        const out = H.downsamplePoints(many, 0, 20000 * 1000, max);
        assert.ok(out.length <= max, `${out.length} <= ${max}`);
        assert.ok(out.length > max / 2, `uses the budget: ${out.length} of ${max}`);
        for (let i = 1; i < out.length; i++) assert.ok(out[i].t > out[i - 1].t, 'time-ordered, no duplicates');
    }
});

test('downsample keeps each series extreme (a lone slow request survives)', () => {
    const many = Array.from({ length: 5000 }, (_, i) => pt(i, 500, 40));
    many[1234] = pt(1234, 500, 3);          // one slow gen
    many[4321] = pt(4321, 9000, 40);        // one fast prefill
    const out = H.downsamplePoints(many, 0, 5000, 200);
    assert.ok(out.some((p) => p.t === 1234 && p.genTps === 3));
    assert.ok(out.some((p) => p.t === 4321 && p.promptTps === 9000));
    assert.ok(out.every((p) => many.includes(p)), 'only real points, never synthesized');
});

test('downsample refines buckets for bursty data instead of wasting the budget', () => {
    // 10 bursts of 1000 requests each, one per day: a fixed max/4 grid leaves most buckets empty
    const pts = [];
    for (let d = 0; d < 10; d++) for (let i = 0; i < 1000; i++) pts.push(pt(d * 86400000 + i * 1000, 100 + (i % 50), 10 + (i % 7)));
    const out = H.downsamplePoints(pts, 0, 10 * 86400000, 1500);
    assert.ok(out.length <= 1500 && out.length > 750, `got ${out.length}`);
});

test('downsample keeps a point from a bucket with no rates at all', () => {
    const pts = Array.from({ length: 50 }, (_, i) => H.chartPoint(i, null, null, null, null, null));
    const out = H.downsamplePoints(pts, 0, 50, 8);
    assert.ok(out.length >= 1 && out.length <= 8);
});

test('defaultWindow: 24 h to the newest request, widened when sparse', () => {
    const D = H.DAY_MS, last = 100 * D;
    const dense = Array.from({ length: 400 }, (_, i) => last - i * 60000);       // newest first, all within 7 h
    assert.deepEqual(H.defaultWindow({ first: 0, last }, dense, 300), { from: last - D, to: last });
    const sparse = Array.from({ length: 400 }, (_, i) => last - i * 3600000);    // one an hour
    const w = H.defaultWindow({ first: 0, last }, sparse, 300);
    assert.equal(w.from, sparse[299]);
    assert.equal(H.defaultWindow(null, [], 300), null);
    // a log shorter than a day opens on all of it
    assert.deepEqual(H.defaultWindow({ first: last - 1000, last }, [last, last - 1000], 300), { from: last - 1000, to: last });
});

test('buildRangeResponse merges, counts the visible window and indexes models', () => {
    const csv = [pt(10, 1, 1, 'a.gguf'), pt(30, 1, 1, 'b.gguf')];
    const db = [pt(20, 2, 2, 'a.gguf'), pt(40, 2, 2, null)];
    const r = H.buildRangeResponse({ csvPoints: csv, dbPoints: db, from: 0, to: 50, max: 1500, extent: { first: 10, last: 40 },
        defaultWin: null, view: { from: 15, to: 35 } });
    assert.equal(r.total, 4);
    assert.equal(r.totalInView, 2);
    assert.equal(r.downsampled, false);
    assert.deepEqual(r.models, ['a.gguf', 'b.gguf']);
    assert.deepEqual(r.points.map((p) => [p.t, p.m]), [[10, 0], [20, 0], [30, 1], [40, null]]);
    assert.deepEqual(Object.keys(r.points[0]).sort(), ['g', 'gt', 'm', 'p', 'pt', 't']);
});

// ---- CSV index: parse once, then only appended bytes ----
function tmpCsv() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'histcsv-'));
    return { dir, file: path.join(dir, 'benchmarks.csv') };
}
const csvLine = (iso, model, p, g) => {
    const cols = new Array(43).fill('');
    cols[0] = iso; cols[1] = 'r'; cols[2] = model; cols[8] = '"a,b"'; cols[10] = String(p); cols[11] = String(g); cols[13] = '100'; cols[28] = '20';
    return cols.join(',');
};
const naiveSplit = (line) => {   // enough CSV for these fixtures: a quoted field with a comma
    const out = []; let f = '', q = false;
    for (const c of line) { if (c === '"') q = !q; else if (c === ',' && !q) { out.push(f); f = ''; } else f += c; }
    out.push(f); return out;
};
const num = (s) => (s === '' || s == null || !Number.isFinite(Number(s)) ? null : Number(s));
function makeIndex(file, counter) {
    return H.createCsvPointIndex(file, {
        io: {
            statSize: (f) => { try { return fs.statSync(f).size; } catch { return null; } },
            readRange: (f, s, e) => { counter.bytes += e - s; const fd = fs.openSync(f, 'r'); try { const b = Buffer.alloc(e - s); fs.readSync(fd, b, 0, b.length, s); return b; } finally { fs.closeSync(fd); } },
        },
        split: naiveSplit, num,
    });
}

test('CSV index parses once, then reads only appended bytes; partial lines wait', () => {
    const { dir, file } = tmpCsv();
    try {
        const filler = Array.from({ length: 40 }, (_, i) => csvLine(`2026-08-01T00:00:${String(i).padStart(2, '0')}.000Z`, 'f', 1, 1)).join('\n');
        fs.writeFileSync(file, 'Timestamp,run_id,model_name\n' + filler + '\n' + csvLine('2026-09-01T00:00:00.000Z', 'a', 100, 10) + '\n' + 'short,row\n');
        const c = { bytes: 0 };
        const idx = makeIndex(file, c);
        assert.equal(idx.refresh().length, 41);                // header + <32-col row skipped
        assert.equal(idx.points[40].promptTps, 100);
        assert.equal(idx.points[40].genTokens, 20);
        const size1 = fs.statSync(file).size;
        c.bytes = 0; idx.refresh();
        assert.ok(c.bytes <= 64, 'unchanged file: only the tail signature is re-read');
        const l2 = csvLine('2026-09-02T00:00:00.000Z', 'b', 200, 20);
        fs.appendFileSync(file, l2.slice(0, 30));              // half a line: not consumed yet
        assert.equal(idx.refresh().length, 41);
        fs.appendFileSync(file, l2.slice(30) + '\n');
        c.bytes = 0;
        assert.equal(idx.refresh().length, 42);
        assert.ok(c.bytes < size1, `incremental read (${c.bytes} bytes), not the whole file`);
        assert.equal(idx.points[41].model, 'b');
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CSV index reparses when the file shrinks or the header is rewritten in place', () => {
    const { dir, file } = tmpCsv();
    try {
        const rows = [1, 2, 3].map((d) => csvLine(`2026-09-0${d}T00:00:00.000Z`, `m${d}`, d, d)).join('\n') + '\n';
        fs.writeFileSync(file, 'Timestamp,a\n' + rows);
        const idx = makeIndex(file, { bytes: 0 });
        assert.equal(idx.refresh().length, 3);
        // migrateCsvHeader-style rewrite: longer header, same rows -> every offset shifts
        fs.writeFileSync(file, 'Timestamp,a,b,c,d,e,f,g\n' + rows);
        assert.deepEqual(idx.refresh().map((p) => p.model), ['m1', 'm2', 'm3']);
        fs.writeFileSync(file, 'Timestamp,a\n' + csvLine('2026-09-05T00:00:00.000Z', 'x', 1, 1) + '\n');
        assert.deepEqual(idx.refresh().map((p) => p.model), ['x']);
        fs.rmSync(file);
        assert.deepEqual(idx.refresh(), []);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('CSV index stays sorted if a row arrives out of order', () => {
    const { dir, file } = tmpCsv();
    try {
        fs.writeFileSync(file, 'Timestamp\n' + csvLine('2026-09-03T00:00:00.000Z', 'c', 1, 1) + '\n');
        const idx = makeIndex(file, { bytes: 0 });
        idx.refresh();
        fs.appendFileSync(file, csvLine('2026-09-01T00:00:00.000Z', 'a', 1, 1) + '\n');
        assert.deepEqual(idx.refresh().map((p) => p.model), ['a', 'c']);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

// ---- client window math ----
const EXT = { first: 0, last: 10 * 86400000 };

test('zoomWindow keeps the pointer time fixed and never inverts or collapses', () => {
    const w = { from: 1e8, to: 2e8 };
    const z = W.zoomWindow(w, 1.5e8, 0.5, EXT);
    assert.deepEqual(z, { from: 1.25e8, to: 1.75e8 });
    let tiny = w;
    for (let i = 0; i < 200; i++) tiny = W.zoomWindow(tiny, 1.5e8, 0.5, EXT);
    assert.ok(tiny.to - tiny.from >= W.MIN_SPAN - 1e-6 && tiny.to > tiny.from);
});

test('zooming out stops at the data extent (plus slack)', () => {
    let w = { from: 4e8, to: 5e8 };
    for (let i = 0; i < 100; i++) w = W.zoomWindow(w, 4.5e8, 2, EXT);
    const span = EXT.last - EXT.first;
    assert.ok(w.from >= EXT.first - span * W.SLACK_FRAC - 1 && w.to <= EXT.last + span * W.SLACK_FRAC + 1);
});

test('panWindow keeps the span and stops at the ends', () => {
    const w = { from: 1e8, to: 2e8 };
    const p = W.panWindow(w, 5e7, EXT);
    assert.deepEqual(p, { from: 1.5e8, to: 2.5e8 });
    const far = W.panWindow(w, 1e12, EXT);
    assert.equal(far.to - far.from, 1e8);
    assert.ok(far.to <= EXT.last + 1e8 * W.SLACK_FRAC + 1);
    const back = W.panWindow(w, -1e12, EXT);
    assert.ok(back.from >= EXT.first - 1e8 * W.SLACK_FRAC - 1);
});

test('loadedServes: covered and not too coarse', () => {
    const win = { from: 100, to: 200 };
    assert.equal(W.loadedServes(null, win), false);
    assert.equal(W.loadedServes({ from: 50, to: 250, downsampled: true }, win), true);
    assert.equal(W.loadedServes({ from: 120, to: 250, downsampled: false }, win), false);
    assert.equal(W.loadedServes({ from: 0, to: 1000, downsampled: false }, win), true);   // everything loaded: zoom freely
    assert.equal(W.loadedServes({ from: 0, to: 1000, downsampled: true }, win), false);   // zoomed into a downsampled range: refetch
    const r = W.fetchRange(win);
    assert.deepEqual(r, { from: 85, to: 215 });
});

test('formatTick picks a resolution for the span', () => {
    const t = new Date(2026, 8, 30, 7, 5, 9).getTime();
    assert.equal(W.formatTick(t, 5 * 60000), '07:05:09');
    assert.equal(W.formatTick(t, 3600000), '07:05');
    assert.equal(W.formatTick(t, 3 * 86400000), '9/30 07:05');
    assert.equal(W.formatTick(t, 60 * 86400000), '9/30');
});

// ---- round 2 (2026-10-01, Kyle): lines with gap breaks, scrollbar, table -> chart link ----

test('downsampleWithGrid reports the bucket width it used (null when not downsampled)', () => {
    const few = [pt(1), pt(2)];
    assert.equal(H.downsampleWithGrid(few, 0, 10, 100).bucketMs, null);
    const many = Array.from({ length: 10000 }, (_, i) => pt(i * 1000, 100 + (i % 37), 10 + (i % 11)));
    const r = H.downsampleWithGrid(many, 0, 10000 * 1000, 1000);
    assert.ok(r.points.length <= 1000);
    assert.ok(r.bucketMs > 0 && r.bucketMs <= 10000 * 1000 / 250);
    const resp = H.buildRangeResponse({ csvPoints: many, dbPoints: [], from: 0, to: 10000 * 1000, max: 1000, extent: null, defaultWin: null });
    assert.equal(resp.bucketMs, r.bucketMs);
});

test('gapThreshold: 10 min floor, follows steady slow runs, and downsampled buckets', () => {
    assert.equal(W.gapThreshold([], null), W.GAP_FLOOR_MS);
    const burst = Array.from({ length: 50 }, (_, i) => i * 5000);                 // 5 s apart
    assert.equal(W.gapThreshold(burst, null), W.GAP_FLOOR_MS);
    const slow = Array.from({ length: 20 }, (_, i) => i * 12 * 60000);            // one every 12 min
    assert.equal(W.gapThreshold(slow, null), 4 * 12 * 60000);
    assert.equal(W.gapThreshold(burst, 3600000), 2.5 * 3600000);
});

test('thumbGeometry: proportional thumb, min width, maps over the usable track', () => {
    const ext = { first: 0, last: 1000 };
    assert.deepEqual(W.thumbGeometry({ from: 0, to: 500 }, ext, 200), { left: 0, width: 100, usable: 100 });
    assert.deepEqual(W.thumbGeometry({ from: 500, to: 1000 }, ext, 200), { left: 100, width: 100, usable: 100 });
    const tiny = W.thumbGeometry({ from: 999, to: 1000 }, ext, 200);
    assert.equal(tiny.width, 24);
    assert.equal(tiny.left + tiny.width, 200, 'min-width thumb at the newest data ends flush with the track');
    assert.equal(W.thumbGeometry(null, ext, 200), null);
    assert.equal(W.thumbGeometry({ from: 0, to: 1 }, null, 200), null);
});

test('thumb drag and track click move the window by the matching time', () => {
    const ext = { first: 0, last: 100 * 60000 };                                  // 100 min of data
    const win = { from: 0, to: 20 * 60000 };                                      // 20 min window
    // track 200 px: thumb 40 px, usable 160 px for 80 min of room -> 1 px = 30 s
    const d = W.thumbDragWindow(win, ext, 200, 16);
    assert.deepEqual(d, { from: 8 * 60000, to: 28 * 60000 });
    const j = W.trackJumpWindow(win, ext, 200, 100);                              // thumb centred at 100 px -> left 80 px -> half the room
    assert.deepEqual(j, { from: 40 * 60000, to: 60 * 60000 });
    const end = W.trackJumpWindow(win, ext, 200, 199);
    assert.equal(end.from, 80 * 60000);
});

test('windowForRun: leaves a visible run alone, keeps the span for short runs, fits long ones', () => {
    const ext = { first: 0, last: 1e9 };
    const win = { from: 1e8, to: 2e8 };
    assert.equal(W.windowForRun(win, { from: 1.2e8, to: 1.3e8 }, ext), win);
    const shortRun = W.windowForRun(win, { from: 5e8, to: 5e8 + 60000 }, ext);
    assert.ok(Math.abs((shortRun.to - shortRun.from) - 1e8) < 1, 'span kept');
    assert.ok(shortRun.from < 5e8 && shortRun.to > 5e8 + 60000, 'run inside');
    const longRun = W.windowForRun(win, { from: 3e8, to: 6e8 }, ext);
    assert.deepEqual(longRun, { from: 2.7e8, to: 6.3e8 });
});

test('wheelIntent: vertical zooms, horizontal or shift pans', () => {
    assert.deepEqual(W.wheelIntent({ deltaX: 0, deltaY: 100 }), { kind: 'zoom', px: 100 });
    assert.deepEqual(W.wheelIntent({ deltaX: 40, deltaY: 3 }), { kind: 'pan', px: 40 });
    assert.deepEqual(W.wheelIntent({ deltaX: 0, deltaY: 100, shiftKey: true }), { kind: 'pan', px: 100 });
    assert.deepEqual(W.wheelIntent({ deltaX: 3, deltaY: 0, deltaMode: 1 }), { kind: 'pan', px: 48 });
});
