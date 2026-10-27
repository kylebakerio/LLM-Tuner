// Live view difficulty + odds (lib/liveodds.js; Kyle 2026-10-24): per task its /100 difficulty, band and points, and the
// running config's predicted P(solve) at the ability of its Models-page row, found by battery dirs.
const test = require('node:test');
const assert = require('node:assert/strict');
const O = require('../lib/liveodds');

const tk = (s) => ({ status: s ? 'pass' : 'fail', solved: !!s, excluded: false, credit: s, attempts: 1, passes: s });
const sig = (z) => 1 / (1 + Math.exp(-z));

// six rows of rising ability over six tasks of rising difficulty, each row filed under one battery dir
async function setup() {
    const L = await import('../ui/shared/leaderboard.js');
    const ids = ['t0', 't1', 't2', 't3', 't4', 't5'];
    const qAll = [0, 1, 2, 3, 4, 5].map((i) => ({ key: 'g' + i, label: 'Row ' + i, m: { key: 'm' + i, display: 'Model ' + i }, c: {},
        dirs: ['bat' + i], q: { scored: 6 }, tasks: Object.fromEntries(ids.map((t, j) => [t, tk(j <= i ? 1 : 0)])) }));
    const fit = { qAll, adj: L.difficultyAdjusted(qAll) };
    let built = 0;
    const Ls = { overviewView: () => ({}), overviewCatalog: () => ({ models: [] }), fitFor: () => { built += 1; return fit; }, difficultyBand: L.difficultyBand, pSolve: L.pSolve };
    return { L, Ls, fit, built: () => built };
}

test('problemId: the problem a battery task is at its prompt level', () => {
    assert.equal(O.problemId('fix-a', 'L2'), 'fix-a');
    assert.equal(O.problemId('fix-a', ''), 'fix-a');
    assert.equal(O.problemId('fix-a', 'L3'), 'fix-a@L3');
    assert.equal(O.problemId('fix-a', 'L3+careful-tone'), 'fix-a@L3');
    assert.equal(O.problemId('fix-a__r2', 'L2+careful-tone'), 'fix-a');
});

test('liveOdds: difficulty / band / points from the fit, P(solve) at the row the battery is filed under', async () => {
    const { Ls, fit, built } = await setup();
    const A = fit.adj;
    const r = O.liveOdds({ battery: 'bat3', tasks: ['t1', 't4', 'nope'], level: 'L2' }, { catalog: {}, etag: 'e1', L: Ls, queue: null, item: null });
    assert.equal(r.row.label, 'Row 3');
    assert.equal(r.why, null);
    const th = A.get('g3').theta;
    for (const t of ['t1', 't4']) {
        const o = r.tasks[t];
        assert.equal(o.problem, t);
        assert.equal(o.difficulty, A.taskDifficulty100.get(t));
        assert.equal(o.points, A.taskPoints.get(t));
        assert.equal(o.band, Ls.difficultyBand(o.difficulty).word);
        const want = sig((A.taskDiscrimination.get(t) || 1) * (th - (A.taskDifficulty.get(t) + A.meanB)));
        assert.ok(Math.abs(o.p - want) < 1e-12, `${t}: ${o.p} vs ${want}`);
    }
    assert.ok(r.tasks.t1.p > r.tasks.t4.p, 'the easier task has the better odds');
    assert.deepEqual(r.tasks.nope, { problem: 'nope', difficulty: null, band: null, points: null, p: null });
    // the same catalog version: the fit is not rebuilt
    O.liveOdds({ battery: 'bat5', tasks: ['t1'], level: '' }, { catalog: {}, etag: 'e1', L: Ls });
    assert.equal(built(), 1);
    const strong = O.liveOdds({ battery: 'bat5', tasks: ['t4'], level: '' }, { catalog: {}, etag: 'e1', L: Ls });
    assert.ok(strong.tasks.t4.p > r.tasks.t4.p, 'a stronger row has better odds on the same task');
});

test('liveOdds: a fresh battery of a known config finds its row through the queue item\'s identity; an unknown config gets no odds', async () => {
    const { Ls } = await setup();
    const seen = [];
    const queue = { draftDirs: (f) => { seen.push(f.env.CODEBENCH_PROMPT_LEVEL || 'L2'); return new Set(['bat2']); } };
    const item = { id: 7, lane: 'local-gpu', runner: 'opencode', model: 'm', launch_cmd: 'x', timeout_s: 7200, env_json: '{"CODEBENCH_DOCS":"off"}' };
    const r = O.liveOdds({ battery: 'new-battery', tasks: ['t2'], level: '' }, { catalog: {}, etag: 'e2', L: Ls, queue, item });
    assert.equal(r.row.label, 'Row 2');
    assert.ok(r.tasks.t2.p > 0 && r.tasks.t2.p < 1);
    assert.deepEqual(seen, ['L2', 'L3'], 'both prompt levels of the config are looked up');
    const none = O.liveOdds({ battery: 'never-ran', tasks: ['t2'], level: '' }, { catalog: {}, etag: 'e2', L: Ls, queue: null, item: null });
    assert.equal(none.row, null);
    assert.match(none.why, /no Models-page row/);
    assert.equal(none.tasks.t2.p, null);
    assert.ok(none.tasks.t2.difficulty > 0, 'the difficulty still shows');
});
