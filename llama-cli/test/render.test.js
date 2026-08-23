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
  assert.match(out, /Test GPU 4090/);
  assert.match(out, /Worker GPU/);
  assert.match(out, /PWR-CAP/, 'throttle badge rendered');
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
  assert.match(out, /Mission Control offline/);
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
