// Auto queue: the planner's scoring (ui/shared/planner.js, pure ESM), the catalog adapter
// (ui/autoqueue/derive.js) and the server half (lib/autoqueue.js: settings, chaining, script generation,
// dry-run enqueue, pending runs of live queues, EXPERIMENTS.md backlog). Nothing here starts a process.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

let uiDir = null;
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'autoqueue-test-'));
process.env.AUTOQUEUE_SETTINGS = path.join(TMP, 'autoqueue.json');
process.env.AUTOQUEUE_BATCHES = path.join(TMP, 'autoqueue-batches.json');
const AQ = require('../lib/autoqueue.js');
test.after(() => { fs.rmSync(TMP, { recursive: true, force: true }); if (uiDir) fs.rmSync(uiDir, { recursive: true, force: true }); });

// The browser modules import each other by relative path: load a copy of the ui/ tree as ESM.
async function ui(rel) {
    if (!uiDir) {
        uiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-aq-'));
        fs.cpSync(path.join(__dirname, '..', 'ui'), path.join(uiDir, 'ui'), { recursive: true });
        fs.writeFileSync(path.join(uiDir, 'package.json'), JSON.stringify({ type: 'module' }));
    }
    return import(`file://${path.join(uiDir, 'ui', rel)}`);
}
const P = () => ui('shared/planner.js');

// ---------------------------------------------------------------- synthetic planner input
function model(id, theta, se, extra = {}) {
    return { id, label: id, role: 'contender', lane: 'local', theta, se, fitted: true, n: 30, relTime: 1, available: true, hist: {}, cfg: {}, ...extra };
}
function task(id, b, se = 0.5, extra = {}) {
    return { id, b, se, tried: true, nStrong: 3, strongPasses: 2, solveMin: 10, failMin: 30, capMin: 120, ...extra };
}
const base = (over = {}) => ({ budget: { localHours: 8, cloud: true, cloudHours: 2, switchMin: 5 }, minValue: 0, ...over });

test('planner: Fisher information p(1-p), discounted per earlier attempt of the same pair', async () => {
    const { fisherInfo, varianceReduction } = await P();
    assert.strictEqual(fisherInfo(0.5), 0.25);
    assert.ok(Math.abs(fisherInfo(0.9) - 0.09) < 1e-12);
    assert.ok(Math.abs(fisherInfo(0.5, 1, 0.3) - 0.075) < 1e-12, 'one earlier attempt: x0.3');
    assert.ok(Math.abs(fisherInfo(0.5, 2, 0.3) - 0.0225) < 1e-12, 'two: x0.09');
    assert.ok(varianceReduction(0.25, 1) > varianceReduction(0.25, 0.3), 'the same run removes more of a WIDE interval');
});

test('planner: overlap is 1 for identical abilities and falls as they separate', async () => {
    const { overlap } = await P();
    assert.ok(Math.abs(overlap({ theta: 1, se: 0.5 }, { theta: 1, se: 0.5 }) - 1) < 1e-6);
    const near = overlap({ theta: 1, se: 0.5 }, { theta: 1.3, se: 0.5 });
    const far = overlap({ theta: 1, se: 0.5 }, { theta: 3, se: 0.5 });
    assert.ok(near > 0.7 && far < 0.1, `near ${near}, far ${far}`);
    assert.strictEqual(overlap({ theta: 0, se: 1 }, { theta: 2, se: 0.2 }), overlap({ theta: 2, se: 0.2 }, { theta: 0, se: 1 }));
});

test('planner: TOP weighting — a model tangled with the leader is worth more than a separated one', async () => {
    const { plan } = await P();
    // leader L; A overlaps it heavily, B is far below. Same cost, same task difficulty relative to each.
    const input = { models: [model('L', 2, 0.3), model('A', 1.9, 0.6), model('B', -1, 0.6)],
        tasks: [task('tA', 1.9), task('tB', -1)] };
    const s = base({ scoring: 'legacy', weights: { top: 1, speed: 0, difficulty: 0 }, topK: 3 });   // the legacy TOP objective
    const out = plan(input, s);
    const first = out.legs[0];
    assert.strictEqual(first.model, 'A', 'the first leg goes to the model whose interval overlaps the leader');
    assert.match(first.runs[0].reason, /separates A from L \(overlap \d+%\)/);
});

test('planner: with "include re-runs" on, a repeat of the same (model, task) pair is discounted', async () => {
    const { plan } = await P();
    const input = { models: [model('L', 2, 0.3), model('A', 1.9, 0.6, { hist: { t1: { attempts: 2, passes: 1 } }, cfg: { t1: { ran: true, passed: true } } })],
        tasks: [task('t1', 1.9), task('t2', 1.9)] };
    const out = plan(input, base({ rerunScored: true, weights: { top: 1, speed: 0, difficulty: 0 }, topK: 2, budget: { localHours: 3, cloud: false, cloudHours: 0, switchMin: 0 } }));
    const legA = out.legs.find((l) => l.model === 'A');
    assert.strictEqual(legA.runs[0].task, 't2', 'the fresh task comes before the twice-run one');
    const rep = legA.runs.find((r) => r.task === 't1');
    assert.ok(rep, 'with re-runs on and the budget for it, the scored task is proposed again');
    assert.match(rep.reason, /repeat #3/);
    assert.strictEqual(rep.rerun, true, 'marked as a wanted re-run (the server guard keeps it)');
    assert.strictEqual(legA.runs[0].rerun, undefined);
});

// One run per task per config (2026-10-14, Kyle: "yes, let's avoid previously done tests by default").
test('planner: by default a task the config already ran is never proposed for it again (greedy, any objective)', async () => {
    const { plan, scoreAll, PLANNER_DEFAULTS, withDefaults } = await P();
    assert.strictEqual(PLANNER_DEFAULTS.rerunScored, false, 'off by default');
    const A = model('A', 1.9, 0.6, { hist: { t1: { attempts: 1, passes: 0 }, t3: { attempts: 1, passes: 1 } }, cfg: { t1: { ran: true, passed: false }, t3: { ran: true, passed: true } } });
    // hist without cfg: the task ran at ANOTHER config of the model (a different context): that is not this config
    const B = model('B', 1.8, 0.6, { hist: { t2: { attempts: 1, passes: 1 } }, cfg: {} });
    const input = { models: [model('L', 2, 0.3), A, B], tasks: [task('t1', 1.9), task('t2', 1.9), task('t3', 1.9), task('t4', 1.9, 1.2, { nStrong: 0 })] };
    for (const w of [{ top: 1, speed: 0, difficulty: 0 }, { top: 0, speed: 0, difficulty: 1 }, { top: 1, speed: 0.6, difficulty: 0.8 }]) {
        const out = plan(input, base({ weights: w, topK: 3, budget: { localHours: 40, cloud: false, cloudHours: 0, switchMin: 0 } }));
        const legA = out.legs.find((l) => l.model === 'A') || { runs: [] };
        assert.deepStrictEqual(legA.runs.map((r) => r.task).filter((t) => t === 't1' || t === 't3'), [], `weights ${JSON.stringify(w)}: A's scored tasks stay out`);
        assert.ok(out.legs.every((l) => l.runs.every((r) => !r.rerun)), 'nothing is a re-run');
    }
    // the candidate list itself
    const ctx = { models: input.models.map((m) => ({ ...m, se2: m.se * m.se, pendingSet: new Set() })), tasks: input.tasks.map((t) => ({ ...t, se2: t.se * t.se })),
        flaggedSet: new Set(), byId: new Map(), top: [], topSet: new Set(), thetaTop: 2, solvedBy: new Map(), shared: new Map() };
    const pairs = (s) => scoreAll(ctx, withDefaults(s)).map((c) => `${c.model}:${c.task}`);
    const off = pairs({});
    assert.ok(!off.includes('A:t1') && !off.includes('A:t3'));
    assert.ok(off.includes('A:t2') && off.includes('A:t4') && off.includes('B:t2') && off.includes('L:t1'), 'other configs and fresh tasks are still candidates');
    const on = pairs({ rerunScored: true });
    assert.ok(on.includes('A:t1') && on.includes('A:t3'), '"include re-runs" brings them back');
});

test('planner: a pin\'s "rerun" still works with re-runs off, and marks its re-runs for the server guard', async () => {
    const { plan } = await P();
    const input = { models: [model('L', 2, 0.3), model('P', 0, 1, { cfg: { t1: { ran: true, passed: false } } })], tasks: [task('t1', 1), task('t2', 1)] };
    const rr = plan(input, base({ topK: 2, pins: [{ model: 'P', tasks: ['t1', 't2'], rerun: true }] }));
    const pinned = rr.legs[0].runs.filter((r) => r.pinned);
    assert.deepStrictEqual(pinned.map((r) => [r.task, !!r.rerun]), [['t1', true], ['t2', false]]);
});

test('planner on the folded catalog: a task scored on a tensor-split row or an f32ssm copy is not proposed for the base config', async () => {
    const { derive, plannerCatalog } = await ui('autoqueue/derive.js');
    const { plan } = await P();
    const { tk, cfg, mk } = foldFixture();
    const raw = { allTaskIds: ['a', 'b', 'c', 'd', 'e', 'f'], taskMeta: {}, models: [
        mk(Q6, [cfg('llama-local/q6-128k', { a: tk(1) })]),
        mk(`${Q6}~rv:tensor-split-two-xtx`, [cfg('llama-local/q6-128k', { b: tk(1), c: tk(0) })]),
        mk(IQ2XS, [cfg('llama-local/gsq-80k', { d: tk(1) }, 81920)]),
        mk(IQ2XS_COPY, [cfg('llama-local/gsq-80k', { a: tk(0), e: tk(1) }, 81920)]),
        mk('local:other', [cfg('llama-local/other', { a: tk(1), b: tk(0), c: tk(1), d: tk(0), e: tk(1), f: tk(0) })]),
    ] };
    const settings = { models: [
        { id: 'q27-q6', catalogKey: Q6, role: 'both', nCtx: 131072 },
        { id: 'iq2xs', catalogKey: IQ2XS, role: 'both', nCtx: 81920 },
        { id: 'other', catalogKey: 'local:other', role: 'ignored' },
    ] };
    const d = derive(plannerCatalog(raw), settings);
    const out = plan(d.input, base({ topK: 3, minValue: 0, weights: { top: 1, speed: 0.6, difficulty: 1 }, budget: { localHours: 100, cloud: false, cloudHours: 0, switchMin: 0 } }));
    const tasksOf = (id) => ((out.legs.find((l) => l.model === id) || { runs: [] }).runs.map((r) => r.task)).sort();
    for (const t of ['a', 'b', 'c']) assert.ok(!tasksOf('q27-q6').includes(t), `Q6_K_XL ${t}: scored (b, c on its tensor-split row)`);
    for (const t of ['a', 'd', 'e']) assert.ok(!tasksOf('iq2xs').includes(t), `IQ2_XS ${t}: scored (a, e on its f32ssm copy)`);
    assert.ok(tasksOf('q27-q6').length + tasksOf('iq2xs').length > 0, 'the unscored tasks are still offered');
});

test('planner: runs are batched into one leg per model; the switch penalty concentrates them', async () => {
    const { plan } = await P();
    const tasks = Array.from({ length: 6 }, (_, i) => task(`t${i}`, 1.5));
    const input = { models: [model('L', 2, 0.3), model('A', 1.5, 0.7), model('B', 1.5, 0.7)], tasks };
    const s = base({ weights: { top: 1, speed: 0, difficulty: 0 }, topK: 3, budget: { localHours: 1.2, cloud: false, cloudHours: 0, switchMin: 40 } });
    const out = plan(input, s);
    const ids = out.legs.map((l) => l.model);
    assert.strictEqual(new Set(ids).size, ids.length, 'never two legs for one model');
    assert.ok(out.legs.length <= 2, `a 40-minute switch keeps the batch on few models (got ${ids.join(',')})`);
    const minutes = out.legs.reduce((a, l) => a + l.minutes, 0) + out.legs.length * 40;
    assert.ok(minutes <= 1.2 * 60 + 1e-6, 'the budget (switches included) holds');
});

test('planner: pins go first, skip what already ran at the config unless rerun, and respect pending runs', async () => {
    const { plan } = await P();
    const input = { models: [model('L', 2, 0.3), model('A', 1.9, 0.6), model('P', 0, 1, { cfg: { t1: { ran: true, passed: false } }, pending: ['t3'] })],
        tasks: [task('t1', 1), task('t2', 1), task('t3', 1), task('t4', 1.9)] };
    const out = plan(input, base({ topK: 3, pins: [{ model: 'P', tasks: ['t1', 't2', 't3'], note: 'quant ladder' }] }));
    assert.strictEqual(out.legs[0].model, 'P', 'the pinned leg leads');
    assert.deepStrictEqual(out.legs[0].runs.filter((r) => r.pinned).map((r) => r.task), ['t2'], 't1 ran already, t3 is queued elsewhere');
    assert.match(out.legs[0].runs[0].reason, /pinned: quant ladder/);
    const rr = plan(input, base({ topK: 3, pins: [{ model: 'P', tasks: ['t1'], rerun: true }] }));
    assert.deepStrictEqual(rr.legs[0].runs.filter((r) => r.pinned).map((r) => r.task), ['t1']);
    // pending pairs are never proposed by the greedy pass either
    assert.ok(!out.legs.some((l) => l.model === 'P' && l.runs.some((r) => r.task === 't3')));
});

test('planner: the cascade preset runs each stage on what the previous stage failed', async () => {
    const { plan } = await P();
    const S = model('S', 0, 0.3, { lane: 'cloud', role: 'scout', cfg: { a: { ran: true, passed: false }, b: { ran: true, passed: true }, c: { ran: true, passed: false }, d: { ran: true, passed: false } } });
    const X = model('X', 1, 0.4, { cfg: { a: { ran: true, passed: true } } });     // already passed a -> a stops here
    const Y = model('Y', 2, 0.4, { available: false, unavailableReason: 'weights missing' });
    const Z = model('Z', 2.5, 0.4, { cfg: { c: { ran: true, passed: false } } });
    const input = { models: [S, X, Y, Z], tasks: [task('a', 0), task('b', 0), task('c', 5), task('d', -5)] };
    const out = plan(input, base({ strategy: 'cascade', cascade: { order: ['S', 'X', 'Y', 'Z'], minReach: 0.25 } }));
    assert.deepStrictEqual(out.cascade.seed.sort(), ['a', 'c', 'd'], 'the seed is what the first stage failed');
    const legX = out.legs.find((l) => l.model === 'X');
    assert.deepStrictEqual(legX.runs.map((r) => r.task).sort(), ['c', 'd'], 'X runs S\'s failures it has not run (a: already passed)');
    assert.strictEqual(legX.cascade, 1);
    assert.ok(!out.legs.some((l) => l.model === 'Y'), 'an unavailable stage runs nothing and passes everything on');
    const legZ = out.legs.find((l) => l.model === 'Z');
    // d: X predicted to pass it (theta 1 vs b -5), so it rarely reaches Z; c: Z already ran it
    assert.ok(!legZ || !legZ.runs.some((r) => r.task === 'd' || r.task === 'c'));
    assert.ok(out.legs.every((l) => l.runs.every((r) => /cascade stage \d/.test(r.reason))));
});

test('planner: tasks unsolved after N strong attempts are flagged for a validity check, not run', async () => {
    const { plan } = await P();
    const input = { models: [model('L', 2, 0.3), model('A', 1.9, 0.6)],
        tasks: [task('dead', 3, 0.5, { nStrong: 6, strongPasses: 0 }), task('ok', 1.9)] };
    const out = plan(input, base({ validity: { minStrong: 4, strongGap: 1 } }));
    assert.deepStrictEqual(out.flagged.map((f) => f.task), ['dead']);
    assert.match(out.flagged[0].reason, /unsolved after 6 strong attempts/);
    assert.ok(!out.legs.some((l) => l.runs.some((r) => r.task === 'dead')));
});

test('planner: family prior — thin quants start at their siblings, well-measured ones keep their fit', async () => {
    const { applyFamilyPrior } = await P();
    const out = applyFamilyPrior([
        model('q2', 2.0, 0.3, { family: 'flash', n: 34 }),
        model('iq4', 0.3, 1.4, { family: 'flash', n: 2 }),
        { ...model('q3', 0, 1.5, { family: 'flash', n: 0, priorShift: -0.2 }), fitted: false },
        model('solo', 1, 0.5, { family: 'other', n: 3 }),
    ], { tau: 0.5, enabled: true, minN: 12 });
    const [q2, iq4, q3, solo] = out;
    assert.strictEqual(q2.theta, 2.0, 'n >= minN: untouched');
    assert.ok(iq4.theta > 1.5 && iq4.se < 1.4, `IQ4 ~ Q2 prior: ${iq4.theta.toFixed(2)} ± ${iq4.se.toFixed(2)}`);
    assert.ok(Math.abs(q3.theta - (((2.0 / 0.09) + (0.3 / 1.96)) / (1 / 0.09 + 1 / 1.96) - 0.2)) < 1e-9, 'no data: siblings\' precision-weighted mean + shift');
    assert.strictEqual(solo.prior, 'none', 'no siblings, no shrink');
    const off = applyFamilyPrior([model('iq4', 0.3, 1.4, { family: 'flash', n: 2 }), model('q2', 2, 0.3, { family: 'flash' })], { enabled: false });
    assert.strictEqual(off[0].theta, 0.3);
});

test('planner: untried tasks default to hard with a wide interval; overrides are priors', async () => {
    const { applyTaskPriors } = await P();
    const [u, o, t] = applyTaskPriors([task('u', null, null, { tried: false }), task('o', null, null, { tried: false }), task('t', 0, 0.5)],
        { untriedB: 1.5, untriedSE: 1.5, taskB: { o: 3, t: 2 } });
    assert.deepStrictEqual([u.b, u.se, u.prior], [1.5, 1.5, 'untried']);
    assert.deepStrictEqual([o.b, o.prior], [3, 'override']);
    assert.ok(t.b > 0 && t.b < 2 && t.se < 0.5, 'data and override combine by precision');
});

test('planner: the cloud lane has its own budget and scouts take untried tasks', async () => {
    const { plan } = await P();
    const input = { models: [model('L', 2, 0.3), model('A', 1.9, 0.6), model('C', 1, 0.3, { lane: 'cloud', role: 'scout', relTime: 0.2 })],
        tasks: [task('new1', null, null, { tried: false, nStrong: 0 }), task('new2', null, null, { tried: false, nStrong: 0 }), task('k', 1.9)] };
    const out = plan(input, base({ budget: { localHours: 0, cloud: true, cloudHours: 1, switchMin: 5 }, weights: { top: 0, speed: 0, difficulty: 1 } }));
    assert.ok(out.legs.every((l) => l.lane === 'cloud'), 'no local budget, only the cloud lane runs');
    assert.ok(out.legs[0].runs.some((r) => /untried task/.test(r.reason)));
    assert.ok(out.totals.cloud.minutes <= 60 + 1e-6);
});

// ---------------------------------------------------------------- derive (catalog adapter)
test('derive: maps runnable configs to fitted groups, splits thinking-off, computes task SEs', async () => {
    const { derive, resolveTasks } = await ui('autoqueue/derive.js');
    const tk = (solved, wall = 300) => ({ status: solved ? 'pass' : 'fail', solved, excluded: false, credit: solved ? 1 : 0, attempts: 1, passes: solved ? 1 : 0, wall_s: wall, ran_at: 1 });
    const cfg = (runnerModel, tasks, n_ctx = 131072) => ({ key: runnerModel, runnerModel, n_ctx, timeout_s: 7200, dirs: [runnerModel],
        facets: { weights: 'w', harness: { runnerModel }, context: { n_ctx } }, agg: { attempted: Object.keys(tasks).length, scored: Object.keys(tasks).length }, tasks });
    const mk = (key, configs) => ({ key, display: key, weightsKey: key, counts: { qualityTasks: 5 }, quality: {}, configs: configs.map((c) => ({ ...c, facets: { ...c.facets, weights: key } })) });
    const catalog = { allTaskIds: ['a', 'b', 'c', 'd', 'e'], taskMeta: {}, models: [
        mk('local:q4', [cfg('llama-local/q4-128k', { a: tk(1), b: tk(1), c: tk(1), d: tk(0) }), cfg('llama-local/q4-128k-nothink', { a: tk(1), b: tk(0), c: tk(0), d: tk(0) })]),
        mk('local:weak', [cfg('llama-local/weak', { a: tk(1), b: tk(0), c: tk(0), d: tk(0) })]),
    ] };
    const settings = { models: [
        { id: 'q4', catalogKey: 'local:q4', role: 'contender', nCtx: 131072, match: { runnerModelExcludes: 'nothink' } },
        { id: 'q4-nt', catalogKey: 'local:q4', role: 'contender', nCtx: 131072, match: { runnerModelIncludes: 'nothink' } },
        { id: 'weak', catalogKey: 'local:weak', role: 'scout', nCtx: 131072 },
        { id: 'new', catalogKey: 'local:none', role: 'contender', relTimeGuess: 0.5 },
    ] };
    const d = derive(catalog, settings, { new: { ok: false, reason: 'weights missing' } }, { weak: ['e'] });
    const [q4, nt, weak, nw] = d.input.models;
    assert.ok(q4.fitted && nt.fitted && q4.theta > nt.theta, 'thinking-off is its own contender, fitted apart');
    assert.deepStrictEqual(Object.keys(q4.cfg).sort(), ['a', 'b', 'c', 'd']);
    assert.strictEqual(q4.cfg.d.passed, false);
    assert.deepStrictEqual(weak.pending, ['e']);
    assert.strictEqual(nw.fitted, false); assert.strictEqual(nw.available, false); assert.strictEqual(nw.relTime, 0.5);
    const e = d.input.tasks.find((t) => t.id === 'e');
    assert.strictEqual(e.tried, false, 'a task nobody ran is untried');
    const a = d.input.tasks.find((t) => t.id === 'a');
    assert.ok(a.tried && a.se > 0 && a.se < 1.5);
    assert.deepStrictEqual(resolveTasks(['@discriminating'], d.input).sort(), ['b', 'c'], 'split by the local models');
    assert.deepStrictEqual(resolveTasks(['@cascade-bottom'], d.input), ['d']);
    assert.deepStrictEqual(resolveTasks(['x', '@untried'], d.input), ['x', 'e']);
});

// ---------------------------------------------------------------- derive on the folded catalog (2026-10-14)
// One run per task per config: a task scored on a tensor-split row or on an f32ssm copy is scored for the base config,
// as the Models page shows it by default, so the planner must not offer it again.
function foldFixture() {
    const tk = (solved) => ({ status: solved ? 'pass' : 'fail', solved, excluded: false, credit: solved ? 1 : 0, attempts: 1, passes: solved ? 1 : 0, wall_s: 300, ran_at: 1 });
    const cfg = (runnerModel, tasks, n_ctx = 131072) => ({ key: runnerModel, runnerModel, n_ctx, timeout_s: 7200, dirs: [runnerModel],
        facets: { weights: 'w', harness: { runnerModel }, context: { n_ctx } }, agg: { attempted: Object.keys(tasks).length, scored: Object.keys(tasks).length }, tasks });
    const mk = (key, configs) => ({ key, display: key, weightsKey: key, counts: { qualityTasks: 5 }, quality: {},
        tasks: Object.assign({}, ...configs.map((c) => c.tasks)), configs: configs.map((c) => ({ ...c, facets: { ...c.facets, weights: key } })) });
    return { tk, cfg, mk };
}
const Q6 = 'local:qwen3.8-27b:q6-k-xl';
const IQ2S = 'local:qwen3.8-27b-gsq-rco-iq2-s-mtp:unknown', IQ2S_COPY = 'local:qwen3.8-27b-gsq-rco-iq2-s-mtp-f32ssm:unknown';
const IQ2XS = 'local:qwen3.8-27b-gsq-rco-iq2-xs-mtp:unknown', IQ2XS_COPY = 'local:qwen3.8-27b-gsq-rco-iq2-xs-mtp-f32ssm:unknown';

test('derive: a task scored only on a tensor-split row is scored for the base config (folded by default)', async () => {
    const { derive, plannerCatalog } = await ui('autoqueue/derive.js');
    const { tk, cfg, mk } = foldFixture();
    const raw = { allTaskIds: ['a', 'b', 'c', 'd'], taskMeta: {}, models: [
        mk(Q6, [cfg('llama-local/q6-128k', { a: tk(1) })]),
        mk(`${Q6}~rv:tensor-split-two-xtx`, [cfg('llama-local/q6-128k', { b: tk(1), c: tk(0) })]),
    ] };
    const settings = { models: [{ id: 'q27-q6', catalogKey: Q6, role: 'contender', nCtx: 131072 }] };
    const before = derive(raw, settings).input.models[0];
    assert.deepStrictEqual(Object.keys(before.cfg).sort(), ['a'], 'the raw catalog: the tensor-split tasks look unscored (the bug)');
    const cat = plannerCatalog(raw);
    assert.strictEqual(cat, plannerCatalog(raw), 'one folded object per catalog: the fit cache holds across replans');
    const m = derive(cat, settings).input.models[0];
    assert.deepStrictEqual(Object.keys(m.cfg).sort(), ['a', 'b', 'c']);
    assert.deepStrictEqual(Object.keys(m.hist).sort(), ['a', 'b', 'c']);
    assert.strictEqual(m.cfg.c.passed, false);
    // the Models page's "tensor split" switch ON (separate): the planner follows it
    const sep = derive(plannerCatalog(raw, { tensorRows: 'separate' }), settings).input.models[0];
    assert.deepStrictEqual(Object.keys(sep.cfg).sort(), ['a']);
});

test('derive: f32ssm copies count for the original file, whichever key the runnable config names', async () => {
    const { derive, plannerCatalog, rowKey } = await ui('autoqueue/derive.js');
    const { tk, cfg, mk } = foldFixture();
    // IQ2_S: only the copy has runs (the original's row does not exist yet: the fold renames the copy's row in place)
    // IQ2_XS: both files have runs, and a tensor-split run on the copy
    const raw = { allTaskIds: ['a', 'b', 'c', 'd', 'e'], taskMeta: {}, models: [
        mk(IQ2S_COPY, [cfg('llama-local/gsq-80k', { a: tk(1), b: tk(0) }, 81920)]),
        mk(IQ2XS_COPY, [cfg('llama-local/gsq-80k', { a: tk(1), b: tk(1) }, 81920)]),
        mk(`${IQ2XS_COPY}~rv:tensor-split-two-xtx`, [cfg('llama-local/gsq-80k', { c: tk(0) }, 81920)]),
        mk(IQ2XS, [cfg('llama-local/gsq-80k', { d: tk(1) }, 81920)]),
    ] };
    const settings = { models: [
        { id: 'iq2s-orig', catalogKey: IQ2S, role: 'contender', nCtx: 81920 },
        { id: 'iq2s-copy', catalogKey: IQ2S_COPY, role: 'contender', nCtx: 81920 },
        { id: 'iq2xs-orig', catalogKey: IQ2XS, role: 'contender', nCtx: 81920 },
        { id: 'iq2xs-copy', catalogKey: IQ2XS_COPY, role: 'contender', nCtx: 81920 },
    ] };
    const rawOut = Object.fromEntries(derive(raw, settings).input.models.map((m) => [m.id, Object.keys(m.cfg).sort()]));
    assert.deepStrictEqual(rawOut['iq2s-orig'], [], 'the raw catalog: a config on the original file sees none of the copy\'s runs (the bug)');
    assert.deepStrictEqual(rawOut['iq2xs-orig'], ['d']);
    const cat = plannerCatalog(raw);
    assert.strictEqual(rowKey(cat, IQ2S), IQ2S_COPY, 'no original row yet: the original lands on the renamed copy row');
    assert.strictEqual(rowKey(cat, IQ2XS_COPY), IQ2XS, 'a copy lands on the original file\'s row');
    assert.strictEqual(rowKey(cat, `${IQ2XS_COPY}~rv:tensor-split-two-xtx`), IQ2XS);
    assert.strictEqual(rowKey(cat, 'local:other'), 'local:other');
    const out = Object.fromEntries(derive(cat, settings).input.models.map((m) => [m.id, Object.keys(m.cfg).sort()]));
    assert.deepStrictEqual(out['iq2s-orig'], ['a', 'b']);
    assert.deepStrictEqual(out['iq2s-copy'], ['a', 'b']);
    assert.deepStrictEqual(out['iq2xs-orig'], ['a', 'b', 'c', 'd'], 'original + copy + the copy\'s tensor-split row');
    assert.deepStrictEqual(out['iq2xs-copy'], ['a', 'b', 'c', 'd']);
    // "f32ssm copies" ON on quality (separate): each file is its own config again
    const sep = Object.fromEntries(derive(plannerCatalog(raw, { fileQuality: 'separate' }), settings).input.models.map((m) => [m.id, Object.keys(m.cfg).sort()]));
    assert.deepStrictEqual(sep['iq2xs-orig'], ['d']);
    assert.deepStrictEqual(sep['iq2xs-copy'], ['a', 'b', 'c']);
});

// ---------------------------------------------------------------- lib/autoqueue.js
function queueDir() {
    const d = fs.mkdtempSync(path.join(TMP, 'q-'));
    fs.writeFileSync(path.join(d, 'flash-tuned.env'), 'FLASH_Q2_CMD="$U144 -m $M/Qwen3.8-Flash-Next-UD-Q2_K_XL-00001-of-00003.gguf $FN_BASE"\nFLASH_IQ4_CMD="$U144 -m $M/Qwen3.8-Flash-Next-UD-IQ4_XS-00001-of-00003.gguf $FN_BASE"\n');
    return d;
}
const settingsFor = (dir) => ({ ...AQ.DEFAULT_SETTINGS, queue: { ...AQ.DEFAULT_SETTINGS.queue, dir } });

test('autoqueue: detectChain waits for the newest queue only while it is alive and not DONE', () => {
    const d = queueDir();
    assert.deepStrictEqual(AQ.detectChain(d, []).next, 1);
    fs.writeFileSync(path.join(d, 'queue14.sh'), ''); fs.writeFileSync(path.join(d, 'queue15.sh'), '');
    fs.writeFileSync(path.join(d, 'queue15.log'), '[05:10] === queue15: waiting ===\n');
    const alive = AQ.detectChain(d, ['/bin/bash ./queue15.sh']);
    assert.deepStrictEqual([alive.prev, alive.next, alive.waitFor, alive.warning], [15, 16, 15, null]);
    const dead = AQ.detectChain(d, []);
    assert.strictEqual(dead.waitFor, null); assert.match(dead.warning, /not running/);
    fs.appendFileSync(path.join(d, 'queue15.log'), '[09:00] === QUEUE15 DONE ===\n');
    assert.strictEqual(AQ.detectChain(d, ['/bin/bash ./queue15.sh']).waitFor, null);
});

test('autoqueue: the generated queue follows queue15 (run(), ports, proxy tap, sandbox, 2 h cap) and chains', () => {
    const d = queueDir();
    const s = settingsFor(d);
    const batch = { strategy: 'greedy', legs: [
        { model: 'q4', lane: 'local', runs: [{ task: 'demo-widget-off-by-one' }, { task: 'demo-retry-storm' }] },
        { model: 'flash-q2', lane: 'local', runs: [{ task: 'demo-pager-skips-rows' }] },
    ] };
    const sh = AQ.generateQueueScript(batch, s, { n: 16, waitFor: 15, dir: d });
    assert.match(sh, /until grep -q "QUEUE15 DONE" \$T\/queue15\.log/);
    assert.match(sh, /record-proxy\.js --listen 8080 --upstream 18080 --tap 18090/);
    assert.match(sh, /eval "exec \$cmd --port 18080"/);
    assert.match(sh, /harness\/run\.py --runner opencode --model "llama-local\/\$om"/);
    assert.match(sh, /--timeout-s 7200/);
    assert.ok(sh.split('\n').includes('run aq16-q4-1 local-128k /tmp/codebench-aq16-q4-1 "'+'$STOCK -m $Q4 -c 131072 -ngl 999 -fa on -np 1 --jinja --spec-type draft-mtp,ngram-mod --spec-draft-n-max 2 -devd ROCm1 -dev ROCm1 --cache-type-k q8_0 --cache-type-v q8_0'+'" - demo-widget-off-by-one demo-retry-storm'), 'the q4 leg uses its KV q8_0 launch (2026-10-15)');
    assert.match(sh, /^run aq16-flash-q2-2 flash-next-64k-nc33 .* "\$FLASH_Q2_CMD" - demo-pager-skips-rows$/m);
    assert.match(sh, /source \$T\/flash-tuned\.env/);
    assert.match(sh, /say "=== QUEUE16 DONE ==="\n$/, 'ends with its DONE line so the next queue can chain');
    assert.throws(() => AQ.generateQueueScript({ legs: [{ model: 'q4', runs: [{ task: 'x; rm -rf /' }] }] }, s, { n: 16, dir: d }), /bad task id/);
});

test('autoqueue: cascade legs run dynamically (previous stage failures ∩ approved), with their own file prefix', () => {
    const d = queueDir();
    const s = settingsFor(d);
    const batch = { strategy: 'cascade', cascade: { order: ['haiku-low-solo', 'ornith', 'swift', 'terse'], seed: ['t1', 't2', 't3'] }, legs: [
        { model: 'ornith', lane: 'local', cascade: 1, runs: [{ task: 't1' }, { task: 't2' }] },
        { model: 'terse', lane: 'local', cascade: 3, runs: [{ task: 't1' }] },
    ] };
    const sh = AQ.generateQueueScript(batch, s, { n: 16, dir: d });
    assert.match(sh, /printf '%s\\n' t1 t2 t3 > \$T\/aq16-cascade-0\.txt/);
    assert.match(sh, /^cstage 1 aq16-ornith-c1-1 ornith15-35b-a3b-64k '%Ornith-1\.5-35B-Q4_K_M%' 65536 '-' '-' ".*" t1 t2$/m);
    assert.match(sh, /^cstage 2 aq16-swift-c2-skip /m, 'a stage with no approved runs still passes its failures on');
    assert.match(sh, /^cstage 3 aq16-terse-c3-2 /m);
    assert.ok(!/cascade-\$\(\( \$1 - 1 \)\)-\*\.txt/.test(sh), 'never reads queue15\'s cascade-<k>-*.txt files');
    assert.ok(sh.indexOf('cstage 1') < sh.indexOf('cstage 2') && sh.indexOf('cstage 2') < sh.indexOf('cstage 3'));
});

test('autoqueue: the cloud lane always sets effort and scaffold, and refuses a model without effort', () => {
    const d = queueDir();
    const s = settingsFor(d);
    const cs = AQ.generateCloudScript({ legs: [{ model: 'haiku-low-solo', lane: 'cloud', runs: [{ task: 'a' }, { task: 'b' }] }] }, s, { n: 16, dir: d });
    assert.match(cs, /CODEBENCH_CLAUDE_EFFORT=low CODEBENCH_CLAUDE_SCAFFOLD=solo timeout 259200 python3 harness\/run\.py --runner claude --model claude-haiku-4-5/);
    assert.match(cs, /--only a b --timeout-s 7200 --out results\/aq16-haiku-low-solo-1/);
    assert.match(cs, /CLOUD16 DONE/);
    const bad = { ...s, models: s.models.map((m) => (m.id === 'haiku-low-solo' ? { ...m, effort: null } : m)) };
    assert.throws(() => AQ.generateCloudScript({ legs: [{ model: 'haiku-low-solo', lane: 'cloud', runs: [{ task: 'a' }] }] }, bad, { n: 16, dir: d }), /no effort/);
});

test('autoqueue: enqueue is a dry run by default — scripts land in outDir, nothing is recorded or started', () => {
    const d = queueDir();
    fs.writeFileSync(path.join(d, 'queue15.sh'), '');
    const out = fs.mkdtempSync(path.join(TMP, 'dry-'));
    const s = { ...settingsFor(d), models: AQ.DEFAULT_MODELS.map((m) => ({ ...m, weights: undefined })) };
    const r = AQ.enqueue({ batch: { legs: [{ model: 'q4', lane: 'local', runs: [{ task: 'a' }] }, { model: 'haiku-low-solo', lane: 'cloud', runs: [{ task: 'b' }] }] }, outDir: out },
        { settings: s, psArgs: ['bash queue15.sh'] });
    assert.strictEqual(r.dryRun, true); assert.strictEqual(r.started, false);
    assert.strictEqual(r.n, 16); assert.strictEqual(r.waitFor, 15);
    assert.ok(fs.existsSync(path.join(out, 'queue16.sh')) && fs.existsSync(path.join(out, 'cloud16.sh')));
    assert.ok(!fs.existsSync(path.join(d, 'queue16.sh')), 'nothing written to the real queue dir');
    assert.ok(!fs.existsSync(process.env.AUTOQUEUE_BATCHES), 'a dry run is not a batch');
    assert.throws(() => AQ.enqueue({ batch: { legs: [{ model: 'q4', runs: [{ task: 'a' }] }] }, dryRun: false }, { settings: s, psArgs: [] }), /confirm:true/);
    const miss = { ...s, models: s.models.map((m) => (m.id === 'q4' ? { ...m, weights: '/nonexistent.gguf' } : m)) };
    assert.throws(() => AQ.enqueue({ batch: { legs: [{ model: 'q4', runs: [{ task: 'a' }] }] }, outDir: out }, { settings: miss, psArgs: [] }), /weights missing/);
});

test('autoqueue: "include re-runs" is off by default and saved as a boolean', () => {
    assert.strictEqual(AQ.DEFAULT_SETTINGS.rerunScored, false);
    assert.strictEqual(AQ.loadSettings().rerunScored, false);
    assert.strictEqual(AQ.saveSettings({ rerunScored: 'yes' }).rerunScored, false, 'only true is true');
    assert.strictEqual(AQ.saveSettings({ rerunScored: true }).rerunScored, true);
    assert.strictEqual(AQ.loadSettings().rerunScored, true);
    assert.strictEqual(AQ.saveSettings({ rerunScored: false }).rerunScored, false);
});

test('autoqueue: enqueue (dry run and real) leaves out runs the config already scored, unless marked rerun', () => {
    const d = queueDir();
    const { createQueue } = require('../lib/queue.js');
    const q = createQueue({ dbPath: path.join(d, 'bench.sqlite') });
    const s = { ...settingsFor(d), models: AQ.DEFAULT_MODELS.map((m) => ({ ...m, weights: undefined })) };
    const ins = q.open().prepare('INSERT INTO runs (result_path, battery, task, status, excluded, model_path, n_ctx, timeout_s, runner, runner_model, effort, scaffold) VALUES (?,?,?,?,0,?,?,7200,?,?,?,?)');
    ins.run('results/x/a.json', 'x', 'a', 'fail', '/hf/Qwen3.8-27B-UD-Q4_K_XL.gguf', 131072, 'opencode', 'llama-local/qwen38-27b-q4-128k', null, null);
    ins.run('results/ts/c.json', 'ts', 'c', 'pass', '/hf/Qwen3.8-27B-UD-Q4_K_XL.gguf', 131072, 'opencode', 'llama-local/qwen38-27b-q4-128k', null, null);   // e.g. a tensor-split run: same file
    ins.run('results/h/b.json', 'h', 'b', 'pass', null, null, 'claude', 'claude-haiku-4-5', 'low', 'solo');
    const batch = { strategy: 'greedy', legs: [
        { model: 'q4', lane: 'local', runs: [{ task: 'a' }, { task: 'b' }, { task: 'c', rerun: true }] },
        { model: 'haiku-low-solo', lane: 'cloud', runs: [{ task: 'b' }, { task: 'z' }] },
    ] };
    const out = fs.mkdtempSync(path.join(TMP, 'dry-'));
    const dry = AQ.enqueue({ batch, outDir: out }, { settings: s, psArgs: [], queue: q });
    assert.deepStrictEqual(dry.dropped, [{ model: 'q4', task: 'a' }, { model: 'haiku-low-solo', task: 'b' }]);
    assert.match(dry.scripts.queue, /^run aq1-q4-1 .* - b c$/m, 'the preview is what would be queued');
    assert.match(dry.scripts.cloud, /--only z /);
    assert.strictEqual(batch.legs[0].runs.length, 3, 'the caller\'s batch is not modified');
    const r = AQ.enqueue({ batch, dryRun: false, confirm: true }, { settings: s, psArgs: [], queue: q });
    assert.deepStrictEqual(r.dropped.map((x) => x.task), ['a', 'b']);
    assert.deepStrictEqual(r.items.map((i) => q.get(i.id).tasks), [['b', 'c'], ['z']]);
    // everything already scored: nothing to enqueue, said so
    assert.throws(() => AQ.enqueue({ batch: { legs: [{ model: 'q4', lane: 'local', runs: [{ task: 'a' }] }] }, dryRun: false, confirm: true }, { settings: s, psArgs: [], queue: q }),
        /nothing to enqueue: every run in the batch already ran at its config \(q4 a\)/);
    // "include re-runs": the batch says so, nothing is dropped
    const all = AQ.enqueue({ batch: { rerunScored: true, legs: [{ model: 'q4', lane: 'local', runs: [{ task: 'a' }] }] }, outDir: out }, { settings: s, psArgs: [], queue: q });
    assert.deepStrictEqual(all.dropped, []);
    assert.match(all.scripts.queue, /- a$/m);
    q.close();
});

test('autoqueue: a confirmed enqueue INSERTS queue rows (no script, no process) and they count as pending', () => {
    const d = queueDir();
    const { createQueue } = require('../lib/queue.js');
    const q = createQueue({ dbPath: path.join(d, 'bench.sqlite') });
    const s = { ...settingsFor(d), models: AQ.DEFAULT_MODELS.map((m) => ({ ...m, weights: undefined })) };
    const batch = { strategy: 'greedy', legs: [{ model: 'q4', lane: 'local', runs: [{ task: 'a' }] }, { model: 'haiku-low-solo', lane: 'cloud', runs: [{ task: 'b' }] }] };
    assert.throws(() => AQ.enqueue({ batch, dryRun: false, confirm: true }, { settings: s, psArgs: [] }), /queue database is not available/);
    const r = AQ.enqueue({ batch, dryRun: false, confirm: true }, { settings: s, psArgs: [], queue: q });
    assert.strictEqual(r.dryRun, false); assert.strictEqual(r.started, false); assert.strictEqual(r.items.length, 2);
    assert.deepStrictEqual(r.items.map((i) => i.lane), ['local-rocm1', 'cloud']);   // q4 runs on its one-XTX lane (2026-10-15)
    assert.ok(!fs.readdirSync(d).some((f) => /^(queue|cloud)\d+\.sh$/.test(f)), 'no script written');
    const row = q.get(r.items[0].id);
    assert.strictEqual(row.launch_cmd, '$STOCK -m $Q4 -c 131072 -ngl 999 -fa on -np 1 --jinja --spec-type draft-mtp,ngram-mod --spec-draft-n-max 2 -devd ROCm1 -dev ROCm1 --cache-type-k q8_0 --cache-type-v q8_0'); assert.strictEqual(row.model, 'local-128k'); assert.strictEqual(row.created_by, 'planner');
    assert.deepStrictEqual(q.get(r.items[1].id).env, { CODEBENCH_CLAUDE_EFFORT: 'low', CODEBENCH_CLAUDE_SCAFFOLD: 'solo', CODEBENCH_DOCS: 'off' });
    const p = AQ.pendingRuns(s, { psArgs: [], queue: q });
    assert.deepStrictEqual(p.byModel.q4, ['a']); assert.deepStrictEqual(p.byModel['haiku-low-solo'], ['b']);
    const b = AQ.listBatches({ settings: s, psArgs: [], queue: q });
    assert.strictEqual(b[0].queueState.state, 'queued');
    q.close();
});

test('autoqueue: pendingRuns reads what live queues still have to run (run / stage / cstage lines)', () => {
    const d = queueDir();
    fs.writeFileSync(path.join(d, 'cascade-0-haiku-failed.txt'), 't1\nt2\n');
    fs.writeFileSync(path.join(d, 'queue15.sh'), [
        'run(){ :; }', 'stage(){ :; }',
        'run fniq4-x flash-next-64k /tmp/sb "$FLASH_IQ4_CMD" - demo-pager-skips-rows',
        'run done-leg qwen38-27b-q4-128k /tmp/sb "$STOCK -m $Q4 -c 131072 $D27MTP" - old',
        'stage 1 casc-ornith ornith15-35b-a3b-64k \'%Ornith%\' 65536 "$STOCK -m /data/models/Ornith-1.5-35B-A3B/Ornith-1.5-35B-Q4_K_M.gguf -c 65536 $D27MTP"',
        'stage 2 casc-q4nt qwen38-27b-q4-128k-nothink \'%Q4%\' 131072 "$STOCK -m $Q4 -c 131072 $D27MTP --reasoning off"',
    ].join('\n'));
    fs.writeFileSync(path.join(d, 'queue15.log'), '[05:00] END done-leg (server still alive)\n');
    const p = AQ.pendingRuns(settingsFor(d), { psArgs: ['/bin/bash ./queue15.sh'] });
    assert.deepStrictEqual(p.byModel['flash-iq4'], ['demo-pager-skips-rows']);
    assert.deepStrictEqual(p.byModel.ornith, ['t1', 't2']);
    assert.deepStrictEqual(p.byModel['q4-nothink'], ['t1', 't2'], '--reasoning off maps to the thinking-off contender');
    assert.ok(!p.byModel.q4, 'a finished leg is not pending');
    assert.deepStrictEqual(AQ.pendingRuns(settingsFor(d), { psArgs: [] }).queues, [], 'a dead queue has nothing pending');
});

test('autoqueue: settings persist server-side and are validated', () => {
    const s = AQ.loadSettings();
    assert.strictEqual(s.strategy, 'greedy');
    assert.ok(s.models.some((m) => m.id === 'q4-nothink'));
    const saved = AQ.saveSettings({ weights: { top: 2, speed: 0, difficulty: 1 }, strategy: 'blend', pins: [{ model: 'q27-q3', tasks: ['@discriminating'] }] });
    assert.strictEqual(saved.weights.top, 2);
    assert.strictEqual(JSON.parse(fs.readFileSync(process.env.AUTOQUEUE_SETTINGS, 'utf-8')).strategy, 'blend');
    assert.strictEqual(AQ.loadSettings().pins.length, 1);
    // a saved models list overlays the defaults by id: new default configs still appear, edits stick
    AQ.saveSettings({ models: [{ id: 'q4', role: 'scout' }, { id: 'extra', role: 'ignored' }] });
    const merged = AQ.loadSettings().models;
    assert.strictEqual(merged.find((m) => m.id === 'q4').role, 'scout');
    assert.strictEqual(merged.find((m) => m.id === 'q4').opencodeModel, 'local-128k');
    assert.ok(merged.some((m) => m.id === 'q27-iq2') && merged.some((m) => m.id === 'extra'));
    assert.throws(() => AQ.saveSettings({ strategy: 'yolo' }), /strategy/);
    assert.throws(() => AQ.saveSettings({ weights: { top: -1 } }), /weights\.top/);
    assert.throws(() => AQ.saveSettings({ pins: [{ model: 'nope', tasks: [] }] }), /unknown model/);
});

test('autoqueue: EXPERIMENTS.md open items become candidate pins where the planner can act', () => {
    const f = path.join(TMP, 'EXP.md');
    fs.writeFileSync(f, ['## (e) Quantisation ladders', '| # | experiment | status | notes |', '|---|---|---|---|',
        '| E1 | Dense 27B quant ladder | idea, **high priority** | n |', '| E9 | gone | done | x |',
        '## (g) Thinking modes', '| # | experiment | status | notes |', '|---|---|---|---|', '| G2 | **Medium thinking** | idea, needs a mechanism | n |',
        '## (z) Other', '| Z1 | nope | idea | |'].join('\n'));
    const items = AQ.parseExperiments(f);
    assert.deepStrictEqual(items.map((i) => i.id), ['E1', 'G2']);
    assert.ok(items[0].plannable && items[0].pins.some((p) => p.model === 'q27-iq2'));
    assert.strictEqual(items[1].plannable, false, 'medium thinking has no mechanism: noted, not plannable');
});
