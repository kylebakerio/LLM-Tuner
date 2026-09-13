import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_DRAFT, DRAFT_KEYS, sanitizeConfig, configToDraft, draftToConfig, clampVerbosity,
  nodeLabels, splitText, profileTag, sortProfileEntries,
} from '../src/launchconfig.js';
import { gpuOnline, gpuTitles } from '../src/format.js';

// A profile as the web dashboard saves it: structured fields PLUS the raw
// command box and legacy keys the CLI has no field for.
const WEB_RPC_PROFILE = {
  modelPath: '/m/qwen-27b.gguf', build: 'cuda-vulkan', ctx: 65536, ngl: 99,
  deviceA: 'CUDA0', deviceB: 'Vulkan1', tensorSplit: 60,
  rpcTarget: 'laptop', transport: 'TB4',
  verbosity: 0,
  rawCommand: '/x/llama-server -m /m/other.gguf -c 4096',
  launchMode: 'local-multi-gpu', model: 'qwen-27b.gguf',
};

test('sanitizeConfig keeps only DRAFT_KEYS (rawCommand and unknown keys dropped)', () => {
  const out = sanitizeConfig({ ...WEB_RPC_PROFILE, preserveThinking: true, bogus: 1 });
  assert.equal('rawCommand' in out, false);
  assert.equal('launchMode' in out, false);
  assert.equal('model' in out, false);
  assert.equal('bogus' in out, false);
  assert.equal(out.preserveThinking, true, 'legacy key buildLlamaArgs still honors');
  assert.equal(out.modelPath, '/m/qwen-27b.gguf');
  for (const k of Object.keys(out)) assert.ok(DRAFT_KEYS.includes(k), `${k} is a draft key`);
  assert.equal('rpcEnabled' in out || 'workerHost' in out, false, 'UI-only keys are not launch keys');
  assert.deepEqual(sanitizeConfig(null), {});
});

test('configToDraft: web RPC profile -> RPC on, host from rpcTarget, GPU B cleared', () => {
  const d = configToDraft(WEB_RPC_PROFILE);
  assert.equal(d.rpcEnabled, true);
  assert.equal(d.workerHost, 'laptop');
  assert.equal(d.transport, 'TB4');
  assert.equal(d.deviceA, 'CUDA0');
  assert.equal(d.deviceB, null, 'split is local-vs-worker only');
  assert.equal(d.tensorSplit, 60);
  assert.equal(d.verbosity, 3, 'verbosity clamped up to the floor');
  assert.equal('rawCommand' in d, false);
  assert.equal('launchMode' in d, false);
});

test('configToDraft: local profile -> RPC off, keeps base host/transport, REPLACE semantics', () => {
  const base = { ...DEFAULT_DRAFT, workerHost: 'laptop', transport: 'WAN', deviceB: 'Vulkan9', argString: '--old' };
  const d = configToDraft({ modelPath: '/m/a.gguf', deviceA: 'Vulkan0', deviceB: 'Vulkan1', rpcTarget: null, transport: null, verbosity: 4 }, base);
  assert.equal(d.rpcEnabled, false);
  assert.equal(d.rpcTarget, '');
  assert.equal(d.workerHost, 'laptop', 'host survives a local load for the next RPC toggle');
  assert.equal(d.transport, 'WAN', 'null transport falls back to the base pick');
  assert.equal(d.deviceB, 'Vulkan1');
  assert.equal(d.verbosity, 4);
});

test('configToDraft skipEmpty (prefill merge) does not blank base values', () => {
  const base = { ...DEFAULT_DRAFT, modelPath: '/m/a.gguf', build: 'vulkan' };
  const d = configToDraft({ modelPath: '', build: 'cuda', ctx: null, rawCommand: 'x' }, base, { skipEmpty: true });
  assert.equal(d.modelPath, '/m/a.gguf');
  assert.equal(d.build, 'cuda');
  assert.equal(d.ctx, 8192);
  assert.equal('rawCommand' in d, false);
});

test('draftToConfig: RPC on maps host -> rpcTarget, sends transport, nulls GPU B', () => {
  const draft = { ...DEFAULT_DRAFT, modelPath: '/m/a.gguf', rpcEnabled: true, workerHost: ' kyle@10.0.0.5 ', transport: 'WAN', deviceA: 'Vulkan0', deviceB: 'Vulkan1', rawCommand: 'nope' };
  const cfg = draftToConfig(draft);
  assert.equal(cfg.rpcTarget, 'kyle@10.0.0.5');
  assert.equal(cfg.transport, 'WAN');
  assert.equal(cfg.deviceB, null);
  assert.equal(cfg.deviceA, 'Vulkan0');
  assert.equal('rawCommand' in cfg, false, 'never sent to /api/start or saved');
  assert.equal('rpcEnabled' in cfg, false);
  assert.equal('workerHost' in cfg, false);
});

test('draftToConfig: RPC off sends empty rpcTarget and null transport even with a host set', () => {
  const cfg = draftToConfig({ ...DEFAULT_DRAFT, rpcEnabled: false, workerHost: 'laptop', transport: 'TB4', deviceB: 'Vulkan1', verbosity: null });
  assert.equal(cfg.rpcTarget, '');
  assert.equal(cfg.transport, null);
  assert.equal(cfg.deviceB, 'Vulkan1');
  assert.equal(cfg.verbosity, 3, 'a blanked verbosity still leaves as the floor');
});

test('profile round-trip: web profile -> draft -> config keeps rpcTarget + transport', () => {
  const cfg = draftToConfig(configToDraft(WEB_RPC_PROFILE));
  assert.equal(cfg.rpcTarget, 'laptop');
  assert.equal(cfg.transport, 'TB4');
  assert.equal(cfg.deviceB, null);
  assert.equal(cfg.modelPath, WEB_RPC_PROFILE.modelPath);
  assert.equal('rawCommand' in cfg, false);
  // and a local one stays local
  const local = draftToConfig(configToDraft({ modelPath: '/m/a.gguf', rpcTarget: '' }));
  assert.equal(local.rpcTarget, '');
  assert.equal(local.transport, null);
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

test('node + split labels follow the RPC switch', () => {
  assert.deepEqual(nodeLabels(true), { a: 'Local', b: 'Worker' });
  assert.deepEqual(nodeLabels(false), { a: 'GPU A', b: 'GPU B' });
  assert.equal(splitText({ tensorSplit: 60, rpcEnabled: true }), 'Local 60% / Worker 40%');
  assert.equal(splitText({ tensorSplit: 25, rpcEnabled: false }), 'GPU A 25% / GPU B 75%');
  assert.equal(splitText({ tensorSplit: null }), null);
});

test('profileTag + sortProfileEntries (most recently used first)', () => {
  assert.equal(profileTag({ rpcTarget: 'laptop' }), 'RPC');
  assert.equal(profileTag({ rpcTarget: '' }), 'Local');
  assert.equal(profileTag({ rpcTarget: null }), 'Local');
  assert.equal(profileTag({}), 'Local');

  const sorted = sortProfileEntries({
    old: { config: { modelPath: '/a' }, savedAt: 100, lastLoadedAt: null },
    usedRecently: { config: { modelPath: '/b', rpcTarget: 'laptop' }, savedAt: 50, lastLoadedAt: 900 },
    newSave: { config: { modelPath: '/c' }, savedAt: 500, lastLoadedAt: null },
  });
  assert.deepEqual(sorted.map((e) => e.name), ['usedRecently', 'newSave', 'old']);
  assert.equal(sorted[0].config.rpcTarget, 'laptop');
  assert.deepEqual(sortProfileEntries(null), []);
});

test('gpuOnline treats Offline name OR either vendor error flag as offline', () => {
  assert.equal(gpuOnline({ gpu_name: 'AMD Radeon RX 7900 XTX', amdgpu_top_error: false }), true);
  assert.equal(gpuOnline({ gpu_name: 'NVIDIA GeForce RTX 4090 Laptop GPU', nvidia_smi_error: false }), true);
  assert.equal(gpuOnline({ gpu_name: 'Offline' }), false);
  assert.equal(gpuOnline({ gpu_name: 'Unknown', nvidia_smi_error: true }), false);
  assert.equal(gpuOnline({ gpu_name: 'AMD Radeon', amdgpu_top_error: true }), false);
  assert.equal(gpuOnline(null), false);
  assert.equal(gpuOnline({}), false);
  assert.deepEqual(gpuTitles(true), ['Local', 'Worker (rpc)']);
  assert.deepEqual(gpuTitles(false), ['GPU 0', 'GPU 1']);
});
