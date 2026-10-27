// What the rig is doing right now, from GET /api/live (the dashboard's snapshot, scrubbed): each busy GPU lane's
// card, engine, phase and live rate, and each running battery's model, current task name and progress -- and, when
// the server sends them (2026-10-07), the question its queue item answers and how many tasks have passed / failed.

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const POLL_MS = 3000;

async function fetchLive() {
    try { const r = await fetch('/api/live', { cache: 'no-store' }); return r.ok ? await r.json() : null; } catch { return null; }
}

function phaseHtml(l) {
    if (!l) return '<span class="lane-phase"><i></i>waiting</span>';
    if (l.phase === 'gen') return `<span class="lane-phase is-gen"><i></i>generating ${Number(l.gen || 0).toFixed(1)} t/s</span>`;
    if (l.phase === 'prefill') return `<span class="lane-phase is-prefill"><i></i>reading ${Math.round(l.prefill || 0).toLocaleString()} t/s${l.progress != null ? ` · ${Math.round(l.progress * 100)}%` : ''}</span>`;
    if (l.phase && l.phase !== 'idle') return `<span class="lane-phase"><i></i>${esc(l.phase)}</span>`;
    return '<span class="lane-phase"><i></i>between steps</span>';
}

// The running queue item's question and tally. Both are optional in the payload: an item with no question shows no
// question line, and a server that sends no counts leaves the card as it was ("N solved so far").
const questionHtml = (r) => (r.question ? `<div class="lane-q"><span>question</span>${esc(r.question)}</div>` : '');
function tallyHtml(r) {
    if (r.passed == null || r.failed == null) return '';
    const n = (v) => Math.max(0, Math.round(Number(v) || 0));
    const left = r.remaining != null ? n(r.remaining) : Math.max(0, n(r.tasks) - n(r.passed) - n(r.failed) - n(r.excluded));
    // "not scored": provider / harness errors and aborted or invalid runs -- not answers from the model, so never fails
    return `<span class="lane-tally"><b class="is-pass">${n(r.passed)} passed</b> · <b class="is-fail">${n(r.failed)} failed</b> · ${left} left${n(r.excluded) ? ` · <span title="errors and aborted runs: not counted as passes or fails">${n(r.excluded)} not scored</span>` : ''}</span>`;
}

function cards(j) {
    const lanes = j.lanes || [];
    const runs = j.running || [];
    // one card per running battery; its lane (card / engine / phase) joined by battery label
    return runs.map((r) => {
        const l = lanes.find((x) => x.battery === r.dir) || null;
        const pct = r.tasks ? Math.round((r.done / r.tasks) * 100) : 0;
        const tally = tallyHtml(r);
        const where = r.lane === 'cloud' ? '<span class="lane-card">cloud</span>' : l ? `<span class="lane-card">${esc(l.card || 'gpu')}</span><span class="lane-engine">${esc(l.engine || '')}</span>` : '<span class="lane-card">local</span>';
        return `<div class="lane">
          <div class="lane-head">${where}${r.lane === 'cloud' ? '<span class="lane-phase"><i></i>remote</span>' : phaseHtml(l)}</div>
          <div class="lane-model">${esc(r.model || r.dir)}</div>
          <div class="lane-battery" title="battery">${esc(r.dir)}${r.runner ? ` · ${esc(r.runner)}` : ''}</div>
          ${questionHtml(r)}
          ${r.task ? `<div class="lane-task">on <code>${esc(r.task)}</code></div>` : ''}
          <div class="lane-bar"><span style="width:${pct}%"></span></div>
          <div class="lane-foot${tally ? ' has-tally' : ''}">${tally ? `${tally}<span>${r.tasks} tasks</span>` : `<span>task ${Math.min(r.done + 1, r.tasks)} of ${r.tasks}</span><span>${r.solved} solved so far</span>`}</div>
        </div>`;
    }).join('');
}

// Static build only (assets/static-mode.js answers /api/live with `offline: true` while the lab cannot be reached;
// public/server.js never sends it): say so plainly, with the last record the build had.
function offlineHtml(j) {
    const when = (t) => new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    const last = j.last && (j.last.running || []).length ? j.last : null;
    return `<div class="lab-offline"><b>The lab is offline right now</b>, so there is nothing live to show. This page reconnects by itself when it is back.
      ${j.updatedAt ? `The results on this site were last updated ${esc(when(j.updatedAt))}.` : ''}
      ${last ? `<div style="margin-top:1rem">Last seen running (${esc(when(last.at))}):</div><ul>${last.running.map((r) => `<li>${esc(r.model || r.dir)}${r.task ? ` on <code>${esc(r.task)}</code>` : ''}${r.tasks ? ` · task ${Math.min((r.done || 0) + 1, r.tasks)} of ${r.tasks}` : ''}${r.passed != null && r.failed != null ? ` · ${tallyHtml(r)}` : ''}${r.question ? `<div class="lab-offline-q">${esc(r.question)}</div>` : ''}</li>`).join('')}</ul>` : ''}</div>`;
}

/** The full live section. Polls while it is on screen. */
export function mountLive(el) {
    el.innerHTML = `<div class="site-kicker">live</div><h1 class="site-h1">What's running right now</h1>
      <p class="site-lede">Each card is a battery of tasks working through the corpus on one GPU (or a cloud model for comparison).
        Rates are the engine's own, sampled every few seconds. Task names are shown; their content isn't.</p>
      <div class="site-section"><div class="lanes" id="lv-lanes"></div><div class="lane-foot" style="margin-top:1rem" id="lv-meta"></div></div>`;
    const host = el.querySelector('#lv-lanes'), meta = el.querySelector('#lv-meta');
    let timer = null;
    const tick = async () => {
        if (el.hidden) { timer = null; return; }
        const j = await fetchLive();
        if (j && j.offline) { host.innerHTML = offlineHtml(j); meta.textContent = ''; }
        else if (j) {
            host.innerHTML = (j.running || []).length ? cards(j) : '<div class="site-empty">Nothing running at the moment — the rig is idle or between batteries.</div>';
            meta.textContent = j.stale ? 'status is stale: the lab may be restarting' : `updated ${new Date(j.at).toLocaleTimeString()}`;
        } else meta.textContent = 'live status unavailable';
        // A stale first answer is usually just the lab waking up (it only writes status while someone watches): ask again soon.
        timer = setTimeout(tick, j && j.stale && !j.offline ? 1500 : POLL_MS);
    };
    tick();
    new MutationObserver(() => { if (!el.hidden && !timer) tick(); }).observe(el, { attributes: true, attributeFilter: ['hidden'] });
}

/** The landing page's compact version: the same cards, refreshed while visible. */
export function liveSummary(host, dot) {
    const tick = async () => {
        if (!document.body.contains(host)) return;
        const j = await fetchLive();
        if (!document.body.contains(host)) return;   // the overview was redrawn while this was in flight: its new copy has its own tick
        const n = j ? (j.running || []).length : 0;
        if (dot) dot.classList.toggle('is-idle', !n);
        host.innerHTML = j && n ? `<div class="lanes">${cards(j)}</div>` : `<div class="site-empty" style="padding:1.5rem 0;text-align:left">${j && j.offline ? 'The lab is offline right now.' : 'Idle right now.'}</div>`;
        if (!host.closest('section').hidden) setTimeout(tick, POLL_MS * 2);
    };
    tick();
}
