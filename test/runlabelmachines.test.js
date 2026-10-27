'use strict';
// A run's device ids are named from the machine THAT RUN was recorded on (2026-10-13).
//
// The bug this pins: `-dev CUDA0` is the RTX 4090 on the laptop (the `laptop-4090` queue lane) and was the RTX 3060 on
// the desktop on the same day. The Models catalog's speed labels (lib/models.js prefillCurve) described each launch
// command with no machine at all, so lib/runlabel.js fell through to this machine's names: every laptop run read
// "RTX 3060 only" and the laptop's RTX 4090 + RTX 3060 run read "2x RTX 3060 (split 2:1)", on the lab page and on the
// public site.
//
// Every fixture is a real record: the launch commands are rows of `requests.launch_command`, the machines are rows of
// the `machines` table (gpus reduced to vendor / name / vram_mib, the fields naming reads), the device lists are
// `requests.devices_json` reduced to { id: name }. Pure: no database, no binary, no probe.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

// this file's own database, before lib/db.js is first required (node --test runs each file in its own process)
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'runlabel-machines-'));
process.env.BENCH_DB = path.join(TMP, 'bench.sqlite');
delete process.env.BENCH_DB_READONLY;
test.after(() => { try { require('../lib/db').open().close(); } catch { /* never opened */ } fs.rmSync(TMP, { recursive: true, force: true }); });

const R = require('../lib/runlabel.js');
const M = require('../lib/models.js');
const C = require('../lib/codebench.js');

// ---- the machines (table `machines`) ----
const AMD_744C = 'Advanced Micro Devices, Inc. [AMD/ATI] Device 744c (rev c8)';   // how the harness records an RX 7900 XTX
const amd = () => ({ vendor: 'amd', name: AMD_744C, vram_mib: 24560 });
const r3060 = () => ({ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 3060', vram_mib: 12288 });
const l4090 = () => ({ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4090 Laptop GPU', vram_mib: 16376 });
const iris = () => ({ vendor: 'intel', name: 'Intel Corporation Raptor Lake-P [Iris Xe Graphics] (rev 04)', vram_mib: null });
const MACHINES = {
    // desktop, RX 7900 XTX + RTX 3060 (2026-09-13 to 2026-10-12)
    oldDesktop: { fingerprint: 'f0d34a510784349f', host: 'pop-os', gpus: [amd(), r3060()] },
    oldDesktopSept: { fingerprint: 'faf75993a056464a', host: 'pop-os', gpus: [amd(), r3060()] },
    // desktop, two RX 7900 XTX (since 2026-10-12)
    newDesktop: { fingerprint: 'cc155498840fc883', host: 'pop-os', gpus: [amd(), amd()] },
    // laptop, RTX 4090 alone (the laptop-4090 lane from 2026-10-06)
    laptop: { fingerprint: '41838718a278f4c4', host: 'laptop', gpus: [iris(), l4090()], source: 'run.py over ssh (laptop-4090 lane)' },
    // laptop, RTX 4090 + the RTX 3060 in an enclosure (2026-10-12)
    laptopPlus3060: { fingerprint: '29d5272fe98f39cb', host: 'laptop', gpus: [iris(), l4090(), r3060()], source: 'run.py over ssh (laptop-4090 lane)' },
};

// ---- the launches (table `requests`, column launch_command) ----
const HF = '/home/kyle/.cache/huggingface/hub/models--unsloth--Qwen3.8-27B-GGUF/snapshots/4ca720788d1e01f1bff70c033e0d0028fd02e502';
const CMD = {
    // (a) laptop, RTX 4090 alone
    laptop4090: '/home/kyle-4090/llama-lane/llama.cpp/build-cuda/bin/llama-server -m /home/kyle-4090/llama-lane/models/Qwen3.8-27B-GSQ-RCO/Qwen3.8-27B-GSQ-RCO-IQ3_XXS-mtp-f32ssm.gguf -c 131072 -ngl 999 -fa on -np 1 --jinja --spec-type draft-mtp --spec-draft-n-max 2 -devd CUDA0 --cache-type-k q4_0 --cache-type-v q4_0 -ctkd q4_0 -ctvd q4_0 -dev CUDA0 --port 18180 --host 127.0.0.1',
    // (a) ... and alone while the RTX 3060 was plugged in too (2026-10-12 21:02)
    laptop4090Q2: '/home/kyle-4090/llama-lane/llama.cpp/build-cuda/bin/llama-server -m /home/kyle-4090/llama-lane/models/Qwen3.8-27B-UD/Qwen3.8-27B-UD-Q2_K_XL.gguf -c 65536 -ngl 999 -fa on -np 1 --jinja --spec-type draft-mtp,ngram-mod --spec-draft-n-max 2 --cache-type-k q4_0 --cache-type-v q4_0 -devd CUDA0 -dev CUDA0 --port 18180 --host 127.0.0.1',
    // (b) laptop, RTX 4090 + RTX 3060, split 2:1
    laptopSplit: '/home/kyle-4090/llama-rpc/moecache-06cad0b/bin/llama-server -m /home/kyle-4090/llama-lane/models/Qwen3.8-27B-UD/Qwen3.8-27B-UD-Q4_K_XL.gguf -c 131072 -ngl 999 -fa on -np 1 --jinja --spec-type draft-mtp,ngram-mod --spec-draft-n-max 2 --cache-type-k q8_0 --cache-type-v q8_0 -devd CUDA0 -dev CUDA0,CUDA1 -ts 2,1 --port 18180 --host 127.0.0.1',
    // (c) old desktop: both cards 3:1, the RTX 3060 alone, the XTX alone
    desktopSplit: '/home/kyle/AI/llama-official/llama.cpp/build-all/bin/llama-server -m /data/models/Ornith-1.5-35B-A3B/Ornith-1.5-35B-Q4_K_M.gguf -c 65536 -ngl 999 -fa on -np 1 --jinja -dev ROCm0,CUDA0 -ts 3,1 --cache-type-k f16 --cache-type-v f16 --spec-type draft-mtp --spec-draft-n-max 2 -devd ROCm0 --port 18080',
    desktop3060: '/home/kyle/AI/llama-official/llama.cpp/build-all/bin/llama-server -m /data/models/Qwen3.8-27B-GSQ-RCO/Qwen3.8-27B-GSQ-RCO-IQ2_XS-mtp-f32ssm.gguf -c 81920 -ngl 999 -fa on -np 1 --jinja --spec-type draft-mtp --spec-draft-n-max 2 -devd CUDA0 --cache-type-k q4_0 --cache-type-v q4_0 -ctkd q4_0 -ctvd q4_0 -dev CUDA0 --port 18081',
    // the same command ran on the old desktop (2026-10-09) and on the new one (2026-10-12): one launch config
    desktopXtx: `/home/kyle/AI/llama-official/llama.cpp/build-all/bin/llama-server -m ${HF}/Qwen3.8-27B-UD-Q4_K_XL.gguf -c 131072 -ngl 999 -fa on -np 1 --jinja --spec-type draft-mtp,ngram-mod --spec-draft-n-max 2 -devd ROCm0 -dev ROCm0 --cache-type-k q8_0 --cache-type-v q8_0 --port 18080`,
    // (d) new desktop: both XTX by tensor, the second XTX alone
    twoXtxTensor: `/home/kyle/AI/llama-official/llama.cpp-moecache/build-all/bin/llama-server -m ${HF}/Qwen3.8-27B-UD-Q4_K_XL.gguf -c 131072 -ngl 999 -fa on -np 1 --jinja --spec-type draft-mtp,ngram-mod --spec-draft-n-max 2 -devd ROCm0 -dev ROCm0,ROCm1 -sm tensor --cache-type-k q8_0 --cache-type-v q8_0 --port 18080`,
    secondXtx: '/home/kyle/AI/llama-official/llama.cpp/build-all/bin/llama-server -m /data/models/Terse-Coder-27B/Qwen3.8-27b-Terse-Coder.Q5_K_S.gguf -c 131072 -ngl 999 -fa on -np 1 --jinja --spec-type draft-mtp,ngram-mod --spec-draft-n-max 2 -devd ROCm1 -dev ROCm1 --cache-type-k q4_0 --cache-type-v q4_0 --port 18082',
    // (e) no machine record (csv-import rows, September): with a device list, with half of one, with none
    csvSplit: "/home/kyle/AI/llama-official/llama.cpp/build-all/bin/llama-server -m /home/kyle/.cache/huggingface/hub/models--unsloth--Qwen3.8-27B-GGUF/snapshots/27af057ecb382ddfea5d12837360a8980560e3ed/Qwen3.8-27B-UD-Q6_K_XL.gguf -c 196608 -ngl 999 --host 127.0.0.1 --port 8080 --metrics -fa on --cache-type-k q8_0 --cache-type-v q8_0 --spec-type draft-mtp --spec-draft-n-max 2 -np 1 --spec-draft-device ROCm0 --reasoning-preserve --split-mode layer -dev 'ROCm0,CUDA0' -ts '75,25' --jinja",
    csvVulkan: "/home/kyle/AI/llama-official/llama.cpp/build-next/bin/llama-server -m /home/kyle/AI/experiment-1/models/Qwen3.8-Flash-Next-UD-Q2_K_XL-00001-of-00003.gguf -ngl 999 -fa on --cache-type-k q8_0 --cache-type-v q8_0 -np 1 --jinja -dev 'Vulkan0,CUDA0' --load-mode none -ot 'blk.(17|18|19).ffn_(up|down|gate)_exps=CUDA0' -ncmoe 20 -ts '40,8' -c 65536 --port 8080",
    csvBare: "/home/kyle/AI/llama-official/llama.cpp/build-all/bin/llama-server -m /home/kyle/.cache/huggingface/hub/models--unsloth--Qwen3.8-27B-GGUF/snapshots/27af057ecb382ddfea5d12837360a8980560e3ed/Qwen3.8-27B-UD-Q6_K_XL.gguf -c 65536 -fa on -ngl 999 -np 1 --jinja -dev 'ROCm0,CUDA0' -ts '3,1' --spec-type draft-mtp --spec-draft-n-max 2 -devd ROCm0 --cache-type-k f16 --cache-type-v f16 --port 8080",
};
// ---- what a request listed for its devices (requests.devices_json -> { id: name }, lib/db.js readRequestDeviceNames) ----
const NAMED = {
    csvSplit: { ROCm0: 'AMD Radeon RX 7900 XTX', CUDA0: 'NVIDIA GeForce RTX 3060' },
    csvVulkan: { Vulkan0: 'AMD Radeon RX 7900 XTX', CUDA0: 'NVIDIA GeForce RTX 3060' },
    csvHalf: { CUDA0: 'NVIDIA GeForce RTX 3060' },   // 2026-09-22: ROCm0 was listed with name null
};

// ---- the two readers ----
// The desktop today: two RX 7900 XTX, no NVIDIA card. Its config still names the cards recorded runs used.
const DESKTOP_NAMES = { CUDA: 'NVIDIA GeForce RTX 3060', ROCm: 'AMD Radeon RX 7900 XTX' };   // dashboard.config.json deviceNames
const TWO_XTX = [{ id: 'ROCm0', description: 'AMD Radeon RX 7900 XTX', totalMib: 24560 }, { id: 'ROCm1', description: 'AMD Radeon RX 7900 XTX', totalMib: 24560 },
    { id: 'Vulkan0', description: 'AMD Radeon RX 7900 XTX (RADV NAVI31)', totalMib: 24560 }, { id: 'Vulkan1', description: 'AMD Radeon RX 7900 XTX (RADV NAVI31)', totalMib: 24560 }];
// the public site's process: no device list, names from the config file; the lab dashboard: its cached listing too
const asPublic = () => R.configure({ cardNames: DESKTOP_NAMES, configFile: null, host: 'pop-os' });
const asLab = () => R.configure({ cardNames: DESKTOP_NAMES, detected: () => TWO_XTX, configFile: null, host: 'pop-os' });
const READERS = [['public site', asPublic], ['lab dashboard', asLab]];
test.afterEach(() => R.configure({ configFile: null }));

const label = (cmd, machine, extra) => R.describeRun({}, { launch_command: cmd, machine: machine || undefined, ...(extra || {}) }).devices.label;

for (const [who, setUp] of READERS) {
    test(`(a) laptop RTX 4090 alone is the laptop's RTX 4090, never this machine's CUDA card [${who}]`, () => {
        setUp();
        assert.equal(label(CMD.laptop4090, MACHINES.laptop), 'laptop: RTX 4090 Laptop only');
        // the same `-dev CUDA0` while the RTX 3060 was in the enclosure: still one card, and still the 4090
        assert.equal(label(CMD.laptop4090Q2, MACHINES.laptopPlus3060), 'laptop: RTX 4090 Laptop only');
        // a result JSON says `remote` too (harness/run.py); a logged request has the machine alone. Same answer.
        const d = R.describeRun({ runner: 'opencode' }, { launch_command: CMD.laptop4090Q2, n_ctx: 65536, devices: 'CUDA0', remote: { lane: 'laptop-4090' }, machine: MACHINES.laptopPlus3060 });
        assert.equal(d.devices.label, 'laptop: RTX 4090 Laptop only');
        assert.deepEqual(d.devices.names, ['RTX 4090 Laptop']); assert.equal(d.devices.machine, 'laptop');
        assert.ok(!/3060/.test(d.line), d.line);
    });

    test(`(b) laptop RTX 4090 + RTX 3060 split reads as those two cards in -dev order, not "2x RTX 3060" [${who}]`, () => {
        setUp();
        assert.equal(label(CMD.laptopSplit, MACHINES.laptopPlus3060), 'laptop: RTX 4090 Laptop + RTX 3060 (split 2:1)');
        assert.equal(label(CMD.laptopSplit, MACHINES.laptopPlus3060, { remote: { lane: 'laptop-4090' } }), 'laptop: RTX 4090 Laptop + RTX 3060 (split 2:1)');
    });

    test(`(c) old desktop RX 7900 XTX + RTX 3060: its CUDA0 is the RTX 3060, its one XTX has no number [${who}]`, () => {
        setUp();
        assert.equal(label(CMD.desktopSplit, MACHINES.oldDesktopSept), 'RX 7900 XTX + RTX 3060 (split 3:1)');
        assert.equal(label(CMD.desktop3060, MACHINES.oldDesktop), 'RTX 3060 only');
        assert.equal(label(CMD.desktopXtx, MACHINES.oldDesktop), 'RX 7900 XTX only');
    });

    test(`(d) new desktop, two RX 7900 XTX: both by tensor are "2x", one of them is numbered from its own record [${who}]`, () => {
        setUp();
        assert.equal(label(CMD.twoXtxTensor, MACHINES.newDesktop), '2x RX 7900 XTX');
        assert.equal(label(CMD.secondXtx, MACHINES.newDesktop), 'RX 7900 XTX #2 only');
        assert.equal(label(CMD.desktopXtx, MACHINES.newDesktop), 'RX 7900 XTX #1 only');
        assert.equal(label(CMD.twoXtxTensor.replace('-sm tensor', '-ts 1,1'), MACHINES.newDesktop), '2x RX 7900 XTX (split 1:1)');
    });
}

test('(e) no machine record: read as before -- this machine\'s names -- unless the record itself names the device', () => {
    // nothing recorded at all: today's behaviour, on both readers
    asPublic();
    assert.equal(label(CMD.csvBare), 'RX 7900 XTX + RTX 3060 (split 3:1)');
    assert.equal(label(CMD.csvVulkan), 'Vulkan0 + RTX 3060 (split 40:8), 20 MoE layers on CPU', 'an id nothing names stays the id');
    assert.equal(label(CMD.laptop4090), 'RTX 3060 only', 'a row with no record at all is still read as this machine\'s own');
    asLab();
    assert.equal(label(CMD.csvBare), 'RX 7900 XTX #1 + RTX 3060 (split 3:1)');
    assert.equal(label(CMD.desktopXtx), 'RX 7900 XTX #1 only');
    // the request's own device list names its ids -- Vulkan included -- and is not numbered from this machine
    for (const [, setUp] of READERS) {
        setUp();
        assert.equal(label(CMD.csvSplit, null, { device_names: NAMED.csvSplit }), 'RX 7900 XTX + RTX 3060 (split 75:25)');
        assert.equal(label(CMD.csvVulkan, null, { device_names: NAMED.csvVulkan }), 'RX 7900 XTX + RTX 3060 (split 40:8), 20 MoE layers on CPU');
        // half a list (ROCm0 listed with no name): the listed RTX 3060 is a card this machine does not have, so this
        // machine's listing does not speak for ROCm0 either -- its name is the configured one, with no "#1"
        assert.equal(label(CMD.csvBare, null, { device_names: NAMED.csvHalf }), 'RX 7900 XTX + RTX 3060 (split 3:1)');
    }
    // ... and a device list that says the id was ANOTHER card than this machine's wins over this machine's listing
    asLab();
    assert.equal(label('llama-server -m x-Q4_K_M.gguf -dev Vulkan0', null, { device_names: { Vulkan0: 'NVIDIA GeForce RTX 3060' } }), 'RTX 3060 only');
    assert.equal(label('llama-server -m x-Q4_K_M.gguf -dev Vulkan0'), 'RX 7900 XTX #1 only', 'with no record at all: as before');
});

test('a record never borrows another machine\'s card: not this machine\'s listing, not its configured names', () => {
    // a laptop record whose card the harness could not name (as it records AMD cards): the id stays, with the machine
    const egpu = { fingerprint: 'feedfeedfeedfeed', host: 'laptop', gpus: [iris(), l4090(), { vendor: 'amd', name: AMD_744C, vram_mib: 24560 }] };
    for (const [, setUp] of READERS) {
        setUp();
        assert.equal(label('llama-server -m x-Q4_K_M.gguf -dev CUDA0,ROCm0 -ts 2,3', egpu), 'laptop: RTX 4090 Laptop + ROCm0 (split 2:3)',
            'ROCm0 there is a 24 GB AMD card and this machine has one too: still not this machine\'s card to name');
        // the machine record lists no card for the id (one NVIDIA card, the launch names a second): not the configured CUDA name
        assert.equal(label('llama-server -m x-Q4_K_M.gguf -dev CUDA0,CUDA1 -ts 2,1', MACHINES.laptop), 'laptop: RTX 4090 Laptop + CUDA1 (split 2:1)');
        // ... on this machine's own record as well: today's desktop has no NVIDIA card, so its CUDA0 is nobody's RTX 3060
        assert.equal(label('llama-server -m x-Q4_K_M.gguf -dev CUDA0', MACHINES.newDesktop), 'CUDA0 only');
    }
    // the device-list resolver is never asked about another machine's record
    let asked = 0;
    R.configure({ cardNames: DESKTOP_NAMES, detected: () => { asked++; return TWO_XTX; }, configFile: null, host: 'pop-os' });
    label(CMD.laptop4090, MACHINES.laptop); label(CMD.laptopSplit, MACHINES.laptopPlus3060); label('llama-server -m x-Q4_K_M.gguf -dev ROCm0', egpu);
    assert.equal(asked, 0);
    // read ON the laptop, the same records are its own (no prefix) and the desktop's are the other machine's
    R.configure({ cardNames: {}, configFile: null, host: 'laptop' });
    assert.equal(label(CMD.laptopSplit, MACHINES.laptopPlus3060), 'RTX 4090 Laptop + RTX 3060 (split 2:1)');
    assert.equal(label(CMD.desktop3060, MACHINES.oldDesktop), 'pop-os: RTX 3060 only');
    assert.equal(label(CMD.desktopXtx, MACHINES.oldDesktop), 'pop-os: ROCm0 only', 'no product name in the record, and the laptop\'s names are not the desktop\'s');
});

test('the other machine\'s name comes from the record or from configuration (machineNames), never from this file', (t) => {
    asPublic();
    assert.equal(R.machineName(MACHINES.laptop, null), 'laptop');                                  // the record's host
    assert.equal(R.machineName({ host: 'laptop-4090 (served remotely; hardware not captured)' }, { lane: 'laptop-4090' }), 'laptop-4090');   // no hardware captured: the lane
    assert.equal(R.machineName(null, null), 'another machine');
    // configured: by host, by fingerprint (the more specific wins), by lane
    R.configure({ cardNames: DESKTOP_NAMES, configFile: null, host: 'pop-os', machineNames: { laptop: 'ThinkPad', '29d5272fe98f39cb': 'ThinkPad + eGPU' } });
    assert.equal(label(CMD.laptop4090, MACHINES.laptop), 'ThinkPad: RTX 4090 Laptop only');
    assert.equal(label(CMD.laptopSplit, MACHINES.laptopPlus3060), 'ThinkPad + eGPU: RTX 4090 Laptop + RTX 3060 (split 2:1)');
    R.configure({ cardNames: DESKTOP_NAMES, configFile: null, host: 'pop-os', machineNames: { 'laptop-4090': 'the laptop' } });
    assert.equal(label(CMD.laptop4090, null, { remote: { lane: 'laptop-4090' } }), 'the laptop: CUDA0 only');
    // a process that never configures (the public site) reads machineNames from dashboard.config.json, like deviceNames
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runlabel-mn-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'dashboard.config.json');
    fs.writeFileSync(file, JSON.stringify({ deviceNames: DESKTOP_NAMES, machineNames: { laptop: 'laptop (ssh lane)' } }));
    R.configure({ configFile: file, host: 'pop-os' });
    assert.equal(label(CMD.laptop4090, MACHINES.laptop), 'laptop (ssh lane): RTX 4090 Laptop only');
    assert.equal(label(CMD.desktop3060, MACHINES.oldDesktop), 'RTX 3060 only');
});

test('a remote lane with no machine record keeps its ids: the lane is named, no card is', () => {
    asLab();
    // before the first result lands the Live view has the queue item's command and its lane, nothing else
    const d = R.describeRun({ runner: 'opencode' }, { launch_command: CMD.laptop4090, launch_command_source: 'queue-item', remote: { lane: 'laptop-4090' } });
    assert.equal(d.devices.label, 'laptop-4090: CUDA0 only');
    assert.ok(!/3060|7900/.test(d.line), d.line);
    // lib/codebench.js queueServer marks such a launch by the queue's own convention (lib/topology.js laneCards)
    assert.equal(C.remoteLaneOf('laptop-4090'), 'laptop-4090');
    for (const here of ['local-gpu', 'local-rocm1', 'local-xtx', 'local', '', null, undefined]) assert.equal(C.remoteLaneOf(here), null);
});

// ---- the catalog: lib/models.js prefillCurve labels each launch config from the records of its requests ----
const req = (cmd, depth, tps, extra = {}) => ({ launchCommand: cmd, promptTokens: 2000, promptTps: tps, ctxDepth: depth, aborted: false, ctx: null, ...extra });
const many = (n, cmd, extra) => Array.from({ length: n }, (_, i) => req(cmd, 1000 * (i + 1), 500 - i, extra));
const curve = (requests) => M.prefillCurve({ _bench: [], _requests: requests });
const devLabel = (c) => c.label.split(' · ')[0];

for (const [who, setUp] of READERS) {
    test(`catalog labels come from each request's machine: the five setups [${who}]`, () => {
        setUp();
        const by = (requests) => curve(requests).byConfig.map(devLabel);
        assert.deepEqual(by(many(3, CMD.laptop4090, { machine: MACHINES.laptop })), ['laptop: RTX 4090 Laptop only']);
        assert.deepEqual(by(many(3, CMD.laptopSplit, { machine: MACHINES.laptopPlus3060 })), ['laptop: RTX 4090 Laptop + RTX 3060 (split 2:1)']);
        assert.deepEqual(by(many(3, CMD.desktopSplit, { machine: MACHINES.oldDesktopSept })), ['RX 7900 XTX + RTX 3060 (split 3:1)']);
        assert.deepEqual(by(many(3, CMD.desktop3060, { machine: MACHINES.oldDesktop })), ['RTX 3060 only']);
        assert.deepEqual(by(many(3, CMD.twoXtxTensor, { machine: MACHINES.newDesktop })), ['2x RX 7900 XTX']);
        assert.deepEqual(by(many(3, CMD.secondXtx, { machine: MACHINES.newDesktop })), ['RX 7900 XTX #2 only']);
        assert.deepEqual(by(many(3, CMD.csvSplit, { deviceNames: NAMED.csvSplit })), ['RX 7900 XTX + RTX 3060 (split 75:25)']);
        // the whole label, as the chart shows it
        assert.equal(curve(many(3, CMD.laptop4090, { machine: MACHINES.laptop })).byConfig[0].label, 'laptop: RTX 4090 Laptop only · 128k · KV q4_0 · MTP');
        assert.equal(curve(many(3, CMD.laptopSplit, { machine: MACHINES.laptopPlus3060 })).byConfig[0].label, 'laptop: RTX 4090 Laptop + RTX 3060 (split 2:1) · 128k · KV q8_0 · draft-mtp,ngram-mod');
    });

    test(`one launch config whose requests carry different records gets one honest label [${who}]`, () => {
        setUp();
        const one = (requests) => { const c = curve(requests); assert.equal(c.byConfig.length, 1, 'one launch command is one config'); return devLabel(c.byConfig[0]); };
        // the laptop before and after its second card (two fingerprints), `-dev CUDA0` both times: the same card
        assert.equal(one([...many(2, CMD.laptop4090Q2, { machine: MACHINES.laptop }), ...many(3, CMD.laptop4090Q2, { machine: MACHINES.laptopPlus3060 })]), 'laptop: RTX 4090 Laptop only');
        // the desktop before (one XTX) and after (two) its second card: one such card, without the number
        assert.equal(one([...many(9, CMD.desktopXtx, { machine: MACHINES.oldDesktop }), ...many(2, CMD.desktopXtx, { machine: MACHINES.newDesktop })]), 'RX 7900 XTX only');
        // a row with no record does not outvote a record of the same launch, however many there are
        assert.equal(one([...many(9, CMD.desktopXtx), ...many(1, CMD.desktopXtx, { machine: MACHINES.oldDesktop })]), 'RX 7900 XTX only');
        assert.equal(one([...many(9, CMD.laptop4090), ...many(1, CMD.laptop4090, { machine: MACHINES.laptop })]), 'laptop: RTX 4090 Laptop only');
        // the same command really run on different cards (it has not happened; a shared build path would do it): both, most-used first
        assert.equal(one([...many(4, CMD.desktop3060, { machine: MACHINES.oldDesktop }), ...many(2, CMD.desktop3060, { machine: MACHINES.laptop })]), 'RTX 3060 only / laptop: RTX 4090 Laptop only');
    });
}

test('mergeDeviceLabels: one label, records over guesses, twins without their number, different cards side by side', () => {
    const m = R.mergeDeviceLabels;
    assert.equal(m([]), null); assert.equal(m(null), null);
    assert.equal(m([{ label: 'RTX 3060 only', n: 5, recorded: false }]), 'RTX 3060 only');
    assert.equal(m([{ label: 'RX 7900 XTX #1 only', n: 50, recorded: false }, { label: 'RX 7900 XTX only', n: 1, recorded: true }]), 'RX 7900 XTX only');
    assert.equal(m([{ label: 'RX 7900 XTX #1 only', n: 1, recorded: true }, { label: 'RX 7900 XTX only', n: 9, recorded: true }]), 'RX 7900 XTX only');
    assert.equal(m([{ label: 'RX 7900 XTX #1 only', n: 1, recorded: true }, { label: 'RX 7900 XTX #2 only', n: 9, recorded: true }]), 'RX 7900 XTX only');
    assert.equal(m([{ label: 'RX 7900 XTX #1 + RTX 3060 (split 3:1), 33 MoE layers on CPU', n: 1, recorded: true }, { label: 'RX 7900 XTX + RTX 3060 (split 3:1), 33 MoE layers on CPU', n: 2, recorded: true }]),
        'RX 7900 XTX + RTX 3060 (split 3:1), 33 MoE layers on CPU');
    assert.equal(m([{ label: 'A only', n: 1, recorded: true }, { label: 'B only', n: 9, recorded: true }, { label: 'C only', n: 99, recorded: false }]), 'B only / A only');
    assert.equal(m([{ label: 'A only', n: 1, recorded: false }, { label: 'B only', n: 9, recorded: false }]), 'B only / A only');
});

test('row identity: the machine a request ran on changes the label and nothing a row or a chart is keyed on', () => {
    asPublic();
    const bare = [...many(9, CMD.laptop4090), ...many(6, CMD.laptopSplit), ...many(4, CMD.desktopXtx), ...many(3, CMD.secondXtx), ...many(2, CMD.csvSplit)];
    // the same requests, each with the record it really carried (the XTX command: half on the old desktop, half on the new)
    const recordOf = (r, i) => (r.launchCommand === CMD.laptop4090 ? { machine: MACHINES.laptop }
        : r.launchCommand === CMD.laptopSplit ? { machine: MACHINES.laptopPlus3060 }
        : r.launchCommand === CMD.desktopXtx ? { machine: i % 2 ? MACHINES.newDesktop : MACHINES.oldDesktop }
        : r.launchCommand === CMD.secondXtx ? { machine: MACHINES.newDesktop } : { deviceNames: NAMED.csvSplit });
    const recorded = bare.map((r, i) => ({ ...r, ...recordOf(r, i) }));
    const a = curve(bare), b = curve(recorded);
    const keyed = (c) => ({ primary: c.primary, fromRequests: c.fromRequests, fromBench: c.fromBench, byConfig: c.byConfig.map(({ label, ...rest }) => rest) });
    assert.deepEqual(keyed(b), keyed(a), 'ids, configKeys, counts, points, order and the primary config are the same');
    assert.equal(a.byConfig.length, 5);
    assert.deepEqual(a.byConfig.map(devLabel), ['RTX 3060 only', '2x RTX 3060 (split 2:1)', 'RX 7900 XTX only', 'RX 7900 XTX only', 'RX 7900 XTX + RTX 3060 (split 75:25)'], 'what the catalog said before');
    assert.deepEqual(b.byConfig.map(devLabel), ['laptop: RTX 4090 Laptop only', 'laptop: RTX 4090 Laptop + RTX 3060 (split 2:1)', 'RX 7900 XTX only', 'RX 7900 XTX #2 only', 'RX 7900 XTX + RTX 3060 (split 75:25)']);
    // the ids are the launch command's alone: no card name, no machine name
    for (const c of b.byConfig) assert.ok(!/RTX|RX 7900|laptop:/.test(c.id + c.configKey), c.id);
    // a running battery's row (lib/models.js describeRunning) is the same row whether or not its launch is marked remote
    const rec = { dir: 'rowfill-x', battery: { runner: 'opencode', model: 'llama-local/x', config: { prompt_level: 'L2' } } };
    const srv = { model_path: '/home/kyle-4090/llama-lane/models/Qwen3.8-27B-UD/Qwen3.8-27B-UD-Q2_K_XL.gguf', n_ctx: 65536, launch_command: CMD.laptop4090Q2, launch_command_source: 'queue-item' };
    assert.deepEqual(M.describeRunning(rec, { ...srv, remote: { lane: 'laptop-4090' } }), M.describeRunning(rec, srv));
});

test('lib/db.js: the machines table and each request\'s own device list, as lib/models.js reads them', () => {
    const DB = require('../lib/db');
    const d = DB.open();
    assert.ok(d, 'test database opens');
    const mach = d.prepare('INSERT INTO machines (fingerprint, host, gpus_json, first_seen, source) VALUES (?, ?, ?, ?, ?)');
    mach.run('29d5272fe98f39cb', 'laptop', JSON.stringify(MACHINES.laptopPlus3060.gpus), '2026-10-12T21:50:50Z', 'run.py over ssh (laptop-4090 lane)');
    mach.run('cc155498840fc883', 'pop-os', JSON.stringify(MACHINES.newDesktop.gpus), '2026-10-12T20:08:04Z', 'run.py');
    mach.run('0000000000000bad', 'broken', '{not json', '2026-10-12T00:00:00Z', 'test');
    const ms = DB.readMachines();
    assert.equal(ms.size, 3);
    assert.deepEqual(ms.get('29d5272fe98f39cb'), { fingerprint: '29d5272fe98f39cb', host: 'laptop', gpus: MACHINES.laptopPlus3060.gpus, source: 'run.py over ssh (laptop-4090 lane)', first_seen: '2026-10-12T21:50:50Z' });
    assert.equal(ms.get('0000000000000bad').gpus, null, 'an unreadable gpu list is no list, not a throw');
    // a machine read from the table names its launches like the fixtures above
    asPublic();
    assert.equal(label(CMD.laptopSplit, ms.get('29d5272fe98f39cb')), 'laptop: RTX 4090 Laptop + RTX 3060 (split 2:1)');
    assert.equal(label(CMD.laptop4090, ms.get('0000000000000bad')), 'broken: CUDA0 only', 'another machine with nothing captured: the id, not a card of this one');

    const ins = d.prepare("INSERT INTO requests (source, completed_at, launch_command, machine_fp, devices_json) VALUES ('test', ?, ?, ?, ?)");
    const dj = (list) => JSON.stringify(list.map(([id, name, host]) => ({ id, name, label: name, host: host || 'local', share: null, util: 0, pwr: 15, temp: 46, vram_used: 34, vram_total: 24560, thermal: false })));
    const a = ins.run('2026-09-17T05:46:00Z', CMD.csvSplit, null, dj([['ROCm0', 'AMD Radeon RX 7900 XTX'], ['CUDA0', 'NVIDIA GeForce RTX 3060']])).lastInsertRowid;
    const a2 = ins.run('2026-09-17T05:47:00Z', CMD.csvSplit, null, dj([['ROCm0', 'AMD Radeon RX 7900 XTX'], ['CUDA0', 'NVIDIA GeForce RTX 3060']])).lastInsertRowid;
    const half = ins.run('2026-09-22T08:28:54Z', CMD.csvBare, null, dj([['ROCm0', null], ['CUDA0', 'NVIDIA GeForce RTX 3060']])).lastInsertRowid;
    const rpc = ins.run('2026-09-16T10:04:40Z', 'x', null, dj([['Vulkan1', 'AMD Radeon RX 7900 XTX'], ['RPC0', 'NVIDIA GeForce RTX 4090 Laptop GPU', 'laptop']])).lastInsertRowid;
    const none = ins.run('2026-10-06T09:27:57Z', CMD.laptop4090, '29d5272fe98f39cb', null).lastInsertRowid;
    const empty = ins.run('2026-09-27T06:45:31Z', 'x', null, '[]').lastInsertRowid;
    const bad = ins.run('2026-09-27T06:45:32Z', 'x', null, '{oops').lastInsertRowid;
    const nameless = ins.run('2026-09-21T00:00:00Z', 'x', null, dj([['ROCm0', null]])).lastInsertRowid;
    const names = DB.readRequestDeviceNames();
    assert.deepEqual(names.get(a), NAMED.csvSplit);
    assert.strictEqual(names.get(a2), names.get(a), 'requests of one launch share one object');
    assert.deepEqual(names.get(half), NAMED.csvHalf, 'a device listed with no name is left out');
    assert.deepEqual(names.get(rpc), { Vulkan1: 'AMD Radeon RX 7900 XTX' }, 'an RPC worker\'s card is not a device of the launch\'s machine');
    for (const id of [none, empty, bad, nameless]) assert.equal(names.has(id), false);
    // readRequests still leaves the big columns out, and still returns the fingerprint the machine is found by
    const rows = DB.readRequests();
    assert.equal(rows.length, 8);
    assert.ok(!('devices_json' in rows[0]) && !('telemetry_json' in rows[0]));
    assert.equal(rows.find((r) => r.id === none).machine_fp, '29d5272fe98f39cb');
    // a Strata engine-log backfill row (placeholder time, 2026-10-22) is History's only: not read here, not in a window
    const untimed = d.prepare("INSERT INTO requests (source, completed_at, launch_command) VALUES (?, '2026-10-22T18:00:00Z', 'x')").run(DB.UNTIMED_SOURCE).lastInsertRowid;
    assert.equal(DB.readRequests().length, 8);
    assert.ok(!DB.requestsBetween('2026-10-22T17:00:00Z', '2026-10-22T19:00:00Z').length);
    assert.equal(DB.newestNonCsvRequestKeys(1)[0].id, untimed, 'History still lists it');
});
