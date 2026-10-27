'use strict';
// Progress beyond the base, and retired tasks (codebench 2026-09-25).
//   1. lib/codebench.js progressOf(): score.py's own `progress` when a row has one; otherwise the
//      same comparison against tasks/<repo>/<id>/baseline.json -- per case when the row recorded its
//      cases, else from the totals (approximate); taskRow() carries the compact form.
//   2. lib/models.js: the fold sums it per task (progressAll).
//   3. task.yaml `retired: true`: parsed, and its old results read as TASK_INVALID (excluded).
// Fixtures live in a temp dir; nothing under the real codebench tree is read or written.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../lib/codebench');
const M = require('../lib/models');

// an invented oracle: four cases the base fails and one it already passes
const BASE = {
    task: 'demo-pager-skips-rows', task_version: 'v1', passed: 1, total: 5, cases_passed: 1, cases_total: 5, usable: true,
    cases: ['case-a', 'case-b', 'case-c', 'case-d'].map((n) => ({ name: n, status: 'fail' })).concat([{ name: 'already-ok', status: 'pass' }]),
};
const casesOf = (passing) => BASE.cases.map((c) => ({ name: c.name, status: passing.includes(c.name) ? 'pass' : 'fail' }));
function blOf(b) {   // readBaselines()' shape
    return { ...b, usable: b.usable !== false, cases: new Map((b.cases || []).map((c) => [c.name, c.status])) };
}
const result = (score, extra = {}) => ({ task: 'demo-pager-skips-rows', status: 'fail', manifest: { task_version: 'v1' }, run: {}, score, ...extra });

test('progressOf: per case against baseline.json -- 2/5 over a base of 1/5 is +1 of 4', () => {
    const p = C.progressOf(result({ assertions: { passed: 2, failed: 3, total: 5 }, fail_to_pass: { cases: casesOf(['already-ok', 'case-a']) } }), blOf(BASE), true);
    assert.deepEqual({ count: p.count, of: p.of, regressions: p.regressions, exact: p.exact, via: p.via }, { count: 1, of: 4, regressions: 0, exact: true, via: 'cases' });
    assert.deepEqual(p.gained, ['case-a']);
});

test('progressOf: a run that breaks a case the base passed is a regression, not "1 of 5"', () => {
    const p = C.progressOf(result({ assertions: { passed: 1, failed: 4, total: 5 }, fail_to_pass: { cases: casesOf(['case-b']) } }), blOf(BASE), true);
    assert.equal(p.count, 1); assert.equal(p.regressions, 1); assert.deepEqual(p.lost, ['already-ok']);
});

test('progressOf: totals only is approximate, and only when the totals match', () => {
    const p = C.progressOf(result({ assertions: { passed: 1, failed: 4, total: 5 } }), blOf(BASE));
    assert.deepEqual({ count: p.count, of: p.of, exact: p.exact, via: p.via }, { count: 0, of: 4, exact: false, via: 'totals' });
    assert.equal(C.progressOf(result({ assertions: { passed: 3, failed: 6, total: 9 } }), blOf(BASE)), null, 'a different oracle size is not comparable');
    assert.equal(C.progressOf(result({}), blOf(BASE)), null, 'no assertions, no cases: nothing to say');
});

test('progressOf: score.py progress wins; a different task_version is flagged stale; unusable baselines give null', () => {
    const own = C.progressOf(result({ progress: { count: 2, of: 4, exact: true, cases: ['case-a', 'case-b'] }, regressions: { count: 0, cases: [] } }), null);
    assert.deepEqual({ count: own.count, of: own.of, via: own.via }, { count: 2, of: 4, via: 'score' });
    const st = C.progressOf(result({ assertions: { passed: 2, failed: 3, total: 5 }, fail_to_pass: { cases: casesOf(['already-ok', 'case-a']) } }, { manifest: { task_version: 'v0' } }), blOf(BASE));
    assert.equal(st.stale, true); assert.equal(st.exact, false);
    assert.equal(C.progressOf(result({ assertions: { passed: 2, failed: 3, total: 5 } }), blOf({ ...BASE, usable: false })), null);
});

test('taskRow reads baseline.json from the configured codebench root', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-progress-'));
    t.after(() => { fs.rmSync(root, { recursive: true, force: true }); C.configure({}); C._resetForTests(); });
    fs.mkdirSync(path.join(root, 'tasks', 'demo-app', 'demo-pager-skips-rows'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tasks', 'demo-app', 'demo-pager-skips-rows', 'baseline.json'), JSON.stringify(BASE));
    C.configure({ root }); C._resetForTests();
    const row = C.taskRow({ file: 'demo-pager-skips-rows__r2.json', data: result({ solved: false, assertions: { passed: 2, failed: 3, total: 5 }, fail_to_pass: { cases: casesOf(['already-ok', 'case-a']) } }) });
    assert.equal(row.progress.count, 1); assert.equal(row.progress.of, 4);
    assert.ok(!('gained' in row.progress), 'the row carries the compact form; case names only via getResult');
    const excluded = C.taskRow({ file: 'x.json', data: result({ assertions: { passed: 2, failed: 3, total: 5 } }, { status: 'PROVIDER_ERROR' }) });
    assert.equal(excluded.progress, null, 'an excluded row is not a model answer: no progress');
});

// ---------------------------------------------------------------- fold + unranked
const row = (task, status, extra = {}) => ({
    dir: extra.dir || 'b1', ended: extra.ended ?? 1000, invalid: false,
    row: { task, status, solved: status === 'pass', tokens_out: 1000, wall_s: 600, tool_calls: 10,
        assertions: extra.assertions ?? null, progress: extra.progress ?? null, p2p: null, p2p_broken: null, anomalies: [], status_derived: false },
});
const META = new Map([
    ['t-a', { id: 't-a', tier: 't1', sample_group: null }],
]);

test('parseTaskYaml: retired: true and its reason', () => {
    const t = M.parseTaskYaml('id: x\nkind: synthetic\nretired: true\nretired_reason: superseded by a better check\n');
    assert.equal(t.retired, true); assert.equal(t.retired_reason, 'superseded by a better check');
    assert.equal(M.parseTaskYaml('id: y\n').retired, undefined, 'absent means part of the suite');
});

test('a retired task: its results are TASK_INVALID (excluded), whatever they said', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-retired-'));
    t.after(() => { fs.rmSync(root, { recursive: true, force: true }); C.configure({}); C._resetForTests(); });
    fs.mkdirSync(path.join(root, 'tasks', '_synthetic', 'old-probe'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tasks', '_synthetic', 'old-probe', 'task.yaml'), 'id: old-probe\nkind: synthetic\nretired: true\nretired_reason: noise\n');
    fs.mkdirSync(path.join(root, 'tasks', '_synthetic', 'kept'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tasks', '_synthetic', 'kept', 'task.yaml'), 'id: kept\nkind: synthetic\n');
    C.configure({ root }); C._resetForTests();
    assert.ok(C.retiredTasks().has('old-probe'));
    assert.equal(C.deriveStatus({ task: 'old-probe__r2', status: 'pass', score: { solved: true } }).status, 'TASK_INVALID');
    assert.equal(C.taskRow({ file: 'old-probe.json', data: { task: 'old-probe', status: 'pass', run: {}, score: { solved: true } } }).excluded, true);
    assert.equal(C.deriveStatus({ task: 'kept', status: 'pass' }).status, 'pass');
});

test('foldQualityRows: progressAll sums over scored runs, approximate if any run is', () => {
    const [s] = M.foldQualityRows([
        row('t-a', 'fail', { progress: { count: 1, of: 4, regressions: 0, exact: true } }),
        row('t-a', 'fail', { dir: 'b2', progress: { count: 0, of: 4, regressions: 1, exact: false } }),
        row('t-a', 'PROVIDER_ERROR', { dir: 'b3', progress: { count: 4, of: 4, regressions: 0, exact: true } }),
    ], META);
    assert.deepEqual(s.progressAll, { count: 1, of: 8, regressions: 1, runs: 2, approx: true });
});

test('mergeTasks: progressAll adds across configs', async () => {
    const L = await import('../ui/shared/leaderboard.js');
    const t = (count, of, regressions, approx) => ({ attempts: 1, passes: 0, credit: 0, progressAll: { count, of, regressions, runs: 1, approx } });
    const merged = L.mergeTasks([{ x: t(1, 4, 0, false) }, { x: t(2, 4, 1, true) }]);
    assert.deepEqual(merged.x.progressAll, { count: 3, of: 8, regressions: 1, runs: 2, approx: true });
});
