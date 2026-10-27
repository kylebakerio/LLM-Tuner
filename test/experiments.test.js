'use strict';
// Side experiments (Bench -> codebench -> Experiments), first one verify-on-fail: codebench's
// harness resumes a FAILED run's session with "verify your work", re-scores, and stores the outcome
// under result.verify ONLY. Two things are pinned here:
//   1. the verify summary / listing / verify-transcript lookup in lib/codebench.js, and the
//      per-configuration summary in ui/benchmarks/experiments.js;
//   2. mainline isolation: a result whose verify.status is `pass` is still a `fail` everywhere the
//      mainline reads it (taskRow, the battery summary, lib/models.js foldQualityRows), and the
//      mainline transcript never resolves to the verify transcript.
// The fixture is synthetic and lives in a temp dir: nothing is written under the real results/.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../lib/codebench');
const M = require('../lib/models');

const line = (o) => JSON.stringify(o) + '\n';
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-verify-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const dir = path.join(root, 'results', 'haiku-low-solo-verifyfix');
    const base = (task, extra) => ({
        task, variant: 'fix', runner: 'claude', model: 'haiku', status: 'fail',
        manifest: { runner: 'claude', model: 'haiku', effort: 'low', timeout_s: 7200, started_at: '2026-09-25T05:41:00Z' },
        run: { wall_s: 600, tool_calls: 30, tool_errors: 0, tokens_in: 1000, tokens_out: 9000, exit_code: 0, transcript: path.join(dir, task, 'claude.jsonl'), scaffold: 'solo' },
        score: { solved: false, partial: 1 / 7, assertions: { passed: 1, failed: 6, total: 7 }, patch: 'diff --git a/x b/x\n', fail_to_pass: { passed: false, cases: [{ name: 'a', status: 'pass' }] } },
        ...extra,
    });
    const write = (task, data) => {
        fs.mkdirSync(path.join(dir, task), { recursive: true });
        fs.writeFileSync(path.join(dir, `${task}.json`), JSON.stringify(data));
        fs.writeFileSync(path.join(dir, task, 'claude.jsonl'), line({ type: 'system', subtype: 'init', session_id: 'S1' }) + line({ type: 'assistant', message: { content: [{ type: 'text', text: 'main run' }] } }));
    };
    // rescued: verify says pass 7/7
    write('t-rescued', base('t-rescued', { verify: {
        prompt: "Can you verify your work and make sure you didn't miss anything?", session: 'S1', cap_s: 1800,
        status: 'pass', solved: true, assertions: { passed: 7, failed: 0, total: 7 },
        cases: [{ name: 'a', status: 'pass' }, { name: 'b', status: 'pass' }], p2p_broken: [], patch_changed: true, patch: 'diff --git a/x b/x\n+fixed\n',
        run: { wall_s: 720, tool_calls: 12, tool_errors: 0, tokens_in: 500, tokens_out: 4000, exit_code: 0, transcript: path.join(dir, 't-rescued', 'verify.claude.jsonl') },
    } }));
    fs.writeFileSync(path.join(dir, 't-rescued', 'verify.claude.jsonl'), line({ type: 'system', subtype: 'init', session_id: 'S1' }) + line({ type: 'assistant', message: { content: [{ type: 'text', text: 'verified again' }] } }));
    // still failing, patch unchanged
    write('t-still', base('t-still', { verify: { status: 'fail', solved: false, assertions: { passed: 3, failed: 4, total: 7 }, patch_changed: false,
        run: { wall_s: 300, tokens_out: 2000, tool_calls: 5, exit_code: 0 } } }));
    // timed out
    write('t-timeout', base('t-timeout', { verify: { status: 'TIMEOUT', solved: false, assertions: { passed: 1, failed: 6, total: 7 }, patch_changed: true,
        run: { wall_s: 1800, tokens_out: 20000, tool_calls: 40, exit_code: -1 } } }));
    // skipped and errored follow-ups
    write('t-skip', base('t-skip', { verify: { skipped: 'no session id in the transcript' } }));
    write('t-err', base('t-err', { verify: { error: 'RuntimeError: boom' } }));
    // a plain fail with no follow-up (older run): not an experiment row
    write('t-plain', base('t-plain', {}));
    return { root, dirName: 'haiku-low-solo-verifyfix' };
}

test.beforeEach(() => { C._resetForTests(); });

test('mainline isolation: verify.status=pass still counts as fail in the row, the battery and the model fold', (t) => {
    const { root, dirName } = fixture(t);
    C.configure({ root });
    const run = C.getRun(dirName, root);
    const row = run.rows.find((r) => r.task === 't-rescued');
    assert.equal(row.status, 'fail');
    assert.equal(row.solved, false);
    assert.deepEqual(row.assertions, { passed: 1, failed: 6, total: 7 }, 'the mainline assertions, not the verify ones');
    assert.equal(row.wall_s, 600); assert.equal(row.tokens_out, 9000);
    assert.ok(!('verify' in row), 'taskRow must not carry the verify block at all');
    assert.ok(!JSON.stringify(run.rows).includes('"verify'), 'no row mentions verify');
    // battery summary (listRuns / the Runs view / lib/models.js batteries)
    assert.equal(run.solved, 0); assert.equal(run.counts.pass, 0); assert.equal(run.counts.fail, 6); assert.equal(run.scored, 6);
    assert.deepEqual(run.assertions, { passed: 6, total: 42, tasks: 6 });
    const listed = C.listRuns(root).find((r) => r.dir === dirName);
    assert.equal(listed.solved, 0); assert.equal(listed.counts.pass, 0);
    // lib/models.js: the fold every leaderboard, the ladder and the grid are built on
    const samples = M.foldQualityRows(run.rows.map((r) => ({ dir: dirName, ended: 1, invalid: false, row: r })), new Map());
    const s = samples.find((x) => x.row.task === 't-rescued');
    assert.equal(s.passes, 0); assert.equal(s.credit, 0); assert.equal(s.attempts, 1);
    assert.deepEqual(s.assertionsAll, { passed: 1, total: 7, runs: 1 });
    const q = M.aggregateQuality(samples);
    assert.equal(q.solved, 0);
    // getResult keeps the mainline row and puts the summary BESIDE it
    const res = C.getResult(dirName, 't-rescued', root);
    assert.equal(res.row.status, 'fail'); assert.equal(res.row.solved, false);
    assert.equal(res.verify.status, 'pass');
    // the mainline transcript is the run's own, never verify.claude.jsonl
    assert.ok(res.transcript.endsWith(path.join('t-rescued', 'claude.jsonl')));
    const tr = C.getTranscript(dirName, 't-rescued', { root });
    assert.ok(tr.transcript.endsWith(path.join('t-rescued', 'claude.jsonl')));
});

test('mainline code never reads `verify` (source guard: models fold, status derivation)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'lib', 'models.js'), 'utf-8');
    assert.ok(!/\bverify\b|\.verify\b|\['verify'\]/.test(src), 'lib/models.js must not read result.verify');
    const cb = fs.readFileSync(path.join(__dirname, '..', 'lib', 'codebench.js'), 'utf-8');
    for (const fn of ['deriveStatus', 'taskRow', 'assertionsOf', 'summarize']) {
        const start = cb.indexOf(`function ${fn}(`); assert.ok(start >= 0, fn);
        const body = cb.slice(start, cb.indexOf('\n}\n', start));
        assert.ok(!/verify/.test(body.replace(/verified_before_done/g, '')), `${fn} must not read verify`);
    }
});

test('verifySummary: compact attempt / skipped / error shapes, null without a block', (t) => {
    const { root, dirName } = fixture(t);
    const dirPath = path.join(root, 'results', dirName);
    const d = JSON.parse(fs.readFileSync(path.join(dirPath, 't-rescued.json'), 'utf-8'));
    const v = C.verifySummary(d, dirPath);
    assert.equal(v.kind, 'attempt'); assert.equal(v.status, 'pass'); assert.equal(v.solved, true);
    assert.deepEqual(v.assertions, { passed: 7, failed: 0, total: 7 });
    assert.equal(v.wall_s, 720); assert.equal(v.tokens_out, 4000); assert.equal(v.tool_calls, 12); assert.equal(v.patch_changed, true);
    assert.equal(v.cases, 2); assert.equal(v.p2p_broken, 0);
    assert.ok(v.transcript.endsWith('verify.claude.jsonl'));
    assert.ok(!('patch' in v), 'the patch stays in the result JSON, not the summary');
    assert.deepEqual(C.verifySummary({ verify: { skipped: 'no session id' } }), { kind: 'skipped', status: null, reason: 'no session id' });
    assert.deepEqual(C.verifySummary({ verify: { error: 'boom' } }), { kind: 'error', status: null, reason: 'boom' });
    assert.equal(C.verifySummary({ status: 'fail' }), null);
});

test('listVerifyRuns: every result with a verify block, mainline `before` untouched', (t) => {
    const { root, dirName } = fixture(t);
    C.configure({ root });
    const rows = C.listVerifyRuns(root);
    assert.deepEqual(rows.map((r) => r.task).sort(), ['t-err', 't-rescued', 't-skip', 't-still', 't-timeout']);   // t-plain has none
    const r = rows.find((x) => x.task === 't-rescued');
    assert.equal(r.dir, dirName); assert.equal(r.run, 1);
    assert.equal(r.runner, 'claude'); assert.equal(r.model, 'haiku'); assert.equal(r.effort, 'low'); assert.equal(r.scaffold, 'solo');
    assert.equal(r.before.status, 'fail'); assert.deepEqual(r.before.assertions, { passed: 1, failed: 6, total: 7 });
    assert.equal(r.verify.status, 'pass'); assert.deepEqual(r.verify.assertions, { passed: 7, failed: 0, total: 7 });
    assert.equal(rows.find((x) => x.task === 't-skip').verify.kind, 'skipped');
});

test('getTranscript which=verify opens the verify transcript', (t) => {
    const { root, dirName } = fixture(t);
    C.configure({ root });
    const tr = C.getTranscript(dirName, 't-rescued', { root, which: 'verify' });
    assert.equal(tr.which, 'verify');
    assert.ok(tr.transcript.endsWith(path.join('t-rescued', 'verify.claude.jsonl')));
    assert.equal(tr.runner, 'claude');
    assert.ok(tr.events.some((e) => e.kind === 'text' && /verified again/.test(e.text)));
    const none = C.getTranscript(dirName, 't-plain', { root, which: 'verify' });
    assert.equal(none.transcript, null); assert.match(none.note, /no verify transcript/);
});

test('summarizeVerify (ui/benchmarks/experiments.js): rescued rate + Wilson, medians, cost per rescue', async (t) => {
    const { root } = fixture(t);
    C.configure({ root });
    const X = await import('../ui/benchmarks/experiments.js');
    const s = X.summarizeVerify(C.listVerifyRuns(root));
    assert.equal(s.models.length, 1);
    const m = s.models[0];
    assert.equal(m.label, 'haiku · low · solo (claude)');
    assert.equal(m.tried, 5); assert.equal(m.attempts, 3);
    assert.equal(m.rescued, 1); assert.equal(m.still_failing, 1); assert.equal(m.timeout, 1);
    assert.equal(m.skipped, 1); assert.equal(m.errored, 1);
    assert.equal(m.rate, 1 / 3);
    assert.ok(m.ci.lo > 0 && m.ci.lo < 1 / 3 && m.ci.hi > 1 / 3 && m.ci.hi < 1);
    assert.equal(m.median_wall_s, 720); assert.equal(m.median_tokens_out, 4000);
    assert.equal(m.wall_per_rescue_s, 720 + 300 + 1800);
    assert.equal(m.patch_changed, 2); assert.equal(m.patch_known, 3);
    assert.equal(s.all.tried, 5);
    assert.equal(X.summarizeVerify([]).models.length, 0);
    assert.equal(X.summarizeVerify([]).all.ci, null);
    // the side note on the result page
    assert.equal(X.verifyNoteText({ kind: 'attempt', status: 'pass', assertions: { passed: 5, total: 7 }, wall_s: 720 }), 'after verify: pass (5/7), +12 min');
    assert.equal(X.verifyNoteText({ kind: 'skipped', reason: 'no session id' }), 'verify follow-up skipped: no session id');
});
