'use strict';
// lib/catalogcache.js: the Models catalog kept as a prebuilt answer (2026-10-06). The rules a request is answered
// by -- rebuild / serve / serve and refresh after -- and the ETag, with the signature, the build and the clock injected.
const test = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('zlib');
const C = require('../lib/catalogcache');

test('decide: no answer builds; a changed input serves the kept answer and rebuilds in the background; logged requests wait for the soft age', () => {
    const entry = { sig: { inputs: 'a', requests: '10:10' }, builtAt: 1000 };
    const o = { softMs: 60000, maxAgeMs: 300000 };
    assert.equal(C.decide(null, { inputs: 'a', requests: '10:10' }, 1000, o), 'build');
    assert.equal(C.decide(entry, { inputs: 'a', requests: '10:10' }, 2000, o), 'serve');
    // a task result landed in an existing battery dir: served at once, rebuilt behind it (2026-10-21: never built
    // inside a request once there is an answer -- the build had grown to 4-16 s and stalled every request)
    assert.equal(C.decide(entry, { inputs: 'b', requests: '10:10' }, 1001, o), 'serve+refresh');
    // only the request table moved: nothing until the answer is a minute old, then a background rebuild
    assert.equal(C.decide(entry, { inputs: 'a', requests: '11:11' }, 1000 + 59000, o), 'serve');
    assert.equal(C.decide(entry, { inputs: 'a', requests: '11:11' }, 1000 + 61000, o), 'serve+refresh');
    // nothing the signature sees, but old: served, refreshed after
    assert.equal(C.decide(entry, { inputs: 'a', requests: '10:10' }, 1000 + 300001, o), 'serve+refresh');
});

test('pack: generatedAt is in the body and not in the ETag; any other change moves the ETag', () => {
    const a = C.pack({ models: [{ key: 'm' }], taskTotal: 3, generatedAt: 1 });
    const b = C.pack({ models: [{ key: 'm' }], taskTotal: 3, generatedAt: 2 });
    const c = C.pack({ models: [{ key: 'm' }], taskTotal: 4, generatedAt: 1 });
    assert.equal(a.etag, b.etag);
    assert.notEqual(a.etag, c.etag);
    assert.match(a.etag, /^"[0-9a-f]{20}"$/);
    assert.deepEqual(JSON.parse(b.body.toString()), { models: [{ key: 'm' }], taskTotal: 3, generatedAt: 2 });
    assert.deepEqual(JSON.parse(C.pack({ generatedAt: 5 }).body.toString()), { generatedAt: 5 });
    assert.deepEqual(JSON.parse(C.pack({ a: 1 }).body.toString()), { a: 1, generatedAt: null });
});

test('etagMatches: exact, a list, a weak validator, *; never an empty header', () => {
    assert.equal(C.etagMatches('"abc"', '"abc"'), true);
    assert.equal(C.etagMatches('"x", W/"abc"', '"abc"'), true);
    assert.equal(C.etagMatches('*', '"abc"'), true);
    assert.equal(C.etagMatches('"abd"', '"abc"'), false);
    assert.equal(C.etagMatches(undefined, '"abc"'), false);
    assert.equal(C.etagMatches('', '"abc"'), false);
});

function harness() {
    const st = { sig: { inputs: 'a', requests: '1:1' }, now: 0, builds: 0, value: { models: [1], generatedAt: 0 }, gate: null };
    const cache = C.createCatalogCache({
        signature: () => ({ ...st.sig }), now: () => st.now, softMs: 60000, maxAgeMs: 300000,
        build: async () => { st.builds++; if (st.gate) await st.gate; return { ...st.value, generatedAt: st.now }; },
    });
    return { st, cache };
}

test('cache: one build serves every later request; the compressed forms decode to the body', async () => {
    const { st, cache } = harness();
    const a = await cache.get();
    assert.equal(st.builds, 1); assert.equal(a.refresh, null);
    assert.deepEqual(JSON.parse(zlib.brotliDecompressSync(a.entry.br).toString()), JSON.parse(a.entry.body.toString()));
    assert.deepEqual(JSON.parse(zlib.gunzipSync(a.entry.gzip).toString()), JSON.parse(a.entry.body.toString()));
    st.now = 30000;
    const b = await cache.get();
    assert.equal(st.builds, 1); assert.equal(b.entry, a.entry, 'the same buffer'); assert.equal(b.refresh, null);
});

test('cache: a result landing is served from the kept answer at once and rebuilt after; an identical rebuild keeps its ETag', async () => {
    const { st, cache } = harness();
    const a = await cache.get();
    st.sig.inputs = 'b'; st.now = 1000;           // the signature moved but the catalog came out the same
    const b = await cache.get();
    assert.equal(st.builds, 1, 'not built inside the request'); assert.equal(b.entry, a.entry); assert.equal(typeof b.refresh, 'function');
    await b.refresh();
    assert.equal(st.builds, 2);
    const b2 = await cache.get();
    assert.equal(b2.refresh, null); assert.equal(b2.entry.etag, a.entry.etag); assert.equal(b2.entry.builtAt, 1000);
    st.sig.inputs = 'c'; st.value = { models: [1, 2], generatedAt: 0 };
    assert.equal(cache.peek().sig.inputs, 'b');
    await cache.tick();                            // the server's timer finds it behind and rebuilds it
    assert.equal(st.builds, 3);
    const c = await cache.get();
    assert.equal(c.refresh, null); assert.notEqual(c.entry.etag, a.entry.etag);
    assert.deepEqual(JSON.parse(c.entry.body.toString()).models, [1, 2]);
});

test('cache: logged requests alone serve the buffer; past the soft age they hand back a background refresh', async () => {
    const { st, cache } = harness();
    const a = await cache.get();
    st.sig.requests = '2:2'; st.now = 20000; st.value = { models: [1, 2], generatedAt: 0 };
    const b = await cache.get();
    assert.equal(st.builds, 1); assert.equal(b.entry, a.entry); assert.equal(b.refresh, null);
    assert.equal(cache.tick(), null, 'the timer leaves it alone too');
    st.now = 61000;
    const c = await cache.get();
    assert.equal(c.entry, a.entry); assert.equal(typeof c.refresh, 'function');
    await c.refresh();
    assert.equal(st.builds, 2);
    const d = await cache.get();
    assert.equal(st.builds, 2); assert.equal(d.refresh, null); assert.notEqual(d.entry.etag, a.entry.etag);
});

test('cache: requests before the first answer share one build; while a rebuild runs, requests get the kept answer and no second build', async () => {
    const { st, cache } = harness();
    let open; st.gate = new Promise((r) => { open = r; });
    const p1 = cache.get(), p2 = cache.get();
    open(); st.gate = null;
    const [a, b] = await Promise.all([p1, p2]);
    assert.equal(st.builds, 1); assert.equal(a.entry, b.entry);
    st.sig.inputs = 'z'; st.now = 1000;
    st.gate = new Promise((res) => { open = res; });
    const r = await cache.get();
    const refreshing = r.refresh();
    assert.equal(cache.building(), true);
    const during = await cache.get();
    assert.equal(during.entry, a.entry, 'the kept answer, at once'); assert.equal(during.refresh, null, 'no second build queued');
    assert.equal(cache.tick(), null);
    open(); st.gate = null; await refreshing;
    assert.equal(st.builds, 2); assert.equal(cache.peek().sig.inputs, 'z');
});

test('cache: buildPacked (the worker) is used when it answers; when it fails, build() runs on this thread', async () => {
    let packedCalls = 0, plainCalls = 0, fail = false; const errs = [];
    const cache = C.createCatalogCache({
        signature: () => ({ inputs: 'a', requests: '-' }),
        buildPacked: async () => { packedCalls++; if (fail) throw new Error('worker died'); return C.packAll({ from: 'worker', generatedAt: 1 }); },
        build: () => { plainCalls++; return { from: 'thread', generatedAt: 2 }; },
        onError: (e) => errs.push(e.message),
    });
    const a = await cache.get();
    assert.deepEqual([packedCalls, plainCalls], [1, 0]);
    assert.equal(JSON.parse(a.entry.body.toString()).from, 'worker');
    assert.equal(JSON.parse(zlib.gunzipSync(a.entry.gzip).toString()).from, 'worker');
    fail = true;
    const b = await cache.rebuild();
    assert.deepEqual([packedCalls, plainCalls], [2, 1]); assert.deepEqual(errs, ['worker died']);
    assert.equal(JSON.parse(b.body.toString()).from, 'thread');
});

test('cache: a failed build rejects and the next request tries again', async () => {
    let n = 0;
    const cache = C.createCatalogCache({ signature: () => ({ inputs: 'a', requests: '-' }), build: () => { if (n++ === 0) throw new Error('boom'); return { ok: 1 }; } });
    await assert.rejects(cache.get(), /boom/);
    assert.deepEqual(JSON.parse((await cache.get()).entry.body.toString()), { ok: 1, generatedAt: null });
});

// ---- lib/catalogworker.js: the thread's protocol, with a stand-in worker (the real one runs listModels) ----
const fs = require('fs');
const os = require('os');
const path = require('path');
const W = require('../lib/catalogworker');

function standIn(body) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'catworker-'));
    const f = path.join(dir, 'w.js');
    fs.writeFileSync(f, `const { parentPort, workerData } = require('worker_threads');
const { packAll } = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'catalogcache.js'))});
let n = 0;
parentPort.on('message', async ({ id, roots }) => { n++; ${body} });`);
    return f;
}

test('catalog worker: answers by id with Buffers that decode; roots are read per build; a crash rejects and the next build starts a new thread', async (t) => {
    const keep = setInterval(() => {}, 1000); t.after(() => clearInterval(keep));
    const file = standIn(`if (roots && roots.crash) process.exit(3);
        const p = await packAll({ n, roots, generatedAt: 0 });
        parentPort.postMessage({ id, ok: true, body: p.body, br: p.br, gzip: p.gzip, etag: p.etag, ms: 1 });`);
    let roots = [{ dir: '/x' }];
    const w = W.createCatalogWorker({ file, role: 'test', roots: () => roots });
    t.after(() => w.stop());
    const a = await w.build();
    assert.ok(Buffer.isBuffer(a.body) && Buffer.isBuffer(a.br) && Buffer.isBuffer(a.gzip));
    assert.deepEqual(JSON.parse(a.body.toString()), { n: 1, roots: [{ dir: '/x' }], generatedAt: 0 });
    assert.deepEqual(JSON.parse(zlib.brotliDecompressSync(a.br).toString()), JSON.parse(a.body.toString()));
    roots = [{ dir: '/y' }];
    const [b, c] = await Promise.all([w.build(), w.build()]);
    assert.deepEqual([JSON.parse(b.body.toString()).n, JSON.parse(c.body.toString()).n], [2, 3], 'the same thread, kept warm');
    assert.deepEqual(JSON.parse(c.body.toString()).roots, [{ dir: '/y' }]);
    roots = { crash: true };
    await assert.rejects(w.build(), /exited \(3\)/);
    roots = [];
    const d = await w.build();
    assert.equal(JSON.parse(d.body.toString()).n, 1, 'a new thread');
});

test('catalog worker: an error in the build rejects; a build past the timeout rejects and the thread is replaced', async (t) => {
    const keep = setInterval(() => {}, 1000); t.after(() => clearInterval(keep));
    const file = standIn(`if (roots === 'hang') return; if (roots === 'bad') return parentPort.postMessage({ id, ok: false, error: 'Error: nope' });
        const p = await packAll({ n }); parentPort.postMessage({ id, ok: true, body: p.body, br: p.br, gzip: p.gzip, etag: p.etag });`);
    let roots = 'bad';
    const w = W.createCatalogWorker({ file, role: 'test', roots: () => roots, timeoutMs: 300 });
    t.after(() => w.stop());
    await assert.rejects(w.build(), /catalog worker: Error: nope/);
    roots = 'hang';
    await assert.rejects(w.build(), /no answer in/);
    roots = 'ok';
    assert.equal(JSON.parse((await w.build()).body.toString()).n, 1, 'a fresh thread after the timeout');
});
