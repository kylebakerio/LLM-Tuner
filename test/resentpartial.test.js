'use strict';
// Kyle, 2026-10-19:
//  A. a pass whose run had its original prompt re-sent after an early stop (run.resent_prompt.fired, harness
//     CODEBENCH_RESEND_ON_EARLY_STOP) is marked on the Solve map like pass*: display only, the score is unchanged;
//  B. with the Solve map's "sub-tests" cells on, strength is fitted from partial points (each task once).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../lib/codebench');
const M = require('../lib/models');

async function loadLb() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'shared', 'leaderboard.js'), 'utf-8');
    const stub = 'data:text/javascript,' + encodeURIComponent(
        'export const esc=(s)=>String(s??"");export const fmtDur=(s)=>String(s);export const fmtN=(n)=>String(n);'
        + 'export const harnessLabel=(r)=>r||null;export const scaffoldBit=(r,s)=>s||null;'
        // the real context rule (ui/shared/ctxlabel.js, 2026-10-25): a stub never carries a copy of it
        + `import ${JSON.stringify(require('url').pathToFileURL(path.join(__dirname, '..', 'ui', 'shared', 'ctxlabel.js')).href)};export const { ctxLabel, commonWindow } = globalThis.CtxLabel;`);
    return import('data:text/javascript,' + encodeURIComponent(src.replace("from '../benchmarks/util.js'", `from '${stub}'`)));
}

const FIRED = { fired: true, policy: 'resend-v1', at_s: 812.4, reason: 'no tool call in the final message', via: 'end of run', left_s: 6000 };

test('re-sent prompt: taskRow reads run.resent_prompt only when it fired; status and score are untouched', () => {
    const base = { task: 't', run: { wall_s: 900 }, score: { solved: true, assertions: { passed: 3, failed: 0, total: 3 } }, status: 'pass' };
    const on = C.taskRow({ file: 't.json', data: { ...base, run: { ...base.run, resent_prompt: FIRED }, anomalies: ['resent_prompt'] } });
    assert.deepStrictEqual(on.resent, { at_s: 812.4, reason: 'no tool call in the final message', via: 'end of run', policy: 'resend-v1' });
    const off = C.taskRow({ file: 't.json', data: base });
    assert.strictEqual(off.resent, null);
    assert.strictEqual(C.taskRow({ file: 't.json', data: { ...base, run: { resent_prompt: { fired: false, policy: 'resend-v1', why: 'ended normally' } } } }).resent, null, 'declined');
    for (const k of ['status', 'solved', 'partial', 'assertions']) assert.deepStrictEqual(on[k], off[k], k);
});

test('re-sent prompt: the catalog cell says which pass came after a re-send; credit, solved and the row stay as they were', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'resent-'));
    fs.mkdirSync(path.join(tmp, 'cbroot', 'results'), { recursive: true }); fs.mkdirSync(path.join(tmp, 'cbroot', 'tasks'), { recursive: true });
    t.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); M.configure({}); });
    const Q4 = '/m/Qwen3.8-27B-UD-Q4_K_XL.gguf';
    const cfg = { runner: 'opencode', model: 'llama-local/qwen38-27b-q4-128k', prompt_level: 'L2', harness_mode: 'agentic', timeout_s: 7200 };
    const run = (dir) => ({ dir, ended: 1, config: cfg, server: { model_path: Q4, build_info: 'b10499-6d0549831', n_ctx: 131072, launch_command: `/b/llama-server -m ${Q4} -c 131072 --jinja` } });
    const row = (task, status, resent) => ({ task, status, solved: status === 'pass', wall_s: 100, tokens_out: 10, tool_calls: 1, ...(resent ? { resent } : {}) });
    const R = { at_s: 812.4, reason: 'no tool call in the final message', via: 'end of run', policy: 'resend-v1' };
    const rows = { b1: [row('a', 'pass', R), row('b', 'pass'), row('c', 'fail', R)] };
    M.configure({
        paths: { csv: path.join(tmp, 'none.csv'), bestConfigs: path.join(tmp, 'none.md'), benchLog: path.join(tmp, 'none.log'), sweepState: path.join(tmp, 'none.json'),
            codebenchRoot: path.join(tmp, 'cbroot'), dashboardConfig: path.join(tmp, 'nope.json') },
        codebench: { listRuns: () => [run('b1')], getRun: (dir) => ({ rows: rows[dir] || [] }) },
        queueLaunch: new Map(),
    });
    const m = M.listModels().models.find((x) => x.key === 'local:qwen3.8-27b:q4-k-xl');
    assert.ok(m, 'one row, the model\'s normal one');
    for (const tasks of [m.tasks, m.configs[0].tasks]) {
        assert.deepStrictEqual(tasks.a.resent, { n: 1, at_s: 812.4, reason: 'no tool call in the final message' });
        assert.strictEqual(tasks.a.credit, 1); assert.strictEqual(tasks.a.solved, true); assert.strictEqual(tasks.a.status, 'pass');
        assert.strictEqual(tasks.b.resent, undefined);
        assert.strictEqual(tasks.c.resent, undefined, 'a FAIL after a re-send is not marked: the mark is for passes');
    }
    assert.strictEqual(m.quality.solved, 2, 'the score counts the re-sent pass as the pass it is');
});

test('re-sent prompt: mergeTasks adds the re-sent passes over configs; the Solve map tooltip names the moment and reason', async (t) => {
    const L = await loadLb();
    const cell = (passes, attempts, extra = {}) => ({ status: passes ? 'pass' : 'fail', passes, attempts, credit: attempts ? passes / attempts : null, solved: passes > 0, excluded: !attempts, ...extra });
    const merged = L.mergeTasks([{ a: cell(1, 1, { resent: { n: 1, at_s: 812, reason: 'r' } }) }, { a: cell(1, 1, { resent: { n: 1, at_s: 900, reason: 'q' } }) }, { a: cell(0, 1) }]);
    assert.strictEqual(merged.a.resent.n, 2);
    assert.strictEqual(merged.a.credit, 2 / 3, 'credit is the runs\', untouched');
    assert.strictEqual(L.mergeTasks([{ a: cell(1, 1) }, { a: cell(0, 1) }]).a.resent, undefined);
    // charts.js resentNote (the grid's tooltip), loaded as the browser loads it
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-resent-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    fs.cpSync(path.join(__dirname, '..', 'ui'), path.join(tmp, 'ui'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
    const had = globalThis.window;
    globalThis.window = globalThis.window || { addEventListener() {} };
    t.after(() => { if (had === undefined) delete globalThis.window; else globalThis.window = had; });
    const Ch = await import(`file://${path.join(tmp, 'ui', 'models', 'charts.js')}`);
    assert.strictEqual(Ch.resentNote('pass', { passes: 1, resent: { n: 1, at_s: 812.4, reason: 'no tool call in the final message' } }),
        'pass — passed after the original prompt was re-sent (stopped early at 13 min 32 s: no tool call in the final message)');
    assert.match(Ch.resentNote('pass', { passes: 2, resent: { n: 2, at_s: 40 } }), /\(stopped early at 40 s\) \(on 2 of its passing runs\)$/);
});

// ---------------------------------------------------------------- B. partial points
const cellP = (passes, attempts, extra = {}) => ({ status: passes >= attempts && attempts ? 'pass' : 'fail', passes, attempts, credit: attempts ? passes / attempts : null,
    solved: passes > 0, excluded: !attempts, ...extra });

test('partialCreditOf: what the sub-tests boxes show -- a pass is 1, else progress beyond base, else raw assertions, else pass/fail', async () => {
    const L = await loadLb();
    assert.strictEqual(L.partialCreditOf(cellP(1, 1, { progressAll: { count: 3, of: 6 } })), 1);
    assert.strictEqual(L.partialCreditOf(cellP(0, 1, { progressAll: { count: 3, of: 6 }, assertionsAll: { passed: 40, total: 50 } })), 0.5, 'beyond base wins over raw');
    assert.strictEqual(L.partialCreditOf(cellP(0, 1, { progressAll: { count: 6, of: 6 } })), 0.999, 'a non-pass is never a full point');
    assert.strictEqual(L.partialCreditOf(cellP(0, 1, { assertionsAll: { passed: 48, total: 50 } })), 0.96);
    assert.strictEqual(L.partialCreditOf(cellP(0, 1)), 0, 'no record: pass/fail');
    assert.strictEqual(L.partialCreditOf(cellP(1, 2)), 0.5);
    assert.strictEqual(L.partialCreditOf({ excluded: true, credit: null }), null);
});

test('partial fit: near misses lift a config; each task counts once, so a 233-assertion task does not outweigh the rest', async () => {
    const L = await loadLb();
    // six configs over eight tasks; A and B have the same pass/fail record, A's misses are near misses
    const near = (k) => cellP(0, 1, { assertionsAll: { passed: k, total: 10 } });
    const tasks = (fn) => Object.fromEntries(['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8'].map((id, i) => [id, fn(i)]));
    const groups = [
        { key: 'A', tasks: tasks((i) => (i < 4 ? cellP(1, 1) : near(9))) },
        { key: 'B', tasks: tasks((i) => (i < 4 ? cellP(1, 1) : near(1))) },
        { key: 'C', tasks: tasks((i) => (i < 6 ? cellP(1, 1) : near(5))) },
        { key: 'D', tasks: tasks((i) => (i < 2 ? cellP(1, 1) : near(5))) },
        { key: 'E', tasks: tasks((i) => (i % 2 ? cellP(1, 1) : near(3))) },
        { key: 'F', tasks: tasks((i) => (i < 5 ? cellP(1, 1) : near(7))) },
    ];
    const bin = L.difficultyAdjusted(groups), par = L.difficultyAdjusted(groups, { credit: 'partial' });
    assert.ok(Math.abs(bin.get('A').strength - bin.get('B').strength) < 1e-9, 'binary: the same record, the same strength');
    assert.ok(par.get('A').strength > par.get('B').strength + 5, 'partial: the near misses count');
    for (const g of ['A', 'B', 'C']) assert.ok(par.get(g).lo <= par.get(g).strength / 100 && par.get(g).strength / 100 <= par.get(g).hi, `${g}: an interval around the point`);
    // weighting: one task with 233 assertions and a 0.2 share, against 7 passes. Per assertion it would sink the config; per task
    // it is one task among eight
    const big = { key: 'G', tasks: tasks((i) => (i === 0 ? cellP(0, 1, { assertionsAll: { passed: 47, total: 233 } }) : cellP(1, 1))) };
    const small = { key: 'H', tasks: tasks((i) => (i === 0 ? cellP(0, 1, { assertionsAll: { passed: 1, total: 5 } }) : cellP(1, 1))) };
    const p2 = L.difficultyAdjusted([...groups, big, small], { credit: 'partial' });
    assert.ok(Math.abs(p2.get('G').strength - p2.get('H').strength) < 0.5, `the same 0.2 share counts the same: ${p2.get('G').strength} vs ${p2.get('H').strength}`);
    // a task with one assertion is binary anyway
    const one = (k) => cellP(k, 1, { assertionsAll: { passed: k, total: 1 } });
    const g1 = [{ key: 'x', tasks: { a: one(1), b: one(0) } }, { key: 'y', tasks: { a: one(0), b: one(1) } }, { key: 'z', tasks: { a: one(1), b: one(1) } }];
    const b1 = L.difficultyAdjusted(g1), q1 = L.difficultyAdjusted(g1, { credit: 'partial' });
    for (const k of ['x', 'y', 'z']) assert.ok(Math.abs(b1.get(k).strength - q1.get(k).strength) < 1e-6, k);
});

test('fitFor: the partial fit is its own cached fit; binary stays the default', async () => {
    const L = await loadLb();
    const cfg = (key, tasks) => ({ key, runner: 'opencode', n_ctx: 131072, timeout_s: 7200, dirs: [key], facets: { weights: 'local:' + key, harness: { runner: 'opencode' }, context: { n_ctx: 131072 } },
        agg: { attempted: Object.keys(tasks).length, scored: Object.keys(tasks).length }, tasks });
    const model = (key, tasks) => ({ key: 'local:' + key, weightsKey: 'local:' + key, display: key, provider: 'local', counts: { qualityTasks: 3 }, quality: {}, configs: [cfg(key, tasks)] });
    const near = (k) => cellP(0, 1, { assertionsAll: { passed: k, total: 10 } });
    const models = [model('a', { x: cellP(1, 1), y: near(9), z: near(9) }), model('b', { x: cellP(1, 1), y: near(1), z: near(1) }), model('c', { x: near(5), y: cellP(1, 1), z: near(5) })];
    const q = L.FACET_DEFAULTS.quality, tk = L.FACET_DEFAULTS.full;
    const b = L.fitFor(models, q, tk);
    assert.strictEqual(L.fitFor(models, q, tk, { credit: 'binary' }), b, 'binary is the default fit');
    const p = L.fitFor(models, q, tk, { credit: 'partial' });
    assert.notStrictEqual(p, b);
    assert.strictEqual(L.fitFor(models, q, tk, { credit: 'partial' }), p, 'cached');
    assert.strictEqual(p.credit, 'partial');
    const ga = (fit, k) => fit.adj.get(fit.qAll.find((g) => g.m.key === 'local:' + k).key).strength;
    assert.ok(Math.abs(ga(b, 'a') - ga(b, 'b')) < 1e-9);
    assert.ok(ga(p, 'a') > ga(p, 'b'));
});
