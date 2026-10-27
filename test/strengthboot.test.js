'use strict';
// Strength ranges from a cluster bootstrap (2026-10-25, Kyle: "Yes run the bootstrap"): ui/shared/leaderboard.js
// (taskGroupOf, bootDraw, bootGroups, strengthBootstrap, bootstrapPayload, applyBootstrap, strengthGap, the fitFor hook)
// and lib/strengthboot.js (the server's timer, the child process, the cache the catalog builds attach). Also the ONE item
// response function (itemP / pSolve) every pass probability now goes through.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const loadLb = () => import('../ui/shared/leaderboard.js');
const SB = require('../lib/strengthboot');

// ---- a small catalog: 8 models (one with two configs), 16 base tasks, some at L3, some with a +bonus test, a
// -staletests twin and a sample group; outcomes from a 2PL world with a fixed pseudo-random stream
const sig = (z) => 1 / (1 + Math.exp(-z));
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
const cell = (credit, attempts = 1) => ({ attempts, passes: credit * attempts, credit, excluded: false, solved: credit > 0, wall_s: 60, tokens_out: 1000 });
const BASES = Array.from({ length: 16 }, (_, i) => 'task' + i);
const PROBLEMS = [...BASES, 'task0@L3', 'task1@L3', 'task2@L3', 'task0+bonus', 'task3+bonus', 'task0@L3+bonus', 'task4-staletests', 'task5-v2'];
const TASK_META = { task5: { sample_group: 'sg5' }, 'task5-v2': { sample_group: 'sg5' } };
function catalog({ seed = 7, models = 8, extra = null } = {}) {
    const r = rng(seed), diff = (p) => -2 + 4 * ((PROBLEMS.indexOf(p) * 7) % PROBLEMS.length) / PROBLEMS.length;
    const out = [];
    for (let m = 0; m < models; m++) {
        const th = -1.5 + 3 * m / (models - 1);
        const cfgs = m === 3 ? [131072, 65536] : [131072];
        const configs = cfgs.map((ctx, ci) => {
            const tasks = {};
            for (const p of PROBLEMS) { if (ci === 1 && PROBLEMS.indexOf(p) % 3) continue; tasks[p] = cell(r() < sig(th - diff(p)) ? 1 : 0); }
            return { n_ctx: ctx, facets: { weights: 'm' + m, context: { n_ctx: ctx, flags: ['-c ' + ctx] }, harness: { runner: 'opencode' } },
                agg: { attempted: Object.keys(tasks).length, scored: Object.keys(tasks).length }, tasks, dirs: [`dir-m${m}-${ctx}`] };
        });
        out.push({ key: 'm' + m, display: 'Model ' + m, provider: 'local', counts: { qualityTasks: PROBLEMS.length }, quality: {}, configs });
    }
    if (extra) out.push(extra);
    return { models: out, taskMeta: TASK_META };
}
const view = (L) => L.overviewView({ store: { getItem: () => null } });
const fitOf = (L, cat) => { const v = view(L); return L.fitFor(L.overviewCatalog(cat, v).models, v.keepQ, v.keepT); };
const VIEW = (L) => { const v = view(L); return { tensorRows: 'combine', fileQuality: 'merge', keepQ: v.keepQ, credit: 'binary' }; };
async function payloadFor(L, cat, { B = 24, seed = 11 } = {}) {
    const fit = fitOf(L, cat);
    const boot = L.strengthBootstrap(fit.qAll, { B, seed, taskMeta: cat.taskMeta });
    return L.bootstrapPayload(fit, boot, { view: VIEW(L), at: '2026-10-25T12:00:00.000Z' });
}

test('taskGroupOf: a task\'s prompt levels, +bonus test, -staletests twin, sample group and a composite\'s level copy are one group', async () => {
    const L = await loadLb();
    const g = L.taskGroupOf({ ...TASK_META, 'multi-x': {}, 'clubapp-a': { sample_group: 'sgA' }, 'clubapp-a-avoid': { sample_group: 'sgA' } });
    for (const p of ['task0', 'task0@L3', 'task0+bonus', 'task0@L3+bonus']) assert.equal(g(p), 'task0', p);
    assert.equal(g('task4-staletests'), 'task4');
    assert.equal(g('task4-staletests@L3'), 'task4');
    assert.equal(g('task5'), 'sg:sg5');
    assert.equal(g('task5-v2'), 'sg:sg5');
    assert.equal(g('clubapp-a-avoid@L3'), 'sg:sgA');
    assert.equal(g('multi-x-L3'), 'multi-x', 'a composite filed at L3 under its own name joins its L2 group');
    assert.equal(g('lone-L3'), 'lone-L3', 'a name ending -L3 with no such base task stays itself');
    assert.equal(g('task6'), 'task6');
});

test('bootDraw: Poisson(1) counts, fixed by (seed, refit, group) alone', async () => {
    const L = await loadLb();
    let n0 = 0, sum = 0; const N = 20000;
    for (let i = 0; i < N; i++) { const k = L.bootDraw(1, i, 'g' + (i % 97)); sum += k; if (k === 0) n0++; }
    assert.ok(Math.abs(sum / N - 1) < 0.03, `mean ${sum / N}`);
    assert.ok(Math.abs(n0 / N - Math.exp(-1)) < 0.015, `P(0) ${n0 / N}`);
    assert.equal(L.bootDraw(5, 3, 'task1'), L.bootDraw(5, 3, 'task1'));
    const seq = (seed) => Array.from({ length: 40 }, (_, b) => L.bootDraw(seed, b, 'task1')).join(',');
    assert.notEqual(seq(5), seq(6), 'another seed, other draws');
});

test('bootGroups: every version of a task moves together -- the same count, renamed copies that keep level and bonus', async () => {
    const L = await loadLb();
    const cat = catalog(), fit = fitOf(L, cat), groupOf = L.taskGroupOf(cat.taskMeta);
    let seenMulti = false, seenZero = false;
    for (let b = 0; b < 30; b++) {
        const G = L.bootGroups(fit.qAll, b, { seed: 3, groupOf });
        for (const [gi, g] of G.entries()) {
            const orig = fit.qAll[gi];
            // count each original problem's copies in this refit
            const copies = new Map();
            for (const id of Object.keys(g.tasks)) {
                const p = L.problemOf(id), m = /^(.*)~(\d+)$/.exec(p.base);
                const back = m ? L.problemId(m[1] + (p.bonus ? '+bonus' : ''), p.level) : id;
                assert.ok(orig.tasks[back], `${id} is a copy of ${back}, a problem the row ran`);
                assert.equal(g.tasks[id], orig.tasks[back], 'a copy carries the same result');
                copies.set(back, (copies.get(back) || 0) + 1);
            }
            const byGroup = new Map();
            for (const p of Object.keys(orig.tasks)) {
                const k = copies.get(p) || 0, grp = groupOf(p);
                if (byGroup.has(grp)) assert.equal(k, byGroup.get(grp), `refit ${b}: ${p} drawn ${k} times, its group ${grp} ${byGroup.get(grp)}`);
                byGroup.set(grp, k);
                assert.equal(k, L.bootDraw(3, b, grp));
                if (k > 1) seenMulti = true; if (k === 0) seenZero = true;
            }
        }
    }
    assert.ok(seenMulti && seenZero, 'some groups drawn twice or more, some not at all');
    // T~2@L3 / T~2+bonus parse as the level / bonus problems they copy
    const L3 = L.problemOf(L.problemId('task0~2+bonus', 'L3'));
    assert.deepEqual([L3.level, L3.bonus, L3.base], ['L3', true, 'task0~2']);
});

test('strengthBootstrap: the same seed gives the same payload, bit for bit; another seed does not', async () => {
    const L = await loadLb();
    const a = await payloadFor(L, catalog()), b = await payloadFor(L, catalog());
    assert.deepEqual(a, b);
    const c = await payloadFor(L, catalog(), { seed: 12 });
    assert.notDeepEqual(a.rows.map((r) => r.d), c.rows.map((r) => r.d));
    assert.equal(a.B, 24); assert.equal(a.v, L.BOOT.VERSION);
    assert.ok(a.groups > 0 && a.groups < a.problems, `${a.groups} task groups over ${a.problems} problems`);
    for (const r of a.rows) {
        assert.equal(r.d.length, 24);
        assert.ok(r.q[0] <= r.q[1] && r.q[1] <= r.q[2], 'quantiles in order');
        assert.equal(r.present, 24, 'a refit that drew none of a row\'s tasks still gives it a strength (its model + facets)');
    }
    assert.ok(a.models.length >= 8);
});

test('fallback: no bootstrap -> every number is the analytic fit\'s, and the range says so', async () => {
    const L = await loadLb();
    const cat = catalog();
    const plain = L.fitFor(cat.models, L.FACET_DEFAULTS.quality, L.FACET_DEFAULTS.full);   // not through overviewCatalog: untouched
    const fit = fitOf(L, cat);
    for (const [k, a] of fit.adj) {
        if (!a) continue;
        const p = plain.adj.get(k);
        for (const f of ['rate', 'lo', 'hi', 'strength', 'theta', 'coverage', 'n']) assert.equal(a[f], p[f], `${k} ${f}`);
        assert.equal(a.range.source, 'analytic');
        assert.match(a.range.why, /no strength bootstrap/);
        assert.match(L.rangeNote(a), /posterior \(analytic/);
    }
    for (const [, m] of fit.adj.models) assert.equal(m.range.source, 'analytic');
    // a gap without a bootstrap: both shown ranges, as if independent
    const keys = fit.qAll.map((g) => g.key);
    const g = L.strengthGap(fit, keys[0], keys[keys.length - 1]);
    assert.equal(g.source, 'independent');
    assert.ok(g.lo < g.gap && g.gap < g.hi);
});

test('applied: strength untouched, each end the wider of bootstrap and posterior + shared drift, a new row analytic, another view analytic', async () => {
    const L = await loadLb();
    const cat0 = catalog(), pay = await payloadFor(L, cat0);
    const plain = fitOf(L, catalog());
    const cat = { ...catalog(), strengthBootstrap: pay };
    const fit = fitOf(L, cat);
    assert.ok(fit.boot && fit.boot.B === 24);
    let boot = 0;
    for (const [k, a] of fit.adj) {
        if (!a) continue;
        const p = plain.adj.get(k), r = pay.rows.find((x) => x.key === k);
        assert.equal(a.strength, p.strength); assert.equal(a.theta, p.theta);
        assert.equal(a.loAnalytic, p.lo); assert.equal(a.hiAnalytic, p.hi);
        const bLo = Math.max(0, a.strength - (r.q[1] - r.q[0])), bHi = Math.min(100, a.strength + (r.q[2] - r.q[1]));
        const [dLo, dHi] = L.driftAt(pay.drift, a.strength);
        const pLo = Math.max(0, a.strength - Math.hypot(a.strength - p.lo * 100, dLo)), pHi = Math.min(100, a.strength + Math.hypot(p.hi * 100 - a.strength, dHi));
        assert.ok(Math.abs(a.lo * 100 - Math.min(bLo, pLo)) < 1e-9 && Math.abs(a.hi * 100 - Math.max(bHi, pHi)) < 1e-9, k);
        assert.ok(a.lo <= p.lo && a.hi >= p.hi, 'never narrower than the posterior');
        assert.ok(a.lo < a.rate && a.rate < a.hi);
        assert.equal(a.range.stale, false);
        if (a.range.source === 'bootstrap') boot++;
    }
    assert.ok(boot > 0, 'some rows take the bootstrap range');
    // the drift curve: on the 0..100 grid, non-negative, and driftAt interpolates it
    assert.equal(pay.drift.s.length, 21); assert.ok(pay.drift.lo.every((x) => x >= 0) && pay.drift.hi.every((x) => x >= 0));
    const [l50] = L.driftAt(pay.drift, 50), [l52] = L.driftAt(pay.drift, 52), [l55] = L.driftAt(pay.drift, 55);
    assert.ok(Math.abs(l52 - (l50 + 0.4 * (l55 - l50))) < 1e-12);
    assert.deepEqual(L.driftAt(null, 40), [0, 0]);
    // a row the bootstrap never saw: analytic, "new since"
    const extra = { key: 'newbie', display: 'Newbie', provider: 'local', counts: { qualityTasks: 5 }, quality: {},
        configs: [{ n_ctx: 131072, facets: { weights: 'newbie', context: { n_ctx: 131072, flags: ['-c 131072'] }, harness: { runner: 'opencode' } },
            agg: { attempted: 5, scored: 5 }, tasks: Object.fromEntries(BASES.slice(0, 5).map((t) => [t, cell(1)])), dirs: ['dir-newbie'] }] };
    const fit2 = fitOf(L, { ...catalog({ extra }), strengthBootstrap: pay });
    const nk = fit2.qAll.find((g) => g.m.key === 'newbie').key;
    assert.equal(fit2.adj.get(nk).range.source, 'analytic');
    assert.match(fit2.adj.get(nk).range.why, /new since the last bootstrap/);
    // another grouping of the rows (other chips): the bootstrap is for the default view only
    const v = view(L), shown = L.overviewCatalog(cat, v);
    const other = L.fitFor(shown.models, v.keepQ.filter((k) => k !== 'kv'), v.keepT);
    for (const [, a] of other.adj) if (a) { assert.equal(a.range.source, 'analytic'); assert.match(a.range.why, /default row settings/); }
    // a row with results newer than the bootstrap keeps the bootstrap's spread around its current strength, marked stale
    const cat3 = catalog(); cat3.models[0].configs[0].tasks.task1 = cell(1, 2);
    const fit3 = fitOf(L, { ...cat3, strengthBootstrap: pay });
    const k0 = fit3.qAll.find((g) => g.m.key === 'm0').key;
    assert.equal(fit3.adj.get(k0).range.stale, true);
    assert.match(L.rangeNote(fit3.adj.get(k0)), /newer than the bootstrap/);
});

test('strengthGap: the shared drift cancels, the gap is antisymmetric, a thin row\'s posterior shortfall is added', async () => {
    const L = await loadLb();
    const cat = catalog(), fit0 = fitOf(L, cat);
    const ka = fit0.qAll.find((g) => g.m.key === 'm6').key, kb = fit0.qAll.find((g) => g.m.key === 'm5').key;
    // a hand-made payload: both rows move together by up to +-25 points refit to refit (a shared drift wider than their
    // posteriors, so the bootstrap sets both ranges), and differ by a small noise of their own
    const B = 200, r = rng(3), drift = Array.from({ length: B }, () => (r() - 0.5) * 50), own = () => Array.from({ length: B }, () => (r() - 0.5) * 2);
    const sA = fit0.adj.get(ka).strength, sB = fit0.adj.get(kb).strength;
    const mk = (key, s, noise) => { const d = drift.map((x, i) => s + x + noise[i]); const sorted = [...d].sort((x, y) => x - y);
        return { key, rec: L.bootRecord(fit0.qAll.find((g) => g.key === key).tasks), s0: s, present: B, q: [0.025, 0.5, 0.975].map((p) => L.quantileSorted(sorted, p)), d: d.map((x) => Math.round(x * 10)) }; };
    const pay = { v: L.BOOT.VERSION, at: '2026-10-25T12:00:00.000Z', B, seed: 1, groups: 10, problems: 20, view: VIEW(L), rows: [mk(ka, sA, own()), mk(kb, sB, own())], models: [], thin: [] };
    const fit = fitOf(L, { ...catalog(), strengthBootstrap: pay });
    const g = L.strengthGap(fit, ka, kb), h = L.strengthGap(fit, kb, ka);
    assert.equal(g.source, 'bootstrap');
    assert.ok(Math.abs(g.gap - (sA - sB)) < 1e-12, 'the gap is the full-data gap');
    const wA = (fit.adj.get(ka).hi - fit.adj.get(ka).lo) * 100, wGap = g.hi - g.lo;
    assert.ok(wGap < wA / 2, `the gap's range (${wGap.toFixed(2)}) is far narrower than a row's (${wA.toFixed(2)}): the drift cancelled`);
    assert.ok(Math.abs(g.gap + h.gap) < 1e-12 && Math.abs(g.lo + h.hi) < 0.2 && Math.abs(g.hi + h.lo) < 0.2, 'B - A mirrors A - B');
    assert.equal(g.resolved, g.lo > 0 || g.hi < 0);
    assert.ok(g.ahead >= 0 && g.ahead <= 1);
    // a row whose posterior is wider than its bootstrap: its shortfall widens the gap's range
    const narrow = { ...pay, rows: [mk(ka, sA, own()), { ...mk(kb, sB, own()), q: [sB - 0.01, sB, sB + 0.01] }] };
    const fitN = fitOf(L, { ...catalog(), strengthBootstrap: narrow });
    assert.deepEqual(fitN.adj.get(kb).range.parts, { lo: 'posterior', hi: 'posterior' }, 'its own range is its posterior');
    const gN = L.strengthGap(fitN, ka, kb);
    assert.ok(gN.hi - gN.lo > wGap + 1, 'the posterior shortfall widens the gap');
    // a model row the bootstrap has: by weights key
    const pay2 = await payloadFor(L, catalog());
    const fit2 = fitOf(L, { ...catalog(), strengthBootstrap: pay2 });
    const gm = L.strengthGap(fit2, 'm7', 'm0');
    assert.equal(gm.source, 'bootstrap');
    assert.ok(gm.gap > 0);
    assert.equal(L.strengthGap(fit2, 'm7', 'no-such-model'), null);
    // from the fit's maps alone (a board holds adj): the same answer
    assert.deepEqual(L.strengthGap(fit2.adj, 'm7', 'm0'), gm);
    // a board's strength cells ask the gap for "=" (groupMetrics -> strengthMetric sepFrom)
    const g0 = fit2.qAll.find((x) => x.m.key === 'm7'), g1 = fit2.qAll.find((x) => x.m.key === 'm0');
    const c0 = L.groupMetrics(g0, null, fit2.adj).metrics.adjSolveRate.ci, c1 = L.groupMetrics(g1, null, fit2.adj).metrics.adjSolveRate.ci;
    assert.equal(c0.sepFrom(c1), L.strengthGap(fit2, g0.key, g1.key).resolved);
});

test('itemP / pSolve: the one P(solve), the same number every reader computed before', async () => {
    const L = await loadLb();
    const fit = fitOf(L, catalog()), A = fit.adj;
    const old = (a, d, th) => 1 / (1 + Math.exp(-(a * (th - (d + A.meanB)))));   // lib/liveodds.js's formula until 10-25
    for (const [t, d] of A.taskDifficulty) for (const th of [-2, -0.3, 0, 1.7]) {
        const a = A.taskDiscrimination.get(t) || 1;
        assert.equal(L.pSolve(A, th, t), old(a, d, th), t);
        assert.equal(L.itemP(a, d + A.meanB, th), sig(a * (th - (d + A.meanB))));
        assert.equal(L.itemLogP(a, d, th), -Math.log1p(Math.exp(-(a * (th - d)))));
        assert.equal(L.itemLog1mP(a, d, th), -Math.log1p(Math.exp(a * (th - d))));
    }
    assert.equal(L.pSolve(A, 0, 'no-such-task'), null);
    assert.equal(L.ITEM_MODEL, '2PL');
    const P = await import('../ui/shared/planner.js');
    assert.equal(P.passProb({ theta: 0.4 }, { id: 't', b: -0.2, a: 1.3 }), 1 / (1 + Math.exp(-(1.3 * (0.4 - -0.2)))));
});

// ---- lib/strengthboot.js
test('decide: a run only when the inputs moved, none is running and the last started MIN_GAP ago', () => {
    const base = { running: false, inputs: 'i2', lastInputs: 'i1', lastStartAt: 0, now: 31 * 60e3, minGapMs: 30 * 60e3, haveCache: true };
    assert.equal(SB.decide(base), 'run');
    assert.equal(SB.decide({ ...base, running: true }), 'running');
    assert.equal(SB.decide({ ...base, inputs: null }), 'no-catalog');
    assert.equal(SB.decide({ ...base, lastInputs: 'i2' }), 'seen');
    assert.equal(SB.decide({ ...base, now: 10 * 60e3 }), 'wait');
    assert.equal(SB.decide({ ...base, lastStartAt: null }), 'run', 'after a restart');
    assert.equal(SB.decide({ ...base, lastInputs: 'i2', haveCache: false }), 'run', 'no cache yet: a failed run is retried');
});

test('childCommand: nice 19, idle I/O when there is ionice, node single-threaded', () => {
    const c = SB.childCommand({ node: '/x/node', file: '/x/sb.js', haveIonice: true });
    assert.deepEqual(c.args, ['-n', '19', '/usr/bin/ionice', '-c', '3', '/x/node', '--single-threaded', '/x/sb.js', '--child']);
    assert.deepEqual(SB.childCommand({ node: '/x/node', file: '/x/sb.js', haveIonice: false }).args, ['-n', '19', '/x/node', '--single-threaded', '/x/sb.js', '--child']);
});

test('the child end to end (B = 6): runs niced, its payload is cached, attached to a catalog, and an unchanged catalog is not redone', async () => {
    const L = await loadLb();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sboot-'));
    const file = path.join(dir, 'strength-bootstrap.json');
    try {
        const cat = catalog();
        const body = Buffer.from(JSON.stringify({ ...cat, generatedAt: 1, strengthBootstrap: { v: 1, rows: [], models: [] } }));
        let done = null; const logs = [];
        const sb = SB.createStrengthBoot({ catalog: () => ({ body, inputs: 'sig-1' }), onDone: (p) => { done = p; }, file, B: 6, firstDelayMs: 0, log: (m) => logs.push(m) });
        assert.equal(await sb.tick(), 'run');
        assert.ok(done, logs.join('\n'));
        assert.equal(done.B, 6);
        if (fs.existsSync('/usr/bin/nice')) assert.equal(done.nice, 19, 'the child ran at nice 19');
        assert.ok(done.cpuMs >= 0 && done.wallMs >= 0 && done.fp && done.inputs);
        const cached = JSON.parse(fs.readFileSync(file, 'utf8'));
        assert.deepEqual(cached.rows, done.rows);
        // the same payload as the in-process function gives (determinism across processes)
        const direct = await SB.runBootstrap(cat, { B: 6, L });
        assert.deepEqual(direct.rows, cached.rows);
        assert.deepEqual(direct.models, cached.models);
        // attach: what the catalog builds do
        const c2 = SB.attach({ models: [] }, file);
        assert.equal(c2.strengthBootstrap.fp, done.fp);
        assert.equal(SB.attach({ models: [] }, path.join(dir, 'none.json')).strengthBootstrap, undefined);
        // the same inputs again: nothing to do; new inputs but the same rows: the child stops after one fit
        assert.equal(await sb.tick(), 'seen');
        const sb2 = SB.createStrengthBoot({ catalog: () => ({ body, inputs: 'sig-2' }), onDone: () => { throw new Error('not redone'); }, file, B: 6, minGapMs: 0, firstDelayMs: 0, log: (m) => logs.push(m) });
        assert.equal(await sb2.tick(), 'run');
        assert.match(logs[logs.length - 1], /unchanged/);
        assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).fp, done.fp);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
