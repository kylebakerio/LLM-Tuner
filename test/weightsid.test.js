// lib/weightsid.js and models.js withWeightsFile (2026-10-15, Kyle: "a different file must not blend"): a local model
// file is identified by its CONTENT, so a re-uploaded quant under the same name is a row of its own, while copies and
// moved snapshots of the same bytes stay one row.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const W = require('../lib/weightsid.js');
const M = require('../lib/models.js');

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'wid-'));
const bytes = (n, f = (i) => i % 251) => { const b = Buffer.alloc(n); for (let i = 0; i < n; i++) b[i] = f(i); return b; };

test('fingerprint: the pinned test vector (harness/config_identity.py computes the same)', (t) => {
    const d = tmpdir(); t.after(() => fs.rmSync(d, { recursive: true, force: true }));
    fs.writeFileSync(path.join(d, 'tv.gguf'), bytes(3 * 1048576));
    assert.strictEqual(W.fingerprintFile(path.join(d, 'tv.gguf')), W.FINGERPRINT_TEST_VECTOR);
    assert.strictEqual(W.FINGERPRINT_TEST_VECTOR, 'w1:3145728:b6cae9540ecf650d');
});

test('fingerprint: content decides -- a changed head or tail is another file, a copy is the same', (t) => {
    const d = tmpdir(); t.after(() => fs.rmSync(d, { recursive: true, force: true }));
    const a = path.join(d, 'a.gguf'), b = path.join(d, 'b.gguf'), c = path.join(d, 'c.gguf'), e = path.join(d, 'e.gguf');
    fs.writeFileSync(a, bytes(2_500_000));
    fs.copyFileSync(a, b);
    fs.writeFileSync(c, bytes(2_500_000, (i) => (i === 10 ? 7 : i % 251)));          // one header byte differs
    fs.writeFileSync(e, bytes(2_500_000, (i) => (i === 2_499_999 ? 3 : i % 251)));   // one tail byte differs
    assert.strictEqual(W.fingerprintFile(a), W.fingerprintFile(b));
    assert.notStrictEqual(W.fingerprintFile(a), W.fingerprintFile(c));
    assert.notStrictEqual(W.fingerprintFile(a), W.fingerprintFile(e));
    assert.strictEqual(W.fingerprintFile(path.join(d, 'missing.gguf')), null);
});

test('fingerprint: a multi-part gguf counts every shard; a missing shard -> null', (t) => {
    const d = tmpdir(); t.after(() => fs.rmSync(d, { recursive: true, force: true }));
    const p1 = path.join(d, 'M-UD-Q2_K_XL-00001-of-00002.gguf'), p2 = path.join(d, 'M-UD-Q2_K_XL-00002-of-00002.gguf');
    assert.deepStrictEqual(W.shardsOf(p1), [p1, p2]);
    assert.deepStrictEqual(W.shardsOf('/x/plain.gguf'), ['/x/plain.gguf']);
    fs.writeFileSync(p1, bytes(1000));
    assert.strictEqual(W.fingerprintFile(p1), null, 'shard 2 missing');
    fs.writeFileSync(p2, bytes(500));
    assert.match(W.fingerprintFile(p1), /^w1:1500:[0-9a-f]{16}$/);
});

test('weightsIdOf: recorded > registry (while the file is unchanged) > the file > null', (t) => {
    const d = tmpdir(); t.after(() => { fs.rmSync(d, { recursive: true, force: true }); W.configure({}); });
    const live = path.join(d, 'live.gguf'); fs.writeFileSync(live, bytes(4096));
    const real = W.fingerprintFile(live);
    W.configure({ registry: { paths: {
        '/gone/old.gguf': { id: 'sha:deadbeefdeadbeef' },
        [live]: { id: 'w1:1:stale', stat: 'not-the-stat' },          // the file changed since the registry was built
    } } });
    assert.deepStrictEqual(W.weightsIdOf('/gone/old.gguf', { id: 'w1:9:recorded' }), { id: 'w1:9:recorded', via: 'recorded', exists: null });
    assert.strictEqual(W.weightsIdOf('/gone/old.gguf').id, 'sha:deadbeefdeadbeef');
    assert.strictEqual(W.weightsIdOf('/gone/old.gguf').via, 'registry');
    assert.strictEqual(W.weightsIdOf(live).id, real, 'a stale registry entry is re-read from the file');
    assert.strictEqual(W.weightsIdOf('/gone/unknown.gguf').id, null, 'gone, no evidence: not verified');
});

test('prime: the newest file that still exists is the reference; with none left, the one with most rows', (t) => {
    const d = tmpdir(); t.after(() => { fs.rmSync(d, { recursive: true, force: true }); W.configure({}); });
    const now = path.join(d, 'now.gguf'); fs.writeFileSync(now, bytes(5000));
    W.configure({ registry: { paths: { '/gone/a.gguf': { id: 'sha:aaaaaaaaaaaaaaaa' }, '/gone/b.gguf': { id: 'sha:bbbbbbbbbbbbbbbb' } } } });
    W.prime([{ baseKey: 'local:x:q6', path: '/gone/a.gguf', rows: 500 }, { baseKey: 'local:x:q6', path: now, rows: 3 },
        { baseKey: 'local:y:q4', path: '/gone/a.gguf', rows: 2 }, { baseKey: 'local:y:q4', path: '/gone/b.gguf', rows: 9 }]);
    assert.strictEqual(W.referenceId('local:x:q6'), W.fingerprintFile(now), 'on disk wins over row count');
    assert.strictEqual(W.referenceId('local:y:q4'), 'sha:bbbbbbbbbbbbbbbb');
    assert.strictEqual(W.referenceId('local:z:q8'), null);
});

test('withWeightsFile: the reference keeps the plain key; another VERIFIED file of the name is its own row; unverified pools', (t) => {
    t.after(() => { W.configure({}); M.configure({}); });
    const HF = '/home/kyle/.cache/huggingface/hub/models--unsloth--Qwen3.8-27B-GGUF/snapshots';
    const cur = `${HF}/4ca720/Qwen3.8-27B-UD-Q6_K_XL.gguf`, sept = `${HF}/27af057/Qwen3.8-27B-UD-Q6_K_XL.gguf`;
    const other = `${HF}/fe1e2a2/Qwen3.8-27B-UD-Q6_K_XL.gguf`, laptop = '/home/kyle-4090/llama-lane/models/Qwen3.8-27B-UD-Q6_K_XL.gguf';
    M.configure({ weightsRegistry: { paths: {
        [cur]: { id: 'w1:25299061664:4fca7ce6d672232f' },
        [sept]: { id: 'w1:25299061664:4fca7ce6d672232f', sameAs: cur },           // HF: same LFS sha256 at both revisions
        [other]: { id: 'sha:739202186fd9389b' },                                  // HF: a different upload of the name
    } } });
    W.prime([{ baseKey: 'local:qwen3.8-27b:q6-k-xl', path: cur, rows: 1000 }, { baseKey: 'local:qwen3.8-27b:q6-k-xl', path: other, rows: 177 }]);
    const c = (p) => M.withWeightsFile(M.canonicalModel(p), p);
    assert.strictEqual(c(cur).key, 'local:qwen3.8-27b:q6-k-xl');
    assert.strictEqual(c(sept).key, 'local:qwen3.8-27b:q6-k-xl', 'September runs: the same bytes, the same row');
    assert.strictEqual(c(other).key, 'local:qwen3.8-27b:q6-k-xl~file:73920218');
    assert.match(c(other).display, /other file 73920218/);
    assert.strictEqual(c(laptop).key, 'local:qwen3.8-27b:q6-k-xl', 'a copy nobody verified is not split off on no evidence');
    assert.strictEqual(c(laptop).weightsVia, null);
    // variants follow the file part, so the folds and the variant suffixes keep working
    const v = M.withWeightsFile({ ...M.canonicalModel(other), key: 'local:qwen3.8-27b:q6-k-xl~nothink', display: 'Qwen3.8-27B Q6_K_XL (thinking off)' }, other);
    assert.strictEqual(v.key, 'local:qwen3.8-27b:q6-k-xl~file:73920218~nothink');
    assert.strictEqual(v.display, 'Qwen3.8-27B Q6_K_XL (thinking off, other file 73920218)');
    // a recorded fingerprint beats the path
    assert.strictEqual(M.withWeightsFile(M.canonicalModel(cur), cur, { id: 'sha:739202186fd9389b' }).key, 'local:qwen3.8-27b:q6-k-xl~file:73920218');
    // cloud and pathless rows untouched
    const cl = M.canonicalModel('claude-opus-5');
    assert.strictEqual(M.withWeightsFile(cl, '/x.gguf'), cl);
});

test('the registry builder: gone paths only with evidence; a sameAs/sha256 match takes the existing file\'s id', async (t) => {
    const d = tmpdir(); t.after(() => { fs.rmSync(d, { recursive: true, force: true }); W.configure({}); });
    const R = require('../tools/weights-registry.js');
    const a = path.join(d, 'blobs', 'a'.repeat(64)); fs.mkdirSync(path.dirname(a), { recursive: true }); fs.writeFileSync(a, bytes(9000));
    const snap = path.join(d, 'snap1', 'X-Q6_K_XL.gguf'); fs.mkdirSync(path.dirname(snap)); fs.symlinkSync(a, snap);
    const reg = await R.build({ paths: new Map([[snap, 10], ['/gone/same.gguf', 4], ['/gone/bysha.gguf', 3], ['/gone/other.gguf', 2], ['/gone/nothing.gguf', 1]]),
        evidence: { '/gone/same.gguf': { sameAs: snap, evidence: 'copy' }, '/gone/bysha.gguf': { sha256: 'a'.repeat(64), evidence: 'hf' },
            '/gone/other.gguf': { sha256: 'b'.repeat(64), size: 5, evidence: 'hf' } } });
    const id = reg.paths[snap].id;
    assert.strictEqual(reg.paths[snap].sha256, 'a'.repeat(64), 'an HF blob is named by its sha256');
    assert.strictEqual(reg.paths['/gone/same.gguf'].id, id);
    assert.strictEqual(reg.paths['/gone/bysha.gguf'].id, id);
    assert.strictEqual(reg.paths['/gone/other.gguf'].id, 'sha:' + 'b'.repeat(16));
    assert.ok(!reg.paths['/gone/nothing.gguf'], 'no evidence, no entry');
});

test('request rows: insertRequest adds the file fingerprint to config_json (readable files only, objects only)', (t) => {
    const d = tmpdir(); t.after(() => { fs.rmSync(d, { recursive: true, force: true }); W.configure({}); });
    W.configure({ registry: { paths: {} } });
    const { withWeights } = require('../lib/db.js');
    const f = path.join(d, 'm.gguf'); fs.writeFileSync(f, bytes(3 * 1048576));
    assert.deepStrictEqual(JSON.parse(withWeights('{"argString":"-c 4096"}', f)), { argString: '-c 4096', weights: { id: W.FINGERPRINT_TEST_VECTOR } });
    assert.deepStrictEqual(JSON.parse(withWeights(null, f)), { weights: { id: W.FINGERPRINT_TEST_VECTOR } });
    assert.strictEqual(withWeights('{"a":1}', path.join(d, 'gone.gguf')), '{"a":1}');
    assert.strictEqual(withWeights('[1]', f), '[1]');
    assert.strictEqual(withWeights('not json', f), 'not json');
});
