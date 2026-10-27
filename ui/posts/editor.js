// The ai lab post editor (ui/posts/index.html). Lists every post in the private repo (drafts too), edits one with a
// live preview rendered exactly as the public site will show it, and saves through POST /api/posts/save, which
// commits to GitHub (lib/postsrepo.js).
//
// "Home page" (2026-10-07) is pinned above the posts: the copy at the top of the public home page, one document in
// the same repo (pages/home.md). It opens in this same form -- Title is its headline, Summary its kicker, the body
// its intro -- with the post-only fields hidden, and saves and previews through the same two routes (`page: 'home'`).

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const status = (t, bad) => { $('pe-status').textContent = t; $('pe-status').style.color = bad ? '#f87171' : ''; };

let current = null;     // { slug, draft, ... } of the post being edited, null for a new one
let dirty = false;
let homeMode = false;   // editing the home page's copy instead of a post
let homeInfo = null;    // { title, updatedAt, exists, builtin } from the list; null: a server without the home document

const LABELS = { title: 'Title', summary: 'Summary (list + link previews)', titleHint: 'Post title', summaryHint: 'One line', note: 'Drafts never appear on the public site.' };
const HOME_LABELS = { title: 'Headline', summary: 'Kicker (small line above the headline)', titleHint: 'The home page headline', summaryHint: 'local models · consumer GPUs · real bugs',
    note: 'The copy at the top of the public home page. Saving puts it on the site.' };
/** Switch the form between a post and the home page's copy: the same fields, fewer of them, other names. */
function setMode(home) {
    homeMode = home;
    const L = home ? HOME_LABELS : LABELS;
    $('pe-title-label').textContent = L.title; $('pe-summary-label').textContent = L.summary;
    $('pe-title').placeholder = L.titleHint; $('pe-summary').placeholder = L.summaryHint;
    $('pe-body').placeholder = home ? 'The intro, in markdown…' : 'Markdown…';
    for (const id of ['pe-slug-wrap', 'pe-date-wrap', 'pe-tags-wrap', 'pe-save']) $(id).style.display = home ? 'none' : '';
    $('pe-title-wrap').className = home ? 'md:col-span-4' : 'md:col-span-3';     // one row: headline 4 of 6, kicker 2
    $('pe-summary-wrap').className = home ? 'md:col-span-2' : 'md:col-span-4';
    $('pe-note').textContent = L.note;
    if (home) { $('pe-state').textContent = 'home page'; $('pe-state').className = 'tag tag-sky'; $('pe-publish').textContent = 'Save home page'; }
}
function renderPages() {
    $('pe-pages').hidden = !homeInfo;
    if (!homeInfo) return;
    $('pe-pages').innerHTML = `<button type="button" id="pe-home" class="w-full text-left px-3 py-2 rounded-lg border ${homeMode ? 'border-indigo-500/60 bg-indigo-500/10' : 'border-transparent hover:bg-gray-800'}">
        <div class="flex items-center gap-1.5"><span class="truncate text-[13px] text-gray-100">Home page</span><span class="ml-auto tag tag-sky">page</span></div>
        <div class="text-[11px] text-gray-500 truncate">${homeInfo.builtin ? 'built-in text · not saved yet' : esc(homeInfo.title || '')}</div></button>`;
    $('pe-home').addEventListener('click', openHome);
}

async function loadList(select) {
    const j = await (await fetch('/api/posts/list', { cache: 'no-store' })).json();
    $('pe-repo').textContent = j.repo ? `· ${j.repo}` : '';
    homeInfo = j.home || null; renderPages();
    $('pe-list').innerHTML = (j.posts || []).map((p) => `<button type="button" data-slug="${esc(p.slug)}" class="w-full text-left px-3 py-2 rounded-lg border ${!homeMode && current && current.slug === p.slug ? 'border-indigo-500/60 bg-indigo-500/10' : 'border-transparent hover:bg-gray-800'}">
        <div class="flex items-center gap-1.5"><span class="truncate text-[13px] text-gray-100">${esc(p.title)}</span><span class="ml-auto tag ${p.draft ? 'tag-amber' : 'tag-sky'}">${p.draft ? 'draft' : 'live'}</span></div>
        <div class="text-[11px] text-gray-500 font-mono">${esc(p.date)} · ${esc(p.slug)}</div></button>`).join('') || '<div class="text-[12px] text-gray-500 p-3">No posts yet.</div>';
    $('pe-list').querySelectorAll('[data-slug]').forEach((b) => b.addEventListener('click', () => open(b.dataset.slug)));
    if (select) open(select);
}

function fill(p) {
    $('pe-title').value = p.title || ''; $('pe-slug').value = p.slug || ''; $('pe-date').value = p.date || new Date().toISOString().slice(0, 10);
    $('pe-summary').value = p.summary || ''; $('pe-tags').value = (p.tags || []).join(', '); $('pe-body').value = p.body || '';
    setState(p.draft !== false);
    $('pe-slug').disabled = !!p.slug && !!current;   // renaming a saved post would orphan the old file
    dirty = false; preview();
}
function setState(draft) {
    $('pe-state').textContent = draft ? 'draft' : 'published';
    $('pe-state').className = `tag ${draft ? 'tag-amber' : 'tag-sky'}`;
    $('pe-publish').textContent = draft ? 'Publish' : 'Update live post';
    $('pe-save').textContent = draft ? 'Save draft' : 'Unpublish (back to draft)';
}
async function open(slug) {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    const p = await (await fetch(`/api/posts/get?slug=${encodeURIComponent(slug)}`, { cache: 'no-store' })).json();
    if (p.error) return status(p.error, true);
    setMode(false);
    current = p; fill(p); loadList();
    status(`editing ${slug}`);
}
async function openHome() {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    const p = await (await fetch('/api/posts/get?page=home', { cache: 'no-store' })).json();
    if (p.error || p.page !== 'home') return status(p.error || 'the home page is not available', true);
    setMode(true);
    current = null;
    $('pe-title').value = p.title || ''; $('pe-summary').value = p.kicker || ''; $('pe-body').value = p.body || '';
    dirty = false; preview(); loadList();
    status(p.builtin ? 'home page · no document saved yet: this is the built-in text the site shows; saving creates it' : 'editing the home page');
}
function form(draft) {
    if (homeMode) return { page: 'home', title: $('pe-title').value, kicker: $('pe-summary').value, body: $('pe-body').value };
    return { slug: $('pe-slug').value.trim(), title: $('pe-title').value, date: $('pe-date').value, summary: $('pe-summary').value,
        tags: $('pe-tags').value, body: $('pe-body').value, draft };
}

let previewTimer = null;
function preview() {
    clearTimeout(previewTimer);
    previewTimer = setTimeout(async () => {
        const r = await fetch('/api/posts/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(form(current ? current.draft !== false : true)) });
        $('pe-preview').srcdoc = await r.text();
    }, 350);
}

async function save(draft) {
    const f = form(draft);
    if (homeMode) return saveHome(f);
    if (!f.title.trim()) return status('A title is required.', true);
    if (!draft && !window.confirm(`Publish "${f.title}" on the public site?`)) return;
    status('saving to GitHub…');
    $('pe-save').disabled = $('pe-publish').disabled = true;
    try {
        const r = await fetch('/api/posts/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        dirty = false;
        status(`${draft ? 'saved draft' : 'published'} · commit ${j.commit || '?'}${draft ? '' : ' · live within a few minutes'}`);
        current = { ...(current || {}), slug: j.slug, draft };
        setState(draft);
        await loadList();
        $('pe-slug').value = j.slug; $('pe-slug').disabled = true;
    } catch (e) { status(e.message, true); }
    finally { $('pe-save').disabled = $('pe-publish').disabled = false; }
}

/** The home page's copy: the same POST as a post, with `page: 'home'`. There is no draft state -- saving is publishing. */
async function saveHome(f) {
    if (!f.title.trim()) return status('A headline is required.', true);
    if (!f.body.trim()) return status('The intro text is required.', true);
    if (!window.confirm('Put this copy on the public home page?')) return;
    status('saving to GitHub…');
    $('pe-publish').disabled = true;
    try {
        const r = await fetch('/api/posts/save', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(f) });
        const j = await r.json();
        if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
        dirty = false;
        status(`saved the home page · commit ${j.commit || '?'} · on the site within a few minutes`);
        await loadList();
    } catch (e) { status(e.message, true); }
    finally { $('pe-publish').disabled = false; }
}

$('pe-new').addEventListener('click', () => {
    if (dirty && !window.confirm('Discard unsaved changes?')) return;
    setMode(false);
    current = null; fill({ draft: true }); $('pe-slug').disabled = false; loadList(); status('new post');
});
$('pe-save').addEventListener('click', () => save(true));
$('pe-publish').addEventListener('click', () => save(false));
for (const id of ['pe-title', 'pe-summary', 'pe-tags', 'pe-body', 'pe-date']) $(id).addEventListener('input', () => { dirty = true; preview(); });
$('pe-title').addEventListener('input', () => {
    if (!current && !homeMode) $('pe-slug').value = $('pe-title').value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
});
window.addEventListener('beforeunload', (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } });

loadList().then(() => { fill({ draft: true }); status('pick a post, or start a new one'); });
