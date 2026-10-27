// The static build of the public site (public/staticsite.js, public/build-static.js): which files a build writes,
// what the host is told to do with each URL, and the gates that keep drafts and private strings out. 2026-10-06.
// 2026-10-22: the host is a Cloudflare Worker with static assets (public/wrangler.jsonc), which reads the same
// _headers / _redirects as Pages and resolves URLs the same way (checked on `wrangler dev`).
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

// posts.js reads POSTS_DIR when it is first required: point it at a fixture before anything loads it.
const postsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'static-posts-'));
process.env.POSTS_DIR = postsDir;
fs.writeFileSync(path.join(postsDir, 'live-post.md'), '---\ntitle: "Live one"\ndate: "2026-10-01"\nsummary: "s"\ndraft: false\n---\n\nHello ![pic](/blog-images/shot.png)\n');
fs.writeFileSync(path.join(postsDir, 'secret-draft.md'), '---\ntitle: "SECRET DRAFT"\ndate: "2026-10-02"\ndraft: true\n---\n\nsecret body ![x](/blog-images/draft-only.png)\n');
fs.writeFileSync(path.join(postsDir, 'no-flag.md'), '---\ntitle: "NO FLAG"\ndate: "2026-10-02"\n---\n\nunflagged body\n');

const S = require('../public/staticsite');
const posts = require('../public/posts');

const ALL = [{ slug: 'live-post', title: 'Live one', draft: false }, { slug: 'secret-draft', title: 'SECRET DRAFT', draft: true }, { slug: 'no-flag', title: 'NO FLAG', draft: true }];

test('routes -> files: five section pages, published posts only, feed, robots, 404', () => {
    const files = S.routeFiles(ALL).map((r) => r.file);
    assert.deepEqual(files, ['index.html', 'results.html', 'writing.html', 'about.html', 'blog/live-post.html', '404.html', 'feed.xml', 'robots.txt']);
    assert.deepEqual(S.routeFiles([]).filter((r) => r.kind === 'post'), []);
    // a post without an explicit draft:false, or with a slug that is not a plain slug, is not routed
    assert.deepEqual(S.publishedOnly([{ slug: 'a' }, { slug: 'b', draft: true }, { slug: '../x', draft: false }, { slug: 'ok-1', draft: false }]).map((p) => p.slug), ['ok-1']);
});

test('Cloudflare Pages: every server route has a static answer (expectations read off `wrangler pages dev`)', () => {
    const built = new Set([...S.routeFiles(ALL).map((r) => r.file), 'snapshot.json', 'data/catalog.json', 'v/abc/assets/site.js', '_headers', '_redirects']);
    const at = (p) => S.resolveRequest(p, { posts: ALL, has: (f) => built.has(f) });
    assert.deepEqual(at('/'), { status: 200, file: 'index.html' });
    assert.deepEqual(at('/index.html'), { status: 308, location: '/' });                       // Pages: the clean URL is the only URL
    for (const s of ['results', 'writing', 'about']) {
        assert.deepEqual(at('/' + s), { status: 200, file: s + '.html' });                     // served by Pages itself, no rule
        assert.deepEqual(at(`/${s}.html`), { status: 308, location: '/' + s });
        assert.deepEqual(at(`/${s}/`), { status: 308, location: '/' + s });
    }
    assert.deepEqual(at('/models'), { status: 200, file: 'results.html' });                    // 200 rewrites: the address bar keeps /models/...
    assert.deepEqual(at('/models/'), { status: 200, file: 'results.html' });
    assert.deepEqual(at('/models/local:qwen/x'), { status: 200, file: 'results.html' });
    assert.deepEqual(at('/blog'), { status: 301, location: '/writing' });
    assert.deepEqual(at('/blog/'), { status: 301, location: '/writing' });                     // a Pages rule matches its path exactly: both are listed
    assert.deepEqual(at('/blog/live-post'), { status: 200, file: 'blog/live-post.html' });
    assert.deepEqual(at('/blog/live-post/'), { status: 308, location: '/blog/live-post' });
    assert.deepEqual(at('/blog/secret-draft'), { status: 404, file: '404.html' });
    assert.deepEqual(at('/blog/no-flag'), { status: 404, file: '404.html' });
    assert.deepEqual(at('/feed.xml'), { status: 200, file: 'feed.xml' });
    assert.deepEqual(at('/robots.txt'), { status: 200, file: 'robots.txt' });
    assert.deepEqual(at('/snapshot.json'), { status: 200, file: 'snapshot.json' });
    assert.deepEqual(at('/v/abc/assets/site.js'), { status: 200, file: 'v/abc/assets/site.js' });
    assert.deepEqual(at('/api/stats'), { status: 404, file: '404.html' });                     // there is no API on the static host
    assert.deepEqual(at('/nope/deeper'), { status: 404, file: '404.html' });
    // the Pages rule set: no rule for a page that exists (a 200 rule to live.html is a redirect loop there), 200 targets are clean URLs
    assert.deepEqual(S.redirectsFile(ALL).trim().split('\n'), ['/live  /  302', '/live/  /  302', '/blog  /writing  301', '/blog/  /writing  301', '/models  /results  200', '/models/*  /results  200']);
    for (const r of S.redirectRules(ALL)) { assert.ok(!r.to.endsWith('.html'), r.from); assert.ok(!S.SECTIONS.some((s) => s.route === r.from), `a rule shadows the page ${r.from}`); }
    assert.deepEqual(S.redirectRules(ALL), S.redirectRules([]), 'Pages needs no per-post rule');
});

test('Netlify: every server route has a static answer', () => {
    const built = new Set([...S.routeFiles(ALL).map((r) => r.file), 'snapshot.json', 'data/catalog.json', 'v/abc/assets/site.js']);
    const at = (p) => S.resolveRequest(p, { posts: ALL, has: (f) => built.has(f), target: 'netlify' });
    assert.deepEqual(at('/'), { status: 200, file: 'index.html' });
    assert.deepEqual(at('/index.html'), { status: 200, file: 'index.html' });
    for (const s of ['results', 'writing', 'about']) assert.deepEqual(at('/' + s), { status: 200, file: s + '.html' });
    assert.deepEqual(at('/live/'), { status: 302, location: '/' });   // its own page until 2026-10-10: old links land on the overview
    assert.deepEqual(at('/live'), { status: 302, location: '/' });
    assert.deepEqual(at('/models'), { status: 200, file: 'results.html' });
    assert.deepEqual(at('/models/local:qwen/x'), { status: 200, file: 'results.html' });
    assert.deepEqual(at('/blog'), { status: 301, location: '/writing' });
    assert.deepEqual(at('/blog/'), { status: 301, location: '/writing' });
    assert.deepEqual(at('/blog/live-post'), { status: 200, file: 'blog/live-post.html' });
    assert.deepEqual(at('/blog/live-post/'), { status: 200, file: 'blog/live-post.html' });
    assert.deepEqual(at('/blog/secret-draft'), { status: 404, file: '404.html' });
    assert.deepEqual(at('/feed.xml'), { status: 200, file: 'feed.xml' });
    assert.deepEqual(at('/api/stats'), { status: 404, file: '404.html' });
    assert.deepEqual(at('/../etc/passwd'), { status: 404, file: '404.html' });
});

test('Cloudflare: the copy of the site at the Worker\'s own workers.dev name is marked noindex, the custom domain is not', () => {
    const opts = { ga: false, liveOrigin: 'https://live.example', posts: ALL, noindexHost: 'lab-kylebaker.acct.workers.dev' };
    assert.ok(S.headersFile(opts).startsWith('https://lab-kylebaker.acct.workers.dev/*\n  X-Robots-Tag: noindex\n\n/*\n'));
    assert.ok(!S.headersFile({ ...opts, noindexHost: '' }).includes('X-Robots-Tag'));
    assert.equal(S.headersFor('/', opts)['X-Robots-Tag'], undefined);          // a path rule never carries it: only the absolute-URL rule does
    assert.ok(!S.netlifyToml({ ...opts, noindexHost: '' }).includes('workers.dev'));
});

test('Cloudflare Pages limits are checked on the build (free plan: 20,000 files, 25 MiB each, 100 header rules, 2,100 redirects)', () => {
    const opts = { ga: true, liveOrigin: 'https://live.example', posts: ALL };
    const headers = S.headersFile(opts), redirects = S.redirectsFile(ALL);
    assert.deepEqual(S.pagesLimitProblems([['index.html', 2000], ['data/catalog.json', 2.4e6]], { headers, redirects }), []);
    assert.ok(S.headerRules(opts).length <= 20 && Math.max(...headers.split('\n').map((l) => l.length)) < 1000, 'far inside the 100-rule / 2,000-character limits');
    assert.match(S.pagesLimitProblems([['data/model/big.json', 26 * 1024 * 1024]], {})[0], /big\.json is 26\.0 MiB \(limit 25 MiB per file\)/);
    assert.match(S.pagesLimitProblems(Array.from({ length: 20001 }, (_, i) => ['f' + i, 1]), {})[0], /20001 files \(limit 20000\)/);
    assert.match(S.pagesLimitProblems([], { headers: Array.from({ length: 101 }, (_, i) => `/p${i}\n  X-A: b`).join('\n\n') })[0], /101 header rules \(limit 100\)/);
    assert.match(S.pagesLimitProblems([], { headers: '/*\n  X-Long: ' + 'x'.repeat(2000) })[0], /_headers line is 20\d\d characters/);
    assert.match(S.pagesLimitProblems([], { redirects: Array.from({ length: 101 }, (_, i) => `/a${i}/*  /b  301`).join('\n') })[0], /101 redirects with a splat or placeholder \(limit 100\)/);
    assert.match(S.pagesLimitProblems([], { redirects: Array.from({ length: 2001 }, (_, i) => `/a${i}  /b  301`).join('\n') })[0], /2001 static redirects \(limit 2000\)/);
});

test('publishing: deploy only when the content changed and the last deploy is old enough', () => {
    const now = 10 * 3600e3;
    assert.deepEqual(S.deployDecision({ last: {}, contentHash: 'a', now }), { deploy: true, why: 'first deploy' });
    assert.equal(S.deployDecision({ last: { contentHash: 'a', at: 0 }, contentHash: 'a', now }).deploy, false);                       // idle lab: nothing to do, however old
    assert.equal(S.deployDecision({ last: { contentHash: 'a', at: now - 119 * 60e3 }, contentHash: 'b', now }).deploy, false);        // default: at most one deploy per 2 h
    assert.equal(S.deployDecision({ last: { contentHash: 'a', at: now - 121 * 60e3 }, contentHash: 'b', now }).deploy, true);
    assert.equal(S.deployDecision({ last: { contentHash: 'a', at: now - 31 * 60e3 }, contentHash: 'b', minIntervalMin: 30, now }).deploy, true);
    assert.deepEqual(S.deployDecision({ last: { contentHash: 'a', at: now }, contentHash: 'a', force: true, now }), { deploy: true, why: 'forced' });
});

test('publishing: the Workers deploy command (and the Netlify one behind --target netlify)', () => {
    const c = S.deployCommand({ out: '/x/dist-static', project: 'lab-kylebaker', message: 'snapshot T abc', node: '/n22/node', wranglerJs: '/x/node_modules/wrangler/bin/wrangler.js', config: '/x/wrangler.jsonc' });
    assert.deepEqual(c, { cmd: '/n22/node', args: ['/x/node_modules/wrangler/bin/wrangler.js', 'deploy', '--config', '/x/wrangler.jsonc', '--name', 'lab-kylebaker', '--assets', '/x/dist-static', '--message', 'snapshot T abc'] });
    assert.deepEqual(S.deployCommand({ out: '/x', project: 'p-1', message: 'm', extra: ['--dry-run'] }).args.slice(2),
        ['--config', 'wrangler.jsonc', '--name', 'p-1', '--assets', '/x', '--message', 'm', '--dry-run']);
    assert.ok(!c.args.some((a) => /^--(domains?|routes?)$/.test(a)), 'a deploy never attaches a domain or route');
    for (const bad of [undefined, '', 'Has Spaces', '-lead', 'x;rm']) assert.throws(() => S.deployCommand({ out: '/x', project: bad, message: 'm' }), /pagesProject/);
    assert.throws(() => S.deployCommand({ target: 'pages', out: '/x', project: 'p', message: 'm' }), /workers or netlify/);   // `wrangler pages deploy` is handed to Workers by wrangler 4.147
    assert.deepEqual(S.deployCommand({ target: 'netlify', out: '/x/dist-static', message: 'm', netlifyBin: '/bin/netlify' }), { cmd: '/bin/netlify', args: ['deploy', '--prod', '--dir', '/x/dist-static', '--message', 'm'] });
});

test('publishing: wrangler needs Node >= 22 -- use this Node if it qualifies, else the newest that does', () => {
    const c = [{ version: 'v20.20.2', path: '/n/20' }, { version: 'v22.9.0', path: '/n/22.9' }, { version: 'v22.23.3', path: '/n/22.23' }, { version: 'v16.13.0', path: '/n/16' }];
    assert.equal(S.pickNode({ version: 'v24.1.0', path: '/cur' }, c), '/cur');
    assert.equal(S.pickNode({ version: 'v20.20.2', path: '/cur' }, c), '/n/22.23');
    assert.equal(S.pickNode({ version: 'v20.20.2', path: '/cur' }, [...c, { version: 'v24.0.1', path: '/n/24' }]), '/n/24');
    assert.equal(S.pickNode({ version: 'v20.20.2', path: '/cur' }, c.filter((x) => !x.version.startsWith('v22'))), null);
    assert.equal(S.pickNode({ version: 'v20.20.2', path: '/cur' }, []), null);
});

test('headers: assets immutable, pages and the snapshot revalidated, no header named by two matching rules', () => {
    const opts = { ga: true, liveOrigin: 'https://live.example', posts: ALL };
    assert.equal(S.headersFor('/v/abc/ui/models/index.js', opts)['Cache-Control'], S.IMMUTABLE);
    for (const p of ['/', '/results', '/models/x', '/blog/live-post', '/snapshot.json', '/data/catalog.json', '/data/model/ab.json', '/feed.xml']) {
        assert.equal(S.headersFor(p, opts)['Cache-Control'], S.NO_CACHE, p);
    }
    const csp = S.headersFor('/', opts)['Content-Security-Policy'];
    assert.match(csp, /connect-src 'self' https:\/\/live\.example /);                 // the page may call the lab's API...
    assert.match(csp, /script-src 'self' https:\/\/www\.googletagmanager\.com;/);     // ...and nothing else new
    assert.equal(S.headersFor('/v/abc/x.js', opts)['X-Frame-Options'], 'DENY');
    assert.ok(!S.csp({}).includes('googletagmanager') && /connect-src 'self';/.test(S.csp({})));
    // the host joins the values of a header set by two matching rules: make sure none is
    for (const p of ['/', '/results', '/v/a/b.js', '/blog/live-post', '/data/catalog.json', '/models/x', '/blog-images/shot.png', '/404.html']) {
        const seen = {};
        for (const h of S.headerRules(opts)) if (S.ruleMatches(h.for, p)) for (const k of Object.keys(h.values)) { assert.ok(!seen[k], `${k} set twice for ${p}`); seen[k] = true; }
    }
});

test('netlify.toml carries the publish dir, every redirect and every header rule', () => {
    const toml = S.netlifyToml({ publishDir: 'public/dist-static', ga: false, liveOrigin: 'https://live.example', posts: ALL });
    assert.match(toml, /\[build\]\n {2}publish = "public\/dist-static"/);
    assert.equal((toml.match(/\[\[redirects\]\]/g) || []).length, S.redirectRules(ALL, 'netlify').length);
    assert.equal((toml.match(/\[\[headers\]\]/g) || []).length, S.headerRules({ posts: ALL }).length);
    assert.match(toml, /from = "\/blog\/live-post"\n {2}to = "\/blog\/live-post\.html"\n {2}status = 200/);
    assert.ok(!toml.includes('secret-draft') && !toml.includes('no-flag'));
    assert.match(toml, /for = "\/v\/\*"\n {2}\[headers\.values\]\n {4}Cache-Control = "public, max-age=31536000, immutable"/);
});

test('the same rules as _redirects / _headers files, and then netlify.toml carries none (never both)', () => {
    const opts = { ga: false, liveOrigin: 'https://live.example', posts: ALL };
    const red = S.redirectsFile(ALL, 'netlify').trim().split('\n');
    assert.equal(red.length, S.redirectRules(ALL, 'netlify').length);
    assert.ok(red.includes('/models/*  /results.html  200') && red.includes('/blog  /writing  301') && red.includes('/blog/live-post  /blog/live-post.html  200'));
    const blocks = S.headersFile(opts).trim().split('\n\n');
    assert.equal(blocks.length, S.headerRules(opts).length);
    assert.ok(blocks.includes('/v/*\n  Cache-Control: public, max-age=31536000, immutable'));
    assert.match(blocks[0], /^\/\*\n {2}X-Content-Type-Options: nosniff\n[\s\S]*\n {2}Content-Security-Policy: default-src 'self'; .*connect-src 'self' https:\/\/live\.example;/);
    const toml = S.netlifyToml({ ...opts, publishDir: 'public/dist-static', rules: false });
    assert.match(toml, /publish = "public\/dist-static"/);
    assert.ok(!toml.includes('[[redirects]]') && !toml.includes('[[headers]]'));
});

test('asset URLs get the content hash; the hash follows content, not order or time', () => {
    const a = [['assets/site.js', 'A'], ['ui/models/index.js', Buffer.from('B')]];
    const h = S.assetHash(a);
    assert.match(h, /^[0-9a-f]{12}$/);
    assert.equal(S.assetHash([a[1], a[0]]), h);
    assert.notEqual(S.assetHash([['assets/site.js', 'A2'], a[1]]), h);
    const html = '<link href="/vendor/tailwind.css"><script src="/ui/shared/theme.js"></script><script type="module" src="/assets/site.js"></script><a href="/results">x</a><link href="/feed.xml">';
    assert.equal(S.versionHtml(html, h), `<link href="/v/${h}/vendor/tailwind.css"><script src="/v/${h}/ui/shared/theme.js"></script><script type="module" src="/v/${h}/assets/site.js"></script><a href="/results">x</a><link href="/feed.xml">`);
});

test('static pages: the static-mode script is in <head> before any other script, configured by data attributes', async () => {
    const page = S.staticPage(await posts.shell({ path: '/results', title: 'results · ai lab' }), { hash: 'abc123', liveOrigin: 'https://live.example' });
    const mode = page.indexOf('/v/abc123/assets/static-mode.js" data-live-origin="https://live.example" data-snapshot="/snapshot.json"');
    assert.ok(mode > 0 && mode < page.indexOf('</head>'));
    assert.ok(mode < page.indexOf('chart.js') && mode < page.indexOf('assets/site.js'));
    assert.ok(page.includes('/v/abc123/assets/static.css'));
    assert.ok(!/(src|href)="\/(ui|assets|vendor)\//.test(page), 'an unversioned asset URL is left');
    assert.ok(!/<script(?![^>]*\bsrc=)(?![^>]*type="application\/json")[^>]*>/.test(page), 'the CSP allows no inline script');
    // a preview build can leave the Google tag out (--no-analytics); nothing else changes
    const tagged = '<head><link rel="stylesheet" href="/assets/site.css"><script async src="https://www.googletagmanager.com/gtag/js?id=G-X"></script><script src="/assets/ga.js"></script></head>';
    assert.ok(S.staticPage(tagged, { hash: 'h' }).includes('googletagmanager') && S.staticPage(tagged, { hash: 'h' }).includes('/v/h/assets/ga.js'));
    const untagged = S.staticPage(tagged, { hash: 'h', analytics: false });
    assert.ok(!untagged.includes('googletagmanager') && !untagged.includes('ga.js') && untagged.includes('/v/h/assets/static-mode.js'));
    // a post page shows no lab data: no static mode, still versioned
    const post = S.staticPage(await posts.postPage('live-post'), { hash: 'abc123', staticMode: false });
    assert.ok(!post.includes('static-mode.js') && post.includes('/v/abc123/assets/site.js') && post.includes('Live one'));
});

test('module imports are checked against the files in the build', () => {
    assert.deepEqual(S.relativeImports(`import { a } from './a.js';\nimport '../shared/b.js';\n// import { z } from './gone.js';\nconst x = import('./c.js'); import(new URL('../ui/d.js', import.meta.url).href); import x from 'pkg';`).sort(),
        ['../shared/b.js', '../ui/d.js', './a.js', './c.js']);
    const ok = { 'assets/site.js': `import './live.js'; import(new URL('../ui/models/index.js', import.meta.url).href);`, 'assets/live.js': '', 'ui/models/index.js': `import '../shared/x.js';`, 'ui/shared/x.js': '' };
    assert.deepEqual(S.missingImports(ok), []);
    delete ok['ui/shared/x.js'];
    assert.deepEqual(S.missingImports(ok), [{ from: 'ui/models/index.js', spec: '../shared/x.js', target: 'ui/shared/x.js' }]);
});

test('the real asset list: covers everything server.js serves, and every import resolves', () => {
    const dash = path.join(__dirname, '..');
    const server = fs.readFileSync(path.join(dash, 'public', 'server.js'), 'utf8');
    const block = server.slice(server.indexOf('const STATIC = new Map(['), server.indexOf(']);', server.indexOf('const STATIC = new Map([')));
    const served = [...block.matchAll(/'\/?((?:assets|vendor|ui)\/[\w./-]+\.(?:js|css))'/g)].map((m) => m[1]);
    assert.ok(served.length >= 19, 'could not read the STATIC map out of server.js');
    const have = new Set(S.ASSET_FILES.map(([k]) => k));
    for (const f of served) assert.ok(have.has(f), `server.js serves ${f}; add it to ASSET_FILES in public/staticsite.js`);
    const sources = {};
    for (const [k, rel] of S.ASSET_FILES) { assert.ok(fs.existsSync(path.join(dash, rel)), `${rel} is missing`); if (k.endsWith('.js')) sources[k] = fs.readFileSync(path.join(dash, rel), 'utf8'); }
    assert.deepEqual(S.missingImports(sources), []);
});

test('snapshot manifest: stats as server.js computes them, model files by key, live record without rates', () => {
    const catalog = { generatedAt: 1700, taskTotal: 7, models: [
        { key: 'local:a:q4', provider: 'local', counts: { qualityTasks: 3, qualityBatteries: 2, requests: 10 } },
        { key: 'cloud:x@low/solo', provider: 'cloud', counts: { qualityTasks: 5, qualityBatteries: 1, requests: 0 } },
        { key: 'local:b:q2', provider: 'local', counts: { qualityTasks: 0, requests: 4 } }] };
    const live = { at: 1690, stale: false, lanes: [{ lane: 'local-gpu', gen: 55.5 }], running: [{ dir: 'bat-1', runner: 'opencode', lane: 'local-gpu', task: 't', tasks: 3, done: 1, solved: 1, model: 'A Q4', state: 'running' }] };
    const m = S.snapshotManifest({ builtAt: 1800, catalog, posts: [{ slug: 'live-post' }], live, modelKeys: catalog.models.map((x) => x.key) });
    assert.deepEqual(m.stats, { models: 3, withQuality: 2, local: 1, cloud: 1, tasks: 7, batteries: 3, taskRuns: 8, requests: 14, generatedAt: 1700 });
    assert.equal(m.generatedAt, 1700);
    assert.equal(m.catalog, '/data/catalog.json');
    assert.match(m.models['cloud:x@low/solo'], /^\/data\/model\/[0-9a-f]{16}\.json$/);
    assert.equal(new Set(Object.values(m.models)).size, 3);
    assert.deepEqual(m.live, { at: 1690, running: [{ dir: 'bat-1', runner: 'opencode', lane: 'local-gpu', task: 't', tasks: 3, done: 1, solved: 1, model: 'A Q4' }] });
    assert.equal(S.snapshotManifest({ builtAt: 1, catalog, live: null, modelKeys: [] }).live, null);
});

test('content hash: blind to build stamps and the live record, not to data', () => {
    const snap = (extra) => JSON.stringify({ v: 1, builtAt: 1, generatedAt: 2, contentHash: null, stats: { models: 3, generatedAt: 2 }, posts: [], live: { at: 5 }, ...extra });
    const base = [['snapshot.json', snap()], ['data/catalog.json', '{"generatedAt":2,"models":[1]}'], ['index.html', '<html>']];
    const h = S.contentHash(base);
    assert.equal(S.contentHash([['snapshot.json', snap({ builtAt: 9, generatedAt: 8, contentHash: 'x', live: null, stats: { models: 3, generatedAt: 8 } })], ['data/catalog.json', '{"generatedAt":8,"models":[1]}'], base[2]]), h);
    assert.notEqual(S.contentHash([base[0], ['data/catalog.json', '{"generatedAt":2,"models":[1,2]}'], base[2]]), h);
    assert.notEqual(S.contentHash([['snapshot.json', snap({ posts: [{ slug: 'new' }] })], base[1], base[2]]), h);
    assert.notEqual(S.contentHash([base[0], base[1], ['index.html', '<html lang>']]), h);
});

test('draft gate: a draft page, list entry or feed item fails the build', async () => {
    const good = { 'blog/live-post.html': await posts.postPage('live-post'), 'feed.xml': await posts.feed(), 'snapshot.json': JSON.stringify({ posts: await posts.index() }) };
    assert.deepEqual(S.draftLeaks(ALL, good), []);
    assert.ok(!JSON.stringify(good).includes('SECRET') && !JSON.stringify(good).includes('NO FLAG'));
    assert.match(S.draftLeaks(ALL, { ...good, 'blog/secret-draft.html': '<html>' })[0], /draft page written: blog\/secret-draft\.html/);
    assert.equal(S.draftLeaks(ALL, { ...good, 'snapshot.json': '{"posts":[{"slug":"no-flag"}]}' }).length, 1);
    assert.equal(S.draftLeaks(ALL, { ...good, 'feed.xml': '<link>https://x/blog/secret-draft</link>' }).length, 1);
    assert.equal(S.draftLeaks(ALL, { ...good, 'writing.html': '<a href="/blog/no-flag">x</a>' }).length, 1);
});

test('only images that published posts reference are copied', async () => {
    assert.deepEqual(S.referencedImages([await posts.postPage('live-post')]), ['shot.png']);
    assert.deepEqual(S.referencedImages(['<img src="/blog-images/a.PNG"><img src="/blog-images/b.webp"><img src="/blog-images/../../etc/passwd">']), ['a.PNG', 'b.webp']);
});

test('leak gate: paths, private addresses, the host name, and dropped keys in data', () => {
    const what = (name, text) => S.leakScan(name, text).map((h) => h.what);
    assert.deepEqual(what('data/catalog.json', '{"launchCommand":"llama-server -m Q-q4.gguf -c 65536 -ngl 999 --rpc <ip>,<ip>","dir":"llama.cpp/build-all"}'), []);   // what publicdata.js lets through
    assert.deepEqual(what('data/catalog.json', '{"a":"/home/someone/x"}'), ['home directory path']);
    assert.deepEqual(what('v/a/ui/x.js', '// see /data/models/Q.gguf'), ['model store path']);
    assert.deepEqual(what('data/x.json', '{"a":"~/.cache/huggingface/hub"}'), ['HF cache path']);
    for (const ip of ['192.168.1.125', '10.0.0.7', '172.16.4.1', '100.80.0.20', '100.100.0.10']) assert.deepEqual(what('index.html', `rpc ${ip}:50052`), ['private IPv4'], ip);
    assert.deepEqual(what('index.html', 'v1.2.3.4 and 8.8.8.8 and 100.200.1.1'), []);
    assert.deepEqual(what('data/x.json', '{"h":"[fd7a:115c:a1e0::2734:583d]:8080"}'), ['tailnet IPv6']);
    assert.deepEqual(what('data/x.json', '{"h":"pop-os"}'), ['host name']);
    assert.deepEqual(what('data/x.json', '{"prompt":"x","transcript_tail":[]}'), ['dropped key "prompt"', 'dropped key "transcript_tail"']);
    assert.deepEqual(what('data/x.json', '{"note":"the Password is"}'), ['the word "password"']);
    assert.deepEqual(what('v/a/ui/x.js', 'const prompt = j.prompt; // "prompt": shown in the lab only'), []);   // code may name a field; data may not carry it
    // the gate's key list is publicdata.js's own
    assert.deepEqual([...S.LEAK_DATA_KEYS].sort(), [...require('../lib/publicdata').DROP_KEYS].sort());
});

test('public/wrangler.jsonc: the project\'s Worker, the build as its assets served like Pages, and never a route or custom domain', () => {
    const read = (f) => fs.readFileSync(path.join(__dirname, '..', 'public', f), 'utf8');
    const wc = JSON.parse(read('wrangler.jsonc').replace(/^\s*\/\/.*$/gm, ''));   // the way publish-static.js reads it
    assert.equal(wc.name, JSON.parse(read('site.config.json')).pagesProject);
    assert.deepEqual(wc.assets, { directory: './dist-static', html_handling: 'auto-trailing-slash', not_found_handling: '404-page' });
    assert.equal(wc.main, undefined, 'assets only: no Worker script');
    // workers_dev OFF since the go-live (Kyle 10-22: the account's workers.dev subdomain is built from his e-mail; wrangler.jsonc
    // says why): explicit either way, so a route or --domain never flips it silently. (This line said `true` until 2026-10-22.)
    assert.equal(wc.workers_dev, false, 'explicit, and off: the workers.dev name would publish the account name');
    for (const k of ['route', 'routes']) assert.equal(wc[k], undefined, `"${k}" in the config: a cron deploy would replace DNS records without asking`);
    assert.match(read('publish-static.js'), /for \(const k of \['route', 'routes'\]\) if \(wc\[k\] != null\) throw/);
});

// 2026-10-27 (pre-push sweep): the account's workers.dev subdomain (built from its e-mail) left site.config.json for
// public/site.config.local.json, gitignored. build-static.js merges it back, so the build's noindex rule is unchanged.
test('build-static: site.config.local.json is merged over site.config.json; no file = as before; a broken one fails', () => {
    const { withLocalConfig } = require('../public/build-static');
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'site-local-'));
    try {
        const base = { pagesProject: 'lab-x', workersSubdomain: null, gaMeasurementId: 'G-TEST' };
        assert.deepEqual(withLocalConfig(base, path.join(d, 'absent.json')), base, 'no local file: site.config.json alone');
        fs.writeFileSync(path.join(d, 'site.config.local.json'), JSON.stringify({ workersSubdomain: 'acct' }));
        const merged = withLocalConfig(base, path.join(d, 'site.config.local.json'));
        assert.deepEqual(merged, { pagesProject: 'lab-x', workersSubdomain: 'acct', gaMeasurementId: 'G-TEST' });
        assert.equal(base.workersSubdomain, null, 'the input object is not modified');
        assert.ok(S.headersFile({ ga: false, liveOrigin: 'https://live.example', posts: ALL, noindexHost: `${merged.pagesProject}.${merged.workersSubdomain}.workers.dev` })
            .startsWith('https://lab-x.acct.workers.dev/*\n  X-Robots-Tag: noindex\n'), 'the noindex rule comes back from the local value');
        for (const bad of ['{ nope', '[1, 2]', 'null', '"text"']) {
            fs.writeFileSync(path.join(d, 'bad.json'), bad);
            assert.throws(() => withLocalConfig(base, path.join(d, 'bad.json')), /^Error: bad\.json: /, bad);
        }
    } finally { fs.rmSync(d, { recursive: true, force: true }); }
    // the repo's own copy names no account
    const repoCfg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public', 'site.config.json'), 'utf8'));
    assert.ok(!repoCfg.workersSubdomain, 'site.config.json carries no workers.dev subdomain (it goes in site.config.local.json)');
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', 'build-static.js'), 'utf8'), /const cfg = withLocalConfig\(postsLib\.siteConfig\(\)\);/, 'the build reads the merged config');
});
