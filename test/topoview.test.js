'use strict';
// ui/topology/view.js: what the launcher and the monitor show about THIS machine's hardware -- card labels, which
// table row a saved device means, each profile's fit, split modes, busy-card sentences, the telemetry card list.
// Fixtures: one card, two identical cards, mixed vendors, no GPU; and an older server that sends none of the
// new fields.
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../ui/topology/view.js');
const topo = require('../lib/topology');
const D = require('../lib/devices');
const T = require('../lib/telemetry');

const XTX = 'AMD Radeon RX 7900 XTX', XTXV = 'AMD Radeon RX 7900 XTX (RADV NAVI31)', R3060 = 'NVIDIA GeForce RTX 3060', R4090 = 'NVIDIA GeForce RTX 4090';
const dev = (id, description, totalMib) => ({ id, description, totalMib, freeMib: totalMib - 500 });
const FIX = {
    oneCard: [dev('CUDA0', R4090, 24564), dev('Vulkan0', R4090, 24564)],
    twoIdentical: [dev('ROCm0', XTX, 24560), dev('ROCm1', XTX, 24560), dev('Vulkan0', XTXV, 24560), dev('Vulkan1', XTXV, 24560)],
    twoIdenticalVulkan: [dev('Vulkan0', XTXV, 24560), dev('Vulkan1', XTXV, 24560)],
    mixed: [dev('CUDA0', R3060, 12288), dev('ROCm0', XTX, 24560), dev('Vulkan0', R3060, 12288), dev('Vulkan1', XTXV, 24560)],
    cpuOnly: [],
};
// exactly what GET /api/devices returns for a build: { cards, topology }
const api = (k) => ({ cards: D.physicalCards(FIX[k]), topology: topo.build({ detected: FIX[k], hostRamMib: 64200 }) });
const rowsFor = (k, withTopology = true) => { const a = api(k); return V.cardRows(a.cards, withTopology ? a.topology : null).map((r) => ({ kind: 'card', ...r, id: r.preferredId })); };

test('the browser copies of the server rules agree with the server', () => {
    for (const n of [XTXV, R3060, 'NVIDIA GeForce RTX 4090 Laptop GPU', 'Intel(R) Arc(TM) B580 Graphics', 'Some Future Card 9000', '']) {
        assert.equal(V.shortName(n), topo.shortName(n), n);
        assert.equal(V.nameKey(n), D.gpuKey(n), n);
    }
    const cases = [{}, null, { splitMode: 'tensor' }, { splitMode: 'layer' }, { argString: '-sm tensor' }, { argString: "-ot 'a b=X0' --split-mode tensor -c 1" },
        { splitMode: 'layer', argString: '-sm tensor' }, { splitMode: 'tensor', argString: '-sm layer' }, { splitMode: 'row' }, { argString: '-sm row' }, { argString: '-sm none' },
        { splitMode: 'weird' }, { argString: '-sm' }, { argString: '-sm layer -sm tensor' }];
    for (const c of cases) assert.deepEqual(V.splitModeOf(c), D.splitModeOf(c), JSON.stringify(c));
    assert.deepEqual(V.SPLIT_MODES.map((m) => m.value), D.SPLIT_MODES);
    assert.ok(!V.SPLIT_MODES.some((m) => m.value === 'row'), 'row is deprecated in llama.cpp and fails to load: never offered');
    assert.match(V.SPLIT_MODES.find((m) => m.value === 'tensor').label, /experimental/);
});

test('cardRows: one row per physical card, identical cards numbered, on any machine', () => {
    assert.deepEqual(rowsFor('twoIdentical').map((r) => [r.label, r.ordinal, r.count, r.preferredId, r.vramMib, r.orderAssumed]),
        [['RX 7900 XTX #1', 1, 2, 'ROCm0', 24560, true], ['RX 7900 XTX #2', 2, 2, 'ROCm1', 24560, true]]);
    assert.deepEqual(rowsFor('twoIdentical').map((r) => r.backends.map((b) => b.id)), [['ROCm0', 'Vulkan0'], ['ROCm1', 'Vulkan1']]);
    // one backend: still two cards, and their order is the listing's own (nothing to pair, so nothing assumed)
    assert.deepEqual(rowsFor('twoIdenticalVulkan').map((r) => [r.label, r.orderAssumed]), [['RX 7900 XTX #1', false], ['RX 7900 XTX #2', false]]);
    assert.deepEqual(rowsFor('oneCard').map((r) => [r.label, r.count, r.preferredId]), [['RTX 4090', 1, 'CUDA0']]);
    assert.deepEqual(rowsFor('mixed').map((r) => r.label).sort(), ['RTX 3060', 'RX 7900 XTX']);
    assert.deepEqual(rowsFor('cpuOnly'), []);
    // an older server sends cards without a topology: numbered here, the same way
    assert.deepEqual(rowsFor('twoIdentical', false).map((r) => [r.label, r.ordinal, r.count, r.orderAssumed]), [['RX 7900 XTX #1', 1, 2, true], ['RX 7900 XTX #2', 2, 2, true]]);
    assert.deepEqual(rowsFor('mixed', false).map((r) => r.label).sort(), ['RTX 3060', 'RX 7900 XTX']);
    assert.deepEqual(V.cardRows(null, null), []);
    // row keys are stable across builds, so a row keeps its tick and share when the build changes
    assert.deepEqual(rowsFor('twoIdentical').map((r) => r.key), rowsFor('twoIdenticalVulkan').map((r) => r.key));
});

test('matchDeviceRow: a saved device lands on ITS card, not the first card of that name', () => {
    const rows = rowsFor('twoIdentical');
    const full = api('twoIdentical').topology;
    // "RX 7900 XTX #2 alone": by name first this enabled card #1
    assert.equal(V.matchDeviceRow(rows, { id: 'ROCm1', name: XTX }, new Set(), full).row.label, 'RX 7900 XTX #2');
    assert.equal(V.matchDeviceRow(rows, { id: 'Vulkan1', name: XTXV }, new Set(), null).row.label, 'RX 7900 XTX #2');
    // both cards, second first: the order of the list is the layer order and must survive
    const used = new Set();
    const picks = [{ id: 'ROCm1', name: XTX }, { id: 'ROCm0', name: XTX }].map((d) => { const h = V.matchDeviceRow(rows, d, used, full); used.add(h.row); return [h.row.label, h.how, V.idOnRow(h.row, d.id)]; });
    assert.deepEqual(picks, [['RX 7900 XTX #2', 'id', 'ROCm1'], ['RX 7900 XTX #1', 'id', 'ROCm0']]);
    // a Vulkan-only build has no ROCm1: the machine's fullest listing says it is card #2
    const vk = rowsFor('twoIdenticalVulkan');
    const moved = V.matchDeviceRow(vk, { id: 'ROCm1', name: XTX }, new Set(), full);
    assert.deepEqual([moved.row.label, moved.how, V.idOnRow(moved.row, 'ROCm1')], ['RX 7900 XTX #2', 'card', 'Vulkan1']);
    // ... and without that listing it can only be "a card of that model"
    assert.deepEqual([V.matchDeviceRow(vk, { id: 'ROCm1', name: XTX }, new Set(), null).how], ['name']);
    // ids shifted between machines: the card is found by name, under the saved backend where it has one
    const mixed = rowsFor('mixed');
    const shifted = V.matchDeviceRow(mixed, { id: 'Vulkan0', name: XTXV }, new Set(), api('mixed').topology);
    assert.deepEqual([shifted.row.label, V.idOnRow(shifted.row, 'Vulkan0')], ['RX 7900 XTX', 'Vulkan1']);
    // a card this machine lacks matches nothing (it is left out, and said so) -- never the card that now has its id
    assert.equal(V.matchDeviceRow(rows, { id: 'CUDA0', name: R3060 }, new Set(), full), null);
    assert.equal(V.matchDeviceRow(rowsFor('oneCard'), { id: 'CUDA0', name: R3060 }, new Set(), api('oneCard').topology), null);
    assert.equal(V.matchDeviceRow([], { id: 'ROCm0', name: XTX }, new Set(), null), null);
    // saved without a name (old configs): the row that has the id, flagged
    assert.deepEqual([V.matchDeviceRow(rows, { id: 'ROCm1' }, new Set(), full).row.label, V.matchDeviceRow(rows, { id: 'ROCm1' }, new Set(), full).how], ['RX 7900 XTX #2', 'unnamed']);
    assert.equal(V.matchDeviceRow(rows, { id: 'CUDA7' }, new Set(), full), null);
    // a row already taken is not handed out twice
    assert.equal(V.matchDeviceRow(rows, { id: 'ROCm1', name: XTX }, new Set([rows[1]]), full).row.label, 'RX 7900 XTX #1');
});

test('samePhysical: one card under two backends is one card; two identical cards are two', () => {
    const t = api('twoIdentical').topology, [r0, r1, v0, v1] = FIX.twoIdentical;
    assert.equal(V.samePhysical(r0, v0, t), true);
    assert.equal(V.samePhysical(r0, r1, t), false, 'the pair worth benchmarking: by description alone it was skipped');
    assert.equal(V.samePhysical(r0, v1, t), false);
    assert.equal(V.samePhysical(r1, v1, t), true);
    const m = api('mixed').topology, [c0, ro0, mv0, mv1] = FIX.mixed;
    assert.deepEqual([V.samePhysical(c0, mv0, m), V.samePhysical(c0, ro0, m), V.samePhysical(ro0, mv1, m), V.samePhysical(c0, mv1, m)], [true, false, true, false]);
    // no topology (older server): same model through different backends is one card, two ids of one backend never are
    assert.deepEqual([V.samePhysical(r0, v0, null), V.samePhysical(r0, r1, null), V.samePhysical(c0, ro0, null)], [true, false, false]);
    assert.equal(V.samePhysical(null, r0, t), false);
});

test('profile fit: runnable first, the reason shown, the resolved device list loaded', () => {
    const two = topo.build({ detected: FIX.twoIdentical, hostRamMib: 64200 });
    const vk = topo.build({ detected: FIX.twoIdenticalVulkan, hostRamMib: 64200 });
    const profiles = {
        'second card': { devices: [{ id: 'ROCm1', name: XTX, share: 100 }] },
        'old split': { devices: [{ id: 'ROCm0', name: XTX, share: 75 }, { id: 'CUDA0', name: R3060, share: 25 }] },
        'old split, sized': { devices: [{ id: 'ROCm0', name: XTX, share: 75, vramMib: 24560 }, { id: 'CUDA0', name: R3060, share: 25, vramMib: 12288 }] },
        'both': { devices: [{ id: 'ROCm0', name: XTX, share: 50 }, { id: 'ROCm1', name: XTX, share: 50 }] },
        'strata': { engine: 'strata', needs: { vendor: 'amd', minVramMib: 24000, hostRamMib: 47000 } },
    };
    // what server4.js profileAvailability sends (lib/topology.js availability; `devices` for moved / substitute)
    const serve = (t, ref) => Object.fromEntries(Object.entries(profiles).map(([n, cfg]) => {
        const a = topo.availability(cfg, t, { reference: ref });
        return [n, { status: a.status, reason: a.reason, placement: a.placement, ...(a.devices && (a.status === 'moved' || a.status === 'substitute') ? { devices: a.devices } : {}) }];
    }));
    const av = serve(two, two);
    assert.deepEqual(Object.fromEntries(Object.keys(profiles).map((n) => [n, V.fitOf(av, n).status])),
        { 'second card': 'ready', 'old split': 'unavailable', 'old split, sized': 'substitute', both: 'ready', strata: 'ready' });
    const gone = V.fitOf(av, 'old split');
    assert.deepEqual([gone.runnable, gone.reason, gone.text, gone.placement], [false, 'Needs RTX 3060.', 'not on this machine', null]);
    assert.equal(V.fitOf(av, 'both').placement, '2x RX 7900 XTX, 1:1');
    assert.equal(V.fitOf(av, 'second card').placement, 'RX 7900 XTX #2 alone');
    // the list: runnable ones first in their given order, unavailable last
    const names = Object.keys(profiles).map((name) => ({ name }));
    assert.deepEqual(V.sortByFit(names, av).map((x) => x.name), ['second card', 'old split, sized', 'both', 'strata', 'old split']);
    // substitute: the stand-in's ids are what the form loads, with the note
    const sub = V.fitOf(av, 'old split, sized');
    const load = V.devicesToLoad(profiles['old split, sized'], sub);
    assert.deepEqual([load.resolved, load.devices.map((d) => d.id)], [true, ['ROCm0', 'ROCm1']]);
    assert.match(load.note, /RTX 3060 is not in this machine; RX 7900 XTX #2 \(24 GB\) stands in\. Not validated on this machine\./);
    assert.equal(sub.placement, '2x RX 7900 XTX, 3:1');
    // moved (the Vulkan-only build): this build's id for the SAME card
    const mv = V.fitOf(serve(vk, two), 'second card');
    assert.deepEqual([mv.status, V.devicesToLoad(profiles['second card'], mv).devices.map((d) => d.id), mv.placement], ['moved', ['Vulkan1'], 'RX 7900 XTX #2 alone']);
    // ready / unavailable: the saved list is loaded as is (the table drops what this machine lacks and says so)
    assert.deepEqual(V.devicesToLoad(profiles.both, V.fitOf(av, 'both')), { devices: profiles.both.devices, resolved: false, note: '' });
    assert.deepEqual(V.devicesToLoad(profiles['old split'], gone), { devices: profiles['old split'].devices, resolved: false, note: 'Needs RTX 3060.' });
    // other machines: one card, mixed vendors, no GPU
    const on = (k) => { const t = topo.build({ detected: FIX[k], hostRamMib: 64200 }); const a = serve(t, t); return Object.fromEntries(Object.keys(profiles).map((n) => [n, V.fitOf(a, n).status])); };
    assert.deepEqual(on('mixed'), { 'second card': 'moved', 'old split': 'ready', 'old split, sized': 'ready', both: 'unavailable', strata: 'ready' });
    assert.deepEqual(on('oneCard'), { 'second card': 'unavailable', 'old split': 'unavailable', 'old split, sized': 'unavailable', both: 'unavailable', strata: 'unavailable' });
    assert.deepEqual(on('cpuOnly'), { 'second card': 'unavailable', 'old split': 'unavailable', 'old split, sized': 'unavailable', both: 'unavailable', strata: 'unavailable' });
});

test('an older server (no availability, no topology): every profile is runnable and labelled from its own devices', () => {
    for (const av of [undefined, null, {}, { other: { status: 'unavailable' } }]) {
        const f = V.fitOf(av, 'p');
        assert.deepEqual([f.status, f.runnable, f.known, f.reason, f.placement, f.devices], ['ready', true, false, '', null, null]);
    }
    assert.equal(V.fitOf({ p: { status: 'nonsense' } }, 'p').status, 'ready');
    assert.deepEqual(V.sortByFit([{ name: 'b' }, { name: 'a' }], undefined).map((x) => x.name), ['b', 'a']);
    const cfg = { devices: [{ id: 'ROCm0', name: XTX, share: 75 }, { id: 'CUDA0', name: R3060, share: 25 }] };
    assert.equal(V.placementText(cfg, V.fitOf(null, 'p')), 'RX 7900 XTX + RTX 3060, 3:1');
    assert.equal(V.placementText({ devices: [{ id: 'ROCm0', name: XTX }, { id: 'ROCm1', name: XTX }] }, null), '2x RX 7900 XTX');
    assert.equal(V.placementText({ devices: [{ id: 'Vulkan1' }] }, null), 'Vulkan1 alone');
    assert.equal(V.placementText({ devices: [{ worker: 'laptop', share: 1 }, { id: 'ROCm0', name: XTX, share: 1, enabled: false }] }, null), 'laptop (RPC) alone');
    assert.equal(V.placementText({ engine: 'strata' }, null), null);
    assert.equal(V.placementText({ devices: [{ id: 'X0' }] }, { placement: 'from the server' }), 'from the server');
    assert.deepEqual(V.devicesToLoad({ devices: [{ id: 'ROCm0' }] }, V.fitOf(null, 'p')), { devices: [{ id: 'ROCm0' }], resolved: false, note: '' });
    // moved, but this server does not send the resolved list yet: the saved one is loaded and the table matches rows itself
    assert.equal(V.devicesToLoad({ devices: [{ id: 'ROCm1' }] }, V.fitOf({ p: { status: 'moved', reason: 'x.' } }, 'p')).resolved, false);
    assert.equal(V.needsText({ vendor: 'amd', minVramMib: 24000, hostRamMib: 47000 }), 'AMD card with 24 GB · 46 GB of memory');
    assert.equal(V.needsText({ minCards: 2 }), '2 cards');
    assert.equal(V.needsText(null), '');
});

test('placementOfRows words the device table as the server words a profile', () => {
    for (const k of ['twoIdentical', 'mixed', 'oneCard']) {
        const t = topo.build({ detected: FIX[k], hostRamMib: 64200 });
        const rows = rowsFor(k);
        const cases = [rows.map((r) => ({ ...r, share: null })), rows.map((r, i) => ({ ...r, share: i ? 25 : 75 })), rows.slice().reverse().map((r) => ({ ...r, share: 50 })), rows.slice(0, 1), rows.slice(-1)];
        for (const c of cases) assert.equal(V.placementOfRows(c), topo.placementLabel(c.map((r) => ({ id: r.id, share: r.share })), t), `${k}: ${c.map((r) => r.id)}`);
    }
    assert.equal(V.placementOfRows(rowsFor('twoIdentical').slice(1)), 'RX 7900 XTX #2 alone');
    assert.equal(V.placementOfRows(rowsFor('twoIdentical').map((r) => ({ ...r, share: 50 }))), '2x RX 7900 XTX, 1:1');
    assert.equal(V.placementOfRows([{ kind: 'card', name: XTX, label: 'RX 7900 XTX #1', share: 60 }, { kind: 'worker', name: 'laptop', share: 40 }]), 'RX 7900 XTX #1 + laptop (RPC), 3:2');
    assert.equal(V.placementOfRows([]), '');
    assert.equal(V.placementOfRows(null), '');
});

test('split mode and launch summary text', () => {
    assert.equal(V.launchSummary({ placement: '2x RX 7900 XTX, 1:1', split: V.splitModeOf({ splitMode: 'tensor' }), deviceCount: 2 }), '2x RX 7900 XTX, 1:1 · tensor split (experimental)');
    assert.equal(V.launchSummary({ placement: '2x RX 7900 XTX, 1:1', split: V.splitModeOf({ argString: '-sm tensor' }), deviceCount: 2 }), '2x RX 7900 XTX, 1:1 · tensor split (experimental), set in extra arguments');
    assert.equal(V.launchSummary({ placement: 'RTX 3060 + RX 7900 XTX, 1:3', split: V.splitModeOf({}), deviceCount: 2 }), 'RTX 3060 + RX 7900 XTX, 1:3 · layer split');
    // one device: nothing is split, whatever the field says
    assert.equal(V.launchSummary({ placement: 'RX 7900 XTX #2 alone', split: V.splitModeOf({ splitMode: 'tensor' }), deviceCount: 1 }), 'RX 7900 XTX #2 alone');
    assert.equal(V.launchSummary({ placement: null, split: V.splitModeOf({}), deviceCount: 3 }), 'layer split');
    assert.equal(V.launchSummary({}), '');
    assert.equal(V.launchSummary(), '');
});

test('busy cards read per physical card, identical cards told apart', () => {
    const guard = require('../lib/launchguard');
    const t = topo.build({ detected: FIX.twoIdentical });
    const running = [{ id: 904, lane: 'local-rocm1', label: 'fill', launch_cmd: 'llama-server -dev ROCm1', env_json: '{"CODEBENCH_DEVICES":"ROCm1"}' },
        { id: 940, lane: 'local-gpu', label: 'strata-sweep', launch_cmd: '/x/queue-serve.sh cfg.json', env_json: '{}' }];
    // exactly what /api/preview-command `busy` carries (server4.js launchBusy drops cardKey)
    const busy = guard.busyCards(running, {}, t).map(({ cardKey, ...b }) => b);
    assert.equal(V.busyText(busy[0]), 'RX 7900 XTX #2 (ROCm1) is running queue item 904 (fill) on lane local-rocm1');
    assert.deepEqual(V.busyWarnings(busy), [
        'RX 7900 XTX #2 (ROCm1) is running queue item 904 (fill) on lane local-rocm1: launching now takes that card',
        'RX 7900 XTX #1 (ROCm0) and RX 7900 XTX #2 (ROCm1) are running queue item 940 (strata-sweep) on lane local-gpu: launching now takes those cards']);
    // the older shape (card + item only) and nothing at all
    assert.deepEqual(V.busyWarnings([{ card: 'RTX 3060', itemId: 879 }]), ['RTX 3060 is running queue item 879: launching now takes that card']);
    assert.deepEqual(V.busyWarnings(undefined), []);
    assert.equal(V.busyText(null), '');
});

test('telemetry cards: every card with its own label and reading; a launch device reads ITS card', () => {
    const g = (o) => ({ host: 'local', index: 0, vendor: 'amd', gpu_name: XTX, vram_used: 100, vram_total: 24560, process_vram: 0, gpu_pwr: 10, gpu_temp: 40, gpu_util: 0, throttle_reasons: [], error: false, ...o });
    const hot = g({ pci: '0b:00.0', gpu_temp: 86, mem_temp: 72, fan_rpm: 2910, fan_pct: 86, gpu_pwr: 322, gpu_util: 95, vram_used: 21888 });
    const idle = g({ index: 1, pci: '0e:00.0', gpu_temp: 42, mem_temp: 60, fan_rpm: 0, fan_pct: 0, gpu_pwr: 16 });
    const t = topo.build({ detected: FIX.twoIdentical });
    // the server's response (server4.js fetchCurrentTelemetry): gpus labelled, devices mapped by card
    const serve = (devices) => {
        const stats = { hosts: { local: {} }, gpus: [hot, idle] };
        const plan = devices ? D.planDevices({ devices }, {}) : null;
        const mapping = plan ? T.mapDevicesToGpus(plan, stats, FIX.twoIdentical, t) : null;
        return { ...stats, gpus: T.labelGpus(stats, t).map((x) => ({ ...x.gpu, label: x.label })), devices: mapping ? mapping.map(T.deviceRecord) : null };
    };
    // no launch: both cards, numbered, each with its own readings
    const both = V.telemetryCardList(serve(null));
    assert.deepEqual(both.map((c) => [c.key, c.label, c.gpu.gpu_temp, c.gpu.fan_rpm]), [['local|RX 7900 XTX #1', 'RX 7900 XTX #1', 86, 2910], ['local|RX 7900 XTX #2', 'RX 7900 XTX #2', 42, 0]]);
    // a launch on the second card alone shows the second card's numbers (by name it showed the first card's)
    const second = V.telemetryCardList(serve([{ id: 'ROCm1', name: XTX }]));
    assert.deepEqual(second.map((c) => [c.key, c.id, c.gpu.pci, c.gpu.gpu_temp]), [['local|RX 7900 XTX #2', 'ROCm1', '0e:00.0', 42]]);
    // both cards in a launch: two cards, two keys (they used to share one chart line), launch order kept
    const split = V.telemetryCardList(serve([{ id: 'ROCm1', name: XTX, share: 50 }, { id: 'ROCm0', name: XTX, share: 50 }]));
    assert.deepEqual(split.map((c) => [c.key, c.gpu.pci]), [['local|RX 7900 XTX #2', '0e:00.0'], ['local|RX 7900 XTX #1', '0b:00.0']]);
    // an older server: no labels, no pci on devices. Identical cards are still two cards, both numbered
    const old = V.telemetryCardList({ hosts: {}, gpus: [hot, idle] });
    assert.deepEqual(old.map((c) => c.label), ['RX 7900 XTX #1', 'RX 7900 XTX #2']);
    const oldLaunch = V.telemetryCardList({ hosts: {}, gpus: [hot, idle], devices: [{ id: 'ROCm0', name: XTX, host: 'local', label: 'RX 7900 XTX', util: 95 }, { id: 'ROCm1', name: XTX, host: 'local', label: 'RX 7900 XTX', util: 0 }] });
    assert.equal(new Set(oldLaunch.map((c) => c.key)).size, 2);
    // other machines: one card, mixed vendors with a worker host, a device with no reading, the legacy pair, nothing
    assert.deepEqual(V.telemetryCardList({ gpus: [g({ gpu_name: R4090, vendor: 'nvidia', pci: '01:00.0' })] }).map((c) => [c.key, c.label]), [['local|RTX 4090', 'RTX 4090']]);
    const mixed = V.telemetryCardList({ gpus: [g({ gpu_name: R3060, pci: '09:00.0' }), g({ pci: '0c:00.0' }), g({ host: 'laptop', gpu_name: 'NVIDIA GeForce RTX 4090 Laptop GPU', pci: '01:00.0' })] });
    assert.deepEqual(mixed.map((c) => c.label), ['RTX 3060', 'RX 7900 XTX', 'RTX 4090 Laptop @laptop']);
    const missing = V.telemetryCardList({ gpus: [], devices: [{ id: 'RPC0', name: null, host: 'laptop', label: 'RPC0', util: null }] });
    assert.deepEqual([missing[0].label, missing[0].gpu.missing], ['RPC0 @laptop', true]);
    assert.deepEqual(V.telemetryCardList({ master: { gpu_name: R3060 }, worker: { gpu_name: XTX } }).map((c) => [c.key, c.id]), [['local|RTX 3060', 'master'], ['worker|RX 7900 XTX', 'worker']]);
    assert.deepEqual(V.telemetryCardList({ gpus: [] }), []);
    assert.deepEqual(V.telemetryCardList(null), []);
    // readouts: each card's own sensors; a stopped fan is "0 rpm", a missing sensor is left out
    assert.deepEqual(V.cardReadout(both[0].gpu), ['86 °C', 'mem 72 °C', 'fan 2910 rpm (86%)', '322 W', '95%']);
    assert.deepEqual(V.cardReadout(both[1].gpu), ['42 °C', 'mem 60 °C', 'fan 0 rpm (0%)', '16 W', '0%']);
    assert.deepEqual(V.cardReadout({ gpu_temp: 55, gpu_pwr: 80.4, gpu_util: 30, fan_pct: 41, fan_rpm: null, mem_temp: null }), ['55 °C', 'fan 41%', '80 W', '30%']);
    assert.deepEqual(V.cardReadout({ gpu_temp: 55, gpu_pwr: 80, gpu_util: 30 }), ['55 °C', '80 W', '30%'], 'an older monitor.py: no fan, no memory temperature');
    assert.deepEqual(V.cardReadout({ missing: true, gpu_temp: null }), []);
    assert.deepEqual(V.cardReadout(null), []);
});

test('chart lines: samples recorded before identical cards were numbered still draw one line per card', () => {
    // a two-card launch's sample as the server recorded it before 2026-10-12: both devices labelled alike
    const old = [{ id: 'ROCm0', label: 'RX 7900 XTX', host: 'local', temp: 86 }, { id: 'ROCm1', label: 'RX 7900 XTX', host: 'local', temp: 42 }];
    assert.deepEqual(V.distinctDevices(old).map((d) => [d.id, d.label, d.temp]), [['ROCm0', 'RX 7900 XTX #1', 86], ['ROCm1', 'RX 7900 XTX #2', 42]]);
    assert.equal(new Set(V.distinctDevices(old).map((d) => `${d.host}|${d.label}`)).size, 2);
    // already distinct (new samples, mixed cards, a worker's twin on another host): returned untouched, same array
    const fresh = [{ id: 'ROCm0', label: 'RX 7900 XTX #1', host: 'local' }, { id: 'ROCm1', label: 'RX 7900 XTX #2', host: 'local' }];
    assert.equal(V.distinctDevices(fresh), fresh);
    const mixed = [{ id: 'CUDA0', label: 'RTX 3060', host: 'local' }, { id: 'ROCm0', label: 'RX 7900 XTX', host: 'local' }, { id: 'RPC0', label: 'RX 7900 XTX', host: 'laptop' }];
    assert.equal(V.distinctDevices(mixed), mixed);
    assert.deepEqual(V.distinctDevices([{ id: 'CUDA0', label: 'RTX 4090', host: 'local' }]).map((d) => d.label), ['RTX 4090']);
    assert.deepEqual(V.distinctDevices(null), []);
    // three of a kind next to another card
    assert.deepEqual(V.distinctDevices([{ label: 'A', host: 'local' }, { label: 'B', host: 'local' }, { label: 'A', host: 'local' }, { label: 'A', host: 'local' }]).map((d) => d.label), ['A #1', 'B', 'A #2', 'A #3']);
});

test('full-screen telemetry series: every identical card numbered, the server\'s label used when it sends one', () => {
    const gpu = (host, name, label) => ({ kind: 'gpu', host, name, ...(label ? { label } : {}) });
    // an older server: no labels. Both cards are numbered (only the second used to be), matching the sidebar's keys
    assert.deepEqual(V.seriesLabels([gpu('local', XTX), gpu('local', XTX), { kind: 'host', id: 'local' }]), ['RX 7900 XTX #1', 'RX 7900 XTX #2', null]);
    assert.deepEqual(V.seriesLabels([gpu('local', XTX, 'RX 7900 XTX #2'), gpu('local', XTX, 'RX 7900 XTX #1')]), ['RX 7900 XTX #2', 'RX 7900 XTX #1']);
    assert.deepEqual(V.seriesLabels([gpu('local', R3060), gpu('local', XTX), gpu('laptop', R4090)]), ['RTX 3060', 'RX 7900 XTX', 'RTX 4090']);
    assert.deepEqual(V.seriesLabels([gpu('local', R4090)]), ['RTX 4090']);
    assert.deepEqual(V.seriesLabels([{ kind: 'net' }, { kind: 'tps' }]), [null, null]);
    assert.deepEqual(V.seriesLabels(null), []);
    // the same labels the sidebar gives the same readings
    const side = V.telemetryCardList({ gpus: [{ host: 'local', gpu_name: XTX, pci: '0b:00.0' }, { host: 'local', gpu_name: XTX, pci: '0e:00.0' }] }).map((c) => c.label);
    assert.deepEqual(V.seriesLabels([gpu('local', XTX), gpu('local', XTX)]), side);
});

// --- 2026-10-13: ordinals that survive truncation, the device list's own note, needs in the server's numbers ---
test('labelParts / labelHtml: the name may be cut, the ordinal may not', () => {
    assert.deepEqual(V.labelParts('RX 7900 XTX #2'), { name: 'RX 7900 XTX', tail: ' #2' });
    assert.deepEqual(V.labelParts('RX 7900 XTX #1 @laptop'), { name: 'RX 7900 XTX', tail: ' #1 @laptop' });
    assert.deepEqual(V.labelParts('RX 7900 XTX #2 Strata'), { name: 'RX 7900 XTX', tail: ' #2 Strata' });
    assert.deepEqual(V.labelParts('RTX 4090 Laptop'), { name: 'RTX 4090 Laptop', tail: '' });
    assert.deepEqual(V.labelParts('2x RX 7900 XTX'), { name: '2x RX 7900 XTX', tail: '' });
    assert.deepEqual(V.labelParts('card #12'), { name: 'card', tail: ' #12' });
    assert.deepEqual([V.labelParts(null), V.labelParts('')], [{ name: '', tail: '' }, { name: '', tail: '' }]);
    const html = V.labelHtml('RX 7900 XTX #2', (x) => String(x).replace(/</g, '&lt;'));
    // the name is the part with the ellipsis; the ordinal sits in a box that does not shrink
    assert.match(html, /<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">RX 7900 XTX<\/span><span style="flex:none;white-space:pre"> #2<\/span>/);
    assert.ok(!V.labelHtml('RTX 4090 Laptop').includes('flex:none'), 'no ordinal: one part');
    assert.ok(V.labelHtml('<b>x</b> #1').includes('&lt;b&gt;x&lt;/b&gt;'), 'escaped, with or without a caller\'s escaper');
    // both cards of the two-identical fixture stay distinct in what cannot be cut
    const tails = rowsFor('twoIdentical').map((r) => V.labelParts(r.label).tail);
    assert.deepEqual(tails, [' #1', ' #2']);
});

test('devicesNote: a cached, borrowed or failed device list is said, never shown as a fresh one or hidden', () => {
    const a = api('twoIdentical');
    assert.deepEqual(V.devicesNote({ ...a, cached: false, probed: true }), { text: '', tone: 'info', failed: false, canRefresh: false });
    assert.deepEqual(V.devicesNote(a), { text: '', tone: 'info', failed: false, canRefresh: false }, 'an older server: nothing to say');
    const cached = V.devicesNote({ ...a, cached: true, probed: false, note: 'not re-probed (queue item 942 is running on lane local-gpu); device list from 45 min ago' });
    assert.deepEqual([cached.text, cached.tone, cached.failed, cached.canRefresh], ['not re-probed (queue item 942 is running on lane local-gpu); device list from 45 min ago', 'info', false, true]);
    // the probe timed out: the last good list is in `cards`, the page must not say "Detection failed"
    const stale = V.devicesNote({ ...a, cached: true, probed: true, error: 'timed out', note: "the probe timed out; showing this build's device list from 60 s ago" });
    assert.deepEqual([stale.failed, stale.tone], [false, 'warn']);
    assert.ok(!/Detection failed/.test(stale.text));
    assert.equal(V.devicesNote({ ...a, cached: true, error: 'timed out' }).text, 'The probe timed out; showing the last good device list.');
    assert.match(V.devicesNote({ ...a, cached: true, borrowed: true, from: 'all' }).text, /not known; showing build "all"'s/);
    // nothing to show at all: the manual-entry fallback, as before
    assert.deepEqual(V.devicesNote({ devices: [], cards: [], error: 'timed out' }), { text: 'Detection failed (timed out) — enter local device ids below.', tone: 'warn', failed: true, canRefresh: true });
    assert.equal(V.devicesNote(null).failed, true);
});

test('needsText says the numbers the server says (lib/topology.js availability)', () => {
    const none = topo.build({ detected: FIX.oneCard.map((d) => ({ ...d, description: R3060, totalMib: 12288 })), hostRamMib: 32000 });
    for (const needs of [{ vendor: 'amd', minVramMib: 24000 }, { minVramMib: 24560 }, { minVramMib: 12288, minCards: 2 }, { vendor: 'nvidia', minVramMib: 16376, hostRamMib: 47000 }, { hostRamMib: 96000 }]) {
        const reason = topo.availability({ engine: 'strata', needs }, none).reason;
        for (const gb of V.needsText(needs).match(/\d+ GB/g) || []) assert.ok(reason.includes(gb), `${JSON.stringify(needs)}: the page says "${V.needsText(needs)}", the server "${reason}"`);
    }
    assert.equal(topo.availability({ engine: 'strata', needs: { vendor: 'amd', minVramMib: 24000 } }, none).reason, 'Needs an AMD card with 24 GB.');
});

test('unavailableConfirmText: one question for the dropdown and the picker', () => {
    assert.equal(V.unavailableConfirmText('bench · X (3060 only)', V.fitOf({ 'bench · X (3060 only)': { status: 'unavailable', reason: 'Needs RTX 3060.' } }, 'bench · X (3060 only)')),
        '"bench · X (3060 only)" cannot run on this machine as saved.\n\nNeeds RTX 3060.\n\nLoad it anyway? Devices this machine lacks are left out of the form.');
    assert.match(V.unavailableConfirmText('p', null), /It needs hardware this machine does not have\./);
});
