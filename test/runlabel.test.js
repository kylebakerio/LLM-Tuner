// Live view "what is running" (lib/runlabel.js + adoptedLive server provenance), the Live view's
// transcript tail merge/follow helpers, and the Models page prefill chart's series selection
// (lib/models.js prefillCurve byConfig + ui/models/prefill.js).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const R = require('../lib/runlabel.js');
const C = require('../lib/codebench.js');
const M = require('../lib/models.js');

// lib/runlabel.js names no card itself. These records come from the machine that had one RX 7900 XTX (ROCm) and one
// RTX 3060 (CUDA) and predate `server.machine`, so the names are that machine's dashboard.config.json `deviceNames`.
// configFile: null -- the tests never read the real dashboard.config.json of whatever machine runs them.
const OLD_RIG = { ROCm: 'AMD Radeon RX 7900 XTX', CUDA: 'NVIDIA GeForce RTX 3060' };
R.configure({ cardNames: OLD_RIG, configFile: null });

// The server provenance run.py recorded for the q2cq4-q8kv-xtx battery (2026-09-28).
const Q2_PATH = '/home/kyle/.cache/huggingface/hub/models--unsloth--Qwen3.8-27B-GGUF/snapshots/4ca720788d1e01f1bff70c033e0d0028fd02e502/Qwen3.8-27B-UD-Q2_K_XL.gguf';
const Q2_SERVER = {
    model_path: Q2_PATH, build_info: 'b10499-6d0549831', n_ctx: 65536,
    launch_command: `/home/kyle/AI/llama-official/llama.cpp/build-all/bin/llama-server -m ${Q2_PATH} -c 65536 -ngl 999 -fa on -np 1 --jinja --spec-type draft-mtp --spec-draft-n-max 2 -devd ROCm0 -dev ROCm0 --cache-type-k q8_0 --cache-type-v q8_0 --port 18080`,
    launch_command_source: 'proc', devices: 'ROCm0',
};
const Q2_CONFIG = { runner: 'opencode', model: 'llama-local/q2max', prompt_level: 'L2', harness_mode: 'agentic', timeout_s: 7200, scaffold: null };

test('describeRun: the running battery reads as model, quant, ctx, KV, devices, MTP, harness, prompt level', () => {
    const d = R.describeRun(Q2_CONFIG, Q2_SERVER);
    assert.equal(d.model.display, 'Qwen3.8-27B Q2_K_XL');   // the Models page catalog display
    assert.equal(d.model.key, 'local:qwen3.8-27b:q2-k-xl');
    assert.equal(d.model.quant, 'Q2_K_XL');
    assert.equal(d.ctx, 65536); assert.equal(d.kv, 'q8_0'); assert.equal(d.mtp, true);
    assert.equal(d.devices.label, 'RX 7900 XTX only');
    assert.equal(d.harness, 'opencode'); assert.equal(d.promptLevel, 'L2'); assert.equal(d.variant, null);
    assert.equal(d.runnerModel, 'q2max');
    assert.equal(d.line, 'Qwen3.8-27B Q2_K_XL · 64k ctx · KV q8_0 · RX 7900 XTX only · MTP on · opencode · L2');
});

test('describeRun: absence of evidence is not "off"; prompt variants and scaffolds split out; cloud runs degrade', () => {
    // only /props answered: no launch flags, so MTP / KV / devices are unknown, never "off" / "f16"
    const bare = R.describeRun(Q2_CONFIG, { model_path: Q2_PATH, n_ctx: 65536 });
    assert.equal(bare.model.display, 'Qwen3.8-27B Q2_K_XL');
    assert.equal(bare.mtp, null); assert.equal(bare.kv, null); assert.equal(bare.devices, null);
    assert.equal(bare.source, 'model_path');
    assert.doesNotMatch(bare.line, /MTP|KV/);
    // no KV flags in a recorded launch = llama-server's default f16; no --spec-type = MTP off
    const plain = R.describeRun({ runner: 'pi', scaffold: 'sol-pi', prompt_level: 'L2+terse' },
        { model_path: '/data/models/Gemma4-12B/gemma-4-12b-it-UD-Q8_K_XL.gguf', launch_command: 'llama-server -m /data/models/Gemma4-12B/gemma-4-12b-it-UD-Q8_K_XL.gguf -c 32768 -dev ROCm0,CUDA0 -ts 3,1' });
    assert.equal(plain.kv, 'f16'); assert.equal(plain.mtp, false);
    assert.equal(plain.devices.label, 'RX 7900 XTX + RTX 3060 (split 3:1)');
    assert.equal(plain.harness, 'pi (sol-pi)'); assert.equal(plain.promptLevel, 'L2'); assert.equal(plain.variant, 'terse');
    assert.match(plain.line, /MTP off/);
    // a cloud runner has no server: harness + model only
    const cloud = R.describeRun({ runner: 'claude', model: 'claude-opus-5', scaffold: 'solo', prompt_level: 'L2' }, null);
    assert.equal(cloud.model.display, 'Claude Opus 5'); assert.equal(cloud.local, false);
    assert.equal(cloud.line, 'Claude Opus 5 · claude (solo) · L2');
    assert.equal(R.describeRun(null, null).line, null);
});

test('device names come from evidence: the record\'s machine, this build\'s device list, configured names; else the id', () => {
    // configured names (OLD_RIG above), by backend
    assert.equal(R.devicesSummary('ROCm0').label, 'RX 7900 XTX only');
    assert.equal(R.devicesSummary('CUDA0').label, 'RTX 3060 only');
    assert.equal(R.devicesSummary('CUDA0,RPC0').label, 'RTX 3060 + remote');
    assert.equal(R.devicesSummary('ROCm0,CUDA0', null, '3,1').label, 'RX 7900 XTX + RTX 3060 (split 3:1)');
    // an id nothing names stays the id: never a guess
    assert.equal(R.devicesSummary('Vulkan0').label, 'Vulkan0 only');
    assert.equal(R.devicesSummary('CUDA0,Vulkan0').label, 'RTX 3060 + Vulkan0');   // -dev order is kept: it is the layer order
    assert.equal(R.devicesSummary('SYCL0', null, null, false, { cardNames: {} }).label, 'SYCL0 only');
    // this build's --list-devices names any id, Vulkan included
    assert.equal(R.devicesSummary('Vulkan1', [{ id: 'Vulkan1', description: 'AMD Radeon RX 7900 XTX (RADV NAVI31)' }]).label, 'RX 7900 XTX only');
    assert.equal(R.devicesSummary('Vulkan0', [{ id: 'Vulkan0', description: 'NVIDIA GeForce RTX 3060' }]).label, 'RTX 3060 only');
    // the device-list resolver is asked only where the record itself leaves a name or a count open -- never for a
    // record whose machine names every card, never for a server on another machine
    let asked = 0;
    const ask = { detected: () => { asked++; return []; } };
    const nvidia = { gpus: [{ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 3060', vram_mib: 12288 }] };
    R.describeRun({}, { launch_command: 'llama-server -m x-Q4_K_M.gguf -dev CUDA0', machine: nvidia }, ask);
    R.describeRun({}, { launch_command: 'llama-server -m x-Q4_K_M.gguf -dev CUDA0,RPC0', machine: nvidia }, ask);
    R.describeRun({}, { launch_command: 'llama-server -m x-Q4_K_M.gguf -dev CUDA0', remote: { lane: 'far' }, machine: { host: 'far' } }, ask);
    R.describeRun({}, { launch_command: 'llama-server -m x-Q4_K_M.gguf' }, ask);
    assert.equal(asked, 0);
    R.describeRun({}, { launch_command: 'llama-server -m x-Q4_K_M.gguf -dev ROCm0' }, ask);            // no machine record at all
    R.describeRun({}, { launch_command: 'llama-server -m x-Q4_K_M.gguf -dev Vulkan1', machine: nvidia }, ask);   // Vulkan: no vendor to go by
    assert.equal(asked, 2);
});

test('this machine\'s device list does not speak for a record made on other cards', () => {
    const XTX2 = [{ id: 'ROCm0', description: 'AMD Radeon RX 7900 XTX', totalMib: 24560 }, { id: 'ROCm1', description: 'AMD Radeon RX 7900 XTX', totalMib: 24560 },
        { id: 'Vulkan0', description: 'AMD Radeon RX 7900 XTX (RADV NAVI31)', totalMib: 24560 }, { id: 'Vulkan1', description: 'AMD Radeon RX 7900 XTX (RADV NAVI31)', totalMib: 24560 }];
    // recorded on the old rig (one 24 GB AMD card, one 12 GB NVIDIA card), read on the two-XTX machine
    const old = { gpus: [{ vendor: 'amd', name: 'Advanced Micro Devices, Inc. [AMD/ATI] Device 744c (rev c8)', vram_mib: 24560 }, { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 3060', vram_mib: 12288 }] };
    const run = (dev, machine, extra) => R.describeRun({}, { launch_command: `llama-server -m x-Q4_K_M.gguf -dev ${dev}`, machine }, { detected: XTX2, cardNames: {}, ...extra }).devices.label;
    // Vulkan1 there was a card of that machine; here it is the second XTX. Saying so would be a guess: the id stays.
    assert.equal(run('CUDA0,Vulkan1', old), 'RTX 3060 + Vulkan1');
    assert.equal(run('Vulkan0', old), 'Vulkan0 only');
    // ROCm0 there was a 24 GB AMD card and is one here: the listing may name it; the count is the record's (one card)
    assert.equal(run('ROCm0', old), 'RX 7900 XTX only');
    // a record from a machine with the same cards as this one: Vulkan ids are named, and numbered
    const same = { gpus: [old.gpus[0], { ...old.gpus[0] }] };
    assert.equal(run('Vulkan1', same), 'RX 7900 XTX #2 only');
    assert.equal(run('ROCm0,ROCm1', same), '2x RX 7900 XTX');
    // a vendor backend's card of another size is not this machine's card either: its name comes from deviceNames, or not at all
    const small = { gpus: [{ vendor: 'amd', name: 'Advanced Micro Devices, Inc. [AMD/ATI] Device 7480', vram_mib: 8176 }] };
    assert.equal(run('ROCm0', small), 'ROCm0 only');
    assert.equal(run('ROCm0', small, { cardNames: { ROCm0: 'AMD Radeon RX 7600' } }), 'RX 7600 only');
});

test('a process that never configures names still reads deviceNames from the config file, once; without one, ids stay ids', (t) => {
    t.after(() => R.configure({ cardNames: OLD_RIG, configFile: null }));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'runlabel-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'dashboard.config.json');
    fs.writeFileSync(file, JSON.stringify({ llamaServerBuilds: [], deviceNames: { ROCm: 'AMD Radeon RX 7900 XTX', CUDA: 'NVIDIA GeForce RTX 3060' } }));
    const cmd = { launch_command: 'llama-server -m /m/Qwen3.8-27B-UD-Q4_K_XL.gguf -c 65536 -dev ROCm0,CUDA0 -ts 3,1' };
    // the public site's process: lib/models.js prefillCurve calls describeRun with no opts and nobody called configure()
    R.configure({ configFile: file });
    assert.equal(R.describeRun({}, cmd).devices.label, 'RX 7900 XTX + RTX 3060 (split 3:1)');
    fs.writeFileSync(file, '{}');
    assert.equal(R.describeRun({}, cmd).devices.label, 'RX 7900 XTX + RTX 3060 (split 3:1)', 'read once, not per call');
    // no deviceNames, a broken file, no file: never a throw, never a guess
    for (const f of [file, path.join(dir, 'missing.json'), null]) {
        R.configure({ configFile: f });
        assert.equal(R.describeRun({}, cmd).devices.label, 'ROCm0 + CUDA0 (split 3:1)');
    }
    fs.writeFileSync(file, '{not json');
    R.configure({ configFile: file });
    assert.equal(R.describeRun({}, cmd).devices.label, 'ROCm0 + CUDA0 (split 3:1)');
    // names handed to configure() win over the file
    fs.writeFileSync(file, JSON.stringify({ deviceNames: { ROCm: 'From The File' } }));
    R.configure({ cardNames: { ROCm: 'AMD Radeon RX 7900 XTX' }, configFile: file });
    assert.equal(R.describeRun({}, { launch_command: 'llama-server -m x-Q4_K_M.gguf -dev ROCm0' }).devices.label, 'RX 7900 XTX only');
});

test('device names on other machines: two identical cards, one card, a machine this code has never seen, no names at all', () => {
    const none = { cardNames: {} };
    const XTX2 = [{ id: 'ROCm0', description: 'AMD Radeon RX 7900 XTX' }, { id: 'ROCm1', description: 'AMD Radeon RX 7900 XTX' },
        { id: 'Vulkan0', description: 'AMD Radeon RX 7900 XTX (RADV NAVI31)' }, { id: 'Vulkan1', description: 'AMD Radeon RX 7900 XTX (RADV NAVI31)' }];
    // two identical cards: one of them is told apart, both together read as two
    assert.equal(R.devicesSummary('ROCm1', XTX2, null, false, none).label, 'RX 7900 XTX #2 only');
    assert.equal(R.devicesSummary('Vulkan0', XTX2, null, false, none).label, 'RX 7900 XTX #1 only');
    assert.equal(R.devicesSummary('ROCm0,ROCm1', XTX2, '1,1', false, none).label, '2x RX 7900 XTX (split 1:1)');
    // ... also when only the backend's name is known (no listing): two ids are two cards, not "RX 7900 XTX only"
    assert.equal(R.devicesSummary('ROCm0,ROCm1', null, null, false, { cardNames: OLD_RIG }).label, '2x RX 7900 XTX');
    // one card
    assert.equal(R.devicesSummary('CUDA0', [{ id: 'CUDA0', description: 'NVIDIA GeForce RTX 4090' }], null, false, none).label, 'RTX 4090 only');
    // nothing known: ids
    assert.equal(R.devicesSummary('ROCm0,CUDA0', null, '3,1', false, none).label, 'ROCm0 + CUDA0 (split 3:1)');
    // the record's own machine wins over this machine's names: a run recorded on a 2x RTX 5090 box, read here
    const far = { gpus: [{ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 5090', vram_mib: 32607 }, { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 5090', vram_mib: 32607 }] };
    const d = R.describeRun({}, { launch_command: 'llama-server -m x-Q4_K_M.gguf -dev CUDA1', machine: far });
    assert.equal(d.devices.label, 'RTX 5090 #2 only');
    assert.equal(R.describeRun({}, { launch_command: 'llama-server -m x-Q4_K_M.gguf -dev CUDA0,CUDA1 -ts 1,1', machine: far }).devices.label, '2x RTX 5090 (split 1:1)');
    // a machine record whose GPU name is the PCI database's (sysfs, AMD cards) says how many cards there were, not
    // what they are called: the name comes from the next source, the ordinal from the record
    const pci = { gpus: [{ vendor: 'amd', name: 'Advanced Micro Devices, Inc. [AMD/ATI] Device 744c (rev c8)', vram_mib: 24560 }, { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 3060', vram_mib: 12288 }] };
    assert.equal(R.describeRun({}, { launch_command: 'llama-server -m x-Q4_K_M.gguf -dev ROCm0,CUDA0 -ts 3,1', machine: pci }).devices.label, 'RX 7900 XTX + RTX 3060 (split 3:1)');
    assert.equal(R.describeRun({}, { launch_command: 'llama-server -m x-Q4_K_M.gguf -dev ROCm0', machine: pci }, { detected: XTX2 }).devices.label, 'RX 7900 XTX only',
        'one AMD card in the record: no #1, although this machine now has two');
    assert.equal(R.describeRun({}, { launch_command: 'llama-server -m x-Q4_K_M.gguf -dev ROCm0', machine: pci }, none).devices.label, 'ROCm0 only');
    assert.deepEqual(R.resolveDevice('ROCm1', { machine: { gpus: [pci.gpus[0], pci.gpus[0]] }, detected: XTX2 }), { id: 'ROCm1', name: 'RX 7900 XTX', ordinal: 2, count: 2 });
    assert.deepEqual(R.resolveDevice('RPC0', {}), { id: 'RPC0', name: 'remote', ordinal: null, count: null });
});

test('adoptedLive: an adopted battery takes server provenance from its newest result JSON and the harness config from battery.json.config', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-runlabel-'));
    try {
        const dir = path.join(out, 'results', 'q2cq4-q8kv-xtx');
        fs.mkdirSync(dir, { recursive: true });
        const b = { v: 1, pid: 1, started: 1790616581.97, cmd: ['harness/run.py'], out: dir, runner: 'opencode', model: 'llama-local/q2max',
            tasks: ['task-a', 'task-b'], runs: 1, timeout_s: 7200, state: 'running', config: { ...Q2_CONFIG, prompt_level: 'L2+terse' } };
        fs.writeFileSync(path.join(dir, 'battery.json'), JSON.stringify(b));
        fs.writeFileSync(path.join(dir, 'task-a.json'), JSON.stringify({ task: 'task-a', runner: 'opencode', model: 'llama-local/q2max', status: 'pass',
            server: Q2_SERVER, run: { wall_s: 10 }, score: { solved: true }, timeline: {}, anomalies: [] }));
        const l = C.adoptedLive({ dir: 'q2cq4-q8kv-xtx', path: dir, battery: b, state: 'running' }, out);
        assert.equal(l.battery.server.model_path, Q2_PATH);
        assert.equal(l.battery.config.prompt_level, 'L2+terse');   // lives only under battery.json.config
        assert.equal(l.battery.config.harness_mode, 'agentic');
        const d = R.describeRun(l.battery.config, l.battery.server);
        assert.equal(d.line, 'Qwen3.8-27B Q2_K_XL · 64k ctx · KV q8_0 · RX 7900 XTX only · MTP on · opencode · L2+terse');
    } finally { fs.rmSync(out, { recursive: true, force: true }); }
});

test('adoptedLive: before any result lands, a lone llama-server process is the witness; two are a guess and give nothing', () => {
    const out = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-runlabel-'));
    try {
        const dir = path.join(out, 'results', 'x'); fs.mkdirSync(dir, { recursive: true });
        const b = { pid: 1, runner: 'opencode', tasks: ['t'], runs: 1, state: 'running', config: Q2_CONFIG };
        const argv = ['/b/llama-server', '-m', Q2_PATH, '-c', '65536', '--spec-type', 'draft-mtp', '-dev', 'ROCm0'];
        C._setProcScan(() => [argv]);
        let l = C.adoptedLive({ dir: 'x', path: dir, battery: b, state: 'running' }, out);
        assert.equal(l.battery.server.launch_command_source, 'proc-scan');
        assert.equal(l.battery.server.model_path, Q2_PATH); assert.equal(l.battery.server.n_ctx, 65536);
        assert.equal(R.describeRun(l.battery.config, l.battery.server).mtp, true);
        C._setProcScan(() => [argv, argv]);
        l = C.adoptedLive({ dir: 'x', path: dir, battery: b, state: 'running' }, out);
        assert.equal(l.battery.server, null);
        // a cloud runner never looks
        C._setProcScan(() => { throw new Error('must not scan'); });
        l = C.adoptedLive({ dir: 'x', path: dir, battery: { ...b, runner: 'claude', config: { runner: 'claude' } }, state: 'running' }, out);
        assert.equal(l.battery.server, null);
    } finally { C._setProcScan(null); fs.rmSync(out, { recursive: true, force: true }); }
});

test('live snapshot carries run_info, so SSE pushes and the /live poll agree', () => {
    C._resetForTests();
    const live = C.freshLive();
    C.applyEvent(live, { v: 1, t: 0, ev: 'battery_start', battery: 'q2cq4-q8kv-xtx', out: '/x', tasks: ['a'], runs: 1, config: Q2_CONFIG, server: Q2_SERVER });
    assert.equal(live.battery.server.model_path, Q2_PATH);
    const s = C.live({ root: os.tmpdir(), noAdopt: true });
    assert.ok('run_info' in s);   // null when idle
});

test('runInfoHtml: model display is the headline; nicknames are labelled as labels; unknowns say so', async () => {
    const U = await import('../ui/benchmarks/util.js');
    const html = U.runInfoHtml(R.describeRun(Q2_CONFIG, Q2_SERVER), 'q2cq4-q8kv-xtx');
    assert.match(html, /text-lg[^>]*>Qwen3\.8-27B Q2_K_XL</);
    for (const s of ['64k ctx', 'KV q8_0', 'RX 7900 XTX only', 'MTP on', 'opencode', 'L2', 'Q2_K_XL']) assert.ok(html.includes(s), s);
    assert.match(html, /q2max/); assert.match(html, /labels, not the weights/);
    const bare = U.runInfoHtml(R.describeRun(Q2_CONFIG, { model_path: Q2_PATH }), 'b');
    assert.match(bare, /launch flags not recorded/); assert.doesNotMatch(bare, /MTP off/);
    const pending = U.runInfoHtml(R.describeRun(Q2_CONFIG, null), 'b');
    assert.match(pending, /no server provenance yet/);
    assert.equal(U.runInfoHtml(null), '');
});

test('transcript tail: merged incrementally (the last entry re-read and replaced), bounded, and re-based when not contiguous', async () => {
    const U = await import('../ui/benchmarks/util.js');
    const ev = (i, txt) => ({ kind: 'text', text: txt || `e${i}` });
    let t = { start: 10, events: [ev(10), ev(11), ev(12, 'partial')] };
    // poll from the last held entry (12): it grew, and 13-14 are new
    t = U.mergeTailEvents(t, 12, { events: [ev(12, 'partial, now complete'), ev(13), ev(14)], total: 15 });
    assert.equal(t.start, 10); assert.equal(t.events.length, 5); assert.equal(t.total, 15);
    assert.equal(t.events[2].text, 'partial, now complete');
    // keep bounds memory by dropping the OLDEST, and start follows
    t = U.mergeTailEvents(t, 14, { events: [ev(14), ev(15), ev(16)], total: 17 }, 4);
    assert.deepEqual(t.events.map((e) => e.text), ['e13', 'e14', 'e15', 'e16']); assert.equal(t.start, 13);
    // a gap (from past what is held): take the page as it is
    t = U.mergeTailEvents(t, 40, { events: [ev(40)], total: 41 });
    assert.equal(t.start, 40); assert.equal(t.events.length, 1);
    assert.deepEqual(U.mergeTailEvents(null, 5, { events: [ev(5)], total: 6 }).events.length, 1);
});

test('transcript tail: follows new entries while at the bottom, stays put once the reader scrolls up, starts at the bottom', async () => {
    const U = await import('../ui/benchmarks/util.js');
    const box = (scrollTop, scrollHeight, clientHeight = 100) => ({ scrollTop, scrollHeight, clientHeight });
    assert.equal(U.isAtBottom(box(400, 500)), true);
    assert.equal(U.isAtBottom(box(120, 500)), false);
    assert.equal(U.isAtBottom(box(0, 80)), true);   // not overflowing yet: at the bottom, so it follows once it does
    let el = box(400, 700); assert.equal(U.followScroll(el, true), true); assert.equal(el.scrollTop, 600);
    el = box(120, 700); assert.equal(U.followScroll(el, false), false); assert.equal(el.scrollTop, 120);
    el = box(0, 700); U.followScroll(el, undefined); assert.equal(el.scrollTop, 600);   // a new box opens at the newest entry
    // and the live view marks both of its tail scrollers, with keys stable across redraws
    const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'benchmarks', 'live.js'), 'utf-8');
    assert.match(src, /data-key="tailbox:\$\{esc\(c\.task\)\}" data-follow/);
    assert.match(src, /data-key="tailpre:\$\{esc\(c\.task\)\}" data-follow/);
    assert.doesNotMatch(src, /evs\.slice\(\)\.reverse\(\)/);
});

// ---------------------------------------------------------------- prefill vs context

function req(cmd, depth, tps, extra) {
    return { aborted: false, promptTokens: 2000, promptTps: tps, ctxDepth: depth, launchCommand: cmd, ctx: 65536, ...(extra || {}) };
}
const XTX = 'llama-server -m /m/Qwen3.8-27B-UD-Q4_K_XL.gguf -c 65536 -dev ROCm0 --spec-type draft-mtp';
const SPLIT = 'llama-server -m /m/Qwen3.8-27B-UD-Q4_K_XL.gguf -c 131072 -dev ROCm0,CUDA0 -ts 3,1';

test('prefillCurve: per launch config, most-used first; the all-config curve is unchanged', () => {
    const m = { _bench: [], _requests: [
        req(XTX, 1000, 900), req(XTX, 5000, 800), req(XTX, 30000, 500), req(XTX, 30000, 520, { promptTokens: 10 }),   // cache hit: out
        req(SPLIT, 1000, 700), req(SPLIT, 40000, 300),
        req(SPLIT, null, 999),                     // no depth: cannot be placed
        req(XTX, 2000, 50, { aborted: true }),
    ] };
    const c = M.prefillCurve(m);
    assert.equal(c.fromRequests.reduce((a, p) => a + p.n, 0), 5);
    assert.equal(c.byConfig.length, 2);
    assert.equal(c.byConfig[0].n, 3); assert.equal(c.byConfig[1].n, 2);
    assert.equal(c.primary, c.byConfig[0].id);
    assert.match(c.byConfig[0].label, /RX 7900 XTX only · 64k · KV f16 · MTP/);
    assert.match(c.byConfig[1].label, /RX 7900 XTX \+ RTX 3060 \(split 3:1\) · 128k/);
    assert.equal(c.byConfig[0].points.length, 3);
    // a most-used config with one bucket is a dot, not a curve: no primary
    assert.equal(M.prefillCurve({ _bench: [], _requests: [req(XTX, 1000, 1), req(XTX, 1000, 2)] }).primary, null);
});

test('prefillSeries: every model with data gets a line (no cap of 8), at its most-used config; "every config" splits them', async () => {
    const P = await import('../ui/models/prefill.js');
    const mk = (i, n) => {
        const pts = [{ bucket: 1024, n, median: 900 - i, min: 1, max: 2 }, { bucket: 32768, n: 1, median: 400 - i, min: 1, max: 2 }];
        return { key: `local:m${i}:q4`, display: `Model ${i} Q4`, provider: 'local',
            speed: { coarse: false, curve: { fromRequests: pts, fromBench: [], primary: 'cfgA', byConfig: [
                { id: 'cfgA', label: 'XTX only · 64k', n: n + 1, points: pts },
                { id: 'cfgB', label: 'XTX + 3060 · 128k', n: 25, points: [{ bucket: 4096, n: 25, median: 600, min: 1, max: 2 }] },
            ] } } };
    };
    const models = Array.from({ length: 22 }, (_, i) => mk(i, 30 + i));
    models.push({ key: 'cloud:x', display: 'Cloud', provider: 'cloud', speed: { coarse: true } });
    models.push({ key: 'local:bench:q8', display: 'Bench Only Q8_0', provider: 'local', speed: { coarse: false, curve: { fromRequests: [], fromBench: [{ depth: 0, n: 1, median: 5000 }, { depth: 4096, n: 1, median: 700 }, { depth: 16384, n: 1, median: 500 }] } } });
    models.push({ key: 'local:none:q4', display: 'No Depth Q4', provider: 'local', speed: { coarse: false, curve: { fromRequests: [], fromBench: [] } } });
    const s = P.prefillSeries(models, 'model');
    assert.equal(s.length, 23, 'all 22 request models + the bench-only one; not the cloud row, not the one without data');
    assert.equal(s[0].label, 'Model 21 Q4', 'ordered by how much data the line rests on');
    assert.match(s[0].config, /XTX only · 64k \(most-used of 2 configs\)/);
    const bench = s.find((x) => x.key === 'local:bench:q8');
    assert.equal(bench.config, 'llama-bench depths'); assert.deepEqual(bench.points.map((p) => p.ctx), [4096, 16384]);   // depth 0 is not a context
    const all = P.prefillSeries(models, 'config');
    assert.equal(all.filter((x) => x.key === 'local:m0:q4').length, 2);
    assert.ok(all.some((x) => x.label === 'Model 3 Q4 · XTX + 3060 · 128k'));
    // a model whose most-used config is a single bucket falls back to the pooled curve, and says so
    const pooled = P.prefillSeries([{ ...mk(0, 5), speed: { coarse: false, curve: { ...mk(0, 5).speed.curve, primary: null } } }], 'model');
    assert.equal(pooled[0].config, 'all 2 configs pooled');
});

test('transcript tail: an empty poll that does not say the transcript shrank keeps what is held', async () => {
    const U = await import('../ui/benchmarks/util.js');
    const held = { start: 3, events: [{ text: 'a' }, { text: 'b' }] };
    const t = U.mergeTailEvents(held, 4, { events: [], total: 5 });
    assert.deepEqual(t.events.map((e) => e.text), ['a', 'b']); assert.equal(t.start, 3);
});

test('a server on another machine (a codebench remote lane) is named after ITS card, never one of this machine\'s', () => {
    const cmd = '/home/kyle-4090/llama-lane/llama.cpp/build-cuda/bin/llama-server -m /home/kyle-4090/llama-lane/models/Qwen3.8-27B-GSQ-RCO/Qwen3.8-27B-GSQ-RCO-IQ2_XS-mtp-f32ssm.gguf -c 131072 --spec-type draft-mtp -devd CUDA0 --cache-type-k q4_0 --cache-type-v q4_0 -dev CUDA0 --port 18180';
    const local = R.describeRun({ runner: 'opencode' }, { launch_command: cmd, n_ctx: 131072, devices: 'CUDA0' });
    assert.strictEqual(local.devices.label, 'RTX 3060 only');                 // a row with no `remote` is this machine's own
    const machine = { host: 'laptop', gpus: [{ vendor: 'intel', name: 'Iris Xe' }, { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4090 Laptop GPU' }] };
    const far = R.describeRun({ runner: 'opencode' }, { launch_command: cmd, n_ctx: 131072, devices: 'CUDA0', remote: { lane: 'laptop-4090' }, machine });
    // 2026-10-13: the ids of the launch are named from that machine's record, one by one (not "every card it has"),
    // and the machine is named in front: test/runlabelmachines.test.js has the laptop's two-card record
    assert.strictEqual(far.devices.label, 'laptop: RTX 4090 Laptop only');
    assert.deepStrictEqual(far.devices.names, ['RTX 4090 Laptop']);
    assert.strictEqual(far.devices.machine, 'laptop');
    assert.ok(!/3060/.test(far.line) && /laptop: RTX 4090 Laptop only/.test(far.line));
    // hardware not captured over there: the lane is named and the id stays an id -- never a card of this machine
    const unknown = R.describeRun({}, { launch_command: cmd, remote: { lane: 'laptop-4090', unverified: 'stale' }, machine: { host: 'laptop-4090 (served remotely; hardware not captured)' } });
    assert.strictEqual(unknown.devices.label, 'laptop-4090: CUDA0 only');
});
