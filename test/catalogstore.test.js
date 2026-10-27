'use strict';
// The page's one Models catalog (ui/benchmarks/util.js createCatalogStore) and the fit kept per catalog object
// (ui/shared/leaderboard.js fitFor), 2026-10-06. Object identity is the contract between them: a 304 hands back the
// same object, so a view knows nothing changed and the fit is not run again.
const test = require('node:test');
const assert = require('node:assert/strict');

const loadUtil = () => import('../ui/benchmarks/util.js');
const loadLb = () => import('../ui/shared/leaderboard.js');

// a fetch that answers like server4.js's catalog route: 200 + ETag, or 304 to a matching If-None-Match
function fakeServer() {
    const st = { etag: '"v1"', body: { models: [{ key: 'a' }] }, calls: [], status: 200, hold: null };
    const fetchFn = async (url, opts) => {
        const inm = opts && opts.headers && opts.headers['If-None-Match'];
        st.calls.push(inm || null);
        if (st.hold) await st.hold;
        if (st.status !== 200) return { ok: false, status: st.status, text: async () => 'down', headers: { get: () => null } };
        if (st.etag && inm === st.etag) return { ok: false, status: 304, headers: { get: () => st.etag } };
        const body = JSON.parse(JSON.stringify(st.body));
        return { ok: true, status: 200, json: async () => body, headers: { get: (h) => (h === 'ETag' ? st.etag : null) } };
    };
    return { st, fetchFn };
}

test('catalogStore: the second load sends the ETag and a 304 returns the SAME object', async () => {
    const { createCatalogStore } = await loadUtil();
    const { st, fetchFn } = fakeServer();
    const store = createCatalogStore(fetchFn);
    const a = await store.load();
    assert.deepEqual(a.catalog, { models: [{ key: 'a' }] });
    assert.deepEqual(st.calls, [null], 'nothing to offer on the first request');
    const b = await store.load();
    assert.deepEqual(st.calls, [null, '"v1"']);
    assert.equal(b.catalog, a.catalog, 'identity, not just equality');
    assert.equal(store.peek(), a.catalog);
    // the server has something new: a new object, and the new ETag is the one offered next
    st.etag = '"v2"'; st.body = { models: [{ key: 'a' }, { key: 'b' }] };
    const c = await store.load();
    assert.notEqual(c.catalog, a.catalog); assert.equal(c.catalog.models.length, 2);
    await store.load();
    assert.equal(st.calls[3], '"v2"');
});

test('catalogStore: callers at the same moment share one request; maxAgeMs reuses a recent answer without asking', async () => {
    const { createCatalogStore } = await loadUtil();
    const { st, fetchFn } = fakeServer();
    let now = 1000;
    const store = createCatalogStore(fetchFn, '/api/models/catalog', () => now);
    let open; st.hold = new Promise((r) => { open = r; });
    const p1 = store.load(), p2 = store.load({ maxAgeMs: 60000 });
    open(); st.hold = null;
    const [a, b] = await Promise.all([p1, p2]);
    assert.equal(st.calls.length, 1); assert.equal(a.catalog, b.catalog);
    now += 30000;
    assert.equal((await store.load({ maxAgeMs: 60000 })).catalog, a.catalog);
    assert.equal(st.calls.length, 1, 'inside the minute: no request');
    now += 31000;
    await store.load({ maxAgeMs: 60000 });
    assert.equal(st.calls.length, 2, 'past it: one conditional request');
    assert.equal(st.calls[1], '"v1"');
});

test('catalogStore: an error is reported, the last good catalog is kept and still offered by ETag; no ETag means no If-None-Match', async () => {
    const { createCatalogStore } = await loadUtil();
    const { st, fetchFn } = fakeServer();
    const store = createCatalogStore(fetchFn);
    const a = await store.load();
    st.status = 500;
    const bad = await store.load();
    assert.equal(bad.error, 'HTTP 500'); assert.equal(bad.status, 500); assert.equal(bad.text, 'down');
    assert.equal(store.peek(), a.catalog);
    st.status = 200;
    assert.equal((await store.load()).catalog, a.catalog);
    const thrown = createCatalogStore(async () => { throw new Error('offline'); });
    assert.match((await thrown.load()).error, /offline/);
    // the public site's catalog has no ETag: every answer is a new object and nothing conditional is sent
    const pub = fakeServer(); pub.st.etag = null;
    const ps = createCatalogStore(pub.fetchFn);
    const x = await ps.load(), y = await ps.load();
    assert.notEqual(x.catalog, y.catalog);
    assert.deepEqual(pub.st.calls, [null, null]);
});

// ---- fitFor: one fit per (catalog models array, facets)
const task = (credit) => ({ attempts: 1, passes: credit, credit, excluded: false, solved: credit > 0, wall_s: 60, tokens_out: 1000 });
const model = (key, ctx, tasks) => ({ key, display: key, provider: 'local', counts: { qualityTasks: Object.keys(tasks).length }, quality: {},
    configs: [{ n_ctx: ctx, facets: { weights: key, context: { n_ctx: ctx }, harness: { runner: 'opencode' } }, agg: { attempted: Object.keys(tasks).length, scored: Object.keys(tasks).length }, tasks, dirs: ['dir-' + key] }] });
const models = () => [model('m1', 131072, { t1: task(1), t2: task(1), t3: task(0) }), model('m2', 131072, { t1: task(1), t2: task(0), t3: task(0) })];

test('fitFor: the same models array and facets give the same fit object; another array or other facets give another', async () => {
    const L = await loadLb();
    const cat = models();
    const q = L.FACET_DEFAULTS.quality, t = L.FACET_DEFAULTS.full;
    const a = L.fitFor(cat, q, t);
    assert.equal(L.fitFor(cat, q, t), a);
    assert.equal(L.fitFor(cat, q.slice(), t.slice()), a, 'keyed on the facet VALUES, not the arrays');
    assert.notEqual(L.fitFor(cat, q.concat(['served']), t), a);
    assert.notEqual(L.fitFor(models(), q, t), a, 'a new catalog object is fitted again');
    // and it is the fit fitGroups would give
    const fresh = L.fitGroups(L.qualityEntries(cat), q, t);
    assert.deepEqual(a.qAll.map((g) => g.key), fresh.qAll.map((g) => g.key));
    for (const g of fresh.qAll) assert.deepEqual(a.adj.get(g.key), fresh.adj.get(g.key));
});

// 2026-10-14: a time cap over 120 min and a non-default prompt level are shared facets; the model row does not
// re-credit a long-cap rerun's failure at the baseline (its cap:long effect is left out of the shift).
test('difficultyAdjusted: cap:long and prompt:<level> facets; long-cap failures stay failures in the model row', async () => {
    const L = await loadLb();
    const tk = (credit) => ({ attempts: 1, passes: credit, credit, excluded: false, solved: credit > 0, wall_s: 60, tokens_out: 1000 });
    const g = (key, w, tasks, harness = {}) => ({ key, m: { key: w, weightsKey: w }, c: { n_ctx: 131072, facets: { harness: { runner: 'opencode', ...harness } } }, tasks });
    const base = { t1: tk(1), t2: tk(1), t3: tk(0), t4: tk(1), t5: tk(0) };
    const adj = L.difficultyAdjusted([
        g('a', 'A', base), g('along', 'A', { t3: tk(0), t5: tk(0) }, { timeout_s: 10800 }),
        g('acar', 'A', { t1: tk(1), t3: tk(1) }, { prompt_level: 'L2+careful' }),
        g('b', 'B', { t1: tk(1), t2: tk(0), t3: tk(0), t4: tk(0), t5: tk(0) }), g('c', 'C', { t1: tk(1), t2: tk(1), t3: tk(1), t4: tk(1), t5: tk(0) }),
    ]);
    assert.deepEqual([...adj.facetEffects.keys()].sort(), ['cap:long', 'prompt:L2+careful']);
    assert.ok(adj.facetEffects.get('cap:long') < 0, 'failures under a long cap read as a negative cap effect');
    // the long-cap row only failed tasks the baseline config also failed: with the cap effect left out of the shift, its
    // failures stay ~failures, so model A's credit on t3/t5 is not lifted above what its baseline config earned
    const m = adj.models.get('A');
    assert.ok(m && m.rate > 0 && m.rate < 1);
    assert.ok(adj.get('along').theta < adj.get('a').theta);
});

test('strengthByDir reads the cached fit: its entries are the fit\'s own', async () => {
    const L = await loadLb();
    const cat = models();
    const byDir = L.strengthByDir(cat);
    const fit = L.fitFor(cat, L.FACET_DEFAULTS.quality, L.FACET_DEFAULTS.full);
    assert.equal(byDir.get('dir-m1'), fit.adj.get(fit.qAll.find((g) => g.m.key === 'm1').key));
    assert.ok(byDir.get('dir-m1').rate > byDir.get('dir-m2').rate);
    assert.equal(L.strengthByDir([]).size, 0);
});

// The fit's inner loops were restructured for speed on 2026-10-06 (the quantile grid's log terms tabulated per task,
// the observations as flat columns). The numbers must be the ones the old loops gave, to the last bit: these were
// produced by the previous implementation on this fixture (partial credit, a KV facet, a perfect record, an
// all-fail record, an excluded task, an empty group).
test('difficultyAdjusted: the numbers of the pre-2026-10-06 implementation, exactly', async () => {
    const L = await loadLb();
    const tk = (credit, attempts = 1) => ({ attempts, passes: credit * attempts, credit, excluded: false, solved: credit > 0, wall_s: 60, tokens_out: 1000 });
    const g = (key, w, tasks, extra = {}) => ({ key, m: { key: w, weightsKey: w }, c: { n_ctx: 131072, facets: { harness: { runner: 'opencode' }, ...extra } }, tasks });
    const adj = L.difficultyAdjusted([
        g('a', 'A', { t1: tk(1), t2: tk(1), t3: tk(0.5, 2), t4: tk(0) }),
        g('a2', 'A', { t1: tk(1), t2: tk(0), t5: tk(1) }, { kv: ['--cache-type-k q8_0'] }),
        g('b', 'B', { t1: tk(1), t2: tk(1), t3: tk(1) }),
        g('c', 'C', { t1: tk(0), t4: tk(0), t5: tk(0), t6: { attempts: 1, credit: null, excluded: true } }),
        g('d', 'D', {}),
    ]);
    const rows = [...adj.entries()].map(([k, a]) => [k, a && [a.rate, a.lo, a.hi, a.coverage, a.theta, a.n]]);
    // ALL values changed on purpose on 2026-10-14 (Kyle: "install the recommended method"): the fit is now 2PL (a
    // per-task discrimination a_j, log a_j ~ N(0, 0.25^2), P(solve) = sigmoid(a_j * (theta - b_j)) everywhere), fitted
    // block by block. Chosen by held-out prediction (reviews/predictor-eval-20261014). The 1-parameter values were:
    //   a  [0.5258630119334015, 0.3370301679072345, 0.7125509401648935, 0.8310057541787468, 0.3142704741390616, 4]
    //   a2 [0.518437675379881, 0.341037365612665, 0.7136691057792197, 0.4867427756579027, 0.3060225589701483, 3]
    //   b  [0.836582609359793, 0.66595085594644, 1, 0.5139838565082698, 1.2623349909712136, 3]
    //   c  [0.07588577183749333, 0, 0.2202179731951174, 0.6103529345358015, -1.5002991201578515, 3]
    //   taskDifficulty t1 -0.695360515815324, t2 -0.0403206350831889, t3 -0.016065472906944565, t4 1.0076879824906533, t5 -0.25594135868519574
    //   models A 0.4865821287690599 0.29233951031716804 0.6808247472209517, B 0.8247970301407049 0.5890782371518956 0.996090715130767,
    //          C 0.08709189114890363 0 0.2976699297638799
    // rate / lo / hi changed on purpose on 2026-10-25 (Kyle: "Raw pass rate is near useless and should never be used in
    // the formula"; "Range fix yes"): strength is S(theta) = sum of points * P(theta, j) on EVERY task (no raw credit on the
    // tasks a config ran), the range is theta's 95% posterior through the same S (no Beta run-to-run term), and that
    // posterior's prior no longer counts the config's own results twice (its model's information less its own share,
    // centred so the posterior peaks at theta). coverage, theta, n and the task difficulties below are unchanged.
    // The values until 10-25 (rate, lo, hi):
    //   a  0.5225071006642107 0.33296400994412423 0.7097940381886317   a2 0.5122188310890948 0.3362100683260378 0.7088068267729294
    //   b  0.8362139425632368 0.6633771780250644 1                     c  0.07421987903714958 0 0.21505698228879946
    assert.deepEqual(rows, [
        ['a', [0.5440015876652385, 0.2551390472055618, 0.815357230560761, 0.8329771709394724, 0.31528655499798064, 4]],
        ['a2', [0.5417239527629804, 0.24783682052909783, 0.8210964844047598, 0.4809154698549753, 0.3054765755809819, 3]],
        ['b', [0.743022715984891, 0.3347849918678228, 0.9715753925010887, 0.5114714175848861, 1.2573169149316634, 3]],
        ['c', [0.17234984138514212, 0.017791947062917177, 0.5543571217338888, 0.607816040469882, -1.508748149737069, 3]],
        ['d', null],
    ]);
    assert.deepEqual([...adj.taskDifficulty.entries()], [['t1', -0.6920441039375118], ['t2', -0.03651337713596965], ['t3', -0.013119482609121338], ['t4', 1.0088868386283047], ['t5', -0.2672098749457019]]);
    assert.deepEqual([...adj.taskDiscrimination.entries()], [['t1', 1.0657286285521088], ['t2', 1.0172731744266341], ['t3', 1.0131515549152577], ['t4', 1.026399023794674], ['t5', 1.030051644429094]]);
    // MODEL strengths changed on purpose on 2026-10-14: each observed credit is shifted to the baseline settings
    // before it is averaged into the model's score (Kyle: "why the hell unadjusted...? yes, please fix"). The
    // per-config rows and task difficulties above are untouched. Previous values: A 0.48815..., B 0.82991..., C 0.08073...
    // MODEL strengths changed again on 2026-10-25: S(alpha) on every task, the range alpha +- 1.96 sd through S (no shifted
    // raw credit, no run-to-run term). Until 10-25: A 0.480847501155315 0.28614998126734126 0.6755450210432887,
    // B 0.8242819029146053 0.5855366403934963 0.9965138439089805, C 0.0854509194595714 0 0.2947208977081059
    assert.deepEqual([...adj.models.entries()].map(([k, a]) => [k, a.rate, a.lo, a.hi]), [
        ['A', 0.5404606052659346, 0.25825768246155706, 0.7978389331353966], ['B', 0.7310906763362596, 0.27645712700738884, 0.9542768365764176], ['C', 0.18358088180756396, 0.028540148637889437, 0.6059482145988623]]);
});

// The Results page's loading bar (2026-10-22): the body read as a stream, counted against X-Body-Length (the DECODED
// size the server announces), then parsed; a caller that asks for no progress gets the old path.
test('catalogStore onProgress: bytes against X-Body-Length, then parse; every caller sharing the request is told', async () => {
    const { createCatalogStore } = await loadUtil();
    const text = JSON.stringify({ models: [{ key: 'a' }, { key: 'b' }] });
    const bytes = new TextEncoder().encode(text);
    const chunks = [bytes.slice(0, 10), bytes.slice(10, 25), bytes.slice(25)];
    const fetchFn = async () => ({ ok: true, status: 200, headers: { get: (h) => (h === 'X-Body-Length' ? String(bytes.length) : h === 'ETag' ? '"e"' : null) },
        body: { getReader() { let k = 0; return { read: async () => (k < chunks.length ? { done: false, value: chunks[k++] } : { done: true }) }; } },
        json: async () => { throw new Error('the stream path must not call json()'); } });
    const store = createCatalogStore(fetchFn);
    const seen = [], other = [];
    let painted = 0;
    const [a, b] = await Promise.all([
        store.load({ onProgress: async (p) => { seen.push([p.phase, p.loaded, p.total]); if (p.phase === 'parse') { await new Promise((r) => setTimeout(r, 5)); painted++; } } }),
        store.load({ onProgress: (p) => other.push(p.phase) }),
    ]);
    assert.deepEqual(a.catalog, JSON.parse(text)); assert.equal(b.catalog, a.catalog);
    assert.deepEqual(seen, [['data', 0, bytes.length], ['data', 10, bytes.length], ['data', 25, bytes.length], ['data', bytes.length, bytes.length], ['parse', bytes.length, bytes.length]]);
    assert.equal(painted, 1, 'the parse step waited for the caller (its chance to paint)');
    assert.deepEqual(other.filter((x) => x === 'parse').length, 1, 'a second caller on the same request hears it too');
    // no length announced (an older server, a proxy that dropped it): bytes only, total null -- never a made-up fraction
    const noLen = createCatalogStore(async () => ({ ok: true, status: 200, headers: { get: () => null }, body: { getReader() { let d = false; return { read: async () => (d ? { done: true } : (d = true, { done: false, value: bytes })) }; } } }));
    const p2 = [];
    await noLen.load({ onProgress: (p) => p2.push(p.total) });
    assert.ok(p2.every((t) => t === null));
    // a caller that asks for progress AFTER another (a picker at page start) began the request still hears it
    let release; const gate = new Promise((r) => { release = r; });
    const late = createCatalogStore(async () => { await gate; return { ok: true, status: 200, headers: { get: (h) => (h === 'X-Body-Length' ? String(bytes.length) : null) }, body: { getReader() { let d = false; return { read: async () => (d ? { done: true } : (d = true, { done: false, value: bytes })) }; } } }; });
    const first = late.load();
    const heard = [];
    const second = late.load({ onProgress: (p) => heard.push(p.phase) });
    release();
    await Promise.all([first, second]);
    assert.deepEqual([heard[0], heard[heard.length - 1]], ['data', 'parse']);
});
