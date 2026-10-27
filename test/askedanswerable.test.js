'use strict';
// Kyle, 2026-10-19: the annotations reader (lib/annotations.js, <codebench root>/annotations/*.json). Kind
// "asked-answerable" (a reviewer's note that the task prompt answers the question a run ended on) is attached to result
// rows by codebench getRun and shown as an extra note on UNFINISHED cells (test/unfinished.test.js has the rest).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../lib/annotations');
const C = require('../lib/codebench');
const M = require('../lib/models');

const FIXTURE_DIR = path.join(__dirname, 'fixtures', 'annotations-asked');

function withEnv(t, dir) {
    const had = process.env.CODEBENCH_ANNOTATIONS_DIR;
    if (dir == null) delete process.env.CODEBENCH_ANNOTATIONS_DIR; else process.env.CODEBENCH_ANNOTATIONS_DIR = dir;
    A._resetForTests();
    t.after(() => { if (had === undefined) delete process.env.CODEBENCH_ANNOTATIONS_DIR; else process.env.CODEBENCH_ANNOTATIONS_DIR = had; A._resetForTests(); });
}

test('annotations: yes and partly are kept, no is dropped; a missing note is built from asked / where', (t) => {
    withEnv(t, FIXTURE_DIR);
    const m = A.askedAnswerableMap('/nonexistent-root');
    assert.deepStrictEqual([...m.keys()].sort(), ['bat-a/task-bonus', 'bat-a/task-four-L3', 'bat-a/task-one', 'bat-a/task-two']);
    assert.deepStrictEqual(m.get('bat-a/task-one'), { answerable: 'yes', note: 'ended asking "Should I use the existing Stripe customer?"; the prompt answers this: reuse the customer on file' });
    assert.deepStrictEqual(m.get('bat-a/task-two'), { answerable: 'partly', note: 'ended asking "Which timezone?"; the prompt answers this: prompt says venue-local time, not which venue' });
    assert.strictEqual(A.askedAnswerableOf('/x', 'bat-a', 'task-one.json').answerable, 'yes', 'the file name may carry .json');
    assert.strictEqual(A.askedAnswerableOf('/x', 'bat-a', 'task-three.json'), null, 'answerable "no" is not marked');
    assert.strictEqual(A.askedAnswerableOf('/x', 'bat-b', 'task-one.json'), null, 'keyed by battery AND file');
    // the default directory is <root>/annotations
    withEnv(t, null);
    assert.strictEqual(A.annotationsDir('/r'), path.join('/r', 'annotations'));
});

test('annotations: a missing dir, garbage, another kind or version, a bad run: no marks and no throw', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asked-ann-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    withEnv(t, path.join(tmp, 'nope'));
    assert.strictEqual(A.askedAnswerableMap('/x').size, 0);
    assert.strictEqual(A.signature('/x'), '-');
    const dir = path.join(tmp, 'ann'); fs.mkdirSync(dir);
    withEnv(t, dir);
    fs.writeFileSync(path.join(dir, 'a-garbage.json'), '{ not json');
    fs.writeFileSync(path.join(dir, 'b-other-kind.json'), JSON.stringify({ v: 1, kind: 'something-else', runs: { 'b/t': { answerable: 'yes', note: 'x' } } }));
    fs.writeFileSync(path.join(dir, 'c-v2.json'), JSON.stringify({ v: 2, kind: 'asked-answerable', runs: { 'b/t': { answerable: 'yes', note: 'x' } } }));
    fs.writeFileSync(path.join(dir, 'd-bad-runs.json'), JSON.stringify({ v: 1, kind: 'asked-answerable', runs: { 'b/t': 'yes', 'nokey': { answerable: 'yes' }, 'b/u': null, 'b/w': { answerable: 7 } } }));
    fs.writeFileSync(path.join(dir, 'e-array.json'), '[1,2,3]');
    fs.writeFileSync(path.join(dir, 'not-json.txt'), 'ignored');
    assert.doesNotThrow(() => A.askedAnswerableMap('/x'));
    assert.strictEqual(A.askedAnswerableMap('/x').size, 0);
});

test('annotations: a file that lands is read on the next catalog check (no TTL lag), and a later file wins for one run', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asked-ann-'));
    t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    withEnv(t, tmp);
    const s0 = A.signature('/x');
    assert.strictEqual(A.askedAnswerableMap('/x').size, 0);
    fs.writeFileSync(path.join(tmp, 'asked-answerable-1.json'), JSON.stringify({ v: 1, kind: 'asked-answerable', runs: { 'b/t': { answerable: 'yes', note: 'first' } } }));
    const s1 = A.signature('/x');   // what lib/models.js inputSignature asks before a build
    assert.notStrictEqual(s1, s0);
    assert.strictEqual(A.askedAnswerableOf('/x', 'b', 't').note, 'first', 'read at once, inside the TTL');
    fs.writeFileSync(path.join(tmp, 'asked-answerable-2.json'), JSON.stringify({ v: 1, kind: 'asked-answerable', runs: { 'b/t': { answerable: 'no' }, 'b/u': { answerable: 'PARTLY', note: 'second' } } }));
    A.signature('/x');
    assert.strictEqual(A.askedAnswerableOf('/x', 'b', 't'), null, 'the later review says no');
    assert.deepStrictEqual(A.askedAnswerableOf('/x', 'b', 'u'), { answerable: 'partly', note: 'second' });
});

test('getRun: rows are marked by battery + result file (a level file too), never the bonus row; nothing else changes', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asked-root-'));
    t.after(() => { fs.rmSync(root, { recursive: true, force: true }); C._resetForTests && C._resetForTests(); });
    const bat = path.join(root, 'results', 'bat-a');
    fs.mkdirSync(bat, { recursive: true });
    const res = (task, status, extra = {}) => ({ task, runner: 'opencode', model: 'llama-local/x', status, run: { wall_s: 100, tokens_out: 10, tool_calls: 2 },
        score: { solved: status === 'pass', assertions: { passed: status === 'pass' ? 3 : 1, failed: status === 'pass' ? 0 : 2, total: 3 } }, ...extra });
    fs.writeFileSync(path.join(bat, 'task-one.json'), JSON.stringify(res('task-one', 'fail')));
    fs.writeFileSync(path.join(bat, 'task-two.json'), JSON.stringify(res('task-two', 'fail')));
    fs.writeFileSync(path.join(bat, 'task-three.json'), JSON.stringify(res('task-three', 'fail')));
    fs.writeFileSync(path.join(bat, 'task-four-L3.json'), JSON.stringify(res('task-four', 'fail', { manifest: { prompt_level: 'L3' } })));
    fs.writeFileSync(path.join(bat, 'task-bonus.json'), JSON.stringify(res('task-bonus', 'pass', { score: { solved: true, extra: { ran_any: true, all: false, passed: 1, total: 2 } } })));
    fs.writeFileSync(path.join(bat, 'task-plain.json'), JSON.stringify(res('task-plain', 'pass')));

    withEnv(t, path.join(root, 'no-annotations'));
    const before = C.getRun('bat-a', root).rows;
    withEnv(t, FIXTURE_DIR);
    const after = C.getRun('bat-a', root).rows;
    assert.strictEqual(after.length, before.length);
    const by = (rows) => Object.fromEntries(rows.map((r) => [r.task, r]));
    const B = by(before), Aft = by(after);
    assert.strictEqual(Aft['task-one'].askedAnswerable.answerable, 'yes');
    assert.strictEqual(Aft['task-two'].askedAnswerable.answerable, 'partly');
    assert.strictEqual(Aft['task-three'].askedAnswerable, undefined, '"no" is not marked');
    assert.strictEqual(Aft['task-four'].askedAnswerable.answerable, 'yes', 'keyed by the FILE (task-four-L3.json), not the task id');
    assert.strictEqual(Aft['task-bonus'].askedAnswerable.answerable, 'yes', 'the main row of the run');
    assert.ok(Aft['task-bonus+bonus'], 'the bonus row is there');
    assert.strictEqual(Aft['task-bonus+bonus'].askedAnswerable, undefined, 'the bonus row of the same run is not marked');
    assert.strictEqual(Aft['task-plain'].askedAnswerable, undefined);
    for (const k of Object.keys(B)) {
        const { askedAnswerable, ...rest } = Aft[k];
        assert.deepStrictEqual(rest, B[k], `${k}: every other field as before`);
    }
});

test('asked but passed -> counts as pass: an indexed pass keeps its note but is not unfinished; an indexed fail is (Kyle 2026-10-19)', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'asked-pass-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const bat = path.join(root, 'results', 'bat-p'), ann = path.join(root, 'annotations');
    fs.mkdirSync(bat, { recursive: true }); fs.mkdirSync(ann, { recursive: true });
    const res = (task, status, run = {}) => ({ task, runner: 'opencode', model: 'llama-local/x', status, run: { wall_s: 100, tokens_out: 10, tool_calls: 2, exit_code: 0, ...run },
        score: { solved: status !== 'fail', assertions: { passed: status === 'fail' ? 1 : 3, failed: status === 'fail' ? 2 : 0, total: 3 } } });
    const UNF = { ending: 'question', question: 'keep the column?', compactions: 0 };
    fs.writeFileSync(path.join(bat, 'task-pass.json'), JSON.stringify(res('task-pass', 'pass')));
    fs.writeFileSync(path.join(bat, 'task-star.json'), JSON.stringify(res('task-star', 'pass*', { unfinished: UNF })));
    fs.writeFileSync(path.join(bat, 'task-fail.json'), JSON.stringify(res('task-fail', 'fail')));
    const entry = (task, status) => ({ battery: 'bat-p', task, status, question: 'keep the column?', compactions: 0, session: 'pruned', rebuildable: null });
    fs.writeFileSync(path.join(ann, 'unfinished-asked-x.json'), JSON.stringify({ v: 1, kind: 'unfinished', created: '2026-10-19', rule: 'test',
        runs: { 'bat-p/task-pass': entry('task-pass', 'fail'), 'bat-p/task-fail': entry('task-fail', 'fail') } }));   // a stale 'fail' for the pass too
    fs.writeFileSync(path.join(ann, 'asked-answerable-x.json'), JSON.stringify({ v: 1, kind: A.KIND, runs: {
        'bat-p/task-pass': { answerable: 'yes', note: 'the prompt answers it' }, 'bat-p/task-fail': { answerable: 'yes', note: 'the prompt answers it' } } }));
    withEnv(t, ann);
    const out = C.getRun('bat-p', root);
    const by = Object.fromEntries(out.rows.map((r) => [r.task, r]));
    assert.strictEqual(by['task-pass'].unfinished, null, 'the index lists it, but it passed: counted');
    assert.strictEqual(by['task-star'].unfinished, null, 'run.unfinished on a pass* (older harness): counted');
    assert.ok(by['task-fail'].unfinished && by['task-fail'].unfinished.source === 'index', 'a fail that asked stays unfinished');
    assert.strictEqual(by['task-pass'].askedAnswerable.answerable, 'yes', 'the reviewer note is still shown');
    assert.deepStrictEqual([out.solved, out.scored, out.unfinished], [2, 2, 1], 'the battery summary counts both passes, holds the fail');
});

// ------------------------------------------------------------------ the catalog
function catalogFixture(t, rows) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'asked-cat-'));
    fs.mkdirSync(path.join(tmp, 'cbroot', 'results'), { recursive: true }); fs.mkdirSync(path.join(tmp, 'cbroot', 'tasks'), { recursive: true });
    t.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); M.configure({}); });
    const Q4 = '/m/Qwen3.8-27B-UD-Q4_K_XL.gguf';
    const cfg = { runner: 'opencode', model: 'llama-local/qwen38-27b-q4-128k', prompt_level: 'L2', harness_mode: 'agentic', timeout_s: 7200 };
    const run = (dir, ended) => ({ dir, ended, config: cfg, server: { model_path: Q4, build_info: 'b10499-6d0549831', n_ctx: 131072, launch_command: `/b/llama-server -m ${Q4} -c 131072 --jinja` } });
    M.configure({
        paths: { csv: path.join(tmp, 'none.csv'), bestConfigs: path.join(tmp, 'none.md'), benchLog: path.join(tmp, 'none.log'), sweepState: path.join(tmp, 'none.json'),
            codebenchRoot: path.join(tmp, 'cbroot'), dashboardConfig: path.join(tmp, 'nope.json') },
        codebench: { listRuns: () => Object.keys(rows).map((d, i) => run(d, i + 1)), getRun: (dir) => ({ rows: rows[dir] || [] }) },
        queueLaunch: new Map(),
    });
    return tmp;
}
const row = (task, status, asked) => ({ task, file: task + '.json', status, solved: status === 'pass', wall_s: 100, tokens_out: 10, tool_calls: 1,
    assertions: { passed: status === 'pass' ? 3 : 1, failed: status === 'pass' ? 0 : 2, total: 3 }, ...(asked ? { askedAnswerable: asked } : {}) });
const YES = { answerable: 'yes', note: 'ended asking "X?"; the prompt answers this: SECRET-PROMPT-QUOTE' };
const PARTLY = { answerable: 'partly', note: 'ended asking "Y?"; the prompt answers this: venue-local' };

test('catalog: the annotations dir is part of the catalog signature, so a review that lands rebuilds it', (t) => {
    const tmp = catalogFixture(t, { b1: [row('a', 'fail')] });
    const dir = path.join(tmp, 'ann'); fs.mkdirSync(dir);
    withEnv(t, dir);
    const s0 = M.catalogSignature().inputs;
    fs.writeFileSync(path.join(dir, 'asked-answerable-x.json'), JSON.stringify({ v: 1, kind: 'asked-answerable', runs: {} }));
    assert.notStrictEqual(M.catalogSignature().inputs, s0);
});

