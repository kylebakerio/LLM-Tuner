// Posts for the public site: the reading half of the GitHub-backed blog (the earlyroots design, 2026-10-02).
//
// Source of truth is the PRIVATE repo kylebakerio/ai-lab-posts, cloned at ~/code/ai-lab-posts. Each post is
// posts/<slug>.md with front matter:
//
//   ---
//   title: "Ternary is real"
//   date: "2026-09-21"
//   tags: ["quantization", "bonsai"]
//   summary: "One line for the list and the social card."
//   draft: true
//   updatedAt: 1790900000000
//   ---
//   markdown body
//
// `draft: true` posts are never read past this file: not listed, not routed, not in the feed (Kyle: drafts
// stay hidden until flipped). The editor that writes posts lives in the password-gated dashboard and commits
// through the GitHub API; server.js pulls the clone every few minutes.
//
// Rendering happens here, server side, so every post has a real URL with Open Graph tags for link previews
// (build-blog.js did this for earlyroots at build time).
//
// The same repo holds ONE document that is not a post: pages/home.md, the copy at the top of the home page
// (2026-10-07, Kyle: "I need to be able to edit the home page copy from the blog-editor interface"). It sits beside
// posts/, not in it, so nothing that lists posts can pick it up. See "the home page's copy" below.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { marked } = require(path.join(__dirname, '..', 'vendor', 'marked.min.js'));

const POSTS_DIR = process.env.POSTS_DIR || path.join(os.homedir(), 'code', 'ai-lab-posts', 'posts');
const HOME_FILE = path.join(POSTS_DIR, '..', 'pages', 'home.md');
const SITE_CONFIG = path.join(__dirname, 'site.config.json');
// og:url and the feed's links and guids. ai.kylebaker.io until 2026-10-22, when the names swapped (ai.* is the private
// dashboard now): a feed reader sees the published posts once more, under their new links.
const ORIGIN = process.env.PUBLIC_ORIGIN || 'https://lab.kylebaker.io';

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Minimal front matter: `key: value` lines; values may be quoted strings, numbers, booleans, or a JSON / `- item` list. */
function parseFrontMatter(text) {
    const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
    if (!m) return { data: {}, body: text };
    const data = {};
    let listKey = null;
    for (const line of m[1].split(/\r?\n/)) {
        const item = /^\s*-\s+(.*)$/.exec(line);
        if (item && listKey) { data[listKey].push(unquote(item[1])); continue; }
        const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
        if (!kv) continue;
        const [, k, raw] = kv;
        listKey = null;
        if (raw === '') { data[k] = []; listKey = k; continue; }
        if (/^\[.*\]$/.test(raw)) { try { data[k] = JSON.parse(raw.replace(/'/g, '"')); continue; } catch { /* fall through */ } }
        if (raw === 'true' || raw === 'false') { data[k] = raw === 'true'; continue; }
        if (/^-?\d+(\.\d+)?$/.test(raw)) { data[k] = Number(raw); continue; }
        data[k] = unquote(raw);
    }
    return { data, body: m[2] };
}
function unquote(s) {
    s = String(s).trim();
    if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) return s.slice(1, -1).replace(/\\"/g, '"');
    return s;
}

let cache = null, cacheAt = 0;
let homeCache = null, homeAt = 0;
function invalidate() { cache = null; homeCache = null; }
async function load() {
    if (cache && Date.now() - cacheAt < 60000) return cache;
    const out = [];
    let names = [];
    try { names = (await fsp.readdir(POSTS_DIR)).filter((f) => /^[a-z0-9-]+\.md$/.test(f)); } catch { /* no clone yet */ }
    for (const f of names) {
        try {
            const { data, body } = parseFrontMatter(await fsp.readFile(path.join(POSTS_DIR, f), 'utf8'));
            if (data.draft !== false) continue;          // drafts -- and anything not explicitly published -- stay private
            const slug = f.replace(/\.md$/, '');
            out.push({ slug, title: data.title || slug, date: String(data.date || ''), tags: Array.isArray(data.tags) ? data.tags : [],
                summary: data.summary || '', updatedAt: data.updatedAt || null, body });
        } catch { /* a broken file is skipped, not served */ }
    }
    out.sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.title.localeCompare(b.title));
    cache = out; cacheAt = Date.now();
    return out;
}

async function index() {
    return (await load()).map(({ body, ...p }) => p);
}

function siteConfig() {
    try { return JSON.parse(fs.readFileSync(SITE_CONFIG, 'utf8')); } catch { return {}; }
}

// ------------------------------------------------------------------ the home page's copy
// pages/home.md in the posts repo:
//
//   ---
//   title: "The headline (the page's h1)"
//   kicker: "the small line above it"
//   updatedAt: 1790900000000
//   ---
//   The intro, in markdown (rendered exactly as a post's body is).
//
// Written by the same editor and the same save path as posts (lib/postsrepo.js). HOME_DEFAULT is the text the page
// had before the document existed: it is the document's first content, what the editor opens with when there is no
// file yet, and what is served whenever the file is missing or unusable -- the home page never renders empty.
// (assets/site.js keeps the same text as its own last resort, for a page shell that carries no copy at all;
// test/publichome.test.js holds the two together.)
const HOME_DEFAULT = Object.freeze({
    kicker: 'local models · consumer GPUs · real bugs',
    title: 'a little local LLM homelab',
    body: 'One desktop — two RX 7900 XTX, 48 GB of VRAM between them — running open-weight models against bugs from my own git history: check out the commit before the fix, hand the agent the original report, and score it on the hidden test the real fix made pass. Speed, quality and cost are all measured, and the tasks stay private so they can\'t leak into anyone\'s training data. [The results](/results) are all here, and whatever is running right now is shown below.',
});

/** The text of pages/home.md -> { kicker, title, body, updatedAt, source }. source 'document': the file's own text
 *  (a missing headline or an empty intro is filled from HOME_DEFAULT; an empty kicker is allowed: no kicker line).
 *  source 'builtin': there is no front matter to read, so none of it is trusted. */
function parseHome(text) {
    const raw = String(text ?? '');
    if (!/^---\r?\n[\s\S]*?\r?\n---(\r?\n|$)/.test(raw)) return { ...HOME_DEFAULT, updatedAt: null, source: 'builtin' };
    const { data, body } = parseFrontMatter(raw);
    const str = (v) => (typeof v === 'string' ? v.trim() : '');
    return { kicker: typeof data.kicker === 'string' ? data.kicker.trim() : HOME_DEFAULT.kicker, title: str(data.title) || HOME_DEFAULT.title,
        body: str(body) || HOME_DEFAULT.body, updatedAt: data.updatedAt || null, source: 'document' };
}

/** The home document as it is on disk now (cached with the posts), or the built-in text. Never throws. */
async function homeDoc() {
    if (homeCache && Date.now() - homeAt < 60000) return homeCache;
    let doc;
    try { doc = parseHome(await fsp.readFile(HOME_FILE, 'utf8')); } catch { doc = { ...HOME_DEFAULT, updatedAt: null, source: 'builtin' }; }
    homeCache = doc; homeAt = Date.now();
    return doc;
}

/** The copy block at the top of the home page, as HTML: kicker and headline escaped, the intro through marked like a
 *  post body. An intro that renders to nothing readable falls back to the built-in one. Never throws. */
function homeHtml(doc) {
    const d = { ...HOME_DEFAULT, ...(doc && typeof doc === 'object' ? doc : {}) };
    const str = (v) => (typeof v === 'string' ? v.trim() : '');
    const text = (h) => String(h).replace(/<[^>]*>/g, '').trim();
    let intro = '';
    try { intro = marked.parse(str(d.body)); } catch { intro = ''; }
    if (!text(intro)) intro = marked.parse(HOME_DEFAULT.body);
    const title = str(d.title) || HOME_DEFAULT.title;
    const kicker = str(d.kicker);
    return `${kicker ? `<div class="site-kicker">${esc(kicker)}</div>` : ''}<h1 class="site-h1">${esc(title)}</h1><div class="site-lede">${intro}</div>`;
}

const NAV = [['/', 'overview'], ['/results', 'results'], ['/writing', 'writing'], ['/about', 'about']];

/** The page shell. `main` is server-rendered content (a post); without it the client fills the section. */
async function shell({ path: p = '/', title = 'ai lab', description, main = '', ogType = 'website', canonical } = {}) {
    const cfg = siteConfig();
    // The home page's copy rides in every section shell (the client can show the overview from any of them); a
    // server-rendered page (a post, the 404) never draws it. Left out if anything goes wrong: site.js has the text too.
    let home = '';
    if (!main) { try { home = `\n<script id="site-home" type="application/json">${JSON.stringify({ html: homeHtml(await homeDoc()) }).replace(/</g, '\\u003c')}</script>`; } catch { home = ''; } }
    const desc = description || cfg.description || 'Local LLMs on consumer GPUs, measured: speed, quality on private coding tasks, and what each costs.';
    const active = (href) => (href === '/' ? p === '/' : p === href || p.startsWith(href + '/') || (href === '/writing' && p.startsWith('/blog')) || (href === '/results' && p.startsWith('/models')));
    return `<!DOCTYPE html>
<html lang="en" class="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:type" content="${ogType}">
<meta property="og:url" content="${esc(ORIGIN + (canonical || p))}">
<meta name="twitter:card" content="summary">
<link rel="alternate" type="application/rss+xml" title="ai lab" href="/feed.xml">
<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="stylesheet" href="/vendor/fonts.css">
<link rel="stylesheet" href="/vendor/tailwind.css">
<link rel="stylesheet" href="/assets/site.css">
${cfg.gaMeasurementId ? `<script async src="https://www.googletagmanager.com/gtag/js?id=${esc(cfg.gaMeasurementId)}"></script><script src="/assets/ga.js"></script>` : ''}
<script src="/vendor/chart.js"></script>
<script src="/ui/shared/theme.js"></script>
<script src="/vendor/marked.min.js"></script>
</head>
<body class="site" data-path="${esc(p)}">
<header class="site-head">
  <div class="site-wrap site-head-row">
    <a href="/" class="site-mark"><span class="site-dot"></span>ai lab</a>
    <nav class="site-nav">${NAV.map(([href, label]) => `<a href="${href}" class="${active(href) ? 'is-on' : ''}">${label}</a>`).join('')}</nav>
  </div>
</header>
<main id="site-main" class="site-wrap">${main}</main>
<footer class="site-foot site-wrap">
  <span>Measured on one desktop. Numbers move as runs land.</span>
  <span class="site-foot-links">${cfg.homepage ? `<a href="${esc(cfg.homepage)}">${esc(cfg.homepageLabel || 'kylebaker.io')}</a>` : ''}${cfg.github ? `<a href="${esc(cfg.github)}">github</a>` : ''}${cfg.kofi ? `<a href="${esc(cfg.kofi)}">buy me a coffee</a>` : ''}<a href="/feed.xml">rss</a></span>
</footer>
<script id="site-config" type="application/json">${JSON.stringify({ kofi: cfg.kofi || null, homepage: cfg.homepage || null, github: cfg.github || null, contact: cfg.contact || null, ga: cfg.gaMeasurementId || null }).replace(/</g, '\\u003c')}</script>${home}
<script type="module" src="/assets/site.js"></script>
</body>
</html>`;
}

function readingTime(body) { return Math.max(1, Math.round(String(body).split(/\s+/).length / 230)); }

async function postPage(slug) {
    const post = (await load()).find((x) => x.slug === slug);
    if (!post) return null;
    const html = marked.parse(post.body);
    const main = `<article class="post">
  <a href="/writing" class="post-back">← writing</a>
  <h1 class="post-title">${esc(post.title)}</h1>
  <div class="post-meta">${esc(post.date)} · ${readingTime(post.body)} min${post.tags.length ? ' · ' + post.tags.map((t) => `<span class="post-tag">${esc(t)}</span>`).join(' ') : ''}</div>
  <div class="prose post-body">${html}</div>
</article>`;
    return shell({ path: `/blog/${slug}`, title: `${post.title} · ai lab`, description: post.summary || undefined, main, ogType: 'article' });
}

async function notFound() {
    return shell({ path: '/404', title: 'not found · ai lab', main: '<div class="site-empty">Nothing here. <a href="/">Back to the lab</a>.</div>' });
}

async function feed() {
    const items = (await load()).slice(0, 30).map((p) => `<item><title>${esc(p.title)}</title><link>${ORIGIN}/blog/${p.slug}</link><guid>${ORIGIN}/blog/${p.slug}</guid>${p.date ? `<pubDate>${new Date(p.date + 'T12:00:00Z').toUTCString()}</pubDate>` : ''}<description>${esc(p.summary || '')}</description></item>`).join('');
    return `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>ai lab</title><link>${ORIGIN}</link><description>Local LLMs on consumer GPUs, measured.</description>${items}</channel></rss>`;
}

/** The standalone page the dashboard's editor previews in (served behind the dashboard's password gate, never by
 *  public/server.js): the public site's frame with site.css inlined, a label where the nav would be. */
function previewPage(title, label, main) {
    let css = '';
    try { css = fs.readFileSync(path.join(__dirname, 'assets', 'site.css'), 'utf8'); } catch { /* unstyled */ }
    return `<!DOCTYPE html><html lang="en" class="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>preview · ${esc(title)}</title>
<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="stylesheet" href="/vendor/fonts.css"><link rel="stylesheet" href="/vendor/tailwind.css"><style>${css}</style></head>
<body class="site"><header class="site-head"><div class="site-wrap site-head-row"><span class="site-mark"><span class="site-dot"></span>ai lab</span>
<span class="site-nav"><span style="color:#fbbf24;font-size:12px">${esc(label)}</span></span></div></header>
<main id="site-main" class="site-wrap">${main}</main></body></html>`;
}

/** A post rendered as it will look on the public site, drafts included -- for the editor preview only. */
function previewHtml(post) {
    return previewPage(post.title, post.draft ? 'DRAFT PREVIEW — not public' : 'preview (published)', `<article class="post"><h1 class="post-title">${esc(post.title)}</h1>
<div class="post-meta">${esc(post.date)} · ${readingTime(post.body)} min${(post.tags || []).length ? ' · ' + post.tags.map((t) => `<span class="post-tag">${esc(t)}</span>`).join(' ') : ''}</div>
<div class="prose post-body">${marked.parse(post.body || '')}</div></article>`);
}

/** The home page's copy as the public site will show it (unsaved editor content: { title, kicker, body }), with a
 *  line standing in for what the page draws under it. Empty fields show what the site would fall back to. */
function homePreviewHtml(doc) {
    const d = doc || {};
    const shown = { kicker: typeof d.kicker === 'string' ? d.kicker : HOME_DEFAULT.kicker, title: String(d.title || '').trim() || HOME_DEFAULT.title, body: String(d.body || '').trim() || HOME_DEFAULT.body };
    return previewPage('home page', 'HOME PAGE PREVIEW', `<section>${homeHtml(shown)}
<div class="site-section"><div class="site-empty" style="padding:1.25rem 0;text-align:left;border-top:1px solid var(--border)">the headline numbers, “testing now” and the latest posts follow here</div></div></section>`);
}

module.exports = { siteConfig, parseFrontMatter, load, index, shell, postPage, notFound, feed, invalidate, previewHtml,
    HOME_DEFAULT, parseHome, homeDoc, homeHtml, homePreviewHtml };
