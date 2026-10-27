// Chart.js helpers for the Models tab. Chart.js v4 is already on the page as a global
// (vendor/chart.js, loaded in index.html) -- no new dependency.
//
// Rules held here so they cannot drift per chart:
//   - never two y-scales on one chart. Prefill and generation are different measures, so they
//     are different charts. A blended "speed" number is not a thing.
//   - categorical hues are assigned in fixed order by entity and never cycled; a 9th series
//     folds into "other" rather than reusing slot 1, so colour always means the same model.
//   - status colours are reserved and never used as series colours.
//   - a legend is always present for >= 2 series; identity is never colour-alone.

import { SERIES, STATUS_COLOR, HIGHLIGHT, ladderStepText } from '../shared/leaderboard.js';
import { esc, answeredLines, answeredCategory, unfinishedLines, unfinishedCategory, specialPassNotes, SPECIAL_PASS_FILL, SPECIAL_PASS_EDGE, UNFINISHED_FILL, UNFINISHED_HATCH, PASS_AT_CAP_NOTE } from '../benchmarks/util.js';
import { filterLines, lineLook } from './prefill.js';

// Read once: the label painters run every frame under pan/zoom.
const SANS = (typeof document !== 'undefined' && typeof getComputedStyle === 'function' && getComputedStyle(document.documentElement).getPropertyValue('--font-sans').trim()) || 'ui-sans-serif, system-ui, sans-serif';
const GRID = 'rgba(255,255,255,0.05)';
const TICK = '#959cab';
const TITLE = '#b9bec9';
// One tooltip skin for every chart on the page (was four inline copies at 10px / 5px padding).
const TIP = { backgroundColor: 'rgba(20,22,28,0.96)', borderColor: '#363a47', borderWidth: 1, titleColor: '#eceef3', bodyColor: '#b9bec9',
    padding: 9, cornerRadius: 8, caretPadding: 8, titleFont: { size: 11.5, weight: '600' }, bodyFont: { size: 11 } };

const registry = new Map();
/**
 * Pan and zoom for the scatter charts (2026-10-01, Kyle): wheel zooms gently around the pointer, click-and-drag pans,
 * on touch one finger pans and two fingers pinch-zoom; double-click / double-tap restores the full view. Log scales
 * move in log space. A drag never counts as a click (the chart's own click handlers see nothing after a drag), and
 * the tooltip is hidden while panning. The canvas takes over touch gestures (touch-action: none) only over the plot.
 */
export function panZoom(chart) {
    const cv = chart && chart.canvas;
    if (!cv) return;
    cv.__zoomChart = chart;                 // charts are rebuilt on the same canvas: the listeners use the current one
    chart.__zoomOrig = {};
    if (cv.__panZoom) return;
    cv.__panZoom = true;
    cv.style.touchAction = 'none';
    const cur = () => cv.__zoomChart;
    const f = (sc, v) => (sc.type === 'logarithmic' ? Math.log10(v) : v), inv = (sc, v) => (sc.type === 'logarithmic' ? Math.pow(10, v) : v);
    const remember = (ch, id) => { if (!(id in ch.__zoomOrig)) ch.__zoomOrig[id] = { min: ch.options.scales[id].min, max: ch.options.scales[id].max }; };
    const zoomAxis = (ch, id, px, k) => {          // k < 1 zooms in
        const sc = ch.scales[id]; if (!sc) return; remember(ch, id);
        const at = f(sc, sc.getValueForPixel(px)), lo = f(sc, sc.min), hi = f(sc, sc.max);
        ch.options.scales[id].min = inv(sc, at - (at - lo) * k);
        ch.options.scales[id].max = inv(sc, at + (hi - at) * k);
    };
    const panAxis = (ch, id, fromPx, toPx) => {
        const sc = ch.scales[id]; if (!sc) return; remember(ch, id);
        const d = f(sc, sc.getValueForPixel(fromPx)) - f(sc, sc.getValueForPixel(toPx));
        ch.options.scales[id].min = inv(sc, f(sc, sc.min) + d);
        ch.options.scales[id].max = inv(sc, f(sc, sc.max) + d);
    };
    const local = (e) => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
    const inPlot = (ch, p) => { const a = ch.chartArea; return a && p.x >= a.left && p.x <= a.right && p.y >= a.top && p.y <= a.bottom; };
    const hideTip = (ch) => { try { ch.tooltip.setActiveElements([], { x: 0, y: 0 }); } catch { /* older Chart.js */ } };
    const reset = () => {
        const ch = cur(); if (!ch || !ch.__zoomOrig) return;
        for (const [id, v] of Object.entries(ch.__zoomOrig)) { ch.options.scales[id].min = v.min; ch.options.scales[id].max = v.max; }
        ch.__zoomOrig = {}; ch.update('none');
    };
    cv.addEventListener('wheel', (e) => {
        const ch = cur(); if (!ch) return;
        const p = local(e); if (!inPlot(ch, p)) return;
        e.preventDefault();
        const k = Math.exp(Math.max(-60, Math.min(60, e.deltaY)) * 0.002);   // ~11% per notch: gradual
        zoomAxis(ch, 'x', p.x, k); zoomAxis(ch, 'y', p.y, k);
        ch.update('none');
    }, { passive: false });
    const ptrs = new Map();       // pointerId -> last local point
    let moved = false, pinchD = null, lastTap = 0;
    cv.addEventListener('pointerdown', (e) => {
        const ch = cur(); if (!ch) return;
        const p = local(e); if (!inPlot(ch, p) && !ptrs.size) return;
        ptrs.set(e.pointerId, p); moved = false;
        if (ptrs.size === 2) { const [a, b] = [...ptrs.values()]; pinchD = Math.hypot(a.x - b.x, a.y - b.y); }
        try { cv.setPointerCapture(e.pointerId); } catch { /* not capturable */ }
    });
    cv.addEventListener('pointermove', (e) => {
        if (!ptrs.has(e.pointerId)) return;
        const ch = cur(); if (!ch) return;
        const p = local(e), prev = ptrs.get(e.pointerId);
        if (ptrs.size === 1) {
            if (!moved && Math.hypot(p.x - prev.x, p.y - prev.y) < 4) return;
            moved = true; hideTip(ch);
            panAxis(ch, 'x', prev.x, p.x); panAxis(ch, 'y', prev.y, p.y);
            ptrs.set(e.pointerId, p); ch.update('none');
        } else if (ptrs.size === 2) {
            ptrs.set(e.pointerId, p);
            const [a, b] = [...ptrs.values()], d = Math.hypot(a.x - b.x, a.y - b.y);
            if (pinchD && d > 0) {
                moved = true; hideTip(ch);
                const k = pinchD / d, mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
                zoomAxis(ch, 'x', mx, k); zoomAxis(ch, 'y', my, k); ch.update('none');
            }
            pinchD = d;
        }
    });
    const up = (e) => {
        if (!ptrs.has(e.pointerId)) return;
        ptrs.delete(e.pointerId); if (ptrs.size < 2) pinchD = null;
        if (e.pointerType === 'touch' && !moved) {          // double-tap resets
            const now = Date.now(); if (now - lastTap < 300) reset(); lastTap = now;
        }
    };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    // after a drag the click is not a pick: stop it before the chart's handlers (registered before ours on this canvas)
    cv.addEventListener('click', (e) => { if (moved) { e.stopImmediatePropagation(); e.preventDefault(); moved = false; } }, true);
    cv.addEventListener('dblclick', reset);
}
export const wheelZoom = panZoom;

export function mount(canvasId, config) {
    const cv = document.getElementById(canvasId);
    if (!cv || typeof window.Chart !== 'function') return null;
    const old = registry.get(canvasId);
    if (old) { try { old.destroy(); } catch { /* already gone */ } registry.delete(canvasId); }
    let c = null;
    try { c = new window.Chart(cv.getContext('2d'), config); } catch { return null; }
    registry.set(canvasId, c);
    return c;
}
// `keep(canvasId)`: charts to leave alone (2026-10-06): a model or task page drops its own charts and leaves the
// overview's (mv-*) alive under it, so going Back shows the overview as it was instead of drawing it again.
export function destroyAll(keep) {
    for (const [id, c] of [...registry.entries()]) {
        if (keep && keep(id)) continue;
        try { c.destroy(); } catch { /* ignore */ }
        registry.delete(id);
    }
}

// ---- search highlight (2026-10-10, Kyle): the models matching the Models page's search box get a GOLD ring wherever
// they are drawn -- a frame around a row, a ring around a point, a halo under a line -- and a gold name.
// setHighlight(test) hands over the test, test(row) -> true for a row / point / line of a matching model (the caller
// knows what its rows are; ui/models/index.js rowHit). It is READ WHEN A CHART DRAWS, never captured when one is
// built: a new term only repaints (repaintHighlight), and a chart built later -- the running poll, a chip, a new
// catalog -- shows the term in force. Gold is near the amber of timeouts and paid ladder steps, hence always a shape too.
// (--hl-gold, when a theme sets it, is the same override the DOM rows use: leaderboard.js ensureHighlightStyle)
const GOLD = (typeof document !== 'undefined' && typeof getComputedStyle === 'function' && getComputedStyle(document.documentElement).getPropertyValue('--hl-gold').trim()) || HIGHLIGHT;
const GOLD_TINT = 'rgba(245,197,66,0.10)';
let hlTest = null;
const isHl = (row) => !!(hlTest && row && hlTest(row));
export function setHighlight(test) { hlTest = typeof test === 'function' ? test : null; }
// Nothing is rebuilt: a canvas repaint, or for a chart whose axis labels / legend carry the gold (chart.$hlUpdate)
// an update with no animation, which re-reads those. chart.$onHl: an HTML legend of the chart to repaint as well.
export function repaintHighlight() {
    for (const c of registry.values()) { try { if (c.$hlUpdate) c.update('none'); else c.draw(); if (typeof c.$onHl === 'function') c.$onHl(); } catch { /* destroyed under us */ } }
}
// A gold frame around each highlighted row of a horizontal-bar chart, across the label strip and the plot; `rows` is
// the chart's row list, in category order.
const rowFramePlugin = (rows) => {
    const each = (chart, fn) => {
        if (!hlTest || !chart.scales.y) return;
        const y = chart.scales.y, a = chart.chartArea;
        const step = rows.length > 1 ? Math.abs(y.getPixelForValue(1) - y.getPixelForValue(0)) : a.bottom - a.top;
        rows.forEach((r, i) => { if (isHl(r)) fn(1, y.getPixelForValue(i) - step / 2 + 1, chart.width - 2, step - 2); });
    };
    const box = (ctx, x, y, w, h) => { ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x, y, w, h, 4); else ctx.rect(x, y, w, h); };
    return {
        id: 'hlRowFrame',
        beforeDatasetsDraw(chart) { const { ctx } = chart; ctx.save(); ctx.fillStyle = GOLD_TINT; each(chart, (x, y, w, h) => { box(ctx, x, y, w, h); ctx.fill(); }); ctx.restore(); },
        afterDraw(chart) { const { ctx } = chart; ctx.save(); ctx.strokeStyle = GOLD; ctx.lineWidth = 1.5; each(chart, (x, y, w, h) => { box(ctx, x + 0.25, y + 0.25, w - 0.5, h - 0.5); ctx.stroke(); }); ctx.restore(); },
    };
};
// A gold ring around one drawn point (scatter charts); `r` is the point's own radius.
const hlRing = (ctx, x, y, r) => { ctx.beginPath(); ctx.arc(x, y, r + 4.5, 0, Math.PI * 2); ctx.stroke(); };

// ---- hover focus: the hovered series stays, every other one fades into the background ----------
// chart.$focus is the focused dataset index (null = none). Colours are faded by alpha, never
// swapped, so a faded series keeps its identity; the original colours live on ds.$base.
const FADE_ALPHA = '26';   // ~15% opacity
const fadeColor = (c) => (typeof c === 'string' && /^#[0-9a-f]{6}/i.test(c) ? c.slice(0, 7) + FADE_ALPHA : c);
export function setFocus(chart, di) {
    if (!chart || chart.$focus === di) return;
    chart.$focus = di;
    chart.data.datasets.forEach((ds, i) => {
        if (!ds.$base) ds.$base = { border: ds.borderColor, bg: ds.backgroundColor, width: ds.borderWidth, order: ds.order || 0 };
        const on = di == null || i === di;
        ds.borderColor = on ? ds.$base.border : fadeColor(ds.$base.border);
        ds.backgroundColor = on ? ds.$base.bg : fadeColor(ds.$base.bg);
        ds.borderWidth = di != null && i === di ? (ds.$base.width || 2) + 1 : ds.$base.width;
        ds.order = di != null && i === di ? -1 : ds.$base.order;   // lower order draws on top
    });
    chart.update('none');
}
/** Alpha a plugin should draw dataset `di`'s extras (whiskers, labels) with. */
const focusAlpha = (chart, di, base = 1) => (chart.$focus == null || chart.$focus === di ? base : base * 0.15);
/** Distance in px from (x, y) to a line dataset's drawn polyline. */
function distToLine(meta, x, y) {
    const pts = meta.data.filter((p) => p && !p.skip && Number.isFinite(p.x) && Number.isFinite(p.y));
    let best = Infinity;
    if (pts.length === 1) return Math.hypot(pts[0].x - x, pts[0].y - y);
    for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i], dx = b.x - a.x, dy = b.y - a.y, L = dx * dx + dy * dy;
        const t = L ? Math.max(0, Math.min(1, ((x - a.x) * dx + (y - a.y) * dy) / L)) : 0;
        best = Math.min(best, Math.hypot(a.x + t * dx - x, a.y + t * dy - y));
    }
    return best;
}

/** Fixed-order hue for an entity, with an explicit overflow bucket instead of a cycled hue. */
export function colorFor(index) { return index < SERIES.length ? SERIES[index] : '#64748b'; }
export const OVERFLOW_LABEL = 'other (beyond 8 series)';

const baseOpts = (xTitle, yTitle, extra = {}) => ({
    responsive: true, maintainAspectRatio: false,
    interaction: { mode: 'nearest', intersect: false },
    plugins: {
        // Legend entries in dataset order, always: hover focus (setFocus) raises the focused series by
        // giving it order -1, and Chart.js sorts legend items by `order` -- the hovered entry jumped to
        // the front, the cursor landed on another entry, that one jumped... a flicker loop.
        legend: { display: true, position: 'bottom', labels: { color: TICK, boxWidth: 10, boxHeight: 10, font: { size: 10 }, usePointStyle: true, sort: (a, b) => a.datasetIndex - b.datasetIndex } },
        tooltip: { ...TIP, displayColors: false, ...(extra.tooltip || {}) },
    },
    scales: {
        x: { title: { display: !!xTitle, text: xTitle, color: TITLE, font: { size: 10 } }, grid: { color: GRID }, ticks: { color: TICK, font: { size: 10 } }, ...(extra.x || {}) },
        y: { title: { display: !!yTitle, text: yTitle, color: TITLE, font: { size: 10 } }, grid: { color: GRID }, ticks: { color: TICK, font: { size: 10 } }, beginAtZero: true, ...(extra.y || {}) },
    },
});

/**
 * Prefill t/s vs context, one line per model. The question it answers is
 * "which model stays usable at 64k" -- so the x axis is the context the measurement was
 * taken at, logarithmic, and a model with one point still shows as a point.
 *
 * Line FOCUS (2026-10-14, Kyle: a legend tap focuses a line, a second tap focuses another too, a focused line tapped
 * again goes back, none focused = every line normal). o.ids: one stable id per series (ui/models/prefill.js lineIds);
 * o.focused: the Set of focused ids. Focused lines are drawn full colour, thicker, on top; the rest are backgrounded --
 * faded and thin, but still drawn: nothing on this chart is ever hidden. The legend is HTML (focusLegend below: 32 px
 * tap targets, which a canvas legend cannot give a phone), so the canvas legend -- and Chart.js's hide-on-click with it
 * -- is off. A desktop pointer within 8 px of a line brings that line forward while it is there; leaving puts the focus
 * set back. Touch never hovers (a tap would leave a sticky emphasis that fights the focus set).
 * Change the focus later with setLineFocus(chart, focused) -- no rebuild.
 */
export function prefillVsContext(canvasId, series, o = {}) {
    const datasets = series.map((s, i) => ({
        label: s.label, $config: s.config || null,   // which launch config the line is drawn at (ui/models/prefill.js)
        $row: s,                                     // for the search highlight
        data: s.points.map((p) => ({ x: p.ctx, y: p.tps, n: p.n, src: p.src, min: p.min, max: p.max })),
        // Dash pattern as a second channel: eight hues plus three dash styles stay tellable apart
        // where hue alone does not, and it survives a colour-vision difference or a grey print.
        // Colour and dash are by the line's index in the full series, so the focus never recolours a line.
        borderColor: lineStyle(i).color, backgroundColor: lineStyle(i).color + 'cc',
        borderDash: lineStyle(i).dash,
        borderWidth: 1.75, pointRadius: 2.25, pointBorderWidth: 0, pointHoverRadius: 6, tension: 0.25, spanGaps: true,
    }));
    const opts = baseOpts('prompt tokens in context (log)', 'prefill t/s', {
            x: { type: 'logarithmic', ticks: { color: TICK, font: { size: 10 }, callback: (v) => (v >= 1024 ? `${Math.round(v / 1024)}k` : v) } },
            // The rate is the answer; the context is the axis you are already standing on. Chart.js
            // titles a line tooltip with the x value by default, which put the context length in
            // the bold line and buried the t/s in the body.
            tooltip: { callbacks: {
                title: (items) => `${Number(items[0].parsed.y).toFixed(1)} t/s prefill`,
                label: (c) => `${c.dataset.label} @ ${Math.round(c.parsed.x).toLocaleString()} tok${c.raw.n ? ` (n=${c.raw.n})` : ''}`,
                afterLabel: (c) => {
                    const r = c.raw || {}; const out = [];
                    if (r.min != null && r.max != null && r.n > 1) out.push(`range ${r.min.toFixed(0)}–${r.max.toFixed(0)} t/s`);
                    if (r.src) out.push(r.src === 'requests' ? 'median of logged requests' : r.src === 'llama-bench' ? 'llama-bench at depth' : 'summary point');
                    if (c.dataset.$config && !String(c.dataset.label).includes(c.dataset.$config)) out.push(`config: ${c.dataset.$config}`);
                    return out;
                },
            } },
        });
    opts.plugins.legend = { display: false };   // the HTML legend (focusLegend) is this chart's legend
    const ids = Array.isArray(o.ids) && o.ids.length === series.length ? o.ids : series.map((_s, i) => String(i));
    opts.onHover = (evt, _els, chart) => {
        if (!fineHover() || isTouch(evt)) return;
        if (evt.type === 'mouseout') return setLineHover(chart, null);
        let di = null, best = 8;
        chart.data.datasets.forEach((_, i) => {
            const d = distToLine(chart.getDatasetMeta(i), evt.x, evt.y);
            if (d <= best) { best = d; di = i; }
        });
        setLineHover(chart, di == null ? null : ids[di]);
    };
    // Search highlight: a gold halo under a matching model's line (its own colour and dash stay on top), a ring when
    // the "line" is a single point; the legend entry turns gold (focusLegend).
    const halo = {
        id: 'hlHalo',
        beforeDatasetsDraw(chart) {
            if (!hlTest) return;
            const { ctx, chartArea: a } = chart;
            ctx.save();
            ctx.beginPath(); ctx.rect(a.left, a.top, a.right - a.left, a.bottom - a.top); ctx.clip();
            ctx.strokeStyle = GOLD; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
            chart.data.datasets.forEach((ds, di) => {
                const meta = chart.getDatasetMeta(di);
                if (meta.hidden || !chart.isDatasetVisible(di) || !isHl(ds.$row)) return;
                const pts = meta.data.filter((p) => p && !p.skip && Number.isFinite(p.x) && Number.isFinite(p.y));
                ctx.globalAlpha = 0.6; ctx.lineWidth = 7; ctx.setLineDash([]);
                if (pts.length > 1 && meta.dataset) { ctx.beginPath(); meta.dataset.path(ctx); ctx.stroke(); }
                ctx.globalAlpha = 1; ctx.lineWidth = 2;
                if (pts.length === 1) hlRing(ctx, pts[0].x, pts[0].y, 2.25);
            });
            ctx.restore();
        },
    };
    const c = mount(canvasId, { type: 'line', data: { datasets }, options: opts, plugins: [halo] });
    if (c) {
        c.$lineFocus = { ids, focused: new Set(o.focused || []), hover: null };
        applyLineFocus(c, false);
    }
    return c;
}

// ---- line focus: drawing. The look per line comes from ui/models/prefill.js lineLook ('normal' | 'focus' | 'back');
// this maps it to dataset styles. The base colours live on ds.$lfBase, so a backgrounded line keeps its hue and dash.
const LINE_LOOKS = {
    normal: { width: 1.75, point: 2.25, order: 0, alpha: null },
    focus: { width: 3, point: 3, order: -1, alpha: null },    // lower order draws on top
    back: { width: 1, point: 1.25, order: 1, alpha: '38' },   // ~22% opacity: faded, never gone
};
/** Dataset style for a look: {borderColor, backgroundColor, borderWidth, pointRadius, order}. Pure. Alpha is never 0. */
export function lineLookStyle(look, base) {
    const L = LINE_LOOKS[look] || LINE_LOOKS.normal;
    const fade = (c) => (L.alpha && typeof c === 'string' && /^#[0-9a-f]{6}/i.test(c) ? c.slice(0, 7) + L.alpha : c);
    return { borderColor: fade(base.border), backgroundColor: fade(base.bg), borderWidth: L.width, pointRadius: L.point, order: L.order };
}
function applyLineFocus(chart, update = true) {
    const st = chart && chart.$lineFocus;
    if (!st || !chart.data) return;
    try {
        chart.data.datasets.forEach((ds, i) => {
            if (!ds.$lfBase) ds.$lfBase = { border: ds.borderColor, bg: ds.backgroundColor };
            Object.assign(ds, lineLookStyle(lineLook(st.ids[i], st.focused, st.hover), ds.$lfBase));
            ds.hidden = false;
        });
        if (update) chart.update('none');
    } catch { /* destroyed under us */ }
}
/** New focus set for a prefill chart, in place (no rebuild). */
export function setLineFocus(chart, focused) {
    if (!chart || !chart.$lineFocus) return;
    chart.$lineFocus.focused = new Set(focused || []);
    applyLineFocus(chart);
}
/** A desktop pointer over line `id` (a line or its legend entry), or null when it leaves: the focus set comes back. */
export function setLineHover(chart, id) {
    if (!chart || !chart.$lineFocus || chart.$lineFocus.hover === id) return;
    chart.$lineFocus.hover = id;
    applyLineFocus(chart);
}
// Hover emphasis is for a real mouse only: a phone fires Chart.js onHover on touchstart/touchmove, and compatibility
// mouse events after a tap.
const fineHover = () => { try { return typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches; } catch { return false; } };
const isTouch = (evt) => { const n = evt && evt.native; return !!(n && (n.pointerType === 'touch' || n.pointerType === 'pen' || /^touch/.test(n.type || ''))); };

// ---- line focus: the legend. An HTML legend under the prefill chart: one button per line (its swatch: hue + dash,
// and its name; the config is in its tooltip), a tap toggles that line's focus; "clear focus" when anything is focused; a filter box when there are
// more than 12 lines (it narrows the LIST, never the chart). Focused entries are marked, the others dimmed while
// anything is focused -- never struck through, nothing is hidden. Buttons are >= 32 px tall and wrap; the list scrolls
// inside its own box past ~6 rows. Re-rendered on every replot: handlers are assigned as properties, so a replot
// replaces them instead of stacking.
const FL_STYLE = `.fl-legend{margin-top:8px}
.fl-bar{display:flex;flex-wrap:wrap;align-items:center;gap:6px;margin-bottom:6px}
.fl-q{flex:1 1 150px;min-width:0;min-height:32px;font-size:16px;padding:3px 9px;border-radius:7px;background:var(--surface-2,#1b1e26);border:1px solid var(--border-strong,#363a47);color:var(--text-1,#eceef3)}
.fl-q::placeholder{color:var(--text-muted,#747b8c)}
.fl-count{font-size:11px;color:var(--text-muted,#747b8c)}
.fl-clear .chip{min-height:32px;justify-content:center}
.fl-clear[hidden]{display:none}
.fl-list{display:flex;flex-wrap:wrap;gap:4px;max-height:236px;overflow-y:auto;overscroll-behavior:contain}
.fl-item{display:inline-flex;align-items:center;gap:6px;min-height:32px;max-width:100%;padding:3px 9px;border-radius:7px;border:1px solid var(--border,#252832);background:transparent;color:var(--text-2,#b9bec9);font-size:11.5px;line-height:1.25;text-align:left;cursor:pointer;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
.fl-item[hidden]{display:none}
.fl-item .lp-sw{flex:none}
.fl-name{min-width:0;overflow-wrap:anywhere}
.fl-item.is-on{border-color:var(--accent,#7275f4);background:rgba(114,117,244,0.14);color:var(--text-1,#eceef3);font-weight:600}
.fl-legend.has-focus .fl-item:not(.is-on){opacity:.5}
.fl-item.is-hl .fl-name{color:var(--hl-gold,${HIGHLIGHT})}
.fl-empty{font-size:11.5px;color:var(--text-muted,#747b8c);padding:6px 4px}
@media (hover:hover) and (pointer:fine){.fl-item:hover{background:rgba(255,255,255,0.05)}.fl-legend.has-focus .fl-item:not(.is-on):hover{opacity:.8}}`;
function ensureFocusLegendStyle() {
    if (typeof document === 'undefined' || !document.head || document.getElementById('fl-style')) return;
    const st = document.createElement('style');
    st.id = 'fl-style';
    st.textContent = FL_STYLE;
    document.head.appendChild(st);
}
const swatchSvg = (color, dash) => `<svg class="lp-sw" width="22" height="12" viewBox="0 0 22 12" aria-hidden="true"><line x1="1" y1="6" x2="21" y2="6" stroke="${esc(color)}" stroke-width="2.5" stroke-linecap="round"${dash && dash.length ? ` stroke-dasharray="${dash.map(Number).join(' ')}"` : ''}/><circle cx="11" cy="6" r="2.6" fill="${esc(color)}"/></svg>`;
/**
 * el: the element the legend renders into. o.items: [{id, label, config, n, color, dash, row}] in chart order;
 * o.focused: Set of focused ids; o.onToggle(id): a tap on an entry; o.onClear(): "clear focus";
 * o.onHover(id | null): a desktop pointer entering / leaving an entry (never touch); o.status(nFocused, total): the
 * count text. Returns { set(focused), paintHl() } -- set() repaints the marks without re-rendering.
 */
export function focusLegend(el, o = {}) {
    if (!el) return { set() {}, paintHl() {} };
    ensureFocusLegendStyle();
    const items = o.items || [];
    let focused = new Set(o.focused || []);
    let q = '';
    const status = o.status || ((n, t) => (n ? `${n} of ${t} focused` : `${t} lines`));
    const search = items.length > 12;
    el.classList.add('fl-legend');
    el.innerHTML = `<div class="fl-bar">
        ${search ? `<input type="search" class="fl-q" placeholder="Find a line (${items.length})" aria-label="Find a line in the legend" autocomplete="off" spellcheck="false">` : ''}
        <span class="fl-count" data-fl-count aria-live="polite"></span>
        <span class="chip-group fl-clear" data-fl-clear-wrap hidden><button type="button" class="chip" data-fl-clear>clear focus</button></span>
      </div>
      <div class="fl-list" role="group" aria-label="Chart lines: tap to focus">${items.map((it) => {
        // the name only: a config string runs to three lines on a phone (the title, the tooltip and the "every config" labels carry it)
        const tip = `${it.label}${it.config ? ` · ${it.config}` : ''}${it.n ? ` · n=${Number(it.n).toLocaleString()}` : ''}`;
        return `<button type="button" class="fl-item" data-fl-id="${esc(it.id)}" aria-pressed="false" title="${esc(tip)}">${swatchSvg(it.color, it.dash)}<span class="fl-name">${esc(it.label)}</span></button>`;
    }).join('')}<div class="fl-empty" hidden>No line matches.</div></div>`;
    const btns = new Map([...el.querySelectorAll('[data-fl-id]')].map((b) => [b.dataset.flId, b]));
    const byId = new Map(items.map((it) => [it.id, it]));
    const paintHl = () => { for (const [id, b] of btns) b.classList.toggle('is-hl', isHl((byId.get(id) || {}).row)); };
    const paint = () => {
        for (const [id, b] of btns) { const on = focused.has(id); b.classList.toggle('is-on', on); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }
        const n = items.filter((it) => focused.has(it.id)).length;
        el.classList.toggle('has-focus', n > 0);
        const cnt = el.querySelector('[data-fl-count]'); if (cnt) cnt.textContent = status(n, items.length);
        const clr = el.querySelector('[data-fl-clear-wrap]'); if (clr) clr.hidden = n === 0;
    };
    const filter = () => {
        const ok = new Set(filterLines(items, q).map((i) => items[i].id));
        for (const [id, b] of btns) b.hidden = !ok.has(id);
        const empty = el.querySelector('.fl-empty'); if (empty) empty.hidden = ok.size > 0;
    };
    el.onclick = (e) => {
        const t = e.target && e.target.closest ? e.target.closest('button') : null;
        if (!t) return;
        if (t.dataset.flClear != null) { if (o.onClear) o.onClear(); return; }
        if (t.dataset.flId != null && o.onToggle) o.onToggle(t.dataset.flId);
    };
    el.oninput = (e) => { if (e.target && e.target.classList && e.target.classList.contains('fl-q')) { q = e.target.value; filter(); } };
    // hover: a mouse only (pointerType), so a tap never leaves a line emphasised
    el.onpointerover = (e) => {
        if (!o.onHover || e.pointerType !== 'mouse' || !fineHover()) return;
        const t = e.target && e.target.closest ? e.target.closest('[data-fl-id]') : null;
        o.onHover(t ? t.dataset.flId : null);
    };
    el.onpointerleave = (e) => { if (o.onHover && e.pointerType === 'mouse') o.onHover(null); };
    paint(); filter(); paintHl();
    return { set(next) { focused = new Set(next || []); paint(); }, paintHl };
}

// ---- install window only: the names the PRE-FOCUS ui/models/index.js imports from this module, so a page load between
// saving this file and saving the new index.js still loads. Neither hides anything. Delete once the new index.js is live.
export function applyLineVisibility() { /* retired: lines are never hidden */ }
export function linePicker() { return { set() {} }; }

/**
 * The cost/quality frontier: solve rate vs output tokens per solve. One point per entity.
 * Every point is directly labelled -- eight scatter points cannot clear the CVD floor on
 * colour alone, so the label carries identity and the colour only reinforces it.
 */
// Twenty distinct hues. SERIES is eight on purpose (past eight, a line chart's colours stop
// being tellable apart), but a scatter identifies points by LABEL and uses colour only to
// reinforce -- so running out and painting eleven of nineteen models the same grey, as this
// chart did, loses information for no benefit.
// Ordered so the FIRST EIGHT are maximally separated -- the old order gave the prefill chart
// three reds (#d95926, #d55181, #e66767) and two greens (#199e70, #008300) in its first six
// slots, which is unreadable on a line chart where colour is the only identity.
const POINT_HUES = [
    // slots 5 and 7 re-stepped (2026-10-01) into the dark lightness band against the #14161c card;
    // the first eight pass validate_palette.js --mode dark (worst adjacent CVD dE 8.8).
    '#3987e5', '#e6693a', '#19a974', '#c026d3', '#c98500', '#7c3aed', '#0e9cbb', '#dc2626',
    '#0284c7', '#b45309', '#059669', '#db2777', '#4f46e5', '#65a30d', '#0891b2', '#e11d48',
    '#a16207', '#2563eb', '#16a34a', '#9333ea',
];
const hueFor = (i) => POINT_HUES[i % POINT_HUES.length];
/** Line i's identity on the prefill chart: its hue, and its dash once the hues run out. The legend's swatches use it. */
export function lineStyle(i) {
    return { color: hueFor(i), dash: [[], [6, 3], [2, 3]][Math.floor(i / POINT_HUES.length) % 3] };
}

// points: {x, solveRate, ...}; opts.xLabel names the axis, opts.fmtX formats a value, opts.log
// picks a log axis (tokens span decades; a relative-time ratio is plotted on log too, 1x in the middle).
export function solveRateVsCost(canvasId, points, onPick, opts = {}) {
    const o = { xLabel: 'tokens per solve', fmtX: (v) => `${Math.round(v).toLocaleString()} tok/solve`, log: true, ...opts };
    // 95% interval as a vertical whisker through each point: a 3-task point must not look as
    // settled as a 101-task one.
    const whiskers = {
        id: 'ciWhiskers',
        beforeDatasetsDraw(chart) {
            const { ctx, scales: { y } } = chart;
            ctx.save(); ctx.lineWidth = 1.2;
            chart.data.datasets.forEach((ds, di) => {
                const meta = chart.getDatasetMeta(di);
                meta.data.forEach((pt, i) => {
                    const p = ds.data[i];
                    if (!p || p.lo == null || p.hi == null || p.x == null) return;
                    const y1 = y.getPixelForValue(p.lo), y2 = y.getPixelForValue(p.hi);
                    ctx.strokeStyle = ds.$hue || (ds.$base && ds.$base.border) || ds.borderColor || '#94a3b8'; ctx.globalAlpha = focusAlpha(chart, di, ds.$dominated ? 0.3 : 0.55);
                    ctx.beginPath(); ctx.moveTo(pt.x, y1); ctx.lineTo(pt.x, y2);
                    ctx.moveTo(pt.x - 3, y1); ctx.lineTo(pt.x + 3, y1); ctx.moveTo(pt.x - 3, y2); ctx.lineTo(pt.x + 3, y2);
                    ctx.stroke();
                });
            });
            ctx.restore();
        },
    };
    const labelPlugin = {
        id: 'pointLabels',
        // Nineteen labels in a band between 60% and 90% overlapped into an unreadable smear.
        // Draw them in order and skip any that would land on one already drawn; what is skipped
        // is still on the point's tooltip, so nothing is lost but the pile-up.
        afterDatasetsDraw(chart) {
            const { ctx } = chart;
            ctx.save();
            ctx.textBaseline = 'middle';
            const taken = [];
            chart.$labelRects = [];
            const clear = (x, y, w, h) => !taken.some((r) => x < r.x + r.w && x + w > r.x && y < r.y + r.h && y + h > r.y);
            // the focused point is labelled first, so it always gets a slot; then the frontier, then the rest
            const order = chart.data.datasets.map((_, di) => di);
            // (a highlighted model is named before the rest too: a skipped label would hide the very model searched for)
            const hit = chart.data.datasets.map((ds) => isHl(ds.$row));
            // ... and no name may sit on a gold ring (its own name starts clear of it, below)
            hit.forEach((on, di) => { const pt = on && chart.getDatasetMeta(di).data[0]; if (pt) taken.push({ x: pt.x - 13, y: pt.y - 13, w: 26, h: 26 }); });
            order.sort((a, b) => ((b === chart.$focus) - (a === chart.$focus)) || (hit[b] - hit[a])
                || (!chart.data.datasets[a].$dominated - !chart.data.datasets[b].$dominated) * -1);
            order.forEach((di) => {
                const ds = chart.data.datasets[di];
                const meta = chart.getDatasetMeta(di);
                meta.data.forEach((pt, i) => {
                    const p = ds.data[i];
                    if (!p || p.x == null) return;
                    const text = ` ${ds.label}`;
                    ctx.font = `${ds.$dominated && !hit[di] ? 400 : 600} ${ds.$dominated && !hit[di] ? 10.5 : 11.5}px ${SANS}`;
                    const w = ctx.measureText(text).width, h = 13;
                    // right of the point first, then left, then give up and let the tooltip carry it
                    // (a highlighted point's name starts clear of its gold ring, and before giving up it tries a line
                    // or two above and below, joined to the ring by a thin gold leader)
                    const dx = hit[di] ? 14 : 6;
                    const slots = [[pt.x + dx, pt.y - 6], [pt.x - dx - w, pt.y - 6], [pt.x + dx, pt.y + 6], [pt.x - dx - w, pt.y + 6]];
                    if (hit[di]) for (const dy of [-22, 16, -36, 30, -50, 44]) slots.push([pt.x + dx, pt.y + dy, true], [pt.x - dx - w, pt.y + dy, true]);
                    for (const [x, y, far] of slots) {
                        if (!clear(x, y, w, h) || (hit[di] && (x < 2 || x + w > chart.width - 2))) continue;   // a highlighted name is never cut off by the canvas edge
                        taken.push({ x, y, w, h }); chart.$labelRects.push({ x, y, w, h, di });
                        if (far) {
                            ctx.save(); ctx.strokeStyle = GOLD; ctx.lineWidth = 1; ctx.globalAlpha = 0.7;
                            ctx.beginPath(); ctx.moveTo(pt.x, pt.y + (y < pt.y ? -12 : 12)); ctx.lineTo(x > pt.x ? x + 2 : x + w, y + h / 2); ctx.stroke(); ctx.restore();
                        }
                        ctx.fillStyle = hit[di] ? GOLD : ds.$dominated && chart.$focus !== di ? '#747b8c' : (ds.$hue || (ds.$base && ds.$base.border) || ds.borderColor || '#cbd5e1');
                        ctx.globalAlpha = hit[di] ? 1 : focusAlpha(chart, di);
                        ctx.fillText(text, x, y + h / 2);
                        ctx.globalAlpha = 1;
                        return;
                    }
                });
            });
            ctx.restore();
        },
    };
    // Pareto frontier (opts.pareto, 2026-10-01): a point is DOMINATED when another is at least as
    // cheap and at least as strong (and strictly better on one). The non-dominated points are joined
    // by a staircase -- for any cost budget, the strongest model you can have -- and the dominated
    // ones are drawn faded, smaller and labelled in grey, so the eye lands on the real choices.
    const valid = points.filter((p) => p.x != null && p.solveRate != null);
    const dominated = new Set(o.pareto ? valid.filter((p) => valid.some((q) => q !== p && q.x <= p.x && q.solveRate >= p.solveRate
        && (q.x < p.x || q.solveRate > p.solveRate))).map((p) => p.key) : []);
    const frontier = o.pareto ? valid.filter((p) => !dominated.has(p.key)).sort((a, b) => a.x - b.x) : [];
    const SURFACE = '#14161c';
    const datasets = points.map((p, i) => {
        const dom = dominated.has(p.key);
        const hue = hueFor(i);
        return {
            label: p.label, $hue: hue, $dominated: dom, $trail: p.trail || null, $row: p,
            data: [{ x: p.x, y: p.solveRate, lo: p.lo, hi: p.hi, key: p.key, n: p.n, attempted: p.attempted, total: p.total }],
            // a surface-coloured ring separates overlapping points; identity lives in the fill
            backgroundColor: dom ? hue + '73' : hue, borderColor: SURFACE, borderWidth: 2,
            // Cloud and local are told apart by shape as well as hue, so the distinction survives
            // a monochrome screenshot and colour-vision differences.
            pointStyle: p.provider === 'cloud' ? 'rectRot' : 'circle',
            pointRadius: dom ? 5.5 : 8, pointHoverRadius: dom ? 8 : 11,
        };
    });
    // Staircase + shaded dominated region, under the points.
    const paretoPlugin = {
        id: 'paretoStair',
        beforeDatasetsDraw(chart) {
            if (frontier.length < 1) return;
            const { ctx, chartArea: a, scales: { x, y } } = chart;
            const pts = frontier.map((p) => [x.getPixelForValue(p.x), y.getPixelForValue(p.solveRate)]);
            ctx.save();
            ctx.beginPath(); ctx.rect(a.left, a.top, a.right - a.left, a.bottom - a.top); ctx.clip();
            const path = new Path2D();
            path.moveTo(pts[0][0], pts[0][1]);
            for (let k = 1; k < pts.length; k++) { path.lineTo(pts[k][0], pts[k - 1][1]); path.lineTo(pts[k][0], pts[k][1]); }
            path.lineTo(a.right, pts[pts.length - 1][1]);
            const region = new Path2D(path);
            region.lineTo(a.right, a.bottom); region.lineTo(pts[0][0], a.bottom); region.closePath();
            const grad = ctx.createLinearGradient(0, a.top, 0, a.bottom);
            grad.addColorStop(0, 'rgba(140,145,253,0.09)'); grad.addColorStop(1, 'rgba(140,145,253,0.0)');
            ctx.fillStyle = grad; ctx.fill(region);
            ctx.strokeStyle = 'rgba(166,172,255,0.75)'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]);
            ctx.globalAlpha = chart.$focus == null ? 1 : 0.4;
            ctx.stroke(path);
            ctx.restore();
        },
    };
    // Config trails: thin spokes from a model's point to each of its other configs (small hollow
    // dots), labelled with what differs when the model is focused.
    const trailPlugin = {
        id: 'configTrails',
        beforeDatasetsDraw(chart) {
            const { ctx, chartArea: a, scales: { x, y } } = chart;
            ctx.save();
            ctx.beginPath(); ctx.rect(a.left, a.top, a.right - a.left, a.bottom - a.top); ctx.clip();
            chart.data.datasets.forEach((ds, di) => {
                if (!ds.$trail || chart.getDatasetMeta(di).hidden) return;
                const p = ds.data[0];
                if (!p || p.x == null) return;
                const focused = chart.$focus === di;
                if (!o.trails && !focused) return;            // trails off: only the hovered model's
                const cx = x.getPixelForValue(p.x), cy = y.getPixelForValue(p.y);
                ctx.globalAlpha = chart.$focus == null ? (ds.$dominated ? 0.28 : 0.5) : focused ? 0.95 : 0.06;
                ctx.strokeStyle = ds.$hue; ctx.fillStyle = SURFACE; ctx.lineWidth = focused ? 1.4 : 1;
                for (const t of ds.$trail) {
                    const tx = x.getPixelForValue(t.x), ty = y.getPixelForValue(t.y);
                    ctx.setLineDash([2, 2]);
                    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(tx, ty); ctx.stroke();
                    ctx.setLineDash([]);
                    ctx.beginPath(); ctx.arc(tx, ty, focused ? 4 : 3, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
                    if (focused && t.label) {
                        ctx.font = `10.5px ${SANS}`; ctx.fillStyle = '#b9bec9'; ctx.textBaseline = 'middle';
                        ctx.fillText(t.label, tx + 7, ty); ctx.fillStyle = SURFACE;
                    }
                }
            });
            ctx.restore();
        },
    };
    // Search highlight: a gold ring around a matching model's point, at full strength whatever is hovered or
    // dominated. Drawn by hand, not as the point's border: setFocus() owns the datasets' own colours.
    const ringPlugin = {
        id: 'hlRings',
        afterDatasetsDraw(chart) {
            if (!hlTest) return;
            const { ctx, chartArea: a } = chart;
            ctx.save(); ctx.strokeStyle = GOLD; ctx.lineWidth = 2;
            chart.data.datasets.forEach((ds, di) => {
                const pt = chart.getDatasetMeta(di).data[0];
                if (!pt || !isHl(ds.$row) || !ds.data[0] || ds.data[0].x == null) return;
                if (pt.x < a.left || pt.x > a.right || pt.y < a.top || pt.y > a.bottom) return;   // panned out of view
                hlRing(ctx, pt.x, pt.y, ds.$dominated ? 5.5 : 8);
            });
            ctx.restore();
        },
    };
    // Fit the y range to the data (whiskers and trails included) instead of 0-100%: every model sits
    // between ~30 and ~85, and the empty bottom half was most of the chart.
    const ys = [];
    for (const p of valid) { ys.push(p.lo != null ? p.lo : p.solveRate, p.hi != null ? p.hi : p.solveRate); for (const t of (p.trail || [])) ys.push(t.y); }
    const yMin = ys.length ? Math.max(0, Math.floor((Math.min(...ys) - 0.04) * 20) / 20) : 0;
    const yMax = ys.length ? Math.min(1, Math.ceil((Math.max(...ys) + 0.04) * 20) / 20) : 1;
    const c = mount(canvasId, {
        type: 'scatter',
        data: { datasets },
        options: {
            ...baseOpts('output tokens per solved task (log) — cheaper is left', 'solve rate over scored tasks', {
                x: { type: o.log ? 'logarithmic' : 'linear', title: { display: true, text: o.xLabel, color: TICK, font: { size: 11 } }, ticks: { color: TICK, font: { size: 10.5 }, callback: (v) => (o.tick ? o.tick(v) : Number(v).toLocaleString()) }, border: { display: false } },
                y: { min: o.pareto ? yMin : undefined, max: o.pareto ? yMax : 1, beginAtZero: !o.pareto, title: { display: !!o.yLabel, text: o.yLabel || '', color: TICK, font: { size: 11 } }, ticks: { color: TICK, font: { size: 10.5 }, callback: (v) => (o.pareto ? `${Math.round(v * 100)}` : `${Math.round(v * 100)}%`) }, border: { display: false } },
                tooltip: { callbacks: { label: (x) => `${x.dataset.label}: ${(x.parsed.y * 100).toFixed(0)}% over ${x.raw.n} scored, ${Math.round(x.parsed.x).toLocaleString()} tok/solve (attempted ${x.raw.attempted}/${x.raw.total ?? '?'})` } },
            }),
            interaction: { mode: 'nearest', intersect: true },   // tooltip only ON a point (2026-10-01, Kyle)
            // xNote (2026-10-22): how the point's cost was had, e.g. a time estimated at the row's fastest speed config
            plugins: { legend: { display: false }, tooltip: { ...TIP, displayColors: false, callbacks: { label: (x) => {
                const line = `${x.dataset.label}: ${(x.parsed.y * 100).toFixed(0)}% over ${x.raw.n} scored, ${o.fmtX(x.parsed.x)} (attempted ${x.raw.attempted}/${x.raw.total ?? '?'})`;
                const note = x.dataset.$row && x.dataset.$row.xNote;
                return note ? [line, note] : line;
            } } } },
            onClick: (evt, els) => {
                if (!onPick || !els.length) return;
                const d = c && c.data.datasets[els[0].datasetIndex];
                if (d && d.data[0] && d.data[0].key) onPick(d.data[0].key, evt.native);
            },
            // Hovering a dot (on it, not merely nearest) or its name label focuses that model.
            onHover: (evt, _els, chart) => {
                if (evt.type === 'mouseout') return setFocus(chart, null);
                const on = chart.getElementsAtEventForMode(evt, 'nearest', { intersect: true }, false);
                const lab = (chart.$labelRects || []).find((r) => evt.x >= r.x && evt.x <= r.x + r.w && evt.y >= r.y && evt.y <= r.y + r.h);
                setFocus(chart, on.length ? on[0].datasetIndex : lab ? lab.di : null);
            },
        },
        plugins: [paretoPlugin, trailPlugin, whiskers, ringPlugin, labelPlugin],
    });
    if (c) { panZoom(c); oneReadout(c); }
    return c;
}

/**
 * The quality ladder: every model is a point, joined bottom to top by a rail, on two PROPORTIONAL
 * axes, so both the rise and the lean of every step are to scale.
 *
 *   order 'quality'  y = the rate (linear %; robust or difficulty-weighted, whichever the caller
 *                    passes), x = cost (log). Rungs join worst to best; the 95% interval is a
 *                    vertical bar through each point. A rail leans right when a step up costs more.
 *   order 'cost'     x = the rate, y = cost (log, reversed: costliest at the bottom, so climbing is
 *                    getting faster). Rungs join costliest to cheapest; the interval is horizontal.
 *
 * Each model's name (and its rate, or its cost in the speed view) is written beside its point. Many
 * rungs sit within a point or two of each other, so names go through a small collision pass: each
 * takes the first free slot beside its point (right, else left), nudged up or down a line at a time,
 * with a thin leader line back to the point when it had to move; names are placed best rung first.
 * Every label is clamped inside the plot, so the top and bottom rungs are always named.
 *
 * Each step's numbers (ladderStepText().compact: "+5.0% · 1.94× time", "free · …", "· noise") go
 * beside the middle of its rail, but only where they fit without covering a name, a point or another
 * step label; the rest are left off (hover or tap a point for its step; the table lists every one).
 * On a narrow plot (a phone) they are all left off. Colour is what the step costs (amber paid, green
 * free), a dashed rail is a step whose two 95% intervals overlap. Prices are head to head
 * (ladderSteps); a rung's position is its own index, so a rail can lean against its label, and the
 * label is right.
 *
 * rungs: ladderSteps() output, bottom first, points {key, label, x (cost), y (rate), lo, hi, step}.
 * opts: order ('quality' | 'cost'), costWord ('time' | 'tokens'), fmtX (a cost), tick (a cost
 * axis tick), xLabel (the cost axis), rateLabel (the rate axis).
 */
export function qualityLadder(canvasId, rungs, onPick, opts = {}) {
    const o = { order: 'quality', costWord: 'time', fmtX: (v) => String(v), ...opts };
    const byCost = o.order === 'cost';
    const RUNG = '#818cf8', PAID = '#fcd34d', FREE = '#86efac', NAME = '#d9dce4';
    const HALO = 'rgba(20,22,28,0.82)';   // the card's own background, so a label reads over rails and bars
    const pct = (v) => `${Math.round(v * 100)}%`;
    // "vs #k" by rank from the top, matching the step table under the chart (ui/models/index.js paintLadder)
    const words = (s, short) => ladderStepText(s, { order: o.order, costWord: o.costWord, short, rank: (st) => `#${rungs.length - st.vsIndex}` });
    const tone = (s) => (s.free ? FREE : PAID);
    const NAME_FONT = '10px ui-sans-serif, system-ui, sans-serif', STEP_FONT = '9px ui-sans-serif, system-ui, sans-serif';
    const LINE = 12;
    // chart coordinates of a rung: the rate is y in the quality view, x in the speed view
    const data = rungs.map((p, i) => ({ x: byCost ? p.y : p.x, y: byCost ? p.x : p.y, i, key: p.key, label: p.label,
        rate: p.y, cost: p.x, lo: p.lo, hi: p.hi, step: p.step, n: p.n, $row: p }));
    const hit = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    const inside = (bx, A) => bx.x >= A.left && bx.x + bx.w <= A.right && bx.y >= A.top && bx.y + bx.h <= A.bottom;
    const ladder = {
        id: 'ladderRails',
        beforeDatasetsDraw(chart) {
            const { ctx, scales: { x, y } } = chart;
            const meta = chart.getDatasetMeta(0).data;
            ctx.save();
            // the 95% interval of the rate, along the rate axis
            ctx.lineWidth = 1; ctx.strokeStyle = RUNG; ctx.globalAlpha = 0.3;
            data.forEach((p, i) => {
                const m = meta[i];
                if (!m || p.lo == null || p.hi == null) return;
                ctx.beginPath();
                if (byCost) {
                    const x1 = x.getPixelForValue(p.lo), x2 = x.getPixelForValue(p.hi);
                    ctx.moveTo(x1, m.y); ctx.lineTo(x2, m.y); ctx.moveTo(x1, m.y - 3); ctx.lineTo(x1, m.y + 3); ctx.moveTo(x2, m.y - 3); ctx.lineTo(x2, m.y + 3);
                } else {
                    const y1 = y.getPixelForValue(p.lo), y2 = y.getPixelForValue(p.hi);
                    ctx.moveTo(m.x, y1); ctx.lineTo(m.x, y2); ctx.moveTo(m.x - 3, y1); ctx.lineTo(m.x + 3, y1); ctx.moveTo(m.x - 3, y2); ctx.lineTo(m.x + 3, y2);
                }
                ctx.stroke();
            });
            ctx.globalAlpha = 1; ctx.lineWidth = 2;
            for (let i = 1; i < data.length; i++) {
                const a = meta[i - 1], b = meta[i], s = data[i].step;
                if (!a || !b || !s) continue;
                ctx.strokeStyle = tone(s); ctx.setLineDash(s.noise ? [4, 3] : []);
                ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
            }
            ctx.restore();
        },
        afterDatasetsDraw(chart) {
            const { ctx, chartArea: A } = chart;
            const meta = chart.getDatasetMeta(0).data;
            const narrow = A.right - A.left < 360;
            const pw = A.right - A.left, maxName = pw < 300 ? 16 : pw < 500 ? 26 : 38;
            // too long: shorten the family, keep the quant (the last word), which is what tells rungs apart
            const shorten = (t) => {
                if (t.length <= maxName) return t;
                const cut = t.lastIndexOf(' '), tail = cut > 0 ? t.slice(cut) : '';
                return tail && tail.length < maxName - 4 ? t.slice(0, maxName - tail.length - 1) + '…' + tail : t.slice(0, maxName - 1) + '…';
            };
            const dots = meta.map((m) => ({ x: m.x - 5, y: m.y - 5, w: 10, h: 10 }));
            const placed = [], boxes = [];
            ctx.save(); ctx.textBaseline = 'middle';
            // search highlight: a gold ring around the rung's point, and (below) a gold box around its gold name --
            // the box because a paid step's label is amber text too
            ctx.strokeStyle = GOLD; ctx.lineWidth = 2;
            data.forEach((p, i) => { const m = meta[i]; if (m && isHl(p.$row) && m.x >= A.left && m.x <= A.right && m.y >= A.top && m.y <= A.bottom) hlRing(ctx, m.x, m.y, 5); });
            // names, best rung first: the first free slot beside the point, nudged a line at a time
            ctx.font = NAME_FONT;
            for (let i = data.length - 1; i >= 0; i--) {
                const p = data[i], m = meta[i];
                if (!m) continue;
                const name = shorten(p.label);
                const text = `${name} ${byCost ? (o.tick ? o.tick(p.cost) : o.fmtX(p.cost)) : pct(p.rate)}`;
                const w = ctx.measureText(text).width + 2, h = LINE;
                const sides = m.x + 8 + w <= A.right ? ['r', 'l'] : ['l', 'r'];
                let best = null;
                for (let k = 0; k <= 12 && !best; k++) {
                    for (const dy of k ? [k, -k] : [0]) {
                        for (const side of sides) {
                            const bx = { x: side === 'r' ? m.x + 8 : m.x - 8 - w, y: m.y - h / 2 + dy * (h + 1), w, h };
                            if (!inside(bx, A) || placed.some((q) => hit(bx, q)) || dots.some((d, j) => j !== i && hit(bx, d))) continue;
                            best = { ...bx, side, moved: dy !== 0 }; break;
                        }
                        if (best) break;
                    }
                }
                if (!best) {   // nowhere free: clamp beside the point, inside the plot, and accept the overlap
                    const bx = { x: sides[0] === 'r' ? m.x + 8 : m.x - 8 - w, y: m.y - h / 2, w, h };
                    bx.x = Math.min(Math.max(bx.x, A.left), A.right - w); bx.y = Math.min(Math.max(bx.y, A.top), A.bottom - h);
                    best = { ...bx, side: sides[0], moved: false };
                }
                if (best.moved) {
                    ctx.strokeStyle = 'rgba(203,213,225,0.45)'; ctx.lineWidth = 1; ctx.setLineDash([]);
                    const ex = best.side === 'r' ? best.x : best.x + best.w;
                    ctx.beginPath(); ctx.moveTo(m.x + (best.side === 'r' ? 5 : -5), m.y); ctx.lineTo(ex, best.y + h / 2); ctx.stroke();
                }
                const gold = isHl(p.$row);
                ctx.fillStyle = HALO; ctx.fillRect(best.x, best.y, best.w, best.h);
                if (gold) { ctx.strokeStyle = GOLD; ctx.lineWidth = 1; ctx.setLineDash([]); ctx.strokeRect(best.x - 1.5, best.y - 0.5, best.w + 3, best.h + 1); }
                ctx.fillStyle = gold ? GOLD : NAME; ctx.fillText(text, best.x + 1, best.y + h / 2);
                placed.push(best); boxes.push({ ...best, key: p.key });
            }
            // step labels beside the middle of each rail, only where they cover nothing
            if (!narrow) {
                ctx.font = STEP_FONT;
                for (let i = 1; i < data.length; i++) {
                    const a = meta[i - 1], b = meta[i], s = data[i].step;
                    if (!a || !b || !s) continue;
                    const text = words(s, true).compact;
                    const w = ctx.measureText(text).width + 2, h = 11;
                    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
                    let at = null;
                    for (const dy of [0, 0.5, -0.5, 1, -1]) {
                        for (const bx0 of [mx + 6, mx - 6 - w]) {
                            const bx = { x: bx0, y: my - h / 2 + dy * h, w, h };
                            if (!inside(bx, A) || placed.some((q) => hit(bx, q)) || dots.some((d) => hit(bx, d))) continue;
                            at = bx; break;
                        }
                        if (at) break;
                    }
                    if (!at) continue;
                    ctx.fillStyle = HALO; ctx.fillRect(at.x, at.y, at.w, at.h);
                    ctx.fillStyle = tone(s); ctx.fillText(text, at.x + 1, at.y + h / 2);
                    placed.push(at);
                }
            }
            ctx.restore();
            chart.$ladderNames = boxes;   // for taps on a name
        },
    };
    const rates = rungs.flatMap((p) => [p.y, p.lo, p.hi]).filter((v) => v != null);
    const rateMin = rates.length ? Math.max(0, Math.floor((Math.min(...rates) - 0.02) * 20) / 20) : 0;
    const rateMax = rates.length ? Math.min(1, Math.ceil((Math.max(...rates) + 0.02) * 20) / 20) : 1;
    const costs = rungs.map((p) => p.x).filter((v) => v > 0);
    const costMin = costs.length ? Math.min(...costs) / 1.3 : undefined, costMax = costs.length ? Math.max(...costs) * 1.3 : undefined;
    const rateAxis = { min: rateMin, max: rateMax, title: { display: true, text: o.rateLabel || 'strength /100 (95% range)', color: TITLE, font: { size: 10 } },
        ticks: { color: TICK, font: { size: 10 }, callback: (v) => pct(v) }, grid: { color: GRID } };
    // 1-2-5 ticks only: every minor tick of a log axis labelled piled up at 0.08-0.10×
    const costAxis = { type: 'logarithmic', min: costMin, max: costMax, reverse: byCost,
        title: { display: true, text: byCost ? (o.xLabel || '').replace(' — left is faster', ' — up is faster').replace(' — left is cheaper', ' — up is cheaper') : o.xLabel, color: TITLE, font: { size: 10 } },
        grid: { color: GRID },
        ticks: { color: TICK, font: { size: 10 }, autoSkip: false, callback: (v) => {
            const m = Number(v) / 10 ** Math.floor(Math.log10(Number(v)) + 1e-9);
            return [1, 2, 5].some((k) => Math.abs(m - k) < 1e-6) ? (o.tick ? o.tick(v) : Number(v).toLocaleString()) : '';
        } } };
    let c = null;
    const pick = (i, evt) => { const d = data[i]; if (onPick && d && d.key) onPick(d.key, evt); };
    c = mount(canvasId, {
        type: 'scatter',
        data: { datasets: [{ label: 'rung', data, backgroundColor: RUNG, borderColor: RUNG, pointRadius: 5, pointHoverRadius: 8, pointHitRadius: 8 }] },
        options: {
            responsive: true, maintainAspectRatio: false, animation: false,
            layout: { padding: { top: 6, right: 6 } },
            interaction: { mode: 'nearest', intersect: true },   // a tooltip only when ON a point (2026-10-01, Kyle: they covered the chart)
            scales: byCost ? { x: rateAxis, y: costAxis } : { x: costAxis, y: rateAxis },
            plugins: {
                legend: { display: false },
                tooltip: { ...TIP, displayColors: false,
                    callbacks: {
                        title: (items) => `${items[0].raw.i + 1}. ${items[0].raw.label}`,
                        label: (t) => {
                            const r = t.raw;
                            const out = [`${pct(r.rate)}${r.lo != null ? ` [${pct(r.lo)}–${pct(r.hi)}]` : ''} · ${o.fmtX(r.cost)}`];
                            if (r.step) { const w = words(r.step); out.push(`step up: ${w.headline}`, `  ${w.detail}`); } else out.push('bottom rung');
                            if (r.$row && r.$row.xNote) out.push(r.$row.xNote);
                            return out;
                        },
                    } },
            },
        },
        plugins: [ladder],
    });
    if (c) { panZoom(c); oneReadout(c); }
    // one tap handler: a name opens its model, so does a point; anywhere else only moves the tooltip
    if (c && onPick) {
        c.canvas.onclick = (e) => {
            const r = c.canvas.getBoundingClientRect();
            const x = e.clientX - r.left, y = e.clientY - r.top;
            const nm = (c.$ladderNames || []).find((b) => x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h);
            if (nm) { onPick(nm.key, e); return; }
            const els = c.getElementsAtEventForMode(e, 'nearest', { intersect: true }, false);
            if (els.length) pick(els[0].index, e);
        };
    }
    return c;
}

/**
 * Per-model task grid: one row per model, one small box per task, boxes in the SAME order on
 * every row so the shape is comparable down the column.
 *
 * Why a grid rather than more columns: a per-task column layout needs a header per task and
 * stops fitting somewhere around eight. A row of boxes carries the same information at any task
 * count, and the thing the eye reads is the shape -- where the green stops -- not any single box.
 *
 * Tasks are ordered EASIEST FIRST (most models solved it), so every row fills from the left and
 * the ragged edge is the frontier of what that model could do. A model that is green past where
 * others have gone red is doing something the rest cannot, and that is visible without reading a
 * number. Sorting of the ROWS is the caller's business; this only fixes the columns.
 *
 * Implemented as a stacked bar of equal 1-unit segments so it stays on the canvas with Chart.js
 * tooltips and hit-testing, rather than a wall of divs.
 */
// opts.order: the task order to draw (left to right). When absent, tasks are ordered by the
// Wilson upper bound of how many rows solved them, easiest left.
// opts.onCell(taskId, row, event, {cell, counts}): a click inside the plot picks a CELL (its column
// is the task); the row-label strip still calls onPick with the row's key.

// A tap on a row LABEL (left of the plot) picks that row too -- on a phone the label is the natural
// target, and Chart.js 4 calls onClick only for clicks inside the plot area. A plain listener on the
// canvas covers the label strip; `onclick =` (not addEventListener) so a re-render replaces it.
// onCell(column, rowIndex, event), when given, takes clicks INSIDE the plot too, mapped by pixel
// rather than by Chart.js's hit test: at phone width a grid cell is a few px wide and a tap that
// lands a hair outside every bar would otherwise do nothing.
// Hover-and-hold on a row LABEL (left of the plot) for LABEL_HOVER_MS -> onHover(row, event, idx);
// leaving the label, or moving to another row, cancels it and calls onLeave (Kyle, 2026-09-29: the
// task grid's labels open the row's config detail, like clicking a frontier point does).
const LABEL_HOVER_MS = 800;
function hoverLabel(chart, rows, onHover, onLeave) {
    if (!chart || !onHover) return chart;
    let timer = null, cur = -1;
    const cancel = () => { if (timer) { clearTimeout(timer); timer = null; } if (cur >= 0 && onLeave) onLeave(); cur = -1; };
    chart.canvas.onmousemove = (e) => {
        const r = chart.canvas.getBoundingClientRect();
        const x = e.clientX - r.left, y = e.clientY - r.top, a = chart.chartArea;
        const v = x < a.left && y >= a.top && y <= a.bottom ? chart.scales.y.getValueForPixel(y) : null;
        const idx = v == null ? -1 : Math.round(v);
        if (idx < 0 || idx >= rows.length || !rows[idx]) { cancel(); return; }
        if (idx === cur) return;
        cancel(); cur = idx;
        const ev = { clientX: e.clientX, clientY: e.clientY };
        timer = setTimeout(() => { timer = null; onHover(rows[idx], ev, idx); }, LABEL_HOVER_MS);
    };
    chart.canvas.onmouseleave = cancel;
    return chart;
}
// One readout at a time (2026-10-01): charts whose click opens a detail card also had Chart.js's hover
// tooltip, so a tap on a phone showed BOTH for the same cell. The tooltip is a mouse-hover affordance:
// touch/pen input turns it off (a tap's emulated mousemove would otherwise raise it), and while a detail
// card is open it stays off for the mouse too; mouse movement with no card open turns it back on.
// chart.tooltip keeps a RESOLVED copy of its options, so a flip needs update('none') to take effect --
// done only when the state actually changes.
const cardOpen = () => !!document.querySelector('.lb-pop:not(.hidden)');
function oneReadout(chart) {
    if (!chart || !chart.canvas || chart.canvas.__oneReadout) return chart;
    const cv = chart.canvas;
    cv.__oneReadout = true;
    const setTip = (on) => {
        const c = window.Chart && window.Chart.getChart(cv);   // none on the Solve map's canvas: its readout is its own (gridCanvas)
        if (!c || !c.options.plugins || !c.options.plugins.tooltip) return;
        if (c.options.plugins.tooltip.enabled === on && c.tooltip && c.tooltip.options.enabled === on) return;
        c.options.plugins.tooltip.enabled = on;
        if (!on && c.tooltip) c.tooltip.setActiveElements([], { x: 0, y: 0 });
        c.update('none');
    };
    cv.addEventListener('pointerdown', (e) => { if (e.pointerType !== 'mouse') setTip(false); }, true);
    cv.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') setTip(!cardOpen()); });
    // after the click's own handlers have opened (or not) a card
    cv.addEventListener('click', () => setTimeout(() => { if (cardOpen()) setTip(false); }, 0));
    return chart;
}
function pickByLabel(chart, rows, onPick, onCell) {
    if (!chart || (!onPick && !onCell)) return chart;
    oneReadout(chart);
    chart.canvas.onclick = (e) => {
        const r = chart.canvas.getBoundingClientRect();
        const x = e.clientX - r.left, y = e.clientY - r.top;
        const a = chart.chartArea;
        if (x >= a.left && !onCell) return;                  // plot clicks go through Chart.js
        const v = chart.scales.y.getValueForPixel(y);
        const idx = v == null ? null : Math.round(v);
        if (idx == null || idx < 0 || idx >= rows.length || !rows[idx]) return;
        if (x < a.left) { if (onPick) onPick(rows[idx].key, e); return; }
        if (x > a.right || y < a.top || y > a.bottom) return;
        const col = Math.floor(chart.scales.x.getValueForPixel(x));
        if (Number.isFinite(col)) onCell(col, idx, e);
    };
    return chart;
}

/** "pass — passed after the original prompt was re-sent (stopped early at 13 min 32 s: no tool call)" (lib/models.js
 *  resentPass: display only, the score is the run's own). `t.resent` = {n, at_s, reason}: n passing runs were re-sent. */
export function resentNote(word, t) {
    const r = t.resent || {};
    const s = Number(r.at_s);
    const at = Number.isFinite(s) ? (s >= 60 ? `${Math.floor(s / 60)} min ${Math.round(s % 60)} s` : `${Math.round(s)} s`) : null;
    const why = [at && `stopped early at ${at}`, r.reason].filter(Boolean).join(': ');
    const of = r.n > 1 ? ` (on ${r.n} of its passing runs)` : '';
    return `${word} — passed after the original prompt was re-sent${why ? ` (${why})` : ''}${of}`;
}

/** Wrap text into lines of at most `max` characters, on spaces (a tooltip line per run note would otherwise run off
 *  the screen: the notes quote the prompt). */
export function wrapText(text, max = 90) {
    const out = [];
    for (const para of String(text || '').split('\n')) {
        let line = '';
        for (const w of para.split(/\s+/).filter(Boolean)) {
            if (line && (line + ' ' + w).length > max) { out.push(line); line = w; } else line = line ? line + ' ' + w : w;
        }
        if (line) out.push(line);
    }
    return out;
}
/** The lab's detail line of a pass* cell (`capWall`, its run's wall clock; taskGrid sets it off the public site). */
export function capWallLine(s) {
    const m = Math.round(Number(s) / 60);
    return `the run's wall clock: ${m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')} min` : `${m} min`}, at the time limit`;
}
/** The detail lines of a cell's marks, wrapped for the tooltip: a pass*'s wall clock (`capWall`), the runs answered with
 *  the original prompt and what they replaced (`answered`), the runs still waiting for the answer (`unfinished`). The lab
 *  only: the public data carries counts, no notes (lib/publicdata.js), and taskGrid sets no `capWall` with
 *  opts.publicSite, so a public cell shows its category line alone. [] when there is nothing. */
export function askTooltip(c) {
    const lines = [...(c && c.capWall ? [capWallLine(c.capWall)] : []), ...answeredLines(c && c.answered), ...(c && c.unfinished ? unfinishedLines(c.unfinished) : [])];
    return lines.flatMap((l) => wrapText(l, 90).map((x, i) => (i ? '     ' : '   ') + x));
}

export function taskGrid(canvasId, rows, allTasks, onPick, opts = {}) {
    const OUTCOME = {
        pass: { c: STATUS_COLOR.pass || '#34d399', t: 'pass' },
        'pass*': { c: SPECIAL_PASS_FILL, t: `pass* — ${PASS_AT_CAP_NOTE}` },
        TIMEOUT: { c: STATUS_COLOR.TIMEOUT || '#f2a03d', t: 'TIMEOUT' },
        fail: { c: STATUS_COLOR.fail || '#f87171', t: 'fail' },
    };
    const EXCLUDED = { c: '#4a4f5c', t: 'excluded (not a model answer)' };
    // 0.10 alpha on a near-black card is invisible; the tail has to read as empty BOXES,
    // because "86 tasks nobody ran" is the point it is making. (With the desktop cell gaps below
    // a fainter fill still reads as boxes; at phone width there are no gaps, hence not fainter still.)
    const MISSING = { c: 'rgba(148,163,184,0.14)', t: 'not attempted' };
    // UNFINISHED (2026-10-19, Kyle): a run that stopped to ask a question not yet answered with the original prompt is in
    // no count; a row carries those beside its tasks (r.unfinished, lib/models.js unfinishedMap). A task with nothing
    // else is a NEUTRAL mid-gray box (hatched when wide enough), never green or red.
    const UNFINISHED = { c: UNFINISHED_FILL };
    // the cell's colour and text, plus its marks (`answered`, `unfinished`) for the tooltip, the card and the painter
    const cell = (r, task) => {
        const t = r.tasks && r.tasks[task];
        const u = r.unfinished && r.unfinished[task];
        if (!t && u) return { ...UNFINISHED, t: unfinishedCategory(u), unfinished: u, unfinishedOnly: true };
        const o = cellOf(r, task);
        if (!t || (!t.answered && !u)) return o;
        return { ...o, ...(t.answered ? { answered: t.answered } : {}), ...(u ? { unfinished: u, t: `${o.t} · another run: ${unfinishedCategory(u)}` } : {}) };
    };
    const cellOf = (r, task) => {
        const t = r.tasks && r.tasks[task];
        if (!t) return MISSING;
        // a sample-group sibling that was folded into another task for scoring: its own outcome,
        // marked as not counted (it would otherwise read as "never attempted")
        if (t.folded_into) {
            const oc = t.own_credit >= 1 ? OUTCOME.pass : t.own_credit > 0 ? { c: OUTCOME.pass.c } : (t.status === 'TIMEOUT' ? OUTCOME.TIMEOUT : OUTCOME.fail);
            return { c: oc.c, t: `${t.own_credit >= 1 ? 'pass' : t.own_credit > 0 ? 'partial' : (t.status || 'fail')} — counted once with ${t.folded_into} (sample group ${t.sample_group}); not scored separately` };
        }
        if (t.excluded) return EXCLUDED;
        // Colour from the fold (credit across every scored run), never the latest row's status:
        // a solve with a later provider error on top of it is still a solve.
        if (t.credit != null) {
            const an = t.answered || null;
            if (t.credit >= 1) {
                // DARK GREEN (2026-10-19, Kyle): passed under special conditions -- the run hit the time limit (pass*), or
                // its question was answered with the original prompt (a re-send at the end of the run, or a continuation)
                // and then it passed. One look; the hover names the condition(s). The lab adds the wall clock of a pass*.
                const notes = specialPassNotes(t);
                if (notes.length) return { c: SPECIAL_PASS_FILL, specialPass: true, t: `${t.status === 'pass*' ? 'pass*' : 'pass'} — ${notes.join('; ')}`,
                    ...(t.status === 'pass*' ? { atCap: true } : {}),
                    ...(t.status === 'pass*' && !opts.publicSite && Number(t.wall_s) > 0 ? { capWall: Number(t.wall_s) } : {}) };
                return OUTCOME.pass;
            }
            if (t.credit > 0) {
                const txt = t.cellText || `passed ${t.passes} of ${t.attempts} ${opts.unit || 'runs'}`;
                return { c: OUTCOME.pass.c, t: an ? `${txt} — ${answeredCategory(an, an.passed > 0 ? 'passed' : 'failed')}` : txt };
            }
            const oc = t.status === 'TIMEOUT' ? OUTCOME.TIMEOUT : OUTCOME.fail;
            // answered and then failed: an ordinary fail; the hover says it was answered
            const base = t.cellText ? `${oc.t} — ${t.cellText}` : oc.t;
            return { c: oc.c, t: an ? `${base} — ${answeredCategory(an, 'failed')}` : base };
        }
        return OUTCOME[t.status] || { c: STATUS_COLOR.fail || '#f87171', t: t.status || 'fail' };
    };

    // EASIEST FIRST, left to right; HARDEST at the right edge (Kyle, 2026-09-24). A row reads as
    // "how far right does the green reach" -- the further right, the harder the problems this model
    // got. The Models page passes the order from the Rasch fit's task difficulties (opts.order);
    // this fallback uses solve counts. Either way it is derived from the results every render, so
    // it re-orders itself as evidence arrives.
    // Tasks nobody has attempted have no measured difficulty, so they cannot be placed on that
    // scale: they go on the right as a tail of empty boxes, which is what unused corpus looks
    // like. Without them the grid silently implied the suite was 16 tasks long.
    const counts = new Map();
    for (const task of (allTasks || [])) counts.set(task, { solved: 0, seen: 0 });
    for (const r of rows) for (const [task, t] of Object.entries(r.tasks || {})) {
        const cur = counts.get(task) || { solved: 0, seen: 0 };
        cur.seen++; if (t.solved) cur.solved++;
        counts.set(task, cur);
    }
    // Difficulty is the WILSON UPPER BOUND of the solve rate, not the raw rate. 17 of the 37
    // attempted tasks have been tried by exactly one model, and on the raw rate a single failure
    // reads as 0% -- indistinguishable from a task nine configs have all failed, and it would sit
    // at the far left as the hardest thing in the corpus. The upper bound says how good the task
    // could plausibly be: 0 of 1 could still be an easy task (UB ~0.79), 0 of 9 could not
    // (UB ~0.30). Sorting by it puts CONFIDENTLY hard on the left and thinly-tested in the middle.
    const wilsonUpper = (k, n) => {
        if (!n) return 1;
        const z = 1.96, p = k / n, d = 1 + (z * z) / n;
        return (p + (z * z) / (2 * n)) / d + (z / d) * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n));
    };
    const order = (opts.order && opts.order.length) ? opts.order.filter((t) => counts.has(t)) : [...counts.keys()].sort((a, b) => {
        const A = counts.get(a), B = counts.get(b);
        if (!A.seen !== !B.seen) return A.seen ? -1 : 1;              // attempted before the tail
        if (!A.seen) return a.localeCompare(b);
        // EASIEST LEFT: highest plausible solve rate first, so each row fills from the left and
        // the hardest tasks sit at the right edge.
        return wilsonUpper(B.solved, B.seen) - wilsonUpper(A.solved, A.seen)
            || B.seen - A.seen || a.localeCompare(b);
    });

    // NO BORDER. At phone width the plot area is ~150 px for 102 segments -- 1.5 px each -- and a
    // 1 px near-black border on both sides of that leaves nothing but border. The chart was drawing
    // correctly the whole time and rendering as an empty strip. Colour alone separates the boxes;
    // at desktop width the segments are wide enough not to need a gap either.
    // A task run more than once with mixed outcomes is split HORIZONTALLY within its cell: green on
    // top, red below, heights in proportion to passed vs failed scored attempts (1 of 2 = half and
    // half). One segment per task keeps widths equal; the red part is painted over the bottom of
    // the cell by the plugin below. Cells that are not a pass/fail mix keep their single colour.
    const split = (r, task) => {
        const t = r.tasks && r.tasks[task];
        if (!t || t.excluded || t.credit == null || t.credit <= 0 || t.credit >= 1) return null;
        return t.credit;
    };
    const RED = STATUS_COLOR.fail || '#f87171';
    // Desktop (2026-10-01): a 2px gap between boxes, plus slightly rounded corners -- the grid reads as boxes rather than a
    // striped bar. Only when a cell is at least 6px wide: the NO BORDER rule above still holds at phone width.
    const gapOf = (chart) => { const a = chart && chart.chartArea; return a && order.length && a.width / order.length >= 6 ? 1 : 0; };
    // A cell's box (2026-10-21: drawn straight on the canvas, see gridCanvas): the row's band is the y step; the box is
    // 86% of it, centred (what Chart.js's categoryPercentage 0.86 drew); `g` insets it for the desktop gap. Edges sit on
    // device pixels, and narrower cells keep a one-device-pixel seam (when a cell is 3+ device pixels wide), so the boxes
    // of one colour still read as separate boxes -- the seam Chart.js's anti-aliased bars used to leave by accident.
    const box = (chart, ri, col) => {
        const { x, y } = chart.scales, g = gapOf(chart), h = y.step * 0.86, d = chart.dpr || 1;
        const snap = (v) => Math.round(v * d) / d;
        const left = snap(x.getPixelForValue(col)), right = snap(x.getPixelForValue(col + 1));
        const seam = !g && (right - left) * d >= 3 ? 1 / d : 0;
        return { left: left + g, top: y.getPixelForValue(ri) - h / 2 + g, w: right - left - 2 * g - seam, height: h - 2 * g, g };
    };
    const rounded = (p, b, radii) => { if (b.g && p.roundRect) p.roundRect(b.left, b.top, b.w, b.height, radii); else p.rect(b.left, b.top, b.w, b.height); };
    // Every cell's fill, one path per colour (one fill call each instead of ~20,000 bar elements). A pass/fail mix is
    // filled green; its red part goes on top below (splitPainter).
    const cellPainter = (chart) => {
        const { ctx } = chart, paths = new Map();
        rows.forEach((r, ri) => order.forEach((task, col) => {
            const c = split(r, task) == null ? cell(r, task).c : OUTCOME.pass.c;
            let p = paths.get(c); if (!p) paths.set(c, p = new Path2D());
            rounded(p, box(chart, ri, col), 2);
        }));
        for (const [c, p] of paths) { ctx.fillStyle = c; ctx.fill(p); }
    };
    // A task run more than once with mixed outcomes: the red share painted over the bottom of its cell. In the sub-tests
    // view a regression (a case the base passes that the run broke) gets an amber corner, so "+1 new" bought by
    // breaking something else does not read as gain.
    const splitPainter = (chart) => {
        const { ctx } = chart;
        ctx.save();
        rows.forEach((r, ri) => order.forEach((task, col) => {
            const f = split(r, task);
            const t = r.tasks && r.tasks[task];
            if (f == null && !(t && t.regress > 0 && !t.excluded)) return;
            const b = box(chart, ri, col);
            if (f != null) {
                ctx.fillStyle = RED; ctx.beginPath();
                rounded(ctx, { ...b, top: b.top + b.height * f, height: b.height * (1 - f) }, [0, 0, 2, 2]);
                ctx.fill();
            }
            if (t && t.regress > 0 && !t.excluded) {
                const k = Math.max(3, Math.min(b.w, b.height) * 0.45);
                ctx.fillStyle = '#f59e0b'; ctx.beginPath();
                ctx.moveTo(b.left + b.w - k, b.top); ctx.lineTo(b.left + b.w, b.top); ctx.lineTo(b.left + b.w, b.top + k); ctx.closePath(); ctx.fill();
            }
        }));
        ctx.restore();
    };
    // The two marked looks (2026-10-19, Kyle), drawn over the fill when a cell is at least 6 px wide:
    //  - PASSED UNDER SPECIAL CONDITIONS (pass*, answered-then-passed): the dark-green fill gets a 1 px light-green edge
    //    (#4ade80), so it never reads as a plain pass;
    //  - UNFINISHED only: the mid-gray fill gets dark diagonal hatching (every 4 px), so it never reads as excluded grey.
    // At phone width (1-2 px cells, no gaps) the fill alone carries it.
    const askPainter = (chart) => {
        if (!gapOf(chart)) return;
        const { ctx } = chart;
        ctx.save();
        rows.forEach((r, ri) => order.forEach((task, col) => {
            const t = r.tasks && r.tasks[task];
            const u = !t && r.unfinished && r.unfinished[task];
            const ans = specialPassNotes(t).length > 0;
            if (!u && !ans) return;
            const { left, top, w, height } = box(chart, ri, col);
            if (w < 6 || height <= 0) return;
            if (ans) { ctx.lineWidth = 1; ctx.strokeStyle = SPECIAL_PASS_EDGE; ctx.strokeRect(left + 1.5, top + 1.5, w - 3, height - 3); return; }
            ctx.save();
            ctx.beginPath(); ctx.rect(left, top, w, height); ctx.clip();
            ctx.strokeStyle = UNFINISHED_HATCH; ctx.lineWidth = 1;
            ctx.beginPath();
            for (let x = left - height; x < left + w; x += 4) { ctx.moveTo(x, top + height); ctx.lineTo(x + height, top); }
            ctx.stroke();
            ctx.restore();
        }));
        ctx.restore();
    };
    // Queued (2026-10-24, Kyle: "the solve maps should put blue dots inside every rectangle that is planned in the current
    // running queued set"): a cell whose row.planned set holds its task is one a running battery still has to run -- a
    // blue dot in its middle, ringed dark (when the cell has room for the ring) so it reads on green, red and grey alike.
    // The full map has ~240 columns, so a cell is often only 3-6 px wide: the dot shrinks with it, down to a 2.5 px cell;
    // at phone width (1-2 px) there is no room for one.
    const plannedPainter = (chart) => {
        if (!rows.some((r) => r.planned && r.planned.size)) return;
        const { ctx } = chart;
        ctx.save();
        rows.forEach((r, ri) => {
            if (!r.planned) return;
            for (const task of r.planned) {
                const col = order.indexOf(task);
                if (col < 0 || (r.running && r.running.has(task))) continue;
                const b = box(chart, ri, col);
                if (b.w < 2.5 || b.height <= 0) continue;
                const ring = b.w >= 6 ? 1 : 0, rad = Math.max(1, Math.min(4, Math.min(b.w / 2 - ring - 0.25, b.height * 0.3)));
                const x = b.left + b.w / 2, y = b.top + b.height / 2;
                if (ring) { ctx.beginPath(); ctx.arc(x, y, rad + ring, 0, Math.PI * 2); ctx.fillStyle = 'rgba(15,23,42,0.9)'; ctx.fill(); }
                ctx.beginPath(); ctx.arc(x, y, rad, 0, Math.PI * 2);
                ctx.fillStyle = '#60a5fa'; ctx.fill();
            }
        });
        ctx.restore();
    };
    // Running now (2026-09-30, Kyle): a cell whose row.running set holds its task is the task a battery is on right
    // now -- a glowing blue outline. A click on it goes to opts.onRunningCell (the Live view) instead of onCell.
    const runningPainter = (chart) => {
        if (!rows.some((r) => r.running && r.running.size)) return;
        const { ctx } = chart;
        ctx.save();
        rows.forEach((r, ri) => {
            if (!r.running) return;
            for (const task of r.running) {
                const col = order.indexOf(task);
                if (col < 0) continue;
                const { x, y } = chart.scales, h = y.step * 0.86;
                const left = x.getPixelForValue(col), w = Math.max(3, x.getPixelForValue(col + 1) - left), top = y.getPixelForValue(ri) - h / 2;
                ctx.shadowColor = '#60a5fa'; ctx.shadowBlur = 10;
                ctx.strokeStyle = '#93c5fd'; ctx.lineWidth = 2;
                for (let k = 0; k < 2; k++) ctx.strokeRect(left - 1, top - 1, w + 2, h + 2);   // twice: a denser glow
            }
        });
        ctx.restore();
    };
    // "All configs" view: rows of one model are clumped together (opts.groupOf(row) -> model key).
    // Each clump gets a shared background band (alternating, so neighbours differ), a coloured
    // accent bar at the left edge of the labels, and a rule across the full width between clumps.
    const groupOf = opts.groupOf || null;
    const bands = [];
    if (groupOf) rows.forEach((r, i) => {
        const g = groupOf(r), last = bands[bands.length - 1];
        if (last && last.g === g) last.to = i; else bands.push({ g, from: i, to: i });
    });
    const groupPainter = {
        beforeDatasetsDraw(chart) {
            if (!bands.length) return;
            const { ctx, scales: { y } } = chart;
            const step = y.step;
            ctx.save();
            bands.forEach((b, bi) => {
                const top = y.getPixelForValue(b.from) - step / 2, bottom = y.getPixelForValue(b.to) + step / 2;
                ctx.fillStyle = bi % 2 ? 'rgba(148,163,184,0.06)' : 'rgba(96,165,250,0.10)';
                ctx.fillRect(0, top, chart.width, bottom - top);
                if (b.to > b.from) {   // only clumps of 2+ configs get the accent bar
                    ctx.fillStyle = bi % 2 ? 'rgba(148,163,184,0.55)' : 'rgba(96,165,250,0.75)';
                    ctx.fillRect(0, top + 1, 3, bottom - top - 2);
                }
            });
            ctx.restore();
        },
        afterDatasetsDraw(chart) {
            if (bands.length < 2) return;
            const { ctx, scales: { y } } = chart;
            const step = y.step;
            ctx.save();
            ctx.strokeStyle = 'rgba(203,213,225,0.45)'; ctx.lineWidth = 1;
            bands.slice(1).forEach((b) => {
                const yy = Math.round(y.getPixelForValue(b.from) - step / 2) + 0.5;
                ctx.beginPath(); ctx.moveTo(0, yy); ctx.lineTo(chart.width, yy); ctx.stroke();
            });
            ctx.restore();
        },
    };
    // Row labels as a small table (2026-10-01): model name | strength + 95% range | how much of the
    // corpus was actually tested. Drawn by hand when the rows carry structured fields (r.name);
    // otherwise the plain label (r.label), right-aligned. Above the plot, a header names
    // the columns and the order of the tasks: easiest to hardest, then the never-attempted tail.
    const rich = rows.some((r) => r.name != null);
    const LABEL_W = opts.labelWidth || 420;
    // Compare mode (2026-10-11, Kyle: "checkboxes show up by every row"): opts.tick(row) -> 'on' | 'off' | 'dim' (the
    // two picks are made: this box cannot be ticked) | null (a row that cannot be compared: no box). A column of
    // boxes at the left edge of the label table, the names moved right to make room. Read WHEN THE CHART DRAWS, as the
    // search highlight is, so a tick only needs chart.draw(). Without opts.tick nothing here draws and nothing moves.
    const tickOf = rich && typeof opts.tick === 'function' ? opts.tick : null;
    const TICK_X = 7, TICK_S = 12, TICK_W = tickOf ? 20 : 0;
    const tickPainter = {
        beforeDatasetsDraw(chart) {      // a faint band under a ticked row's label, so the two picks are easy to find in a long list
            if (!tickOf) return;
            const { ctx, scales: { y }, chartArea: a } = chart;
            const step = y.step;
            ctx.save(); ctx.fillStyle = 'rgba(116,119,246,0.16)';
            rows.forEach((r, i) => { if (tickOf(r) === 'on') ctx.fillRect(0, y.getPixelForValue(i) - step / 2 + 1, a.left - 4, step - 2); });
            ctx.restore();
        },
    };
    const drawTick = (ctx, state, yy) => {
        const x = TICK_X, top = Math.round(yy - TICK_S / 2) + 0.5;
        ctx.save();
        ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x + 0.5, top, TICK_S, TICK_S, 3); else ctx.rect(x + 0.5, top, TICK_S, TICK_S);
        if (state === 'on') {
            ctx.fillStyle = '#7477f6'; ctx.fill();
            ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1.8; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
            ctx.beginPath(); ctx.moveTo(x + 3.5, top + 6.2); ctx.lineTo(x + 5.8, top + 8.6); ctx.lineTo(x + 9.8, top + 3.6); ctx.stroke();
        } else {
            ctx.fillStyle = state === 'dim' ? 'rgba(255,255,255,0.02)' : 'rgba(255,255,255,0.05)'; ctx.fill();
            ctx.strokeStyle = state === 'dim' ? 'rgba(149,156,171,0.28)' : '#959cab'; ctx.lineWidth = 1.2; ctx.stroke();
        }
        ctx.restore();
    };
    const nAttempted = (() => { const i = order.findIndex((t) => !((counts.get(t) || {}).seen)); return i < 0 ? order.length : i; })();
    const ellipsize = (ctx, text, max) => {
        if (ctx.measureText(text).width <= max) return text;
        let lo = 0, hi = text.length;
        while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (ctx.measureText(text.slice(0, mid) + '…').width <= max) lo = mid; else hi = mid - 1; }
        return text.slice(0, lo) + '…';
    };
    const labelPainter = {
        afterDraw(chart) {
            const { ctx, scales: { x, y }, chartArea: a } = chart;
            ctx.save();
            ctx.textBaseline = 'middle';
            const headY = a.top - 13;
            // difficulty header over the cells
            if (order.length) {
                const x0 = x.getPixelForValue(0), xa = x.getPixelForValue(nAttempted), x1 = x.getPixelForValue(order.length);
                if (nAttempted > 0) {
                    const grad = ctx.createLinearGradient(x0, 0, xa, 0);
                    grad.addColorStop(0, 'rgba(140,145,253,0.15)'); grad.addColorStop(1, 'rgba(140,145,253,0.85)');
                    ctx.fillStyle = grad;
                    ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(x0, headY + 7, xa - x0 - 2, 2, 1); else ctx.rect(x0, headY + 7, xa - x0 - 2, 2); ctx.fill();
                    ctx.font = `500 10.5px ${SANS}`; ctx.fillStyle = '#959cab';
                    ctx.textAlign = 'left'; ctx.fillText('easiest', x0, headY - 2);
                    ctx.textAlign = 'right'; ctx.fillText(`hardest  ·  ${nAttempted} attempted tasks`, xa - 2, headY - 2);
                }
                if (nAttempted < order.length) {
                    ctx.font = `500 10.5px ${SANS}`; ctx.fillStyle = '#525867'; ctx.textAlign = 'right';
                    ctx.fillText(`never attempted · ${order.length - nAttempted}`, x1, headY - 2);
                    ctx.strokeStyle = 'rgba(255,255,255,0.10)'; ctx.setLineDash([2, 3]); ctx.lineWidth = 1;
                    ctx.beginPath(); ctx.moveTo(Math.round(xa) + 0.5, headY + 4); ctx.lineTo(Math.round(xa) + 0.5, a.bottom); ctx.stroke(); ctx.setLineDash([]);
                }
            }
            if (rich) {
                const pctRight = a.left - 12, xBar = pctRight - 30 - 40, xStr = xBar - 14, nameMax = xStr - 84 - 6;
                ctx.font = `600 9.5px ${SANS}`; ctx.fillStyle = '#525867';
                ctx.textAlign = 'left'; ctx.fillText('MODEL', 6 + TICK_W, headY - 2);
                ctx.textAlign = 'right'; ctx.fillText('STRENGTH', xStr, headY - 2);
                ctx.textAlign = 'left'; ctx.fillText('TESTED', xBar, headY - 2);
                rows.forEach((r, i) => {
                    const yy = y.getPixelForValue(i);
                    const muted = !!(r.secondary || r.pending);
                    // tested share of the corpus: a thin bar, then the percent
                    if (r.coverage != null) {
                        ctx.fillStyle = 'rgba(255,255,255,0.07)';
                        ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(xBar, yy - 2, 40, 4, 2); else ctx.rect(xBar, yy - 2, 40, 4); ctx.fill();
                        ctx.fillStyle = muted ? 'rgba(140,145,253,0.45)' : '#8c91fd';
                        const w = Math.max(2, 40 * Math.min(1, r.coverage));
                        ctx.beginPath(); if (ctx.roundRect) ctx.roundRect(xBar, yy - 2, w, 4, 2); else ctx.rect(xBar, yy - 2, w, 4); ctx.fill();
                        ctx.font = `10.5px ${SANS}`; ctx.fillStyle = '#747b8c'; ctx.textAlign = 'right';
                        ctx.fillText(`${Math.round(r.coverage * 100)}%`, pctRight, yy + 0.5);
                    }
                    // strength and its range
                    if (r.strength != null) {
                        ctx.textAlign = 'right';
                        const range = r.lo != null ? `${r.lo}–${r.hi}` : '';
                        ctx.font = `10.5px ${SANS}`; const rw = ctx.measureText(range).width;
                        ctx.fillStyle = '#747b8c'; ctx.fillText(range, xStr, yy + 0.5);
                        ctx.font = `650 12.5px ${SANS}`; ctx.fillStyle = muted ? '#b9bec9' : '#ffffff';
                        ctx.fillText(String(r.strength), xStr - rw - 6, yy + 0.5);
                    }
                    // name, then a muted note (configs count, config difference) if it fits
                    ctx.textAlign = 'left';
                    const indent = (r.secondary ? 16 : 6) + TICK_W;
                    const tk = tickOf ? tickOf(r) : null;
                    if (tk) drawTick(ctx, tk, yy);
                    const gold = isHl(r);   // search highlight: a gold name inside the row's gold frame (rowFramePlugin)
                    ctx.font = `${gold ? 650 : muted ? 400 : 500} 12px ${SANS}`; ctx.fillStyle = gold ? GOLD : muted ? '#959cab' : '#d9dce4';
                    const name = ellipsize(ctx, r.name || r.label || '', nameMax - indent);
                    ctx.fillText(name, indent, yy + 0.5);
                    if (r.note) {
                        const used = ctx.measureText(name).width;
                        ctx.font = `11px ${SANS}`; ctx.fillStyle = '#525867';
                        const room = nameMax - indent - used - 8;
                        if (room > 30) ctx.fillText(ellipsize(ctx, r.note, room), indent + used + 8, yy + 0.5);
                    }
                });
            } else {
                // plain rows: the label, right-aligned against the plot (what the Chart.js y axis drew)
                ctx.font = `11px ${SANS}`; ctx.fillStyle = TICK; ctx.textAlign = 'right';
                rows.forEach((r, i) => ctx.fillText(ellipsize(ctx, r.label || '', a.left - 16), a.left - 8, y.getPixelForValue(i) + 0.5));
            }
            ctx.restore();
        },
    };
    const frame = rowFramePlugin(rows);
    // Paint order = the old Chart.js plugin order: bands, tick bands, gold tint | cells | rules, split, marks, running |
    // gold frame, labels.
    const paint = (chart) => {
        groupPainter.beforeDatasetsDraw(chart); tickPainter.beforeDatasetsDraw(chart); frame.beforeDatasetsDraw(chart);
        cellPainter(chart);
        groupPainter.afterDatasetsDraw(chart); splitPainter(chart); askPainter(chart); plannedPainter(chart); runningPainter(chart);
        frame.afterDraw(chart); labelPainter.afterDraw(chart);
    };
    // The hover readout of a cell: the row, the task and its outcome, its marks, how many models here solved it.
    const tooltip = (ri, col) => {
        const task = order[col], r = rows[ri];
        const c = cell(r, task);
        const n = counts.get(task) || { solved: 0, seen: 0 };
        const queued = r.running && r.running.has(task) ? ['running now'] : r.planned && r.planned.has(task) ? ['queued: a running battery of this row still has it to run'] : [];
        return { title: r.label, lines: [`${task}: ${c.t}`, ...askTooltip(c), ...queued, n.seen ? `solved by ${n.solved}/${n.seen} models here` : 'never attempted by any model'] };
    };
    const labelWidth = rich ? () => LABEL_W
        : (ctx) => { ctx.font = `11px ${SANS}`; return Math.min(320, Math.ceil(Math.max(40, ...rows.map((r) => ctx.measureText(r.label || '').width))) + 16); };
    return hoverLabel(pickByLabel(gridCanvas(canvasId, {
        nRows: rows.length, nCols: Math.max(1, order.length), labelWidth, padTop: 30, padRight: 2, paint, tooltip,
        // with opts.onCell the canvas listener in pickByLabel takes every click instead
        onPlotClick: opts.onCell ? null : (ri, col, e) => { if (onPick && rows[ri]) onPick(rows[ri].key, e); },
    }), rows, onPick, opts.onCell ? (col, ri, e) => {
        if (col < 0 || col >= order.length) return;       // blank plot space past the last column
        const task = order[col];
        if (task && opts.onRunningCell && rows[ri] && rows[ri].running && rows[ri].running.has(task)) return opts.onRunningCell(task, rows[ri], e);
        if (task) opts.onCell(task, rows[ri], e, { cell: cell(rows[ri], task), counts: counts.get(task) || { solved: 0, seen: 0 } });
    } : null), rows, opts.onLabelHover || null, opts.onLabelLeave || null);
}

// ---- the Solve map's canvas (2026-10-21, Kyle: "I think we have too many html elements. the solve map should probably
// be rendered as a canvas"). It was a Chart.js stacked bar chart with one dataset per task: ~20,000 bar elements, each
// with its own resolved options and hit box, rebuilt on every draw -- 1.5 s of a frozen page per paint, measured.
// Now taskGrid paints the cells itself on one canvas; this is the small chart-shaped object it paints on, so the shared
// helpers keep working unchanged: hoverLabel / pickByLabel (chart.canvas, chartArea, scales.x/y getValueForPixel),
// rowFramePlugin (scales.y.getPixelForValue, ctx, width), the registry (destroyAll; repaintHighlight calls draw()).
// The geometry is Chart.js's for this chart: a category y axis (row i centred in band i), a linear x axis 0..nCols over
// the plot. Sized to its parent box (the page sets the box height); redrawn when the box resizes; crisp at any
// devicePixelRatio. The cell readout is an HTML tooltip in the same skin as the Chart.js ones (TIP), for a mouse only,
// and never while a detail card is open (oneReadout's rule).
export function gridGeometry(width, height, { nRows, nCols, labelW, padTop = 0, padRight = 0, padBottom = 2 }) {
    const left = labelW, top = padTop, right = Math.max(left + 1, width - padRight), bottom = Math.max(top + 1, height - padBottom);
    const step = (bottom - top) / Math.max(1, nRows), colW = (right - left) / Math.max(1, nCols);
    return {
        chartArea: { left, top, right, bottom, width: right - left, height: bottom - top },
        y: { step, getPixelForValue: (i) => top + (i + 0.5) * step, getValueForPixel: (py) => (py - top) / step - 0.5 },
        x: { getPixelForValue: (v) => left + v * colW, getValueForPixel: (px) => (px - left) / colW },
    };
}
/** The cell under a point, or null: the row whose bar (86% of its band) contains y, the column that contains x. */
export function gridCellAt(geo, nRows, nCols, px, py) {
    const a = geo.chartArea;
    if (px < a.left || px >= a.right || py < a.top || py >= a.bottom) return null;
    const ri = Math.round(geo.y.getValueForPixel(py)) || 0, col = Math.floor(geo.x.getValueForPixel(px));   // || 0: never -0
    if (ri < 0 || ri >= nRows || col < 0 || col >= nCols) return null;
    if (Math.abs(py - geo.y.getPixelForValue(ri)) > (geo.y.step * 0.86) / 2) return null;   // the gap between bars
    return { ri, col };
}
let gridTipEl = null;
function gridTip() {
    if (gridTipEl && gridTipEl.isConnected) return gridTipEl;
    gridTipEl = document.createElement('div');
    gridTipEl.className = 'tg-tip';
    gridTipEl.setAttribute('role', 'tooltip');
    Object.assign(gridTipEl.style, { position: 'fixed', zIndex: '60', pointerEvents: 'none', display: 'none', maxWidth: 'min(640px, calc(100vw - 16px))',
        background: TIP.backgroundColor, border: `${TIP.borderWidth}px solid ${TIP.borderColor}`, borderRadius: TIP.cornerRadius + 'px', padding: TIP.padding + 'px',
        color: TIP.bodyColor, font: `${TIP.bodyFont.size}px ${SANS}`, lineHeight: '1.4', whiteSpace: 'pre-wrap', boxShadow: '0 4px 14px rgba(0,0,0,0.35)' });
    document.body.appendChild(gridTipEl);
    return gridTipEl;
}
function gridCanvas(canvasId, { nRows, nCols, labelWidth, padTop, padRight, paint, tooltip, onPlotClick }) {
    const cv = document.getElementById(canvasId);
    if (!cv) return null;
    const old = registry.get(canvasId);
    if (old) { try { old.destroy(); } catch { /* already gone */ } registry.delete(canvasId); }
    const stray = window.Chart && window.Chart.getChart && window.Chart.getChart(cv);   // a Chart.js chart left on this canvas
    if (stray) { try { stray.destroy(); } catch { /* gone */ } }
    const ctx = cv.getContext('2d');
    const G = { canvas: cv, ctx, width: 0, height: 0, chartArea: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }, scales: {} };
    let dpr = 1, alive = true, raf = 0;
    cv.style.display = 'block'; cv.style.boxSizing = 'border-box'; cv.style.width = '100%'; cv.style.height = '100%';
    const layout = () => {
        const host = cv.parentElement;
        const w = host ? host.clientWidth : cv.clientWidth, h = host ? host.clientHeight : cv.clientHeight;
        dpr = window.devicePixelRatio || 1;
        G.width = w; G.height = h; G.dpr = dpr;
        const geo = gridGeometry(w, h, { nRows, nCols, labelW: labelWidth(ctx), padTop, padRight });
        G.chartArea = geo.chartArea; G.scales = { x: geo.x, y: geo.y };
        const W = Math.max(1, Math.round(w * dpr)), H = Math.max(1, Math.round(h * dpr));
        if (cv.width !== W) cv.width = W;
        if (cv.height !== H) cv.height = H;
    };
    G.draw = () => {
        if (!alive || !G.width || !G.height) return;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.clearRect(0, 0, G.width, G.height);
        paint(G);
    };
    G.update = () => { if (!alive) return; layout(); G.draw(); };
    // hover readout
    let touchUntilMouse = false;
    const hideTip = () => { if (gridTipEl) gridTipEl.style.display = 'none'; };
    const showTip = (e) => {
        if (touchUntilMouse || cardOpen()) return hideTip();
        const r = cv.getBoundingClientRect();
        const hit = gridCellAt({ chartArea: G.chartArea, ...G.scales }, nRows, nCols, e.clientX - r.left, e.clientY - r.top);
        if (!hit) return hideTip();
        const t = tooltip(hit.ri, hit.col), el = gridTip();
        el.replaceChildren();
        const head = document.createElement('div');
        Object.assign(head.style, { color: TIP.titleColor, font: `${TIP.titleFont.weight} ${TIP.titleFont.size}px ${SANS}`, marginBottom: '3px' });
        head.textContent = t.title || '';
        el.appendChild(head);
        const body = document.createElement('div'); body.textContent = t.lines.join('\n'); el.appendChild(body);
        el.style.display = 'block';
        const bw = el.offsetWidth, bh = el.offsetHeight, vw = window.innerWidth, vh = window.innerHeight;
        let x = e.clientX + 14, y = e.clientY + 14;
        if (x + bw > vw - 8) x = Math.max(8, e.clientX - bw - 14);
        if (y + bh > vh - 8) y = Math.max(8, e.clientY - bh - 14);
        el.style.left = x + 'px'; el.style.top = y + 'px';
    };
    const onMove = (e) => { if (e.pointerType && e.pointerType !== 'mouse') return; touchUntilMouse = false; showTip(e); };
    const onDown = (e) => { if (e.pointerType !== 'mouse') { touchUntilMouse = true; hideTip(); } };
    const onClick = (e) => {
        setTimeout(() => { if (cardOpen()) hideTip(); }, 0);
        if (!onPlotClick) return;
        const r = cv.getBoundingClientRect();
        const hit = gridCellAt({ chartArea: G.chartArea, ...G.scales }, nRows, nCols, e.clientX - r.left, e.clientY - r.top);
        if (hit) onPlotClick(hit.ri, hit.col, e);
    };
    cv.addEventListener('pointermove', onMove);
    cv.addEventListener('pointerdown', onDown, true);
    cv.addEventListener('pointerleave', hideTip);
    cv.addEventListener('click', onClick);
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => { cancelAnimationFrame(raf); raf = requestAnimationFrame(G.update); }) : null;
    if (ro && cv.parentElement) ro.observe(cv.parentElement);
    G.destroy = () => {
        alive = false; cancelAnimationFrame(raf); if (ro) ro.disconnect(); hideTip();
        cv.removeEventListener('pointermove', onMove); cv.removeEventListener('pointerdown', onDown, true);
        cv.removeEventListener('pointerleave', hideTip); cv.removeEventListener('click', onClick);
        cv.onmousemove = null; cv.onmouseleave = null; cv.onclick = null;   // hoverLabel / pickByLabel set these
        if (registry.get(canvasId) === G) registry.delete(canvasId);
    };
    G.update();
    registry.set(canvasId, G);
    return G;
}

/**
 * Per-model status mix. Excluded statuses get their own visible segment so a model with a
 * pile of OVERFLOW/KILLED runs cannot read as good by accident.
 */
export function statusMix(canvasId, rows, onPick) {
    // No excluded segment. Kyle: stop showing grey bars here. An excluded row is not a model
    // answer, so putting it on a chart of how models did invites exactly the reading the
    // exclusion exists to prevent -- and Gemini's bar was half grey from a quota outage that
    // says nothing about Gemini. The count is still in the tooltip and on the detail page.
    const keys = ['pass', 'pass*', 'TIMEOUT', 'fail'];
    // Bar LENGTH is tasks -- how much evidence there is. The SPLIT within the bar is tasks
    // passed vs failed, with a task counted fractionally across its runs (4 passes of 5 = 0.8
    // pass, 0.2 fail), so repeats change the ratio and not the length.
    // Colour: pass* is a PASS -- solved, with the clock censored -- so it is the special-pass dark
    // green (2026-10-19, Kyle), not the amber it used to share with TIMEOUT. Amber now means only
    // TIMEOUT, which is the genuinely unknown outcome: it might have solved with more time.
    // (Retired from the page 2026-09-24; kept consistent with the Solve map.)
    const color = { ...STATUS_COLOR, 'pass*': SPECIAL_PASS_FILL, TIMEOUT: '#f59e0b', excluded: '#747b8c' };
    const datasets = keys.map((k) => ({
        label: k === 'excluded' ? 'excluded (not a failure)' : (k === 'pass*' ? 'pass* (passed, the run hit the time limit)' : k),
        data: rows.map((r) => r.counts[k] || 0),
        backgroundColor: color[k],
        borderColor: '#14161c', borderWidth: 2,      // 2px surface gap between stacked segments
        borderSkipped: false, borderRadius: 3,
    }));
    const c = mount(canvasId, {
        type: 'bar',
        data: { labels: rows.map((r) => r.label), datasets },
        options: {
            indexAxis: 'y',
            ...baseOpts('tasks', null, { x: { stacked: true }, y: { stacked: true, grid: { display: false } } }),
            // intersect:true, unlike the scatter charts. With intersect:false the NEAREST segment
            // wins by distance, so hovering the grey excluded block lit up whichever coloured
            // segment happened to be closest -- a tooltip for a bar you are not pointing at.
            interaction: { mode: 'nearest', intersect: true },
            scales: {
                x: { stacked: true, min: 0, title: { display: true, text: 'tasks — bar length is how many were attempted, the split is how they went', color: TITLE, font: { size: 10 } }, grid: { color: GRID }, ticks: { color: TICK, font: { size: 10 } } },
                y: { stacked: true, grid: { display: false }, ticks: { color: TICK, font: { size: 10 } } },
            },
            plugins: {
                tooltip: {
                    callbacks: {
                        // Share is what the bar draws; the underlying task count is what the
                        // reader needs to judge whether the share means anything.
                        label: (ctx) => {
                            const v = Number(ctx.parsed.x);
                            const r = rows[ctx.dataIndex];
                            // Denominator is SCORED, matching the bar: excluded runs are not drawn
                            // and must not appear under a percentage either.
                            const den = r && r.scored ? r.scored : (r && r.attempted);
                            const pct = den ? ` — ${(100 * v / den).toFixed(0)}%` : '';
                            return `${ctx.dataset.label}: ${Math.round(v * 100) / 100} of ${den || '?'} scored${pct}`;
                        },
                        afterBody: (items) => {
                            const r = rows[items[0].dataIndex];
                            if (!r) return '';
                            const out = [];
                            if (r.ci != null) out.push(`solve rate ${(r.rate * 100).toFixed(0)}% ±${r.ci.toFixed(0)} pts (95%)`);
                            if (r.repeated) out.push(`${r.repeated} task(s) run more than once — ${r.attemptsTotal} runs total`);
                            else out.push('one attempt per task — a single draw, not an estimate');
                            return out;
                        },
                    },
                },
            },
            onClick: (evt, els) => { if (onPick && els.length && rows[els[0].index]) onPick(rows[els[0].index].key, evt.native); },
        },
    });
    return c;
}

/**
 * Cost per solved task, one bar per model, cheapest first. Same shape for tokens, wall clock and
 * gigabytes of weights, because the question is identical in all three: what did one solve cost.
 *
 * A model with no solves is dropped rather than drawn at infinity -- "solved nothing" is a fact
 * about the solve-rate chart, not a cost.
 */
const barValuePlugin = (fmt) => ({
    id: 'barValues',
    // A 0.69 bar next to a 39 bar is one pixel wide and reads as zero -- Kyle read Bonsai's
    // 0.7 GB/solve, its best-in-class number, as missing data.
    afterDatasetsDraw(chart) {
        const { ctx } = chart;
        ctx.save();
        ctx.font = '10px ui-sans-serif, system-ui, sans-serif';
        ctx.fillStyle = '#cbd5e1';
        ctx.textBaseline = 'middle';
        for (const meta of chart.getSortedVisibleDatasetMetas()) {
            meta.data.forEach((bar, i) => {
                const v = chart.data.datasets[meta.index].data[i];
                if (v == null) return;
                ctx.fillText(fmt(v), bar.x + 6, bar.y);
            });
        }
        ctx.restore();
    },
});

// order: 'value' (cheapest / fastest first, the default) or 'quality' (highest solve rate first,
// ties broken by the value), so the cost can be read against what it bought.
// order: 'value' (smallest first -- a cost), 'desc' (largest first -- a yield, e.g. strength per GB),
// 'quality' (strength first). opts.per names what the value is per, for the tooltip (default "solved task").
export function costPerSolve(canvasId, rows, unit, fmt, order = 'value', onPick = null, opts = {}) {
    const per = opts.per || 'per solved task';
    const sorted = rows.filter((r) => r.value != null && isFinite(r.value) && r.value > 0)
        .sort(order === 'quality'
            ? (a, b) => ((b.rate ?? -1) - (a.rate ?? -1)) || (a.value - b.value)
            : order === 'desc' ? (a, b) => b.value - a.value
            : (a, b) => a.value - b.value);
    // onPick(key, event, row): bars and their labels both open the row's details
    const pick = onPick ? (key, ev) => { const r = sorted.find((x) => x.key === key); if (r) onPick(key, ev, r); } : null;
    const chart = mount(canvasId, {
        type: 'bar',
        data: {
            labels: sorted.map((r) => r.label),
            datasets: [{
                label: unit, data: sorted.map((r) => r.value),
                backgroundColor: sorted.map((r) => (r.provider === 'cloud' ? SERIES[3] : SERIES[0])),
                borderColor: '#14161c', borderWidth: 2, borderRadius: 4, borderSkipped: false,
            }],
        },
        options: {
            indexAxis: 'y',
            responsive: true, maintainAspectRatio: false,
            interaction: { mode: 'nearest', intersect: true },
            onClick: pick ? (evt, els) => { if (els.length) pick(sorted[els[0].index].key, evt.native); } : undefined,
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: {
                    title: (i) => sorted[i[0].dataIndex].label,
                    label: (c) => `${fmt(c.parsed.x)} ${per}`,
                    afterLabel: (c) => {
                        const r = sorted[c.dataIndex];
                        return [...(r.detail ? [r.detail] : []), `${r.solved} solved of ${r.attempted} attempted`, r.provider === 'cloud' ? 'cloud' : 'local'];
                    },
                } },
            },
            scales: {
                x: { beginAtZero: true, title: { display: true, text: unit, color: TITLE, font: { size: 10 } },
                     grid: { color: GRID }, ticks: { color: TICK, font: { size: 10 }, callback: (v) => fmt(v) } },
                // every row labelled: the container grows per row and scrolls, so never skip labels
                // (a model matching the search box: gold name, inside the row's gold frame)
                y: { grid: { display: false }, ticks: { color: (c) => (isHl(sorted[c.index]) ? GOLD : TICK), font: (c) => ({ size: 10, weight: isHl(sorted[c.index]) ? '700' : '400' }), autoSkip: false } },
            },
        },
        plugins: [rowFramePlugin(sorted), barValuePlugin(fmt)],
    });
    if (chart) chart.$hlUpdate = true;   // the tick colours are re-read on update
    return pickByLabel(chart, sorted, pick);
}

/** A single model's prefill curve: logged requests (median per bucket) + llama-bench depths. */
export function modelPrefillCurve(canvasId, fromRequests, fromBench) {
    const datasets = [];
    if (fromRequests.length) datasets.push({
        label: 'logged requests (median per bucket)',
        data: fromRequests.map((p) => ({ x: p.bucket, y: p.median, n: p.n })),
        borderColor: SERIES[0], backgroundColor: SERIES[0], borderWidth: 2, pointRadius: 4, tension: 0.2,
    });
    if (fromBench.length) datasets.push({
        label: 'llama-bench (measured at depth)',
        data: fromBench.map((p) => ({ x: Math.max(p.depth, 1), y: p.median, n: p.n })),
        borderColor: SERIES[1], backgroundColor: SERIES[1], borderWidth: 2, borderDash: [4, 3], pointRadius: 4, tension: 0.2,
    });
    return mount(canvasId, {
        type: 'line', data: { datasets },
        options: baseOpts('prompt tokens (log)', 'prefill t/s', {
            x: { type: 'logarithmic', ticks: { color: TICK, font: { size: 10 }, callback: (v) => (v >= 1024 ? `${Math.round(v / 1024)}k` : v) } },
            tooltip: { callbacks: { label: (c) => `${c.dataset.label}: ${Number(c.parsed.y).toFixed(1)} t/s (n=${c.raw.n})` } },
        }),
    });
}

/** Generation t/s by config. Bars, one per config, sorted by the caller. */
export function genByConfig(canvasId, rows) {
    return mount(canvasId, {
        type: 'bar',
        data: {
            labels: rows.map((r) => r.label),
            datasets: [{
                label: 'generation t/s', data: rows.map((r) => r.gen),
                backgroundColor: SERIES[2], borderColor: '#14161c', borderWidth: 2, borderRadius: 4, borderSkipped: false,
            }],
        },
        options: {
            interaction: { mode: 'nearest', intersect: true },   // bars: point AT one, don't guess the nearest
            indexAxis: 'y',
            ...baseOpts('generation t/s', null),
            plugins: {
                legend: { display: false },
                tooltip: { ...TIP, displayColors: false,
                    callbacks: { label: (c) => `${Number(c.parsed.x).toFixed(1)} t/s (n=${rows[c.dataIndex].n})` } },
            },
            scales: {
                x: { title: { display: true, text: 'generation t/s', color: TITLE, font: { size: 10 } }, grid: { color: GRID }, ticks: { color: TICK, font: { size: 10 } }, beginAtZero: true },
                y: { grid: { display: false }, ticks: { color: TICK, font: { size: 9 } } },
            },
        },
    });
}

/** Request rates over time, prefill and generation as SEPARATE charts (never one dual axis). */
export function ratesOverTime(prefillCanvasId, genCanvasId, series) {
    const opt = (yTitle, color, label) => ({
        type: 'line',
        data: { datasets: [{ label, data: series.map((p) => ({ x: p.t, y: p[label === 'prefill t/s' ? 'promptTps' : 'genTps'], tok: p[label === 'prefill t/s' ? 'promptTokens' : 'genTokens'] })).filter((d) => d.y != null), borderColor: color, backgroundColor: color, borderWidth: 2, pointRadius: 0, pointHoverRadius: 6, tension: 0.15 }] },
        options: baseOpts(null, yTitle, {
            x: { type: 'linear', ticks: { color: TICK, font: { size: 10 }, callback: (v) => new Date(v).toLocaleDateString() } },
            tooltip: { callbacks: { label: (c) => `${Number(c.parsed.y).toFixed(1)} t/s · ${c.raw.tok ?? '?'} tok · ${new Date(c.parsed.x).toLocaleString()}` } },
        }),
    });
    mount(prefillCanvasId, opt('prefill t/s', SERIES[0], 'prefill t/s'));
    mount(genCanvasId, opt('generation t/s', SERIES[2], 'gen t/s'));
}

export { esc };
