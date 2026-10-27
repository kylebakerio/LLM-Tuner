#!/usr/bin/env node
// Serve a static build locally, the way the host will (2026-10-06). See STATIC-ARCHITECTURE.md, "Local preview".
//
//   node public/preview-static.js [--dir public/dist-static] [--port 4173] [--host 127.0.0.1] [--target pages|netlify] [--live-origin URL]
//
// Read-only, 127.0.0.1 unless --host says otherwise. A dependency-free MODEL of the host: it applies the redirect and
// header rules that build-static.js writes (public/staticsite.js) with the host's page resolution, so pretty URLs,
// the CSP and the cache headers can be checked quickly on any Node. For Cloudflare the reference is its real asset
// server, which needs Node >= 22:  npx wrangler dev --port 4174   (run in public/; wrangler.jsonc, since 2026-10-22).
// --live-origin must match what the build was given (it goes into the CSP's connect-src); by default it is read
// from the built index.html.

'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const S = require('./staticsite');

const args = process.argv.slice(2);
const arg = (name, dflt) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : dflt; };
const DIR = path.resolve(arg('--dir', path.join(__dirname, 'dist-static')));
const PORT = Number(arg('--port', process.env.PREVIEW_PORT || 4173));
const TARGET = arg('--target', 'pages');     // whose URL rules to imitate: pages (Cloudflare Pages) or netlify
const HOST = arg('--host', '127.0.0.1');   // loopback unless told otherwise (e.g. the tailnet address, to look from another machine)
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json',
    '.xml': 'application/rss+xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
    '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' };

if (!fs.existsSync(path.join(DIR, 'index.html'))) { console.error(`no build in ${DIR} -- run: node public/build-static.js`); process.exit(1); }
const indexHtml = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
const liveOrigin = arg('--live-origin', (/data-live-origin="([^"]*)"/.exec(indexHtml) || [])[1] || '');
const ga = /googletagmanager\.com/.test(indexHtml);
// the published posts are the pages in blog/
const posts = (fs.existsSync(path.join(DIR, 'blog')) ? fs.readdirSync(path.join(DIR, 'blog')) : []).filter((f) => f.endsWith('.html')).map((f) => ({ slug: f.replace(/\.html$/, ''), draft: false }));
const has = (f) => { const full = path.join(DIR, f); return full.startsWith(DIR + path.sep) && fs.existsSync(full) && fs.statSync(full).isFile(); };

http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); return res.end(); }
    let p;
    try { p = decodeURIComponent(new URL(req.url, 'http://x').pathname); } catch { res.writeHead(400); return res.end(); }
    const headers = S.headersFor(p, { ga, liveOrigin, posts });
    const r = S.resolveRequest(p, { posts, has, target: TARGET });
    if (r.location) { res.writeHead(r.status, { ...headers, Location: r.location }); return res.end(); }
    if (!r.file) { res.writeHead(404, headers); return res.end('Not found'); }
    const body = fs.readFileSync(path.join(DIR, r.file));
    if (r.status === 404) delete headers['Cache-Control'];
    res.writeHead(r.status, { 'Content-Type': TYPES[path.extname(r.file)] || 'application/octet-stream', 'Cache-Control': r.status === 404 ? 'no-store' : S.NO_CACHE, ...headers });   // the host's default, unless a rule says otherwise
    res.end(req.method === 'HEAD' ? undefined : body);
}).listen(PORT, HOST, () => console.log(`static preview: http://${HOST}:${PORT}  (dir ${DIR}, lab API ${liveOrigin || 'none'})`));
