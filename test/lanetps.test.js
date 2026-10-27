'use strict';
// lib/lanetps.js: per-lane live t/s from a record-proxy tap, and the multi-lane sum the sidebar shows
// while 2+ local GPU lanes run (Kyle, 2026-10-01). Synthetic frames shaped like the live taps'
// (captured 2026-10-01 from 18090 / Strata and 18091 / llama-server), with time passed in.
const test = require('node:test');
const assert = require('node:assert/strict');
const lt = require('../lib/lanetps');

const T0 = 1790843000000;   // ms
const req = (id, tMs, extra = {}) => ({ type: 'request', id, thread: 1, prefix: 0, delta: [], t: tMs / 1000, ...extra });
const end = (id, tMs, timings, extra = {}) => ({ type: 'end', id, finish: 'tool_calls', usage: null, timings, status: 200, error: null, t: tMs / 1000, ...extra });
const tm = (o) => ({ prompt_n: 1249, prompt_per_second: 367.5, predicted_n: 100, predicted_per_second: 25.1, ...o });
// `n` frames of `chars` each, `everyMs` apart from `startMs` (the proxy coalesces to 50 ms frames).
function stream(m, id, startMs, n, chars, everyMs = 50) {
    for (let i = 0; i < n; i++) m.feed({ type: 'delta', id, reasoning: 'x'.repeat(chars) }, startMs + i * everyMs);
    return startMs + (n - 1) * everyMs;
}

test('deltaChars counts reasoning, content and tool-call name/arguments', () => {
    assert.equal(lt.deltaChars({ reasoning: 'abc', content: 'de' }), 5);
    assert.equal(lt.deltaChars({ tool_calls: [{ index: 0, name: 'bash', arguments: '{"c":1}' }, null] }), 11);
    assert.equal(lt.deltaChars({}), 0);
});

test('calibrated chars/token turns the streamed text into the lane\'s gen rate', () => {
    const m = lt.createLaneMeter();
    // Response 1: 3000 chars over 1000 tokens -> 3.0 chars/token.
    m.feed(req(1, T0), T0);
    stream(m, 1, T0 + 500, 30, 100);
    m.feed(end(1, T0 + 2000, tm({ predicted_n: 1000 })), T0 + 2000);
    assert.equal(m.rates(T0 + 2000).cpt, 3);
    // Response 2 streams 30 chars per 50 ms frame = 600 chars/s = 200 tok/s at 3.0 chars/token.
    m.feed(req(2, T0 + 10000), T0 + 10000);
    const last = stream(m, 2, T0 + 11000, 41, 30);   // 2 s of frames
    const r = m.rates(last + 10);
    assert.equal(r.genSrc, 'stream');
    assert.equal(r.phase, 'gen');
    assert.ok(Math.abs(r.gen - 200) < 1, `gen ${r.gen}`);
});

test('uncalibrated: the last request\'s exact predicted_per_second, then the default ratio', () => {
    const a = lt.createLaneMeter();
    a.feed(end(9, T0 - 60000, tm({ predicted_per_second: 54.8, predicted_n: 10 })), T0);   // too few tokens to calibrate
    a.feed(req(10, T0), T0);
    const last = stream(a, 10, T0 + 100, 21, 32);
    assert.equal(a.rates(last).genSrc, 'last');
    assert.equal(a.rates(last).gen, 54.8);
    const b = lt.createLaneMeter();
    b.feed(req(1, T0), T0);
    const lb = stream(b, 1, T0 + 100, 21, 32);   // 640 chars/s
    const rb = b.rates(lb);
    assert.equal(rb.genSrc, 'stream~');
    assert.ok(Math.abs(rb.gen - 640 / lt.DEFAULT_CPT) < 1);
});

test('the rate window only spans the current response (not the previous one + this prefill)', () => {
    const m = lt.createLaneMeter();
    m.feed(req(1, T0), T0);
    stream(m, 1, T0, 10, 100);
    m.feed(end(1, T0 + 500, tm({ predicted_n: 300 })), T0 + 500);   // 1000 chars / 300 tok
    m.feed(req(2, T0 + 600), T0 + 600);
    // 2 s prefill, then 1 s of frames: rate must be this response's, ignoring the gap.
    const last = stream(m, 2, T0 + 2600, 21, 50);   // 1000 chars/s
    const r = m.rates(last);
    assert.ok(Math.abs(r.gen - 1000 / (1000 / 300)) < 1, `gen ${r.gen}`);
});

test('a lane that stopped streaming contributes 0 gen after GEN_IDLE_MS; prefill 0 after ACTIVE_IDLE_MS', () => {
    // frames stop with no end yet (the connection stalls): gen holds for GEN_IDLE_MS, then 0
    const s = lt.createLaneMeter();
    s.feed(req(1, T0), T0);
    const ls = stream(s, 1, T0 + 1000, 21, 30);
    assert.ok(s.rates(ls + 100).gen > 0);
    assert.equal(s.rates(ls + lt.GEN_IDLE_MS + 1).gen, 0);
    // an end stops generation at once (2026-10-22: it lingered GEN_IDLE_MS, and so did the 'generating' strip)
    const m = lt.createLaneMeter();
    m.feed(req(1, T0), T0);
    const last = stream(m, 1, T0 + 1000, 21, 30);
    m.feed(end(1, last + 20, tm({ prompt_per_second: 1098.2, prompt_n: 4733 })), last + 20);
    assert.deepEqual([m.rates(last + 100).gen, m.rates(last + 100).phase], [0, 'busy']);
    assert.equal(m.rates(last + 100).prefill, 1098.2);
    assert.equal(m.rates(last + lt.GEN_IDLE_MS + 1).phase, 'busy');
    const idle = m.rates(last + 20 + lt.ACTIVE_IDLE_MS + 1);
    assert.deepEqual([idle.gen, idle.prefill, idle.phase, idle.active], [0, 0, 'idle', false]);
});

test('prefill: shown while a request is in flight (even a long silent prefill), floor prompt_n >= 32', () => {
    const m = lt.createLaneMeter();
    m.feed(req(1, T0), T0);
    stream(m, 1, T0 + 100, 5, 30);
    m.feed(end(1, T0 + 400, tm({ prompt_n: 19, prompt_per_second: 43.8 })), T0 + 400);
    assert.equal(m.rates(T0 + 500).prefill, 0, 'a 19-token cached re-prompt is not a prefill rate');
    m.feed(end(1, T0 + 400, tm({ prompt_n: 836, prompt_per_second: 496.8 })), T0 + 400);
    m.feed(req(2, T0 + 1000), T0 + 1000);
    const r = m.rates(T0 + 60000);   // 59 s into prefill, no frames
    assert.equal(r.phase, 'prefill');
    assert.equal(r.prefill, 496.8);
    assert.equal(r.gen, 0);
});

test('tap replay on connect: replayed deltas calibrate but never count as live; old end does not wake the lane', () => {
    const m = lt.createLaneMeter();
    const now = T0;
    // What record-proxy replays to a new subscriber: request+delta flagged replay, the end NOT flagged.
    m.feed(req(17, now - 120000, { replay: true }), now);
    m.feed({ type: 'delta', id: 17, replay: true, reasoning: 'y'.repeat(4546) }, now);
    m.feed(end(17, now - 50000, tm({ predicted_n: 1668, prompt_per_second: 367.5 })), now);
    const r = m.rates(now + 10);
    assert.equal(r.cpt, 2.73);
    assert.equal(r.gen, 0);
    assert.equal(r.active, false, 'an end 50 s old must not make the lane look busy');
    assert.equal(r.prefill, 0);
    // A response already streaming when we dialled: its replayed text is partial -> no calibration from it.
    const p = lt.createLaneMeter();
    p.feed({ type: 'delta', id: 18, reasoning: 'z'.repeat(132) }, now);
    p.feed(end(18, now + 100, tm({ predicted_n: 6003 })), now + 100);
    assert.equal(p.rates(now + 200).cpt, null);
});

test('reset() drops a lane\'s state (new queue item = different model)', () => {
    const m = lt.createLaneMeter();
    m.feed(req(1, T0), T0);
    m.feed(end(1, T0 + 10, tm()), T0 + 10);
    m.reset();
    const r = m.rates(T0 + 20);
    assert.deepEqual([r.prefill, r.lastPromptTps, r.cpt, r.phase], [0, null, null, 'idle']);
});

test('combine: sums, per-lane breakdown text, combined only with 2+ lanes', () => {
    const two = lt.combine([
        { lane: 'local-gpu', label: 'XTX Strata', gen: 51.24, prefill: 1098.2 },
        { lane: 'local-3060', label: '3060 llama', gen: 24.04, prefill: 367.5 },
    ]);
    assert.equal(two.combined, true);
    assert.equal(two.gen, 75.3);
    assert.equal(two.prefill, 1465.7);
    assert.equal(two.genText, 'XTX Strata 51 · 3060 llama 24');
    assert.equal(two.prefillText, 'XTX Strata 1098 · 3060 llama 368');
    // An idle lane is still listed (at 0) so the breakdown shows both.
    const idle = lt.combine([{ label: 'XTX Strata', gen: 0, prefill: 0 }, { label: '3060 llama', gen: 24, prefill: 0 }]);
    assert.equal(idle.gen, 24);
    assert.equal(idle.genText, 'XTX Strata 0 · 3060 llama 24');
    // Single lane: not combined -- the sidebar keeps its single-server path.
    assert.equal(lt.combine([{ label: '3060 llama', gen: 24, prefill: 300 }]).combined, false);
    assert.equal(lt.combine([]).combined, false);
});

test('two live meters end to end: the XTX lane generating while the 3060 lane prefills', () => {
    const xtx = lt.createLaneMeter(), g3060 = lt.createLaneMeter();
    xtx.feed(req(1, T0), T0);
    stream(xtx, 1, T0 + 100, 40, 180);
    xtx.feed(end(1, T0 + 2100, tm({ predicted_n: 2400, prompt_n: 4733, prompt_per_second: 1098.2 })), T0 + 2100);   // 7200 chars / 2400 tok = 3.0
    g3060.feed(end(5, T0 + 1000, tm({ prompt_n: 1249, prompt_per_second: 367.5 })), T0 + 1000);
    xtx.feed(req(2, T0 + 3000), T0 + 3000);
    const last = stream(xtx, 2, T0 + 4000, 41, 9);   // 180 chars/s = 60 tok/s
    g3060.feed(req(6, last - 200), last - 200);       // 3060 just started prefilling its next turn
    const sum = lt.combine([
        { label: 'XTX Strata', ...xtx.rates(last) },
        { label: '3060 llama', ...g3060.rates(last) },
    ]);
    assert.equal(sum.combined, true);
    assert.ok(Math.abs(sum.gen - 60) < 0.5, `gen ${sum.gen}`);
    assert.equal(sum.prefill, 1465.7);
    assert.equal(sum.lanes[1].phase, 'prefill');
    assert.match(sum.genText, /^XTX Strata 60 · 3060 llama 0$/);
});

test('lane labels: the card name the runner published (shortened), else the lane; engine from /props build_info', () => {
    assert.equal(lt.gpuShort({ gpu: 'AMD Radeon RX 7900 XTX' }, '', 'local-xtx'), 'RX 7900 XTX');
    assert.equal(lt.gpuShort({ gpu: 'NVIDIA GeForce RTX 3060' }, '', 'local-3060'), 'RTX 3060');
    assert.equal(lt.gpuShort({ gpu: 'NVIDIA GeForce RTX 4090 Laptop GPU' }, '', 'x'), 'RTX 4090 Laptop');
    assert.equal(lt.gpuShort({ gpu: 'Intel(R) Arc(TM) B580 Graphics' }, '', 'x'), 'Arc B580');   // a card this code has never heard of
    // no card is guessed from a queue item's label any more: the lane's own name stands in
    assert.equal(lt.gpuShort({ server_port: 18080 }, 'strata-flashnext-gsqrco-coder-iq1m-262k-xtx-strataset', 'local-gpu'), 'gpu');
    assert.equal(lt.gpuShort({}, 'qwen38-27b-ud-q4kxl-64k', 'local-rocm1'), 'rocm1');
    assert.equal(lt.gpuShort(null, '', ''), '?');
    // several cards under one lane
    assert.equal(lt.joinCardLabels(['RX 7900 XTX #1', 'RX 7900 XTX #2']), '2x RX 7900 XTX');
    assert.equal(lt.joinCardLabels(['RTX 3060', 'RX 7900 XTX', 'RTX 3060']), 'RTX 3060 + RX 7900 XTX');
    assert.equal(lt.joinCardLabels(['RX 7900 XTX #2']), 'RX 7900 XTX #2');
    assert.equal(lt.joinCardLabels([]), null);
    assert.equal(lt.engineOf({ build_info: 'Strata 0.1.30' }), 'Strata');
    assert.equal(lt.engineOf({ build_info: 'b10499-6d0549831' }), 'llama');
    assert.equal(lt.engineOf(null), null);
});

// ---- engine samples (exact live counters, preferred over the tap estimate) ----
// Strata GET /metrics `live` blocks as sampled from the XTX lane on 2026-10-01.
const strata = (live) => ({ engine: { version: '0.1.30' }, live, requests: [] });
const LIVE_IDLE = { state: 'idle', queued: 0, phase: null, prompt_tokens: null, prompt_read: null, prompt_total: null, generated: null, tok_s: null, tok_s_mean: null, prefill_tok_s_mean: null, tok_s_window_s: null };

test('parseStrataLive: reading (before/after the first chunk), generating, idle', () => {
    const n = T0;
    const r0 = lt.parseStrataLive(strata({ state: 'reading', phase: 'reading the prompt', prompt_tokens: 10097, prompt_read: null, prompt_total: null, generated: 0, tok_s: null, prefill_tok_s_mean: null }), n);
    assert.deepEqual([r0.phase, r0.gen, r0.prefill, r0.progress], ['prefill', 0, null, null]);
    const r1 = lt.parseStrataLive(strata({ state: 'reading', prompt_tokens: 10097, prompt_read: 8192, prompt_total: 10097, generated: 0, tok_s: null, prefill_tok_s_mean: 1429.1 }), n);
    assert.equal(r1.prefill, 1429.1);
    assert.ok(Math.abs(r1.progress - 8192 / 10097) < 1e-9);
    const g = lt.parseStrataLive(strata({ state: 'generating', phase: 'thinking', generated: 86, tok_s: 61.8, tok_s_mean: 58.0, prefill_tok_s_mean: 1188.6, tok_s_window_s: 2.0 }), n);
    assert.deepEqual([g.phase, g.gen, g.prefill, g.src], ['gen', 61.8, null, 'metrics']);
    const i = lt.parseStrataLive(strata(LIVE_IDLE), n);
    assert.deepEqual([i.phase, i.gen], ['idle', 0]);
    assert.equal(lt.parseStrataLive({ error: { message: 'not found' } }, n), null);
});

test('slotsSample: lib/slots.js output -> gen / prefill / busy / idle', () => {
    assert.deepEqual(lt.slotsSample({ gen: { instTps: 28.8, avgTps: 27, nDecoded: 90 }, prefill: null, ctx: { busy: true } }, T0),
        { at: T0, src: 'slots', phase: 'gen', gen: 28.8, prefill: null, generated: 90, ctx: null, ctxMax: null });
    const p = lt.slotsSample({ gen: null, prefill: { instTps: 410, progress: 0.5 }, ctx: { busy: true } }, T0);
    assert.deepEqual([p.phase, p.gen, p.prefill, p.progress], ['prefill', 0, 410, 0.5]);
    assert.equal(lt.slotsSample({ gen: null, prefill: null, ctx: { busy: true } }, T0).phase, 'busy');
    assert.equal(lt.slotsSample({ gen: null, prefill: null, ctx: { busy: false } }, T0).gen, 0);
});

test('laneRates: a fresh engine sample wins, a stale or unknown one falls back to the tap meter', () => {
    const m = lt.createLaneMeter();
    m.feed(req(1, T0), T0);
    const last = stream(m, 1, T0 + 100, 41, 30);   // tap estimate ~187 t/s at the default ratio
    m.feed(end(1, last + 10, tm({ prompt_n: 4733, prompt_per_second: 1098.2 })), last + 10);
    m.feed(req(2, last + 50), last + 50);
    stream(m, 2, last + 300, 21, 30);
    const now = last + 1300;
    const meter = m.rates(now);
    assert.equal(meter.genSrc, 'last');   // uncalibrated -> the last exact rate (25.1)
    // Generating per the engine: its exact rate; prefill stays the tap's exact per-request rate.
    const g = lt.laneRates(meter, { at: now - 500, src: 'metrics', phase: 'gen', gen: 54.8, prefill: null }, now);
    assert.deepEqual([g.gen, g.genSrc, g.prefill, g.prefillSrc, g.phase], [54.8, 'metrics', 1098.2, 'tap', 'gen']);
    // Mid-read with a live rate: live prefill, and gen is 0 even though the tap's last frames are < 3 s old.
    const p = lt.laneRates(meter, { at: now, src: 'slots', phase: 'prefill', gen: 0, prefill: 410.4, progress: 0.4 }, now);
    assert.deepEqual([p.gen, p.prefill, p.prefillSrc, p.phase, p.progress], [0, 410.4, 'slots', 'prefill', 0.4]);
    // Mid-read before the engine has a rate: the tap's last exact prefill rate.
    assert.equal(lt.laneRates(meter, { at: now, src: 'metrics', phase: 'prefill', gen: 0, prefill: null }, now).prefill, 1098.2);
    // Engine idle while the tap saw activity < 5 s ago: 'between turns', gen 0.
    const i = lt.laneRates(meter, { at: now, src: 'metrics', phase: 'idle', gen: 0, prefill: null }, now);
    assert.deepEqual([i.gen, i.phase], [0, 'busy']);
    // Unknown ('busy', llama's first tick of a request) or stale: the meter's numbers.
    assert.equal(lt.laneRates(meter, { at: now, src: 'slots', phase: 'busy', gen: null, prefill: null }, now).genSrc, 'last');
    const stale = lt.laneRates(meter, { at: now - lt.SAMPLE_FRESH_MS - 1, src: 'slots', phase: 'gen', gen: 99, prefill: null }, now);
    assert.deepEqual([stale.gen, stale.genSrc], [meter.gen, 'last']);
    assert.equal(lt.laneRates(meter, null, now).gen, meter.gen);
});

test('busyLocalLanes: lanes with a tap and a running item; cloud and idle lanes excluded', () => {
    const taps = { 'local-gpu': 18090, 'local-3060': 18091, 'local-xtx': 18092 };
    const run = (...lanes) => Object.fromEntries(lanes.map((l, i) => [l, { id: i + 1, lane: l, label: `item-${l}` }]));
    assert.deepEqual(lt.busyLocalLanes({ taps, running: run('local-xtx', 'cloud', 'local-3060') }), ['local-3060', 'local-xtx']);
    // The state on 2026-10-01 after the 3060's item finished: one local lane -> not combined.
    assert.deepEqual(lt.busyLocalLanes({ taps, running: run('local-gpu', 'cloud') }), ['local-gpu']);
    assert.deepEqual(lt.busyLocalLanes({}), []);
});

// 2026-10-09 (Kyle: the public live card "only seems to show generating numbers, but never prefill numbers"): a card
// that is generating also needs the last prefill rate, and only a sizeable read is a speed.
test('lastRead: the last prefill of >= 1000 tokens, kept through later small cached re-reads', () => {
    const m = lt.createLaneMeter();
    m.feed(req(1, T0), T0);
    m.feed(end(1, T0 + 400, tm({ prompt_n: 12400, prompt_per_second: 297.7 })), T0 + 400);
    m.feed(req(2, T0 + 1000), T0 + 1000);
    m.feed(end(2, T0 + 1400, tm({ prompt_n: 310, prompt_per_second: 3.1 })), T0 + 1400);
    const r = m.rates(T0 + 1500);
    assert.deepEqual([r.lastReadTps, r.lastReadN, r.lastPromptN], [297.7, 12400, 310]);
    assert.deepEqual([lt.createLaneMeter().rates(T0).lastReadTps, lt.createLaneMeter().rates(T0).lastReadN], [null, null]);
});

// 2026-10-22: the Live transcript's prefill / generation strip (ui/benchmarks/util.js livePhase) reads one shape for
// both engines -- tokens read / to read while the prompt is read, tokens generated while generating -- and the
// in-flight request's ages from the tap.
test('engine samples carry read / total / generated in one shape, Strata and llama alike', () => {
    const s1 = lt.parseStrataLive({ live: { state: 'reading', prompt_read: 8192, prompt_total: 20480, prefill_tok_s_mean: 900 } }, T0);
    assert.deepEqual([s1.phase, s1.read, s1.total, s1.prefill], ['prefill', 8192, 20480, 900]);
    const s2 = lt.parseStrataLive({ live: { state: 'generating', tok_s: 41.5, generated: 377 } }, T0);
    assert.deepEqual([s2.phase, s2.gen, s2.generated], ['gen', 41.5, 377]);
    const s3 = lt.slotsSample({ prefill: { instTps: 410, progress: 0.25, nTokens: 2048, total: 8192 }, gen: null }, T0);
    assert.deepEqual([s3.phase, s3.read, s3.total], ['prefill', 2048, 8192]);
    const s4 = lt.slotsSample({ gen: { instTps: 30, nDecoded: 512 }, prefill: null }, T0);
    assert.deepEqual([s4.phase, s4.generated], ['gen', 512]);
});

test('laneRates passes the counts through only from a fresh sample of the same phase; the meter gives the request\'s ages', () => {
    const m = lt.createLaneMeter();
    m.feed(req(1, T0), T0);
    const pre = m.rates(T0 + 4000);
    assert.deepEqual([pre.phase, pre.reqAgeMs, pre.firstTokenMs], ['prefill', 4000, null]);
    const r1 = lt.laneRates(pre, { at: T0 + 4000, src: 'metrics', phase: 'prefill', gen: 0, prefill: 850, read: 4096, total: 10000 }, T0 + 4000);
    assert.deepEqual([r1.read, r1.total, r1.generated, r1.reqAgeMs], [4096, 10000, null, 4000]);
    stream(m, 1, T0 + 9000, 5, 20);
    const gen = m.rates(T0 + 9300);
    assert.deepEqual([gen.phase, gen.reqAgeMs, gen.firstTokenMs], ['gen', 9300, 9000]);
    const r2 = lt.laneRates(gen, { at: T0 + 9300, src: 'slots', phase: 'gen', gen: 40, prefill: null, generated: 77 }, T0 + 9300);
    assert.deepEqual([r2.generated, r2.read, r2.total], [77, null, null]);
    const stale = lt.laneRates(gen, { at: T0, src: 'slots', phase: 'gen', gen: 40, prefill: null, generated: 77 }, T0 + 9300);
    assert.equal(stale.generated, null, 'a stale count would be another moment\'s');
    m.feed(end(1, T0 + 9500, tm({})), T0 + 9500);
    assert.deepEqual([m.rates(T0 + 9600).reqAgeMs, m.rates(T0 + 9600).firstTokenMs], [null, null], 'nothing in flight');
});

// 2026-10-22 (Kyle: the Live view's prefill / generation strip "seems ... a second or two late"): the tap's edges.
test('feed() names the edges of a live request; replayed frames are none', () => {
    const m = lt.createLaneMeter();
    assert.equal(m.feed(req(1, T0), T0), 'request');
    assert.equal(m.feed({ type: 'delta', id: 1, reasoning: 'ab' }, T0 + 900), 'first');
    assert.equal(m.feed({ type: 'delta', id: 1, reasoning: 'cd' }, T0 + 950), null);
    assert.equal(m.feed(end(1, T0 + 1500, tm()), T0 + 1500), 'end');
    assert.equal(m.rates(T0 + 1500).edgeAt, T0 + 1500);
    // what a new subscriber is replayed: request + delta flagged, the end not -- none of it is an edge
    const r = lt.createLaneMeter();
    assert.equal(r.feed(req(7, T0 - 60000, { replay: true }), T0), null);
    assert.equal(r.feed({ type: 'delta', id: 7, replay: true, content: 'x' }, T0), null);
    assert.equal(r.feed(end(7, T0 - 50000, tm()), T0), null);
    assert.equal(r.rates(T0).edgeAt, null);
    // a request already streaming when we dialled: its live frames are edges again
    assert.equal(r.feed(req(8, T0 - 2000, { replay: true }), T0), null);
    assert.equal(r.feed({ type: 'delta', id: 8, content: 'y' }, T0 + 50), 'first');
    assert.equal(r.feed(end(8, T0 + 400, tm()), T0 + 400), 'end');
});

test('laneRates: an engine sample taken before the latest tap edge yields to the tap until the next sample', () => {
    const m = lt.createLaneMeter();
    m.feed(req(1, T0), T0);
    const engPrefill = { at: T0 + 600, src: 'metrics', phase: 'prefill', gen: 0, prefill: 900, progress: 0.5, read: 500, total: 1000, ctx: 40500, ctxMax: 131072 };
    let r = lt.laneRates(m.rates(T0 + 700), engPrefill, T0 + 700);
    assert.deepEqual([r.phase, r.prefill, r.prefillSrc, r.read, r.ctx, r.ctxMax], ['prefill', 900, 'metrics', 500, 40500, 131072]);
    // the first token streams at +1000; the engine's last word (+600) still says reading: the strip says generating now
    m.feed({ type: 'delta', id: 1, content: 'x'.repeat(10) }, T0 + 1000);
    r = lt.laneRates(m.rates(T0 + 1010), engPrefill, T0 + 1010);
    assert.deepEqual([r.phase, r.read, r.total, r.progress, r.ctx], ['gen', null, null, null, null]);
    assert.equal(r.ctxMax, 131072, 'the server\'s context size does not change with the request');
    // the engine's next sample (after the edge) speaks again
    r = lt.laneRates(m.rates(T0 + 1600), { at: T0 + 1600, src: 'metrics', phase: 'gen', gen: 61.8, prefill: null, generated: 30, ctx: 41030, ctxMax: 131072 }, T0 + 1600);
    assert.deepEqual([r.phase, r.gen, r.genSrc, r.generated, r.ctx], ['gen', 61.8, 'metrics', 30, 41030]);
    // the end: between requests at once, though the engine's last sample still said generating
    m.feed({ type: 'delta', id: 1, content: 'y'.repeat(10) }, T0 + 1900);
    m.feed(end(1, T0 + 2000, tm({ predicted_n: 40 })), T0 + 2000);
    r = lt.laneRates(m.rates(T0 + 2010), { at: T0 + 1600, src: 'metrics', phase: 'gen', gen: 61.8, prefill: null }, T0 + 2010);
    assert.deepEqual([r.phase, r.gen], ['busy', 0]);
});

test('engine samples carry the context in use and the server\'s context size', () => {
    const s = lt.parseStrataLive({ engine: { context: 131072, max_context: 131072 }, live: { state: 'generating', prompt_tokens: 94485, generated: 86, tok_s: 139.3 } }, T0);
    assert.deepEqual([s.ctx, s.ctxMax], [94571, 131072]);
    const r = lt.parseStrataLive({ engine: { max_context: 65536 }, live: { state: 'reading', prompt_tokens: 20480, prompt_read: 0, prompt_total: 664, generated: 0 } }, T0);
    assert.deepEqual([r.ctx, r.ctxMax], [20480, 65536]);
    const i = lt.parseStrataLive({ engine: { context: 131072 }, live: { state: 'idle', prompt_tokens: null } }, T0);
    assert.deepEqual([i.ctx, i.ctxMax], [null, 131072]);
    const g = lt.slotsSample({ gen: { instTps: 30, nDecoded: 512 }, prefill: null, ctx: { used: 30512, limit: 65536, busy: true } }, T0);
    assert.deepEqual([g.ctx, g.ctxMax], [30512, 65536]);
    assert.deepEqual([lt.slotsSample({ gen: null, prefill: null, ctx: { used: 30512, limit: 65536, busy: false } }, T0).ctx], [null]);
});
