// ai lab -- the public site's front end. Sections are client-rendered from the read-only API; a post page
// (/blog/<slug>) arrives server-rendered and is left alone. Results is the dashboard's own Models module
// (ui/models/index.js) running with window.PUBLIC_SITE set, so the charts are the same code as in the lab.

window.PUBLIC_SITE = true;
import { liveSummary } from './live.js';
import { createLoadPanel, RESULTS_STEPS, RESULTS_TITLE } from '../ui/shared/loadbar.js';

const cfg = (() => { try { return JSON.parse(document.getElementById('site-config').textContent); } catch { return {}; } })();
const main = document.getElementById('site-main');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const get = async (url) => { const r = await fetch(url); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.json(); };
const fmtN = (n) => (n == null ? '—' : Number(n).toLocaleString());

const SECTIONS = ['overview', 'results', 'writing', 'about'];   // no 'live' page since 2026-10-10: the overview's "testing now" is the live view
const sectionOf = (p) => (p === '/' || p === '' ? 'overview' : p.startsWith('/models') ? 'results' : p.replace(/^\//, '').split('/')[0]);

// A post page is server-rendered: nothing to do but keep the nav working.
const serverRendered = main.children.length > 0;

const els = {};
function sectionEl(name) {
    if (!els[name]) {
        const el = document.createElement('section');
        el.dataset.section = name;
        el.hidden = true;
        main.appendChild(el);
        els[name] = el;
    }
    return els[name];
}

// ------------------------------------------------------------------ overview
// The copy at the top of the home page (kicker, headline, intro) is a document Kyle edits in the dashboard's post
// editor (pages/home.md in the posts repo). The server renders it into the page shell as #site-home { html }
// (public/posts.js homeHtml); HOME_BUILTIN is the same text built in, used when the shell carries none or it cannot
// be read, so the page is never empty. Keep it equal to posts.js HOME_DEFAULT (test/publichome.test.js checks).
const HOME_BUILTIN = `<div class="site-kicker">local models · consumer GPUs · real bugs</div>
      <h1 class="site-h1">a little local LLM homelab</h1>
      <p class="site-lede">One desktop — two RX 7900 XTX, 48 GB of VRAM between them — running open-weight models
        against bugs from my own git history: check out the commit before the fix, hand the agent the original report, and
        score it on the hidden test the real fix made pass. Speed, quality and cost are all measured, and the tasks stay
        private so they can't leak into anyone's training data. <a href="/results" data-nav>The results</a> are all here, and
        whatever is running right now is shown below.</p>`;
function homeCopy() {
    try {
        const j = JSON.parse(document.getElementById('site-home').textContent);
        return j && typeof j.html === 'string' && j.html.replace(/<[^>]*>/g, '').trim() ? j.html : HOME_BUILTIN;
    } catch { return HOME_BUILTIN; }
}

async function renderOverview(el) {
    el.innerHTML = `
      ${homeCopy()}
      <div class="stat-row" id="ov-stats"><div class="stat"><b>…</b><span>loading</span></div></div>
      <div class="site-section"><h2 class="site-h2"><span class="site-dot" id="ov-dot"></span>testing now</h2><div id="ov-live"></div></div>
      <div class="site-section"><h2 class="site-h2">writing <a href="/writing" data-nav>all posts →</a></h2><div id="ov-posts" class="posts"></div></div>`;
    get('/api/stats').then((s) => {
        el.querySelector('#ov-stats').innerHTML = [
            [s.withQuality, 'models scored'], [`${s.local} / ${s.cloud}`, 'local / cloud'], [s.tasks, 'private tasks'],
            [s.taskRuns, 'task runs scored'], [s.requests, 'requests timed'],
        ].map(([v, l]) => `<div class="stat"><b>${typeof v === 'number' ? fmtN(v) : esc(v)}</b><span>${esc(l)}</span></div>`).join('');
    }).catch(() => { el.querySelector('#ov-stats').remove(); });
    liveSummary(el.querySelector('#ov-live'), el.querySelector('#ov-dot'));
    renderPostList(el.querySelector('#ov-posts'), 3);
}

// ------------------------------------------------------------------ writing
async function renderPostList(host, limit) {
    let posts = [];
    try { posts = await get('/api/posts'); } catch { /* none */ }
    if (limit) posts = posts.slice(0, limit);
    host.innerHTML = posts.length
        ? posts.map((p) => `<a class="post-row" href="/blog/${esc(p.slug)}"><time>${esc(p.date)}</time><div><h3>${esc(p.title)}</h3>${p.summary ? `<p>${esc(p.summary)}</p>` : ''}</div></a>`).join('')
        : '<div class="site-empty">Nothing published yet.</div>';
}
function renderWriting(el) {
    el.innerHTML = `<div class="site-kicker">writing</div><h1 class="site-h1">Notes from the bench</h1>
      <p class="site-lede">Short write-ups of what the measurements say, including the ones that turned out to be wrong.</p>
      <div class="site-section"><div class="posts" id="wr-posts"></div></div>`;
    renderPostList(el.querySelector('#wr-posts'));
}

// ------------------------------------------------------------------ about
function renderAbout(el) {
    const link = (href, label) => `<a class="btn" href="${esc(href)}" rel="noopener">${esc(label)}</a>`;
    el.innerHTML = `<div class="site-kicker">about</div><h1 class="site-h1">A lab notebook for local inference</h1>
      <div class="site-text">
        <p>I'm Kyle Baker. I've been writing software for about ten years, most of it before AI could write any of it: as a
        technical cofounder and acting CTO for early-stage start-ups, and as a specialist in VR and 3D on the web — the kind of
        work where the browser is the engine and every millisecond is visible.</p>
        <p>This started as an attempt to make local models useful for real work and turned into a measuring project: a harness
        that replays bugs from my own repositories against an agent, and a dashboard that runs it on whatever is loaded on the GPUs.</p>
        <p>Everything on this page is read straight from that rig. Task names are public; the tasks themselves aren't, so
        they stay out of training data and the scores stay honest. Small samples are marked as such — most results here
        come with an interval, and some of the most useful findings were measurements that turned out to be wrong.</p>
        <p>If you're working on something where local inference, evaluation, or careful measurement matters, I'm glad to talk.</p>
      </div>
      <div class="about-links">${[cfg.homepage && link(cfg.homepage, 'kylebaker.io'), cfg.github && link(cfg.github, 'github'),
        cfg.contact && link(cfg.contact, 'get in touch')].filter(Boolean).join('')}</div>
      ${cfg.kofi ? `<div class="site-section site-text"><p>If any of this saved you a weekend of benchmarking, you can <a href="${esc(cfg.kofi)}" rel="noopener">buy me a coffee</a>. It goes toward GPU hours and the occasional cloud comparison run.</p></div>` : ''}`;
}

// ------------------------------------------------------------------ results (the Models module)
let resultsMounted = false;
function renderResults(el) {
    if (resultsMounted) return;
    resultsMounted = true;
    el.innerHTML = `<div class="site-kicker">results</div>
      <p class="site-lede" style="margin-bottom:1.5rem">Every model scored on the private corpus: what it solved, its strength out of 100
        (difficulty-weighted, with a 95% range), how fast it gets there and what it costs in tokens, time and memory. Hover anything;
        click a model for its own page.</p>
      <button id="tab-models" type="button" hidden></button><div id="models-view"></div>`;
    // The loading panel while the page's code arrives (2026-10-22): its first step running, the module's own steps
    // after it (ui/shared/loadbar.js). The module draws the same panel again, with `code` done, as soon as it runs.
    createLoadPanel(el.querySelector('#models-view'), RESULTS_TITLE, RESULTS_STEPS).start('code');
    import(new URL('../ui/models/index.js', import.meta.url).href);   // under this page's /v/<hash>/ prefix: never a stale module   // finds #tab-models + a visible #models-view and loads itself
}

const RENDER = { overview: renderOverview, results: renderResults, writing: renderWriting, about: renderAbout };
const rendered = new Set();
function show(name) {
    if (!SECTIONS.includes(name)) name = 'overview';
    document.body.dataset.section = name;
    for (const [n, el] of Object.entries(els)) el.hidden = n !== name;
    const el = sectionEl(name);
    el.hidden = false;
    if (!rendered.has(name) || name === 'writing' || name === 'overview') { rendered.add(name); RENDER[name](el); }
    document.querySelectorAll('.site-nav a').forEach((a) => a.classList.toggle('is-on', sectionOf(a.getAttribute('href')) === name));
    document.title = name === 'overview' ? 'ai lab' : `${name} · ai lab`;
}

function navigate(path, push = true) {
    const name = sectionOf(path);
    if (!SECTIONS.includes(name)) { location.href = path; return; }
    if (serverRendered) { location.href = path; return; }
    if (push) history.pushState({ path }, '', path);
    show(name);
    if (window.gtag) window.gtag('event', 'page_view', { page_path: path, page_title: document.title });   // GA4: in-site navigation
    window.scrollTo(0, 0);
}

document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a || e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || a.target) return;
    const href = a.getAttribute('href');
    if (!href.startsWith('/') || href.startsWith('/blog/') || href.startsWith('/feed')) return;
    if (!SECTIONS.includes(sectionOf(href))) return;
    e.preventDefault();
    navigate(href);
});
window.addEventListener('popstate', () => { if (!serverRendered) show(sectionOf(location.pathname)); });
window.addEventListener('site:navigate', (e) => navigate((e.detail && e.detail.path) || '/'));
// Static build only (assets/static-mode.js): the lab answered after the bundled snapshot was already drawn -- redraw
// the overview's numbers from it. Nothing sends this event on the server-rendered site.
window.addEventListener('site:refresh', () => { if (!serverRendered && document.body.dataset.section === 'overview') show('overview'); });

if (!serverRendered) show(sectionOf(location.pathname));
