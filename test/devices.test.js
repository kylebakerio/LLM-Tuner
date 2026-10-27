'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../lib/devices');

// Endpoint the way server4.js computes it for link 'ssh' (no I/O needed).
const sshEndpoint = (w) => (w.link === 'ssh' ? `127.0.0.1:${w.localPort}` : `${w.ssh}:${w.port}`);

const WORKERS = { laptop: { binary: '~/llama-rpc/ggml-rpc-server-cuda', devices: 'CUDA0' } };

// What --list-devices reports on the desktop (CUDA+Vulkan build) as of 2026-09-13.
const DETECTED = [
    { id: 'CUDA0', description: 'NVIDIA GeForce RTX 3060', totalMib: 11906, freeMib: 10794 },
    { id: 'Vulkan0', description: 'NVIDIA GeForce RTX 3060', totalMib: 12288, freeMib: 10794 },
    { id: 'Vulkan1', description: 'AMD Radeon RX 7900 XTX (RADV NAVI31)', totalMib: 24560, freeMib: 24446 },
];

test('legacy GPU A + GPU B converts to a two-device list', () => {
    assert.deepEqual(D.legacyToDevices({ deviceA: 'CUDA0', deviceB: 'Vulkan2', tensorSplit: 40 }),
        [{ id: 'CUDA0', share: 40 }, { id: 'Vulkan2', share: 60 }]);
});

test('legacy RPC target becomes a worker device, and deviceA === deviceB is one device', () => {
    assert.deepEqual(D.legacyToDevices({ deviceA: 'Vulkan0', rpcTarget: 'laptop', tensorSplit: 60 }),
        [{ id: 'Vulkan0', share: 60 }, { worker: 'laptop', share: 40 }]);
    assert.deepEqual(D.legacyToDevices({ deviceA: 'Vulkan0', deviceB: 'Vulkan0', tensorSplit: 60 }), [{ id: 'Vulkan0' }]);
    assert.deepEqual(D.legacyToDevices({}), []);
});

test('an explicit devices list wins over legacy fields', () => {
    assert.deepEqual(D.configDevices({ devices: [{ id: 'Vulkan1' }], deviceA: 'CUDA0' }), [{ id: 'Vulkan1' }]);
});

test('sanitizeDevices drops bad entries and never accepts a bare RPC id', () => {
    assert.deepEqual(D.sanitizeDevices([{ id: 'RPC0' }, { id: 'CUDA0,Vulkan1' }, null, { id: 'CUDA0', share: -1, extra: 1 }, { worker: 'laptop', share: '30' }]),
        [{ id: 'CUDA0' }, { worker: 'laptop', share: 30 }]);
});

test('three devices across two local backends and a worker', () => {
    const plan = D.planDevices({ devices: [
        { id: 'Vulkan1', name: 'AMD Radeon RX 7900 XTX', share: 50 },
        { worker: 'laptop', share: 30 },
        { id: 'CUDA0', name: 'NVIDIA GeForce RTX 3060', share: 20 },
    ] }, WORKERS);
    assert.deepEqual(plan.devices.map((d) => d.id), ['Vulkan1', 'RPC0', 'CUDA0']);
    assert.deepEqual(D.deviceArgs(plan, sshEndpoint),
        ['--rpc', '127.0.0.1:50052', '--split-mode', 'layer', '-dev', 'Vulkan1,RPC0,CUDA0', '-ts', '50,30,20']);
    assert.equal(plan.workers[0].ssh, 'laptop');
    assert.equal(plan.workers[0].procName, 'ggml-rpc-server');
});

test('a single device pins -dev without a split, and missing shares omit -ts', () => {
    assert.deepEqual(D.deviceArgs(D.planDevices({ devices: [{ id: 'Vulkan1' }] }, {}), sshEndpoint), ['-dev', 'Vulkan1']);
    assert.deepEqual(D.deviceArgs(D.planDevices({ devices: [{ id: 'Vulkan1' }, { id: 'CUDA0', share: 1 }] }, {}), sshEndpoint),
        ['--split-mode', 'layer', '-dev', 'Vulkan1,CUDA0']);
    assert.deepEqual(D.deviceArgs(D.planDevices({ devices: [] }, {}), sshEndpoint), []);
});

test('disabled devices are left out', () => {
    const plan = D.planDevices({ devices: [{ id: 'Vulkan1', share: 1 }, { id: 'CUDA0', share: 1, enabled: false }] }, {});
    assert.deepEqual(D.deviceArgs(plan, sshEndpoint), ['-dev', 'Vulkan1']);
});

test('RPC ids follow each worker\'s device count', () => {
    const workers = { a: { devices: 'CUDA0,CUDA1', localPort: 50052 }, b: { localPort: 50053 } };
    const plan = D.planDevices({ devices: [{ worker: 'a' }, { worker: 'b' }, { worker: 'a', workerDevice: 1 }] }, workers);
    assert.deepEqual(plan.devices.map((d) => d.id), ['RPC0', 'RPC2', 'RPC1']);
    assert.deepEqual(D.deviceArgs(plan, sshEndpoint).slice(0, 2), ['--rpc', '127.0.0.1:50052,127.0.0.1:50053']);
});

test('plan errors: duplicates, unknown worker, clashing forward ports, missing worker device', () => {
    assert.throws(() => D.planDevices({ devices: [{ id: 'CUDA0' }, { id: 'CUDA0' }] }, {}), /listed twice/);
    assert.throws(() => D.planDevices({ devices: [{ worker: 'no such!' }] }, {}), /Unknown RPC worker/);
    assert.throws(() => D.planDevices({ devices: [{ worker: 'a' }, { worker: 'b' }] }, { a: {}, b: {} }), /both use localPort 50052/);
    assert.throws(() => D.planDevices({ devices: [{ worker: 'laptop', workerDevice: 1 }] }, WORKERS), /no device #1/);
});

test('an ad-hoc ssh target works as a worker and old rpcTarget matches a worker by its ssh', () => {
    const adhoc = D.planDevices({ deviceA: 'Vulkan1', rpcTarget: 'kyle-4090@192.168.1.125', tensorSplit: 60 }, {});
    assert.equal(adhoc.workers[0].ssh, 'kyle-4090@192.168.1.125');
    const bySsh = D.planDevices({ devices: [{ worker: 'kyle-4090@192.168.1.125' }] }, { laptop: { ssh: 'kyle-4090@192.168.1.125' } });
    assert.equal(bySsh.workers[0].name, 'laptop');
});

test('validateWorker rejects shell-unsafe settings', () => {
    assert.throws(() => D.validateWorker('w', { binary: '~/bin/x; rm -rf ~' }), /plain paths/);
    assert.throws(() => D.validateWorker('w', { devices: 'CUDA0 -H 0.0.0.0' }), /device list/);
    assert.throws(() => D.validateWorker('w', { ssh: '-oProxyCommand=evil' }), /ssh/);
    assert.throws(() => D.validateWorker('w', { localPort: 70000 }), /localPort/);
});

test('workersFromConfig reads rpcWorkers, or the old single rpcWorker block', () => {
    assert.deepEqual(Object.keys(D.workersFromConfig({ rpcWorkers: { laptop: {}, 'bad name!': {} } })), ['laptop']);
    const legacy = D.workersFromConfig({ rpcWorker: { ssh: 'kyle-4090@192.168.1.125', devices: 'Vulkan1' } });
    assert.equal(legacy.worker.ssh, 'kyle-4090@192.168.1.125');
    assert.equal(legacy.worker.port, 50052);
});

test('devicesToLegacy projects the first two local devices, the worker and A\'s share', () => {
    const plan = D.planDevices({ devices: [{ id: 'Vulkan1', share: 50 }, { worker: 'laptop', share: 30 }, { id: 'CUDA0', share: 20 }] }, WORKERS);
    assert.deepEqual(D.devicesToLegacy(plan), { deviceA: 'Vulkan1', deviceB: 'CUDA0', rpcTarget: 'laptop', tensorSplit: 50 });
    assert.deepEqual(D.devicesToLegacy(D.planDevices({ devices: [{ id: 'Vulkan1' }] }, {})),
        { deviceA: 'Vulkan1', deviceB: null, rpcTarget: null, tensorSplit: null });
});

test('devicesFromArgs reads back what a raw command runs, workers included', () => {
    const args = ['-m', 'x.gguf', '--rpc', '127.0.0.1:50052', '-dev', 'Vulkan1,RPC0,CUDA0', '-ts', '50/30/20'];
    assert.deepEqual(D.devicesFromArgs(args, WORKERS, sshEndpoint),
        [{ id: 'Vulkan1', share: 50 }, { worker: 'laptop', share: 30 }, { id: 'CUDA0', share: 20 }]);
    assert.deepEqual(D.devicesFromArgs(['--rpc', '10.0.0.9:50052', '-dev', 'RPC0'], WORKERS, sshEndpoint),
        [{ id: 'RPC0', rpcEndpoint: '10.0.0.9:50052' }]);
    assert.equal(D.devicesFromArgs(['-m', 'x.gguf'], WORKERS, sshEndpoint), null);
});

test('reconcileDeviceIds re-points a profile whose card moved to another id', () => {
    // Saved when the XTX was the only AMD card at Vulkan0; the 3060 now takes Vulkan0.
    const { devices, warnings } = D.reconcileDeviceIds(
        [{ id: 'Vulkan0', name: 'AMD Radeon RX 7900 XTX', share: 60 }, { worker: 'laptop', share: 40 }], DETECTED);
    assert.deepEqual(devices, [{ id: 'Vulkan1', name: 'AMD Radeon RX 7900 XTX', share: 60 }, { worker: 'laptop', share: 40 }]);
    assert.match(warnings[0], /moved from Vulkan0 to Vulkan1/);
});

test('reconcileDeviceIds warns instead of guessing', () => {
    const noName = D.reconcileDeviceIds([{ id: 'Vulkan5' }], DETECTED);
    assert.match(noName.warnings[0], /not a device in this build/);
    const twins = [...DETECTED, { id: 'Vulkan2', description: 'NVIDIA GeForce RTX 3060', totalMib: 12288, freeMib: 12000 }];
    const gone = D.reconcileDeviceIds([{ id: 'Vulkan1', name: 'NVIDIA GeForce RTX 3060' }], twins);
    assert.equal(gone.devices[0].id, 'Vulkan1');
    assert.match(gone.warnings[0], /several identical cards/);
});

test('physicalCards merges the CUDA and Vulkan listings of one card', () => {
    const cards = D.physicalCards(DETECTED);
    assert.equal(cards.length, 2);
    assert.deepEqual(cards[0].backends.map((b) => b.id), ['CUDA0', 'Vulkan0']);
    assert.equal(cards[0].preferredId, 'CUDA0');
    assert.equal(cards[1].name, 'AMD Radeon RX 7900 XTX');
    assert.equal(cards[1].preferredId, 'Vulkan1');
    assert.equal(cards[1].vendor, 'amd');
    assert.equal(cards[0].ambiguous, false);
});

test('physicalCards groups the all-backends build: each card under two backends', () => {
    // What the combined CUDA+ROCm+Vulkan build (GGML_BACKEND_DL) should list.
    const all = [
        { id: 'CUDA0', description: 'NVIDIA GeForce RTX 3060', totalMib: 11906, freeMib: 10794 },
        { id: 'ROCm0', description: 'AMD Radeon RX 7900 XTX', totalMib: 24560, freeMib: 23230 },
        { id: 'Vulkan0', description: 'NVIDIA GeForce RTX 3060', totalMib: 12288, freeMib: 10794 },
        { id: 'Vulkan1', description: 'AMD Radeon RX 7900 XTX (RADV NAVI31)', totalMib: 24560, freeMib: 24446 },
    ];
    const cards = D.physicalCards(all);
    assert.deepEqual(cards.map((c) => [c.name, c.backends.map((b) => b.id), c.preferredId]), [
        ['NVIDIA GeForce RTX 3060', ['CUDA0', 'Vulkan0'], 'CUDA0'],
        ['AMD Radeon RX 7900 XTX', ['ROCm0', 'Vulkan1'], 'ROCm0'],
    ]);
    // A profile saved on the Vulkan-only build keeps working here, and one
    // saved on the ROCm backend is re-pointed within ROCm, not onto Vulkan.
    assert.deepEqual(D.reconcileDeviceIds([{ id: 'Vulkan1', name: 'AMD Radeon RX 7900 XTX' }], all).warnings, []);
    const rocm = D.reconcileDeviceIds([{ id: 'ROCm1', name: 'AMD Radeon RX 7900 XTX' }], all);
    assert.equal(rocm.devices[0].id, 'ROCm0');
});

test('split mode: layer by default, tensor on request, read from the extra arguments too; row is refused', () => {
    const plan = D.planDevices({ devices: [{ id: 'ROCm0', share: 50 }, { id: 'ROCm1', share: 50 }] }, {});
    // nothing set: exactly the flags every two-device launch had before the field existed
    assert.deepEqual(D.deviceArgs(plan, sshEndpoint), ['--split-mode', 'layer', '-dev', 'ROCm0,ROCm1', '-ts', '50,50']);
    assert.deepEqual(D.deviceArgs(plan, sshEndpoint, { splitMode: 'layer' }), D.deviceArgs(plan, sshEndpoint));
    assert.deepEqual(D.deviceArgs(plan, sshEndpoint, { splitMode: 'tensor' }), ['--split-mode', 'tensor', '-dev', 'ROCm0,ROCm1', '-ts', '50,50']);
    assert.deepEqual(D.deviceArgs(plan, sshEndpoint, { splitMode: 'row' })[1], 'layer', 'never emitted: the caller refuses it first');
    // one device, or none: no split to describe
    assert.deepEqual(D.deviceArgs(D.planDevices({ devices: [{ id: 'ROCm1' }] }, {}), sshEndpoint, { splitMode: 'tensor' }), ['-dev', 'ROCm1']);
    assert.deepEqual(D.deviceArgs(D.planDevices({ devices: [] }, {}), sshEndpoint, { splitMode: 'tensor' }), []);
    assert.deepEqual(D.splitModeOf({}), { mode: 'layer', source: 'default', overridden: false, problem: null });
    assert.deepEqual(D.splitModeOf({ splitMode: 'tensor' }), { mode: 'tensor', source: 'field', overridden: false, problem: null });
    // profiles saved before the field carry it in the extra arguments, where llama-server reads it last
    const extra = D.splitModeOf({ argString: "-ot 'blk\\.(1|2)\\.ffn=ROCm0' -sm tensor --cache-ram 2048" });
    assert.deepEqual([extra.mode, extra.source, extra.overridden], ['tensor', 'extra', false]);
    assert.deepEqual(D.splitModeOf({ splitMode: 'layer', argString: '--split-mode tensor' }), { mode: 'tensor', source: 'extra', overridden: true, problem: null });
    assert.equal(D.splitModeOf({ argString: '-sm layer -sm tensor' }).mode, 'tensor', 'the last one wins, as in llama-server');
    assert.match(D.splitModeOf({ splitMode: 'row' }).problem, /deprecated in llama\.cpp and fails to load/);
    assert.match(D.splitModeOf({ argString: '-sm row' }).problem, /deprecated/);
    assert.match(D.splitModeOf({ splitMode: 'diagonal' }).problem, /Unknown split mode "diagonal"/);
    assert.equal(D.splitModeOf({ argString: '-sm none' }).problem, null);
    assert.equal(D.splitModeOf(null).mode, 'layer');
    assert.deepEqual(D.SPLIT_MODES, ['layer', 'tensor']);
});
