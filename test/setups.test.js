'use strict';
// The hardware setups this dashboard has really run on (TOPOLOGY.md "Setups this has run on"), each as a topology
// fixture, so lib/topology.js is exercised against every machine in the records and not only the one on the desk.
// A listing is either CAPTURED (copied from a record; the comment says which) or `// constructed:` (ids and names
// come from the records, but the --list-devices text itself was never saved: the comment says what it was inferred
// from). Pure: no binary is run, nothing is probed.
const test = require('node:test');
const assert = require('node:assert');
const topo = require('../lib/topology');

const XTX = 'AMD Radeon RX 7900 XTX', XTXV = 'AMD Radeon RX 7900 XTX (RADV NAVI31)', R3060 = 'NVIDIA GeForce RTX 3060';
const L4090 = 'NVIDIA GeForce RTX 4090 Laptop GPU', IRIS = 'Intel(R) Iris(R) Xe Graphics (RPL-P)';
const dev = (id, description, totalMib, freeMib) => ({ id, description, totalMib, freeMib: freeMib ?? totalMib - 500 });

const FIX = {
    // captured: test/devices.test.js DETECTED -- "what --list-devices reports on the desktop (CUDA+Vulkan build) as of
    // 2026-09-13". No ROCm in that build: the XTX is reachable through Vulkan only.
    desktop0913: [dev('CUDA0', R3060, 11906, 10794), dev('Vulkan0', R3060, 12288, 10794), dev('Vulkan1', XTXV, 24560, 24446)],
    // constructed: the same desktop as its CUDA+ROCm+Vulkan build lists it. Ids from HETERO-DEVICES-PLAN.md ("build-all
    // ... listing CUDA0/Vulkan0 (3060) and ROCm0/Vulkan1 (XTX)"); sizes from the 2026-09-13 capture; line order assumed.
    desktopXtx3060: [dev('CUDA0', R3060, 11906), dev('ROCm0', XTX, 24560), dev('Vulkan0', R3060, 12288), dev('Vulkan1', XTXV, 24560)],
    // constructed: two RX 7900 XTX since 2026-10-12. Ids from HANDOFF.md ("ROCm0 (0b:00.0) and ROCm1 (0e:00.0)") and the
    // /api/topology example in API.md; 24,560 MiB from the run database's machine record (machines.gpus_json vram_mib).
    desktopTwoXtx: [dev('ROCm0', XTX, 24560), dev('ROCm1', XTX, 24560), dev('Vulkan0', XTXV, 24560), dev('Vulkan1', XTXV, 24560)],
    // Laptop RTX 4090 + RX 7900 XTX in a Thunderbolt 4 enclosure (August 2026), CUDA+Vulkan build.
    // captured: the three Vulkan devices and their order, and CUDA0 = the 4090 at 15,943 MiB (logs/bench-history.log,
    // 2026-08-17: "0 = Intel(R) Iris(R) Xe Graphics (RPL-P)", "1 = NVIDIA GeForce RTX 4090 Laptop GPU", "2 = AMD Radeon RX
    // 7900 XTX (RADV NAVI31)", "Device 0: ... VRAM: 15943 MiB").
    // constructed: the Vulkan sizes (4090: 16,376 from the laptop's machine record; XTX: 24,560 as on the desktop) and
    // the integrated GPU's size, which no record holds -- a placeholder, nothing below depends on its value.
    laptopXtxEgpu: [dev('CUDA0', L4090, 15943), dev('Vulkan0', IRIS, 15000), dev('Vulkan1', L4090, 16376), dev('Vulkan2', XTXV, 24560)],
    // constructed: laptop RTX 4090 + RTX 3060 in the enclosure (2026-10-12), CUDA-only build. Ids from HANDOFF.md ("sees
    // CUDA0 = 4090, CUDA1 = eGPU 3060"); sizes are each card's CUDA size where it was captured (15,943 and 11,906 above).
    laptop3060Egpu: [dev('CUDA0', L4090, 15943), dev('CUDA1', R3060, 11906)],
    // constructed: the laptop on its own, as its queue lane ran it from 2026-10-06 (`-dev CUDA0`, a CUDA build).
    laptopAlone: [dev('CUDA0', L4090, 15943)],
    // constructed: the first setup (2026-07), two ThinkPad laptops joined by llama.cpp RPC -- this is the master's
    // listing. What is known: the records call its card "the 3080" (experiment-1/readme.md; "3080 Master Node" in the
    // dashboard's first commit) and the owner describes both laptops' cards as 16 GB NVIDIA laptop cards. The product
    // string and the exact MiB were never captured: this description is those two facts put together, the size is
    // nominal. The second line is the other laptop's card as the master's llama.cpp lists an RPC device (the format
    // of test/topology.test.js `withWorker`); its name and 16,376 MiB are the later machine record of that laptop.
    twoLaptops: [dev('CUDA0', 'NVIDIA GeForce RTX 3080 Laptop GPU', 16384), dev('RPC0', 'p1: NVIDIA GeForce RTX 4090 Laptop GPU', 16376)],
};
const DESKTOP_RAM = 64223, LAPTOP_RAM = 31744;   // 62.7 GiB and 31.0 GiB in the machine records
// dashboard.config.json `rpcWorkers.laptop`, as /api/topology lists it
const LAPTOP_WORKER = { name: 'laptop', ssh: 'laptop', port: 50052, devices: 'CUDA0', deviceCount: 1, cache: true, link: 'ssh' };
const build = (k, { ram = DESKTOP_RAM, workers = [] } = {}) => topo.build({ detected: FIX[k], hostRamMib: ram, workers });
const TWO_XTX = build('desktopTwoXtx');
// Queue lanes as their runners published them (queue_lanes.runtime_json; codebench tools/queue_runner.py device_lanes()
// and LANE_DEFAULTS). local-gpu publishes ports only; a one-card lane its id and card name (and ports, left out here:
// they are numbered by the lane's position among the cards present, so they changed with the hardware); the laptop
// lane a made-up device name, because its llama-server runs on the laptop.
const LANE = {
    gpu: { server_port: 18080, proxy_port: 8080, tap_port: 18090 },
    xtx: { devices: ['ROCm0'], gpu: XTX },
    r3060: { devices: ['CUDA0'], gpu: R3060 },
    rocm1: { devices: ['ROCm1'], gpu: XTX },
    laptop: { server_port: 18180, proxy_port: 18480, tap_port: 18190, devices: ['LAPTOP4090'], gpu: L4090 },
};

test('setup: desktop RX 7900 XTX + RTX 3060 (2026-09 to 2026-10-12)', () => {
    const cap = build('desktop0913'), t = build('desktopXtx3060');
    assert.strictEqual(t.signature, 'RTX 3060 12G + RX 7900 XTX 24G | 63G RAM');
    assert.deepStrictEqual(t.cards.map((c) => [c.label, c.vendor, c.ids.join(','), c.preferredId]),
        [['RTX 3060', 'nvidia', 'CUDA0,Vulkan0', 'CUDA0'], ['RX 7900 XTX', 'amd', 'ROCm0,Vulkan1', 'ROCm0']]);
    assert.ok(t.cards.every((c) => !c.orderAssumed), 'two different cards: nothing had to be paired by order');
    // the captured CUDA+Vulkan listing: same two cards, the XTX through Vulkan only
    assert.deepStrictEqual(cap.cards.map((c) => [c.label, c.ids.join(','), c.preferredId]), [['RTX 3060', 'CUDA0,Vulkan0', 'CUDA0'], ['RX 7900 XTX', 'Vulkan1', 'Vulkan1']]);
    // the launches it ran: the 27B split 3:1 and 5:1, each card alone
    assert.strictEqual(topo.placementLabel([{ id: 'ROCm0', share: 75 }, { id: 'CUDA0', share: 25 }], t), 'RX 7900 XTX + RTX 3060, 3:1');
    assert.strictEqual(topo.placementLabel([{ id: 'ROCm0', share: 5 }, { id: 'CUDA0', share: 1 }], t), 'RX 7900 XTX + RTX 3060, 5:1');
    assert.strictEqual(topo.placementLabel([{ id: 'ROCm0', share: 100 }], t), 'RX 7900 XTX alone');
    assert.strictEqual(topo.placementLabel([{ id: 'CUDA0', share: 100 }], t), 'RTX 3060 alone');
    // a saved profile of this setup ("bench · Ornith-1.5-35B Q4_K_M · 64k · KV f16 · MTP (benchmark config)", logs/profiles.json)
    const split = { devices: [{ id: 'ROCm0', name: XTX, share: 75 }, { id: 'CUDA0', name: R3060, share: 25 }], specDraftDevice: 'ROCm0' };
    const here = topo.availability(split, t);
    assert.strictEqual(here.status, 'ready');
    assert.strictEqual(here.placement, 'RX 7900 XTX + RTX 3060, 3:1');
    // ... on today's two-XTX desktop: it needs the card that left
    const now = topo.availability(split, TWO_XTX);
    assert.strictEqual(now.status, 'unavailable');
    assert.match(now.reason, /RTX 3060/);
    // lanes: one that takes anything, one per card
    assert.deepStrictEqual(topo.laneCards('local-gpu', LANE.gpu, t).cards.length, 2);
    assert.strictEqual(topo.laneCards('local-xtx', LANE.xtx, t).label, 'RX 7900 XTX');
    assert.strictEqual(topo.laneCards('local-3060', LANE.r3060, t).label, 'RTX 3060');
    assert.strictEqual(topo.laneCards('cloud', {}, t).here, null, 'the cloud lane says nothing about cards');
});

test('setup: desktop XTX + 3060 -- a bare id follows the id, a named device follows its card', () => {
    // HETERO-DEVICES-PLAN.md, 2026-09-13: the XTX "was Vulkan0 -- saved profiles now point at the wrong card". On the
    // laptop rig the XTX was Vulkan2; in the desktop's CUDA+Vulkan build Vulkan0 is the 3060 and the XTX is Vulkan1.
    const cap = build('desktop0913', { workers: [LAPTOP_WORKER] });
    assert.strictEqual(topo.cardOfId(cap, 'Vulkan0').label, 'RTX 3060');
    // the old two-field profile shape, converted (lib/devices.js legacyToDevices): ids only, no card names
    const bare = topo.availability({ devices: [{ id: 'Vulkan0', share: 60 }, { worker: 'laptop', share: 40 }] }, cap);
    assert.strictEqual(bare.status, 'ready', 'nothing tells it the id means another card now');
    assert.match(bare.placement, /^RTX 3060 \+ laptop \(RPC\)/);
    // the same profile saved with its card's name is re-pointed
    const named = topo.availability({ devices: [{ id: 'Vulkan0', name: XTXV, share: 60 }, { worker: 'laptop', share: 40 }] }, cap);
    assert.strictEqual(named.status, 'moved');
    assert.strictEqual(named.devices[0].id, 'Vulkan1');
    // the laptop rig's daily profile (CUDA0 + Vulkan2, ids only): Vulkan2 is no device here
    const old = topo.availability({ devices: [{ id: 'CUDA0', share: 40 }, { id: 'Vulkan2', share: 60 }] }, cap);
    assert.strictEqual(old.status, 'unavailable');
    assert.match(old.reason, /Vulkan2/);
});

test('setup: desktop with two RX 7900 XTX (since 2026-10-12)', () => {
    const t = TWO_XTX;
    assert.strictEqual(t.signature, '2x RX 7900 XTX 24G | 63G RAM');
    assert.deepStrictEqual(t.cards.map((c) => [c.label, c.ids.join(','), c.preferredId]), [['RX 7900 XTX #1', 'ROCm0,Vulkan0', 'ROCm0'], ['RX 7900 XTX #2', 'ROCm1,Vulkan1', 'ROCm1']]);
    assert.ok(t.cards.every((c) => c.orderAssumed), 'which Vulkan id is which ROCm id is paired by listing order');
    // the launches it ran: each card alone, both by layer or by tensor (the split mode is not part of the placement)
    assert.strictEqual(topo.placementLabel([{ id: 'ROCm0', share: 100 }], t), 'RX 7900 XTX #1 alone');
    assert.strictEqual(topo.placementLabel([{ id: 'ROCm1', share: 100 }], t), 'RX 7900 XTX #2 alone');
    assert.strictEqual(topo.placementLabel([{ id: 'ROCm0', share: 50 }, { id: 'ROCm1', share: 50 }], t), '2x RX 7900 XTX, 1:1');
    // "opt · Qwen3.8-27B UD-Q4_K_XL · 128k · KV q8_0 · MTP · tensor split (2 cards, experimental)" (logs/profiles.json)
    const tensor = { build: 'moecache', splitMode: 'tensor', specDraftDevice: 'ROCm0',
        devices: [{ id: 'ROCm0', name: XTX, vramMib: 24560, share: 50 }, { id: 'ROCm1', name: XTX, vramMib: 24560, share: 50 }] };
    assert.strictEqual(topo.availability(tensor, t).status, 'ready');
    // ... on the desktop as it was a day earlier: one XTX, and the 12 GB card cannot stand in for a 24 GB one
    const before = topo.availability(tensor, build('desktopXtx3060'));
    assert.strictEqual(before.status, 'unavailable');
    assert.match(before.reason, /RX 7900 XTX/);
    // the two-card Strata profile says what it needs instead of naming devices
    const strata2 = { engine: 'strata', needs: { vendor: 'amd', minVramMib: 24000, minCards: 2, hostRamMib: 47000 } };
    assert.strictEqual(topo.availability(strata2, t).status, 'ready');
    assert.match(topo.availability(strata2, build('desktopXtx3060')).reason, /2 AMD cards/);
    const onLaptop = topo.availability(strata2, build('laptop3060Egpu', { ram: LAPTOP_RAM }));
    assert.strictEqual(onLaptop.status, 'unavailable');
    assert.match(onLaptop.reason, /memory/);
    // lanes as they stand: both cards, the second card's own lane, the first card's (paused), and the lane of a card
    // that is gone -- its runner is stopped and publishes nothing ({}), so the lane says nothing about cards
    assert.strictEqual(topo.laneCards('local-gpu', LANE.gpu, t).label, '2x RX 7900 XTX');
    assert.deepStrictEqual(topo.laneCards('local-rocm1', LANE.rocm1, t).cards, [t.cards[1].key]);
    assert.strictEqual(topo.laneCards('local-xtx', LANE.xtx, t).label, 'RX 7900 XTX #1');
    assert.strictEqual(topo.laneCards('local-3060', {}, t).here, null);
    const stale = topo.laneCards('local-3060', LANE.r3060, t);   // had its runner still published the old card
    assert.strictEqual(stale.here, false);
    assert.strictEqual(stale.label, 'RTX 3060');
});

test('setup: laptop RTX 4090 + RX 7900 XTX in a Thunderbolt 4 enclosure (2026-08)', () => {
    const t = build('laptopXtxEgpu', { ram: LAPTOP_RAM });
    // the integrated GPU is listed by Vulkan, so it is a card of this machine too
    assert.deepStrictEqual(t.cards.map((c) => [c.label, c.vendor, c.ids.join(','), c.preferredId]),
        [['RTX 4090 Laptop', 'nvidia', 'CUDA0,Vulkan1', 'CUDA0'], ['Iris Xe', 'other', 'Vulkan0', 'Vulkan0'], ['RX 7900 XTX', 'amd', 'Vulkan2', 'Vulkan2']]);
    assert.match(t.signature, /^RTX 4090 Laptop 16G \+ Iris Xe \d+G \+ RX 7900 XTX 24G \| 31G RAM$/);
    // the daily launch (`-dev CUDA0,Vulkan2 -ts 40,60`) and the all-Vulkan one it was measured against
    assert.strictEqual(topo.placementLabel([{ id: 'CUDA0', share: 40 }, { id: 'Vulkan2', share: 60 }], t), 'RTX 4090 Laptop + RX 7900 XTX, 2:3');
    assert.strictEqual(topo.placementLabel([{ id: 'Vulkan1', share: 40 }, { id: 'Vulkan2', share: 60 }], t), 'RTX 4090 Laptop + RX 7900 XTX, 2:3');
    assert.strictEqual(topo.cardOfId(t, 'Vulkan1').key, topo.cardOfId(t, 'CUDA0').key);
    // its profile as saved then (ids only: API.md's example profile, bench-tools/depth_sweep.py)
    const bare = { devices: [{ id: 'CUDA0', share: 40 }, { id: 'Vulkan2', share: 60 }] };
    assert.strictEqual(topo.availability(bare, t).status, 'ready');
    const gone = topo.availability(bare, TWO_XTX);
    assert.strictEqual(gone.status, 'unavailable');
    assert.match(gone.reason, /CUDA0/);
    // ... saved the way the web UI saves today (card names and sizes): two cards at least as big stand in
    const named = { devices: [{ id: 'CUDA0', name: L4090, vramMib: 15943, share: 40 }, { id: 'Vulkan2', name: XTXV, vramMib: 24560, share: 60 }] };
    const sub = topo.availability(named, TWO_XTX);
    assert.strictEqual(sub.status, 'substitute');
    assert.match(sub.reason, /RTX 4090 Laptop is not in this machine/);
    assert.match(sub.reason, /Not validated/);
    assert.strictEqual(new Set(sub.devices.map((d) => topo.cardOfId(TWO_XTX, d.id).key)).size, 2, 'one card each');
    // the other way round: a desktop XTX-only profile opened on this rig follows the card to its Vulkan id
    const xtxOnly = topo.availability({ devices: [{ id: 'ROCm0', name: XTX, vramMib: 24560, share: 100 }] }, t);
    assert.strictEqual(xtxOnly.status, 'moved');
    assert.strictEqual(xtxOnly.devices[0].id, 'Vulkan2');
    assert.strictEqual(xtxOnly.placement, 'RX 7900 XTX alone');
});

test('setup: laptop RTX 4090 + RTX 3060 in the Thunderbolt 4 enclosure (2026-10-12)', () => {
    const t = build('laptop3060Egpu', { ram: LAPTOP_RAM });
    assert.strictEqual(t.signature, 'RTX 4090 Laptop 16G + RTX 3060 12G | 31G RAM');
    assert.deepStrictEqual(t.cards.map((c) => [c.label, c.ids.join(',')]), [['RTX 4090 Laptop', 'CUDA0'], ['RTX 3060', 'CUDA1']]);
    // `-ts 5,4` did not fit (the 3060 was 714 MiB short); `-ts 2,1` is what ran
    assert.strictEqual(topo.placementLabel([{ id: 'CUDA0', share: 5 }, { id: 'CUDA1', share: 4 }], t), 'RTX 4090 Laptop + RTX 3060, 5:4');
    assert.strictEqual(topo.placementLabel([{ id: 'CUDA0', share: 2 }, { id: 'CUDA1', share: 1 }], t), 'RTX 4090 Laptop + RTX 3060, 2:1');
    const two = { devices: [{ id: 'CUDA0', name: L4090, share: 2 }, { id: 'CUDA1', name: R3060, share: 1 }], specDraftDevice: 'CUDA0' };
    assert.strictEqual(topo.availability(two, t).status, 'ready');
    const onDesktop = topo.availability(two, TWO_XTX);
    assert.strictEqual(onDesktop.status, 'unavailable');
    assert.match(onDesktop.reason, /RTX 4090 Laptop/);
    assert.match(onDesktop.reason, /RTX 3060/);
    // the same RTX 3060 was CUDA0 in the desktop and is CUDA1 here: a 3060-only profile from the desktop is re-pointed
    const moved = topo.availability({ devices: [{ id: 'CUDA0', name: R3060, share: 100 }], specDraftDevice: 'CUDA0' }, t);
    assert.strictEqual(moved.status, 'moved');
    assert.strictEqual(moved.devices[0].id, 'CUDA1');
    // it ran as the desktop's remote lane; the lane publishes ONE card name, so the enclosure's card is not shown
    const lane = topo.laneCards('laptop-4090', LANE.laptop, TWO_XTX);
    assert.deepStrictEqual(lane, { label: 'RTX 4090 Laptop', here: false, remote: true, cards: [] });
});

test('setup: desktop + the laptop RTX 4090 as a llama.cpp RPC worker (Wi-Fi 2026-09-14, direct 1 GbE 2026-09-26)', () => {
    // constructed: the RPC0 line (format as test/topology.test.js `withWorker`); with `--rpc` first, --list-devices adds it
    const t = topo.build({ detected: [...FIX.desktopXtx3060, dev('RPC0', `laptop: ${L4090}`, 16376)], hostRamMib: DESKTOP_RAM, workers: [LAPTOP_WORKER] });
    assert.strictEqual(t.cards.length, 2, 'the worker\'s card is another machine\'s: not one of this machine\'s cards');
    assert.strictEqual(t.signature, 'RTX 3060 12G + RX 7900 XTX 24G | 63G RAM', 'nor part of the machine\'s signature');
    assert.deepStrictEqual(t.workers.map((w) => [w.name, w.devices, w.link]), [['laptop', 'CUDA0', 'ssh']]);
    assert.strictEqual(topo.cardOfId(t, 'RPC0'), null);
    assert.strictEqual(topo.cardKeysOf(t, ['ROCm0', 'RPC0']).size, 1, 'a launch on the XTX and the worker holds one local card');
    // README.md's three-device example: `-dev Vulkan1,RPC0,CUDA0 -ts 50,30,20`
    const three = { devices: [{ id: 'Vulkan1', name: XTX, share: 50 }, { worker: 'laptop', share: 30 }, { id: 'CUDA0', name: R3060, share: 20 }] };
    const a = topo.availability(three, t);
    assert.strictEqual(a.status, 'ready');
    assert.strictEqual(a.placement, 'RX 7900 XTX + laptop (RPC) + RTX 3060, 5:3:2');
    // a machine without that worker configured cannot run it, whatever its cards
    const noWorker = topo.availability({ devices: [{ id: 'ROCm0', name: XTX, share: 60 }, { worker: 'laptop', share: 40 }] }, TWO_XTX);
    assert.strictEqual(noWorker.status, 'unavailable');
    assert.match(noWorker.reason, /RPC worker "laptop"/);
    // today's desktop still has the worker in its config: the XTX + worker profile runs, the three-device one does not
    const today = topo.build({ detected: FIX.desktopTwoXtx, hostRamMib: DESKTOP_RAM, workers: [LAPTOP_WORKER] });
    assert.strictEqual(topo.availability({ devices: [{ id: 'ROCm0', name: XTX, share: 60 }, { worker: 'laptop', share: 40 }] }, today).placement, 'RX 7900 XTX #1 + laptop (RPC), 3:2');
    assert.match(topo.availability(three, today).reason, /RTX 3060/);
});

test('setup: the laptop as a remote queue lane over ssh (laptop-4090, since 2026-10-06)', () => {
    // On the desktop the lane is another machine's card, in either era of the desktop.
    for (const k of ['desktopXtx3060', 'desktopTwoXtx']) {
        const lane = topo.laneCards('laptop-4090', LANE.laptop, build(k));
        assert.deepStrictEqual(lane, { label: 'RTX 4090 Laptop', here: false, remote: true, cards: [] }, k);
    }
    // The lane's launch is written in the LAPTOP's terms (`-dev CUDA0` = its 4090). On the old desktop CUDA0 was the 3060:
    // only the card's name keeps such a config from landing on the wrong card.
    const laptop = build('laptopAlone', { ram: LAPTOP_RAM });
    assert.strictEqual(laptop.signature, 'RTX 4090 Laptop 16G | 31G RAM');
    assert.strictEqual(topo.placementLabel([{ id: 'CUDA0' }], laptop), 'RTX 4090 Laptop alone');
    const desk = build('desktopXtx3060');
    assert.strictEqual(topo.cardOfId(desk, 'CUDA0').label, 'RTX 3060');
    const laneCfg = { devices: [{ id: 'CUDA0', name: L4090, share: 100 }], specDraftDevice: 'CUDA0' };
    assert.strictEqual(topo.availability(laneCfg, laptop).status, 'ready');
    const onDesk = topo.availability(laneCfg, desk);
    assert.strictEqual(onDesk.status, 'unavailable', 'CUDA0 exists there, but it is another card');
    assert.match(onDesk.reason, /RTX 4090 Laptop/);
    // with the card's size saved, the 24 GB card is offered in its place -- never the 12 GB one
    const sized = topo.availability({ devices: [{ ...laneCfg.devices[0], vramMib: 15943 }] }, desk);
    assert.strictEqual(sized.status, 'substitute');
    assert.strictEqual(topo.cardOfId(desk, sized.devices[0].id).label, 'RX 7900 XTX');
});

test('setup: two laptops over llama.cpp RPC (2026-07; Wi-Fi, then a direct Thunderbolt cable): one local card and a worker', () => {
    // The master laptop's own 16 GB card plus the other laptop's 16 GB card as a worker; the split was
    // `--tensor-split 1,1` (experiment-1/docker-compose.master.yml). The worker had no name then: 'p1' is this
    // fixture's. Host memory is not in the records, so the signature carries none.
    const t = topo.build({ detected: FIX.twoLaptops, hostRamMib: null, workers: [{ name: 'p1', port: 50052, devices: 'CUDA0' }] });
    assert.strictEqual(t.cards.length, 1, 'the other machine\'s card is a worker, never one of this machine\'s cards');
    assert.deepStrictEqual([t.cards[0].label, t.cards[0].vendor, t.cards[0].ids, Math.round(t.cards[0].vramMib / 1024)], ['RTX 3080 Laptop', 'nvidia', ['CUDA0'], 16]);
    assert.deepStrictEqual(t.workers.map((w) => w.name), ['p1']);
    assert.strictEqual(t.signature, 'RTX 3080 Laptop 16G');
    // the link (Wi-Fi or the cable) is not part of the model: both are the same topology
    const cfg = { devices: [{ id: 'CUDA0', name: 'NVIDIA GeForce RTX 3080 Laptop GPU', vramMib: 16384, share: 1 }, { worker: 'p1', share: 1 }] };
    const here = topo.availability(cfg, t);
    assert.deepStrictEqual([here.status, here.placement], ['ready', 'RTX 3080 Laptop + p1 (RPC), 1:1']);
    // on today's desktop: no such worker, whatever card stands in for the local one
    const desk = topo.availability(cfg, TWO_XTX);
    assert.strictEqual(desk.status, 'unavailable');
    assert.match(desk.reason, /RPC worker "p1"/);
    // with the worker configured there too, the 16 GB card is stood in for by a 24 GB one, not validated
    const withWorker = topo.build({ detected: FIX.desktopTwoXtx, hostRamMib: DESKTOP_RAM, workers: [{ name: 'p1' }] });
    assert.strictEqual(topo.availability(cfg, withWorker).status, 'substitute');
});
