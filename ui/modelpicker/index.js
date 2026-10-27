// The launch panel's model picker. The native <select id="model-select"> stays in the DOM (script.js
// fills it, reads it, and listens to its 'change'); it is hidden and a button stands in its place.
// The button opens a modal listing every option the select has, strictly by quality (the ladder's
// active rate), best first. Each row is compared with the CURRENTLY SELECTED model: solve-rate
// points gained or lost, and wall time (and tokens) head to head over the tasks both solved, plus
// how much evidence backs its number. Picking a row sets the select's value and fires the same 'change'
// event the dropdown fires, so profiles, device suggestions and launch behave exactly as before.
//
// The numbers are the Models overview's: the same catalog, the same global fit (fitGroups, with the
// facet chips the overview's charts use) and the same head-to-head cost helper (pairwiseCost).

import { esc, catalogStore } from '../benchmarks/util.js';
import { fitFor, ladderPoints, LADDER_MIN_N, overviewView, overviewCatalog, overviewRowKey } from '../shared/leaderboard.js';
import { pickerRows, compareTo, speedAt32k, THIN_TASKS, THIN_WIDTH } from './rank.js';

const select = document.getElementById('model-select');
if (select) mount(select);

function mount(sel) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'model-picker-btn';
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.className = 'flex-1 min-w-0 flex items-center gap-2 bg-gray-800 hover:bg-gray-700 border border-gray-700 rounded-md px-3 py-2 text-sm text-gray-200 text-left';
    sel.classList.add('hidden');
    sel.after(btn);
    // The label follows the select however its value changes: a pick here, a profile load (which
    // sets .value and dispatches 'change'), or script.js refilling the options.
    const sync = () => {
        const o = sel.selectedOptions && sel.selectedOptions[0];
        btn.innerHTML = `<span class="truncate min-w-0 flex-1">${esc(o ? o.textContent : 'Choose a model…')}</span><span class="text-gray-500 shrink-0">▾</span>`;
        btn.title = o ? o.value : '';
    };
    sel.addEventListener('change', sync);
    new MutationObserver(sync).observe(sel, { childList: true, subtree: true, attributes: true });
    sync();
    const picker = createPicker(sel, () => { sync(); btn.focus(); });
    btn.addEventListener('click', () => picker.open());
}

// ------------------------------------------------------------ data
// The page's one catalog (ui/benchmarks/util.js catalogStore, 2026-10-06): shared with the Models tab, so opening this
// picker after it costs no request inside the minute, and one "still current?" request (a 304) after that.
const CATALOG_TTL = 60 * 1000;
function loadCatalog() {
    return catalogStore.load({ maxAgeMs: CATALOG_TTL }).then((r) => (r.error ? { error: r.error } : r.catalog));
}
// and the rate the ladder is set to: robust (the lower end of the 95% interval) unless changed there
const ladderHow = () => {
    return 'adjusted';   // one quality measure everywhere (2026-09-29): strength /100 = the fit's rate
};
function rank(sel, catalog) {
    const options = [...sel.options].filter((o) => o.value).map((o) => ({ value: o.value, text: o.textContent }));
    if (!catalog || catalog.error) return { ...pickerRows(options, [], []), error: catalog && catalog.error };
    // The Models page's own fit object: the catalog as that page shows it (tensor-split rows and f32ssm copies folded, by
    // its switches) on its chart chips (leaderboard.js overviewView, 2026-10-14). The raw catalog was another fit: a
    // folded model's number differed from the page's (IQ2_XS-mtp 37 here, 59 there) and its copies were rows of their own.
    const v = overviewView(), shown = overviewCatalog(catalog, v);
    const fit = fitFor(shown.models, v.keepQ, v.keepT);
    return { ...pickerRows(options, ladderPoints(fit, fit.qAll, { how: ladderHow(), cost: 'time' }), shown.models, { rowKeyOf: (k) => overviewRowKey(shown, k) }), how: ladderHow() };
}

// ------------------------------------------------------------ formatting
const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const fmtRel = (v) => `${v < 1 ? v.toFixed(2) : v.toFixed(1)}×`;
const f1 = (v) => (Math.abs(v) < 10 ? Math.abs(v).toFixed(1) : String(Math.round(Math.abs(v))));
const tps = (v) => (v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1));
const tok = (v) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k` : String(Math.round(v)));
const speedHtml = (m) => {
    const s = speedAt32k(m);
    if (!s) return '<span class="text-gray-600">no speed at 32k</span>';
    return `<span class="text-gray-500" title="median t/s at ~32k context depth, fastest launch config for each (at least 3 samples)">`
        + `pp ${s.prefill ? tps(s.prefill.tps) : '—'} · tg ${s.gen ? tps(s.gen.tps) : '—'} t/s @32k</span>`;
};
// "+4.1% solve" / "−7.3% solve": percentage points of the active rate, this row minus the current one
const ptsText = (pts) => `${pts >= 0.05 ? '+' : pts <= -0.05 ? '−' : '±'}${f1(pts)} strength`;
// A cost ratio against the current model: "1.34× slower" / "0.76× time (24% faster)"; `unit` names
// the measure ('time' -> slower/faster, 'tokens' -> more/fewer).
function ratioText(c, unit) {
    const A = c.approx ? '≈' : '', r = c.ratio, d = Math.round(Math.abs(r - 1) * 100);
    if (unit === 'time') {
        if (d === 0) return `${A}same speed`;
        // "46% faster" = takes 46% less time; "5% slower" = takes 5% more time
        return r < 1 ? `${A}${d}% faster` : `${A}${d}% slower`;
    }
    return d === 0 ? `${A}same tokens` : `${A}${d}% ${r < 1 ? 'fewer' : 'more'} tokens`;
}
function costHtml(c, unit, curName) {
    const what = unit === 'time' ? 'wall time' : 'output tokens';
    if (!c) return `<span class="text-gray-600">no ${unit === 'time' ? 'time' : 'token'} comparison</span>`;
    const tip = c.approx
        ? `≈ estimate: shares only ${c.n} solved task${c.n === 1 ? '' : 's'} with ${curName} (under ${LADDER_MIN_N}), so this is the ratio of the two ${unit === 'time' ? 'relative solve-time indexes' : 'tokens-per-solve averages'}, each measured on its own tasks`
        : `head to head against ${curName}: geometric mean of ${what} per task over the ${c.n} tasks both solved`;
    const good = c.ratio < 0.995, bad = c.ratio >= 1.005;
    const cls = unit === 'time' ? (good ? 'text-green-300' : bad ? 'text-amber-300' : 'text-gray-300') : 'text-gray-300';
    const basis = c.approx ? `(only ${c.n} shared)` : `over ${c.n} shared tasks`;
    return `<span title="${esc(tip)}"><b class="${cls} font-semibold">${esc(ratioText(c, unit))}</b>${unit === 'time' && c.approx ? ` <span class="text-gray-500">${esc(basis)}</span>` : ''}</span>`;
}

// ------------------------------------------------------------ the modal
function createPicker(sel, onClose) {
    const style = document.createElement('style');
    // Phone: a full-screen sheet. From md up: a centred panel. Written here rather than as Tailwind
    // classes because the vendored build is static and lacks most sizing utilities.
    style.textContent = `
      #mp-modal .mp-panel { position: absolute; inset: 0; }
      @media (min-width: 768px) { #mp-modal .mp-panel { inset: auto; left: 50%; top: 5vh; transform: translateX(-50%); width: min(960px, 94vw); max-height: 90vh; border-radius: 0.75rem; } }
      #mp-modal .mp-list { min-height: 0; }
      #mp-modal .mp-row[data-mp-current="1"] { background: rgba(99, 102, 241, 0.12); box-shadow: inset 3px 0 0 #6366f1; }
      #mp-modal .mp-row[data-active="1"] { background: rgba(79, 70, 229, 0.22); box-shadow: inset 3px 0 0 #818cf8; }`;
    document.head.appendChild(style);
    const root = document.createElement('div');
    root.id = 'mp-modal';
    root.className = 'fixed inset-0 bg-black/80 hidden z-50';
    root.innerHTML = `
      <div class="mp-panel bg-gray-900 border border-gray-700 flex flex-col" role="dialog" aria-modal="true" aria-label="Choose a model">
        <div class="p-3 border-b border-gray-800 space-y-2">
          <div class="flex items-center gap-2">
            <div class="text-sm font-semibold text-gray-100">Choose a model</div>
            <div class="text-[10px] text-gray-500">best quality first · compared with the current model</div>
            <button type="button" data-mp-close class="ml-auto px-2 text-gray-500 hover:text-gray-200" aria-label="close">✕</button>
          </div>
          <input data-mp-search type="text" placeholder="filter models…" autocomplete="off" spellcheck="false"
            class="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-200" />
          <div data-mp-note class="text-[10px] text-gray-500"></div>
        </div>
        <div data-mp-list class="mp-list flex-1 overflow-y-auto"></div>
      </div>`;
    document.body.appendChild(root);
    const input = root.querySelector('[data-mp-search]');
    const list = root.querySelector('[data-mp-list]');
    let data = null, error = null, visible = [], active = 0, loading = false;

    const badge = (t, cls, { style = '', title = '' } = {}) => `<span class="px-1 rounded text-[9px] shrink-0 ${cls}"${style ? ` style="${style}"` : ''}${title ? ` title="${esc(title)}"` : ''}>${t}</span>`;
    const rowHtml = (r, i, rankOf, cur) => {
        const isCur = r.option.value === sel.value;
        const curBadge = isCur ? badge('current', 'border border-indigo-500 text-indigo-300') : '';
        const file = `<span class="text-gray-600 font-mono break-all">${esc(r.option.text)}</span>`;
        const attrs = `class="mp-row w-full text-left px-3 py-2 border-b border-gray-800 hover:bg-gray-800" data-mp-i="${i}"${isCur ? ' data-mp-current="1"' : ''}`;
        if (!r.point) {
            return `<button type="button" ${attrs}>
              <div class="flex items-center gap-2 min-w-0"><span class="text-sm text-gray-300 truncate min-w-0 flex-1">${esc(r.model ? r.model.display : r.option.text)}</span>${curBadge}</div>
              ${r.model ? `<div class="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-gray-400 mt-0.5">${speedHtml(r.model)}${file}</div>` : ''}</button>`;
        }
        const p = r.point, robust = !data || data.how !== 'adjusted';
        const cmp = compareTo(r, cur);
        const thin = r.thin ? badge('thin', '', { style: 'background:rgba(120,53,15,0.6);color:#fde68a',
            title: `thin record: ${p.n} scored tasks, 95% interval ${pct(p.lo)}–${pct(p.hi)}. Its place could move a lot with more runs.` }) : '';
        const same = cmp && cmp.same && !isCur ? badge('same weights', 'border border-gray-700 text-gray-400', { title: 'another file of the current model\'s weights' }) : '';
        const rateTip = 'strength /100: difficulty-weighted points over the whole corpus';
        // quality: the rate, and against the current model the difference in points of that rate
        let delta = '';
        let speed = '';
        if (cmp && !cmp.same) {
            speed = `<span class="text-xs shrink-0">${costHtml(cmp.time, 'time', cur.model ? cur.model.display : cur.point.label)}</span>`;
            const cls = cmp.noise ? 'text-gray-400' : cmp.pts >= 0.05 ? 'text-green-300' : cmp.pts <= -0.05 ? 'text-red-300' : 'text-gray-400';
            delta = `<span class="text-xs font-mono font-semibold shrink-0 ${cls}" title="${esc(`strength ${Math.round(p.y * 100)} vs ${Math.round(cur.point.y * 100)} for the current model${cmp.noise ? '; the two 95% intervals overlap, so this difference is within noise' : ''}`)}">${esc(ptsText(cmp.pts))}</span>`;
        }
        const sc = (v) => (v == null ? '—' : String(Math.round(v * 100)));
        const interval = `<span class="${r.thin ? 'text-amber-300' : ''}"><b class="text-gray-200">${sc(p.y)}</b>/100 · 95% ${sc(p.lo)}–${sc(p.hi)}${p.coverage != null ? ` · ${Math.round(p.coverage * 100)}% tested` : ''} · ${p.n} tasks</span>`;
        const parts = [interval];
        if (cmp && !cmp.same) {
            if (cmp.noise) parts.push('<span class="text-gray-500">quality within noise</span>');
            const curName = cur.model ? cur.model.display : cur.point.label;
            if (cmp.tokens) parts.push(costHtml(cmp.tokens, 'tokens', curName));
        } else {
            // the current model itself (or no current benchmarked model): absolute numbers
            parts.push(`<span title="relative solve time: a joint fit of wall time over every config and task (the length of each task factored out), so 2× = twice as long as a typical config on the same task; only tasks at least two configs solved count">${p.relTime != null ? `${fmtRel(p.relTime)} time index` : 'no relative time'}</span>`);
            if (p.tokensPerSolve) parts.push(`<span>${tok(p.tokensPerSolve)} tokens/solve</span>`);
        }
        parts.push(speedHtml(r.model), file);
        return `<button type="button" ${attrs}>
          <div class="flex items-center gap-2 min-w-0">
            <span class="text-[10px] text-gray-500 font-mono shrink-0">#${rankOf.get(p.key)}</span>
            <span class="text-sm ${isCur ? 'text-white font-semibold' : 'text-gray-100'} truncate min-w-0 flex-1">${esc(r.model ? r.model.display : p.label)}</span>${curBadge}${same}${thin}
            ${delta}${speed}
            <span class="text-sm font-mono shrink-0 ${r.thin ? 'text-gray-400' : 'text-gray-100'}" title="${rateTip}">${pct(p.y)}</span>
          </div>
          <div class="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-gray-400 mt-0.5">${parts.join('')}</div></button>`;
    };
    // Only the list is re-rendered: the search box is never replaced, so typing keeps its focus.
    const paint = () => {
        const q = input.value.trim().toLowerCase();
        const match = (r) => !q || r.option.text.toLowerCase().includes(q) || r.key.includes(q) || (r.model && r.model.display.toLowerCase().includes(q));
        const src = data || { rated: [], unrated: [...sel.options].filter((o) => o.value).map((o) => ({ option: { value: o.value, text: o.textContent }, key: '', point: null, model: null })) };
        // rank numbers over the whole ladder, not the filtered view: #3 stays #3 while you search
        const rankOf = new Map();
        for (const r of src.rated) if (!rankOf.has(r.point.key)) rankOf.set(r.point.key, rankOf.size + 1);
        // every comparison is against the model the select holds now, so re-picking re-bases the list
        const cur = src.rated.find((r) => r.option.value === sel.value) || null;
        const curName = cur ? (cur.model ? cur.model.display : cur.point.label) : null;
        const rated = src.rated.filter(match), unrated = src.unrated.filter(match);
        visible = [...rated, ...unrated];
        if (active >= visible.length) active = Math.max(0, visible.length - 1);
        const note = root.querySelector('[data-mp-note]');
        const rateWord = '<b class="text-gray-400">strength /100</b>';
        if (note) note.innerHTML = `Best first by the ${rateWord}, as the Models page's Quality ladder is set. `
            + (cur
                ? `Every row is compared with the current model, <b class="text-indigo-300">${esc(curName)}</b>: <b class="text-gray-400">±x</b> = points of strength (grey when the 95% intervals overlap: within noise); <b class="text-gray-400">speed</b> = wall time head to head, the geometric mean over the solved tasks the two share; with under ${LADDER_MIN_N} shared it is <b class="text-gray-400">≈</b> the ratio of the relative-time indexes. Tokens the same way. `
                : 'The current model has no quality data, so rows show absolute numbers; pick a benchmarked model to compare against it. ')
            + `<span class="text-amber-300">thin</span> = under ${THIN_TASKS} tasks or an interval wider than ${Math.round(THIN_WIDTH * 100)} points. ↑↓ move · Enter picks · Esc closes.`;
        const head = (t) => `<div class="sticky top-0 px-3 py-1 bg-gray-950 border-b border-gray-800 text-[10px] font-semibold uppercase tracking-wider text-gray-500">${t}</div>`;
        list.innerHTML = (loading ? '<div class="px-3 py-2 text-[10px] text-gray-500">Loading quality data…</div>' : '')
            + (error ? `<div class="px-3 py-2 text-[10px] text-amber-300">No quality data (${esc(error)}); every model is listed alphabetically.</div>` : '')
            + (rated.length ? head(`Benchmarked — best quality first (${rated.length})`) + rated.map((r, i) => rowHtml(r, i, rankOf, cur)).join('') : '')
            + (unrated.length ? head(`Not benchmarked (${unrated.length})`) + unrated.map((r, i) => rowHtml(r, rated.length + i, rankOf, cur)).join('') : '')
            + (!visible.length ? '<div class="px-3 py-4 text-xs text-gray-500 text-center">No model matches.</div>' : '');
        mark(false);
    };
    const mark = (scroll = true) => {
        list.querySelectorAll('.mp-row').forEach((el) => { el.dataset.active = Number(el.dataset.mpI) === active ? '1' : '0'; });
        const el = list.querySelector(`.mp-row[data-mp-i="${active}"]`);
        if (el && scroll) el.scrollIntoView({ block: 'nearest' });
    };
    const pick = (i) => {
        const r = visible[i];
        if (!r) return;
        close();
        if (sel.value !== r.option.value) {
            sel.value = r.option.value;
            sel.dispatchEvent(new Event('change'));
        }
    };
    const close = () => { root.classList.add('hidden'); document.body.style.overflow = ''; onClose(); };
    const open = () => {
        input.value = '';
        root.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
        loading = !data; error = null;
        paint();
        const at = visible.findIndex((r) => r.option.value === sel.value);
        active = at >= 0 ? at : 0; mark();
        input.focus();
        loadCatalog().then((cat) => {
            try { data = rank(sel, cat); error = data.error || null; } catch (e) { data = null; error = String(e && e.message || e); }
            loading = false;
            if (root.classList.contains('hidden')) return;
            const cur = visible[active] && visible[active].option.value;
            paint();
            const at2 = visible.findIndex((r) => r.option.value === (cur || sel.value));
            active = at2 >= 0 ? at2 : 0; mark();
        });
    };

    input.addEventListener('input', () => { active = 0; paint(); });
    list.addEventListener('click', (e) => { const b = e.target.closest('.mp-row'); if (b) pick(Number(b.dataset.mpI)); });
    list.addEventListener('mousemove', (e) => { const b = e.target.closest('.mp-row'); if (b && Number(b.dataset.mpI) !== active) { active = Number(b.dataset.mpI); mark(false); } });
    root.querySelector('[data-mp-close]').addEventListener('click', close);
    root.addEventListener('click', (e) => { if (e.target === root) close(); });
    root.addEventListener('keydown', (e) => {
        // stopPropagation: the page's own Escape handler would also close the phone's launch drawer under it
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(visible.length - 1, active + 1); mark(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); mark(); }
        else if (e.key === 'Enter') { e.preventDefault(); pick(active); }
    });
    return { open, close };
}
