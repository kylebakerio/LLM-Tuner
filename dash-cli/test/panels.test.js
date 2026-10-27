import { test } from 'node:test';
import assert from 'node:assert/strict';
import { telemetryPanels, panelLayout, netBytesOf } from '../src/format.js';

const gpu = (over) => ({
  host: 'local', index: 0, pci: '', vendor: 'nvidia', gpu_name: '', gpu_util: 10, vram_used: 1000, vram_total: 12000,
  process_vram: 0, gpu_pwr: 50, gpu_temp: 50, gpu_throttle: false, throttle_reasons: [], error: false, ...over,
});

// Server telemetry during a three-device launch (rig as of 2026-09-13).
export const THREE_DEVICE_STATS = {
  hosts: {
    local: { cpu_name: 'AMD Ryzen 7 5800X', cpu_util: 12, cpu_temp: 55, ram_used: 20000, ram_total: 32000, net_bytes: 100, error: false },
    laptop: { cpu_name: 'i9-13900H', cpu_util: 33, cpu_temp: 77, ram_used: 12288, ram_total: 32768, net_bytes: 50, error: false },
  },
  gpus: [
    gpu({ index: 0, pci: '09:00.0', gpu_name: 'NVIDIA GeForce RTX 3060', gpu_util: 30, throttle_reasons: ['sw_power_cap'] }),
    gpu({ index: 0, pci: '0c:00.0', vendor: 'amd', gpu_name: 'AMD Radeon RX 7900 XTX', gpu_util: 90, vram_total: 24560 }),
    gpu({ host: 'laptop', pci: '01:00.0', gpu_name: 'NVIDIA GeForce RTX 4090 Laptop GPU', gpu_util: 70, vram_total: 16376 }),
  ],
  devices: [
    { id: 'Vulkan1', name: 'AMD Radeon RX 7900 XTX', label: 'RX 7900 XTX', host: 'local', share: 50, util: 90, pwr: 50, temp: 50, vram_used: 1000, vram_total: 24560, thermal: false },
    { id: 'RPC0', name: 'NVIDIA GeForce RTX 4090 Laptop GPU', label: 'RTX 4090 Laptop', host: 'laptop', share: 30, util: 70, pwr: 50, temp: 50, vram_used: 1000, vram_total: 16376, thermal: false },
    { id: 'CUDA0', name: 'NVIDIA GeForce RTX 3060', label: 'RTX 3060', host: 'local', share: 20, util: 30, pwr: 50, temp: 50, vram_used: 1000, vram_total: 12288, thermal: false },
  ],
  master: { gpu_name: 'AMD Radeon RX 7900 XTX' },
  worker: { gpu_name: 'NVIDIA GeForce RTX 4090 Laptop GPU' },
};

test('telemetryPanels: one panel per launch device, in launch order, full GPU entry when found', () => {
  const panels = telemetryPanels(THREE_DEVICE_STATS, true);
  assert.deepEqual(panels.map((p) => [p.title, p.name]), [
    ['Vulkan1', 'RX 7900 XTX'], ['RPC0', 'RTX 4090 Laptop@laptop'], ['CUDA0', 'RTX 3060'],
  ]);
  assert.deepEqual(panels[2].gpu.throttle_reasons, ['sw_power_cap'], 'the gpus entry supplies throttle reasons');
  assert.equal(new Set(panels.map((p) => p.key)).size, 3, 'distinct buffer keys');
});

test('telemetryPanels: a device with no reading stays as an offline panel', () => {
  const stats = {
    ...THREE_DEVICE_STATS,
    gpus: THREE_DEVICE_STATS.gpus.filter((g) => g.host !== 'laptop'),
    devices: THREE_DEVICE_STATS.devices.map((d) => (d.host === 'laptop' ? { ...d, util: null, pwr: null, temp: null, vram_used: null, vram_total: null } : d)),
  };
  const panels = telemetryPanels(stats, true);
  assert.equal(panels.length, 3);
  assert.equal(panels[1].gpu.gpu_name, 'Offline');
  assert.equal(panels[1].key, telemetryPanels(THREE_DEVICE_STATS, true)[1].key, 'same key whether or not a reading arrived');
});

test('telemetryPanels: no launch -> every GPU; old server -> master/worker', () => {
  const idle = telemetryPanels({ hosts: THREE_DEVICE_STATS.hosts, gpus: THREE_DEVICE_STATS.gpus.slice(0, 2), devices: null });
  assert.deepEqual(idle.map((p) => [p.title, p.name]), [['GPU 0', 'RTX 3060'], ['GPU 1', 'RX 7900 XTX']]);
  const legacy = telemetryPanels({ master: { gpu_name: 'A' }, worker: { gpu_name: 'Offline' } }, false);
  assert.deepEqual(legacy.map((p) => p.title), ['GPU 0'], 'offline legacy worker hidden outside RPC');
  assert.deepEqual(telemetryPanels({ master: { gpu_name: 'A' } }, true).map((p) => p.title), ['Local', 'Worker (rpc)']);
  assert.deepEqual(telemetryPanels(null), []);
});

test('panelLayout: two per row, three on wide terminals, extra rows wrap', () => {
  assert.deepEqual(panelLayout(2, 80), { perRow: 2, widths: [39, 40], rows: 1 });
  assert.equal(panelLayout(3, 80).rows, 2, '80 cols: 2 + 1');
  const wide = panelLayout(3, 150);
  assert.equal(wide.perRow, 3);
  assert.equal(wide.rows, 1);
  assert.equal(wide.widths.reduce((a, b) => a + b, 0), 148);
  assert.equal(panelLayout(5, 150).rows, 2);
  assert.equal(panelLayout(0, 80).rows, 1, 'always room for one placeholder panel');
});

test('netBytesOf sums hosts, else master + worker', () => {
  assert.equal(netBytesOf(THREE_DEVICE_STATS), 150);
  assert.equal(netBytesOf({ master: { net_bytes: 5 }, worker: { net_bytes: 7 } }), 12);
  assert.equal(netBytesOf(null), 0);
});

test('telemetryPanels: a card the launch does not use still gets a panel', () => {
  const stats = {
    devices: [{ id: 'ROCm0', name: 'AMD Radeon RX 7900 XTX', label: 'RX 7900 XTX', host: 'local', util: 50, vram_used: 100, vram_total: 24560 }],
    gpus: [
      { host: 'local', index: 0, pci: '04:00.0', gpu_name: 'NVIDIA GeForce RTX 3060', gpu_util: 99, vram_used: 11473, vram_total: 12288 },
      { host: 'local', index: 0, pci: '0c:00.0', gpu_name: 'AMD Radeon RX 7900 XTX', gpu_util: 50, vram_used: 100, vram_total: 24560 },
    ],
  };
  const panels = telemetryPanels(stats);
  assert.equal(panels.length, 2);
  assert.equal(panels[0].title, 'ROCm0');
  assert.equal(panels[1].title, 'not in launch');
  assert.equal(panels[1].name, 'RTX 3060');
  assert.equal(panels[1].gpu.gpu_util, 99);
});
