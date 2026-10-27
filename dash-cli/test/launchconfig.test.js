import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DRAFT, DRAFT_KEYS, LEGACY_DEVICE_KEYS, sanitizeConfig, sanitizeDevices, legacyToDevices,
  needsDeviceConversion, convertLegacyConfig, configToDraft, draftToConfig, clampVerbosity,
  sharePercents, suggestShares, mergeCatalog, pollableWorkers, hasEnabledWorker, splitProblem,
  toggleDeviceAt, adjustShareAt, setShareAt, moveDeviceAt, cycleBackendAt,
  profileTag, deviceSummary, sortProfileEntries, unnamedDeviceNotes, uniqueWarnings,
} from '../src/launchconfig.js';

test('unnamedDeviceNotes flags enabled local devices restored without a card name; uniqueWarnings dedupes', () => {
  const notes = unnamedDeviceNotes([
    { id: 'Vulkan0' }, { id: 'Vulkan1', name: 'AMD Radeon RX 7900 XTX' }, { worker: 'laptop' }, { id: 'CUDA0', enabled: false },
  ]);
  assert.equal(notes.length, 1);
  assert.match(notes[0], /Vulkan0 was saved without a card name/);
  assert.deepEqual(uniqueWarnings(['a', 'b'], ['b', '', 'c'], []), ['a', 'b', 'c']);
});
import { gpuOnline, gpuTitles, gpuKey, shortGpuName } from '../src/format.js';

// A profile as the older web UI saved it: two-device fields PLUS the raw
// command box and keys the CLI has no field for.
const WEB_RPC_PROFILE = {
  modelPath: '/m/qwen-27b.gguf', build: 'cuda-vulkan', ctx: 65536, ngl: 99,
  deviceA: 'CUDA0', deviceB: 'Vulkan1', tensorSplit: 60,
  rpcTarget: 'laptop', transport: 'TB4',
  verbosity: 0,
  rawCommand: '/x/llama-server -m /m/other.gguf -c 4096',
  launchMode: 'local-multi-gpu', model: 'qwen-27b.gguf',
};

// /api/devices on the desktop's CUDA+Vulkan build (2026-09-13).
const CARDS = [
  { name: 'NVIDIA GeForce RTX 3060', vendor: 'nvidia', preferredId: 'CUDA0', ambiguous: false,
    backends: [{ id: 'CUDA0', totalMib: 11906, freeMib: 10000 }, { id: 'Vulkan0', totalMib: 12288, freeMib: 10000 }] },
  { name: 'AMD Radeon RX 7900 XTX', vendor: 'amd', preferredId: 'Vulkan1', ambiguous: false,
    backends: [{ id: 'Vulkan1', totalMib: 24560, freeMib: 20000 }] },
];
const WORKERS = [{ name: 'laptop', ssh: 'laptop', devices: 'CUDA0', deviceCount: 1, cache: true, link: 'ssh' }];

test('sanitizeConfig drops rawCommand and unknown keys, keeps legacy device keys for copying', () => {
  const out = sanitizeConfig({ ...WEB_RPC_PROFILE, preserveThinking: true, bogus: 1 });
  for (const k of ['rawCommand', 'launchMode', 'model', 'bogus']) assert.equal(k in out, false, `${k} dropped`);
  assert.equal(out.preserveThinking, true, 'legacy key buildLlamaArgs still honors');
  assert.equal(out.rpcTarget, 'laptop', 'a copied web profile keeps its device fields');
  for (const k of Object.keys(out)) assert.ok(DRAFT_KEYS.includes(k) || LEGACY_DEVICE_KEYS.includes(k), `${k} is known`);
  assert.deepEqual(sanitizeConfig(null), {});
});

test('sanitizeDevices normalizes entries and never keeps a bare RPC id', () => {
  assert.deepEqual(sanitizeDevices([
    { id: 'RPC0' }, { id: 'CUDA0,Vulkan1' }, null, { id: ' CUDA0 ', share: -1, extra: 1 },
    { worker: 'laptop', share: '30', id: 'RPC0' }, { id: 'Vulkan1', name: 'AMD Radeon RX 7900 XTX', share: 50, enabled: false },
  ]), [
    { id: 'CUDA0', share: null, enabled: true },
    { worker: 'laptop', share: 30, enabled: true },
    { id: 'Vulkan1', name: 'AMD Radeon RX 7900 XTX', share: 50, enabled: false },
  ]);
});

test('legacyToDevices mirrors the server conversion', () => {
  assert.deepEqual(legacyToDevices({ deviceA: 'CUDA0', deviceB: 'Vulkan1', tensorSplit: 40 }),
    [{ id: 'CUDA0', share: 40, enabled: true }, { id: 'Vulkan1', share: 60, enabled: true }]);
  assert.deepEqual(legacyToDevices({ deviceA: 'Vulkan1', rpcTarget: 'laptop', tensorSplit: 60 }),
    [{ id: 'Vulkan1', share: 60, enabled: true }, { worker: 'laptop', share: 40, enabled: true }]);
  assert.deepEqual(legacyToDevices({ deviceA: 'Vulkan0', deviceB: 'Vulkan0', tensorSplit: 60 }),
    [{ id: 'Vulkan0', share: null, enabled: true }]);
  assert.deepEqual(legacyToDevices({}), []);
  assert.equal(needsDeviceConversion(WEB_RPC_PROFILE), true);
  assert.equal(needsDeviceConversion({ devices: [], deviceA: 'CUDA0' }), false);
  assert.equal(needsDeviceConversion({ modelPath: '/m' }), false);
});

test('convertLegacyConfig uses the server preview (worker ids mapped back, warnings kept), else converts locally', async () => {
  const bodies = [];
  const client = {
    postJson: async (p, body) => {
      bodies.push([p, body]);
      return {
        command: '/x/llama-server ...',
        devices: [{ id: 'Vulkan1', name: 'AMD Radeon RX 7900 XTX', share: 60 }, { worker: 'laptop', share: 40, id: 'RPC0' }],
        warnings: ['AMD Radeon RX 7900 XTX moved from Vulkan0 to Vulkan1; using Vulkan1'],
      };
    },
  };
  const res = await convertLegacyConfig(client, { ...WEB_RPC_PROFILE, deviceA: 'Vulkan0', deviceB: null });
  assert.equal(bodies[0][0], '/api/preview-command');
  assert.equal('rawCommand' in bodies[0][1], false, 'the raw command is never sent for conversion');
  assert.deepEqual(res.devices, [
    { id: 'Vulkan1', name: 'AMD Radeon RX 7900 XTX', share: 60, enabled: true },
    { worker: 'laptop', share: 40, enabled: true },
  ]);
  assert.match(res.warnings[0], /moved from Vulkan0 to Vulkan1/);

  const down = await convertLegacyConfig({ postJson: async () => { throw new Error('fetch failed'); } }, WEB_RPC_PROFILE);
  assert.deepEqual(down.devices.map((d) => d.id || d.worker), ['CUDA0', 'Vulkan1'], 'local fallback');
  assert.deepEqual(down.warnings, []);
  const unresolved = await convertLegacyConfig({ postJson: async () => ({ command: '', error: 'modelPath is required' }) }, { rpcTarget: 'laptop' });
  assert.deepEqual(unresolved.devices, [{ worker: 'laptop', share: null, enabled: true }]);
});

test('configToDraft: explicit devices win, then the config list, then the legacy conversion; no legacy keys in the draft', () => {
  const given = configToDraft(WEB_RPC_PROFILE, DEFAULT_DRAFT, { devices: [{ id: 'Vulkan1', share: 70 }] });
  assert.deepEqual(given.devices, [{ id: 'Vulkan1', share: 70, enabled: true }]);
  for (const k of [...LEGACY_DEVICE_KEYS, 'rawCommand', 'launchMode']) assert.equal(k in given, false, `${k} not in draft`);
  assert.equal(given.transport, 'TB4');
  assert.equal(given.verbosity, 3, 'verbosity clamped up to the floor');

  const own = configToDraft({ modelPath: '/m/a.gguf', devices: [{ worker: 'laptop', enabled: false }], transport: null }, { ...DEFAULT_DRAFT, transport: 'WAN' });
  assert.deepEqual(own.devices, [{ worker: 'laptop', share: null, enabled: false }]);
  assert.equal(own.transport, 'WAN', 'null transport falls back to the base pick');

  const legacy = configToDraft(WEB_RPC_PROFILE);
  assert.deepEqual(legacy.devices.map((d) => d.id), ['CUDA0', 'Vulkan1'], 'GPU B wins over the worker, like the server');
});

test('configToDraft skipEmpty (prefill merge) does not blank base values', () => {
  const base = { ...DEFAULT_DRAFT, modelPath: '/m/a.gguf', build: 'vulkan' };
  const d = configToDraft({ modelPath: '', build: 'cuda', ctx: null, rawCommand: 'x' }, base, { skipEmpty: true });
  assert.equal(d.modelPath, '/m/a.gguf');
  assert.equal(d.build, 'cuda');
  assert.equal(d.ctx, 8192);
  assert.equal('rawCommand' in d, false);
});

test('draftToConfig sends devices (disabled rows kept), transport only with an enabled worker, never legacy keys', () => {
  const draft = {
    ...DEFAULT_DRAFT, modelPath: '/m/a.gguf', transport: 'WAN', rawCommand: 'nope', deviceA: 'X', rpcTarget: 'laptop',
    devices: [
      { id: 'Vulkan1', name: 'AMD Radeon RX 7900 XTX', share: 50, enabled: true },
      { worker: 'laptop', share: 30, enabled: true },
      { id: 'CUDA0', name: 'NVIDIA GeForce RTX 3060', share: null, enabled: false },
    ],
    specDraftDevice: 'Vulkan1',
  };
  const cfg = draftToConfig(draft);
  assert.deepEqual(cfg.devices, [
    { id: 'Vulkan1', name: 'AMD Radeon RX 7900 XTX', share: 50, enabled: true },
    { worker: 'laptop', share: 30, enabled: true },
    { id: 'CUDA0', name: 'NVIDIA GeForce RTX 3060', enabled: false },
  ]);
  assert.equal(cfg.transport, 'WAN');
  assert.equal(cfg.specDraftDevice, 'Vulkan1');
  for (const k of [...LEGACY_DEVICE_KEYS, 'rawCommand']) assert.equal(k in cfg, false, `${k} never sent`);

  const noWorker = draftToConfig({ ...draft, devices: [{ id: 'Vulkan1' }, { worker: 'laptop', enabled: false }], specDraftDevice: 'CUDA0', verbosity: null });
  assert.equal(noWorker.transport, null, 'a disabled worker does not send transport');
  assert.equal(noWorker.specDraftDevice, null, 'draft device must be an enabled local device');
  assert.equal(noWorker.verbosity, 3, 'a blanked verbosity still leaves as the floor');
  assert.equal(draftToConfig({ ...draft, specDraftDevice: 'RPC0' }).specDraftDevice, null, 'never a worker');
});

test('profile round-trip: old web profile -> draft -> config -> draft keeps the device list', () => {
  const cfg = draftToConfig(configToDraft({ modelPath: '/m/a.gguf', deviceA: 'Vulkan1', rpcTarget: 'laptop', tensorSplit: 60, transport: 'TB4' }));
  assert.deepEqual(cfg.devices, [{ id: 'Vulkan1', share: 60, enabled: true }, { worker: 'laptop', share: 40, enabled: true }]);
  assert.equal(cfg.transport, 'TB4');
  assert.deepEqual(configToDraft(cfg).devices, [{ id: 'Vulkan1', share: 60, enabled: true }, { worker: 'laptop', share: 40, enabled: true }]);
});

test('clampVerbosity floors at 3 (unset too, like the web restore)', () => {
  assert.equal(clampVerbosity(0), 3);
  assert.equal(clampVerbosity(2), 3);
  assert.equal(clampVerbosity(null), 3);
  assert.equal(clampVerbosity(''), 3);
  assert.equal(clampVerbosity('abc'), 3);
  assert.equal(clampVerbosity(3), 3);
  assert.equal(clampVerbosity(5), 5);
  assert.equal(DEFAULT_DRAFT.verbosity, 3);
});

test('sharePercents: 100 for one device, normalized when every share is set, auto otherwise', () => {
  assert.deepEqual(sharePercents([{ id: 'Vulkan1', share: 7 }]), [100]);
  assert.deepEqual(sharePercents([{ id: 'Vulkan1', share: 50 }, { worker: 'laptop', share: 30 }, { id: 'CUDA0', share: 20, enabled: false }]), [63, 38, null]);
  assert.deepEqual(sharePercents([{ id: 'Vulkan1', share: 50 }, { id: 'CUDA0' }]), ['auto', 'auto']);
  assert.deepEqual(sharePercents([{ id: 'Vulkan1', share: 0 }, { id: 'CUDA0', share: 0 }]), ['auto', 'auto']);
});

test('splitProblem: all blank (auto) or all set totaling 100; one device never needs a share', () => {
  assert.equal(splitProblem([{ id: 'Vulkan1', share: 7 }]), null);
  assert.equal(splitProblem([{ id: 'Vulkan1' }, { id: 'CUDA0' }]), null);
  assert.equal(splitProblem([{ id: 'CUDA0', share: 31 }, { id: 'Vulkan1', share: 69 }]), null);
  assert.equal(splitProblem([{ id: 'CUDA0', share: 50 }, { id: 'Vulkan1', share: 60 }, { worker: 'laptop', share: 30, enabled: false }]),
    'Shares total 110% -- they must add up to 100%.');
  assert.match(splitProblem([{ id: 'CUDA0', share: 50 }, { id: 'Vulkan1' }]), /every enabled device/);
});

test('suggestShares: free VRAM from cards and worker telemetry; a missing reading is estimated', () => {
  const devices = [{ id: 'Vulkan1' }, { worker: 'laptop' }, { id: 'CUDA0' }, { id: 'Vulkan0', enabled: false }];
  const gpus = [{ host: 'laptop', gpu_name: 'RTX 4090 Laptop', vram_total: 16000, vram_used: 6000, error: false }];
  const res = suggestShares(devices, { cards: CARDS, gpus });
  assert.deepEqual(res.devices.map((d) => d.share), [50, 25, 25, null], '20000 : 10000 : 10000');
  assert.equal(res.devices.filter((d) => d.enabled).reduce((a, d) => a + d.share, 0), 100);
  assert.deepEqual(res.notes, []);

  const est = suggestShares([{ id: 'Vulkan1' }, { worker: 'laptop' }], { cards: CARDS, gpus: [] });
  assert.deepEqual(est.devices.map((d) => d.share), [50, 50]);
  assert.match(est.notes[0], /laptop: no VRAM reading yet, estimated/);

  const single = suggestShares([{ id: 'Vulkan1' }], { cards: CARDS });
  assert.equal(single.devices[0].share, null, 'fewer than two enabled rows: unchanged');
});

test('mergeCatalog: one row per card and worker; name match re-points ids; missing flagged; idempotent', () => {
  // Saved when the XTX was Vulkan0 (with its name) plus a bare 3060 id.
  const rows = mergeCatalog([
    { id: 'Vulkan0', name: 'AMD Radeon RX 7900 XTX', share: 60 },
    { worker: 'laptop', share: 40 },
    { id: 'ROCm3' },
  ], CARDS, WORKERS);
  assert.deepEqual(rows.map((r) => r.entry), [
    { id: 'Vulkan1', name: 'AMD Radeon RX 7900 XTX', vramMib: 24560, share: 60, enabled: true },
    { worker: 'laptop', share: 40, enabled: true },
    { id: 'ROCm3', share: null, enabled: true },
    { id: 'CUDA0', name: 'NVIDIA GeForce RTX 3060', vramMib: 12288, share: null, enabled: false },
  ]);
  assert.equal(rows[2].missing, true);
  assert.equal(rows[3].card, CARDS[0]);
  const again = mergeCatalog(rows.map((r) => r.entry), CARDS, WORKERS).map((r) => r.entry);
  assert.deepEqual(again, rows.map((r) => r.entry), 'merging a merged list is a no-op');

  // bare id matches a card by backend and gains the card name; worker by ssh
  const bare = mergeCatalog([{ id: 'Vulkan0' }, { worker: 'laptop' }], CARDS, [{ ...WORKERS[0], name: 'lap' }]);
  assert.deepEqual(bare[0].entry, { id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3060', vramMib: 12288, share: null, enabled: true });
  assert.equal(bare[1].entry.worker, 'lap', 'ssh target resolves to the worker name');
});

test('mergeCatalog: a fresh draft enables discrete cards (not an iGPU), workers off', () => {
  const cards = [...CARDS, { name: 'Intel(R) Iris(R) Xe Graphics', preferredId: 'Vulkan2', backends: [{ id: 'Vulkan2' }] }];
  const rows = mergeCatalog([], cards, WORKERS);
  assert.deepEqual(rows.map((r) => [r.entry.id || r.entry.worker, r.entry.enabled]),
    [['CUDA0', true], ['Vulkan1', true], ['Vulkan2', false], ['laptop', false]]);
});

test('row edits: toggle, share, move, backend cycle', () => {
  const list = [{ id: 'CUDA0', name: 'NVIDIA GeForce RTX 3060' }, { worker: 'laptop', share: 10 }];
  assert.equal(toggleDeviceAt(list, 1)[1].enabled, false);
  assert.equal(adjustShareAt(list, 0, 5)[0].share, 5, 'unset share starts from 0');
  assert.equal(adjustShareAt(list, 1, -20)[1].share, 0, 'never below 0');
  assert.equal(setShareAt(list, 1, null)[1].share, null);
  assert.deepEqual(moveDeviceAt(list, 1, -1).map((d) => d.id || d.worker), ['laptop', 'CUDA0']);
  assert.deepEqual(moveDeviceAt(list, 0, -1).map((d) => d.id || d.worker), ['CUDA0', 'laptop'], 'edge: unchanged');
  assert.equal(cycleBackendAt(list, 0, CARDS[0])[0].id, 'Vulkan0');
  assert.equal(cycleBackendAt(cycleBackendAt(list, 0, CARDS[0]), 0, CARDS[0])[0].id, 'CUDA0', 'wraps');
  assert.equal(cycleBackendAt(list, 1, CARDS[0])[1].worker, 'laptop', 'workers have no backend');
});

test('pollableWorkers / hasEnabledWorker gate worker polling to enabled worker rows', () => {
  assert.deepEqual(pollableWorkers([{ id: 'CUDA0' }, { worker: 'laptop', enabled: false }]), []);
  assert.equal(hasEnabledWorker([{ worker: 'laptop', enabled: false }]), false);
  assert.deepEqual(pollableWorkers([{ worker: 'laptop' }, { worker: 'laptop' }, { worker: 'desk' }]), ['laptop', 'desk']);
});

test('profileTag + deviceSummary for both config shapes; sortProfileEntries', () => {
  assert.equal(profileTag({ rpcTarget: 'laptop' }), 'RPC');
  assert.equal(profileTag({ rpcTarget: '' }), 'Local');
  assert.equal(profileTag({}), 'Local');
  assert.equal(profileTag({ devices: [{ id: 'Vulkan1' }, { worker: 'laptop', enabled: false }] }), 'Local', 'a disabled worker is not RPC');
  assert.equal(profileTag({ devices: [{ worker: 'laptop' }] }), 'RPC');
  assert.equal(deviceSummary({ devices: [
    { id: 'Vulkan1', name: 'AMD Radeon RX 7900 XTX', share: 50 },
    { worker: 'laptop', share: 30 },
    { id: 'CUDA0', name: 'NVIDIA GeForce RTX 3060', share: 20 },
    { id: 'Vulkan0', enabled: false },
  ] }), 'RX 7900 XTX 50 · laptop 30 · RTX 3060 20');
  assert.equal(deviceSummary({ deviceA: 'CUDA0', rpcTarget: 'laptop', tensorSplit: 60 }), 'CUDA0 60 · laptop 40');
  assert.equal(deviceSummary({ modelPath: '/m' }), '');

  const sorted = sortProfileEntries({
    old: { config: { modelPath: '/a' }, savedAt: 100, lastLoadedAt: null },
    usedRecently: { config: { modelPath: '/b', rpcTarget: 'laptop' }, savedAt: 50, lastLoadedAt: 900 },
    newSave: { config: { modelPath: '/c' }, savedAt: 500, lastLoadedAt: null },
  });
  assert.deepEqual(sorted.map((e) => e.name), ['usedRecently', 'newSave', 'old']);
  assert.deepEqual(sortProfileEntries(null), []);
});

test('gpuOnline, gpuTitles, gpuKey, shortGpuName', () => {
  assert.equal(gpuOnline({ gpu_name: 'AMD Radeon RX 7900 XTX', amdgpu_top_error: false }), true);
  assert.equal(gpuOnline({ gpu_name: 'NVIDIA GeForce RTX 4090 Laptop GPU', error: false }), true);
  assert.equal(gpuOnline({ gpu_name: 'Offline' }), false);
  assert.equal(gpuOnline({ gpu_name: 'Unknown', nvidia_smi_error: true }), false);
  assert.equal(gpuOnline({ gpu_name: 'AMD Radeon', amdgpu_top_error: true }), false);
  assert.equal(gpuOnline(null), false);
  assert.deepEqual(gpuTitles(true), ['Local', 'Worker (rpc)']);
  assert.deepEqual(gpuTitles(false), ['GPU 0', 'GPU 1']);
  assert.equal(gpuKey('AMD Radeon RX 7900 XTX (RADV NAVI31)'), gpuKey('AMD Radeon RX 7900 XTX'));
  assert.equal(shortGpuName('NVIDIA GeForce RTX 4090 Laptop GPU'), 'RTX 4090 Laptop');
  assert.equal(shortGpuName('AMD Radeon RX 7900 XTX (RADV NAVI31)'), 'RX 7900 XTX');
});
