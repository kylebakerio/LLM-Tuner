'use strict';
// When a `--list-devices` probe may run and what is served when it may not (lib/deviceprobe.js, 2026-10-13).
// No binary is ever run here: `probe` is a counter that answers from a table.
const test = require('node:test');
const assert = require('node:assert');
const { createDeviceCache, busyReason, ageText } = require('../lib/deviceprobe');

const XTX = 'AMD Radeon RX 7900 XTX';
const dev = (id, description = XTX, totalMib = 24560) => ({ id, description, totalMib, freeMib: totalMib - 500 });
const ALL = [dev('ROCm0'), dev('ROCm1'), dev('Vulkan0'), dev('Vulkan1')];
const ROCM = [dev('ROCm0'), dev('ROCm1')];

function rig({ answers = { '/all': ALL, '/rocm': ROCM } } = {}) {
    const st = { calls: [], busy: null, t: 1000000, answers: { ...answers } };
    const cache = createDeviceCache({
        probe: async (bin) => { st.calls.push(bin); const a = st.answers[bin]; if (a instanceof Error) throw a; if (!a) throw new Error('no such binary'); return a; },
        busy: () => st.busy, now: () => st.t,
    });
    return { st, cache };
}
const timeout = () => Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' });

test('busyReason: what counts as something on a local card', () => {
    assert.strictEqual(busyReason({}), null);
    assert.match(busyReason({ ownServer: true }), /launched from this dashboard/);
    assert.match(busyReason({ pending: true }), /launch is in progress/);
    assert.match(busyReason({ runningItems: [{ id: 942, lane: 'local-gpu' }] }), /queue item 942 is running on lane local-gpu/);
    assert.match(busyReason({ runningItems: [{ id: 942, lane: 'local-gpu' }, { id: 904, lane: 'local-rocm1' }] }), /queue item 942, 904 is running on local lanes/);
    // another machine's lane and the cloud lane hold none of this machine's cards
    assert.strictEqual(busyReason({ runningItems: [{ id: 935, lane: 'laptop-4090' }, { id: 7, lane: 'cloud' }] }), null);
    assert.match(busyReason({ external: { port: 8080 } }), /another server is running on port 8080/);
    // work nothing here started: seen only in the readings. A desktop session's few hundred MiB is not work.
    assert.strictEqual(busyReason({ gpus: [{ label: 'RX 7900 XTX #1', vram_used: 800, gpu_util: 4 }, { label: 'RX 7900 XTX #2', vram_used: 20, gpu_util: 0 }] }), null);
    assert.strictEqual(busyReason({ gpus: [{ label: 'RX 7900 XTX #2', vram_used: 21500, gpu_util: 0 }] }), 'RX 7900 XTX #2 holds 21.0 GB');
    assert.strictEqual(busyReason({ gpus: [{ name: 'RTX 4090', vram_used: 500, gpu_util: 97 }] }), 'RTX 4090 is at 97%');
    assert.strictEqual(busyReason({ gpus: [{ label: 'x', error: true, vram_used: 99999 }] }), null, 'a reading that failed says nothing');
});

test('a probe runs at boot, on refresh, and when the cards are free -- and not otherwise', async () => {
    const { st, cache } = rig();
    st.busy = 'queue item 942 is running on lane local-gpu';
    const boot = await cache.request('/all', { boot: true });
    assert.deepStrictEqual([boot.probed, boot.cached, boot.devices.length, boot.note, boot.error], [true, false, 4, null, null]);
    st.t += 45 * 60 * 1000;
    // busy: the cache, with its age and why
    const busy = await cache.request('/all');
    assert.deepStrictEqual([busy.probed, busy.cached, busy.ageMs, busy.devices.length], [false, true, 45 * 60 * 1000, 4]);
    assert.strictEqual(busy.note, 'not re-probed (queue item 942 is running on lane local-gpu); device list from 45 min ago');
    assert.strictEqual(st.calls.length, 1);
    // explicit refresh: probes even then
    const forced = await cache.request('/all', { refresh: true });
    assert.deepStrictEqual([forced.probed, forced.cached, forced.ageMs], [true, false, 0]);
    assert.strictEqual(st.calls.length, 2);
    // free: every call probes, as before
    st.busy = null;
    await cache.request('/all'); await cache.request('/all');
    assert.strictEqual(st.calls.length, 4);
});

test('a failed or timed-out probe never replaces or hides a good listing', async () => {
    const { st, cache } = rig();
    await cache.request('/all', { boot: true });
    st.t += 60000;
    st.answers['/all'] = timeout();
    const r = await cache.request('/all', { refresh: true });
    assert.deepStrictEqual([r.devices.map((d) => d.id), r.cached, r.probed, r.error, r.cachedAt], [['ROCm0', 'ROCm1', 'Vulkan0', 'Vulkan1'], true, true, 'timed out', 1000000]);
    assert.strictEqual(r.note, "the probe timed out; showing this build's device list from 60 s ago");
    assert.strictEqual(cache.get('/all').length, 4, 'the cache still holds the good listing');
    assert.deepStrictEqual([cache.info('/all').error, cache.info('/all').at], ['timed out', 1000000]);
    // the next good probe clears the error
    st.answers['/all'] = ALL;
    const ok = await cache.request('/all');
    assert.deepStrictEqual([ok.cached, ok.error, cache.info('/all').error], [false, null, null]);
});

test('no listing of its own: the fullest listing of another build, marked borrowed; none anywhere: empty with the reason', async () => {
    const { st, cache } = rig({ answers: { '/all': ALL, '/rocm': ROCM, '/moecache': timeout() } });
    // nothing cached at all
    const none = await cache.request('/moecache', { boot: true });
    assert.deepStrictEqual([none.devices, none.cached, none.borrowed, none.error], [[], false, false, 'timed out']);
    await cache.request('/rocm', { boot: true }); await cache.request('/all', { boot: true });
    // its probe times out: the fullest other listing, said to be another build's
    const r = await cache.request('/moecache', { refresh: true });
    assert.deepStrictEqual([r.devices.length, r.cached, r.borrowed, r.from, r.error], [4, true, true, '/all', 'timed out']);
    assert.match(r.note, /^the probe timed out; this build has no device list of its own yet, so the cards are shown as another build lists them/);
    assert.strictEqual(cache.get('/moecache'), null, 'a borrowed listing is never stored as this build\'s own');
    // busy and never probed: same, without running anything
    st.busy = 'RX 7900 XTX #1 holds 21.0 GB';
    const n = st.calls.length;
    const b = await cache.request('/never-seen');
    assert.deepStrictEqual([b.probed, b.borrowed, b.from, b.devices.length, st.calls.length], [false, true, '/all', 4, n]);
    assert.match(b.note, /^not probed \(RX 7900 XTX #1 holds 21\.0 GB\)/);
    // busy, never probed, nothing to borrow
    const lone = rig(); lone.st.busy = 'a launch is in progress';
    const e = await lone.cache.request('/all');
    assert.deepStrictEqual([e.devices, e.probed, e.cached, e.error, lone.st.calls.length], [[], false, false, 'not probed: a launch is in progress', 0]);
});

test('touch: a reader that meets an unknown binary probes it only when the rule allows, once, and backs off after a failure', async () => {
    const { st, cache } = rig({ answers: { '/all': ALL, '/bad': timeout() } });
    st.busy = 'a model launched from this dashboard is loaded';
    assert.strictEqual(cache.touch('/all'), false);
    assert.strictEqual(st.calls.length, 0, 'every telemetry tick used to start a probe here');
    st.busy = null;
    assert.strictEqual(cache.touch('/all'), true);
    assert.strictEqual(cache.touch('/all'), false, 'already in flight');
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(cache.get('/all').length, 4);
    assert.strictEqual(cache.touch('/all'), false, 'known: nothing to do');
    assert.strictEqual(st.calls.length, 1);
    // a binary whose probe fails is not hammered
    assert.strictEqual(cache.touch('/bad'), true);
    await new Promise((r) => setImmediate(r));
    assert.strictEqual(cache.touch('/bad'), false);
    st.t += 6 * 60 * 1000;
    assert.strictEqual(cache.touch('/bad'), true);
    assert.strictEqual(cache.touch(null), false);
});

test('concurrent requests share one probe; fullest() and listings() read only good listings', async () => {
    const { st, cache } = rig();
    const [a, b] = await Promise.all([cache.request('/all', { boot: true }), cache.request('/all', { boot: true })]);
    assert.deepStrictEqual([a.devices.length, b.devices.length, st.calls.length], [4, 4, 1]);
    await cache.request('/rocm', { boot: true });
    assert.strictEqual(cache.fullest().length, 4);
    assert.strictEqual(cache.listings().length, 2);
    assert.deepStrictEqual([ageText(40000), ageText(12 * 60000), ageText(3 * 3600000)], ['40 s', '12 min', '3 h']);
});

test('snapshot / seed: listings kept across a restart are served with their real age, and never trusted blindly', async () => {
    const saved = [];
    const st = { busy: null, t: 5000000 };
    const first = createDeviceCache({ probe: async (b) => (b === '/all' ? ALL : ROCM), busy: () => st.busy, now: () => st.t, onChange: (snap) => saved.push(JSON.parse(JSON.stringify(snap))) });
    await first.request('/all', { boot: true }); st.t += 1000; await first.request('/rocm', { boot: true });
    assert.deepStrictEqual(Object.keys(saved[saved.length - 1]), ['/all', '/rocm']);
    assert.deepStrictEqual([saved[1]['/all'].at, saved[1]['/rocm'].at, saved[1]['/all'].devices.length], [5000000, 5001000, 4]);
    // the next process: seeded, something on the cards, nothing is run
    const calls = [];
    const now = 5000000 + 3 * 3600000;
    const next = createDeviceCache({ probe: async (b) => { calls.push(b); return ALL; }, busy: () => 'queue item 942 is running on lane local-gpu', now: () => now });
    assert.strictEqual(next.seed({ ...saved[1], '/junk': { at: 1, devices: [{ nope: 1 }] }, '/alsojunk': 'x', '/noat': { devices: [] } }), 2);
    const r = await next.request('/all');
    assert.deepStrictEqual([r.devices.length, r.cached, r.probed, r.cachedAt, calls.length], [4, true, false, 5000000, 0]);
    assert.match(r.note, /device list from 3 h ago$/);
    assert.strictEqual(next.get('/junk'), null);
    // a listing this process already has is not replaced by an older kept one
    assert.strictEqual(first.seed({ '/all': { at: 1, devices: [] } }), 0);
    assert.strictEqual(first.get('/all').length, 4);
});
