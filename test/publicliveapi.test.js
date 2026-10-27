// The lab's live API for the static site (2026-10-22): what the dashboard writes into logs/public-api/
// (lib/publiclive.js) and what public/live_server.py serves from it. The files must be exactly what public/server.js
// answered on the same routes, nothing private may get into them, and the file server must serve those three files
// and nothing else.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { spawn, spawnSync } = require('child_process');
const PL = require('../lib/publiclive');
const { liveRunning, sanitizePayload } = require('../lib/publicdata');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'publicliveapi-test-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

// What server4.js writes into logs/public-live.json, with everything a careless change could add.
const RAW = {
    at: 1000000,
    lanes: [{ lane: 'local-gpu', card: '2x RX 7900 XTX', engine: 'Strata', phase: 'gen', gen: 73.2, prefill: 372.9, progress: null, battery: 'bat-a', read: 821.6, readN: 1545 }],
    running: [{ dir: 'bat-a', runner: 'opencode', state: 'running', lane: 'local-gpu', task: 'repo-task-one', tasks: 3, done: 1, solved: 1,
        user_note: 'KYLE-PRIVATE-NOTE', launch_cmd: '/secret/bin/llama-server -m /secret/models/q4.gguf', path: '/secret/results/bat-a' },
    { dir: 'bat-b', runner: 'claude', state: 'running', lane: 'cloud', task: null, tasks: 2, done: 0, solved: 0 }],
    items: { 'bat-a': { question: 'Is /home/someone/models/q4.gguf faster over 192.168.1.125:50052?', passed: 1, failed: 0, excluded: 0, remaining: 2, total: 3, user_note: 'KYLE-PRIVATE-NOTE' } },
};
const SECRETS = ['KYLE-PRIVATE-NOTE', '/secret/', 'llama-server', '192.168.', '/home/'];

test('live.json is public/server.js\'s /api/live answer: liveRunning per battery, scrubbed, stale after 30 s', () => {
    const names = PL.batteryModels({ models: [{ display: 'Qwen 27B', batteries: [{ dir: 'bat-a' }, null, {}] }, { display: 'No runs' }] });
    assert.deepEqual(names, { 'bat-a': 'Qwen 27B' });
    const live = PL.liveAnswer(RAW, names, RAW.at + 2000);
    // the transform public/server.js liveSnapshot() applies, spelled out
    const want = sanitizePayload({ at: RAW.at, lanes: RAW.lanes, running: RAW.running.map((r) => liveRunning(r, RAW.items[r.dir] || null, names[r.dir])), stale: false });
    assert.deepEqual(live, want);
    assert.equal(live.running[0].model, 'Qwen 27B');
    assert.equal(live.running[0].question, 'Is q4.gguf faster over <ip>?');
    assert.equal(live.running[1].model, null);
    assert.ok(!('question' in live.running[1]) && !('passed' in live.running[1]), 'a battery with no queue item: counts only');
    assert.deepEqual(SECRETS.filter((s) => JSON.stringify(live).includes(s)), []);
    assert.equal(PL.liveAnswer(RAW, names, RAW.at + PL.STALE_MS).stale, true);
    assert.deepEqual(PL.liveAnswer(null, null, RAW.at), { at: 0, lanes: [], running: [], stale: true });
});

test('running.json is /api/models/running: five fields per battery; stats.json carries the DEPLOYED snapshot\'s stamp', () => {
    const files = PL.apiFiles(RAW, { names: {}, deployed: { contentHash: 'abc', at: 5, generatedAt: 1234, stats: { models: 61, generatedAt: 1234 } }, now: RAW.at });
    assert.deepEqual(Object.keys(files).sort(), ['live.json', 'running.json', 'stats.json']);
    assert.deepEqual(files['running.json'], { running: [
        { dir: 'bat-a', task: 'repo-task-one', tasks: 3, runner: 'opencode', state: 'running' },
        { dir: 'bat-b', task: null, tasks: 2, runner: 'claude', state: 'running' }] });
    assert.deepEqual(files['stats.json'], { models: 61, generatedAt: 1234 });
    // a deploy recorded before stats were: the stamp alone; never deployed: 0 -- a number, so the probe reads "up",
    // and never later than any snapshot a page can hold
    assert.deepEqual(PL.statsAnswer({ generatedAt: 99 }), { generatedAt: 99 });
    assert.deepEqual(PL.statsAnswer(null), { generatedAt: 0 });
    assert.deepEqual(PL.statsAnswer({ generatedAt: 'x', stats: { models: 1, generatedAt: 5e12 } }), { models: 1, generatedAt: 0 }, 'the stamp is only ever the deploy\'s own');
});

test('files are written whole: through a temp file and a rename', () => {
    const dir = path.join(TMP, 'api');
    PL.writeAtomic(dir, { 'live.json': { a: 1 }, 'stats.json': { generatedAt: 0 } });
    assert.deepEqual(fs.readdirSync(dir).sort(), ['live.json', 'stats.json']);
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'live.json'), 'utf8')), { a: 1 });
    const ino = fs.statSync(path.join(dir, 'live.json')).ino;
    PL.writeAtomic(dir, { 'live.json': { a: 2 } });
    assert.notEqual(fs.statSync(path.join(dir, 'live.json')).ino, ino, 'replaced by rename, not rewritten in place');
});

// ------------------------------------------------------------------ public/live_server.py
const hasPython = spawnSync('python3', ['--version']).status === 0;
const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });

test('live_server.py: three files, fresh, GET/HEAD, listed origins only, no-store; everything else 404', { skip: !hasPython && 'no python3' }, async () => {
    const dir = path.join(TMP, 'served');
    PL.writeAtomic(dir, PL.apiFiles(RAW, { now: RAW.at }));
    fs.writeFileSync(path.join(dir, 'secret.json'), '{"no":1}');
    const port = await freePort();
    const child = spawn('python3', [path.join(__dirname, '..', 'public', 'live_server.py')],
        { env: { ...process.env, LIVE_PORT: String(port), LIVE_DIR: dir, LIVE_CORS_ORIGINS: 'https://site.example,https://copy.example' }, stdio: 'ignore' });
    try {
        const base = `http://127.0.0.1:${port}`;
        for (let i = 0; i < 50; i++) { try { await fetch(base + '/'); break; } catch { await new Promise((r) => setTimeout(r, 100)); } }
        const get = (p, init) => fetch(base + p, init);

        for (const [p, f] of [['/api/stats', 'stats.json'], ['/api/live', 'live.json'], ['/api/models/running', 'running.json'], ['/api/live?x=1', 'live.json']]) {
            const r = await get(p, { headers: { Origin: 'https://site.example' } });
            assert.equal(r.status, 200, p);
            assert.equal(await r.text(), fs.readFileSync(path.join(dir, f), 'utf8'), p);
            assert.equal(r.headers.get('content-type'), 'application/json');
            assert.equal(r.headers.get('cache-control'), 'no-store');
            assert.equal(r.headers.get('access-control-allow-origin'), 'https://site.example');
            assert.equal(r.headers.get('access-control-allow-credentials'), null);
            assert.equal(r.headers.get('server'), 'live');
        }
        assert.equal((await get('/api/live', { headers: { Origin: 'https://copy.example' } })).headers.get('access-control-allow-origin'), 'https://copy.example');
        assert.equal((await get('/api/live', { headers: { Origin: 'https://evil.example' } })).headers.get('access-control-allow-origin'), null);
        assert.equal((await get('/api/live')).headers.get('access-control-allow-origin'), null);
        const head = await get('/api/stats', { method: 'HEAD' });
        assert.equal(head.status, 200);
        assert.equal(await head.text(), '');
        for (const p of ['/', '/api/models/catalog', '/api/model?key=x', '/api/posts', '/secret.json', '/api/secret.json', '/stats.json', '/api/../secret.json', '/api/stats/']) {
            assert.equal((await get(p)).status, 404, p);
        }
        assert.equal((await get('/api/live', { method: 'POST', body: 'x' })).status, 501);
        // the dashboard stopped writing: stale -> 503 (the page reads it as offline); a missing file the same
        const old = Date.now() / 1000 - 31;
        fs.utimesSync(path.join(dir, 'live.json'), old, old);
        assert.equal((await get('/api/live')).status, 503);
        fs.rmSync(path.join(dir, 'running.json'));
        assert.equal((await get('/api/models/running')).status, 503);
        assert.equal((await get('/api/stats')).status, 200, 'each file on its own');
    } finally { child.kill('SIGTERM'); }
});

test('live_server.py listens on the loopback address only, and says so in code', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'live_server.py'), 'utf8');
    assert.match(src, /ThreadingHTTPServer\(\('127\.0\.0\.1',/);
    assert.ok(!/do_(POST|PUT|DELETE|PATCH|OPTIONS)\b/.test(src), 'GET and HEAD only');
});
