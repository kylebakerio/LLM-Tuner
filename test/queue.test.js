// Benchmark queue (lib/queue.js): rows in a temp bench.sqlite -- insert / validate / reorder / duplicate /
// hold / cancel / stop controls / lane pause, the task-source mirror of codebench's queue_runner.py, the
// Auto queue batch -> rows mapping and the HTTP API (handleApi, the function server4.js calls).
// Also (2026-10-07) what the Queue page shows per item: the estimate (estimateItem: measured / fallback /
// running remainder / no history), the lanes' clocks, and the queue_meta write endpoint's validation.
// Nothing here starts a process.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createQueue, handleApi, parseEnvFile, expandPreview, buildHistory, historyKeys, estimateItem, laneClocks, META_MAX, LOCAL_ALL } = require('../lib/queue.js');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'queue-test-'));
test.after(() => fs.rmSync(TMP, { recursive: true, force: true }));
let n = 0;
function fresh(extra = {}) {
    const dir = path.join(TMP, `q${++n}`); fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'vars.env'), 'STOCK=/bin/llama-server\nD27MTP="-ngl 999 -fa on"\nHF=/m\nQ4=$HF/q4.gguf\n');
    fs.writeFileSync(path.join(dir, 'flash.env'), "U=/u/llama\nFLASH_Q2_CMD=\"$U -m /m/q2.gguf -ot 'blk.(1|2)=CUDA0'\"\n");
    return { q: createQueue({ dbPath: path.join(dir, 'bench.sqlite'), envFiles: [path.join(dir, 'vars.env'), path.join(dir, 'flash.env')], ...extra }), dir };
}
const RUN = (o = {}) => ({ label: 'leg', runner: 'opencode', model: 'qwen', launch_cmd: '$STOCK -m $Q4 -c 131072 $D27MTP', tasks: ['a', 'b'], ...o });

test('queue: insert appends to the lane in order; list splits running / pending / history', () => {
    const { q } = fresh();
    const a = q.insert(RUN({ label: 'a' })); const b = q.insert(RUN({ label: 'b' })); const c = q.insert(RUN({ label: 'c', lane: 'cloud', runner: 'claude', model: 'claude-haiku-4-5', launch_cmd: null, env: { CODEBENCH_CLAUDE_EFFORT: 'low', CODEBENCH_CLAUDE_SCAFFOLD: 'solo' } }));
    assert.ok(a.position < b.position);
    assert.deepStrictEqual(a.tasks, ['a', 'b']);
    assert.strictEqual(a.timeout_s, 7200);
    const L = q.list();
    assert.deepStrictEqual(L.pending.map((i) => i.label).sort(), ['a', 'b', 'c']);
    assert.deepStrictEqual(L.pending.filter((i) => i.lane === 'local-gpu').map((i) => i.label), ['a', 'b']);
    assert.deepStrictEqual(L.pending.filter((i) => i.lane === 'cloud').map((i) => i.id), [c.id]);
    assert.ok(L.lanes.some((l) => l.lane === 'local-gpu') && L.lanes.some((l) => l.lane === 'cloud'));
    const ev = q.get(a.id).events;
    assert.strictEqual(ev[0].event, 'insert');
});

test('queue: validation refuses cloud items without effort, bare quotes, --port, bad task ids, runs without tasks', () => {
    const { q } = fresh();
    assert.throws(() => q.insert({ lane: 'cloud', runner: 'claude', model: 'claude-haiku-4-5', tasks: ['a'], env: { CODEBENCH_CLAUDE_SCAFFOLD: 'solo' } }), /CODEBENCH_CLAUDE_EFFORT/);
    assert.throws(() => q.insert(RUN({ launch_cmd: '$STOCK -m "x"' })), /bare "/);
    assert.throws(() => q.insert(RUN({ launch_cmd: '$STOCK --port 8080' })), /--port/);
    assert.throws(() => q.insert(RUN({ tasks: ['ok', 'rm -rf /'] })), /bad task id/);
    assert.throws(() => q.insert(RUN({ tasks: null })), /needs tasks/);
    assert.throws(() => q.insert(RUN({ label: 'has space' })), /label/);
    assert.throws(() => q.insert({ kind: 'stage', model: 'm', launch_cmd: 'x', task_source: { from: 'sql', query: 'delete from runs' } }), /SELECT/);
    assert.throws(() => q.insert({ kind: 'wait', wait: { nothing: 1 } }), /wait needs/);
    // single-quoted -ot patterns are fine (flash-tuned.env style)
    assert.ok(q.insert(RUN({ launch_cmd: "$U -m x -ot 'blk.(1|2)=CUDA0'" })).id);
    // a missing label becomes q<id>
    const it = q.insert(RUN({ label: '' }));
    assert.strictEqual(it.label, `q${it.id}`);
});

test('queue: reorder / move deal the existing positions; running and finished rows never move', () => {
    const { q } = fresh();
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((l) => q.insert(RUN({ label: l })));
    const db = q.open();
    db.prepare("UPDATE queue_items SET status='running' WHERE id=?").run(a.id);
    const order = () => q.list().pending.filter((i) => i.lane === 'local-gpu').map((i) => i.label);
    q.move(d.id, 'up'); assert.deepStrictEqual(order(), ['b', 'd', 'c']);
    q.move(d.id, 'top'); assert.deepStrictEqual(order(), ['d', 'b', 'c']);
    q.reorder('local-gpu', [c.id, b.id]); assert.deepStrictEqual(order(), ['c', 'b', 'd']);
    assert.throws(() => q.move(a.id, 'down'), /running item does not move/);
    assert.strictEqual(q.get(a.id).position, a.position);
});

test('queue: edits are refused on running / finished rows except notes; lane change goes to the end', () => {
    const { q } = fresh();
    const a = q.insert(RUN({ label: 'a' })); q.insert(RUN({ label: 'b', lane: 'x' }));
    const e = q.update(a.id, { tasks: 'c d, e', timeout_s: 3600, notes: 'hi' });
    assert.deepStrictEqual(e.tasks, ['c', 'd', 'e']); assert.strictEqual(e.timeout_s, 3600);
    assert.throws(() => q.update(a.id, { status: 'done' }), /not editable/);
    const moved = q.update(a.id, { lane: 'x' });
    assert.ok(moved.position > q.list().pending.find((i) => i.label === 'b').position);
    q.open().prepare("UPDATE queue_items SET status='running' WHERE id=?").run(a.id);
    assert.throws(() => q.update(a.id, { tasks: ['z'] }), /running/);
    assert.strictEqual(q.update(a.id, { notes: 'still ok' }).notes, 'still ok');
    q.open().prepare("UPDATE queue_items SET status='done' WHERE id=?").run(a.id);
    assert.throws(() => q.update(a.id, { model: 'other' }), /duplicate it/);
});

test('queue: duplicate / hold / release / cancel / skip', () => {
    const { q } = fresh();
    const a = q.insert(RUN({ label: 'a' })); const b = q.insert(RUN({ label: 'b' }));
    const dup = q.duplicate(a.id);
    assert.strictEqual(dup.label, 'a-r2');
    assert.deepStrictEqual(q.list().pending.map((i) => i.label), ['a', 'a-r2', 'b'], 'a duplicate of a pending item goes right after it');
    assert.strictEqual(q.setStatus(b.id, 'hold').status, 'paused');
    assert.strictEqual(q.setStatus(b.id, 'release').status, 'pending');
    assert.strictEqual(q.setStatus(b.id, 'skip').status, 'skipped');
    assert.throws(() => q.setStatus(b.id, 'release'), /duplicate it/);
    assert.ok(q.list().history.some((i) => i.id === b.id));
    // a finished item's duplicate runs what it resolved to and goes to the end
    q.open().prepare("UPDATE queue_items SET status='done', tasks_json=NULL, task_source_json='{\"tasks\":[\"x\"]}', kind='run', resolved_tasks_json='[\"x\"]' WHERE id=?").run(a.id);
    const d2 = q.duplicate(a.id);
    assert.strictEqual(d2.label, 'a-r3');
    assert.strictEqual(q.list().pending.slice(-1)[0].id, d2.id);
});

// 2026-10-26, Kyle: "the default for adding an item back to the queue from the bottom should be adding it to the top".
// Positions as the live queue has them: finished rows between the running item and the head, a held row at the head,
// card-handoff's "+0.0001" neighbour, a floor-* fill item at the end, and another GPU lane's rows (positions are also
// compared across GPU lanes by the runner's device gate, so they must not move).
function lanesLikeLive(q) {
    const db = q.open();
    const mk = (label, status, position, lane = 'local-gpu') => {
        const it = q.insert(RUN({ label, lane }));
        db.prepare('UPDATE queue_items SET status=?, position=? WHERE id=?').run(status, position, it.id);
        return { ...it, status, position };
    };
    return {
        old: mk('old-done', 'done', 1), victim: mk('victim', 'cancelled', 2), running: mk('running', 'running', 3),
        between: mk('cut-off', 'cancelled', 3.5), held: mk('held-head', 'paused', 4), rest: mk('rest', 'pending', 4.0001),
        next: mk('next', 'pending', 5), floor: mk('floor-fill', 'pending', 6),
        other: mk('rocm1-head', 'pending', 3.75, 'local-rocm1'), other2: mk('rocm1-next', 'pending', 4.5, 'local-rocm1'),
    };
}
// what queue_runner.py next_pending() takes: the lowest-position PENDING row of the lane
const runnerPick = (q, lane) => q.open().prepare("SELECT id FROM queue_items WHERE lane=? AND status='pending' ORDER BY position, id LIMIT 1").get(lane).id;
const waitingOrder = (q, lane = 'local-gpu') => q.list().pending.filter((i) => i.lane === lane).map((i) => i.label);

test('queue: "again" (position top) puts the copy of a finished item at the TOP of its lane -- after the running item, ahead of every held and pending one -- and the runner takes it next (2026-10-26)', () => {
    const { q } = fresh();
    const r = lanesLikeLive(q);
    const before = new Map(q.open().prepare('SELECT id, position FROM queue_items').all().map((x) => [x.id, x.position]));
    const cp = q.duplicate(r.victim.id, { position: 'top' });
    assert.strictEqual(cp.status, 'pending'); assert.strictEqual(cp.lane, 'local-gpu'); assert.strictEqual(cp.label, 'victim-r2');
    assert.deepStrictEqual(waitingOrder(q), ['victim-r2', 'held-head', 'rest', 'next', 'floor-fill'], 'ahead of the held head too: it shows as #1');
    assert.ok(cp.position > r.running.position && cp.position < r.held.position, `between the running item (3) and the head (4): ${cp.position}`);
    assert.strictEqual(runnerPick(q, 'local-gpu'), cp.id, 'the runner starts it next');
    for (const [id, p] of before) assert.strictEqual(q.get(id).position, p, `row ${id} did not move`);   // nothing else moved, in either lane
    assert.deepStrictEqual(waitingOrder(q, 'local-rocm1'), ['rocm1-head', 'rocm1-next']);
    const ev = q.get(cp.id).events.find((e) => e.event === 'duplicate');
    assert.deepStrictEqual(ev.detail, { from: r.victim.id, position: 'top' });
    // the next "again" goes ahead of this one: the last re-queued runs first, as a drag to the top would do
    const cp2 = q.duplicate(r.between.id, { position: 'top' });
    assert.deepStrictEqual(waitingOrder(q), ['cut-off-r2', 'victim-r2', 'held-head', 'rest', 'next', 'floor-fill']);
    assert.strictEqual(runnerPick(q, 'local-gpu'), cp2.id);
});

test('queue: duplicate positions -- the old defaults stand when none is named (scripts call it), "end" and "after" on request, bad ones refused', () => {
    const { q } = fresh();
    const r = lanesLikeLive(q);
    const last = () => waitingOrder(q).slice(-1)[0];
    assert.strictEqual(q.duplicate(r.victim.id).label, 'victim-r2'); assert.strictEqual(last(), 'victim-r2', 'a finished item, no position: the end, as before');
    q.duplicate(r.victim.id, { position: 'end' }); assert.strictEqual(last(), 'victim-r3');
    q.duplicate(r.rest.id); assert.deepStrictEqual(waitingOrder(q).slice(0, 3), ['held-head', 'rest', 'rest-r2'], 'a waiting item, no position: right after it, as before');
    q.duplicate(r.next.id, { position: 'after' }); assert.strictEqual(waitingOrder(q)[waitingOrder(q).indexOf('next') + 1], 'next-r2');
    q.duplicate(r.floor.id, { position: 'top' }); assert.strictEqual(waitingOrder(q)[0], 'floor-fill-r2', 'a waiting item can be copied to the top too');
    assert.throws(() => q.duplicate(r.victim.id, { position: 'after' }), /cancelled: its copy goes to the top or the end/);
    assert.throws(() => q.duplicate(r.victim.id, { position: 'sideways' }), /position must be top, end or after/);
    assert.throws(() => q.duplicate(r.running.id, { position: 'bottom' }), /position must be/);
});

test('queue: "top" in a lane with nothing waiting goes after the running item; many in a row keep their order when halving runs out of float room', () => {
    const { q } = fresh();
    const db = q.open();
    const run = q.insert(RUN({ label: 'busy' })); db.prepare("UPDATE queue_items SET status='running', position=10 WHERE id=?").run(run.id);
    const src = q.insert(RUN({ label: 'src' })); db.prepare("UPDATE queue_items SET status='done', position=2 WHERE id=?").run(src.id);
    const one = q.duplicate(src.id, { position: 'top' });
    assert.ok(one.position > 10, 'nothing waiting: the end, after the running item');
    assert.strictEqual(runnerPick(q, 'local-gpu'), one.id);
    // 80 more: each halves the gap under the head; past ~50 there is no float between the two and the copy goes one
    // below the head (under the running row: only waiting rows are ordered). Every one must still be first.
    const ids = [one.id];
    for (let i = 0; i < 80; i++) { const c = q.duplicate(src.id, { position: 'top' }); ids.unshift(c.id); assert.strictEqual(runnerPick(q, 'local-gpu'), c.id, `copy ${i + 2} is next`); }
    assert.deepStrictEqual(q.list().pending.map((x) => x.id), ids, 'last re-queued first, every one in order');
    // an adjacent pair of doubles under the head: the copy is still ahead of it
    const { q: q2 } = fresh(); const d2 = q2.open();
    const a = q2.insert(RUN({ label: 'a' })); const b = q2.insert(RUN({ label: 'b' })); const s = q2.insert(RUN({ label: 's' }));
    d2.prepare("UPDATE queue_items SET status='running', position=? WHERE id=?").run(1 + Number.EPSILON, a.id);
    d2.prepare('UPDATE queue_items SET position=? WHERE id=?').run(1 + 2 * Number.EPSILON, b.id);
    d2.prepare("UPDATE queue_items SET status='done', position=0 WHERE id=?").run(s.id);
    const c = q2.duplicate(s.id, { position: 'top' });
    assert.ok(c.position < 1 + 2 * Number.EPSILON);
    assert.deepStrictEqual(waitingOrder(q2), ['s-r2', 'b']); assert.strictEqual(runnerPick(q2, 'local-gpu'), c.id);
});

test('queue: run and stage legs record unless told not to; a duplicate takes the default (2026-10-22)', () => {
    const { q } = fresh();
    assert.strictEqual(q.insert(RUN({ label: 'r' })).record, 1, 'record left out -> 1');
    assert.strictEqual(q.insert(RUN({ label: 'r0', record: false })).record, 0, 'an explicit no stays');
    assert.strictEqual(q.insert({ kind: 'shell', label: 's', shell_cmd: 'true' }).record, 0, 'a shell item launches no proxy');
    const old = q.insert(RUN({ label: 'old', record: 0 }));
    assert.strictEqual(q.duplicate(old.id).record, 1, 'a copy of a 10-15..10-22 item (record 0) records');
});

test('queue: stop controls go on the row AND into the battery control.json; only for running items', () => {
    const { q, dir } = fresh();
    const a = q.insert(RUN({ label: 'a' }));
    assert.throws(() => q.control(a.id, 'stop-now'), /not running/);
    const rdir = path.join(dir, 'results', 'a');
    q.open().prepare("UPDATE queue_items SET status='running', harness_pid=?, result_dir=? WHERE id=?").run(process.pid, rdir, a.id);
    const r = q.control(a.id, 'stop-after-task');
    assert.strictEqual(r.control, 'stop-after-task'); assert.strictEqual(r.controlJsonWritten, true);
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(rdir, 'control.json'), 'utf-8')).action, 'stop-after-task');
    q.control(a.id, 'clear');
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(rdir, 'control.json'), 'utf-8')).action, 'run');
    assert.strictEqual(q.get(a.id).control, null);
    assert.throws(() => q.control(a.id, 'explode'), /action must be/);
});

test('queue: lane pause / resume is recorded with who did it', () => {
    const { q } = fresh();
    const l = q.pauseLane('local-gpu', true, { note: 'cut-over' });
    assert.strictEqual(l.paused, 1); assert.strictEqual(l.note, 'cut-over'); assert.strictEqual(l.alive, false);
    assert.strictEqual(q.pauseLane('local-gpu', false).paused, 0);
});

function seedRuns(q, rows) {
    const st = q.open().prepare('INSERT INTO runs (result_path, battery, task, status, excluded, model_path, n_ctx, timeout_s) VALUES (?,?,?,?,0,?,?,7200)');
    rows.forEach(([task, status, model, nctx, rp], i) => st.run(rp || `results/b${i}/${task}.json`, 'b', task, status, model, nctx));
}

test('queue: task sources mirror queue_runner.py (cascade chain by item id, approved, exclude_like, read-only sql)', () => {
    const { q, dir } = fresh();
    const seed = path.join(dir, 'seed.txt'); fs.writeFileSync(seed, 't1\nt2\nt3\nt4\n');
    seedRuns(q, [['t1', 'pass', '/m/Ornith-Q4.gguf', 65536], ['t2', 'fail', '/m/Ornith-Q4.gguf', 65536], ['t3', 'pass', '/m/Ornith-Q4.gguf', 32768],
        ['t2', 'pass', '/m/Swift.gguf', 131072], ['t4', 'pass', '/m/Swift.gguf', 131072, 'results/x-nothink/t4.json']]);
    const s1 = q.insert({ kind: 'stage', label: 's1', model: 'm', launch_cmd: 'x', task_source: { from: 'cascade', input: { file: seed }, model_like: '%Ornith%', n_ctx: 65536 } });
    const s2 = q.insert({ kind: 'stage', label: 's2', model: 'm', launch_cmd: 'x', approved: ['t2', 't3', 't4'],
        task_source: { from: 'cascade', input: { item: s1.id }, model_like: '%Swift%', n_ctx: 131072, exclude_like: '%nothink%' } });
    assert.deepStrictEqual(q.preview(s1.id).tasks, ['t3', 't4']);
    assert.deepStrictEqual(q.failedSet(s1.id), ['t2', 't3', 't4']);
    const p2 = q.preview(s2.id);
    assert.deepStrictEqual(p2.tasks, ['t3', 't4']); assert.deepStrictEqual(p2.input, ['t2', 't3', 't4']);
    assert.deepStrictEqual(q.resolveSource({ from: 'sql', query: "select task from runs where status='fail'" }), ['t2']);
    assert.throws(() => q.resolveSource({ from: 'sql', query: 'delete from runs' }), /readonly|read-only|attempt to write|only for statements that return data/i);
});

test('queue: a bonus result (task <task>+bonus, db-rebuild 2026-10-14) never comes back from a task source and never counts as a run of its parent', () => {
    const { q, dir } = fresh();
    const seed = path.join(dir, 'seed.txt'); fs.writeFileSync(seed, 't1\nt2\n');
    seedRuns(q, [['t1', 'fail', '/m/A.gguf', 1, 'results/b/t1.json'], ['t1+bonus', 'pass', '/m/A.gguf', 1, 'results/b/t1.json#bonus'],
        ['t2+bonus', 'fail', '/m/A.gguf', 1, 'results/b/t2.json#bonus']]);
    assert.deepStrictEqual(q.resolveSource({ from: 'sql', query: 'select task from runs' }), ['t1']);
    const torun = q.insert({ kind: 'stage', label: 'tr', model: 'm', launch_cmd: 'x', task_source: { from: 'cascade', input: { file: seed }, model_like: '%A%', n_ctx: 1 } });
    assert.deepStrictEqual(q.preview(torun.id).tasks, ['t2']);            // t2's only row is a bonus: t2 has not run
    assert.deepStrictEqual(q.failedSet(torun.id), ['t1', 't2']);          // t1's bonus passed, t1 did not
    // typed by hand it is refused outright, as any id that is not a task
    assert.throws(() => q.insert({ kind: 'stage', label: 'ls', model: 'm', launch_cmd: 'x', task_source: { tasks: ['t1', 't1+bonus'] } }), /bad task id/);
});

test('queue: Auto queue batch -> rows (run legs, a cascade chained by item id incl. a stage that does not run, cloud with effort)', () => {
    const { q } = fresh();
    const settings = { models: [
        { id: 'haiku-low-solo', runner: 'claude', lane: 'cloud', claudeModel: 'claude-haiku-4-5', effort: 'low', scaffold: 'solo' },
        { id: 'ornith', opencodeModel: 'orn', cmd: '$STOCK -m /o.gguf -c 65536 $D27MTP', nCtx: 65536, dbLike: '%Ornith%' },
        { id: 'swift', opencodeModel: 'swi', cmd: '$STOCK -m /s.gguf -c 131072 $D27MTP', nCtx: 131072, dbLike: '%Swift%' },
        { id: 'q4', opencodeModel: 'q4m', cmd: '$STOCK -m $Q4 -c 131072 $D27MTP', nCtx: 131072, dbLike: '%Q4%', dbExcludeLike: '%nothink%' },
    ] };
    const batch = { strategy: 'cascade', cascade: { order: ['haiku-low-solo', 'ornith', 'swift', 'q4'], seed: ['t1', 't2'] }, legs: [
        { model: 'q4', lane: 'local', runs: [{ task: 'x1' }] },
        { model: 'ornith', lane: 'local', cascade: 1, runs: [{ task: 't1' }, { task: 't2' }] },
        { model: 'q4', lane: 'local', cascade: 3, runs: [{ task: 't2' }] },
        { model: 'haiku-low-solo', lane: 'cloud', runs: [{ task: 'c1' }] },
    ] };
    const rows = q.insertBatch(batch, settings, { stamp: 'T' });
    assert.deepStrictEqual(rows.map((r) => r.label), ['aqT-q4-1', 'aqT-ornith-c1', 'aqT-q4-c3', 'aqT-haiku-low-solo-4']);
    const [run, s1, s3, cloud] = rows;
    assert.strictEqual(run.kind, 'run'); assert.strictEqual(run.launch_cmd, '$STOCK -m $Q4 -c 131072 $D27MTP'); assert.deepStrictEqual(run.tasks, ['x1']);
    assert.deepStrictEqual(s1.task_source, { from: 'cascade', input: { tasks: ['t1', 't2'] }, model_like: '%Ornith%', n_ctx: 65536 });
    // stage 2 (swift) has no approved runs: it does not run, but still filters what reaches stage 3
    assert.deepStrictEqual(s3.task_source.input, { from: 'cascade', mode: 'failed', input: { item: s1.id }, model_like: '%Swift%', n_ctx: 131072 });
    assert.strictEqual(s3.task_source.exclude_like, '%nothink%'); assert.deepStrictEqual(s3.approved, ['t2']);
    assert.strictEqual(cloud.lane, 'cloud'); assert.deepStrictEqual(cloud.env, { CODEBENCH_CLAUDE_EFFORT: 'low', CODEBENCH_CLAUDE_SCAFFOLD: 'solo', CODEBENCH_DOCS: 'off' });
    // every planner row runs without the offline docs (L2, not L2+docs: Kyle 2026-10-15)
    for (const r of rows) assert.strictEqual(r.env.CODEBENCH_DOCS, 'off', r.label);
    assert.ok(rows.every((r) => r.created_by === 'planner'));
    // the planner sees them as still queued
    const pend = q.pendingForPlanner(settings, (models, om) => models.find((m) => m.opencodeModel === om) || null);
    assert.ok(pend.byModel.q4.includes('x1'));
    assert.strictEqual(pend.queue.legs.length, 4);
    assert.ok(pend.byModel['haiku-low-solo'].includes('c1'));
});

test('queue: insertBatch never re-adds a task its config already scored (one run per task per config, 2026-10-14)', () => {
    const { q } = fresh();
    const settings = { models: [
        { id: 'q4', opencodeModel: 'q4m', cmd: '$STOCK -m $Q4 -c 131072 $D27MTP', nCtx: 131072, dbLike: '%Q4_K_XL%', dbExcludeLike: '%nothink%' },
        { id: 'q4-nt', opencodeModel: 'q4nt', cmd: '$STOCK -m $Q4 -c 131072 $D27MTP --reasoning off', nCtx: 131072, dbLike: '%Q4_K_XL%', dbIncludeLike: '%nothink%' },
        { id: 'gsq', opencodeModel: 'gsq', cmd: '$STOCK -m /m/GSQ-IQ2_XS-mtp.gguf -c 81920', nCtx: 81920, dbLike: '%GSQ-IQ2_XS-mtp%' },
        { id: 'nolike', opencodeModel: 'x', cmd: '$STOCK -m /m/x.gguf' },
        { id: 'haiku', runner: 'claude', lane: 'cloud', claudeModel: 'claude-haiku-4-5', effort: 'low', scaffold: 'solo' },
    ] };
    const ins = q.open().prepare('INSERT INTO runs (result_path, battery, task, status, excluded, model_path, n_ctx, timeout_s, runner, runner_model, effort, scaffold) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    const local = (rp, task, { ex = 0, model = '/m/Qwen-Q4_K_XL.gguf', nctx = 131072, cap = 7200, status = 'fail' } = {}) => ins.run(rp, 'b', task, status, ex, model, nctx, cap, 'opencode', 'm', null, null);
    local('results/q4/t1.json', 't1');                                     // scored at the config: dropped
    local('results/q4-64k/t2.json', 't2', { nctx: 65536 });                // another context: not this config
    local('results/q4-3h/t3.json', 't3', { cap: 10800 });                  // another cap: not this config
    local('results/q4/t4.json', 't4', { ex: 1 });                          // excluded: does not count
    local('results/q4/t5.json#bonus', 't5+bonus');                         // a bonus result is not a run of t5
    local('results/q4-nothink/t6.json', 't6');                             // thinking off: only q4-nt's
    local('results/gsq/t7.json', 't7', { model: '/m/GSQ-IQ2_XS-mtp-f32ssm.gguf', nctx: 81920 });   // the f32ssm copy of gsq's file
    ins.run('results/h/t8.json', 'h', 't8', 'pass', 0, null, null, 7200, 'claude', 'claude-haiku-4-5', 'low', 'solo');
    ins.run('results/h2/t9.json', 'h2', 't9', 'pass', 0, null, null, 7200, 'claude', 'claude-haiku-4-5', 'high', 'solo');   // another effort
    const T = ['t1', 't2', 't3', 't4', 't5', 't6', 't7', 't8', 't9'];
    assert.deepStrictEqual([...q.scoredAtConfig(settings.models[0], T)].sort(), ['t1']);
    assert.deepStrictEqual([...q.scoredAtConfig(settings.models[1], T)].sort(), ['t6']);
    assert.deepStrictEqual([...q.scoredAtConfig(settings.models[2], T)].sort(), ['t7']);
    assert.strictEqual(q.scoredAtConfig(settings.models[3], T), null, 'no dbLike: cannot be looked up');
    assert.deepStrictEqual([...q.scoredAtConfig(settings.models[4], T)].sort(), ['t8']);
    const batch = { strategy: 'greedy', cascade: { order: ['haiku', 'q4'], seed: ['t1'] }, legs: [
        { model: 'q4', lane: 'local', runs: T.map((task) => ({ task })) },
        { model: 'q4-nt', lane: 'local', runs: [{ task: 't6', rerun: true }, { task: 't1' }] },
        { model: 'gsq', lane: 'local', runs: [{ task: 't7' }] },
        { model: 'nolike', lane: 'local', runs: [{ task: 't1' }] },
        { model: 'haiku', lane: 'cloud', runs: [{ task: 't8' }, { task: 't9' }] },
        { model: 'q4', lane: 'local', cascade: 1, runs: [{ task: 't1' }] },
    ] };
    const g = q.dropScored(batch, settings);
    assert.deepStrictEqual(g.dropped, [{ model: 'q4', task: 't1' }, { model: 'gsq', task: 't7' }, { model: 'haiku', task: 't8' }]);
    assert.deepStrictEqual(batch.legs[0].runs.length, 9, 'the input is not modified');
    assert.deepStrictEqual(q.dropScored({ ...batch, rerunScored: true }, settings).dropped, [], '"include re-runs" on the batch keeps everything');
    const rows = q.insertBatch(batch, settings, { stamp: 'T' });
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]));
    assert.deepStrictEqual(byLabel['aqT-q4-1'].tasks, ['t2', 't3', 't4', 't5', 't6', 't7', 't8', 't9']);
    assert.deepStrictEqual(byLabel['aqT-q4-nt-2'].tasks, ['t6', 't1'], 'a run marked rerun is kept');
    assert.strictEqual(rows.some((r) => /gsq/.test(r.label)), false, 'a leg left empty is not inserted');
    assert.deepStrictEqual(byLabel['aqT-nolike-3'].tasks, ['t1'], 'a config that cannot be looked up is left alone');
    assert.deepStrictEqual(byLabel['aqT-haiku-4'].tasks, ['t9']);
    assert.deepStrictEqual(byLabel['aqT-q4-c1'].approved, ['t1'], 'a cascade stage filters at run time (task_source torun), not here');
});

test('queue: presets from the Auto queue configs; launch variables from the env files', () => {
    const { q } = fresh();
    const p = q.presets({ models: [{ id: 'q4', label: 'Q4', opencodeModel: 'q4m', cmd: '$STOCK -m $Q4', nCtx: 131072 }, { id: 'h', runner: 'claude', claudeModel: 'c', effort: 'low' }, { id: 'noeff', runner: 'claude', claudeModel: 'c' }] });
    const ids = p.presets.map((x) => x.id);
    assert.ok(ids.includes('q4') && ids.includes('h') && !ids.includes('noeff'));
    assert.deepStrictEqual(p.presets.find((x) => x.id === 'h').env, { CODEBENCH_CLAUDE_EFFORT: 'low', CODEBENCH_CLAUDE_SCAFFOLD: 'solo', CODEBENCH_DOCS: 'off' });
    assert.deepStrictEqual(p.presets.find((x) => x.id === 'q4').env, { CODEBENCH_DOCS: 'off' }, 'a preset fill pins docs off too');
    assert.strictEqual(p.vars.Q4, '/m/q4.gguf');
    assert.strictEqual(p.vars.FLASH_Q2_CMD, "/u/llama -m /m/q2.gguf -ot 'blk.(1|2)=CUDA0'");
    assert.strictEqual(expandPreview('$STOCK -m $Q4 $D27MTP', p.vars), '/bin/llama-server -m /m/q4.gguf -ngl 999 -fa on');
    assert.deepStrictEqual(parseEnvFile('/nonexistent'), {});
    // Strata profiles from profiles.json
    const strata1m = p.presets.find((x) => x.id.includes('Strata Coder IQ1_M · 1M'));
    if (strata1m) {
        assert.strictEqual(strata1m.model, 'local-1024k');
        // 2026-10-15: the pack's own file, not '%coder-IQ1_M%' / '%IQ3_XXS%' (which took other packs' and quants' rows)
        assert.match(strata1m.dbLike, /^%\/[^%]*IQ1_M[^%]*\.gguf$|^%coder-IQ1_M%$/);
        assert.ok(strata1m.launch_cmd.includes('queue-serve.sh'));
    }
    // 27B XTX-only profile from profiles.json
    const xtx27 = p.presets.find((x) => x.id.includes('Qwen3.8-27B') && x.id.includes('XTX only'));
    if (xtx27) {
        assert.strictEqual(xtx27.model, 'qwen38-27b-q4-128k');
        // 2026-10-15: one file ('%Qwen3.8-27B%' matched every 27B quant and fine-tune)
        assert.notStrictEqual(xtx27.dbLike, '%Qwen3.8-27B%');
        assert.match(xtx27.dbLike, /Q4_K_XL/);
        assert.ok(xtx27.launch_cmd.includes('-dev ROCm0'));
    }
});

test('queue: HTTP API (handleApi) end to end', () => {
    const { q } = fresh();
    const call = (method, p, body, query) => handleApi(q, { method, path: p, body, query: new URLSearchParams(query || '') }, { loadSettings: () => ({ models: [] }) });
    let r = call('POST', '/api/queue/items', { item: RUN({ label: 'one' }) });
    assert.strictEqual(r.code, 200); const id = r.body.item.id;
    r = call('POST', '/api/queue/items', { item: RUN({ label: 'zero' }), before: id });
    assert.strictEqual(call('GET', '/api/queue').body.pending.map((i) => i.label).join(), 'zero,one');
    assert.strictEqual(call('POST', '/api/queue/items', { item: RUN({ launch_cmd: '"' }) }).code, 400);
    assert.strictEqual(call('POST', '/api/queue/item/update', { id, fields: { notes: 'n' } }).body.item.notes, 'n');
    assert.strictEqual(call('POST', '/api/queue/item/move', { id, dir: 'up' }).code, 200);
    assert.strictEqual(call('GET', '/api/queue').body.pending[0].label, 'one');
    assert.strictEqual(call('POST', '/api/queue/item/duplicate', { id }).body.item.label, 'one-r2');
    // the Queue page's "again" (2026-10-26): a finished item's copy at the top of the lane; a bad position is a 400
    q.open().prepare("UPDATE queue_items SET status='done' WHERE label='zero'").run();
    const zid = q.open().prepare("SELECT id FROM queue_items WHERE label='zero'").get().id;
    r = call('POST', '/api/queue/item/duplicate', { id: zid, position: 'top' });
    assert.strictEqual(r.code, 200); assert.strictEqual(call('GET', '/api/queue').body.pending[0].id, r.body.item.id);
    assert.strictEqual(call('POST', '/api/queue/item/duplicate', { id: zid, position: 'middle' }).code, 400);
    assert.strictEqual(call('POST', '/api/queue/item/duplicate', { id: zid }).body.item.id, call('GET', '/api/queue').body.pending.slice(-1)[0].id, 'no position: the end, as before');
    assert.strictEqual(call('POST', '/api/queue/item/status', { id, action: 'hold' }).body.item.status, 'paused');
    assert.strictEqual(call('POST', '/api/queue/lane', { lane: 'local-gpu', paused: true }).body.lane.paused, 1);
    assert.strictEqual(call('GET', '/api/queue/item', null, `id=${id}`).body.item.id, id);
    assert.deepStrictEqual(call('GET', '/api/queue/preview', null, `id=${id}`).body.tasks, ['a', 'b']);
    assert.strictEqual(call('GET', '/api/queue/item', null, 'id=99999').code, 404);
    assert.strictEqual(call('POST', '/api/queue/item/control', { id, action: 'stop-now' }).code, 400);
    assert.ok(Array.isArray(call('GET', '/api/queue/presets').body.presets));
    assert.strictEqual(call('DELETE', '/api/queue').code, 404);
});

test('queue: pi items are local legs like opencode (need a launch_cmd); CODEBENCH_PI_EXT must be none or sol-pi', () => {
    const { q } = fresh();
    const a = q.insert(RUN({ label: 'pi-plain', runner: 'pi' }));
    assert.strictEqual(a.runner, 'pi');
    const b = q.insert(RUN({ label: 'pi-solpi', runner: 'pi', env: { CODEBENCH_PI_EXT: 'sol-pi' } }));
    assert.strictEqual(b.env.CODEBENCH_PI_EXT, 'sol-pi');
    assert.throws(() => q.insert(RUN({ label: 'pi-nolaunch', runner: 'pi', launch_cmd: null })), /a local pi item needs a launch_cmd/);
    assert.throws(() => q.insert(RUN({ label: 'pi-bad', runner: 'pi', env: { CODEBENCH_PI_EXT: 'turbo' } })), /CODEBENCH_PI_EXT must be none or sol-pi/);
    assert.throws(() => q.insert(RUN({ label: 'x', runner: 'cursor' })), /runner must be opencode, claude or pi/);
});

// ---------------------------------------------------------------- estimates + queue_meta (2026-10-07)
const HIST = { n: 3, mean: 700, tasks: { a: 900, c: 300 } };   // seconds: this config ran a (twice) and c; never b
const near = (x, y) => assert.ok(Math.abs(x - y) < 0.011, `${x} ~ ${y}`);

test('estimate: measured -- every task timed from this config\'s own past runs of it, capped at the per-task timeout', () => {
    const e = estimateItem({ tasks: ['a', 'c'], total: 2, timeout_s: 7200, hist: HIST, est_hours: 99 });
    near(e.hours, 1200 / 3600);
    assert.deepStrictEqual([e.basis, e.rough, e.measured_tasks, e.config_tasks, e.guess_tasks], ['history', false, 2, 0, 0]);
    near(e.measured_hours, e.hours); assert.strictEqual(e.fallback_hours, 0);
    // the cap is the item's: a 900 s task under a 600 s cap counts 600
    near(estimateItem({ tasks: ['a', 'c'], timeout_s: 600, hist: HIST }).hours, (600 + 300) / 3600);
});

test('estimate: fallback -- a task nobody has run locally costs the config\'s mean over all tasks; no history at all uses the hand estimate, spread evenly', () => {
    const mixed = estimateItem({ tasks: ['a', 'b'], timeout_s: 7200, hist: HIST });
    near(mixed.hours, (900 + 700) / 3600);
    assert.deepStrictEqual([mixed.measured_tasks, mixed.config_tasks, mixed.rough], [1, 1, false]);
    const mostly = estimateItem({ tasks: ['b', 'd', 'c'], timeout_s: 7200, hist: HIST });   // 700 + 700 fallback against 300 measured
    assert.deepStrictEqual([mostly.measured_tasks, mostly.config_tasks, mostly.rough, mostly.basis], [1, 2, true, 'history']);
    near(mostly.fallback_hours, 1400 / 3600);
    near(estimateItem({ tasks: ['b'], timeout_s: 300, hist: HIST }).hours, 300 / 3600);   // the config mean is capped too
    const guess = estimateItem({ tasks: ['a', 'b', 'c', 'd'], total: 4, timeout_s: 7200, hist: null, est_hours: 6 });
    assert.deepStrictEqual([guess.hours, guess.basis, guess.rough, guess.guess_tasks, guess.measured_hours, guess.fallback_hours], [6, 'guess', true, 4, 0, 6]);
    // history wins over the hand estimate whenever there is any
    assert.strictEqual(estimateItem({ tasks: ['b'], hist: HIST, est_hours: 6 }).basis, 'history');
});

test('estimate: fallback -- a task the config never ran is timed from the other local models\' runs of it, at this config\'s pace', () => {
    // every local model together: a 1800, c 600 -> this config (a 900, c 300) runs at half their time; b takes them 1000, a composite 9000
    const local = { tasks: { a: 1800, c: 600, b: 1000, multi: 9000, other: 50 } };
    const e = estimateItem({ tasks: ['a', 'b', 'multi', 'nobody'], timeout_s: 7200, hist: HIST, local });
    near(e.hours, (900 + 500 + 4500 + 700) / 3600);   // a: its own; b and the composite: theirs x 0.5; `nobody`: no local run anywhere -> the config's mean
    assert.deepStrictEqual([e.measured_tasks, e.scaled_tasks, e.config_tasks, e.guess_tasks, e.speed_ratio, e.basis, e.rough], [1, 2, 1, 0, 0.5, 'history', true]);
    near(e.measured_hours, 900 / 3600); near(e.fallback_hours, 5700 / 3600);   // scaled counts as fallback for "rough"
    near(estimateItem({ tasks: ['multi'], timeout_s: 3600, hist: HIST, local }).hours, 1);   // capped like the rest
    assert.strictEqual(estimateItem({ tasks: ['a', 'c'], hist: HIST, local }).speed_ratio, null);   // nothing scaled: no ratio to report
    // a config with no history of its own: the local field's time as it is (ratio 1), and the hand estimate only for what nobody ran
    const fresh1 = estimateItem({ tasks: ['b', 'multi'], total: 2, timeout_s: 28800, hist: null, local, est_hours: 99 });
    near(fresh1.hours, 10000 / 3600); assert.deepStrictEqual([fresh1.scaled_tasks, fresh1.speed_ratio, fresh1.basis, fresh1.rough], [2, 1, 'history', true]);
    const part = estimateItem({ tasks: ['b', 'nobody'], total: 2, timeout_s: 7200, hist: null, local, est_hours: 4 });
    near(part.hours, 1000 / 3600 + 2); assert.deepStrictEqual([part.scaled_tasks, part.guess_tasks, part.basis], [1, 1, 'history']);
    assert.strictEqual(estimateItem({ tasks: ['b', 'nobody'], total: 2, hist: null, local, est_hours: null }), null);   // one task nothing can time: no estimate
    // a cloud item is not handed the local field: its unknown task stays at its own runner model's mean
    assert.deepStrictEqual([estimateItem({ tasks: ['b'], hist: HIST, local: null }).config_tasks, estimateItem({ tasks: ['b'], hist: HIST, local: null }).scaled_tasks], [1, 0]);
});

test('estimate: thinking off is its own config -- --reasoning off in the launch command keys the item and the history rows apart from thinking-on', () => {
    const vars = { STOCK: '/bin/llama-server', Q4: '/m/q4.gguf' };
    assert.deepStrictEqual(historyKeys({ launch_cmd: '$STOCK -m $Q4 -c 131072 -ngl 999 --reasoning off' }, vars), ['m:q4.gguf|131072|nothink']);
    assert.deepStrictEqual(historyKeys({ launch_cmd: '$STOCK -m $Q4 -c 131072 --reasoning on' }, vars), ['m:q4.gguf|131072']);
    assert.deepStrictEqual(historyKeys({ launch_cmd: '$STOCK -m $Q4 -c 131072 --reasoning-budget 0' }, vars), ['m:q4.gguf|131072']);
    const row = (o) => ({ model_path: '/m/q4.gguf', n_ctx: 131072, nothink: 0, runner: 'opencode', provider: 'local', runner_model: 'llama-local/x', effort: null, task: 'a', n: 1, s: 1400, ...o });
    const h = buildHistory([row(), row({ nothink: 1, s: 240 }), row({ nothink: 1, task: 'b', s: 260 }), row({ model_path: '/m/other.gguf', s: 600 }),
        row({ runner: 'pi', s: 5000 }), row({ model_path: null, n_ctx: null, runner: 'claude', provider: 'cloud', runner_model: 'claude-x', s: 60 })]);
    assert.deepStrictEqual(h.get('m:q4.gguf|131072|nothink'), { n: 2, mean: 250, tasks: { a: 240, b: 260 } });
    assert.deepStrictEqual(h.get('m:q4.gguf|131072'), { n: 2, mean: 3200, tasks: { a: 3200 } });   // thinking-on: the opencode and the pi run, not the 240 s one
    // the local field: opencode runs of every local model, thinking on or off; not pi, not cloud
    assert.deepStrictEqual(h.get(LOCAL_ALL), { n: 4, mean: (1400 + 240 + 260 + 600) / 4, tasks: { a: (1400 + 240 + 600) / 3, b: 260 } });
});

test('queue: list() times a thinking-off item from thinking-off runs, and a never-run task from the other local models at this config\'s pace', () => {
    const { q } = fresh({ estTtlMs: 0 });
    const db = q.open();
    let rn = 0;
    const run = (o) => db.prepare(`INSERT INTO runs (result_path, battery, task, started_at, excluded, wall_s, runner, provider, model_path, n_ctx, launch_command)
        VALUES (@result_path, @battery, @task, @started_at, 0, @wall_s, 'opencode', 'local', @model_path, 131072, @launch_command)`)
        .run({ result_path: `results/y/${++rn}.json`, battery: 'old', started_at: '2026-10-01T00:00:00Z', model_path: '/m/q4.gguf', launch_command: '/bin/llama-server -m /m/q4.gguf -c 131072', ...o });
    const OFF = '/bin/llama-server -m /m/q4.gguf -c 131072 --reasoning off';
    run({ task: 'a', wall_s: 1400 }); run({ task: 'b', wall_s: 1600 }); run({ task: 'a', wall_s: 1500, launch_command: null });   // thinking on (a null launch command is thinking-on)
    run({ task: 'a', wall_s: 240, launch_command: OFF });                                                                       // thinking off
    run({ task: 'multi', wall_s: 9000, model_path: '/m/other.gguf', launch_command: '/bin/llama-server -m /m/other.gguf -c 131072' });
    run({ task: 'a', wall_s: 730, model_path: '/m/other.gguf', launch_command: '/bin/llama-server -m /m/other.gguf -c 131072' });
    const on = q.insert(RUN({ label: 'on', tasks: ['a', 'multi'], timeout_s: 28800 }));
    const off = q.insert(RUN({ label: 'off', tasks: ['a', 'b'], launch_cmd: '$STOCK -m $Q4 -c 131072 $D27MTP --reasoning off' }));
    const L = q.list(); const by = (id) => L.pending.find((i) => i.id === id).est;
    // local field: a = (1400 + 1500 + 240 + 730) / 4 = 967.5, b = 1600, multi = 9000
    // thinking on: a 1450 of its own; over (a, b) it takes 1450 + 1600 against the field's 967.5 + 1600 -> x 1.19 on the composite
    const ratioOn = (1450 + 1600) / (967.5 + 1600);
    assert.strictEqual(by(on.id).timed_from, 'm:q4.gguf|131072');
    near(by(on.id).hours, (1450 + 9000 * ratioOn) / 3600);
    assert.deepStrictEqual([by(on.id).measured_tasks, by(on.id).scaled_tasks, by(on.id).config_tasks, by(on.id).rough], [1, 1, 0, true]);
    // thinking off: a 240 of its own (not 1450); b never run thinking-off -> the field's 1600 x (240 / 967.5)
    assert.strictEqual(by(off.id).timed_from, 'm:q4.gguf|131072|nothink');
    near(by(off.id).hours, (240 + 1600 * (240 / 967.5)) / 3600);
    assert.deepStrictEqual([by(off.id).measured_tasks, by(off.id).scaled_tasks, by(off.id).speed_ratio], [1, 1, 0.25]);
});

test('estimate: a running item counts only what is not scored yet, less the time already spent on the task in flight', () => {
    // 4 tasks, a is scored: c is in flight for 100 s of its usual 300
    const e = estimateItem({ tasks: ['c', 'a', 'b'], total: 4, timeout_s: 7200, hist: HIST, elapsed_s: 100 });
    near(e.hours, (200 + 900 + 700) / 3600);
    assert.deepStrictEqual([e.tasks, e.overdue], [3, false]);
    // past its usual time: it counts nothing more (never negative) and says so
    const late = estimateItem({ tasks: ['c', 'a'], total: 4, timeout_s: 7200, hist: HIST, elapsed_s: 5000 });
    near(late.hours, 900 / 3600); assert.strictEqual(late.overdue, true);
    // the hand estimate keeps the share of the tasks still to run
    near(estimateItem({ tasks: ['c'], total: 4, hist: null, est_hours: 8 }).hours, 2);
    // every task scored: nothing left, whatever the history
    assert.strictEqual(estimateItem({ tasks: [], total: 4, hist: null, est_hours: 8 }).hours, 0);
    // a shell / wait item has no task list: the hand estimate less the time it has been running
    near(estimateItem({ est_hours: 1, elapsed_s: 1800 }).hours, 0.5);
});

test('estimate: no history and no hand estimate is no estimate (never invented)', () => {
    assert.strictEqual(estimateItem({ tasks: ['a', 'b'], total: 2, timeout_s: 7200, hist: null, est_hours: null }), null);
    assert.strictEqual(estimateItem({ tasks: ['a'], hist: { n: 0, mean: NaN, tasks: {} } }), null);
    assert.strictEqual(estimateItem({ tasks: null, est_hours: undefined }), null);   // a shell item nobody estimated
    assert.strictEqual(estimateItem({ tasks: null, hist: HIST }), null);             // an unresolved task source: history alone cannot say
});

test('estimate: history keys -- model file + context from the launch command (variables expanded, Strata config read), runner model (+ effort) for cloud', () => {
    const vars = { STOCK: '/bin/llama-server', Q4: '/m/sub/q4.gguf' };
    assert.deepStrictEqual(historyKeys({ launch_cmd: '$STOCK -m $Q4 -md /m/draft.gguf -c 131072 -ngl 999' }, vars), ['m:q4.gguf|131072']);
    assert.deepStrictEqual(historyKeys({ launch_cmd: "/x/llama-server --model '/m/q6.gguf' --ctx-size 65536" }, vars), ['m:q6.gguf|65536']);
    const strata = { args: ['--pack', '/p', '--native', '/s/IQ3/flash-00001-of-00002.gguf', '--max-context', '131072'] };
    assert.deepStrictEqual(historyKeys({ launch_cmd: '/s/queue-serve.sh /s/strata-iq3.json' }, vars, (f) => (f === '/s/strata-iq3.json' ? strata : null)), ['m:flash-00001-of-00002.gguf|131072']);
    assert.deepStrictEqual(historyKeys({ launch_cmd: '/s/queue-serve.sh /s/missing.json' }, vars, () => { throw new Error('ENOENT'); }), []);
    assert.deepStrictEqual(historyKeys({ lane: 'cloud', runner: 'claude', model: 'claude-x', env: { CODEBENCH_CLAUDE_EFFORT: 'xhigh' } }), ['c:claude-x|xhigh', 'c:claude-x']);
    assert.deepStrictEqual(historyKeys({ lane: 'cloud', runner: 'agy', model: 'gemini-low' }), ['c:gemini-low']);
    assert.deepStrictEqual(historyKeys({ lane: 'local-gpu', kind: 'shell' }), []);
    // the grouped rows -> per-key mean and per-task means; a cloud row lands under the model and under model|effort
    const h = buildHistory([
        { model_path: '/m/sub/q4.gguf', n_ctx: 131072, runner_model: 'llama-local/x', effort: null, task: 'a', n: 2, s: 1800 },
        { model_path: '/elsewhere/q4.gguf', n_ctx: 131072, runner_model: 'llama-local/y', effort: null, task: 'c', n: 1, s: 300 },
        { model_path: '/m/sub/q4.gguf', n_ctx: 65536, runner_model: null, effort: null, task: 'a', n: 1, s: 50 },
        { model_path: null, n_ctx: null, runner_model: 'claude-x', effort: 'low', task: 'a', n: 1, s: 100 },
        { model_path: null, n_ctx: null, runner_model: 'claude-x', effort: 'xhigh', task: 'a', n: 1, s: 900 },
        { model_path: null, n_ctx: null, runner_model: null, effort: null, task: 'a', n: 5, s: 5 },
    ]);
    assert.deepStrictEqual(h.get('m:q4.gguf|131072'), { n: 3, mean: 700, tasks: { a: 900, c: 300 } });
    assert.strictEqual(h.get('m:q4.gguf|65536').mean, 50);
    assert.deepStrictEqual([h.get('c:claude-x').mean, h.get('c:claude-x|low').mean, h.get('c:claude-x|xhigh').tasks.a], [500, 100, 900]);
    assert.strictEqual(h.size, 5);
});

test('estimate: lane clock -- running first, then pending back to back from now; held items are passed by; an item with no estimate makes the rest "no earlier than"', () => {
    const now = Date.parse('2026-10-07T12:00:00Z');
    const est = (hours) => ({ hours });
    const { clocks, lanes } = laneClocks([
        { id: 1, lane: 'x', status: 'running', started_at: '2026-10-07T10:00:00Z', est: est(1) },
        { id: 2, lane: 'x', status: 'paused', est: est(50) },
        { id: 3, lane: 'x', status: 'pending', est: est(2) },
        { id: 4, lane: 'x', status: 'pending', est: null },
        { id: 5, lane: 'x', status: 'pending', est: est(0.5) },
        { id: 6, lane: 'y', status: 'pending', est: est(3) },
    ], now);
    assert.deepStrictEqual(clocks.get(1), { starts_at: '2026-10-07T10:00:00Z', done_at: '2026-10-07T13:00:00Z', after_unknown: false });
    assert.strictEqual(clocks.has(2), false);
    assert.deepStrictEqual(clocks.get(3), { starts_at: '2026-10-07T13:00:00Z', done_at: '2026-10-07T15:00:00Z', after_unknown: false });
    assert.deepStrictEqual(clocks.get(4), { starts_at: '2026-10-07T15:00:00Z', done_at: null, after_unknown: false });
    assert.deepStrictEqual(clocks.get(5), { starts_at: '2026-10-07T15:00:00Z', done_at: '2026-10-07T15:30:00Z', after_unknown: true });
    assert.deepStrictEqual(lanes.x, { hours: 3.5, items: 3, unknown: 1, done_at: '2026-10-07T15:30:00Z' });
    assert.deepStrictEqual(lanes.y, { hours: 3, items: 1, unknown: 0, done_at: '2026-10-07T15:00:00Z' });
});

test('queue: list() carries question / user_note / est / clock on pending and running items, from runs + queue_meta; history rows are untouched', () => {
    const { q } = fresh({ estTtlMs: 0 });
    const db = q.open();
    let rn = 0;
    const run = (o) => db.prepare(`INSERT INTO runs (result_path, battery, task, started_at, excluded, wall_s, runner_model, effort, model_path, n_ctx)
        VALUES (@result_path, @battery, @task, @started_at, @excluded, @wall_s, @runner_model, @effort, @model_path, @n_ctx)`)
        .run({ result_path: `results/x/${++rn}.json`, battery: 'old', started_at: '2026-10-01T00:00:00Z', excluded: 0, runner_model: null, effort: null, model_path: null, n_ctx: null, ...o });
    // $Q4 is /m/q4.gguf (vars.env): at 131072 it ran a twice (600, 1200) and c once (300); an excluded run counts for nothing
    for (const [task, wall_s, excluded] of [['a', 600, 0], ['a', 1200, 0], ['c', 300, 0], ['a', 99999, 1]]) run({ task, wall_s, excluded, model_path: '/m/q4.gguf', n_ctx: 131072 });
    run({ task: 'a', wall_s: 5, model_path: '/m/q4.gguf', n_ctx: 65536 });                                     // another context: another config
    run({ task: 'a', wall_s: 100, runner_model: 'claude-haiku-4-5', effort: 'low' });
    run({ task: 'a', wall_s: 1000, runner_model: 'claude-haiku-4-5', effort: 'high' });
    const known = q.insert(RUN({ label: 'known' }));                                                              // a 900 (own runs) + b 700 (config mean)
    const guessed = q.insert(RUN({ label: 'guessed', launch_cmd: '$STOCK -m /m/never-ran.gguf -c 131072' }));
    const held = q.insert(RUN({ label: 'held', tasks: ['c'] })); q.setStatus(held.id, 'hold');
    const unknown = q.insert(RUN({ label: 'unknown', launch_cmd: '$STOCK -m /m/never-ran.gguf -c 131072' }));
    const last = q.insert(RUN({ label: 'last', tasks: ['c'], timeout_s: 120 }));                                  // 300 capped at 120
    const cloud = q.insert(RUN({ label: 'cloud', lane: 'cloud', runner: 'claude', model: 'claude-haiku-4-5', launch_cmd: null, tasks: ['a'], env: { CODEBENCH_CLAUDE_EFFORT: 'low', CODEBENCH_CLAUDE_SCAFFOLD: 'solo' } }));
    db.prepare('INSERT INTO queue_meta (item_id, question, est_hours, user_note) VALUES (?,?,?,?)').run(known.id, 'Does it hold?', 99, null);
    db.prepare('INSERT INTO queue_meta (item_id, question, est_hours, user_note) VALUES (?,?,?,?)').run(guessed.id, null, 3, 'mine');
    let L = q.list();
    const by = (l) => [...L.running, ...L.pending].find((i) => i.label === l);
    assert.strictEqual(L.est_error, undefined);
    near(by('known').est.hours, 1600 / 3600);
    assert.deepStrictEqual([by('known').est.basis, by('known').est.measured_tasks, by('known').est.config_tasks, by('known').est.timed_from], ['history', 1, 1, 'm:q4.gguf|131072']);
    assert.deepStrictEqual([by('known').question, by('known').user_note], ['Does it hold?', '']);
    assert.deepStrictEqual([by('guessed').est.hours, by('guessed').est.basis, by('guessed').est.rough, by('guessed').user_note, by('guessed').question], [3, 'guess', true, 'mine', null]);
    assert.strictEqual(by('unknown').est, null);
    near(by('held').est.hours, 300 / 3600); assert.strictEqual(by('held').clock, null);
    near(by('last').est.hours, 120 / 3600);
    near(by('cloud').est.hours, 100 / 3600); assert.strictEqual(by('cloud').est.timed_from, 'c:claude-haiku-4-5|low');
    // the lane's clock: known, then guessed right after it; `last` sits behind an item with no estimate
    assert.strictEqual(by('guessed').clock.starts_at, by('known').clock.done_at);
    assert.deepStrictEqual([by('unknown').clock.done_at, by('unknown').clock.after_unknown, by('last').clock.after_unknown], [null, false, true]);
    assert.deepStrictEqual([L.lane_est['local-gpu'].items, L.lane_est['local-gpu'].unknown, L.lane_est.cloud.items], [3, 1, 1]);
    near(L.lane_est['local-gpu'].hours, 1600 / 3600 + 3 + 120 / 3600);
    // running: of [a, b, c] its battery has scored a since it started (an older row of the same name does not count)
    db.prepare("UPDATE queue_items SET status='running', started_at=?, resolved_tasks_json=?, result_dir=? WHERE id=?")
        .run('2026-10-07T10:00:00Z', JSON.stringify(['a', 'b', 'c']), '/r/results/known-battery', known.id);
    run({ battery: 'known-battery', task: 'a', wall_s: 50, started_at: '2026-10-07T10:00:05Z', model_path: '/m/q4.gguf', n_ctx: 131072 });
    run({ battery: 'known-battery', task: 'c', wall_s: 50, started_at: '2026-10-06T10:00:05Z', model_path: '/m/q4.gguf', n_ctx: 131072 });
    L = q.list();
    assert.deepStrictEqual([L.running[0].label, L.running[0].est.tasks, L.running[0].est.overdue], ['known', 2, true]);   // b (in flight since 10:00:55, long past its 600 s) + c
    assert.ok(L.running[0].est.hours > 0 && L.running[0].est.hours < 0.09);   // c alone: the mean of 300 and the two 50 s rows of this battery
    assert.strictEqual(L.running[0].clock.starts_at, '2026-10-07T10:00:00Z');
    assert.strictEqual(by('guessed').clock.starts_at, L.running[0].clock.done_at);
    // a finished item is history: no estimate, no clock
    db.prepare("UPDATE queue_items SET status='done' WHERE id=?").run(known.id);
    L = q.list();
    assert.deepStrictEqual(['est', 'clock', 'question', 'user_note'].filter((k) => k in L.history[0]), []);
});

test('queue: POST /api/queue/item/meta saves the note and the question (queue_meta only), and validates', () => {
    const { q } = fresh({ estTtlMs: 0 });
    const call = (method, p, body, query) => handleApi(q, { method, path: p, body, query: new URLSearchParams(query || '') }, { loadSettings: () => ({ models: [] }) });
    const id = q.insert(RUN({ label: 'one' })).id;
    const db = q.open();
    db.prepare('INSERT INTO queue_meta (item_id, question, est_hours, user_note, updated_at) VALUES (?,?,?,?,?)').run(id, 'Old question?', 6, '', '2026-10-07 21:40:33');
    const rowBefore = JSON.stringify(db.prepare('SELECT * FROM queue_items WHERE id=?').get(id));
    const eventsBefore = db.prepare('SELECT count(*) AS n FROM queue_events').get().n;
    // the note: stored as typed (plain text; markup is just characters), est_hours and the question kept
    let r = call('POST', '/api/queue/item/meta', { id, user_note: 'run this <b>first</b>\r\nthen "that"\u0000' });
    assert.strictEqual(r.code, 200);
    assert.deepStrictEqual([r.body.meta.user_note, r.body.meta.question, r.body.meta.est_hours], ['run this <b>first</b>\nthen "that"', 'Old question?', 6]);
    assert.match(r.body.meta.updated_at, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.strictEqual(call('GET', '/api/queue').body.pending[0].user_note, 'run this <b>first</b>\nthen "that"');
    // the question: one line; the note stays
    r = call('POST', '/api/queue/item/meta', { id, question: '  Does it\n hold?  ' });
    assert.deepStrictEqual([r.body.meta.question, r.body.meta.user_note], ['Does it hold?', 'run this <b>first</b>\nthen "that"']);
    // clearing is a save too
    assert.strictEqual(call('POST', '/api/queue/item/meta', { id, user_note: '' }).body.meta.user_note, '');
    assert.strictEqual(call('POST', '/api/queue/item/meta', { id, user_note: null }).body.meta.user_note, '');
    // an item with no row yet gets one
    const id2 = q.insert(RUN({ label: 'two' })).id;
    const m2 = call('POST', '/api/queue/item/meta', { id: id2, user_note: 'new' }).body.meta;
    assert.deepStrictEqual([m2.item_id, m2.question, m2.est_hours, m2.user_note], [id2, null, null, 'new']);
    // validation: the item must exist, something must be sent, text only, capped
    assert.strictEqual(call('POST', '/api/queue/item/meta', { id: 99999, user_note: 'x' }).code, 404);
    assert.strictEqual(call('POST', '/api/queue/item/meta', { id: 'abc', user_note: 'x' }).code, 404);
    assert.match(call('POST', '/api/queue/item/meta', { user_note: 'x' }).body.error, /id is required/);
    assert.match(call('POST', '/api/queue/item/meta', { id }).body.error, /user_note or question is required/);
    assert.match(call('POST', '/api/queue/item/meta', { id, est_hours: 2 }).body.error, /user_note or question is required/);
    assert.match(call('POST', '/api/queue/item/meta', { id, user_note: { a: 1 } }).body.error, /must be text/);
    assert.match(call('POST', '/api/queue/item/meta', { id, question: 7 }).body.error, /must be text/);
    assert.strictEqual(call('POST', '/api/queue/item/meta', { id, user_note: 'x'.repeat(META_MAX) }).code, 200);
    r = call('POST', '/api/queue/item/meta', { id, user_note: 'x'.repeat(META_MAX + 1) });
    assert.strictEqual(r.code, 400); assert.match(r.body.error, /too long/);
    assert.strictEqual(call('POST', '/api/queue/item/meta', { id, question: 'q'.repeat(META_MAX + 1) }).code, 400);
    assert.strictEqual(db.prepare('SELECT user_note FROM queue_meta WHERE item_id=?').get(id).user_note.length, META_MAX);   // a refused save changed nothing
    assert.strictEqual(call('GET', '/api/queue/item/meta', null, `id=${id}`).code, 404);                                   // write-only: reads come with /api/queue
    // never the queue itself: the item's row is byte-for-byte what it was, and nothing was added to the audit trail
    assert.strictEqual(JSON.stringify(db.prepare('SELECT * FROM queue_items WHERE id=?').get(id)), rowBefore);
    assert.strictEqual(db.prepare('SELECT count(*) AS n FROM queue_events').get().n, eventsBefore + 1);   // + the insert of item two
    assert.strictEqual(db.prepare('SELECT est_hours FROM queue_meta WHERE item_id=?').get(id).est_hours, 6);
});

test('queue: runningFor(battery) is the running item behind a battery -- by label or result dir -- with its question, note and notes', () => {
    const { q } = fresh();
    const a = q.insert(RUN({ label: 'leg-a', notes: 'why this item exists' })); const b = q.insert(RUN({ label: 'leg-b' }));
    assert.strictEqual(q.runningFor('leg-a'), null, 'pending: not running anything');
    const db = q.open();
    db.prepare("UPDATE queue_items SET status='running', started_at=?, result_dir=? WHERE id=?").run('2026-10-07T10:00:00Z', '/r/results/battery_a', a.id);
    q.setMeta(a.id, { question: 'Does it hold?', user_note: 'watch the 3 h cap' });
    assert.deepStrictEqual(q.runningFor('battery_a'), { id: a.id, lane: 'local-gpu', label: 'leg-a', kind: 'run', started_at: '2026-10-07T10:00:00Z', question: 'Does it hold?', user_note: 'watch the 3 h cap', notes: 'why this item exists' });
    assert.strictEqual(q.runningFor('leg-a').id, a.id, 'the label finds it too');
    assert.strictEqual(q.runningFor('batteryXa'), null, 'an exact name, not a pattern');
    // an item with no queue_meta row: empty question and note, never undefined
    db.prepare("UPDATE queue_items SET status='running' WHERE id=?").run(b.id);
    assert.deepStrictEqual([q.runningFor('leg-b').question, q.runningFor('leg-b').user_note, q.runningFor('leg-b').notes], [null, '', '']);
    db.prepare("UPDATE queue_items SET status='done' WHERE id=?").run(a.id);
    assert.strictEqual(q.runningFor('battery_a'), null, 'finished: the lane has moved on');
    assert.strictEqual(q.runningFor(''), null);
});

test('laneCardInfo: lanes carry their cards on this machine; idle leftovers are parked', () => {
    const { laneCardInfo } = require('../lib/queue');
    const topo = require('../lib/topology');
    const XTX = 'AMD Radeon RX 7900 XTX';
    const det = (id, description, totalMib) => ({ id, description, totalMib, freeMib: totalMib });
    const two = topo.build({ detected: [det('ROCm0', XTX, 24560), det('ROCm1', XTX, 24560), det('Vulkan0', XTX, 24560), det('Vulkan1', XTX, 24560)] });
    const lane = (name, runtime, o = {}) => ({ lane: name, paused: 0, alive: true, runtime_json: JSON.stringify(runtime), ...o });
    // the live set of 2026-10-12 (two RX 7900 XTX here, the laptop's lane remote, two leftovers from the old rig)
    const lanes = [
        lane('cloud', {}),
        lane('laptop-4090', { devices: ['LAPTOP4090'], gpu: 'NVIDIA GeForce RTX 4090 Laptop GPU' }),
        lane('local-3060', {}, { paused: 1, alive: false }),
        lane('local-gpu', { server_port: 18080 }, { paused: 1 }),
        lane('local-rocm1', { devices: ['ROCm1'], gpu: XTX }, { paused: 1 }),
        lane('local-xtx', { devices: ['ROCm0'], gpu: XTX }, { paused: 1 }),
    ];
    const out = Object.fromEntries(laneCardInfo(lanes, two).map((l) => [l.lane, [l.card.label, l.card.here, l.card.remote, l.parked]]));
    assert.deepStrictEqual(out, {
        cloud: [null, null, false, false],
        'laptop-4090': ['RTX 4090 Laptop', false, true, false],          // another machine's card: not "absent"
        'local-3060': [null, null, false, true],                         // paused and its runner is gone
        'local-gpu': ['2x RX 7900 XTX', true, false, false],             // paused, but its runner is up and the cards are here
        'local-rocm1': ['RX 7900 XTX #2', true, false, false],
        'local-xtx': ['RX 7900 XTX #1', true, false, false],
    });
    // the same lanes on other machines: one card, mixed vendors, no GPU
    const one = topo.build({ detected: [det('CUDA0', 'NVIDIA GeForce RTX 4090', 24564)] });
    const onOne = Object.fromEntries(laneCardInfo(lanes, one).map((l) => [l.lane, [l.card.label, l.parked]]));
    assert.deepStrictEqual(onOne['local-rocm1'], ['RX 7900 XTX', true], 'its card is not in this machine: parked, named by what its runner published');
    assert.deepStrictEqual(onOne['local-gpu'], ['RTX 4090', false]);
    const mixed = topo.build({ detected: [det('CUDA0', 'NVIDIA GeForce RTX 3060', 12288), det('ROCm0', XTX, 24560)] });
    assert.strictEqual(laneCardInfo(lanes, mixed).find((l) => l.lane === 'local-gpu').card.label, 'RTX 3060 + RX 7900 XTX');
    assert.strictEqual(laneCardInfo(lanes, mixed).find((l) => l.lane === 'local-rocm1').parked, true, 'ROCm1 is not an id on a one-AMD-card machine');
    const none = topo.build({ detected: [] });
    assert.deepStrictEqual(laneCardInfo(lanes, none).find((l) => l.lane === 'local-gpu').card, { label: 'no GPU', here: false, remote: false });
    // bad input never throws: the lane comes back with an empty card
    assert.deepStrictEqual(laneCardInfo([{ lane: 'x', runtime_json: '{not json' }], two)[0].card, { label: null, here: null, remote: false });
    assert.deepStrictEqual(laneCardInfo(null, two), []);
});

// ---------------------------------------------------------------- config identity (lib/configid.js, 2026-10-15)
test('queue: with the config identity, only the config\'s own cell counts as scored; rules and reruns carry it to the runner', () => {
    const asked = [];
    // a stand-in identity lib: cells by (prompt level, thinking off) -- what matters is that the queue asks it, not the predicate
    const cellOf = (s) => `${s.config.prompt_level}|${/--reasoning off/.test(s.launch || '') ? 'off' : 'on'}|${s.config.runner}|${s.config.effort || ''}`;
    const scored = { 'L2|on|opencode|': { t1: [{ status: 'pass' }], t2: [{ status: 'fail' }] }, 'L2|off|opencode|': { t6: [{ status: 'pass' }] }, 'L2|on|claude|low': { t8: [{ status: 'pass' }] } };
    const identity = { scoredIndex: () => ({}), identityOfSpec: (s) => (s && s.config ? { key: cellOf(s), display: cellOf(s) } : null),
        scoredFor: (id, tasks) => Object.fromEntries(Object.entries(scored[id.key] || {}).filter(([t]) => !tasks || tasks.includes(t))) };
    const harnessConfig = (a) => { asked.push(a); return { runner: a.runner, model: a.model, prompt_level: 'L2', harness_mode: 'agentic', timeout_s: a.timeout_s, effort: a.env.CODEBENCH_CLAUDE_EFFORT || null, scaffold: a.env.CODEBENCH_CLAUDE_SCAFFOLD || null }; };
    const { q } = fresh({ identity, harnessConfig });
    const settings = { models: [
        { id: 'q4', opencodeModel: 'q4m', cmd: '$STOCK -m $Q4 -c 131072 $D27MTP', nCtx: 131072, dbLike: '%Q4%' },
        { id: 'q4-nt', opencodeModel: 'q4nt', cmd: '$STOCK -m $Q4 -c 131072 $D27MTP --reasoning off', nCtx: 131072, dbLike: '%Q4%' },
        { id: 'haiku', runner: 'claude', lane: 'cloud', claudeModel: 'claude-haiku-4-5', effort: 'low', scaffold: 'solo' },
    ] };
    // a row the OLD predicate would have counted for q4 (same file, same context): the identity does not
    const ins = q.open().prepare('INSERT INTO runs (result_path, battery, task, status, excluded, model_path, n_ctx, timeout_s, runner) VALUES (?,?,?,?,?,?,?,?,?)');
    ins.run('results/q4-review/t9.json', 'q4-review', 't9', 'pass', 0, '/m/q4.gguf', 131072, 7200, 'opencode');
    const T = ['t1', 't2', 't6', 't8', 't9'];
    assert.deepStrictEqual([...q.scoredAtConfig(settings.models[0], T)].sort(), ['t1', 't2']);
    assert.deepStrictEqual([...q.scoredAtConfig(settings.models[1], T)].sort(), ['t6'], 'thinking off: only its own runs');
    assert.deepStrictEqual([...q.scoredAtConfig(settings.models[2], T)].sort(), ['t8']);
    assert.ok(asked.some((a) => a.runner === 'opencode' && a.model === 'llama-local/q4m'), 'run.py decides the prompt level');
    assert.ok(asked.every((a) => a.env.CODEBENCH_DOCS === 'off'), 'the identity is asked for the docs-off config the rows will run');
    const batch = { strategy: 'greedy', cascade: { order: ['haiku', 'q4'], seed: ['t1'] }, legs: [
        { model: 'q4-nt', lane: 'local', runs: [{ task: 't6', rerun: true }, { task: 't9' }] },
        { model: 'q4', lane: 'local', cascade: 1, runs: [{ task: 't3' }] },
    ] };
    const rows = q.insertBatch(batch, settings, { stamp: 'T' });
    const leg = rows.find((r) => r.label === 'aqT-q4-nt-1');
    assert.deepStrictEqual(leg.tasks, ['t6', 't9']);
    assert.deepStrictEqual(JSON.parse(q.get(leg.id).env_json || '{}'), { CODEBENCH_DOCS: 'off', CODEBENCH_ALLOW_RERUN: 't6' }, 'the marked rerun passes the runner\'s guard; nothing else does');
    const stage = rows.find((r) => r.kind === 'stage');
    const src = JSON.parse(q.get(stage.id).task_source_json);
    assert.strictEqual(src.identity_spec.config.prompt_level, 'L2');
    assert.match(src.identity_spec.launch, /^\/bin\/llama-server -m \/m\/q4\.gguf -c 131072/);
    // the cascade preview filters by the identity too: t1 and t2 ran at q4's config, t3 did not
    assert.deepStrictEqual(q.resolveSource({ from: 'cascade', input: { tasks: ['t1', 't2', 't3'] }, model_like: '%Q4%', n_ctx: 131072, identity_spec: src.identity_spec }), ['t3']);
    assert.deepStrictEqual(q.resolveSource({ from: 'cascade', mode: 'failed', input: { tasks: ['t1', 't2', 't3'] }, model_like: '%Q4%', n_ctx: 131072, identity_spec: src.identity_spec }), ['t2', 't3']);
});

test('queue: with no identity available the old predicate still answers (fallback), and a temp-database queue never uses the live catalog', () => {
    const { q } = fresh({ identity: { scoredIndex: () => { throw new Error('no catalog'); } }, harnessConfig: () => ({ runner: 'opencode', prompt_level: 'L2', timeout_s: 7200 }) });
    q.open().prepare('INSERT INTO runs (result_path, battery, task, status, excluded, model_path, n_ctx, timeout_s, runner) VALUES (?,?,?,?,?,?,?,?,?)')
        .run('results/q4/t1.json', 'q4', 't1', 'pass', 0, '/m/q4.gguf', 131072, 7200, 'opencode');
    assert.deepStrictEqual([...q.scoredAtConfig({ id: 'q4', opencodeModel: 'q4m', cmd: '$STOCK -m $Q4 -c 131072', nCtx: 131072, dbLike: '%/q4.gguf' }, ['t1', 't2'])], ['t1']);
});
