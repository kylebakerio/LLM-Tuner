// Auto queue focus set (2026-10-15, Kyle: "select which models we want to focus on, and then interpolates test runs for the
// models to keep their information/completion rate roughly comparable"; "for 'comparable' we're seeking similar 'strength
// coverage'"): the planner's focus restriction and coverage balance (ui/shared/planner.js), interleaved chunks
// (chunkSchedule), derive's coverage and prompt-level configs, the queue side (lib/queue.js insertBatch lanes / env /
// chunk order / labels, the cloud HOLD rule, the queued-duplicate guard, prompt-level-aware pending rows) and the opt-in
// continuous refill (lib/autoqueue.js planRefill / refill, dry run and real). Nothing here starts a process; every queue
// is a temp database.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-focus-test-'));
process.env.AUTOQUEUE_SETTINGS = path.join(TMP, 'autoqueue.json');
process.env.AUTOQUEUE_BATCHES = path.join(TMP, 'autoqueue-batches.json');
const AQ = require('../lib/autoqueue.js');
const { createQueue, CLOUD_HOLD_NOTE } = require('../lib/queue.js');
let uiDir = null;
test.after(() => { fs.rmSync(TMP, { recursive: true, force: true }); if (uiDir) fs.rmSync(uiDir, { recursive: true, force: true }); });

async function ui(rel) {
    if (!uiDir) {
        uiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-aqf-'));
        fs.cpSync(path.join(__dirname, '..', 'ui'), path.join(uiDir, 'ui'), { recursive: true });
        fs.writeFileSync(path.join(uiDir, 'package.json'), JSON.stringify({ type: 'module' }));
    }
    return import(`file://${path.join(uiDir, 'ui', rel)}`);
}
const P = () => ui('shared/planner.js');
async function mods() { return { ...(await P()), ...(await ui('autoqueue/derive.js')) }; }

let qn = 0;
function freshQueue(extra = {}) {
    const dir = path.join(TMP, `q${++qn}`); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'vars.env'), 'STOCK=/bin/llama-server\nMOE=/bin/moe\nD27MTP="-ngl 999 -fa on"\n');
    return { q: createQueue({ dbPath: path.join(dir, 'bench.sqlite'), envFiles: [path.join(dir, 'vars.env')], ...extra }), dir };
}

// ---------------------------------------------------------------- synthetic planner input
function model(id, theta, se, extra = {}) {
    return { id, label: id, role: 'contender', lane: 'local', theta, se, fitted: true, n: 30, relTime: 1, available: true, hist: {}, cfg: {}, ...extra };
}
function task(id, b, extra = {}) {
    return { id, b, se: 0.5, tried: true, nStrong: 3, strongPasses: 2, solveMin: 10, failMin: 30, capMin: 120, points: 5, ...extra };
}
const ran = (ids) => Object.fromEntries(ids.map((t) => [t, { ran: true, passed: true }]));
const base = (over = {}) => ({ budget: { localHours: 8, cloud: false, cloudHours: 0, switchMin: 5 }, minValue: 0, ...over });

// ================================================================ planner
test('focus: only focus configs get proposed runs; a pin for another config still runs; an ignored focus config is planned', async () => {
    const { plan } = await P();
    const tasks = ['a', 'b', 'c', 'd', 'e', 'f'].map((t, i) => task(t, i * 0.4));
    const input = { models: [model('A', 1, 0.6), model('B', 0.8, 0.6, { role: 'ignored' }), model('C', 1.1, 0.6)], tasks, focus: ['A', 'B'] };
    const out = plan(input, base({ pins: [{ model: 'C', tasks: ['a'] }] }));
    const by = Object.fromEntries(out.legs.map((L) => [L.model, L.runs.map((r) => r.task)]));
    assert.deepStrictEqual(by.C, ['a'], 'the pin, nothing else');
    assert.ok(by.A && by.A.length > 0, 'A planned');
    assert.ok(by.B && by.B.length > 0, 'B is ignored but focused: planned');
    assert.deepStrictEqual(out.focus.sort(), ['A', 'B']);
    // no focus: everything as before (C is a contender and gets runs)
    const all = plan({ ...input, focus: [] }, base());
    assert.ok(all.legs.some((L) => L.model === 'C'));
    assert.deepStrictEqual(all.coverage, [], 'no focus: no coverage report');
});

test('focus: balance factor f = (1 + max(0, C* - C) / 10)^balance (points)', async () => {
    const { balanceFactor } = await P();
    assert.strictEqual(balanceFactor(50, 70, 1), 3);
    assert.strictEqual(balanceFactor(50, 70, 2), 9);
    assert.strictEqual(balanceFactor(70, 70, 1), 1, 'the best-covered config keeps 1');
    assert.strictEqual(balanceFactor(80, 70, 1), 1, 'never below 1');
    assert.strictEqual(balanceFactor(10, 70, 0), 1, 'balance 0 = off');
});

test('focus: coverage balance moves runs to the config that is behind, and the projection adds exactly the batch\'s points', async () => {
    const { plan } = await P();
    // 20 tasks of 5 points (100 in all); A has run 12 (60 points), B 4 (20 points); same ability, same cost
    const ids = Array.from({ length: 20 }, (_, i) => `t${i}`);
    const tasks = ids.map((t, i) => task(t, 0.8 + (i % 5) * 0.1));
    const mk = () => ({ models: [model('A', 1, 0.5, { cfg: ran(ids.slice(0, 12)) }), model('B', 1, 0.5, { cfg: ran(ids.slice(16)), pending: ['t12'] })], tasks, focus: ['A', 'B'] });
    // the legacy DIFFICULTY objective (2026-10-18: information scoring is the default; test/autoqueue-info.test.js has its balance test)
    const s = base({ scoring: 'legacy', budget: { localHours: 3, cloud: false, cloudHours: 0, switchMin: 0 }, weights: { top: 0, speed: 0, difficulty: 1 } });
    const runsOf = (o, id) => o.legs.filter((L) => L.model === id).reduce((a, L) => a + L.runs.length, 0);
    const off = plan(mk(), { ...s, balance: 0 });
    const on = plan(mk(), { ...s, balance: 2 });
    assert.ok(runsOf(on, 'B') > runsOf(off, 'B'), `balance on gives B more runs (${runsOf(on, 'B')} vs ${runsOf(off, 'B')})`);
    assert.ok(runsOf(on, 'B') > runsOf(on, 'A'), 'B is 35 points behind: it gets most of the batch');
    const cb = on.coverage.find((c) => c.model === 'B');
    assert.ok(Math.abs(cb.current - 0.20) < 1e-9, 'current: 4 tasks x 5 points');
    assert.ok(Math.abs(cb.pending - 0.05) < 1e-9, 'pending: t12 is queued for it');
    assert.ok(Math.abs(cb.projected - (0.25 + runsOf(on, 'B') * 0.05)) < 1e-9, 'projected = current + pending + the batch\'s points');
    const reason = on.legs.find((L) => L.model === 'B').runs[0].reason;
    assert.match(reason, /coverage \d+ of \d+ pts \(×\d/, 'the reason says why it was preferred');
});

test('focus: an L3 config only gets tasks that have a prompt at L3 (allowedTasks), pins included', async () => {
    const { plan } = await P();
    const tasks = ['a', 'b', 'c', 'd'].map((t) => task(t, 1));
    const input = { models: [model('q4.L3', 1, 0.6, { allowedTasks: ['b', 'd'], promptLevel: 'L3' })], tasks, focus: ['q4.L3'] };
    const out = plan(input, base({ pins: [{ model: 'q4.L3', tasks: ['a', 'b'] }] }));
    const got = out.legs.flatMap((L) => L.runs.map((r) => r.task)).sort();
    assert.deepStrictEqual(got, ['b', 'd']);
});

test('focus: expandFocus — an L3 entry is its own config, same in the browser and on the server', async () => {
    const { expandFocus } = await P();
    const models = [{ id: 'q4', label: 'Q4', cmd: 'x', env: { CODEBENCH_DEVICES: 'ROCm1' } }, { id: 'q8', label: 'Q8', cmd: 'y' }];
    const focus = [{ model: 'q4' }, { model: 'q4', promptLevel: 'L3' }, { model: 'nope' }, { model: 'q8', promptLevel: 'l3' }, { model: 'q4' }];
    const a = expandFocus(models, focus);
    assert.deepStrictEqual(a.focus, ['q4', 'q4.L3', 'q8.L3']);
    const l3 = a.models.find((m) => m.id === 'q4.L3');
    assert.deepStrictEqual(l3.env, { CODEBENCH_DEVICES: 'ROCm1', CODEBENCH_PROMPT_LEVEL: 'L3' });
    assert.strictEqual(l3.promptLevel, 'L3'); assert.strictEqual(l3.focusOf, 'q4'); assert.strictEqual(l3.cmd, 'x');
    assert.ok(/^[\w.-]+$/.test(l3.id), 'label-safe: aq<stamp>-<id>-<n> must be [\\w.-]');
    assert.deepStrictEqual(AQ.expandFocus(models, focus), a, 'lib/autoqueue.js expandFocus is the same function');
    assert.strictEqual(models.length, 2, 'the input is not modified');
});

test('chunks: each config\'s runs cut into rows of N, interleaved per queue lane; cascade legs pass through whole', async () => {
    const { chunkSchedule } = await P();
    const R = (...t) => t.map((task) => ({ task, minutes: 10 }));
    const legs = [
        { model: 'A', lane: 'local', queueLane: 'local-gpu', runs: R('a1', 'a2', 'a3', 'a4', 'a5') },
        { model: 'S', lane: 'local', cascade: 1, runs: R('s1') },
        { model: 'B', lane: 'local', queueLane: 'local-gpu', runs: R('b1', 'b2', 'b3') },
        { model: 'C', lane: 'local', queueLane: 'local-rocm1', runs: R('c1', 'c2', 'c3') },
        { model: 'H', lane: 'cloud', runs: R('h1') },
    ];
    const out = chunkSchedule(legs, 2);
    const show = (x) => `${x.queueLane}:${x.model}:${x.runs.map((r) => r.task).join(',')}`;
    assert.deepStrictEqual(out.map(show), [
        'local-gpu:S:s1',
        'local-gpu:A:a1,a2', 'local-gpu:B:b1,b2', 'local-gpu:A:a3,a4', 'local-gpu:B:b3', 'local-gpu:A:a5',
        'local-rocm1:C:c1,c2', 'local-rocm1:C:c3',
        'cloud:H:h1',
    ]);
    assert.deepStrictEqual(out.filter((x) => x.model === 'A').map((x) => `${x.chunk}/${x.chunks}`), ['1/3', '2/3', '3/3']);
    assert.strictEqual(out[1].minutes, 20);
    assert.deepStrictEqual(chunkSchedule(legs, 0).map((x) => x.runs.length), [1, 5, 3, 3, 1], '0 = one row per config');
});

// ================================================================ derive
function catalogFixture() {
    const tk = (solved) => ({ status: solved ? 'pass' : 'fail', solved, excluded: false, credit: solved ? 1 : 0, attempts: 1, passes: solved ? 1 : 0, wall_s: 600, ran_at: 1 });
    const cfg = (key, tasks, prompt_level = 'L2') => ({ key, runnerModel: 'llama-local/x', n_ctx: 131072, timeout_s: 7200, prompt_level, runner: 'opencode', dirs: [key],
        facets: { weights: 'w', harness: { runnerModel: 'llama-local/x', prompt_level, timeout_s: 7200 }, context: { n_ctx: 131072 } }, agg: { attempted: Object.keys(tasks).length, scored: Object.keys(tasks).length }, tasks });
    const mk = (key, configs) => ({ key, display: key, weightsKey: key, counts: { qualityTasks: 5 }, quality: {}, configs: configs.map((c) => ({ ...c, facets: { ...c.facets, weights: key } })) });
    const T = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const catalog = { allTaskIds: T, taskMeta: {}, models: [
        // one row ran the L2 tasks and two L3 problems (2026-10-17: a prompt level is a problem, `<task>@L3`, not a config)
        mk('local:A', [cfg('A2', { a: tk(1), b: tk(1), c: tk(1), d: tk(0), e: tk(1), f: tk(0), 'a@L3': tk(1), 'b@L3': tk(0) })]),
        mk('local:B', [cfg('B2', { a: tk(1), b: tk(0) })]),
        mk('local:C', [cfg('C2', { a: tk(1), c: tk(0), g: tk(0) })]),
        mk('local:W', [cfg('W2', { a: tk(0), b: tk(0), c: tk(0), d: tk(0), e: tk(0), f: tk(0), g: tk(0), h: tk(0) })]),
    ] };
    return { catalog, T };
}
const fixtureModels = () => [
    { id: 'A', catalogKey: 'local:A', role: 'contender', nCtx: 131072, opencodeModel: 'oa', cmd: '$STOCK -m /m/A.gguf -c 131072', queueLane: 'local-gpu' },
    { id: 'B', catalogKey: 'local:B', role: 'contender', nCtx: 131072, opencodeModel: 'ob', cmd: '$STOCK -m /m/B.gguf -c 131072', queueLane: 'local-rocm1', env: { CODEBENCH_DEVICES: 'ROCm1' } },
    { id: 'C', catalogKey: 'local:C', role: 'contender', nCtx: 131072, opencodeModel: 'oc', cmd: '$STOCK -m /m/C.gguf -c 131072', queueLane: 'laptop-4090' },
    { id: 'W', catalogKey: 'local:W', role: 'ignored', nCtx: 131072, opencodeModel: 'ow', cmd: '$STOCK -m /m/W.gguf -c 131072' },
    { id: 'H', label: 'Haiku', role: 'scout', lane: 'cloud', runner: 'claude', claudeModel: 'claude-haiku-4-5', effort: 'low', scaffold: 'solo', catalogKey: 'cloud:h' },
];

test('derive: strength coverage = the fit\'s task points over what the config ran; an L3 focus entry is its own config of its row\'s L3 problems', async () => {
    const { derive } = await ui('autoqueue/derive.js');
    const { catalog } = catalogFixture();
    const settings = { models: fixtureModels(), focus: [{ model: 'A' }, { model: 'A', promptLevel: 'L3' }, { model: 'B' }] };
    const d = derive(catalog, settings, {}, {}, { L3: ['a', 'b', 'c'] });
    assert.deepStrictEqual(d.input.focus, ['A', 'A.L3', 'B']);
    const by = new Map(d.input.models.map((m) => [m.id, m]));
    const pts = (ids) => ids.reduce((s, t) => s + d.input.tasks.find((x) => x.id === t).points, 0) / 100;
    // the candidates are the suite's tasks; the L3 problems hold the rest of the fit's 100 points
    assert.deepStrictEqual(d.input.tasks.map((t) => t.id), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 'no `@L3` candidate');
    const l3pts = (ids) => ids.reduce((s, t) => s + d.fit.adj.taskPoints.get(`${t}@L3`), 0) / 100;
    assert.ok(d.input.tasks.every((t) => t.points >= 0) && Math.abs(d.input.tasks.reduce((s, t) => s + t.points, 0) / 100 + l3pts(['a', 'b']) - 1) < 1e-6, 'points sum to 100 over tasks + L3 problems');
    // one config row scored them, under LEVEL_MIN_CONFIGS (5): no points yet, so the L3 config covers nothing so far
    assert.deepEqual([l3pts(['a']), l3pts(['b'])], [0, 0], 'an L3 problem below the minimum earns no points');
    assert.deepStrictEqual(Object.keys(by.get('A').cfg).sort(), ['a', 'b', 'c', 'd', 'e', 'f'], 'the L2 config: not its L3 runs');
    assert.deepStrictEqual(by.get('A.L3').cfg, { a: { ran: true, passed: true }, b: { ran: true, passed: false } }, 'the L3 config: only its L3 problems, by task id');
    assert.deepStrictEqual(Object.keys(by.get('A.L3').hist).sort(), ['a', 'b']);
    assert.ok(Math.abs(by.get('A').coverage - pts(['a', 'b', 'c', 'd', 'e', 'f'])) < 1e-9);
    assert.ok(Math.abs(by.get('A.L3').coverage - l3pts(['a', 'b'])) < 1e-9, 'the L3 config\'s coverage: its L3 problems\' points');
    assert.ok(Math.abs(by.get('A').fitCoverage - (pts(['a', 'b', 'c', 'd', 'e', 'f']) + l3pts(['a', 'b']))) < 1e-6, 'the row\'s own fit coverage: both levels\' problems');
    assert.ok(Math.abs(by.get('B').coverage - by.get('B').fitCoverage) < 1e-6, 'one group: the same number as the fit\'s own coverage');
    assert.deepStrictEqual(by.get('A.L3').allowedTasks, ['a', 'b', 'c']);
    assert.strictEqual(by.get('A').allowedTasks, null);
    assert.strictEqual(by.get('B').queueLane, 'local-rocm1'); assert.strictEqual(by.get('W').queueLane, 'local-gpu'); assert.strictEqual(by.get('H').queueLane, 'cloud');
});

// ================================================================ queue: rows
const qSettings = () => ({ models: [
    { id: 'A', opencodeModel: 'oa', cmd: '$STOCK -m /m/A.gguf -c 131072', nCtx: 131072, dbLike: '%/A.gguf', queueLane: 'local-gpu' },
    { id: 'B', opencodeModel: 'ob', cmd: '$STOCK -m /m/B.gguf -c 131072', nCtx: 131072, dbLike: '%/B.gguf', queueLane: 'local-gpu', env: { CODEBENCH_DEVICES: 'ROCm0,ROCm1', CODEBENCH_ROW_VARIANT: 'tensor-split-two-xtx' } },
    { id: 'C', opencodeModel: 'oc', cmd: '$STOCK -m /m/C.gguf -c 131072', nCtx: 131072, dbLike: '%/C.gguf', queueLane: 'local-rocm1', env: { CODEBENCH_DEVICES: 'ROCm1' } },
    { id: 'H', runner: 'claude', lane: 'cloud', claudeModel: 'claude-sonnet-5-5', effort: 'high', scaffold: 'solo' },
] });

test('queue: interleaved chunks land on each config\'s own lane in order, with its env under the planner\'s docs-off pin', async () => {
    const { chunkSchedule } = await P();
    const { q } = freshQueue();
    const s = qSettings();
    const legs = chunkSchedule([
        { model: 'A', lane: 'local', queueLane: 'local-gpu', runs: ['a1', 'a2', 'a3', 'a4', 'a5'].map((task) => ({ task })) },
        { model: 'B', lane: 'local', queueLane: 'local-gpu', runs: ['b1', 'b2', 'b3'].map((task) => ({ task })) },
        { model: 'C', lane: 'local', queueLane: 'local-rocm1', runs: ['c1', 'c2'].map((task) => ({ task })) },
    ], 2);
    const rows = q.insertBatch({ strategy: 'greedy', legs: legs.map((L) => ({ model: L.model, lane: L.lane, chunk: L.chunk, chunks: L.chunks, runs: L.runs })) }, s, { stamp: 'T' });
    const lane = (l) => q.list().pending.filter((r) => r.lane === l).map((r) => `${r.label}:${r.tasks.join(',')}`);
    assert.deepStrictEqual(lane('local-gpu'), ['aqT-A-1:a1,a2', 'aqT-B-2:b1,b2', 'aqT-A-3:a3,a4', 'aqT-B-4:b3', 'aqT-A-5:a5'], 'A, B, A, B, A');
    assert.deepStrictEqual(lane('local-rocm1'), ['aqT-C-6:c1,c2']);
    const b = rows.find((r) => r.label === 'aqT-B-2');
    assert.deepStrictEqual(b.env, { CODEBENCH_DEVICES: 'ROCm0,ROCm1', CODEBENCH_ROW_VARIANT: 'tensor-split-two-xtx', CODEBENCH_DOCS: 'off' });
    assert.match(b.notes, /chunk 1\/2/);
    // the same stamp again (an enqueue and a refill in the same minute): labels never collide
    const again = q.insertBatch({ strategy: 'greedy', legs: [{ model: 'A', lane: 'local', runs: [{ task: 'a9' }] }] }, s, { stamp: 'T' });
    assert.strictEqual(again[0].label, 'aqT-A-1-r2');
});

test('queue: the CLOUD RULE — a planner cloud row is inserted HELD (hold action, inside the insert transaction) with a note asking for Kyle\'s OK', () => {
    const { q } = freshQueue();
    const rows = q.insertBatch({ strategy: 'greedy', legs: [
        { model: 'A', lane: 'local', runs: [{ task: 'a1' }] },
        { model: 'H', lane: 'cloud', runs: [{ task: 'h1' }, { task: 'h2' }] },
    ] }, qSettings(), { stamp: 'T' });
    const cloud = rows.find((r) => r.lane === 'cloud');
    assert.strictEqual(cloud.status, 'paused', 'held');
    assert.ok(cloud.notes.includes(CLOUD_HOLD_NOTE) && /Kyle's OK/.test(cloud.notes));
    const ev = q.get(cloud.id).events.map((e) => [e.event, e.actor, e.detail && e.detail.to]);
    assert.deepStrictEqual(ev.map((e) => e[0]), ['insert', 'hold']);
    assert.deepStrictEqual(ev[1], ['hold', 'planner', 'paused']);
    assert.strictEqual(rows.find((r) => r.lane === 'local-gpu').status, 'pending', 'local rows are not held');
    assert.ok(!q.list().pending.some((r) => r.lane === 'cloud' && r.status === 'pending'), 'no cloud row is ever pending');
    // the same through the Auto queue's enqueue: the answer lists what is held
    const d = fs.mkdtempSync(path.join(TMP, 'aqd-'));
    const r = AQ.enqueue({ batch: { strategy: 'greedy', legs: [{ model: 'haiku-low-solo', lane: 'cloud', runs: [{ task: 'z1' }] }] }, dryRun: false, confirm: true },
        { settings: { ...AQ.DEFAULT_SETTINGS, queue: { ...AQ.DEFAULT_SETTINGS.queue, dir: d } }, psArgs: [], queue: q });
    assert.strictEqual(r.items[0].status, 'paused');
    assert.deepStrictEqual(r.held, [r.items[0].id]);
});

test('queue: a task already QUEUED at the same config is not added again (and not twice within one batch); reruns still pass', () => {
    const { q } = freshQueue();
    const s = qSettings();
    q.insertBatch({ strategy: 'greedy', legs: [{ model: 'A', lane: 'local', runs: [{ task: 'a1' }, { task: 'a2' }] }] }, s, { stamp: 'T1' });
    const g = q.dropScored({ legs: [{ model: 'A', lane: 'local', runs: [{ task: 'a1' }, { task: 'a3' }] }, { model: 'A', lane: 'local', runs: [{ task: 'a3' }, { task: 'a2', rerun: true }] }, { model: 'C', lane: 'local', runs: [{ task: 'a1' }] }] }, s);
    assert.deepStrictEqual(g.queued, [{ model: 'A', task: 'a1' }, { model: 'A', task: 'a3' }]);
    assert.deepStrictEqual(g.dropped, []);
    assert.deepStrictEqual(g.batch.legs.map((L) => L.runs.map((r) => r.task)), [['a3'], ['a2'], ['a1']], 'another config may run a1');
    const rows = q.insertBatch({ strategy: 'greedy', legs: [{ model: 'A', lane: 'local', runs: [{ task: 'a1' }, { task: 'a4' }] }] }, s, { stamp: 'T2' });
    assert.deepStrictEqual(rows.map((r) => r.tasks), [['a4']]);
});

test('queue: prompt level — an L3 focus config\'s rows ask run.py for L3, its pending rows and scored runs are its own (fallback predicate)', () => {
    const { q } = freshQueue();
    const s = { models: AQ.expandFocus(qSettings().models, [{ model: 'A' }, { model: 'A', promptLevel: 'L3' }]).models };
    const rows = q.insertBatch({ strategy: 'greedy', legs: [{ model: 'A.L3', lane: 'local', runs: [{ task: 't1' }] }, { model: 'A', lane: 'local', runs: [{ task: 't2' }] }] }, s, { stamp: 'T' });
    assert.strictEqual(rows[0].label, 'aqT-A.L3-1');
    assert.deepStrictEqual(rows[0].env, { CODEBENCH_PROMPT_LEVEL: 'L3', CODEBENCH_DOCS: 'off' });
    // a hand-made careful-tone row of the same file is neither config's
    q.insert({ label: 'careful', runner: 'opencode', model: 'oa', launch_cmd: '$STOCK -m /m/A.gguf -c 131072', tasks: ['t3'], env: { CODEBENCH_PROMPT_VARIANT: 'careful-tone', CODEBENCH_DOCS: 'off' } });
    const exact = (ms, om, cmd) => ms.find((m) => m.opencodeModel === om && m.cmd === cmd) || null;
    const p = q.pendingForPlanner(s, exact).byModel;
    assert.deepStrictEqual(p['A.L3'], ['t1']);
    assert.deepStrictEqual(p.A, ['t2'], 'the L2 config does not take the L3 row or the careful-tone row');
    const ins = q.open().prepare('INSERT INTO runs (result_path, battery, task, status, excluded, model_path, n_ctx, timeout_s, runner, prompt_level) VALUES (?,?,?,?,0,?,?,7200,?,?)');
    ins.run('results/l3/x.json', 'l3', 'x', 'pass', '/m/A.gguf', 131072, 'opencode', 'L3');
    ins.run('results/l2/y.json', 'l2', 'y', 'pass', '/m/A.gguf', 131072, 'opencode', null);
    assert.deepStrictEqual([...q.scoredAtConfig(s.models.find((m) => m.id === 'A.L3'), ['x', 'y'])], ['x']);
});

test('queue: with the config identity, pending rows go to the config whose identity they have (L3 vs L2 of the same launch)', () => {
    const identity = { scoredIndex: () => ({}), identityOfSpec: (sp) => (sp && sp.config ? { key: `${sp.config.prompt_level}|${String(sp.launch).split(' ')[2]}` } : null), scoredFor: () => ({}) };
    const harnessConfig = (a) => ({ runner: a.runner, model: a.model, prompt_level: a.env.CODEBENCH_PROMPT_LEVEL || (a.env.CODEBENCH_PROMPT_VARIANT ? `L2+${a.env.CODEBENCH_PROMPT_VARIANT}` : 'L2'), harness_mode: 'agentic', timeout_s: a.timeout_s });
    const { q } = freshQueue({ identity, harnessConfig });
    const s = { models: AQ.expandFocus(qSettings().models, [{ model: 'A' }, { model: 'A', promptLevel: 'L3' }]).models };
    // hand-made rows (Kyle's): an L3 one, an L2 one, a careful-tone one -- the same launch command
    const R = (label, tasks, env) => q.insert({ label, runner: 'opencode', model: 'local-128k', launch_cmd: '$STOCK -m /m/A.gguf -c 131072', tasks, env });
    R('l3', ['t1'], { CODEBENCH_PROMPT_LEVEL: 'L3', CODEBENCH_DOCS: 'off', CODEBENCH_DEVICES: 'ROCm1' });
    R('l2', ['t2'], { CODEBENCH_DOCS: 'off' });
    R('careful', ['t3'], { CODEBENCH_PROMPT_VARIANT: 'careful-tone', CODEBENCH_DOCS: 'off' });
    const byFile = (ms, om, cmd) => ms.find((m) => cmd.includes('/m/A.gguf') && m.id === 'A') || null;
    const p = q.pendingForPlanner(s, byFile).byModel;
    assert.deepStrictEqual(p['A.L3'], ['t1']);
    assert.deepStrictEqual(p.A, ['t2']);
});

// ================================================================ refill
function refillSetup({ refill = {}, pause = [] } = {}) {
    const { q } = freshQueue();
    const dir = fs.mkdtempSync(path.join(TMP, 'rq-'));
    for (const l of pause) q.pauseLane(l, true, { note: 'test pause' });
    const settings = { ...AQ.DEFAULT_SETTINGS, queue: { ...AQ.DEFAULT_SETTINGS.queue, dir }, models: fixtureModels(), chunkTasks: 2,
        focus: [{ model: 'A' }, { model: 'B' }, { model: 'C' }, { model: 'H' }],
        budget: { ...AQ.DEFAULT_SETTINGS.budget, switchMin: 0 }, minValue: 0,
        refill: { ...AQ.DEFAULT_SETTINGS.refill, enabled: true, lanes: ['local-gpu', 'local-rocm1', 'laptop-4090'], minHours: 3, topUpHours: 3, ...refill } };
    return { q, settings };
}
const allTasks = (q) => { const o = {}; for (const r of [...q.list().pending, ...q.list().running]) (o[r.model] = o[r.model] || []).push(...(r.tasks || [])); return o; };

test('refill: off by default; a paused lane cannot be switched on; cloud is refused', () => {
    assert.strictEqual(AQ.DEFAULT_SETTINGS.refill.enabled, false);
    assert.deepStrictEqual(AQ.DEFAULT_SETTINGS.refill.lanes, []);
    assert.strictEqual(AQ.loadSettings().refill.enabled, false);
    const { q } = freshQueue();
    q.pauseLane('local-rocm1', true);
    assert.throws(() => AQ.saveSettings({ refill: { enabled: true, lanes: ['local-rocm1'] } }, { queue: q }), /local-rocm1: the lane is paused/);
    assert.throws(() => AQ.saveSettings({ refill: { enabled: true, lanes: ['cloud'] } }, { queue: q }), /never runs on the cloud lane/);
    const ok = AQ.saveSettings({ refill: { enabled: true, lanes: ['local-gpu'] } }, { queue: q });
    assert.deepStrictEqual(ok.refill.lanes, ['local-gpu']);
    // focus entries are validated and kept in their short form
    const f = AQ.saveSettings({ focus: [{ model: 'q4' }, { model: 'q4', promptLevel: 'l3' }, 'q27-q8', { model: 'q4' }], balance: 1.5, chunkTasks: 3 }, { queue: q });
    assert.deepStrictEqual(f.focus, [{ model: 'q4' }, { model: 'q4', promptLevel: 'L3' }, { model: 'q27-q8' }]);
    assert.throws(() => AQ.saveSettings({ focus: [{ model: 'nope' }] }), /focus: unknown model/);
    assert.throws(() => AQ.saveSettings({ focus: [{ model: 'q4', promptLevel: 'L9' }] }), /promptLevel/);
    AQ.saveSettings({ focus: [], refill: { enabled: false, lanes: [] } });
});

test('refill: DRY RUN plans each lane\'s focus configs as chunks, skips the paused lane and the cloud lane, and writes nothing', async () => {
    const { q, settings } = refillSetup({ pause: ['laptop-4090'] });
    const { catalog } = catalogFixture();
    const res = await AQ.refill({ dryRun: true }, { queue: q, settings, catalog: async () => catalog, mods: await mods(), psArgs: [] });
    const L = Object.fromEntries(res.lanes.map((x) => [x.lane, x]));
    assert.strictEqual(res.dryRun, true);
    assert.strictEqual(L['local-gpu'].action, 'fill');
    assert.ok(L['local-gpu'].chunks.length > 0 && L['local-gpu'].chunks.every((c) => c.model === 'A' && c.tasks.length <= 2));
    assert.ok(L['local-rocm1'].chunks.every((c) => c.model === 'B'));
    assert.strictEqual(L['laptop-4090'].action, 'skip'); assert.match(L['laptop-4090'].reason, /paused/);
    assert.strictEqual(L['laptop-4090'].chunks.length, 0);
    assert.strictEqual(L.cloud.action, 'skip'); assert.match(L.cloud.reason, /never refilled/);
    assert.ok(res.lanes.every((x) => !x.batch || x.batch.legs.every((g) => g.lane !== 'cloud')));
    assert.ok(L['local-gpu'].coverage.some((c) => c.model === 'B'), 'the coverage report covers the whole focus set');
    assert.strictEqual(q.list().pending.length, 0, 'a dry run inserts nothing');
});

test('refill: real refill inserts only on enabled, listed lanes; never a cloud row; a second pass adds no duplicate; a full lane is left alone', async () => {
    const { q, settings } = refillSetup({ refill: { lanes: ['local-gpu'] } });
    const { catalog } = catalogFixture();
    const deps = { queue: q, settings, catalog: async () => catalog, mods: await mods(), psArgs: [] };
    // refill.enabled false: a real call inserts nothing
    await AQ.refill({ dryRun: false }, { ...deps, settings: { ...settings, refill: { ...settings.refill, enabled: false } } });
    assert.strictEqual(q.list().pending.length, 0);
    const r1 = await AQ.refill({ dryRun: false }, deps);
    const gpu = r1.lanes.find((x) => x.lane === 'local-gpu');
    assert.ok(gpu.inserted && gpu.inserted.length > 0);
    assert.ok(!r1.lanes.find((x) => x.lane === 'local-rocm1').inserted, 'local-rocm1 is not in refill.lanes: planned, not inserted');
    const rows = q.list().pending;
    assert.ok(rows.length > 0 && rows.every((r) => r.lane === 'local-gpu' && r.created_by === 'planner' && r.model === 'oa'));
    assert.ok(!rows.some((r) => r.lane === 'cloud'), 'refill never makes a cloud row');
    const r2 = await AQ.refill({ dryRun: false }, { ...deps, settings: { ...settings, refill: { ...settings.refill, minHours: 1000 } } });
    const t = allTasks(q).oa;
    assert.strictEqual(new Set(t).size, t.length, `no task queued twice for A (${t.join(' ')})`);
    assert.ok(r2.lanes.find((x) => x.lane === 'local-gpu').action !== 'fill' || (r2.lanes.find((x) => x.lane === 'local-gpu').inserted || []).every((x) => x.tasks.every((k) => !gpu.inserted.some((g) => g.tasks.includes(k)))));
    // a lane with enough planner work queued is topped up already
    const r3 = await AQ.refill({ dryRun: true }, { ...deps, settings: { ...settings, refill: { ...settings.refill, minHours: 0.01 } } });
    assert.match(r3.lanes.find((x) => x.lane === 'local-gpu').reason, /topped up/);
});

test('refill: plannerHours counts only pending / running planner rows on the lane (held rows do not run)', () => {
    const rows = [
        { lane: 'local-gpu', created_by: 'planner', status: 'pending', est: { hours: 1.5 }, tasks: ['a'] },
        { lane: 'local-gpu', created_by: 'planner', status: 'running', est: null, tasks: ['a', 'b', 'c'] },
        { lane: 'local-gpu', created_by: 'planner', status: 'paused', est: { hours: 9 } },
        { lane: 'local-gpu', created_by: 'kyle', status: 'pending', est: { hours: 9 } },
        { lane: 'local-rocm1', created_by: 'planner', status: 'pending', est: { hours: 9 } },
    ];
    assert.strictEqual(AQ.plannerHours(rows, 'local-gpu'), 3.5);
});

test('focus defaults: the Q8_K_XL and Flash-Next GSQ-RCO IQ3_XXS configs exist, with their lane and row env', () => {
    const q8 = AQ.DEFAULT_MODELS.find((m) => m.id === 'q27-q8');
    const fn = AQ.DEFAULT_MODELS.find((m) => m.id === 'fn-gsq-iq3xxs');
    assert.strictEqual(q8.catalogKey, 'local:qwen3.8-27b:q8-k-xl');
    assert.deepStrictEqual(q8.env, { CODEBENCH_DEVICES: 'ROCm0,ROCm1', CODEBENCH_ROW_VARIANT: 'tensor-split-two-xtx' });
    assert.match(q8.cmd, /-sm tensor/); assert.ok(!/"/.test(q8.cmd), 'no bare quote: the queue refuses those');
    assert.strictEqual(fn.catalogKey, 'local:qwen3.8-flash-next-gsq-rco:iq3-xxs');
    assert.match(fn.cmd, /Strata-0\.1\.43\.1\/queue-serve\.sh .*strata-iq3_xxs\.json$/);
    assert.strictEqual(fn.queueLane, 'local-gpu');
});

test('focus defaults: a saved Q2_K_XL entry that is the OLD 128k KV f16 default verbatim reads as the new Q4-comparable one (128k KV q8_0, one XTX); an edited one stays', () => {
    const HF = AQ.DEFAULT_MODELS.find((m) => m.id === 'q27-iq2').weights.replace(/Qwen3\.8-27B-UD-IQ2_XXS\.gguf$/, '');
    const old = { id: 'q27-q2', role: 'contender', opencodeModel: 'qwen38-27b-q4-128k', nCtx: 131072, cmd: `$STOCK -m ${HF}Qwen3.8-27B-UD-Q2_K_XL.gguf -c 131072 $D27MTP` };
    const m = AQ.mergeModels([old]).find((x) => x.id === 'q27-q2');
    assert.strictEqual(m.nCtx, 131072); assert.strictEqual(m.queueLane, 'local-rocm1'); assert.match(m.cmd, /Q2_K_XL\.gguf -c 131072 .*-dev ROCm1 --cache-type-k q8_0 --cache-type-v q8_0$/);
    const q4 = AQ.mergeModels([{ id: 'q4', opencodeModel: 'qwen38-27b-q4-128k', cmd: '$STOCK -m $Q4 -c 131072 $D27MTP' }]).find((x) => x.id === 'q4');
    assert.match(q4.cmd, /--cache-type-k q8_0 --cache-type-v q8_0$/, 'the old KV f16 Q4_K_XL entry reads as the KV q8_0 one');
    const edited = AQ.mergeModels([{ ...old, cmd: `${old.cmd} --mine` }]).find((x) => x.id === 'q27-q2');
    assert.strictEqual(edited.nCtx, 131072, 'a user edit is never overridden');
    assert.match(edited.cmd, /--mine$/);
});

test('focus defaults: a saved Flash-Next UD-IQ4_XS entry that is the OLD Strata 0.1.43.1 plain-split default verbatim reads as the 0.1.44.1 spec 3 one; an edited one stays', () => {
    const def = AQ.DEFAULT_MODELS.find((m) => m.id === 'fn-udiq4xs-strata-262k');
    const dir = def.weights.replace(/Strata-0\.1\.44\.1\/.*$/, 'Strata-0.1.43.1');
    const old = { id: 'fn-udiq4xs-strata-262k', role: 'contender', opencodeModel: 'local-262k', nCtx: 262144, queueLane: 'local-gpu', env: { CODEBENCH_DEVICES: 'ROCm0,ROCm1' },
        weights: `${dir}/strata-ud-iq4_xs-262k-int8-2xtx.json`, cmd: `${dir}/queue-serve.sh ${dir}/strata-ud-iq4_xs-262k-int8-2xtx.json` };
    const m = AQ.mergeModels([old]).find((x) => x.id === 'fn-udiq4xs-strata-262k');
    assert.match(m.cmd, /Strata-0\.1\.44\.1\/queue-serve\.sh .*Strata-0\.1\.44\.1\/strata-ud-iq4_xs-262k-int8-2xtx-pw2-kcopy-spec3\.json$/);
    assert.strictEqual(m.weights, def.weights);
    const edited = AQ.mergeModels([{ ...old, cmd: `${old.cmd} --mine` }]).find((x) => x.id === 'fn-udiq4xs-strata-262k');
    assert.match(edited.cmd, /2xtx\.json --mine$/, 'a user edit is never overridden');
});

test('derive: a run under a longer cap that finished inside 2 h counts as ran at the benchmark config (as the identity guard counts it); a timeout does not', async () => {
    const { derive } = await ui('autoqueue/derive.js');
    const tk = (solved, wall, status) => ({ status: status || (solved ? 'pass' : 'fail'), solved, excluded: false, credit: solved ? 1 : 0, attempts: 1, passes: solved ? 1 : 0, wall_s: wall, ran_at: 1 });
    const cfg = (key, tasks, timeout_s, w = 'local:A') => ({ key, runnerModel: 'x', n_ctx: 131072, timeout_s, runner: 'opencode', dirs: [key],
        facets: { weights: w, harness: { timeout_s }, context: { n_ctx: 131072 } }, agg: { attempted: Object.keys(tasks).length, scored: Object.keys(tasks).length }, tasks });
    const catalog = { allTaskIds: ['a', 'b', 'c', 'd'], taskMeta: {}, models: [
        { key: 'local:A', display: 'A', weightsKey: 'local:A', counts: { qualityTasks: 4 }, quality: {}, configs: [cfg('A2', { a: tk(1, 600), b: tk(0, 900) }, 7200), cfg('A3', { c: tk(0, 5000), d: tk(0, 10800, 'TIMEOUT') }, 10800)] },
        { key: 'local:W', display: 'W', weightsKey: 'local:W', counts: { qualityTasks: 4 }, quality: {}, configs: [cfg('W2', { a: tk(0, 600), b: tk(0, 600), c: tk(1, 600), d: tk(0, 600) }, 7200, 'local:W')] },
    ] };
    const d = derive(catalog, { models: [{ id: 'A', catalogKey: 'local:A', role: 'contender', nCtx: 131072 }] });
    assert.deepStrictEqual(Object.keys(d.input.models[0].cfg).sort(), ['a', 'b', 'c']);
});

test('queue: the Queue view\'s presets carry a config\'s own lane and env (a Strata launch names no card: CODEBENCH_DEVICES does)', () => {
    const { q } = freshQueue();
    const pr = q.presets({ models: qSettings().models }).presets;
    const c = pr.find((p) => p.id === 'C');
    assert.strictEqual(c.lane, 'local-rocm1');
    assert.deepStrictEqual(c.env, { CODEBENCH_DEVICES: 'ROCm1', CODEBENCH_DOCS: 'off' });
    assert.strictEqual(pr.find((p) => p.id === 'A').lane, 'local-gpu');
    const fn = q.presets({ models: AQ.DEFAULT_MODELS }).presets.find((p) => p.id === 'fn-gsq-iq3xxs');
    assert.deepStrictEqual(fn.env, { CODEBENCH_DEVICES: 'ROCm0', CODEBENCH_DOCS: 'off' });
});
