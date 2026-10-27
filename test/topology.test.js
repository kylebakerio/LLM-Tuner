'use strict';
const test = require('node:test');
const assert = require('node:assert');
const topo = require('../lib/topology');
const guard = require('../lib/launchguard');

const XTX = 'AMD Radeon RX 7900 XTX', XTXV = 'AMD Radeon RX 7900 XTX (RADV NAVI31)', R3060 = 'NVIDIA GeForce RTX 3060';
const dev = (id, description, totalMib) => ({ id, description, totalMib, freeMib: totalMib - 500 });
const FIX = {
    oneCard: [dev('CUDA0', 'NVIDIA GeForce RTX 4090', 24564), dev('Vulkan0', 'NVIDIA GeForce RTX 4090', 24564)],
    twoIdentical: [dev('ROCm0', XTX, 24560), dev('ROCm1', XTX, 24560), dev('Vulkan0', XTXV, 24560), dev('Vulkan1', XTXV, 24560)],
    mixed: [dev('CUDA0', R3060, 12288), dev('ROCm0', XTX, 24560), dev('Vulkan0', R3060, 12288), dev('Vulkan1', XTXV, 24560)],
    cpuOnly: [],
    withWorker: [dev('ROCm0', XTX, 24560), dev('RPC0', 'laptop: NVIDIA GeForce RTX 4090 Laptop GPU', 16376)],
};
const T = Object.fromEntries(Object.entries(FIX).map(([k, d]) => [k, topo.build({ detected: d, hostRamMib: 64200, workers: k === 'withWorker' ? [{ name: 'laptop' }] : [] })]));

test('short names drop vendor words', () => {
    assert.strictEqual(topo.shortName(XTXV), 'RX 7900 XTX');
    assert.strictEqual(topo.shortName('NVIDIA GeForce RTX 4090 Laptop GPU'), 'RTX 4090 Laptop');
});

test('two identical cards are two cards, each reachable through both backends', () => {
    const t = T.twoIdentical;
    assert.strictEqual(t.cards.length, 2);
    assert.deepStrictEqual(t.cards.map((c) => c.label), ['RX 7900 XTX #1', 'RX 7900 XTX #2']);
    assert.deepStrictEqual(t.cards[1].ids, ['ROCm1', 'Vulkan1']);
    assert.notStrictEqual(t.cards[0].key, t.cards[1].key);
    assert.strictEqual(topo.cardOfId(t, 'Vulkan1').key, topo.cardOfId(t, 'ROCm1').key);
    assert.ok(t.cards[0].orderAssumed);
    assert.strictEqual(t.signature, '2x RX 7900 XTX 24G | 63G RAM');
});

test('one card, mixed vendors, CPU only, RPC worker', () => {
    assert.strictEqual(T.oneCard.cards.length, 1);
    assert.strictEqual(T.oneCard.cards[0].label, 'RTX 4090');
    assert.strictEqual(T.oneCard.cards[0].preferredId, 'CUDA0');
    assert.deepStrictEqual(T.mixed.cards.map((c) => c.label).sort(), ['RTX 3060', 'RX 7900 XTX']);
    assert.strictEqual(topo.cardOfId(T.mixed, 'Vulkan1').label, 'RX 7900 XTX');
    assert.strictEqual(T.cpuOnly.cards.length, 0);
    assert.strictEqual(T.cpuOnly.signature, 'no GPU | 63G RAM');
    assert.strictEqual(T.withWorker.cards.length, 1, 'an RPC device is not one of this machine\'s cards');
});

test('resolveDevices: kept, moved, two of a kind, substitute, unavailable', () => {
    const one = [{ id: 'ROCm0', name: XTX, share: 100 }];
    assert.strictEqual(topo.resolveDevices(one, T.twoIdentical).status, 'ready');
    // saved on the old rig (XTX was ROCm0, 3060 was CUDA0), opened on two XTX: the 3060 is gone
    const split = [{ id: 'ROCm0', name: XTX, share: 75 }, { id: 'CUDA0', name: R3060, share: 25 }];
    const r = topo.resolveDevices(split, T.twoIdentical);
    assert.strictEqual(r.status, 'unavailable');
    assert.deepStrictEqual(r.missing, ['RTX 3060']);
    // ... unless the profile says how much memory that card had: the second XTX is big enough to stand in
    const sub = topo.resolveDevices([split[0], { ...split[1], vramMib: 12288 }], T.twoIdentical);
    assert.strictEqual(sub.status, 'substitute');
    assert.deepStrictEqual(sub.devices.map((d) => d.id), ['ROCm0', 'ROCm1']);
    // a profile that names the same card twice needs two of them
    const two = [{ id: 'ROCm0', name: XTX, share: 1 }, { id: 'ROCm1', name: XTX, share: 1 }];
    assert.strictEqual(topo.resolveDevices(two, T.twoIdentical).status, 'ready');
    assert.strictEqual(topo.resolveDevices(two, T.mixed).status, 'unavailable');
    // ids shifted: the XTX was Vulkan0 when saved and is Vulkan1 on the mixed rig
    const moved = topo.resolveDevices([{ id: 'Vulkan0', name: XTXV, share: 100 }], T.mixed);
    assert.strictEqual(moved.status, 'moved');
    assert.strictEqual(moved.devices[0].id, 'Vulkan1');
    // a 3060-only profile on a one-card 4090 machine, with and without a known size
    assert.strictEqual(topo.resolveDevices([{ id: 'CUDA0', name: R3060, vramMib: 12288 }], T.oneCard).status, 'substitute');
    assert.strictEqual(topo.resolveDevices([{ id: 'CUDA0', name: R3060 }], T.cpuOnly).status, 'unavailable');
    assert.strictEqual(topo.resolveDevices([{ worker: 'laptop', share: 1 }], T.oneCard).status, 'unavailable');
    assert.strictEqual(topo.resolveDevices([{ worker: 'laptop', share: 1 }], T.withWorker).status, 'ready');
});

test('availability: needs, raw commands, placement text', () => {
    const a = topo.availability({ devices: [{ id: 'ROCm0', name: XTX, share: 1 }, { id: 'ROCm1', name: XTX, share: 1 }] }, T.twoIdentical);
    assert.strictEqual(a.status, 'ready');
    assert.strictEqual(a.placement, '2x RX 7900 XTX, 1:1');
    assert.strictEqual(topo.availability({ devices: [{ id: 'ROCm1', name: XTX, share: 100 }] }, T.twoIdentical).placement, 'RX 7900 XTX #2 alone');
    const s = topo.availability({ engine: 'strata', needs: { hostRamMib: 47000, minVramMib: 24000, vendor: 'amd' } }, T.twoIdentical);
    assert.strictEqual(s.status, 'ready');
    const low = topo.availability({ engine: 'strata', needs: { hostRamMib: 47000, minVramMib: 24000, vendor: 'amd' } }, topo.build({ detected: FIX.oneCard, hostRamMib: 32000 }));
    assert.strictEqual(low.status, 'unavailable');
    assert.match(low.reason, /46 GB of memory.*an AMD card with 24 GB/);
    const raw = topo.availability({ launchMode: 'raw', rawCommand: "llama-server -m x.gguf -dev ROCm0,CUDA0 -ts 47,1 -ot 'blk\\.(24)\\.ffn_up_exps=CUDA0' -devd ROCm0" }, T.twoIdentical);
    assert.strictEqual(raw.status, 'unavailable');
    assert.match(raw.reason, /CUDA0/);
    assert.strictEqual(topo.availability({ launchMode: 'raw', rawCommand: 'llama-server -dev ROCm0,ROCm1 -sm tensor' }, T.twoIdentical).status, 'ready');
    assert.strictEqual(topo.placementLabel([{ id: 'ROCm0', share: 75 }, { id: 'CUDA0', share: 25 }], T.mixed), 'RX 7900 XTX + RTX 3060, 3:1');
    assert.strictEqual(topo.placementLabel([], T.cpuOnly), 'CPU only');
});

test('launch guard: identical cards are separate, backends of one card collide', () => {
    const t = T.twoIdentical;
    const running = [{ id: 904, lane: 'local-rocm1', label: 'fill', launch_cmd: 'llama-server -dev ROCm1 -devd ROCm1', env_json: '{"CODEBENCH_DEVICES":"ROCm1"}' }];
    const busy = guard.busyCards(running, {}, t);
    assert.strictEqual(busy.length, 1);
    assert.strictEqual(busy[0].card, 'RX 7900 XTX #2');
    assert.strictEqual(guard.conflicts(guard.neededCards({ args: ['-dev', 'ROCm0'], topology: t }), busy).length, 0, 'the other identical card is free');
    assert.strictEqual(guard.conflicts(guard.neededCards({ args: ['-dev', 'Vulkan1'], topology: t }), busy).length, 1, 'same card through Vulkan');
    assert.strictEqual(guard.conflicts(guard.neededCards({ args: ['-m', 'x.gguf'], topology: t }), busy).length, 1, 'no -dev = every card');
    assert.strictEqual(guard.conflicts(guard.neededCards({ devices: [{ id: 'ROCm0', name: XTX }, { worker: 'laptop' }], topology: t }), busy).length, 0);
    assert.strictEqual(guard.conflicts(guard.neededCards({ command: '/x/Strata-0.1.32/queue-serve.sh', args: ['cfg.json'], topology: t }), busy).length, 0, 'Strata takes the first card');
    assert.strictEqual(guard.conflicts(guard.neededCards({ command: '/x/strata', args: ['--gpu', '0,1'], topology: t }), busy).length, 1);
    assert.strictEqual(guard.conflicts(guard.neededCards({ command: '/x/Strata-0.1.43.1/queue-serve.sh', args: ['two-card.json'], devices: [{ id: 'ROCm0' }, { id: 'ROCm1' }], topology: t }), busy).length, 1, 'a Strata config that lists both cards');
    assert.match(guard.describe(busy), /RX 7900 XTX #2 is running queue item 904 \(fill\)/);
});

test('launch guard: lanes without device lists, remote lanes, no topology', () => {
    const t = T.twoIdentical;
    const strata = [{ id: 940, lane: 'local-gpu', label: 's', launch_cmd: '/x/queue-serve.sh cfg.json', env_json: '{}' }];
    assert.strictEqual(guard.busyCards(strata, {}, t).length, 2, 'a local item naming no device holds every card');
    assert.strictEqual(guard.busyCards(strata, { 'local-gpu': { devices: ['ROCm0'] } }, t).length, 1, 'unless its lane is confined to one');
    const laptop = [{ id: 935, lane: 'laptop-4090', label: 'l', launch_cmd: 'laptop-llama-server.py -dev CUDA0,CUDA1', env_json: '{"CODEBENCH_DEVICES":"LAPTOP4090"}' }];
    assert.strictEqual(guard.conflicts(guard.neededCards({ args: ['-dev', 'ROCm0,ROCm1'], topology: t }), guard.busyCards(laptop, {}, t)).length, 0);
    // probe failed: ids are compared as text
    const b = guard.busyCards([{ id: 1, lane: 'local-gpu', launch_cmd: 'llama-server -dev ROCm0', env_json: '{}' }], {}, null);
    assert.strictEqual(guard.conflicts(guard.neededCards({ args: ['-dev', 'ROCm0'] }), b).length, 1);
    assert.strictEqual(guard.conflicts(guard.neededCards({ args: ['-dev', 'ROCm1'] }), b).length, 0);
    assert.deepStrictEqual(guard.neededCards({ args: ['-dev', 'none'], topology: t }), []);
});

// --- launch path and lane widgets (server4.js planLaunchDevices, /api/queue lane cards) ---
const VK_ONLY = topo.build({ detected: [dev('Vulkan0', XTXV, 24560), dev('Vulkan1', XTXV, 24560)], hostRamMib: 64200 });

test('resolveDevices: an id this build lacks goes to the SAME physical card, by the fullest listing', () => {
    const second = [{ id: 'ROCm1', name: XTX, share: 100 }];
    // a Vulkan-only build knows no ROCm1; without help the first free identical card would be taken (Vulkan0 = card #1)
    assert.strictEqual(topo.resolveDevices(second, VK_ONLY).devices[0].id, 'Vulkan0');
    const r = topo.resolveDevices(second, VK_ONLY, { reference: T.twoIdentical });
    assert.strictEqual(r.status, 'moved');
    assert.strictEqual(r.devices[0].id, 'Vulkan1');
    assert.deepStrictEqual(r.cards, ['amd radeon rx 7900 xtx#2']);
    // both cards, second first: each stays its own card
    const both = topo.resolveDevices([{ id: 'ROCm1', name: XTX, share: 1 }, { id: 'ROCm0', name: XTX, share: 1 }], VK_ONLY, { reference: T.twoIdentical });
    assert.deepStrictEqual(both.devices.map((d) => d.id), ['Vulkan1', 'Vulkan0']);
    assert.strictEqual(topo.availability({ devices: second }, VK_ONLY, { reference: T.twoIdentical }).placement, 'RX 7900 XTX #2 alone');
    // the reference names a card this build has no twin of: fall back to the first free one, never throw
    assert.strictEqual(topo.resolveDevices([{ id: 'CUDA0', name: XTX }], VK_ONLY, { reference: T.mixed }).devices[0].id, 'Vulkan0');
});

test('launchDevices: what runs, what the user is told, which ids changed', () => {
    const t = T.twoIdentical;
    // two identical cards with valid ids: nothing to say (the old reconcile warned "several identical cards")
    const ok = topo.launchDevices([{ id: 'ROCm0', name: XTX, share: 50 }, { id: 'ROCm1', name: XTX, share: 50 }], t);
    assert.deepStrictEqual([ok.status, ok.warnings, ok.idMap], ['ready', [], {}]);
    assert.deepStrictEqual(ok.devices.map((d) => [d.id, d.share]), [['ROCm0', 50], ['ROCm1', 50]]);
    // moved: the id follows the card, and says so
    const moved = topo.launchDevices([{ id: 'ROCm1', name: XTX }], VK_ONLY, { reference: t });
    assert.deepStrictEqual([moved.devices[0].id, moved.idMap, moved.warnings], ['Vulkan1', { ROCm1: 'Vulkan1' }, ['RX 7900 XTX #2 moved from ROCm1 to Vulkan1; using Vulkan1']]);
    // substitute: runs on the stand-in, flagged as not validated
    const sub = topo.launchDevices([{ id: 'ROCm0', name: XTX, share: 75 }, { id: 'CUDA0', name: R3060, vramMib: 12288, share: 25 }], t);
    assert.deepStrictEqual(sub.devices.map((d) => d.id), ['ROCm0', 'ROCm1']);
    assert.strictEqual(sub.idMap.CUDA0, 'ROCm1');
    assert.match(sub.warnings[0], /RTX 3060 is not in this machine; using RX 7900 XTX #2 \(ROCm1\) instead -- not validated here/);
    // unavailable: the id is left alone (llama-server reports it), with the reason
    const gone = topo.launchDevices([{ id: 'CUDA0', name: R3060 }], t);
    assert.deepStrictEqual([gone.status, gone.devices[0].id, gone.warnings], ['unavailable', 'CUDA0', ['RTX 3060 (CUDA0) is not in this machine']]);
    assert.deepStrictEqual(topo.launchDevices([{ id: 'SYCL0' }], t).warnings, ['SYCL0 is not a device in this build']);
    // an id that now reaches another card model, and no such card anywhere
    assert.deepStrictEqual(topo.launchDevices([{ id: 'CUDA0', name: 'NVIDIA GeForce RTX 4090' }], T.mixed).warnings, ['CUDA0 is now RTX 3060, not RTX 4090']);
    // RPC workers pass through untouched; an unnamed valid id is kept silently
    const rpc = topo.launchDevices([{ id: 'ROCm0' }, { worker: 'laptop', share: 1 }], T.withWorker);
    assert.deepStrictEqual([rpc.warnings, rpc.devices[1]], [[], { worker: 'laptop', share: 1 }]);
    // no cards known (probe failed / not run yet) or a CPU-only machine: nothing is touched, nothing is claimed
    for (const none of [null, T.cpuOnly, { cards: [] }]) {
        const r = topo.launchDevices([{ id: 'ROCm0', name: XTX }, { id: 'CUDA0', name: R3060 }], none);
        assert.deepStrictEqual([r.devices.map((d) => d.id), r.warnings, r.idMap], [['ROCm0', 'CUDA0'], [], {}]);
    }
    assert.deepStrictEqual(topo.launchDevices(null, t).devices, []);
});

test('laneCards: a lane\'s cards come from its device list and this machine, or the remote lane\'s own name', () => {
    const t = T.twoIdentical;
    assert.deepStrictEqual(topo.laneCards('local-rocm1', { devices: ['ROCm1'], gpu: XTX }, t), { label: 'RX 7900 XTX #2', here: true, remote: false, cards: ['amd radeon rx 7900 xtx#2'] });
    assert.strictEqual(topo.laneCards('local-xtx', { devices: ['ROCm0'], gpu: XTX }, t).label, 'RX 7900 XTX #1');
    assert.strictEqual(topo.laneCards('any', { devices: ['ROCm0', 'Vulkan1'] }, t).label, '2x RX 7900 XTX');
    assert.strictEqual(topo.laneCards('any', { devices: ['ROCm0', 'Vulkan0'] }, t).label, 'RX 7900 XTX #1', 'two ids of one card are one card');
    // another machine's lane: its device names are not ids here, its card is the one its runner published
    assert.deepStrictEqual(topo.laneCards('laptop-4090', { devices: ['LAPTOP4090'], gpu: 'NVIDIA GeForce RTX 4090 Laptop GPU' }, t), { label: 'RTX 4090 Laptop', here: false, remote: true, cards: [] });
    // ... even when its id happens to exist here too (CUDA0 on both machines): the published card model decides
    assert.strictEqual(topo.laneCards('far', { devices: ['CUDA0'], gpu: 'NVIDIA GeForce RTX 4090 Laptop GPU' }, T.mixed).remote, true);
    // a lane with a serving port but no device list runs whatever its items ask for: every card of this machine
    assert.strictEqual(topo.laneCards('local-gpu', { server_port: 18080 }, t).label, '2x RX 7900 XTX');
    assert.strictEqual(topo.laneCards('local-gpu', { server_port: 18080 }, T.mixed).label, 'RTX 3060 + RX 7900 XTX');
    assert.strictEqual(topo.laneCards('local-gpu', { server_port: 18080 }, T.oneCard).label, 'RTX 4090');
    assert.deepStrictEqual(topo.laneCards('local-gpu', { server_port: 18080 }, T.cpuOnly), { label: 'no GPU', here: false, remote: false, cards: [] });
    // a local lane whose card left this machine: absent, not remote -- named by what its runner published, else its ids
    assert.deepStrictEqual(topo.laneCards('local-old', { devices: ['CUDA0'] }, t), { label: 'CUDA0', here: false, remote: false, cards: [] });
    assert.deepStrictEqual(topo.laneCards('local-old', { devices: ['CUDA0'], gpu: R3060 }, t), { label: 'RTX 3060', here: false, remote: false, cards: [] });
    assert.deepStrictEqual(topo.laneCards('local-rocm1', { devices: ['ROCm1'], gpu: XTX }, T.oneCard), { label: 'RX 7900 XTX', here: false, remote: false, cards: [] });
    assert.strictEqual(topo.laneCards('local-old', { gpu: R3060 }, T.mixed).here, true);
    // nothing published (a stopped runner, the cloud lane): nothing claimed
    assert.deepStrictEqual(topo.laneCards('local-3060', {}, t), { label: null, here: null, remote: false, cards: [] });
    assert.deepStrictEqual(topo.laneCards('cloud', null, t), { label: null, here: null, remote: false, cards: [] });
});

// --- a bare id (no card name) that this build does not list (2026-10-13) ---
test('resolveDevices: a bare id this build lacks follows its card through the fullest listing, and nothing else', () => {
    const bare = [{ id: 'ROCm1', share: 100 }];
    // with the reference: ROCm1 is card #2 there, and this build reaches card #2 as Vulkan1
    const r = topo.resolveDevices(bare, VK_ONLY, { reference: T.twoIdentical });
    assert.deepStrictEqual([r.status, r.devices[0].id, r.cards, r.kinds], ['moved', 'Vulkan1', ['amd radeon rx 7900 xtx#2'], ['byId']]);
    assert.strictEqual(r.devices[0].name, undefined, 'the device gains no name it was not saved with');
    assert.match(r.notes[0], /^ROCm1 is RX 7900 XTX #2 on this machine, which this build reaches as Vulkan1 \(identical cards paired by listing order\)$/);
    // without one: unavailable. Never "the second device here", never the first free card.
    const none = topo.resolveDevices(bare, VK_ONLY);
    assert.deepStrictEqual([none.status, none.devices[0].id, none.cards, none.missing], ['unavailable', 'ROCm1', [null], ['device ROCm1']]);
    // the reference is this very listing, or does not know the id either: unavailable
    assert.strictEqual(topo.resolveDevices(bare, VK_ONLY, { reference: VK_ONLY }).status, 'unavailable');
    assert.strictEqual(topo.resolveDevices([{ id: 'SYCL1' }], VK_ONLY, { reference: T.twoIdentical }).status, 'unavailable');
    // the reference knows the id as a card this build cannot reach at all (an NVIDIA card, a Vulkan-less AMD build)
    const ROCM_ONLY = topo.build({ detected: [dev('ROCm0', XTX, 24560)], hostRamMib: 64200 });
    assert.strictEqual(topo.resolveDevices([{ id: 'CUDA0' }], ROCM_ONLY, { reference: T.mixed }).status, 'unavailable');
    // that card is already taken by another device of the same launch: unavailable, not the other card
    const clash = topo.resolveDevices([{ id: 'Vulkan1', name: XTXV, share: 1 }, { id: 'ROCm1', share: 1 }], VK_ONLY, { reference: T.twoIdentical });
    assert.deepStrictEqual([clash.status, clash.cards], ['unavailable', ['amd radeon rx 7900 xtx#2', null]]);
    // two bare ids, second card first: each lands on its own card
    const both = topo.resolveDevices([{ id: 'ROCm1' }, { id: 'ROCm0' }], VK_ONLY, { reference: T.twoIdentical });
    assert.deepStrictEqual([both.status, both.devices.map((d) => d.id)], ['moved', ['Vulkan1', 'Vulkan0']]);
    // a bare id the build DOES list is kept as it always was, reference or not
    assert.deepStrictEqual(topo.resolveDevices([{ id: 'Vulkan1' }], VK_ONLY, { reference: T.twoIdentical }).kinds, ['kept']);
});

test('launchDevices / availability: the bare-id move is said in words and mapped for the draft device', () => {
    const l = topo.launchDevices([{ id: 'ROCm1' }], VK_ONLY, { reference: T.twoIdentical });
    assert.deepStrictEqual([l.status, l.devices[0].id, l.idMap], ['moved', 'Vulkan1', { ROCm1: 'Vulkan1' }]);
    assert.deepStrictEqual(l.warnings, ['ROCm1 is RX 7900 XTX #2 on this machine; this build reaches it as Vulkan1; using Vulkan1 (identical cards paired by listing order)']);
    assert.deepStrictEqual(topo.launchDevices([{ id: 'ROCm1' }], VK_ONLY).warnings, ['ROCm1 is not a device in this build']);
    const a = topo.availability({ devices: [{ id: 'ROCm1', share: 100 }] }, VK_ONLY, { reference: T.twoIdentical });
    assert.deepStrictEqual([a.status, a.placement], ['moved', 'RX 7900 XTX #2 alone']);
    assert.strictEqual(topo.availability({ devices: [{ id: 'ROCm1', share: 100 }] }, VK_ONLY).status, 'unavailable');
});

// --- POST /api/start's availability gate (2026-10-13) ---
test('launchGate: only a launch this machine cannot run is stopped, and never on a guess', () => {
    const t = T.twoIdentical;
    // runs as saved, re-pointed, or on a stand-in: not the gate's business
    assert.strictEqual(topo.launchGate({ devices: [{ id: 'ROCm0', name: XTX, share: 50 }, { id: 'ROCm1', name: XTX, share: 50 }] }, t), null);
    assert.strictEqual(topo.launchGate({ devices: [{ id: 'ROCm1', name: XTX }] }, VK_ONLY, { reference: t }), null, 'moved');
    assert.strictEqual(topo.launchGate({ devices: [{ id: 'ROCm0', name: XTX, share: 75 }, { id: 'CUDA0', name: R3060, vramMib: 12288, share: 25 }] }, t), null, 'substitute');
    // a card this machine does not have
    assert.deepStrictEqual(topo.launchGate({ devices: [{ id: 'CUDA0', name: R3060, share: 100 }] }, t), { status: 'unavailable', reason: 'Needs RTX 3060.' });
    // an id pinned in the extra arguments
    assert.match(topo.launchGate({ devices: [{ id: 'ROCm0', name: XTX }], argString: "-ot 'blk\\.(24|25)\\.ffn=CUDA0'" }, t).reason, /^Needs device CUDA0 \(named in its extra arguments\)\.$/);
    // the raw command is what runs: it is what is checked, whatever the structured fields beside it say
    const raw = '/b/llama-server -m /m/x.gguf -dev ROCm0,CUDA0 -ts 3,1 --port 8080';
    assert.deepStrictEqual(topo.launchGate({ rawCommand: raw, devices: [{ id: 'ROCm0', name: XTX }] }, t), { status: 'unavailable', reason: 'Needs device CUDA0 (named in its command).' });
    assert.strictEqual(topo.launchGate({ rawCommand: '/b/llama-server -m /m/x.gguf -dev ROCm0,ROCm1 --rpc 10.10.10.2:50052', devices: [{ id: 'CUDA0', name: R3060 }] }, t), null);
    assert.strictEqual(topo.launchGate({ rawCommand: '/x/Strata-0.1.43.1/queue-serve.sh /x/two-card.json --port 8080' }, t), null, 'an engine with its own launcher names no id');
    assert.strictEqual(topo.launchGate({ rawCommand: '/b/llama-server -m /m/x.gguf -dev none' }, t), null);
    // what a profile says it needs
    assert.match(topo.launchGate({ rawCommand: '/x/queue-serve.sh /x/c.json', needs: { hostRamMib: 96000 } }, t).reason, /^Needs 94 GB of memory \(this machine has 63\)\.$/);
    // an engine with its own launcher whose config lists two GPUs (server4.js withStrataNeeds -> needs.minCards), on one card
    assert.deepStrictEqual(topo.launchGate({ rawCommand: '/x/Strata-0.1.43.1/queue-serve.sh /x/two-card.json --port 8080', needs: { minCards: 2 } }, T.oneCard), { status: 'unavailable', reason: 'Needs 2 cards.' });
    assert.strictEqual(topo.launchGate({ rawCommand: '/x/Strata-0.1.43.1/queue-serve.sh /x/two-card.json --port 8080', needs: { minCards: 2 } }, t), null);
    assert.deepStrictEqual(topo.launchGate({ needs: { vendor: 'amd', minVramMib: 24000, minCards: 2 } }, T.oneCard), { status: 'unavailable', reason: 'Needs 2 AMD cards with 24 GB.' });
    // nothing known about this machine's cards: nothing is refused (the probe has not answered; a CPU-only machine)
    assert.strictEqual(topo.launchGate({ devices: [{ id: 'CUDA0', name: R3060 }] }, T.cpuOnly), null);
    assert.strictEqual(topo.launchGate({ rawCommand: raw }, null), null);
    assert.strictEqual(topo.launchGate(null, t), null);
});
