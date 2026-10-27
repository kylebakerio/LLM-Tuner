#!/usr/bin/env node
// Build the static copy of the public site (2026-10-06). See STATIC-ARCHITECTURE.md.
//
//   node public/build-static.js [--out DIR] [--target pages|netlify] [--source URL] [--live-origin URL] [--no-analytics] [--quiet]
//
// Writes a self-contained site into public/dist-static/: every page as HTML, the assets under /v/<content hash>/,
// the published posts, a snapshot of the public data as JSON, and the host's rules. The target is Cloudflare
// (`pages`: _redirects and _headers inside the output, which Workers static assets read too -- the deploy is a Worker
// since 2026-10-22, public/wrangler.jsonc); --target netlify writes a netlify.toml beside the output instead.
// Nothing is deployed and nothing else is written.
//
// Data comes from the RUNNING public server (pm2 `public`, 127.0.0.1:3100) over HTTP: the exact JSON the public
// site already serves, already through lib/publicdata.js, from that process's caches -- so a build reads no
// database and no request log, and costs the benchmarks nothing. If the server is down the build fails and the
// last build (and the last deploy) stay as they are, which is the behaviour we want.
// Posts come from the local clone through public/posts.js, which only ever returns `draft: false` posts.
//
// The build FAILS, leaving the previous output untouched, if: a module import would 404, a draft shows up
// anywhere, the data is not already scrubbed, or a private-looking string is in any output file.

'use strict';
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');

const S = require('./staticsite');

const SITE = __dirname;
const DASH = path.join(SITE, '..');

function parseArgs(argv) {
    const a = { out: path.join(SITE, 'dist-static'), source: process.env.STATIC_SOURCE || `http://127.0.0.1:${process.env.PUBLIC_PORT || 3100}`, liveOrigin: process.env.STATIC_LIVE_ORIGIN || null, quiet: false };
    for (let i = 0; i < argv.length; i++) {
        const [k, inline] = argv[i].split(/=(.*)/s);
        const val = () => (inline !== undefined ? inline : argv[++i]);
        if (k === '--out') a.out = path.resolve(val());
        else if (k === '--source') a.source = val();
        else if (k === '--live-origin') a.liveOrigin = val();
        else if (k === '--quiet') a.quiet = true;
        else if (k === '--target') { a.target = val(); if (a.target !== 'pages' && a.target !== 'netlify') throw new Error('--target is pages or netlify'); }
        else if (k === '--rules') { a.rules = val(); if (a.rules !== 'toml' && a.rules !== 'files') throw new Error('--rules is toml or files'); }
        else if (k === '--no-analytics') a.analytics = false;      // for local previews: no Google tag in the pages
        else if (k === '--help' || k === '-h') a.help = true;
        else throw new Error(`unknown argument: ${argv[i]}`);
    }
    a.source = String(a.source).replace(/\/+$/, '');
    return a;
}

async function getText(url, timeoutMs = 60000) {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) throw new Error(`${url} -> HTTP ${r.status}`);
    return r.text();
}

/** Run `fn` over `items`, `n` at a time. */
async function pool(items, n, fn) {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (next < items.length) { const i = next++; out[i] = await fn(items[i], i); } }));
    return out;
}

// site.config.local.json (2026-10-27, pre-push sweep): values that stay out of the public repo -- the account's
// workers.dev subdomain is built from its e-mail address -- live in public/site.config.local.json, which is gitignored,
// and are merged over site.config.json key by key. No file: site.config.json alone, as before. A file that is not a
// JSON object fails the build (the last build and deploy stay), rather than quietly dropping its rules.
const LOCAL_CONFIG = path.join(SITE, 'site.config.local.json');
function withLocalConfig(cfg, file = LOCAL_CONFIG) {
    let text;
    try { text = fs.readFileSync(file, 'utf8'); } catch { return { ...cfg }; }
    let local;
    try { local = JSON.parse(text); } catch (e) { throw new Error(`${path.basename(file)}: ${e.message}`); }
    if (!local || typeof local !== 'object' || Array.isArray(local)) throw new Error(`${path.basename(file)}: not a JSON object`);
    return { ...cfg, ...local };
}

/** Every post file in the clone with its draft flag -- an independent read, to check posts.js against. */
async function allPosts(postsLib, dir) {
    let names = [];
    try { names = (await fsp.readdir(dir)).filter((f) => f.endsWith('.md')); } catch { /* no clone */ }
    const out = [];
    for (const f of names) {
        let data = {};
        try { data = postsLib.parseFrontMatter(await fsp.readFile(path.join(dir, f), 'utf8')).data; } catch { /* unreadable = not published */ }
        out.push({ slug: f.replace(/\.md$/, ''), title: data.title || '', draft: data.draft !== false });
    }
    return out;
}

async function build(opts) {
    const log = opts.quiet ? () => {} : (...x) => console.log(...x);
    const t0 = Date.now();
    const postsLib = require('./posts');
    const { sanitizePayload } = require(path.join(DASH, 'lib', 'publicdata'));
    const cfg = withLocalConfig(postsLib.siteConfig());
    const liveOrigin = String(opts.liveOrigin || cfg.liveOrigin || 'https://live.kylebaker.io').replace(/\/+$/, '');
    const analytics = opts.analytics !== false && !!cfg.gaMeasurementId;
    const postsDir = process.env.POSTS_DIR || path.join(os.homedir(), 'code', 'ai-lab-posts', 'posts');
    const files = new Map();   // output path -> Buffer | string
    const put = (name, body) => { if (files.has(name)) throw new Error(`two outputs for ${name}`); files.set(name, body); };

    // ---- assets, under one content hash
    const assets = [];
    for (const [urlPath, rel] of S.ASSET_FILES) assets.push([urlPath, await fsp.readFile(path.join(DASH, rel))]);
    const missing = S.missingImports(Object.fromEntries(assets.filter(([k]) => k.endsWith('.js')).map(([k, b]) => [k, b.toString('utf8')])));
    if (missing.length) throw new Error('imports that are not in the build:\n' + missing.map((m) => `  ${m.from} imports ${m.spec} (${m.target})`).join('\n'));
    const hash = S.assetHash(assets);
    for (const [urlPath, body] of assets) put(`v/${hash}/${urlPath}`, body);
    for (const [name, rel] of S.ICON_FILES) put(name, await fsp.readFile(path.join(DASH, rel)));   // the icons, at the root

    // ---- posts: published only, checked two ways
    const every = await allPosts(postsLib, postsDir);
    const index = await postsLib.index();
    const viaFlag = S.publishedOnly(every).map((p) => p.slug).sort();
    const viaLib = index.map((p) => p.slug).sort();
    if (JSON.stringify(viaFlag) !== JSON.stringify(viaLib)) throw new Error(`posts.js and the front matter disagree about what is published: ${JSON.stringify(viaLib)} vs ${JSON.stringify(viaFlag)}`);

    // ---- pages
    const postHtml = [];
    for (const r of S.routeFiles(every)) {
        if (r.kind === 'section') put(r.file, S.staticPage(await postsLib.shell({ path: r.route, title: r.title }), { hash, liveOrigin, analytics }));
        else if (r.kind === 'post') {
            const html = await postsLib.postPage(r.slug);
            if (!html) throw new Error(`post ${r.slug} is published but has no page`);
            postHtml.push(html);
            put(r.file, S.staticPage(html, { hash, staticMode: false, analytics }));    // a post page shows no lab data: no probe, no snapshot
        } else if (r.kind === 'notfound') put(r.file, S.staticPage(await postsLib.notFound(), { hash, staticMode: false, analytics }));
        else if (r.kind === 'feed') put(r.file, await postsLib.feed());
        else if (r.kind === 'robots') put(r.file, 'User-agent: *\nAllow: /\n');
    }
    for (const img of S.referencedImages(postHtml)) {
        try { put(`blog-images/${img}`, await fsp.readFile(path.join(postsDir, '..', 'images', img))); } catch { log(`  (image ${img} is referenced by a post but missing)`); }
    }

    // ---- data snapshot, from the running public server
    // The server answers from its cache and rebuilds in the background when the cached value is old (catalog 3 min,
    // a model record 1 min), so on a quiet site the FIRST answer can be hours stale. Ask once to start the rebuilds,
    // then read: the catalog until its stamp is recent, the model records on a second pass.
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const FRESH_MS = 240000;
    let catalogText = await getText(`${opts.source}/api/models/catalog`).catch((e) => { throw new Error(`cannot read the public server (${e.message}). Is pm2 \`public\` running? The previous build is untouched.`); });
    let catalog = JSON.parse(catalogText);
    const primed = Date.now() - (catalog.generatedAt || 0) > FRESH_MS;
    if (primed) await pool((catalog.models || []).map((m) => m.key), 4, (key) => getText(`${opts.source}/api/model?key=${encodeURIComponent(key)}`).catch(() => null));
    for (let i = 0; i < 10 && Date.now() - (catalog.generatedAt || 0) > FRESH_MS; i++) {
        await sleep(3000);
        catalogText = await getText(`${opts.source}/api/models/catalog`);
        catalog = JSON.parse(catalogText);
    }
    if (Date.now() - (catalog.generatedAt || 0) > FRESH_MS) log(`  (the server's catalog is ${Math.round((Date.now() - catalog.generatedAt) / 60000)} min old and did not refresh: building from it anyway)`);
    const scrubbed = (name, obj) => { if (JSON.stringify(sanitizePayload(obj)) !== JSON.stringify(obj)) throw new Error(`${name}: lib/publicdata.js would change this payload -- the source is not serving scrubbed data`); };
    scrubbed('catalog', catalog);
    put('data/catalog.json', catalogText);
    const keys = (catalog.models || []).map((m) => m.key);
    const details = await pool(keys, 4, async (key) => {
        const text = await getText(`${opts.source}/api/model?key=${encodeURIComponent(key)}`);
        scrubbed(`model ${key}`, JSON.parse(text));
        return text;
    });
    keys.forEach((key, i) => put(S.modelFile(key), details[i]));
    let live = null;
    for (let i = 0; i < 3 && !(live && !live.stale); i++) {     // the dashboard only writes live status while someone asks: ask, wait, ask again
        if (i) await new Promise((r) => setTimeout(r, 3500));
        try { live = JSON.parse(await getText(`${opts.source}/api/live`, 10000)); } catch { live = null; }
    }
    scrubbed('live', live || {});
    const builtAt = Date.now();
    const manifest = S.snapshotManifest({ builtAt, catalog, posts: index, live: live && !live.stale ? live : null, modelKeys: keys });
    put('snapshot.json', JSON.stringify(manifest));
    manifest.contentHash = S.contentHash([...files]);
    files.set('snapshot.json', JSON.stringify(manifest));

    // ---- host rules. Cloudflare Pages (the default target) reads them from _redirects and _headers in the publish
    // directory; Netlify from netlify.toml (below), or from the same two files with --rules files -- never both.
    const target = opts.target || 'pages';
    const rulesAsFiles = target === 'pages' || opts.rules === 'files';
    if (rulesAsFiles) {
        put('_redirects', S.redirectsFile(every, target));
        // the Worker's own name, <pagesProject>.<workersSubdomain>.workers.dev (site.config.json), is marked noindex
        const okName = (x) => /^[a-z0-9-]+$/.test(x || '');
        put('_headers', S.headersFile({ ga: analytics, liveOrigin, posts: every, noindexHost: target === 'pages' && okName(cfg.pagesProject) && okName(cfg.workersSubdomain) ? `${cfg.pagesProject}.${cfg.workersSubdomain}.workers.dev` : '' }));
    }
    if (target === 'pages') {
        const over = S.pagesLimitProblems([...files].map(([name, body]) => [name, Buffer.byteLength(body)]), { headers: files.get('_headers'), redirects: files.get('_redirects') });
        if (over.length) throw new Error('over a Cloudflare limit:\n  ' + over.join('\n  '));
    }

    // ---- gates
    const texts = {};
    for (const [name, body] of files) if (/\.(html|xml|json|js|css|txt)$/.test(name) || name === '_headers' || name === '_redirects') texts[name] = Buffer.isBuffer(body) ? body.toString('utf8') : body;
    const drafts = S.draftLeaks(every, texts);
    if (drafts.length) throw new Error('a draft would be published:\n  ' + drafts.join('\n  '));
    // The lab's API origin is in every section page on purpose (and in production is a public host name); a preview
    // build may point it at a private address, so that one string is not what the scan is looking for.
    const leaks = Object.entries(texts).flatMap(([name, text]) => S.leakScan(name, name.endsWith('.html') || name === '_headers' ? text.split(liveOrigin).join('') : text, { isData: name.endsWith('.json') }));
    if (leaks.length) throw new Error('private-looking strings in the build:\n' + leaks.map((l) => `  ${l.file}: ${l.what}: …${l.sample}…`).join('\n'));

    // ---- write: a fresh directory, swapped in whole (a failed build never leaves half a site to deploy)
    const out = opts.out;
    const tmp = `${out}.tmp-${process.pid}`;
    await fsp.rm(tmp, { recursive: true, force: true });
    let bytes = 0;
    for (const [name, body] of files) {
        const f = path.join(tmp, name);
        await fsp.mkdir(path.dirname(f), { recursive: true });
        await fsp.writeFile(f, body);
        bytes += Buffer.byteLength(body);
    }
    const old = `${out}.old-${process.pid}`;
    if (fs.existsSync(out)) await fsp.rename(out, old);
    await fsp.rename(tmp, out);
    await fsp.rm(old, { recursive: true, force: true });

    // Netlify only: netlify.toml sits beside the output (the directory deploys are run from). `publish` is resolved
    // by Netlify against the repository root when there is one, so write it relative to that; deploys pass --dir anyway.
    if (target === 'netlify') {
        const tomlDir = path.dirname(out);
        let repoRoot = tomlDir;
        for (let d = tomlDir; ; d = path.dirname(d)) { if (fs.existsSync(path.join(d, '.git'))) { repoRoot = d; break; } if (path.dirname(d) === d) break; }
        const toml = S.netlifyToml({ publishDir: path.relative(repoRoot, out) || '.', ga: analytics, liveOrigin, posts: every, rules: !rulesAsFiles });
        await fsp.writeFile(path.join(tomlDir, 'netlify.toml'), toml);
    }

    const summary = {
        out, target, files: files.size, bytes, assetHash: hash, contentHash: manifest.contentHash, builtAt, generatedAt: manifest.generatedAt,
        liveOrigin, source: opts.source, models: keys.length, postsPublished: viaLib.length, postsDraft: every.length - viaLib.length,
        liveRecord: manifest.live ? manifest.live.running.length : null, stats: manifest.stats, ms: Date.now() - t0,
    };
    log(`static site (${target === 'pages' ? 'Cloudflare' : 'Netlify'}): ${summary.files} files, ${(bytes / 1048576).toFixed(1)} MB -> ${out}`);
    log(`  assets /v/${hash}/   data as of ${new Date(manifest.generatedAt).toISOString()}   content ${manifest.contentHash}`);
    log(`  ${keys.length} models, ${viaLib.length} published posts (${summary.postsDraft} drafts left out), lab API ${liveOrigin}`);
    log(`  gates passed: imports resolve, no drafts, data already scrubbed, no private strings${target === 'pages' ? ', within Cloudflare limits' : ''}   (${summary.ms} ms)`);
    return summary;
}

module.exports = { build, parseArgs, withLocalConfig };

if (require.main === module) {
    let opts;
    try { opts = parseArgs(process.argv.slice(2)); } catch (e) { console.error(e.message); process.exit(2); }
    if (opts.help) { console.log('node public/build-static.js [--out DIR] [--source http://127.0.0.1:3100] [--target pages|netlify] [--live-origin https://live.kylebaker.io] [--no-analytics] [--quiet]   (netlify also takes --rules toml|files)'); process.exit(0); }
    build(opts).catch((e) => { console.error(`build-static: FAILED -- ${e.message}`); process.exit(1); });
}
