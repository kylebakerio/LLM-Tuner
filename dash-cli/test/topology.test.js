import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import App from '../src/app.js';
import { Launch } from '../src/modes/launch.js';
import { createAppStore } from '../src/state.js';
import {
  gpuKey, shortGpuName, normalizeTopology, topologyFromCatalog, cardOfId, deviceLabel, placementText,
  normalizeAvailability, matchGpusToCards, labelIdentical,
} from '../src/topology.js';
import { telemetryPanels, monitorPanels, lanesLine } from '../src/format.js';
import {
  sanitizeConfig, sanitizeDevices, mergeCatalog, configToDraft, draftToConfig, DEFAULT_DRAFT,
  splitModeOf, configSplitMode, withSplitMode, setSplitMode, describeSplitMode, SPLIT_MODES, repointNotes,
} from '../src/launchconfig.js';
import {
  profileRow, profileListRows, availabilityCounts, availabilityNote, filterRows, cardsCell,
  planCards, planSplit, splitTag, launchRisks, runningSummary, busyText, normalizeBusy, profileLaunchPlan,
} from '../src/launchplan.js';
import { listProfileState, listProfileEntries } from '../src/profiles.js';

// The CLI on machines it was not written on. Nothing in src/ may name a card:
// every label comes from the server's topology (GET /api/topology, and the
// copies sent with /api/profiles and /api/devices) or from a device's own
// name. Five machines, each exactly what the server's lib/topology.js build()
// returns for it:
//   oneCard       one AMD card, a Vulkan-only build
//   twoIdentical  two of the same card, each reachable as ROCm<n> and Vulkan<n>
//   mixed         one NVIDIA + one AMD card (the machine the older fixtures in
//                 this directory encode)
//   cpuOnly       no GPU at all
//   withWorker    one card plus an RPC worker on another machine
// Nothing here talks to a real server.

const XTX = 'AMD Radeon RX 7900 XTX';
const N3060 = 'NVIDIA GeForce RTX 3060';
const L4090 = 'NVIDIA GeForce RTX 4090 Laptop GPU';
const WORKER = { name: 'laptop', ssh: 'laptop', port: 50052, devices: 'CUDA0', deviceCount: 1, cache: true, link: 'ssh' };

const xtxCard = (ordinal, count, ids, orderAssumed = false) => ({
  key: `amd radeon rx 7900 xtx#${ordinal}`, name: XTX, short: 'RX 7900 XTX', label: count > 1 ? `RX 7900 XTX #${ordinal}` : 'RX 7900 XTX',
  vendor: 'amd', ordinal, count, vramMib: 24560, ids, preferredId: ids[0], orderAssumed,
});
const MACHINES = {
  oneCard: { cards: [xtxCard(1, 1, ['Vulkan0'])], hostRamMib: 32011, workers: [], signature: 'RX 7900 XTX 24G | 31G RAM' },
  twoIdentical: {
    cards: [xtxCard(1, 2, ['ROCm0', 'Vulkan0'], true), xtxCard(2, 2, ['ROCm1', 'Vulkan1'], true)],
    hostRamMib: 64223, workers: [], signature: '2x RX 7900 XTX 24G | 63G RAM',
  },
  mixed: {
    cards: [
      { key: 'nvidia geforce rtx 3060#1', name: N3060, short: 'RTX 3060', label: 'RTX 3060', vendor: 'nvidia', ordinal: 1, count: 1, vramMib: 12288, ids: ['CUDA0', 'Vulkan0'], preferredId: 'CUDA0', orderAssumed: false },
      xtxCard(1, 1, ['ROCm0', 'Vulkan1']),
    ],
    hostRamMib: 64223, workers: [], signature: 'RTX 3060 12G + RX 7900 XTX 24G | 63G RAM',
  },
  cpuOnly: { cards: [], hostRamMib: 32011, workers: [], signature: 'no GPU | 31G RAM' },
  withWorker: { cards: [xtxCard(1, 1, ['Vulkan0'])], hostRamMib: 32011, workers: [WORKER], signature: 'RX 7900 XTX 24G | 31G RAM' },
};
const T = Object.fromEntries(Object.entries(MACHINES).map(([k, v]) => [k, normalizeTopology(v)]));

// One telemetry GPU entry (monitor.py's shape).
const gpu = (over) => ({
  host: 'local', index: 0, pci: '', vendor: 'amd', gpu_name: XTX, gpu_util: 10, vram_used: 1000, vram_total: 24560,
  process_vram: 0, gpu_pwr: 50, gpu_temp: 50, gpu_throttle: false, throttle_reasons: [], error: false, ...over,
});
const LOCAL_HOST = { cpu_name: 'AMD Ryzen 7 5800X', cpu_util: 12, cpu_temp: 55, ram_used: 20000, ram_total: 64223, net_bytes: 100, error: false };
// What the live two-card machine sends with nothing launched (2026-10-12).
const TWO_IDLE = {
  hosts: { local: LOCAL_HOST },
  gpus: [gpu({ index: 0, pci: '0b:00.0', gpu_util: 3 }), gpu({ index: 1, pci: '0e:00.0', gpu_util: 97, vram_used: 20000 })],
  devices: null,
};

// ---- names and labels ----

test('shortGpuName: derived from the card name -- vendor / product-line words and the driver note dropped', () => {
  assert.equal(shortGpuName('AMD Radeon RX 7900 XTX (RADV NAVI31)'), 'RX 7900 XTX');
  assert.equal(shortGpuName(N3060), 'RTX 3060');
  assert.equal(shortGpuName(L4090), 'RTX 4090 Laptop');
  assert.equal(shortGpuName('Intel(R) Arc(TM) A770 Graphics'), 'Arc A770');
  assert.equal(shortGpuName('NVIDIA RTX A6000'), 'RTX A6000');
  assert.equal(shortGpuName('Apple M2 Max'), 'Apple M2 Max', 'a name with nothing to drop is kept');
  assert.equal(shortGpuName('GPU'), 'GPU', 'never reduced to nothing');
  assert.equal(shortGpuName(''), '');
  assert.equal(gpuKey('AMD Radeon RX 7900 XTX (RADV NAVI31)'), gpuKey(XTX), 'one card across backends');
});

test('normalizeTopology: null = unknown (not "no cards"); fields a server left out are derived', () => {
  assert.equal(normalizeTopology(undefined), null);
  assert.equal(normalizeTopology({}), null, 'an older server (or a stub) that answers {}');
  assert.equal(normalizeTopology({ signature: 'x' }), null, 'no cards array');
  assert.deepEqual(T.cpuOnly.cards, [], 'a CPU-only machine is a known topology with no cards');
  assert.equal(T.cpuOnly.signature, 'no GPU | 31G RAM');
  assert.deepEqual(normalizeTopology(MACHINES.twoIdentical), MACHINES.twoIdentical, 'the server shape passes through unchanged');

  // Only names: labels, ordinals, keys and the signature are worked out here.
  const bare = normalizeTopology({ cards: [{ name: XTX, vramMib: 24560, ids: ['Vulkan0'] }, { name: `${XTX} (RADV NAVI31)`, vramMib: 24560, ids: ['Vulkan1'] }, { name: N3060, vramMib: 12288, ids: ['CUDA0'] }], hostRamMib: 64223 });
  assert.deepEqual(bare.cards.map((c) => [c.label, c.key, c.preferredId]), [
    ['RX 7900 XTX #1', 'amd radeon rx 7900 xtx#1', 'Vulkan0'],
    ['RX 7900 XTX #2', 'amd radeon rx 7900 xtx#2', 'Vulkan1'],
    ['RTX 3060', 'nvidia geforce rtx 3060#1', 'CUDA0'],
  ]);
  assert.equal(bare.signature, '2x RX 7900 XTX 24G + RTX 3060 12G | 63G RAM', 'same format as the server');
  assert.deepEqual(normalizeTopology({ cards: [], workers: ['laptop', null, { name: 'desk' }] }).workers, [{ name: 'laptop' }, { name: 'desk' }]);
});

test('topologyFromCatalog: /api/devices `cards` from a server that sends no topology', () => {
  const two = topologyFromCatalog([
    { name: XTX, vendor: 'amd', preferredId: 'ROCm0', backends: [{ id: 'ROCm0', totalMib: 24560 }, { id: 'Vulkan0', totalMib: 24560 }] },
    { name: XTX, vendor: 'amd', preferredId: 'ROCm1', backends: [{ id: 'ROCm1', totalMib: 24560 }, { id: 'Vulkan1', totalMib: 24560 }] },
  ], [WORKER]);
  assert.deepEqual(two.cards.map((c) => [c.label, c.ids, c.vramMib]), [
    ['RX 7900 XTX #1', ['ROCm0', 'Vulkan0'], 24560], ['RX 7900 XTX #2', ['ROCm1', 'Vulkan1'], 24560],
  ]);
  assert.equal(two.workers[0].name, 'laptop');
  assert.equal(topologyFromCatalog(null), null);
  assert.deepEqual(topologyFromCatalog([]).cards, []);
});

test('cardOfId / deviceLabel: the same card through every backend; identical cards told apart', () => {
  assert.equal(cardOfId(T.twoIdentical, 'Vulkan1').label, 'RX 7900 XTX #2');
  assert.equal(cardOfId(T.twoIdentical, 'ROCm1').key, cardOfId(T.twoIdentical, 'Vulkan1').key, 'one physical card, two ids');
  assert.equal(cardOfId(T.twoIdentical, 'CUDA0'), null);
  assert.equal(cardOfId(null, 'ROCm0'), null, 'no topology');
  assert.equal(deviceLabel(T.twoIdentical, { id: 'ROCm1', name: XTX }), 'RX 7900 XTX #2');
  assert.equal(deviceLabel(T.mixed, { id: 'CUDA0', name: N3060 }), 'RTX 3060', 'a card with no twin gets no number');
  assert.equal(deviceLabel(T.twoIdentical, { id: 'CUDA0', name: N3060 }), 'RTX 3060', 'not in this machine: its own name, shortened');
  assert.equal(deviceLabel(T.mixed, { id: 'Vulkan0', name: XTX }), 'RX 7900 XTX', 'an id that now reaches a different card is not given that card\'s label');
  assert.equal(deviceLabel(null, { id: 'Vulkan3' }), 'Vulkan3');
  assert.equal(deviceLabel(T.withWorker, { worker: 'laptop' }), 'laptop (RPC)');
});

test('placementText: the server\'s wording, on every machine', () => {
  const both = [{ id: 'ROCm0', name: XTX, share: 50 }, { id: 'ROCm1', name: XTX, share: 50 }];
  assert.equal(placementText(both, T.twoIdentical), '2x RX 7900 XTX, 1:1');
  assert.equal(placementText([{ id: 'ROCm0', name: XTX, share: 47 }, { id: 'ROCm1', name: XTX, share: 1 }], T.twoIdentical), '2x RX 7900 XTX, 47:1');
  assert.equal(placementText([{ id: 'ROCm1', name: XTX, share: 100 }], T.twoIdentical), 'RX 7900 XTX #2 alone');
  assert.equal(placementText([{ id: 'Vulkan0', name: XTX }], T.oneCard), 'RX 7900 XTX alone');
  assert.equal(placementText([{ id: 'ROCm0', name: XTX, share: 75 }, { id: 'CUDA0', name: N3060, share: 25 }], T.mixed), 'RX 7900 XTX + RTX 3060, 3:1');
  assert.equal(placementText([{ id: 'Vulkan0', name: XTX, share: 60 }, { worker: 'laptop', share: 40 }], T.withWorker), 'RX 7900 XTX + laptop (RPC), 3:2');
  assert.equal(placementText(both, T.twoIdentical.cards.length ? { ...T.twoIdentical } : null), '2x RX 7900 XTX, 1:1');
  assert.equal(placementText([{ id: 'ROCm0', name: XTX }, { id: 'ROCm1', name: XTX }], T.twoIdentical), '2x RX 7900 XTX', 'auto split: no ratio');
  assert.equal(placementText([], T.cpuOnly), 'CPU only');
  assert.equal(placementText(both, null), '2x RX 7900 XTX, 1:1', 'no topology: from the names the profile stored');
});

// ---- availability: which saved profiles this machine can run ----

const p = (devices, extra = {}) => ({ modelPath: '/models/alpha-27b-Q4_K_XL.gguf', build: 'all', ctx: 131072, ngl: 999, devices, ...extra });
const NOW = Date.now();
// Saved profiles, with the availability the server computes for them on the
// two-identical-cards machine (lib/topology.js availability()).
const TWO_PROFILES = {
  'old · one NVIDIA card': { config: p([{ id: 'CUDA0', name: N3060, share: 100 }]), savedAt: 1, lastLoadedAt: NOW - 60000 },
  'both cards · layer': { config: p([{ id: 'ROCm0', name: XTX, share: 50 }, { id: 'ROCm1', name: XTX, share: 50 }], { tuningNote: 'two-card layer split' }), savedAt: 2, lastLoadedAt: NOW - 3600000 },
  'both cards · tensor': { config: p([{ id: 'ROCm0', name: XTX, share: 50 }, { id: 'ROCm1', name: XTX, share: 50 }], { argString: '-sm tensor' }), savedAt: 3, lastLoadedAt: NOW - 2 * 3600000 },
  'second card only': { config: p([{ id: 'ROCm1', name: XTX, share: 100 }]), savedAt: 4, lastLoadedAt: NOW - 3 * 3600000 },
  'stand-in · small card': { config: p([{ id: 'CUDA0', name: N3060, vramMib: 12288, share: 100 }]), savedAt: 5, lastLoadedAt: NOW - 4 * 3600000 },
  'strata coder': { config: { engine: 'strata', strataBase: '/strata/strata-coder.json', needs: { vendor: 'amd', minVramMib: 24000 } }, savedAt: 6, lastLoadedAt: NOW - 5 * 3600000 },
};
const TWO_AVAILABILITY = {
  'old · one NVIDIA card': { status: 'unavailable', reason: 'Needs RTX 3060.', placement: null },
  'both cards · layer': { status: 'ready', reason: '', placement: '2x RX 7900 XTX, 1:1' },
  'both cards · tensor': { status: 'ready', reason: '', placement: '2x RX 7900 XTX, 1:1' },
  'second card only': { status: 'ready', reason: '', placement: 'RX 7900 XTX #2 alone' },
  'stand-in · small card': { status: 'substitute', reason: 'RTX 3060 is not in this machine; RX 7900 XTX #1 (24 GB) stands in. Not validated on this machine.', placement: 'RX 7900 XTX #1 alone' },
  'strata coder': { status: 'ready', reason: '', placement: null },
};
const entriesOf = (profiles) => Object.entries(profiles)
  .map(([name, e]) => ({ name, ...e }))
  .sort((a, b) => (b.lastLoadedAt || b.savedAt) - (a.lastLoadedAt || a.savedAt));

test('normalizeAvailability: a missing or unknown entry reads as ready', () => {
  assert.deepEqual(normalizeAvailability(undefined), { status: 'ready', reason: '', placement: null });
  assert.deepEqual(normalizeAvailability({ status: 'someday', reason: 'x' }), { status: 'ready', reason: 'x', placement: null });
  assert.deepEqual(normalizeAvailability({ status: 'moved', reason: ' a is now b. ', placement: ' X alone ' }), { status: 'moved', reason: 'a is now b.', placement: 'X alone' });
  // The re-pointed device list rides along for moved / substitute only.
  const devices = [{ id: 'Vulkan1', name: XTX, share: 100 }];
  assert.deepEqual(normalizeAvailability({ status: 'moved', reason: 'x', placement: 'y', devices }).devices, devices);
  assert.equal('devices' in normalizeAvailability({ status: 'ready', devices }), false);
  assert.equal('devices' in normalizeAvailability({ status: 'unavailable', reason: 'Needs RTX 3060.', devices }), false);
});

test('profile rows: runnable profiles first, unavailable ones last with the server\'s reason; placement is the server\'s text', () => {
  const rows = profileListRows(entriesOf(TWO_PROFILES), { availability: TWO_AVAILABILITY, topology: T.twoIdentical, now: NOW });
  assert.deepEqual(rows.map((r) => r.name), [
    'both cards · layer', 'both cards · tensor', 'second card only', 'stand-in · small card', 'strata coder', 'old · one NVIDIA card',
  ], 'most recently used first among the runnable; the most recently used of all is last because it cannot run here');
  const by = Object.fromEntries(rows.map((r) => [r.name, r]));
  assert.equal(by['both cards · layer'].cards, '2x RX 7900 XTX, 1:1');
  assert.equal(by['both cards · tensor'].cards, '2x RX 7900 XTX, 1:1 · tensor', 'two profiles that differ only in split mode are not the same row');
  assert.equal(by['second card only'].cards, 'RX 7900 XTX #2 alone');
  assert.equal(by['strata coder'].cards, 'Strata engine', 'the server gives a Strata profile no placement');
  assert.equal(by['stand-in · small card'].runnable, true);
  assert.match(by['stand-in · small card'].availNote, /^stand-in card — RTX 3060 is not in this machine; RX 7900 XTX #1 \(24 GB\) stands in\./);
  const off = by['old · one NVIDIA card'];
  assert.equal(off.runnable, false);
  assert.equal(off.cards, 'Needs RTX 3060.', 'the placement cell carries the reason');
  assert.equal(off.status, 'unavailable');
  assert.equal(off.availNote, 'can\'t run on this machine — Needs RTX 3060.');
  assert.deepEqual(availabilityCounts(rows), { total: 6, unavailable: 1, moved: 0, substitute: 1, runnable: 5 });
  assert.deepEqual(filterRows(rows, 'unavailable').map((r) => r.name), ['old · one NVIDIA card'], 'searchable by status');
  assert.deepEqual(filterRows(rows, 'needs rtx').map((r) => r.name), ['old · one NVIDIA card'], 'and by reason');

  assert.equal(availabilityNote({ status: 'moved', reason: 'RX 7900 XTX: ROCm0 is now Vulkan0.' }), 'device ids changed — RX 7900 XTX: ROCm0 is now Vulkan0.');
  assert.equal(availabilityNote({ status: 'ready', reason: '' }), '');
});

test('profile rows without `availability` (older server): every profile ready, list order untouched, placement derived', () => {
  const entries = entriesOf(TWO_PROFILES);
  const rows = profileListRows(entries, { now: NOW });
  assert.deepEqual(rows.map((r) => r.name), entries.map((e) => e.name), 'plain most-recently-used order');
  assert.ok(rows.every((r) => r.runnable && r.avail.status === 'ready' && r.availNote === ''));
  assert.equal(rows[0].cards, 'RTX 3060 alone', 'from the profile\'s own device names');
  assert.equal(rows.find((r) => r.name === 'both cards · layer').cards, '2x RX 7900 XTX, 1:1');
  assert.equal(availabilityCounts(rows).unavailable, 0);
  // The same profiles on a machine whose topology is known but that sent no availability.
  assert.equal(profileRow(entries[3], { topology: T.twoIdentical }).cards, 'RX 7900 XTX #2 alone');
  assert.equal(cardsCell({ devices: [] }, T.cpuOnly), 'auto');
});

test('listProfileState: availability and topology ride along with the entries; absent on an older server', async () => {
  const doc = { version: 3, profiles: TWO_PROFILES, availability: TWO_AVAILABILITY, topology: MACHINES.twoIdentical };
  const st = await listProfileState({ baseUrl: 'http://fake', getJson: async () => doc });
  assert.equal(st.entries[0].name, 'old · one NVIDIA card');
  assert.equal(st.availability['second card only'].placement, 'RX 7900 XTX #2 alone');
  assert.equal(st.topology.signature, '2x RX 7900 XTX 24G | 63G RAM');
  const old = await listProfileState({ baseUrl: 'http://fake', getJson: async () => ({ version: 3, profiles: TWO_PROFILES }) });
  assert.equal(old.availability, null);
  assert.equal(old.topology, null);
  assert.deepEqual(old.entries, await listProfileEntries({ baseUrl: 'http://fake', getJson: async () => doc }), 'same entries either way');
});

// ---- the review panel's cards, split mode and risks ----

test('planCards: topology labels with the id in use -- two identical cards read #1 and #2', () => {
  const both = { devices: [{ id: 'ROCm0', name: XTX, share: 50 }, { id: 'ROCm1', name: XTX, share: 50 }] };
  assert.deepEqual(planCards(null, both, T.twoIdentical), [
    { text: 'RX 7900 XTX #1 (ROCm0)', share: '50%' }, { text: 'RX 7900 XTX #2 (ROCm1)', share: '50%' },
  ]);
  assert.deepEqual(planCards([{ id: 'Vulkan1', name: `${XTX} (RADV NAVI31)` }], both, T.twoIdentical), [{ text: 'RX 7900 XTX #2 (Vulkan1)', share: '' }], 'the preview\'s plan wins; the same card through another backend keeps its label');
  assert.deepEqual(planCards(null, { devices: [{ id: 'ROCm0', name: XTX, share: 75 }, { id: 'CUDA0', name: N3060, share: 25 }] }, T.mixed), [
    { text: 'RX 7900 XTX (ROCm0)', share: '75%' }, { text: 'RTX 3060 (CUDA0)', share: '25%' },
  ]);
  assert.deepEqual(planCards([{ id: 'Vulkan0', name: XTX, share: 60 }, { worker: 'laptop', share: 40, id: 'RPC0' }], {}, T.withWorker), [
    { text: 'RX 7900 XTX (Vulkan0)', share: '60%' }, { text: 'RPC laptop (RPC0)', share: '40%' },
  ]);
  assert.deepEqual(planCards(null, { devices: [] }, T.cpuOnly), []);
});

test('split mode: layer by default, tensor through "-sm tensor" in the raw args; row is flagged and never offered', () => {
  assert.deepEqual(SPLIT_MODES, ['layer', 'tensor'], 'the modes on offer');
  assert.equal(splitModeOf(''), null);
  assert.equal(splitModeOf('-sm tensor'), 'tensor');
  assert.equal(splitModeOf('--split-mode layer -dev ROCm0,ROCm1 -ts 50,50 -sm tensor'), 'tensor', 'the last one wins, as in llama-server');
  assert.equal(splitModeOf("--split-mode='row'"), 'row');
  assert.equal(splitModeOf('--fit off -smx tensor'), null, 'only the real flag');

  assert.equal(withSplitMode('', 'tensor'), '-sm tensor');
  assert.equal(withSplitMode('--fit off -sm row', 'tensor'), '--fit off -sm tensor');
  assert.equal(withSplitMode('--split-mode row --fit off -sm tensor', 'layer'), '--fit off', 'layer needs no flag: the dashboard emits it');
  assert.equal(withSplitMode('-sm tensor', 'row'), '', 'row can not be set through here');
  assert.equal(withSplitMode("-ot 'blk\\.1\\..*=ROCm1' -sm tensor", 'layer'), "-ot 'blk\\.1\\..*=ROCm1'", 'other arguments untouched');

  assert.equal(describeSplitMode(null).mode, 'layer');
  assert.equal(describeSplitMode(null).level, 'ok');
  assert.match(describeSplitMode('tensor').text, /^tensor \(-sm tensor\) — experimental/);
  assert.equal(describeSplitMode('tensor').level, 'warn');
  assert.equal(describeSplitMode('row').level, 'bad');
  assert.match(describeSplitMode('row').text, /deprecated in llama\.cpp, fails to load/);
  assert.ok(Object.values({ a: null, b: 'tensor', c: 'row', d: 'none' }).every((m) => describeSplitMode(m).text.length <= 62), 'fits the editor row at 80 columns');

  assert.equal(planSplit(1, { command: '-sm tensor' }, {}), null, 'one device: nothing is split');
  assert.equal(planSplit(2, { command: '/x/llama-server --split-mode layer -dev ROCm0,ROCm1' }, {}).mode, 'layer');
  assert.equal(planSplit(2, { command: '/x/llama-server --split-mode layer -dev ROCm0,ROCm1 -sm tensor' }, {}).mode, 'tensor', 'read from the resolved command');
  assert.equal(planSplit(2, { command: '/x/llama-server --split-mode tensor -dev ROCm0,ROCm1' }, {}).mode, 'tensor');
  assert.equal(planSplit(2, { command: '' }, { argString: '-sm tensor' }).mode, 'tensor', 'the config, until the command is resolved');
  assert.equal(planSplit(2, { command: '/x/llama-server --split-mode layer', splitMode: 'tensor' }, {}).mode, 'tensor', 'the server\'s own word for it wins');
  assert.equal(planSplit(2, null, { splitMode: 'tensor' }).mode, 'tensor');
});

test('split mode in the config: the `splitMode` field or the raw args (which win); written to exactly one of them; never lost on the way to /api/start', async () => {
  assert.equal(configSplitMode({}), null);
  assert.equal(configSplitMode({ splitMode: 'Tensor' }), 'tensor');
  assert.equal(configSplitMode({ splitMode: 'tensor', argString: '-sm layer' }), 'layer', 'a -sm in the raw args comes later on the command line');
  assert.equal(configSplitMode({ splitMode: 'row' }), 'row', 'reported, so it can be flagged');

  // A server that has not said it knows the field: the raw args, which every server reads.
  assert.deepEqual(setSplitMode({ argString: '--fit off' }, 'tensor'), { splitMode: null, argString: '--fit off -sm tensor' });
  assert.deepEqual(setSplitMode({ argString: '--fit off -sm tensor', splitMode: 'tensor' }, 'layer'), { splitMode: null, argString: '--fit off' });
  // One that has: the field, and the raw args lose their -sm.
  assert.deepEqual(setSplitMode({ argString: '--fit off -sm row' }, 'tensor', { useField: true }), { splitMode: 'tensor', argString: '--fit off' });
  assert.deepEqual(setSplitMode({ argString: '-sm tensor', splitMode: 'tensor' }, 'layer', { useField: true }), { splitMode: null, argString: '' });
  assert.deepEqual(setSplitMode({ argString: '' }, 'row', { useField: true }), { splitMode: null, argString: '' }, 'row can not be set');

  assert.equal(splitTag({ devices: [{ id: 'ROCm0' }, { id: 'ROCm1' }], splitMode: 'tensor' }), ' · tensor');
  assert.equal(splitTag({ devices: [{ id: 'ROCm0' }, { id: 'ROCm1' }] }), '', 'layer is the default: not spelled out');
  assert.equal(splitTag({ devices: [{ id: 'ROCm0' }], argString: '-sm tensor' }), '', 'one device: nothing is split');

  // A profile the web UI saved with the field launches from the CLI with it.
  const web = p([{ id: 'ROCm0', name: XTX, share: 50 }, { id: 'ROCm1', name: XTX, share: 50 }], { splitMode: 'tensor', rawCommand: '/x/llama-server' });
  assert.equal(sanitizeConfig(web).splitMode, 'tensor');
  const plan = await profileLaunchPlan({ postJson: async () => ({}) }, web);
  assert.equal(plan.config.splitMode, 'tensor');
  assert.equal('splitMode' in (await profileLaunchPlan({ postJson: async () => ({}) }, p([{ id: 'ROCm0', name: XTX }]))).config, false, 'not sent by a config that does not carry it (an older server never sees the key)');
});

test('launchRisks: an overridden unavailable profile, a stand-in card and a deprecated split each ask a second time', () => {
  const idle = runningSummary({ state: 'stopped' }, null, NOW, T.twoIdentical);
  assert.deepEqual(launchRisks({ running: idle, port: 8095, avail: { status: 'ready', reason: '' }, split: describeSplitMode('tensor') }), [], 'tensor split alone is not a second question');
  const off = launchRisks({ running: idle, port: 8095, avail: TWO_AVAILABILITY['old · one NVIDIA card'] });
  assert.deepEqual(off.map((r) => r.kind), ['unavailable']);
  assert.equal(off[0].text, 'launch a profile this machine can\'t run as saved — Needs RTX 3060.');
  assert.deepEqual(launchRisks({ running: idle, port: 8095, avail: TWO_AVAILABILITY['stand-in · small card'] }).map((r) => r.kind), ['substitute']);
  assert.deepEqual(launchRisks({ running: idle, port: 8095, avail: { status: 'moved', reason: 'x' } }), [], 'moved ids are a note, not a risk');
  assert.deepEqual(launchRisks({ running: idle, port: 8095, split: describeSplitMode('row') }).map((r) => r.kind), ['split']);
  // Busy text reads right with per-card labels: which of two identical cards is busy.
  const busy = normalizeBusy([{ lane: 'local-2', device: 'ROCm1', card: 'RX 7900 XTX #2', cardKey: 'amd radeon rx 7900 xtx#2', itemId: 901, label: 'bench-alpha' }]);
  assert.equal(busyText(busy[0]), 'RX 7900 XTX #2 (ROCm1) — queue item 901 “bench-alpha” · lane local-2');
  assert.equal(runningSummary({ state: 'ready', model: 'a.gguf', launchConfig: TWO_PROFILES['second card only'].config }, null, NOW, T.twoIdentical).cards, 'RX 7900 XTX #2 alone');
});

// ---- the config editor's device rows ----

const twoCards = (ids1, ids2) => [ids1, ids2].map((ids) => ({
  name: XTX, vendor: 'amd', preferredId: ids[0], ambiguous: true, backends: ids.map((id) => ({ id, totalMib: 24560, freeMib: 24000 })),
}));

test('mergeCatalog with two identical cards: a row saved for the second card stays on the second card', () => {
  const cards = twoCards(['ROCm0', 'Vulkan0'], ['ROCm1', 'Vulkan1']);
  const second = mergeCatalog([{ id: 'ROCm1', name: XTX, share: 100 }], cards, []);
  assert.deepEqual(second.map((r) => [r.entry.id, r.entry.enabled, r.card === cards[1]]), [['ROCm1', true, true], ['ROCm0', false, false]]);
  assert.equal(second[0].entry.vramMib, 24560, 'the card\'s size is recorded with the row');

  const swapped = mergeCatalog([{ id: 'ROCm1', name: XTX, share: 30 }, { id: 'ROCm0', name: XTX, share: 70 }], cards, []);
  assert.deepEqual(swapped.map((r) => [r.entry.id, r.entry.share]), [['ROCm1', 30], ['ROCm0', 70]], 'saved order (-dev order) kept, no id re-pointed');
  assert.deepEqual(mergeCatalog(swapped.map((r) => r.entry), cards, []).map((r) => r.entry), swapped.map((r) => r.entry), 'idempotent');

  // The same two rows opened for a build that only has Vulkan ids: one card each, in order.
  const vk = twoCards(['Vulkan0'], ['Vulkan1']);
  assert.deepEqual(mergeCatalog([{ id: 'ROCm0', name: XTX }, { id: 'ROCm1', name: XTX }], vk, []).map((r) => r.entry.id), ['Vulkan0', 'Vulkan1']);
  // The second card ALONE, on that build: still the second card (not the first free one), and it says it chose.
  const lone = mergeCatalog([{ id: 'ROCm1', name: XTX, share: 100 }], vk, []);
  assert.deepEqual(lone.map((r) => [r.entry.id, r.entry.enabled, r.card === vk[1]]), [['Vulkan1', true, true], ['Vulkan0', false, false]]);
  assert.deepEqual(lone[0].repointed, { from: 'ROCm1', to: 'Vulkan1', identical: true });
  assert.deepEqual(repointNotes(lone, (e) => deviceLabel(topologyFromCatalog(vk), e)), [
    'ROCm1 is not an id in this build: using RX 7900 XTX #2 (Vulkan1) — one of several identical cards, check it is the one you meant',
  ]);
  assert.deepEqual(repointNotes(mergeCatalog(lone.map((r) => r.entry), vk, [])), [], 'once: the merged list has nothing left to re-point');
  // The machine's fullest listing decides when it knows the id (here: saved id index 1, but the reference says card #1).
  const ref = normalizeTopology({ cards: [{ name: XTX, ids: ['Vulkan0', 'SYCL1'] }, { name: XTX, ids: ['Vulkan1', 'SYCL0'] }] });
  assert.equal(mergeCatalog([{ id: 'SYCL1', name: XTX }], vk, [], { reference: ref })[0].entry.id, 'Vulkan0');
  assert.equal(mergeCatalog([{ id: 'SYCL1', name: XTX }], vk, [])[0].entry.id, 'Vulkan1', 'without one: the id\'s own position');
  // A card with no twin moves without a note (there is nothing to choose).
  const single = mergeCatalog([{ id: 'ROCm0', name: XTX }], [vk[0]], []);
  assert.equal(single[0].entry.id, 'Vulkan0');
  assert.deepEqual(repointNotes(single), []);
  // A fresh draft on any machine: every discrete card on, auto split.
  assert.deepEqual(mergeCatalog([], cards, [WORKER]).map((r) => [r.entry.id || r.entry.worker, r.entry.enabled]), [['ROCm0', true], ['ROCm1', true], ['laptop', false]]);
  assert.deepEqual(mergeCatalog([], [], []), [], 'CPU-only: no rows');
  // A card that is not in this machine stays as a flagged row instead of silently becoming another card.
  const gone = mergeCatalog([{ id: 'CUDA0', name: N3060, vramMib: 12288, share: 100 }], cards, []);
  assert.equal(gone[0].missing, true);
  assert.equal(gone[0].entry.vramMib, 12288, 'its saved size is kept (the server\'s stand-in check reads it)');
});

test('a profile\'s hardware fields survive the editor round trip: device vramMib and `needs`', () => {
  assert.deepEqual(sanitizeDevices([{ id: 'ROCm0', name: XTX, vramMib: 24560, share: 50 }, { id: 'ROCm1', vramMib: 'x' }, { worker: 'laptop', vramMib: 16000 }]), [
    { id: 'ROCm0', name: XTX, vramMib: 24560, share: 50, enabled: true },
    { id: 'ROCm1', share: null, enabled: true },
    { worker: 'laptop', share: null, enabled: true },
  ]);
  const saved = p([{ id: 'ROCm0', name: XTX, vramMib: 24560, share: 100 }], { needs: { hostRamMib: 47000, minCards: 1 }, rawCommand: '/x/llama-server' });
  assert.deepEqual(sanitizeConfig(saved).needs, { hostRamMib: 47000, minCards: 1 });
  const out = draftToConfig(configToDraft(saved, DEFAULT_DRAFT));
  assert.deepEqual(out.needs, { hostRamMib: 47000, minCards: 1 });
  assert.deepEqual(out.devices, [{ id: 'ROCm0', name: XTX, vramMib: 24560, share: 100, enabled: true }]);
  assert.equal('rawCommand' in out, false);
  assert.equal('needs' in draftToConfig(configToDraft(p([]), DEFAULT_DRAFT)), false, 'not invented for a profile without it');
});

// ---- Monitor's GPU panels ----

test('labelIdentical / matchGpusToCards: the n-th reading of a model is card #n', () => {
  assert.deepEqual(labelIdentical([{ name: XTX }, { name: N3060 }, { name: `${XTX} (RADV NAVI31)` }]).map((x) => x.label), ['RX 7900 XTX #1', 'RTX 3060', 'RX 7900 XTX #2']);
  const { byCard, rest } = matchGpusToCards([...TWO_IDLE.gpus, gpu({ host: 'laptop', gpu_name: L4090 })], T.twoIdentical);
  assert.equal(byCard.get('amd radeon rx 7900 xtx#1').pci, '0b:00.0');
  assert.equal(byCard.get('amd radeon rx 7900 xtx#2').pci, '0e:00.0');
  assert.deepEqual(rest.map((g) => g.host), ['laptop'], 'another host\'s card is no card of this machine');
  // Listed in the other order: still by PCI address, the server's own rule.
  assert.equal(matchGpusToCards([TWO_IDLE.gpus[1], TWO_IDLE.gpus[0]], T.twoIdentical).byCard.get('amd radeon rx 7900 xtx#1').pci, '0b:00.0');
  // A server that says which card a reading is (`card`): that, whatever the order or the addresses.
  const said = [{ ...TWO_IDLE.gpus[0], label: 'RX 7900 XTX #2', card: 'amd radeon rx 7900 xtx#2' }, { ...TWO_IDLE.gpus[1], label: 'RX 7900 XTX #1', card: 'amd radeon rx 7900 xtx#1' }];
  assert.equal(matchGpusToCards(said, T.twoIdentical).byCard.get('amd radeon rx 7900 xtx#1').pci, '0e:00.0');
  assert.deepEqual(telemetryPanels({ ...TWO_IDLE, gpus: said }, false, T.twoIdentical).map((x) => [x.title, x.name]), [['RX 7900 XTX #1', '0e:00.0'], ['RX 7900 XTX #2', '0b:00.0']]);

  // A card this client has never seen, named differently by llama.cpp and by
  // the telemetry tool: still one panel, under the topology's label.
  const arc = normalizeTopology({ cards: [{ name: 'Intel(R) Arc(TM) A770 Graphics (DG2)', vendor: 'intel', vramMib: 16288, ids: ['Vulkan0'] }], hostRamMib: 32011 });
  const reading = gpu({ vendor: 'intel', gpu_name: 'Intel Corporation DG2 [Arc A770]', pci: '03:00.0', gpu_util: 44 });
  assert.equal(matchGpusToCards([reading], arc).byCard.get(arc.cards[0].key), reading);
  assert.deepEqual(telemetryPanels({ hosts: { local: LOCAL_HOST }, gpus: [reading], devices: null }, false, arc).map((x) => [x.title, x.gpu.gpu_util]), [['Arc A770', 44]]);
  // Not when it would be a guess: a reading of another vendor is no stand-in for a card without one.
  const guess = matchGpusToCards([gpu({ vendor: 'nvidia', gpu_name: N3060 })], T.oneCard);
  assert.equal(guess.byCard.size, 0);
  assert.equal(guess.rest.length, 1);
});

test('telemetryPanels with a topology: one panel per physical card, labelled from it', () => {
  const two = telemetryPanels(TWO_IDLE, false, T.twoIdentical);
  assert.deepEqual(two.map((x) => [x.key, x.title, x.name, x.gpu.gpu_util]), [
    ['card|amd radeon rx 7900 xtx#1', 'RX 7900 XTX #1', '0b:00.0', 3],
    ['card|amd radeon rx 7900 xtx#2', 'RX 7900 XTX #2', '0e:00.0', 97],
  ]);

  const one = telemetryPanels({ hosts: { local: LOCAL_HOST }, gpus: [gpu({ pci: '0b:00.0' })], devices: null }, false, T.oneCard);
  assert.deepEqual(one.map((x) => [x.title, x.name]), [['RX 7900 XTX', '0b:00.0']], 'a single card gets no number');

  const mixed = telemetryPanels({
    hosts: { local: LOCAL_HOST },
    // monitor.py lists the AMD card first; the topology lists the NVIDIA one first.
    gpus: [gpu({ pci: '0c:00.0', gpu_util: 90 }), gpu({ pci: '09:00.0', vendor: 'nvidia', gpu_name: N3060, gpu_util: 30, vram_total: 12288 })],
    devices: null,
  }, false, T.mixed);
  assert.deepEqual(mixed.map((x) => [x.title, x.gpu.gpu_util]), [['RTX 3060', 30], ['RX 7900 XTX', 90]], 'topology order, each card its own reading');

  assert.deepEqual(telemetryPanels({ hosts: { local: LOCAL_HOST }, gpus: [], devices: null }, false, T.cpuOnly), [], 'CPU-only: no panels to invent');
});

test('telemetryPanels during a launch: readings come from the card, the launch only says which ids it uses', () => {
  // A launch on the SECOND card alone. The server's per-device record carries
  // the first card's numbers (it claims same-name GPUs in order) -- the panel
  // must not show them.
  const stats = {
    ...TWO_IDLE,
    devices: [{ id: 'ROCm1', name: XTX, label: 'RX 7900 XTX', host: 'local', share: 100, util: 3, pwr: 50, temp: 50, vram_used: 1000, vram_total: 24560, thermal: false }],
  };
  const panels = telemetryPanels(stats, false, T.twoIdentical);
  assert.deepEqual(panels.map((x) => [x.title, x.name, x.gpu.gpu_util]), [
    ['RX 7900 XTX #1', 'not in launch', 3],
    ['RX 7900 XTX #2', 'ROCm1', 97],
  ]);
  assert.deepEqual(panels.map((x) => x.key), telemetryPanels(TWO_IDLE, false, T.twoIdentical).map((x) => x.key), 'same panels, same keys, launch or not');

  // Both cards, split 47:1 -- shares shown as percentages of the launch.
  const split = telemetryPanels({ ...TWO_IDLE, devices: [{ id: 'Vulkan0', name: XTX, host: 'local', share: 47 }, { id: 'Vulkan1', name: XTX, host: 'local', share: 1 }] }, false, T.twoIdentical);
  assert.deepEqual(split.map((x) => x.name), ['Vulkan0 98%', 'Vulkan1 2%']);

  // A card that stops reporting keeps its panel, offline.
  const dropped = telemetryPanels({ ...TWO_IDLE, gpus: [TWO_IDLE.gpus[0], { ...TWO_IDLE.gpus[1], error: true }] }, false, T.twoIdentical);
  assert.equal(dropped[1].gpu.gpu_name, 'Offline');
  assert.equal(telemetryPanels({ ...TWO_IDLE, gpus: [TWO_IDLE.gpus[0]] }, false, T.twoIdentical).length, 2);

  // An id the topology does not list (it came from another build's device
  // list): matched by card name, identical cards by the id's own index.
  const other = telemetryPanels({ ...TWO_IDLE, devices: [{ id: 'SYCL1', name: XTX, host: 'local', share: 100 }] }, false, T.twoIdentical);
  assert.deepEqual(other.map((x) => x.name), ['not in launch', 'SYCL1']);
});

test('telemetryPanels with a remote worker: its card is a panel of its own, kept when its readings drop', () => {
  const stats = {
    hosts: { local: LOCAL_HOST, laptop: { cpu_name: 'i9', cpu_util: 33, cpu_temp: 77, ram_used: 12288, ram_total: 32768, net_bytes: 50, error: false } },
    gpus: [gpu({ pci: '0b:00.0', gpu_util: 80 }), gpu({ host: 'laptop', pci: '01:00.0', vendor: 'nvidia', gpu_name: L4090, gpu_util: 70, vram_total: 16376 })],
    devices: [
      { id: 'Vulkan0', name: XTX, label: 'RX 7900 XTX', host: 'local', share: 60, util: 80, vram_used: 1000, vram_total: 24560 },
      { id: 'RPC0', name: L4090, label: 'RTX 4090 Laptop', host: 'laptop', share: 40, util: 70, vram_used: 1000, vram_total: 16376 },
    ],
  };
  const panels = telemetryPanels(stats, true, T.withWorker);
  assert.deepEqual(panels.map((x) => [x.title, x.name, x.gpu.gpu_util]), [
    ['RX 7900 XTX', 'Vulkan0 60%', 80],
    ['RTX 4090 Laptop@laptop', 'RPC0 40%', 70],
  ]);
  const down = telemetryPanels({ ...stats, gpus: stats.gpus.filter((g) => g.host === 'local') }, true, T.withWorker);
  assert.deepEqual(down.map((x) => [x.title, x.gpu.gpu_name === 'Offline']), [['RX 7900 XTX', false], ['RTX 4090 Laptop@laptop', true]]);
  assert.deepEqual(down.map((x) => x.key), panels.map((x) => x.key), 'same key with or without a reading');
  // No launch: the worker's card is still listed when the server reports it.
  const idle = telemetryPanels({ ...stats, devices: null }, false, T.withWorker);
  assert.deepEqual(idle.map((x) => [x.title, x.name]), [['RX 7900 XTX', '0b:00.0'], ['RTX 4090 Laptop@laptop', '']]);
});

test('telemetryPanels without a topology (older server): the telemetry-shaped panels, as before', () => {
  assert.deepEqual(telemetryPanels(TWO_IDLE, false, null).map((x) => [x.title, x.name]), [['GPU 0', 'RX 7900 XTX'], ['GPU 1', 'RX 7900 XTX']]);
  assert.deepEqual(telemetryPanels({ master: { gpu_name: 'A' } }, false, T.twoIdentical).map((x) => x.title), ['GPU 0'], 'legacy-only telemetry is not forced into the topology');
});

test('monitorPanels: placeholders already have the final shape; a machine with no GPU says so', () => {
  assert.deepEqual(monitorPanels(null, false, T.twoIdentical).map((x) => [x.key, x.title, x.gpu]), [
    ['card|amd radeon rx 7900 xtx#1', 'RX 7900 XTX #1', null], ['card|amd radeon rx 7900 xtx#2', 'RX 7900 XTX #2', null],
  ], 'before the first sample: one waiting panel per card');
  const none = monitorPanels({ hosts: { local: LOCAL_HOST }, gpus: [], devices: null }, false, T.cpuOnly);
  assert.deepEqual(none.map((x) => [x.title, x.idle]), [['NO GPU', 'CPU only — this machine has no GPU']]);
  assert.deepEqual(monitorPanels(null, false, null).map((x) => x.title), ['GPU 0'], 'nothing known yet');
  assert.equal(monitorPanels(TWO_IDLE, false, T.twoIdentical).length, 2);
});

test('lanesLine: the running queue lanes in one line', () => {
  assert.equal(lanesLine(undefined), '');
  assert.equal(lanesLine([]), '');
  assert.equal(lanesLine([{ lane: 'laptop-4090', label: '4090 llama', gpu: '4090', phase: 'gen', gen: 19, prefill: 264.5, connected: true, index: 6, total: 22 }]), 'queue: laptop-4090 (4090 llama) gen 19 t/s · 6/22');
  assert.equal(lanesLine([{ lane: 'local-1', phase: 'prefill', prefill: 264.5, gen: null }, { lane: 'local-2', phase: null, gen: null, connected: false }]), 'queue: local-1 prefill 265 t/s   local-2 not connected');
});

// ---- rendered: Monitor on each machine ----

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ENTER = '\r';
const ESC = '\x1b';
const DOWN = '\x1b[B';
const UP = '\x1b[A';
const TAB = '\t';
const stub = { getJson: async () => ({}), postJson: async () => ({}), connect() {}, close() {} };

async function monitorFrame(t, topology, telemetry, sse = {}) {
  const appStore = createAppStore();
  appStore.onConnState('live');
  appStore.onSSEEvent({ state: 'stopped', model: '', log: '', launchConfig: null, ...sse });
  if (topology) appStore.onTopology(topology);
  if (telemetry) appStore.onTelemetry({ t: Date.now(), ...telemetry });
  const view = render(React.createElement(App, { client: stub, appStore, serverUrl: 'http://fake' }));
  t.after(view.unmount);
  await sleep(50);
  return { out: view.lastFrame() || '', appStore };
}

test('Monitor on two identical cards: a panel each, #1 and #2, the machine in the state line, the queue lanes under it', async (t) => {
  const lanes = [{ lane: 'laptop-4090', label: '4090 llama', gpu: '4090', phase: 'gen', gen: 19, connected: true, index: 6, total: 22 }];
  const { out, appStore } = await monitorFrame(t, MACHINES.twoIdentical, { stats: TWO_IDLE, lanes });
  assert.match(out, /╭─\[ RX 7900 XTX #1 · 0b:00\.0 \]─+╮.*╭─\[ RX 7900 XTX #2 · 0e:00\.0 \]─+╮/);
  assert.match(out, /util\s+3%.*util\s+97%/, 'each panel its own card\'s reading');
  assert.match(out, /no model loaded — press 2 to launch · 2x RX 7900 XTX 24G \| 63G RAM/);
  assert.match(out, /queue: laptop-4090 \(4090 llama\) gen 19 t\/s · 6\/22/);
  assert.doesNotMatch(out, /GPU 0|GPU 1|waiting for telemetry/);
  assert.deepEqual(Object.keys(appStore.store.getState().buffers.gpus), ['card|amd radeon rx 7900 xtx#1', 'card|amd radeon rx 7900 xtx#2'], 'histories keyed by physical card');
});

test('Monitor on one card, on mixed vendors, and with a remote worker', async (t) => {
  const one = await monitorFrame(t, MACHINES.oneCard, { stats: { hosts: { local: LOCAL_HOST }, gpus: [gpu({ pci: '0b:00.0' })], devices: null } });
  assert.match(one.out, /╭─\[ RX 7900 XTX · 0b:00\.0 \]/);
  assert.equal((one.out.match(/╭─\[ [^\]]*(RX|RTX)/g) || []).length, 1, 'one card, one GPU panel');
  assert.match(one.out, /· RX 7900 XTX 24G \| 31G RAM/);

  const mixed = await monitorFrame(t, MACHINES.mixed, {
    stats: { hosts: { local: LOCAL_HOST }, gpus: [gpu({ pci: '09:00.0', vendor: 'nvidia', gpu_name: N3060, vram_total: 12288, throttle_reasons: ['sw_power_cap'] }), gpu({ pci: '0c:00.0' })], devices: null },
  });
  assert.match(mixed.out, /╭─\[ RTX 3060 · 09:00\.0 \]─+╮.*╭─\[ RX 7900 XTX · 0c:00\.0 \]/);
  assert.match(mixed.out, /pwr-cap/, 'vendor-specific badges still shown');

  const rpc = await monitorFrame(t, MACHINES.withWorker, {
    stats: {
      hosts: { local: LOCAL_HOST, laptop: { cpu_name: 'i9', cpu_util: 33, cpu_temp: 77, ram_used: 12288, ram_total: 32768, net_bytes: 50, error: false } },
      gpus: [gpu({ pci: '0b:00.0' }), gpu({ host: 'laptop', pci: '01:00.0', vendor: 'nvidia', gpu_name: L4090, vram_total: 16376 })],
      devices: [{ id: 'Vulkan0', name: XTX, host: 'local', share: 60 }, { id: 'RPC0', name: L4090, host: 'laptop', share: 40 }],
    },
  }, { state: 'ready', model: 'm.gguf', isRpc: true, launchCommand: '/x/llama-server --port 8080' });
  assert.match(rpc.out, /╭─\[ RX 7900 XTX · Vulkan0 60% \]─+╮.*╭─\[ RTX 4090 Laptop@laptop · RPC0 40% \]/);
  assert.match(rpc.out, /laptop\s+33%\s+77°C · ram 12\.0\/32\.0G/, 'the worker host\'s own row');
  assert.match(rpc.out, /model on :8080 · idle · RX 7900 XTX 24G \| 31G RAM/);
});

test('Monitor on a CPU-only machine: one "NO GPU" panel, nothing waiting for telemetry', async (t) => {
  const { out } = await monitorFrame(t, MACHINES.cpuOnly, { stats: { hosts: { local: LOCAL_HOST }, gpus: [], devices: null } });
  assert.match(out, /╭─\[ NO GPU \]/);
  assert.match(out, /CPU only — this machine has no GPU/);
  assert.match(out, /no GPU \| 31G RAM/);
  assert.match(out, /cpu\s+12%/, 'the SYSTEM panel still has this host');
  assert.doesNotMatch(out, /waiting for telemetry|GPU 0/);
});

test('Monitor height does not change when the first telemetry sample arrives, on any machine', async (t) => {
  const lines = (o) => o.split('\n').length;
  for (const [name, machine] of Object.entries(MACHINES)) {
    const n = machine.cards.length;
    const before = await monitorFrame(t, machine, null);
    const after = await monitorFrame(t, machine, {
      stats: { hosts: { local: LOCAL_HOST }, gpus: Array.from({ length: n }, (_, i) => gpu({ index: i, pci: `0${i}:00.0`, gpu_name: machine.cards[i].name })), devices: null },
    });
    assert.equal(lines(before.out), lines(after.out), `${name}: ${lines(before.out)} lines before telemetry, ${lines(after.out)} after`);
  }
});

// ---- rendered: Launch on the two-identical-cards machine ----

const TWO_BUILD_CARDS = twoCards(['ROCm0', 'Vulkan0'], ['ROCm1', 'Vulkan1']);
const CMD = '/x/build-all/bin/llama-server -m /models/alpha-27b-Q4_K_XL.gguf -c 131072 -ngl 999';

// A fake dashboard on the two-card machine. `availability: false` = a server
// that sends neither `availability` nor `topology`.
// `splitField: true` = a server that knows the `splitMode` launch-config field
// and describes the resolved launch (placement / splitMode / status) in its
// preview, as servers from 2026-10-12 do.
// `start`: per-call answers of /api/start, each an Error to throw or a value
// to return (default: it launches).
function fakeDashboard({ profiles = TWO_PROFILES, availability = TWO_AVAILABILITY, topology = MACHINES.twoIdentical, busy = [], splitField = false, start = [] } = {}) {
  const posts = [];
  const startQueue = [...start];
  const client = {
    baseUrl: 'http://fake',
    posts,
    of: (path) => posts.filter(([q]) => q === path).map(([, b]) => b),
    getJson: async (q) => {
      if (q === '/api/profiles') return { version: 3, profiles, ...(availability ? { availability, topology } : {}) };
      if (q === '/api/models') return [{ name: 'alpha-27b-Q4_K_XL.gguf', path: '/models/alpha-27b-Q4_K_XL.gguf', size: '17.1', source: 'local', kind: 'model' }];
      if (q === '/api/builds') return { builds: [{ id: 'all', label: 'ROCm + Vulkan', path: '/x/build-all/bin/llama-server' }] };
      if (q === '/api/strata/configs') return { configs: [{ path: '/strata/strata-coder.json' }] };
      if (q.startsWith('/api/devices')) return { devices: [], cards: TWO_BUILD_CARDS, workers: [], ...(availability ? { topology } : {}) };
      return {};
    },
    postJson: async (q, body) => {
      posts.push([q, body]);
      if (q === '/api/preview-command') {
        const devices = (body.devices || []).filter((d) => d.enabled !== false);
        const field = splitField && body.splitMode === 'tensor' ? 'tensor' : 'layer';
        const dev = devices.length ? `${devices.length > 1 ? ` --split-mode ${field}` : ''} -dev ${devices.map((d) => d.id).join(',')}` : '';
        const res = { command: `${CMD}${dev}${body.argString ? ` ${body.argString}` : ''}`, devices, warnings: [], busy };
        if (!splitField) return res;
        const absent = devices.filter((d) => !d.worker && !topology.cards.some((c) => c.ids.includes(d.id)));
        return {
          ...res,
          warnings: absent.map((d) => `${d.name ? shortGpuName(d.name) : d.id} (${d.id}) is not in this machine`),
          placement: placementText(devices, normalizeTopology(topology)),
          splitMode: devices.length > 1 ? (/-sm tensor/.test(body.argString || '') ? 'tensor' : field) : null,
          status: absent.length ? 'unavailable' : 'ready',
          signature: topology.signature,
        };
      }
      if (q === '/api/start') {
        const next = startQueue.shift();
        if (next instanceof Error) throw next;
        return next || { status: 'launching' };
      }
      return {};
    },
    deleteJson: async () => ({ ok: true }),
    connect() {},
    close() {},
  };
  return client;
}

function mountLaunch(t, client) {
  const appStore = createAppStore();
  appStore.onConnState('live');
  appStore.onSSEEvent({ state: 'stopped', model: '', log: '', launchConfig: null });
  const launched = [];
  const view = render(React.createElement(Launch, {
    client, appStore, serverUrl: 'http://fake', modeGateRef: { current: false }, onLaunched: () => launched.push(1),
  }));
  t.after(view.unmount);
  const press = async (...keys) => { for (const k of keys) { view.stdin.write(k); await sleep(60); } };
  return { view, appStore, launched, press, frame: () => view.lastFrame() || '' };
}

test('Launch list: runnable profiles first with the server\'s placement, the unavailable one last with its reason; u hides it', async (t) => {
  const { frame, press, appStore } = mountLaunch(t, fakeDashboard());
  await sleep(150);
  let out = frame();
  const lines = out.split('\n');
  assert.match(out, /Profiles · 5 of 6 run here \(u hides the rest\) · 2x RX 7900 XTX 24G \| 63G RAM/, 'counts, the key and the machine in the title line');
  assert.match(out, /PROFILE\s+MODEL\s+CTX\s+PLACEMENT\s+BUILD\s+LAST USED/);
  const at = (name) => lines.findIndex((l) => l.includes(name) && /131k|—/.test(l));
  const order = ['both cards · layer', 'both cards · tensor', 'second card only', 'stand-in · small card', 'strata coder', 'old · one NVIDIA card'].map(at);
  assert.ok(order.every((i) => i > 0), 'every profile has a row');
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'the most recently used profile is last: it cannot run here');
  assert.match(lines[at('both cards · layer')], /^› {3}both cards · layer\s+alpha-27b-Q4_K_XL\s+131k 2x RX 7900 XTX, 1:1\s+all\s+1h ago/);
  assert.match(lines[at('both cards · tensor')], /131k 2x RX 7900 XTX, 1:1 · tensor\s+all\s+2h ago/, 'the split mode, when it is not the default');
  assert.match(lines[at('second card only')], /131k RX 7900 XTX #2 alone\s+all\s+3h ago/);
  assert.match(lines[at('stand-in · small card')], /^ {2}~ stand-in · small card\s.*RX 7900 XTX #1 alone/, 'runs with a note: flagged');
  assert.match(lines[at('strata coder')], /Strata engine\s+strata/);
  assert.match(lines[at('old · one NVIDIA card')], /^ {2}– old · one NVIDIA card\s+alpha-27b-Q4_K_XL\s+131k Needs RTX 3060\.\s+all\s+unavailable/);
  assert.equal(appStore.store.getState().topology.signature, '2x RX 7900 XTX 24G | 63G RAM', 'the topology reaches the store (Monitor reads it there)');

  // The detail lines say why, for the selected row.
  await press(UP); // wraps to the last row
  out = frame();
  assert.match(out, /^› – old · one NVIDIA card/m);
  assert.match(out, /can't run on this machine — Needs RTX 3060\. · last used 1m ago/);

  await press('u');
  out = frame();
  assert.doesNotMatch(out, /old · one NVIDIA card/);
  assert.match(out, /Profiles · 5 of 6 run here \(u shows the rest\)/);
  assert.match(out, /1–5 of 5 \(6 saved\)/);
  await press('u');
  assert.match(frame(), /old · one NVIDIA card/);
});

test('Launch list against a server without availability: every profile listed as before, nothing blocked', async (t) => {
  const client = fakeDashboard({ availability: false });
  const { frame, press } = mountLaunch(t, client);
  await sleep(150);
  let out = frame();
  assert.match(out, /Profiles · 6 saved · most recently used first · shared with the web dashboard/);
  assert.match(out, /^› {3}old · one NVIDIA card\s+alpha-27b-Q4_K_XL\s+131k RTX 3060 alone\s+all\s+1m ago/m, 'plain most-recently-used order, placement from the profile');
  assert.doesNotMatch(out, /unavailable|run here|–  old/);
  await press('u');
  assert.match(frame(), /Every saved profile can run on this machine/);
  await press(ENTER);
  await sleep(100);
  out = frame();
  assert.doesNotMatch(out, /NOT RUNNABLE HERE/);
  assert.match(out, /cards\s+RTX 3060 \(CUDA0\)/);
  await press(ENTER);
  await sleep(350);
  assert.equal(client.of('/api/start').length, 1, 'launches as it always did');
});

test('an unavailable profile: the review says why, Enter does not launch, O overrides after a second explicit yes and sends it as saved', async (t) => {
  const client = fakeDashboard();
  const { frame, press, launched } = mountLaunch(t, client);
  await sleep(150);
  await press(UP, ENTER);
  await sleep(100);
  let out = frame();
  assert.match(out, /Launch profile “old · one NVIDIA card”/);
  assert.match(out, /NOT RUNNABLE HERE — this profile needs hardware this machine does not have/);
  assert.match(out, /Needs RTX 3060\./);
  assert.match(out, /this machine: 2x RX 7900 XTX 24G \| 63G RAM/);
  assert.match(out, /Enter does not launch it\. e edits it for this machine; O overrides and launches it as saved\./);
  assert.match(out, /^O: override \(asks once more\)\s+e: edit for this machine\s+Esc: back to profiles$/m, 'one line of key hints');
  assert.doesNotMatch(out, /Enter: launch/);

  await press(ENTER);
  await sleep(100);
  assert.equal(client.of('/api/start').length, 0, 'Enter is not the override');
  assert.match(frame(), /This machine can't run this profile as saved \(Needs RTX 3060\.\)/);

  await press('O');
  out = frame();
  assert.match(out, /Launch anyway\? This will:/);
  assert.match(out, /• launch a profile this machine can't run as saved — Needs RTX 3060\.\n/);
  assert.doesNotMatch(out, /e edits it for this machine, O overrides/, 'the "Enter does not launch" message is gone once the override is chosen');
  assert.match(out, /Override chosen: it will be launched exactly as saved\./);
  await press('n');
  assert.equal(client.of('/api/start').length, 0, 'n: nothing sent');
  assert.match(frame(), /Enter does not launch it\./, 'declining drops the override');
  await press(ENTER);
  assert.equal(client.of('/api/start').length, 0, 'and Enter is still not it');

  await press('O', 'y');
  await sleep(350);
  const starts = client.of('/api/start');
  assert.equal(starts.length, 1);
  assert.deepEqual(starts[0].devices, [{ id: 'CUDA0', name: N3060, share: 100, enabled: true }], 'the config as saved: no id re-pointed by the client');
  assert.equal(starts[0].allowUnavailable, true, 'the override is said on the request: the dashboard refuses such a launch without it');
  assert.equal('force' in starts[0], false, 'force is the busy-card override only');
  assert.equal(launched.length, 1);
  assert.equal(client.of('/api/profiles').some((b) => b.config && 'allowUnavailable' in b.config), false, 'never written into a profile');
});

const unavailableHere = (reason) => Object.assign(new Error(`This machine cannot run this launch as saved: ${reason}`),
  { status: 409, data: { error: `This machine cannot run this launch as saved: ${reason}`, code: 'UNAVAILABLE_HERE', availability: { status: 'unavailable', reason } } });

test('a launch the dashboard refuses as unavailable here (the preview had said nothing): its reason, the same override question, y resends with allowUnavailable', async (t) => {
  // availability: false = a server answer with no per-profile availability, so the profile reviews as runnable
  // and Enter launches it straight away -- the refusal is the first the client hears of it.
  const client = fakeDashboard({ availability: false, start: [unavailableHere('Needs RTX 3060.')] });
  const { frame, press, launched } = mountLaunch(t, client);
  await sleep(150);
  await press(ENTER); // old · one NVIDIA card: most recently used
  await sleep(100);
  assert.match(frame(), /Launch profile “old · one NVIDIA card”/);
  assert.doesNotMatch(frame(), /NOT RUNNABLE HERE/);
  await press(ENTER);
  await sleep(350);
  let starts = client.of('/api/start');
  assert.equal(starts.length, 1);
  assert.equal('allowUnavailable' in starts[0], false, 'the first attempt never carries the override');
  assert.equal(launched.length, 0);
  let out = frame();
  assert.match(out, /NOT RUNNABLE HERE — this profile needs hardware this machine does not have/);
  assert.match(out, /Needs RTX 3060\./, 'the server\'s reason');
  assert.match(out, /The dashboard refused to start it\. Launching anyway sends it exactly as saved\./);
  assert.match(out, /Launch anyway\? This will:/);
  assert.match(out, /• launch a profile this machine can't run as saved — Needs RTX 3060\.\n/);
  assert.doesNotMatch(out, /Launch failed/, 'not a raw error');

  await press(ENTER);
  assert.equal(client.of('/api/start').length, 1, 'only y goes ahead');
  await press('y');
  await sleep(350);
  starts = client.of('/api/start');
  assert.equal(starts.length, 2);
  assert.equal(starts[1].allowUnavailable, true);
  assert.equal('force' in starts[1], false, 'no card was busy: no force');
  assert.deepEqual(starts[1].devices, starts[0].devices, 'the same config, as saved');
  assert.equal(launched.length, 1);
});

test('refused as unavailable, declined: back on the review with Enter blocked; refused twice is an error, not a loop', async (t) => {
  const client = fakeDashboard({ availability: false, start: [unavailableHere('Needs RTX 3060.'), unavailableHere('Needs RTX 3060.')] });
  const { frame, press, launched } = mountLaunch(t, client);
  await sleep(150);
  await press(ENTER);
  await sleep(100);
  await press(ENTER);
  await sleep(350);
  await press('n');
  assert.match(frame(), /Enter does not launch it\. e edits it for this machine; O overrides and launches it as saved\./, 'declining drops the override');
  await press(ENTER);
  assert.equal(client.of('/api/start').length, 1, 'Enter is not the override');
  await press('O', 'y');
  await sleep(350);
  const starts = client.of('/api/start');
  assert.equal(starts.length, 2);
  assert.equal(starts[1].allowUnavailable, true);
  assert.equal(launched.length, 0);
  assert.match(frame(), /Launch failed: This machine cannot run this launch as saved: Needs RTX 3060\./, 'a server that refuses the override too: its message, once');
});

test('busy card first, then unavailable: each refusal gets its own yes, and the last request carries both flags', async (t) => {
  const busyNow = [{ lane: 'local-2', device: 'ROCm1', card: 'RX 7900 XTX #2', itemId: 901, label: 'bench-alpha' }];
  const cardBusy = Object.assign(new Error('Card busy: the RX 7900 XTX #2 is running queue item 901'), { status: 409, data: { code: 'CARD_BUSY', busy: busyNow } });
  const client = fakeDashboard({ availability: false, start: [cardBusy, unavailableHere('Needs RTX 3060.')] });
  const { frame, press, launched } = mountLaunch(t, client);
  await sleep(150);
  await press(ENTER);
  await sleep(100);
  await press(ENTER);
  await sleep(350);
  assert.match(frame(), /CARD BUSY/);
  await press('y');
  await sleep(350);
  assert.match(frame(), /NOT RUNNABLE HERE/);
  await press('y');
  await sleep(350);
  const starts = client.of('/api/start');
  assert.deepEqual(starts.map((b) => [!!b.force, !!b.allowUnavailable]), [[false, false], [true, false], [true, true]]);
  assert.equal(launched.length, 1);
});

test('review panel: cards by topology label, the split mode of a multi-card launch, a stand-in card asks twice, busy text names the card', async (t) => {
  const busy = [{ lane: 'local-2', device: 'ROCm1', card: 'RX 7900 XTX #2', itemId: 901, label: 'bench-alpha' }];
  const client = fakeDashboard({ busy });
  const { frame, press } = mountLaunch(t, client);
  await sleep(150);
  await press(ENTER); // both cards · layer
  await sleep(100);
  let out = frame();
  assert.match(out, /cards\s+RX 7900 XTX #1 \(ROCm0\) 50%\s+·\s+RX 7900 XTX #2 \(ROCm1\) 50%/);
  assert.match(out, /split\s+layer \(default\) — whole layers per card, in the order listed/);
  assert.match(out, /CARD BUSY — a benchmark is running on a card this launch needs/);
  assert.match(out, /RX 7900 XTX #2 \(ROCm1\) — queue item 901 “bench-alpha” · lane local-2/);

  await press(ESC, DOWN, ENTER); // both cards · tensor
  await sleep(100);
  out = frame();
  assert.match(out, /split\s+tensor \(-sm tensor\) — experimental/);
  assert.match(out, /--split-mode layer -dev ROCm0,ROCm1 -sm tensor/, 'the resolved command it was read from');

  await press(ESC, DOWN, ENTER); // second card only
  await sleep(100);
  out = frame();
  assert.match(out, /cards\s+RX 7900 XTX #2 \(ROCm1\)/);
  assert.doesNotMatch(out, /\n\s+split\s/, 'one card: no split line');

  await press(ESC, DOWN, ENTER); // stand-in · small card
  await sleep(100);
  out = frame();
  assert.match(out, /⚠ stand-in card — RTX 3060 is not in this machine; RX 7900 XTX #1 \(24 GB\) stands in\./);
  assert.match(out, /Enter: launch \(asks once more\)/);
  await press(ENTER);
  assert.match(frame(), /• use a stand-in card — RTX 3060 is not in this machine/);
  assert.equal(client.of('/api/start').length, 0);

  await press('n', ESC, DOWN, ENTER); // strata coder
  await sleep(100);
  assert.match(frame(), /cards\s+placed by the Strata engine \(its GPU list, else the first card: RX 7900 XTX #1\)/);
});

test('config editor on two identical cards: one row per physical card (#1, #2, every id that reaches it); Split mode switches -sm tensor in the raw args', async (t) => {
  const client = fakeDashboard();
  const { frame, press } = mountLaunch(t, client);
  await sleep(150);
  await press(DOWN, DOWN, 'e'); // second card only
  await sleep(150);
  await press(TAB);
  await sleep(500);
  let out = frame();
  assert.match(out, /\[x\] RX 7900 XTX #2\s+ROCm1 \(v: ROCm1\/Vulkan1\)\s+share 100 \(100%\)/, 'the saved second card is still the second card');
  assert.match(out, /\[ \] RX 7900 XTX #1\s+ROCm0 \(v: ROCm0\/Vulkan0\)/);
  assert.doesNotMatch(out, /Split mode|Suggest split/, 'one device enabled: nothing to split');
  let sent = client.of('/api/preview-command').pop();
  assert.deepEqual(sent.devices, [
    { id: 'ROCm1', name: XTX, vramMib: 24560, share: 100, enabled: true },
    { id: 'ROCm0', name: XTX, vramMib: 24560, enabled: false },
  ]);

  await press(DOWN, ' '); // enable the other card
  await sleep(500);
  out = frame();
  assert.match(out, /\[x\] RX 7900 XTX #1\s+ROCm0/);
  assert.match(out, /Split mode\s+layer \(default\)/);
  await press(DOWN, DOWN, ENTER); // Suggest split, Split mode -> Enter
  await sleep(600);
  out = frame();
  assert.match(out, /Split mode\s+tensor \(-sm tensor\) — experimental/);
  assert.match(out, /Split mode: tensor \(experimental\) — "-sm tensor" added to the raw args/);
  sent = client.of('/api/preview-command').pop();
  assert.equal(sent.argString, '-sm tensor');
  assert.equal('splitMode' in sent, false, 'this server never answered with a splitMode: the field is not sent to it');
  await press(ENTER);
  await sleep(600);
  assert.match(frame(), /Split mode\s+layer \(default\)/);
  assert.equal(client.of('/api/preview-command').pop().argString, '');
  assert.doesNotMatch(frame(), /\brow\b.*Enter|Enter: row/, 'row is never offered');

  // v: the same physical card through its other backend -- still card #2, and
  // the one place the "paired by order" assumption is spelled out.
  await press(UP, UP, UP, 'v');
  await sleep(100);
  out = frame();
  assert.match(out, /\[x\] RX 7900 XTX #2\s+Vulkan1 \(v: ROCm1\/Vulkan1\)/);
  assert.match(out, /RX 7900 XTX #2: its ids across backends \(ROCm1 \/ Vulkan1\) are paired with the card by order/);
});

test('a saved "-sm row" (deprecated in llama.cpp): flagged in the review, asks twice, and the editor only ever switches it back to layer', async (t) => {
  const profiles = { 'both cards · row': { config: p([{ id: 'ROCm0', name: XTX, share: 50 }, { id: 'ROCm1', name: XTX, share: 50 }], { argString: '--fit off -sm row' }), savedAt: 1, lastLoadedAt: NOW - 60000 } };
  const availability = { 'both cards · row': { status: 'ready', reason: '', placement: '2x RX 7900 XTX, 1:1' } };
  const client = fakeDashboard({ profiles, availability });
  const { frame, press } = mountLaunch(t, client);
  await sleep(150);
  await press(ENTER);
  await sleep(100);
  let out = frame();
  assert.match(out, /split\s+row — deprecated in llama\.cpp, fails to load \(use layer\)/);
  assert.match(out, /Enter: launch \(asks once more\)/);
  await press(ENTER);
  assert.match(frame(), /• probably fail to load — split mode row — deprecated in llama\.cpp/);
  assert.equal(client.of('/api/start').length, 0);

  await press('n', 'e'); // into the editor on this profile
  await sleep(150);
  await press(TAB);
  await sleep(500);
  assert.match(frame(), /Split mode\s+row — deprecated in llama\.cpp, fails to load \(use layer\)/);
  await press(DOWN, DOWN, DOWN, ENTER); // card, card, Suggest split, Split mode
  await sleep(600);
  assert.match(frame(), /Split mode\s+layer \(default\)/);
  assert.equal(client.of('/api/preview-command').pop().argString, '--fit off', 'the row flag is gone, the other arguments stay');
  await press(ENTER);
  await sleep(600);
  assert.equal(client.of('/api/preview-command').pop().argString, '--fit off -sm tensor', 'from layer the only other choice is tensor');
});

test('a server that knows the `splitMode` field: the editor writes the field (not the raw args); the review shows the server\'s placement and split mode', async (t) => {
  const client = fakeDashboard({ splitField: true });
  const { frame, press } = mountLaunch(t, client);
  await sleep(150);
  await press('e'); // both cards · layer
  await sleep(150);
  await press(TAB);
  await sleep(600); // the editor's own preview has answered: the server knows the field
  await press(DOWN, DOWN, DOWN, ENTER); // card, card, Suggest split, Split mode
  await sleep(600);
  let out = frame();
  assert.match(out, /Split mode\s+tensor \(-sm tensor\) — experimental/);
  assert.match(out, /Split mode: tensor \(experimental\) — saved as the config's split mode/);
  let sent = client.of('/api/preview-command').pop();
  assert.equal(sent.splitMode, 'tensor');
  assert.equal(sent.argString, '', 'the raw args are left alone');

  await press('b'); // review the draft
  await sleep(150);
  out = frame();
  assert.match(out, /cards\s+RX 7900 XTX #1 \(ROCm0\) 50%\s+·\s+RX 7900 XTX #2 \(ROCm1\) 50%\s+2x RX 7900 XTX, 1:1/, 'each device, then the server\'s placement');
  assert.match(out, /split\s+tensor \(-sm tensor\) — experimental/);
  assert.match(out, /--split-mode tensor -dev ROCm0,ROCm1/);

  await press(ESC, ENTER); // back in the editor: Enter on Split mode again -> layer
  await sleep(600);
  sent = client.of('/api/preview-command').pop();
  assert.equal('splitMode' in sent, false, 'layer is the absent field');
  assert.equal(sent.argString, '');
});

test('a profile the server re-pointed (stand-in card) opens in the editor with the server\'s device list; a draft the server can\'t place is not launched by Enter', async (t) => {
  const availability = {
    ...TWO_AVAILABILITY,
    'stand-in · small card': { ...TWO_AVAILABILITY['stand-in · small card'], devices: [{ id: 'ROCm0', name: XTX, vramMib: 24560, share: 100 }] },
  };
  const client = fakeDashboard({ availability, splitField: true });
  const { frame, press } = mountLaunch(t, client);
  await sleep(150);
  await press(DOWN, DOWN, DOWN, 'e'); // stand-in · small card
  await sleep(150);
  await press(TAB);
  await sleep(600);
  let out = frame();
  assert.match(out, /\[x\] RX 7900 XTX #1\s+ROCm0 \(v: ROCm0\/Vulkan0\)\s+share 100/, 'the card the server stood in, not the saved CUDA0');
  assert.doesNotMatch(out, /CUDA0|not a device in this build/);
  assert.match(out, /⚠ loaded for this machine: stand-in card — RTX 3060 is not in this machine/);
  assert.deepEqual(client.of('/api/preview-command').pop().devices[0], { id: 'ROCm0', name: XTX, vramMib: 24560, share: 100, enabled: true });

  // The other way round: the unavailable profile opened as saved, reviewed as a draft.
  await press(ESC, UP, UP, UP, UP, 'e'); // wraps to the last row: old · one NVIDIA card
  await sleep(150);
  await press(TAB);
  await sleep(600);
  assert.match(frame(), /\[x\] RTX 3060\s+CUDA0\s+\(not a device in this build\)/);
  await press('b');
  await sleep(150);
  out = frame();
  assert.match(out, /NOT RUNNABLE HERE/);
  assert.match(out, /RTX 3060 \(CUDA0\) is not in this machine/, 'the reason is the preview\'s own');
  await press(ENTER);
  await sleep(100);
  assert.equal(client.of('/api/start').length, 0);
});

test('editor: a profile saved for the second of two identical cards, opened on a build without that id, stays on the second card and says it chose', async (t) => {
  const profiles = { 'second card · vk build': { config: p([{ id: 'ROCm1', name: XTX, share: 100 }], { build: 'vk' }), savedAt: 1, lastLoadedAt: NOW - 60000 } };
  const client = fakeDashboard({ profiles, availability: false });
  const base = client.getJson;
  client.getJson = async (q) => {
    if (q === '/api/builds') return { builds: [{ id: 'vk', label: 'Vulkan only' }] };
    if (q.startsWith('/api/devices')) return { devices: [], cards: twoCards(['Vulkan0'], ['Vulkan1']), workers: [] };
    return base(q);
  };
  const { frame, press } = mountLaunch(t, client);
  await sleep(150);
  await press('e');
  await sleep(150);
  await press(TAB);
  await sleep(600);
  const out = frame();
  assert.match(out, /\[x\] RX 7900 XTX #2\s+Vulkan1\s+share 100/);
  assert.match(out, /\[ \] RX 7900 XTX #1\s+Vulkan0/);
  assert.match(out, /⚠ ROCm1 is not an id in this build: using RX 7900 XTX #2 \(Vulkan1\) — one of several identical\s+cards, check it is the one you meant/);
  assert.equal(client.of('/api/preview-command').pop().devices[0].id, 'Vulkan1');
});

// ---- GET /api/devices served from the dashboard's cache (2026-10-13) ----
// The dashboard probes a build's devices only when nothing is running on a
// local card (or when asked to); otherwise, and when a probe fails, it sends
// the build's last good listing with `cached: true`.

test('editor: a device list from the dashboard\'s cache is used as it is, with a dim note of its age; the client never asks for a re-probe', async (t) => {
  const client = fakeDashboard();
  const base = client.getJson;
  const asked = [];
  client.getJson = async (q) => {
    if (q.startsWith('/api/devices')) {
      asked.push(q);
      return { devices: [], cards: TWO_BUILD_CARDS, workers: [], topology: MACHINES.twoIdentical,
        cached: true, probed: false, cachedAt: Date.now() - 12 * 60000, ageMs: 12 * 60000, note: 'not re-probed: a benchmark is running on a local card' };
    }
    return base(q);
  };
  const { frame, press } = mountLaunch(t, client);
  await sleep(150);
  await press(DOWN, 'e'); // both cards · layer
  await sleep(150);
  await press(TAB);
  await sleep(600);
  const out = frame();
  assert.match(out, /\[x\] RX 7900 XTX #1\s+ROCm0/, 'the cached listing fills the table');
  assert.match(out, /\[x\] RX 7900 XTX #2\s+ROCm1/);
  assert.match(out, /· device list from 12m ago \(cached\) — not re-probed: a benchmark is running on a local card/);
  assert.doesNotMatch(out, /detecting devices|no device list/);
  assert.ok(asked.length > 0 && asked.every((q) => !/refresh/.test(q)), `no ?refresh=1 from the editor: ${asked.join(' ')}`);
  await press(TAB);
  await sleep(100);
  assert.doesNotMatch(frame(), /device list from/, 'the note belongs to the device table: gone on the next group');
});

test('editor: a probe that failed with nothing cached says so (and why) instead of "detecting" for ever', async (t) => {
  const profiles = { 'new build': { config: p([], { build: 'all' }), savedAt: 1, lastLoadedAt: NOW - 60000 } };
  const client = fakeDashboard({ profiles, availability: false });
  const base = client.getJson;
  client.getJson = async (q) => {
    if (q.startsWith('/api/devices')) return { devices: [], error: 'timed out' };
    if (q === '/api/worker/config') return { workers: [] };
    return base(q);
  };
  const { frame, press } = mountLaunch(t, client);
  await sleep(150);
  await press('e');
  await sleep(150);
  await press(TAB);
  await sleep(600);
  assert.match(frame(), /no device list from the dashboard \(timed out\)/);
  assert.doesNotMatch(frame(), /detecting devices/);
});

// ---- Strata profiles when the dashboard lists two installs ----

test('Launch list: a Strata profile of a second install is found, and says which Strata it is', async (t) => {
  const base043 = '/home/kyle/AI/Strata-0.1.43.1/strata-iq3_xxs-2gpu-split27-trim-pw2.json';
  const profiles = {
    'opt · Strata 0.1.43.1 · 2 cards': { config: { engine: 'strata', strataBase: base043, needs: { vendor: 'amd', minVramMib: 24000, minCards: 2 } }, savedAt: 1, lastLoadedAt: NOW - 60000 },
    'bench · Strata IQ3_XXS': { config: { engine: 'strata', strataBase: '/home/kyle/AI/Strata-0.1.32/strata-iq3_xxs.json' }, savedAt: 2, lastLoadedAt: NOW - 3600000 },
  };
  const client = fakeDashboard({ profiles, availability: false });
  const baseGet = client.getJson;
  client.getJson = async (q) => {
    if (q === '/api/strata/configs') {
      return {
        dir: '/home/kyle/AI/Strata-0.1.32', serveScript: '/home/kyle/AI/Strata-0.1.32/queue-serve.sh',
        configs: [
          { path: '/home/kyle/AI/Strata-0.1.32/strata-iq3_xxs.json', name: 'strata-iq3_xxs.json', maxContext: '131072', install: '/home/kyle/AI/Strata-0.1.32', version: '0.1.32' },
          { path: base043, name: 'strata-iq3_xxs-2gpu-split27-trim-pw2.json', maxContext: '131072', install: '/home/kyle/AI/Strata-0.1.43.1', version: '0.1.43.1' },
        ],
        installs: [{ dir: '/home/kyle/AI/Strata-0.1.32', version: '0.1.32', configs: 1 }, { dir: '/home/kyle/AI/Strata-0.1.43.1', version: '0.1.43.1', configs: 1 }],
      };
    }
    return baseGet(q);
  };
  const { frame, press } = mountLaunch(t, client);
  await sleep(200);
  let out = frame();
  assert.doesNotMatch(out, /MISSING|Strata base config not found/);
  assert.match(out, /Strata engine 0\.1\.43\.1 \(e opens the Strata editor/, 'the selected row\'s detail line names the install');
  await press(ENTER);
  await sleep(150);
  out = frame();
  assert.match(out, /build Strata engine 0\.1\.43\.1/);
  assert.doesNotMatch(out, /✗|probably fail to start/, 'nothing about a missing file on the review');
});
