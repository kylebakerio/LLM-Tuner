// ai lab -- the public, read-only site (lab.kylebaker.io; it was ai.kylebaker.io until 2026-10-22). 2026-10-02.
//
// A SEPARATE process from the dashboard (server4.js, ai.kylebaker.io; lab.kylebaker.io until 2026-10-22). It has no
// route to the dashboard and no write path of any kind: GET/HEAD only, an explicit allowlist of files and endpoints,
// everything else 404.
// It builds the Models catalog itself from the same read-only libraries the dashboard uses, then passes it
// through lib/publicdata.js (task names public, task content / paths / addresses never). Live status comes
// from a snapshot FILE the dashboard writes (logs/public-live.json) -- the dashboard is never called.
//
// Every expensive answer is cached and rebuilt in the background, so public traffic can't make this machine
// re-read the request log or the results tree on demand.
//
// Run: node public/server.js  (pm2: `public`, see ecosystem.config.js). PUBLIC_PORT (default 3100).

process.env.BENCH_DB_READONLY = '1';   // lib/db.js: read-only handle, no schema/pragma writes -- before anything requires it
const http = require('http');
const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const DASH = path.join(__dirname, '..');                 // the dashboard dir (libraries, vendor/, ui/)
const ROOT = path.join(DASH, '..');                      // experiment-1 (logs/)
const SITE = __dirname;                                  // public/ (index.html, assets/)
const PORT = Number(process.env.PUBLIC_PORT) || 3100;
const HOST = process.env.PUBLIC_HOST || '0.0.0.0';
const POSTS_DIR = process.env.POSTS_DIR || path.join(os.homedir(), 'code', 'ai-lab-posts', 'posts');
const LIVE_FILE = path.join(ROOT, 'logs', 'public-live.json');
const LIVE_WANT = path.join(ROOT, 'logs', 'public-live.want');

// The shared dashboard code (row rules, catalog, sanitising). Loaded through loadShared() so it can be loaded AGAIN
// when the lab dashboard has moved to newer code -- see ensureFresh() below (2026-10-09, Kyle: the public site and
// the lab "should not be able to get out of sync"; "check on load whether the data still has the same hash, and if
// not, load the fresh data").
let modelsModel, modelScan, sanitizeCatalog, sanitizePayload, liveRunning, codeStamp, strengthBoot, loadedStamp = null;
let epoch = 0;   // bumped on every reload: every cached() value built by older code is rebuilt on its next use
function loadShared() {
    const lib = path.join(DASH, 'lib') + path.sep;
    for (const k of Object.keys(require.cache)) if (k.startsWith(lib)) delete require.cache[k];
    modelsModel = require(path.join(DASH, 'lib', 'models'));
    modelScan = require(path.join(DASH, 'lib', 'modelscan'));
    ({ sanitizeCatalog, sanitizePayload, liveRunning } = require(path.join(DASH, 'lib', 'publicdata')));
    codeStamp = require(path.join(DASH, 'lib', 'codestamp'));
    strengthBoot = require(path.join(DASH, 'lib', 'strengthboot'));   // read-only here: the cache the dashboard writes
    loadedStamp = codeStamp.LOADED;
}
loadShared();
/** Called when data is asked for: if the lab dashboard runs different shared code than this process loaded, and the
 *  files on disk are that code, load it here too and drop everything built with the old code. One small file read
 *  per call; the files are hashed only when the stamps differ. Never ahead of the lab: if the disk has changed but
 *  the dashboard has not been restarted onto it, nothing happens. */
function ensureFresh() {
    try {
        const lab = codeStamp.readStamp();
        if (!lab || lab === loadedStamp || codeStamp.diskStamp() !== lab) return;
        const was = loadedStamp;
        loadShared(); epoch++; modelDetail.clear();
        console.log(`[codestamp] shared code ${was} -> ${loadedStamp} (the lab dashboard's): reloaded, data rebuilds on next use`);
    } catch (e) { console.warn('[codestamp] check failed:', e.message); }
}
const posts = require('./posts');
const liveApi = require('./liveapi');

// ------------------------------------------------------------------ static allowlist
// Exact files only (no directory serving): the site, the vendored libraries, and the Results-page modules.
const SITE_ICONS = ['favicon.ico', 'favicon.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png'];
const STATIC = new Map([
    ['/assets/site.css', path.join(SITE, 'assets', 'site.css')],
    ['/assets/site.js', path.join(SITE, 'assets', 'site.js')],
    ['/assets/live.js', path.join(SITE, 'assets', 'live.js')],
    ['/assets/ga.js', path.join(SITE, 'assets', 'ga.js')],
    ['/vendor/tailwind.css', path.join(DASH, 'vendor', 'tailwind.css')],
    ['/vendor/fonts.css', path.join(DASH, 'vendor', 'fonts.css')],
    ['/vendor/chart.js', path.join(DASH, 'vendor', 'chart.js')],
    ['/vendor/marked.min.js', path.join(DASH, 'vendor', 'marked.min.js')],
    ...['ui/shared/theme.js', 'ui/shared/modelname.js', 'ui/shared/ctxlabel.js', 'ui/shared/poll.js', 'ui/shared/leaderboard.js', 'ui/shared/todos.js', 'ui/shared/loadbar.js', 'ui/benchmarks/util.js', 'ui/benchmarks/transcript.js',
        'ui/models/index.js', 'ui/models/charts.js', 'ui/models/detail.js', 'ui/models/task.js', 'ui/models/prefill.js']
        .map((p) => ['/' + p, path.join(DASH, p)]),
    // the KBIO icons (2026-10-22; the set and make.py are in experiment-1/favicon-kbio/): at the root, where browsers
    // look for /favicon.ico and /apple-touch-icon.png on their own; the files live in assets/
    ...SITE_ICONS.map((f) => ['/' + f, path.join(SITE, 'assets', f)]),
]);
let assetHashCache = { at: 0, v: '0' };
function assetHash() {   // hash over the mtimes of every versioned file (re-read at most every 3 s)
    if (Date.now() - assetHashCache.at < 3000) return assetHashCache.v;
    const h = require('crypto').createHash('sha1');
    for (const [k, f] of STATIC) { if (!/^\/(ui|assets)\//.test(k)) continue; try { h.update(k + ':' + fs.statSync(f).mtimeMs); } catch { h.update(k); } }
    assetHashCache = { at: Date.now(), v: h.digest('hex').slice(0, 12) };
    return assetHashCache.v;
}
const versioned = (html) => { const v = assetHash(); return String(html).replace(/(src|href)="\/(ui|assets)\//g, (_m, a, d) => `${a}="/v/${v}/${d}/`); };
const TYPES = { '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.xml': 'application/rss+xml; charset=utf-8', '.txt': 'text/plain; charset=utf-8',
    '.ico': 'image/x-icon', '.png': 'image/png', '.svg': 'image/svg+xml' };

// ------------------------------------------------------------------ cached data
// A value rebuilt in the background at most every `ttl` ms; requests always get the last good value.
function cached(ttl, build) {
    let value = null, at = 0, busy = null, seen = epoch;
    const refresh = () => {
        if (busy) return busy;
        busy = Promise.resolve().then(build).then((v) => { value = v; at = Date.now(); }).catch((e) => { console.warn('[public] rebuild failed:', e.message); })
            .finally(() => { busy = null; });
        return busy;
    };
    return async () => {
        if (seen !== epoch) { seen = epoch; value = null; }   // built by code that has since been replaced
        if (!value) await refresh();
        else if (Date.now() - at > ttl) refresh();
        return value;
    };
}

function modelRoots() {
    // the same roots as the dashboard's (server4.js modelRoots): `modelsRoot`, then `modelDirs`, written with ~ or
    // ${ROOT} if the config does (lib/paths.js; an absolute path is used as it is)
    let extra = [];
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(DASH, 'dashboard.config.json'), 'utf8'));
        const P = require(path.join(DASH, 'lib', 'paths'));
        const ctx = P.context(cfg);
        extra = [ctx.modelsRoot, ...(Array.isArray(cfg.modelDirs) ? cfg.modelDirs : []).filter((d) => typeof d === 'string' && d.trim()).map((d) => P.expand(d.trim(), ctx))].filter(Boolean);
    } catch { /* none */ }
    const hf = process.env.HF_HOME || process.env.HUGGINGFACE_HUB_CACHE || path.join(os.homedir(), '.cache', 'huggingface', 'hub');
    return [{ dir: path.join(ROOT, 'models'), source: 'local' }, { dir: '/data/models', source: 'local' }, { dir: hf, source: 'huggingface' },
        ...extra.map((dir) => ({ dir, source: 'local' }))];
}

const catalog = cached(180000, async () => {   // listModels() reads the whole request log: at most every 3 min
    let out = modelsModel.listModels();
    try { out = modelScan.fillDiskBytes(out, await modelScan.scanModelDirs(modelRoots()), (p) => modelsModel.canonicalModel(p).key); } catch { /* sizes optional */ }
    // the strength bootstrap the dashboard caches (lib/strengthboot.js, logs/strength-bootstrap.json; 2026-10-25), so the
    // public pages -- and the static site's data/catalog.json -- show the same ranges; sanitized with the rest (its row
    // keys are scrubbed exactly as the configs' facets are, so they still match the rows the page builds)
    strengthBoot.attach(out);
    return JSON.stringify(sanitizeCatalog(out));
});

const modelDetail = new Map();   // key -> cached()
function detailFor(key) {
    if (!modelDetail.has(key)) {
        if (modelDetail.size > 500) modelDetail.clear();
        modelDetail.set(key, cached(60000, () => { const m = modelsModel.getModel(key); return m ? JSON.stringify(sanitizePayload(m)) : null; }));
    }
    return modelDetail.get(key)();
}

// The batteries running now come from the dashboard's snapshot too: lib/codebench.js scanBatteries() rewrites
// battery.json for a battery whose process has died, and this process must never write.
async function running() {
    const snap = JSON.parse(await liveSnapshot());
    return JSON.stringify({ running: (snap.running || []).map(({ dir, task, tasks, runner, state }) => ({ dir, task, tasks, runner, state })) });
}

// battery dir -> the model it runs (display name), from the public catalog: the live page names models, not labels.
const batteryModels = cached(180000, async () => {
    const cat = JSON.parse(await catalog());
    const map = {};
    for (const m of cat.models || []) for (const b of m.batteries || []) if (b && b.dir) map[b.dir] = m.display;
    return map;
});

// A few headline counts for the landing page (so it needn't download the 2 MB catalog).
const stats = cached(180000, async () => {
    const cat = JSON.parse(await catalog());
    const models = cat.models || [];
    const withQuality = models.filter((m) => m.counts && m.counts.qualityTasks > 0);
    return JSON.stringify({
        models: models.length, withQuality: withQuality.length,
        local: withQuality.filter((m) => m.provider !== 'cloud').length, cloud: withQuality.filter((m) => m.provider === 'cloud').length,
        tasks: cat.taskTotal || 0, batteries: models.reduce((a, m) => a + ((m.counts && m.counts.qualityBatteries) || 0), 0),
        taskRuns: models.reduce((a, m) => a + ((m.counts && m.counts.qualityTasks) || 0), 0),
        requests: models.reduce((a, m) => a + ((m.counts && m.counts.requests) || 0), 0), generatedAt: cat.generatedAt || null,
    });
});

// Live lanes: read the dashboard's snapshot; touching the want-marker tells the dashboard someone is watching.
// Each running battery is copied field by field (publicdata.liveRunning): its label, runner, current task name and
// progress, and from the snapshot's `items` the question its queue item answers and the passed / failed / excluded /
// remaining counts (2026-10-07). Nothing else from the queue can get through, whatever the snapshot grows later.
let wantTouchedAt = 0;
async function liveSnapshot() {
    if (Date.now() - wantTouchedAt > 5000) {
        wantTouchedAt = Date.now();
        fsp.writeFile(LIVE_WANT, String(Date.now())).catch(() => {});
    }
    try {
        const raw = await fsp.readFile(LIVE_FILE, 'utf8');
        const j = JSON.parse(raw);
        const names = await batteryModels().catch(() => ({}));
        const items = j.items && typeof j.items === 'object' ? j.items : {};
        const running = (j.running || []).map((r) => liveRunning(r, Object.prototype.hasOwnProperty.call(items, r.dir) ? items[r.dir] : null, (names || {})[r.dir]));
        return JSON.stringify(sanitizePayload({ at: j.at || 0, lanes: j.lanes || [], running, stale: !(Date.now() - (j.at || 0) < 30000) }));
    } catch { return JSON.stringify({ at: 0, stale: true, lanes: [], running: [] }); }
}

// ------------------------------------------------------------------ http
const SECURITY_HEADERS = {
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'strict-origin-when-cross-origin',
    'X-Frame-Options': 'DENY',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
};
// No inline script and no third-party script -- except Google's tag + analytics endpoints, and only while
// site.config.json has a gaMeasurementId. Ko-fi is a plain link, not their widget.
function csp() {
    const ga = !!posts.siteConfig().gaMeasurementId;
    const gaScript = ga ? ' https://www.googletagmanager.com' : '';
    const gaConnect = ga ? ' https://*.google-analytics.com https://*.analytics.google.com https://*.googletagmanager.com' : '';
    return `default-src 'self'; script-src 'self'${gaScript}; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; connect-src 'self'${gaConnect}; frame-ancestors 'none'; base-uri 'self'; form-action 'none'`;
}
function send(res, code, body, type, extra = {}) {
    res.writeHead(code, { 'Content-Type': type || 'text/plain; charset=utf-8', ...SECURITY_HEADERS, 'Content-Security-Policy': csp(), ...extra });
    res.end(body);
}
const json = (res, body, maxAge = 30) => send(res, 200, body, 'application/json', { 'Cache-Control': `public, max-age=${maxAge}` });

async function handle(req, res) {
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method Not Allowed', null, { Allow: 'GET, HEAD' });
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;

    // Cross-origin reads of the JSON API, for the static build of this site on another origin (STATIC-ARCHITECTURE.md).
    // Off unless site.config.json has "corsOrigins" (or PUBLIC_CORS_ORIGINS is set): with no list this adds nothing.
    if (p.startsWith('/api/')) {
        ensureFresh();
        const cors = liveApi.corsHeaders(req.headers.origin, liveApi.parseOrigins(process.env.PUBLIC_CORS_ORIGINS, posts.siteConfig().corsOrigins));
        for (const [k, v] of Object.entries(cors)) res.setHeader(k, v);
    }

    // /live was its own page until 2026-10-10 (Kyle: "a duplicate of the stuff that we already have on home"): old links land on the overview
    if (p === '/live' || p === '/live/') return send(res, 302, '', null, { Location: '/' });
    if (p === '/' || p === '/index.html' || p === '/results' || p === '/writing' || p === '/about' || /^\/models(\/|$)/.test(p)) {
        return send(res, 200, versioned(await posts.shell({ path: p })), TYPES['.html'], { 'Cache-Control': 'no-cache' });
    }
    if (p === '/blog' || p === '/blog/') return send(res, 200, versioned(await posts.shell({ path: '/writing' })), TYPES['.html'], { 'Cache-Control': 'no-cache' });
    const m = /^\/blog\/([a-z0-9-]+)\/?$/.exec(p);
    if (m) {
        const html = await posts.postPage(m[1]);
        return html ? send(res, 200, versioned(html), TYPES['.html'], { 'Cache-Control': 'no-cache' }) : send(res, 404, await posts.notFound(), TYPES['.html']);
    }
    if (p === '/feed.xml') return send(res, 200, await posts.feed(), TYPES['.xml'], { 'Cache-Control': 'public, max-age=300' });
    if (p === '/robots.txt') return send(res, 200, 'User-agent: *\nAllow: /\n', TYPES['.txt']);

    if (p === '/api/models/catalog') {
        // X-Body-Length: the size the Results page's loading bar fills against (ui/benchmarks/util.js createCatalogStore).
        // Not Content-Length: Cloudflare compresses this on the way out and drops that header; its own pass through.
        const body = await catalog();
        return send(res, 200, body, 'application/json', { 'Cache-Control': 'public, max-age=60', 'X-Body-Length': String(Buffer.byteLength(body)) });
    }
    if (p === '/api/models/running') return json(res, await running(), 15);
    if (p === '/api/model') {
        const key = u.searchParams.get('key');
        if (!key || key.length > 300) return send(res, 400, '{"error":"key is required"}', 'application/json');
        const body = await detailFor(key);
        return body ? json(res, body, 60) : send(res, 404, '{"error":"no such model"}', 'application/json');
    }
    if (p === '/api/live') return json(res, await liveSnapshot(), 2);
    if (p === '/api/stats') return json(res, await stats(), 120);
    if (p === '/api/posts') return json(res, JSON.stringify(await posts.index()), 60);

    // Versioned assets (2026-10-03, Kyle: "you didn't deploy it to the public site"): Cloudflare rewrites our
    // no-cache into a 31-day browser cache, so a changed module kept being served stale. Pages reference every
    // site/UI module under /v/<hash>/..., where <hash> covers all their mtimes; relative imports inside the modules
    // resolve under the same prefix. Any change -> new URLs for all of them; unchanged -> cached forever, safely.
    const vm = /^\/v\/[0-9a-f]{6,16}(\/(?:ui|assets)\/.+)$/.exec(p);
    if (vm && STATIC.has(vm[1])) {
        try { return send(res, 200, await fsp.readFile(STATIC.get(vm[1])), TYPES[path.extname(vm[1])] || 'application/octet-stream', { 'Cache-Control': 'public, max-age=31536000, immutable' }); }
        catch { return send(res, 404, 'Not found'); }
    }
    if (STATIC.has(p)) {
        const file = STATIC.get(p);
        try {
            const body = await fsp.readFile(file);
            return send(res, 200, body, TYPES[path.extname(file)] || 'application/octet-stream', { 'Cache-Control': p.startsWith('/vendor/') || SITE_ICONS.includes(p.slice(1)) ? 'public, max-age=86400' : 'no-cache' });
        } catch { return send(res, 404, 'Not found'); }
    }
    const img = /^\/blog-images\/([\w.-]+\.(?:png|jpe?g|webp|gif|svg))$/i.exec(p);
    if (img) {
        const file = path.join(POSTS_DIR, '..', 'images', img[1]);
        try { return send(res, 200, await fsp.readFile(file), { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', svg: 'image/svg+xml' }[img[1].split('.').pop().toLowerCase()], { 'Cache-Control': 'public, max-age=86400' }); }
        catch { return send(res, 404, 'Not found'); }
    }
    return send(res, 404, await posts.notFound(), TYPES['.html']);
}

// Posts come from a clone of the private posts repo; pull it now and then (fast-forward only) so a post
// committed by the editor appears without a restart. Drafts never leave posts.js.
function pullPosts() {
    execFile('git', ['-C', path.join(POSTS_DIR, '..'), 'pull', '--ff-only', '--quiet'], { timeout: 30000 }, () => posts.invalidate());
}
setInterval(pullPosts, 5 * 60 * 1000).unref();

const server = http.createServer((req, res) => {
    handle(req, res).catch((e) => { console.error('[public]', e); try { send(res, 500, 'Internal error'); } catch { /* sent */ } });
});
server.listen(PORT, HOST, () => console.log(`ai lab (public) on http://${HOST}:${PORT}`));
catalog();   // warm the cache

console.log(`[codestamp] lib ${loadedStamp}`);

