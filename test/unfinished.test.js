'use strict';
// Kyle, 2026-10-19: a run whose session ended ASKING the user something is UNFINISHED until its question is answered with
// the original prompt ("retroactively treated as an original condition"):
//  - unfinished rows (run.unfinished, or the annotations index of kind "unfinished") are in no count, x/y, pass rate,
//    fit, leaderboard, battery summary, task / case tally or "scored" index -- their +bonus rows neither;
//  - a continuation (run.resent_prompt.via "continue-from") COUNTS, base and +bonus, and SUPERSEDES its source;
//  - dark green only for a run answered with the original prompt that then passed; unfinished cells are neutral;
//  - the public data carries counts and category notes, never the question text;
//  - tools/config-identity.js check returns `unfinished`; the planner and the queue guard hold a task whose saved session
//    waits for a continuation, and free one whose session is pruned.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../lib/annotations');
const C = require('../lib/codebench');
const M = require('../lib/models');
const ID = require('../lib/configid');
const { sanitizeCatalog, sanitizePayload } = require('../lib/publicdata');

let uiDir = null;
async function ui(rel) {
    if (!uiDir) {
        uiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-unf-'));
        fs.cpSync(path.join(__dirname, '..', 'ui'), path.join(uiDir, 'ui'), { recursive: true });
        fs.writeFileSync(path.join(uiDir, 'package.json'), JSON.stringify({ type: 'module' }));
        if (globalThis.window === undefined) globalThis.window = { addEventListener() {} };
    }
    return import(`file://${path.join(uiDir, 'ui', rel)}`);
}
test.after(() => { if (uiDir) fs.rmSync(uiDir, { recursive: true, force: true }); });

// ---------------------------------------------------------------- a results tree with real result-JSON shapes
const Q4 = '/m/Qwen3.8-27B-UD-Q4_K_XL.gguf';
const SERVER = { model_path: Q4, build_info: 'b10499-6d0549831', n_ctx: 131072, launch_command: `/b/llama-server -m ${Q4} -c 131072 --jinja` };
const MANIFEST = { runner: 'opencode', model: 'llama-local/qwen38-27b-q4-128k', prompt_level: 'L2', harness_mode: 'agentic', timeout_s: 7200 };
const KEY = 'local:qwen3.8-27b:q4-k-xl';
const QUESTION = 'SECRET-QUESTION: should I keep the legacy column?';
function result(task, status, { assertions = [1, 3], resent = null, unfinished = null, continuedFrom = null, bonus = null } = {}) {
    const solved = status === 'pass' || status === 'pass*';
    const [p, tot] = solved ? [3, 3] : assertions;
    return {
        task, runner: 'opencode', model: MANIFEST.model, status, server: SERVER, manifest: MANIFEST, cap_used: 7200,
        run: { wall_s: 600, tokens_out: 100, tool_calls: 5, exit_code: 0, ...(resent ? { resent_prompt: resent } : {}), ...(unfinished ? { unfinished } : {}) },
        score: { solved, assertions: { passed: p, failed: tot - p, total: tot },
            ...(bonus != null ? { extra: { ran_any: true, all: bonus, passed: bonus ? 2 : 1, total: 2 } } : {}) },
        ...(continuedFrom ? { continued_from: continuedFrom } : {}),
    };
}
const END_OF_RUN = { fired: true, policy: 'resend-v2', at_s: 400.5, reason: 'question', via: 'end of run', compactions: 0, final_message: 'SECRET-ASKED-EOR: tests or not?' };
const CONTINUE = { fired: true, policy: 'resend-v2', at_s: 1440, reason: 'question', via: 'continue-from', compactions: 2, final_message: 'SECRET-ASKED-CONT' };
const UNF = { why: 'ended asking', ending: 'question', question: QUESTION, compactions: 1, policy: 'resend-v2' };
const T0 = Date.parse('2026-10-18T12:00:00Z') / 1000;

/** parts: which optional pieces the tree has. Every file gets a fixed mtime (ran_at and the battery clock come from it). */
function tree(t, parts = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unf-root-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, 'tasks'), { recursive: true });
    fs.mkdirSync(path.join(root, 'annotations'), { recursive: true });
    fs.mkdirSync(path.join(root, 'session-store'), { recursive: true });
    let n = 0;
    const put = (dir, file, data, at) => {
        fs.mkdirSync(path.join(root, 'results', dir), { recursive: true });
        const f = path.join(root, 'results', dir, file);
        fs.writeFileSync(f, JSON.stringify(data));
        const ts = T0 + (at ?? n++ * 60);
        fs.utimesSync(f, ts, ts);
    };
    // the source battery: beta pass, delta passed after an end-of-run re-send (answered), eps fail
    put('src-20261018', 'tk-beta.json', result('tk-beta', 'pass'), 100);
    put('src-20261018', 'tk-delta.json', result('tk-delta', 'pass', { resent: END_OF_RUN }), 200);
    put('src-20261018', 'tk-eps.json', result('tk-eps', 'fail'), 300);
    // unfinished: alpha (a past run, in the index; its bonus ran) and gamma (a new run saying so itself)
    if (parts.alpha) put('src-20261018', 'tk-alpha.json', result('tk-alpha', 'fail', { bonus: true }), 10);
    if (parts.gamma) put('src-20261018', 'tk-gamma.json', result('tk-gamma', 'fail', { unfinished: UNF }), 20);
    // asked but PASSED (Kyle 2026-10-19, "keep passes and void fails"): alpha passed (bonus too) and is in the index, gamma a
    // pass* carrying run.unfinished from an older harness -- or the same two passes with no unfinished mark at all (`plain`)
    if (parts.passAsked || parts.passPlain) {
        put('src-20261018', 'tk-alpha.json', result('tk-alpha', 'pass', { bonus: true }), 10);
        put('src-20261018', 'tk-gamma.json', result('tk-gamma', 'pass*', parts.passAsked ? { unfinished: UNF } : {}), 20);
    }
    if (parts.alpha || parts.indexAlways || parts.passAsked) {
        fs.writeFileSync(path.join(root, 'annotations', 'unfinished-asked-x.json'), JSON.stringify({ v: 1, kind: 'unfinished', created: '2026-10-19', rule: 'test',
            runs: { 'src-20261018/tk-alpha': { battery: 'src-20261018', task: 'tk-alpha', runner: 'opencode', status: 'fail', question: QUESTION, compactions: 0, session: 'saved', rebuildable: true } } }));
    }
    if (parts.alphaSaved) for (const ext of ['json', 'tar.gz']) {
        const store = parts.alphaPinned ? 'session-store-pinned' : 'session-store';
        fs.mkdirSync(path.join(root, store, 'src-20261018'), { recursive: true });
        fs.writeFileSync(path.join(root, store, 'src-20261018', `tk-alpha.${ext}`), '{}');
    }
    // the continuation of alpha (passes, its bonus passes) and of eps (fails); and one in an INVALID- battery on beta
    const src = (f, st = 'fail') => ({ battery: 'src-20261018', result: path.join(root, 'results', 'src-20261018', f), session: 'ses_0', previous_status: st, previous_wall_s: 1440 });
    if (parts.cont) {
        put('cont-20261019', 'tk-alpha.json', result('tk-alpha', 'pass', { resent: CONTINUE, continuedFrom: src('tk-alpha.json'), bonus: true }), 1000);
        put('cont-20261019', 'tk-eps.json', result('tk-eps', 'fail', { assertions: [2, 3], resent: CONTINUE, continuedFrom: src('tk-eps.json') }), 1001);
    }
    if (parts.invalidCont) put('INVALID-cont', 'tk-beta.json', result('tk-beta', 'fail', { resent: CONTINUE, continuedFrom: src('tk-beta.json', 'pass') }), 1100);
    if (parts.chain) put('cont2-20261020', 'tk-alpha.json', result('tk-alpha', 'pass', { resent: CONTINUE,
        continuedFrom: { battery: 'cont-20261019', result: path.join(root, 'results', 'cont-20261019', 'tk-alpha.json'), previous_status: 'pass' } }), 1200);
    return root;
}
function catalogOf(t, root) {
    const had = process.env.CODEBENCH_ANNOTATIONS_DIR;
    process.env.CODEBENCH_ANNOTATIONS_DIR = path.join(root, 'annotations');
    A._resetForTests();
    t.after(() => { if (had === undefined) delete process.env.CODEBENCH_ANNOTATIONS_DIR; else process.env.CODEBENCH_ANNOTATIONS_DIR = had; A._resetForTests(); M.configure({}); });
    M.configure({
        paths: { csv: path.join(root, 'none.csv'), bestConfigs: path.join(root, 'none.md'), benchLog: path.join(root, 'none.log'), sweepState: path.join(root, 'none.json'),
            codebenchRoot: root, dashboardConfig: path.join(root, 'nope.json') },
        queueLaunch: new Map(),
    });
    const runs = Object.fromEntries(C.listRuns(root).map((r) => [r.dir, r]));
    const cat = JSON.parse(JSON.stringify(M.listModels()));
    const idx = ID.scoredIndex();
    const cells = JSON.stringify([...idx.cells].map(([k, m]) => [k, [...m].map(([task, l]) => [task, l.map((x) => [x.status, x.dir])]).sort()]).sort());
    return { cat, runs, idx, cells, m: cat.models.find((x) => x.key === KEY) };
}
// what must be identical: drop the display-only fields and the absolute paths
const DISPLAY = new Set(['unfinished', 'answeredNotes', 'generatedAt', 'path', 'history']);
const drop = (x) => JSON.parse(JSON.stringify(x, (k, v) => (DISPLAY.has(k) ? undefined : v)));
const summaryCounts = (r) => r && { tasks: r.tasks, solved: r.solved, scored: r.scored, excluded: r.excluded, counts: r.counts, assertions: r.assertions, bonus: r.bonus };

test('taskRow: `answered` (end of run / continue-from) and `unfinished` (run.unfinished, never once the question was answered)', () => {
    const e = C.taskRow({ file: 'tk.json', data: result('tk', 'pass', { resent: END_OF_RUN }) });
    assert.deepStrictEqual(e.answered, { via: 'end of run', at_s: 400.5, compactions: 0, asked: 'SECRET-ASKED-EOR: tests or not?' });
    assert.strictEqual(e.unfinished, null);
    const u = C.taskRow({ file: 'tk.json', data: result('tk', 'fail', { unfinished: UNF }) });
    assert.deepStrictEqual(u.unfinished, { question: QUESTION, compactions: 1, why: 'ended asking', source: 'run' });
    assert.strictEqual(u.answered, null);
    assert.strictEqual(C.taskRow({ file: 'tk.json', data: result('tk', 'fail', { unfinished: UNF, resent: END_OF_RUN }) }).unfinished, null, 'answered: not unfinished');
    assert.strictEqual(C.taskRow({ file: 'tk.json', data: result('tk', 'fail', { unfinished: { ...UNF, ending: 'done' } }) }).unfinished, null);
    const c = C.taskRow({ file: 'tk.json', data: result('tk', 'pass', { resent: CONTINUE, continuedFrom: { result: '/r/results/src-b/tk.json' } }) });
    assert.strictEqual(c.answered.via, 'continue-from');
    assert.strictEqual(c.continuation.src_dir, 'src-b');
    assert.strictEqual(c.status, 'pass');
});

test('session state: saved in the store or the pinned store; pruned when a store exists without it; the index word without stores', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'unf-ses-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    assert.strictEqual(C.sessionState(root, 'b', 't.json', 'saved'), 'saved', 'no store at all: the index says');
    assert.strictEqual(C.sessionState(root, 'b', 't.json', null), null);
    fs.mkdirSync(path.join(root, 'session-store', 'b'), { recursive: true });
    assert.strictEqual(C.sessionState(root, 'b', 't.json', 'saved'), 'pruned');
    fs.writeFileSync(path.join(root, 'session-store', 'b', 't.json'), '{}');
    assert.strictEqual(C.sessionState(root, 'b', 't.json'), 'pruned', 'the archive is needed too');
    fs.writeFileSync(path.join(root, 'session-store', 'b', 't.keep'), '');
    fs.mkdirSync(path.join(root, 'session-store-pinned', 'b'), { recursive: true });
    for (const ext of ['json', 'tar.gz']) fs.writeFileSync(path.join(root, 'session-store-pinned', 'b', `t.${ext}`), '{}');
    assert.strictEqual(C.sessionState(root, 'b', 't.json'), 'saved', 'a pinned session counts');
});

test('unfinished rows are in no tally: the catalog, the fit, the battery summary and the "scored" index are those without them', async (t) => {
    const L = await ui('shared/leaderboard.js');
    const ref = catalogOf(t, tree(t, {}));
    const got = catalogOf(t, tree(t, { alpha: true, gamma: true, alphaSaved: true }));
    assert.ok(ref.m && got.m);
    assert.deepStrictEqual(drop(got.m.quality), drop(ref.m.quality), 'solved / scored / counts');
    assert.deepStrictEqual(drop(got.m.tasks), drop(ref.m.tasks), 'every task cell (and no +bonus cell of the unfinished alpha)');
    assert.deepStrictEqual(drop(got.m.configs), drop(ref.m.configs), 'every config row');
    assert.deepStrictEqual(got.m.counts, ref.m.counts);
    assert.deepStrictEqual(got.cat.models.map((m) => m.key), ref.cat.models.map((m) => m.key));
    assert.strictEqual(got.cells, ref.cells, 'the config-identity "scored" tally');
    assert.deepStrictEqual(summaryCounts(got.runs['src-20261018']), summaryCounts(ref.runs['src-20261018']), 'the battery summary');
    assert.strictEqual(got.runs['src-20261018'].unfinished, 2);
    const q = L.FACET_DEFAULTS.quality, full = L.FACET_DEFAULTS.full;
    assert.deepStrictEqual(JSON.parse(JSON.stringify([...L.fitFor(drop(got.cat.models), q, full).adj.entries()])),
        JSON.parse(JSON.stringify([...L.fitFor(drop(ref.cat.models), q, full).adj.entries()])), 'the strength fit');
    // shown apart: the config row's `unfinished` map (beside `tasks`), with the session state
    const u = got.m.configs[0].unfinished;
    assert.deepStrictEqual(Object.keys(u).sort(), ['tk-alpha', 'tk-alpha+bonus', 'tk-gamma']);
    assert.deepStrictEqual([u['tk-alpha'].saved, u['tk-gamma'].pruned, u['tk-gamma'].compacted], [1, 1, 1]);
    assert.strictEqual(u['tk-gamma'].unfinishedNotes[0].question, QUESTION);
    assert.strictEqual(got.m.tasks['tk-alpha'], undefined);
    // the task page's goals panel and the battery view
    assert.ok(!C.listTaskCases('tk-alpha', got.runs['src-20261018'].path.replace(/\/results\/.*$/, '')).length);
    const rows = C.getRun('src-20261018', got.runs['src-20261018'].path.replace(/\/results\/.*$/, '')).rows;
    const alpha = rows.filter((r) => r.file === 'tk-alpha.json');
    assert.strictEqual(alpha.length, 2, 'base and +bonus');
    assert.ok(alpha.every((r) => r.unfinished && r.unfinished.session === 'saved' && r.unfinished.rebuildable === true), 'the +bonus row is unfinished too');
    // the model page lists them, apart
    assert.deepStrictEqual(M.getModel(KEY).qualityDetail.unfinishedRuns.map((x) => x.task), ['tk-alpha', 'tk-gamma']);
});

test('asked but passed -> counts as pass: a pass / pass* that ended asking is in every tally, never unfinished (index or run.unfinished)', async (t) => {
    const L = await ui('shared/leaderboard.js');
    const ref = catalogOf(t, tree(t, { passPlain: true }));
    const gotRoot = tree(t, { passAsked: true, alphaSaved: true });
    const got = catalogOf(t, gotRoot);
    assert.ok(ref.m && got.m);
    assert.deepStrictEqual(drop(got.m.quality), drop(ref.m.quality), 'solved / scored / counts');
    assert.deepStrictEqual(drop(got.m.tasks), drop(ref.m.tasks), 'every task cell, the +bonus of alpha included');
    assert.ok(got.m.tasks['tk-alpha'] && got.m.tasks['tk-alpha+bonus'] && got.m.tasks['tk-gamma'], 'the passes are cells');
    assert.deepStrictEqual(drop(got.m.configs), drop(ref.m.configs), 'every config row');
    assert.strictEqual(got.cells, ref.cells, 'the config-identity "scored" tally');
    assert.deepStrictEqual(summaryCounts(got.runs['src-20261018']), summaryCounts(ref.runs['src-20261018']), 'the battery summary');
    assert.strictEqual(got.runs['src-20261018'].unfinished, null);
    const q = L.FACET_DEFAULTS.quality, full = L.FACET_DEFAULTS.full;
    assert.deepStrictEqual(JSON.parse(JSON.stringify([...L.fitFor(drop(got.cat.models), q, full).adj.entries()])),
        JSON.parse(JSON.stringify([...L.fitFor(drop(ref.cat.models), q, full).adj.entries()])), 'the strength fit');
    assert.ok(!got.m.configs[0].unfinished || !Object.keys(got.m.configs[0].unfinished).length, 'nothing listed apart');
    const rows = C.getRun('src-20261018', gotRoot).rows;
    assert.ok(rows.filter((r) => /^tk-(alpha|gamma)\.json$/.test(r.file)).every((r) => !r.unfinished), 'no row (nor +bonus) is unfinished');
    assert.deepStrictEqual(rows.filter((r) => /^tk-(alpha|gamma)$/.test(r.task)).map((r) => r.status).sort(), ['pass', 'pass*']);
    assert.strictEqual(C.taskRow({ file: 'tk.json', data: result('tk', 'pass*', { unfinished: UNF }) }).unfinished, null);
    assert.ok(C.solvedRun(result('tk', 'pass')) && C.solvedRun(result('tk', 'pass*')) && !C.solvedRun(result('tk', 'fail')));
    // the duplicate guard: a passed cell is scored, not held for a continuation
    const spec = { dir: 'probe', config: { ...MANIFEST }, server: SERVER };
    const out = require('../tools/config-identity').answer('check', { spec, tasks: ['tk-alpha', 'tk-gamma', 'tk-beta'] });
    assert.deepStrictEqual(Object.keys(out.scored).sort(), ['tk-alpha', 'tk-beta', 'tk-gamma']);
    assert.deepStrictEqual(Object.keys(out.unfinished || {}), []);
});

test('a continuation counts (base and +bonus) and supersedes its source; an INVALID- one supersedes nothing; a chain walks back', (t) => {
    // the reference: the same tree with the superseded sources simply absent
    const ref = catalogOf(t, (() => { const r = tree(t, { cont: true }); fs.rmSync(path.join(r, 'results', 'src-20261018', 'tk-eps.json')); return r; })());
    const got = catalogOf(t, tree(t, { alpha: true, alphaSaved: true, cont: true, invalidCont: true }));
    assert.deepStrictEqual(drop(got.m.quality), drop(ref.m.quality));
    assert.deepStrictEqual(drop(got.m.tasks), drop(ref.m.tasks));
    assert.strictEqual(got.cells, ref.cells);
    const tasks = got.m.tasks;
    assert.deepStrictEqual([tasks['tk-alpha'].credit, tasks['tk-alpha'].attempts, tasks['tk-alpha'].status], [1, 1, 'pass'], 'the continuation is the score');
    assert.deepStrictEqual([tasks['tk-alpha+bonus'].credit, tasks['tk-alpha+bonus'].attempts], [1, 1], 'its +bonus counts; the source\'s +bonus does not');
    assert.deepStrictEqual([tasks['tk-eps'].credit, tasks['tk-eps'].attempts], [0, 1], 'a failed continuation replaces the source too');
    assert.strictEqual(tasks['tk-beta'].credit, 1, 'an INVALID- continuation supersedes nothing');
    // the cell: answered then passed (dark green), with the source as history
    assert.deepStrictEqual([tasks['tk-alpha'].answered.passed, tasks['tk-alpha'].answered.failed, tasks['tk-alpha'].answered.compacted], [1, 0, 1]);
    const h = tasks['tk-alpha'].answered.answeredNotes[0].history;
    assert.deepStrictEqual(h.map((x) => [x.dir, x.status, x.asked]), [['src-20261018', 'fail', QUESTION]]);
    assert.deepStrictEqual([tasks['tk-eps'].answered.passed, tasks['tk-eps'].answered.failed], [0, 1], 'answered, then failed: an ordinary fail');
    assert.strictEqual(tasks['tk-delta'].answered.passed, 1, 'a pass after an end-of-run re-send: dark green');
    assert.ok(tasks['tk-delta'].resent, 'its re-sent mark (speed-neutral stage) stays');
    assert.strictEqual(tasks['tk-beta'].answered, undefined);
    // the source battery: superseded rows out of its counts
    assert.strictEqual(got.runs['src-20261018'].superseded, 2);
    assert.strictEqual(got.runs['src-20261018'].unfinished, null, 'a superseded run is not unfinished');
    assert.deepStrictEqual([got.runs['cont-20261019'].solved, got.runs['cont-20261019'].scored], [2, 3], 'base + bonus pass, eps fails');
    const srcRows = C.getRun('src-20261018', got.runs['src-20261018'].path.replace(/\/results\/.*$/, '')).rows;
    assert.ok(srcRows.filter((r) => r.file === 'tk-alpha.json').every((r) => r.superseded && r.superseded.by[0].dir === 'cont-20261019' && !r.unfinished));
    // a chain: cont2 continues cont's alpha -> cont's alpha is superseded too; the history walks back to the source
    const chain = catalogOf(t, tree(t, { alpha: true, cont: true, chain: true }));
    const ca = chain.m.tasks['tk-alpha'];
    assert.deepStrictEqual([ca.credit, ca.attempts], [1, 1]);
    assert.deepStrictEqual(ca.answered.answeredNotes.find((n) => n.dir === 'cont2-20261020').history.map((x) => x.dir), ['src-20261018', 'cont-20261019']);
});

test('public data: counts and category notes only -- no question, no note, no history', async (t) => {
    const got = catalogOf(t, tree(t, { alpha: true, gamma: true, alphaSaved: true, cont: true }));
    const priv = JSON.stringify(got.cat);
    assert.match(priv, /SECRET-QUESTION/);
    const pub = JSON.stringify(sanitizeCatalog(got.cat));
    assert.doesNotMatch(pub, /SECRET-|answeredNotes|unfinishedNotes|unfinishedRuns|askedAnswerable/);
    const det = JSON.stringify(sanitizePayload(M.getModel(KEY)));
    assert.doesNotMatch(det, /SECRET-/);
    const p = JSON.parse(pub).models.find((m) => m.key === KEY);
    assert.deepStrictEqual(p.tasks['tk-delta'].answered, { passed: 1, failed: 0, compacted: 0 });
    assert.deepStrictEqual(p.configs[0].unfinished['tk-gamma'], { n: 1, compacted: 1, saved: 0, pruned: 1, unknown: 0 });
    const S = require('../public/staticsite');
    assert.deepStrictEqual(S.leakScan('data/catalog.json', pub).filter((h) => /dropped key/.test(h.what)), []);
    const U = await ui('benchmarks/util.js');
    assert.strictEqual(U.answeredCategory({ passed: 1, compacted: 1 }), 'passed after the original prompt was re-supplied (asked after compaction)');
    assert.strictEqual(U.answeredCategory({ passed: 1, compacted: 0 }), 'passed after the original prompt was re-supplied (asked)');
    assert.strictEqual(U.unfinishedCategory({ n: 1 }), 'unfinished: the run stopped to ask a question; awaiting the answer');
    assert.strictEqual(U.PASS_AT_CAP_NOTE, 'code passed the tests although the run hit the time limit');
    assert.deepStrictEqual(U.answeredLines({ passed: 1 }), [], 'no notes (public): no detail lines');
    assert.deepStrictEqual(U.unfinishedLines({ n: 1 }), []);
});

test('display: dark green for passes under special conditions (pass*, answered-then-passed); unfinished is a hatched mid gray; the lab shows the question', async () => {
    const U = await ui('benchmarks/util.js');
    const Ch = await ui('models/charts.js');
    assert.strictEqual(U.SPECIAL_PASS_FILL, '#166534');
    assert.strictEqual(U.ANSWERED_FILL, U.SPECIAL_PASS_FILL, 'the old name stays, as an alias');
    assert.strictEqual(U.UNFINISHED_FILL, '#8a909b');
    assert.strictEqual(U.UNFINISHED_INK, '#111827', 'dark ink: light ink on the gray was 3.1:1');
    assert.match(U.answeredChip({ passed: 1, failed: 0, compacted: 0 }), /background:#166534/);
    assert.doesNotMatch(U.answeredChip({ passed: 0, failed: 1, compacted: 0 }), /#166534/, 'answered then failed: no green');
    // a continuation row: dark green only when it passed
    assert.match(U.continuationChip({ src_dir: 's', src_file: 't.json' }, true), /background:#166534/);
    assert.doesNotMatch(U.continuationChip({ src_dir: 's', src_file: 't.json' }, false), /#166534/, 'a failed continuation: no green');
    assert.match(U.continuationChip({ src_dir: 's', src_file: 't.json' }, false), /continues s\/t\.json with the original prompt/);
    // pass* chips wear the same dark green, with the public category note as their title
    assert.match(U.statusChip('pass*'), /background:#166534/);
    assert.match(U.statusChip('pass*'), /code passed the tests although the run hit the time limit/);
    assert.doesNotMatch(U.statusChip('pass'), /#166534/);
    // the special conditions of a passed cell: category notes only (no task text), [] for a plain pass or a miss
    assert.deepStrictEqual(U.specialPassNotes({ status: 'pass*', credit: 1, passes: 1 }), ['code passed the tests although the run hit the time limit']);
    assert.deepStrictEqual(U.specialPassNotes({ status: 'pass', credit: 1, passes: 2, answered: { passed: 1, compacted: 1 } }),
        ['passed after the original prompt was re-supplied (asked after compaction) (on 1 of its 2 passing runs)']);
    assert.deepStrictEqual(U.specialPassNotes({ status: 'pass*', credit: 1, passes: 1, answered: { passed: 1, compacted: 0 } }),
        ['passed after the original prompt was re-supplied (asked)', 'code passed the tests although the run hit the time limit']);
    assert.deepStrictEqual(U.specialPassNotes({ status: 'pass', credit: 1, passes: 1 }), []);
    assert.deepStrictEqual(U.specialPassNotes({ status: 'pass*', credit: 0.5, passes: 1 }), [], 'passed on some runs: the green-over-red split, not dark green');
    assert.deepStrictEqual(U.specialPassNotes({ status: 'fail', credit: 0, passes: 0, answered: { passed: 0, failed: 1 } }), []);
    const unf = { n: 1, compacted: 0, saved: 1, pruned: 0, unknown: 0, unfinishedNotes: [{ dir: 'b', question: QUESTION, session: 'saved', ai: { answerable: 'yes', note: 'the prompt answers it' } }] };
    const chip = U.unfinishedChip(unf);
    assert.match(chip, /background:#8a909b;color:#111827/);
    assert.doesNotMatch(chip, /#3d5a80/, 'no slate blue left');
    assert.match(chip, /unfinished · awaiting answer/);
    assert.match(chip, /SECRET-QUESTION/, 'the lab quotes the question');
    assert.match(chip, /AI review \(yes\): the prompt answers it/, 'and the reviewer\'s note when there is one');
    const tip = Ch.askTooltip({ unfinished: unf });
    assert.ok(tip.some((l) => /SECRET-QUESTION/.test(l)));
    const hist = Ch.askTooltip({ answered: { passed: 1, answeredNotes: [{ via: 'continue-from', status: 'pass', dir: 'c', at_s: 1440, compactions: 2, asked: 'x',
        history: [{ dir: 'src', status: 'fail', at_s: 1440, asked: 'keep the column?' }] }] } });
    assert.match(hist.join(' '), /first stopped at 24 min asking: "keep the column\?"/);
    // a pass*'s wall clock: a lab detail line (taskGrid sets capWall only off the public site)
    assert.deepStrictEqual(Ch.askTooltip({ capWall: 7195 }), ["   the run's wall clock: 2 h 00 min, at the time limit"]);
    assert.deepStrictEqual(Ch.askTooltip({}), []);
    // the grid: one dark green for every special pass, from specialPassNotes; the unfinished box from r.unfinished
    const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'models', 'charts.js'), 'utf-8');
    assert.match(src, /const notes = specialPassNotes\(t\);\n\s*if \(notes\.length\) return \{ c: SPECIAL_PASS_FILL/);
    assert.match(src, /\.\.\.\(t\.status === 'pass\*' && !opts\.publicSite && Number\(t\.wall_s\) > 0 \? \{ capWall: /, 'no wall clock on the public site');
    assert.match(src, /const ans = specialPassNotes\(t\)\.length > 0;/, 'the light edge on every special pass, pass* included');
    assert.match(src, /if \(!t && u\) return \{ \.\.\.UNFINISHED, t: unfinishedCategory\(u\)/);
    assert.doesNotMatch(src, /return t\.resent \? \{ c: OUTCOME\['pass\*'\]\.c/, 'the faded re-sent green is gone');
    assert.doesNotMatch(src, /rgba\(52,(201,138|211,153),0\.(45|55)\)/, 'the faded pass* green is gone');
    assert.match(src, /'pass\*': \{ c: SPECIAL_PASS_FILL, t: `pass\* — \$\{PASS_AT_CAP_NOTE\}` \}/);
    const L = fs.readFileSync(path.join(__dirname, '..', 'ui', 'shared', 'leaderboard.js'), 'utf-8');
    assert.match(L, /'pass\*': '#166534'/, 'STATUS_COLOR pass*: dark green, not amber');
    const idx = fs.readFileSync(path.join(__dirname, '..', 'ui', 'models', 'index.js'), 'utf-8');
    assert.match(idx, /passed under special conditions<\/span>/);
    assert.doesNotMatch(idx, /pass at the time cap<\/span>|slate blue|faded green/);
    assert.match(idx, /publicSite: PUBLIC/);
});

test('config-identity check returns `unfinished`; unfinished rows are not in `scored`; the queue guard holds a saved one, frees a pruned one', (t) => {
    const root = tree(t, { alpha: true, gamma: true, alphaSaved: true });
    catalogOf(t, root);
    const spec = { dir: 'probe', config: { ...MANIFEST }, server: SERVER };
    const out = require('../tools/config-identity').answer('check', { spec, tasks: ['tk-alpha', 'tk-gamma', 'tk-beta', 'tk-zeta'] });
    assert.ok(out.identity);
    assert.deepStrictEqual(Object.keys(out.scored).sort(), ['tk-beta']);
    assert.deepStrictEqual(Object.keys(out.unfinished).sort(), ['tk-alpha', 'tk-gamma']);
    assert.deepStrictEqual(out.unfinished['tk-alpha'].map((u) => [u.dir, u.session, u.rebuildable]), [['src-20261018', 'saved', true]]);
    assert.strictEqual(out.unfinished['tk-alpha'][0].result, path.join(root, 'results', 'src-20261018', 'tk-alpha.json'));
    assert.deepStrictEqual(out.unfinished['tk-gamma'].map((u) => [u.session, u.rebuildable]), [['pruned', null]]);
    assert.ok(ID.awaitsContinuation(out.unfinished['tk-alpha'][0]));
    assert.ok(!ID.awaitsContinuation(out.unfinished['tk-gamma'][0]));
    assert.ok(!ID.awaitsContinuation({ session: 'saved', rebuildable: false }), 'saved but not rebuildable: fresh-eligible');
    const bats = require('../tools/config-identity').answer('batteries');
    assert.ok(bats.batteries['src-20261018'], 'the battery with scored rows is listed');
});

test('planner: an unfinished task with a saved session counts as covered (awaiting continuation); a pruned one may be picked fresh', async () => {
    const { derive, plannerCatalog } = await ui('autoqueue/derive.js');
    const { plan } = await ui('shared/planner.js');
    const tk = (solved) => ({ status: solved ? 'pass' : 'fail', solved, excluded: false, credit: solved ? 1 : 0, attempts: 1, passes: solved ? 1 : 0, wall_s: 300, ran_at: 1 });
    const cfg = (tasks, unfinished) => ({ key: 'cfg', runnerModel: 'llama-local/m', n_ctx: 131072, timeout_s: 7200, dirs: ['d'],
        facets: { weights: 'local:m', harness: { runnerModel: 'llama-local/m' }, context: { n_ctx: 131072 } },
        agg: { attempted: Object.keys(tasks).length, scored: Object.keys(tasks).length }, tasks, ...(unfinished ? { unfinished } : {}) });
    const u = (saved, pruned) => ({ n: 1, compacted: 0, saved, pruned, unknown: 0 });
    const raw = { allTaskIds: ['a', 'b', 'c', 'd', 'e', 'f'], taskMeta: {}, models: [
        { key: 'local:m', display: 'm', weightsKey: 'local:m', counts: { qualityTasks: 2 }, quality: {}, tasks: { a: tk(1), b: tk(0) },
            configs: [cfg({ a: tk(1), b: tk(0) }, { c: u(1, 0), d: u(0, 1) })] },
        { key: 'local:o', display: 'o', weightsKey: 'local:o', counts: { qualityTasks: 6 }, quality: {}, tasks: {},
            configs: [{ ...cfg({ a: tk(1), b: tk(0), c: tk(1), d: tk(0), e: tk(1), f: tk(0) }), facets: { weights: 'local:o', harness: { runnerModel: 'llama-local/o' }, context: { n_ctx: 131072 } }, runnerModel: 'llama-local/o' }] },
    ] };
    raw.models[1].tasks = raw.models[1].configs[0].tasks;
    const settings = { models: [{ id: 'm', catalogKey: 'local:m', role: 'both', nCtx: 131072 }, { id: 'o', catalogKey: 'local:o', role: 'ignored' }] };
    const d = derive(plannerCatalog(raw), settings);
    const m = d.input.models.find((x) => x.id === 'm');
    assert.deepStrictEqual(m.pendingContinuation, ['c']);
    assert.deepStrictEqual(m.cfg.c, { ran: true, passed: false, pendingContinuation: true });
    assert.strictEqual(m.cfg.d, undefined, 'pruned: free for a fresh run');
    const out = plan(d.input, { budget: { localHours: 100, cloud: false, cloudHours: 0, switchMin: 0 }, minValue: 0, topK: 6, weights: { top: 1, speed: 0.6, difficulty: 1 } });
    const picked = ((out.legs.find((l) => l.model === 'm') || { runs: [] }).runs.map((r) => r.task));
    assert.ok(!picked.includes('c'), 'the saved one is not picked fresh');
    assert.ok(picked.includes('d'), `the pruned one may be: ${picked}`);
});

test('queue guard: dropScored holds a task waiting for a continuation apart from "already ran"; a pruned one goes through', (t) => {
    const root = tree(t, { alpha: true, gamma: true, alphaSaved: true });
    catalogOf(t, root);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'unf-q-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, 'vars.env'), '');
    const { createQueue } = require('../lib/queue.js');
    const q = createQueue({ dbPath: path.join(dir, 'bench.sqlite'), envFiles: [path.join(dir, 'vars.env')], identity: true });
    t.after(() => { try { q.close(); } catch { /* closed */ } });
    const settings = { models: [{ id: 'A', lane: 'local', cmd: SERVER.launch_command, opencodeModel: 'qwen38-27b-q4-128k' }] };
    const g = q.dropScored({ legs: [{ model: 'A', lane: 'local', runs: [{ task: 'tk-alpha' }, { task: 'tk-gamma' }, { task: 'tk-beta' }, { task: 'tk-zeta' }] }] }, settings);
    assert.deepStrictEqual(g.pendingContinuation, [{ model: 'A', task: 'tk-alpha' }], 'saved session: waits for a continuation');
    assert.deepStrictEqual(g.dropped, [{ model: 'A', task: 'tk-beta' }], 'scored: already ran');
    assert.deepStrictEqual(g.batch.legs[0].runs.map((r) => r.task), ['tk-gamma', 'tk-zeta'], 'pruned and untried: free');
    const all = q.dropScored({ rerunScored: true, legs: [{ model: 'A', lane: 'local', runs: [{ task: 'tk-alpha' }, { task: 'tk-beta' }] }] }, settings);
    assert.deepStrictEqual(all.batch.legs[0].runs.map((r) => r.task), ['tk-beta'], 're-runs on: a waiting task is still never run fresh');
});
