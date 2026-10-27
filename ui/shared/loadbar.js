// A loading panel that shows REAL progress (2026-10-22, Kyle: "the 'loading' for that page should have a loading bar
// and a better animation -- that goes for both ai and lab subdomain pages"). Used by the Results page on both sites:
// the public site's assets/site.js draws it while the page's code arrives, then ui/models/index.js draws it again for
// its own steps. One copy of the look and the rules, here.
//
// The bar only ever moves on something that happened, never on a timer: a step finishing, or the bytes of the data
// arriving against the size the server announced (X-Body-Length: lib/catalogcache.js / public/server.js). A step that
// cannot say how far along it is (parsing, fitting, drawing: one synchronous call each) fills its share when it ends;
// while it runs, its row shows a moving shimmer, which is an animation, not a claim of progress.
//
// No DOM is needed to build the markup (loadPanelHtml is pure, for the tests); createLoadPanel(el, ...) draws into
// `el` and updates in place, so the animations keep running between updates.

const STYLE_ID = 'loadbar-style';
// The page's tailwind build is prebuilt (only pulse / spin / ping), so the panel brings its own few rules, once.
export function ensureLoadStyle(doc = typeof document !== 'undefined' ? document : null) {
    if (!doc || !doc.head || doc.getElementById(STYLE_ID)) return;
    const st = doc.createElement('style');
    st.id = STYLE_ID;
    st.textContent = `.lb-panel{max-width:30rem;margin:3rem auto;padding:1.1rem 1.25rem 1rem;border:1px solid rgba(129,140,248,.22);border-radius:14px;
background:radial-gradient(120% 140% at 0% 0%,rgba(99,102,241,.10),rgba(17,19,26,.0) 60%),rgba(17,19,26,.72);box-shadow:0 10px 30px -18px rgba(0,0,0,.9)}
.lb-head{display:flex;align-items:baseline;gap:.6rem;margin-bottom:.7rem}
.lb-title{font-size:13px;font-weight:600;color:#e5e7eb;letter-spacing:.01em}
.lb-pct{margin-left:auto;font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#a5b4fc}
.lb-track{position:relative;height:6px;border-radius:9999px;background:rgba(148,163,184,.14);overflow:hidden}
.lb-fill{position:absolute;inset:0 auto 0 0;width:0;border-radius:9999px;background:linear-gradient(90deg,#6366f1,#34d399,#6366f1);background-size:200% 100%;
animation:lb-sheen 1.4s linear infinite;transition:width .45s cubic-bezier(.2,.7,.2,1)}
.lb-steps{list-style:none;margin:.85rem 0 0;padding:0;display:grid;gap:.4rem}
.lb-step{display:flex;align-items:center;gap:.55rem;font-size:12px;color:#6b7280;position:relative;border-radius:6px;padding:.1rem .3rem;overflow:hidden}
.lb-step[data-state=done]{color:#9ca3af}.lb-step[data-state=active]{color:#e5e7eb}
.lb-step[data-state=active]::after{content:"";position:absolute;inset:0;background:linear-gradient(90deg,transparent,rgba(129,140,248,.12),transparent);animation:lb-shimmer 1.3s ease-in-out infinite}
.lb-icon{flex:none;width:14px;height:14px;border-radius:9999px;display:grid;place-items:center;border:1.5px solid #374151;box-sizing:border-box}
.lb-step[data-state=done] .lb-icon{border-color:#34d399;background:rgba(52,211,153,.15)}
.lb-step[data-state=done] .lb-icon::before{content:"";width:6px;height:3px;border:solid #34d399;border-width:0 0 1.5px 1.5px;transform:translateY(-1px) rotate(-45deg)}
.lb-step[data-state=active] .lb-icon{border-color:rgba(129,140,248,.25);border-top-color:#818cf8;animation:lb-spin .8s linear infinite}
.lb-step[data-state=failed] .lb-icon{border-color:#f87171}
.lb-detail{margin-left:auto;font:11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;color:#6b7280;white-space:nowrap}
@keyframes lb-sheen{from{background-position:200% 0}to{background-position:0 0}}
@keyframes lb-shimmer{from{transform:translateX(-100%)}to{transform:translateX(100%)}}
@keyframes lb-spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){.lb-fill,.lb-step::after,.lb-icon{animation:none!important}}`;
    doc.head.appendChild(st);
}

const escHtml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/**
 * The bar's fraction, 0..1, from the steps alone: each step is an equal share; a finished one counts whole, the
 * running one its own `frac` (0..1, only when it can measure itself -- the download), the rest nothing.
 * steps: [{ id, label, state: 'todo' | 'active' | 'done' | 'failed', detail?, frac? }]
 */
export function loadFraction(steps) {
    const list = Array.isArray(steps) ? steps : [];
    if (!list.length) return 0;
    let got = 0;
    for (const s of list) {
        if (s.state === 'done') got += 1;
        else if (s.state === 'active' && Number.isFinite(s.frac)) got += Math.max(0, Math.min(1, s.frac));
    }
    return got / list.length;
}

export function loadPanelHtml(title, steps) {
    const f = loadFraction(steps);
    return `<div class="lb-panel" role="progressbar" aria-label="${escHtml(title)}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(f * 100)}">
  <div class="lb-head"><span class="lb-title">${escHtml(title)}</span><span class="lb-pct">${Math.round(f * 100)}%</span></div>
  <div class="lb-track"><div class="lb-fill" style="width:${(f * 100).toFixed(1)}%"></div></div>
  <ul class="lb-steps">${(steps || []).map((s) => `<li class="lb-step" data-step="${escHtml(s.id)}" data-state="${escHtml(s.state || 'todo')}"><span class="lb-icon"></span><span>${escHtml(s.label)}</span><span class="lb-detail">${escHtml(s.detail || '')}</span></li>`).join('')}</ul>
</div>`;
}

/**
 * Draw a panel into `el` and keep it up to date: set(id, { state, detail, frac }) changes one step in place (the
 * running animations are not restarted); start(id) marks it running and every earlier step done.
 */
export function createLoadPanel(el, title, steps) {
    ensureLoadStyle(el && el.ownerDocument);
    const list = (steps || []).map((s) => ({ state: 'todo', ...s }));
    el.innerHTML = loadPanelHtml(title, list);
    const root = el.querySelector('.lb-panel');
    const paint = () => {
        if (!root || !root.isConnected) return;
        const f = loadFraction(list);
        root.setAttribute('aria-valuenow', String(Math.round(f * 100)));
        root.querySelector('.lb-fill').style.width = `${(f * 100).toFixed(1)}%`;
        root.querySelector('.lb-pct').textContent = `${Math.round(f * 100)}%`;
        for (const s of list) {
            const li = root.querySelector(`[data-step="${s.id}"]`);
            if (!li) continue;
            if (li.dataset.state !== s.state) li.dataset.state = s.state;
            const d = li.querySelector('.lb-detail');
            if (d.textContent !== (s.detail || '')) d.textContent = s.detail || '';
        }
    };
    return {
        set(id, patch) { const s = list.find((x) => x.id === id); if (s) { Object.assign(s, patch); paint(); } },
        start(id) {
            const k = list.findIndex((x) => x.id === id);
            if (k < 0) return;
            list.forEach((s, i) => { if (i < k && s.state !== 'failed') s.state = 'done'; });
            list[k].state = 'active';
            paint();
        },
        get el() { return root; },
    };
}

// The Results page's steps, in order: the public site draws them while the page's code arrives (assets/site.js, `code`
// running), then ui/models/index.js draws them again from `data` on. One list, so the two never disagree.
export const RESULTS_STEPS = [{ id: 'code', label: 'Page code' }, { id: 'data', label: 'Results data' }, { id: 'parse', label: 'Reading it' },
    { id: 'fit', label: 'Fitting model strengths' }, { id: 'draw', label: 'Drawing the charts' }];
export const RESULTS_TITLE = 'Loading the results';

/** Let the browser paint before the next synchronous step (a step that blocks the thread would otherwise never show). */
// A hidden tab runs no animation frames, so a timer stands in after 100 ms: the load never waits for the tab to show.
export const nextPaint = () => new Promise((resolve) => {
    let done = false;
    const go = () => { if (!done) { done = true; resolve(); } };
    if (typeof requestAnimationFrame === 'function' && !(typeof document !== 'undefined' && document.hidden)) requestAnimationFrame(() => setTimeout(go, 0));
    setTimeout(go, typeof requestAnimationFrame === 'function' ? 100 : 0);
});
