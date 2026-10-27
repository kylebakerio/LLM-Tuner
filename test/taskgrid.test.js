'use strict';
// ui/models/charts.js taskGrid: the Solve map painted straight on one canvas (2026-10-21, Kyle: "the solve map should
// probably be rendered as a canvas"), not a Chart.js chart with one dataset per task. Checked here with a recording 2D
// context: every cell is painted in its row's colour for the task in that column (rows and order exactly as handed in),
// the geometry is Chart.js's (category rows, a linear 0..n x axis, 86% bars), a point maps back to its (row, task),
// clicks and the hover readout reach the right cell, and the registry can destroy it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

async function load(t, { width = 1000, height = 160, dpr = 2 } = {}) {
    const { parseHTML } = require('linkedom');
    const { document } = parseHTML('<!doctype html><html><head></head><body><div id="box"><canvas id="cv"></canvas></div></body></html>');
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-grid-'));
    t.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
    fs.cpSync(path.join(__dirname, '..', 'ui'), path.join(tmp, 'ui'), { recursive: true, filter: (s) => !/\.bak/.test(s) });
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
    const keys = ['document', 'window', 'Path2D', 'ResizeObserver', 'requestAnimationFrame', 'cancelAnimationFrame'];
    const had = Object.fromEntries(keys.map((k) => [k, globalThis[k]]));
    t.after(() => { for (const k of keys) { if (had[k] === undefined) delete globalThis[k]; else globalThis[k] = had[k]; } });
    globalThis.document = document;
    globalThis.window = { devicePixelRatio: dpr, addEventListener() {}, innerWidth: 1400, innerHeight: 900 };
    globalThis.requestAnimationFrame = (f) => setTimeout(f, 0); globalThis.cancelAnimationFrame = (h) => clearTimeout(h);
    delete globalThis.ResizeObserver;
    // a Path2D that keeps its boxes
    globalThis.Path2D = class { constructor() { this.boxes = []; } rect(x, y, w, h) { this.boxes.push({ x, y, w, h }); } roundRect(x, y, w, h) { this.boxes.push({ x, y, w, h }); } };
    const fills = [];   // { color, boxes } per ctx.fill(path)
    const ctx = new Proxy({ fillStyle: '', strokeStyle: '', font: '', lineWidth: 1, textAlign: 'left', textBaseline: 'alphabetic', shadowBlur: 0, shadowColor: '', lineCap: '', lineJoin: '',
        fill(p) { if (p && p.boxes) fills.push({ color: this.fillStyle, boxes: p.boxes }); },
        measureText: (s) => ({ width: String(s).length * 6 }),
        createLinearGradient: () => ({ addColorStop() {} }),
        transforms: [], setTransform(...a) { this.transforms.push(a); },
    }, { get: (o, k) => (k in o ? o[k] : () => {}), set: (o, k, v) => { o[k] = v; return true; } });
    const box = document.getElementById('box'), cv = document.getElementById('cv');
    Object.defineProperty(box, 'clientWidth', { value: width }); Object.defineProperty(box, 'clientHeight', { value: height });
    cv.getContext = () => ctx;
    cv.getBoundingClientRect = () => ({ left: 0, top: 0, right: width, bottom: height, width, height });
    const C = await import(`file://${path.join(tmp, 'ui', 'models', 'charts.js')}`);
    const L = await import(`file://${path.join(tmp, 'ui', 'shared', 'leaderboard.js')}`);
    return { C, L, document, cv, ctx, fills };
}

const P = (x = {}) => ({ status: 'pass', credit: 1, solved: true, passes: 1, attempts: 1, ...x });
const F = (x = {}) => ({ status: 'fail', credit: 0, solved: false, passes: 0, attempts: 1, ...x });
const T = (x = {}) => ({ status: 'TIMEOUT', credit: 0, solved: false, passes: 0, attempts: 1, ...x });
// three rows; the order is NOT alphabetical, and one task (t5) nobody ran
const rows = [
    { key: 'a', label: 'A row', name: 'A', strength: 60, lo: 50, hi: 70, coverage: 0.8, tasks: { t1: P(), t2: F(), t3: P(), t4: T() } },
    { key: 'b', label: 'B row', name: 'B', strength: 50, lo: 40, hi: 60, coverage: 0.5, tasks: { t1: F(), t3: P() } },
    { key: 'c', label: 'C row', name: 'C', tasks: { t2: P(), t4: P(), t1: P({ credit: 0.5, passes: 1, attempts: 2 }) } },
];
const order = ['t3', 't1', 't4', 't2', 't5'];

test('taskGrid paints every cell in its row\'s colour for the task in its column, one fill per colour, on a canvas sized to its box at the device pixel ratio', async (t) => {
    const { C, L, cv, fills, ctx } = await load(t);
    const G = C.taskGrid('cv', rows, order, null, { order });
    assert.ok(G && typeof G.draw === 'function');
    assert.deepEqual([cv.width, cv.height], [2000, 320], 'box 1000 x 160 at devicePixelRatio 2');
    assert.deepEqual(ctx.transforms.at(-1), [2, 0, 0, 2, 0, 0]);
    assert.deepEqual(G.chartArea, { left: 420, top: 30, right: 998, bottom: 158, width: 578, height: 128 }, 'the label table, the 30 px header, 2 px right');
    const cellFills = fills.filter((f) => f.boxes.length);
    assert.equal(new Set(cellFills.map((f) => f.color)).size, cellFills.length, 'one path per colour');
    const colorAt = (ri, col) => {
        const cx = G.scales.x.getPixelForValue(col + 0.5), cy = G.scales.y.getPixelForValue(ri);
        const hit = cellFills.filter((f) => f.boxes.some((b) => cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h));
        assert.equal(hit.length, 1, `exactly one fill covers cell ${ri},${col}`);
        return hit[0].color;
    };
    const PASS = L.STATUS_COLOR.pass, FAIL = L.STATUS_COLOR.fail, TO = L.STATUS_COLOR.TIMEOUT;
    const MISSING = 'rgba(148,163,184,0.14)';
    const want = [
        [PASS, PASS, TO, FAIL, MISSING],          // a: t3 t1 t4 t2 t5
        [PASS, FAIL, MISSING, MISSING, MISSING],  // b
        [MISSING, PASS, PASS, PASS, MISSING],     // c: t1 is a pass/fail mix -> green base (its red share goes on top)
    ];
    want.forEach((cols, ri) => cols.forEach((c, col) => assert.equal(colorAt(ri, col), c, `row ${ri} col ${col} (${order[col]})`)));
    const total = cellFills.reduce((n, f) => n + f.boxes.length, 0);
    assert.equal(total, rows.length * order.length, 'one box per row and task, nothing else');
    // boxes: 86% of the row band, centred; 578/5 = 115.6 px wide cells get the 1 px desktop gap
    const b = cellFills.flatMap((f) => f.boxes).find((x) => x.x < 422 && x.y < 40);
    const step = 128 / 3;
    assert.ok(Math.abs(b.h - (step * 0.86 - 2)) < 1e-9 && Math.abs(b.y - (30 + step / 2 - step * 0.43 + 1)) < 1e-9);
});

test('gridGeometry / gridCellAt: the row and column under a point; nothing in the labels, the gaps between bars, or past the plot', async (t) => {
    const { C } = await load(t);
    const geo = C.gridGeometry(1000, 160, { nRows: 3, nCols: 5, labelW: 420, padTop: 30, padRight: 2 });
    const at = (x, y) => C.gridCellAt(geo, 3, 5, x, y);
    const cx = (col) => geo.x.getPixelForValue(col + 0.5), cy = (ri) => geo.y.getPixelForValue(ri);
    assert.deepEqual(at(cx(2), cy(1)), { ri: 1, col: 2 });
    assert.deepEqual(at(cx(4), cy(2)), { ri: 2, col: 4 });
    assert.deepEqual(at(geo.x.getPixelForValue(1) + 0.01, cy(0)), { ri: 0, col: 1 }, 'the left edge of a column is that column');
    assert.equal(at(100, cy(1)), null, 'the label table');
    assert.equal(at(cx(2), cy(1) + geo.y.step / 2 - 0.5), null, 'the 14% gap between two bars');
    assert.equal(at(999, cy(1)), null, 'past the plot');
    assert.equal(at(cx(2), 10), null, 'the header strip');
    for (let ri = 0; ri < 3; ri++) assert.equal(Math.round(geo.y.getValueForPixel(cy(ri))) || 0, ri, 'pixel <-> row round-trips');
});

test('clicks: a cell goes to onCell with its task and row, a label to onPick; the hover readout names the row, the task and its outcome', async (t) => {
    const { C, cv, document } = await load(t);
    const cells = [], picks = [];
    const G = C.taskGrid('cv', rows, order, (key) => picks.push(key), { order, onCell: (task, r, e, info) => cells.push([task, r.key, info.cell.t]) });
    const cx = (col) => G.scales.x.getPixelForValue(col + 0.5), cy = (ri) => G.scales.y.getPixelForValue(ri);
    cv.onclick({ clientX: cx(3), clientY: cy(0) });
    cv.onclick({ clientX: cx(0), clientY: cy(2) });
    cv.onclick({ clientX: 50, clientY: cy(1) });
    assert.deepEqual(cells, [['t2', 'a', 'fail'], ['t3', 'c', 'not attempted']]);
    assert.deepEqual(picks, ['b']);
    // the readout: a mouse over a cell
    const ev = new document.defaultView.Event('pointermove');
    Object.assign(ev, { pointerType: 'mouse', clientX: cx(2), clientY: cy(0) });
    cv.dispatchEvent(ev);
    const tip = document.querySelector('.tg-tip');
    assert.ok(tip, 'one tooltip element on the page');
    assert.equal(tip.style.display, 'block');
    assert.match(tip.textContent, /A row/);
    assert.match(tip.textContent, /t4: TIMEOUT/);
    assert.match(tip.textContent, /solved by 1\/2 models here/);
    // touch never raises it
    const touch = new document.defaultView.Event('pointerdown'); Object.assign(touch, { pointerType: 'touch', clientX: cx(2), clientY: cy(0) });
    cv.dispatchEvent(touch);
    assert.equal(tip.style.display, 'none');
});

test('without onCell a plot click picks the row; the registry destroys it (destroyAll) and a destroyed grid draws nothing', async (t) => {
    const { C, cv, document, fills } = await load(t);
    const picks = [];
    const G = C.taskGrid('cv', rows, order, (key) => picks.push(key), { order });
    const ev = new document.defaultView.Event('click');
    Object.assign(ev, { clientX: G.scales.x.getPixelForValue(1.5), clientY: G.scales.y.getPixelForValue(2) });
    cv.dispatchEvent(ev);
    assert.deepEqual(picks, ['c']);
    await new Promise((r) => setTimeout(r, 10));   // the click's deferred card check runs while the stand-in DOM is up
    C.destroyAll();
    const n = fills.length;
    G.draw();
    assert.equal(fills.length, n, 'destroyed: no paint');
    assert.equal(cv.onclick, null);
    // a new grid on the same canvas replaces the old one in the registry
    const G2 = C.taskGrid('cv', rows.slice(0, 1), order, null, { order });
    assert.notEqual(G2, G);
    assert.ok(fills.length > n);
});

test('queued cells (row.planned, 2026-10-24): a blue dot in the middle of each, none on the running cell or at phone width; the readout says so', async (t) => {
    const { C, cv, ctx, document } = await load(t);
    const dots = [];
    ctx.arc = function (x, y, r) { dots.push({ x, y, r, at: () => this.fillStyle }); };
    const fillsAt = [];
    const fill0 = ctx.fill;
    ctx.fill = function (p) { if (!p) fillsAt.push(this.fillStyle); return fill0.call(this, p); };
    const rs = rows.map((r) => ({ ...r }));
    rs[0].running = new Set(['t4']); rs[0].planned = new Set(['t2', 't4', 'nope']);
    rs[1].planned = new Set(['t5']);
    const G = C.taskGrid('cv', rs, order, null, { order });
    const cx = (col) => (G.scales.x.getPixelForValue(col) + G.scales.x.getPixelForValue(col + 1)) / 2, cy = (ri) => G.scales.y.getPixelForValue(ri);
    const centres = [...new Set(dots.map((d) => `${Math.round(d.x)},${Math.round(d.y)}`))];
    assert.deepEqual(centres.sort(), [`${Math.round(cx(3))},${Math.round(cy(0))}`, `${Math.round(cx(4))},${Math.round(cy(1))}`].sort(),
        'row a: t2 (col 3) only -- t4 is running, `nope` has no column; row b: t5 (col 4)');
    assert.ok(fillsAt.includes('#60a5fa'), 'the dot is blue');
    const ev = new document.defaultView.Event('pointermove');
    Object.assign(ev, { pointerType: 'mouse', clientX: cx(3), clientY: cy(0) });
    cv.dispatchEvent(ev);
    assert.match(document.querySelector('.tg-tip').textContent, /queued: a running battery/);
    // the full map has ~240 columns, so its cells are often 3-6 px: 150 columns over the 578 px plot (3.9 px) still get a
    // (ringless) dot that fits the cell; 300 (1.9 px, phone-like) get none
    const many = (n) => Array.from({ length: n }, (_, i) => 'x' + i);
    const grid = (ids) => { dots.length = 0; return C.taskGrid('cv', [{ key: 'w', label: 'W', name: 'W', tasks: Object.fromEntries(ids.map((x) => [x, P()])), planned: new Set(ids.slice(0, 5)) }], ids, null, { order: ids }); };
    const g150 = grid(many(150));
    assert.equal(g150.chartArea.width, 578);
    assert.equal(dots.length, 5, 'a 3.9 px cell: one dot each, no ring');
    assert.ok(dots.every((d) => d.r >= 1 && d.r * 2 <= 578 / 150 + 0.5), 'and it fits inside the cell');
    grid(many(300));
    assert.equal(dots.length, 0, 'under 2.5 px: no dot');
});
