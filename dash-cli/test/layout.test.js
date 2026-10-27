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

test('N-device Monitor height is stable while readings drop or badges change', async (t) => {
  const { THREE_DEVICE_STATS } = await import('./panels.test.js');
  const variants = {
    baseline: THREE_DEVICE_STATS,
    'worker readings dropped': {
      ...THREE_DEVICE_STATS,
      hosts: { ...THREE_DEVICE_STATS.hosts, laptop: { cpu_name: 'Offline', ram_total: 1, error: true } },
      gpus: THREE_DEVICE_STATS.gpus.filter((g) => g.host !== 'laptop'),
      devices: THREE_DEVICE_STATS.devices.map((d) => (d.host === 'laptop' ? { ...d, util: null, vram_used: null, vram_total: null, pwr: null, temp: null } : d)),
    },
    'real thermal badge': {
      ...THREE_DEVICE_STATS,
      gpus: THREE_DEVICE_STATS.gpus.map((g) => ({ ...g, throttle_reasons: ['hw_thermal_slowdown', 'sw_power_cap'] })),
    },
  };
  const heights = {};
  for (const [name, stats] of Object.entries(variants)) {
    const appStore = createAppStore();
    appStore.onConnState('live');
    appStore.onSSEEvent({ state: 'ready', isRpc: true, model: 'm.gguf', launchCommand: '/x --port 8080', launchConfig: null, log: '' });
    appStore.onTelemetry({ t: Date.now(), stats });
    const view = render(React.createElement(App, { client: clientStub, appStore, serverUrl: 'http://localhost:3000' }));
    t.after(view.unmount);
    await sleep(50);
    heights[name] = lineCount(view);
  }
  for (const [name, n] of Object.entries(heights)) {
    assert.equal(n, heights.baseline, `${name}: frame is ${n} lines, baseline is ${heights.baseline} (layout thrash)`);
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

// Fan and memory temperature (monitor.py `fan_rpm`, `fan_pct`, `mem_temp` on
// each stats.gpus entry) on the panel's temp line -- and the same panel
// height whether a card has those sensors, has only a fan percentage
// (NVIDIA), or has no reading at all.
test('GPU panels: a temp line with memory temperature and fan where the card reports them; same height without', async (t) => {
  const gpu = (over) => ({
    host: 'local', vendor: 'amd', gpu_name: 'AMD Radeon RX 7900 XTX', gpu_util: 97, vram_used: 21000, vram_total: 24560,
    process_vram: 20000, gpu_pwr: 322, gpu_temp: 96, throttle_reasons: [], error: false, ...over,
  });
  const frameFor = async (gpus) => {
    const appStore = createAppStore();
    appStore.onConnState('live');
    appStore.onSSEEvent({ state: 'stopped', model: '', launchCommand: '', launchConfig: null, log: '' });
    appStore.onTelemetry({ t: Date.now(), stats: { hosts: { local: { cpu_util: 10, cpu_temp: 60, ram_used: 1000, ram_total: 64000, net_bytes: 0 } }, gpus, devices: [] } });
    const view = render(React.createElement(App, { client: clientStub, appStore, serverUrl: 'http://localhost:3000' }));
    t.after(view.unmount);
    await sleep(50);
    return view.lastFrame() || '';
  };
  const withSensors = await frameFor([
    gpu({ index: 0, pci: '0b:00.0', mem_temp: 102, fan_rpm: 2950, fan_pct: 86 }),
    gpu({ index: 1, pci: '0e:00.0', gpu_temp: 84, mem_temp: 90, fan_rpm: 2237, fan_pct: 61 }),
  ]);
  assert.match(withSensors, /temp 96°C · mem 102°C · fan 2950 rpm \(86%\)/);
  assert.match(withSensors, /temp 84°C · mem 90°C · fan 2237 rpm \(61%\)/);
  assert.doesNotMatch(withSensors, /pow\s+322W.*°C/, 'the temperature moved off the power line onto its own');
  assert.match(withSensors, /throttle: none/, 'the throttle line is still there, under it');

  const nvidia = await frameFor([
    gpu({ index: 0, pci: '01:00.0', vendor: 'nvidia', gpu_name: 'NVIDIA GeForce RTX 4090 Laptop GPU', gpu_temp: 82, mem_temp: null, fan_rpm: null, fan_pct: 45 }),
    gpu({ index: 1, pci: '25:00.0', vendor: 'nvidia', gpu_name: 'NVIDIA GeForce RTX 3060', gpu_temp: 52 }),
  ]);
  assert.match(nvidia, /temp 82°C · fan 45%/, 'fan as a percentage when that is all the card reports');
  const bare = nvidia.split('\n').find((l) => /temp 52°C/.test(l));
  assert.ok(bare, 'a card with neither sensor still shows its temperature');
  assert.doesNotMatch(nvidia, /mem --|fan --|rpm/, 'a missing sensor is left out, not dashed');

  const offline = await frameFor([gpu({ index: 0, pci: '0b:00.0', error: true }), gpu({ index: 1, pci: '0e:00.0', error: true })]);
  assert.doesNotMatch(offline, /temp \d/, 'no reading: no temp text');
  const n = (s) => s.split('\n').length;
  assert.equal(n(nvidia), n(withSensors), 'same height with or without the sensors');
  assert.equal(n(offline), n(withSensors), 'and with no reading at all');
});

// Two identical cards in a terminal too narrow for their titles: the "#1" /
// "#2" is the part that must survive the cut.
test('GPU panel titles: a cut title keeps the card ordinal', async (t) => {
  const { normalizeTopology } = await import('../src/topology.js');
  const card = (n, ids) => ({ key: `amd radeon rx 7900 xtx#${n}`, name: 'AMD Radeon RX 7900 XTX', short: 'RX 7900 XTX', label: `AMD Radeon RX 7900 XTX (RADV NAVI31) #${n}`, vendor: 'amd', ordinal: n, count: 2, vramMib: 24560, ids, preferredId: ids[0] });
  const appStore = createAppStore();
  appStore.onConnState('live');
  appStore.onSSEEvent({ state: 'stopped', model: '', launchCommand: '', launchConfig: null, log: '' });
  appStore.onTopology({ cards: [card(1, ['ROCm0']), card(2, ['ROCm1'])], hostRamMib: 64223, workers: [], signature: '2x RX 7900 XTX 24G | 63G RAM' });
  assert.ok(normalizeTopology({ cards: [card(1, ['ROCm0'])] }), 'sanity: the fixture is a topology the client accepts');
  const g = (i, pci) => ({ host: 'local', index: i, pci, vendor: 'amd', gpu_name: 'AMD Radeon RX 7900 XTX', gpu_util: 5, vram_used: 500, vram_total: 24560, process_vram: 0, gpu_pwr: 30, gpu_temp: 40, throttle_reasons: [], error: false });
  appStore.onTelemetry({ t: Date.now(), stats: { hosts: { local: {} }, gpus: [g(0, '0b:00.0'), g(1, '0e:00.0')], devices: [] } });
  const view = render(React.createElement(App, { client: clientStub, appStore, serverUrl: 'http://localhost:3000' }));
  t.after(view.unmount);
  await sleep(50);
  const out = view.lastFrame() || '';
  // "<label> · <pci>" is 49 columns; a half-width panel of the test renderer's 100 leaves the title 39 or 40.
  // The plain cut ended both titles "…(RADV NAVI31) #…".
  const titles = out.split('\n').find((l) => /╭─\[/.test(l)) || '';
  assert.doesNotMatch(titles, /0b:00\.0 \]/, `sanity: the title did not fit and was cut: ${titles}`);
  assert.match(titles, /#1/, `card #1 is still told apart: ${titles}`);
  assert.match(titles, /#2/, `card #2 is still told apart: ${titles}`);
});
