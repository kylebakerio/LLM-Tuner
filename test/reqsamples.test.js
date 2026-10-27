'use strict';
// lib/reqsamples.js: every queue lane's request gets a telemetry series (Kyle, 2026-10-22: Monitor said "no telemetry
// samples for this request", always), keyed to the run id its Monitor row carries, kept in bench.sqlite within a bound.
// Lane records shaped like server4.js lanesLive().lanes (lib/lanetps.js laneRates) on the local-gpu Strata lane that day.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const rs = require('../lib/reqsamples');

const T0 = 1792668560000;
const SCHEMA = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
const memDb = () => { const d = new Database(':memory:'); d.exec(SCHEMA); return d; };
const ctx = { itemId: 1271, label: 'ladder2xtx-b-strata022-fn-gsqrco-iq3xxs-128k-int8-2xtx-l3-20261022', engine: 'Strata' };
const req = (id, extra = {}) => ({ type: 'request', id, thread: 1, prefix: 0, delta: [], t: T0 / 1000, ...extra });
const end = (id, timings, extra = {}) => ({ type: 'end', id, finish: 'stop', usage: null, timings, status: 200, error: null, ...extra });
// Strata's timings on the tap's `end` (llama.cpp style), from the 94k-context agent turns on 2026-10-22
const TM = { cache_n: 93581, prompt_n: 664, prompt_ms: 1135.1, prompt_per_second: 585.0, predicted_n: 89, predicted_ms: 776.6, predicted_per_second: 114.6 };
const lane = (o) => ({ lane: 'local-gpu', engine: 'Strata', gen: 0, prefill: 0, genSrc: null, prefillSrc: null, ...o });
const dev = () => [{ id: 'xtx-1', label: 'RX 7900 XTX #1', host: 'local', util: 99, pwr: 330, temp: 71, vram: 23.1, thermal: false }];

test('a lane request: ticks of its lane, keyed rec:<item label>:<tap id>, the engine\'s timings placing read and answer', () => {
    const r = rs.createRecorder();
    r.begin('local-gpu', req(532), { ...ctx, devices: dev() }, T0);
    // another lane's records never reach this series
    r.tick([lane({ phase: 'prefill', prefill: 610, prefillSrc: 'metrics', progress: 0.4, read: 265, total: 664, ctx: 93846, ctxMax: 131072 }),
        { lane: 'local-rocm1', phase: 'gen', gen: 30, genSrc: 'slots' }], () => dev(), T0 + 600);
    r.tick([lane({ phase: 'gen', gen: 121.3, genSrc: 'metrics', generated: 40, ctx: 94285, ctxMax: 131072 })], () => dev(), T0 + 1600);
    assert.equal(r.openCount(), 1);
    const rec = r.end('local-gpu', end(532, TM), ctx, T0 + 2000);
    assert.equal(r.openCount(), 0);
    assert.equal(rec.runId, `rec:${ctx.label}:532`, 'the id the proxy-recording import gives the same request');
    assert.deepEqual([rec.lane, rec.itemId, rec.live, rec.reason, rec.note], ['local-gpu', 1271, true, null, null]);
    const S = rec.samples;
    assert.ok(S.every((s, i) => i === 0 || s.t >= S[i - 1].t), 'in time order');
    // the live tick in the read keeps its own rate; the exact average is the dashed line beside it
    const read = S.find((s) => s.t === T0 + 600);
    assert.deepEqual([read.prefillTps, read.prefillTpsAvg, read.prefillProgress, read.prefillPos, read.ctx, read.src], [610, 585, 0.4, 265, 93846, 'engine']);
    assert.equal(read.genTps, undefined);
    const gen = S.find((s) => s.t === T0 + 1600);
    assert.deepEqual([gen.genTps, gen.genTokens, gen.prefillTps, gen.devices[0].label], [121.3, 40, undefined, 'RX 7900 XTX #1']);
    // anchors from the timings: read 1135 ms then answer 777 ms, ending at the end frame
    const anchors = S.filter((s) => s.src === 'timings');
    const tGen = T0 + 2000 - 776.6, tStart = tGen - 1135.1;
    assert.deepEqual(anchors.map((a) => a.t), [Math.round(tStart), Math.round(tGen) - 1, Math.round(tGen), T0 + 2000]);
    assert.deepEqual(anchors.map((a) => a.ctx), [93581, 94245, 94245, 94334], 'cached + read + generated');
    assert.deepEqual([anchors[0].prefillTps, anchors[1].prefillProgress, anchors[3].genTps, anchors[3].genTokens, anchors[3].ctxMax], [585, 1, 114.6, 89, 131072]);
});

test('a request shorter than one tick still has a series: its start and the engine\'s timings, with a note', () => {
    const r = rs.createRecorder();
    r.begin('local-gpu', req(9), ctx, T0);
    const rec = r.end('local-gpu', end(9, { cache_n: 94450, prompt_n: 35, prompt_ms: 240.6, prompt_per_second: 145.5, predicted_n: 86, predicted_ms: 617.5, predicted_per_second: 139.3 }), ctx, T0 + 900);
    assert.ok(rec.samples.length >= 4);
    assert.equal(rec.reason, null);
    assert.match(rec.note, /shorter than one sample tick/);
    assert.ok(rec.samples.some((s) => s.genTps === 139.3) && rec.samples.some((s) => s.prefillTps === 145.5));
});

test('no timings and no ticks: a reason that names the lane, not an empty chart', () => {
    const r = rs.createRecorder();
    const rec = r.end('laptop-3060', end(4, null, { status: 500, error: 'context overflow' }), { label: 'x', engine: 'llama' }, T0);
    assert.ok(rec.samples.length < 2);
    assert.match(rec.reason, /failed \(500 context overflow\).*lane laptop-3060 \(llama\)/);
    const quiet = rs.createRecorder().end('local-rocm1', end(5, null), { label: 'y' }, T0);
    assert.match(quiet.reason, /lane local-rocm1 reported no timings/);
});

test('the tap\'s catch-up on (re)connect: a replayed request is a partial series, timed by the proxy\'s stamp', () => {
    const r = rs.createRecorder();
    r.begin('local-gpu', req(77, { replay: true, t: (T0 - 30000) / 1000 }), ctx, T0);
    const rec = r.end('local-gpu', end(77, TM, { t: (T0 - 20000) / 1000 }), ctx, T0 + 5);
    assert.equal(rec.live, false);
    assert.equal(rec.completedAt, T0 - 20000, 'when it ended, not when the replay arrived');
    assert.match(rec.note, /not connected to lane local-gpu \(Strata\)/);
    // connected mid-request: the live ticks that follow are kept, and the note says where they start
    r.begin('local-gpu', req(78, { replay: true }), ctx, T0);
    r.tick([lane({ phase: 'gen', gen: 50, genSrc: 'metrics' })], null, T0 + 1000);
    const mid = r.end('local-gpu', end(78, TM), ctx, T0 + 1500);
    assert.match(mid.note, /mid-request/);
});

test('a long request is thinned, never cut: the first and the latest samples stay', () => {
    const r = rs.createRecorder({ maxSamples: 10 });
    r.begin('local-gpu', req(1), ctx, T0);
    for (let i = 1; i <= 40; i++) r.tick([lane({ phase: 'prefill', prefill: 500 + i, prefillSrc: 'metrics' })], null, T0 + i * 1000);
    const rec = r.end('local-gpu', end(1, null), ctx, T0 + 41000);
    assert.ok(rec.samples.length <= 11, `${rec.samples.length} samples`);
    assert.equal(rec.samples[0].t, T0);
    assert.ok(rec.samples[rec.samples.length - 1].t >= T0 + 36000);
});

test('store: kept across a restart (a new store on the same database), nulls dropped, deflated', () => {
    const d = memDb();
    const a = rs.createStore({ db: () => d, now: () => T0 });
    const r = rs.createRecorder();
    r.begin('local-gpu', req(532), ctx, T0 - 3000);
    const rec = r.end('local-gpu', end(532, TM), ctx, T0);
    a.put(rec);
    assert.equal(a.get(rec.runId).samples.length, rec.samples.length, 'readable before the flush');
    assert.deepEqual(a.flush(), { written: 1, pruned: 0 });
    const b = rs.createStore({ db: () => d, now: () => T0 + 60000 });   // the dashboard restarted
    const got = b.get(rec.runId);
    assert.equal(got.samples.length, rec.samples.length);
    assert.equal(got.lane, 'local-gpu');
    assert.ok(got.samples.every((s) => Object.values(s).every((v) => v !== null)), 'no nulls stored');
    const row = d.prepare('SELECT n, source, item_id, length(samples_z) AS z FROM request_samples WHERE run_id = ?').get(rec.runId);
    assert.deepEqual([row.n, row.source, row.item_id], [rec.samples.length, 'lane', 1271]);
    assert.ok(row.z < JSON.stringify(rec.samples).length / 2, `deflated: ${row.z} bytes`);
    assert.equal(b.bounds().since, T0, 'since = the first time the store ran, kept in meta');
    assert.equal(b.get('rec:nope:1'), null);
});

test('store: identity tells the tap\'s replay of a kept request from a re-run label\'s restarted seq', () => {
    const d = memDb();
    const st = rs.createStore({ db: () => d, now: () => T0 });
    st.put({ runId: 'rec:L:5', lane: 'local-gpu', itemId: 1271, tStart: 1792668560.5, completedAt: T0, samples: [{ t: 1 }, { t: 2 }] });
    assert.equal(st.identity('rec:L:5', 1792668560.5, 1271), 'same');   // pending
    st.flush();
    assert.equal(st.identity('rec:L:5', 1792668560.5, 1271), 'same');
    assert.equal(st.identity('rec:L:5', null, 1271), 'same', 'a replay whose request frame was missed');
    assert.equal(st.identity('rec:L:5', 1792669999.0, 1271), 'other');
    assert.equal(st.identity('rec:L:5', 1792668560.5, 1300), 'other');
    assert.equal(st.identity('rec:L:6', 1, 1), null);
});

test('store: the bound -- the newest keepRows requests, none older than keepMs', () => {
    const d = memDb();
    let now = T0;
    const st = rs.createStore({ db: () => d, keepRows: 50, keepMs: 3600000, now: () => now });
    for (let i = 0; i < 80; i++) st.put({ runId: `rec:L:${i}`, completedAt: T0 + i * 1000, samples: [{ t: i }, { t: i + 1 }] });
    const f = st.flush();
    assert.deepEqual([f.written, f.pruned], [80, 30]);
    assert.equal(d.prepare('SELECT count(*) AS n FROM request_samples').get().n, 50);
    assert.equal(st.get('rec:L:29'), null);
    assert.ok(st.get('rec:L:30'));
    assert.equal(st.bounds().oldest, T0 + 30000);
    // an hour on: everything older than keepMs goes with the next flush
    now = T0 + 3600000 + 100000;   // the newest kept one (T0 + 79 s) is now over an hour old
    st.put({ runId: 'rec:L:new', completedAt: now, samples: [{ t: 1 }, { t: 2 }] });
    st.flush();
    assert.deepEqual(d.prepare('SELECT run_id FROM request_samples').all().map((x) => x.run_id), ['rec:L:new']);
    // a broken database never throws into request handling
    let warned = 0;
    const bad = rs.createStore({ db: () => { throw new Error('locked'); }, warn: () => warned++ });
    bad.put({ runId: 'x', samples: [{ t: 1 }, { t: 2 }] });
    assert.deepEqual(bad.flush(), { written: 0, pruned: 0 });
    assert.ok(bad.get('x'), 'still readable from the queue');
    assert.equal(bad.identity('y', 1, 1), null);
    assert.equal(warned, 1, 'warned once');
    const gone = rs.createStore({ db: () => null });
    gone.put({ runId: 'x', samples: [] });
    assert.deepEqual(gone.flush(), { written: 0, pruned: 0 });
    assert.equal(gone.get('nope'), null);
});

test('missingReason: why a row has no samples, by its run id and time', () => {
    const b = { since: T0, oldest: T0 + 86400000, keepRows: 50000, keepMs: 14 * 86400000 };
    assert.match(rs.missingReason('', null, b), /no run id/);
    assert.match(rs.missingReason('log:queue/x:123', null, b), /imported from a llama-server log/);
    // LL-Dash's own run ids carry their time
    const before = `${(T0 - 3600000).toString(36)}_ab12`;
    assert.equal(rs.runIdTime(before), T0 - 3600000);
    assert.match(rs.missingReason(before, null, b), /recorded before per-request telemetry was kept/);
    assert.match(rs.missingReason(`${(T0 + 3600000).toString(36)}_ab12`, null, b), /older than the telemetry kept \(the last 50,000 requests or 14 days\)/);
    assert.match(rs.missingReason(`${(T0 + 2 * 86400000).toString(36)}_ab12`, null, b), /finished within one telemetry tick/);
    // a lane's: by the row's time when the browser sends it
    assert.match(rs.missingReason('rec:L:1', T0 - 1, b), /before per-request telemetry was kept/);
    assert.match(rs.missingReason('rec:L:1', null, b), /predates/);
});

// ---- the wiring (server4.js, script.js, ui/benchmarks/live.js) ----
const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
test('server: both tap relays feed the series; the telemetry tick samples them; LANE_COMPLETION carries the run id', () => {
    const server = read('server4.js');
    assert.match(server, /onEvent: \(ev\) => onLaneTapEvent\(lane, port, ev\)/);
    assert.match(server, /onEvent: \(ev\) => onLaneTapEvent\(defaultTapLane\(\), defaultTapPort\(\), ev\)/);
    assert.match(server, /laneRequests\.tick\(lanesLiveFull, \(lane\) => laneDeviceReadings\(lane, stats\), Date\.now\(\)\)/);
    assert.match(server, /const rec = laneRequests\.end\(lane, ev, laneRequestCtx\(lane\), Date\.now\(\)\);/);
    assert.match(server, /LANE_COMPLETION:\$\{JSON\.stringify\(\{\s*runId: rec \? rec\.runId : null,/);
    assert.match(server, /if \(kept === 'same' && !rec\.live\) return;/, 'the tap\'s replay of a kept request is not a second row');
    // LL-Dash's own requests are kept too, and the read path is the ring, then the store, then a reason
    assert.match(server, /requestSamplesStore\.put\(\{ runId, source: 'lldash'/);
    assert.match(server, /reqSamples\.missingReason\(runId, Number\(queryParams\.get\('at'\)\) \|\| null, requestSamplesStore\.bounds\(\)\)/);
    assert.match(server, /try \{ requestSamplesStore\.flush\(\); \} catch \{ \}/, 'flushed on shutdown');
    // an engine sample is as old as its poll's send, so an answer that crossed a tap edge cannot overrule it
    assert.match(server, /laneTps\.parseStrataLive\(j, sentAt\)/);
    assert.match(server, /setLaneSample\(t\.lane, laneTps\.slotsSample\(out, sentAt\)\)/);
    // no new poller: the series read the lane records lanesLive() already builds
    assert.ok(!/setInterval\([^\n]*laneRequests/.test(server));
});

test('browser: a lane row keeps its run id and detail; the modal shows the reason and the row\'s details', () => {
    const script = read('script.js');
    assert.match(script, /server: p\.server \|\| p\.lane \|\| null, runId: p\.runId \|\| null,/);
    assert.match(script, /detail: p\.detail \|\| null,/);
    assert.match(script, /`No telemetry samples for this request\$\{reason \? ` — \$\{reason\}` : ''\}`/);
    assert.match(script, /renderExpandDetails\(row \|\| \{\}\);   \/\/ the row's details still show/);
    assert.match(script, /if \(d\.lane\) return renderLaneExpandDetails\(det, row\);/);
    assert.match(script, /label: 'Context \(% of n_ctx\)'/);
});
