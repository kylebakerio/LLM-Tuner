// The static site's data layer (public/assets/static-mode.js): every number, post, catalog and model record from the
// snapshot; live status from the lab while it answers, "offline" with the last record when it does not. Driven here
// with a fake fetch. 2026-10-06; 2026-10-22: the lab is a file server with live status only (public/live_server.py),
// so data no longer comes from it when its stamp is newer.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const M = require('../public/assets/static-mode.js');

const LAB = 'https://live.example';
const SNAP = {
    v: 1, builtAt: 2000, generatedAt: 1000, stats: { models: 3, generatedAt: 1000 }, posts: [{ slug: 'p1', title: 'P1' }],
    live: { at: 990, running: [{ dir: 'bat-1', model: 'A Q4', task: 't1', tasks: 3, done: 1, solved: 1 }] },
    catalog: '/data/catalog.json', models: { 'local:a:q4': '/data/model/aa.json' },
};
const body = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });

/** A fake network. lab: null = unreachable (fetch rejects, as a browser does for a dead tunnel or a missing CORS header),
 *  'hang' = never answers until aborted, 'stale' = every file 503 (public/live_server.py: the dashboard stopped writing),
 *  or { stamp } = up with that generatedAt. */
function world({ lab = null, snapshot = SNAP } = {}) {
    const w = { lab, snapshot, calls: [], clock: 100000, events: [] };
    w.fetch = (url, init = {}) => {
        w.calls.push(String(url));
        if (String(url).startsWith(LAB)) {
            const p = String(url).slice(LAB.length);
            if (w.lab === null) return Promise.reject(new TypeError('Failed to fetch'));
            if (w.lab === 'hang') return new Promise((_res, rej) => { init.signal.addEventListener('abort', () => rej(new DOMException('aborted', 'AbortError'))); });
            if (w.lab === 'stale') return Promise.resolve(body({ error: 'stale' }, 503));
            if (p === '/api/stats') return Promise.resolve(body({ models: 4, generatedAt: w.lab.stamp }));
            if (p === '/api/models/catalog') return Promise.resolve(body({ generatedAt: w.lab.stamp, models: ['live'] }));
            if (p.startsWith('/api/model?key=')) return Promise.resolve(p.includes('nope') ? body({ error: 'no such model' }, 404) : body({ key: 'live' }));
            if (p === '/api/live') return Promise.resolve(body({ at: w.clock, stale: false, lanes: [], running: [{ dir: 'bat-live' }] }));
            if (p === '/api/models/running') return Promise.resolve(body({ running: [{ dir: 'bat-live' }] }));
            return Promise.resolve(body({}, 404));
        }
        if (url === '/snapshot.json') return Promise.resolve(w.snapshot ? body(w.snapshot) : body({}, 404));
        if (url === '/data/catalog.json') return Promise.resolve(body({ generatedAt: 1000, models: ['snapshot'] }));
        if (url === '/data/model/aa.json') return Promise.resolve(body({ key: 'snapshot' }));
        return Promise.resolve(body({ passthrough: String(url) }));
    };
    w.mode = M.create({ fetch: w.fetch, liveOrigin: LAB + '/', pageOrigin: 'https://ai.example', now: () => w.clock, onChange: (i) => w.events.push({ probe: i.state.probe, refresh: !!i.refresh }) });
    w.get = async (url, init) => { const r = await w.mode.fetch(url, init); return { status: r.status, json: await r.json() }; };
    return w;
}

test('classify: the six API calls the site makes, and nothing else', () => {
    assert.deepEqual(M.classify('/api/stats'), { kind: 'stats', source: 'snapshot' });
    assert.deepEqual(M.classify('/api/posts'), { kind: 'posts', source: 'snapshot' });
    assert.deepEqual(M.classify('/api/models/catalog'), { kind: 'catalog', source: 'snapshot' });
    assert.deepEqual(M.classify('/api/model?key=cloud%3Ax%40low%2Fsolo'), { kind: 'model', source: 'snapshot', key: 'cloud:x@low/solo' });
    assert.deepEqual(M.classify('/api/live'), { kind: 'live', source: 'live' });
    assert.deepEqual(M.classify('/api/models/running'), { kind: 'running', source: 'live' });
    assert.equal(M.classify('/api/codebench/task?id=x'), null);
});

test('plan: data always from the snapshot, live status from the lab once the probe has answered', () => {
    const L = M.classify('/api/live'), R = M.classify('/api/models/running');
    for (const url of ['/api/stats', '/api/posts', '/api/models/catalog', '/api/model?key=k']) {
        for (const probe of ['pending', 'up', 'down']) assert.equal(M.plan(M.classify(url), { probe }), 'snapshot', `${url} while ${probe}`);   // never waits, never the lab
    }
    for (const X of [L, R]) {
        assert.equal(M.plan(X, { probe: 'pending' }), 'wait');
        assert.equal(M.plan(X, { probe: 'up' }), 'live');                  // live status only ever comes from the lab
        assert.equal(M.plan(X, { probe: 'down' }), 'offline');
    }
    assert.equal(M.isFresher, undefined, 'no stamp comparison any more: the lab has no data to be fresher with');
});

test('lab unreachable: everything from the snapshot, live says offline with the last record, note says so', async () => {
    const w = world({ lab: null });
    await w.mode.ready;
    assert.equal(w.mode.state.probe, 'down');
    assert.deepEqual((await w.get('/api/stats')).json, SNAP.stats);
    assert.deepEqual((await w.get('/api/posts')).json, SNAP.posts);
    assert.deepEqual((await w.get('/api/models/catalog')).json.models, ['snapshot']);
    assert.deepEqual((await w.get('/api/model?key=' + encodeURIComponent('local:a:q4'))).json, { key: 'snapshot' });
    assert.equal((await w.get('/api/model?key=unknown')).status, 404);
    const live = (await w.get('/api/live', { cache: 'no-store' })).json;
    assert.deepEqual(live, { at: 990, stale: true, offline: true, lanes: [], running: [], updatedAt: 1000, last: SNAP.live });
    assert.deepEqual((await w.get('/api/models/running')).json, { running: [] });
    assert.deepEqual(M.statusLine(w.mode.state, w.mode.state.snap, (ms) => `T${ms}`), { state: 'offline', text: 'last updated T1000 — the lab is offline' });
    assert.ok(!w.events.some((e) => e.refresh), 'nothing changed under the page: no redraw');
    assert.equal(w.calls.filter((u) => u.startsWith(LAB)).length, 1, 'one probe, then no more lab traffic for 30 s');
});

test('lab up: live status from the lab; numbers, catalog, model records and posts from the snapshot, whatever its stamp', async () => {
    for (const stamp of [5000, 1000, 0]) {                    // newer than the snapshot, the same, or the "never deployed" 0
        const w = world({ lab: { stamp } });
        await w.mode.ready;
        assert.equal(w.mode.state.probe, 'up');
        assert.deepEqual((await w.get('/api/stats')).json, SNAP.stats);
        assert.deepEqual((await w.get('/api/models/catalog')).json.models, ['snapshot']);
        assert.deepEqual((await w.get('/api/model?key=' + encodeURIComponent('local:a:q4'))).json, { key: 'snapshot' });
        assert.equal((await w.get('/api/model?key=nope')).status, 404);                    // not in the snapshot: no such model
        assert.deepEqual((await w.get('/api/posts')).json, SNAP.posts);
        assert.deepEqual((await w.get('/api/live')).json.running, [{ dir: 'bat-live' }]);
        assert.deepEqual((await w.get('/api/models/running')).json.running, [{ dir: 'bat-live' }]);
        assert.deepEqual(M.statusLine(w.mode.state, w.mode.state.snap, String), { state: 'live', text: 'live — connected to the lab' });
        assert.deepEqual(w.calls.filter((u) => u.startsWith(LAB)).map((u) => u.slice(LAB.length)), ['/api/stats', '/api/live', '/api/models/running'], 'the lab is asked for the probe and live status, nothing else');
    }
});

test('the numbers never wait for the probe, and the lab answering changes nothing under them (no redraw)', async () => {
    const slow = world({ lab: 'hang' });
    const early = await slow.get('/api/stats');             // asked while the probe is still out (it hangs for PROBE_MS)
    assert.deepEqual(early.json, SNAP.stats);
    assert.equal(slow.mode.state.probe, 'pending');
    await slow.mode.ready;
    const w = world({ lab: { stamp: 5000 } });
    assert.deepEqual((await w.get('/api/stats')).json, SNAP.stats);
    await w.mode.ready;
    assert.deepEqual(w.events.filter((e) => e.refresh), []);
    assert.deepEqual((await w.get('/api/stats')).json, SNAP.stats);
});

test('a slow lab costs at most the probe timeout: live status waits for the probe, then says offline; the catalog never waits', async () => {
    const w = world({ lab: 'hang' });
    let t0 = Date.now();
    assert.deepEqual((await w.get('/api/models/catalog')).json.models, ['snapshot']);
    assert.ok(Date.now() - t0 < 500, 'the catalog is the snapshot\'s at once');
    t0 = Date.now();
    const live = await w.get('/api/live');
    const took = Date.now() - t0;
    assert.equal(live.json.offline, true);
    assert.equal(w.mode.state.probe, 'down');
    assert.ok(took >= M.PROBE_MS - 400 && took < M.PROBE_MS + 1500, `took ${took} ms`);
});

test('stale files on the lab (503: the dashboard stopped writing) read as offline', async () => {
    const w = world({ lab: 'stale' });
    await w.mode.ready;
    assert.equal(w.mode.state.probe, 'down');
    assert.equal((await w.get('/api/live')).json.offline, true);
    const up = world({ lab: { stamp: 5000 } });
    await up.mode.ready;
    up.lab = 'stale';
    assert.equal((await up.get('/api/live')).json.offline, true);           // went stale mid-session: this poll says so
    assert.equal(up.mode.state.probe, 'down');
});

test('the lab goes away mid-session: the next live call says offline, data keeps coming from the snapshot', async () => {
    const w = world({ lab: { stamp: 5000 } });
    await w.mode.ready;
    w.lab = null;
    assert.equal((await w.get('/api/live')).json.offline, true);
    assert.equal(w.mode.state.probe, 'down');
    assert.deepEqual((await w.get('/api/models/catalog')).json.models, ['snapshot']);
    assert.deepEqual(w.events.map((e) => e.probe).filter((p, i, a) => p !== a[i - 1]).slice(-2), ['up', 'down']);
});

test('the lab comes back: found by a re-probe at most every 30 s, and the page is told to redraw', async () => {
    const w = world({ lab: null });
    await w.mode.ready;
    w.lab = { stamp: 5000 };
    assert.equal((await w.get('/api/live')).json.offline, true);            // within 30 s of the last probe: no new lab traffic
    assert.equal(w.calls.filter((u) => u.startsWith(LAB)).length, 1);
    w.clock += M.RETRY_MS;
    assert.equal((await w.get('/api/live')).json.offline, true);            // this poll starts the re-probe without waiting for it
    await w.mode.probe();
    assert.equal(w.mode.state.probe, 'up');
    assert.deepEqual(w.events.at(-1), { probe: 'up', refresh: true });
    assert.deepEqual((await w.get('/api/live')).json.running, [{ dir: 'bat-live' }]);
});

test('no lab origin configured, or no snapshot: still an answer', async () => {
    const a = M.create({ fetch: world().fetch, liveOrigin: '', pageOrigin: 'https://ai.example' });
    await a.ready;
    assert.equal(a.state.probe, 'down');
    const w = world({ lab: null, snapshot: null });
    await w.mode.ready;
    assert.equal((await w.get('/api/stats')).status, 503);
    assert.deepEqual((await w.get('/api/live')).json, { at: 0, stale: true, offline: true, lanes: [], running: [], updatedAt: null, last: null });
});

test('everything that is not a same-origin GET /api/ call goes to the real fetch untouched', async () => {
    const w = world({ lab: null });
    await w.mode.ready;
    assert.deepEqual((await w.get('/snapshot.json')).json.v, 1);
    assert.deepEqual((await w.get('/api/codebench/task?id=x')).json, { passthrough: '/api/codebench/task?id=x' });
    assert.deepEqual((await w.get('https://other.example/api/stats')).json, { passthrough: 'https://other.example/api/stats' });
    assert.deepEqual((await w.get('/api/stats', { method: 'POST' })).json, { passthrough: '/api/stats' });
});

test('lab requests carry no credentials and no custom headers (a "simple" request: no preflight)', async () => {
    const seen = [];
    const w = world({ lab: { stamp: 5000 } });
    const inner = w.fetch;
    const mode = M.create({ fetch: (u, i) => { if (String(u).startsWith(LAB)) seen.push(i); return inner(u, i); }, liveOrigin: LAB, pageOrigin: 'https://ai.example' });
    await mode.ready;
    await (await mode.fetch('/api/live', { cache: 'no-store' })).json();
    assert.ok(seen.length >= 2);
    for (const i of seen) { assert.equal(i.credentials, 'omit'); assert.equal(i.mode, 'cors'); assert.equal(i.headers, undefined); assert.equal(i.method, undefined); }
});
