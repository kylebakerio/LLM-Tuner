'use strict';
// OVERFLOWED, THEN PASSED (2026-10-24, Kyle: "these should be 'dark green' cases"). codebench harness/status.py now scores a
// run whose conversation outgrew the context window (a runner-reported context overflow) and whose hidden tests pass as
// `pass`, keeping "context_overflow" in the result's `anomalies`; an overflow that did not solve stays OVERFLOW (excluded).
// Such a pass is a pass under special conditions: the dark green, with its own note. Display only -- attempts, passes,
// credit and every count are untouched.
//  - lib/models.js overflowedOfRuns -> `overflowed: { passed }` on taskMap / configsFor tasks / qualityDetail samples /
//    diagnosticMap; public (counts only, like `answered`'s);
//  - ui/benchmarks/util.js specialPassNotes (the Solve map's fill, hover and edge) and overflowChip (the tables);
//  - ui/shared/leaderboard.js mergeTasks pools it; ui/models/task.js diagnosticOf sums it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../lib/annotations');
const M = require('../lib/models');
const { sanitizeCatalog, sanitizePayload } = require('../lib/publicdata');

const NOTE = 'passed after the conversation outgrew the context window (the agent compacted and carried on)';
const OVF = ['context_overflow', 'run_terminated_early', 'compaction_thrash'];

// ---------------------------------------------------------------- pure: the mark over a task's runs
const run = (status, anomalies = [], dir = 'b1') => ({ dir, row: { task: 'tk', status, anomalies } });

test('overflowedOfRuns: passing scored runs with context_overflow; nothing for a plain pass, a fail, or an excluded overflow', () => {
    assert.deepStrictEqual(M.overflowedOfRuns([run('pass', OVF)]), { passed: 1 });
    assert.deepStrictEqual(M.overflowedOfRuns([run('pass*', ['context_overflow'])]), { passed: 1 }, 'pass* counts too');
    assert.deepStrictEqual(M.overflowedOfRuns([run('pass', OVF), run('pass', []), run('pass', OVF, 'b2')]), { passed: 2 });
    assert.strictEqual(M.overflowedOfRuns([run('pass', [])]), null, 'a passing run without it');
    assert.strictEqual(M.overflowedOfRuns([run('pass', ['patch_apply_failed'])]), null, 'another anomaly is not it');
    assert.strictEqual(M.overflowedOfRuns([run('fail', OVF)]), null, 'a failing run with it');
    assert.strictEqual(M.overflowedOfRuns([run('TIMEOUT', OVF)]), null);
    assert.strictEqual(M.overflowedOfRuns([run('OVERFLOW', OVF)]), null, 'an unsolved overflow is excluded');
    assert.strictEqual(M.overflowedOfRuns([{ dir: 'b', row: { task: 'tk', status: 'pass' } }]), null, 'no anomalies list');
    assert.strictEqual(M.overflowedOfRuns([]), null);
    assert.strictEqual(M.overflowedOfRuns(undefined), null);
});

test('foldQualityRows / diagnosticMap carry it, and the score is untouched', () => {
    const e = (task, status, anomalies, ended, dir = 'b1') => ({ dir, ended, invalid: false, row: { task, status, solved: status === 'pass', anomalies, wall_s: 300, tokens_out: 900, tool_calls: 4, ran_at: ended } });
    const entries = [e('ov', 'pass', OVF, 1), e('plain', 'pass', [], 2), e('ovfail', 'fail', OVF, 3), e('ovexcl', 'OVERFLOW', OVF, 4),
        e('mixed', 'pass', [], 5), e('mixed', 'pass', OVF, 6, 'b2'), e('split', 'pass', OVF, 7), e('split', 'fail', [], 8, 'b2')];
    const by = Object.fromEntries(M.foldQualityRows(entries, new Map()).map((s) => [s.row.task, s]));
    assert.deepStrictEqual(by.ov.overflowed, { passed: 1 });
    assert.deepStrictEqual([by.ov.attempts, by.ov.passes, by.ov.credit], [1, 1, 1], 'credit untouched');
    assert.strictEqual(by.plain.overflowed, null);
    assert.strictEqual(by.ovfail.overflowed, null);
    assert.deepStrictEqual([by.ovfail.attempts, by.ovfail.passes, by.ovfail.credit], [1, 0, 0]);
    assert.strictEqual(by.ovexcl.overflowed, null);
    assert.strictEqual(by.ovexcl.attempts, 0, 'OVERFLOW stays excluded');
    assert.deepStrictEqual([by.mixed.overflowed, by.mixed.passes], [{ passed: 1 }, 2]);
    assert.deepStrictEqual([by.split.overflowed, by.split.credit], [{ passed: 1 }, 0.5]);
    // a diagnostic task (demo-recall-probe) has no grid cell: its own map carries the mark
    const meta = new Map([['demo-recall-probe', { diagnostic: true }]]);
    const diag = M.diagnosticMap(M.foldDiagnosticRows([e('demo-recall-probe', 'pass', OVF, 9), e('fix', 'pass', OVF, 10)], meta));
    assert.deepStrictEqual(Object.keys(diag), ['demo-recall-probe']);
    assert.deepStrictEqual(diag['demo-recall-probe'].overflowed, { passed: 1 });
    assert.strictEqual(M.diagnosticMap(M.foldDiagnosticRows([e('demo-recall-probe', 'fail', OVF, 9)], meta))['demo-recall-probe'].overflowed, undefined);
});

// ---------------------------------------------------------------- end to end: a results tree -> the catalog
const Q4 = '/m/Qwen3.8-27B-UD-Q4_K_XL.gguf';
const SERVER = { model_path: Q4, build_info: 'b10499-6d0549831', n_ctx: 65536, launch_command: `/b/llama-server -m ${Q4} -c 65536 --jinja` };
const MANIFEST = { runner: 'opencode', model: 'llama-local/qwen38-27b-q4-64k', prompt_level: 'L2', harness_mode: 'agentic', timeout_s: 7200 };
const KEY = 'local:qwen3.8-27b:q4-k-xl';
const T0 = Date.parse('2026-10-24T12:00:00Z') / 1000;
function result(task, status, anomalies = []) {
    const solved = status === 'pass' || status === 'pass*';
    return { task, runner: 'opencode', model: MANIFEST.model, status, server: SERVER, manifest: MANIFEST, cap_used: 7200, anomalies,
        run: { wall_s: 600, tokens_out: 100, tool_calls: 5, exit_code: 0 },
        score: { solved, assertions: { passed: solved ? 3 : 1, failed: solved ? 0 : 2, total: 3 } } };
}
function catalog(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ovp-root-'));
    for (const d of ['tasks', 'annotations', 'session-store']) fs.mkdirSync(path.join(root, d), { recursive: true });
    let n = 0;
    const put = (dir, file, data) => {
        fs.mkdirSync(path.join(root, 'results', dir), { recursive: true });
        const f = path.join(root, 'results', dir, file);
        fs.writeFileSync(f, JSON.stringify(data));
        const ts = T0 + n++ * 60;
        fs.utimesSync(f, ts, ts);
    };
    put('ovp-a-20261024', 'tk-ovpass.json', result('tk-ovpass', 'pass', OVF));            // recovered: dark green
    put('ovp-a-20261024', 'tk-plain.json', result('tk-plain', 'pass', ['patch_apply_failed']));   // a false-positive overflow, rescored: plain pass
    put('ovp-a-20261024', 'tk-ovfail.json', result('tk-ovfail', 'fail', ['context_overflow']));  // a fail carrying it: nothing
    put('ovp-a-20261024', 'tk-ovexcl.json', result('tk-ovexcl', 'OVERFLOW', OVF));             // unsolved overflow: excluded, nothing
    put('ovp-a-20261024', 'tk-mixed.json', result('tk-mixed', 'pass'));
    put('ovp-b-20261024', 'tk-mixed.json', result('tk-mixed', 'pass', OVF));                    // one of its two passes
    const had = process.env.CODEBENCH_ANNOTATIONS_DIR;
    process.env.CODEBENCH_ANNOTATIONS_DIR = path.join(root, 'annotations');
    A._resetForTests();
    t.after(() => {
        if (had === undefined) delete process.env.CODEBENCH_ANNOTATIONS_DIR; else process.env.CODEBENCH_ANNOTATIONS_DIR = had;
        A._resetForTests(); M.configure({}); fs.rmSync(root, { recursive: true, force: true });
    });
    M.configure({
        paths: { csv: path.join(root, 'none.csv'), bestConfigs: path.join(root, 'none.md'), benchLog: path.join(root, 'none.log'), sweepState: path.join(root, 'none.json'),
            codebenchRoot: root, dashboardConfig: path.join(root, 'nope.json') },
        queueLaunch: new Map(),
    });
    const cat = JSON.parse(JSON.stringify(M.listModels()));
    return { cat, m: cat.models.find((x) => x.key === KEY) };
}

test('catalog: a passing run with context_overflow gets `overflowed` on its task, config cell and report-card sample; the rest get nothing', (t) => {
    const { cat, m } = catalog(t);
    assert.ok(m, 'the model row');
    const T = m.tasks;
    assert.deepStrictEqual(T['tk-ovpass'].overflowed, { passed: 1 });
    assert.deepStrictEqual([T['tk-ovpass'].status, T['tk-ovpass'].credit, T['tk-ovpass'].passes, T['tk-ovpass'].attempts], ['pass', 1, 1, 1], 'counts as a pass, nothing else changes');
    assert.strictEqual(T['tk-plain'].overflowed, undefined, 'a pass without it');
    assert.strictEqual(T['tk-ovfail'].overflowed, undefined, 'a fail with it');
    assert.strictEqual(T['tk-ovfail'].credit, 0);
    assert.strictEqual(T['tk-ovexcl'].overflowed, undefined, 'an excluded OVERFLOW');
    assert.strictEqual(T['tk-ovexcl'].excluded, true);
    assert.deepStrictEqual([T['tk-mixed'].overflowed, T['tk-mixed'].passes], [{ passed: 1 }, 2]);
    // the Solve map reads the config rows' cells
    assert.strictEqual(m.configs.length, 1);
    const C = m.configs[0].tasks;
    assert.deepStrictEqual(C['tk-ovpass'].overflowed, { passed: 1 });
    assert.strictEqual(C['tk-plain'].overflowed, undefined);
    assert.strictEqual(C['tk-ovfail'].overflowed, undefined);
    assert.strictEqual(C['tk-ovexcl'].overflowed, undefined);
    // the model page's report card
    const samples = M.getModel(KEY).qualityDetail.samples;
    assert.deepStrictEqual(samples.find((s) => s.task === 'tk-ovpass').overflowed, { passed: 1 });
    assert.strictEqual(samples.find((s) => s.task === 'tk-plain').overflowed, undefined);
    // public: the counts survive the scrub (a category, not task text), and nothing the leak gate forbids appears
    const pub = sanitizeCatalog(cat);
    const p = pub.models.find((x) => x.key === KEY);
    assert.deepStrictEqual(p.tasks['tk-ovpass'].overflowed, { passed: 1 });
    assert.deepStrictEqual(p.configs[0].tasks['tk-ovpass'].overflowed, { passed: 1 });
    assert.deepStrictEqual(sanitizePayload({ overflowed: { passed: 2 } }), { overflowed: { passed: 2 } });
    const S = require('../public/staticsite');
    assert.deepStrictEqual(S.leakScan('data/catalog.json', JSON.stringify(pub)).filter((h) => /dropped key/.test(h.what)), []);
});

// ---------------------------------------------------------------- display
test('specialPassNotes / overflowChip: the dark green and its note for a passed cell with the mark; nothing otherwise', async () => {
    const U = await import('../ui/benchmarks/util.js');
    assert.strictEqual(U.OVERFLOW_PASS_NOTE, NOTE);
    assert.deepStrictEqual(U.specialPassNotes({ status: 'pass', credit: 1, passes: 1, overflowed: { passed: 1 } }), [NOTE]);
    assert.deepStrictEqual(U.specialPassNotes({ status: 'pass', credit: 1, passes: 2, overflowed: { passed: 1 } }), [`${NOTE} (on 1 of its 2 passing runs)`]);
    assert.deepStrictEqual(U.specialPassNotes({ status: 'pass*', credit: 1, passes: 1, overflowed: { passed: 1 }, answered: { passed: 1, compacted: 1 } }),
        ['passed after the original prompt was re-supplied (asked after compaction)', NOTE, 'code passed the tests although the run hit the time limit'], 'answered, overflowed, then pass*');
    assert.deepStrictEqual(U.specialPassNotes({ status: 'pass', credit: 1, passes: 1 }), [], 'a plain pass');
    assert.deepStrictEqual(U.specialPassNotes({ status: 'pass', credit: 1, passes: 1, overflowed: null }), []);
    assert.deepStrictEqual(U.specialPassNotes({ status: 'pass', credit: 0.5, passes: 1, attempts: 2, overflowed: { passed: 1 } }), [], 'passed on some runs: the green-over-red split');
    assert.deepStrictEqual(U.specialPassNotes({ status: 'fail', credit: 0, passes: 0 }), [], 'a fail');
    assert.deepStrictEqual(U.specialPassNotes({ status: 'OVERFLOW', excluded: true, credit: null, passes: 0, overflowed: { passed: 1 } }), [], 'excluded');
    const chip = U.overflowChip({ passed: 1 });
    assert.match(chip, /background:#166534/);
    assert.match(chip, /data-overflowed/);
    assert.ok(chip.includes(`title="${NOTE}"`));
    assert.match(U.overflowChip({ passed: 1 }, 3), /\(on 1 of its 3 passing runs\)/);
    assert.strictEqual(U.overflowChip(null), '');
    assert.strictEqual(U.overflowChip({ passed: 0 }), '');
    // the Solve map decides its dark green (fill, hover text, light edge) from specialPassNotes alone
    const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'models', 'charts.js'), 'utf-8');
    assert.match(src, /const notes = specialPassNotes\(t\);\n\s*if \(notes\.length\) return \{ c: SPECIAL_PASS_FILL/);
    assert.match(src, /const ans = specialPassNotes\(t\)\.length > 0;/);
    // the legend and "How to read this" name the condition
    const idx = fs.readFileSync(path.join(__dirname, '..', 'ui', 'models', 'index.js'), 'utf-8');
    assert.match(idx, /or it passed after the conversation outgrew the context window \(the agent compacted and carried on\)"><span class="legend-sw" style="background:\$\{SPECIAL_PASS_FILL\}/);
    assert.match(idx, /and then it passed, or it passed after the conversation outgrew the context window \(the agent compacted and carried on\)\. <b class="text-gray-300">Hatched mid gray/);
});

test('pooling: mergeTasks keeps the mark from any member whose passes count; diagnosticOf sums it', async () => {
    const { mergeTasks, mergeOverflowed } = await import('../ui/shared/leaderboard.js');
    const PASS = (extra = {}) => ({ status: 'pass', solved: true, excluded: false, credit: 1, attempts: 1, passes: 1, wall_s: 100, ...extra });
    // the mark on the member that is NOT the representative one (rep = the most attempts)
    const m = mergeTasks([{ t1: PASS({ attempts: 2, passes: 2 }) }, { t1: PASS({ overflowed: { passed: 1 } }) }]);
    assert.deepStrictEqual([m.t1.overflowed, m.t1.passes, m.t1.credit], [{ passed: 1 }, 3, 1]);
    assert.deepStrictEqual(mergeTasks([{ t1: PASS({ overflowed: { passed: 1 } }) }, { t1: PASS({ overflowed: { passed: 2 } }) }]).t1.overflowed, { passed: 3 });
    assert.strictEqual(mergeTasks([{ t1: PASS() }, { t1: PASS() }]).t1.overflowed, undefined);
    assert.strictEqual('overflowed' in mergeTasks([{ t1: PASS({ attempts: 3, passes: 3, overflowed: null }) }, { t1: PASS() }]).t1, false, 'no stale key from the rep');
    assert.deepStrictEqual(mergeTasks([{ t1: PASS({ overflowed: { passed: 1 } }) }]).t1.overflowed, { passed: 1 }, 'one member: as it is');
    assert.strictEqual(mergeOverflowed([]), null);
    const { diagnosticOf } = await import('../ui/models/task.js');
    const g = { members: [
        { c: { diagnostics: { 'demo-recall-probe': { status: 'pass', attempts: 1, passes: 1, wall_s: 1000, ran_at: 1, overflowed: { passed: 1 } } } } },
        { c: { diagnostics: { 'demo-recall-probe': { status: 'pass', attempts: 1, passes: 1, wall_s: 500, ran_at: 2 } } } }] };
    assert.deepStrictEqual(diagnosticOf(g, 'demo-recall-probe').overflowed, { passed: 1 }, 'from a member that is not the latest');
    assert.strictEqual('overflowed' in diagnosticOf({ members: [g.members[1]] }, 'demo-recall-probe'), false);
});
