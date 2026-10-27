'use strict';
// What a dashboard restart / "probe now" may do while the queue has work on this machine's cards (lib/gpusafety.js,
// lib/deviceprobe.js hardBusy; 2026-10-17). Nothing here runs a binary or kills a process.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const g = require('../lib/gpusafety');
const { createDeviceCache } = require('../lib/deviceprobe');

// The process table of 2026-10-17 01:30, trimmed: the local-gpu lane serving Strata 0.1.44.1 on 18080 behind the
// agent proxy on 127.0.0.1:8080, two idle local runners, the laptop lane, the dashboard and its monitor.py.
const P = (pid, ppid, cmd) => ({ pid, ppid, cmd });
const PROCS = [
    P(1468, 1, 'PM2 v7.0.3: God Daemon (/home/kyle/.pm2)'),
    P(227397, 1468, 'python3 /home/kyle/code/codebench/tools/queue_runner.py --lane local-rocm1'),
    P(227525, 1468, 'python3 /home/kyle/code/codebench/tools/queue_runner.py --lane local-xtx'),
    P(332738, 1468, 'python3 /home/kyle/code/codebench/tools/queue_runner.py --lane local-gpu'),
    P(3565284, 332738, '/home/kyle/AI/Strata/.venv/bin/python serve/server.py --engine strata --config /home/kyle/AI/Strata-0.1.44.1/x.json --port 18080'),
    P(3565398, 3565284, '/home/kyle/AI/Strata-0.1.44.1/engine/strata --serve --pack /p'),
    P(3567309, 332738, 'node /home/kyle/code/codebench/tools/record-proxy.js --listen 8080 --upstream 18080 --tap 18090'),
    P(3567335, 332738, 'flock /tmp/codebench-lldash.lock timeout 259200 python3 /home/kyle/code/codebench/harness/run.py --runner opencode'),
    P(476515, 1468, 'python3 /home/kyle/code/codebench/tools/queue_runner.py --lane laptop-4090'),
    P(2977351, 476515, 'node /home/kyle/code/codebench/tools/record-proxy.js --listen 18480 --upstream 18180'),
    P(2151007, 1468, 'node /home/kyle/AI/experiment-1/dashboard/server4.js'),
    P(2151039, 2151007, 'python3 monitor.py'),
];

test('localQueueWork: a local lane counts when its runner has processes under it; idle runners and other machines\' lanes do not', () => {
    const w = g.localQueueWork(PROCS);
    assert.deepStrictEqual(w.map((x) => x.lane), ['local-gpu']);
    assert.ok(w[0].pids.includes(3565398) && !w[0].pids.includes(332738), 'the engine counts, the runner itself does not');
    assert.deepStrictEqual(g.localQueueWork(PROCS.filter((p) => p.ppid !== 332738 && p.ppid !== 3565284)), []);
});

test('hardBusyReason: running local items, queue runners with work, the battery lock, an unreadable queue', () => {
    assert.strictEqual(g.hardBusyReason({}), null);
    assert.match(g.hardBusyReason({ runningItems: [{ id: 1076, lane: 'local-gpu' }] }), /queue item 1076 is running on lane local-gpu/);
    assert.strictEqual(g.hardBusyReason({ runningItems: [{ id: 1054, lane: 'laptop-4090' }, { id: 9, lane: 'cloud' }] }), null);
    assert.match(g.hardBusyReason({ queueWork: g.localQueueWork(PROCS) }), /the local-gpu queue runner has work running/);
    assert.match(g.hardBusyReason({ lockHeld: true }), /battery holds the model server/);
    assert.match(g.hardBusyReason({ queueUnread: true }), /could not be read/);
});

test('portCleanupTargets: the queue\'s proxy on 8080 is never killed; an orphaned model server is; monitor.py only on 8081', () => {
    // today: 8080 is the local-gpu lane's record proxy
    assert.deepStrictEqual(g.portCleanupTargets({ listenerPids: [3567309], procs: PROCS, allow: g.MODEL_SERVER, selfPid: 1 }).kill, []);
    // a llama-server the queue started (under the runner) on 8080: spared, with its runner named
    const queued = [...PROCS, P(4000, 332738, '/home/kyle/AI/llama-official/llama.cpp-moecache/build-all/bin/llama-server -m /m.gguf --port 8080')];
    const r = g.portCleanupTargets({ listenerPids: [4000], procs: queued, allow: g.MODEL_SERVER, selfPid: 1 });
    assert.deepStrictEqual(r.kill, []);
    assert.match(r.spare[0].why, /^under python3 \/home\/kyle\/code\/codebench\/tools\/queue_runner\.py \(pid 332738\)$/);
    // a battery's own server (under run.py, outside the queue): spared
    const battery = [P(5000, 1, 'flock /tmp/codebench-lldash.lock python3 /home/kyle/code/codebench/harness/run.py'), P(5001, 5000, '/x/build-all/bin/llama-server --port 8080')];
    assert.deepStrictEqual(g.portCleanupTargets({ listenerPids: [5001], procs: battery, allow: g.MODEL_SERVER, selfPid: 1 }).kill, []);
    // what an old dashboard left behind: killed
    const orphans = [P(6000, 1, '/x/build-all/bin/llama-server -m /m.gguf --port 8080'), P(6001, 1, '/home/kyle/AI/Strata-0.1.44.1/queue-serve.sh /c.json --port 8080'),
        P(6002, 1, '/venv/bin/python serve/server.py --engine strata --config /c.json --port 8080')];
    assert.deepStrictEqual(g.portCleanupTargets({ listenerPids: [6000, 6001, 6002], procs: orphans, allow: g.MODEL_SERVER, selfPid: 1 }).kill, [6000, 6001, 6002]);
    // something else on the port (a user's tool): left alone
    assert.deepStrictEqual(g.portCleanupTargets({ listenerPids: [7000], procs: [P(7000, 1, 'python3 -m http.server 8080')], allow: g.MODEL_SERVER, selfPid: 1 }).spare.map((x) => x.why), ['not a process this dashboard starts']);
    // 8081: the old monitor.py, yes; a model server, no; itself, never
    assert.deepStrictEqual(g.portCleanupTargets({ listenerPids: [2151039], procs: PROCS, allow: g.MONITOR, selfPid: 1 }).kill, [2151039]);
    assert.deepStrictEqual(g.portCleanupTargets({ listenerPids: [6000], procs: orphans, allow: g.MONITOR, selfPid: 1 }).kill, []);
    assert.deepStrictEqual(g.portCleanupTargets({ listenerPids: [42], procs: [P(42, 1, 'python3 monitor.py')], allow: g.MONITOR, selfPid: 42 }).kill, []);
});

test('cleanupPortSafely: kills only the planned pids', async () => {
    const killed = [];
    const plan = await g.cleanupPortSafely(8080, g.MODEL_SERVER, {
        listeners: async () => [3567309, 6000], procs: () => [...PROCS, P(6000, 1, '/x/llama-server --port 8080')], kill: (pid) => killed.push(pid), selfPid: 1,
    });
    assert.deepStrictEqual([killed, plan.spare.map((s) => s.pid)], [[6000], [3567309]]);
    const none = await g.cleanupPortSafely(8080, g.MODEL_SERVER, { listeners: async () => [], procs: () => { throw new Error('not read'); }, kill: () => killed.push('x') });
    assert.deepStrictEqual([none, killed.length], [{ kill: [], spare: [] }, 1]);
});

test('device cache: while the queue has work on the cards nothing probes -- not "probe now", not boot, not a reader', async () => {
    const st = { calls: 0, hard: 'queue item 1076 is running on lane local-gpu', soft: null };
    const cache = createDeviceCache({ probe: async () => { st.calls++; return [{ id: 'ROCm0', description: 'AMD Radeon RX 7900 XTX' }]; }, busy: () => st.soft, hardBusy: () => st.hard, now: () => 1e6 });
    const r = await cache.request('/all', { refresh: true });
    assert.deepStrictEqual([r.probed, r.refused, st.calls], [false, true, 0]);
    assert.match(r.error, /not probed: queue item 1076/);
    assert.strictEqual((await cache.request('/all', { boot: true })).refused, true);
    assert.strictEqual((await cache.request('/all')).refused, false, 'a plain read is served from the cache, not "refused"');
    assert.strictEqual(cache.touch('/all'), false);
    assert.strictEqual(st.calls, 0);
    // the queue lets go: "probe now" probes even with the soft rule saying busy; a plain read follows the soft rule
    st.hard = null; st.soft = 'a model launched from this dashboard is loaded';
    assert.strictEqual((await cache.request('/all')).probed, false);
    assert.strictEqual((await cache.request('/all', { refresh: true })).probed, true);
    assert.strictEqual(st.calls, 1);
});

test('server4.js: startup runs no device probe, no --help, and no fuser -k (source check)', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server4.js'), 'utf-8');
    // the code of initServer, comments taken out (they say what used to be here)
    const init = src.slice(src.indexOf('async function initServer()'), src.indexOf('initServer().catch')).split('\n').map((l) => l.replace(/^\s*\/\/.*$/, '')).join('\n');
    assert.ok(init.length > 1000, 'found initServer');
    assert.doesNotMatch(init, /deviceCache\.request\(|deviceCache\.touch\(|--help|--list-devices|probeDevices\(/);
    assert.doesNotMatch(src.split('\n').filter((l) => !/^\s*\/\//.test(l)).join('\n'), /fuser/, 'no fuser call anywhere (comments aside)');
    assert.match(init, /gpuSafety\.cleanupPortSafely\(port, allow\)/);
    // every other probe goes through the cache, which asks hardBusy first; /api/flags asks it too
    assert.match(src, /createDeviceCache\(\{[^}]*hardBusy: \(\) => queueHardBusy\(\)/);
    assert.match(src, /const flagsBusy = queueHardBusy\(\) \|\|/);
    assert.strictEqual((src.match(/\['--list-devices'\]/g) || []).length, 1, 'one --list-devices call site: probeDevices, run only by the cache');
    assert.strictEqual((src.match(/\['--help'\]/g) || []).length, 1, 'one --help call site: /api/flags, behind queueHardBusy');
});
