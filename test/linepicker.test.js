// The Models page prefill chart's line FOCUS (2026-10-14 23:30, Kyle: "when I click on one I want to FOCUS IT, and
// remove focus on everything else. When I click a second one (in the legend), it should ALSO focus. When I re-click a
// focused line, it should be, again, backgrounded--if that leaves no focused lines, then everything should be surfaced
// again."). Replaced the 22:5x line picker, whose taps HID lines. The pure half -- line ids, the focus set, its storage,
// the look of each line -- is ui/models/prefill.js; the legend DOM and the dataset styling are ui/models/charts.js,
// driven here through linkedom.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const P = () => import('../ui/models/prefill.js');

// A localStorage stand-in; `broken` throws like a private-mode / blocked-storage browser.
function memStore() {
    const m = new Map();
    return { m, getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}
const broken = { getItem() { throw new Error('SecurityError'); }, setItem() { throw new Error('QuotaExceeded'); }, removeItem() { throw new Error('x'); } };

const series = [
    { key: 'local:a:q4', label: 'Alpha 27B Q4', config: 'XTX only · 64k', configId: 'c1', n: 900 },
    { key: 'local:b:q4', label: 'Beta 35B Q4', config: 'XTX + 3060 · 128k', configId: 'c2', n: 400 },
    { key: 'local:b:q4', label: 'Beta 35B Q4 · XTX only · 64k', config: 'XTX only · 64k', configId: 'c3', n: 30 },
    { key: 'local:c:q8', label: 'Gamma Flash Q8_0', config: 'llama-bench depths', configId: null, n: 3 },
];

test('line ids: the model key per model, model key + config per config line, always unique', async () => {
    const { lineIds, lineId } = await P();
    assert.deepEqual(lineIds(series, 'config'), ['local:a:q4|c1', 'local:b:q4|c2', 'local:b:q4|c3', 'local:c:q8|llama-bench depths']);
    // model mode: one line per model normally; were two to share a key, the second still gets an id of its own
    assert.deepEqual(lineIds(series, 'model'), ['local:a:q4', 'local:b:q4', 'local:b:q4#2', 'local:c:q8']);
    assert.equal(lineId(null), '');
});

test('focus: a tap puts a line in, a second tap on another adds it, a re-tap takes it out; empty = every line normal', async () => {
    const { toggleFocus, lineLook } = await P();
    const ids = ['a', 'b', 'c', 'd'];
    const looks = (f, hover = null) => ids.map((id) => lineLook(id, f, hover));
    let f = new Set();
    assert.deepEqual(looks(f), ['normal', 'normal', 'normal', 'normal'], 'nothing focused: everything drawn normally');
    f = toggleFocus(f, 'b');
    assert.deepEqual(looks(f), ['back', 'focus', 'back', 'back'], 'one tap: that line focused, the rest backgrounded');
    f = toggleFocus(f, 'd');
    assert.deepEqual(looks(f), ['back', 'focus', 'back', 'focus'], 'a second line ALSO focuses');
    f = toggleFocus(f, 'b');
    assert.deepEqual(looks(f), ['back', 'back', 'back', 'focus'], 'a re-tapped focused line goes back');
    const before = f;
    f = toggleFocus(f, 'd');
    assert.equal(f.size, 0);
    assert.deepEqual(looks(f), ['normal', 'normal', 'normal', 'normal'], 'the last one out: everything surfaces again');
    assert.equal(before.has('d'), true, 'toggleFocus returns a new set, the old one is untouched');
    assert.deepEqual(looks(null), ['normal', 'normal', 'normal', 'normal']);
});

test('hover (desktop): the hovered line alone comes forward; hover off puts the focus set back', async () => {
    const { lineLook } = await P();
    const f = new Set(['a']);
    assert.equal(lineLook('c', f, 'c'), 'focus');
    assert.equal(lineLook('a', f, 'c'), 'back');
    assert.equal(lineLook('a', f, null), 'focus', 'hover gone: the focus set is in force again');
    assert.equal(lineLook('c', f, null), 'back');
    assert.equal(lineLook('c', new Set(), null), 'normal');
});

test('persistence: per chart AND mode, round-trips; empty removes the key; never throws on a blocked or malformed store', async () => {
    const { loadFocus, saveFocus, lineStoreKey } = await P();
    const st = memStore();
    saveFocus(st, 'prefill', 'model', new Set(['a', 'b']));
    saveFocus(st, 'prefill', 'config', ['a|c1']);
    assert.deepEqual(loadFocus(st, 'prefill', 'model'), ['a', 'b']);
    assert.deepEqual(loadFocus(st, 'prefill', 'config'), ['a|c1'], 'each mode keeps its own focus');
    assert.equal(lineStoreKey('prefill', 'model'), 'models_lines_prefill_model', 'the same key as the picker used');
    assert.deepEqual(JSON.parse(st.m.get('models_lines_prefill_model')), { focused: ['a', 'b'] });
    saveFocus(st, 'prefill', 'model', new Set());
    assert.equal(st.m.has('models_lines_prefill_model'), false, 'nothing focused removes the key');
    assert.deepEqual(loadFocus(st, 'prefill', 'model'), []);
    st.setItem('models_lines_prefill_model', '{not json');
    assert.deepEqual(loadFocus(st, 'prefill', 'model'), []);
    st.setItem('models_lines_prefill_model', JSON.stringify({ focused: ['a', 7, null] }));
    assert.deepEqual(loadFocus(st, 'prefill', 'model'), ['a'], 'non-string ids dropped');
    st.setItem('models_lines_prefill_model', JSON.stringify(['a']));
    assert.deepEqual(loadFocus(st, 'prefill', 'model'), [], 'a value of another shape is nothing focused');
    assert.deepEqual(loadFocus(broken, 'prefill', 'model'), []);
    assert.doesNotThrow(() => saveFocus(broken, 'prefill', 'model', ['a']));
    assert.deepEqual(loadFocus(null, 'prefill', 'model'), []);
    assert.doesNotThrow(() => saveFocus(null, 'prefill', 'model', ['a']));
});

test('the old picker\'s saved "shown" subset hides nothing and focuses nothing after the change', async () => {
    const { loadFocus, resolveFocus, lineLook } = await P();
    const st = memStore();
    st.setItem('models_lines_prefill_model', JSON.stringify({ shown: ['a', 'c'] }));   // 22:5x: "draw only a and c"
    const ids = ['a', 'b', 'c', 'd'];
    const f = resolveFocus(loadFocus(st, 'prefill', 'model'), ids);
    assert.equal(f.size, 0);
    assert.deepEqual(ids.map((id) => lineLook(id, f)), ['normal', 'normal', 'normal', 'normal']);
    st.setItem('models_lines_prefill_config', JSON.stringify({ shown: [] }));            // 22:5x: "none"
    assert.deepEqual(loadFocus(st, 'prefill', 'config'), []);
});

test('stale ids: a focused line no longer on the chart is dropped; if none is left, everything is normal', async () => {
    const { resolveFocus, saveFocus, loadFocus, lineLook } = await P();
    const ids = ['a', 'b', 'c'];
    assert.deepEqual([...resolveFocus(['c', 'gone', 'a'], ids)], ['a', 'c'], 'chart order, the gone id dropped');
    const none = resolveFocus(['gone', 'also-gone'], ids);
    assert.equal(none.size, 0);
    assert.deepEqual(ids.map((id) => lineLook(id, none)), ['normal', 'normal', 'normal'], 'never a chart of only faded lines');
    assert.equal(resolveFocus(null, ids).size, 0);
    // what the page does on every replot: resolve, then save -- the stale id is gone from storage too
    const st = memStore();
    saveFocus(st, 'prefill', 'model', ['a', 'gone']);
    saveFocus(st, 'prefill', 'model', resolveFocus(loadFocus(st, 'prefill', 'model'), ids));
    assert.deepEqual(loadFocus(st, 'prefill', 'model'), ['a']);
});

test('filterLines: every term must match label or config, case-insensitive; empty matches all', async () => {
    const { filterLines } = await P();
    assert.deepEqual(filterLines(series, ''), [0, 1, 2, 3]);
    assert.deepEqual(filterLines(series, '  '), [0, 1, 2, 3]);
    assert.deepEqual(filterLines(series, 'beta'), [1, 2]);
    assert.deepEqual(filterLines(series, 'BETA 3060'), [1], 'the config text counts');
    assert.deepEqual(filterLines(series, 'q4 64k'), [0, 2]);
    assert.deepEqual(filterLines(series, 'nothing'), []);
    assert.deepEqual(filterLines(null, 'x'), []);
});

test('focusLabel: the legend\'s status text', async () => {
    const { focusLabel } = await P();
    assert.equal(focusLabel(0, 23), '23 lines · tap to focus');
    assert.equal(focusLabel(2, 23), '2 of 23 focused');
    assert.equal(focusLabel(0, 1), '1 line · tap to focus');
});

// ---------------------------------------------------------------- charts.js: the legend and the drawing
async function loadCharts(t, { fine = true } = {}) {
    const { parseHTML } = require('linkedom');
    const { window, document } = parseHTML('<!doctype html><html><head></head><body><div id="lg"></div><canvas id="cv"></canvas></body></html>');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-lines-'));
    t.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
    fs.cpSync(path.join(__dirname, '..', 'ui'), path.join(tmp, 'ui'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
    const had = { document: globalThis.document, window: globalThis.window, matchMedia: globalThis.matchMedia };
    globalThis.document = document;
    const configs = [];
    // a Chart.js stand-in: keeps the config, and what update() is asked for
    class FakeChart {
        constructor(_ctx, config) { this.config = config; this.data = config.data; this.options = config.options; this.updates = 0; configs.push(this); }
        update() { this.updates++; }
        destroy() {}
        getDatasetMeta() { return { data: [] }; }
    }
    globalThis.window = { addEventListener() {}, Chart: FakeChart };
    globalThis.matchMedia = (q) => ({ matches: fine && /hover: hover/.test(q) });
    t.after(() => {
        for (const k of ['document', 'window', 'matchMedia']) { if (had[k] === undefined) delete globalThis[k]; else globalThis[k] = had[k]; }
    });
    const cv = document.getElementById('cv'); cv.getContext = () => ({});
    const C = await import(`file://${path.join(tmp, 'ui', 'models', 'charts.js')}`);
    return { C, window, document, configs };
}
const items = Array.from({ length: 14 }, (_, i) => ({ id: `m${i}`, label: i === 3 ? 'Qwen <b>3.8</b> Flash' : `Model ${i}`, config: i % 2 ? 'XTX only' : 'XTX + 3060', n: 100 + i, color: '#3987e5', dash: i > 9 ? [6, 3] : [], row: { key: `m${i}` } }));

test('focusLegend: one >=32 px button per line; a tap hands the caller that id; marks follow set(); clear; filter', async (t) => {
    const { C, document } = await loadCharts(t);
    const el = document.getElementById('lg');
    const taps = []; let clears = 0;
    const lg = C.focusLegend(el, { items, focused: new Set(), onToggle: (id) => taps.push(id), onClear: () => { clears++; }, status: (n, tot) => `${n}/${tot}` });
    assert.ok(document.getElementById('fl-style'), 'its stylesheet is injected once');
    assert.match(document.getElementById('fl-style').textContent, /\.fl-item\{[^}]*min-height:32px/, 'tap targets are at least 32 px tall');
    assert.doesNotMatch(document.getElementById('fl-style').textContent, /line-through/, 'nothing is struck through');
    const btns = el.querySelectorAll('[data-fl-id]');
    assert.equal(btns.length, 14);
    assert.equal(el.querySelector('b'), null, 'labels are escaped (no markup gets through)');
    assert.match(el.querySelector('[data-fl-id="m3"] .fl-name').textContent, /<b>3\.8<\/b>/);
    assert.ok(el.querySelector('[data-fl-id="m12"] line').getAttribute('stroke-dasharray'), 'the swatch carries the dash');
    assert.ok(el.querySelector('.fl-q'), 'more than 12 lines: a find box');
    assert.equal(el.querySelector('[data-fl-clear-wrap]').hidden, true, 'nothing focused: no "clear focus"');
    assert.equal(el.querySelector('[data-fl-count]').textContent, '0/14');
    // taps
    el.onclick({ target: el.querySelector('[data-fl-id="m5"] .fl-name') });
    el.onclick({ target: el.querySelector('[data-fl-id="m7"]') });
    assert.deepEqual(taps, ['m5', 'm7']);
    // the caller decides and sets; the legend only marks
    lg.set(new Set(['m5', 'm7']));
    assert.equal(el.classList.contains('has-focus'), true);
    assert.equal(el.querySelector('[data-fl-id="m5"]').getAttribute('aria-pressed'), 'true');
    assert.equal(el.querySelector('[data-fl-id="m5"]').classList.contains('is-on'), true);
    assert.equal(el.querySelector('[data-fl-id="m1"]').getAttribute('aria-pressed'), 'false');
    assert.equal(el.querySelector('[data-fl-id="m1"]').hidden, false, 'an unfocused entry stays in the legend');
    assert.equal(el.querySelector('[data-fl-clear-wrap]').hidden, false);
    assert.equal(el.querySelector('[data-fl-count]').textContent, '2/14');
    el.onclick({ target: el.querySelector('[data-fl-clear]') });
    assert.equal(clears, 1);
    lg.set(new Set());
    assert.equal(el.classList.contains('has-focus'), false);
    // the find box narrows the LIST only; it does not touch the focus
    const q = el.querySelector('.fl-q'); q.value = 'model 1'; el.oninput({ target: q });
    const visible = [...btns].filter((b) => !b.hidden).map((b) => b.dataset.flId);
    assert.deepEqual(visible, ['m1', 'm10', 'm11', 'm12', 'm13']);
    q.value = 'zzz'; el.oninput({ target: q });
    assert.equal(el.querySelector('.fl-empty').hidden, false);
    assert.equal(taps.length, 2, 'filtering is not a tap');
});

test('focusLegend: hover is mouse-only (a tap never leaves a line emphasised); a replot does not stack handlers', async (t) => {
    const { C, document } = await loadCharts(t);
    const el = document.getElementById('lg');
    const hov = []; let taps = 0;
    C.focusLegend(el, { items, onToggle: () => { taps++; }, onHover: (id) => hov.push(id) });
    const b = el.querySelector('[data-fl-id="m2"]');
    el.onpointerover({ pointerType: 'touch', target: b });
    assert.deepEqual(hov, [], 'touch: no hover');
    el.onpointerover({ pointerType: 'mouse', target: b });
    el.onpointerleave({ pointerType: 'mouse' });
    assert.deepEqual(hov, ['m2', null]);
    const few = items.slice(0, 4);
    C.focusLegend(el, { items: few, focused: new Set(['m0']), onToggle: () => { taps++; } });
    assert.equal(el.querySelector('.fl-q'), null, 'few lines: no find box');
    assert.equal(el.querySelectorAll('[data-fl-id]').length, 4);
    el.onclick({ target: el.querySelector('[data-fl-id="m2"]') });
    assert.equal(taps, 1, 'one handler, not two');
    assert.doesNotThrow(() => C.focusLegend(null, { items }).set(new Set()));
});

test('focusLegend: no hover on a coarse pointer, even for a mouse-typed event', async (t) => {
    const { C, document } = await loadCharts(t, { fine: false });
    const el = document.getElementById('lg');
    const hov = [];
    C.focusLegend(el, { items, onHover: (id) => hov.push(id) });
    el.onpointerover({ pointerType: 'mouse', target: el.querySelector('[data-fl-id="m2"]') });
    assert.deepEqual(hov, []);
});

const pts = (k) => [{ ctx: 1024, tps: 100 + k, n: 5, src: 'requests' }, { ctx: 8192, tps: 80 + k, n: 5, src: 'requests' }];
const lines = ['a', 'b', 'c'].map((k, i) => ({ key: `local:${k}`, label: k, config: 'cfg', n: 10 - i, points: pts(i) }));

test('prefillVsContext: no canvas legend (no hide-on-click), nothing hidden; focus restyles in place, hover and back', async (t) => {
    const { C, configs } = await loadCharts(t);
    const ids = lines.map((s) => s.key);
    const chart = C.prefillVsContext('cv', lines, { ids, focused: new Set() });
    assert.ok(chart && configs.length === 1);
    assert.equal(chart.options.plugins.legend.display, false, 'the HTML legend is the legend');
    assert.equal(chart.options.plugins.legend.onClick, undefined, 'no legend click handler left that could hide a line');
    const ds = chart.data.datasets;
    const widths = () => ds.map((d) => d.borderWidth);
    assert.ok(ds.every((d) => d.hidden === false));
    assert.deepEqual(widths(), [1.75, 1.75, 1.75], 'nothing focused: all normal');
    const base0 = ds[0].borderColor;
    C.setLineFocus(chart, new Set(['local:b']));
    assert.deepEqual(widths(), [1, 3, 1]);
    assert.ok(ds[1].order < ds[0].order && ds[1].order < ds[2].order, 'the focused line draws on top');
    assert.equal(ds[0].borderColor, base0.slice(0, 7) + '38', 'backgrounded: its own hue, faded');
    assert.ok(ds.every((d) => d.hidden === false), 'backgrounded is still drawn');
    C.setLineFocus(chart, new Set(['local:b', 'local:c']));
    assert.deepEqual(widths(), [1, 3, 3]);
    // desktop hover over a backgrounded line: it alone forward; pointer away: the focus set again
    chart.options.onHover({ type: 'mousemove', x: 0, y: 0, native: { pointerType: 'mouse', type: 'mousemove' } }, [], chart);
    C.setLineHover(chart, 'local:a');
    assert.deepEqual(widths(), [3, 1, 1]);
    chart.options.onHover({ type: 'mouseout', native: { type: 'mouseout' } }, [], chart);
    assert.deepEqual(widths(), [1, 3, 3], 'hover off -> back to the focus state');
    // a touch never hovers
    C.setLineHover(chart, null);
    chart.options.onHover({ type: 'mouseout', native: { pointerType: 'touch', type: 'touchend' } }, [], chart);
    assert.deepEqual(widths(), [1, 3, 3]);
    C.setLineFocus(chart, new Set());
    assert.deepEqual(widths(), [1.75, 1.75, 1.75], 'the last focus out: everything surfaces');
    assert.equal(ds[0].borderColor, base0);
    assert.ok(chart.updates >= 4, 'restyled in place (update), not rebuilt');
    assert.equal(configs.length, 1);
    assert.doesNotThrow(() => { C.setLineFocus(null, new Set()); C.setLineHover(null, 'x'); });
});

test('lineLookStyle: every look keeps the line drawn (width > 0, alpha never 0)', async (t) => {
    const { C } = await loadCharts(t);
    for (const look of ['normal', 'focus', 'back', 'unknown']) {
        const s = C.lineLookStyle(look, { border: '#3987e5', bg: '#3987e5cc' });
        assert.ok(s.borderWidth > 0 && s.pointRadius > 0, look);
        assert.ok(!/00$/.test(s.borderColor.slice(7)) || s.borderColor.length === 7, `${look}: not fully transparent`);
    }
    assert.deepEqual(C.lineStyle(0), { color: '#3987e5', dash: [] });
    assert.deepEqual(C.lineStyle(20).dash, [6, 3], 'past the twenty hues, the dash changes');
});

// ---------------------------------------------------------------- install order
// The ui files are live the moment they are saved. charts.js and prefill.js go in first, so they must still export
// every name the index.js BEFORE this change imports (the picker's), and the new index.js only names exports that exist.
test('install order: charts.js / prefill.js export what the old AND the new ui/models/index.js import', async (t) => {
    const { C } = await loadCharts(t);
    const Pm = await P();
    const oldNames = {
        prefill: ['prefillSeries', 'lineIds', 'loadLineSel', 'saveLineSel', 'resolveLineSel', 'encodeLineSel', 'lineSelLabel'],
        charts: ['prefillVsContext', 'applyLineVisibility', 'linePicker', 'lineStyle'],
    };
    const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'models', 'index.js'), 'utf-8');
    const named = (mod) => {
        const m = new RegExp(`import \\{([^}]*)\\} from '\\./${mod}\\.js'`).exec(src);
        return m ? m[1].split(',').map((x) => x.trim().split(/\s+as\s+/)[0]).filter(Boolean) : [];
    };
    for (const n of [...oldNames.prefill, ...named('prefill')]) assert.equal(typeof Pm[n], 'function', `prefill.js exports ${n}`);
    for (const n of [...oldNames.charts, ...named('charts')]) assert.equal(typeof C[n], 'function', `charts.js exports ${n}`);
    // charts.js imports from prefill.js: prefill.js is saved FIRST (a new charts.js on the old prefill.js fails to load)
    const csrc = fs.readFileSync(path.join(__dirname, '..', 'ui', 'models', 'charts.js'), 'utf-8');
    const fromPrefill = (/import \{([^}]*)\} from '\.\/prefill\.js'/.exec(csrc) || [, ''])[1].split(',').map((x) => x.trim()).filter(Boolean);
    assert.ok(fromPrefill.includes('lineLook'));
    for (const n of fromPrefill) assert.equal(typeof Pm[n], 'function', `prefill.js exports ${n} (charts.js imports it)`);
    // and the retired names hide nothing in that window
    const chart = { data: { datasets: [{ hidden: false }] }, setDatasetVisibility() { throw new Error('must not be called'); }, update() {} };
    assert.doesNotThrow(() => C.applyLineVisibility(chart, () => false));
    assert.equal(chart.data.datasets[0].hidden, false);
    assert.deepEqual([...Pm.resolveLineSel(['a'], ['a', 'b'])], ['a', 'b']);
});
