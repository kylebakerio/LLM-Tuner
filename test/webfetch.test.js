'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const W = require('../lib/webfetch');

test('isPublicAddress: LAN, loopback, link-local, CGNAT and IPv6 private ranges are refused', () => {
    for (const ip of ['127.0.0.1', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.1.125', '169.254.61.173',
        '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', '::', 'fd12::1', 'fe80::1', '::ffff:192.168.1.1', 'not-an-ip']) {
        assert.equal(W.isPublicAddress(ip), false, ip);
    }
    for (const ip of ['1.1.1.1', '98.97.107.80', '172.32.0.1', '2606:4700::6810:84e5', '::ffff:8.8.8.8']) {
        assert.equal(W.isPublicAddress(ip), true, ip);
    }
});

test('fetchPage refuses private targets and non-web urls before connecting', async () => {
    await assert.rejects(W.fetchPage('http://127.0.0.1:3000/api/status'), /blocked/);
    await assert.rejects(W.fetchPage('http://192.168.1.125:22/'), /blocked/);
    await assert.rejects(W.fetchPage('http://localhost:8080/slots'), /blocked/);
    await assert.rejects(W.fetchPage('http://[::1]/'), /blocked/);
    await assert.rejects(W.fetchPage('file:///etc/passwd'), /unsupported protocol/);
    await assert.rejects(W.fetchPage('https://user:pw@example.com/'), /credentials/);
    await assert.rejects(W.fetchPage('not a url'), /invalid url/);
});

test('htmlToMarkdown: the article, as markdown, without page chrome', () => {
    const para = 'Qwen3.8-Flash-Next is a mixture-of-experts model with about three billion active parameters per token. ';
    const html = `<!doctype html><html><head><title>Qwen3.8 Flash Next quants</title><style>body{}</style></head><body>
        <nav><a href="/">Home</a> <a href="/models">Models</a></nav>
        <article><h1>Qwen3.8 Flash Next quants</h1>
          <p>${para.repeat(4)}</p>
          <p><a href="https://example.com/full.png"><img src="https://example.com/thumb.png" alt=""></a></p>
          <h2><a href="#sizes"></a>Sizes</h2>
          <ul><li>UD-Q4_K_XL: 45 GB</li><li>UD-Q2_K_XL: 28 GB</li></ul>
          <p>See <a href="https://huggingface.co/unsloth">the repo</a> for the full list. ${para}</p>
        </article>
        <footer>Cookie settings</footer><script>track()</script></body></html>`;
    const { title, markdown } = W.htmlToMarkdown(html);
    assert.equal(title, 'Qwen3.8 Flash Next quants');
    assert.match(markdown, /## Sizes/);
    assert.match(markdown, /-\s+UD-Q4_K_XL: 45 GB/);
    assert.match(markdown, /\[the repo\]\(https:\/\/huggingface\.co\/unsloth\)/);
    assert.doesNotMatch(markdown, /track\(\)|Cookie settings|body\{\}/);
    assert.doesNotMatch(markdown, /thumb\.png|full\.png|\]\(#sizes\)/);
});

test('htmlToMarkdown: a page with no article falls back to the body text', () => {
    const { markdown } = W.htmlToMarkdown('<html><body><h3>Results</h3><p>Only a short line.</p></body></html>');
    assert.match(markdown, /### Results/);
    assert.match(markdown, /Only a short line\./);
});
