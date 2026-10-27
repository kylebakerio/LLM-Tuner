// The "f32ssm copies" switches (2026-10-14, Kyle: "...the results should merge, you can add in a config toggle that lets
// one manually select whether those should be separated on quality or speed and by default we will say it should
// differentiate on neither"): ui/shared/leaderboard.js FILE_VARIANTS / fileBaseKey / foldFileVariants / foldFileRun /
// fileVariantRows / timeKeepWith / fileSpeedModels. Pure: a catalog in, the same catalog or its folded twin out.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// the browser module, with its DOM-facing import stubbed (as test/tensorfold.test.js loads it)
async function loadLb() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'shared', 'leaderboard.js'), 'utf-8');
    const stub = 'data:text/javascript,' + encodeURIComponent(
        'export const esc=(s)=>String(s??"");export const fmtDur=(s)=>String(s);export const fmtN=(n)=>String(n);'
        + 'export const harnessLabel=(r)=>r||null;export const scaffoldBit=(r,s)=>s||null;'
        // the real context rule (ui/shared/ctxlabel.js, 2026-10-25): a stub never carries a copy of it
        + `import ${JSON.stringify(require('url').pathToFileURL(path.join(__dirname, '..', 'ui', 'shared', 'ctxlabel.js')).href)};export const { ctxLabel, commonWindow } = globalThis.CtxLabel;`);
    return import('data:text/javascript,' + encodeURIComponent(src.replace("from '../benchmarks/util.js'", `from '${stub}'`)));
}

const cell = (passes, attempts, wall = 100) => ({ status: passes >= attempts ? 'pass' : 'fail', attempts, passes, credit: attempts ? passes / attempts : null,
    solved: passes > 0, excluded: !attempts, wall_s: wall, tokens_out: 1000 });
const HARNESS = { runner: 'opencode', prompt_level: 'L2' };
const config = (weights, placement, tasks, dirs, extra = {}) => ({
    key: JSON.stringify([['weights', weights], ['placement', placement]]), dirs, tasks, n_ctx: 81920,
    agg: { attempted: Object.keys(tasks).length, scored: Object.keys(tasks).length },
    facets: { weights, harness: HARNESS, context: { n_ctx: 81920 }, output: ['--jinja'], kv: ['--cache-type-k q4_0'], other: [], placement, ...extra } });
const speed = (n) => ({ coarse: false, at8k: { prefillTps: 400, n }, at32k: { prefillTps: 300, genTps: 30, n }, at64k: null, curve: {} });
const model = (key, display, configs, extra = {}) => {
    const tasks = {};
    for (const c of configs) for (const [id, t] of Object.entries(c.tasks)) tasks[id] = t;
    return { key, display, family: display.replace(/ \(.*\)$/, ''), weightsKey: key, weightsDisplay: display, provider: 'local', configs, tasks,
        counts: { requests: 5, benchRuns: 0, sweepRows: 0, qualityBatteries: configs.length, qualityTasks: Object.keys(tasks).length },
        quality: { attempted: Object.keys(tasks).length, scored: Object.keys(tasks).length, solved: 1, harnessIncompatible: false },
        batteries: configs.flatMap((c) => c.dirs.map((dir, i) => ({ dir, ended: 10 + i }))), sources: [], speedConfigs: [], ...extra };
};
const XS_COPY = 'local:qwen3.8-27b-gsq-rco-iq2-xs-mtp-f32ssm:unknown', XS = 'local:qwen3.8-27b-gsq-rco-iq2-xs-mtp:unknown';
const S_COPY = 'local:qwen3.8-27b-gsq-rco-iq2-s-mtp-f32ssm:unknown', S = 'local:qwen3.8-27b-gsq-rco-iq2-s-mtp:unknown';
const XXS_COPY = 'local:qwen3.8-27b-gsq-rco-iq3-xxs-mtp-f32ssm:unknown', XXS = 'local:qwen3.8-27b-gsq-rco-iq3-xxs-mtp:unknown';
const HELPER = 'local:qwen3.8-flash-next-gsq-rco:iq3-xxs~helper:qwen3.8-27b-gsq-rco-iq2-xs';
const sc = (id, n) => ({ id, configKey: id, ctx: 81920, at32k: { source: 'logged requests', prefillTps: 300, genTps: 30, n } });
const catalogOf = () => ({ generatedAt: 1, allTaskIds: ['t1', 't2', 't3'], models: [
    model(XS_COPY, 'Qwen3.8-27B-GSQ-RCO-IQ2_XS-mtp-f32ssm', [config(XS_COPY, ['-dev CUDA0'], { t1: cell(1, 1, 200), t2: cell(0, 1) }, ['copy-a'])],
        { speed: speed(500), speedConfigs: [sc('cfg-copy', 400)], diskBytes: 8818497600 }),
    model(XS, 'Qwen3.8-27B-GSQ-RCO-IQ2_XS-mtp', [config(XS, ['-dev CUDA0'], { t2: cell(1, 1), t3: cell(1, 1, 50) }, ['orig-a'])],
        { speed: speed(4), speedConfigs: [sc('cfg-orig', 20)], diskBytes: 8771311680 }),
    model(XS_COPY + '~tau', 'Qwen3.8-27B-GSQ-RCO-IQ2_XS-mtp-f32ssm (tau)', [config(XS_COPY + '~tau', [], { t1: cell(1, 1) }, ['tau'])]),
    model(S_COPY, 'Qwen3.8-27B-GSQ-RCO-IQ2_S-mtp-f32ssm', [config(S_COPY, ['-dev CUDA0'], { t1: cell(1, 1) }, ['s-copy'])], { speed: speed(9), speedConfigs: [sc('cfg-s', 9)] }),
    model(HELPER, 'Qwen3.8-Flash-Next-GSQ-RCO IQ3_XXS (+ helper Qwen3.8-27B GSQ-RCO IQ2_XS)', [config(HELPER, [], { t1: cell(1, 1) }, ['helper'])]),
    model('local:qwen3.8-flash-next-gsq-rco:iq3-xxs', 'Qwen3.8-Flash-Next-GSQ-RCO IQ3_XXS', [config('local:qwen3.8-flash-next-gsq-rco:iq3-xxs', [], { t1: cell(0, 1) }, ['fn'])]),
] });

test('fileBaseKey: exactly the three f32ssm copies map to their original -mtp file, suffix kept', async () => {
    const L = await loadLb();
    assert.deepStrictEqual(Object.keys(L.FILE_VARIANTS).sort(), [S_COPY, XS_COPY, XXS_COPY].sort());
    assert.strictEqual(L.fileBaseKey(XS_COPY), XS);
    assert.strictEqual(L.fileBaseKey(S_COPY), S);
    assert.strictEqual(L.fileBaseKey(XXS_COPY), XXS);
    assert.strictEqual(L.fileBaseKey(XS_COPY + '~tau'), XS + '~tau');
    assert.strictEqual(L.fileBaseKey(XS_COPY + '~rv:subagents'), XS + '~rv:subagents');
    for (const k of [XS, S, XXS, HELPER, 'local:qwen3.8-flash-next-gsq-rco:iq3-xxs', 'local:qwen3.8-27b-gsq-rco-iq3-s-mtp:unknown',
        'local:other-model-f32ssm:unknown', 'local:qwen3.8-27b-gsq-rco-iq2-xs-mtp-f32ssm:iq2-xs', '', null]) assert.strictEqual(L.fileBaseKey(k), null, String(k));
});

test('foldFileVariants: the copy joins its original row; a copy with no original row is renamed in place; the rest is untouched', async () => {
    const L = await loadLb();
    const raw = catalogOf(), before = JSON.stringify(raw);
    const f = L.foldFileVariants(raw);
    assert.strictEqual(JSON.stringify(raw), before, 'the source catalog is not changed');
    assert.strictEqual(L.foldFileVariants(raw), f, 'one folded object per source catalog');
    assert.deepStrictEqual(f.models.map((m) => m.key), [XS, XS_COPY + '~tau', S_COPY, HELPER, 'local:qwen3.8-flash-next-gsq-rco:iq3-xxs']);
    assert.deepStrictEqual(f.fileFolded, { [XS_COPY]: XS });
    assert.deepStrictEqual(f.fileRenamed, { [XS + '~tau']: XS_COPY + '~tau', [S]: S_COPY });

    // merged: one row named as the original, the copy's config restated under it and tagged
    const m = f.models[0];
    assert.strictEqual(m.display, 'Qwen3.8-27B-GSQ-RCO-IQ2_XS-mtp');
    assert.strictEqual(m.diskBytes, 8771311680, 'the original file');
    assert.deepStrictEqual(m.configs.map((c) => c.facets.weights), [XS, XS]);
    assert.deepStrictEqual(m.configs.map((c) => c.facets.file ?? null), [null, 'f32ssm']);
    assert.strictEqual(m.configs[1].fileFoldedFrom, XS_COPY);
    assert.ok(!m.configs[1].key.includes('f32ssm') && m.configs[1].key.includes(JSON.stringify(XS)));
    assert.deepStrictEqual(Object.keys(m.tasks).sort(), ['t1', 't2', 't3']);
    assert.strictEqual(m.tasks.t2.attempts, 2); assert.strictEqual(m.tasks.t2.passes, 1);
    assert.strictEqual(m.counts.qualityBatteries, 2); assert.strictEqual(m.counts.requests, 10);
    assert.deepStrictEqual(m.fileFoldedFrom, [XS_COPY]);
    assert.strictEqual(m.tensorFoldedFrom, undefined);
    assert.deepStrictEqual(m.speedConfigs.map((s) => [s.id, s.file ?? null, s.fileFoldedFrom ?? null]), [['cfg-orig', null, null], ['cfg-copy', 'f32ssm', XS_COPY]]);
    assert.strictEqual(m.speed.at32k.n, 500, 'the merged row\'s prefill curve is the member with the most samples');
    assert.deepStrictEqual(m.fileParts.map((p) => [p.key, p.tag]), [[XS, null], [XS_COPY, 'f32ssm']]);

    // renamed in place: the server's key, the original's name and weights
    const tau = f.models[1];
    assert.strictEqual(tau.key, XS_COPY + '~tau');
    assert.strictEqual(tau.display, 'Qwen3.8-27B-GSQ-RCO-IQ2_XS-mtp (tau)');
    assert.strictEqual(tau.weightsKey, XS + '~tau');
    assert.strictEqual(tau.configs[0].facets.weights, XS + '~tau');
    assert.strictEqual(tau.configs[0].facets.file, 'f32ssm');
    const s = f.models[2];
    assert.strictEqual(s.display, 'Qwen3.8-27B-GSQ-RCO-IQ2_S-mtp'); assert.strictEqual(s.weightsDisplay, 'Qwen3.8-27B-GSQ-RCO-IQ2_S-mtp');
    assert.strictEqual(s.family, 'Qwen3.8-27B-GSQ-RCO-IQ2_S-mtp');
    assert.strictEqual(s.tasks, raw.models[3].tasks, 'nothing to merge: the same results');
    // the helper combination and the Flash-Next GSQ-RCO rows are the very same objects
    assert.strictEqual(f.models[3], raw.models[4]);
    assert.strictEqual(f.models[4], raw.models[5]);
});

test('foldFileVariants: a catalog with no copy comes back as the same object', async () => {
    const L = await loadLb();
    const raw = { models: [catalogOf().models[1]] };
    assert.strictEqual(L.foldFileVariants(raw), raw);
    assert.strictEqual(L.foldFileVariants(null), null);
    assert.deepStrictEqual(L.foldFileVariants({}), {});
});

test('quality pools the copy with the original into ONE strength row; the time pseudo-facet splits only the time groups', async () => {
    const L = await loadLb();
    const raw = catalogOf(), f = L.foldFileVariants(raw);
    const keepQ = L.FACET_DEFAULTS.quality, keepT = L.FACET_DEFAULTS.full;
    // separate (raw): two quality rows
    const sep = L.fitGroups(L.qualityEntries(raw.models), keepQ, keepT);
    assert.strictEqual(sep.qAll.filter((g) => [XS, XS_COPY].includes(g.m.key)).length, 2);
    // merged, speed merged (both switches default): one quality row, one time row, linked
    const rows0 = L.fileVariantRows(false, {});
    const t0 = L.timeKeepWith(keepT, rows0);
    assert.strictEqual(t0, keepT, 'defaults: the time keep-list is the stored one, untouched');
    const fit0 = L.fitGroups(L.qualityEntries(f.models), keepQ, t0);
    const q = fit0.qAll.filter((g) => g.m.key === XS);
    assert.strictEqual(q.length, 1);
    assert.deepStrictEqual(Object.keys(q[0].tasks).sort(), ['t1', 't2', 't3']);
    assert.strictEqual(q[0].tasks.t2.credit, 0.5);
    assert.deepStrictEqual(q[0].varies, ['file'], 'the merged row says what its members differ in');
    assert.ok(fit0.adj.get(q[0].key), 'one strength for the merged row');
    assert.strictEqual(fit0.tAll.filter((g) => g.m.key === XS).length, 1);
    // merged on quality, separate on speed: still ONE quality row, but two time rows, both linked to it
    const rows1 = L.fileVariantRows(false, { speed: 'separate' });
    const t1 = L.timeKeepWith(keepT, rows1);
    assert.deepStrictEqual(t1, [...keepT, 'file']);
    const fit1 = L.fitGroups(L.qualityEntries(f.models), keepQ, t1);
    assert.strictEqual(fit1.qAll.filter((g) => g.m.key === XS).length, 1);
    const tg = fit1.tAll.filter((g) => g.m.key === XS);
    assert.strictEqual(tg.length, 2);
    assert.ok(tg.every((g) => g.qg && g.qg.key === fit1.qAll.find((x) => x.m.key === XS).key), 'each time row hangs off the merged quality row');
    assert.deepStrictEqual(tg.map((g) => g.c.facets.file ?? null).sort(), [null, 'f32ssm'].sort());
    // the quality fit is the same either way
    assert.strictEqual(fit1.adj.get(fit1.qAll.find((x) => x.m.key === XS).key).rate, fit0.adj.get(q[0].key).rate);
});

test('fileVariantRows: both switches merge by default; the public site always merges; quality separate forces speed separate', async () => {
    const L = await loadLb();
    assert.deepStrictEqual(L.fileVariantRows(false, {}), { quality: 'merge', speed: 'merge', speedSplit: false });
    assert.deepStrictEqual(L.fileVariantRows(false), { quality: 'merge', speed: 'merge', speedSplit: false });
    assert.deepStrictEqual(L.fileVariantRows(false, { quality: null, speed: 'junk' }), { quality: 'merge', speed: 'merge', speedSplit: false });
    assert.deepStrictEqual(L.fileVariantRows(false, { speed: 'separate' }), { quality: 'merge', speed: 'separate', speedSplit: true });
    assert.deepStrictEqual(L.fileVariantRows(false, { quality: 'separate' }), { quality: 'separate', speed: 'merge', speedSplit: true });
    assert.deepStrictEqual(L.fileVariantRows(true, { quality: 'separate', speed: 'separate' }), { quality: 'merge', speed: 'merge', speedSplit: false });
    // the time pseudo-facet is added only when the catalog is folded AND speed is separate
    const k = ['harness', 'placement'];
    assert.strictEqual(L.timeKeepWith(k, L.fileVariantRows(false, { quality: 'separate', speed: 'separate' })), k);
    assert.strictEqual(L.timeKeepWith(k, L.fileVariantRows(true, { speed: 'separate' })), k);
    assert.deepStrictEqual(L.timeKeepWith(k, L.fileVariantRows(false, { speed: 'separate' })), ['harness', 'placement', 'file']);
    assert.strictEqual(L.timeKeepWith(null, null), L.FACET_DEFAULTS.full);
    assert.ok(!L.FACETS.some((x) => x.id === L.FILE_FACET), 'not a facet chip: no stored keep-list carries it');
});

test('fileSpeedModels: a merged row is one prefill line, or one per file when the copies are kept apart', async () => {
    const L = await loadLb();
    const f = L.foldFileVariants(catalogOf());
    assert.strictEqual(L.fileSpeedModels(f.models, false), f.models);
    const split = L.fileSpeedModels(f.models, true);
    assert.deepStrictEqual(split.map((m) => m.key), [XS, XS_COPY, XS_COPY + '~tau', S_COPY, HELPER, 'local:qwen3.8-flash-next-gsq-rco:iq3-xxs']);
    assert.deepStrictEqual(split.slice(0, 2).map((m) => [m.display, m.speed.at32k.n]), [['Qwen3.8-27B-GSQ-RCO-IQ2_XS-mtp', 4], ['Qwen3.8-27B-GSQ-RCO-IQ2_XS-mtp · f32ssm copy', 500]]);
});

test('foldFileRun: a copy\'s running battery lands on the original row; an original\'s on a renamed copy row', async () => {
    const L = await loadLb();
    const f = L.foldFileVariants(catalogOf());
    const run = { dir: 'copy-b', task: 't3', modelKey: XS_COPY, facets: { weights: XS_COPY, placement: ['-dev CUDA0'] } };
    const g = L.foldFileRun(run, f);
    assert.strictEqual(g.modelKey, XS); assert.strictEqual(g.facets.weights, XS); assert.strictEqual(g.facets.file, 'f32ssm');
    assert.strictEqual(run.modelKey, XS_COPY, 'the polled entry itself is not changed');
    assert.strictEqual(L.foldFileRun(run, catalogOf()), run, 'rows separate: as filed');
    const sCopy = L.foldFileRun({ dir: 's', modelKey: S_COPY, facets: { weights: S_COPY } }, f);
    assert.strictEqual(sCopy.modelKey, S_COPY, 'renamed row: the copy keeps its key'); assert.strictEqual(sCopy.facets.weights, S);
    const sOrig = L.foldFileRun({ dir: 's2', modelKey: S, facets: { weights: S } }, f);
    assert.strictEqual(sOrig.modelKey, S_COPY, 'a run on the original file joins the renamed row'); assert.strictEqual(sOrig.facets.weights, S);
    assert.strictEqual(sOrig.facets.file, undefined);
    const plain = { dir: 'p', modelKey: XS, facets: { weights: XS } };
    assert.strictEqual(L.foldFileRun(plain, f), plain);
});

test('the tensor fold and the file fold compose: one object per source catalog, a tensor-split copy reaches the original', async () => {
    const L = await loadLb();
    const raw = catalogOf();
    const TEN = XS_COPY + '~rv:tensor-split-two-xtx';
    raw.models.push(model(TEN, 'Qwen3.8-27B-GSQ-RCO-IQ2_XS-mtp-f32ssm (tensor-split-two-xtx)', [config(TEN, ['-sm tensor'], { t3: cell(1, 1) }, ['ten'])]));
    const shown = L.foldFileVariants(L.foldTensorRows(raw));
    assert.strictEqual(L.foldFileVariants(L.foldTensorRows(raw)), shown, 'stable identity: the fit and board caches hold');
    assert.ok(!shown.models.some((m) => m.key === TEN || m.key === XS_COPY));
    const m = shown.models.find((x) => x.key === XS);
    assert.strictEqual(m.configs.length, 3);
    assert.deepStrictEqual(m.configs.map((c) => c.facets.weights), [XS, XS, XS]);
    assert.deepStrictEqual(shown.tensorFolded, { [TEN]: XS_COPY });
    const run = L.foldFileRun(L.foldTensorRun({ dir: 'x', modelKey: TEN, facets: { weights: TEN } }, shown.tensorFolded), shown);
    assert.strictEqual(run.modelKey, XS); assert.strictEqual(run.facets.weights, XS);
});

test('facetBar extras: a disabled chip is drawn inert and "default" leaves it alone', async () => {
    const L = await loadLb();
    const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'shared', 'leaderboard.js'), 'utf-8');
    assert.match(src, /x\.disabled && x\.disabled\(\) \? ' disabled' : ''/);
    assert.match(src, /if \(x && !\(x\.disabled && x\.disabled\(\)\)\) \{ x\.set/);
    assert.strictEqual(typeof L.facetBar, 'function');
});

test('the Models page wires both chips on the lab dashboard only, default merged, remembered per viewer', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'models', 'index.js'), 'utf-8');
    assert.match(src, /fileVariantRows\(PUBLIC, \{ quality: storedRows\('models_f32ssm_quality'\), speed: storedRows\('models_f32ssm_speed'\) \}\)/);
    assert.match(src, /localStorage\.setItem\('models_f32ssm_' \+ which, v\)/);
    assert.match(src, /PUBLIC \? \[\] : \[tensorChip, fileChipQ\]/);
    assert.match(src, /PUBLIC \? \[\] : \[fileChipT\]/);
    // (2026-10-14: the fold rule moved to leaderboard.js overviewCatalog, shared with the Benchmarks board and the pickers;
    // test/strength.test.js checks it gives this page's object for every switch)
    assert.match(src, /const shownCatalog = \(raw\) => overviewCatalog\(raw, \{ tensorRows, fileRows \}\)/);
    assert.match(src, /foldFileRun\(foldTensorRun\(filed, catalog\.tensorFolded\), catalog\)/);
    // every fit the page asks for uses the same time keep-list (one cached fit per catalog and choice)
    assert.ok(!/fitFor\(catalog\.models, keepQ, chartKeep\.t/.test(src));
    assert.match(src, /keepT = timeKeep\(\)/);
    // the time board (source 'full') follows the time chip too; the Speed board splits its copy rows on it
    assert.match(src, /spec\.source === 'full' \? timeKeepWith\(facetKeep\[id\] \|\| FACET_DEFAULTS\.full, fileRows\)/);
    assert.match(src, /const copy = fileRows\.speedSplit && c\[FILE_FACET\]/);
    assert.match(src, /JSON\.stringify\(\[id, facetKeep\[id\] \|\| null, fileRows\.speedSplit\]\)/);
});
