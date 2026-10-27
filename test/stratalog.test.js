// Request timings from a Strata engine's own log (lib/stratalog.js, 2026-10-22): the source of a Strata run's prefill /
// generation sums when the record proxy did not record (none of Flash-Next UD-Q4_K_XL's batteries did), and the depth
// bands every run's sums now carry (lib/tps.js runRates, lib/models.js sumRunSpeed).

const test = require('node:test');
const assert = require('node:assert');
const SL = require('../lib/stratalog');
const tps = require('../lib/tps');
const M = require('../lib/models');

// the engine's lines as v0.2.2 and 0.1.44.1 both write them (times are the engine's LOCAL clock)
const start = (when) => `[strata] ${when} engine started: /home/kyle/AI/Strata-0.2.2/engine/strata --serve --pack /p --resident-budget-gib 42`;
const req = (n, reused, read, readMs, gen, genMs) => `strata serve: prompt ${n} tokens = ${reused} reused + ${read} read in ${readMs} ms (${(read / readMs * 1000).toFixed(1)} tok/s), ${gen} generated in ${genMs} ms (${(gen / genMs * 1000).toFixed(1)} tok/s), drafts accepted 1 of 2, 1 checkpoints`;
const local = (y, mo, d, h, mi, s) => new Date(y, mo - 1, d, h, mi, s).getTime();

test('parseLog: one segment per engine start (local time), the request lines, a cut log and a line being written', () => {
    const text = [
        req(500, 0, 500, 1000, 50, 1000),                       // before any start line (a log that was cut): dropped
        start('2026-10-22 03:24:04'),
        'strata serve: prompt chunk auto: 8192 tokens, a 96-slot ring',   // not a request
        req(645, 0, 645, 3559, 213, 4150),
        req(7601, 7507, 94, 1137, 103, 1835),
        start('2026-10-22 05:00:00'),
        req(31000, 30000, 1000, 2000, 100, 1600),
        'strata serve: prompt 40000 tokens = 39000 reused + 1000 read in 20',   // the line being written: no newline yet
    ].join('\n');
    const segs = SL.parseLog(text);
    assert.equal(segs.length, 2);
    assert.equal(segs[0].start, local(2026, 10, 22, 3, 24, 4), 'the engine\'s clock is local time (09:24:04Z here in MDT)');
    assert.equal(segs[0].end, segs[1].start);
    assert.equal(segs[1].end, Infinity);
    assert.deepStrictEqual(segs[0].reqs, [{ depth: 645, read: 645, readMs: 3559, gen: 213, genMs: 4150 }, { depth: 7601, read: 94, readMs: 1137, gen: 103, genMs: 1835 }]);
    assert.equal(segs[1].reqs.length, 1, 'the partial last line is not a request');
    assert.equal(SL.parseLog(text + '\n')[1].reqs.length, 1, 'still not one once its newline arrives cut short (no "generated")');
});

test('runSpeeds: a start serving one run gives it its requests; one serving several shares them out by wall clock', () => {
    const t0 = local(2026, 10, 22, 3, 0, 0);
    const segs = { '/a.log': [
        { start: t0, end: t0 + 3600e3, reqs: [{ depth: 10000, read: 1000, readMs: 2000, gen: 100, genMs: 2000 }, { depth: 40000, read: 3000, readMs: 6000, gen: 300, genMs: 6000 }] },
        { start: t0 + 3600e3, end: Infinity, reqs: [{ depth: 5000, read: 900, readMs: 1000, gen: 60, genMs: 1000 }] },
    ] };
    const read = (f) => segs[f] || null;
    const runs = [
        { key: 'one', log: '/a.log', from: t0 + 60e3, to: t0 + 600e3, weight: 400 },
        // the second start served two runs: 3 : 1 by their weights (lib/models.js passes each run's wall clock)
        { key: 'two-a', log: '/a.log', from: t0 + 3700e3, to: t0 + 3800e3, weight: 300 },
        { key: 'two-b', log: '/a.log', from: t0 + 3900e3, to: t0 + 4000e3, weight: 100 },
        { key: 'crosses', log: '/a.log', from: t0 + 3000e3, to: t0 + 3700e3, weight: 1 },   // across a restart: its requests are split
        { key: 'before', log: '/a.log', from: t0 - 600e3, to: t0 - 60e3, weight: 1 },       // before the first start
        { key: 'nolog', log: '/b.log', from: t0, to: t0 + 1, weight: 1 },
    ];
    const out = SL.runSpeeds(runs, read);
    assert.deepStrictEqual(out.get('one'), { prompt_n: 4000, prompt_ms: 8000, predicted_n: 400, predicted_ms: 8000, n: 2,
        lo: { prompt_n: 1000, prompt_ms: 2000, predicted_n: 100, predicted_ms: 2000, n: 1 },
        hi: { prompt_n: 3000, prompt_ms: 6000, predicted_n: 300, predicted_ms: 6000, n: 1 }, src: 'strata-log', shared: false });
    const a = out.get('two-a'), b = out.get('two-b');
    assert.deepStrictEqual([a.prompt_n, a.predicted_ms, a.n, a.shared], [675, 750, 0.75, true]);
    assert.deepStrictEqual([b.prompt_n, b.predicted_ms, b.n], [225, 250, 0.25]);
    assert.equal(a.prompt_n / a.prompt_ms, b.prompt_n / b.prompt_ms, 'a share has the segment\'s own rates');
    for (const k of ['crosses', 'before', 'nolog']) assert.equal(out.has(k), false, `${k}: unknown, never a guess`);
});

test('lib/tps.js runRates: the depth bands at SPEED_BAND_SPLIT; a request with no recorded depth counts in the totals only', () => {
    const T0 = Date.parse('2026-10-17T06:00:00Z');
    const cmd = '/b/llama-server -m /m/x.gguf -c 131072';
    const rq = (dt, depth, extra) => ({ t: T0 + dt, modelPath: '/m/x.gguf', launchCommand: cmd, source: 'llama-log-import', aborted: false,
        promptTokens: 1000, promptTps: 1000, genTokens: 100, genTps: 50, ctxDepth: depth, ...extra });
    const tl = tps.requestTimeline([rq(1000, 12000), rq(2000, tps.SPEED_BAND_SPLIT), rq(3000, 45000, { promptTps: 500 }), rq(4000, null)]);
    const r = tps.runRates(tl, { from: T0, to: T0 + 10000, modelPath: '/m/x.gguf', launchCommand: cmd });
    assert.equal(r.n, 4);
    assert.deepStrictEqual(r.lo, { prompt_n: 1000, prompt_ms: 1000, predicted_n: 100, predicted_ms: 2000, n: 1 });
    assert.deepStrictEqual(r.hi, { prompt_n: 2000, prompt_ms: 3000, predicted_n: 200, predicted_ms: 4000, n: 2 }, 'exactly 30k is the upper band');
    assert.deepStrictEqual([tps.bandOf(29999), tps.bandOf(30000), tps.bandOf(null)], [0, 1, null]);
    const none = tps.runRates(tps.requestTimeline([rq(1000, null)]), { from: T0, to: T0 + 10000, modelPath: '/m/x.gguf', launchCommand: cmd });
    assert.equal('lo' in none || 'hi' in none, false, 'no depth recorded: no band, the old shape');
});

test('lib/models.js sumRunSpeed: band sums and the engine-log counts, only when present', () => {
    const band = (pn, pms, gn, gms, n) => ({ prompt_n: pn, prompt_ms: pms, predicted_n: gn, predicted_ms: gms, n });
    const s = M.sumRunSpeed([
        { ...band(3000, 4000, 300, 6000, 3), lo: band(1000, 1000, 100, 2000, 1), hi: band(2000, 3000, 200, 4000, 2) },
        { ...band(900, 1000, 60, 1000, 0.75), lo: band(900, 1000, 60, 1000, 0.75), src: 'strata-log', shared: true },
        { none: true },
    ]);
    assert.deepStrictEqual(s, { pn: 3900, pms: 5000, gn: 360, gms: 7000, req: 3.75, runs: 2, of: 3,
        pn0: 1900, pms0: 2000, gn0: 160, gms0: 3000, rq0: 1.75, pn1: 2000, pms1: 3000, gn1: 200, gms1: 4000, rq1: 2, sl: 1, sh: 1 });
    assert.deepStrictEqual(M.sumRunSpeed([band(1, 1, 1, 1, 1)]), { pn: 1, pms: 1, gn: 1, gms: 1, req: 1, runs: 1, of: 1 }, 'the old shape without them');
});
