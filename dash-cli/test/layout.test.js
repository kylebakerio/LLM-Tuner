import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
import App from '../src/app.js';
import { createAppStore } from '../src/state.js';

const clientStub = {
  getJson: async () => ({}),
  postJson: async () => ({}),
  connect() {},
  close() {},
};

// Seed a running model with knobs that used to change the screen height:
// throttle flags, telemetry presence, worker presence, completion count,
// aborted rows, GPU offline.
function seed(appStore, {
  throttle = ['sw_power_cap'], telemetry = true, worker = true,
  completions = 1, aborted = false, gpuOnline = true, isRpc = false, workerError = false,
} = {}) {
  appStore.onConnState('live');
  appStore.onSSEEvent({
    state: 'ready',
    isRpc,
    model: 'test-model.gguf',
    launchCommand: '/x/llama-server -m /y/test-model.gguf --port 8080',
    launchConfig: { modelPath: '/y/test-model.gguf', build: 'vulkan', ctx: 8192, ngl: 99, port: 8080 },
    log: '',
  });
  if (telemetry) {
    appStore.onTelemetry({
      t: Date.now(),
      stats: {
        master: {
          gpu_name: gpuOnline ? 'Test GPU 4090' : 'Offline',
          gpu_util: 42, vram_used: 14000, vram_total: 16376,
          process_vram: 13900, gpu_pwr: 180, gpu_temp: 63, throttle_reasons: throttle,
          cpu_util: 25.5, cpu_temp: 61, ram_used: 18000, ram_total: 31744, net_bytes: 123,
        },
        ...(worker ? {
          worker: {
            gpu_name: 'Worker GPU', gpu_util: 12, vram_used: 4000, vram_total: 24560, net_bytes: 0,
            cpu_name: 'i9', cpu_util: 20, cpu_temp: 70, ram_used: 9000, ram_total: 32000, nvidia_smi_error: workerError,
          },
        } : {}),
      },
    });
  }
  if (completions > 0) {
    appStore.backfillCompletions(Array.from({ length: completions }, (_, i) => ({
      runId: `r${i}`, timestamp: Date.now(), model: 'test-model.gguf',
      promptTps: 400.5, genTps: 21.3, promptTokens: 1280, genTokens: 246,
      wallTime: 12.1, aborted: aborted && i === 0,
    })));
  }
}

const lineCount = (view) => (view.lastFrame() || '').split('\n').length;

test('Monitor screen height is stable across states (no layout thrashing)', async (t) => {
  const cases = [
    ['baseline', {}],
    ['real thermal badge appears', { throttle: ['hw_thermal_slowdown', 'sw_power_cap'] }],
    ['sw thermal below 75C floor (ignored)', { throttle: ['sw_thermal_slowdown', 'sw_power_cap'] }],
    ['power brake badge', { throttle: ['sw_power_cap', 'hw_power_brake_slowdown'] }],
    ['no telemetry yet', { telemetry: false }],
    ['gpu reports offline', { gpuOnline: false }],
    ['no worker gpu', { worker: false }],
    ['rpc run with worker', { isRpc: true }],
    ['rpc run, worker nvidia-smi error', { isRpc: true, workerError: true }],
    ['rpc run, no worker telemetry', { isRpc: true, worker: false }],
    ['no completions yet', { completions: 0 }],
    ['three completions incl. aborted', { completions: 3, aborted: true }],
  ];
  const heights = {};
  for (const [name, opts] of cases) {
    const appStore = createAppStore();
    seed(appStore, opts);
    const view = render(React.createElement(App, { client: clientStub, appStore, serverUrl: 'http://localhost:3000' }));
    t.after(view.unmount);
    await sleep(50);
    heights[name] = lineCount(view);
  }
  const base = heights.baseline;
  for (const [name, n] of Object.entries(heights)) {
    assert.equal(n, base, `${name}: frame is ${n} lines, baseline is ${base} (layout thrash)`);
  }
});

test('throttle badge line is present (and calm) even with no throttle flags', async (t) => {
  const appStore = createAppStore();
  seed(appStore, { throttle: [] });
  const view = render(React.createElement(App, { client: clientStub, appStore, serverUrl: 'http://localhost:3000' }));
  t.after(view.unmount);
  await sleep(50);
  const out = view.lastFrame() || '';
  assert.match(out, /throttle: none/, 'permanent throttle line shows "none"');
  assert.doesNotMatch(out, /THERM|PWR-BRAKE/);
});
