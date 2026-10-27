// The Solve map's "Tensor split: separate / combine" switch (2026-10-13, Kyle): ui/shared/leaderboard.js
// foldTensorRows / tensorBaseKey / foldTensorRun. Pure: a catalog in, the same catalog or its folded twin out.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// the browser module, with its DOM-facing import stubbed (as test/compare.test.js loads it)
async function loadLb() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'shared', 'leaderboard.js'), 'utf-8');
    const stub = 'data:text/javascript,' + encodeURIComponent(
        'export const esc=(s)=>String(s??"");export const fmtDur=(s)=>String(s);export const fmtN=(n)=>String(n);'
        + 'export const harnessLabel=(r)=>r||null;export const scaffoldBit=(r,s)=>s||null;'
        // the real context rule (ui/shared/ctxlabel.js, 2026-10-25): a stub never carries a copy of it
        + `import ${JSON.stringify(require('url').pathToFileURL(path.join(__dirname, '..', 'ui', 'shared', 'ctxlabel.js')).href)};export const { ctxLabel, commonWindow } = globalThis.CtxLabel;`);
    return import('data:text/javascript,' + encodeURIComponent(src.replace("from '../benchmarks/util.js'", `from '${stub}'`)));
}

const cell = (passes, attempts) => ({ status: passes >= attempts ? 'pass' : 'fail', attempts, passes, credit: attempts ? passes / attempts : null,
    solved: passes > 0, excluded: !attempts, wall_s: 100, tokens_out: 1000 });
const HARNESS = { runner: 'opencode', prompt_level: 'L2' };
const config = (weights, placement, tasks, dirs, extra = {}) => ({
    key: JSON.stringify([['weights', weights], ['placement', placement]]), dirs, tasks, n_ctx: 131072,
    agg: { attempted: Object.keys(tasks).length, scored: Object.keys(tasks).length },
    facets: { weights, harness: HARNESS, context: { n_ctx: 131072 }, output: ['--jinja'], kv: ['--cache-type-k q8_0'], other: [], placement, ...extra } });
const model = (key, display, configs, extra = {}) => {
    const tasks = {};
    for (const c of configs) for (const [id, t] of Object.entries(c.tasks)) tasks[id] = t;
    return { key, display, weightsKey: key, weightsDisplay: display, provider: 'local', configs, tasks,
        counts: { requests: 5, benchRuns: 0, sweepRows: 0, qualityBatteries: configs.length, qualityTasks: Object.keys(tasks).length },
        quality: { attempted: Object.keys(tasks).length, scored: Object.keys(tasks).length, solved: 1, harnessIncompatible: false },
        batteries: configs.flatMap((c) => c.dirs.map((dir, i) => ({ dir, ended: 10 + i }))), sources: [], speedConfigs: [], ...extra };
};
const BASE = 'local:qwen3.8-27b:q4-k-xl', TEN = BASE + '~rv:tensor-split-two-xtx';
const catalogOf = () => ({ generatedAt: 1, allTaskIds: ['t1', 't2', 't3'], models: [
    model(BASE, 'Qwen3.8-27B Q4_K_XL', [config(BASE, ['-dev ROCm0'], { t1: cell(1, 1), t2: cell(0, 1) }, ['one-card'])]),
    model(TEN, 'Qwen3.8-27B Q4_K_XL (tensor-split-two-xtx)', [config(TEN, ['-dev ROCm0,ROCm1', '-sm tensor'], { t2: cell(1, 1), t3: cell(1, 1) }, ['tensor-a'])]),
    model(BASE + '~nothink', 'Qwen3.8-27B Q4_K_XL (thinking off)', [config(BASE + '~nothink', ['-dev ROCm0'], { t1: cell(1, 1) }, ['nothink'])]),
    model('local:other:q8~rv:tensor-split-two-xtx', 'Other Q8 (tensor-split-two-xtx)', [config('local:other:q8~rv:tensor-split-two-xtx', ['-sm tensor'], { t1: cell(1, 1) }, ['orphan'])]),
    model('local:x:q4~rv:review-fn-iq3xxs', 'X Q4 (reviewing)', [config('local:x:q4~rv:review-fn-iq3xxs', [], { t1: cell(0, 1) }, ['review'])]),
    model('local:x:q4', 'X Q4', [config('local:x:q4', [], { t1: cell(1, 1) }, ['x'])]),
] });

test('tensorBaseKey: only a tensor-split row variant is a foldable part of a key', async () => {
    const L = await loadLb();
    assert.strictEqual(L.tensorBaseKey(TEN), BASE);
    assert.strictEqual(L.tensorBaseKey(BASE + '~nothink~rv:tensor-split-two-xtx'), BASE + '~nothink');
    assert.strictEqual(L.tensorBaseKey(BASE + '~rv:Tensor-Split'), BASE);
    assert.strictEqual(L.tensorBaseKey(BASE), null);
    assert.strictEqual(L.tensorBaseKey(BASE + '~rv:review-fn-iq3xxs'), null);
    assert.strictEqual(L.tensorBaseKey(BASE + '~helper:qwen3.8-27b-gsq-rco-iq2-xs'), null);
    assert.strictEqual(L.tensorBaseKey(BASE + '~rv:plan-only-stage'), null);
});

test('foldTensorRows: the variant joins its base model; every other row is left as it is', async () => {
    const L = await loadLb();
    const raw = catalogOf(), before = JSON.stringify(raw);
    const f = L.foldTensorRows(raw);
    assert.strictEqual(JSON.stringify(raw), before, 'the source catalog is not changed');
    assert.notStrictEqual(f, raw);
    assert.strictEqual(L.foldTensorRows(raw), f, 'one folded object per source catalog (the page caches key on identity)');
    assert.deepStrictEqual(f.models.map((m) => m.key), [BASE, BASE + '~nothink', 'local:other:q8~rv:tensor-split-two-xtx', 'local:x:q4~rv:review-fn-iq3xxs', 'local:x:q4']);
    assert.deepStrictEqual(f.tensorFolded, { [TEN]: BASE });
    assert.strictEqual(f.allTaskIds, raw.allTaskIds);

    const m = f.models[0];
    assert.strictEqual(m.display, 'Qwen3.8-27B Q4_K_XL');
    assert.strictEqual(m.configs.length, 2);
    assert.deepStrictEqual(m.configs.map((c) => c.facets.weights), [BASE, BASE]);
    assert.strictEqual(m.configs[1].tensorFoldedFrom, TEN);
    assert.ok(!m.configs[1].key.includes('tensor-split-two-xtx') && m.configs[1].key.includes(JSON.stringify(BASE)), 'the config key names the base model');
    assert.deepStrictEqual(m.configs[1].facets.placement, ['-dev ROCm0,ROCm1', '-sm tensor'], 'placement still says tensor split');
    // t2 was failed on one card and passed on tensor split: 1 of 2
    assert.deepStrictEqual(Object.keys(m.tasks).sort(), ['t1', 't2', 't3']);
    assert.strictEqual(m.tasks.t2.attempts, 2); assert.strictEqual(m.tasks.t2.passes, 1); assert.strictEqual(m.tasks.t2.credit, 0.5);
    assert.strictEqual(m.counts.qualityTasks, 3); assert.strictEqual(m.counts.qualityBatteries, 2); assert.strictEqual(m.counts.requests, 10);
    assert.strictEqual(m.quality.scored, 3); assert.strictEqual(m.quality.solved, 2.5);
    assert.deepStrictEqual(m.batteries.map((b) => b.dir).sort(), ['one-card', 'tensor-a']);
    // the other rows are the very same objects
    assert.strictEqual(f.models[1], raw.models[2]);
    assert.strictEqual(f.models[3], raw.models[4]);
    assert.strictEqual(f.models[4], raw.models[5]);
    // no base model in the catalog: the row keeps its key (the server knows it by that) and loses only the words
    assert.strictEqual(f.models[2].key, 'local:other:q8~rv:tensor-split-two-xtx');
    assert.strictEqual(f.models[2].display, 'Other Q8');
    assert.strictEqual(f.models[2].configs, raw.models[3].configs);
});

test('foldTensorRows: quality grouping pools the tensor config with the base config; a placement-keeping grouping does not', async () => {
    const L = await loadLb();
    const raw = catalogOf(), f = L.foldTensorRows(raw);
    const entries = (cat, key) => cat.models.filter((m) => (L.tensorBaseKey(m.key) || m.key) === key || m.key === key).flatMap((m) => m.configs.map((c) => ({ m, c })));
    const sep = L.groupConfigs(entries(raw, BASE).filter((e) => e.m.key === BASE), L.FACET_DEFAULTS.quality);
    assert.strictEqual(sep.length, 1); assert.deepStrictEqual(Object.keys(sep[0].tasks).sort(), ['t1', 't2']);
    const pooled = L.groupConfigs(f.models[0].configs.map((c) => ({ m: f.models[0], c })), L.FACET_DEFAULTS.quality);
    assert.strictEqual(pooled.length, 1, 'one quality config: same context, KV type and prompt');
    assert.deepStrictEqual(Object.keys(pooled[0].tasks).sort(), ['t1', 't2', 't3']);
    assert.strictEqual(pooled[0].tasks.t2.credit, 0.5);
    assert.deepStrictEqual(pooled[0].dirs.sort(), ['one-card', 'tensor-a']);
    const timed = L.groupConfigs(f.models[0].configs.map((c) => ({ m: f.models[0], c })), L.FACET_DEFAULTS.full);
    assert.strictEqual(timed.length, 2, 'time charts keep card placement apart');
});

test('foldTensorRows: a catalog with no tensor-split row comes back as the same object', async () => {
    const L = await loadLb();
    const raw = { models: [model('local:x:q4', 'X Q4', [config('local:x:q4', [], { t1: cell(1, 1) }, ['x'])])] };
    assert.strictEqual(L.foldTensorRows(raw), raw);
    assert.strictEqual(L.foldTensorRows(null), null);
    assert.deepStrictEqual(L.foldTensorRows({}), {});
});

test('foldTensorRun: a running tensor-split battery lands on its base model only when that row was folded', async () => {
    const L = await loadLb();
    const f = L.foldTensorRows(catalogOf());
    const run = { dir: 'tensor-b', task: 't3', modelKey: TEN, facets: { weights: TEN, placement: ['-sm tensor'] } };
    const g = L.foldTensorRun(run, f.tensorFolded);
    assert.strictEqual(g.modelKey, BASE); assert.strictEqual(g.facets.weights, BASE); assert.deepStrictEqual(g.facets.placement, ['-sm tensor']);
    assert.strictEqual(run.modelKey, TEN, 'the polled entry itself is not changed');
    assert.strictEqual(L.foldTensorRun(run, undefined), run, 'rows separate: as filed');
    const orphan = { dir: 'o', task: 't1', modelKey: 'local:other:q8~rv:tensor-split-two-xtx' };
    assert.strictEqual(L.foldTensorRun(orphan, f.tensorFolded), orphan, 'no base model: the row kept its key');
    const plain = { dir: 'p', task: 't1', modelKey: BASE };
    assert.strictEqual(L.foldTensorRun(plain, f.tensorFolded), plain);
});
