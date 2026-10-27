'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const S = require('../lib/modelscan');

// A throwaway copy of the rig's layout: ROOT/models with symlinks into /data/models, a model in
// /data/models with no symlink (Ornith), a 3-part split model, the HF hub's snapshot links, and an
// external drive holding a byte-for-byte copy plus a model found nowhere else.
function fixture() {
    const t = fs.mkdtempSync(path.join(os.tmpdir(), 'modelscan-'));
    const mk = (p, bytes) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, ''); fs.truncateSync(p, bytes); return p; };
    const models = path.join(t, 'models'), data = path.join(t, 'data'), hub = path.join(t, 'hub'), ext = path.join(t, 'ext');
    const split = (dir, stem, sizes) => sizes.map((b, i) => mk(path.join(dir, `${stem}-0000${i + 1}-of-0000${sizes.length}.gguf`), b));
    const ornith = mk(path.join(data, 'Ornith-1.5-35B-A3B', 'Ornith-1.5-35B-Q4_K_M.gguf'), 2000);
    const swift = mk(path.join(data, 'Swift', 'Swift-Qwen3.8-27B-Q4_K_L.gguf'), 1900);
    const flash = split(path.join(data, 'Flash', 'UD-Q2_K_XL'), 'Qwen3.8-Flash-Next-UD-Q2_K_XL', [11, 5000, 3000]);
    fs.mkdirSync(models, { recursive: true });
    fs.symlinkSync(swift, path.join(models, path.basename(swift)));
    for (const p of flash) fs.symlinkSync(p, path.join(models, path.basename(p)));
    mk(path.join(models, 'qwen2.5-coder-7b-instruct-q4_k_m.gguf'), 470);
    mk(path.join(models, '.cache', 'huggingface', 'download', 'stale.gguf'), 5);
    // HF hub: snapshot entries are symlinks to extension-less blobs; two snapshots share one mmproj blob
    const blob = (name, bytes) => mk(path.join(hub, 'models--u--Q-GGUF', 'blobs', name), bytes);
    const q4 = blob('aaa', 1700), mm = blob('bbb', 90);
    for (const rev of ['r1', 'r2']) {
        fs.mkdirSync(path.join(hub, 'models--u--Q-GGUF', 'snapshots', rev), { recursive: true });
        fs.symlinkSync(mm, path.join(hub, 'models--u--Q-GGUF', 'snapshots', rev, 'mmproj-F16.gguf'));
    }
    fs.symlinkSync(q4, path.join(hub, 'models--u--Q-GGUF', 'snapshots', 'r2', 'Qwen3.8-27B-UD-Q4_K_XL.gguf'));
    // the external drive: a copy of the split model (not a link) and one only it has
    split(path.join(ext, 'Flash', 'UD-Q2_K_XL'), 'Qwen3.8-Flash-Next-UD-Q2_K_XL', [11, 5000, 3000]);
    split(path.join(ext, 'Flash', 'UD-IQ1_S'), 'Qwen3.8-Flash-Next-UD-IQ1_S', [11, 4000, 2000]);
    fs.symlinkSync(path.join(t, 'gone', 'x.gguf'), path.join(models, 'dangling.gguf'));
    const roots = [{ dir: models, source: 'local' }, { dir: data, source: 'local' }, { dir: hub, source: 'huggingface' }, { dir: ext, source: 'local' }];
    return { t, models, data, hub, ext, roots, ornith, swift, flash, cleanup: () => fs.rmSync(t, { recursive: true, force: true }) };
}

test('split names: hidden parts, display name, part paths', () => {
    assert.equal(S.isHiddenSplitPart('X-Q2_K_XL-00001-of-00003.gguf'), false);
    assert.equal(S.isHiddenSplitPart('X-Q2_K_XL-00002-of-00003.gguf'), true);
    assert.equal(S.isHiddenSplitPart('X-Q2_K_XL.gguf'), false);
    assert.equal(S.displayName('Qwen3.8-Flash-Next-UD-Q2_K_XL-00001-of-00003.gguf'), 'Qwen3.8-Flash-Next-UD-Q2_K_XL.gguf');
    assert.equal(S.displayName('Qwen3.8-27B-UD-Q4_K_XL.gguf'), 'Qwen3.8-27B-UD-Q4_K_XL.gguf');
    assert.deepEqual(S.splitInfo('/a/X-00001-of-00003.gguf'), { part: 1, total: 3 });
    assert.equal(S.splitInfo('/a/X.gguf'), null);
    assert.deepEqual(S.partPaths('/a/X-00001-of-00002.gguf'), ['/a/X-00001-of-00002.gguf', '/a/X-00002-of-00002.gguf']);
    assert.deepEqual(S.partPaths('/a/X.gguf'), ['/a/X.gguf']);
});

test('scan: every root is walked, a model only in /data/models (no symlink) is listed', async () => {
    const f = fixture();
    try {
        const out = await S.scanModelDirs(f.roots);
        const names = out.map((m) => m.name);
        assert.ok(names.includes('Ornith-1.5-35B-Q4_K_M.gguf'), names.join(', '));
        const ornith = out.find((m) => m.name === 'Ornith-1.5-35B-Q4_K_M.gguf');
        assert.equal(ornith.path, f.ornith);
        assert.equal(ornith.source, 'local');
        assert.equal(out.find((m) => m.name === 'Qwen3.8-27B-UD-Q4_K_XL.gguf').source, 'huggingface');
        // the external drive's own model is found, dot-dirs and dangling links are not
        assert.ok(names.includes('Qwen3.8-Flash-Next-UD-IQ1_S.gguf'));
        assert.ok(!names.includes('stale.gguf'));
        assert.ok(!names.includes('dangling.gguf'));
    } finally { f.cleanup(); }
});

test('scan: a split model is one entry at part 1\'s path, named without the suffix, sized over all parts', async () => {
    const f = fixture();
    try {
        const out = await S.scanModelDirs(f.roots);
        const flash = out.filter((m) => /Q2_K_XL/.test(m.name));
        assert.equal(flash.length, 1, 'one entry: no part 2/3, no second path, no copy');
        const m = flash[0];
        assert.equal(m.name, 'Qwen3.8-Flash-Next-UD-Q2_K_XL.gguf');
        assert.equal(m.file, 'Qwen3.8-Flash-Next-UD-Q2_K_XL-00001-of-00003.gguf');
        assert.equal(m.path, path.join(f.models, m.file), 'the models/ symlink path, the one profiles saved');
        assert.equal(m.bytes, 11 + 5000 + 3000);
        assert.equal(m.parts, 3);
        assert.equal(m.size, (8011 / 2 ** 30).toFixed(2));
        assert.ok(!out.some((x) => /-0000[23]-of-/.test(x.file)));
        // the /data/models original and the external copy both collapse into it
        assert.ok(m.aliases.includes(f.flash[0]));
        assert.ok(m.aliases.includes(path.join(f.ext, 'Flash', 'UD-Q2_K_XL', m.file)));
    } finally { f.cleanup(); }
});

test('scan: a file reached through a symlink and directly is listed once, first root wins', async () => {
    const f = fixture();
    try {
        const out = await S.scanModelDirs(f.roots);
        const swift = out.filter((m) => m.name === 'Swift-Qwen3.8-27B-Q4_K_L.gguf');
        assert.equal(swift.length, 1);
        assert.equal(swift[0].path, path.join(f.models, 'Swift-Qwen3.8-27B-Q4_K_L.gguf'));
        assert.equal(swift[0].realPath, fs.realpathSync(f.swift));
        assert.deepEqual(swift[0].aliases, [f.swift]);
        assert.equal(swift[0].bytes, 1900);
        // no path is listed twice anywhere
        assert.equal(new Set(out.map((m) => m.path)).size, out.length);
    } finally { f.cleanup(); }
});

test('scan: mmproj files are not deduped (each HF snapshot keeps its own path for lib/mmproj.js)', async () => {
    const f = fixture();
    try {
        const out = await S.scanModelDirs(f.roots);
        assert.equal(out.filter((m) => m.name === 'mmproj-F16.gguf').length, 2);
    } finally { f.cleanup(); }
});

test('scan: a missing split part under-counts and is reported, not dropped', async () => {
    const f = fixture();
    try {
        fs.rmSync(path.join(f.ext, 'Flash', 'UD-IQ1_S', 'Qwen3.8-Flash-Next-UD-IQ1_S-00003-of-00003.gguf'));
        const m = (await S.scanModelDirs(f.roots)).find((x) => x.name === 'Qwen3.8-Flash-Next-UD-IQ1_S.gguf');
        assert.equal(m.bytes, 4011);
        assert.deepEqual(m.missingParts, ['Qwen3.8-Flash-Next-UD-IQ1_S-00003-of-00003.gguf']);
    } finally { f.cleanup(); }
});

test('scan: symlinked directories are followed, symlink loops and missing roots are harmless', async () => {
    const f = fixture();
    try {
        const extra = path.join(f.t, 'linked');
        fs.mkdirSync(extra);
        fs.symlinkSync(path.join(f.data, 'Ornith-1.5-35B-A3B'), path.join(extra, 'ornith-dir'));
        fs.symlinkSync(extra, path.join(extra, 'loop'));
        const out = await S.scanModelDirs([{ dir: extra }, { dir: path.join(f.t, 'nope') }]);
        assert.deepEqual(out.map((m) => m.name), ['Ornith-1.5-35B-Q4_K_M.gguf']);
        assert.equal(out[0].path, path.join(extra, 'ornith-dir', 'Ornith-1.5-35B-Q4_K_M.gguf'));
        assert.deepEqual(await S.scanModelDirs([]), []);
    } finally { f.cleanup(); }
});

test('fillDiskBytes: fills only local models with no size, by catalog key, without touching the input', () => {
    const { canonicalModel } = require('../lib/models');
    const keyOf = (p) => canonicalModel(p).key;
    const catalog = { models: [
        { key: 'local:qwen3.8-flash-next:iq1-s', provider: 'local', diskBytes: null },
        { key: 'local:qwen3.8-flash-next:q2-k-xl', provider: 'local', diskBytes: 123 },
        { key: 'local:qwen3.8-27b:q8-0', provider: 'local', diskBytes: null },
        { key: 'cloud:x', provider: 'cloud', diskBytes: null },
    ], other: 1 };
    const scanned = [
        { path: '/ext/Qwen3.8-Flash-Next-UD-IQ1_S-00001-of-00003.gguf', file: 'Qwen3.8-Flash-Next-UD-IQ1_S-00001-of-00003.gguf', bytes: 6011 },
        { path: '/m/Qwen3.8-Flash-Next-UD-Q2_K_XL-00001-of-00003.gguf', file: 'Qwen3.8-Flash-Next-UD-Q2_K_XL-00001-of-00003.gguf', bytes: 999 },
    ];
    const out = S.fillDiskBytes(catalog, scanned, keyOf);
    assert.deepEqual(out.models.map((m) => m.diskBytes), [6011, 123, null, null]);
    assert.equal(out.other, 1);
    assert.equal(catalog.models[0].diskBytes, null, 'input not mutated');
    assert.equal(S.fillDiskBytes(catalog, [], keyOf), catalog, 'nothing to fill: same object');
    assert.equal(S.fillDiskBytes({ error: 'x' }, scanned, keyOf).error, 'x');
});

test('the picker\'s gguf key reads the part-1 path the scan lists, same as the catalog\'s', async () => {
    const { ggufModelKey } = await import('../ui/modelpicker/rank.js');
    const { canonicalModel } = require('../lib/models');
    for (const p of ['/m/Qwen3.8-Flash-Next-UD-Q2_K_XL-00001-of-00003.gguf', '/data/models/Ornith-1.5-35B-A3B/Ornith-1.5-35B-Q4_K_M.gguf']) {
        assert.equal(ggufModelKey(p), canonicalModel(p).key, p);
    }
    assert.equal(ggufModelKey('/data/models/Ornith-1.5-35B-A3B/Ornith-1.5-35B-Q4_K_M.gguf'), 'local:ornith-1.5-35b:q4-k-m');
});

test('scan: every entry carries its kind, and only models are launchable', async () => {
    const f = fixture();
    try {
        const mk = (p, bytes) => { fs.writeFileSync(p, ''); fs.truncateSync(p, bytes); };
        mk(path.join(f.models, 'qwen-3.8-unsloth-3.0-chat-template.gguf'), 9994);
        mk(path.join(f.models, 'mtp-Qwen3.8-Flash-Next-Q8_0.gguf'), 400);
        const out = await S.scanModelDirs(f.roots);
        const kind = (n) => (out.find((m) => m.name === n) || {}).kind;
        // (the fixture's files are tiny, so the size rule would call them all 'other'; kinds by name here)
        assert.equal(kind('mmproj-F16.gguf'), 'mmproj');
        assert.equal(kind('mtp-Qwen3.8-Flash-Next-Q8_0.gguf'), 'draft');
        assert.equal(kind('qwen-3.8-unsloth-3.0-chat-template.gguf'), 'other');
        assert.ok(out.every((m) => ['model', 'mmproj', 'draft', 'other'].includes(m.kind)));
    } finally { f.cleanup(); }
});
