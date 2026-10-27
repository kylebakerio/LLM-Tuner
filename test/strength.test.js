// ONE SOURCE OF STRENGTH (2026-10-14, Kyle: "do all of our quality leaderboards use the same strength algorithm/match...?
// I think in bench they didn't look like they lined up..."). The Models page fits the catalog with its tensor-split rows
// and f32ssm copies folded, on its chart chips; the Benchmarks board and the two pickers fitted the RAW catalog, and the
// Models page's own Quality board fitted on its own whenever a harness-incompatible model was in the catalog. Pinned here:
//   overviewView / overviewCatalog / overviewRowKey  the page's settings and catalog, for every other board
//   strengthByDir / strengthForDirs                  battery dirs -> the page's config entry (multi-group dirs, pooling)
//   board.js boardStrength                           the Benchmarks board's cell is that entry, pooled rows say so
//   rank.js pickerRows rowKeyOf                      an f32ssm copy's gguf carries the original row's point
//   inQualityFit + the Models Quality board          shares the charts' fit with a harness-incompatible model present
//   and, when this machine has the lab's results, the same checks over the real catalog.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const UI = path.join(__dirname, '..', 'ui');

// The ui tree as ES modules (a copy with package.json type:module, as test/models.test.js loads the picker), so
// leaderboard.js, board.js and rank.js share ONE leaderboard.js instance -- the fit cache is per module instance.
let loaded = null;
async function load(t) {
    if (loaded) return loaded;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-strength-'));
    process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* gone */ } });
    fs.cpSync(UI, path.join(tmp, 'ui'), { recursive: true, filter: (src) => !/\.bak/.test(src) });
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
    globalThis.document = globalThis.document || { addEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
    globalThis.window = globalThis.window || { addEventListener() {} };
    const url = (p) => 'file://' + path.join(tmp, 'ui', p);
    loaded = {
        L: await import(url('shared/leaderboard.js')),
        B: await import(url('benchmarks/board.js')),
        R: await import(url('modelpicker/rank.js')),
    };
    return loaded;
}

// ---- fixtures: a base model with a tensor-split row, an f32ssm copy with its original, two others, one harness-incompatible
const cell = (passes, attempts) => ({ status: passes >= attempts ? 'pass' : 'fail', attempts, passes, credit: attempts ? passes / attempts : null,
    solved: passes > 0, excluded: !attempts, wall_s: 100, tokens_out: 1000 });
const HARNESS = { runner: 'opencode', prompt_level: 'L2' };
const config = (weights, placement, tasks, dirs, kv = 'q8_0') => ({
    key: JSON.stringify([['weights', weights], ['placement', placement], ['kv', kv]]), dirs, tasks, n_ctx: 131072,
    agg: { attempted: Object.keys(tasks).length, scored: Object.keys(tasks).length },
    facets: { weights, harness: HARNESS, context: { n_ctx: 131072 }, output: ['--jinja'], kv: [`--cache-type-k ${kv}`], other: [], placement } });
const model = (key, display, configs, extra = {}) => {
    const tasks = {};
    for (const c of configs) for (const [id, t] of Object.entries(c.tasks)) tasks[id] = t;
    return { key, display, weightsKey: key, weightsDisplay: display, provider: 'local', configs, tasks,
        counts: { requests: 5, benchRuns: 0, sweepRows: 0, qualityBatteries: configs.length, qualityTasks: Object.keys(tasks).length },
        quality: { attempted: Object.keys(tasks).length, scored: Object.keys(tasks).length, solved: 1, harnessIncompatible: false },
        batteries: configs.flatMap((c) => c.dirs.map((dir, i) => ({ dir, ended: 10 + i }))), sources: [], speedConfigs: [], ...extra };
};
const Q4 = 'local:qwen3.8-27b:q4-k-xl', Q4_TS = Q4 + '~rv:tensor-split-two-xtx';
const XS = 'local:qwen3.8-27b-gsq-rco-iq2-xs-mtp:unknown', XS_COPY = 'local:qwen3.8-27b-gsq-rco-iq2-xs-mtp-f32ssm:unknown';
const B = 'local:other:q8-0', C = 'local:qwen2.5-coder-7b-instruct:q4-k-m';
function catalog() {
    const T = (pattern) => Object.fromEntries([...pattern].map((ch, i) => [`t${i + 1}`, cell(ch === '1' ? 1 : 0, 1)]));
    return { taskTotal: 8, models: [
        model(Q4, 'Qwen3.8-27B Q4_K_XL', [config(Q4, ['-dev XTX'], T('11101100'), ['q4-a', 'q4-b']), config(Q4, ['-dev XTX'], T('1100'), ['q4-kv4'], 'q4_0')]),
        model(Q4_TS, 'Qwen3.8-27B Q4_K_XL (tensor-split-two-xtx)', [config(Q4_TS, ['-sm tensor'], { t7: cell(1, 1), t8: cell(1, 1) }, ['q4-ts'])]),
        model(XS, 'Qwen3.8-27B-GSQ-RCO-IQ2_XS-mtp', [config(XS, ['-dev XTX'], T('10100000'), ['xs-orig'])]),
        model(XS_COPY, 'Qwen3.8-27B-GSQ-RCO-IQ2_XS-mtp-f32ssm', [config(XS_COPY, ['-dev XTX'], T('11110000'), ['xs-copy'])]),
        model(B, 'Other Q8_0', [config(B, ['-dev XTX'], T('11111110'), ['b-1'])]),
        model(C, 'qwen2.5-coder-7b-instruct Q4_K_M', [config(C, ['-dev XTX'], T('00000000'), ['c-1'])], {
            quality: { attempted: 8, scored: 8, solved: 0, harnessIncompatible: true } }),
    ] };
}
const store = (kv) => ({ getItem: (k) => (k in kv ? kv[k] : null) });

test('overviewView: the Models page\'s switches and chips as stored; the public site always folds', async (t) => {
    const { L } = await load(t);
    const d = L.overviewView({ store: store({}) });
    assert.strictEqual(d.tensorRows, 'combine');
    assert.deepStrictEqual(d.fileRows, { quality: 'merge', speed: 'merge', speedSplit: false });
    assert.deepStrictEqual(d.keepQ, L.FACET_DEFAULTS.quality);
    assert.deepStrictEqual(d.keepT, L.FACET_DEFAULTS.full);
    const kv = { models_tensor_rows_v2: 'separate', models_f32ssm_quality: 'merge', models_f32ssm_speed: 'separate',
        'facets_models-charts-q': JSON.stringify(['harness', 'kv']), 'facets_models-charts-t': JSON.stringify(['harness']) };
    const lab = L.overviewView({ store: store(kv) });
    assert.strictEqual(lab.tensorRows, 'separate');
    assert.deepStrictEqual(lab.fileRows, { quality: 'merge', speed: 'separate', speedSplit: true });
    assert.deepStrictEqual(lab.keepQ, ['harness', 'kv']);
    assert.deepStrictEqual(lab.keepT, ['harness', L.FILE_FACET], 'the time keep-list as the page builds it (timeKeepWith)');
    const pub = L.overviewView({ publicSite: true, store: store(kv) });
    assert.strictEqual(pub.tensorRows, 'combine'); assert.strictEqual(pub.fileRows.quality, 'merge');
    // junk and a throwing store read as the defaults
    assert.deepStrictEqual(L.overviewView({ store: store({ models_tensor_rows_v2: 'x', 'facets_models-charts-q': '{oops' }) }).keepQ, L.FACET_DEFAULTS.quality);
    assert.strictEqual(L.overviewView({ store: { getItem() { throw new Error('denied'); } } }).tensorRows, 'combine');
    assert.strictEqual(L.overviewView({ store: null }).tensorRows, 'combine');
});

test('overviewCatalog: the very object the Models page builds, for every switch', async (t) => {
    const { L } = await load(t);
    const raw = catalog();
    for (const tensorRows of ['combine', 'separate']) for (const quality of ['merge', 'separate']) {
        const fileRows = L.fileVariantRows(false, { quality });
        // ui/models/index.js before 2026-10-14, verbatim
        const tt = tensorRows === 'combine' ? L.foldTensorRows(raw) : raw;
        const page = fileRows.quality === 'merge' ? L.foldFileVariants(tt) : tt;
        assert.strictEqual(L.overviewCatalog(raw, { tensorRows, fileRows }), page, `${tensorRows}/${quality}: identity, so the fit cache is shared`);
    }
    assert.strictEqual(L.overviewCatalog(raw, { tensorRows: 'separate', fileRows: { quality: 'separate' } }), raw);
    assert.strictEqual(L.overviewCatalog(null), null);
    const f = L.overviewCatalog(raw, L.overviewView({ store: store({}) }));
    assert.strictEqual(L.overviewRowKey(f, Q4_TS), Q4);
    assert.strictEqual(L.overviewRowKey(f, XS_COPY), XS);
    assert.strictEqual(L.overviewRowKey(f, B), B);
    // an original file whose row is a renamed copy (no run on the original yet)
    const only = { models: raw.models.filter((m) => m.key !== XS) };
    assert.strictEqual(L.overviewRowKey(L.overviewCatalog(only, L.overviewView({ store: store({}) })), XS), XS_COPY);
});

test('strengthByDir on the shown catalog: a tensor-split battery and an f32ssm copy\'s read the base config\'s entry', async (t) => {
    const { L } = await load(t);
    const raw = catalog();
    const v = L.overviewView({ store: store({}) }), shown = L.overviewCatalog(raw, v);
    const fit = L.fitFor(shown.models, v.keepQ, v.keepT);
    const byDir = L.strengthByDir(shown.models, v.keepQ, v.keepT);
    const q4 = fit.qAll.find((g) => g.dirs.includes('q4-a'));
    assert.deepStrictEqual([...q4.dirs].sort(), ['q4-a', 'q4-b', 'q4-ts'], 'the tensor-split battery joined the base config');
    assert.strictEqual(byDir.get('q4-ts'), fit.adj.get(q4.key), 'the fit\'s own entry, not a copy');
    assert.strictEqual(byDir.get('q4-a'), byDir.get('q4-ts'));
    assert.strictEqual(byDir.get('xs-copy'), byDir.get('xs-orig'));
    assert.notStrictEqual(byDir.get('q4-kv4'), byDir.get('q4-a'), 'KV type still separates on quality');
    assert.strictEqual(byDir.get('c-1'), undefined, 'a harness-incompatible model is not in the fit');
    // the default arguments are the default chips: an old caller gets the same map
    assert.strictEqual(L.strengthByDir(shown.models).get('q4-ts'), byDir.get('q4-ts'));
    // the raw catalog is ANOTHER fit: that is the bug the Benchmarks board and the pickers had
    const rawDir = L.strengthByDir(raw.models);
    assert.notStrictEqual(rawDir.get('q4-ts'), byDir.get('q4-ts'));
    assert.notStrictEqual(rawDir.get('q4-ts').strength, byDir.get('q4-ts').strength);
});

test('strengthForDirs: one group, a pooled group, and dirs in two groups (best low end, said so)', async (t) => {
    const { L } = await load(t);
    const ga = { key: 'ga', dirs: ['d1', 'd2'] }, gb = { key: 'gb', dirs: ['d2', 'd3', 'd4'] };
    const ea = { strength: 60, rate: 0.6, lo: 0.5, hi: 0.7, coverage: 0.5, n: 10 }, eb = { strength: 58, rate: 0.58, lo: 0.55, hi: 0.62, coverage: 0.8, n: 30 };
    const byDir = new Map([['d1', ea], ['d2', eb], ['d3', eb], ['d4', eb]]);
    byDir.groupsByDir = new Map([['d1', [[ga, ea]]], ['d2', [[ga, ea], [gb, eb]]], ['d3', [[gb, eb]]], ['d4', [[gb, eb]]]]);
    const same = L.strengthForDirs(byDir, ['d1', 'd2'].slice(0, 1).concat([]));
    assert.strictEqual(same.a, ea); assert.strictEqual(same.groups, 1);
    assert.match(same.note, /pools 2 batteries, 1 of them not in this row/);
    const exact = L.strengthForDirs(byDir, ['d3', 'd4', 'd2']);
    assert.strictEqual(exact.a, eb, 'd2 is in both: the higher low end (0.55 > 0.50) wins');
    assert.strictEqual(exact.groups, 2);
    assert.match(exact.note, /fall in 2 configs/);
    assert.ok(!/pools/.test(exact.note), 'gb has no battery outside the row');
    assert.strictEqual(L.strengthForDirs(byDir, ['nope']), null);
    assert.strictEqual(L.strengthForDirs(byDir, []), null);
    // a plain map (no groupsByDir): best low end over the dirs, no note
    const plain = L.strengthForDirs(new Map([['x', ea], ['y', eb]]), ['x', 'y']);
    assert.strictEqual(plain.a, eb); assert.strictEqual(plain.note, '');
    // strengthByDir itself picks by the one rule (bestConfigOf) for a dir in two groups (it used to be whichever group came
    // last): one battery whose rows ran under two KV types (a row-config battery) is in both groups
    const T = (pattern) => Object.fromEntries([...pattern].map((ch, i) => [`t${i + 1}`, cell(ch === '1' ? 1 : 0, 1)]));
    const cat = { models: [...catalog().models,
        model('local:split:q4', 'Split Q4', [config('local:split:q4', [], T('11111111'), ['s-own', 's-shared']), config('local:split:q4', [], T('00010000'), ['s-shared'], 'q4_0')])] };
    const bd = L.strengthByDir(cat.models);
    const fit = L.fitFor(cat.models, L.FACET_DEFAULTS.quality, L.FACET_DEFAULTS.full);
    const two = bd.groupsByDir.get('s-shared');
    assert.strictEqual(two.length, 2);
    const best = fit.adj.get(L.bestConfigOf(two.map(([g]) => g), (g) => L.strengthRank(fit.adj.get(g.key))).key);
    assert.strictEqual(bd.get('s-shared'), best);
    assert.strictEqual(best, fit.adj.get(fit.qAll.find((g) => g.dirs.includes('s-own')).key), 'the 8-of-8 config, not the 1-of-8 one');
    assert.match(L.strengthForDirs(bd, ['s-shared']).note, /fall in 2 configs/);
});

test('Benchmarks board: its strength cell is the Models page\'s config entry; a pooled row says so', async (t) => {
    const { L, B: Board } = await load(t);
    const raw = catalog();
    const v = L.overviewView({ store: store({}) }), shown = L.overviewCatalog(raw, v);
    const byDir = L.strengthByDir(shown.models, v.keepQ, v.keepT);
    const m = { solved: 2, scored: 2 };
    // the server keeps the tensor-split battery a row of its own (its model key differs); the page pools it
    const ts = Board.boardStrength(byDir, ['q4-ts'], m);
    const base = Board.boardStrength(byDir, ['q4-a', 'q4-b'], m);
    assert.strictEqual(ts.v, byDir.get('q4-a').rate);
    assert.strictEqual(base.v, ts.v, 'same config on the Models page, same number on the board');
    assert.strictEqual(ts.pooled, true); assert.match(ts.note, /pools 3 batteries, 2 of them not in this row/);
    assert.strictEqual(base.pooled, true);
    const all = Board.boardStrength(byDir, ['q4-a', 'q4-b', 'q4-ts'], m);
    assert.ok(!all.pooled && !/pools/.test(all.note), 'the same batteries as the page\'s config: nothing to say');
    assert.strictEqual(Board.boardStrength(byDir, ['c-1'], m), null, 'harness-incompatible: no strength, as on the charts');
    assert.strictEqual(Board.boardStrength(byDir, [], m), null);
});

test('pickers: an f32ssm copy\'s gguf carries the original row\'s point; the key stays the gguf\'s', async (t) => {
    const { L, R } = await load(t);
    const raw = catalog();
    const v = L.overviewView({ store: store({}) }), shown = L.overviewCatalog(raw, v);
    const fit = L.fitFor(shown.models, v.keepQ, v.keepT);
    const points = L.ladderPoints(fit, fit.qAll, { how: 'adjusted', cost: 'time' });
    const opt = (f) => ({ value: '/m/' + f, text: f });
    const options = [opt('Qwen3.8-27B-GSQ-RCO-IQ2_XS-mtp-f32ssm.gguf'), opt('Qwen3.8-27B-GSQ-RCO-IQ2_XS-mtp.gguf'), opt('Qwen3.8-27B-UD-Q4_K_XL.gguf')];
    assert.strictEqual(R.ggufModelKey(options[0].value), XS_COPY);
    const without = R.pickerRows(options, points, shown.models);
    assert.deepStrictEqual(without.unrated.map((r) => r.key), [XS_COPY], 'without the mapping the copy has no point on the folded ladder');
    const { rated, unrated } = R.pickerRows(options, points, shown.models, { rowKeyOf: (k) => L.overviewRowKey(shown, k) });
    assert.strictEqual(unrated.length, 0);
    const copy = rated.find((r) => r.key === XS_COPY), orig = rated.find((r) => r.key === XS);
    assert.ok(copy && orig);
    assert.strictEqual(copy.point, orig.point, 'one row on the Models page, one point');
    assert.strictEqual(copy.model.key, XS, 'the model the speed column reads is the folded row');
    const q4 = rated.find((r) => r.key === Q4);
    const g = fit.qAll.find((x) => x.dirs.includes('q4-a'));
    assert.strictEqual(q4.point.y, fit.adj.get(g.key).rate, 'the number is the page\'s config entry');
});

test('the Models Quality board shares the charts\' fit with a harness-incompatible model in the catalog', async (t) => {
    const { L } = await load(t);
    const shown = L.overviewCatalog(catalog(), L.overviewView({ store: store({}) }));
    const keep = L.FACET_DEFAULTS.quality;
    // buildBoardCandidates' groups: per set of weights, every attempted config, on the board's keep-list
    const perW = new Map();
    for (const m of shown.models) { const w = L.weightsOf(m); if (!perW.has(w)) perW.set(w, []); perW.get(w).push(m); }
    const all = [];
    for (const members of perW.values()) {
        const e = []; for (const m of members) for (const c of (m.configs || [])) if (c.agg && c.agg.attempted) e.push({ m, c });
        if (e.length) all.push(...L.groupConfigs(e, keep));
    }
    const fit = L.fitFor(shown.models, keep, L.FACET_DEFAULTS.full);
    const size = new Map(fit.qAll.map((g) => [g.key, g.members.length]));
    const sharedWith = (flat) => flat.length === fit.qAll.length && flat.every((g) => size.get(g.key) === g.members.length);
    assert.strictEqual(sharedWith(all), false, 'the old check: the coder model\'s row made the board refit on its own');
    assert.strictEqual(sharedWith(all.filter((g) => L.inQualityFit(g.m))), true, 'filtered as the fit is: the charts\' fit');
    // and the page does filter so
    const src = fs.readFileSync(path.join(UI, 'models', 'index.js'), 'utf-8');
    assert.match(src, /const flat = \[\.\.\.allGroups\.values\(\)\]\.flat\(\)\.filter\(\(g\) => inQualityFit\(g\.m\)\);/);
    assert.match(src, /const shownCatalog = \(raw\) => overviewCatalog\(raw, \{ tensorRows, fileRows \}\);/);
    assert.match(src, /strengthByDir\(cat\.models \|\| \[\], keepQ, keepT\)/, 'the detail page\'s strength on the chart chips');
    // qualityEntries and inQualityFit are one rule
    assert.deepStrictEqual(L.qualityEntries(shown.models).map((e) => e.m.key).sort(),
        shown.models.filter(L.inQualityFit).flatMap((m) => m.configs.map(() => m.key)).sort());
});

test('the Benchmarks board and both pickers fit the shown catalog, not the raw one', () => {
    const board = fs.readFileSync(path.join(UI, 'benchmarks', 'board.js'), 'utf-8');
    assert.match(board, /const shown = c\.catalog \? overviewCatalog\(c\.catalog, v\) : null;/);
    assert.match(board, /strengthByDir\(shown\.models \|\| \[\], v\.keepQ, v\.keepT\)/);
    assert.ok(!/strengthByDir\(c\.catalog\.models/.test(board));
    for (const f of ['modelpicker/index.js', 'profilepicker/index.js']) {
        const src = fs.readFileSync(path.join(UI, f), 'utf-8');
        assert.match(src, /const v = overviewView\(\), shown = overviewCatalog\(catalog, v\);/, f);
        assert.match(src, /fitFor\(shown\.models, v\.keepQ, v\.keepT\)/, f);
        assert.match(src, /rowKeyOf: \(k\) => overviewRowKey\(shown, k\)/, f);
        assert.ok(!/fitFor\(catalog\.models/.test(src), f);
    }
});

// The real thing, when this machine has the lab's results: every quality place reads the Models page's number.
test('real catalog: Benchmarks board rows, pickers and the Quality board agree with the Models page config for config', async (t) => {
    let M, cat, lb;
    try {
        M = require(path.join(__dirname, '..', 'lib', 'models'));
        cat = M.listModels(); lb = M.listLeaderboards();
    } catch (e) { t.skip('no lab catalog here: ' + e.message); return; }
    if (!cat || !Array.isArray(cat.models) || cat.models.length < 5) { t.skip('catalog too small'); return; }
    const { L, B: Board } = await load(t);
    const v = L.overviewView({ store: store({}) }), shown = L.overviewCatalog(cat, v);
    const fit = L.fitFor(shown.models, v.keepQ, v.keepT);
    const byDir = L.strengthByDir(shown.models, v.keepQ, v.keepT);
    const groupOf = new Map(); for (const g of fit.qAll) for (const d of g.dirs) groupOf.set(d, [...(groupOf.get(d) || []), g]);
    let rows = 0;
    for (const q of lb.quality) {
        const cell = Board.boardStrength(byDir, q.dirs, { solved: 0, scored: 0 });
        const gs = [...new Set(q.dirs.flatMap((d) => groupOf.get(d) || []))].filter((g) => fit.adj.get(g.key));
        if (!gs.length) { assert.strictEqual(cell, null, q.model); continue; }
        const best = L.bestConfigOf(gs, (g) => L.strengthRank(fit.adj.get(g.key)));   // the one rule (2026-10-21)
        assert.strictEqual(cell.v, fit.adj.get(best.key).rate, `${q.model} ${q.dirs.join(',')}`);
        rows++;
    }
    assert.ok(rows > 10, `${rows} board rows checked`);
    // pickers: every ladder point is the page's own entry for its config
    for (const p of L.ladderPoints(fit, fit.qAll, { how: 'adjusted', cost: 'time' })) if (p.y != null) assert.strictEqual(p.y, fit.adj.get(p._g.key).rate, p.label);
});
