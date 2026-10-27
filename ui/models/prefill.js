// Series for the Models page "prefill t/s vs context" chart, from listModels()' speed.curve
// (lib/models.js prefillCurve). Pure: node tests it.
//
// mode 'model'  -- one line per model, drawn at its MOST-USED launch config (the config with the
//                  most depth-bearing logged requests). A model whose most-used config has a single
//                  bucket is drawn from all its configs together, and says so.
// mode 'config' -- one line per (model, config) with at least `minConfigRequests` requests.
//
// Every model with data is returned: the old overview cut the list to 8 -- and the 8 it kept were
// the first 8 in the catalog's quality-tasks order, not the 8 with the most speed data -- so 14 of
// 22 models with prefill measurements never appeared. Ordered by how much data a line rests on.

const reqPoints = (pts) => (pts || []).filter((p) => p.median != null)
    .map((p) => ({ ctx: Math.max(p.bucket, 1), tps: p.median, n: p.n, src: 'requests', min: p.min, max: p.max }));
const nOf = (pts) => pts.reduce((a, p) => a + (p.n || 0), 0);

function benchPoints(curve) {
    const out = [];
    for (const p of (curve.fromBench || [])) {
        const ctx = Math.max(p.depth || 1, 1);
        // A depth-0 llama-bench row is a prefill measured at no context: plotted at x=1 on a log axis
        // it draws a cliff across the whole chart. Same floor the request curve uses.
        if (ctx <= 64 || p.median == null) continue;
        out.push({ ctx, tps: p.median, n: p.n, src: 'llama-bench' });
    }
    return out;
}
function summaryPoints(m) {
    const byCtx = new Map();
    for (const sp of [m.speed.at8k, m.speed.at32k, m.speed.at64k]) {
        if (sp && sp.prefillTps != null && sp.ctx) byCtx.set(Math.max(sp.ctx, 1), { ctx: Math.max(sp.ctx, 1), tps: sp.prefillTps, n: sp.n, src: 'summary' });
    }
    return [...byCtx.values()];
}
const sortPts = (pts) => pts.slice().sort((a, b) => a.ctx - b.ctx);

export function prefillSeries(models, mode = 'model', opts = {}) {
    const minCfg = opts.minConfigRequests ?? 20;
    const out = [];
    for (const m of models || []) {
        if (m.provider !== 'local' || !m.speed || m.speed.coarse) continue;
        const curve = m.speed.curve || {};
        const cfgs = Array.isArray(curve.byConfig) ? curve.byConfig : [];
        if (mode === 'config' && cfgs.length) {
            let any = false;
            for (const c of cfgs) {
                if (c.n < minCfg) continue;
                const pts = reqPoints(c.points); if (!pts.length) continue;
                any = true;
                out.push({ label: `${m.display} · ${c.label}`, key: m.key, config: c.label, configId: c.id, n: c.n, points: sortPts(pts) });
            }
            if (any) continue;   // otherwise fall through: the model still gets its one line
        }
        const prim = curve.primary ? cfgs.find((c) => c.id === curve.primary) : null;
        let pts, config, n;
        if (prim) { pts = reqPoints(prim.points); config = prim.label + (cfgs.length > 1 ? ` (most-used of ${cfgs.length} configs)` : ''); n = prim.n; }
        else {
            pts = reqPoints(curve.fromRequests);
            config = pts.length ? (cfgs.length > 1 ? `all ${cfgs.length} configs pooled` : (cfgs[0] ? cfgs[0].label : null)) : null;
            n = nOf(pts);
        }
        if (!pts.length) { pts = benchPoints(curve); if (pts.length) { config = 'llama-bench depths'; n = nOf(pts); } }
        if (!pts.length) { pts = summaryPoints(m); if (pts.length) { config = 'summary points'; n = nOf(pts); } }
        if (!pts.length) continue;
        out.push({ label: m.display, key: m.key, config, configId: prim ? prim.id : null, n, points: sortPts(pts) });
    }
    out.sort((a, b) => (b.n || 0) - (a.n || 0) || a.label.localeCompare(b.label));
    return out;
}


// ---- line FOCUS (2026-10-14 23:30, Kyle: "when I click on one I want to FOCUS IT, and remove focus on everything else.
// When I click a second one (in the legend), it should ALSO focus. When I re-click a focused line, it should be, again,
// backgrounded--if that leaves no focused lines, then everything should be surfaced again."). Replaces the 22:5x picker
// that HID lines. The state is a SET OF FOCUSED LINES: empty = every line drawn normally; otherwise the focused lines
// are drawn full colour on top and every other line is backgrounded -- faded and thin, but still drawn. Nothing is ever
// hidden. Remembered per viewer in localStorage, one key per chart + mode. Pure (the storage object is passed in): node
// tests it; the legend is ui/models/charts.js focusLegend, the drawing charts.js applyLineFocus.
//
// A line's id is stable across replots: the model key in 'model' mode, model key + config id in 'config' mode (a model
// has several lines there).
export function lineId(s, mode = 'model') {
    if (!s) return '';
    return mode === 'config' ? `${s.key}|${s.configId ?? s.config ?? ''}` : String(s.key);
}
/** One id per series, unique even when two series would share one (a duplicate gets #2, #3...). */
export function lineIds(series, mode = 'model') {
    const seen = new Map();
    return (series || []).map((s) => {
        const base = lineId(s, mode);
        const k = (seen.get(base) || 0) + 1; seen.set(base, k);
        return k === 1 ? base : `${base}#${k}`;
    });
}
export const lineStoreKey = (chart, mode) => `models_lines_${chart}_${mode}`;
/**
 * The stored focused ids for chart + mode: an array, [] when nothing is focused. The value is {focused: [...]}. Anything
 * else -- absent, unreadable, malformed, or the picker's old {shown: [...]} (which listed lines to DRAW, not to focus) --
 * is [] : an old saved choice never hides or backgrounds anything after the change.
 */
export function loadFocus(storage, chart, mode) {
    try {
        const raw = storage && storage.getItem(lineStoreKey(chart, mode));
        if (!raw) return [];
        const v = JSON.parse(raw);
        return v && Array.isArray(v.focused) ? v.focused.filter((x) => typeof x === 'string') : [];
    } catch { return []; }
}
/** Store the focused ids (a Set or array). Nothing focused removes the key. Never throws (private mode, quota). */
export function saveFocus(storage, chart, mode, focused) {
    try {
        if (!storage) return;
        const k = lineStoreKey(chart, mode);
        const list = [...(focused || [])];
        if (!list.length) storage.removeItem(k);
        else storage.setItem(k, JSON.stringify({ focused: list }));
    } catch { /* private mode */ }
}
/** The focused set for the lines on the chart now: stored ids that no longer exist are dropped (and, once the caller
 *  saves again, gone from storage too). Ordered as the chart is. */
export function resolveFocus(stored, ids) {
    const want = new Set(Array.isArray(stored) ? stored : []);
    return new Set((ids || []).filter((id) => want.has(id)));
}
/** A legend tap: an unfocused line joins the focus set, a focused one leaves it. Returns a new Set. */
export function toggleFocus(focused, id) {
    const next = new Set(focused || []);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
}
/**
 * How line `id` is drawn: 'normal' (nothing focused), 'focus' (full colour, thicker, on top) or 'back' (faded, thin,
 * underneath -- never hidden). `hover` is the id under a desktop pointer, or null: while it is set it alone is brought
 * forward, and when it clears the focus set is back in force.
 */
export function lineLook(id, focused, hover = null) {
    if (hover != null) return id === hover ? 'focus' : 'back';
    if (!focused || !focused.size) return 'normal';
    return focused.has(id) ? 'focus' : 'back';
}
/** The legend's status text: "tap a line to focus it" / "2 of 23 focused". */
export function focusLabel(nFocused, total) {
    return nFocused ? `${nFocused} of ${total} focused` : `${total} line${total === 1 ? '' : 's'} · tap to focus`;
}
/** Indices of `items` ({label, config}) matching every whitespace-separated term of `q`, case-insensitive. */
export function filterLines(items, q) {
    const terms = String(q || '').toLowerCase().split(/\s+/).filter(Boolean);
    const out = [];
    (items || []).forEach((it, i) => {
        const hay = `${it.label || ''} ${it.config || ''}`.toLowerCase();
        if (terms.every((t) => hay.includes(t))) out.push(i);
    });
    return out;
}

// ---- install window only: the names the PRE-FOCUS ui/models/index.js imports from this module. A page load between
// saving this file and saving the new index.js still loads; nothing in the new code calls these. Delete once the new
// index.js is live. (They no longer store anything: the old picker's state is retired.)
export const loadLineSel = () => null;
export const saveLineSel = () => {};
export const resolveLineSel = (_stored, ids) => new Set(ids || []);
export const encodeLineSel = () => null;
export const lineSelLabel = (n, total) => `all (${total})`;
