import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createAppStore } from '../src/state.js';

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

test('telemetry fills buffers and computes net rate', () => {
  const appStore = createAppStore();
  appStore.onTelemetry({ t: 1000, stats: { master: { gpu_util: 50, vram_used: 1000, net_bytes: 1000 }, worker: null } });
  appStore.onTelemetry({
    t: 2000,
    stats: {
      master: { gpu_util: 60, vram_used: 1100, net_bytes: 1000 + 1024 * 1024 },
      worker: { gpu_name: 'w', gpu_util: 10, vram_used: 500, net_bytes: 0 },
    },
  });
  const s = appStore.store.getState();
  assert.equal(s.buffers.mUtil.length, 2);
  assert.equal(s.buffers.wUtil.length, 1, 'worker buffers only fill when worker online');
  assert.ok(s.netMbps > 0.99 && s.netMbps < 1.01, `net rate ~1 MB/s (got ${s.netMbps})`);
  assert.equal(s.telemetry.master.gpu_util, 60);
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
