'use strict';
// The KBIO icon on both sites (2026-10-22, Kyle: "let's add a favicon to both sites that has the letters KBIO in a 2x2
// grid"). The set is made in experiment-1/favicon-kbio/ (make.py) and copied, unchanged, to each site's asset spot:
// the dashboard's own dir (server4.js's static route) and public/assets/ (public/server.js's allowlist, at the root).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const DASH = path.join(__dirname, '..');
const ICONS = ['favicon.ico', 'favicon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'];
const LINKS = [/<link rel="icon" href="\/favicon\.ico" sizes="16x16 32x32 48x48">/, /<link rel="icon" href="\/favicon\.svg" type="image\/svg\+xml">/, /<link rel="apple-touch-icon" href="\/apple-touch-icon\.png">/];

test('both sites carry the same five files, byte for byte the source set', () => {
    const src = path.join(DASH, '..', 'favicon-kbio');
    for (const f of ICONS) {
        const a = fs.readFileSync(path.join(DASH, f)), b = fs.readFileSync(path.join(DASH, 'public', 'assets', f));
        assert.ok(a.equals(b), f);
        if (fs.existsSync(path.join(src, f))) assert.ok(a.equals(fs.readFileSync(path.join(src, f))), `${f} is the source file`);
    }
});

test('every HTML entry point links them', async () => {
    for (const page of ['index.html', path.join('ui', 'posts', 'index.html')]) {
        const html = fs.readFileSync(path.join(DASH, page), 'utf8');
        for (const re of LINKS) assert.match(html, re, page);
    }
    const server = fs.readFileSync(path.join(DASH, 'server4.js'), 'utf8');
    const gate = server.slice(server.indexOf('const TUNNEL_GATE_PAGE'), server.indexOf('</html>`;', server.indexOf('const TUNNEL_GATE_PAGE')));
    for (const re of LINKS) assert.match(gate, re, 'the tunnel gate page');
    const posts = require('../public/posts');
    const shell = await posts.shell({ path: '/' });
    for (const re of LINKS) assert.match(shell, re, 'the public page shell (every section, post and the 404)');
    for (const re of LINKS) assert.match(posts.previewHtml({ title: 't', date: '', tags: [], body: 'x', draft: true }), re, 'the editor preview');
});

test('the servers answer a plain /favicon.ico: the dashboard before its gate, the public site from its allowlist', () => {
    const server = fs.readFileSync(path.join(DASH, 'server4.js'), 'utf8');
    assert.match(server, /const SITE_ICONS = new Set\(\['\/favicon\.ico', '\/favicon\.svg', '\/apple-touch-icon\.png', '\/icon-192\.png', '\/icon-512\.png'\]\)/);
    assert.match(server, /!tunnelAuthenticated\(req\) && !\(req\.method === 'GET' && SITE_ICONS\.has\(req\.url\.split\('\?'\)\[0\]\)\)/);
    for (const f of ICONS) assert.match(`/${f}`, /^\/(?:vendor\/)?[\w.-]+\.(js|css|map|ico|png|svg)$/, `${f}: the dashboard's static route serves it`);
    const pub = fs.readFileSync(path.join(DASH, 'public', 'server.js'), 'utf8');
    assert.match(pub, /const SITE_ICONS = \['favicon\.ico', 'favicon\.svg', 'apple-touch-icon\.png', 'icon-192\.png', 'icon-512\.png'\]/);
    assert.match(pub, /\.\.\.SITE_ICONS\.map\(\(f\) => \['\/' \+ f, path\.join\(SITE, 'assets', f\)\]\)/);
    assert.match(pub, /'\.ico': 'image\/x-icon', '\.png': 'image\/png', '\.svg': 'image\/svg\+xml'/);
    assert.deepEqual(require('../public/staticsite').ICON_FILES.map(([n]) => n), ICONS, 'the static build writes them at its root');
});
