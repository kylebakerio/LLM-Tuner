import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAppStore } from '../src/state.js';
import { THREE_DEVICE_STATS } from './panels.test.js';

test('SSE events drive the store', () => {
  const appStore = createAppStore();
  appStore.onConnState('live');

  appStore.onSSEEvent({ state: 'starting', model: 'm.gguf', log: '', launchCommand: '/x --port 8081' });
  assert.equal(appStore.store.getState().server.state, 'starting');
  assert.equal(appStore.store.getState().modelUpSince, null);

  appStore.onSSEEvent({ state: 'ready', model: 'm.gguf', log: 'CTX_LIVE:100:8192:1' });
  let s = appStore.store.getState();
  assert.equal(s.server.state, 'ready');
  assert.ok(s.modelUpSince > 0, 'modelUpSince set on ready transition');
  assert.equal(s.live.ctxUsed, 100);
  assert.equal(s.live.ctxTotal, 8192);
  assert.equal(s.live.active, true);

  appStore.onSSEEvent({ state: 'ready', model: 'm.gguf', log: 'PREFILL_PROGRESS:0.5:450:128' });
  assert.equal(appStore.store.getState().live.promptTps, 450);

  // New server format appends the instantaneous rate as a 4th field:
  // PREFILL_PROGRESS:<progress>:<cumulativeTps>:<nTokens>:<instTps>
  // The cumulative value decays across a long prefill (it's a running
  // average), so the instantaneous one must win when present.
  appStore.onSSEEvent({ state: 'ready', model: 'm.gguf', log: 'PREFILL_PROGRESS:0.9:332.5:104000:664.10' });
  assert.equal(appStore.store.getState().live.promptTps, 664.1);
  // ...and an empty 4th field (first point of a prefill) falls back.
  appStore.onSSEEvent({ state: 'ready', model: 'm.gguf', log: 'PREFILL_PROGRESS:0.01:660:4096:' });
  assert.equal(appStore.store.getState().live.promptTps, 660);

  appStore.onSSEEvent({ state: 'ready', model: 'm.gguf', log: 'GEN_PROGRESS:21.5:19.2:100' });
  s = appStore.store.getState();
  assert.equal(s.live.genTps, 21.5);
  assert.equal(s.live.genInst, 19.2);

  const row = { runId: 'a', timestamp: Date.now(), promptTps: 400, genTps: 20, promptTokens: 100, genTokens: 50, wallTime: 3.2 };
  appStore.onSSEEvent({ state: 'ready', model: 'm.gguf', log: 'COMPLETION:' + JSON.stringify(row) });
  s = appStore.store.getState();
  assert.equal(s.completions.length, 1);
  assert.equal(s.completions[0].runId, 'a');
  assert.equal(s.live.promptTps, null, 'live progress cleared on completion');
  assert.equal(s.buffers.promptTps.includes(400), true, 'completion pushed to buffer');

  // duplicate run_id is deduped (backfill + live event race)
  appStore.onSSEEvent({ state: 'ready', model: 'm.gguf', log: 'COMPLETION:' + JSON.stringify({ runId: 'a' }) });
  assert.equal(appStore.store.getState().completions.length, 1);

  // plain log lines go to the tail
  appStore.onSSEEvent({ state: 'ready', model: 'm.gguf', log: 'hello world' });
  assert.deepEqual(appStore.store.getState().logTail, ['hello world']);

  // stopping clears modelUpSince
  appStore.onSSEEvent({ state: 'stopped', model: '', log: '' });
  assert.equal(appStore.store.getState().modelUpSince, null);
});

test('legacy telemetry fills per-panel buffers and computes net rate', () => {
  const appStore = createAppStore();
  appStore.onTelemetry({ t: 1000, stats: { master: { gpu_name: 'A', gpu_util: 50, vram_used: 1000, net_bytes: 1000 }, worker: null } });
  appStore.onTelemetry({
    t: 2000,
    stats: {
      master: { gpu_name: 'A', gpu_util: 60, vram_used: 1100, net_bytes: 1000 + 1024 * 1024 },
      worker: { gpu_name: 'w', gpu_util: 10, vram_used: 500, net_bytes: 0 },
    },
  });
  const s = appStore.store.getState();
  assert.equal(s.buffers.gpus['legacy|master'].util.length, 2);
  assert.equal(s.buffers.gpus['legacy|worker'].util.length, 1, 'worker buffers only fill when worker online');
  assert.ok(s.netMbps > 0.99 && s.netMbps < 1.01, `net rate ~1 MB/s (got ${s.netMbps})`);
  assert.equal(s.telemetry.master.gpu_util, 60);
});

test('worker buffers skip monitor.py error-fallback samples (either vendor flag)', () => {
  const appStore = createAppStore();
  const master = { gpu_name: 'AMD Radeon RX 7900 XTX', gpu_util: 50, amdgpu_top_error: false };
  appStore.onTelemetry({ t: 1000, stats: { master, worker: { gpu_name: 'Unknown', gpu_util: 0, nvidia_smi_error: true } } });
  appStore.onTelemetry({ t: 2000, stats: { master, worker: { gpu_name: 'X', gpu_util: 0, amdgpu_top_error: true } } });
  assert.equal(appStore.store.getState().buffers.gpus['legacy|worker'], undefined);
  appStore.onTelemetry({ t: 3000, stats: { master, worker: { gpu_name: 'NVIDIA GeForce RTX 4090 Laptop GPU', gpu_util: 70, nvidia_smi_error: false } } });
  assert.deepEqual(appStore.store.getState().buffers.gpus['legacy|worker'].util, [70]);
});

test('N-device telemetry: one buffer per launch device, offline readings skipped, net from every host', () => {
  const appStore = createAppStore();
  appStore.onTelemetry({ t: 1000, stats: THREE_DEVICE_STATS });
  const dropped = {
    ...THREE_DEVICE_STATS,
    hosts: { ...THREE_DEVICE_STATS.hosts, laptop: { ...THREE_DEVICE_STATS.hosts.laptop, net_bytes: 50 + 1024 * 1024 } },
    devices: THREE_DEVICE_STATS.devices.map((d) => (d.id === 'RPC0' ? { ...d, util: null, vram_used: null } : d)),
  };
  appStore.onTelemetry({ t: 2000, stats: dropped });
  const s = appStore.store.getState();
  const lens = Object.fromEntries(Object.entries(s.buffers.gpus).map(([k, v]) => [k.split('|')[1], v.util.length]));
  assert.deepEqual(lens, { Vulkan1: 2, RPC0: 1, CUDA0: 2 });
  assert.ok(s.netMbps > 0.99 && s.netMbps < 1.01, `net summed over hosts (got ${s.netMbps})`);
});

test('backfill dedupes against live completions', () => {
  const appStore = createAppStore();
  appStore.backfillCompletions([
    { runId: 'r1', promptTps: 100, genTps: 10 },
    { runId: 'r2', promptTps: 110, genTps: 11 },
  ]);
  appStore.onSSEEvent({ state: 'ready', model: 'm', log: 'COMPLETION:' + JSON.stringify({ runId: 'r1' }) });
  appStore.onSSEEvent({ state: 'ready', model: 'm', log: 'COMPLETION:' + JSON.stringify({ runId: 'r3' }) });
  const ids = appStore.store.getState().completions.map((c) => c.runId);
  assert.deepEqual(ids, ['r1', 'r2', 'r3']);
});

test('external-server events (dashboard polling a llama-server it did not launch) feed live and clear on idle', () => {
  const appStore = createAppStore();
  const external = { port: 8080, model: 'Qwen3.8-Flash-Next-UD-Q3_K_XL', busy: true };
  appStore.onSSEEvent({ state: 'stopped', model: '', external, log: 'PREFILL_PROGRESS:0.50:900.00:2048:1024.00' });
  appStore.onSSEEvent({ state: 'stopped', model: '', external, log: 'GEN_PROGRESS:30.00:28.50:120' });
  appStore.onSSEEvent({ state: 'stopped', model: '', external, log: 'CTX_LIVE:33115:65536:1' });
  let s = appStore.store.getState();
  assert.equal(s.server.external.model, 'Qwen3.8-Flash-Next-UD-Q3_K_XL');
  assert.equal(s.live.promptTps, 1024);
  assert.equal(s.live.genTps, 30);
  assert.equal(s.live.genInst, 28.5);
  assert.equal(s.live.ctxUsed, 33115);
  assert.equal(s.live.active, true);

  // No COMPLETION ever arrives for these -- busy=0 is the end signal, and the
  // last request's numbers stay up.
  appStore.onSSEEvent({ state: 'stopped', model: '', external: { ...external, busy: false }, log: 'CTX_LIVE:33200:65536:0' });
  s = appStore.store.getState();
  assert.equal(s.live.active, false);
  assert.equal(s.live.genTps, 30);

  appStore.onSSEEvent({ state: 'stopped', model: '' });
  assert.equal(appStore.store.getState().server.external, null);
});
