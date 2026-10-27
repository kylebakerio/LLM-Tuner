// Shared leaderboard MACHINERY -- sorting, the denominator/coverage rendering, the "n=" column,
// the common-tasks recomputation, duration formatting and click-through. Each board (codebench
// quality, public suites, llama-bench, launch sweep, and the Models overview's short summaries)
// keeps its OWN columns, its own note and its own meaning; this file exists so they do not each
// reinvent the parts below, not to flatten them into one board:
//   - every board states its DENOMINATOR (n=, tasks attempted, reps)
//   - excluded codebench statuses (OVERFLOW / KILLED / PROVIDER_ERROR / ABORTED) are shown
//     separately and never counted as failures
//   - a bare percentage across contestants that attempted DIFFERENT task sets is misleading,
//     so a quality board either restricts to the common tasks or warns, loudly, that it did not
//   - durations go through fmtDur(); a t/s number always carries its conditions
//
// Row shape:
//   { key, label, sublabel, metrics: {<colId>: number|null|{v,n,note,coarse}},
//     n, coverage: {attempted, total}, warnings: [string], href, tasks: {id: {...}} }

import { esc, fmtDur, fmtN, harnessLabel, scaffoldBit, ctxLabel, commonWindow } from '../benchmarks/util.js';

// ============================================================ THE item response function (2026-10-25)
// The chance a config of ability `theta` solves a problem of discrimination `a` and (absolute) difficulty `b`. ONE place
// (Kyle: "confirm the logic for this stuff exists in one place and won't be duplicated or out of sync"), so a later change
// to the item model (a lower asymptote, a per-level discrimination ...) reaches every number that reads a pass
// probability at once:
//   this file        difficultyAdjusted: strength S(theta) and its 95% range (the posterior grid's log p / log(1-p)), the
//                    points, the /100 difficulty, avgRate; pSolve (the fit's own maps, for everyone else); reportCard and
//                    tagDelta
//   lib/liveodds.js  the live view's odds (pSolve)
//   ui/shared/planner.js     passProb and the Gauss-Hermite expectation `predictive`
//   ui/autoqueue/derive.js   the per-task information behind each difficulty's standard error
// NOT through it, and so NOT changed by editing these three: the ESTIMATORS, whose Newton steps are the 2PL's derivatives
// (difficultyAdjusted's theta / b / log-a passes and hierarchical ability blocks, the held level problems' 1PL
// difficulty), and the planner's Fisher information a^2 p (1 - p). A different item model needs those rewritten as well.
// The 2PL (since 2026-10-14): P = sigmoid(a (theta - b)). Each caller passes theta and b exactly as it built them before
// these existed (b = difficulty + meanB on the centred maps, the raw b inside the fit), so every number is bit for bit
// what it was: (b - meanB) + meanB is not always b in floating point.
export const ITEM_MODEL = '2PL';
/** P(solve) = sigmoid(a * (theta - b)). */
export function itemP(a, b, theta) { return 1 / (1 + Math.exp(-(a * (theta - b)))); }
/** log P(solve), numerically stable: -log(1 + exp(-z)), z = a * (theta - b). */
export function itemLogP(a, b, theta) { return -Math.log1p(Math.exp(-(a * (theta - b)))); }
/** log (1 - P(solve)), numerically stable: -log(1 + exp(z)). */
export function itemLog1mP(a, b, theta) { return -Math.log1p(Math.exp(a * (theta - b))); }

// Reference categorical palette, dark steps. Fixed order, never cycled; validated against this
// dashboard's card surface (#14161c): lightness band, chroma floor, CVD separation, contrast.
export const SERIES = ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'];
// Status palette -- reserved, never reused as "series N".
export const STATUS_COLOR = {
    // pass/fail/timeout re-stepped 2026-10-01: the old green/red pair (#0ca30c/#d03b3b) was dE 4.1 apart under
    // deuteranopia -- the task grid's whole message. These clear validate_palette --pairs all (worst CVD dE 9.0).
    // pass* is a pass under a special condition (the run hit the time limit): the special-pass dark green of
    // ui/benchmarks/util.js SPECIAL_PASS_FILL (2026-10-19, Kyle), no longer an amber next to TIMEOUT's
    'pass': '#34c98a', 'pass*': '#166534', 'TIMEOUT': '#f2a03d', 'fail': '#d9434b',
    'OVERFLOW': '#747b8c', 'KILLED': '#747b8c', 'PROVIDER_ERROR': '#747b8c', 'ABORTED': '#747b8c',
    'CAP_TOO_LOW': '#747b8c', 'HARNESS_ERROR': '#747b8c', 'CONTAMINATED': '#747b8c', 'TASK_INVALID': '#747b8c', 'CUTOFF': '#747b8c',
};
export const EXCLUDED_STATUS = new Set(['OVERFLOW', 'KILLED', 'PROVIDER_ERROR', 'ABORTED', 'CAP_TOO_LOW', 'HARNESS_ERROR', 'CONTAMINATED', 'TASK_INVALID', 'CUTOFF']);

// ---- search highlight (2026-10-10, Kyle: "instead of 'filter models' ... a gold highlight around models that match").
// The Models page's search box hides nothing any more: a model matching the term gets a GOLD ring wherever it is
// drawn. Gold is close to the amber of a timeout cell and of the ladder's paid steps, so the highlight is always a
// SHAPE as well (a frame, a ring), never the colour alone.
export const HIGHLIGHT = '#f5c542';
// The match rule, the one the filter used: the term is a case-insensitive substring of the model's display name,
// key, family or quant. No term matches nothing. -> (model) => boolean
export function modelMatcher(term) {
    const s = String(term == null ? '' : term).trim().toLowerCase();
    if (!s) return () => false;
    return (m) => !!m && [m.display, m.key, m.family, m.quant].some((v) => String(v || '').toLowerCase().includes(s));
}
// DOM rows and tiles carry data-hl; one stylesheet rule set draws their ring. Injected here because vendor/tailwind.css
// is a static build (a new utility class would silently do nothing). A table row is ringed through its cells: a
// box-shadow on a <tr> itself is not drawn by every browser. --hl-gold lets a theme pick another gold.
export function ensureHighlightStyle() {
    if (typeof document === 'undefined' || !document.head || document.getElementById('hl-style')) return;
    const st = document.createElement('style');
    st.id = 'hl-style';
    const g = `var(--hl-gold, ${HIGHLIGHT})`;
    st.textContent = `tr[data-hl] > td { background-color: rgba(245, 197, 66, 0.07); box-shadow: inset 0 2px 0 ${g}, inset 0 -2px 0 ${g}; }
tr[data-hl] > td:first-child { box-shadow: inset 2px 0 0 ${g}, inset 0 2px 0 ${g}, inset 0 -2px 0 ${g}; }
tr[data-hl] > td:last-child { box-shadow: inset -2px 0 0 ${g}, inset 0 2px 0 ${g}, inset 0 -2px 0 ${g}; }
.model-tile[data-hl], .model-tile[data-hl]:hover { border-color: ${g}; box-shadow: 0 0 0 1.5px ${g}; background-color: rgba(245, 197, 66, 0.07); }`;
    document.head.appendChild(st);
}

const val = (m) => (m && typeof m === 'object' ? m.v : m);
// Wilson score interval for a proportion. At n=12 it is roughly +/-25 points, which is the
// honest width of a 11/12 vs 10/11 "ranking": those two are the same measurement and a table
// that prints them as #1 and #2 is claiming something the data cannot support.
export function wilson(passed, total, z = 1.96) {
    const n = Number(total);
    if (!Number.isFinite(n) || n <= 0) return null;
    const p = Number(passed) / n;
    const d = 1 + (z * z) / n;
    const centre = p + (z * z) / (2 * n);
    const half = z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
    return { lo: Math.max(0, (centre - half) / d), hi: Math.min(1, (centre + half) / d) };
}
export const overlaps = (a, b) => !!(a && b && a.lo <= b.hi && b.lo <= a.hi);
const pct = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : `${(Number(v) * 100).toFixed(1)}%`);
const num1 = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(1));
const int = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : Math.round(Number(v)).toLocaleString());

function fmtCell(col, m) {
    const v = val(m);
    // The spread across reps rides with the value: 43.9 vs 46.4 means nothing until you know
    // one was +/-1.0 and the other +/-0.1.
    const sp = (m && typeof m === 'object' && m.spread != null && Number.isFinite(Number(m.spread)))
        ? `<span class="text-gray-500 text-[9px]"> ±${Number(m.spread).toFixed(1)}</span>` : '';
    const ci = (m && typeof m === 'object' && m.ci) ? m.ci : null;
    switch (col.kind) {
        case 'pct': return pct(v) + (ci ? `<div class="text-[9px] text-gray-500">${Math.round(ci.lo * 100)}–${Math.round(ci.hi * 100)}%</div>` : '');
        case 'strength': return (v == null ? '—' : Math.round(v * 100))
            + (ci ? `<div class="text-[9px] text-gray-500">${Math.round(ci.lo * 100)}–${Math.round(ci.hi * 100)}${m.coverage != null ? ` · ${Math.round(m.coverage * 100)}% tested` : ''}${m.pooled ? ' · pooled' : ''}</div>` : '');
        case 'dur': return (v == null ? '—' : fmtDur(v)) + sp;
        case 'int': return int(v);
        case 'xy': return v && Number.isFinite(Number(v.total)) ? `${v.passed ?? 0}/${v.total}` : '—';
        case 'text': return v == null ? '—' : esc(String(v));
        default: return num1(v) + sp;
    }
}

/**
 * Intersection of the task ids every row attempted (rows with no task data are ignored).
 * Returns { ids:Set, rowsCompared, allSame }.
 */
export function commonTaskSet(rows) {
    const withTasks = rows.filter((r) => r.tasks && Object.keys(r.tasks).length);
    if (!withTasks.length) return { ids: new Set(), rowsCompared: 0, allSame: true };
    let ids = null;
    for (const r of withTasks) {
        // A task every run of which was excluded was not answered: it is not common ground.
        const s = new Set(Object.entries(r.tasks).filter(([, t]) => !t.excluded).map(([k]) => k));
        ids = ids === null ? s : new Set([...ids].filter((x) => s.has(x)));
    }
    const allSame = withTasks.every((r) => Object.values(r.tasks).filter((t) => !t.excluded).length === ids.size);
    return { ids, rowsCompared: withTasks.length, allSame };
}

const med = (a) => {
    const n = a.filter((v) => v != null && Number.isFinite(Number(v))).map(Number).sort((x, y) => x - y);
    if (!n.length) return null;
    const m = n.length >> 1;
    return n.length % 2 ? n[m] : (n[m - 1] + n[m]) / 2;
};
const avg = (a) => {
    const n = a.filter((v) => v != null && Number.isFinite(Number(v))).map(Number);
    return n.length ? n.reduce((x, y) => x + y, 0) / n.length : null;
};

/**
 * Recompute a quality row's metrics over a restricted task set. The same arithmetic the
 * server does, applied to a subset -- so "common tasks only" is a real recomputation, not a
 * percentage filtered after the fact.
 */
export function qualityMetricsFor(tasks, ids) {
    const ents = Object.entries(tasks || {}).filter(([id]) => !ids || ids.has(id));
    const list = ents.map(([, t]) => t);
    // a bonus test's result (`<id>+bonus`, 2026-10-14) has no wall clock of its own (its run's is the parent's): it is a
    // solve, but not one that solves-per-hour may count against hours it did not spend
    const bonusIds = new Set(ents.filter(([id]) => /\+bonus$/.test(id)).map(([, t]) => t));
    let scored = 0, solved = 0, excluded = 0, aP = 0, aT = 0, timedSolved = 0;
    const tok = [], wall = [], tools = [], allWall = [];
    for (const t of list) {
        // `excluded` is "no scoreable run at all". Anything else is scored, and a task run more
        // than once counts fractionally -- the same fold lib/models.js applies, so the two cannot
        // disagree. The denominator is never `attempted`: an excluded row is not a model answer,
        // so it cannot sit in the bottom of a rate.
        if (t.excluded) { excluded++; continue; }
        scored++;
        if (t.wall_s != null) allWall.push(t.wall_s);
        if (t.assertions && Number.isFinite(Number(t.assertions.total))) { aP += Number(t.assertions.passed || 0); aT += Number(t.assertions.total); }
        if (t.solved) {
            solved += (t.credit != null ? t.credit : 1);
            if (!bonusIds.has(t)) timedSolved += (t.credit != null ? t.credit : 1);
            if (t.tokens_out > 0) tok.push(t.tokens_out);   // 0 on a solve = count not recorded
            if (t.wall_s != null) wall.push(t.wall_s);
            if (t.tool_calls != null) tools.push(t.tool_calls);
        }
    }
    const wallTotal = allWall.reduce((a, b) => a + b, 0);
    return {
        // counted: what a coverage figure counts (a level problem not scored yet, `unscored`, is not in the "/N" total)
        attempted: list.length, counted: list.filter((t) => !t.unscored).length, scored, solved, excluded,
        solveRate: scored ? solved / scored : null,
        assertions: aT ? { passed: aP, total: aT } : null,
        tokensPerSolve: solved ? avg(tok) : null,
        tokensPerSolveMedian: solved ? med(tok) : null,
        wallPerSolve: solved ? avg(wall) : null,
        wallPerSolveMedian: solved ? med(wall) : null,
        toolCallsPerSolve: solved ? avg(tools) : null,
        solvesPerHour: wallTotal > 0 ? timedSolved / (wallTotal / 3600) : null,
    };
}

// ============================================================ details popover
// One floating card at a time. Shown on hover (pointer devices, after a short delay) and pinned
// on click / tap; dismissed by Escape, a click elsewhere, or its close button. `actions` are
// [{label, onClick}] buttons at the bottom (e.g. "Model details ->").
let popEl = null, popPinned = false, popTimer = null;
function ensurePop() {
    if (popEl) return popEl;
    popEl = document.createElement('div');
    popEl.className = 'lb-pop fixed z-50 text-[11px] leading-snug text-gray-200 bg-gray-950 border border-gray-700 rounded-lg shadow-2xl p-3 hidden';
    // Never wider or taller than the screen (a phone is ~400 px wide); long launch commands wrap
    // anywhere instead of forcing the card wider; a tall card scrolls inside itself.
    Object.assign(popEl.style, { maxWidth: 'min(34rem, calc(100vw - 16px))', maxHeight: 'calc(100vh - 24px)',
        overflowY: 'auto', overflowWrap: 'anywhere', wordBreak: 'break-word' });
    document.body.appendChild(popEl);
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hidePopover(true); });
    document.addEventListener('pointerdown', (e) => { if (popEl && !popEl.contains(e.target) && !e.target.closest('[data-pop-anchor]')) hidePopover(true); }, true);
    popEl.addEventListener('mouseenter', () => clearTimeout(popTimer));
    popEl.addEventListener('mouseleave', () => { if (!popPinned) hidePopover(); });
    return popEl;
}
export function hidePopover(force) {
    clearTimeout(popTimer);
    if (!popEl || (popPinned && !force)) return;
    popEl.classList.add('hidden'); popPinned = false;
}
/** Show `html` near (x, y) viewport coords. pin=true keeps it until dismissed. */
export function showPopover(x, y, html, { actions = [], pin = false } = {}) {
    const el = ensurePop();
    el.innerHTML = `<button type="button" class="lb-pop-x float-right ml-2 text-gray-500 hover:text-gray-200" aria-label="close">✕</button>${html}`
        + (actions.length ? `<div class="mt-2 flex gap-2">${actions.map((a, i) => `<button type="button" data-pop-act="${i}" class="px-2 py-1 rounded bg-indigo-600 hover:bg-indigo-500 text-white text-[11px]">${esc(a.label)}</button>`).join('')}</div>` : '');
    el.querySelector('.lb-pop-x').addEventListener('click', () => hidePopover(true));
    el.querySelectorAll('[data-pop-act]').forEach((b) => b.addEventListener('click', () => { hidePopover(true); actions[Number(b.dataset.popAct)].onClick(); }));
    el.classList.remove('hidden');
    popPinned = pin;
    // keep it on screen
    const r = el.getBoundingClientRect();
    // Clamp to the viewport on both sides: the card may be as wide as the screen itself.
    const px = Math.max(8, Math.min(x + 12, window.innerWidth - r.width - 8));
    const py = Math.max(8, (y + 12 + r.height > window.innerHeight) ? Math.min(y - r.height - 12, window.innerHeight - r.height - 8) : y + 12);
    el.style.left = `${px}px`; el.style.top = `${py}px`;
}
/** Wire hover-preview + click/tap-pin on `el` for content from `render()`. */
export function attachPopover(el, render, actions) {
    el.setAttribute('data-pop-anchor', '1');
    el.addEventListener('mouseenter', (e) => {
        if (popPinned) return;
        clearTimeout(popTimer);
        popTimer = setTimeout(() => showPopover(e.clientX, e.clientY, render(), { actions: actions ? actions() : [] }), 350);
    });
    el.addEventListener('mouseleave', () => { clearTimeout(popTimer); setTimeout(() => { if (!popPinned && popEl && !popEl.matches(':hover')) hidePopover(); }, 150); });
    el.addEventListener('click', (e) => { clearTimeout(popTimer); showPopover(e.clientX, e.clientY, render(), { actions: actions ? actions() : [], pin: true }); });
}

/**
 * createLeaderboard(el, opts)
 *   opts.columns      [{id, label, title, kind, dir, sub}]   sub: a second line under the value
 *   opts.defaultSort  column id
 *   opts.note         the board's standing caveat (rendered above the table, always visible)
 *   opts.commonTasks  true -> show the "common tasks only" toggle and recompute quality metrics
 *   opts.onRow(row)   click-through
 *   opts.limit        show only the top N rows (the Models overview's SHORT summary boards);
 *                     the footer then says how many were left out and where the full board is
 *   opts.more         {label, onClick} rendered in that footer
 *   opts.emptyText
 *   opts.highlight(row) -> true: the row is ringed in gold (the Models page's search term). Read on every render(),
 *                     so a new term only needs render(); with opts.limit the footer counts the matches below the cut
 */
export function createLeaderboard(el, opts) {
    // opts.rowDetail(row) -> html: a row then opens a details card (hover / click / tap) with a
    //   "Model details" button (opts.onRow) instead of navigating straight away.
    // opts.method: html explaining how this board's numbers are adjusted, behind an info button.
    const o = { columns: [], defaultSort: null, note: null, commonTasks: false, limit: null, more: null, emptyText: 'Nothing recorded yet.', rowDetail: null, method: null, highlight: null, ...opts };
    const hl = (r) => !!(o.highlight && o.highlight(r));
    if (o.highlight) ensureHighlightStyle();
    let rows = [];
    let sortId = o.defaultSort || (o.columns[0] && o.columns[0].id);
    let sortDir = null;
    let commonOnly = false;
    try { commonOnly = localStorage.getItem(`lb_common_${o.id || 'x'}`) === '1'; } catch { /* private mode */ }

    el.innerHTML = '';
    el.className = 'space-y-2';
    const head = document.createElement('div');
    const warn = document.createElement('div');
    let noteOpen = false;
    const wrap = document.createElement('div');
    wrap.className = 'overflow-x-auto';
    const foot = document.createElement('div');
    el.append(head, warn, wrap, foot);

    // opts.rowsForSort(colId, dir): rows are re-derived for the active sort. The overview boards
    // use it to show each model under its best config FOR THE COLUMN BEING RANKED.
    function effectiveRows() {
        if (o.rowsForSort) {
            const c0 = o.columns.find((c) => c.id === sortId) || o.columns[0];
            rows = o.rowsForSort(c0 && c0.id, sortDir || (c0 && c0.dir) || 'desc') || [];
        }
        if (!o.commonTasks || !commonOnly) return rows.map((r) => ({ ...r }));
        const { ids } = commonTaskSet(rows);
        return rows.map((r) => {
            if (!r.tasks || !Object.keys(r.tasks).length) return { ...r };
            const q = qualityMetricsFor(r.tasks, ids);
            // n is the DENOMINATOR the rate was computed over, which is `scored`. Printing
            // `attempted` here put excluded rows under a rate they were not part of --
            // Terse-Coder read 9/12 with one fail, because two provider errors were sitting
            // in the bottom of a fraction they had been excluded from.
            return { ...r, metrics: { ...r.metrics, ...qualityToMetrics(q) }, n: q.scored,
                coverage: { attempted: q.attempted, total: r.coverage ? r.coverage.total : null } };
        });
    }

    function render() {
        const list = effectiveRows();
        // header: sort state + the common-tasks control
        const cov = o.commonTasks ? commonTaskSet(rows) : null;
        // The board's note is methodology: folded under "About this board" (open state kept across re-renders).
        head.className = 'flex flex-wrap items-start gap-x-4 gap-y-1 mb-2';
        head.innerHTML = (o.note ? `<details class="how lb-note" ${noteOpen ? 'open' : ''}><summary>About this board</summary><div class="how-body">${o.note}</div></details>` : '')
            + (o.method
                ? `<button type="button" class="lb-method text-[11.5px] font-medium text-sky-300 hover:text-sky-200">ⓘ how these numbers are adjusted</button>` : '');
        head.querySelector('.lb-note')?.addEventListener('toggle', (e) => { noteOpen = e.currentTarget.open; });
        const mb = head.querySelector('.lb-method');
        if (mb) attachPopover(mb, () => o.method);
        if (o.commonTasks) {
            const shared = cov.ids ? cov.ids.size : 0;
            head.insertAdjacentHTML('beforeend', `
                <label class="mt-1 inline-flex items-center gap-1.5 text-[10px] text-gray-400 cursor-pointer">
                    <input type="checkbox" class="lb-common accent-indigo-500" ${commonOnly ? 'checked' : ''}>
                    common tasks only <span class="text-gray-600">(${shared} task${shared === 1 ? '' : 's'} attempted by all ${cov.rowsCompared} rows)</span>
                </label>`);
            const cb = head.querySelector('.lb-common');
            if (cb) cb.addEventListener('change', () => {
                commonOnly = cb.checked;
                try { localStorage.setItem(`lb_common_${o.id || 'x'}`, commonOnly ? '1' : '0'); } catch { /* ignore */ }
                render();
            });
            warn.innerHTML = (!commonOnly && !cov.allSame && cov.rowsCompared > 1)
                ? `<div class="text-[10px] text-red-200 bg-red-900/25 border border-red-800/50 rounded px-2 py-1">
                     These rows attempted <b>different task sets</b> — the percentages below are <b>not comparable</b> as printed.
                     Only ${cov.ids.size} task${cov.ids.size === 1 ? ' is' : 's are'} shared by all ${cov.rowsCompared} rows. Tick “common tasks only” to compare like with like.
                   </div>`
                : (commonOnly ? `<div class="text-[10px] text-gray-500">Restricted to the ${cov.ids.size} task${cov.ids.size === 1 ? '' : 's'} every row attempted; every number below is recomputed over that set.</div>` : '');
        }

        if (!list.length) { wrap.innerHTML = `<div class="text-xs text-gray-600 py-4 text-center">${esc(o.emptyText)}</div>`; foot.innerHTML = ''; return; }

        const col = o.columns.find((c) => c.id === sortId) || o.columns[0];
        const dir = sortDir || (col && col.dir) || 'desc';
        const sorted = [...list].sort((a, b) => {
            const av = val(a.metrics && a.metrics[col.id]);
            const bv = val(b.metrics && b.metrics[col.id]);
            const ma = a.metrics && a.metrics[col.id], mb = b.metrics && b.metrics[col.id];
            const sa = ma && typeof ma === 'object' && ma.sort != null ? ma.sort : null;
            const sb = mb && typeof mb === 'object' && mb.sort != null ? mb.sort : null;
            if (sa != null || sb != null) {
                if (sa == null) return 1;
                if (sb == null) return -1;
                if (sa !== sb) return dir === 'asc' ? sa - sb : sb - sa;
                return String(a.label).localeCompare(String(b.label));
            }
            const an = (av && typeof av === 'object') ? (av.total ? av.passed / av.total : null) : av;
            const bn = (bv && typeof bv === 'object') ? (bv.total ? bv.passed / bv.total : null) : bv;
            if (an == null && bn == null) return String(a.label).localeCompare(String(b.label));
            if (an == null) return 1;                     // nulls always last, whichever way we sort
            if (bn == null) return -1;
            if (typeof an === 'string' || typeof bn === 'string') return dir === 'asc' ? String(an).localeCompare(String(bn)) : String(bn).localeCompare(String(an));
            return dir === 'asc' ? an - bn : bn - an;
        });

        // Ranks are only printed where the data supports an ordering. When the sorted column
        // carries a confidence interval and two neighbours' intervals overlap, they are tied:
        // the row shows "=" and the tooltip says why.
        const ciOf = (r) => { const m = r.metrics && r.metrics[col.id]; return m && typeof m === 'object' ? m.ci : null; };
        // Two kinds of tie, and they are not the same claim:
        //   EXACT  -- identical values on the sorted column. Competition ranking: they share the
        //             rank they tied for (1,2,2,4), because printing 2 and 3 for two equal scores
        //             invents an ordering out of array position.
        //   OVERLAP -- different values whose 95% intervals overlap. Shown as "=": the numbers
        //             differ but the data cannot separate them.
        const valOf = (r) => { const m = r.metrics && r.metrics[col.id]; return m && typeof m === 'object' ? m.v : m; };
        const ranks = [];
        let tiedAny = false;
        sorted.forEach((r, i) => {
            if (i === 0) { ranks.push({ text: '1', tied: false, n: 1 }); return; }
            const prev = ranks[i - 1];
            const va = valOf(sorted[i - 1]), vb = valOf(r);
            if (va != null && vb != null && va === vb) {
                ranks.push({ text: String(prev.n), tied: true, exact: true, n: prev.n, with: sorted[i - 1].label });
                return;
            }
            const a2 = ciOf(sorted[i - 1]), b2 = ciOf(r);
            // a strength column with a bootstrap answers with the gap's own range (strengthMetric sepFrom); else the overlap
            const sep = a2 && b2 && typeof a2.sepFrom === 'function' ? a2.sepFrom(b2) : null;
            if (a2 && b2 && (sep == null ? overlaps(a2, b2) : !sep)) { tiedAny = true; ranks.push({ text: '=', tied: true, n: i + 1, with: sorted[i - 1].label }); }
            else ranks.push({ text: String(i + 1), tied: false, n: i + 1 });
        });
        const shown = o.limit ? sorted.slice(0, o.limit) : sorted;
        const tieNote = tiedAny
            ? `<div class="text-[10px] text-amber-200/90 pt-1">Rows marked <span class="font-mono">=</span> are <b>tied</b>: the data cannot order them (their 95% intervals overlap, or, for strength where the board has the bootstrap, the 95% range of the gap between the two includes 0), so the order between them is not a result. At n≈12 the interval on a solve rate is roughly ±25 points — 11/12 and 10/11 are the same measurement.</div>`
            : '';
        // a summary board shows only its top rows: say how many highlighted ones sit below the cut
        const hidden = o.limit && o.highlight ? sorted.slice(o.limit).filter(hl).length : 0;
        const hiddenNote = hidden ? ` · <span style="color:var(--hl-gold, ${HIGHLIGHT})">${hidden} highlighted model${hidden === 1 ? '' : 's'} below the top ${o.limit}</span>` : '';
        foot.innerHTML = tieNote + ((o.limit && sorted.length > o.limit)
            ? `<div class="text-[10px] text-gray-500 pt-1">top ${o.limit} of ${sorted.length}${hiddenNote}${o.more ? ` — <button type="button" class="lb-more underline hover:text-gray-300">${esc(o.more.label)}</button>` : ''}</div>`
            : (o.more ? `<div class="text-[10px] text-gray-500 pt-1"><button type="button" class="lb-more underline hover:text-gray-300">${esc(o.more.label)}</button></div>` : ''));

        const th = (c) => `<th class="lb-th text-right cursor-pointer select-none whitespace-nowrap hover:text-gray-200 ${c.id === col.id ? '!text-indigo-300' : ''}"
            data-sort="${esc(c.id)}" ${c.title ? `title="${esc(c.title)}"` : ''}>${esc(c.label)}${c.id === col.id ? (dir === 'asc' ? ' ↑' : ' ↓') : ''}</th>`;

        // A warning every shown row carries (e.g. "llama-bench measures raw decode with NO speculative
        // decoding") is said once above the table instead of on every row; row-specific ones stay inline.
        const common = shown.length > 1
            ? (shown[0].warnings || []).filter((w) => shown.every((r) => (r.warnings || []).includes(w)))
            : [];
        const own = (r) => (r.warnings || []).filter((w) => !common.includes(w));

        wrap.innerHTML = `${common.length ? `<div class="lb-banner">${common.map((w) => `<div class="flex gap-2"><span class="text-amber-400 shrink-0">⚠</span><span>${esc(w)}</span></div>`).join('')}<div class="text-[10px] text-amber-200/50 mt-1">applies to every row below</div></div>` : ''}
            <table class="w-full text-[11.5px] lb-table">
            <thead><tr>
                <th class="lb-th text-left w-8">#</th>
                <th class="lb-th text-left">Entry</th>
                ${o.columns.map(th).join('')}
                <th class="lb-th text-right" title="How many tasks / reps / requests this row is computed over. A one-run row is not a measurement.">n</th>
                <th class="lb-th text-right" title="How much of the suite this entry has actually attempted.">coverage</th>
            </tr></thead>
            <tbody class="text-gray-300">${shown.map((r, i) => `
                <tr class="${o.onRow ? 'cursor-pointer' : ''}" data-key="${esc(r.key)}"${hl(r) ? ' data-hl="1"' : ''}>
                    <td class="lb-td text-gray-500 font-mono" ${ranks[i] && ranks[i].tied ? `title="${ranks[i].exact ? `identical score to ${esc(ranks[i].with)} — they share this rank` : `tied with ${esc(ranks[i].with)}: their confidence intervals overlap, so the ordering between them is not something this data can decide`}"` : ''}>${ranks[i] ? ranks[i].text : i + 1}</td>
                    <td class="lb-td">
                        <div class="text-gray-100 font-medium">${esc(r.label)}${r.badges ? ' ' + r.badges : ''}</div>
                        ${r.sublabel ? `<div class="text-[10.5px] text-gray-500 font-mono truncate max-w-[34rem] mt-0.5" title="${esc(r.sublabelFull || r.sublabel)}">${esc(r.sublabel)}</div>` : ''}
                        ${own(r).map((w) => `<div class="text-[10.5px] text-amber-300/90 mt-0.5">⚠ ${esc(w)}</div>`).join('')}
                    </td>
                    ${o.columns.map((c) => {
                        const m = r.metrics && r.metrics[c.id];
                        const sub = (m && typeof m === 'object' && m.n != null) ? `<div class="text-[9px] text-gray-600">n=${m.n}</div>` : '';
                        const note = (m && typeof m === 'object' && m.note) ? ` title="${esc(m.note)}"` : '';
                        const coarse = (m && typeof m === 'object' && m.coarse) ? '<span class="text-amber-400/80" title="coarse: tokens ÷ wall clock, not a measured rate">~</span>' : '';
                        return `<td class="lb-td text-right font-mono whitespace-nowrap ${c.id === col.id ? 'text-gray-100' : ''}"${note}>${coarse}${fmtCell(c, m)}${sub}</td>`;
                    }).join('')}
                    <td class="lb-td text-right font-mono text-gray-500">${r.n == null ? '—' : fmtN(r.n)}</td>
                    <td class="lb-td text-right font-mono ${coverageClass(r)}">${coverageText(r)}</td>
                </tr>`).join('')}
            </tbody></table>`;

        wrap.querySelectorAll('th[data-sort]').forEach((h) => h.addEventListener('click', () => {
            const id = h.dataset.sort;
            if (id === sortId) sortDir = dir === 'asc' ? 'desc' : 'asc';
            else { sortId = id; sortDir = null; }
            render();
        }));
        if (o.rowDetail) {
            wrap.querySelectorAll('tr[data-key]').forEach((tr) => {
                const r = shown.find((x) => String(x.key) === tr.dataset.key);
                if (!r) return;
                attachPopover(tr, () => o.rowDetail(r), () => (o.onRow ? [{ label: 'Model details →', onClick: () => o.onRow(r) }] : []));
            });
        } else if (o.onRow) wrap.querySelectorAll('tr[data-key]').forEach((tr) => tr.addEventListener('click', () => {
            const r = shown.find((x) => String(x.key) === tr.dataset.key);
            if (r) o.onRow(r);
        }));
        foot.querySelector('.lb-more')?.addEventListener('click', () => o.more.onClick());
    }

    function coverageText(r) {
        const c = r.coverage;
        if (!c || c.attempted == null) return '—';
        return c.total ? `${c.attempted}/${c.total}` : String(c.attempted);
    }
    function coverageClass(r) {
        const c = r.coverage;
        if (!c || !c.total || c.attempted == null) return 'text-gray-500';
        const f = c.attempted / c.total;
        return f >= 0.9 ? 'text-green-300' : (f >= 0.3 ? 'text-yellow-300' : 'text-orange-300');
    }

    return {
        setRows(next) { rows = next || []; render(); },
        get commonOnly() { return commonOnly; },
        render,
    };
}

/** Map a qualityMetricsFor() result onto the standard quality column ids. */
export function qualityToMetrics(q) {
    return {
        solveRate: {
            v: q.solveRate, n: q.scored, ci: wilson(q.solved, q.scored),
            note: `${q.solved}/${q.scored} scored tasks solved${q.excluded ? `; ${q.excluded} excluded (OVERFLOW/KILLED/PROVIDER_ERROR/ABORTED — not failures)` : ''} · 95% Wilson interval shown beneath`,
        },
        excluded: q.excluded,
        assertions: { v: q.assertions },
        tokensPerSolve: { v: q.tokensPerSolve, n: q.solved, note: q.tokensPerSolveMedian != null ? `median ${Math.round(q.tokensPerSolveMedian).toLocaleString()}` : null },
        wallPerSolve: { v: q.wallPerSolve, n: q.solved, note: q.wallPerSolveMedian != null ? `median ${fmtDur(q.wallPerSolveMedian)}` : null },
        toolCallsPerSolve: { v: q.toolCallsPerSolve, n: q.solved },
        solvesPerHour: { v: q.solvesPerHour, n: q.scored, note: 'solved tasks ÷ total wall clock of every scored task, including the ones that failed' },
    };
}

/**
 * Map a lib/models.js aggregateQuality() result (a model's `quality` or one config's `agg`) onto
 * the standard quality column ids. Differs from qualityToMetrics only in shape: here the
 * per-solve figures arrive as {mean, median, n}.
 */
export function aggToMetrics(q) {
    q = q || {};
    return {
        solveRate: { v: q.solveRate, n: q.scored, ci: wilson(q.solved, q.scored), note: `${q.solved}/${q.scored} scored solved${q.excluded ? `; ${q.excluded} excluded` : ''}` },
        excluded: q.excluded,
        assertions: { v: q.assertions },
        tokensPerSolve: q.tokensPerSolve ? { v: q.tokensPerSolve.mean, n: q.tokensPerSolve.n, note: `median ${Math.round(q.tokensPerSolve.median).toLocaleString()}` } : null,
        wallPerSolve: q.wallPerSolve ? { v: q.wallPerSolve.mean, n: q.wallPerSolve.n, note: `median ${fmtDur(q.wallPerSolve.median)}` } : null,
        toolCallsPerSolve: q.toolCallsPerSolve ? { v: q.toolCallsPerSolve.mean, n: q.toolCallsPerSolve.n } : null,
        solvesPerHour: { v: q.solvesPerHour, n: q.scored, note: q.wallTotal_s ? `over ${fmtDur(q.wallTotal_s)} of scored wall clock` : null },
    };
}

/**
 * One SET OF WEIGHTS -- what a leaderboard ranks. A local catalog key is already one gguf; a cloud
 * key also carries effort / scaffold, which are configs of the same weights, so the server gives
 * both a shared `weightsKey`. Different quants are different weights and stay separate.
 */
export const weightsOf = (m) => m.weightsKey || m.key;
export const weightsLabel = (m) => m.weightsDisplay || m.display;

/** What distinguishes this catalog entry within its weights: a cloud "(low, solo)", else ''. */
export function variantOf(m) {
    const f = weightsLabel(m);
    return m.display && m.display !== f && m.display.startsWith(f) ? m.display.slice(f.length).trim() : '';
}

// ============================================================ prompt levels are problems (2026-10-17)
// Kyle: "every different prompt is a different PROBLEM". A result of task T at prompt level L3 is the problem `T@L3` (its
// bonus test `T@L3+bonus`); L2, or no level recorded, is T itself. A config's row no longer includes the level: one row
// can have run T and T@L3, two problems. The same functions as lib/models.js (promptLevelOf / problemId / problemOf);
// test/promptlevel.test.js holds the two copies equal.
const PROBLEM_RE = /^(.+?)@(L\d+)(\+bonus)?$/;
// MINIMUM CONFIGS FIRST (Kyle, 2026-10-17): a level problem earns strength points only once this many distinct config
// rows have a scored result on it (difficultyAdjusted counts its own fitted groups; the server counts the Models page's
// default rows for the "/N" total and the "not scored yet" markers). lib/models.js LEVEL_MIN_CONFIGS is the same number.
export const LEVEL_MIN_CONFIGS = 5;
/** 'L3' / 'L3+careful-tone' -> 'L3'; null, '' or 'L2+docs' -> 'L2'. */
export function promptLevel(pl) {
    const l = String(pl == null ? '' : pl).split('+')[0].trim().toUpperCase();
    return /^L\d+$/.test(l) ? l : 'L2';
}
/** 'L2+careful-tone' / 'L3+careful-tone' -> 'careful-tone'; 'L2' / 'L3' / null -> null. */
export function promptVariant(pl) {
    const bits = String(pl == null ? '' : pl).split('+').slice(1).filter(Boolean);
    return bits.length ? bits.join('+') : null;
}
/** The problem a result of `task` at `level` answers: T at L2, `T@L3` at L3, `T@L3+bonus` for T's bonus test. */
export function problemId(task, level) {
    const t = String(task), l = promptLevel(level);
    if (l === 'L2') return t;
    return t.endsWith('+bonus') ? `${t.slice(0, -6)}@${l}+bonus` : `${t}@${l}`;
}
/** A problem id -> { id, task (the result file's task id: T or T+bonus), base (T), level, bonus }. */
export function problemOf(id) {
    const s = String(id), m = PROBLEM_RE.exec(s);
    if (m) return { id: s, task: m[1] + (m[3] || ''), base: m[1], level: m[2], bonus: !!m[3] };
    const bonus = s.endsWith('+bonus');
    return { id: s, task: s, base: bonus ? s.slice(0, -6) : s, level: 'L2', bonus };
}

/** One codebench config, in words. Short form for a sublabel; `full` adds every recorded field. */
/**
 * A Strata config's launch, in words (2026-10-20): lib/models.js strataLaunchInfo -- the engine config FILE the queue item
 * launched (a Strata run has no llama-server flags to record). Short: the file's name; full: the name and what it sets.
 * null when `s` is absent (not a Strata run), so the caller falls back to the llama.cpp wording.
 */
export function strataLaunchText(s, full, nCtx) {
    if (!s) return null;
    const name = s.config ? s.config.replace(/\.json$/, '') : null;
    if (!name) return 'Strata (launch config not recorded)';
    if (!full) return `Strata config ${name}`;
    const f = s.facts;
    if (!f) return `Strata config ${s.config}${s.derived ? ' (dashboard copy with overrides)' : ''} (file no longer on disk: settings unknown)`;
    const num = (v) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 100) / 100));
    const bits = [];
    if (f.ctx && f.ctx !== nCtx) bits.push(`${ctxLabel(f.ctx)} max context`);
    if (f.kv) bits.push(`KV ${f.kv}`);
    if (f.kvResident) bits.push(`KV resident ${ctxLabel(f.kvResident)}`);
    if (f.rope) bits.push(`rope ${f.rope}`);
    if (f.gpus && f.gpus.length) bits.push(f.gpus.length > 1 ? `GPUs ${f.gpus.join('+')}${f.layerSplit ? ` (layer split ${f.layerSplit})` : ''}` : `GPU ${f.gpus[0]}`);
    if (f.spec != null) bits.push(`spec ${num(f.spec)}${f.specMinP != null ? ` (min-p ${num(f.specMinP)})` : ''}`);
    if (f.pipelineWindows != null) bits.push(`pipeline windows ${num(f.pipelineWindows)}`);
    if (f.residentBudgetGib != null) bits.push(`resident budget ${num(f.residentBudgetGib)} GiB`);
    for (const x of f.switches || []) bits.push(x);
    const sm = f.sampling;
    if (sm && (sm.temperature != null || sm.top_p != null || sm.top_k != null)) {
        bits.push(`sampling ${[sm.temperature != null && `temp ${num(sm.temperature)}`, sm.top_p != null && `top-p ${num(sm.top_p)}`, sm.top_k != null && `top-k ${num(sm.top_k)}`].filter(Boolean).join(' / ')}`);
    }
    return `Strata config ${s.config}${s.derived ? ' (dashboard copy with overrides)' : ''}${bits.length ? `: ${bits.join(', ')}` : ''}`
        + (s.editedSince ? ' (file changed since this run: settings as it reads now)' : '');
}

/**
 * A config's context as its row says it (2026-10-25). `c`: a catalog config or battery (lib/models.js runDescriptor):
 * n_ctx is the context it is FILED under, ctx_label that in words (ctxLabel, ui/shared/ctxlabel.js: the one rule, 131072
 * and 128000 both read 128k), and agentWindow is there only when the agent's window was out of step with the server (an
 * alias the harness did not put in step; the Ornith "262k" runs: local-128k = 128000 on a 262144 server, filed at 131072,
 * the size that window runs on in step). A row pooling runs with and without one has none (commonWindow): plain "128k
 * ctx". Modes:
 *   'short' -> "128k"      | "128k agent window"
 *   'row'   -> "128k ctx"  | "128k ctx (agent window; 256k server)"
 *   'full'  -> "128k ctx"  | "128k ctx: agent window local-128k = 128000 tokens, compacting at 111616, on a server with
 *                             n_ctx 262144 (256k), filed with the in-step 128k runs"
 * null without a context. (A catalog from before 10-25 has no ctx_label: the same rule from n_ctx.)
 */
export function ctxText(c, mode = 'row') {
    if (!c || !c.n_ctx) return null;
    const lab = c.ctx_label || ctxLabel(c.n_ctx), w = c.agentWindow;
    if (mode === 'short') return w ? `${lab} agent window` : lab;
    if (!w) return `${lab} ctx`;
    if (mode !== 'full') return `${lab} ctx (agent window; ${w.serverLabel || '?'} server)`;
    const alias = w.model ? `${String(w.model).replace(/^llama-local\//, '')} = ` : '';
    return `${lab} ctx: agent window ${alias}${w.window || w.effective_ctx} tokens${w.compaction_at ? `, compacting at ${w.compaction_at}` : ''}, `
        + `on a server with n_ctx ${w.server_n_ctx || '?'} (${w.serverLabel || '?'}), filed with the in-step ${lab} runs`;
}

export function configText(m, c, full) {
    const kctx = ctxText(c, full ? 'full' : 'row');   // the context it is filed under; an agent window says so (2026-10-25)
    // A Strata config has no llama-server flags by design: its engine config file says how it ran (strataLaunchText)
    const strata = c.launchUnknown && !c.launchConflict ? strataLaunchText(c.strata, full, c.n_ctx) : null;
    const launch = strata || (c.launchUnknown
        ? (c.launchConflict ? 'launch flags unknown (recorded command contradicts the server)' : 'launch flags unrecorded')
        : c.launchSummary);
    const bits = [variantOf(m), harnessLabel(c.runner, c.scaffold), c.effort && `effort ${c.effort}`, scaffoldBit(c.runner, c.scaffold), kctx, launch,
        c.timeout_s && `${Math.round(c.timeout_s / 60)}m cap`];
    // the prompt: its variant (part of the config), and the levels it was run at (each level is its own set of problems)
    const pv = promptVariant(c.prompt_level), lv = (c.prompt_levels || []).filter((l) => l !== 'L2');
    if (full) bits.push(c.runnerModel && `model id ${c.runnerModel}`, pv ? `prompt +${pv}` : 'default prompt',
        lv.length ? `ran prompt ${(c.prompt_levels || []).join(' + ')} problems` : null, c.harness_mode, c.build_info && `build ${c.build_info}`,
        c.launchCommand && !c.launchUnknown ? c.launchCommand : null);
    return bits.filter(Boolean).join(' · ') || '—';
}

// ============================================================ facets: what separates two runs
// Every codebench config arrives at its finest grain (lib/models.js runDescriptor: every recorded
// parameter, by facet). A board or page chooses which facets SEPARATE runs; every other facet is
// collapsed and runs that differ only there merge. The defaults are each board's honest choice
// (MTP cannot change an answer, so Quality collapses it); the chips let the reader choose.
export const FACETS = [
    { id: 'harness', label: 'harness', title: 'runner, runner model id, effort, scaffold, prompt variant (careful-tone, review, ...), time cap. Not the prompt level: a task at L3 is a problem of its own (T@L3), run by the same config' },
    { id: 'context', label: 'context', title: 'context size and parallel slots' },
    { id: 'output', label: 'p/k/temp/template', title: 'sampler settings (top-p, top-k, temperature), chat template (--jinja) and reasoning handling (thinking off, --reasoning-preserve)' },
    { id: 'kv', label: 'KV type', title: 'KV cache precision' },
    { id: 'speculative', label: 'MTP / draft', title: 'speculative decoding: MTP, draft model, draft device' },
    { id: 'placement', label: 'GPU placement', title: 'devices, split, offload, flash attention, batch sizes' },
    { id: 'build', label: 'engine version', title: 'the engine build that served the run: llama.cpp commit, build dir, backend flags and binary fingerprint, or the Strata version. Off for quality by default (a newer build of the same launch is the same row), on for speed' },
    { id: 'machine', label: 'machine', title: 'CPU, RAM, GPUs, PCIe links, power limits' },
    { id: 'served', label: 'date served (cloud)', title: 'the day a cloud model served the run — the model behind a fixed name drifts' },
    { id: 'other', label: 'other flags', title: 'launch flags this dashboard does not classify — kept apart by default, since they could change anything' },
];
export const FACET_DEFAULTS = {
    quality: ['harness', 'context', 'output', 'kv', 'other'],
    full: FACETS.map((f) => f.id),
};

/** The `answered` marks of several cells (lib/models.js answeredOfRuns), pooled: counts added, notes listed. Display only. */
export function mergeAnswered(list) {
    const xs = (list || []).map((t) => t && t.answered).filter(Boolean);
    if (!xs.length) return null;
    const out = { passed: 0, failed: 0, compacted: 0 };
    for (const x of xs) { out.passed += x.passed || 0; out.failed += x.failed || 0; out.compacted += x.compacted || 0; }
    const notes = xs.flatMap((x) => x.answeredNotes || []);
    return notes.length ? { ...out, answeredNotes: notes } : out;
}
/** The `overflowed` marks of several cells (lib/models.js overflowedOfRuns: { passed }), pooled: passing runs that outgrew
 *  the context window and carried on, added up. null when none. Display only (2026-10-24). */
export function mergeOverflowed(list) {
    const n = (list || []).reduce((a, t) => a + ((t && t.overflowed && t.overflowed.passed) || 0), 0);
    return n > 0 ? { passed: n } : null;
}
/** Per-config `unfinished` maps (lib/models.js unfinishedMap), pooled. They sit BESIDE `tasks`, so nothing that counts
 *  cells sees them. Display and the planner's "waiting for a continuation" only. */
export function mergeUnfinished(maps) {
    const out = {};
    for (const m of maps || []) for (const [id, u] of Object.entries(m || {})) {
        const o = out[id] || (out[id] = { n: 0, compacted: 0, saved: 0, pruned: 0, unknown: 0 });
        for (const k of ['n', 'compacted', 'saved', 'pruned', 'unknown']) o[k] += u[k] || 0;
        if (u.unfinishedNotes) o.unfinishedNotes = (o.unfinishedNotes || []).concat(u.unfinishedNotes);
    }
    return Object.keys(out).length ? out : null;
}

/** Merge per-task maps from several configs: attempts and passes add, credit is recomputed. */
export function mergeTasks(maps) {
    if (maps.length === 1) return maps[0];
    const out = {};
    for (const m of maps) for (const [id, t] of Object.entries(m || {})) (out[id] = out[id] || []).push(t);
    for (const [id, all] of Object.entries(out)) {
        // t/s sums (lib/models.js sumRunSpeed) add over EVERY member, folded or not: speed is not an outcome,
        // and `...rep` below would otherwise keep one member's runs and drop the rest
        const speed = mergeSpeed(all.map((t) => t.speed));
        // folded sample-group siblings (lib/models.js) are shown but never scored: if any config
        // scored this task, merge only those; if none did, pass the folded entry through untouched
        const list = all.filter((t) => !t.folded_into);
        // runs answered with the original prompt (display only): pooled over every member, folded or not
        const answered = mergeAnswered(all);
        if (!list.length) {
            out[id] = speed ? { ...all[0], speed } : { ...all[0] };
            if (answered) out[id].answered = answered; else delete out[id].answered;
            const ovAll = mergeOverflowed(all);
            if (ovAll) out[id].overflowed = ovAll; else delete out[id].overflowed;
            continue;
        }
        const attempts = list.reduce((a, t) => a + (t.attempts || 0), 0);
        const passes = list.reduce((a, t) => a + (t.passes || 0), 0);
        const credit = attempts ? passes / attempts : null;
        // cost fields: from the members that solved it (weighted by passes), else the scored ones
        const pool = list.filter((t) => t.passes > 0);
        const src = pool.length ? pool : list.filter((t) => t.attempts > 0);
        const w = (t) => (pool.length ? t.passes : t.attempts) || 1;
        const wavg = (k) => {
            const v = src.filter((t) => t[k] != null && t[k] > 0);
            const W = v.reduce((a, t) => a + w(t), 0);
            return W ? v.reduce((a, t) => a + t[k] * w(t), 0) / W : null;
        };
        const rep = list.reduce((a, t) => ((t.attempts || 0) > (a.attempts || 0) ? t : a), list[0]);
        const aa = list.map((t) => t.assertionsAll).filter(Boolean);
        const pa = list.map((t) => t.progressAll).filter(Boolean);
        const ran = list.map((t) => t.ran_at).filter((x) => x > 0);
        out[id] = { ...rep, attempts, passes, credit, excluded: !attempts, solved: credit != null && credit > 0,
            wall_s: wavg('wall_s'), tokens_out: wavg('tokens_out'), tool_calls: wavg('tool_calls'),
            ran_at: ran.length ? Math.max(...ran) : (rep.ran_at ?? null),
            assertionsAll: aa.length ? { passed: aa.reduce((a, x) => a + x.passed, 0), total: aa.reduce((a, x) => a + x.total, 0), runs: aa.reduce((a, x) => a + x.runs, 0) } : null,
            progressAll: pa.length ? { count: pa.reduce((a, x) => a + x.count, 0), of: pa.reduce((a, x) => a + x.of, 0), regressions: pa.reduce((a, x) => a + (x.regressions || 0), 0),
                runs: pa.reduce((a, x) => a + x.runs, 0), approx: pa.some((x) => x.approx) } : null };
        if (speed) out[id].speed = speed; else delete out[id].speed;
        // passes that came after a re-sent prompt (lib/models.js resentPass): counted over every member, display only
        const rs = list.map((t) => t.resent).filter(Boolean);
        if (rs.length) out[id].resent = { ...rs[0], n: rs.reduce((a, x) => a + (x.n || 0), 0) }; else delete out[id].resent;
        if (answered) out[id].answered = answered; else delete out[id].answered;
        // passing runs that outgrew the context window and carried on (display only): over the members whose passes count
        const overflowed = mergeOverflowed(list);
        if (overflowed) out[id].overflowed = overflowed; else delete out[id].overflowed;
    }
    return out;
}

/**
 * TOKEN RATES of a row (2026-10-18, Kyle: "on the a/b compare pages, I'd like to see the avg tg and pp speeds for each
 * config being compared"). Each task cell of a local row carries `speed`, the token sums of its runs' requests from
 * the server's request log (lib/models.js runSpeed / sumRunSpeed: llama-server's own log timings for llama.cpp, the
 * record-proxy's timings for Strata, and since 2026-10-22 the Strata engine's own log for a run the proxy did not record,
 * lib/stratalog.js): pn / pms prompt tokens and prefill ms, gn / gms generated tokens and generation
 * ms, req requests, runs = runs with request data, of = local runs with a wall clock.
 * The average is TOKEN-WEIGHTED, as Bench -> Live's per-task t/s (lib/tps.js): all tokens / all time, never a mean of
 * per-request or per-run rates. Every run of the task counts (passed, failed or excluded: speed is not an outcome).
 * It is NOT a rate at a stated context: an agent run's context grows as it works, so it sits below a short-context
 * llama-bench figure and is not the overview's "@32k" median.
 */
const SPEED_KEYS = ['pn', 'pms', 'gn', 'gms', 'req', 'runs', 'of'];
// 2026-10-22: the same sums by context depth (band 0 / 1, see SPEED_BANDS) and the runs read from a Strata engine log
// (sl; sh = of them, runs that shared one engine start). Carried only when a cell has them (lib/models.js sumRunSpeed).
const SPEED_OPT_KEYS = ['pn0', 'pms0', 'gn0', 'gms0', 'rq0', 'pn1', 'pms1', 'gn1', 'gms1', 'rq1', 'sl', 'sh'];
function mergeSpeed(list) {
    let out = null;
    for (const s of list) {
        if (!s) continue;
        out = out || Object.fromEntries(SPEED_KEYS.map((k) => [k, 0]));
        for (const k of SPEED_KEYS) out[k] += Number(s[k]) || 0;
        for (const k of SPEED_OPT_KEYS) if (Number(s[k])) out[k] = (out[k] || 0) + Number(s[k]);
    }
    return out;
}
/** tasks map (+ the task ids to count; all when omitted) -> {tg, pp (t/s, null when unknown), runs, of, req, tasks,
 *  pn, gn (prompt tokens read, tokens generated), bands: [{ tg, pp, req, pn, gn }] (SPEED_BANDS order), sl, sh}
 *  -- null when no counted task has a local run (a cloud row). */
export function speedOf(tasks, ids) {
    const keys = ids ? [...ids] : Object.keys(tasks || {});
    const s = mergeSpeed(keys.map((id) => tasks && tasks[id] && tasks[id].speed));
    if (!s) return null;
    const rate = (n, ms) => (n > 0 && ms > 0 ? n / (ms / 1000) : null);
    return { tg: rate(s.gn, s.gms), pp: rate(s.pn, s.pms), runs: s.runs, of: s.of, req: s.req,
        tasks: keys.filter((id) => tasks[id] && tasks[id].speed && tasks[id].speed.runs > 0).length,
        pn: s.pn, gn: s.gn,
        bands: SPEED_BANDS.map((b) => ({ tg: rate(s['gn' + b.i], s['gms' + b.i]), pp: rate(s['pn' + b.i], s['pms' + b.i]),
            req: s['rq' + b.i] || 0, pn: s['pn' + b.i] || 0, gn: s['gn' + b.i] || 0 })),
        sl: s.sl || 0, sh: s.sh || 0 };
}

// ============================================================ a row's speed at its FASTEST config
// 2026-10-22, Kyle: "on the compare page: the speed should separately be based on the fastest config; is it? I wouldn't
// want the speed to falsely be bogged down by having run low-speed quality runs to increase throughput in that
// comparison screen, giving a false idea of the model's actual speed." And: "we should separately include a warning that
// notes that it wasn't run at fastest config, shows estimated times based on tokens re-multiplied by fastest config
// expected performance, and then also has a separate comparison that is raw gen/prefill speed results for fastest
// configs for each."
// A quality row folds speed-only settings on purpose (lib/models.js STRATA_NEUTRAL: rb<N>, pf<N>, mtpfirst, cpushare,
// ...; MTP, GPU placement, engine version), so its runs can come from several SPEED CONFIGS -- the time groups
// (groupConfigs on every facet: CG.tG on the Models page; a Strata config file is in the placement facet, its version
// in the build facet). Flash-Next UD-Q4_K_XL (Strata) ran ~60 tasks at --resident-budget-gib 30 on 0.1.44.1 (decode
// ~43 tok/s, prompt ~270) and three at a time on 2026-10-22 at rb42 + --prefill 4096 on v0.2.2 (decode ~62, prompt
// ~540): every figure pooled over the row described the rb30 runs, not the model.
//
// THE RULE for a row's fastest speed config (one place: the compare page, fastestFor on the Models page -- ladder,
// frontier, cost charts and their tooltips -- all read it):
//   - measured throughput, never wall clock per task (a wall clock depends on which tasks a config happened to run):
//     generation and prompt t/s from the request log (lib/models.js runSpeed; for a Strata run the request log missed,
//     the engine's own log, lib/stratalog.js), token-weighted, by context depth (SPEED_BANDS: a prompt rate at 10k
//     says little about 60k);
//   - END TO END: the row's OWN token mix (prompt tokens read and tokens generated in each depth band, over all its
//     runs) divided by each config's rate for that band, summed (modelSeconds) -- the model time the row's work would
//     take at that config. Prefill and generation are priced separately and both still shown separately; only this
//     ranking adds their TIMES (codebench's work is prefill-heavy, so the best decode rate alone picks wrong: see
//     SPEED_COLUMNS). Lowest wins;
//   - evidence: a config competes only with SPEED_MIN_REQ requests, and SPEED_MIN_BAND_REQ in every band holding
//     SPEED_BAND_MIN_SHARE of the row's tokens (so a lucky short run, or one never measured at the depths the row works
//     at, cannot win); when none has that much, the config with the most requests stands in (fastest.thin). Within
//     SPEED_TIE of the best, the one with more requests wins (a 1-2% gap is noise).
export const SPEED_BANDS = [
    { i: 0, label: '<30k', title: 'requests with under 30k tokens of context (lib/tps.js SPEED_BAND_SPLIT)' },
    { i: 1, label: '≥30k', title: 'requests with 30k tokens of context or more' },
];
export const SPEED_MIN_REQ = 20, SPEED_MIN_BAND_REQ = 5, SPEED_BAND_MIN_SHARE = 0.05, SPEED_TIE = 0.03;

/** A cell's per-run token mix (its speed sums divided by the runs that have them), in speedOf's shape; null without. */
export function runMix(speed) {
    const n = speed && speed.runs;
    if (!(n > 0)) return null;
    return { pn: (speed.pn || 0) / n, gn: (speed.gn || 0) / n,
        bands: SPEED_BANDS.map((b) => ({ pn: (speed['pn' + b.i] || 0) / n, gn: (speed['gn' + b.i] || 0) / n })) };
}

/**
 * Seconds of model time for a token mix ({pn, gn, bands: [{pn, gn}]}: speedOf / runMix) at a config's rates (speedOf of
 * the config): each band's tokens at that band's rate when it was measured on SPEED_MIN_BAND_REQ requests, else at the
 * config's all-depth rate; tokens with no recorded depth at the all-depth rate. Prompt and generation are priced apart
 * and only their times add. null when a rate the mix needs is unknown.
 */
export function modelSeconds(mix, sp) {
    if (!mix || !sp) return null;
    const part = (n, rate, all, req) => {
        if (!(n > 0)) return 0;
        const r = req >= SPEED_MIN_BAND_REQ && rate > 0 ? rate : all;
        return r > 0 ? n / r : NaN;
    };
    let s = 0, pnB = 0, gnB = 0;
    SPEED_BANDS.forEach((b) => {
        const m = (mix.bands || [])[b.i] || { pn: 0, gn: 0 }, c = (sp.bands || [])[b.i] || { req: 0 };
        s += part(m.pn, c.pp, sp.pp, c.req) + part(m.gn, c.tg, sp.tg, c.req);
        pnB += m.pn || 0; gnB += m.gn || 0;
    });
    s += part((mix.pn || 0) - pnB, null, sp.pp, 0) + part((mix.gn || 0) - gnB, null, sp.tg, 0);
    return Number.isFinite(s) ? s : null;
}

/**
 * THE RULE (above). configs: [{ g, sp }] (sp = speedOf(g.tasks)); mix: the row's token mix (speedOf of its tasks).
 * -> { g, sp, est (model seconds of the row's work at it), eligible, thin (no config had the evidence: the most-measured
 *    one stands in), used (the bands the row's work runs in), candidates: [{ g, sp, est, eligible }] fastest first }
 *    | null (no config has a measured rate: a cloud row, or runs with no request log).
 */
export function fastestSpeedConfig(configs, mix) {
    const list = (configs || []).filter((c) => c && c.sp && c.sp.runs > 0 && (c.sp.tg != null || c.sp.pp != null));
    if (!list.length || !mix) return null;
    const share = (n, of) => (of > 0 ? n / of : 0);
    const used = SPEED_BANDS.filter((b) => { const m = (mix.bands || [])[b.i] || {}; return share(m.pn, mix.pn) >= SPEED_BAND_MIN_SHARE || share(m.gn, mix.gn) >= SPEED_BAND_MIN_SHARE; }).map((b) => b.i);
    const cands = list.map((c) => ({ g: c.g, sp: c.sp, est: modelSeconds(mix, c.sp),
        eligible: c.sp.req >= SPEED_MIN_REQ && used.every((i) => ((c.sp.bands || [])[i] || {}).req >= SPEED_MIN_BAND_REQ) }))
        .filter((c) => c.est != null).sort((a, b) => (a.est - b.est) || (b.sp.req - a.sp.req));
    if (!cands.length) return null;
    const pool = cands.some((c) => c.eligible) ? cands.filter((c) => c.eligible) : [cands.slice().sort((a, b) => b.sp.req - a.sp.req)[0]];
    const best = Math.min(...pool.map((c) => c.est));
    const pick = pool.filter((c) => c.est <= best * (1 + SPEED_TIE)).sort((a, b) => (b.sp.req - a.sp.req) || (a.est - b.est))[0];
    return { ...pick, thin: !pick.eligible, used, candidates: cands };
}

/**
 * A ROW AT ITS FASTEST SPEED CONFIG. rowTasks: the row's task map (its cells, every config pooled); groups: the row's
 * speed configs (time groups, each { key, tasks }: their cells add up to the row's).
 * Every task cell is RE-PRICED at the fastest config: for each config that ran it (weighted as mergeTasks weights a wall
 * clock: by passes, else by scored runs), its wall clock less the time the server spent on its requests, plus the time
 * the same tokens take at the fastest config --
 *     estimate = (wall - min(logged model time per run, wall)) + modelSeconds(its tokens per run, the fastest config)
 * -- so the tool and test time of the run stays as measured, and the model's part is its prompt tokens read and tokens
 * generated, each band at the fastest config's rate for that band. A run AT the fastest config is not re-priced: it is
 * the measurement (a row whose runs were all there reads exactly as measured). The logged time is capped at the wall
 * clock: a run's sums are averaged over its runs and a shared Strata start is shared out (lib/stratalog.js), so it can
 * read a little over the wall clock of the run that wall clock is from, and the model is ~98% of an agent run's time.
 * A run with no request timings cannot be re-priced: it is left out of the task's estimate (the task is dropped when
 * nothing else ran it).
 * -> null (no config has a measured rate), or { fastest (fastestSpeedConfig), configs: [{ g, sp }], mix,
 *    tasks: { id: { ...cell, wall_s (the estimate), measured_wall_s, model_s (logged model time, capped at the wall),
 *    model_fast_s (at the fastest config) -- each null when unknown, how: 'measured' (every run counted was at the
 *    fastest config) | 'estimated' } }, via: { id: [the speed configs whose runs count for its wall clock] } }
 */
export function fastSpeedOf(rowTasks, groups) {
    const configs = (groups || []).map((g) => ({ g, sp: speedOf(g.tasks) })).filter((c) => c.sp);
    const mix = speedOf(rowTasks);
    const fastest = fastestSpeedConfig(configs, mix);
    if (!fastest) return null;
    const F = fastest.g;
    const tasks = {}, via = {};
    for (const [id, cell] of Object.entries(rowTasks || {})) {
        if (!cell || !(cell.wall_s > 0)) continue;
        const members = (groups || []).map((g) => ({ g, c: g.tasks && g.tasks[id] })).filter((x) => x.c && x.c.wall_s > 0);
        const passed = members.filter((x) => x.c.passes > 0);
        const src = passed.length ? passed : members.filter((x) => x.c.attempts > 0);
        if (!src.length) continue;
        via[id] = src.map((x) => x.g);
        let W = 0, est = 0, Wm = 0, own = 0, fast = 0, moved = false;
        for (const x of src) {
            const w = (passed.length ? x.c.passes : x.c.attempts) || 1;
            const sp1 = x.c.speed, mix1 = runMix(sp1);
            const a = mix1 ? Math.min(((sp1.pms || 0) + (sp1.gms || 0)) / sp1.runs / 1000, x.c.wall_s) : null;   // logged model time per run
            const b = x.g === F ? a : (mix1 ? modelSeconds(mix1, fastest.sp) : null);
            if (a != null && b != null) { Wm += w; own += w * a; fast += w * b; }
            if (x.g === F) { W += w; est += w * x.c.wall_s; continue; }
            if (a == null || b == null) continue;   // no request timings for these runs: they cannot be re-priced
            W += w; est += w * (x.c.wall_s - a + b); moved = true;
        }
        if (!W) continue;
        tasks[id] = { ...cell, wall_s: est / W, measured_wall_s: cell.wall_s, model_s: Wm ? own / Wm : null, model_fast_s: Wm ? fast / Wm : null,
            how: moved ? 'estimated' : 'measured' };
    }
    return { fastest, configs, mix, tasks, via };
}

/**
 * Which speed configs a row's runs used on the tasks `ids` (the paired tasks of a comparison), against its fastest one:
 * the compare page's warning when they were not all there. -> { n (tasks with a run counted), atFastest (tasks whose every
 * counted run was at the fastest config), others: [{ g, tasks, req }] (configs other than the fastest, by tasks) }.
 */
export function speedConfigShare(fs, ids) {
    const out = { n: 0, atFastest: 0, others: [] };
    if (!fs) return out;
    const F = fs.fastest.g, by = new Map();
    for (const id of ids || []) {
        const v = fs.via[id];
        if (!v || !v.length) continue;
        out.n++;
        if (v.every((g) => g === F)) { out.atFastest++; continue; }
        for (const g of new Set(v)) {
            if (g === F) continue;
            if (!by.has(g)) by.set(g, { g, tasks: 0, req: 0 });
            const e = by.get(g); e.tasks++;
            e.req += Number(((g.tasks || {})[id] || {}).speed && g.tasks[id].speed.req) || 0;
        }
    }
    out.others = [...by.values()].sort((a, b) => (b.tasks - a.tasks) || (b.req - a.req));
    return out;
}

/**
 * TENSOR-SPLIT ROWS, separate or combined (2026-10-13, Kyle: "a button that lets us choose whether tensor split should
 * separate or combine for quality config readings in the solve map"). A queue item run with llama.cpp's `-sm tensor`
 * declares CODEBENCH_ROW_VARIANT=tensor-split-<cards>, so its battery is filed under a catalog model of its own,
 * `<model>~rv:tensor-split-<cards>` (lib/models.js rowVariant), and its `weights` facet carries that key: no facet
 * chip can pool it with the model's other runs. foldTensorRows() returns the catalog with those rows FOLDED into
 * the model they are a placement of: the variant's configs join the base model with the weights facet rewritten (so
 * they group with the base configs of the same context, KV type and prompt, while `-sm tensor` stays in the placement
 * facet, which the time charts keep apart), its per-task results are merged in, and the variant model is dropped.
 * A variant whose base model is not in the catalog keeps its key (the server knows it by that) and loses only the
 * words in its name. Only `rv:tensor-split*` parts fold: helper combinations, prompt experiments and plan rows stay
 * rows of their own.
 * Pure, and memoised per catalog object: the page's fit and board caches key on catalog identity, so there must be
 * ONE folded object per source catalog. `tensorFolded` on the result maps variant key -> base key.
 */
const TENSOR_PART = /^rv:tensor-split[\w.-]*$/i;
/** `<model>~rv:tensor-split-two-xtx` -> `<model>`; null for a key with no tensor-split part. */
export function tensorBaseKey(key) {
    const parts = String(key || '').split('~');
    const kept = parts.filter((p) => !TENSOR_PART.test(p));
    return kept.length === parts.length ? null : kept.join('~');
}
// "Qwen3.8-27B Q4_K_XL (thinking off, tensor-split-two-xtx)" -> "Qwen3.8-27B Q4_K_XL (thinking off)"
const tensorNameless = (text, key) => {
    const slugs = String(key || '').split('~').filter((p) => TENSOR_PART.test(p)).map((p) => p.slice(3).toLowerCase());
    return String(text || '').replace(/ \(([^()]*)\)$/, (all, inner) => {
        const bits = inner.split(', ').filter((b) => !slugs.includes(b.toLowerCase()));
        return bits.length ? ` (${bits.join(', ')})` : '';
    });
};
const tensorConfig = (c, to) => {
    const from = (c.facets || {}).weights;
    return { ...c, key: typeof c.key === 'string' && from ? c.key.split(JSON.stringify(from)).join(JSON.stringify(to)) : c.key,
        facets: { ...(c.facets || {}), weights: to }, tensorFoldedFrom: from || null };
};
// (2026-10-14: shared with the file-variant fold below -- `config` restates a variant's config under the base model,
// `speedConfig` its speed configs, `mark` names the field that lists the folded keys)
function tensorMerge(base, variants, { config = tensorConfig, speedConfig = (s) => s, mark = 'tensorFoldedFrom' } = {}) {
    const to = ((base.configs || [])[0] && base.configs[0].facets && base.configs[0].facets.weights) || base.weightsKey || base.key;
    const all = [base, ...variants];
    const tasks = mergeTasks(all.map((m) => m.tasks || {}).filter((t) => Object.keys(t).length));
    const vals = Object.values(tasks || {});
    const excluded = vals.filter((t) => t.excluded).length;
    const solved = vals.reduce((a, t) => a + (t.excluded ? 0 : (t.credit || 0)), 0);
    const sum = (f) => all.reduce((a, m) => a + (f(m) || 0), 0);
    const counts = { ...(base.counts || {}) };
    for (const k of ['requests', 'benchRuns', 'sweepRows', 'qualityBatteries']) counts[k] = sum((m) => (m.counts || {})[k]);
    counts.qualityTasks = vals.length;
    const scored = vals.length - excluded;
    return { ...base, tasks: tasks || {}, counts,
        configs: [...(base.configs || []), ...variants.flatMap((v) => (v.configs || []).map((c) => config(c, to)))],
        batteries: [...(base.batteries || []), ...variants.flatMap((v) => v.batteries || [])].sort((a, b) => (b.ended || 0) - (a.ended || 0)),
        sources: [...(base.sources || []), ...variants.flatMap((v) => v.sources || [])],
        speedConfigs: [...(base.speedConfigs || []), ...variants.flatMap((v) => (v.speedConfigs || []).map((s) => speedConfig(s, v)))],
        // the model's own totals, restated over the merged tasks; the per-solve costs stay the base model's (the
        // boards and charts never read them from here: they recompute from the configs)
        quality: { ...(base.quality || {}), attempted: vals.length, counted: vals.filter((t) => !t.unscored).length, excluded, scored, solved, solveRate: scored ? solved / scored : null,
            attemptsTotal: vals.reduce((a, t) => a + (t.attempts || 0), 0), repeatedTasks: vals.filter((t) => (t.attempts || 0) > 1).length,
            harnessIncompatible: all.every((m) => m.quality && m.quality.harnessIncompatible) },
        [mark]: variants.map((v) => v.key) };
}
const tensorFoldMemo = new WeakMap();
export function foldTensorRows(catalog) {
    if (!catalog || !Array.isArray(catalog.models)) return catalog;
    if (tensorFoldMemo.has(catalog)) return tensorFoldMemo.get(catalog);
    const byKey = new Map(catalog.models.map((m) => [m.key, m]));
    const into = new Map(), tensorFolded = {};
    let any = false;
    for (const m of catalog.models) {
        const b = tensorBaseKey(m.key);
        if (b == null) continue;
        any = true;
        if (!byKey.has(b) || tensorBaseKey(b) != null) continue;
        if (!into.has(b)) into.set(b, []);
        into.get(b).push(m); tensorFolded[m.key] = b;
    }
    let out = catalog;
    if (any) {
        const models = [];
        for (const m of catalog.models) {
            if (tensorFolded[m.key]) continue;                       // folded into its base model
            if (tensorBaseKey(m.key) != null) {                      // no base model in the catalog: the same row, plainly named
                models.push({ ...m, display: tensorNameless(m.display, m.key), weightsDisplay: m.weightsDisplay ? tensorNameless(m.weightsDisplay, m.key) : m.weightsDisplay });
                continue;
            }
            models.push(into.has(m.key) ? tensorMerge(m, into.get(m.key)) : m);
        }
        out = { ...catalog, models, tensorFolded };
    }
    tensorFoldMemo.set(catalog, out);
    return out;
}
/** A running battery as the folded catalog files it: its model key and weights facet without the tensor-split part
 *  (only when that row was folded into a base model -- `folded` is the catalog's `tensorFolded`). */
export function foldTensorRun(run, folded) {
    const to = run && folded && folded[run.modelKey];
    if (!to) return run;
    const w = (run.facets || {}).weights;
    return { ...run, modelKey: to, facets: run.facets ? { ...run.facets, weights: folded[w] || tensorBaseKey(w) || w } : run.facets };
}

/**
 * FILE VARIANTS, merged or separate (2026-10-14, Kyle: "if the quality scores would be identical, but the f32ssm copies
 * only add a tiny bit more weight/size... the results should merge, you can add in a config toggle that lets one
 * manually select whether those should be separated on quality or speed and by default we will say it should
 * differentiate on neither"). `Qwen3.8-27B-GSQ-RCO-<quant>-mtp-f32ssm.gguf` are local re-saves of the GSQ-RCO files
 * with the SSM tensors stored as f32 (an old CUDA-12 work-around); the weights are otherwise the same, and from
 * 10-14 the original `-mtp.gguf` files are run instead. lib/models.js keys a local gguf by its file name
 * (`local:<file slug>:unknown` for these), so each copy is a catalog model of its own and its `weights` facet carries
 * that key, as a tensor-split row's does.
 * foldFileVariants() is the same fold as foldTensorRows, over an EXPLICIT map of three files (no pattern: another
 * `-f32ssm` file is a new decision): a copy's model (and each of its suffixed rows, `~tau`, `~rv:...`) joins the
 * original file's model of the same suffix; its configs' weights facet is rewritten to the original's and they are
 * tagged `facets.file = 'f32ssm'` -- a pseudo-facet in no FACETS list, so no keep-list separates on it unless a caller
 * adds FILE_FACET (the time charts' "f32ssm copies" chip does). A copy whose original has no row yet is renamed in
 * place: name, weights key and config weights become the original's, the model key stays (the server's /api/model
 * knows the row by it), and `fileRenamed` maps original key -> that row, so a battery running on the original file
 * lands there. The model's `speed` (one curve, for the prefill chart) is the member's with the most samples;
 * `fileParts` keeps each member's own, for a page that keeps the copies apart on speed (fileSpeedModels).
 * Pure, memoised per catalog object like foldTensorRows. `fileFolded` maps copy key -> original key.
 */
export const FILE_FACET = 'file';
export const FILE_FACET_LABEL = 'weights file (f32ssm copy)';
export const FILE_VARIANTS = Object.freeze({
    'local:qwen3.8-27b-gsq-rco-iq2-xs-mtp-f32ssm:unknown': Object.freeze({ to: 'local:qwen3.8-27b-gsq-rco-iq2-xs-mtp:unknown', tag: 'f32ssm',
        name: 'Qwen3.8-27B-GSQ-RCO-IQ2_XS-mtp-f32ssm', toName: 'Qwen3.8-27B-GSQ-RCO-IQ2_XS-mtp' }),
    'local:qwen3.8-27b-gsq-rco-iq2-s-mtp-f32ssm:unknown': Object.freeze({ to: 'local:qwen3.8-27b-gsq-rco-iq2-s-mtp:unknown', tag: 'f32ssm',
        name: 'Qwen3.8-27B-GSQ-RCO-IQ2_S-mtp-f32ssm', toName: 'Qwen3.8-27B-GSQ-RCO-IQ2_S-mtp' }),
    'local:qwen3.8-27b-gsq-rco-iq3-xxs-mtp-f32ssm:unknown': Object.freeze({ to: 'local:qwen3.8-27b-gsq-rco-iq3-xxs-mtp:unknown', tag: 'f32ssm',
        name: 'Qwen3.8-27B-GSQ-RCO-IQ3_XXS-mtp-f32ssm', toName: 'Qwen3.8-27B-GSQ-RCO-IQ3_XXS-mtp' }),
});
const fileVariantOf = (key) => FILE_VARIANTS[String(key || '').split('~')[0]] || null;
/** `<copy key>[~suffix]` -> `<original key>[~suffix]`; null for any other key. */
export function fileBaseKey(key) {
    const parts = String(key || '').split('~');
    const v = FILE_VARIANTS[parts[0]];
    return v ? [v.to, ...parts.slice(1)].join('~') : null;
}
const fileRenamed = (text, v) => (typeof text === 'string' && v && text.startsWith(v.name) ? v.toName + text.slice(v.name.length) : text);
const fileConfig = (c, to, tag) => {
    const from = (c.facets || {}).weights;
    const w = to || fileBaseKey(from) || from;
    return { ...c, key: typeof c.key === 'string' && from && w ? c.key.split(JSON.stringify(from)).join(JSON.stringify(w)) : c.key,
        facets: { ...(c.facets || {}), weights: w, [FILE_FACET]: tag }, fileFoldedFrom: from || null };
};
const speedSamples = (s) => (s ? ['at8k', 'at32k', 'at64k'].reduce((a, k) => a + ((s[k] && s[k].n) || 0), 0) : 0);
const filePart = (m, tag) => ({ key: m.key, tag, display: m.display, speed: m.speed });
function fileMerge(base, variants) {
    const v0 = fileVariantOf(variants[0].key), tag = v0.tag;
    const out = tensorMerge(base, variants, { config: (c, to) => fileConfig(c, to, tag), speedConfig: (s, v) => ({ ...s, [FILE_FACET]: tag, fileFoldedFrom: v.key }), mark: 'fileFoldedFrom' });
    const parts = [filePart(base, null), ...variants.map((v) => filePart(v, tag))];
    const best = parts.reduce((a, p) => (speedSamples(p.speed) > speedSamples(a.speed) ? p : a), parts[0]);
    return { ...out, speed: best.speed, fileParts: parts };
}
function fileRename(m) {
    const v = fileVariantOf(m.key);
    return { ...m, display: fileRenamed(m.display, v), weightsDisplay: fileRenamed(m.weightsDisplay, v), family: fileRenamed(m.family, v),
        weightsKey: fileBaseKey(m.weightsKey || m.key),
        configs: (m.configs || []).map((c) => fileConfig(c, null, v.tag)),
        speedConfigs: (m.speedConfigs || []).map((s) => ({ ...s, [FILE_FACET]: v.tag, fileFoldedFrom: m.key })),
        fileFoldedFrom: [m.key], fileParts: [filePart(m, v.tag)] };
}
const fileFoldMemo = new WeakMap();
export function foldFileVariants(catalog) {
    if (!catalog || !Array.isArray(catalog.models)) return catalog;
    if (fileFoldMemo.has(catalog)) return fileFoldMemo.get(catalog);
    const byKey = new Map(catalog.models.map((m) => [m.key, m]));
    const into = new Map(), fileFolded = {}, renamed = {};
    let any = false;
    for (const m of catalog.models) {
        const b = fileBaseKey(m.key);
        if (b == null) continue;
        any = true;
        if (!byKey.has(b)) { renamed[b] = m.key; continue; }
        if (!into.has(b)) into.set(b, []);
        into.get(b).push(m); fileFolded[m.key] = b;
    }
    let out = catalog;
    if (any) {
        const models = [];
        for (const m of catalog.models) {
            if (fileFolded[m.key]) continue;                                  // joined the original file's row
            if (fileBaseKey(m.key) != null) { models.push(fileRename(m)); continue; }   // no original row yet: renamed
            models.push(into.has(m.key) ? fileMerge(m, into.get(m.key)) : m);
        }
        out = { ...catalog, models, fileFolded, fileRenamed: renamed };
    }
    fileFoldMemo.set(catalog, out);
    return out;
}
/** A running battery as the file-folded catalog (`cat`) files it: a copy's run under the original's row and weights,
 *  tagged as a copy; a run on an original whose row is a renamed copy, under that row. Unfolded catalog: as filed. */
export function foldFileRun(run, cat) {
    if (!run || !cat || !cat.fileFolded) return run;
    const v = fileVariantOf(run.modelKey);
    if (v) {
        const w = (run.facets || {}).weights;
        return { ...run, modelKey: cat.fileFolded[run.modelKey] || run.modelKey,
            facets: run.facets ? { ...run.facets, weights: fileBaseKey(w) || w, [FILE_FACET]: v.tag } : run.facets };
    }
    const row = cat.fileRenamed && cat.fileRenamed[run.modelKey];
    return row ? { ...run, modelKey: row } : run;
}
/** The two "f32ssm copies separate" switches: stored values ('separate' | 'merge') -> what the page shows. Both merge
 *  by default; the public site always merges (it has no switches). Speed is separate whenever quality is: a copy
 *  that is a row of its own on quality has its own times too (a time group hangs off one quality group). */
export function fileVariantRows(publicSite, stored = {}) {
    const ok = (v) => v === 'separate' || v === 'merge';
    if (publicSite) return { quality: 'merge', speed: 'merge', speedSplit: false };
    const quality = ok(stored.quality) ? stored.quality : 'merge', speed = ok(stored.speed) ? stored.speed : 'merge';
    return { quality, speed, speedSplit: quality === 'separate' || speed === 'separate' };
}
/** The time charts' keep-list: FILE_FACET added when the rows are merged on quality but kept apart on speed. */
export function timeKeepWith(keepT, rows) {
    const k = keepT || FACET_DEFAULTS.full;
    return rows && rows.quality === 'merge' && rows.speed === 'separate' && !k.includes(FILE_FACET) ? [...k, FILE_FACET] : k;
}
/** Models for a per-model speed chart (prefill): a merged row as one model (its most-sampled curve), or, `split`, one
 *  model per file it pools ("<name> · f32ssm copy" under the copy's own key). */
export function fileSpeedModels(models, split) {
    if (!split) return models;
    return (models || []).flatMap((m) => (Array.isArray(m.fileParts) && m.fileParts.length
        ? m.fileParts.map((p) => ({ ...m, key: p.key, display: p.tag ? `${m.display} · ${p.tag} copy` : m.display, speed: p.speed }))
        : [m]));
}

/**
 * Group `entries` ([{m, c}], c = a finest-grain config with .facets) on the `keep` facets.
 * Returns [{key, m, c (representative), members, tasks, dirs, varies: [facet ids that differ]}].
 */
export function groupConfigs(entries, keep) {
    const want = ['weights', ...keep];
    const groups = new Map();
    for (const e of entries) {
        const f = e.c.facets || {};
        const key = JSON.stringify(want.map((k) => [k, f[k] ?? null]));
        if (!groups.has(key)) groups.set(key, { key, members: [] });
        groups.get(key).members.push(e);
    }
    const mostScored = (list) => list.reduce((a, e) => ((e.c.agg && e.c.agg.scored) > (a.c.agg && a.c.agg.scored) ? e : a), list[0]);
    return [...groups.values()].map((g) => {
        let rep = mostScored(g.members);
        const varies = [...FACETS.map((x) => x.id), FILE_FACET].filter((id) => !keep.includes(id)
            && new Set(g.members.map((e) => JSON.stringify((e.c.facets || {})[id] ?? null))).size > 1);
        // the row's words come from its representative's `c` (configText, ctxText: the context AND the launch summary). A
        // row pooling configs with and without an agent window (the Ornith 128k row: local-128k on a 262144 server and on
        // a 131072 one, 2026-10-25) reads plainly at its size: its words come from its most-scored member WITHOUT a window
        // (a real launch at the row's size: "128k ctx · ... · 128k", not the 262k server's "256k"); were every member
        // filed under a different window, from a copy of the most-scored without the note (catalog configs are never
        // mutated: the folds and fits are memoised on them). Each member's own line (configText(e.m, e.c, true)) keeps its
        // note and its launch.
        let c = rep.c;
        if (rep.c.agentWindow && !commonWindow(g.members.map((e) => e.c))) {
            const inStep = g.members.filter((e) => !e.c.agentWindow);
            if (inStep.length) { rep = mostScored(inStep); c = rep.c; } else c = (({ agentWindow, ...rest }) => rest)(rep.c);
        }
        return { key: g.key, m: rep.m, c, members: g.members, varies,
            tasks: mergeTasks(g.members.map((e) => e.c.tasks)), dirs: g.members.flatMap((e) => e.c.dirs || []),
            // unfinished rows (beside `tasks`, never inside it): the Solve map's neutral cells, the planner's "awaiting continuation"
            ...(g.members.some((e) => e.c.unfinished) ? { unfinished: mergeUnfinished(g.members.map((e) => e.c.unfinished)) } : {}) };
    });
}

/**
 * Relative solve time over a set of groups, as ONE joint fit: log(wall of group g on task t) =
 * a_g + b_t over every solved, non-excluded task at least two groups solved (a task only one group
 * solved says nothing about speed). b_t is the task's own length, a_g the group's speed; index =
 * exp(a_g) against the median a_g of the groups with >= LADDER_MIN_N such tasks (all groups when
 * none has), so 1x = a typical config, 2x = twice as long on the same task.
 *
 * Until 2026-09-25 this was each group's geometric mean of wall / the median of its peers on ITS
 * OWN tasks. Two groups' indexes were then measured against different yardsticks and their ratio
 * could point the wrong way: Swift and Terse both read 0.94x while Terse is 5% slower head to head,
 * and Flash-Next UD-Q2_K_XL read faster than the Qwen3.8-27B UD-Q4_K_XL on the cost chart. The joint fit puts every group
 * on one scale, so index ratios agree with head-to-head comparisons up to noise.
 * -> Map key -> {index, tasks (solved tasks in the fit), noPeer (solved tasks nobody else solved)}
 */
export function relSolveTimes(groups) {
    const solvedBy = new Map();
    for (const g of groups) for (const [t, r] of Object.entries(g.tasks)) {
        if (!r.solved || r.excluded || !(r.wall_s > 0)) continue;
        solvedBy.set(t, (solvedBy.get(t) || 0) + 1);
    }
    const obs = [], nTasks = new Map(), noPeer = new Map();
    groups.forEach((g, gi) => {
        let n = 0, lone = 0;
        for (const [t, r] of Object.entries(g.tasks)) {
            if (!r.solved || r.excluded || !(r.wall_s > 0)) continue;
            if (solvedBy.get(t) < 2) { lone++; continue; }
            obs.push([gi, t, Math.log(r.wall_s)]); n++;
        }
        nTasks.set(gi, n); noPeer.set(gi, lone);
    });
    const a = new Array(groups.length).fill(0), b = new Map();
    for (let it = 0; it < 300; it++) {
        const sb = new Map(), cb = new Map();
        for (const [gi, t, y] of obs) { sb.set(t, (sb.get(t) || 0) + y - a[gi]); cb.set(t, (cb.get(t) || 0) + 1); }
        for (const [t, v] of sb) b.set(t, v / cb.get(t));
        const sa = new Array(groups.length).fill(0), ca = new Array(groups.length).fill(0);
        for (const [gi, t, y] of obs) { sa[gi] += y - b.get(t); ca[gi]++; }
        let delta = 0;
        for (let gi = 0; gi < a.length; gi++) if (ca[gi]) { const v = sa[gi] / ca[gi]; delta = Math.max(delta, Math.abs(v - a[gi])); a[gi] = v; }
        if (delta < 1e-7) break;
    }
    const fitted = groups.map((_, gi) => gi).filter((gi) => nTasks.get(gi) > 0);
    const solid = fitted.filter((gi) => nTasks.get(gi) >= LADDER_MIN_N);
    const ref = med((solid.length ? solid : fitted).map((gi) => a[gi]));
    const out = new Map();
    groups.forEach((g, gi) => {
        const n = nTasks.get(gi);
        out.set(g.key, n > 0 && ref != null ? { index: Math.exp(a[gi] - ref), tasks: n, noPeer: noPeer.get(gi) } : { index: null, tasks: 0, noPeer: noPeer.get(gi) });
    });
    // the task lengths and the yardstick, for a task map placed on this scale afterwards (relIndexOf)
    Object.defineProperty(out, 'fit', { value: { b, ref }, enumerable: false });
    return out;
}

/**
 * A task map placed on an existing relative-solve-time scale (relSolveTimes' `rel`) without refitting it: the mean of
 * log(wall) - task length over its solved tasks the fit has a length for, against the fit's yardstick. Used for a row's
 * time at its fastest speed config (fastSpeedOf's re-priced task map, 2026-10-22), which no run measured as a whole.
 * -> { index, tasks, noPeer } as relSolveTimes, or null when the scale has no fit or no task in common.
 */
export function relIndexOf(rel, tasks) {
    const fit = rel && rel.fit;
    if (!fit || fit.ref == null) return null;
    let sum = 0, n = 0, lone = 0;
    for (const [t, r] of Object.entries(tasks || {})) {
        if (!r || !r.solved || r.excluded || !(r.wall_s > 0)) continue;
        if (!fit.b.has(t)) { lone++; continue; }
        sum += Math.log(r.wall_s) - fit.b.get(t); n++;
    }
    return n ? { index: Math.exp(sum / n - fit.ref), tasks: n, noPeer: lone } : null;
}

/**
 * THE order of anything ranked by strength: the LOW end of its 95% range (Kyle, 2026-09-29: a thin record's wide range
 * leaves its low end low, so proven results outrank unproven ones), -1 without one. The number shown stays the strength
 * (the midpoint) with its range; only the order is this. One place since 2026-10-21 (Kyle: "experiments with few results
 * should have high variability and select rank based on the lowest bound number ... should apply to every ordered quality
 * sorting on the page"): the Solve map, the speed x quality frontier and ladder, the cost charts' quality order, every
 * board's strength column (strengthMetric's `sort`), the pickers, and bestConfigOf's default rank.
 * `a` is a fit entry (difficultyAdjusted) or anything carrying `lo` (a ladder point).
 */
/**
 * THE fitted P(solve) of problem `pid` at ability `theta`, from a fit's exported maps (difficultyAdjusted: taskDifficulty,
 * centred on meanB, and taskDiscrimination; a = 1 where it has none) through the one item response function
 * (itemP). null when the problem is not in the fit. lib/liveodds.js reads its odds here.
 */
export function pSolve(A, theta, pid) {
    const d = A && A.taskDifficulty ? A.taskDifficulty.get(pid) : null;
    if (d == null || theta == null) return null;
    return itemP((A.taskDiscrimination && A.taskDiscrimination.get(pid)) || 1, d + A.meanB, theta);
}

export function strengthRank(a) {
    return a && Number.isFinite(a.lo) ? a.lo : -1;
}

/**
 * The strength-column cell for fit entry `a` (difficultyAdjusted), raw counts from metrics `q`. `sort` makes every
 * board order the column by strengthRank, not by the midpoint `v` it prints (2026-10-21: the boards sorted by v, so a
 * 23-task Jeff row out-ranked 70- and 159-task configs that the Solve map put above it).
 */
export function strengthMetric(a, q, ctx = null) {
    // ctx { key, adj } (groupMetrics): with a bootstrap on the fit, two neighbours are told apart by the 95% range of their
    // GAP (strengthGap), not by whether their own ranges overlap -- those include the drift the two share (2026-10-25)
    const ci = a ? { lo: a.lo, hi: a.hi } : null;
    if (ci && ctx && ctx.key != null && ctx.adj && ctx.adj.boot) {
        ci.gapKey = ctx.key;
        ci.sepFrom = (other) => { if (!other || other.gapKey == null) return null; const g = strengthGap(ctx.adj, ctx.key, other.gapKey); return g ? g.resolved : null; };
    }
    return a ? { v: a.rate, sort: strengthRank(a), n: a.n, ci, coverage: a.coverage,
        note: `strength ${Math.round(a.strength)}/100 (95% ${Math.round(a.lo * 100)}–${Math.round(a.hi * 100)}); ${Math.round(a.coverage * 100)} of the 100 points actually tested (${a.n} tasks); the expected score at its fitted ability; raw ${q.solved}/${q.scored}${a.range ? `; ${rangeNote(a)}` : ''}` } : null;
}

/**
 * The ONE strength fit (the models overview's: every catalog model, FACET_DEFAULTS facets), keyed by battery
 * dir, so any table whose rows know their batteries shows the same strength numbers (2026-09-30, Kyle: the
 * strength score is the default ranking everywhere). dir -> fit entry, or undefined.
 * `models` must be the catalog AS THE MODELS PAGE SHOWS IT (overviewCatalog below: tensor-split rows and f32ssm copies
 * folded), and keepQ / keepT its chart chips (overviewView), or the numbers are another fit's (2026-10-14).
 * A dir in more than one fitted group (a battery split by row config, or chips that separate inside one battery: date
 * served, placement) gets the group bestConfigOf picks, as the Solve map's rows do; `groupsByDir` on the result
 * maps dir -> every [group, entry] it is in, for a caller that says so (strengthForDirs).
 */
export function strengthByDir(models, keepQ = FACET_DEFAULTS.quality, keepT = FACET_DEFAULTS.full) {
    const fit = fitFor(models, keepQ, keepT);   // cached per catalog (fitFor below)
    const out = new Map(), groupsByDir = new Map();
    for (const g of fit.qAll) {
        const a = fit.adj.get(g.key);
        if (!a) continue;
        for (const d of new Set(g.dirs || [])) {
            if (!groupsByDir.has(d)) groupsByDir.set(d, []);
            groupsByDir.get(d).push([g, a]);
        }
    }
    for (const [d, pairs] of groupsByDir) out.set(d, pickPair(pairs)[1]);
    out.groupsByDir = groupsByDir;
    return out;
}

/** bestConfigOf over [group, fit entry] pairs, ranked by the entry's strengthRank. -> the chosen pair. */
function pickPair(pairs) {
    const g = bestConfigOf(pairs.map(([x]) => x), (x) => strengthRank(pairs.find(([y]) => y === x)[1]));
    return pairs.find(([x]) => x === g);
}

/**
 * The strength of a table row that knows its batteries (`dirs`), from strengthByDir's map: the fit entry of the
 * fitted group its batteries are in -- bestConfigOf's pick when they span several -- and what that group
 * pools beyond the row. -> { a, groups (distinct groups the dirs are in), groupDirs (batteries the chosen group pools),
 * rowDirs, note } | null. `note` is '' when the row and the group are the same batteries.
 */
export function strengthForDirs(byDir, dirs) {
    if (!byDir || !dirs || !dirs.length) return null;
    const seen = new Map();
    for (const d of dirs) for (const [g, a] of ((byDir.groupsByDir && byDir.groupsByDir.get(d)) || [])) seen.set(g.key, [g, a]);
    if (!seen.size) {   // a map without groupsByDir (an older caller's): the plain per-dir lookup
        const a = dirs.map((d) => byDir.get(d)).filter(Boolean).sort((x, y) => strengthRank(y) - strengthRank(x))[0];
        return a ? { a, groups: 1, groupDirs: null, rowDirs: dirs.length, note: '' } : null;
    }
    const [g, a] = pickPair([...seen.values()]);
    const groupDirs = new Set(g.dirs || []).size, rowDirs = new Set(dirs).size;
    const bits = [];
    if (seen.size > 1) bits.push(`this row's batteries fall in ${seen.size} configs on the Models page; the best by low end among those with enough tasks is shown`);
    const extra = [...new Set(g.dirs || [])].filter((d) => !dirs.includes(d)).length;
    if (extra) bits.push(`the Models page's config pools ${groupDirs} batteries, ${extra} of them not in this row (tensor-split / f32ssm copies folded, launch-unrecorded runs pooled) — the strength is that config's; the raw columns are this row's`);
    return { a, groups: seen.size, groupDirs, rowDirs, note: bits.join('; ') };
}

// ============================================================ the Models page's view, for every other board
/**
 * ONE SOURCE OF STRENGTH (2026-10-14, Kyle: "do all of our quality leaderboards use the same strength algorithm/match...?
 * I think in bench they didn't look like they lined up"). The fit is one function (difficultyAdjusted via fitFor), but
 * its numbers depend on WHICH catalog it is fed and on the quality facets: the Models page fits the catalog with its
 * tensor-split rows and f32ssm copies folded (ui/models/index.js, by its two switches) on its chart chips, while the
 * Benchmarks board and the two pickers fitted the raw catalog -- every config moved a little (difficulties and the model
 * level are shared) and a folded model's moved a lot (Qwen3.8-27B-GSQ-RCO-IQ2_XS-mtp 37 vs 46). These three read the
 * page's own settings, so every other board fits the same catalog on the same facets and hits the same cached fit.
 *   overviewView()          the switches and chips this browser has (the public site: always folded, as its page is)
 *   overviewCatalog(raw, v) the catalog as the page shows it: tensor fold first, then the file fold (memoised folds, so
 *                           the same object the page holds and the fit cache holds)
 *   overviewRowKey(cat, k)  the row a raw catalog key (a gguf's) lands on in that catalog
 */
export const OVERVIEW_KEYS = Object.freeze({ tensorRows: 'models_tensor_rows_v2', fileQuality: 'models_f32ssm_quality', fileSpeed: 'models_f32ssm_speed',
    keepQ: 'facets_models-charts-q', keepT: 'facets_models-charts-t' });
const defaultStore = () => { try { return typeof localStorage !== 'undefined' ? localStorage : null; } catch { return null; } };
export function overviewView({ publicSite = false, store = defaultStore() } = {}) {
    const get = (k) => { try { return store ? store.getItem(k) : null; } catch { return null; } };
    const t = get(OVERVIEW_KEYS.tensorRows);
    const tensorRows = !publicSite && (t === 'separate' || t === 'combine') ? t : 'combine';
    const fileRows = fileVariantRows(publicSite, { quality: get(OVERVIEW_KEYS.fileQuality), speed: get(OVERVIEW_KEYS.fileSpeed) });
    const keep = (k, dflt) => { try { const v = JSON.parse(get(k) || 'null'); if (Array.isArray(v)) return v; } catch { /* unreadable */ } return dflt; };
    return { tensorRows, fileRows, keepQ: keep(OVERVIEW_KEYS.keepQ, FACET_DEFAULTS.quality),
        keepT: timeKeepWith(keep(OVERVIEW_KEYS.keepT, FACET_DEFAULTS.full), fileRows) };
}
export function overviewCatalog(raw, view = overviewView()) {
    if (!raw || !Array.isArray(raw.models)) return raw;
    const t = view.tensorRows === 'separate' ? raw : foldTensorRows(raw);
    const out = view.fileRows && view.fileRows.quality === 'separate' ? t : foldFileVariants(t);
    // the catalog's strength bootstrap (2026-10-25: lib/strengthboot.js, carried as `strengthBootstrap`) goes with the
    // rows as this view folds them; fitFor applies it when the view is the one it was computed for
    if (out && Array.isArray(out.models)) bootRegistry.set(out.models, { payload: raw.strengthBootstrap || null,
        view: { tensorRows: view.tensorRows === 'separate' ? 'separate' : 'combine', fileQuality: view.fileRows && view.fileRows.quality === 'separate' ? 'separate' : 'merge' } });
    return out;
}
export function overviewRowKey(catalog, key) {
    let k = key;
    if (catalog && catalog.tensorFolded && catalog.tensorFolded[k]) k = catalog.tensorFolded[k];
    if (catalog && catalog.fileFolded && catalog.fileFolded[k]) k = catalog.fileFolded[k];
    if (catalog && catalog.fileRenamed && catalog.fileRenamed[k]) k = catalog.fileRenamed[k];
    return k;
}

/** Metrics for a (possibly merged) group, from its task map. */
export function groupMetrics(g, rel, adj) {
    const q = qualityMetricsFor(g.tasks, null);
    const metrics = qualityToMetrics(q);
    const a = adj && adj.get(g.key);
    metrics.adjSolveRate = strengthMetric(a, q, adj && g ? { key: g.key, adj } : null);
    const rt = rel && rel.get(g.key);
    metrics.relSolveTime = rt && rt.index != null
        ? { v: rt.index, n: rt.tasks, note: `${rt.tasks} solved task(s) compared against every other config that solved them${rt.noPeer ? `; ${rt.noPeer} had no peer` : ''}` } : null;
    return { q, metrics };
}

/**
 * The chip bar: one toggle per facet, ON = separates runs. Persisted per `storeKey`.
 * Returns the current keep-list; calls onChange(keep) on every toggle.
 * `extra` (2026-10-13): chips for a separation that is NOT a facet of a config, drawn after the facets in the same
 * style: [{ id, label, title, isOn(), set(on), dflt? }]. Their state is the caller's (it is not in the keep-list, so every
 * comparison of keep-lists holds), set(on) does whatever redraw the change needs, and "default" puts each back to its
 * `dflt` (on when not given). `disabled()` (2026-10-14, optional): true draws the chip greyed and inert, its state
 * forced by another chip (the time bar's "f32ssm copies" while the quality bar keeps the copies as rows of their own).
 */
export function facetBar(el, storeKey, defaults, onChange, extra = []) {
    let keep = defaults.slice();
    try { const v = JSON.parse(localStorage.getItem('facets_' + storeKey) || 'null'); if (Array.isArray(v)) keep = v; } catch { /* private mode */ }
    const paint = () => {
        el.innerHTML = `<div class="flex flex-wrap items-center gap-1 text-[10px]">
            <span class="text-gray-500 mr-1" title="A facet that is ON keeps runs apart; OFF merges runs that differ only there.">separate runs by:</span>
            ${FACETS.map((f) => `<button type="button" data-facet="${f.id}" title="${esc(f.title)}"
                class="px-1.5 py-0.5 rounded border ${keep.includes(f.id) ? 'border-indigo-500 bg-indigo-600/30 text-indigo-100' : 'border-gray-700 text-gray-500 line-through'}">${esc(f.label)}</button>`).join('')}
            ${extra.map((x) => `<button type="button" data-facet-extra="${esc(x.id)}" title="${esc(x.title || '')}"${x.disabled && x.disabled() ? ' disabled' : ''}
                class="px-1.5 py-0.5 rounded border ${x.isOn() ? 'border-indigo-500 bg-indigo-600/30 text-indigo-100' : 'border-gray-700 text-gray-500 line-through'}${x.disabled && x.disabled() ? ' opacity-50 cursor-not-allowed' : ''}">${esc(x.label)}</button>`).join('')}
            <button type="button" data-facet-reset class="ml-1 underline text-gray-500 hover:text-gray-300">default</button></div>`;
        el.querySelectorAll('[data-facet]').forEach((b) => b.addEventListener('click', () => {
            const id = b.dataset.facet;
            keep = keep.includes(id) ? keep.filter((x) => x !== id) : [...keep, id];
            try { localStorage.setItem('facets_' + storeKey, JSON.stringify(keep)); } catch { /* ignore */ }
            paint(); onChange(keep);
        }));
        el.querySelectorAll('[data-facet-extra]').forEach((b) => b.addEventListener('click', () => {
            const x = extra.find((e) => e.id === b.dataset.facetExtra);
            if (x && !(x.disabled && x.disabled())) { x.set(!x.isOn()); if (el.isConnected) paint(); }   // set() may have redrawn the page, this bar with it
        }));
        el.querySelector('[data-facet-reset]').addEventListener('click', () => {
            keep = defaults.slice();
            try { localStorage.removeItem('facets_' + storeKey); } catch { /* ignore */ }
            for (const x of extra) { const d = x.dflt === undefined ? true : !!x.dflt; if (!(x.disabled && x.disabled()) && x.isOn() !== d) x.set(d); }
            if (!el.isConnected) return;   // an extra chip's set() redrew the page: the new bar already shows the defaults
            paint(); onChange(keep);
        });
    };
    paint();
    return keep;
}

// ============================================================ difficulty-adjusted solve rate
// The words and colours of the /100 difficulty (difficultyAdjusted taskDifficulty100; Kyle 2026-10-24: "a graphical
// colored difficulty scale/bar ... with a 'easy/medium/hard/very hard' label"). On the strength scale: a task in a band
// is one a config of that strength solves about half the time, so "very hard" (60+) is at or past the strongest local
// configs (Flash-Next GSQ-RCO IQ3_XXS at 65 on 10-24).
export const DIFFICULTY_BANDS = [   // color: the bar segment; text: the label on a dark card
    { below: 20, word: 'easy', color: '#10b981', text: '#6ee7b7' },
    { below: 40, word: 'medium', color: '#eab308', text: '#fde047' },
    { below: 60, word: 'hard', color: '#f97316', text: '#fdba74' },
    { below: Infinity, word: 'very hard', color: '#ef4444', text: '#fca5a5' },
];
// by the ROUNDED value, the one every page shows: 19.7 reads "20", so it is medium, never a green "20" beside a yellow one
export const difficultyBand = (d) => DIFFICULTY_BANDS.find((b) => Math.round(d) < b.below);
/**
 * PARTIAL POINTS (2026-10-19, Kyle: with the Solve map's "sub-tests" cells on, "strength recomputed from partial points
 * instead of pass/fail"). One task cell -> its share in [0, 1], exactly what the sub-tests view colours the box by
 * (ui/models/index.js cellsOf): a pass is 1; else the share of the cases the untouched base fails that the runs turned
 * green (progress beyond base, summed over the runs, below 1 for a task that did not pass); else, with no baseline, the
 * raw share of hidden-test assertions passed; else (no assertion record, older results) the pass/fail credit. A
 * composite's assertions are those of all its parts, so its share counts the parts. null for an excluded cell.
 */
export function partialCreditOf(t) {
    if (!t || t.excluded || t.credit == null) return null;
    const p = t.progressAll, a = t.assertionsAll;
    if (p && p.of > 0) return t.credit >= 1 ? 1 : Math.min(p.count / p.of, 0.999);
    if (a && a.total > 0) return a.passed / a.total;
    return t.credit;
}
/** The fit's response for one cell: [y, w]. 'binary' (the default): the pass credit over the scored runs, weighted by
 *  the runs. 'partial': partialCreditOf, weighted ONCE per task -- never per assertion or case, so a task with 233
 *  assertions counts as much as one with 4 (and repeats of one task count once). The same likelihood takes both: a
 *  Bernoulli log-likelihood with a fractional outcome (quasi-binomial), which the fit already used for 1-of-2 runs. */
export const FIT_CREDIT = ['binary', 'partial'];
function responseOf(credit) {
    if (credit === 'partial') return (r) => { const y = partialCreditOf(r); return [y == null ? r.credit : y, 1]; };
    return (r) => [r.credit, r.attempts];
}

/**
 * A Rasch (one-parameter item-response) fit over groups x tasks: every group has an ability theta,
 * every task a difficulty b, and P(solve) = sigmoid(theta - b) (since 2026-10-14 a 2PL fit: sigmoid(a * (theta - b)),
 * a per-task discrimination a, see below). Fitted jointly on every scored
 * attempt, so a group that only ran easy tasks is credited only for beating what easy tasks give
 * everyone, and groups that ran different task sets become comparable.
 *
 * Reported per group: `rate` = sigmoid(theta - mean b), the expected solve rate on a task of AVERAGE
 * difficulty, with a 95% interval from the fit's own standard error (thin evidence = wide interval).
 * Fractional credit (1 pass of 2 runs) enters as 2 attempts with outcome 0.5. A weak N(0, 1.5^2)
 * prior on theta and b keeps a 3/3 record finite instead of "infinitely able".
 *
 * groups: [{key, tasks: {taskId: {attempts, credit, excluded}}}] -> Map key -> {rate, lo, hi, theta, se, n}
 */
export function difficultyAdjusted(groups, { minConfigs = LEVEL_MIN_CONFIGS, credit = 'binary', ranges = true } = {}) {
    // `ranges: false` (the strength bootstrap's refits, 2026-10-25): every number as usual but no 95% range (lo / hi null);
    // the posterior grids are a fifth of the fit's time and a replicate needs only the strengths. A group (or model) with
    // no scored task in THIS fit -- a resample that drew none of its task groups -- then still gets the strength its
    // fitted ability gives (its model + facets, the priors: what the fit says about it without its results), n 0.
    const respond = responseOf(credit);
    const obs = [];                       // [gi, ti, y, w]
    const tIndex = new Map();
    // MINIMUM CONFIGS FIRST (2026-10-17): a level problem (`T@L3`) scored by fewer than `minConfigs` of these groups is
    // HELD: not in the joint fit (so it moves no ability, no other difficulty and no points), worth 0 points, and given a
    // difficulty of its own afterwards, from its own results at the fitted abilities (for its task page and the grid's
    // order). Plain L2 tasks are never held. `levelUnscored` on the result: id -> how many groups scored it.
    const scoredBy = new Map();
    for (const g of groups) for (const [t, r] of Object.entries(g.tasks || {})) {
        if (!r || r.excluded || r.credit == null || !(r.attempts > 0) || problemOf(t).level === 'L2') continue;
        scoredBy.set(t, (scoredBy.get(t) || 0) + 1);
    }
    const held = new Map([...scoredBy].filter(([, k]) => k < minConfigs));
    const heldObs = [];                   // [gi, task, y, w]
    groups.forEach((g, gi) => {
        for (const [t, r] of Object.entries(g.tasks || {})) {
            if (!r || r.excluded || r.credit == null || !(r.attempts > 0)) continue;
            const [y, w] = respond(r);
            if (held.has(t)) { heldObs.push([gi, t, y, w]); continue; }
            if (!tIndex.has(t)) tIndex.set(t, tIndex.size);
            obs.push([gi, tIndex.get(t), y, w]);
        }
    });
    const G = groups.length, T = tIndex.size, PRIOR = 1 / (1.5 * 1.5);
    const theta = new Float64Array(G), b = new Float64Array(T);
    // THE ESTIMATOR'S OWN LOGISTIC: the Newton steps below (pass, fitAbilities, the held problems' 1PL) are the 2PL's
    // derivatives, so they keep it; every pass probability the fit REPORTS goes through itemP (above).
    const sig = (x) => 1 / (1 + Math.exp(-x));
    // the observations again as flat columns, for the two iterated loops below (2026-10-06: the same numbers in the
    // same order, without destructuring a 4-element array a few million times)
    const NO = obs.length, oG = new Int32Array(NO), oT = new Int32Array(NO), oY = new Float64Array(NO), oW = new Float64Array(NO);
    obs.forEach((o, i) => { oG[i] = o[0]; oT[i] = o[1]; oY[i] = o[2]; oW[i] = o[3]; });
    // 2PL (2026-10-14, Kyle: "install the recommended method"): each task also gets a discrimination a_j = exp(la_j),
    // P(solve) = sigmoid(a_j * (theta - b_j)), with a tight prior log a_j ~ N(0, 0.25^2) (fitted a ~0.9-1.6). Held-out
    // prediction on our own data (reviews/predictor-eval-20261014): log loss -4% overall and -6% on the hard tail against
    // the 1-parameter fit; a looser prior over-fits. The three blocks are updated in turn (theta, then b, then log a, each
    // from a fresh pass): updating them all at once from one pass oscillates once a is free. The a step is damped
    // (2PL is not convex in (theta, b, a) jointly). ~50 rounds of 3 passes on today's catalog.
    const la = new Float64Array(T), aj = new Float64Array(T).fill(1), P_LA = 1 / (0.25 * 0.25), LA_DAMP = 0.5;
    const gr = new Float64Array(Math.max(G, T)), hs = new Float64Array(Math.max(G, T));
    const pass = (which) => {   // which: 0 theta, 1 b, 2 log a -> the largest step taken
        const K = which === 0 ? G : T;
        gr.fill(0, 0, K); hs.fill(0, 0, K);
        for (let i = 0; i < NO; i++) {
            const gi = oG[i], ti = oT[i], w = oW[i], a = aj[ti], d = theta[gi] - b[ti];
            const p = sig(a * d), r = w * (oY[i] - p), h = w * p * (1 - p);
            if (which === 0) { gr[gi] += a * r; hs[gi] += a * a * h; }
            else if (which === 1) { gr[ti] -= a * r; hs[ti] += a * a * h; }
            else { gr[ti] += a * d * r; hs[ti] += a * a * d * d * h; }
        }
        let move = 0;
        for (let k = 0; k < K; k++) {
            let d;
            if (which === 0) { d = (gr[k] - PRIOR * theta[k]) / (hs[k] + PRIOR); theta[k] += d; }
            else if (which === 1) { d = (gr[k] - PRIOR * b[k]) / (hs[k] + PRIOR); b[k] += d; }
            else { d = LA_DAMP * (gr[k] - P_LA * la[k]) / (hs[k] + P_LA); la[k] += d; aj[k] = Math.exp(la[k]); }
            move = Math.max(move, Math.abs(d));
        }
        return move;
    };
    for (let it = 0; it < 500; it++) {
        const move = Math.max(pass(0), pass(1), pass(2));
        if (move < 1e-7) break;
    }
    const P = (th, j) => itemP(aj[j], b[j], th);   // the fitted P(solve) of task j at ability th, used everywhere below
    // HIERARCHICAL ABILITY (2026-09-29, Kyle): config ability = model ability + facet effects + a small
    // config remainder, task difficulties held from the joint fit above.
    //   model ability  alpha_m ~ N(mu, tau^2), mu/tau estimated from well-tested models (empirical Bayes)
    //   facet effects  beta_f  ~ N(0, 0.7^2): KV type, context bucket, harness, thinking off, template
    //                  flags, 60-min cap -- each SHARED across models, relative to the baseline (opencode,
    //                  KV f16, 128k, thinking on, 120-min cap). Near zero while data is thin, and they grow
    //                  as the data supports them: nothing to "upgrade later".
    //   remainder      eps_g   ~ N(0, 0.35^2): what this exact config shows beyond its model + facets.
    // A thin config is therefore pulled toward ITS OWN MODEL (not the population): a 12-task row can no
    // longer outrank the same model's well-tested evidence, and a genuinely better config rises as fast
    // as its results justify. Model strength (alpha at the baseline) is what the model picker ranks by.
    const facetKeys = (g) => {
        const c = g.c || {}, f = c.facets || {}, h = f.harness || {}, out = [];
        const kv = /(?:cache-type-k|-ctk)\s+(\S+)/.exec((f.kv || []).join(' '));
        if (kv && kv[1] !== 'f16') out.push('kv:' + kv[1]);
        const nc = c.n_ctx || (f.context || {}).n_ctx;
        if (nc) { const k = nc / 1024; const bk = k <= 48 ? '32k' : k <= 80 ? '64k' : k <= 112 ? '96k' : k <= 176 ? null : '256k'; if (bk) out.push('ctx:' + bk); }
        const runner = c.runner || h.runner;
        if (runner && runner !== 'opencode' && runner !== 'claude' && runner !== 'agy') out.push('harness:' + runner + (c.scaffold ? '+' + c.scaffold : ''));
        for (const x of f.output || []) { if (x === '--jinja') continue; out.push(/^(--reasoning|-rea)\s+off$/.test(x) ? 'think:off' : 'tmpl:' + x); }
        if (h.timeout_s && h.timeout_s <= 3600) out.push('cap:60m');
        // Two shared facets the config remainder was absorbing (2026-10-14): a time cap over 120 min (180/360/480-min
        // runs are mostly reruns of tasks that failed or timed out at 120 min, so the effect is selection, strongly
        // negative, and is NOT carried into the model rows below) and a non-default prompt VARIANT (L2+careful, ...).
        // The prompt LEVEL is not a facet (2026-10-17, Kyle: "every different prompt is a different PROBLEM"): a result at
        // L3 is the problem `T@L3`, with a difficulty of its own, so the facet keys on the variant alone, spelled at L2
        // as the server files it (an L3+careful-tone run shares `prompt:L2+careful-tone` with the L2 ones).
        const cap = h.timeout_s || c.timeout_s, pv = promptVariant(h.prompt_level || c.prompt_level);
        if (cap && cap > 7200) out.push('cap:long');
        if (pv) out.push('prompt:L2+' + pv);
        for (const x of f.other || []) out.push('other:' + x);
        return out;
    };
    const modelOf = (g) => (g.m && (g.m.weightsKey || g.m.key)) || g.key;
    const mIndex = new Map(), fIndex = new Map();
    const gModel = new Int32Array(G), gFacets = groups.map((g, gi) => {
        const mk = modelOf(g); if (!mIndex.has(mk)) mIndex.set(mk, mIndex.size); gModel[gi] = mIndex.get(mk);
        return facetKeys(g).map((k) => { if (!fIndex.has(k)) fIndex.set(k, fIndex.size); return fIndex.get(k); });
    });
    const Mn = mIndex.size, F = fIndex.size;
    const alpha = new Float64Array(Mn), beta = new Float64Array(F), eps = new Float64Array(G);
    for (let gi = 0; gi < G; gi++) alpha[gModel[gi]] += theta[gi] / groups.filter((_, k) => gModel[k] === gModel[gi]).length;
    const P_B = 1 / (0.7 * 0.7), P_E = 1 / (0.35 * 0.35);
    let muT = 0, tauT = 1.5;
    const thOf = (gi) => { let t = alpha[gModel[gi]] + eps[gi]; for (const f of gFacets[gi]) t += beta[f]; return t; };
    const thNow = new Float64Array(G);
    const fitAbilities = (P_A) => {
        for (let it = 0; it < 300; it++) {
            let move = 0;
            const block = (which) => {
                const gr = new Float64Array(which === 'a' ? Mn : which === 'b' ? F : G), hs = new Float64Array(gr.length);
                for (let gi = 0; gi < G; gi++) thNow[gi] = thOf(gi);   // abilities do not move inside this pass: once per group, not per observation
                for (let i = 0; i < NO; i++) {
                    const gi = oG[i], ti = oT[i], y = oY[i], w = oW[i];
                    const a = aj[ti], p = sig(a * (thNow[gi] - b[ti])), r = w * a * (y - p), hh = w * a * a * p * (1 - p);
                    if (which === 'a') { gr[gModel[gi]] += r; hs[gModel[gi]] += hh; }
                    else if (which === 'b') { for (const f of gFacets[gi]) { gr[f] += r; hs[f] += hh; } }
                    else { gr[gi] += r; hs[gi] += hh; }
                }
                for (let k = 0; k < gr.length; k++) {
                    let d;
                    if (which === 'a') { d = (gr[k] - P_A * (alpha[k] - muT)) / (hs[k] + P_A); alpha[k] += d; }
                    else if (which === 'b') { d = (gr[k] - P_B * beta[k]) / (hs[k] + P_B); beta[k] += d; }
                    else { d = (gr[k] - P_E * eps[k]) / (hs[k] + P_E); eps[k] += d; }
                    move = Math.max(move, Math.abs(d));
                }
            };
            block('a'); block('b'); block('e');
            if (move < 1e-6) break;
        }
    };
    fitAbilities(1 / (1.5 * 1.5));
    {   // empirical Bayes for the model level: mu/tau from models with >= 20 scored tasks
        const hA = new Float64Array(Mn), cntM = new Float64Array(Mn);
        for (const [gi, ti, , w] of obs) { const p = P(thOf(gi), ti); hA[gModel[gi]] += w * aj[ti] * aj[ti] * p * (1 - p); cntM[gModel[gi]] += 1; }
        const well = []; for (let k = 0; k < Mn; k++) if (cntM[k] >= 20) well.push([alpha[k], 1 / (hA[k] + 1 / 2.25)]);
        if (well.length >= 3) {
            muT = well.reduce((a, x) => a + x[0], 0) / well.length;
            const v = well.reduce((a, x) => a + (x[0] - muT) ** 2, 0) / (well.length - 1) - well.reduce((a, x) => a + x[1], 0) / well.length;
            tauT = Math.sqrt(Math.max(v, 0.25));
        }
        fitAbilities(1 / (tauT * tauT));
    }
    for (let gi = 0; gi < G; gi++) theta[gi] = thOf(gi);
    const PRIOR_T = 1 / (tauT * tauT);
    const meanB = T ? b.reduce((a, x) => a + x, 0) / T : 0;
    const info = new Float64Array(G), n = new Float64Array(G);
    for (const [gi, ti, , w] of obs) { const p = P(theta[gi], ti); info[gi] += w * aj[ti] * aj[ti] * p * (1 - p); n[gi] += 1; }
    // the model level's information: info_g summed over the model's configs (the same terms, at the same abilities)
    const hAfin = new Float64Array(Mn); for (const [gi, ti, , w] of obs) { const p = P(theta[gi], ti); hAfin[gModel[gi]] += w * aj[ti] * aj[ti] * p * (1 - p); }
    const out = new Map();
    // Per-task difficulty on the same scale (higher = harder), for ordering tasks by what the fit
    // learned rather than by raw solve counts (a task only weak models tried is not "hard").
    out.abilityPrior = { mu: muT, tau: tauT };
    out.facetEffects = new Map([...fIndex.entries()].map(([k, j]) => [k, beta[j]]));
    out.taskDifficulty = new Map([...tIndex.entries()].map(([t, j]) => [t, b[j] - meanB]));
    out.taskDiscrimination = new Map([...tIndex.entries()].map(([t, j]) => [t, aj[j]]));
    // the held level problems: a difficulty from their own results at the fitted abilities (1PL, the fit's N(0, 1.5^2)
    // prior on b, a = 1), on the same centred scale; 0 points
    out.levelUnscored = held;
    out.levelMinConfigs = minConfigs;
    {
        const byT = new Map();
        for (const [gi, t, y, w] of heldObs) { if (!byT.has(t)) byT.set(t, []); byT.get(t).push([theta[gi], y, w]); }
        for (const [t, list] of byT) {
            let bh = 0;
            for (let it = 0; it < 100; it++) {
                let gr = -PRIOR * bh, hs = PRIOR;
                for (const [th, y, w] of list) { const p = sig(th - bh); gr -= w * (y - p); hs += w * p * (1 - p); }
                const d = gr / hs; bh += d;
                if (Math.abs(d) < 1e-9) break;
            }
            out.taskDifficulty.set(t, bh - meanB); out.taskDiscrimination.set(t, 1);
        }
    }
    out.meanB = meanB;   // taskDifficulty is centred on it; P(solve) = sigmoid(a * (theta - (difficulty + meanB))) (reportCard)
    // Interval from the model's actual posterior over ability (task difficulties held at their fit),
    // evaluated on a grid, not theta ± 1.96·se. The ±se form breaks for a PERFECT record: the likelihood
    // keeps rising, the curvature at the (prior-held) estimate is near zero, so the "se" balloons and
    // the lower bound collapses -- Flash-Next UD-Q2_K_XL at 33/33 ranked BELOW a 32.5/34 model on "robust"
    // (Kyle, 2026-09-25). The exact 2.5% / 97.5% posterior quantiles have no such pathology.
    const byGroup = Array.from({ length: G }, () => []);
    for (const [gi, ti, y, w] of obs) byGroup[gi].push([ti, y, w]);
    const GRID_LO = -10, GRID_HI = 14, STEP = 0.02, NPTS = Math.round((GRID_HI - GRID_LO) / STEP) + 1;
    // log p and log(1-p) at a grid point depend only on the TASK (z = grid ability - its difficulty), so they are
    // tabulated once per task instead of once per (group, task): 111 groups x ~40 tasks x 1,201 points was 11 M
    // exp/log1p calls and nearly all of the fit's time (2026-10-06, Kyle: "the models page is a relatively heavy
    // load"). The same expressions, added in the same order, so every number is bit-for-bit what it was.
    const LOK = new Float64Array(ranges ? T * NPTS : 0), LNO = new Float64Array(ranges ? T * NPTS : 0);
    if (ranges) for (let j = 0; j < T; j++) for (let k = 0; k < NPTS; k++) {
        const th = GRID_LO + k * STEP;   // log p and log(1-p), numerically stable (itemLogP / itemLog1mP)
        LOK[j * NPTS + k] = itemLogP(aj[j], b[j], th); LNO[j * NPTS + k] = itemLog1mP(aj[j], b[j], th);
    }
    const quantiles = (gi) => {
        const lp = new Float64Array(NPTS); let mx = -Infinity;
        // THE PRIOR IS WHAT THE REST OF THE DATA SAYS about theta_g (2026-10-25): the model's alpha from its OTHER
        // configs (hAfin less this config's own share, info[gi]: the same terms summed over its observations, plus the
        // population prior 1/tau^2), its facets, and eps's own prior variance 1/P_E.
        // Until 10-25 the alpha variance came from every config INCLUDING this one and the centre was alpha + facets with
        // this config's results already in alpha: they were counted twice (in this prior, then again in the likelihood
        // below), so the range was too narrow and leaned toward the data. The centre comes from the fit's own balance: at
        // the joint optimum this config's likelihood slope at theta_g equals P_E * eps_g (the eps block's fixed point), so
        // the leave-this-config-out centre is theta_g - pv * P_E * eps_g, and the posterior below peaks at theta_g itself,
        // the ability the strength is read at. (A model's only config: pv = 1/P_E + tau^2 and the centre is mu + facets.)
        const pv = 1 / P_E + 1 / (Math.max(0, hAfin[gModel[gi]] - info[gi]) + PRIOR_T), cen = theta[gi] - pv * P_E * eps[gi];
        for (let k = 0; k < NPTS; k++) { const th = GRID_LO + k * STEP; lp[k] = -0.5 * (th - cen) * (th - cen) / pv; }
        for (const [j, y, w] of byGroup[gi]) {
            const o = j * NPTS;
            for (let k = 0; k < NPTS; k++) lp[k] += w * (y * LOK[o + k] + (1 - y) * LNO[o + k]);
        }
        for (let k = 0; k < NPTS; k++) if (lp[k] > mx) mx = lp[k];
        let tot = 0; const pd = new Float64Array(NPTS);
        for (let k = 0; k < NPTS; k++) { pd[k] = Math.exp(lp[k] - mx); tot += pd[k]; }
        const at = (q) => { let c = 0; for (let k = 0; k < NPTS; k++) { c += pd[k] / tot; if (c >= q) return GRID_LO + k * STEP; } return GRID_HI; };
        return [at(0.025), at(0.975)];
    };
    // STRENGTH /100 (Kyle, 2026-09-29) -- IRT's expected score on the whole corpus, difficulty-weighted.
    // Every task anyone has attempted is worth points in proportion to its difficulty: the chance a
    // TYPICAL config (median ability) fails it; the points sum to 100. Since 2026-10-25 (Kyle: "Raw pass rate is near
    // useless and should never be used in the formula") a config earns its fitted P(solve) = sigmoid(a * (theta - b)) on
    // EVERY task, run or not: S(theta) = sum of points_j * P(theta, j). Its own results enter only through theta (the
    // likelihood), so a lucky or unlucky single run moves it only as much as the fit lets it, and a repeat chosen on the
    // outcome adds one more observation instead of replacing a cell's credit. Until 10-25 it earned its raw credit on the
    // tasks it ran, and its range added a separate "run-to-run" term for them (a Beta posterior around the raw credit,
    // OBS_PRIOR_N = 2) that was about half the sampling sd of the raw credit it was meant to cover. `coverage` is still
    // the share of the 100 points it actually ran (its evidence). The interval is the exact 95% posterior of theta
    // (`quantiles`) mapped through the same S: S rises with theta, so its quantiles are S at theta's quantiles.
    // This replaces the old "average-difficulty rate / robust lower bound / pass ratio" trio: strength already weighs
    // difficulty, and coverage + interval show the evidence.
    const used = [];
    groups.forEach((g, gi) => { if (n[gi]) used.push(theta[gi]); });
    used.sort((x, y) => x - y);
    const thRef = used.length ? used[Math.floor(used.length / 2)] : 0;
    const w = new Float64Array(T); let W = 0;
    for (let j = 0; j < T; j++) { w[j] = 1 - P(thRef, j); W += w[j]; }
    const scale = W > 0 ? 100 / W : 0;
    out.taskPoints = new Map([...tIndex.entries()].map(([t, j]) => [t, w[j] * scale]));
    for (const t of held.keys()) out.taskPoints.set(t, 0);   // not scored yet: no points
    // DIFFICULTY /100 (Kyle, 2026-10-24: "a general linear 1-100 difficulty score ... a model that scores 30 would have a
    // 50/50 chance of solving a test with difficulty score 30"): the strength a config would have at the ability that
    // gives it exactly a 50% chance on the task (theta = its b, so a cancels), i.e. the corpus's points earned at
    // P(solve) = sigmoid(a_k (b_task - b_k)) on every task k. On the strength scale, monotone in taskDifficulty (ranks
    // unchanged); a real config's strength is this same curve at its theta (since 2026-10-25 strength is S(theta) on
    // every task). Held level problems get a value from their own difficulty too (they earn 0 points).
    out.taskDifficulty100 = new Map();
    for (const [t, d] of out.taskDifficulty) {
        let s = 0; for (let j = 0; j < T; j++) s += w[j] * P(d + meanB, j);
        out.taskDifficulty100.set(t, s * scale);
    }
    const strengthAt = (th) => { let sum = 0; for (let j = 0; j < T; j++) sum += w[j] * P(th, j); return sum * scale; };
    const ran = Array.from({ length: G }, () => new Set());   // tasks each config ran (coverage only)
    for (const [gi, ti] of obs) ran[gi].add(ti);
    groups.forEach((g, gi) => {
        if (!n[gi] && !ranges) { const st = strengthAt(theta[gi]); out.set(g.key, { rate: st / 100, lo: null, hi: null, strength: st, coverage: 0, theta: theta[gi], n: 0 }); return; }
        if (!n[gi]) { out.set(g.key, null); return; }
        const se = 1 / Math.sqrt(info[gi] + PRIOR_T);   // kept for reference; the interval below is exact
        const [qlo, qhi] = ranges ? quantiles(gi) : [NaN, NaN];
        let cov = 0; for (const j of ran[gi]) cov += w[j];
        const st = strengthAt(theta[gi]);
        // rate/lo/hi are the strength on 0..1 so every consumer (grid rank, frontier, ladder, GB, wall)
        // reads it unchanged; avgRate keeps the old "expected rate on an average task" for reference. The posterior
        // peaks at theta[gi] (the prior's centre above), so S(qlo) <= st <= S(qhi); min/max only guard the 0.02 grid.
        out.set(g.key, { rate: st / 100, lo: ranges ? Math.min(st, strengthAt(qlo)) / 100 : null, hi: ranges ? Math.max(st, strengthAt(qhi)) / 100 : null,
            strength: st, coverage: cov * scale / 100, avgRate: itemP(1, meanB, theta[gi]),
            theta: theta[gi], se, n: n[gi] });
    });
    // MODEL strength: the model's ability at the baseline settings (alpha) -- facets and each config's own remainder
    // left out, so a model's side experiments (KV q4_0, long contexts, a careful prompt, a long-cap rerun) do not drag it
    // below its main configs -- read through the same S: S(alpha) on every task (2026-10-25; until then the configs'
    // raw credits, shifted to the baseline settings, on the tasks any of them ran, with the same Beta "run-to-run" term
    // as the configs'). Its 95% range is alpha's posterior, alpha +- 1.96 / sqrt(hAfin + 1/tau^2), through S (no
    // double count here: the population prior is not built from the model's own data).
    // `coverage` / `n`: the tasks any of its configs ran. Keyed by weights key.
    out.models = new Map();
    const mRan = Array.from({ length: Mn }, () => new Set());
    for (const [gi, ti] of obs) mRan[gModel[gi]].add(ti);
    for (const [mk, mi] of mIndex.entries()) {
        if (!mRan[mi].size && ranges) continue;
        const sd = 1 / Math.sqrt(hAfin[mi] + PRIOR_T);
        let cov = 0; for (const j of mRan[mi]) cov += w[j];
        const st = strengthAt(alpha[mi]);
        out.models.set(mk, { strength: st, rate: st / 100, lo: ranges ? strengthAt(alpha[mi] - 1.96 * sd) / 100 : null, hi: ranges ? strengthAt(alpha[mi] + 1.96 * sd) / 100 : null,
            coverage: cov * scale / 100, n: mRan[mi].size, theta: alpha[mi] });
    }
    return out;
}

// ============================================================ report card: good at X, weak at Y
// Kyle, 2026-10-14: "update the config view, when clicking on a config, to fill out that 'good at x, weak at y' view."
// Every task carries 1-3 skill tags (codebench tasks/skills.json; the catalog's taskMeta[id].skills, a `+bonus` task
// its parent's). Per config and tag: how much better or worse it does on that tag's tasks than its overall ability
// predicts, with everything else held from the main fit (difficultyAdjusted):
//     P(solve task j) = sigmoid(a_j * (theta + delta_tag - b_j)),   delta_tag ~ N(0, s^2)
// theta = the config's fitted ability, a_j / b_j = the task's fitted discrimination / difficulty, the likelihood is the
// fit's own (fractional credit, weighted by attempts). delta's posterior is evaluated on a grid (exact, no normal
// approximation: 3 of 3 passes is a skewed posterior), and a tag is a STRENGTH / WEAKNESS only when its central 90%
// interval excludes 0; anything else is "no clear difference". s = REPORT_CARD_S, chosen by held-out log loss on the
// catalog (2026-10-14: 5-fold over config x task cells, the 2PL refitted per fold; s in {0, .25, .5, .75, 1, 1.5}: 0.5 was
// best, 0.4% under s = 0 (no tag effect) in 5 of 5 folds, and wider priors over-fit; the script and its output are
// sweeps/bonus-rows-stage/analysis/choose-s.*). The prior is what keeps a tag with two tasks from reading as a skill:
// with little evidence delta stays near 0 and the interval straddles it.
// `score` is the tag's expected score at theta + delta, 0-100, difficulty-weighted (each task worth its strength points;
// actual credit on tasks the config ran, predicted elsewhere -- strength itself, since 2026-10-25, uses the prediction on
// every task), so configs compare on one skill.
export const REPORT_CARD_S = 0.5;
export const REPORT_CARD_LEVEL = 0.9;
export const REPORT_CARD_THIN = 6;   // fewer tasks run than this on a tag: thin (TAXONOMY.md: "too thin to support a claim alone")
const RC_LO = -6, RC_HI = 6, RC_STEP = 0.02, RC_N = Math.round((RC_HI - RC_LO) / RC_STEP) + 1;
/** Posterior of delta for observations [[a, b, y, w]] at ability theta, prior N(0, s^2) -> {mean, lo, hi, pPos}. */
export function tagDelta(obs, theta, s = REPORT_CARD_S, level = REPORT_CARD_LEVEL) {
    const lp = new Float64Array(RC_N); let mx = -Infinity;
    const iv = s > 0 ? 1 / (s * s) : Infinity;
    if (!(s > 0)) return { mean: 0, lo: 0, hi: 0, pPos: 0.5 };
    for (let k = 0; k < RC_N; k++) {
        const d = RC_LO + k * RC_STEP;
        let v = -0.5 * d * d * iv;
        for (const [a, b, y, w] of obs) v += w * (y * itemLogP(a, b, theta + d) + (1 - y) * itemLog1mP(a, b, theta + d));
        lp[k] = v; if (v > mx) mx = v;
    }
    let tot = 0, m = 0, pos = 0; const pd = new Float64Array(RC_N);
    for (let k = 0; k < RC_N; k++) { pd[k] = Math.exp(lp[k] - mx); tot += pd[k]; }
    for (let k = 0; k < RC_N; k++) { const d = RC_LO + k * RC_STEP; pd[k] /= tot; m += d * pd[k]; if (d > 0) pos += pd[k]; }
    const tail = (1 - level) / 2;
    const at = (q) => { let c = 0; for (let k = 0; k < RC_N; k++) { c += pd[k]; if (c >= q) return RC_LO + k * RC_STEP; } return RC_HI; };
    return { mean: m, lo: at(tail), hi: at(1 - tail), pPos: pos };
}
/**
 * The report card of one fitted config group `g` ({key, tasks}) against the fit `adj` (difficultyAdjusted's Map with
 * taskDifficulty / taskDiscrimination / taskPoints / meanB). `taskMeta`: catalog.taskMeta (its `skills` per task);
 * `tagDefs`: catalog.skillTags. -> null when the config is not in the fit or no task is tagged, else
 * { theta, n, tags: [{tag, def, delta, lo, hi, pPos, call: 'strength'|'weakness'|null, thin, ran, tagged, inFit,
 *   passes, attempts, credit, score, scoreLo, scoreHi}] sorted by delta, strengths, weaknesses, summary, thin }.
 */
export function reportCard(g, adj, taskMeta, tagDefs, { s = REPORT_CARD_S, level = REPORT_CARD_LEVEL } = {}) {
    const a0 = adj && g && adj.get(g.key);
    if (!a0 || a0.theta == null || !adj.taskDifficulty) return null;
    const meta = taskMeta || {};
    const tagsOf = (t) => ((meta[t] && Array.isArray(meta[t].skills)) ? meta[t].skills : []);
    const byTag = new Map();
    for (const t of Object.keys(meta)) for (const tag of tagsOf(t)) {
        if (!byTag.has(tag)) byTag.set(tag, []);
        byTag.get(tag).push(t);
    }
    if (!byTag.size) return null;
    const theta = a0.theta, meanB = adj.meanB || 0;
    const B = (t) => adj.taskDifficulty.get(t) + meanB, A = (t) => (adj.taskDiscrimination ? adj.taskDiscrimination.get(t) : 1) || 1;
    const rows = [];
    for (const [tag, ids] of byTag) {
        const fitIds = ids.filter((t) => adj.taskDifficulty.has(t) && !(adj.levelUnscored && adj.levelUnscored.has(t)));   // a problem not scored yet is not evidence for a tag
        const obs = [], seen = new Map();
        let passes = 0, attempts = 0, credit = 0;
        for (const t of fitIds) {
            const r = g.tasks && g.tasks[t];
            if (!r || r.excluded || r.credit == null || !(r.attempts > 0)) continue;
            obs.push([A(t), B(t), r.credit, r.attempts]); seen.set(t, r.credit);
            passes += r.passes || 0; attempts += r.attempts; credit += r.credit;
        }
        const d = obs.length ? tagDelta(obs, theta, s, level) : { mean: 0, lo: null, hi: null, pPos: 0.5 };
        const scoreAt = (dl) => {
            let num = 0, den = 0;
            for (const t of fitIds) { const w = (adj.taskPoints && adj.taskPoints.get(t)) || 0; den += w; num += w * (seen.has(t) ? seen.get(t) : itemP(A(t), B(t), theta + dl)); }
            return den > 0 ? 100 * num / den : null;
        };
        const call = obs.length && d.lo > 0 ? 'strength' : (obs.length && d.hi < 0 ? 'weakness' : null);
        rows.push({ tag, def: (tagDefs && tagDefs[tag]) || null, delta: d.mean, lo: d.lo, hi: d.hi, pPos: d.pPos, call,
            thin: obs.length < REPORT_CARD_THIN, ran: obs.length, tagged: ids.length, inFit: fitIds.length,
            passes, attempts, credit, score: scoreAt(d.mean), scoreLo: obs.length ? scoreAt(d.lo) : null, scoreHi: obs.length ? scoreAt(d.hi) : null });
    }
    rows.sort((x, y) => (y.delta - x.delta) || (y.ran - x.ran) || x.tag.localeCompare(y.tag));
    const strengths = rows.filter((r) => r.call === 'strength'), weaknesses = rows.filter((r) => r.call === 'weakness').reverse();
    const ran = rows.reduce((m, r) => m + r.ran, 0);
    const list = (xs) => xs.map((r) => r.tag).join(', ');
    const summary = strengths.length || weaknesses.length
        ? [strengths.length ? `Good at ${list(strengths)}` : null, weaknesses.length ? `weak at ${list(weaknesses)}` : null].filter(Boolean).join('; ').replace(/^weak/, 'Weak') + '.'
        : 'No clear strengths or weaknesses: every tag is within what its overall strength predicts.';
    const thinTags = rows.filter((r) => r.ran > 0 && r.thin).length;
    return { theta, n: a0.n, s, level, tags: rows, strengths, weaknesses, summary,
        thin: (a0.n || 0) < 20 || thinTags > rows.filter((r) => r.ran > 0).length / 2, thinTags, ran };
}

// ============================================================ the global fit, shared
// The Models overview's charts and the launch panel's model picker read the SAME numbers: every
// model's configs grouped on the chosen facets, one Rasch fit (difficultyAdjusted) over all quality
// groups and one relative-solve-time pass over all time groups. Kept here so the two cannot drift.

export const groupKeyOf = (c, keep) => JSON.stringify(['weights', ...keep].map((k) => [k, (c.facets || {})[k] ?? null]));

/** Is model `m` in the global fit? (quality data, and not harness-incompatible: its runs say nothing about the model) */
export const inQualityFit = (m) => !!(m && m.counts && m.counts.qualityTasks > 0) && !(m.quality && m.quality.harnessIncompatible);

/** Every scoreable quality config of every model with quality data: [{m, c}]. */
export function qualityEntries(models) {
    const out = [];
    for (const m of (models || [])) {
        if (!inQualityFit(m)) continue;
        for (const c of (m.configs || [])) if (c.agg && c.agg.attempted) out.push({ m, c });
    }
    return out;
}

/**
 * The fit over `entries`: quality groups (keepQ facets) and time groups (keepT), each carrying its
 * metrics `q` and fractional `passed` / `failed`; `adj` the difficulty-weighted rates, `rel` the
 * relative solve times; every time group linked to its quality group as `qg`.
 */
export function fitGroups(entries, keepQ, keepT, { credit = 'binary' } = {}) {
    const decorate = (groups) => {
        for (const g of groups) {
            g.q = qualityMetricsFor(g.tasks, null);
            const scored = Object.values(g.tasks).filter((t) => !t.excluded && t.credit != null);
            g.passed = scored.reduce((a, t) => a + t.credit, 0);
            g.failed = scored.length - g.passed;
        }
        return groups;
    };
    const qAll = decorate(groupConfigs(entries, keepQ));
    const tAll = decorate(groupConfigs(entries, keepT));
    const qByKey = new Map(qAll.map((g) => [g.key, g]));
    for (const g of tAll) g.qg = qByKey.get(groupKeyOf(g.c, keepQ)) || null;
    return { qAll, tAll, adj: difficultyAdjusted(qAll, { credit }), rel: relSolveTimes(tAll), credit };
}

// ONE fit per catalog (2026-10-06, Kyle: "the models page is a relatively heavy load"). The fit is ~150-200 ms and
// opening the Models tab ran it up to three times (charts, strength-by-battery, the pickers on their own copies);
// every caller that wants "the overview's fit of this catalog on these facets" now gets the same object.
// Keyed on the catalog's `models` ARRAY (its identity: ui/benchmarks/util.js catalogStore hands the same object back
// until the server says it changed) and on the two facet lists. Callers must not change what they are handed.
const fitCache = new WeakMap();   // models array -> Map(JSON([keepQ, keepT]) -> fit)
// `credit`: 'binary' (pass/fail, the default) or 'partial' (partial points, see partialCreditOf): its own cached fit.
// THE ONE PLACE the strength bootstrap is applied (2026-10-25): a models array that came out of overviewCatalog carries
// its catalog's `strengthBootstrap` and the view it was folded for (bootRegistry); the fit is then cached per bootstrap
// too, and applyBootstrap sets each row's range (or marks it analytic and says why). Every reader of lo / hi /
// strengthRank -- the Models page, the boards, the pickers, lib/liveodds.js, lib/autoqueue.js -- comes through here.
export function fitFor(models, keepQ, keepT, { credit = 'binary' } = {}) {
    const cr = credit === 'partial' ? 'partial' : 'binary';
    if (!models || typeof models !== 'object') return fitGroups(qualityEntries(models), keepQ, keepT, { credit: cr });
    let per = fitCache.get(models);
    if (!per) fitCache.set(models, per = new Map());
    const reg = bootRegistry.get(models) || null;
    const k = JSON.stringify(cr === 'binary' ? [keepQ, keepT] : [keepQ, keepT, cr])
        + (reg ? `|boot:${(reg.payload && reg.payload.at) || 'none'}:${reg.view.tensorRows}:${reg.view.fileQuality}` : '');
    if (!per.has(k)) {
        if (per.size >= 8) per.delete(per.keys().next().value);   // a session of chip toggling must not keep every fit
        const fit = fitGroups(qualityEntries(models), keepQ, keepT, { credit: cr });
        if (reg) applyBootstrap(fit, reg.payload, { keepQ, credit: cr, view: reg.view });
        per.set(k, fit);
    }
    return per.get(k);
}

// ============================================================ strength ranges from a cluster bootstrap (2026-10-25)
// Kyle 2026-10-25: "Yes run the bootstrap". The 10-25 calibration found the ranges about x1.7 too narrow; the ranges-1025
// formula fix (no double count, no raw credit) took the cluster-bootstrap / stated sd ratio from x1.95 to x1.28. What a
// row's posterior cannot see is what the TASKS leave uncertain: the difficulties and discriminations are estimates too,
// related problems (a task at L2 and L3, its +bonus test, its -staletests twin, a sample group) are not independent, and
// the corpus is one draw of the problems it could have held (the ~3-point drift between catalogs).
// METHOD. Resample whole task GROUPS with replacement and refit the WHOLE joint model each time (difficultyAdjusted:
// difficulties, discriminations, abilities, the model level, the points); a row's range is the spread of S over the refits.
//   group      taskGroupOf: a task with every version of it -- its prompt levels (T@L3), its +bonus test, its -staletests
//              twin, every task of its sample_group (taskMeta: the same bug at another stage), a composite's level copy
//   resample   each group is drawn k ~ Poisson(1) times (the Poisson bootstrap: resampling with replacement, each group's
//              count drawn on its own), k from a hash of (seed, refit, group): the same catalog gives the same draws, and a
//              group added later changes no other group's. A copy is a problem of its own (T~2, T~2@L3, T~2+bonus): the
//              refit sees k problems with the same results.
//   B, seed    BOOT.B = 200 refits, BOOT.SEED fixed: no jitter between page loads, nor between reruns on the same data
//   range      the strength of the FULL-DATA fit (never the bootstrap mean) with the refits' spread around their median:
//              [S - (q50 - q2.5), S + (q97.5 - q50)], clipped to 0..100 ("percentile spread, centred on the point
//              estimate": the skew near 0 or 100 is kept and the range always contains S)
//   drift      what the refits' spread IS (measured 10-25): almost all of the extra width over the posterior is a shift
//              every row shares -- a resample that holds harder (or easier) task groups moves every strength together
//              (the yardstick is the corpus). bootDrift estimates it per refit as a function of strength: the
//              n-weighted kernel mean (bandwidth BOOT.DRIFT_BW points) of S*_b - S over the well-tested rows (n >=
//              BOOT.DRIFT_MIN_N, at least BOOT.DRIFT_MIN_ROWS of them), its spread on a 0..100 grid shipped with the
//              payload. With it removed, a well-tested row's bootstrap spread is its posterior's (median ratio 1.00 on
//              10-25), and 100 random halvings of the task groups shift every row together by sd 6.0 points.
//   thin rows  a bootstrap cannot see a prior: a row whose ability rests on its model's other configs and the fit's priors
//              resamples NARROWER than its posterior. Each END of the range is the wider of (a) the bootstrap's spread
//              and (b) the row's own posterior (difficultyAdjusted's analytic range) combined in quadrature with the
//              drift at its strength, so a thin row keeps its posterior AND carries the drift every row carries (without
//              it a thin row's low end sat higher than a well-tested one's and out-ranked it). No factor anywhere.
//   stale      a row with results newer than the bootstrap keeps the bootstrap's spread around its CURRENT strength (and
//              the posterior where that is wider); the note says so. A row the bootstrap never saw is analytic.
//   gaps       strengthGap: A - B in each refit (the shared drift cancels), the same spread around the full-data gap,
//              plus each row's posterior shortfall beyond its OWN part of the bootstrap spread (max(0, post^2 - (boot^2 -
//              drift^2))) in quadrature. A row without bootstrap data: both shown ranges, as independent (conservative).
// RUNTIME: lib/strengthboot.js, on the server, in a child process at nice 19 on its own timer (a catalog build follows
// every result; this does not), cached in logs/strength-bootstrap.json, carried by the catalog as `strengthBootstrap`
// (lib/catalogworker.js, public/server.js -> the static site's data/catalog.json).
export const BOOT = Object.freeze({ VERSION: 1, B: 200, SEED: 20261025, MIN_PRESENCE: 0.95, DRIFT_BW: 12, DRIFT_MIN_N: 30, DRIFT_MIN_ROWS: 5, DRIFT_STEP: 5 });
const bootRegistry = new WeakMap();   // models array (overviewCatalog's) -> { payload, view }

/** taskMeta -> (problem id -> its task GROUP id: 'sg:<sample_group>' or the base task). */
export function taskGroupOf(taskMeta) {
    const tm = taskMeta || {};
    return (pid) => {
        const p = problemOf(pid);
        let b = p.base.replace(/-staletests$/, '');
        const lv = /^(.+)-L\d+$/.exec(b);   // a composite's level copy filed as a task of its own (`<id>-L3`)
        if (lv && tm[lv[1]]) b = lv[1];
        const sg = (tm[p.base] || {}).sample_group || (tm[b] || {}).sample_group;
        return sg ? 'sg:' + sg : b;
    };
}
function hash32(str) {   // FNV-1a, then murmur3's finaliser: a well-mixed 32-bit hash
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    h ^= h >>> 16; h = Math.imul(h, 0x85ebca6b); h ^= h >>> 13; h = Math.imul(h, 0xc2b2ae35); h ^= h >>> 16;
    return h >>> 0;
}
/** k ~ Poisson(1): how many times task group `group` is drawn in refit `b` under `seed` (deterministic). */
export function bootDraw(seed, b, group) {
    const u = (hash32(`${seed}|${b}|${group}`) + 0.5) / 4294967296;
    let k = 0, p = Math.exp(-1), c = p;
    while (u > c && k < 30) { k += 1; p /= k; c += p; }
    return k;
}
const bootCopyId = (pid, k) => { if (k === 1) return pid; const p = problemOf(pid); return problemId(`${p.base}~${k}${p.bonus ? '+bonus' : ''}`, p.level); };
/** The groups of refit `b`: each cell of a task group drawn k times, as k problems (copy 1 keeps the problem's own id). */
export function bootGroups(groups, b, { seed = BOOT.SEED, groupOf = taskGroupOf(null) } = {}) {
    const memo = new Map();
    const draw = (c) => { let k = memo.get(c); if (k === undefined) memo.set(c, k = bootDraw(seed, b, c)); return k; };
    return groups.map((g) => {
        const tasks = {};
        for (const [pid, cell] of Object.entries(g.tasks || {})) { const k = draw(groupOf(pid)); for (let i = 1; i <= k; i++) tasks[bootCopyId(pid, i)] = cell; }
        return { ...g, tasks };
    });
}
/** A row's record, to tell whether it has results newer than a bootstrap: [scored tasks, scored runs, passes]. */
export function bootRecord(tasks) {
    let n = 0, att = 0, pas = 0;
    for (const r of Object.values(tasks || {})) { if (!r || r.excluded || r.credit == null || !(r.attempts > 0)) continue; n += 1; att += r.attempts; pas += r.credit * r.attempts; }
    return [n, att, Math.round(pas * 1000) / 1000];
}
/**
 * The refits. groups: fitGroups' qAll (the rows) -> { B, seed, groups (task groups), problems, rows: Map key ->
 * Float64Array(B) of strengths (NaN in a refit where the row drew no scored task), models: Map weights key -> the same }.
 * onStep(b) after each refit.
 */
export function strengthBootstrap(groups, { B = BOOT.B, seed = BOOT.SEED, taskMeta = null, credit = 'binary', onStep = null } = {}) {
    const groupOf = taskGroupOf(taskMeta);
    const tg = new Set(), probs = new Set();
    for (const g of groups) for (const [pid, r] of Object.entries(g.tasks || {})) if (r && !r.excluded && r.credit != null && r.attempts > 0) { probs.add(pid); tg.add(groupOf(pid)); }
    const rows = new Map(groups.map((g) => [g.key, new Float64Array(B).fill(NaN)]));
    const models = new Map();
    for (let b = 0; b < B; b++) {
        const A = difficultyAdjusted(bootGroups(groups, b, { seed, groupOf }), { credit, ranges: false });
        for (const g of groups) { const e = A.get(g.key); if (e) rows.get(g.key)[b] = e.strength; }
        for (const [mk, m] of A.models) { if (!models.has(mk)) models.set(mk, new Float64Array(B).fill(NaN)); models.get(mk)[b] = m.strength; }
        if (onStep) onStep(b);
    }
    return { B, seed, groups: tg.size, problems: probs.size, rows, models };
}
/** The q-quantile of an ascending list (linear interpolation, R's type 7). */
export function quantileSorted(s, q) {
    if (!s.length) return NaN;
    const h = (s.length - 1) * q, lo = Math.floor(h), hi = Math.ceil(h);
    return s[lo] + (h - lo) * (s[hi] - s[lo]);
}
const r3 = (x) => Math.round(x * 1000) / 1000;
function bootSummary(arr) {
    const s = Array.from(arr).filter(Number.isFinite).sort((x, y) => x - y);
    return { present: s.length, q: [0.025, 0.5, 0.975].map((p) => r3(quantileSorted(s, p))) };
}
/**
 * The drift every row shares, from the refits (see "drift" above): -> { bw, minN, ref (rows used), s: grid 0..100,
 * lo / hi: the 95% spread below / above its median at each grid strength } | null (no reference rows).
 */
export function bootDrift(fit, boot) {
    let ref = [];
    for (const [k, a] of fit.adj) { const arr = a && boot.rows.get(k); if (arr) ref.push({ s: a.strength, n: a.n, d: arr }); }
    ref.sort((x, y) => y.n - x.n);
    const well = ref.filter((r) => r.n >= BOOT.DRIFT_MIN_N);
    ref = well.length >= BOOT.DRIFT_MIN_ROWS ? well : ref.slice(0, BOOT.DRIFT_MIN_ROWS);
    if (!ref.length) return null;
    const s = [], lo = [], hi = [];
    for (let x = 0; x <= 100; x += BOOT.DRIFT_STEP) {
        const shifts = [];
        for (let b = 0; b < boot.B; b++) {
            let num = 0, den = 0;
            for (const r of ref) { const v = r.d[b]; if (!Number.isFinite(v)) continue; const w = r.n * Math.exp(-0.5 * ((x - r.s) / BOOT.DRIFT_BW) ** 2); num += w * (v - r.s); den += w; }
            if (den > 0) shifts.push(num / den);
        }
        shifts.sort((u, v) => u - v);
        const q50 = quantileSorted(shifts, 0.5);
        s.push(x); lo.push(r3(Math.max(0, q50 - quantileSorted(shifts, 0.025)))); hi.push(r3(Math.max(0, quantileSorted(shifts, 0.975) - q50)));
    }
    return { bw: BOOT.DRIFT_BW, minN: BOOT.DRIFT_MIN_N, ref: ref.length, s, lo, hi };
}
/** The drift's 95% half-widths at strength S (linear between grid points) -> [lo, hi]; [0, 0] without a curve. */
export function driftAt(drift, S) {
    if (!drift || !Array.isArray(drift.s) || !drift.s.length) return [0, 0];
    const x = Math.min(100, Math.max(0, S)), st = drift.s.length > 1 ? drift.s[1] - drift.s[0] : 1;
    const i = Math.min(drift.s.length - 2, Math.max(0, Math.floor((x - drift.s[0]) / st)));
    if (drift.s.length === 1) return [drift.lo[0], drift.hi[0]];
    const t = (x - drift.s[i]) / st;
    return [drift.lo[i] + t * (drift.lo[i + 1] - drift.lo[i]), drift.hi[i] + t * (drift.hi[i + 1] - drift.hi[i])];
}
/**
 * The cache / catalog form of a bootstrap of `fit` (fitFor's): per row its record then, its strength then (s0), the
 * refits' 2.5 / 50 / 97.5% quantiles (q) and every refit's strength in tenths of a point (d, null = absent: the gaps).
 * `view`: the overview view it was computed for { tensorRows, fileQuality, keepQ, credit }.
 */
export function bootstrapPayload(fit, boot, { view, at = new Date().toISOString(), extra = {} } = {}) {
    const pack = (arr) => Array.from(arr, (v) => (Number.isFinite(v) ? Math.round(v * 10) : null));
    const rows = [], models = [], thin = [];
    for (const g of fit.qAll) {
        const a = fit.adj.get(g.key), arr = boot.rows.get(g.key);
        if (!a || !arr) continue;
        const { present, q } = bootSummary(arr);
        if (present < BOOT.MIN_PRESENCE * boot.B) { thin.push({ key: g.key, present }); continue; }
        rows.push({ key: g.key, rec: bootRecord(g.tasks), s0: r3(a.strength), present, q, d: pack(arr) });
    }
    for (const [mk, m] of fit.adj.models) {
        const arr = boot.models.get(mk);
        if (!arr) continue;
        const { present, q } = bootSummary(arr);
        if (present < BOOT.MIN_PRESENCE * boot.B) { thin.push({ key: mk, model: true, present }); continue; }
        models.push({ key: mk, n: m.n, s0: r3(m.strength), present, q, d: pack(arr) });
    }
    return { v: BOOT.VERSION, method: 'cluster bootstrap: task groups drawn Poisson(1) times, the whole fit refitted', at,
        B: boot.B, seed: boot.seed, minPresence: BOOT.MIN_PRESENCE, groups: boot.groups, problems: boot.problems, view, drift: bootDrift(fit, boot), rows, models, thin, ...extra };
}
export const bootUsable = (p) => !!(p && p.v === BOOT.VERSION && Array.isArray(p.rows) && Array.isArray(p.models) && p.view && p.B > 0);
const bootDecoded = new WeakMap();   // payload -> its rows / models as Maps, the refits as numbers
function decodeBoot(p) {
    let out = bootDecoded.get(p);
    if (out) return out;
    const dec = (list) => new Map((list || []).map((r) => [r.key, { rec: r.rec || null, n: r.n, s0: r.s0, present: r.present, q: r.q,
        hwLo: Math.max(0, r.q[1] - r.q[0]), hwHi: Math.max(0, r.q[2] - r.q[1]), d: Float64Array.from(r.d || [], (x) => (x == null ? NaN : x / 10)) }]));
    out = { rows: dec(p.rows), models: dec(p.models), thin: new Map((p.thin || []).map((t) => [(t.model ? 'm:' : '') + t.key, t])) };
    bootDecoded.set(p, out);
    return out;
}
const sameRec = (a, b) => !!(a && b && a.length === b.length && a.every((x, i) => x === b[i]));
/**
 * Apply a bootstrap payload to a fit (fitFor calls it; ONE place). Every fitted row and model gets `range`:
 *   { source: 'bootstrap' | 'analytic', why, parts: { lo, hi: 'bootstrap' | 'posterior' }, B, at, groups, stale, ... }
 * and, where the bootstrap applies, lo / hi replaced (the analytic ones kept as loAnalytic / hiAnalytic). The strength,
 * theta and everything else are untouched. ctx: { keepQ, credit, view } of the fit. -> fit, with fit.boot set when used.
 */
export function applyBootstrap(fit, payload, { keepQ, credit = 'binary', view } = {}) {
    const all = (f) => { for (const [, a] of fit.adj) if (a) f(a); for (const [, m] of (fit.adj.models || new Map())) f(m); };
    if (!bootUsable(payload)) { all((a) => { a.range = { source: 'analytic', why: 'no strength bootstrap has run yet' }; }); return fit; }
    const pv = payload.view;
    if (credit !== pv.credit || JSON.stringify(keepQ) !== JSON.stringify(pv.keepQ) || !view || view.tensorRows !== pv.tensorRows || view.fileQuality !== pv.fileQuality) {
        all((a) => { a.range = { source: 'analytic', why: 'the bootstrap covers the default row settings only (default config grouping, tensor-split rows and f32ssm copies combined, pass / fail cells)' }; });
        return fit;
    }
    const D = decodeBoot(payload), at = payload.at;
    const one = (a, b, recNow, thinInfo) => {
        if (!b) return { source: 'analytic', at, why: thinInfo ? `its tasks fall in too few task groups to resample (it drew a scored task in ${thinInfo.present} of ${payload.B} refits)` : 'new since the last bootstrap' };
        const S = a.strength, anLo = a.lo * 100, anHi = a.hi * 100, [dLo, dHi] = driftAt(payload.drift, S);
        const bLo = Math.max(0, S - b.hwLo), bHi = Math.min(100, S + b.hwHi);
        // the posterior with the shared drift added in quadrature (a thin row's: it carries the drift every row carries)
        const pLo = Math.max(0, S - Math.hypot(S - anLo, dLo)), pHi = Math.min(100, S + Math.hypot(anHi - S, dHi));
        const parts = { lo: bLo <= pLo ? 'bootstrap' : 'posterior', hi: bHi >= pHi ? 'bootstrap' : 'posterior' };
        a.loAnalytic = a.lo; a.hiAnalytic = a.hi;
        a.lo = Math.min(bLo, pLo) / 100; a.hi = Math.max(bHi, pHi) / 100;
        const both = parts.lo === 'posterior' && parts.hi === 'posterior';
        return { source: 'bootstrap', parts, at, B: payload.B, groups: payload.groups, hwLo: b.hwLo, hwHi: b.hwHi, driftLo: dLo, driftHi: dHi,
            why: both ? 'its own posterior, with the drift every row shares added, is wider than its bootstrap spread at both ends' : null,
            stale: recNow ? !sameRec(recNow, b.rec) : (b.n != null && a.n != null && b.n !== a.n), recThen: b.rec || null };
    };
    const byKey = new Map(fit.qAll.map((g) => [g.key, g]));
    for (const [k, a] of fit.adj) { if (!a) continue; const g = byKey.get(k); a.range = one(a, D.rows.get(k), g ? bootRecord(g.tasks) : null, D.thin.get(k)); }
    for (const [k, m] of (fit.adj.models || new Map())) m.range = one(m, D.models.get(k), null, D.thin.get('m:' + k));
    fit.boot = { at, B: payload.B, seed: payload.seed, groups: payload.groups, problems: payload.problems, drift: payload.drift || null, rows: D.rows, models: D.models };
    fit.adj.boot = fit.boot;   // with the fit's maps, so a reader holding only `adj` (a board's metrics) can ask for gaps
    return fit;
}
/**
 * "A vs B" (2026-10-25): the strength gap A - B with its own 95% range, for any two rows of a fit (fitFor's). An id is
 * a config group key (a JSON string, starting "[") or a weights key (the model row, adj.models). -> { gap, lo, hi
 * (points), source: 'bootstrap' | 'independent', resolved (the range excludes 0), ahead (share of refits with A ahead,
 * recentred on the gap; bootstrap only), refits, at, why } | null when either row has no strength.
 *   bootstrap    both rows in the bootstrap: A - B in each refit, so what moves every row together cancels; the spread
 *                around its median, centred on the full-data gap, plus each row's posterior shortfall in quadrature
 *   independent  either row missing from it: the two shown ranges' half-widths in quadrature, as if independent (for
 *                two configs of one model, which share its ability, this is wider than the truth)
 */
export function strengthGap(fit, idA, idB) {
    const adj = fit && fit.adj ? fit.adj : fit, boot = (fit && fit.boot) || (adj && adj.boot) || null;
    if (!adj || typeof adj.get !== 'function') return null;
    const side = (id) => {
        const isRow = String(id).startsWith('[');
        const a = isRow ? adj.get(id) : adj.models && adj.models.get(id);
        const b = boot ? (isRow ? boot.rows : boot.models).get(id) || null : null;
        return a && Number.isFinite(a.lo) && Number.isFinite(a.hi) ? { a, b } : null;
    };
    const A = side(idA), Bs = side(idB);
    if (!A || !Bs) return null;
    const gap = A.a.strength - Bs.a.strength;
    const hw = (x) => ({ lo: x.a.strength - x.a.lo * 100, hi: x.a.hi * 100 - x.a.strength });   // the shown range's half-widths
    if (A.b && Bs.b && boot) {
        const dd = [];
        for (let i = 0; i < A.b.d.length; i++) { const x = A.b.d[i] - Bs.b.d[i]; if (Number.isFinite(x)) dd.push(x); }
        if (dd.length >= BOOT.MIN_PRESENCE * boot.B) {
            dd.sort((x, y) => x - y);
            const q025 = quantileSorted(dd, 0.025), q50 = quantileSorted(dd, 0.5), q975 = quantileSorted(dd, 0.975);
            // a row's posterior beyond its OWN part of the bootstrap spread (the spread less the drift, which the
            // difference has already cancelled), per end: a thin row's, which no resample can see
            const short = (x, end) => {
                const post = end === 'lo' ? x.a.strength - (x.a.loAnalytic != null ? x.a.loAnalytic : x.a.lo) * 100 : (x.a.hiAnalytic != null ? x.a.hiAnalytic : x.a.hi) * 100 - x.a.strength;
                const bh = end === 'lo' ? Math.min(x.a.strength, x.b.hwLo) : Math.min(100 - x.a.strength, x.b.hwHi);
                const dr = driftAt(boot.drift, x.a.strength)[end === 'lo' ? 0 : 1];
                return Math.max(0, post * post - Math.max(0, bh * bh - dr * dr));
            };
            const lo = gap - Math.sqrt((q50 - q025) ** 2 + short(A, 'lo') + short(Bs, 'hi'));
            const hi = gap + Math.sqrt((q975 - q50) ** 2 + short(A, 'hi') + short(Bs, 'lo'));
            return { gap, lo, hi, source: 'bootstrap', resolved: lo > 0 || hi < 0, ahead: dd.filter((x) => x - q50 + gap > 0).length / dd.length,
                refits: dd.length, at: boot.at, why: null };
        }
    }
    const a = hw(A), b = hw(Bs);
    const lo = gap - Math.hypot(a.lo, b.hi), hi = gap + Math.hypot(a.hi, b.lo);
    return { gap, lo, hi, source: 'independent', resolved: lo > 0 || hi < 0, ahead: null, refits: 0, at: boot ? boot.at : null,
        why: !boot ? 'no strength bootstrap applies to these rows' : 'one of the rows is not in the last bootstrap' };
}
const fmtAt = (iso) => { const d = new Date(iso); if (!Number.isFinite(d.getTime())) return String(iso || ''); const p = (x) => String(x).padStart(2, '0'); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };
/** A fit entry's range, in words (tooltips and notes): where its 95% range comes from. '' for an entry without one. */
export function rangeNote(a) {
    const r = a && a.range;
    if (!r) return '';
    if (r.source === 'bootstrap') {
        const both = r.parts && r.parts.lo === 'posterior' && r.parts.hi === 'posterior';
        const post = both ? 'both ends' : r.parts && (r.parts.lo === 'posterior' ? 'its low end' : r.parts.hi === 'posterior' ? 'its high end' : null);
        return `95% range from a cluster bootstrap (${r.B} refits of the whole fit over resampled task groups, ${fmtAt(r.at)}); it includes the ±${Math.round(Math.max(r.driftLo || 0, r.driftHi || 0))} or so points every row moves together when the suite's tasks change, which cancels between rows (Compare shows the gap's own range)`
            + (post ? `; ${post} from its own posterior plus that shared part, wider there than its bootstrap spread` : '')
            + (r.stale ? '; this row has results newer than the bootstrap: its spread is from then, around its current strength' : '');
    }
    return `95% range from the fit's posterior (analytic${r.at ? `; bootstrap of ${fmtAt(r.at)}` : ''}): ${r.why}`;
}

export const BEST_CONFIG_MIN_N = 10, BEST_CONFIG_MIN_FRAC = 0.25;   // bestConfigOf's evidence bar
/**
 * THE rule for which config stands for several (a model's configs, or the configs one battery fell into) -- the one
 * place it lives (2026-10-21, Kyle: "this logic should live in one place, not be duplicated ... this should apply across
 * the code base"). Used by the Solve map's "best config per model" (ui/models/index.js, and so every chart there that
 * follows its Rows switch: the speed x quality frontier and ladder, the cost charts), the Models board's per-column pick,
 * the two pickers (ladderPoints), and every battery's strength (strengthByDir / strengthForDirs: the Benchmarks board,
 * model detail).
 *   Only configs with real evidence compete: at least 10 scored tasks and at least a quarter of the most-tested one,
 *   else the most-tested alone (Kyle, 2026-10-03), so a thin lucky config cannot win. Among those the highest `rank`
 *   (callers pass strengthRank of the group's fit entry; a measure of their own for the raw / ratio modes), ties to
 *   the more-tested.
 * Before 2026-10-21 only the Solve map had the evidence rule; the ladder took the highest low end over every config, so
 * a 6-task careful-tone re-run stood for Flash-Next IQ3_XXS at 63.5 while the Solve map showed its 90-task config at 50.9.
 * `list` holds fitted groups (g.q.scored); `rank(g)` -> number. -> the group, or null for an empty list.
 */
export function bestConfigOf(list, rank, scored = (g) => (g.q && (g.q.scored || g.q.attempted)) || 0) {
    if (!list || !list.length) return null;
    const most = Math.max(...list.map(scored));
    const eligible = list.filter((g) => scored(g) >= Math.max(BEST_CONFIG_MIN_N, BEST_CONFIG_MIN_FRAC * most));
    const pool = eligible.length ? eligible : list.filter((g) => scored(g) === most);   // else the most-tested (ties: by rank)
    return pool.slice().sort((a, b) => (rank(b) - rank(a)) || (scored(b) - scored(a)))[0];
}

/**
 * One ladder point per set of weights among `qGroups`: its best quality group (bestConfigOf by
 * strengthRank), placed at that group's fastest time group; y = its strength ('adjusted') or the
 * low end ('robust'). x = relative solve time, or tokens per solve when cost is 'tokens'.
 *
 * "Fastest" is the lowest relative-time index among the time groups that solved at least
 * LADDER_MIN_N tasks (any time group only when none has): an index over 1 or 2 tasks is noise, and
 * picking it put Flash-Next Q2_K_XL at 1.34× (2 tasks) when its 31-task config sits at 2.5×.
 *
 * `costTasks` is the per-task cost the ladder's steps are priced from, head to head: taskId ->
 * wall_s of the chosen time group (cost 'time') or tokens_out of the quality group (cost 'tokens'),
 * over SOLVED, non-excluded tasks with a positive value (both are means over the passing runs).
 * -> [{key, label, y, rank, rate, lo, hi, x, relTime, tokensPerSolve, n, costTasks, _g, _tg, _others}]
 * (The pickers' ladder. The Models page builds its rungs from the Rows switch's rows with ladderPointOf, 2026-10-21.)
 */
export function ladderPoints(fit, qGroups, { how = 'adjusted', cost = 'time' } = {}) {
    const relOf = (g) => { const r = fit.rel.get(g.key); return r && r.index != null ? r.index : null; };
    const tasksOf = (g) => { const r = fit.rel.get(g.key); return r ? r.tasks : 0; };
    const byW = new Map();
    for (const g of qGroups) { const w = weightsOf(g.m); if (!byW.has(w)) byW.set(w, []); byW.get(w).push(g); }
    return [...byW.values()].map((list) => {
        const qg = bestConfigOf(list, (g) => strengthRank(fit.adj.get(g.key)));
        const timed = fit.tAll.filter((g) => g.qg === qg && relOf(g) != null);
        const enough = timed.filter((g) => tasksOf(g) >= LADDER_MIN_N);
        const tg = (enough.length ? enough : timed).sort((x, y) => relOf(x) - relOf(y))[0] || null;
        return ladderPointOf(qg, fit.adj.get(qg.key), tg, fit.rel, { how, cost, key: qg.m.key, label: qg.m.display, others: list });
    });
}

/**
 * One ladder point: quality group `qg` with fit entry `a`, timed by time group `tg` (relative solve times in `rel`).
 * Shared by ladderPoints (the pickers) and the Models page's ladder (its rows from the Rows switch), so a point means
 * the same thing in both. y = the strength ('adjusted') or its low end ('robust'); `rank` = strengthRank, the order
 * ladderSteps climbs in.
 */
export function ladderPointOf(qg, a, tg, rel, { how = 'adjusted', cost = 'time', key = qg.m.key, label = qg.m.display, others = null } = {}) {
    const r = tg ? rel.get(tg.key) : null;
    const relTime = r && r.index != null ? r.index : null;
    const costTasks = solvedCosts(cost === 'tokens' ? qg.tasks : (tg && tg.tasks), cost === 'tokens' ? 'tokens_out' : 'wall_s');
    return { key, label, y: a ? (how === 'robust' ? a.lo : a.rate) : null, rank: strengthRank(a), rate: a ? a.rate : null,
        lo: a ? a.lo : null, hi: a ? a.hi : null, coverage: a ? a.coverage : null, relTime, tokensPerSolve: qg.q.tokensPerSolve || null,
        x: cost === 'tokens' ? (qg.q.tokensPerSolve || null) : relTime, n: qg.q.scored, costTasks, _g: qg, _tg: tg, _others: others };
}

/** taskId -> the task's `field` (wall_s / tokens_out), over solved, non-excluded tasks where it is > 0. */
export function solvedCosts(tasks, field) {
    if (!tasks) return null;
    const out = {};
    for (const [t, r] of Object.entries(tasks)) if (r && r.solved && !r.excluded && r[field] > 0) out[t] = r[field];
    return out;
}

/**
 * Head-to-head cost of B against A: over the tasks BOTH solved (keys of both costTasks maps), the
 * geometric mean of costB / costA. -> {ratio (null when nothing is shared), n (common tasks)}.
 *
 * Why not relTimeB ÷ relTimeA: each relative-time index is a model's wall ÷ the peer median on ITS
 * OWN task set, so two indexes are measured against different yardsticks and their ratio can point
 * the wrong way (Flash-Next Q2_K_XL read as 0.72× the 27B Q4_K_XL's time; head to head it is slower).
 */
export function pairwiseCost(a, b) {
    const A = a && a.costTasks, B = b && b.costTasks;
    if (!A || !B) return { ratio: null, n: 0 };
    let sum = 0, n = 0;
    for (const [t, va] of Object.entries(A)) {
        const vb = B[t];
        if (!(va > 0) || !(vb > 0)) continue;
        sum += Math.log(vb / va); n++;
    }
    return { ratio: n ? Math.exp(sum / n) : null, n };
}

/**
 * The quality ladder: every model is a rung, in one of two orders, and each step between adjacent
 * rungs is priced in the other measure.
 *
 *   order 'quality'  rungs by `rank` (strengthRank: the low end of the 95% range, 2026-10-21; y when a point
 *                    has none), worst at the bottom. Climbing a step gains `pts` percentage points of
 *                    the plotted rate (y) for `mult` × the cost; the headline is `perPt` =
 *                    (mult - 1) × 100 ÷ pts, the % more cost per +1 point ("+81% time per +1%": plain
 *                    division, not a log). Below LADDER_MIN_PTS the gain is too small to price. Ranked by
 *                    the low end, a better-proven rung can sit above a higher midpoint: `pts` is then
 *                    negative and the step reads "surer, not higher" (ladderStepText), never as a price.
 *   order 'cost'     rungs by x (the cost index), costliest at the bottom. Climbing a step is
 *                    `speedup` × less cost for `pts` of quality (usually negative); the headline is
 *                    `perHalving` = -pts ÷ log2(speedup), the points given up per halving of the cost.
 *                    Below LADDER_MIN_SPEEDUP it is null (no real speedup to price).
 *
 * `mult` (and speedup = 1 / mult) is HEAD TO HEAD: pairwiseCost() over the tasks both rungs solved,
 * `n` of them. Adjacent rungs often share few solved tasks (thin records, cloud models that ran a
 * different subset), so with fewer than LADDER_MIN_N the step is RE-ANCHORED: priced against the
 * nearest rung further down that does share LADDER_MIN_N (`reanchored`, `vsIndex`/`vsKey`; `pts`
 * and `noise` are then against that rung too). Only when no lower rung shares enough does it fall
 * back to the ratio of the rung's x to the rung just below's (their indexes), marked `indirect`: an
 * estimate across different task sets. `basis` is 'direct' | 'reanchored' | 'indirect'.
 * So in cost order a rung placed above (cheaper by index) can still be costlier head to head
 * (speedup < 1); the labels (ladderStepText) follow the head-to-head direction, never the order.
 *
 * Every step also carries `free` (cheaper AND better, head to head: nothing is paid) and `noise`
 * (the two rungs' 95% intervals overlap, so the quality difference may not be real).
 *
 * points: [{key, x, y, lo, hi, costTasks?, ...}] (extra fields ride along) ->
 *   {rungs: [{...p, step}] bottom first, unplaced: [p]}  (no x or y: nowhere to put it)
 */
// Under these a step has no rate: dividing by 0.3 pts or by log2(1.03) turns noise into a headline
// (a 1.07× speedup for -67 pts read as "-673 pts per halving"). LADDER_MIN_N: common solved tasks
// a head-to-head step needs (and solved tasks a time config needs to be a rung's "fastest").
export const LADDER_MIN_PTS = 1, LADDER_MIN_SPEEDUP = 1.1, LADDER_MIN_N = 5;
export function ladderSteps(points, order = 'quality') {
    const ok = (v) => v != null && Number.isFinite(v);
    const unplaced = points.filter((p) => !ok(p.x) || !ok(p.y) || p.x <= 0);
    const rk = (p) => (p.rank != null ? p.rank : p.y);   // strengthRank (2026-10-21); a bare point climbs by y
    const rungs = points.filter((p) => !unplaced.includes(p))
        .sort(order === 'cost' ? (a, b) => (b.x - a.x) || (a.y - b.y) : (a, b) => (rk(a) - rk(b)) || (a.y - b.y) || (b.x - a.x))
        .map((p) => ({ ...p, step: null }));
    const enough = (q) => q.n >= LADDER_MIN_N && q.ratio > 0;
    for (let i = 1; i < rungs.length; i++) {
        const adj = rungs[i - 1], hi = rungs[i];
        // head to head against the rung just below; if they share too few solved tasks, against the
        // nearest rung further down that shares enough; only then the index ratio, marked indirect
        let vs = i - 1, pw = pairwiseCost(adj, hi);
        const nAdj = pw.n;
        let basis = enough(pw) ? 'direct' : 'indirect';
        if (basis === 'indirect') {
            for (let j = i - 2; j >= 0; j--) {
                const q = pairwiseCost(rungs[j], hi);
                if (enough(q)) { vs = j; pw = q; basis = 'reanchored'; break; }
            }
        }
        const lo = rungs[vs], indirect = basis === 'indirect';
        const pts = (hi.y - lo.y) * 100, mult = indirect ? hi.x / adj.x : pw.ratio, speedup = 1 / mult;
        hi.step = {
            pts, mult, speedup, n: indirect ? nAdj : pw.n, indirect, reanchored: basis === 'reanchored', basis,
            vsIndex: vs, vsKey: lo.key, vsLabel: lo.label,
            free: mult < 1 && pts > 0,
            noise: ok(hi.lo) && ok(hi.hi) && ok(lo.lo) && ok(lo.hi) && overlaps(hi, lo),
            perPt: pts >= LADDER_MIN_PTS ? ((mult - 1) * 100) / pts : null,
            perHalving: speedup >= LADDER_MIN_SPEEDUP ? -pts / Math.log2(speedup) : null,
        };
    }
    return { rungs, unplaced };
}

/**
 * A ladder step in words, shared by the chart, its table and the model picker so they cannot
 * disagree. Quality changes are percentage points of solve rate, written "+1.4% solve" / "−3.0% solve".
 *   order 'quality'  "+81% time per +1%" · "+1.4% solve for 1.34× time · 30 shared tasks" · "free: +1.4% solve at 0.72× time"
 *                    · "surer, not higher: −2.0% solve at 0.90× time (a higher low end)" when the rung ranks above on
 *                    the low end of its range but its midpoint is lower (ladderSteps)
 *   order 'cost'     "−3.0% solve per halving of time" · "2.10× faster for −6.3% solve · 12 shared tasks"
 * `basis` says how the step was priced: "30 shared tasks" (head to head with the rung below),
 * "vs #14, 12 shared" (re-anchored on a lower rung, see ladderSteps), "≈ indirect (2 shared)".
 * `rank(step)` names the anchor rung (default "#<vsIndex + 1>", the ladder's bottom-first numbering).
 * Direction always comes from the head-to-head `mult`, never from the rung order. `short` is the
 * phone form. -> {headline, detail, basis, move ("+1.4% solve · 1.34× time"), compact (move with
 * "free" / "vs #k" / "noise" marks, one line for the chart)}
 */
export function ladderStepText(s, { order = 'quality', costWord = 'time', short = false, rank = null } = {}) {
    const faster = costWord === 'time' ? 'faster' : 'cheaper', slower = costWord === 'time' ? 'slower' : 'costlier';
    const f1 = (v) => (Math.abs(v) < 10 ? Math.abs(v).toFixed(1) : String(Math.round(Math.abs(v))));
    const pp = (v) => `${v < 0 ? '−' : '+'}${f1(v)}% solve`;
    const X = (v) => `${s.indirect ? '≈' : ''}${v.toFixed(2)}×`;
    const vsName = s.reanchored ? (rank ? rank(s) : `#${s.vsIndex + 1}`) : '';
    const basis = s.indirect ? `≈ indirect (${s.n} shared)` : s.reanchored ? `vs ${vsName}, ${s.n} shared` : `${s.n} shared tasks`;
    const A = s.indirect ? '≈' : '';   // an indirect step's direction is an estimate too, headline included
    let headline;
    if (order === 'cost') {
        if (s.mult < 1 && s.pts >= LADDER_MIN_PTS) headline = short ? `${A}free` : `${A}free: ${X(s.speedup)} ${faster} and ${pp(s.pts)}`;
        else if (s.mult < 1 && s.pts >= 0) headline = short ? `${A}${faster}, same` : `${A}${faster}, same quality`;
        else if (s.mult >= 1) headline = short ? `${A}${slower}${s.pts < 0 ? ', worse' : ''}` : s.indirect ? `≈${slower}${s.pts < 0 ? ', and worse' : ''}` : `${slower} head to head${s.pts < 0 ? ', and worse' : ''}`;
        else if (s.perHalving == null) headline = short ? `${pp(s.pts)}, no speedup` : `${pp(s.pts)}, no real speedup`;
        else headline = short ? `−${f1(s.perHalving)}% / halving` : `−${f1(s.perHalving)}% solve per halving of ${costWord}`;
    } else {
        // ranked by the low end (strengthRank), a rung can sit above a higher midpoint: surer, not higher -- no price
        if (s.pts <= -LADDER_MIN_PTS) headline = short ? `surer, ${pp(s.pts)}` : `surer, not higher: ${pp(s.pts)} at ${X(s.mult)} ${costWord} (a higher low end)`;
        else if (s.mult < 1) headline = s.pts >= LADDER_MIN_PTS ? (short ? `${A}free` : `${A}free: ${pp(s.pts)} at ${X(s.mult)} ${costWord}`) : A + (short ? `${faster}, same` : `${faster}, same quality`);
        else if (s.perPt == null) headline = short ? `${X(s.mult)}, no gain` : `${X(s.mult)} ${costWord}, no real gain`;
        else headline = short ? `+${f1(s.perPt)}% per +1%` : `+${f1(s.perPt)}% ${costWord} per +1%`;
    }
    const move = order === 'cost'
        ? `${s.mult < 1 ? `${X(s.speedup)} ${faster}` : `${X(s.mult)} ${costWord}`} · ${pp(s.pts)}`
        : `${pp(s.pts)} · ${X(s.mult)} ${costWord}`;
    const detail = `${move.replace(' · ', ' for ')} · ${basis}${s.noise && !short ? ' · within noise' : ''}`;
    // one line for the chart's rail: "free" first, the anchor when it is not the rung below, "noise" last
    const compact = `${s.free ? `${A}free · ` : ''}${s.reanchored ? `vs ${vsName}: ` : ''}${move}${s.noise ? ' · noise' : ''}`;
    return { headline, detail, basis, move, compact };
}

// ============================================================ head-to-head comparison of two rows
// The Solve map's compare mode (2026-10-11, Kyle: "a view that compares the selected two models ... which tests each
// passed that the other failed or did better on than the other, their speed and strength, the confidence of the
// result"). compareRows() is the arithmetic, with no DOM and no fit of its own: two task maps in, counts and lists
// out. ui/models/index.js draws the page from it.

/** The four composite tasks (several fixes in one sitting): called out on their own in a comparison. */
export const COMPOSITE_TASKS = ['clubapp-multi6', 'multi-clubapp-tewaza9', 'multi-clubapp-tewaza9-L3', 'clubapp-payments12'];
/** A task's family when the catalog names no repo for it: the first word of its id (clubapp-, tewaza-, lldash-, ...). */
export const taskFamily = (id) => String(id == null ? '' : id).split('-')[0] || 'other';

/**
 * One row's outcome on one task, folded across its runs the way the task grid colours it.
 *   kind  'pass' | 'pass*' (solved at the time cap: a pass) | 'partial' (passed on some runs) | 'fail' | 'TIMEOUT'
 *         | 'excluded' (no run was a model answer, or a sample-group sibling scored under another task)
 *   scored false for 'excluded'; text is the words to print ("pass 1 of 3 runs").
 * null when the row has no entry for the task (never run).
 */
export function taskOutcome(t) {
    if (!t) return null;
    const attempts = t.attempts || 0, passes = t.passes || 0;
    if (t.folded_into) return { kind: 'excluded', scored: false, credit: null, passes, attempts, text: `counted with ${t.folded_into}` };
    if (t.excluded || t.credit == null) return { kind: 'excluded', scored: false, credit: null, passes, attempts, text: `excluded${t.status && t.status !== 'excluded' ? ` (${t.status})` : ''}` };
    if (t.credit >= 1) { const k = t.status === 'pass*' ? 'pass*' : 'pass'; return { kind: k, scored: true, credit: 1, passes, attempts, text: attempts > 1 ? `${k} ${passes} of ${attempts} runs` : k }; }
    if (t.credit > 0) return { kind: 'partial', scored: true, credit: t.credit, passes, attempts, text: `pass ${passes} of ${attempts} runs` };
    const k = t.status === 'TIMEOUT' ? 'TIMEOUT' : 'fail';
    return { kind: k, scored: true, credit: 0, passes, attempts, text: attempts > 1 ? `${k} 0 of ${attempts} runs` : k };
}

/**
 * Head to head: row A against row B (each { tasks: {id: {status, credit, attempts, passes, solved, excluded,
 * wall_s, tokens_out, ...}} }, a task map folded as lib/models.js / mergeTasks fold it).
 *
 *   opts.difficulty  Map (or object) task -> difficulty, higher = harder (the Rasch fit's taskDifficulty). Orders
 *                    every list and splits the shared tasks into thirds. A task without one sorts as hardest.
 *   opts.familyOf    (id) -> family key; default taskFamily (the id's first word)
 *   opts.composites  ids to report on their own; default COMPOSITE_TASKS
 *
 * A task counts for a side only when that side has a SCORED result on it (taskOutcome().scored): an excluded run is
 * not an answer, so a task one side scored and the other only has excluded runs of is a coverage gap, never a win.
 *
 * -> {
 *   a, b:      whole-record counts: { tasks, scored, excluded, runs, runsPassed, credit, clean, partial, failed, repeated }
 *              (credit = task-equivalents: a task passed 1 of 2 times is 0.5; clean = passed every run; repeated = scored tasks run more than once)
 *   shared:    the like-for-like set, tasks BOTH scored: { n, ids (easiest -> hardest), creditA, creditB,
 *                bothPass, aOnly, bOnly, aBetter, bBetter, tied, bothFail   -- these seven sum to n:
 *                  aOnly / bOnly     a clean pass against a clean miss (credit 1 vs 0)
 *                  aBetter / bBetter any other difference in credit (2 of 3 vs 0 of 3, 1 of 1 vs 1 of 2)
 *                  tied              the same partial credit on both sides
 *                aAhead (= aOnly + aBetter), bAhead, differ (= aAhead + bAhead),
 *                repeatedBoth (tasks both ran more than once), singleRun (tasks where at least one side has ONE run),
 *                lists: { aOnly, bOnly, aBetter, bBetter } of items, MOST DIFFICULT FIRST }
 *   gaps:      { onlyA, onlyB }: items one side scored and the other did not (item.a / item.b null = never run,
 *              kind 'excluded' = run but not scoreable), most difficult first
 *   speed:     over the shared tasks BOTH solved (credit > 0) with a wall clock recorded on both:
 *              { n, medA, medB (median wall seconds), ratio (median over tasks of wallA / wallB; < 1 = A faster),
 *                geo (geometric mean of the same ratio), aFaster, bFaster, same,
 *                tok: { n, medA, medB, ratio } the same for output tokens (0 = not recorded: left out) }
 *   bands:     the shared tasks in three equal slices by difficulty: [{ key: 'easiest' | 'middle' | 'hardest', n,
 *              creditA, creditB, aAhead, bAhead, bothPass, bothFail }] ([] with fewer than 3 shared tasks)
 *   families:  [{ key, n (shared), creditA, creditB, aAhead, bAhead, bothPass, bothFail, onlyA, onlyB (gaps) }], most shared tasks first
 *   composites:[{ id, a, b }] outcomes (null = never run) of opts.composites that either side has an entry for
 * }
 * item = { id, d (difficulty or null), family, a, b (taskOutcome or null) }
 */
export const COMPARE_MIN_SHARED = LADDER_MIN_N, COMPARE_MIN_SHARED_FRAC = 0.25;
export function compareRows(a, b, opts = {}) {
    const A = (a && a.tasks) || {}, B = (b && b.tasks) || {};
    const dmap = opts.difficulty || null;
    const dOf = (id) => { const v = !dmap ? null : typeof dmap.get === 'function' ? dmap.get(id) : dmap[id]; return v == null || !Number.isFinite(Number(v)) ? null : Number(v); };
    const familyOf = opts.familyOf || taskFamily;
    const hardFirst = (x, y) => ((y.d == null ? Infinity : y.d) - (x.d == null ? Infinity : x.d)) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
    const side = (tasks) => {
        const s = { tasks: 0, scored: 0, excluded: 0, runs: 0, runsPassed: 0, credit: 0, clean: 0, partial: 0, failed: 0, repeated: 0 };
        for (const t of Object.values(tasks)) {
            const o = taskOutcome(t);
            s.tasks++;
            if (!o.scored) { s.excluded++; continue; }
            s.scored++; s.runs += o.attempts; s.runsPassed += o.passes; s.credit += o.credit;
            if (o.credit >= 1) s.clean++; else if (o.credit > 0) s.partial++; else s.failed++;
            if (o.attempts > 1) s.repeated++;
        }
        return s;
    };
    const items = [...new Set([...Object.keys(A), ...Object.keys(B)])].map((id) => ({ id, d: dOf(id), family: familyOf(id), a: taskOutcome(A[id]), b: taskOutcome(B[id]) }));
    const sharedItems = items.filter((x) => x.a && x.a.scored && x.b && x.b.scored).sort(hardFirst);
    const shared = { n: sharedItems.length, ids: sharedItems.map((x) => x.id).reverse(), creditA: 0, creditB: 0,
        bothPass: 0, aOnly: 0, bOnly: 0, aBetter: 0, bBetter: 0, tied: 0, bothFail: 0, aAhead: 0, bAhead: 0, differ: 0,
        repeatedBoth: 0, singleRun: 0, lists: { aOnly: [], bOnly: [], aBetter: [], bBetter: [] } };
    const EPS = 1e-9;
    const classOf = (x) => {
        const ca = x.a.credit, cb = x.b.credit;
        if (ca >= 1 && cb >= 1) return 'bothPass';
        if (ca <= 0 && cb <= 0) return 'bothFail';
        if (ca >= 1 && cb <= 0) return 'aOnly';
        if (cb >= 1 && ca <= 0) return 'bOnly';
        return ca > cb + EPS ? 'aBetter' : cb > ca + EPS ? 'bBetter' : 'tied';
    };
    const ahead = (c) => (c === 'aOnly' || c === 'aBetter' ? 'a' : c === 'bOnly' || c === 'bBetter' ? 'b' : null);
    const fam = new Map();
    const famOf = (k) => { if (!fam.has(k)) fam.set(k, { key: k, n: 0, creditA: 0, creditB: 0, aAhead: 0, bAhead: 0, bothPass: 0, bothFail: 0, onlyA: 0, onlyB: 0 }); return fam.get(k); };
    const bands = shared.n >= 3 ? ['easiest', 'middle', 'hardest'].map((key) => ({ key, n: 0, creditA: 0, creditB: 0, aAhead: 0, bAhead: 0, bothPass: 0, bothFail: 0 })) : [];
    sharedItems.forEach((x, i) => {
        const c = classOf(x), w = ahead(c);
        x.cls = c;
        shared[c]++; shared.creditA += x.a.credit; shared.creditB += x.b.credit;
        if (shared.lists[c]) shared.lists[c].push(x);
        if (x.a.attempts > 1 && x.b.attempts > 1) shared.repeatedBoth++;
        if (x.a.attempts <= 1 || x.b.attempts <= 1) shared.singleRun++;
        const groups = [famOf(x.family)];
        if (bands.length) groups.push(bands[Math.floor((3 * (shared.n - 1 - i)) / shared.n)]);   // the j-th easiest of n is in slice floor(3j / n); sharedItems is hardest first
        for (const g of groups) { g.n++; g.creditA += x.a.credit; g.creditB += x.b.credit; if (w === 'a') g.aAhead++; else if (w === 'b') g.bAhead++; else if (c !== 'tied') g[c]++; }
    });
    shared.aAhead = shared.aOnly + shared.aBetter; shared.bAhead = shared.bOnly + shared.bBetter; shared.differ = shared.aAhead + shared.bAhead;
    // A THIN overlap (2026-10-18, Kyle: the compare page "shows both passing 1, and everything else 0s" for Flash-Next
    // UD-Q2_K_XL 64k KV q8_0 (37 tasks scored) against Strata Flash-Next GSQ-RCO IQ1_M careful-tone (13): the two had run
    // different task sets and shared ONE task, so every like-for-like count was 1 or 0). Thin = fewer shared tasks than
    // LADDER_MIN_N, or than a quarter of the smaller row's scored tasks: the like-for-like counts then describe a sliver
    // of the two records and the page must say so before them.
    const sa = Object.values(A).filter((t) => { const o = taskOutcome(t); return o && o.scored; }).length;
    const sb = Object.values(B).filter((t) => { const o = taskOutcome(t); return o && o.scored; }).length;
    shared.thin = shared.n < Math.max(COMPARE_MIN_SHARED, Math.ceil(COMPARE_MIN_SHARED_FRAC * Math.min(sa, sb)));
    const gaps = {
        onlyA: items.filter((x) => x.a && x.a.scored && !(x.b && x.b.scored)).sort(hardFirst),
        onlyB: items.filter((x) => x.b && x.b.scored && !(x.a && x.a.scored)).sort(hardFirst),
    };
    for (const x of gaps.onlyA) famOf(x.family).onlyA++;
    for (const x of gaps.onlyB) famOf(x.family).onlyB++;
    // speed and cost: only where both solved it, and only where both recorded the figure (0 = not recorded)
    const paired = (field) => {
        const ra = [], va = [], vb = [], ids = [];
        let aLess = 0, bLess = 0, same = 0, logSum = 0;
        for (const x of sharedItems) {
            if (!(x.a.credit > 0) || !(x.b.credit > 0)) continue;
            const pa = Number(A[x.id][field]), pb = Number(B[x.id][field]);
            if (!(pa > 0) || !(pb > 0)) continue;
            va.push(pa); vb.push(pb); ra.push(pa / pb); logSum += Math.log(pa / pb); ids.push(x.id);
            if (pa < pb) aLess++; else if (pb < pa) bLess++; else same++;
        }
        const n = ra.length;
        return { n, medA: med(va), medB: med(vb), ratio: med(ra), geo: n ? Math.exp(logSum / n) : null, aLess, bLess, same, ids };
    };
    const w = paired('wall_s'), tk = paired('tokens_out');
    // ids: the paired tasks (the compare page asks which speed configs ran them: speedConfigShare)
    const speed = { n: w.n, medA: w.medA, medB: w.medB, ratio: w.ratio, geo: w.geo, aFaster: w.aLess, bFaster: w.bLess, same: w.same, ids: w.ids,
        tok: { n: tk.n, medA: tk.medA, medB: tk.medB, ratio: tk.ratio, geo: tk.geo, aFewer: tk.aLess, bFewer: tk.bLess, same: tk.same } };
    const composites = (opts.composites || COMPOSITE_TASKS).filter((id) => A[id] || B[id]).map((id) => ({ id, d: dOf(id), a: taskOutcome(A[id]), b: taskOutcome(B[id]) }));
    return { a: side(A), b: side(B), shared, gaps, speed, bands,
        families: [...fam.values()].sort((x, y) => (y.n - x.n) || ((y.onlyA + y.onlyB) - (x.onlyA + x.onlyB)) || (x.key < y.key ? -1 : 1)), composites };
}

/**
 * The compare page's row identities (2026-10-20, Kyle: "allow selecting an arbitrary number of models"): row i's letter
 * (A, B, ... Z, then A2, B2, ...) and colour (SERIES first; past it, hues spread by the golden angle -- an identity
 * colour, never a status colour). Always shown together, so a colour that sits near another is still told apart.
 */
export const compareTag = (i) => String.fromCharCode(65 + (i % 26)) + (i >= 26 ? String(Math.floor(i / 26) + 1) : '');
export const compareColor = (i) => (i < SERIES.length ? SERIES[i] : `hsl(${Math.round((i * 137.508) % 360)}, 62%, 58%)`);

/**
 * The like-for-like split of a TWO-row comparison (compareRows().shared) as ONE ordered list, left to right as the bar
 * draws it: A ahead, both pass, same partial credit, both miss, B ahead (2026-10-20, Kyle: "the order of those little
 * summary boxes should align with the order of the colors on the bar beneath"). The summary tiles and the bar are both
 * drawn from this list, so they cannot disagree on order, colour or count. `core`: a tile is drawn even at 0 (the bar
 * leaves a 0 out); "same partial credit" only shows when there is one. colors: [A's, B's]; tags: ['A', 'B'].
 */
export function likeSegments(sh, { tags = ['A', 'B'], colors = [SERIES[0], SERIES[1]] } = {}) {
    const s = sh || {};
    const better = (n) => (n ? ` · ${n} on partial credit` : '');
    return [
        { key: 'aAhead', label: `${tags[0]} ahead`, n: s.aAhead || 0, color: colors[0], core: true, side: 0,
            sub: `${tags[0]} passed, ${tags[1]} missed: ${s.aOnly || 0}${better(s.aBetter)}` },
        { key: 'bothPass', label: 'both pass', n: s.bothPass || 0, color: STATUS_COLOR.pass, core: true, sub: 'every run, both rows' },
        { key: 'tied', label: 'same partial credit', n: s.tied || 0, color: '#747b8c', core: false, sub: 'passed on some runs, as often on both' },
        { key: 'bothFail', label: 'both miss', n: s.bothFail || 0, color: STATUS_COLOR.fail, core: true, sub: 'no passing run on either' },
        { key: 'bAhead', label: `${tags[1]} ahead`, n: s.bAhead || 0, color: colors[1], core: true, side: 1,
            sub: `${tags[1]} passed, ${tags[0]} missed: ${s.bOnly || 0}${better(s.bBetter)}` },
    ];
}

/**
 * N rows at once (2026-10-20): the like-for-like arithmetic over the tasks EVERY row scored, the head-to-head counts of
 * every pair (compareRows, so a pair's cell matches its own two-row page), and paired speed over the tasks every row
 * solved. rows: [{ tasks }] (two or more); opts as compareRows.
 * -> {
 *   n: rows, sides: whole-record counts per row (compareRows' a / b shape),
 *   shared: { n, ids (easiest -> hardest), credit: [per row], allPass, allFail, tied, split, lead: [per row],
 *             perRow: [{ alone (it alone had the most credit), sharedLead (one of 2+ leaders, not all), behind }],
 *             lists: { lead: [[items] per row], split: [items] } (most difficult first), singleRun, thin }
 *       each shared task is exactly ONE of: allPass (all clean passes), allFail (no pass anywhere), tied (all the same
 *       partial credit), lead[i] (row i alone had the most credit), split (2+ rows, not all, shared the most credit)
 *   pairs: [i][j] = { n, ahead (i ahead of j), behind, thin } for i != j; null on the diagonal
 *   speed: { n (tasks every row solved, wall clock on all), med: [median wall per row], fastest: [tasks it was fastest on],
 *            tok: { n, med: [median output tokens per row] } }
 *   outside: [[items] per row]: tasks the row scored that not every row scored (most difficult first)
 * } item = { id, d, family, o: [taskOutcome per row (null = never run)] }
 */
export function compareMany(rows, opts = {}) {
    const R = (rows || []).map((r) => (r && r.tasks) || {});
    const N = R.length;
    const dmap = opts.difficulty || null;
    const dOf = (id) => { const v = !dmap ? null : typeof dmap.get === 'function' ? dmap.get(id) : dmap[id]; return v == null || !Number.isFinite(Number(v)) ? null : Number(v); };
    const familyOf = opts.familyOf || taskFamily;
    const hardFirst = (x, y) => ((y.d == null ? Infinity : y.d) - (x.d == null ? Infinity : x.d)) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0);
    const scoredOf = (o) => !!(o && o.scored);
    const items = [...new Set(R.flatMap((t) => Object.keys(t)))].map((id) => ({ id, d: dOf(id), family: familyOf(id), o: R.map((t) => taskOutcome(t[id])) }));
    const sharedItems = items.filter((x) => x.o.every(scoredOf)).sort(hardFirst);
    const EPS = 1e-9;
    const shared = { n: sharedItems.length, ids: sharedItems.map((x) => x.id).reverse(), credit: new Array(N).fill(0),
        allPass: 0, allFail: 0, tied: 0, split: 0, lead: new Array(N).fill(0),
        perRow: R.map(() => ({ alone: 0, sharedLead: 0, behind: 0 })), lists: { lead: R.map(() => []), split: [] }, singleRun: 0 };
    for (const x of sharedItems) {
        const c = x.o.map((o) => o.credit);
        c.forEach((v, i) => { shared.credit[i] += v; });
        if (x.o.some((o) => o.attempts <= 1)) shared.singleRun++;
        const max = Math.max(...c), min = Math.min(...c);
        if (min >= 1) { x.cls = 'allPass'; shared.allPass++; continue; }
        if (max <= 0) { x.cls = 'allFail'; shared.allFail++; continue; }
        if (max - min <= EPS) { x.cls = 'tied'; shared.tied++; continue; }
        const leaders = c.map((v, i) => (v >= max - EPS ? i : -1)).filter((i) => i >= 0);
        c.forEach((v, i) => { if (v < max - EPS) shared.perRow[i].behind++; });
        if (leaders.length === 1) { const i = leaders[0]; x.cls = 'lead'; x.leader = i; shared.lead[i]++; shared.perRow[i].alone++; shared.lists.lead[i].push(x); }
        else { x.cls = 'split'; x.leaders = leaders; shared.split++; shared.lists.split.push(x); for (const i of leaders) shared.perRow[i].sharedLead++; }
    }
    const scoredCount = R.map((t) => Object.values(t).filter((v) => scoredOf(taskOutcome(v))).length);
    shared.thin = shared.n < Math.max(COMPARE_MIN_SHARED, Math.ceil(COMPARE_MIN_SHARED_FRAC * Math.min(...(scoredCount.length ? scoredCount : [0]))));
    const pairs = R.map((_, i) => R.map((__, j) => {
        if (i === j) return null;
        const s = compareRows(rows[i], rows[j], { difficulty: dmap, familyOf, composites: [] }).shared;
        return { n: s.n, ahead: s.aAhead, behind: s.bAhead, thin: s.thin };
    }));
    // speed: the tasks EVERY row solved (credit > 0) with the figure recorded on every row (0 = not recorded)
    const paired = (field) => {
        const vals = R.map(() => []), fastest = new Array(N).fill(0), ids = [];
        let n = 0;
        for (const x of sharedItems) {
            if (!x.o.every((o) => o.credit > 0)) continue;
            const v = R.map((t) => Number(t[x.id][field]));
            if (!v.every((y) => y > 0)) continue;
            n++; v.forEach((y, i) => vals[i].push(y)); ids.push(x.id);
            const lo = Math.min(...v), at = v.map((y, i) => (y === lo ? i : -1)).filter((i) => i >= 0);
            if (at.length === 1) fastest[at[0]]++;
        }
        return { n, med: vals.map((a) => med(a)), fastest, ids };
    };
    const w = paired('wall_s'), tk = paired('tokens_out');
    const outside = R.map((_, i) => items.filter((x) => scoredOf(x.o[i]) && !x.o.every(scoredOf)).sort(hardFirst));
    return { n: N, sides: R.map((t) => compareRows({ tasks: t }, { tasks: {} }, { composites: [] }).a), shared, pairs,
        speed: { n: w.n, med: w.med, fastest: w.fastest, ids: w.ids, tok: { n: tk.n, med: tk.med, fewest: tk.fastest } }, outside };
}

/**
 * The like-for-like split of an N-row comparison (compareMany().shared) as one ordered list, as the bar draws it: each
 * row's "alone ahead" in row order (its own colour), then all pass, shared lead, same partial credit, all miss. The
 * summary tiles and the bar are drawn from it (the same rule as likeSegments). tags / colors: per row.
 */
export function manySegments(sh, { tags, colors } = {}) {
    const s = sh || {}, lead = s.lead || [];
    const T = tags || lead.map((_, i) => compareTag(i)), C = colors || lead.map((_, i) => compareColor(i));
    return [
        ...lead.map((n, i) => ({ key: `lead:${i}`, label: `${T[i]} alone ahead`, n: n || 0, color: C[i], core: true, side: i,
            sub: `${T[i]} had more credit than every other row` })),
        { key: 'allPass', label: 'all pass', n: s.allPass || 0, color: STATUS_COLOR.pass, core: true, sub: 'every run, every row' },
        { key: 'split', label: 'shared lead', n: s.split || 0, color: '#9aa3b5', core: true, sub: 'two or more rows (not all) tied for the most credit' },
        { key: 'tied', label: 'same partial credit', n: s.tied || 0, color: '#747b8c', core: false, sub: 'passed on some runs, as often on every row' },
        { key: 'allFail', label: 'all miss', n: s.allFail || 0, color: STATUS_COLOR.fail, core: true, sub: 'no passing run on any row' },
    ];
}

/** The standard quality column set, shared by the codebench board and the models overview. */
export const ADJ_COLUMN = { id: 'adjSolveRate', label: 'strength /100', kind: 'strength', dir: 'desc',
    title: 'Strength out of 100: every task anyone attempted is worth points in proportion to its difficulty (points sum to 100). A config\'s strength is its expected score on all of them at the ability its results give it (Rasch fit over every model and task); its raw pass/fail is never added in. Beneath: 95% range (a cluster bootstrap: task groups resampled, the whole fit refitted; it includes the drift every row shares when the tasks change, so two overlapping ranges can still be ordered: Compare shows the range of the gap itself), and coverage = how many of the 100 points it actually ran.' };
export const QUALITY_COLUMNS = [
    { id: 'solveRate', label: 'solve rate', kind: 'pct', dir: 'desc', title: 'solved ÷ scored tasks. OVERFLOW / KILLED / PROVIDER_ERROR / ABORTED are excluded from the denominator — they are not model answers.' },
    { id: 'excluded', label: 'excl.', kind: 'int', dir: 'asc', title: 'tasks excluded from the denominator (OVERFLOW / KILLED / PROVIDER_ERROR / ABORTED)' },
    { id: 'assertions', label: 'assertions', kind: 'xy', dir: 'desc', title: 'hidden-test assertions passed / total, summed over the results that carry the field' },
    { id: 'tokensPerSolve', label: 'tok/solve', kind: 'int', dir: 'asc', title: 'mean output tokens per SOLVED task (hover for the median)' },
    { id: 'wallPerSolve', label: 'wall/solve', kind: 'dur', dir: 'asc', title: 'mean wall clock per SOLVED task (hover for the median)' },
    { id: 'toolCallsPerSolve', label: 'tools/solve', kind: 'num', dir: 'asc' },
    // solves/hour was here. It never said solves OF WHAT -- a config that only ran easy tasks
    // out-scored one that ran hard ones. Relative solve time (Models > Solve time) replaces it.
];

/**
 * The standard speed column set. WALL COMES FIRST and is the default sort, because ranking
 * configs on generation t/s alone picks the wrong one: on gemma-4-12b-it (2026-09-22, 5 reps)
 * Vulkan won generation 46.4 vs 43.9 while ROCm prefilled 17% faster, and codebench's real
 * mix is prefill-heavy (70.4k in / 16.75k out on one battery) — so the fastest config for the
 * actual work is the one with the lowest wall clock on a stated workload, not the one with the
 * best decode rate. Prefill and generation stay as separate columns and are never blended.
 * KV type is part of the row identity: f16 beats q8 by ~10% on generation for the dense 27B
 * and gemma-4-12b, and the opposite holds for Flash-Next. It is never inherited across models.
 */
export const SPEED_COLUMNS = [
    { id: 'wall', label: 'wall', kind: 'dur', dir: 'asc', title: 'wall clock for the workload stated on the row — the only number that answers "which config is fastest for real work". Rows without a workload (llama-bench measures rates, not a job) have none.' },
    { id: 'prefillTps', label: 'prefill t/s', kind: 'num', dir: 'desc', title: 'prompt-processing rate at the context stated in the row. Never blended with generation.' },
    { id: 'genTps', label: 'gen t/s', kind: 'num', dir: 'desc', title: 'token-generation rate. Sorting by this answers a DIFFERENT question from "which config finishes the work soonest" — on a prefill-heavy workload the generation winner is regularly not the wall-clock winner.' },
    { id: 'ctx', label: 'n_ctx', kind: 'int', dir: 'desc', title: 'a t/s number is meaningless without the context it was measured at' },
    { id: 'residency', label: 'residency', kind: 'text', dir: 'asc', title: 'Where the weights actually live. The biggest lever there is: on gemma-4-26B-A4B (2026-09-22), fully resident across both cards gave 66.4 gen / 2378 prefill, the same model with 12 expert layers on the host gave 30.6 / 890 — 54% of generation and 65% of prefill gone. And splitting a model that already fits on one card costs ~30%, so "use both GPUs" is the intuitive wrong answer.' },
    { id: 'kv', label: 'KV', kind: 'text', dir: 'asc', title: 'cache-type-k/v. Part of the row identity, never carried across models. f16 wins on gemma-4-12b, gemma-4-26B-A4B and the dense 27B; Flash-Next runs q8_0 because f16 + MTP DOES NOT FIT at 64k — a constraint, not a preference.' },
    { id: 'draftAcceptRate', label: 'draft acc', kind: 'pct', dir: 'desc', title: 'speculative draft acceptance — a diagnostic, not an objective' },
];
