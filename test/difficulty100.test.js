// Difficulty /100 (Kyle, 2026-10-24): a task's difficulty on the strength scale -- the strength at which a config has a
// 50/50 chance on it -- with its band word and bar on the task page, plus the strength points it is worth.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');

const lb = () => import('../ui/shared/leaderboard.js');
const tk = (s) => ({ status: s ? 'pass' : 'fail', solved: !!s, excluded: false, credit: s, attempts: 1, passes: s, wall_s: 60 });

// six configs of rising ability over six tasks of rising difficulty (config i solves tasks below its rank)
function groups() {
    const ids = ['t0', 't1', 't2', 't3', 't4', 't5'];
    return [0, 1, 2, 3, 4, 5].map((i) => ({ key: 'g' + i, m: { key: 'm' + i, display: 'Model ' + i }, c: {},
        tasks: Object.fromEntries(ids.map((t, j) => [t, tk(j <= i ? 1 : 0)])) }));
}

test('taskDifficulty100: on 0..100, ordered like the fit\'s difficulty, and the points-weighted P(solve) at theta = b', async () => {
    const L = await lb();
    const adj = L.difficultyAdjusted(groups());
    const td = adj.taskDifficulty, d100 = adj.taskDifficulty100;
    assert.ok(d100 instanceof Map && d100.size === td.size);
    for (const v of d100.values()) assert.ok(v > 0 && v < 100, String(v));
    const byB = [...td.keys()].sort((a, b) => td.get(a) - td.get(b));
    for (let i = 1; i < byB.length; i++) assert.ok(d100.get(byB[i]) >= d100.get(byB[i - 1]) - 1e-9, `${byB[i]} vs ${byB[i - 1]}`);
    // the definition, recomputed from the fit's own outputs
    const sig = (z) => 1 / (1 + Math.exp(-z)), A = (t) => adj.taskDiscrimination.get(t) || 1;
    for (const t of td.keys()) {
        let s = 0; for (const [k, p] of adj.taskPoints) s += p * sig(A(k) * (td.get(t) - td.get(k)));
        assert.ok(Math.abs(s - d100.get(t)) < 1e-6, `${t}: ${s} vs ${d100.get(t)}`);
    }
    const pts = [...adj.taskPoints.values()].reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(pts - 100) < 1e-6, String(pts));
});

test('difficultyBand: easy < 20 <= medium < 40 <= hard < 60 <= very hard, by the rounded value', async () => {
    const L = await lb();
    assert.deepEqual([0, 19.4, 20, 39.4, 40, 59.4, 60, 100].map((d) => L.difficultyBand(d).word),
        ['easy', 'easy', 'medium', 'medium', 'hard', 'hard', 'very hard', 'very hard']);
    // by the rounded value the pages show (2026-10-24): 19.6 reads "20", so it is medium
    assert.deepEqual([19.6, 39.5, 59.5].map((d) => L.difficultyBand(d).word), ['medium', 'hard', 'very hard']);
    assert.equal(L.DIFFICULTY_BANDS.length, 4);
});

test('task page: the difficulty card shows /100, the band, a marked bar and the points; log-odds only in the tooltip', async (t) => {
    const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
    const had = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
    globalThis.document = document; globalThis.window = window;
    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({ error: 'no server here' }), text: async () => '' });
    t.after(() => { Object.assign(globalThis, had); });
    const { renderTask, difficultyCard } = await import('../ui/models/task.js');
    const catalog = { taskTotal: 2, allTaskIds: ['fix-a', 'fix-b'], taskMeta: { 'fix-a': { repo: 'r', category: [] }, 'fix-b': { repo: 'r', category: [] } } };
    const gs = [{ key: 'g1', m: { key: 'm1', display: 'Model One' }, c: {}, members: [], dirs: ['d1'], tasks: { 'fix-a': tk(0), 'fix-b': tk(1) }, q: { attempted: 2 } }];
    const adj = { taskDifficulty: new Map([['fix-a', 2.79], ['fix-b', -1.05]]), taskDifficulty100: new Map([['fix-a', 70.2], ['fix-b', 12.4]]),
        taskPoints: new Map([['fix-a', 1.58], ['fix-b', 0.1]]) };
    const ctx = (id) => ({ id, catalog, groups: gs, adj, rows: 'best', setRows() {}, detailHtml: () => '', openModel() {}, openTask() {}, onBack() {} });
    const root = document.getElementById('root');
    renderTask(root, ctx('fix-a'));
    const card = root.querySelector('[data-difficulty]');
    assert.ok(card, 'difficulty card present');
    assert.equal(card.getAttribute('data-difficulty'), '70.2');
    const text = card.textContent.replace(/\s+/g, ' ');
    assert.match(text, /70\s*\/ 100/);
    assert.match(text, /very hard/);
    assert.match(text, /worth 1\.58 of 100 points/);
    assert.match(text, /hardest 1 of 2/);
    assert.ok(!/\+2\.79/.test(text), 'the log-odds value is not on the card face');
    assert.match(card.getAttribute('title'), /log-odds difficulty: \+2\.79/);
    assert.match(card.innerHTML, /left:calc\(70\.2% - 1\.5px\)/, 'the marker sits at the value');
    renderTask(root, ctx('fix-b'));
    assert.match(root.querySelector('[data-difficulty]').textContent, /easy/);
    // not placed: the old dash card, nothing invented
    assert.match(difficultyCard(null, null, null, { diagnostic: true }), /diagnostic task — not in the fit/);
    assert.match(difficultyCard({ d: 0.5, text: 'hardest 3 of 9' }, 45, 0, { unscored: true }), /not scored yet: 0 points/);
});
