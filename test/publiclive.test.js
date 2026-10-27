// "What's running now" on the public site (2026-10-07): each running battery may show the QUESTION its queue item
// answers and its tally -- tasks passed / failed / not scored / left -- and nothing else from the queue.
// Kyle's note on the item (queue_meta.user_note), the item's own notes, its launch command, env and paths must
// never appear. These tests follow the data the whole way: the queue row (lib/queue.js runningFor) -> what the
// dashboard writes into logs/public-live.json (lib/publicdata.js liveItem) -> what /api/live serves (liveRunning +
// sanitizePayload) -> what the static build keeps as its last record (public/staticsite.js liveRecord).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { liveTally, liveItem, liveRunning, sanitizePayload, DROP_KEYS } = require('../lib/publicdata');
const { createQueue } = require('../lib/queue.js');
const { SOLVED, EXCLUDED } = require('../lib/codebench');
const S = require('../public/staticsite');
const SM = require('../public/assets/static-mode.js');

const SETS = { solved: SOLVED, excluded: EXCLUDED };
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'publiclive-test-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));

test('tally: passes, fails and what is left; an excluded status is never a fail', () => {
    assert.deepStrictEqual(liveTally(['pass', 'fail', 'pass*', 'TIMEOUT'], 10, SETS), { passed: 2, failed: 2, excluded: 0, remaining: 6, total: 10 });
    // every status the harness excludes from scoring is counted on its own
    const ex = [...EXCLUDED];
    assert.ok(ex.includes('PROVIDER_ERROR') && ex.includes('ABORTED') && ex.includes('HARNESS_ERROR'));
    assert.deepStrictEqual(liveTally(ex, ex.length + 3, SETS), { passed: 0, failed: 0, excluded: ex.length, remaining: 3, total: ex.length + 3 });
    assert.deepStrictEqual(liveTally(['pass', 'PROVIDER_ERROR', 'ABORTED', 'fail'], 4, SETS), { passed: 1, failed: 1, excluded: 2, remaining: 0, total: 4 });
});

test('tally: a result that cannot be read yet is still to come; the parts always add up to the total', () => {
    assert.deepStrictEqual(liveTally(['pass', null, undefined, ''], 5, SETS), { passed: 1, failed: 0, excluded: 0, remaining: 4, total: 5 });
    assert.deepStrictEqual(liveTally([], 0, SETS), { passed: 0, failed: 0, excluded: 0, remaining: 0, total: 0 });
    assert.deepStrictEqual(liveTally(null, 7, SETS), { passed: 0, failed: 0, excluded: 0, remaining: 7, total: 7 });
    // more results than the task list says (never negative "left")
    const t = liveTally(['pass', 'fail', 'fail'], 2, SETS);
    assert.deepStrictEqual(t, { passed: 1, failed: 2, excluded: 0, remaining: 0, total: 3 });
    for (const [st, total] of [[['pass', 'fail', 'KILLED', null], 9], [['fail'], 1], [[], 3]]) {
        const x = liveTally(st, total, SETS);
        assert.strictEqual(x.passed + x.failed + x.excluded + x.remaining, x.total);
    }
});

const SECRETS = ['KYLE-PRIVATE-NOTE', 'ITEM-INTERNAL-NOTES', 'llama-server', '/secret/', 'SECRET_ENV', 'harness.log'];
const leaks = (json) => SECRETS.filter((s) => json.includes(s));

test('the queue item behind a battery: only its question and the counts leave the dashboard', () => {
    const dir = path.join(TMP, 'q1'); fs.mkdirSync(dir);
    const q = createQueue({ dbPath: path.join(dir, 'bench.sqlite'), envFiles: [] });
    const a = q.insert({ label: 'leg-a', runner: 'opencode', model: 'qwen', launch_cmd: '/secret/bin/llama-server -m /secret/models/q4.gguf -c 131072',
        tasks: ['t1', 't2', 't3', 't4'], notes: 'ITEM-INTERNAL-NOTES', env: { SECRET_ENV: '1' } });
    const db = q.open();
    db.prepare("UPDATE queue_items SET status='running', started_at=?, result_dir=?, log_path=? WHERE id=?").run('2026-10-07T10:00:00Z', '/secret/results/battery_a', '/secret/logs/harness.log', a.id);
    q.setMeta(a.id, { question: 'Does the row hold\n on the newer tasks?', user_note: 'KYLE-PRIVATE-NOTE' });
    const item = q.runningFor('battery_a');
    assert.strictEqual(item.user_note, 'KYLE-PRIVATE-NOTE', 'the private dashboard does get the note: this test is about the public side');

    const pub = liveItem(item, liveTally(['pass', 'fail', 'PROVIDER_ERROR'], 4, SETS));
    assert.deepStrictEqual(pub, { question: 'Does the row hold on the newer tasks?', passed: 1, failed: 1, excluded: 1, remaining: 1, total: 4 });
    assert.deepStrictEqual(leaks(JSON.stringify(pub)), []);

    // an item with no question: no question key at all (the page shows nothing for it, not a placeholder)
    const b = q.insert({ label: 'leg-b', runner: 'opencode', model: 'qwen', launch_cmd: '/secret/bin/llama-server -m x', tasks: ['t1'], notes: 'ITEM-INTERNAL-NOTES' });
    db.prepare("UPDATE queue_items SET status='running' WHERE id=?").run(b.id);
    q.setMeta(b.id, { user_note: 'KYLE-PRIVATE-NOTE' });
    const noQ = liveItem(q.runningFor('leg-b'), liveTally([], 1, SETS));
    assert.deepStrictEqual(noQ, { passed: 0, failed: 0, excluded: 0, remaining: 1, total: 1 });
    assert.ok(!('question' in noQ));
    assert.deepStrictEqual(liveItem({ question: '   ', user_note: 'KYLE-PRIVATE-NOTE' }, null), {});
    assert.deepStrictEqual(liveItem(null, null), {}, 'a battery no queue item started');
    q.close();
});

// What server4.js writes (running[] entry + items[dir]) with everything a careless change could add to either.
const dirty = () => ({
    entry: { dir: 'battery_a', runner: 'opencode', state: 'running', lane: 'local-gpu', task: 'repo-task-one', tasks: 4, done: 3, solved: 1,
        user_note: 'KYLE-PRIVATE-NOTE', notes: 'ITEM-INTERNAL-NOTES', launch_cmd: '/secret/bin/llama-server', path: '/secret/results/battery_a', env_json: '{"SECRET_ENV":"1"}', pid: 4242 },
    extra: { question: 'Does the row hold on the newer tasks?', passed: 1, failed: 1, excluded: 1, remaining: 1, total: 4,
        user_note: 'KYLE-PRIVATE-NOTE', notes: 'ITEM-INTERNAL-NOTES', launch_cmd: '/secret/bin/llama-server', result_dir: '/secret/results/battery_a', log_path: '/secret/logs/harness.log', id: 750, label: 'leg-a' },
});

test('/api/live running entry: an explicit list of fields -- user_note, notes, commands and paths cannot ride along', () => {
    const { entry, extra } = dirty();
    const out = liveRunning(entry, extra, 'Qwen 27B');
    assert.deepStrictEqual(Object.keys(out).sort(), ['dir', 'done', 'excluded', 'failed', 'lane', 'model', 'passed', 'question', 'remaining', 'runner', 'solved', 'state', 'task', 'tasks']);
    assert.deepStrictEqual(out, { dir: 'battery_a', runner: 'opencode', state: 'running', lane: 'local-gpu', task: 'repo-task-one', tasks: 4, done: 3, solved: 1, model: 'Qwen 27B',
        question: 'Does the row hold on the newer tasks?', passed: 1, failed: 1, excluded: 1, remaining: 1 });
    const json = JSON.stringify(sanitizePayload({ at: 1, lanes: [], running: [out], stale: false }));
    assert.deepStrictEqual(leaks(json), []);
    for (const key of ['user_note', 'notes', 'launch_cmd', 'env_json', 'result_dir', 'log_path', 'pid']) assert.ok(!json.includes(`"${key}"`), `key leaked: ${key}`);
    assert.ok(DROP_KEYS.has('user_note'), 'and the scrub would drop the key even if something did copy it');
    assert.strictEqual(sanitizePayload({ running: [{ user_note: 'KYLE-PRIVATE-NOTE', question: 'q' }] }).running[0].user_note, undefined);
});

test('/api/live running entry: no question -> no key; no counts (an older dashboard) -> the entry as it was', () => {
    const { entry } = dirty();
    const old = liveRunning(entry, null, null);
    assert.deepStrictEqual(old, { dir: 'battery_a', runner: 'opencode', state: 'running', lane: 'local-gpu', task: 'repo-task-one', tasks: 4, done: 3, solved: 1, model: null });
    const noQ = liveRunning(entry, { passed: 2, failed: 0, excluded: 0, remaining: 2, total: 4 }, 'M');
    assert.ok(!('question' in noQ) && noQ.passed === 2 && noQ.remaining === 2);
    assert.ok(!('question' in liveRunning(entry, { question: '  ' }, 'M')));
    assert.ok(!('question' in liveRunning(entry, { question: { text: 'KYLE-PRIVATE-NOTE' } }, 'M')), 'a question is a string or it is nothing');
    assert.deepStrictEqual(liveRunning(entry, { question: 'q', passed: 'x', failed: -3, excluded: null, remaining: 2.6 }, 'M').failed, 0, 'counts are whole numbers >= 0');
    assert.doesNotThrow(() => liveRunning(null, undefined, undefined));
});

test('the question is free text: paths and addresses in it are scrubbed like every other public string', () => {
    const out = sanitizePayload({ running: [liveRunning({ dir: 'd', tasks: 1, done: 0, solved: 0 }, { question: 'Is /home/someone/models/q4.gguf faster over 192.168.1.125:50052?', passed: 0, failed: 0 }, null)] });
    assert.strictEqual(out.running[0].question, 'Is q4.gguf faster over <ip>?');
});

test('static build: the last record keeps the question and the counts, and nothing it was not given a name for', () => {
    const { entry, extra } = dirty();
    const live = { at: 1791400000000, stale: false, lanes: [{ lane: 'local-gpu', gen: 40 }], running: [{ ...liveRunning(entry, extra, 'Qwen 27B'), user_note: 'KYLE-PRIVATE-NOTE', notes: 'ITEM-INTERNAL-NOTES' }] };
    const rec = S.liveRecord(live);
    assert.deepStrictEqual(rec.running[0], { dir: 'battery_a', runner: 'opencode', lane: 'local-gpu', task: 'repo-task-one', tasks: 4, done: 3, solved: 1, model: 'Qwen 27B',
        question: 'Does the row hold on the newer tasks?', passed: 1, failed: 1, excluded: 1, remaining: 1 });
    assert.deepStrictEqual(leaks(JSON.stringify(rec)), []);
    // a lab that does not send them yet: the record is what it was before
    assert.deepStrictEqual(S.liveRecord({ at: 5, running: [liveRunning(entry, null, 'M')] }).running[0], { dir: 'battery_a', runner: 'opencode', lane: 'local-gpu', task: 'repo-task-one', tasks: 4, done: 3, solved: 1, model: 'M' });
    // snapshot.json carries it, and the offline page gets it back as `last`
    const snap = S.snapshotManifest({ builtAt: 2, catalog: { generatedAt: 1, models: [] }, posts: [], live, modelKeys: [] });
    assert.strictEqual(snap.live.running[0].question, 'Does the row hold on the newer tasks?');
    assert.strictEqual(SM.offlineLive(snap).last.running[0].passed, 1);
    // the build's own gate refuses a data file that carries the note's key
    assert.ok(S.leakScan('snapshot.json', JSON.stringify({ live: { running: [{ user_note: 'x' }] } })).some((h) => /user_note/.test(h.what)));
    assert.deepStrictEqual(S.leakScan('snapshot.json', JSON.stringify(snap)), []);
});
