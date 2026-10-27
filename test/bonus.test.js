'use strict';
// Bonus tests as their own results (2026-10-14, Kyle: "one test run can produce two test results") and the config
// report card ("good at X, weak at Y"). lib/codebench.js bonusRow / resultRows, lib/models.js task metadata + skill tags,
// lib/publicdata.js (tags public, bonus notes private), ui/shared/leaderboard.js reportCard / tagDelta.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../lib/codebench');
const M = require('../lib/models');
const P = require('../lib/publicdata');
const loadLb = () => import('../ui/shared/leaderboard.js');

const result = (task, status, extra, wall = 600) => ({
    task, runner: 'opencode', model: 'llama-local/x', status,
    manifest: { started_at: '2026-10-14T00:00:00Z', runner: 'opencode', timeout_s: 7200, server: { model_path: '/m/x.gguf', n_ctx: 131072 } },
    run: { wall_s: wall, tokens_in: 1000, tokens_out: 500, tool_calls: 30 }, timeline: { edits: 3 },
    score: { solved: status === 'pass', assertions: { passed: 4, failed: 0, total: 4 }, ...(extra ? { extra } : {}) },
});
function scene(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-bonus-'));
    t.after(() => { fs.rmSync(root, { recursive: true, force: true }); C._resetForTests(); C.configure({}); M.configure({}); });
    const bat = path.join(root, 'results', 'bat1'); fs.mkdirSync(bat, { recursive: true });
    const put = (j) => fs.writeFileSync(path.join(bat, `${j.task}.json`), JSON.stringify(j));
    put(result('t1', 'pass', { passed: 1, total: 3, all: false, ran_any: true, skill: 'robust failure handling', cases: [{ name: 'c1', status: 'pass' }] }));
    put(result('t2', 'PROVIDER_ERROR', { passed: 2, total: 2, all: true, ran_any: true }));
    put(result('t3', 'fail', null));
    put(result('t6', 'fail', { passed: 0, total: 0, all: false, ran_any: false }));   // the bonus never ran: one result only
    const task = (id, extra) => { const d = path.join(root, 'tasks', 'r', id); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'task.yaml'), `id: ${id}\nrepo: /x\ntier_predicted: t1\ntimeout_s: 7200\n${extra || ''}`); };
    task('t1', "extra_tests:\n- test/extra_t1.test.js\nextra_skill: 'robust failure handling'\n");
    task('t2', 'extra_tests:\n- test/extra_t2.test.js\n');
    task('t3');
    task('t4', 'retired: true\nextra_tests:\n- test/x.js\n');
    task('t5', 'hold: true\nextra_tests:\n- test/x.js\n');
    task('t7', 'extra_tests: []\n');
    fs.writeFileSync(path.join(root, 'tasks', 'skills.json'), JSON.stringify({ tags: { 'error-handling': 'failure paths', 'edge-cases': 'boundaries' },
        tasks: { t1: ['error-handling', 'edge-cases'], t3: ['edge-cases', 'not-a-tag'] } }));
    C._resetForTests(); C.configure({ root, python: 'python3' });
    return { root };
}

test('bonus: a result whose bonus ran is two rows; the bonus carries none of the run cost', (t) => {
    const { root } = scene(t);
    const r = C.getRun('bat1', root);
    assert.deepEqual(r.rows.map((x) => x.task), ['t1', 't1+bonus', 't2', 't2+bonus', 't3', 't6']);
    const b = r.rows.find((x) => x.task === 't1+bonus');
    assert.equal(b.bonus, true); assert.equal(b.parent, 't1'); assert.equal(b.bonus_skill, 'robust failure handling');
    assert.equal(b.status, 'fail'); assert.equal(b.solved, false); assert.equal(b.excluded, false);
    assert.deepEqual(b.assertions, { passed: 1, failed: 2, total: 3 });
    for (const k of ['wall_s', 'tokens_in', 'tokens_out', 'tool_calls', 'edits']) assert.equal(b[k], null, k);
    assert.equal(r.rows.find((x) => x.task === 't1').wall_s, 600);
    // an excluded run (not a model answer) makes its bonus excluded too, whatever the bonus said
    const b2 = r.rows.find((x) => x.task === 't2+bonus');
    assert.equal(b2.status, 'PROVIDER_ERROR'); assert.equal(b2.excluded, true); assert.equal(b2.solved, true);   // solved = extra.all, like the main row
    // battery summary: `tasks` counts files (runs), the results are counted with their bonus
    assert.equal(r.tasks, 4); assert.equal(r.bonus, 2);
    assert.equal(r.scored, 4); assert.equal(r.solved, 1); assert.equal(r.excluded, 2);   // t1, t1+bonus, t3, t6 | t2, t2+bonus
    // one bonus result opens over its parent's file; its cases are the bonus test's
    const g = C.getResult('bat1', 't1+bonus', root);
    assert.equal(g.task, 't1+bonus'); assert.equal(g.row.status, 'fail'); assert.equal(g.bonus.parent, 't1');
    assert.deepEqual(C.listTaskCases('t1+bonus', root).map((x) => [x.task, x.cases.length]), [['t1+bonus', 1]]);
    assert.throws(() => C.getResult('bat1', 't3+bonus', root), /no bonus test result/);
});

test('bonus: task metadata gives <id>+bonus its parent\'s, labelled; retired / held parents take it along; skill tags', (t) => {
    const { root } = scene(t);
    M.configure({ paths: { codebenchRoot: root } });
    const meta = M.readTaskMeta();
    const b = meta.get('t1+bonus');
    assert.ok(b && b.bonus); assert.equal(b.parent, 't1'); assert.equal(b.label, 't1 (bonus)'); assert.equal(b.tier, 't1'); assert.equal(b.timeout_s, 7200);
    assert.equal(b.sample_group, null); assert.equal(b.extra_skill, 'robust failure handling');
    assert.ok(meta.has('t2+bonus')); assert.ok(!meta.has('t3+bonus')); assert.ok(!meta.has('t7+bonus'));   // `extra_tests: []` is none
    const gone = M.retiredTaskIds();
    assert.ok(gone.has('t4') && gone.has('t4+bonus'));                 // retired parent: both gone
    assert.ok(!gone.has('t5') && gone.has('t5+bonus') && meta.has('t5') && !meta.has('t5+bonus'));   // held: its bonus waits
    assert.deepEqual(M.skillsOf('t1'), ['error-handling', 'edge-cases']);
    assert.deepEqual(M.skillsOf('t1+bonus'), ['error-handling', 'edge-cases']);   // the parent's tags
    assert.deepEqual(M.skillsOf('t3'), ['edge-cases']);                           // an unknown tag is dropped
});

test('bonus: solves per hour counts only results that carry the hours; nothing else changes', () => {
    const row = (task, status, wall, bonus) => ({ task, status, wall_s: wall, tokens_out: wall ? 100 : null, tool_calls: wall ? 5 : null, ...(bonus ? { bonus: true } : {}) });
    const s = (r) => ({ row: r, runs: [{ row: r }], attempts: 1, passes: r.status === 'pass' ? 1 : 0, credit: r.status === 'pass' ? 1 : 0 });
    const q = M.aggregateQuality([s(row('a', 'pass', 3600)), s(row('a+bonus', 'pass', null, true)), s(row('b', 'fail', 3600))]);
    assert.equal(q.solved, 2); assert.equal(q.scored, 3);
    assert.equal(q.solvesPerHour, 0.5);          // 1 timed solve over 2 h, not 2
    assert.equal(q.wallPerSolve.n, 1); assert.equal(q.tokensPerSolve.n, 1);
});

test('bonus: the public catalog keeps a bonus task\'s names and the skill tags (public since 2026-10-14), not its note', () => {
    const cat = { models: [], skillTags: { 'edge-cases': 'boundaries' },
        taskMeta: { 'x+bonus': { repo: 'r', tier: 't1', bonus: true, parent: 'x', label: 'x (bonus)', bonus_note: 'secret fix sha abc', skills: ['edge-cases'], probes: 'p' } } };
    const out = P.sanitizeCatalog(cat);
    assert.deepEqual(out.taskMeta['x+bonus'], { repo: 'r', tier: 't1', bonus: true, parent: 'x', label: 'x (bonus)', skills: ['edge-cases'] });
    assert.deepEqual(out.skillTags, { 'edge-cases': 'boundaries' });
    assert.ok(!/secret|"p"/.test(JSON.stringify(out)));
});

test('report card: tagDelta is the exact posterior of a tag shift; no evidence, no shift', async () => {
    const { tagDelta } = await loadLb();
    const none = tagDelta([], 0, 0.5);
    assert.ok(Math.abs(none.mean) < 1e-9 && none.lo < 0 && none.hi > 0);
    const up = tagDelta(Array.from({ length: 30 }, () => [1, 0, 1, 1]), 0, 0.5);
    const down = tagDelta(Array.from({ length: 30 }, () => [1, 0, 0, 1]), 0, 0.5);
    assert.ok(up.lo > 0 && Math.abs(up.mean + down.mean) < 1e-6);   // symmetric
    const two = tagDelta([[1, 0, 1, 1], [1, 0, 1, 1]], 0, 0.5);       // two passes: the prior holds it near 0
    assert.ok(two.lo < 0 && two.hi > 0);
});

test('report card: a config much better on one tag than overall gets it as a strength; a tag it never ran is "not run"', async () => {
    const { difficultyAdjusted, reportCard } = await loadLb();
    // 40 tasks, 20 tagged "x" and 20 "y"; 30 configs pass by ability; config "S" passes every x task and fails most y
    const tasks = Array.from({ length: 40 }, (_, i) => `t${i}`);
    const taskMeta = Object.fromEntries(tasks.map((t, i) => [t, { skills: [i < 20 ? 'x' : 'y'] }]));
    taskMeta.extra = { skills: ['z'] };
    let seed = 3; const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const groups = [];
    for (let g = 0; g < 30; g++) {
        const th = -1.5 + 3 * g / 29, tk = {};
        tasks.forEach((t, i) => { const b = -2 + 4 * (i % 20) / 19; const y = rnd() < 1 / (1 + Math.exp(-(th - b))) ? 1 : 0; tk[t] = { credit: y, attempts: 1, passes: y }; });
        groups.push({ key: 'g' + g, tasks: tk });
    }
    const sk = {}; tasks.forEach((t, i) => { const y = i < 20 ? 1 : (i % 20 < 4 ? 1 : 0); sk[t] = { credit: y, attempts: 1, passes: y }; });
    groups.push({ key: 'S', tasks: sk });
    const adj = difficultyAdjusted(groups);
    const rc = reportCard(groups[groups.length - 1], adj, taskMeta, { x: 'X things', y: 'Y things', z: 'Z' });
    const by = Object.fromEntries(rc.tags.map((r) => [r.tag, r]));
    assert.equal(by.x.call, 'strength'); assert.equal(by.y.call, 'weakness');
    assert.equal(by.z.ran, 0); assert.equal(by.z.call, null);
    assert.equal(by.x.ran, 20); assert.equal(by.x.tagged, 20); assert.equal(by.x.def, 'X things');
    assert.match(rc.summary, /^Good at x; weak at y\.$/);
    assert.ok(by.x.score > by.y.score);
    // a config in the middle of the pack: nothing to say
    const mid = reportCard(groups[15], adj, taskMeta, {});
    assert.equal(mid.strengths.length + mid.weaknesses.length, 0);
    assert.match(mid.summary, /^No clear strengths or weaknesses/);
    // no tags anywhere, or a config outside the fit: no card
    assert.equal(reportCard(groups[0], adj, {}, {}), null);
    assert.equal(reportCard({ key: 'nope', tasks: {} }, adj, taskMeta, {}), null);
});

test('bonus: client-side solves per hour (qualityMetricsFor) does not count a bonus solve against hours it did not spend', async () => {
    const { qualityMetricsFor } = await loadLb();
    const q = qualityMetricsFor({ a: { solved: true, credit: 1, wall_s: 3600, tokens_out: 100 }, 'a+bonus': { solved: true, credit: 1, wall_s: null, tokens_out: null }, b: { solved: false, credit: 0, wall_s: 3600 } });
    assert.equal(q.solved, 2); assert.equal(q.solvesPerHour, 0.5); assert.equal(q.wallPerSolve, 3600); assert.equal(q.tokensPerSolve, 100);
});
