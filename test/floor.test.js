// Lane floor (lib/autoqueue.js laneHours / floorEnv / planFloor / floor, 2026-10-21; Kyle: "lanes should never be sitting
// empty ... empty lanes should get populated and not waste time"). planFloor runs on a stub queue and a stub fit (the real
// ui/shared/leaderboard.js for problemOf / strengthRank), so every rule is pinned without the catalog: all items count
// toward a lane's hours, held items do not; paused lanes and the cloud lane are never filled; an item is released only when
// its notes OPEN with [backlog] and do not say BACKBURNER; gaps are the reference row's problems the config's row has not
// scored, hardest first, minus what the identity guard says is scored / waiting / queued; chunks per level x composite;
// strongest config first; three launch failures stop a config; `never` rules; the field tier; and the real insert path.
// The queue's draft guard is tested on a temp database with an injected identity.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'floor-test-'));
process.env.AUTOQUEUE_SETTINGS = path.join(TMP, 'autoqueue.json');
process.env.AUTOQUEUE_BATCHES = path.join(TMP, 'batches.json');
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
const AQ = require('../lib/autoqueue.js');
const { createQueue } = require('../lib/queue.js');
const LB = () => import(pathToFileURL(path.join(__dirname, '..', 'ui', 'shared', 'leaderboard.js')).href);

// ---- stubs -------------------------------------------------------------------------------------------------------
const meta = { a: { repo: 'club-app' }, b: { repo: 'club-app' }, c: { repo: 'club-app' }, d: { repo: 'club-app' }, e: { repo: 'club-app' },
    m1: { repo: 'multi', category: ['multi'] }, m2: { repo: 'multi', category: ['multi'] }, old: { repo: 'club-app', unscored: true }, f: { repo: 'club-app' } };
const grp = (key, dirs, problems) => ({ key, dirs, q: { scored: problems.length }, tasks: Object.fromEntries(problems.map((p) => [p, { attempts: 1, solved: true, excluded: false }])) });
// reference row R ran a b c d e a@L3 m1 m2 old; config X ran a; config Y ran a b c d e a@L3 m1 m2 (nothing left)
const GROUPS = [grp('R', ['dR'], ['a', 'b', 'c', 'd', 'e', 'a@L3', 'm1', 'm2', 'old', 'a+bonus']), grp('X', ['dX'], ['a']), grp('Y', ['dY'], ['a', 'b', 'c', 'd', 'e', 'a@L3', 'm1', 'm2']), grp('Z', ['dZ'], ['a', 'b'])];
const DIFF = new Map([['a', 0.1], ['b', 2.0], ['c', 1.0], ['d', 3.0], ['e', -1.0], ['a@L3', 2.5], ['m1', 1.5], ['m2', 0.5], ['old', 9], ['f', 4.0]]);
const STRENGTH = { R: { strength: 52, lo: 0.48 }, X: { strength: 50, lo: 0.40 }, Y: { strength: 61, lo: 0.57 }, Z: { strength: 49, lo: 0.45 } };
async function stubL() {
    const real = await LB();
    return { problemOf: real.problemOf, strengthRank: real.strengthRank,
        overviewView: () => ({ keepQ: null, keepT: null }), overviewCatalog: (cat) => ({ models: cat.models || [] }),
        fitFor: () => ({ qAll: GROUPS, adj: { get: (k) => STRENGTH[k] || null, taskDifficulty: DIFF } }) };
}
const T = (id, lane, launch, extra = {}) => ({ id, kind: 'run', lane, runner: 'opencode', model: 'm', launch_cmd: launch, timeout_s: 7200, env: { CODEBENCH_DEVICES: 'ROCm0', CODEBENCH_PROMPT_LEVEL: 'L3', CODEBENCH_CONTINUE_FROM: 'x' }, notes: '', ...extra });
function stubQueue({ active = [], items = {}, guard = () => ({}), dirs = {}, last = {}, lanes = [] } = {}) {
    const inserted = []; const released = [];
    return {
        inserted, released,
        list: () => ({ lanes, running: active.filter((x) => x.status === 'running'), pending: active.filter((x) => x.status !== 'running') }),
        get: (id) => items[id] || null,
        draftDirs: (f) => new Set(dirs[f.launch_cmd] || []),
        draftGuard: (f, tasks) => { const g = guard(f, tasks) || {}; return { key: 'k', scored: new Set(g.scored || []), waiting: new Set(g.waiting || []), queued: new Set(g.queued || []) }; },
        estimateDraft: (f) => ({ hours: f.tasks.length * 0.5 }),
        lastFinished: (lane) => last[lane] || [],
        freeLabel: (b) => b,
        insert: (f, o) => { const r = { id: 900 + inserted.length, ...f, created_by: o.createdBy }; inserted.push(r); return r; },
        setStatus: (id, a) => { released.push([id, a]); return { id }; },
    };
}
const SETTINGS = (floor = {}) => ({ ...AQ.loadSettings(), floor: { ...AQ.DEFAULT_SETTINGS.floor, enabled: true, hours: 3, topUpHours: 6, chunkTasks: 2, compositeChunk: 2,
    reference: { template: 1, label: 'REF' }, never: [], lanes: { 'local-gpu': [{ id: 'x', label: 'X', template: 2 }] }, ...floor } });
const ITEMS = { 1: T(1, 'local-gpu', 'REF-CMD'), 2: T(2, 'local-gpu', 'X-CMD'), 3: T(3, 'local-gpu', 'Y-CMD'), 4: T(4, 'local-rocm1', 'strata/queue-serve.sh Flash-Next-IQ3'), 6: T(6, 'local-gpu', 'Z-CMD') };
const DIRS = { 'REF-CMD': ['dR'], 'X-CMD': ['dX'], 'Y-CMD': ['dY'], 'Z-CMD': ['dZ'] };

// ---- pure helpers --------------------------------------------------------------------------------------------------
test('floor: laneHours counts every pending + running item (any creator), not held ones; no estimate = 40 min a task', () => {
    const active = [{ lane: 'L', status: 'running', created_by: 'kyle', est: { hours: 2 } }, { lane: 'L', status: 'pending', created_by: 'claude', est: null, tasks: ['a', 'b', 'c'] },
        { lane: 'L', status: 'paused', created_by: 'kyle', est: { hours: 50 } }, { lane: 'M', status: 'pending', est: { hours: 9 } }];
    assert.strictEqual(AQ.laneHours(active, 'L'), 4);
});
test('floor: floorEnv keeps the template env, drops what belongs to its own run, sets level / composite switch / docs off', () => {
    const env = { CODEBENCH_DEVICES: 'ROCm0', CODEBENCH_PROMPT_LEVEL: 'L3', CODEBENCH_CONTINUE_FROM: 'x', CODEBENCH_ALLOW_RERUN: '1', OPENCODE_CONFIG_CONTENT: '{}', LLAMA_ARG_CACHE_RAM: '2048' };
    assert.deepStrictEqual(AQ.floorEnv(env), { CODEBENCH_DEVICES: 'ROCm0', LLAMA_ARG_CACHE_RAM: '2048', CODEBENCH_DOCS: 'off' });
    assert.strictEqual(AQ.floorEnv(env, { level: 'L3' }).CODEBENCH_PROMPT_LEVEL, 'L3');
    assert.deepStrictEqual(JSON.parse(AQ.floorEnv(env, { composite: true }).OPENCODE_CONFIG_CONTENT), { tools: { task: false }, permission: { task: 'deny' } });
});

// ---- planFloor -----------------------------------------------------------------------------------------------------
test('floor: a lane at or over the floor, a paused lane and the cloud lane get nothing', async () => {
    const L = await stubL();
    const q = stubQueue({ items: ITEMS, dirs: DIRS, active: [{ id: 5, lane: 'local-gpu', status: 'pending', est: { hours: 3 } }], lanes: [{ lane: 'local-rocm1', paused: 1, note: 'by hand' }] });
    const res = AQ.planFloor({ settings: SETTINGS({ lanes: { 'local-gpu': [{ id: 'x', template: 2 }], 'local-rocm1': [], cloud: [] } }), queue: q, catalog: { taskMeta: meta }, L });
    const by = Object.fromEntries(res.lanes.map((x) => [x.lane, x]));
    assert.strictEqual(by['local-gpu'].action, 'none'); assert.match(by['local-gpu'].reason, /3 h queued/);
    assert.match(by['local-rocm1'].reason, /lane paused: by hand/);
    assert.match(by.cloud.reason, /never fills the cloud lane/);
});
test('floor: releases the oldest held item whose notes OPEN with [backlog] -- not "no [backlog] tag", not BACKBURNER', async () => {
    const L = await stubL();
    const active = [
        { id: 10, lane: 'local-gpu', status: 'paused', created_at: '2026-10-01', notes: 'Kyle: keep (no [backlog] tag, so idle-guard will not release it)' },
        { id: 11, lane: 'local-gpu', status: 'paused', created_at: '2026-10-02', notes: '[backlog] but BACKBURNER since 10-21' },
        { id: 12, lane: 'local-gpu', status: 'paused', created_at: '2026-10-04', notes: '[backlog] Kyle 10-20: fill the row' },
        { id: 13, lane: 'local-gpu', status: 'paused', created_at: '2026-10-03', notes: '[backlog] older one' },
    ];
    const q = stubQueue({ items: ITEMS, dirs: DIRS, active });
    const res = AQ.planFloor({ settings: SETTINGS(), queue: q, catalog: { taskMeta: meta }, L });
    assert.strictEqual(res.lanes[0].action, 'release');
    assert.strictEqual(res.lanes[0].release.id, 13);
});
test('floor: gaps against the reference row, hardest first, minus scored / waiting / queued at the identity; chunks per level x composite', async () => {
    const L = await stubL();
    // X's row ran a; the identity also scored c, waits on b's continuation; e is queued already; 'old' is unscored; a+bonus never counts
    const q = stubQueue({ items: ITEMS, dirs: DIRS, guard: (f) => (f.env.CODEBENCH_PROMPT_LEVEL ? {} : f.env.OPENCODE_CONFIG_CONTENT ? {} : { scored: ['c'], waiting: ['b'], queued: ['e'] }) });
    const res = AQ.planFloor({ settings: SETTINGS({ topUpHours: 100 }), queue: q, catalog: { taskMeta: meta }, L });
    const r = res.lanes[0];
    assert.strictEqual(r.action, 'fill');
    const rows = r.items.filter((x) => x.tier === 'reference').map((x) => [x.level, x.composite, x.tasks]);
    // hardest first: d (3.0, L2) ; a@L3 (2.5) ; m1+m2 composites (1.5, 0.5) -- b waits, c scored, e queued, a ran
    assert.deepStrictEqual(rows, [['L2', false, ['d']], ['L3', false, ['a']], ['L2', true, ['m1', 'm2']]]);
    const comp = r.items.find((x) => x.composite);
    assert.strictEqual(comp.fields.timeout_s, 10800);
    assert.ok(/"task":false/.test(comp.fields.env.OPENCODE_CONFIG_CONTENT));
    const l3 = r.items.find((x) => x.level === 'L3');
    assert.strictEqual(l3.fields.env.CODEBENCH_PROMPT_LEVEL, 'L3');
    assert.ok(!('CODEBENCH_CONTINUE_FROM' in l3.fields.env));
    assert.strictEqual(l3.fields.launch_cmd, 'X-CMD');
    assert.ok(!('notes' in l3.fields) && !('label' in l3.fields));
    // the field tier (problems any row ran) comes after: f (4.0) is not a reference problem
    assert.deepStrictEqual(r.items.filter((x) => x.tier === 'field').map((x) => x.tasks), [['f']]);
});
test('floor: the strongest config (fit low end) is filled first; it stops at topUpHours; a config without gaps passes', async () => {
    const L = await stubL();
    const q = stubQueue({ items: ITEMS, dirs: DIRS });
    // Y (lo 0.57) has no reference gaps; X (lo 0.40) and Z (lo 0.45) do: Z first, and 1 h = one chunk of 2 at 0.5 h a task
    const s = SETTINGS({ topUpHours: 1, lanes: { 'local-gpu': [{ id: 'x', template: 2 }, { id: 'y', template: 3 }, { id: 'z', template: 6 }] } });
    const r = AQ.planFloor({ settings: s, queue: q, catalog: { taskMeta: meta }, L }).lanes[0];
    assert.deepStrictEqual(r.items.map((x) => [x.config, x.tier, x.tasks]), [['z', 'reference', ['d', 'c']]]);
    assert.ok(r.skipped.some((x) => x.config === 'y' && x.tier === 'reference'));
    // with more room: Z's reference gaps, then X's; the field tier only after both (Y first there: the strongest)
    const r2 = AQ.planFloor({ settings: SETTINGS({ topUpHours: 100, lanes: s.floor.lanes }), queue: q, catalog: { taskMeta: meta }, L }).lanes[0];
    const order = r2.items.map((x) => `${x.config}/${x.tier}`);
    assert.strictEqual(order[0], 'z/reference');
    assert.ok(order.indexOf('x/reference') > order.lastIndexOf('z/reference'));
    assert.ok(order.indexOf('y/field') > order.lastIndexOf('x/reference'));
    assert.ok(order.indexOf('y/field') < order.indexOf('z/field'));
});
test('floor: three launch failures in a row with a config stop it there, said in the reason; other configs still go', async () => {
    const L = await stubL();
    const fail = { status: 'failed', launch_cmd: 'X-CMD', outcome: { reason: 'LAUNCH FAILED' } };
    const q = stubQueue({ items: ITEMS, dirs: DIRS, last: { 'local-gpu': [fail, fail, fail] } });
    const r = AQ.planFloor({ settings: SETTINGS(), queue: q, catalog: { taskMeta: meta }, L }).lanes[0];
    assert.strictEqual(r.action, 'stuck');
    assert.match(r.reason, /failed at launch/);
    const q2 = stubQueue({ items: ITEMS, dirs: DIRS, last: { 'local-gpu': [fail, fail, { status: 'done', launch_cmd: 'X-CMD', outcome: {} }] } });
    assert.strictEqual(AQ.planFloor({ settings: SETTINGS(), queue: q2, catalog: { taskMeta: meta }, L }).lanes[0].action, 'fill');
});
test('floor: never rules (by launch, optionally per lane) and BACKBURNER templates are not fed', async () => {
    const L = await stubL();
    const q = stubQueue({ items: { ...ITEMS, 2: T(2, 'local-gpu', 'X-CMD', { notes: 'BACKBURNER (Kyle 10-21)' }) }, dirs: DIRS });
    const r = AQ.planFloor({ settings: SETTINGS(), queue: q, catalog: { taskMeta: meta }, L }).lanes[0];
    assert.strictEqual(r.items.length, 0); assert.match(r.skipped[0].reason, /BACKBURNER/);
    const s = SETTINGS({ lanes: { 'local-rocm1': [{ id: 'fn', template: 4 }] }, never: AQ.DEFAULT_SETTINGS.floor.never });
    const r2 = AQ.planFloor({ settings: s, queue: stubQueue({ items: ITEMS, dirs: DIRS }), catalog: { taskMeta: meta }, L }).lanes[0];
    assert.strictEqual(r2.items.length, 0); assert.match(r2.skipped[0].reason, /never fed/);
    assert.ok(AQ.DEFAULT_SETTINGS.floor.never.some((n) => /Flash-Next-UD-Q2_K_XL/.test(n.pattern)));
    assert.ok(!Object.values(AQ.DEFAULT_SETTINGS.floor.lanes).flat().some((c) => /q2kxl/.test(c.id) && /fn/.test(c.id)));
});
test('floor: the real pass inserts at the lane end as planner rows with [floor] notes, or releases; dry run and disabled write nothing', async () => {
    const L = await stubL();
    const s = SETTINGS();
    const q = stubQueue({ items: ITEMS, dirs: DIRS });
    await AQ.floor({ dryRun: true }, { queue: q, settings: s, catalog: async () => ({ taskMeta: meta }), L });
    await AQ.floor({ dryRun: false }, { queue: q, settings: { ...s, floor: { ...s.floor, enabled: false } }, catalog: async () => ({ taskMeta: meta }), L });
    assert.strictEqual(q.inserted.length, 0);
    const res = await AQ.floor({ dryRun: false }, { queue: q, settings: s, catalog: async () => ({ taskMeta: meta }), L });
    assert.ok(q.inserted.length >= 1);
    assert.ok(q.inserted.every((r) => r.created_by === 'planner' && /^\[floor\]/.test(r.notes) && r.kind === 'run' && r.lane === 'local-gpu'));
    assert.match(q.inserted[0].notes, /Config copied from item 2/);
    assert.deepStrictEqual(res.lanes[0].inserted.map((x) => x.id), q.inserted.map((x) => x.id));
    const q2 = stubQueue({ items: ITEMS, dirs: DIRS, active: [{ id: 13, lane: 'local-gpu', status: 'paused', created_at: '1', notes: '[backlog] x' }] });
    await AQ.floor({ dryRun: false }, { queue: q2, settings: s, catalog: async () => ({ taskMeta: meta }), L });
    assert.deepStrictEqual(q2.released, [[13, 'release']]);
});
test('floor: settings refuse the cloud lane, configs without a template, a bad never list', () => {
    const base = AQ.loadSettings();
    assert.throws(() => AQ.saveSettings({ floor: { ...base.floor, lanes: { cloud: [] } } }), /cloud/);
    assert.throws(() => AQ.saveSettings({ floor: { ...base.floor, lanes: { 'local-gpu': [{ id: 'x' }] } } }), /template/);
    assert.throws(() => AQ.saveSettings({ floor: { ...base.floor, never: [{}] } }), /never/);
    const ok = AQ.saveSettings({ floor: { ...base.floor, enabled: true } });
    assert.strictEqual(ok.floor.enabled, true);
});

// ---- the queue's draft guard (temp database, injected identity) ----------------------------------------------------------
test('queue: draftGuard -- scored / waiting from the identity, queued from active rows of the SAME identity only', () => {
    const dir = fs.mkdtempSync(path.join(TMP, 'q-'));
    fs.writeFileSync(path.join(dir, 'vars.env'), 'STOCK=/bin/llama-server\n');
    const keyOf = (spec) => (spec && /q8/.test(spec.launch) ? 'K8' : 'K4');
    const identity = {
        identityOfSpec: (spec) => ({ key: keyOf(spec) }),
        scoredIndex: () => ({}),
        scoredFor: (id, tasks) => (id.key === 'K4' ? Object.fromEntries((tasks || ['s']).filter((t) => t === 's').map((t) => [t, [{ status: 'pass', dir: 'd4' }]])) : {}),
        unfinishedFor: (id, tasks) => (id.key === 'K4' && (tasks || []).includes('w') ? { w: [{ session: 'saved' }] } : {}),
        awaitsContinuation: (u) => u.session === 'saved',
    };
    const q = createQueue({ dbPath: path.join(dir, 'bench.sqlite'), envFiles: [path.join(dir, 'vars.env')], identity, harnessConfig: () => ({ runner: 'opencode', prompt_level: 'L2', timeout_s: 7200 }) });
    q.insert({ label: 'p4', runner: 'opencode', model: 'm', launch_cmd: '$STOCK -m q4.gguf', tasks: ['x', 'y'] });
    q.insert({ label: 'p8', runner: 'opencode', model: 'm', launch_cmd: '$STOCK -m q8.gguf', tasks: ['z'] });
    const held = q.insert({ label: 'h4', runner: 'opencode', model: 'm', launch_cmd: '$STOCK -m q4.gguf', tasks: ['v'] }); q.setStatus(held.id, 'hold');
    const g = q.draftGuard({ lane: 'local-gpu', runner: 'opencode', model: 'm', launch_cmd: '$STOCK -m q4.gguf', env: {} }, ['s', 'w', 'x', 'z', 'n']);
    assert.strictEqual(g.key, 'K4');
    assert.deepStrictEqual([...g.scored], ['s']);
    assert.deepStrictEqual([...g.waiting], ['w']);
    assert.deepStrictEqual([...g.queued].sort(), ['v', 'x', 'y']);   // the q8 row's z is another identity
    assert.deepStrictEqual([...q.draftDirs({ lane: 'local-gpu', runner: 'opencode', model: 'm', launch_cmd: '$STOCK -m q4.gguf', env: {} })], ['d4']);
    assert.strictEqual(q.freeLabel('p4'), 'p4-r2');
    assert.strictEqual(q.lastFinished('local-gpu').length, 0);
    q.close();
});
