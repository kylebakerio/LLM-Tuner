'use strict';
// DIAGNOSTIC tasks (2026-10-17). Kyle on the first one, a long-context recall check: "a special test for
// functionality, like a speed test, that isn't a quality test" -- task.yaml `category: [needle, ctx-scaling, diagnostic]`.
// Out of the strength fit, coverage, task points, solve rates and the planner's candidates; still shown as its own
// result (model page, task page); a fail is not a failed task. lib/models.js readTaskMeta / foldQualityRows /
// foldDiagnosticRows / diagnosticMap / scoredTaskTotal, lib/publicdata.js, ui/models/detail.js diagnosticsCard,
// ui/models/task.js diagnosticOf, ui/autoqueue/derive.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('../lib/models');
const P = require('../lib/publicdata');

function tasks(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-diag-'));
    t.after(() => { fs.rmSync(root, { recursive: true, force: true }); M.configure({}); });
    const task = (repo, id, extra) => { const d = path.join(root, 'tasks', repo, id); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'task.yaml'), `id: ${id}\n${extra || ''}`); };
    task('r', 'fix-a', 'tier_predicted: t1\ncategory: [bugfix]\n');
    task('r', 'fix-b', 'tier_predicted: t2\nextra_tests:\n- test/x.js\n');
    task('_synthetic', 'demo-recall-probe', 'kind: synthetic\ncategory: [needle, ctx-scaling, diagnostic]\ntimeout_s: 7200\n');
    task('_synthetic', 'probe-list', 'category:\n  - diagnostic\n  - speed\nextra_tests:\n- test/y.js\n');   // block list form, with a bonus
    M.configure({ paths: { codebenchRoot: root } });
    return root;
}
const entry = (task, status, ended = 1, extra = {}) => ({ dir: 'bat1', ended, invalid: false, row: { task, status, solved: status === 'pass', wall_s: 300, tokens_out: 900, tool_calls: 4, ran_at: ended, ...extra } });

test('task metadata: category diagnostic marks the task (and its bonus); the suite total and the planner list leave it out', (t) => {
    tasks(t);
    const meta = M.readTaskMeta();
    assert.equal(meta.get('demo-recall-probe').diagnostic, true);
    assert.equal(meta.get('probe-list').diagnostic, true, 'block-list category');
    assert.equal(meta.get('probe-list+bonus').diagnostic, true, 'a diagnostic task\'s bonus is diagnostic too');
    assert.equal(meta.get('fix-a').diagnostic, undefined);
    assert.equal(meta.size, 6);
    assert.equal(M.scoredTaskTotal(meta), 3, 'fix-a, fix-b, fix-b+bonus');
    assert.deepEqual([...M.diagnosticTaskIds()].sort(), ['demo-recall-probe', 'demo-recall-probe+bonus', 'probe-list', 'probe-list+bonus']);
    assert.equal(M.isDiagnosticTask('demo-recall-probe', meta), true);
    assert.equal(M.isDiagnosticTask('nope', meta), false);
});

test('scoring: a diagnostic result is in no sample, no solve rate, no status count -- a failed one is not a fail', (t) => {
    tasks(t);
    const meta = M.readTaskMeta();
    const entries = [entry('fix-a', 'pass'), entry('fix-b', 'pass'), entry('demo-recall-probe', 'fail', 2), entry('demo-recall-probe', 'pass', 3)];
    const samples = M.foldQualityRows(entries, meta);
    assert.deepEqual(samples.map((s) => s.row.task).sort(), ['fix-a', 'fix-b']);
    const q = M.aggregateQuality(samples);
    assert.deepEqual([q.attempted, q.scored, q.solved, q.solveRate, q.counts.fail], [2, 2, 2, 1, 0]);
    // its own result: both runs folded (1 of 2 passed), latest status
    const diag = M.diagnosticMap(M.foldDiagnosticRows(entries, meta));
    assert.deepEqual(Object.keys(diag), ['demo-recall-probe']);
    assert.deepEqual(['diagnostic', 'status', 'attempts', 'passes', 'credit', 'solved', 'excluded'].map((k) => diag['demo-recall-probe'][k]), [true, 'pass', 2, 1, 0.5, true, false]);
    // without metadata nothing is diagnostic (an older codebench checkout): as before
    assert.equal(M.foldQualityRows(entries, new Map()).length, 3);
});

test('public catalog: the diagnostic flag passes the task-metadata whitelist', () => {
    const out = P.sanitizeCatalog({ models: [], taskMeta: { 'demo-recall-probe': { repo: '_synthetic', category: ['needle', 'diagnostic'], diagnostic: true, story: 'private' } } });
    assert.deepEqual(out.taskMeta['demo-recall-probe'], { repo: '_synthetic', category: ['needle', 'diagnostic'], diagnostic: true });
});

test('model page: a Diagnostic tasks card lists the results apart; task page: a config\'s diagnostic result for the task', async () => {
    const { diagnosticsCard } = await import('../ui/models/detail.js');
    assert.equal(diagnosticsCard({ diagnostics: {} }), '');
    const html = diagnosticsCard({ diagnostics: { 'demo-recall-probe': { diagnostic: true, status: 'fail', attempts: 1, passes: 0, wall_s: 1200, ran_at: Date.UTC(2026, 9, 16) } } }, { openTask: () => {} });
    assert.match(html, /Diagnostic tasks/);
    assert.match(html, /not part of the solve rate, coverage, strength or task points; a fail here is not a failed task/);
    assert.match(html, /data-open-task="demo-recall-probe"/);
    assert.match(html, />0\/1</);
    assert.match(html, /2026-10-16/);
    const { diagnosticOf } = await import('../ui/models/task.js');
    const g = { members: [
        { c: { diagnostics: { 'demo-recall-probe': { status: 'fail', attempts: 1, passes: 0, wall_s: 1000, ran_at: 1 } } } },
        { c: { diagnostics: { 'demo-recall-probe': { status: 'pass', attempts: 1, passes: 1, wall_s: 500, ran_at: 2 } } } },
        { c: {} }] };
    const r = diagnosticOf(g, 'demo-recall-probe');
    assert.deepEqual([r.status, r.attempts, r.passes, r.credit, r.wall_s, r.diagnostic], ['pass', 2, 1, 0.5, 750, true]);
    assert.equal(diagnosticOf(g, 'fix-a'), null);
    assert.equal(diagnosticOf({}, 'demo-recall-probe'), null);
});

test('planner: a diagnostic task is never a candidate, even in a catalog that still lists it', async () => {
    const { derive } = await import('../ui/autoqueue/derive.js');
    const tk = (solved) => ({ status: solved ? 'pass' : 'fail', solved, excluded: false, credit: solved ? 1 : 0, attempts: 1, passes: solved ? 1 : 0, wall_s: 300, ran_at: 1 });
    const cfg = (runnerModel, tasks) => ({ key: runnerModel, runnerModel, n_ctx: 131072, timeout_s: 7200, dirs: [runnerModel],
        facets: { weights: 'w', harness: { runnerModel }, context: { n_ctx: 131072 } }, agg: { attempted: Object.keys(tasks).length, scored: Object.keys(tasks).length }, tasks });
    const mk = (key, configs) => ({ key, display: key, weightsKey: key, counts: { qualityTasks: 3 }, quality: {}, configs: configs.map((c) => ({ ...c, facets: { ...c.facets, weights: key } })) });
    const catalog = { allTaskIds: ['a', 'b', 'c', 'demo-recall-probe'], taskMeta: { 'demo-recall-probe': { diagnostic: true } }, models: [
        mk('local:x', [cfg('llama-local/x', { a: tk(1), b: tk(0), c: tk(1) })]), mk('local:y', [cfg('llama-local/y', { a: tk(0), b: tk(0), c: tk(1) })])] };
    const d = derive(catalog, { models: [{ id: 'x', catalogKey: 'local:x', role: 'contender', nCtx: 131072 }] });
    assert.deepEqual(d.input.tasks.map((t) => t.id).sort(), ['a', 'b', 'c']);
});

test('battery summary (lib/codebench.js): a diagnostic result is its own tally, not a pass, fail or scored task', (t) => {
    const C = require('../lib/codebench');
    const root = tasks(t);
    t.after(() => { C._resetForTests(); C.configure({}); });
    const bat = path.join(root, 'results', 'bat1'); fs.mkdirSync(bat, { recursive: true });
    const result = (task, status) => ({ task, runner: 'opencode', model: 'llama-local/x', status,
        manifest: { started_at: '2026-10-16T00:00:00Z', runner: 'opencode', timeout_s: 7200, server: { model_path: '/m/x.gguf', n_ctx: 262144 } },
        run: { wall_s: 600, tokens_in: 1000, tokens_out: 500, tool_calls: 30 }, score: { solved: status === 'pass' } });
    for (const [task, st] of [['fix-a', 'pass'], ['fix-b', 'pass'], ['demo-recall-probe', 'fail']]) fs.writeFileSync(path.join(bat, `${task}.json`), JSON.stringify(result(task, st)));
    C._resetForTests(); C.configure({ root, python: 'python3' });
    const r = C.getRun('bat1', root);
    assert.deepEqual([r.tasks, r.scored, r.solved, r.counts.fail, r.counts.pass], [3, 2, 2, 0, 2]);
    assert.deepEqual(r.diagnostic, { results: 1, passed: 0, tasks: ['demo-recall-probe'] });
    assert.ok(r.rows.some((x) => x.task === 'demo-recall-probe'), 'the row itself is still listed');
    assert.equal(C.isDiagnosticYaml('category: [needle, diagnostic]\n'), true);
    assert.equal(C.isDiagnosticYaml('category:\n  - speed\n  - "diagnostic"\nid: x\n'), true);
    assert.equal(C.isDiagnosticYaml('category: [bugfix]\nnotes: diagnostic\n'), false);
});
