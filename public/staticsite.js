// The static build of the public site: the pure half (2026-10-06). See STATIC-ARCHITECTURE.md.
//
// Kyle: "we need a new architecture for the public page -- it should deploy to e.g. netlify, and connect to our
// server _when_ it's up/live, and when not, just show the last record of data it had."
//
// Everything here is a function of its arguments: which files a build writes for which routes, how asset URLs
// get their content hash, the headers / redirects the host must apply, the snapshot manifest, and the gates
// that keep drafts and private strings out. build-static.js does the reading and writing; preview-static.js
// serves the result with the SAME rule table that becomes netlify.toml, so the preview tests the real rules.

'use strict';
const crypto = require('crypto');
const path = require('path');

const sha1 = (x) => crypto.createHash('sha1').update(x).digest('hex');

// ------------------------------------------------------------------ assets
// The files a page may load. Mirrors the STATIC map in server.js (test/staticsite.test.js fails if server.js
// gains a file this list lacks) plus the static-only pieces. key = the URL path the server uses, value = the
// path relative to the dashboard dir.
const STATIC_ONLY = ['assets/static-mode.js', 'assets/static.css'];
const ASSET_FILES = [
    ...['site.css', 'site.js', 'live.js', 'ga.js'].map((f) => [`assets/${f}`, `public/assets/${f}`]),
    ...STATIC_ONLY.map((f) => [f, `public/${f}`]),
    ...['tailwind.css', 'fonts.css', 'chart.js', 'marked.min.js'].map((f) => [`vendor/${f}`, `vendor/${f}`]),
    ...['ui/shared/theme.js', 'ui/shared/modelname.js', 'ui/shared/ctxlabel.js', 'ui/shared/poll.js', 'ui/shared/leaderboard.js', 'ui/shared/todos.js', 'ui/shared/loadbar.js', 'ui/benchmarks/util.js', 'ui/benchmarks/transcript.js',
        'ui/models/index.js', 'ui/models/charts.js', 'ui/models/detail.js', 'ui/models/task.js', 'ui/models/prefill.js'].map((f) => [f, f]),
];
// The site's icons (2026-10-22): written at the build's ROOT, unversioned, where browsers look for them (server.js
// serves the same files at the same paths). [output name, path relative to the dashboard dir]
const ICON_FILES = ['favicon.ico', 'favicon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'].map((f) => [f, `public/assets/${f}`]);

/** One hash over every asset's path and CONTENT (the server hashes mtimes; a build must be reproducible). */
function assetHash(files) {   // files: [[urlPath, Buffer|string]]
    const h = crypto.createHash('sha1');
    for (const [k, body] of [...files].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) h.update(k + '\0' + sha1(body) + '\n');
    return h.digest('hex').slice(0, 12);
}

/** Every src/href into /ui, /assets or /vendor -> /v/<hash>/...; relative imports inside the modules then resolve under the same prefix. */
function versionHtml(html, hash) {
    return String(html).replace(/(src|href)="\/(ui|assets|vendor)\//g, (_m, a, d) => `${a}="/v/${hash}/${d}/`);
}

/** Relative module specifiers in a JS source: `import ... from './x.js'`, `import './x.js'`, `import('./x.js')`, `new URL('./x.js', import.meta.url)`. */
function relativeImports(src) {
    const out = new Set();
    const res = [/\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/g, /\bimport\s*['"](\.{1,2}\/[^'"]+)['"]/g, /\bimport\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/g,
        /new URL\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*,\s*import\.meta\.url\s*\)/g];
    const code = String(src).replace(/^\s*\/\/.*$/gm, '');   // a commented-out import is not an import
    for (const re of res) for (const m of code.matchAll(re)) out.add(m[1]);
    return [...out];
}

/** Imports that would 404 in the build: [{ from, spec, target }]. sources: { 'ui/models/index.js': '<js>' } keyed by URL path. */
function missingImports(sources) {
    const have = new Set(Object.keys(sources));
    const missing = [];
    for (const [file, src] of Object.entries(sources)) {
        if (!file.endsWith('.js')) continue;
        for (const spec of relativeImports(src)) {
            const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), spec));
            if (!have.has(target)) missing.push({ from: file, spec, target });
        }
    }
    return missing;
}

// ------------------------------------------------------------------ routes
// The section pages: one shell each (the client renders the section), like server.js's first route.
const SECTIONS = [
    { route: '/', file: 'index.html', title: 'ai lab' },
    { route: '/results', file: 'results.html', title: 'results · ai lab' },
    { route: '/writing', file: 'writing.html', title: 'writing · ai lab' },
    { route: '/about', file: 'about.html', title: 'about · ai lab' },
];

const SLUG_RE = /^[a-z0-9-]+$/;

/** Only posts explicitly published (`draft: false`) with a routable slug. Same rule as posts.js load(). */
function publishedOnly(posts) {
    return (posts || []).filter((p) => p && p.draft === false && SLUG_RE.test(String(p.slug || '')));
}

/** Every HTML/XML/TXT file a build writes, and the route that reaches it. posts: [{ slug, draft }] (anything not draft:false is skipped). */
function routeFiles(posts) {
    return [
        ...SECTIONS.map((s) => ({ route: s.route, file: s.file, kind: 'section', title: s.title })),
        ...publishedOnly(posts).map((p) => ({ route: `/blog/${p.slug}`, file: `blog/${p.slug}.html`, kind: 'post', slug: p.slug })),
        { route: '/404', file: '404.html', kind: 'notfound' },
        { route: '/feed.xml', file: 'feed.xml', kind: 'feed' },
        { route: '/robots.txt', file: 'robots.txt', kind: 'robots' },
    ];
}

/** Redirect / rewrite rules for a host, first match wins. status 200 = serve `to` at the requested URL.
 *
 *  The two hosts resolve pages differently, so the rules differ (checked on `wrangler pages dev`, 2026-10-06):
 *  - Cloudflare ('pages', the default: Pages, and since 2026-10-22 Workers static assets with html_handling
 *    "auto-trailing-slash" -- the same asset server, checked on `wrangler dev`) serves `live.html` at `/live` by itself and 308s `/live.html` and
 *    `/live/` to it. Its redirects are followed even when a file exists, so a `/live -> /live.html 200` rule
 *    becomes a redirect loop there: Pages gets no rule for a page that exists. A 200 target must be the clean URL
 *    (`/results`, not `/results.html`). A rule matches its path exactly: `/blog` does not cover `/blog/`.
 *  - Netlify ('netlify') only applies a rule when no file matches, and ignores trailing slashes; explicit 200
 *    rewrites keep its behaviour independent of the "pretty URLs" setting. */
function redirectRules(posts, target = 'pages') {
    if (target === 'pages') {
        return [
            { from: '/live', to: '/', status: 302 },                 // its own page until 2026-10-10; the overview shows what is running
            { from: '/live/', to: '/', status: 302 },
            { from: '/blog', to: '/writing', status: 301 },          // server.js serves the writing shell here; the client then shows the wrong section
            { from: '/blog/', to: '/writing', status: 301 },
            { from: '/models', to: '/results', status: 200 },        // server.js: /^\/models(\/|$)/ is the results shell
            { from: '/models/*', to: '/results', status: 200 },
        ];
    }
    return [
        ...SECTIONS.filter((s) => s.route !== '/').map((s) => ({ from: s.route, to: '/' + s.file, status: 200 })),
        { from: '/models', to: '/results.html', status: 200 },
        { from: '/models/*', to: '/results.html', status: 200 },
        { from: '/live', to: '/', status: 302 },
        { from: '/blog', to: '/writing', status: 301 },
        ...publishedOnly(posts).map((p) => ({ from: `/blog/${p.slug}`, to: `/blog/${p.slug}.html`, status: 200 })),
    ];
}

/** Content-Security-Policy: server.js csp() plus the lab's API origin in connect-src (the page calls it cross-origin). */
function csp({ ga = false, liveOrigin = '' } = {}) {
    const gaScript = ga ? ' https://www.googletagmanager.com' : '';
    const gaConnect = ga ? ' https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com' : '';
    const live = liveOrigin ? ' ' + liveOrigin : '';
    return `default-src 'self'; script-src 'self'${gaScript}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'${live}${gaConnect}; frame-ancestors 'none'; base-uri 'self'; form-action 'none'`;
}

const NO_CACHE = 'public, max-age=0, must-revalidate';
const IMMUTABLE = 'public, max-age=31536000, immutable';

/** Header rules. A request gets the headers of EVERY rule whose pattern matches, so no header name appears in two
 *  rules that can match the same path (the host would join the values): security headers on `/*`, Cache-Control
 *  only on disjoint paths. */
function headerRules({ ga = false, liveOrigin = '', posts = [], noindexHost = '' } = {}) {
    return [
        // Cloudflare keeps serving the site at the project's own name (<worker>.<account>.workers.dev; Pages:
        // <project>.pages.dev) beside the custom domain: keep that second copy out of search engines (an absolute-URL
        // rule, the example in Cloudflare's own _headers documentation). The host is in _headers only, which is never served.
        ...(noindexHost ? [{ for: `https://${noindexHost}/*`, values: { 'X-Robots-Tag': 'noindex' } }] : []),
        { for: '/*', values: {
            'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin', 'X-Frame-Options': 'DENY',
            'Permissions-Policy': 'camera=(), microphone=(), geolocation=()', 'Content-Security-Policy': csp({ ga, liveOrigin }) } },
        { for: '/v/*', values: { 'Cache-Control': IMMUTABLE } },                          // content-hashed: never changes under a URL
        ...['/', '/index.html', ...SECTIONS.filter((s) => s.route !== '/').map((s) => s.route), '/models', '/models/*', '/blog/*', '/404.html',
            '/snapshot.json', '/data/*', '/feed.xml'].map((p) => ({ for: p, values: { 'Cache-Control': NO_CACHE } })),   // HTML and the snapshot: always revalidated
        ...(publishedOnly(posts).length ? [{ for: '/blog-images/*', values: { 'Cache-Control': 'public, max-age=86400' } }] : []),
    ];
}

const tomlStr = (s) => JSON.stringify(String(s));   // a TOML basic string takes the same escapes as JSON for these values

/** netlify.toml. publishDir is relative to the repository root (see STATIC-ARCHITECTURE.md). `rules: false` leaves the
 *  redirects and headers out, for a build that carries them as _redirects / _headers files instead (never both: the
 *  host would apply each header twice). */
function netlifyToml({ publishDir = 'dist-static', ga = false, liveOrigin = '', posts = [], rules = true } = {}) {
    const lines = [
        '# GENERATED by public/build-static.js -- edit public/staticsite.js (headerRules / redirectRules), not this file.',
        '# The static build of lab.kylebaker.io: prebuilt files, no build step on Netlify.',
        '',
        '[build]',
        `  publish = ${tomlStr(publishDir)}`,
        '',
    ];
    if (!rules) return lines.concat(['# Redirects and headers are in the publish directory: _redirects and _headers (build-static.js --rules files).', '']).join('\n');
    for (const r of redirectRules(posts, 'netlify')) {
        lines.push('[[redirects]]', `  from = ${tomlStr(r.from)}`, `  to = ${tomlStr(r.to)}`, `  status = ${r.status}`, '');
    }
    for (const h of headerRules({ ga, liveOrigin, posts })) {
        lines.push('[[headers]]', `  for = ${tomlStr(h.for)}`, '  [headers.values]');
        for (const [k, v] of Object.entries(h.values)) lines.push(`    ${k} = ${tomlStr(v)}`);
        lines.push('');
    }
    return lines.join('\n');
}

/** The rules as files in the publish directory: what Cloudflare reads (Pages, and Workers static assets: wrangler
 *  uploads both files as the assets' configuration, never as files to serve), and what Netlify reads wherever the
 *  deploy is run from. */
function redirectsFile(posts, target = 'pages') {
    return redirectRules(posts, target).map((r) => `${r.from}  ${r.to}  ${r.status}`).join('\n') + '\n';
}
function headersFile(opts) {
    return headerRules(opts).map((h) => [h.for, ...Object.entries(h.values).map(([k, v]) => `  ${k}: ${v}`)].join('\n')).join('\n\n') + '\n';
}

// Cloudflare Pages limits (developers.cloudflare.com/pages/platform/limits, read 2026-10-06; free plan). Workers static
// assets have the same per-file (25 MiB) and file-count (20,000 on the free plan) limits, and read the same two files.
const PAGES_LIMITS = { files: 20000, fileBytes: 25 * 1024 * 1024, headerRules: 100, headerLine: 2000, staticRedirects: 2000, dynamicRedirects: 100, redirectLine: 1000 };

/** What in a build Cloudflare Pages would refuse or ignore -> [message]. files: [[name, bytes]]. */
function pagesLimitProblems(files, { headers = '', redirects = '' } = {}) {
    const out = [];
    const L = PAGES_LIMITS;
    if (files.length > L.files) out.push(`${files.length} files (limit ${L.files})`);
    for (const [name, bytes] of files) if (bytes > L.fileBytes) out.push(`${name} is ${(bytes / 1048576).toFixed(1)} MiB (limit 25 MiB per file)`);
    const hLines = String(headers).split('\n');
    const nRules = hLines.filter((l) => l && !/^\s/.test(l) && !l.startsWith('#')).length;
    if (nRules > L.headerRules) out.push(`${nRules} header rules (limit ${L.headerRules})`);
    for (const l of hLines) if (l.length > L.headerLine) out.push(`a _headers line is ${l.length} characters (limit ${L.headerLine}): ${l.slice(0, 60)}…`);
    const rLines = String(redirects).split('\n').filter((l) => l.trim() && !l.startsWith('#'));
    const dynamic = rLines.filter((l) => /[*:]/.test(l.trim().split(/\s+/)[0].replace(/^https?:/, ''))).length;
    if (dynamic > L.dynamicRedirects) out.push(`${dynamic} redirects with a splat or placeholder (limit ${L.dynamicRedirects})`);
    if (rLines.length - dynamic > L.staticRedirects) out.push(`${rLines.length - dynamic} static redirects (limit ${L.staticRedirects})`);
    for (const l of rLines) if (l.length > L.redirectLine) out.push(`a _redirects line is ${l.length} characters (limit ${L.redirectLine})`);
    return out;
}

/** Does a rule pattern (`/x`, `/x/*`, `/*`) match a request path? `exact`: Pages (a trailing slash is a different
 *  path); otherwise trailing slashes are ignored, as Netlify does. */
function ruleMatches(pattern, p, exact = false) {
    const norm = (s) => (!exact && s.length > 1 ? s.replace(/\/+$/, '') : s);
    if (pattern.endsWith('/*')) { const base = pattern.slice(0, -2); return p === base + '/' || p.startsWith(base + '/') || (base === '' && p.startsWith('/')); }
    return norm(pattern) === norm(p);
}

/** What the host does with a request path: a redirect, or the file to serve and its status. `has(file)` says whether
 *  a file exists in the build. Used by preview-static.js; the expectations in the tests were read off
 *  `wrangler pages dev` (Pages) -- this is a model of the host, the emulator is the reference. Workers static assets
 *  (`wrangler dev`, 2026-10-22) answer every route the same, except that the redirects to a clean URL are 307 there. */
function resolveRequest(p, { posts = [], has, target = 'pages' }) {
    const direct = (q) => { const f = q.replace(/^\//, ''); return f && has(f) ? f : null; };
    const notFound = () => ({ status: 404, file: has('404.html') ? '404.html' : null });
    if (target === 'pages') {
        // Pages' own page resolution: clean URLs are canonical, everything else is 308'd to them.
        const asset = (q) => {
            if (q === '/') return has('index.html') ? { status: 200, file: 'index.html' } : notFound();
            if (q.endsWith('/index.html')) return direct(q) ? { status: 308, location: q.slice(0, -'index.html'.length) } : notFound();
            if (q.endsWith('.html')) return direct(q) ? { status: 308, location: q.slice(0, -'.html'.length) } : notFound();
            if (q.endsWith('/')) {
                const bare = q.replace(/\/+$/, '');
                if (direct(q + 'index.html')) return { status: 200, file: direct(q + 'index.html') };
                return direct(bare + '.html') ? { status: 308, location: bare } : notFound();
            }
            if (direct(q + '.html')) return { status: 200, file: direct(q + '.html') };
            if (direct(q)) return { status: 200, file: direct(q) };
            return direct(q + '/index.html') ? { status: 308, location: q + '/' } : notFound();
        };
        for (const r of redirectRules(posts, 'pages')) {      // redirects first, whether or not a file matches
            if (!ruleMatches(r.from, p, true)) continue;
            return r.status === 200 ? asset(r.to) : { status: r.status, location: r.to };
        }
        return asset(p);
    }
    const clean = p.length > 1 ? p.replace(/\/+$/, '') : p;
    // Netlify: a real file wins over a rule ("shadowing": rules without force apply only when no file matches)
    const exact = direct(clean) || (clean === '/' ? 'index.html' : null);
    if (exact) return { status: 200, file: exact };
    for (const r of redirectRules(posts, 'netlify')) {
        if (!ruleMatches(r.from, clean)) continue;
        if (r.status === 200) { const f = direct(r.to); if (f) return { status: 200, file: f }; continue; }
        return { status: r.status, location: r.to };
    }
    const pretty = direct(clean + '.html') || direct(clean + '/index.html');
    if (pretty) return { status: 200, file: pretty };
    return notFound();
}

/** The response headers the rules give a request path. */
function headersFor(p, opts) {
    const out = {};
    for (const h of headerRules(opts)) if (ruleMatches(h.for, p)) Object.assign(out, h.values);
    return out;
}

// ------------------------------------------------------------------ pages
/** A section shell from posts.shell() -> its static form: versioned asset URLs, the static-mode script and style
 *  in <head> (before anything can fetch), configured through data- attributes (the CSP allows no inline script). */
function staticPage(html, { hash, liveOrigin = '', snapshotUrl = '/snapshot.json', staticMode = true, analytics = true } = {}) {
    let out = String(html);
    // a local preview must not report page views: drop the Google tag and its bootstrap (build-static.js --no-analytics)
    if (!analytics) out = out.replace(/<script async src="https:\/\/www\.googletagmanager\.com\/[^"]*"><\/script>/g, '').replace(/<script src="\/assets\/ga\.js"><\/script>/g, '');
    if (staticMode) {
        const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        const script = `<script src="/assets/static-mode.js" data-live-origin="${esc(liveOrigin)}" data-snapshot="${esc(snapshotUrl)}"></script>\n`;
        const end = out.indexOf('</head>');
        if (end < 0) throw new Error('page has no </head>');
        out = out.slice(0, end) + '<link rel="stylesheet" href="/assets/static.css">\n' + out.slice(end);   // after site.css
        let at = out.indexOf('<link rel="stylesheet"');      // the script goes ahead of the stylesheets and libraries: the probe starts while they load
        if (at < 0) at = out.indexOf('</head>');
        out = out.slice(0, at) + script + out.slice(at);
    }
    return versionHtml(out, hash);
}

/** Image files under /blog-images/ that published pages reference (a draft's images are not copied). */
function referencedImages(htmls) {
    const out = new Set();
    for (const h of htmls) for (const m of String(h).matchAll(/\/blog-images\/([\w.-]+\.(?:png|jpe?g|webp|gif|svg))/gi)) out.add(m[1]);
    return [...out].sort();
}

// ------------------------------------------------------------------ data snapshot
/** The landing page's headline counts, from the public catalog: the same arithmetic as server.js `stats`. */
function statsFromCatalog(cat) {
    const models = (cat && cat.models) || [];
    const withQuality = models.filter((m) => m.counts && m.counts.qualityTasks > 0);
    const sum = (f) => models.reduce((a, m) => a + ((m.counts && m.counts[f]) || 0), 0);
    return {
        models: models.length, withQuality: withQuality.length,
        local: withQuality.filter((m) => m.provider !== 'cloud').length, cloud: withQuality.filter((m) => m.provider === 'cloud').length,
        tasks: (cat && cat.taskTotal) || 0, batteries: sum('qualityBatteries'), taskRuns: sum('qualityTasks'), requests: sum('requests'),
        generatedAt: (cat && cat.generatedAt) || null,
    };
}

/** Where a model's detail record lives in the build. The manifest carries key -> file, so nothing else derives this. */
function modelFile(key) { return `data/model/${sha1(String(key)).slice(0, 16)}.json`; }

/** The last live record worth keeping for an offline page: what was running, without rates (stale within seconds). */
function liveRecord(live) {
    if (!live || !live.at) return null;
    // question / passed / failed / excluded / remaining (2026-10-07): what the running queue item answers and where it
    // stood at build time; absent when the lab's server does not send them, and then left out here too.
    return { at: live.at, running: (live.running || []).map(({ dir, runner, lane, task, tasks, done, solved, model, question, passed, failed, excluded, remaining }) => {
        const o = { dir, runner, lane, task, tasks, done, solved, model };
        if (typeof question === 'string' && question) o.question = question;
        if (passed != null && failed != null) Object.assign(o, { passed, failed, excluded: excluded || 0, remaining: remaining || 0 });
        return o;
    }) };
}

/** /snapshot.json: the one file the page reads first. Small things inline, big things by path. */
function snapshotManifest({ builtAt, catalog, posts, live, modelKeys, contentHash }) {
    const models = {};
    for (const k of modelKeys || []) models[k] = '/' + modelFile(k);
    return {
        v: 1, builtAt, generatedAt: (catalog && catalog.generatedAt) || builtAt, contentHash: contentHash || null,
        stats: statsFromCatalog(catalog), posts: posts || [], live: liveRecord(live),
        catalog: '/data/catalog.json', models,
    };
}

/** A hash of what the site SHOWS, blind to the stamps that change on every build (generatedAt, builtAt) and to the
 *  live record: publish-static.js deploys only when this changes. files: [[path, string|Buffer]]. */
function contentHash(files) {
    const h = crypto.createHash('sha1');
    for (const [k, body] of [...files].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) {
        let text = Buffer.isBuffer(body) ? body.toString('latin1') : String(body);
        if (k === 'snapshot.json') { const j = JSON.parse(text); delete j.builtAt; delete j.generatedAt; delete j.contentHash; delete j.live; if (j.stats) delete j.stats.generatedAt; text = JSON.stringify(j); }
        else if (k.endsWith('.json')) text = text.replace(/"generatedAt":\d+/g, '"generatedAt":0');
        h.update(k + '\0' + sha1(text) + '\n');
    }
    return h.digest('hex').slice(0, 16);
}

// ------------------------------------------------------------------ publishing
/** Should publish-static.js deploy now? last: { contentHash, at } from the previous deploy (or {}).
 *  -> { deploy, why }. The hash ignores build stamps and the live record, so an idle lab never deploys. */
function deployDecision({ last = {}, contentHash: hash, force = false, minIntervalMin = 120, now = Date.now() }) {
    if (force) return { deploy: true, why: 'forced' };
    if (last.contentHash === hash) return { deploy: false, why: `unchanged since the last deploy (${hash})` };
    const ageMin = last.at ? (now - last.at) / 60000 : Infinity;
    if (ageMin < minIntervalMin) return { deploy: false, why: `changed, but the last deploy was ${Math.round(ageMin)} min ago (< ${minIntervalMin})` };
    return { deploy: true, why: last.contentHash ? `changed (${last.contentHash} -> ${hash})` : 'first deploy' };
}

/** The deploy command for a host -> { cmd, args }. Workers (the default since 2026-10-22: wrangler 4.147 hands
 *  `wrangler pages ...` to Workers, and Workers static assets is Cloudflare's current product): wrangler's own script
 *  run by a Node >= 22 (`node`), so nothing depends on PATH, with public/wrangler.jsonc (`config`: how the assets are
 *  served -- never a route or custom domain, see that file). `--name` and `--assets` (only the directory; the config's
 *  html_handling / not_found_handling stay) say what this build is, so a config edited by hand cannot deploy something
 *  else; the message is the version's, shown in the account. */
function deployCommand({ target = 'workers', out, project, message = '', node = 'node', wranglerJs = 'node_modules/wrangler/bin/wrangler.js', config = 'wrangler.jsonc', netlifyBin = 'netlify', extra = [] }) {
    if (target === 'netlify') return { cmd: netlifyBin, args: ['deploy', '--prod', '--dir', out, '--message', message, ...extra] };
    if (target !== 'workers') throw new Error(`unknown deploy target ${JSON.stringify(target)} (workers or netlify)`);
    if (!project || !/^[a-z0-9][a-z0-9-]{0,56}[a-z0-9]$/.test(project)) throw new Error(`no usable project name (${JSON.stringify(project)}): set "pagesProject" in public/site.config.json or pass --project`);
    return { cmd: node, args: [wranglerJs, 'deploy', '--config', config, '--name', project, '--assets', out, '--message', message, ...extra] };
}

/** The newest Node that can run wrangler (>= 22) among `candidates` ([{ version: 'v22.23.3', path }]); the current
 *  one if it qualifies. -> path or null. */
function pickNode(current, candidates) {
    const major = (v) => Number(String(v).replace(/^v/, '').split('.')[0]) || 0;
    if (major(current.version) >= 22) return current.path;
    const cmp = (a, b) => { const x = a.version.replace(/^v/, '').split('.').map(Number), y = b.version.replace(/^v/, '').split('.').map(Number); return (y[0] - x[0]) || (y[1] - x[1]) || (y[2] - x[2]); };
    const ok = (candidates || []).filter((c) => major(c.version) >= 22).sort(cmp);
    return ok.length ? ok[0].path : null;
}

// ------------------------------------------------------------------ gates
/** Drafts in the output: for every post that is not published, no page, and no mention in the list, feed or manifest.
 *  allPosts: [{ slug, title, draft }] (every .md in the repo); files: { 'blog/x.html': '<html>', 'feed.xml': ..., 'snapshot.json': ... }. */
function draftLeaks(allPosts, files) {
    const published = new Set(publishedOnly(allPosts).map((p) => p.slug));
    const leaks = [];
    for (const p of allPosts || []) {
        if (published.has(p.slug)) continue;
        if (Object.prototype.hasOwnProperty.call(files, `blog/${p.slug}.html`)) leaks.push(`draft page written: blog/${p.slug}.html`);
        for (const [name, body] of Object.entries(files)) {
            if (!/\.(html|xml|json)$/.test(name)) continue;
            const text = String(body);
            if (text.includes(`/blog/${p.slug}"`) || text.includes(`/blog/${p.slug}<`) || text.includes(`"slug":"${p.slug}"`)) leaks.push(`draft "${p.slug}" referenced in ${name}`);
        }
    }
    return leaks;
}

// Strings that must not be in ANY file of the build: filesystem roots, private and tailnet addresses, the rig's host name.
const LEAK_ANYWHERE = [
    ['home directory path', /\/home\/[\w.-]+/],
    ['model store path', /\/data\/models/],
    ['HF cache path', /\.cache\/huggingface/],
    ['private IPv4', /\b(?:10\.\d{1,3}|192\.168|172\.(?:1[6-9]|2\d|3[01])|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\.\d{1,3}\.\d{1,3}\b/],
    ['tailnet IPv6', /\bfd7a:[0-9a-f]{1,4}:/i],
    ['host name', /\bpop-os\b/i],
];
// JSON keys that must not be in the DATA files: lib/publicdata.js DROP_KEYS, re-checked on the output.
const LEAK_DATA_KEYS = ['story', 'probes', 'weak_model_failure', 'incident_date', 'sources', 'prompt', 'prompts', 'transcript', 'transcript_tail', 'patch', 'diff',
    'stderrTail', 'stdout', 'stderr', 'env', 'environment', 'token', 'password', 'ssh', 'user_note',
    // runs that asked (lib/publicdata.js, 2026-10-19): the question texts and notes stay in the lab
    'askedAnswerable', 'answeredNotes', 'unfinishedNotes', 'unfinishedRuns'];

/** Private material in one output file -> [{ what, sample }]. `isData` = a JSON data file (keys checked too). */
function leakScan(name, text, { isData = /\.json$/.test(name) } = {}) {
    const hits = [];
    const s = String(text);
    for (const [what, re] of LEAK_ANYWHERE) {
        const m = re.exec(s);
        if (m) hits.push({ file: name, what, sample: s.slice(Math.max(0, m.index - 30), m.index + 50).replace(/\s+/g, ' ') });
    }
    if (isData) {
        for (const k of LEAK_DATA_KEYS) {
            const i = s.indexOf(`"${k}":`);
            if (i >= 0) hits.push({ file: name, what: `dropped key "${k}"`, sample: s.slice(Math.max(0, i - 30), i + 50) });
        }
        if (/password/i.test(s)) hits.push({ file: name, what: 'the word "password"', sample: s.slice(Math.max(0, s.search(/password/i) - 30), s.search(/password/i) + 40) });
    }
    return hits;
}

module.exports = {
    ASSET_FILES, ICON_FILES, STATIC_ONLY, SECTIONS, assetHash, versionHtml, relativeImports, missingImports, publishedOnly, routeFiles, redirectRules, headerRules, csp,
    netlifyToml, redirectsFile, headersFile, pagesLimitProblems, PAGES_LIMITS, ruleMatches, resolveRequest, headersFor, staticPage, referencedImages, statsFromCatalog, modelFile, liveRecord, snapshotManifest, contentHash,
    deployDecision, deployCommand, pickNode, draftLeaks, leakScan, LEAK_DATA_KEYS, NO_CACHE, IMMUTABLE, sha1,
};
