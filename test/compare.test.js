// The Solve map's compare mode (2026-10-11, Kyle): the head-to-head arithmetic behind the compare page
// (ui/shared/leaderboard.js compareRows / taskOutcome). Pure: two folded task maps in, counts and lists out.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

// the browser module, with its DOM-facing import stubbed (as test/highlight.test.js loads it)
async function loadLb() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'shared', 'leaderboard.js'), 'utf-8');
    const stub = 'data:text/javascript,' + encodeURIComponent(
        'export const esc=(s)=>String(s??"");export const fmtDur=(s)=>String(s);export const fmtN=(n)=>String(n);'
        + 'export const harnessLabel=(r)=>r||null;export const scaffoldBit=(r,s)=>s||null;'
        // the real context rule (ui/shared/ctxlabel.js, 2026-10-25): a stub never carries a copy of it
        + `import ${JSON.stringify(require('url').pathToFileURL(path.join(__dirname, '..', 'ui', 'shared', 'ctxlabel.js')).href)};export const { ctxLabel, commonWindow } = globalThis.CtxLabel;`);
    return import('data:text/javascript,' + encodeURIComponent(src.replace("from '../benchmarks/util.js'", `from '${stub}'`)));
}

// a folded task cell, as lib/models.js and mergeTasks shape it
const cell = (passes, attempts, extra = {}) => ({
    status: passes >= attempts ? 'pass' : 'fail', attempts, passes, credit: attempts ? passes / attempts : null,
    solved: passes > 0, excluded: !attempts, wall_s: null, tokens_out: 0, ...extra });
const PASS = (x) => cell(1, 1, x), FAIL = (x) => cell(0, 1, x);
const EXCL = (status = 'PROVIDER_ERROR') => ({ status, attempts: 0, passes: 0, credit: null, solved: false, excluded: true, wall_s: 30, tokens_out: 10 });

// difficulty: t1 easiest ... t9 hardest
const DIFF = new Map(['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9', 'xa', 'xb', 'demo-combo-fix'].map((id, i) => [id, i - 4]));
const A = { tasks: {
    t1: PASS({ wall_s: 100, tokens_out: 1000 }),
    t2: PASS({ wall_s: 200, tokens_out: 4000 }),
    t3: FAIL(),
    t4: PASS({ wall_s: 300, tokens_out: 3000 }),
    t5: cell(2, 3, { wall_s: 50, tokens_out: 500 }),           // partial: passed 2 of 3
    t6: FAIL({ status: 'TIMEOUT' }),
    t7: cell(1, 1, { status: 'pass*', wall_s: 7200 }),         // solved at the cap: a pass
    t8: cell(1, 2, { wall_s: 80 }),
    t9: FAIL(),
    xa: PASS(),                                               // B never ran it
    xb: PASS(),                                               // B ran it, but no run was a model answer
    'demo-combo-fix': PASS(),                                  // a composite (passed in opts.composites below)
} };
const B = { tasks: {
    t1: PASS({ wall_s: 50, tokens_out: 2000 }),
    t2: PASS({ wall_s: 400, tokens_out: 2000 }),
    t3: PASS({ wall_s: 10 }),
    t4: FAIL(),
    t5: cell(0, 3),
    t6: FAIL(),
    t7: FAIL(),
    t8: cell(1, 2, { wall_s: 40 }),
    t9: cell(1, 4, { wall_s: 20, tokens_out: 0 }),
    xb: EXCL(),
    onlyb: FAIL(),
    'demo-combo-fix': EXCL('TASK_INVALID'),
} };

test('taskOutcome: one cell, folded the way the grid colours it', async () => {
    const { taskOutcome } = await loadLb();
    assert.strictEqual(taskOutcome(undefined), null, 'no entry = never run');
    assert.deepStrictEqual(taskOutcome(PASS()), { kind: 'pass', scored: true, credit: 1, passes: 1, attempts: 1, text: 'pass' });
    assert.strictEqual(taskOutcome(cell(3, 3)).text, 'pass 3 of 3 runs');
    assert.deepStrictEqual(taskOutcome(cell(1, 3)), { kind: 'partial', scored: true, credit: 1 / 3, passes: 1, attempts: 3, text: 'pass 1 of 3 runs' });
    assert.strictEqual(taskOutcome(FAIL()).kind, 'fail');
    assert.strictEqual(taskOutcome(FAIL({ status: 'TIMEOUT' })).kind, 'TIMEOUT');
    assert.strictEqual(taskOutcome(FAIL({ status: 'TIMEOUT' })).credit, 0, 'a timeout is a scored miss');
    assert.strictEqual(taskOutcome(cell(1, 1, { status: 'pass*' })).kind, 'pass*');
    assert.strictEqual(taskOutcome(cell(1, 1, { status: 'pass*' })).credit, 1, 'solved at the cap is a pass');
    const ex = taskOutcome(EXCL('OVERFLOW'));
    assert.strictEqual(ex.scored, false); assert.strictEqual(ex.kind, 'excluded'); assert.strictEqual(ex.text, 'excluded (OVERFLOW)');
    // a sample-group sibling scored under another task is shown, never scored
    const folded = taskOutcome({ status: 'pass', folded_into: 't-other', sample_group: 'g', own_credit: 1, credit: 1, attempts: 1, passes: 1 });
    assert.strictEqual(folded.scored, false); assert.strictEqual(folded.text, 'counted with t-other');
    // a solve with a later excluded status on top of it is still a solve: credit decides, not the latest status
    assert.strictEqual(taskOutcome(cell(1, 1, { status: 'PROVIDER_ERROR' })).kind, 'pass');
});

test('compareRows: like-for-like split on the tasks both scored', async () => {
    const { compareRows } = await loadLb();
    const c = compareRows(A, B, { difficulty: DIFF });
    const s = c.shared;
    assert.strictEqual(s.n, 9, 't1..t9: xa / xb / onlyb / the composite are not shared');
    assert.deepStrictEqual(s.ids, ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9'], 'easiest first, as the grid orders its columns');
    assert.deepStrictEqual([s.bothPass, s.aOnly, s.bOnly, s.aBetter, s.bBetter, s.tied, s.bothFail], [2, 2, 1, 1, 1, 1, 1]);
    assert.strictEqual(s.bothPass + s.aOnly + s.bOnly + s.aBetter + s.bBetter + s.tied + s.bothFail, s.n, 'the seven classes cover every shared task once');
    assert.deepStrictEqual(s.lists.aOnly.map((x) => x.id), ['t7', 't4'], 'clean wins, most difficult first; pass* counts as a pass');
    assert.deepStrictEqual(s.lists.bOnly.map((x) => x.id), ['t3']);
    assert.deepStrictEqual(s.lists.aBetter.map((x) => x.id), ['t5'], '2 of 3 against 0 of 3: better, not a clean win');
    assert.deepStrictEqual(s.lists.bBetter.map((x) => x.id), ['t9'], '1 of 4 against a single fail');
    assert.strictEqual(s.lists.aOnly[0].a.kind, 'pass*'); assert.strictEqual(s.lists.aOnly[0].b.kind, 'fail');
    assert.strictEqual(s.lists.aBetter[0].a.text, 'pass 2 of 3 runs'); assert.strictEqual(s.lists.aBetter[0].b.text, 'fail 0 of 3 runs');
    assert.deepStrictEqual([s.aAhead, s.bAhead, s.differ], [3, 2, 5]);
    assert.ok(Math.abs(s.creditA - (1 + 1 + 0 + 1 + 2 / 3 + 0 + 1 + 0.5 + 0)) < 1e-9);
    assert.ok(Math.abs(s.creditB - (1 + 1 + 1 + 0 + 0 + 0 + 0 + 0.5 + 0.25)) < 1e-9);
    // t6: TIMEOUT against fail is a both-miss, but each side keeps its own word
    assert.strictEqual(s.bothFail, 1);
    // how many cells rest on a single run: t5 and t8 were repeated by both
    assert.strictEqual(s.repeatedBoth, 2); assert.strictEqual(s.singleRun, 7);
});

test('compareRows: a task one side has no scored result on is a coverage gap, never a win', async () => {
    const { compareRows, COMPOSITE_TASKS } = await loadLb();
    const c = compareRows(A, B, { difficulty: DIFF });
    assert.deepStrictEqual(c.gaps.onlyA.map((x) => x.id), ['demo-combo-fix', 'xb', 'xa'], 'most difficult first');
    assert.strictEqual(c.gaps.onlyA.find((x) => x.id === 'xa').b, null, 'never run by B');
    assert.strictEqual(c.gaps.onlyA.find((x) => x.id === 'xb').b.kind, 'excluded', 'run by B, but not a model answer');
    assert.deepStrictEqual(c.gaps.onlyB.map((x) => x.id), ['onlyb'], 'no difficulty: sorts as hardest');
    assert.strictEqual(c.shared.aOnly, 2, 'xa and xb are passes for A but not wins over B');
    // whole-record counts keep them
    assert.deepStrictEqual([c.a.tasks, c.a.scored, c.a.excluded, c.a.runs, c.a.runsPassed], [12, 12, 0, 15, 10]);
    assert.deepStrictEqual([c.b.tasks, c.b.scored, c.b.excluded, c.b.runs, c.b.runsPassed], [12, 10, 2, 16, 5]);
    assert.deepStrictEqual([c.a.clean, c.a.partial, c.a.failed, c.a.repeated], [7, 2, 3, 2]);
    assert.ok(Math.abs(c.a.credit - (7 + 2 / 3 + 0.5)) < 1e-9);
    // the composites are reported on their own, with both cells (opts.composites; by default COMPOSITE_TASKS)
    assert.deepStrictEqual(compareRows(A, B, { difficulty: DIFF, composites: ['demo-combo-fix'] }).composites.map((x) => [x.id, x.a.kind, x.b.kind]), [['demo-combo-fix', 'pass', 'excluded']]);
    assert.deepStrictEqual(c.composites, [], 'the default list does not name the invented id');
    const real = COMPOSITE_TASKS[0];
    assert.deepStrictEqual(compareRows({ tasks: { [real]: PASS() } }, { tasks: {} }).composites.map((x) => [x.id, x.a.kind, x.b]), [[real, 'pass', null]], 'with no opts.composites, COMPOSITE_TASKS are the composites');
    assert.strictEqual(compareRows(A, B, { difficulty: DIFF, composites: ['t1', 'nope'] }).composites.length, 1, 'only composites either side has an entry for');
});

test('compareRows: speed and tokens only over shared tasks both solved, with the figure recorded on both', async () => {
    const { compareRows } = await loadLb();
    const sp = compareRows(A, B, { difficulty: DIFF }).speed;
    // both solved with a wall clock: t1 (100 v 50), t2 (200 v 400), t8 (80 v 40). t9: A failed. t3/t4/t7: one side failed.
    assert.strictEqual(sp.n, 3);
    assert.strictEqual(sp.medA, 100); assert.strictEqual(sp.medB, 50);
    assert.strictEqual(sp.ratio, 2, 'median of A/B over the tasks: [2, 0.5, 2]');
    assert.ok(Math.abs(sp.geo - Math.cbrt(2 * 0.5 * 2)) < 1e-9);
    assert.deepStrictEqual([sp.aFaster, sp.bFaster, sp.same], [1, 2, 0]);
    // tokens: 0 means not recorded, so t8 (no count on either) is left out
    assert.strictEqual(sp.tok.n, 2);
    assert.strictEqual(sp.tok.medA, 2500); assert.strictEqual(sp.tok.medB, 2000);
    assert.strictEqual(sp.tok.ratio, 1.25, 'median of [0.5, 2]');
    assert.deepStrictEqual([sp.tok.aFewer, sp.tok.bFewer], [1, 1]);
    // nothing shared and solved: nulls, not NaN
    const none = compareRows({ tasks: { t1: FAIL() } }, { tasks: { t1: PASS({ wall_s: 5 }) } }).speed;
    assert.deepStrictEqual([none.n, none.medA, none.ratio, none.geo, none.tok.n], [0, null, null, null, 0]);
});

test('compareRows: where the wins sit -- difficulty thirds of the shared tasks, families', async () => {
    const { compareRows } = await loadLb();
    const c = compareRows(A, B, { difficulty: DIFF, familyOf: (id) => (/^t[1-5]$/.test(id) ? 'low' : /^t[6-9]$/.test(id) ? 'high' : 'other') });
    assert.deepStrictEqual(c.bands.map((x) => [x.key, x.n, x.aAhead, x.bAhead]), [['easiest', 3, 0, 1], ['middle', 3, 2, 0], ['hardest', 3, 1, 1]]);
    assert.ok(Math.abs(c.bands[1].creditA - (1 + 2 / 3)) < 1e-9); assert.strictEqual(c.bands[1].creditB, 0);
    assert.strictEqual(c.bands.reduce((n, x) => n + x.n, 0), c.shared.n);
    assert.deepStrictEqual(c.bands.map((x) => [x.bothPass, x.bothFail]), [[2, 0], [0, 1], [0, 0]], 'what both solve and both miss, by slice (t8, the same partial credit, is neither)');
    const fam = Object.fromEntries(c.families.map((f) => [f.key, f]));
    assert.deepStrictEqual([fam.low.n, fam.low.aAhead, fam.low.bAhead, fam.low.onlyA, fam.low.onlyB], [5, 2, 1, 0, 0]);
    assert.deepStrictEqual([fam.high.n, fam.high.aAhead, fam.high.bAhead], [4, 1, 1]);
    assert.deepStrictEqual([fam.other.n, fam.other.onlyA, fam.other.onlyB], [0, 3, 1], 'a family with only coverage gaps is still listed');
    assert.deepStrictEqual(c.families.map((f) => f.key), ['low', 'high', 'other'], 'most shared tasks first');
    // default family: the first word of the task id
    const d = compareRows({ tasks: { 'clubapp-x': PASS(), 'tewaza-y': FAIL() } }, { tasks: { 'clubapp-x': FAIL(), 'tewaza-y': FAIL() } });
    assert.deepStrictEqual(d.families.map((f) => f.key).sort(), ['clubapp', 'tewaza']);
    assert.deepStrictEqual(d.bands, [], 'fewer than 3 shared tasks: no thirds');
    // uneven thirds still cover everything once
    const five = compareRows({ tasks: Object.fromEntries(['t1', 't2', 't3', 't4', 't5'].map((id) => [id, PASS()])) }, { tasks: Object.fromEntries(['t1', 't2', 't3', 't4', 't5'].map((id) => [id, FAIL()])) }, { difficulty: DIFF });
    assert.deepStrictEqual(five.bands.map((x) => x.n), [2, 2, 1]);
});

test('compareRows: swapping the sides mirrors the result; empty and missing rows do not throw', async () => {
    const { compareRows } = await loadLb();
    const ab = compareRows(A, B, { difficulty: DIFF }), ba = compareRows(B, A, { difficulty: DIFF });
    assert.deepStrictEqual([ba.shared.aOnly, ba.shared.bOnly, ba.shared.aBetter, ba.shared.bBetter], [ab.shared.bOnly, ab.shared.aOnly, ab.shared.bBetter, ab.shared.aBetter]);
    assert.deepStrictEqual(ba.shared.lists.aOnly.map((x) => x.id), ab.shared.lists.bOnly.map((x) => x.id));
    assert.deepStrictEqual(ba.gaps.onlyA.map((x) => x.id), ab.gaps.onlyB.map((x) => x.id));
    assert.ok(Math.abs(ba.speed.ratio - 0.5) < 1e-9); assert.strictEqual(ba.speed.aFaster, ab.speed.bFaster);
    for (const [x, y] of [[null, null], [{}, {}], [A, null], [{ tasks: {} }, B]]) {
        const c = compareRows(x, y);
        assert.strictEqual(c.shared.n, 0); assert.strictEqual(c.shared.differ, 0); assert.deepStrictEqual(c.bands, []);
    }
    // a difficulty map may be a plain object too; unknown difficulty never throws
    assert.strictEqual(compareRows(A, B, { difficulty: Object.fromEntries(DIFF) }).shared.ids[0], 't1');
    assert.strictEqual(compareRows(A, B).shared.n, 9);
});

test('compare mode is wired: the page, the grid and the router agree on the names', async () => {
    const lb = await loadLb();
    // the four composite tasks: real ids from the suite, so only their shape is pinned here
    assert.ok(Array.isArray(lb.COMPOSITE_TASKS) && lb.COMPOSITE_TASKS.length === 4 && new Set(lb.COMPOSITE_TASKS).size === 4);
    assert.ok(lb.COMPOSITE_TASKS.every((id) => typeof id === 'string' && /^[A-Za-z0-9][A-Za-z0-9.-]*$/.test(id)), 'plain task ids: no @level, no +bonus');
    assert.strictEqual(lb.taskFamily('demo-widget-off-by-one'), 'demo');
    assert.strictEqual(lb.overlaps({ lo: 0.4, hi: 0.6 }, { lo: 0.55, hi: 0.7 }), true);
    assert.strictEqual(lb.overlaps({ lo: 0.4, hi: 0.5 }, { lo: 0.55, hi: 0.7 }), false);
    const page = fs.readFileSync(path.join(__dirname, '..', 'ui', 'models', 'index.js'), 'utf-8');
    assert.ok(/compareRows\(/.test(page), 'ui/models/index.js draws the compare page from compareRows');
    assert.ok(page.includes('data-compare-mode'), 'the Solve map has its Compare toggle');
    const charts = fs.readFileSync(path.join(__dirname, '..', 'ui', 'models', 'charts.js'), 'utf-8');
    assert.ok(/opts\.tick/.test(charts), 'taskGrid draws the row checkboxes');
});

// ---- 2026-10-18: tg / pp t/s per compared row (leaderboard.js speedOf, lib/models.js runSpeed) ----
test('speedOf: token-weighted over the row\'s runs; mergeTasks adds the sums of every member', async () => {
    const { speedOf, mergeTasks } = await loadLb();
    // 1000 prompt tokens in 2 s, 100 generated in 5 s (one run) / 9000 in 6 s, 900 in 15 s (three runs)
    const s1 = { pn: 1000, pms: 2000, gn: 100, gms: 5000, req: 10, runs: 1, of: 1 };
    const s2 = { pn: 9000, pms: 6000, gn: 900, gms: 15000, req: 30, runs: 3, of: 4 };
    const t = { t1: PASS({ speed: s1 }), t2: FAIL({ speed: s2 }), t3: PASS() };
    const all = speedOf(t);
    assert.strictEqual(all.tg, 1000 / 20, 'all generated tokens / all generation time, not the mean of 20 and 60 t/s');
    assert.strictEqual(all.pp, 10000 / 8);
    assert.deepStrictEqual([all.runs, all.of, all.req, all.tasks], [4, 5, 40, 2]);
    assert.strictEqual(speedOf(t, ['t1']).tg, 20, 'restricted to the given tasks (the shared ones)');
    assert.strictEqual(speedOf(t, ['t3']), null, 'no local run: a cloud row -> null ("—")');
    assert.strictEqual(speedOf({ x: PASS({ speed: { pn: 0, pms: 0, gn: 0, gms: 0, req: 0, runs: 0, of: 2 } }) }).tg, null, 'runs with no request log: no rate, but counted');
    // two configs of one task pool: the sums add, whatever member is the representative row
    const m = mergeTasks([{ t1: PASS({ speed: s1 }) }, { t1: cell(0, 3, { speed: s2 }) }, { t1: { ...EXCL(), folded_into: 'tx', speed: s1 } }]);
    assert.deepStrictEqual(m.t1.speed, { pn: 11000, pms: 10000, gn: 1100, gms: 25000, req: 50, runs: 5, of: 6 });
    assert.strictEqual(mergeTasks([{ t1: PASS() }, { t1: FAIL() }]).t1.speed, undefined, 'cloud cells stay without one');
});

// Kyle 2026-10-18: "shows both passing 1, and everything else 0s". The two rows of his link (the exact keys below) had
// run different task sets and shared ONE task; the keys and the arithmetic were right, the page led with like-for-like
// counts over that one task. compareRows now flags the overlap as thin and the page states each row's own record first.
const KYLE_A = '[["weights","local:qwen3.8-flash-next:q2-k-xl"],["harness",{"runner":"opencode","runnerModel":null,"effort":null,"scaffold":null,"prompt_level":"L2","harness_mode":"agentic","timeout_s":7200}],["context",{"n_ctx":65536,"flags":["-c 65536"]}],["output",["--jinja"]],["kv",["--cache-type-k q8_0","--cache-type-v q8_0"]],["other",[]]]';
const KYLE_B = '[["weights","local:qwen3.8-flash-next-gsq-rco:iq1-m"],["harness",{"runner":"opencode","runnerModel":null,"effort":null,"scaffold":null,"prompt_level":"L2+careful-tone","harness_mode":"agentic","timeout_s":7200}],["context",{"n_ctx":131072,"flags":null}],["output",null],["kv",null],["other",null]]';
test('compare: Kyle\'s two rows (exact keys) group as on the Solve map, and a one-task overlap is flagged thin', async () => {
    const { groupConfigs, compareRows, FACET_DEFAULTS, COMPARE_MIN_SHARED } = await loadLb();
    const facetsOf = (key) => Object.fromEntries(JSON.parse(key));
    const ids = (p, n) => Array.from({ length: n }, (_, i) => `${p}-${i}`);
    // A: 36 of 37 passed; B: 9 of 13 passed (a Strata row: null launch facets); one task in common, passed by both
    const tA = Object.fromEntries([...ids('a', 36).map((id) => [id, PASS()]), ['demo-shared-task', PASS()]]);
    tA['a-0'] = FAIL();
    tA['a-35'] = PASS();
    const tB = Object.fromEntries([...ids('b', 12).map((id, i) => [id, i < 8 ? PASS() : FAIL()]), ['demo-shared-task', PASS()]]);
    const entries = [
        { m: { key: 'local:qwen3.8-flash-next:q2-k-xl' }, c: { facets: facetsOf(KYLE_A), tasks: tA, agg: { scored: 37 } } },
        { m: { key: 'local:qwen3.8-flash-next-gsq-rco:iq1-m' }, c: { facets: facetsOf(KYLE_B), tasks: tB, agg: { scored: 13 } } },
    ];
    const g = groupConfigs(entries, FACET_DEFAULTS.quality);
    const gA = g.find((x) => x.key === KYLE_A), gB = g.find((x) => x.key === KYLE_B);
    assert.ok(gA && gB, 'the link\'s keys are the Solve map\'s group keys (null facets and [] facets are kept as they are)');
    const c = compareRows(gA, gB);
    assert.deepStrictEqual([c.a.scored, c.a.runsPassed, c.b.scored, c.b.runsPassed], [37, 36, 13, 9], 'each side keeps its whole record');
    assert.deepStrictEqual([c.shared.n, c.shared.bothPass, c.shared.aOnly, c.shared.bOnly, c.shared.bothFail], [1, 1, 0, 0, 0]);
    assert.strictEqual(c.shared.thin, true);
    assert.deepStrictEqual([c.gaps.onlyA.length, c.gaps.onlyB.length], [36, 12]);
    // not thin once the overlap is a real share of the smaller record
    const tB2 = Object.fromEntries(Object.keys(tA).slice(0, 13).map((id) => [id, PASS()]));
    assert.strictEqual(compareRows(gA, { tasks: tB2 }).shared.thin, false);
    assert.strictEqual(compareRows(gA, { tasks: Object.fromEntries(Object.keys(tA).slice(0, COMPARE_MIN_SHARED - 1).map((id) => [id, PASS()])) }).shared.thin, true);
    const page = fs.readFileSync(path.join(__dirname, '..', 'ui', 'models', 'index.js'), 'utf-8');
    assert.ok(page.includes('sh.thin') && page.includes('data-thin-overlap'), 'the compare page says so');
    assert.ok(/speedOf\(x\.tasks\)/.test(page), 'the compare page shows each row\'s tg / pp');
});

test('lib/models.js runSpeed: cloud, bonus and unplaceable runs; sumRunSpeed counts measured of local runs', () => {
    const M = require('../lib/models');
    const tpsLib = require('../lib/tps');
    const t0 = Date.parse('2026-10-17T06:00:00Z');
    const cmd = '/b/llama-server -m /m/x.gguf -c 65536';
    const tl = tpsLib.requestTimeline([{ t: t0 + 1000, modelPath: '/m/x.gguf', launchCommand: cmd, source: 'llama-log-import', promptTokens: 100, promptTps: 100, genTokens: 10, genTps: 10 }]);
    const srv = { model_path: '/m/x.gguf', launch_command: cmd };
    const row = (extra) => ({ wall_s: 30, ran_at: t0, ran_at_source: 'manifest', rowConfig: { server: srv }, ...extra });
    assert.deepStrictEqual(M.runSpeed(tl, row(), {}), { prompt_n: 100, prompt_ms: 1000, predicted_n: 10, predicted_ms: 1000, n: 1 });
    assert.strictEqual(M.runSpeed(tl, row({ rowConfig: { server: null } }), { server: null }), null, 'cloud: no model path');
    assert.strictEqual(M.runSpeed(tl, row({ wall_s: null }), {}), null, 'a +bonus row: the main row has the run\'s time');
    assert.deepStrictEqual(M.runSpeed(tl, row({ ran_at_source: 'transcript_mtime' }), {}), { none: true }, 'start not recorded: unknown, not guessed');
    assert.deepStrictEqual(M.runSpeed(tl, row({ ran_at: t0 + 3600e3 }), {}), { none: true });
    const s = M.sumRunSpeed([M.runSpeed(tl, row(), {}), { none: true }, null]);
    assert.deepStrictEqual(s, { pn: 100, pms: 1000, gn: 10, gms: 1000, req: 1, runs: 1, of: 2 });
    assert.strictEqual(M.sumRunSpeed([null, null]), null);
});

// Kyle 2026-10-20: "the order of those little summary boxes should align with the order of the colors on the bar beneath".
test('likeSegments: one ordered list for the like-for-like tiles and bar (A ahead ... B ahead), counts as the bar shows them', async () => {
    const { compareRows, likeSegments, STATUS_COLOR } = await loadLb();
    const sh = compareRows(A, B, { difficulty: DIFF }).shared;
    const segs = likeSegments(sh, { tags: ['A', 'B'], colors: ['#a', '#b'] });
    assert.deepStrictEqual(segs.map((x) => x.key), ['aAhead', 'bothPass', 'tied', 'bothFail', 'bAhead'], 'left to right as the bar draws it');
    assert.deepStrictEqual(segs.map((x) => x.n), [sh.aAhead, sh.bothPass, sh.tied, sh.bothFail, sh.bAhead]);
    assert.strictEqual(segs.reduce((s, x) => s + x.n, 0), sh.n, 'the five segments cover every shared task once');
    assert.deepStrictEqual(segs.map((x) => x.color), ['#a', STATUS_COLOR.pass, '#747b8c', STATUS_COLOR.fail, '#b']);
    assert.ok(segs[0].sub.includes(`${sh.aOnly}`) && segs[4].sub.includes(`${sh.bOnly}`), 'a tile says how much of its lead is clean passes');
    assert.deepStrictEqual(segs.filter((x) => !x.core).map((x) => x.key), ['tied'], 'only "same partial credit" may drop out of the tiles, and only at 0');
    const page = fs.readFileSync(path.join(__dirname, '..', 'ui', 'models', 'index.js'), 'utf-8');
    assert.ok(/const SEGS = likeSegments\(/.test(page) && /segTiles\(SEGS\)/.test(page) && /segBar\(SEGS, sh\.n\)/.test(page),
        'the two-row page draws its tiles and its bar from the same list');
    assert.ok(!/tile\('both pass', sh\.bothPass/.test(page), 'no second, separately ordered set of tiles');
});

test('compareTag / compareColor: a letter and an identity colour for any number of rows', async () => {
    const { compareTag, compareColor, SERIES, STATUS_COLOR } = await loadLb();
    assert.deepStrictEqual([0, 1, 2, 25, 26, 27, 52].map(compareTag), ['A', 'B', 'C', 'Z', 'A2', 'B2', 'A3']);
    assert.strictEqual(compareColor(0), SERIES[0]);
    assert.strictEqual(compareColor(1), SERIES[1]);
    const many = Array.from({ length: 30 }, (_, i) => compareColor(i));
    assert.strictEqual(new Set(many).size, 30, 'thirty rows, thirty colours');
    for (const c of many) assert.ok(!Object.values(STATUS_COLOR).includes(c), 'never a status colour');
});

test('compareMany: three rows, every shared task in exactly one class; pairs match compareRows', async () => {
    const { compareMany, compareRows, manySegments } = await loadLb();
    const C = { tasks: {
        t1: PASS({ wall_s: 300, tokens_out: 3000 }), t2: PASS({ wall_s: 100, tokens_out: 1000 }), t3: PASS({ wall_s: 20 }), t4: FAIL(),
        t5: cell(1, 3), t6: FAIL(), t7: FAIL(), t8: cell(1, 2, { wall_s: 60 }), t9: FAIL(), xa: PASS(), onlyc: PASS(),
    } };
    const m = compareMany([A, B, C], { difficulty: DIFF });
    assert.strictEqual(m.n, 3);
    // every row scored t1..t9 (xa: B never ran it; xb: B excluded, C never ran it; demo-combo-fix: B excluded)
    assert.strictEqual(m.shared.n, 9);
    assert.deepStrictEqual(m.shared.ids, ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9'], 'easiest first');
    const sh = m.shared;
    // t1, t2 all pass; t6 all fail; t3: B and C pass (shared lead); t4: A alone; t5: A 2/3 > C 1/3 > B 0 (A alone);
    // t7: A alone (pass*); t8: all 1/2 (tied); t9: B alone (1 of 4)
    assert.deepStrictEqual([sh.allPass, sh.allFail, sh.tied, sh.split, ...sh.lead], [2, 1, 1, 1, 3, 1, 0]);
    assert.strictEqual(sh.allPass + sh.allFail + sh.tied + sh.split + sh.lead.reduce((s, x) => s + x, 0), sh.n);
    assert.deepStrictEqual(sh.lists.lead[0].map((x) => x.id), ['t7', 't5', 't4'], 'most difficult first');
    assert.deepStrictEqual(sh.lists.split.map((x) => x.id), ['t3']);
    assert.deepStrictEqual(sh.perRow.map((r) => [r.alone, r.sharedLead, r.behind]), [[3, 0, 2], [1, 1, 3], [0, 1, 4]]);
    // pairs: each cell is that pair's own compareRows
    for (const [i, j, x, y] of [[0, 1, A, B], [1, 2, B, C], [2, 0, C, A]]) {
        const s = compareRows(x, y, { difficulty: DIFF }).shared;
        assert.deepStrictEqual(m.pairs[i][j], { n: s.n, ahead: s.aAhead, behind: s.bAhead, thin: s.thin });
        assert.deepStrictEqual([m.pairs[j][i].ahead, m.pairs[j][i].behind], [s.bAhead, s.aAhead], 'the mirror cell');
    }
    assert.strictEqual(m.pairs[1][1], null);
    // speed: tasks EVERY row solved with a wall clock on all: t1, t2, t8
    assert.strictEqual(m.speed.n, 3);
    assert.deepStrictEqual(m.speed.med, [100, 50, 100]);
    assert.deepStrictEqual(m.speed.fastest, [0, 2, 1], 't1 and t8: B fastest; t2: C (100 against A 200, B 400)');
    const tie = compareMany([{ tasks: { t: PASS({ wall_s: 10 }) } }, { tasks: { t: PASS({ wall_s: 10 }) } }, { tasks: { t: PASS({ wall_s: 30 }) } }]);
    assert.deepStrictEqual(tie.speed.fastest, [0, 0, 0], 'a tie for fastest counts for nobody');
    // outside: tasks a row scored that not every row scored
    assert.deepStrictEqual(m.outside[2].map((x) => x.id).sort(), ['onlyc', 'xa']);
    assert.ok(m.outside[0].some((x) => x.id === 'xb'), 'A scored xb; B only has excluded runs of it');
    // the tiles / bar list: each row's own lead first, in row order, then the collective classes
    const segs = manySegments(sh, { tags: ['A', 'B', 'C'], colors: ['#a', '#b', '#c'] });
    assert.deepStrictEqual(segs.map((x) => x.key), ['lead:0', 'lead:1', 'lead:2', 'allPass', 'split', 'tied', 'allFail']);
    assert.deepStrictEqual(segs.map((x) => x.n), [3, 1, 0, 2, 1, 1, 1]);
    assert.deepStrictEqual(segs.slice(0, 3).map((x) => x.color), ['#a', '#b', '#c']);
    // two rows through compareMany agree with compareRows on the shared set
    const two = compareMany([A, B], { difficulty: DIFF }), ab = compareRows(A, B, { difficulty: DIFF }).shared;
    assert.deepStrictEqual([two.shared.n, two.shared.allPass, two.shared.allFail, two.shared.lead[0], two.shared.lead[1]], [ab.n, ab.bothPass, ab.bothFail, ab.aAhead, ab.bAhead]);
    // nothing shared
    const none = compareMany([{ tasks: { a: PASS() } }, { tasks: { b: PASS() } }, { tasks: {} }]);
    assert.strictEqual(none.shared.n, 0);
    assert.strictEqual(none.speed.n, 0);
});

test('the compare page takes any number of rows: no cap on the ticks, every id routed', () => {
    const page = fs.readFileSync(path.join(__dirname, '..', 'ui', 'models', 'index.js'), 'utf-8');
    assert.ok(!/Compare \(\$\{n\}\/2\)/.test(page) && !/Two rows are already ticked/.test(page), 'the two-pick limit is gone');
    assert.ok(/comparePicks\.length >= 2\) openCompare\(comparePicks\.map/.test(page), 'Compare opens every ticked row');
    assert.ok(/if \(ids\.length > 2\) \{ drawCompareMany\(ids\)/.test(page), 'three or more rows: the side-by-side page');
    assert.ok(!/openCompare\(\w+\[0\], \w+\[1\]/.test(page), 'no caller passes only the first two ids');
});
