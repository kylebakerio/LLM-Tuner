'use strict';
// The headless Launch Sweep must make EVERY rep a cold prefill: rep 2..N used to reuse the prompt
// cache, so a sweep line produced one prefill sample and never reached the Models page's 32k board.
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');

// Before requiring sweep.js: its journal must not overwrite the dashboard's real sweep-state.json.
const stateFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sweep-test-')), 'sweep-state.json');
process.env.SWEEP_STATE_FILE = stateFile;
const sweep = require('../lib/sweep');
test.after(() => fs.rmSync(path.dirname(stateFile), { recursive: true, force: true }));

test('repChatBody asks llama-server not to reuse the cached prompt', () => {
    const body = sweep.repChatBody('hello', 16);
    assert.equal(body.cache_prompt, false);
    assert.equal(body.max_tokens, 16);
    assert.equal(body.stream, false);
    assert.deepEqual(body.messages, [{ role: 'user', content: 'hello' }]);
});

// A stand-in for the dashboard's loopback API: just enough of /api/start, /api/status (SSE),
// /api/chat and friends for runAll to drive one row to completion.
function fakeDashboard() {
    const chats = [];
    const streams = new Set();
    const push = (msg) => { for (const s of streams) s.write(`data: ${JSON.stringify(msg)}\n\n`); };
    const json = (res, obj) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
    const server = http.createServer((req, res) => {
        let body = '';
        req.on('data', (c) => { body += c; });
        req.on('end', () => {
            if (req.url === '/api/status') {
                res.writeHead(200, { 'Content-Type': 'text/event-stream' });
                streams.add(res);
                res.on('close', () => streams.delete(res));   // not req's: that fires once the GET body is consumed
                return;
            }
            if (req.url === '/api/models') return json(res, [{ name: 'fake-model.gguf', path: '/models/fake-model.gguf' }]);
            if (req.url === '/api/builds') return json(res, { builds: [{ id: 'fake', path: '/bin/llama-server' }] });
            if (req.url === '/api/telemetry/latest') return json(res, { stats: { gpus: [] } });
            if (req.url === '/api/master/logs') return json(res, { logs: '' });
            if (req.url === '/api/stop') { json(res, {}); return push({ state: 'stopped' }); }
            if (req.url === '/api/start') {
                json(res, {});
                setTimeout(() => push({ state: 'loading' }), 20);
                setTimeout(() => push({ state: 'ready' }), 40);
                return;
            }
            if (req.url === '/api/chat') {
                chats.push(JSON.parse(body));
                json(res, { choices: [] });
                const payload = { promptTokens: 30000, promptTps: 400, genTps: 17, genTokens: 8 };
                setTimeout(() => push({ log: 'COMPLETION:' + JSON.stringify(payload) }), 20);
                return;
            }
            res.writeHead(404); res.end();
        });
    });
    return { server, chats, close: () => { for (const s of streams) s.destroy(); server.close(); } };
}

test('every rep of a sweep row sends cache_prompt:false through /api/chat', { timeout: 60000 }, async () => {
    const fake = fakeDashboard();
    await new Promise((r) => fake.server.listen(0, '127.0.0.1', r));
    sweep.port = fake.server.address().port;
    try {
        await sweep.start({ lines: ['row1 :: -m fake-model.gguf -c 4096'], prompt: 'a long prompt', reps: 3, genTokens: 8, build: 'fake' });
        const t0 = Date.now();
        while (sweep.status().running && Date.now() - t0 < 50000) await new Promise((r) => setTimeout(r, 200));
        const st = sweep.status();
        assert.equal(st.running, false);
        assert.equal(st.rows[0].status, 'done', st.rows[0].error || '');
        assert.equal(fake.chats.length, 3);
        for (const body of fake.chats) assert.equal(body.cache_prompt, false);
        assert.equal(st.summary[0].n, 3);
        // the journal went to the temp file, not the dashboard's real one
        assert.ok(fs.existsSync(stateFile));
    } finally {
        fake.close();
    }
});
