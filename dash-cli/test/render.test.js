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

function seedRunning(appStore) {
  appStore.onConnState('live');
  appStore.onSSEEvent({
    state: 'ready',
    model: 'test-model.gguf',
    launchCommand: '/x/llama-server -m /y/test-model.gguf --port 8080',
    launchConfig: { modelPath: '/y/test-model.gguf', build: 'vulkan', ctx: 8192, ngl: 99, port: 8080 },
    log: '',
  });
  appStore.onTelemetry({
    t: Date.now(),
    stats: {
      master: {
        gpu_name: 'Test GPU 4090', gpu_util: 42, vram_used: 14000, vram_total: 16376,
        process_vram: 13900, gpu_pwr: 180, gpu_temp: 63, throttle_reasons: ['sw_power_cap'],
        cpu_util: 25.5, cpu_temp: 61, ram_used: 18000, ram_total: 31744, net_bytes: 123,
      },
      worker: { gpu_name: 'Worker GPU', gpu_util: 12, vram_used: 4000, vram_total: 24560, net_bytes: 0 },
    },
  });
  appStore.backfillCompletions([{
    runId: 'r1', timestamp: Date.now(), model: 'test-model.gguf',
    promptTps: 400.5, genTps: 21.3, promptTokens: 1280, genTokens: 246, wallTime: 12.1, aborted: false,
  }]);
}

test('Monitor mode renders the full btop screen', async (t) => {
  const appStore = createAppStore();
  seedRunning(appStore);
  const view = render(React.createElement(App, { client: clientStub, appStore, serverUrl: 'http://localhost:3000' }));
  t.after(view.unmount);
  await sleep(50);
  const out = view.lastFrame() || '';

  assert.match(out, /Llama CLI/);
  assert.match(out, /test-model\.gguf/);
  assert.match(out, /\[ready\]/);
  assert.match(out, /GPU 0 · Test 4090/, 'legacy panels: the card name, vendor/"GPU" words dropped');
  assert.match(out, /GPU 1 · Worker/);
  assert.match(out, /pwr-cap/, 'info-level throttle badge (permanent fw cap, not an alarm)');
  assert.match(out, /TOKENS \/ CONTEXT/);
  assert.match(out, /COMPLETED REQUESTS/);
  assert.match(out, /SYSTEM/);
  assert.match(out, /1 Monitor/, 'tab strip');
  assert.match(out, /stop server/, 'keymap bar');
});

test('Monitor mode shows the offline screen when disconnected', async (t) => {
  const appStore = createAppStore();
  appStore.onConnState('reconnecting');
  const view = render(React.createElement(App, { client: clientStub, appStore, serverUrl: 'http://localhost:3000' }));
  t.after(view.unmount);
  await sleep(50);
  const out = view.lastFrame() || '';
  assert.match(out, /LL-Dash offline/);
  assert.match(out, /pm2 start ecosystem\.config\.js/);
});

test('Launch mode renders the form and catalog', async (t) => {
  const appStore = createAppStore();
  appStore.onConnState('live');
  appStore.onSSEEvent({ state: 'stopped', model: '', log: '', launchConfig: null });

  const client = {
    getJson: async (p) => {
      if (p === '/api/models') return [
        { name: 'alpha-7b.gguf', path: '/models/alpha-7b.gguf', size: '4.2', source: 'local' },
        { name: 'beta-35b.gguf', path: '/models/beta-35b.gguf', size: '20.7', source: 'local' },
      ];
      if (p === '/api/builds') return { builds: [{ id: 'vulkan', label: 'Vulkan Only', path: '/x/llama-server' }] };
      if (p.startsWith('/api/devices')) return { devices: [{ id: 'CUDA0', description: 'Test 4090', totalMib: 15943, freeMib: 100 }] };
      return {};
    },
    postJson: async (p) => (p === '/api/preview-command' ? { command: '/x/llama-server -m /models/alpha-7b.gguf -c 8192 -ngl 99' } : {}),
    connect() {},
    close() {},
  };

  // Monitor with no model (App's default mode):
  const view = render(React.createElement(App, { client, appStore, serverUrl: 'http://localhost:3000' }));
  t.after(view.unmount);
  await sleep(50);
  assert.match(view.lastFrame() || '', /no model loaded/);

  // Launch rendered directly (mode switching needs a keypress, covered by the
  // live smoke test):
  const { Launch } = await import('../src/modes/launch.js');
  const view2 = render(React.createElement(Launch, {
    client, appStore, serverUrl: 'http://localhost:3000',
    modeGateRef: { current: false },
    onLaunched: () => {},
  }));
  t.after(view2.unmount);
  await sleep(700); // let catalog load + 400ms preview debounce land
  const out = view2.lastFrame() || '';
  assert.match(out, /LAUNCH/);
  assert.match(out, /Model/);
  assert.match(out, /alpha-7b\.gguf/, 'default model prefilled from catalog');
  assert.match(out, /command:/);
  assert.match(out, /\/x\/llama-server -m \/models\/alpha-7b\.gguf/, 'preview command from API');
});

test('Monitor labels the GPU panels Local / Worker (rpc) and shows worker cpu/ram during an RPC run', async (t) => {
  const appStore = createAppStore();
  appStore.onConnState('live');
  appStore.onSSEEvent({
    state: 'ready', model: 'm.gguf', isRpc: true, log: '',
    launchCommand: '/x/llama-server -m /y/m.gguf --port 8080',
    launchConfig: { modelPath: '/y/m.gguf', rpcTarget: 'laptop', transport: 'TB4' },
  });
  appStore.onTelemetry({
    t: Date.now(),
    stats: {
      master: {
        gpu_name: 'AMD Radeon RX 7900 XTX', gpu_util: 30, vram_used: 20000, vram_total: 24560,
        gpu_pwr: 200, gpu_temp: 60, cpu_util: 10, cpu_temp: 50, ram_used: 8000, ram_total: 64000,
        net_bytes: 1, amdgpu_top_error: false,
      },
      worker: {
        gpu_name: 'NVIDIA GeForce RTX 4090 Laptop GPU', gpu_util: 80, vram_used: 14000, vram_total: 16376,
        gpu_pwr: 150, gpu_temp: 70, cpu_name: 'i9', cpu_util: 33, cpu_temp: 77, ram_used: 12288, ram_total: 32768,
        net_bytes: 0, nvidia_smi_error: false,
      },
    },
  });
  const view = render(React.createElement(App, { client: clientStub, appStore, serverUrl: 'http://localhost:3000' }));
  t.after(view.unmount);
  await sleep(50);
  const out = view.lastFrame() || '';
  assert.match(out, /Local · RX 7900 XTX/, 'vendor and product-line words dropped from the card name');
  assert.match(out, /Worker \(rpc\) · RTX 4090 Laptop\b/);
  assert.doesNotMatch(out, /GPU 0|GPU 1/);
  assert.match(out, /wrk\s+33%\s+77°C · ram 12\.0\/32\.0G/);
});

test('Monitor treats an nvidia_smi_error worker as offline (panel kept during RPC)', async (t) => {
  const appStore = createAppStore();
  appStore.onConnState('live');
  appStore.onSSEEvent({ state: 'ready', model: 'm.gguf', isRpc: true, log: '', launchCommand: '', launchConfig: null });
  appStore.onTelemetry({
    t: Date.now(),
    stats: {
      master: { gpu_name: 'AMD Radeon RX 7900 XTX', gpu_util: 30, vram_used: 1, vram_total: 2, cpu_util: 1, ram_used: 1, ram_total: 2 },
      worker: { gpu_name: 'Unknown', gpu_util: 0, vram_used: 0, vram_total: 1, cpu_name: 'Offline', ram_total: 1, nvidia_smi_error: true },
    },
  });
  const view = render(React.createElement(App, { client: clientStub, appStore, serverUrl: 'http://localhost:3000' }));
  t.after(view.unmount);
  await sleep(50);
  const out = view.lastFrame() || '';
  assert.match(out, /Worker \(rpc\)/);
  assert.doesNotMatch(out, /Unknown/, 'error-fallback name is not shown as a real card');
  assert.match(out, /offline/);
  assert.match(out, /worker telemetry offline/);
});

// /api/devices on the desktop's CUDA+Vulkan build, with the laptop worker.
const DEVICES_RESPONSE = {
  devices: [
    { id: 'CUDA0', description: 'NVIDIA GeForce RTX 3060', totalMib: 11906, freeMib: 10000 },
    { id: 'Vulkan0', description: 'NVIDIA GeForce RTX 3060', totalMib: 12288, freeMib: 10000 },
    { id: 'Vulkan1', description: 'AMD Radeon RX 7900 XTX (RADV NAVI31)', totalMib: 24560, freeMib: 20000 },
  ],
  cards: [
    { name: 'NVIDIA GeForce RTX 3060', vendor: 'nvidia', preferredId: 'CUDA0', ambiguous: false,
      backends: [{ id: 'CUDA0', totalMib: 11906, freeMib: 10000 }, { id: 'Vulkan0', totalMib: 12288, freeMib: 10000 }] },
    { name: 'AMD Radeon RX 7900 XTX', vendor: 'amd', preferredId: 'Vulkan1', ambiguous: false,
      backends: [{ id: 'Vulkan1', totalMib: 24560, freeMib: 20000 }] },
  ],
  workers: [{ name: 'laptop', ssh: 'laptop', port: 50052, devices: 'CUDA0', deviceCount: 1, cache: true, link: 'ssh' }],
};

function launchClient(posts, { status = 'running' } = {}) {
  return {
    getJson: async (p) => {
      if (p === '/api/models') return [{ name: 'alpha-7b.gguf', path: '/models/alpha-7b.gguf', size: '4.2', source: 'local' }];
      if (p === '/api/builds') return { builds: [{ id: 'vulkan-cuda', label: 'Vulkan + CUDA', path: '/x/llama-server' }] };
      if (p === '/api/worker/config') return { ssh: 'laptop', workers: DEVICES_RESPONSE.workers };
      if (p.startsWith('/api/devices')) return DEVICES_RESPONSE;
      return {};
    },
    postJson: async (p, body) => {
      posts.push([p, body]);
      if (p === '/api/worker/status') return { status };
      if (p === '/api/preview-command') {
        // A config without `devices` is a conversion request from the CLI.
        if (!Array.isArray(body.devices)) {
          return {
            command: '', devices: [{ id: 'Vulkan1', share: 70 }, { worker: 'laptop', share: 30, id: 'RPC0' }],
            warnings: ['Vulkan1 was saved without a card name'],
          };
        }
        return { command: '/x/llama-server --rpc 127.0.0.1:50052 --split-mode layer -dev Vulkan1,RPC0 -ts 70,30', warnings: [] };
      }
      return {};
    },
    connect() {},
    close() {},
  };
}

test('Launch prefilled from an old-style RPC run: converted by the server, device rows shown, only `devices` sent', async (t) => {
  const appStore = createAppStore();
  appStore.onConnState('live');
  appStore.onSSEEvent({
    state: 'stopped', model: '', log: '',
    launchConfig: {
      modelPath: '/models/alpha-7b.gguf', build: 'vulkan-cuda', ctx: 8192, ngl: 99,
      deviceA: 'Vulkan1', tensorSplit: 70, rpcTarget: 'laptop', transport: 'TB4',
      rawCommand: '/x/llama-server -m /models/other.gguf', verbosity: 1,
    },
  });
  const posts = [];
  const { Launch } = await import('../src/modes/launch.js');
  const view = render(React.createElement(Launch, {
    client: launchClient(posts), appStore, serverUrl: 'http://localhost:3000', modeGateRef: { current: false }, onLaunched: () => {},
  }));
  t.after(view.unmount);
  await sleep(150);
  view.stdin.write('\t'); // core -> hw group
  await sleep(900);
  const out = view.lastFrame() || '';
  assert.match(out, /\[x\] RX 7900 XTX\s+Vulkan1\s+share 70 \(70%\)/);
  assert.match(out, /\[x\] RPC laptop\s+share 30 \(30%\)\s+\[RUNNING\]/);
  assert.match(out, /\[ \] RTX 3060\s+CUDA0 \(v: CUDA0\/Vulkan0\)/);
  assert.match(out, /Transport\s+TB4/);
  assert.match(out, /saved without a card name/, 'conversion warning shown');

  const conversion = posts.find(([p, b]) => p === '/api/preview-command' && !Array.isArray(b.devices));
  assert.ok(conversion, 'old config converted through the server preview');
  assert.equal('rawCommand' in conversion[1], false);
  const preview = posts.filter(([p, b]) => p === '/api/preview-command' && Array.isArray(b.devices)).pop();
  assert.ok(preview, 'preview requested with devices');
  assert.deepEqual(preview[1].devices, [
    { id: 'Vulkan1', name: 'AMD Radeon RX 7900 XTX', vramMib: 24560, share: 70, enabled: true },
    { worker: 'laptop', share: 30, enabled: true },
    { id: 'CUDA0', name: 'NVIDIA GeForce RTX 3060', vramMib: 12288, enabled: false },
  ]);
  for (const k of ['deviceA', 'deviceB', 'rpcTarget', 'tensorSplit', 'rawCommand']) assert.equal(k in preview[1], false, `${k} not sent`);
  assert.equal(preview[1].transport, 'TB4');
  assert.equal(preview[1].verbosity, 3);
  const status = posts.find(([p]) => p === '/api/worker/status');
  assert.deepEqual(status[1], { worker: 'laptop' });
});

test('Launch polls a worker only while its row is enabled (space toggles the focused row)', async (t) => {
  const appStore = createAppStore();
  appStore.onConnState('live');
  appStore.onSSEEvent({
    state: 'stopped', model: '', log: '',
    launchConfig: {
      modelPath: '/models/alpha-7b.gguf', build: 'vulkan-cuda', ctx: 8192, ngl: 99,
      devices: [{ id: 'Vulkan1', name: 'AMD Radeon RX 7900 XTX' }, { worker: 'laptop', enabled: false }],
    },
  });
  const posts = [];
  const { Launch } = await import('../src/modes/launch.js');
  const view = render(React.createElement(Launch, {
    client: launchClient(posts, { status: 'stopped' }), appStore, serverUrl: 'http://localhost:3000', modeGateRef: { current: false }, onLaunched: () => {},
  }));
  t.after(view.unmount);
  await sleep(150);
  view.stdin.write('\t'); // hw group, row 1 (XTX) focused
  await sleep(700);
  assert.equal(posts.filter(([p]) => p === '/api/worker/status').length, 0, 'disabled worker is not polled');
  assert.match(view.lastFrame() || '', /\[ \] RPC laptop/);
  view.stdin.write('[B'); // down -> worker row
  await sleep(100);
  view.stdin.write(' ');
  await sleep(400);
  assert.ok(posts.some(([p, b]) => p === '/api/worker/status' && b.worker === 'laptop'), 'enabling the row starts polling');
  assert.match(view.lastFrame() || '', /\[x\] RPC laptop.*\[STOPPED\]/);
});

test('Monitor draws one GPU panel per launch device and a row per worker host', async (t) => {
  const { THREE_DEVICE_STATS } = await import('./panels.test.js');
  const appStore = createAppStore();
  appStore.onConnState('live');
  appStore.onSSEEvent({ state: 'ready', model: 'm.gguf', isRpc: true, log: '', launchCommand: '/x/llama-server --port 8080', launchConfig: null });
  appStore.onTelemetry({ t: Date.now(), stats: THREE_DEVICE_STATS });
  const view = render(React.createElement(App, { client: clientStub, appStore, serverUrl: 'http://localhost:3000' }));
  t.after(view.unmount);
  await sleep(50);
  const out = view.lastFrame() || '';
  assert.match(out, /Vulkan1 · RX 7900 XTX/);
  assert.match(out, /RPC0 · RTX 4090 Laptop@laptop/);
  assert.match(out, /CUDA0 · RTX 3060/);
  assert.match(out, /laptop\s+33%\s+77°C · ram 12\.0\/32\.0G/);
  assert.doesNotMatch(out, /\(no rpc worker\)/);
});

test('Help overlay renders on ? key (via direct Help render)', async (t) => {
  const { Help } = await import('../src/components/help.js');
  const view = render(React.createElement(Help, { mode: 'mode2' }));
  t.after(view.unmount);
  await sleep(50);
  const out = view.lastFrame() || '';
  assert.match(out, /Help/);
  assert.match(out, /save profile/);
  assert.match(out, /Ctrl-C/);
});
