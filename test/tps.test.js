'use strict';
// Per-task token rates (lib/tps.js): token-weighted prefill/gen averages for Bench -> Live.
const test = require('node:test');
const assert = require('node:assert/strict');
const tps = require('../lib/tps');
const { createRelay } = require('../lib/livechat');

test('token-weighted, not a mean of per-request rates', () => {
    const acc = tps.fresh();
    // 20000 tokens in 20 s (1000 t/s) and 30 tokens in 1 s (30 t/s): 20030 / 21 s, not (1000 + 30) / 2
    tps.addTimings(acc, { prompt_n: 20000, prompt_ms: 20000, predicted_n: 500, predicted_ms: 25000 });
    tps.addTimings(acc, { prompt_n: 30, prompt_ms: 1000, predicted_n: 100, predicted_ms: 10000 });
    const s = tps.summarize(acc);
    assert.equal(s.pp, +(20030 / 21).toFixed(2));
    assert.equal(s.gen, +(600 / 35).toFixed(2));
    assert.equal(s.n, 2);
    assert.equal(s.prompt_n, 20030);
    assert.equal(s.src, 'tap');
});

test('a phase with no tokens or no time is left out of that phase only', () => {
    const acc = tps.fresh();
    tps.addTimings(acc, { prompt_n: 0, prompt_ms: 0, predicted_n: 100, predicted_ms: 5000 });   // fully cached prompt
    const s = tps.summarize(acc);
    assert.equal(s.pp, null);
    assert.equal(s.gen, 20);
    tps.addTimings(acc, null);
    tps.addTimings(acc, { prompt_n: 10, prompt_ms: 0 });   // nothing usable: not counted as a request
    assert.equal(tps.summarize(acc).n, 1);
});

test('nothing counted -> null (the view shows "—")', () => {
    assert.equal(tps.summarize(tps.fresh()), null);
    assert.equal(tps.summarize(null), null);
    assert.equal(tps.fromRows([]), null);
    assert.equal(tps.fromRows(null), null);
    assert.equal(tps.createBook().get('nope'), null);
});

test('rates + tokens (slots `finished`, request-log rows) derive time as tokens / rate', () => {
    const acc = tps.fresh();
    tps.addRates(acc, { promptTokens: 1000, promptTps: 500, genTokens: 200, genTps: 20 });   // 2 s, 10 s
    tps.addRates(acc, { promptTokens: 3000, promptTps: 1000, genTokens: 100, genTps: 50 });  // 3 s, 2 s
    const s = tps.summarize(acc);
    assert.equal(s.pp, 800);     // 4000 / 5 s
    assert.equal(s.gen, 25);     // 300 / 12 s
    assert.equal(s.src, 'slots');
});

test('request-log rows: zero/NULL rates are skipped, not counted as instant', () => {
    const s = tps.fromRows([
        { prompt_tokens: 2000, prefill_tps: 400, gen_tokens: 100, gen_tps: 20 },
        { prompt_tokens: 50, prefill_tps: 0, gen_tokens: 0, gen_tps: null },     // no usable phase at all
        { prompt_tokens: 1000, prefill_tps: 500, gen_tokens: 300, gen_tps: 0 },  // prefill only
    ]);
    assert.equal(s.pp, +(3000 / 7).toFixed(2));
    assert.equal(s.gen, 20);
    assert.equal(s.n, 2);
    assert.equal(s.src, 'db');
});

test('rows are filtered to the task\'s model, across symlinked paths and split shards', () => {
    assert.equal(tps.modelKey('/data/models/X/Foo-Q4_K_M-00001-of-00003.gguf'), 'Foo-Q4_K_M');
    const rows = [
        { model_path: '/home/k/models/Foo-Q4_K_M-00001-of-00003.gguf', prompt_tokens: 100, prefill_tps: 100 },
        { model_path: '/home/k/models/Bar.gguf', prompt_tokens: 100, prefill_tps: 1 },
        { model_path: null, prompt_tokens: 100, prefill_tps: 100 },
    ];
    const kept = tps.rowsForModel(rows, '/data/models/Foo-Q4_K_M-00001-of-00003.gguf');
    assert.equal(kept.length, 2);
    assert.equal(tps.rowsForModel(rows, null).length, 3);
    assert.equal(tps.fromRows(kept).pp, 100);
});

test('book: per-(battery, task) keys, mixed sources, bounded', () => {
    const b = tps.createBook({ max: 2 });
    const k1 = tps.taskKey('bat', 'task-a', 1), k2 = tps.taskKey('bat', 'task-a', 2), k3 = tps.taskKey('bat', 'task-b');
    assert.equal(k1, 'bat|task-a#1');
    assert.equal(tps.taskKey('bat', 'task-b'), 'bat|task-b#1');
    b.addTimings(k1, { prompt_n: 100, prompt_ms: 1000, predicted_n: 10, predicted_ms: 1000 });
    b.addRates(k1, { promptTokens: 100, promptTps: 100, genTokens: 10, genTps: 10 }, 'slots');
    assert.deepEqual([b.get(k1).pp, b.get(k1).gen, b.get(k1).n, b.get(k1).src], [100, 10, 2, 'slots+tap']);
    b.addTimings(null, { prompt_n: 1, prompt_ms: 1 });   // no running task: dropped
    b.addTimings(k2, { predicted_n: 5, predicted_ms: 1000 });
    b.addTimings(k3, { predicted_n: 5, predicted_ms: 1000 });
    assert.equal(b.size(), 2);
    assert.equal(b.get(k1), null);   // oldest evicted
    assert.equal(b.get(k3).gen, 5);
});

test('relay: every `end` reaches onEnd with its timings (main and side responses)', () => {
    const got = [];
    const relay = createRelay({ onEnd: (ev) => got.push(ev), httpGet: () => { throw new Error('no dial in this test'); } });
    relay._onEvent({ type: 'request', id: 1, thread: 't', prefix: 0, delta: [{ role: 'user', content: 'hi' }], n_messages: 1, tools: [{}] });
    relay._onEvent({ type: 'delta', id: 1, content: 'x' });
    relay._onEvent({ type: 'end', id: 1, finish: 'stop', timings: { prompt_n: 10, prompt_ms: 100, predicted_n: 1, predicted_ms: 50 } });
    relay._onEvent({ type: 'end', id: 99, timings: null });
    assert.equal(got.length, 2);
    assert.equal(got[0].timings.prompt_n, 10);
    assert.equal(relay.connected(), false);
});

// ---- per-run rates over the request log (the Models compare page's tg / pp, 2026-10-18) ----
const LLAMA = '/home/kyle/AI/llama-official/llama.cpp/build-all/bin/llama-server -m /m/Qwen3.8-27B-UD-Q4_K_XL.gguf -c 131072 -dev ROCm1 --port 18082';
const LAPTOP = '/home/kyle-4090/llama-lane/llama.cpp/build-cuda/bin/llama-server -m /m/Qwen3.8-27B-UD-Q4_K_XL.gguf -c 131072 -dev CUDA0,CUDA1 --port 18090';
const STRATA = '/home/kyle/AI/Strata-0.1.43.1/queue-serve.sh /home/kyle/AI/Strata-0.1.43.1/fn-iq1m.json';
const T0 = Date.parse('2026-10-17T06:00:00Z');
// readRequests()-shaped rows: 100 prompt tokens at 1000 t/s = 0.1 s, 50 generated at 25 t/s = 2 s
const rq = (dt, extra) => ({ t: T0 + dt, modelPath: '/m/Qwen3.8-27B-UD-Q4_K_XL.gguf', launchCommand: LLAMA, machineFp: 'desk', source: 'llama-log-import',
    aborted: false, promptTokens: 100, promptTps: 1000, genTokens: 50, genTps: 25, ...extra });

test('runRates: only the run\'s own server, inside its window, token-weighted', () => {
    const rows = [
        rq(-5000),                                                    // before the window (start - 1 s): not this run
        rq(10000), rq(20000, { promptTokens: 1900, promptTps: 950 }),   // the run's own requests
        rq(30000, { launchCommand: LAPTOP, genTps: 100 }),            // the laptop lane, SAME weights, same minute
        rq(31000, { modelPath: '/m/other.gguf' }),                    // another model
        rq(32000, { modelPath: null }),                               // nothing says which server: never taken
        rq(33000, { aborted: true }),
        rq(64000),                                                    // within the 5 s grace after the wall clock
        rq(80000),                                                    // after it
    ];
    const tl = tps.requestTimeline(rows);
    assert.equal(tps.requestTimeline(rows), tl, 'memoised per rows array');
    // the run recorded the command with another port and quoting: still its own server
    const run = { from: T0, to: T0 + 60000, modelPath: '/elsewhere/Qwen3.8-27B-UD-Q4_K_XL.gguf', launchCommand: LLAMA.replace('--port 18082', "--port 18099").replace('-dev ROCm1', "-dev 'ROCm1'") };
    const r = tps.runRates(tl, run);
    assert.equal(r.n, 3);
    assert.equal(r.prompt_n, 2100); assert.equal(r.prompt_ms, 100 + 2000 + 100);
    assert.equal(r.predicted_n, 150); assert.equal(r.predicted_ms, 6000);
    // the laptop lane's run gets only its own request
    assert.equal(tps.runRates(tl, { ...run, launchCommand: LAPTOP }).n, 1);
    // a launch nobody logged: null, never the other lanes' requests
    assert.equal(tps.runRates(tl, { ...run, launchCommand: LLAMA.replace('-c 131072', '-c 65536') }), null);
    assert.equal(tps.runRates(tl, { ...run, modelPath: null }), null);
    assert.equal(tps.runRates(tl, { ...run, from: T0 + 200000, to: T0 + 260000 }), null);
});

test('runRates: a Strata run (no launch command) takes its machine\'s rows, and refuses two servers', () => {
    const fn = (dt, extra) => rq(dt, { modelPath: '/data/models/Qwen3.8-Flash-Next-GSQ-RCO-IQ1_M-00001-of-00002.gguf', launchCommand: STRATA, source: 'proxy-record', machineFp: 'desk', ...extra });
    const run = { from: T0, to: T0 + 60000, modelPath: '/data/models/Qwen3.8-Flash-Next-GSQ-RCO-IQ1_M-00001-of-00002.gguf', launchCommand: null, machineFp: 'desk' };
    const one = tps.requestTimeline([fn(1000), fn(2000), fn(3000, { machineFp: 'laptop' }), fn(4000, { machineFp: null })]);
    assert.equal(tps.runRates(one, run).n, 3, 'the other machine\'s row is left out; a row with no machine recorded is kept');
    const two = tps.requestTimeline([fn(1000), fn(2000, { launchCommand: STRATA.replace('fn-iq1m', 'fn-iq1m-b') })]);
    assert.equal(tps.runRates(two, run), null, 'two launches of the same weights in the window: cannot tell which served it');
});

test('runRates: a request logged twice (two sources) counts once', () => {
    const tl = tps.requestTimeline([rq(1000), rq(2000), rq(1000, { source: 'live' })]);
    const r = tps.runRates(tl, { from: T0, to: T0 + 10000, modelPath: '/m/Qwen3.8-27B-UD-Q4_K_XL.gguf', launchCommand: LLAMA });
    assert.equal(r.n, 2);
    assert.equal(tps.normLaunch(`a  '--x' "y" --port 1 b`), 'a --x y b');
});
