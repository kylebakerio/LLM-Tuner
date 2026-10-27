'use strict';
// ui/benchmarks/queue.js, the part added 2026-10-07: each pending / running item's estimate line, question and
// note box. The view redraws through setHtml (a MERGE, ui/benchmarks/util.js), so what is pinned here is the trap:
// the note box must be the SAME element before and after a redraw -- with an unsaved draft still in it -- also when
// its row moves, and a poll that only moves the clocks must not redraw at all. linkedom has no focus or layout, so
// focus, caret and scroll position are checked in a real browser, not here.
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseHTML } = require('linkedom');

const item = (id, o = {}) => ({ id, lane: 'local-gpu', position: id, status: 'pending', kind: 'run', label: `leg-${id}`, runner: 'opencode', model: 'local-128k',
    launch_cmd: '$STOCK -m /m/q4.gguf -c 131072', tasks: ['a', 'b'], timeout_s: 7200, question: `Question ${id}?`, user_note: '',
    est: { hours: 6, tasks: 2, measured_tasks: 2, config_tasks: 0, guess_tasks: 0, measured_hours: 6, fallback_hours: 0, basis: 'history', rough: false, overdue: false, timed_from: 'm:q4.gguf|131072' },
    clock: { starts_at: '2026-10-08T01:00:00Z', done_at: '2026-10-08T07:00:00Z', after_unknown: false }, ...o });
const queue = (o = {}) => ({ lanes: [{ lane: 'local-gpu', paused: 0, alive: true, runner_state: 'running' }], laneNames: ['local-gpu'],
    running: [item(1, { status: 'running', started_at: '2026-10-07T20:00:00Z', resolved_tasks: ['a', 'b'] })], pending: [item(2), item(3)],
    history: [{ id: 9, lane: 'local-gpu', status: 'done', kind: 'run', label: 'old', model: 'm', outcome: { counts: { pass: 1 } } }],
    lane_est: { 'local-gpu': { hours: 18, items: 3, unknown: 0, done_at: '2026-10-08T13:00:00Z' } }, now: '2026-10-07T21:00:00Z', ...o });

async function setup() {
    const { window, document } = parseHTML('<!doctype html><html><head></head><body><div id="cb-view-queue"></div></body></html>');
    const had = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
    const server = { queue: queue(), posts: [], fail: null };
    globalThis.document = document; globalThis.window = window;
    globalThis.fetch = async (url, opts) => {
        const answer = (code, body) => ({ ok: code === 200, status: code, statusText: '', json: async () => body });
        if (!opts || opts.method !== 'POST') return answer(200, JSON.parse(JSON.stringify(server.queue)));
        const body = JSON.parse(opts.body); server.posts.push([url, body]);
        if (server.fail) return answer(400, { error: server.fail });
        const own = server.reply && server.reply(url, body); if (own) return answer(200, own);   // a test's own answer (10-26)
        return answer(200, { meta: { item_id: body.id, question: body.question ?? null, user_note: body.user_note ?? '' } });
    };
    const U = await import('../ui/benchmarks/util.js');
    U.recordListeners(window);
    const { createQueueView } = await import('../ui/benchmarks/queue.js');
    const root = document.getElementById('cb-view-queue');
    const view = createQueueView(root);
    await view.refresh(true);
    const restore = () => { for (const k of Object.keys(had)) { if (had[k] === undefined) delete globalThis[k]; else globalThis[k] = had[k]; } };
    const note = (id) => root.querySelector(`[data-meta-host="${id}"] textarea`);
    const type = (id, text) => { const ta = note(id); ta.value = text; ta.dispatchEvent(new window.Event('input')); return ta; };
    const blur = async (ta) => { ta.dispatchEvent(new window.Event('blur')); for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
    return { window, document, root, view, server, restore, note, type, blur };
}

test('queue view: every pending / running item shows its estimate, clock, question and a note box; the lane header its total; history is as it was', async (t) => {
    const { root, server, view, restore } = await setup(); t.after(restore);
    assert.equal(root.querySelectorAll('[data-meta-host] textarea').length, 3);
    assert.equal(root.querySelector('[data-key="qv-history"] textarea'), null);
    const row = root.querySelector('[data-item="2"]');
    assert.match(row.querySelector('.qv-est').textContent, /~6 h · starts ~\w{3} \d\d:\d\d · done ~\w{3} \d\d:\d\d/);
    assert.equal(row.querySelector('.qv-rough'), null);
    assert.equal(row.querySelector('.qv-q').textContent.replace('✎', '').trim(), 'Question 2?');
    assert.match(root.querySelector('[data-running="1"] .qv-est').textContent, /~6 h left · done ~/);
    assert.match(root.querySelector('[data-lane="local-gpu"]').textContent, /~18 h queued · done ~\w{3} \d\d:\d\d/);
    // mostly fallback -> "rough"; no estimate -> said so, and what follows is "no earlier than"; held -> no clock
    server.queue = queue({ pending: [
        item(2, { est: { ...item(2).est, measured_tasks: 0, config_tasks: 2, measured_hours: 0, fallback_hours: 6, rough: true } }),
        item(3, { est: null, question: null, clock: { starts_at: '2026-10-08T07:00:00Z', done_at: null, after_unknown: false } }),
        item(4, { clock: { starts_at: '2026-10-08T07:00:00Z', done_at: '2026-10-08T13:00:00Z', after_unknown: true } }),
        item(5, { status: 'paused', clock: null })],
    lane_est: { 'local-gpu': { hours: 18, items: 3, unknown: 1, done_at: '2026-10-08T13:00:00Z' } } });
    await view.refresh(true);
    const est = (id) => root.querySelector(`[data-item="${id}"] .qv-est`).textContent;
    assert.match(est(2), /~6 h rough · starts ~/);
    assert.match(est(3), /^no estimate · starts ~\w{3} \d\d:\d\d$/);
    assert.match(est(4), /starts ≥ \w{3} \d\d:\d\d · done ≥ /);
    assert.match(est(5), /~6 h · held: not in the lane’s clock/);
    assert.match(root.querySelector('[data-item="3"] .qv-q').textContent, /no question recorded/);
    assert.match(root.querySelector('[data-lane="local-gpu"]').textContent, /~18 h queued \+ 1 with no estimate · done ≥ /);
});

test('queue view: an estimate reads as an estimate -- rounded hours, a quarter-hour clock, and what it was timed from in the tooltip', async (t) => {
    const { restore } = await setup(); t.after(restore);
    const { fmtEst, fmtWhen, estHtml } = await import('../ui/benchmarks/queue.js');
    assert.deepEqual([0.02, 0.5, 0.97, 2.46, 9.96, 42.3, null].map(fmtEst), ['under 5 min', '~30 min', '~1 h', '~2.5 h', '~10 h', '~42 h', '']);
    const now = Date.parse('2026-10-07T21:00:00Z');
    assert.match(fmtWhen('2026-10-08T05:07:00Z', now), /^\w{3} \d\d:(00|15|30|45)$/);
    assert.match(fmtWhen('2026-10-20T05:07:00Z', now), /^\w{3} 10-(19|20) \d\d:(00|15|30|45)$/);   // a week or more away: with the date
    const html = estHtml(item(2, { est: { ...item(2).est, hours: 1.3, measured_tasks: 1, config_tasks: 3, tasks: 4, rough: true, hand_hours: 6 } }), now);
    assert.match(html, /1 of 4 tasks timed from past runs of the same task on q4\.gguf at 128k context; 3 no local model has run, counted at its average over all tasks; each task capped at the item&#39;s 2h 00m 00s; the hand estimate recorded with the item: ~6 h/);
    // a task this config never ran, timed from the other local models' runs of it at this config's pace; thinking off named
    const scaled = estHtml(item(2, { est: { ...item(2).est, measured_tasks: 1, scaled_tasks: 2, config_tasks: 1, tasks: 4, speed_ratio: 0.2, rough: true, timed_from: 'm:q4.gguf|131072|nothink' } }), now);
    assert.match(scaled, /on q4\.gguf at 128k context, thinking off; 2 never run there, timed from other local models&#39; runs of the task × 0\.2 \(this config&#39;s pace against theirs\); 1 no local model has run, counted at its average over all tasks/);
    assert.match(scaled, /class="qv-rough">rough/);
    assert.match(estHtml(item(2, { est: { ...item(2).est, measured_tasks: 1, config_tasks: 1, timed_from: 'c:claude-x|low' } }), now), /on claude-x at effort low; 1 never run there, counted at its average/);
    assert.match(estHtml(item(2, { status: 'running', est: { ...item(2).est, hours: 0, overdue: true } }), now), /under 5 min<\/b> left.*the task in flight is past its usual time.*done ~/);
    assert.match(estHtml(item(2, { est: { ...item(2).est, basis: 'guess', rough: true, timed_from: null } }), now), /no past runs to time this from: this is the hand estimate recorded with the item/);
});

test('queue view: a note being typed survives the redraws -- same element, same unsaved text -- while the rest of the row is rebuilt', async (t) => {
    const { root, server, view, restore, note, type } = await setup(); t.after(restore);
    const ta = type(2, 'half a thou');
    const other = note(3); const row = root.querySelector('[data-item="2"]'); const button = row.querySelector('[data-move="up"]');
    // the server answers with different data (a new note on #3 from elsewhere, another estimate): a full redraw
    server.queue = queue({ pending: [item(2, { est: { ...item(2).est, hours: 5 } }), item(3, { user_note: 'typed on the phone' })] });
    await view.refresh();
    assert.equal(note(2), ta, 'the box being typed in is the same element');
    assert.equal(ta.value, 'half a thou', 'and still holds the unsaved draft, not the server\'s empty note');
    assert.equal(root.querySelector('[data-item="2"]'), row, 'its row persists (it holds the box)');
    assert.notEqual(row.querySelector('[data-move="up"]'), button, 'while an ordinary button in it is a fresh node');
    assert.match(row.querySelector('.qv-est').textContent, /~5 h/);
    assert.equal(note(3), other); assert.equal(other.value, 'typed on the phone', 'a box nobody is typing in takes the server\'s note');
    assert.equal(server.posts.length, 0, 'nothing is saved by a redraw');
    for (let i = 0; i < 3; i++) await view.refresh(true);
    assert.equal(note(2), ta); assert.equal(ta.value, 'half a thou');
    assert.equal(root.querySelectorAll('[data-meta-host="2"] textarea').length, 1, 'the box is never duplicated');
    ta.dispatchEvent(new (root.ownerDocument.defaultView.Event)('blur'));   // flush: no timer left behind
});

test('queue view: a poll that only moves the clocks does not redraw; a changed note or question does', async (t) => {
    const { root, server, view, restore } = await setup(); t.after(restore);
    const line = root.querySelector('[data-item="2"] .qv-est');
    server.queue = queue({ pending: [item(2, { est: { ...item(2).est, hours: 5.9 }, clock: { starts_at: '2026-10-08T01:00:05Z', done_at: '2026-10-08T06:54:05Z', after_unknown: false } }), item(3)], now: '2026-10-07T21:00:05Z' });
    await view.refresh();
    assert.equal(root.querySelector('[data-item="2"] .qv-est'), line, 'same node: not redrawn');
    server.queue = queue({ pending: [item(2, { question: 'A better question?' }), item(3)] });
    await view.refresh();
    assert.notEqual(root.querySelector('[data-item="2"] .qv-est'), line);
    assert.match(root.querySelector('[data-item="2"] .qv-q').textContent, /A better question\?/);
});

test('queue view: the box follows its item when the row moves (reorder; pending -> running) and never lands on another item', async (t) => {
    const { root, server, view, restore, note, type } = await setup(); t.after(restore);
    const ta2 = type(2, 'draft for two'); const ta3 = note(3);
    server.queue = queue({ pending: [item(3), item(2)] });
    await view.refresh();
    assert.deepEqual(Array.from(root.querySelectorAll('.qv-row[data-item]')).map((r) => r.dataset.item), ['3', '2']);
    assert.equal(note(2), ta2); assert.equal(ta2.value, 'draft for two');
    assert.equal(note(3), ta3); assert.equal(ta3.value, '');
    // #1 finishes, #2 starts running: its box moves into the running card with the draft
    server.queue = queue({ running: [item(2, { status: 'running', started_at: '2026-10-07T21:00:00Z' })], pending: [item(3)] });
    await view.refresh();
    assert.equal(root.querySelector('[data-running="2"] textarea'), ta2); assert.equal(ta2.value, 'draft for two');
    assert.equal(root.querySelectorAll('textarea').length, 2);
    ta2.dispatchEvent(new (root.ownerDocument.defaultView.Event)('blur'));
});

test('queue view: the note saves on blur through /api/queue/item/meta and says so; a failed save keeps the text and says that', async (t) => {
    const { root, server, view, restore, type, blur, note } = await setup(); t.after(restore);
    const status = (id) => root.querySelector(`[data-meta-host="${id}"] [data-qm-st]`);
    const ta = type(2, 'check the 3 h cap');
    assert.match(status(2).textContent, /saves when you pause/);
    await blur(ta);
    assert.deepEqual(server.posts, [['/api/queue/item/meta', { id: 2, user_note: 'check the 3 h cap' }]]);
    assert.match(status(2).textContent, /^saved /);
    await blur(ta);
    assert.equal(server.posts.length, 1, 'nothing to save: no second request');
    // the server refuses: the draft stays, the status says it was not saved, the next blur tries again
    server.fail = 'user_note is too long';
    type(2, 'check the 3 h cap, twice');
    await blur(ta);
    assert.match(status(2).textContent, /NOT saved: user_note is too long/);
    server.queue = queue();   // the server still has the old (empty) note
    await view.refresh(true);
    assert.equal(note(2), ta); assert.equal(ta.value, 'check the 3 h cap, twice', 'an unsaved note is never overwritten by a redraw');
    server.fail = null;
    await blur(ta);
    assert.deepEqual(server.posts[server.posts.length - 1], ['/api/queue/item/meta', { id: 2, user_note: 'check the 3 h cap, twice' }]);
    assert.match(status(2).textContent, /^saved /);
    // an item that leaves the queue with a draft in its box: the draft is sent before the box goes
    type(3, 'last words');
    server.queue = queue({ pending: [item(2, { user_note: 'check the 3 h cap, twice' })] });
    await view.refresh();
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
    assert.deepEqual(server.posts[server.posts.length - 1], ['/api/queue/item/meta', { id: 3, user_note: 'last words' }]);
    assert.equal(root.querySelector('[data-meta-host="3"]'), null);
});

// ---- lanes and this machine's cards (2026-10-12): /api/queue lanes[].card and .parked, lib/queue.js laneCardInfo ----
test('queue view: lanes show their cards; parked lanes fold away below the ones in use', async (t) => {
    const { root, server, view, restore } = await setup(); t.after(restore);
    const lane = (name, o = {}) => ({ lane: name, paused: 0, alive: true, runner_state: 'idle', ...o });
    server.queue = queue({
        laneNames: ['local-gpu', 'cloud', 'laptop-4090', 'local-3060', 'local-rocm1'],
        lanes: [lane('local-gpu', { runner_state: 'running', card: { label: '2x RX 7900 XTX', here: true, remote: false }, parked: false }),
            lane('cloud', { card: { label: null, here: null, remote: false }, parked: false }),
            lane('laptop-4090', { card: { label: 'RTX 4090 Laptop', here: false, remote: true }, parked: false }),
            lane('local-3060', { paused: 1, alive: false, runner_state: 'stopped', note: 'no such card here', card: { label: null, here: null, remote: false }, parked: true }),
            lane('local-rocm1', { paused: 1, card: { label: 'RX 7900 XTX #2', here: true, remote: false }, parked: false })],
        machine: '2x RX 7900 XTX 24G | 63G RAM',
    });
    await view.refresh(true);
    const order = [...root.querySelectorAll('[data-lane]')].map((el) => el.getAttribute('data-lane'));
    assert.deepEqual(order, ['local-gpu', 'cloud', 'laptop-4090', 'local-rocm1', 'local-3060'], 'the parked lane is last, whatever the server order');
    const fold = root.querySelector('[data-qv-parked]');
    assert.ok(fold && !fold.hasAttribute('open'), 'folded by default');
    assert.ok(fold.querySelector('[data-lane="local-3060"]'), 'and still there, with its controls');
    assert.match(fold.querySelector('summary').textContent, /1 parked lane .*local-3060.*2x RX 7900 XTX 24G/);
    assert.equal(root.querySelector('[data-lane="local-gpu"]').parentNode === fold.querySelector('div'), false);
    // card names come from the server's lane rows, never from the lane's name
    assert.match(root.querySelector('[data-lane="local-gpu"]').textContent, /local-gpu\s+2x RX 7900 XTX/);
    assert.match(root.querySelector('[data-lane="local-rocm1"]').textContent, /RX 7900 XTX #2/);
    assert.match(root.querySelector('[data-lane="laptop-4090"]').textContent, /RTX 4090 Laptop \(remote\)/);
    assert.doesNotMatch(root.querySelector('[data-lane="local-3060"]').textContent, /RTX|3060 \(/);
    // items waiting on a parked lane stay folded with it, counted in the one line that is shown
    server.queue = { ...server.queue, pending: [...server.queue.pending, item(77, { lane: 'local-3060', label: 'waits-for-a-card' })] };
    await view.refresh(true);
    assert.match(root.querySelector('[data-qv-parked] summary').textContent, /local-3060 \(1 waiting\)/);
    assert.ok(root.querySelector('[data-qv-parked] [data-lane="local-3060"] [data-item="77"]'));
    // something RUNNING on it brings it back among the others
    server.queue = { ...server.queue, running: [...server.queue.running, item(78, { lane: 'local-3060', status: 'running', label: 'runs-anyway' })] };
    await view.refresh(true);
    assert.equal(root.querySelector('[data-qv-parked]'), null);
    assert.ok(root.querySelector('[data-lane="local-3060"]'));
});

test('queue view: an older server (no card, no parked) lists every lane as before', async (t) => {
    const { root, server, view, restore } = await setup(); t.after(restore);
    server.queue = queue({ laneNames: ['local-gpu', 'cloud', 'local-3060'], lanes: [{ lane: 'local-gpu', paused: 0, alive: true, runner_state: 'running' },
        { lane: 'cloud', paused: 0, alive: true }, { lane: 'local-3060', paused: 1, alive: false, runner_state: 'stopped' }] });
    await view.refresh(true);
    assert.deepEqual([...root.querySelectorAll('[data-lane]')].map((el) => el.getAttribute('data-lane')), ['local-gpu', 'cloud', 'local-3060']);
    assert.equal(root.querySelector('[data-qv-parked]'), null);
});

// ---- 2026-10-26: lanes are accordions, closed when the page opens; an open lane scrolls in a box of its own; a paused
// lane says who paused it, when and why, with a Resume button in its header; "again" queues at the top of the lane ----
const click = (el) => el.dispatchEvent(new (el.ownerDocument.defaultView.Event)('click', { bubbles: true, cancelable: true }));
const settle = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r)); };
const lanesQueue = (o = {}) => queue({
    laneNames: ['local-gpu', 'cloud', 'laptop-3060'],
    lanes: [{ lane: 'local-gpu', paused: 0, alive: true, runner_state: 'running', runner_detail: 'item 1: leg-1' },
        { lane: 'cloud', paused: 0, alive: true, runner_state: 'idle' },
        { lane: 'laptop-3060', paused: 1, alive: true, runner_state: 'paused', runner_detail: 'lane paused', paused_by: 'card-handoff', paused_at: '2026-10-07T20:30:00Z',
            note: 'PAUSED by card-handoff: the 3060 eGPU keeps locking up under two-card llama-server (Xid 119); needs Kyle' }],
    pending: [item(2), item(3), item(4, { status: 'paused', clock: null }), item(5, { lane: 'laptop-3060', label: 'eg-wait' })], ...o });

test('queue view (10-26): every lane opens closed, its header reading at a glance -- state, the running item and how far it got, pending and held counts, hours', async (t) => {
    const { root, server, view, restore } = await setup(); t.after(restore);
    server.queue = lanesQueue(); await view.refresh(true);
    for (const lane of ['local-gpu', 'cloud', 'laptop-3060']) {
        const card = root.querySelector(`[data-lane="${lane}"]`);
        assert.ok(card.querySelector(`[data-lane-body="${lane}"]`).hasAttribute('hidden'), `${lane} is closed`);
        assert.equal(card.querySelector('[data-lane-toggle]').getAttribute('aria-expanded'), 'false');
    }
    const head = (lane) => root.querySelector(`[data-lane="${lane}"] [data-lane-toggle]`).textContent.replace(/\s+/g, ' ');
    assert.match(head('local-gpu'), /local-gpu running 2 pending · 1 held ~18 h queued · done ~/);
    assert.match(head('local-gpu'), /▶ #1 leg-1\s*0\/2 tasks done · ~6 h left/, 'the running item and its progress (est.tasks = what is left)');
    assert.match(head('cloud'), /cloud idle nothing waiting/);
    assert.match(head('laptop-3060'), /laptop-3060 paused 1 pending/);
    // everything is still in the page, closed: the note boxes live in the bodies
    assert.equal(root.querySelectorAll('[data-meta-host] textarea').length, 5);
    // progress counts what the battery scored: one of two done, the rest timed
    server.queue = lanesQueue({ running: [item(1, { status: 'running', started_at: '2026-10-07T20:00:00Z', resolved_tasks: ['a', 'b'], est: { ...item(1).est, tasks: 1, hours: 0.5 } })] });
    await view.refresh(true);
    assert.match(head('local-gpu'), /1\/2 tasks done · ~30 min left/);
    // a lane with nothing running whose runner is waiting says why, on the second line
    server.queue = lanesQueue({ running: [], lanes: [{ lane: 'local-gpu', paused: 0, alive: true, runner_state: 'waiting-gpu', runner_detail: 'ROCm1 in use by item 7 (local-rocm1: x)' }, ...lanesQueue().lanes.slice(1)] });
    await view.refresh(true);
    assert.match(head('local-gpu'), /waiting-gpu .*ROCm1 in use by item 7/);
});

test('queue view (10-26): the header opens a lane into a scroll box of its own; it stays open through redraws (an empty lane too) and a new page opens closed', async (t) => {
    const { root, server, view, restore, note, type, window } = await setup(); t.after(restore);
    server.queue = lanesQueue(); await view.refresh(true);
    const body = root.querySelector('[data-lane-body="local-gpu"]'); const ta = type(2, 'draft while closed');
    click(root.querySelector('[data-lane-toggle="local-gpu"]'));
    assert.equal(body.hasAttribute('hidden'), false); assert.equal(root.querySelector('[data-lane-toggle="local-gpu"]').getAttribute('aria-expanded'), 'true');
    assert.ok(root.querySelector('[data-lane="local-gpu"]').classList.contains('qv-lane-open'));
    assert.match(body.className, /\bqv-scroll\b/); assert.match(body.className, /overflow-y-auto/, 'setHtml must see it as a scroller (same node, scroll kept)');
    assert.ok(body.querySelector('[data-running="1"]') && body.querySelector('[data-item="2"]') && body.querySelector('[data-item="4"]'), 'the running card and the waiting rows are in the box');
    assert.equal(server.posts.length, 0, 'opening a lane asks nothing of the server');
    // redraws: same box, still open, the draft still there; the closed lanes stay closed
    server.queue = lanesQueue({ pending: [item(3), item(2), item(4, { status: 'paused', clock: null }), item(5, { lane: 'laptop-3060', label: 'eg-wait' })] });
    await view.refresh(true); await view.refresh(true);
    assert.equal(root.querySelector('[data-lane-body="local-gpu"]'), body); assert.equal(body.hasAttribute('hidden'), false);
    assert.equal(note(2), ta); assert.equal(ta.value, 'draft while closed');
    assert.ok(root.querySelector('[data-lane-body="cloud"]').hasAttribute('hidden'));
    // the empty lane: opened, then redrawn with other data, still open
    click(root.querySelector('[data-lane-toggle="cloud"]'));
    server.queue = lanesQueue({ history: [] }); await view.refresh(true);
    assert.equal(root.querySelector('[data-lane-body="cloud"]').hasAttribute('hidden'), false);
    assert.match(root.querySelector('[data-lane-body="cloud"]').textContent, /nothing pending/);
    // and closed again
    click(root.querySelector('[data-lane-toggle="local-gpu"]'));
    assert.ok(root.querySelector('[data-lane-body="local-gpu"]').hasAttribute('hidden'));
    await view.refresh(true);
    assert.ok(root.querySelector('[data-lane-body="local-gpu"]').hasAttribute('hidden'));
    // a page opened afresh (a new view): every lane closed, whatever was open in another
    const { createQueueView } = await import('../ui/benchmarks/queue.js');
    const root2 = root.ownerDocument.createElement('div'); root2.id = 'cb-view-queue-2'; root.ownerDocument.body.appendChild(root2);
    const v2 = createQueueView(root2); await v2.refresh(true);
    assert.ok([...root2.querySelectorAll('[data-lane-body]')].every((b) => b.hasAttribute('hidden')));
    ta.dispatchEvent(new window.Event('blur'));
});

test('queue view (10-26): drag-reordering works inside the scroll box', async (t) => {
    const { root, server, view, restore, window } = await setup(); t.after(restore);
    server.queue = lanesQueue(); await view.refresh(true);
    click(root.querySelector('[data-lane-toggle="local-gpu"]'));
    const row = (id) => root.querySelector(`[data-lane-body="local-gpu"] [data-item="${id}"]`);
    row(4).dispatchEvent(new window.Event('dragstart'));
    const over = new window.Event('dragover', { cancelable: true }); row(2).dispatchEvent(over);
    assert.equal(over.defaultPrevented, true, 'a row of the same lane accepts the drop');
    row(2).dispatchEvent(new window.Event('drop', { cancelable: true }));
    await settle();
    assert.deepEqual(server.posts[0], ['/api/queue/reorder', { lane: 'local-gpu', ids: [4, 2, 3] }]);
});

test('queue view (10-26): a paused lane says who paused it, when and why; "Resume lane" sits in its header and resumes it after the confirm; pause is one click and clears the note', async (t) => {
    const { root, server, view, restore, window } = await setup(); t.after(restore);
    server.queue = lanesQueue(); await view.refresh(true);
    const card = root.querySelector('[data-lane="laptop-3060"]');
    const banner = card.querySelector('[data-lane-paused]');
    assert.ok(banner, 'shown with the lane closed');
    assert.equal(card.querySelector('[data-lane-body]').contains(banner), false);
    assert.match(banner.textContent.replace(/\s+/g, ' '), /Paused by card-handoff · 10-0[78] \d\d:\d\d \(.* ago\) PAUSED by card-handoff: the 3060 eGPU keeps locking up .*needs Kyle/);
    const resume = card.querySelector('[data-lane-resume="laptop-3060"]');
    assert.ok(resume && /Resume lane/.test(resume.textContent));
    assert.equal(card.querySelector('[data-lane-toggle]').contains(resume), false, 'not inside the toggle: a click resumes, it does not open the lane');
    assert.equal(card.querySelector('[data-lane-pause]'), null);
    assert.equal(root.querySelectorAll('[data-lane-resume]').length, 1, 'only the paused lane offers it');
    // the confirm repeats who paused it and why; "cancel" sends nothing
    const asked = []; let yes = false; window.confirm = (m) => { asked.push(m); return yes; };
    click(resume); await settle();
    assert.equal(server.posts.length, 0); assert.match(asked[0], /^Resume lane laptop-3060\?[\s\S]*Paused by card-handoff 10-0[78] \d\d:\d\d: PAUSED by card-handoff: the 3060 eGPU/);
    yes = true; click(root.querySelector('[data-lane-resume="laptop-3060"]')); await settle();
    assert.deepEqual(server.posts, [['/api/queue/lane', { lane: 'laptop-3060', paused: false }]]);
    // pause: no confirm, an empty note (the API keeps the old one otherwise, and the header shows it as the reason)
    asked.length = 0;
    click(root.querySelector('[data-lane-pause="local-gpu"]')); await settle();
    assert.deepEqual(server.posts[1], ['/api/queue/lane', { lane: 'local-gpu', paused: true, note: '' }]);
    assert.equal(asked.length, 0);
    // a paused lane whose runner is down says resuming alone starts nothing; one without a note says so
    server.queue = lanesQueue({ lanes: [...lanesQueue().lanes.slice(0, 2), { lane: 'laptop-3060', paused: 1, alive: false, paused_by: 'dashboard', paused_at: '2026-10-07T20:30:00Z', note: null }] });
    await view.refresh(true);
    assert.match(root.querySelector('[data-lane="laptop-3060"] [data-lane-paused]').textContent, /Paused by dashboard[\s\S]*its runner is not running[\s\S]*no note/);
});

test('queue view (10-26): "again" on a finished item asks for the top of its lane and says where the copy went; "dup" on a waiting one still copies right after it', async (t) => {
    const { root, server, view, restore } = await setup(); t.after(restore);
    server.reply = (url, body) => (url === '/api/queue/item/duplicate' ? { item: { id: 41, lane: 'local-gpu', label: 'old-r2', status: 'pending' } } : null);
    const again = root.querySelector('[data-key="qv-history"] [data-again="9"]');
    assert.match(again.getAttribute('title'), /TOP of local-gpu/);
    click(again); await settle();
    assert.deepEqual(server.posts[0], ['/api/queue/item/duplicate', { id: 9, position: 'top' }]);
    assert.match(root.querySelector('[data-qv-status]').textContent, /#41 queued at the top of local-gpu/);
    click(root.querySelector('[data-item="2"] [data-dup="2"]')); await settle();
    assert.deepEqual(server.posts[1], ['/api/queue/item/duplicate', { id: 2 }]);
    // history is a box of its own scroll too, open by default ("again" lives there)
    const hist = root.querySelector('[data-key="qv-history"]');
    assert.ok(hist.hasAttribute('open')); assert.match(hist.querySelector('[data-key="qv-history-box"]').className, /qv-scroll.*overflow-y-auto/);
});
