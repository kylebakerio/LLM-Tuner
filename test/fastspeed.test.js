// A row's speed at its FASTEST speed config (2026-10-22, Kyle: "the speed should separately be based on the fastest
// config ... I wouldn't want the speed to falsely be bogged down by having run low-speed quality runs"; then: "a warning
// that notes that it wasn't run at fastest config, shows estimated times based on tokens re-multiplied by fastest config
// expected performance, and ... raw gen/prefill speed results for fastest configs"). ui/shared/leaderboard.js
// fastestSpeedConfig (the rule), modelSeconds, fastSpeedOf (the re-pricing), speedConfigShare (the warning), relIndexOf.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

async function loadLb() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'shared', 'leaderboard.js'), 'utf-8');
    const stub = 'data:text/javascript,' + encodeURIComponent(
        'export const esc=(s)=>String(s??"");export const fmtDur=(s)=>String(s);export const fmtN=(n)=>String(n);'
        + 'export const harnessLabel=(r)=>r||null;export const scaffoldBit=(r,s)=>s||null;'
        // the real context rule (ui/shared/ctxlabel.js, 2026-10-25): a stub never carries a copy of it
        + `import ${JSON.stringify(require('url').pathToFileURL(path.join(__dirname, '..', 'ui', 'shared', 'ctxlabel.js')).href)};export const { ctxLabel, commonWindow } = globalThis.CtxLabel;`);
    return import('data:text/javascript,' + encodeURIComponent(src.replace("from '../benchmarks/util.js'", `from '${stub}'`)));
}

// A run's speed sums (lib/models.js sumRunSpeed's shape) from rates: per band { pp, tg (t/s), pn, gn (tokens), req }.
function speed(lo, hi, runs = 1) {
    const b = (x) => ({ pn: x.pn, pms: (x.pn / x.pp) * 1000, gn: x.gn, gms: (x.gn / x.tg) * 1000, rq: x.req });
    const L = b(lo), H = b(hi);
    return { pn: L.pn + H.pn, pms: L.pms + H.pms, gn: L.gn + H.gn, gms: L.gms + H.gms, req: L.rq + H.rq, runs, of: runs,
        pn0: L.pn, pms0: L.pms, gn0: L.gn, gms0: L.gms, rq0: L.rq, pn1: H.pn, pms1: H.pms, gn1: H.gn, gms1: H.gms, rq1: H.rq };
}
const cell = (wall, sp, extra = {}) => ({ status: 'pass', attempts: 1, passes: 1, credit: 1, solved: true, excluded: false, wall_s: wall, tokens_out: 1000, ...(sp ? { speed: sp } : {}), ...extra });
const group = (key, tasks) => ({ key, tasks });
const close = (a, b, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} != ${b}`);

// The Flash-Next UD-Q4_K_XL (Strata) case, in miniature: 20 tasks at rb30 on 0.1.44.1 (decode ~45 / ~40, prompt ~300 /
// ~220 below / above 30k of context), 3 at rb42 + --prefill 4096 on v0.2.2 (~63 / ~62, ~550 / ~536), and one lucky
// short run at an untried setting, faster still on paper but measured on 8 requests.
const RB30 = { lo: { pp: 300, tg: 45, pn: 20000, gn: 1000, req: 5 }, hi: { pp: 220, tg: 40, pn: 30000, gn: 5000, req: 20 } };
const RB42 = { lo: { pp: 550, tg: 63, pn: 20000, gn: 1000, req: 12 }, hi: { pp: 536, tg: 62, pn: 30000, gn: 5000, req: 21 } };
const LUCKY = { lo: { pp: 2000, tg: 120, pn: 20000, gn: 1000, req: 3 }, hi: { pp: 1900, tg: 110, pn: 30000, gn: 5000, req: 5 } };
function fnRow() {
    const t30 = {}, t42 = {}, tl = {};
    for (let i = 0; i < 20; i++) t30[`s${i}`] = cell(900 + i, speed(RB30.lo, RB30.hi));
    for (let i = 0; i < 3; i++) t42[`f${i}`] = cell(500, speed(RB42.lo, RB42.hi));
    tl.lucky = cell(100, speed(LUCKY.lo, LUCKY.hi));
    return { g30: group('rb30', t30), g42: group('rb42', t42), gl: group('lucky', tl) };
}

test('the rule: Flash-Next UD-Q4_K_XL\'s rb42 / v0.2.2 config, not its rb30 runs, and never a thin lucky run', async () => {
    const L = await loadLb();
    const { g30, g42, gl } = fnRow();
    const groups = [g30, g42, gl];
    const rowTasks = L.mergeTasks(groups.map((g) => g.tasks));
    const fsx = L.fastSpeedOf(rowTasks, groups);
    assert.strictEqual(fsx.fastest.g, g42, 'measured throughput at the row\'s own mix picks the rb42 config');
    assert.strictEqual(fsx.fastest.thin, false);
    const lucky = fsx.fastest.candidates.find((c) => c.g === gl);
    assert.ok(lucky.est < fsx.fastest.est, 'the lucky run is faster on paper ...');
    assert.strictEqual(lucky.eligible, false, '... but 8 requests are under SPEED_MIN_REQ: it cannot win');
    // the estimate the rule ranks by: the row's own tokens at each config's band rates (prompt and generation apart)
    const mix = L.speedOf(rowTasks);
    const at = (r) => mix.bands[0].pn / r.lo.pp + mix.bands[0].gn / r.lo.tg + mix.bands[1].pn / r.hi.pp + mix.bands[1].gn / r.hi.tg;
    close(fsx.fastest.est, at(RB42));
    close(fsx.fastest.candidates.find((c) => c.g === g30).est, at(RB30));
    // the rb30 runs are re-priced, the rb42 ones stay as measured
    assert.strictEqual(fsx.tasks.f0.how, 'measured');
    assert.strictEqual(fsx.tasks.f0.wall_s, 500);
    assert.strictEqual(fsx.tasks.s0.how, 'estimated');
    assert.ok(fsx.tasks.s0.wall_s < 900, 'faster at the fastest config');
});

test('the rule: with no config measured enough, the most-measured one stands in (thin); ties within SPEED_TIE go to more data', async () => {
    const L = await loadLb();
    const a = group('a', { t1: cell(100, speed({ ...RB30.lo, req: 2 }, { ...RB30.hi, req: 6 })) });            // 8 requests, slow
    const b = group('b', { t2: cell(100, speed({ ...LUCKY.lo, req: 1 }, { ...LUCKY.hi, req: 2 })) });           // 3 requests, fast
    const thin = L.fastSpeedOf(L.mergeTasks([a.tasks, b.tasks]), [a, b]);
    assert.strictEqual(thin.fastest.g, a);
    assert.strictEqual(thin.fastest.thin, true);
    // two configs 1% apart: the one with more requests
    const x = group('x', { t1: cell(100, speed({ ...RB42.lo, req: 10 }, { ...RB42.hi, req: 15 })) });
    const y = group('y', { t2: cell(100, speed({ ...RB42.lo, pp: RB42.lo.pp * 1.01, tg: RB42.lo.tg * 1.01, req: 30 }, { ...RB42.hi, pp: RB42.hi.pp * 1.01, tg: RB42.hi.tg * 1.01, req: 40 })) });
    const z = group('z', { t3: cell(100, speed({ ...RB42.lo, pp: RB42.lo.pp * 1.005, req: 12 }, { ...RB42.hi, req: 13 })) });
    const tie = L.fastestSpeedConfig([x, y, z].map((g) => ({ g, sp: L.speedOf(g.tasks) })), L.speedOf(L.mergeTasks([x.tasks, y.tasks, z.tasks])));
    assert.strictEqual(tie.g, y, 'fastest anyway here; and within 3% the better-measured one');
    const tie2 = L.fastestSpeedConfig([x, z].map((g) => ({ g, sp: L.speedOf(g.tasks) })), L.speedOf(L.mergeTasks([x.tasks, z.tasks])));
    assert.strictEqual(tie2.g, z, 'z is 0.5% faster on prompts only, and has 25 requests to x\'s 25: equal data, the faster');
});

test('the rule: a config never measured at the depths the row works at cannot win', async () => {
    const L = await loadLb();
    const deep = group('deep', Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`d${i}`, cell(600, speed(RB30.lo, RB30.hi))])));
    // 40 requests, all under 30k, at twice rb42's rates: nothing says how it does at 60k
    const shallow = group('shallow', { s: cell(50, speed({ pp: 1100, tg: 126, pn: 20000, gn: 1000, req: 40 }, { pp: 1, tg: 1, pn: 0, gn: 0, req: 0 })) });
    const f = L.fastSpeedOf(L.mergeTasks([deep.tasks, shallow.tasks]), [deep, shallow]);
    assert.strictEqual(f.fastest.g, deep);
    assert.deepStrictEqual(f.fastest.used, [0, 1], 'the row\'s work runs in both bands');
    assert.strictEqual(f.fastest.candidates.find((c) => c.g === shallow).eligible, false);
});

test('re-pricing arithmetic: wall - logged model time + model time at the fastest config, per band', async () => {
    const L = await loadLb();
    // own config: 250 / 200 t/s prompt, 40 / 40 generation below / above 30k; the fastest: 500 / 400, 50 / 50
    const OWN = { lo: { pp: 250, tg: 40, pn: 10000, gn: 1000, req: 10 }, hi: { pp: 200, tg: 40, pn: 20000, gn: 2000, req: 15 } };
    const FAST = { lo: { pp: 500, tg: 50, pn: 10000, gn: 1000, req: 10 }, hi: { pp: 400, tg: 50, pn: 20000, gn: 2000, req: 15 } };
    const own = group('own', { t1: cell(400, speed(OWN.lo, OWN.hi)), t2: cell(300, speed(OWN.lo, OWN.hi)) });
    const fast = group('fast', { t3: cell(250, speed(FAST.lo, FAST.hi)), t4: cell(260, speed(FAST.lo, FAST.hi)) });
    const row = L.mergeTasks([own.tasks, fast.tasks]);
    const f = L.fastSpeedOf(row, [own, fast]);
    assert.strictEqual(f.fastest.g, fast);
    // model time as run (logged, and the same at its config's rates here): 10000/250 + 1000/40 + 20000/200 + 2000/40 = 215 s
    // at the fastest:     10000/500 + 1000/50 + 20000/400 + 2000/50 = 20 + 20 + 50 + 40 = 130 s
    close(L.modelSeconds(L.runMix(own.tasks.t1.speed), L.speedOf(own.tasks)), 215);
    close(L.modelSeconds(L.runMix(own.tasks.t1.speed), L.speedOf(fast.tasks)), 130);
    close(f.tasks.t1.wall_s, 400 - 215 + 130);
    close(f.tasks.t1.model_s, 215); close(f.tasks.t1.model_fast_s, 130);
    assert.strictEqual(f.tasks.t1.measured_wall_s, 400);
    assert.strictEqual(f.tasks.t3.wall_s, 250, 'a run at the fastest config moves by exactly 0');
    // two runs in one cell: per-run tokens (the sums / runs), as the wall clock is per run
    const two = group('own2', { t1: cell(400, speed({ ...OWN.lo, pn: 20000, gn: 2000, req: 20 }, { ...OWN.hi, pn: 40000, gn: 4000, req: 30 }, 2), { attempts: 2, passes: 2 }) });
    const f2 = L.fastSpeedOf(L.mergeTasks([two.tasks, fast.tasks]), [two, fast]);
    close(f2.tasks.t1.wall_s, 400 - 215 + 130);
    // logged model time over the run's wall clock (sums averaged over runs, a shared Strata start shared out): capped at
    // the wall, so the estimate is the fastest config's model time and the run's tool time is taken as none
    const over = group('over', { t5: cell(150, speed(OWN.lo, OWN.hi)) });
    const f4 = L.fastSpeedOf(L.mergeTasks([over.tasks, fast.tasks]), [over, fast]);
    close(f4.tasks.t5.model_s, 150); close(f4.tasks.t5.wall_s, 130);
    // a run with no speed data cannot be re-priced: its task drops out when nothing else ran it
    const blind = group('blind', { t9: cell(700) });
    const f3 = L.fastSpeedOf(L.mergeTasks([own.tasks, fast.tasks, blind.tasks]), [own, fast, blind]);
    assert.strictEqual(f3.tasks.t9, undefined);
    // modelSeconds: a band measured on fewer than SPEED_MIN_BAND_REQ requests is priced at the all-depth rate, and so are
    // tokens with no recorded depth
    const sp = { pp: 100, tg: 10, bands: [{ pp: 1000, tg: 100, req: 4 }, { pp: 50, tg: 5, req: 50 }] };
    close(L.modelSeconds({ pn: 3000, gn: 30, bands: [{ pn: 1000, gn: 10 }, { pn: 1000, gn: 10 }] }, sp), 1000 / 100 + 10 / 10 + 1000 / 50 + 10 / 5 + 1000 / 100 + 10 / 10);
    assert.strictEqual(L.modelSeconds({ pn: 10, gn: 0, bands: [] }, { pp: null, tg: 5, bands: [] }), null, 'a rate the mix needs is unknown');
});

test('the warning: which speed configs ran the paired tasks, against the fastest one', async () => {
    const L = await loadLb();
    const { g30, g42 } = fnRow();
    // a task run at both: it counts as not (all) at the fastest
    g42.tasks.s0 = cell(480, speed(RB42.lo, RB42.hi));
    const row = L.mergeTasks([g30.tasks, g42.tasks]);
    const f = L.fastSpeedOf(row, [g30, g42]);
    const ids = Object.keys(row);
    const w = L.speedConfigShare(f, ids);
    assert.deepStrictEqual([w.n, w.atFastest, w.others.length], [23, 3, 1]);
    assert.strictEqual(w.others[0].g, g30);
    assert.strictEqual(w.others[0].tasks, 20);
    assert.strictEqual(w.others[0].req, 20 * 25);
    assert.strictEqual(f.tasks.s0.how, 'estimated', 'its rb30 run re-priced, its rb42 run as measured, weighted by passes');
    assert.deepStrictEqual(L.speedConfigShare(null, ids), { n: 0, atFastest: 0, others: [] }, 'no rates (a cloud row): nothing to warn about');
});

test('a row with ONE speed config: the estimate is the measurement, and there is no warning', async () => {
    const L = await loadLb();
    const only = group('only', Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`t${i}`, cell(100 * (i + 1), speed(RB42.lo, RB42.hi))])));
    const other = group('other', Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`t${i}`, cell(150 * (i + 1), speed(RB30.lo, RB30.hi))])));
    const fa = L.fastSpeedOf(only.tasks, [only]), fb = L.fastSpeedOf(other.tasks, [other]);
    assert.strictEqual(fa.fastest.g, only);
    for (const [id, c] of Object.entries(only.tasks)) { assert.strictEqual(fa.tasks[id].wall_s, c.wall_s); assert.strictEqual(fa.tasks[id].how, 'measured'); }
    const asRun = L.compareRows(only, other).speed, est = L.compareRows({ tasks: fa.tasks }, { tasks: fb.tasks }).speed;
    for (const k of ['n', 'medA', 'medB', 'ratio', 'aFaster', 'bFaster']) assert.strictEqual(est[k], asRun[k], k);
    assert.deepStrictEqual(asRun.ids, Object.keys(only.tasks), 'the paired tasks are listed (the page asks which configs ran them)');
    const w = L.speedConfigShare(fa, asRun.ids);
    assert.strictEqual(w.atFastest, w.n);
    assert.deepStrictEqual(w.others, []);
    // compareMany carries its paired ids too
    assert.deepStrictEqual(L.compareMany([only, other, only]).speed.ids, Object.keys(only.tasks));
});

test('speedOf / mergeTasks: the band sums ride along only where a cell has them; SPEED_BANDS matches lib/tps.js', async () => {
    const L = await loadLb();
    const tpsLib = require('../lib/tps');
    assert.strictEqual(tpsLib.SPEED_BAND_SPLIT, 30000);
    assert.match(L.SPEED_BANDS[0].label, /<30k/);
    assert.match(L.SPEED_BANDS[1].label, /30k/);
    const s1 = speed(RB30.lo, RB30.hi), old = { pn: 100, pms: 1000, gn: 10, gms: 1000, req: 1, runs: 1, of: 1 };
    const m = L.mergeTasks([{ t: cell(10, s1) }, { t: cell(20, s1) }]);
    assert.strictEqual(m.t.speed.rq1, 40);
    assert.strictEqual(L.mergeTasks([{ t: cell(10, old) }, { t: cell(20, old) }]).t.speed.rq0, undefined, 'an old cell keeps its shape');
    const sp = L.speedOf(m);
    close(sp.bands[0].pp, 300); close(sp.bands[1].tg, 40);
    assert.strictEqual(sp.bands[1].req, 40);
});

test('relIndexOf: a task map placed on a fitted relative-time scale reads as the fit would', async () => {
    const L = await loadLb();
    const T = ['a', 'b', 'c', 'd', 'e', 'f'];
    const g = (key, f) => ({ key, tasks: Object.fromEntries(T.map((t, i) => [t, cell(f * (100 + 50 * i))])) });
    const groups = [g('x', 1), g('y', 2), g('z', 4)];
    const rel = L.relSolveTimes(groups);
    const y = L.relIndexOf(rel, groups[1].tasks);
    close(y.index, rel.get('y').index, 1e-6);
    assert.strictEqual(y.tasks, 6);
    close(L.relIndexOf(rel, g('h', 3).tasks).index / rel.get('x').index, 3, 1e-6);
    assert.strictEqual(L.relIndexOf(new Map(), groups[0].tasks), null, 'no fit behind the map');
});
