// The public site's data must not carry task content, paths, addresses or private hostnames (lib/publicdata.js).
// Tests the OUTPUT: whatever the catalog grows later, these strings must not survive serialization.
const test = require('node:test');
const assert = require('node:assert');
const { sanitizeCatalog, sanitizePayload, scrubString } = require('../lib/publicdata');

const fixture = () => ({
    generatedAt: 1,
    taskTotal: 2,
    allTaskIds: ['repo-a-task-one', 'repo-b-task-two'],
    sources: { requests: '/home/someone/AI/logs/benchmarks.csv', codebench: '/home/someone/code/codebench/results' },
    taskMeta: {
        'repo-a-task-one': { repo: 'repo-a', variant: 'fix', tier: 't2', category: ['bug'], timeout_s: 3600,
            story: 'SECRET-STORY production incident', probes: 'SECRET-PROBES', weak_model_failure: 'SECRET-WEAK', incident_date: '2026-09-24' },
    },
    models: [{
        key: 'local:qwen:q4', display: 'Qwen Q4', why: 'unresolved: /data/models/x/y.gguf',
        sources: [{ id: 'x', raw: '/home/someone/.cache/huggingface/hub/models--a/snapshots/abc/model.gguf', dir: 'battery-1' }],
        configs: [{
            key: '[["weights","local:qwen:q4"],["build",{"dir":"/home/someone/llama.cpp/build-all"}]]',
            launchCommand: '/home/someone/llama.cpp/build-all/bin/llama-server -m /data/models/Q/Q-q4.gguf -c 65536 --rpc 192.168.1.125:50052,100.100.0.10:50052 --host 0.0.0.0',
            facets: { build: { dir: '/home/someone/llama.cpp/build-all' } },
            dirs: ['battery-1'],
            tasks: { 'repo-a-task-one': { status: 'pass', solved: true, transcript_tail: ['SECRET-TRANSCRIPT'] } },
        }],
    }],
});

test('public catalog: no task content, paths, addresses or host names survive', () => {
    const json = JSON.stringify(sanitizeCatalog(fixture()));
    for (const bad of ['SECRET-', 'story', 'probes', 'weak_model', 'incident_date', '/home/', '/data/', '.cache/huggingface',
        '192.168.', '100.100.', '0.0.0.0', 'transcript', '"sources"']) {
        assert.ok(!json.includes(bad), `leaked: ${bad}`);
    }
});

test('public catalog: the data the charts need is kept, identifiers stay consistent', () => {
    const out = sanitizeCatalog(fixture());
    assert.deepStrictEqual(out.allTaskIds, ['repo-a-task-one', 'repo-b-task-two']);            // task names are public
    assert.deepStrictEqual(out.taskMeta['repo-a-task-one'], { repo: 'repo-a', variant: 'fix', tier: 't2', category: ['bug'], timeout_s: 3600 });
    const c = out.models[0].configs[0];
    assert.strictEqual(c.tasks['repo-a-task-one'].status, 'pass');
    assert.deepStrictEqual(c.dirs, ['battery-1']);                                               // battery labels are public
    assert.match(c.launchCommand, /^llama-server -m Q-q4\.gguf -c 65536 --rpc <ip>,<ip> --host <ip>$/);
    assert.ok(c.key.includes('"dir":"build-all"') && c.facets.build.dir === 'build-all');        // same scrub, same id
});

test('scrubString: paths to basenames, IPs masked, ordinary text untouched', () => {
    assert.strictEqual(scrubString('see /home/u/a/b.json and ~/x/y.txt'), 'see b.json and y.txt');
    assert.strictEqual(scrubString('Qwen3.8-27B Q4_K_XL · 128k · kv q8'), 'Qwen3.8-27B Q4_K_XL · 128k · kv q8');
    assert.strictEqual(scrubString('70.5% at 1.5× time'), '70.5% at 1.5× time');
    assert.strictEqual(sanitizePayload({ a: { password: 'x', ok: 1 } }).a.password, undefined);
});

test('scrubString: version numbers that look like dotted quads are not addresses', () => {
    assert.strictEqual(scrubString('Strata 0.1.44.1 · KV int8'), 'Strata 0.1.44.1 · KV int8');
    assert.strictEqual(scrubString('build v1.2.3.4'), 'build v1.2.3.4');
    assert.strictEqual(scrubString('served via 10.10.10.2 and 192.168.1.125:22'), 'served via <ip> and <ip>');
    assert.strictEqual(scrubString('--host 127.0.0.1 --port 8080'), '--host <ip> --port 8080');
    assert.strictEqual(scrubString('bind 0.0.0.0:3000'), 'bind <ip>');
});
