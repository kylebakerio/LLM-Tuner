'use strict';
// lib/assets.js: the dashboard's JS/CSS under /v/<hash>/ (2026-10-06). The property that matters: a URL under a hash
// has exactly one possible body, so "immutable" can never serve a stale script.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { createAssets } = require('../lib/assets');

function tree(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'assets-test-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const put = (rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
    put('script.js', 'console.log(1)');
    put('vendor/chart.js', 'chart');
    put('vendor/tailwind.css', 'body{}');
    put('ui/models/index.js', "import '../shared/x.js'");
    put('ui/shared/x.js', 'export const x = 1');
    put('ui/shared/x.js.bak-old', 'old');          // backups are not assets
    put('server4.js', 'secret');                   // nor is anything else at the root
    put('ui/shared/deep/y.js', 'no');              // nor a third level
    return { root, put };
}

test('the set is script.js, vendor/*, ui/<dir>/*; the hash covers their bytes', (t) => {
    const { root, put } = tree(t);
    const A = createAssets(root);
    const s = A.snapshot();
    assert.match(s.hash, /^[0-9a-f]{12}$/);
    for (const p of ['/script.js', '/vendor/chart.js', '/vendor/tailwind.css', '/ui/models/index.js', '/ui/shared/x.js']) assert.ok(s.has(p), p);
    for (const p of ['/server4.js', '/ui/shared/x.js.bak-old', '/ui/shared/deep/y.js', '/../etc/passwd']) assert.ok(!s.has(p), p);
    assert.equal(A.snapshot().hash, s.hash, 'stable while nothing changes');
    // an edit to ANY file, however deep in the import graph, is a new hash
    put('ui/shared/x.js', 'export const x = 2');
    const h2 = A.snapshot().hash;
    assert.notEqual(h2, s.hash);
    // a new file and a removed file too
    put('ui/shared/z.js', 'z');
    const h3 = A.snapshot().hash;
    assert.notEqual(h3, h2);
    fs.rmSync(path.join(root, 'ui/shared/z.js'));
    assert.equal(A.snapshot().hash, h2, 'back to the same bytes, back to the same hash');
});

test('a body is served under a hash only while that hash is current: one URL, one body', (t) => {
    const { root, put } = tree(t);
    const A = createAssets(root);
    const h1 = A.snapshot().hash;
    assert.equal(A.versioned(h1, '/script.js').body.toString(), 'console.log(1)');
    assert.equal(A.versioned(h1, '/ui/shared/x.js').type, 'application/javascript');
    assert.equal(A.versioned(h1, '/vendor/tailwind.css').type, 'text/css');
    assert.equal(A.versioned(h1, '/server4.js'), null, 'not in the set, whatever the hash');
    assert.equal(A.versioned('000000000000', '/script.js'), null);
    put('script.js', 'console.log(2) // changed');
    // the old URL is never answered with the new bytes (the server falls back to an uncached answer)
    assert.equal(A.versioned(h1, '/script.js'), null);
    assert.equal(A.versioned(h1, '/ui/shared/x.js'), null, 'nor is any other file under the old hash');
    const h2 = A.snapshot().hash;
    assert.equal(A.versioned(h2, '/script.js').body.toString(), 'console.log(2) // changed');
});

test('a same-size edit is seen (mtime), and the compressed forms belong to the version they were made from', async (t) => {
    const { root, put } = tree(t);
    const A = createAssets(root);
    const h1 = A.snapshot().hash;
    const e1 = A.versioned(h1, '/ui/shared/x.js');
    assert.equal(zlib.brotliDecompressSync(await A.encoded(e1, 'br')).toString(), 'export const x = 1');
    assert.equal(A.encoded(e1, 'br'), A.encoded(e1, 'br'), 'compressed once');
    put('ui/shared/x.js', 'export const x = 7');
    const later = new Date(Date.now() + 3000); fs.utimesSync(path.join(root, 'ui/shared/x.js'), later, later);
    const h2 = A.snapshot().hash;
    assert.notEqual(h2, h1);
    const e2 = A.versioned(h2, '/ui/shared/x.js');
    assert.equal(zlib.gunzipSync(await A.encoded(e2, 'gzip')).toString(), 'export const x = 7');
    assert.equal(zlib.brotliDecompressSync(await A.encoded(e2, 'br')).toString(), 'export const x = 7');
});

test('versionHtml: local ./x.js|css in the set move under /v/<hash>/; everything else is left as written', (t) => {
    const { root } = tree(t);
    const A = createAssets(root);
    const h = A.snapshot().hash;
    const html = '<link rel="stylesheet" href="./vendor/tailwind.css"><script src="./script.js"></script>'
        + '<script type="module" src="./ui/models/index.js"></script><script src="./nope.js"></script><a href="https://x.test/a.js">x</a><script src="/vendor/chart.js"></script>';
    assert.equal(A.versionHtml(html), `<link rel="stylesheet" href="/v/${h}/vendor/tailwind.css"><script src="/v/${h}/script.js"></script>`
        + `<script type="module" src="/v/${h}/ui/models/index.js"></script><script src="./nope.js"></script><a href="https://x.test/a.js">x</a><script src="/vendor/chart.js"></script>`);
});
