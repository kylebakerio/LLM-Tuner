'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const D = require('../lib/devices');
const T = require('../lib/telemetry');

const gpu = (over) => ({
    host: 'local', index: 0, pci: '', vendor: 'nvidia', gpu_name: '', vram_used: 1000, vram_total: 12000,
    process_vram: 0, gpu_pwr: 50, gpu_temp: 50, gpu_util: 10, gpu_throttle: false, throttle_reasons: [], error: false,
    ...over,
});

// The rig as of 2026-09-13: 3060 + XTX here, 4090 laptop as worker "laptop".
const STATS = {
    hosts: {
        local: { cpu_name: 'AMD Ryzen 7 5800X', cpu_util: 12, cpu_temp: 55, ram_used: 20000, ram_total: 32000, process_ram: 900, net_bytes: 111 },
        laptop: { cpu_name: 'Intel i9-13900H', cpu_util: 3, cpu_temp: 60, ram_used: 8000, ram_total: 32000, process_ram: 400, net_bytes: 222 },
    },
    gpus: [
        gpu({ index: 0, pci: '09:00.0', gpu_name: 'NVIDIA GeForce RTX 3060', vram_total: 12288, gpu_util: 30 }),
        gpu({ index: 0, pci: '0c:00.0', vendor: 'amd', gpu_name: 'AMD Radeon RX 7900 XTX', vram_total: 24560, gpu_util: 90 }),
        gpu({ host: 'laptop', index: 0, pci: '01:00.0', gpu_name: 'NVIDIA GeForce RTX 4090 Laptop GPU', vram_total: 16376, gpu_util: 70 }),
    ],
};
const DETECTED = [
    { id: 'CUDA0', description: 'NVIDIA GeForce RTX 3060' },
    { id: 'Vulkan0', description: 'NVIDIA GeForce RTX 3060' },
    { id: 'Vulkan1', description: 'AMD Radeon RX 7900 XTX (RADV NAVI31)' },
];
const WORKERS = { laptop: { devices: 'CUDA0' } };

test('maps local devices by card name and worker devices by host', () => {
    const plan = D.planDevices({ devices: [{ id: 'Vulkan1', share: 50 }, { worker: 'laptop', share: 30 }, { id: 'CUDA0', share: 20 }] }, WORKERS);
    const m = T.mapDevicesToGpus(plan, STATS, DETECTED);
    assert.deepEqual(m.map((x) => x.gpu && x.gpu.gpu_name),
        ['AMD Radeon RX 7900 XTX', 'NVIDIA GeForce RTX 4090 Laptop GPU', 'NVIDIA GeForce RTX 3060']);
});

test('a stored device name wins over the detected description, and unknown devices map to null', () => {
    const plan = D.planDevices({ devices: [{ id: 'Vulkan0', name: 'AMD Radeon RX 7900 XTX' }, { id: 'ROCm3' }] }, {});
    const m = T.mapDevicesToGpus(plan, STATS, DETECTED);
    assert.equal(m[0].gpu.gpu_name, 'AMD Radeon RX 7900 XTX');
    assert.equal(m[1].gpu, null);
});

test('identical cards are claimed once each, in order', () => {
    const twins = { hosts: STATS.hosts, gpus: [gpu({ index: 0, gpu_name: 'NVIDIA GeForce RTX 3060' }), gpu({ index: 1, gpu_name: 'NVIDIA GeForce RTX 3060' })] };
    const plan = D.planDevices({ devices: [{ id: 'CUDA0', name: 'NVIDIA GeForce RTX 3060' }, { id: 'CUDA1', name: 'NVIDIA GeForce RTX 3060' }] }, {});
    assert.deepEqual(T.mapDevicesToGpus(plan, twins, []).map((x) => x.gpu.index), [0, 1]);
});

test('a worker whose telemetry is missing maps to null', () => {
    const plan = D.planDevices({ devices: [{ id: 'Vulkan1' }, { worker: 'laptop' }] }, WORKERS);
    const noLaptop = { hosts: STATS.hosts, gpus: STATS.gpus.filter((g) => g.host === 'local') };
    assert.equal(T.mapDevicesToGpus(plan, noLaptop, DETECTED)[1].gpu, null);
});

test('legacy master/worker come from the first two mapped devices, merged with their hosts', () => {
    const plan = D.planDevices({ devices: [{ id: 'Vulkan1' }, { worker: 'laptop' }, { id: 'CUDA0' }] }, WORKERS);
    const { master, worker } = T.legacyNodes(STATS, T.mapDevicesToGpus(plan, STATS, DETECTED));
    assert.equal(master.gpu_name, 'AMD Radeon RX 7900 XTX');
    assert.equal(master.cpu_name, 'AMD Ryzen 7 5800X');
    assert.equal(master.amdgpu_top_error, false);
    assert.equal('nvidia_smi_error' in master, false);
    assert.equal(worker.gpu_name, 'NVIDIA GeForce RTX 4090 Laptop GPU');
    assert.equal(worker.cpu_name, 'Intel i9-13900H');
    assert.equal(worker.nvidia_smi_error, false);
    assert.equal('host' in worker || 'pci' in worker || 'error' in worker, false);
});

test('with no launch, the pair is the two largest local GPUs; a single-device launch has no worker', () => {
    const idle = T.legacyNodes(STATS, null);
    assert.equal(idle.master.gpu_name, 'AMD Radeon RX 7900 XTX');
    assert.equal(idle.worker.gpu_name, 'NVIDIA GeForce RTX 3060');
    const solo = T.legacyNodes(STATS, T.mapDevicesToGpus(D.planDevices({ devices: [{ id: 'CUDA0' }] }, {}), STATS, DETECTED));
    assert.equal(solo.master.gpu_name, 'NVIDIA GeForce RTX 3060');
    assert.equal(solo.worker, undefined);
});

test('no GPUs at all still yields an Offline master carrying the local host', () => {
    const { master, worker } = T.legacyNodes({ hosts: STATS.hosts, gpus: [] }, null);
    assert.equal(master.gpu_name, 'Offline');
    assert.equal(master.cpu_name, 'AMD Ryzen 7 5800X');
    assert.equal(worker, undefined);
});

test('isRealThermal needs hw_thermal, or a sw thermal reason plus real heat', () => {
    assert.equal(T.isRealThermal({ throttle_reasons: ['hw_thermal_slowdown'], gpu_temp: 40 }), true);
    assert.equal(T.isRealThermal({ throttle_reasons: ['sw_thermal_slowdown'], gpu_temp: 50 }), false);
    assert.equal(T.isRealThermal({ throttle_reasons: ['sw_thermal_slowdown'], gpu_temp: 80 }), true);
    assert.equal(T.isRealThermal({ throttle_reasons: ['sw_power_cap'], gpu_temp: 90 }), false);
    assert.equal(T.isRealThermal(undefined), false);
});

test('short names, per-device records and chart samples', () => {
    assert.equal(T.shortGpuName('NVIDIA GeForce RTX 4090 Laptop GPU'), 'RTX 4090 Laptop');
    assert.equal(T.shortGpuName('AMD Radeon RX 7900 XTX (RADV NAVI31)'), 'RX 7900 XTX');
    const plan = D.planDevices({ devices: [{ id: 'Vulkan1', share: 60 }, { worker: 'laptop', share: 40 }] }, WORKERS);
    const m = T.mapDevicesToGpus(plan, STATS, DETECTED);
    assert.deepEqual(T.deviceRecord(m[1]), {
        id: 'RPC0', name: 'NVIDIA GeForce RTX 4090 Laptop GPU', label: 'RTX 4090 Laptop', host: 'laptop', pci: '01:00.0', share: 40,
        util: 70, pwr: 50, temp: 50, mem_temp: null, fan_rpm: null, fan_pct: null, vram_used: 1000, vram_total: 16376, thermal: false,
    });
    assert.deepEqual(T.sampleFromRecord(T.deviceRecord(m[0])),
        { id: 'Vulkan1', label: 'RX 7900 XTX', host: 'local', util: 90, pwr: 50, temp: 50, vram: 0.98, thermal: false });
    const missing = T.deviceRecord({ device: { id: 'CUDA0', name: 'NVIDIA GeForce RTX 3060' }, gpu: null });
    assert.equal(missing.label, 'RTX 3060');
    assert.equal(missing.util, null);
    assert.equal(T.deviceRecord({ device: { id: 'RPC1', worker: 'x' }, gpu: null }).label, 'RPC1');
});

// --- topology fixtures (lib/topology.js): the reading a device gets must be its own card's, whatever the machine ---
const topo = require('../lib/topology');
const XTX = 'AMD Radeon RX 7900 XTX', XTXV = 'AMD Radeon RX 7900 XTX (RADV NAVI31)';
const det = (id, description, totalMib) => ({ id, description, totalMib, freeMib: totalMib });
const TWO_XTX = [det('ROCm0', XTX, 24560), det('ROCm1', XTX, 24560), det('Vulkan0', XTXV, 24560), det('Vulkan1', XTXV, 24560)];
const amd = (over) => gpu({ vendor: 'amd', gpu_name: XTX, vram_total: 24560, ...over });
// monitor.py on the two-XTX machine (2026-10-12), deliberately listed second card first: order comes from the PCI address
const TWO_STATS = { hosts: STATS.hosts, gpus: [amd({ index: 1, pci: '0e:00.0', gpu_temp: 71, fan_rpm: 1450, fan_pct: 48, mem_temp: 84 }), amd({ index: 0, pci: '0b:00.0', gpu_temp: 48, fan_rpm: 0, fan_pct: 0, mem_temp: 54 })] };

test('two identical cards: labels by PCI order, and a launch on the second card reads the SECOND card', () => {
    const t = topo.build({ detected: TWO_XTX });
    assert.deepEqual(T.labelGpus(TWO_STATS, t).map((x) => [x.gpu.pci, x.label, x.card.key]), [
        ['0e:00.0', 'RX 7900 XTX #2', 'amd radeon rx 7900 xtx#2'], ['0b:00.0', 'RX 7900 XTX #1', 'amd radeon rx 7900 xtx#1']]);
    // ROCm1 alone: by name this used to be the first unclaimed XTX reading, i.e. card #1's temperature
    const second = T.mapDevicesToGpus(D.planDevices({ devices: [{ id: 'ROCm1', name: XTX }] }, {}), TWO_STATS, TWO_XTX, t);
    assert.equal(second[0].gpu.pci, '0e:00.0');
    const rec = T.deviceRecord(second[0]);
    assert.deepEqual([rec.label, rec.pci, rec.temp, rec.mem_temp, rec.fan_rpm, rec.fan_pct], ['RX 7900 XTX #2', '0e:00.0', 71, 84, 1450, 48]);
    // the same card through the other backend
    assert.equal(T.mapDevicesToGpus(D.planDevices({ devices: [{ id: 'Vulkan1' }] }, {}), TWO_STATS, TWO_XTX, t)[0].gpu.pci, '0e:00.0');
    // both cards, second listed first: each device keeps its own reading and its own label (one chart line each)
    const both = T.mapDevicesToGpus(D.planDevices({ devices: [{ id: 'ROCm1', name: XTX, share: 50 }, { id: 'ROCm0', name: XTX, share: 50 }] }, {}), TWO_STATS, TWO_XTX, t);
    assert.deepEqual(both.map((m) => T.deviceRecord(m)).map((r) => [r.id, r.label, r.pci]), [['ROCm1', 'RX 7900 XTX #2', '0e:00.0'], ['ROCm0', 'RX 7900 XTX #1', '0b:00.0']]);
    assert.deepEqual(both.map((m) => T.sampleFromRecord(T.deviceRecord(m)).label), ['RX 7900 XTX #2', 'RX 7900 XTX #1']);
    // a zero-RPM fan is a reading (0), not a missing one
    assert.equal(T.deviceRecord(both[1]).fan_rpm, 0);
});

test('labelGpus on other machines: one card, mixed vendors, no GPU, no topology, a worker host', () => {
    const one = topo.build({ detected: [det('CUDA0', 'NVIDIA GeForce RTX 4090', 24564), det('Vulkan0', 'NVIDIA GeForce RTX 4090', 24564)] });
    assert.deepEqual(T.labelGpus({ gpus: [gpu({ pci: '01:00.0', gpu_name: 'NVIDIA GeForce RTX 4090' })] }, one).map((x) => x.label), ['RTX 4090']);
    const mixed = topo.build({ detected: [det('CUDA0', 'NVIDIA GeForce RTX 3060', 12288), det('ROCm0', XTX, 24560), det('Vulkan0', 'NVIDIA GeForce RTX 3060', 12288), det('Vulkan1', XTXV, 24560)] });
    assert.deepEqual(T.labelGpus(STATS, mixed).map((x) => [x.label, x.card ? x.card.label : null]),
        [['RTX 3060', 'RTX 3060'], ['RX 7900 XTX', 'RX 7900 XTX'], ['RTX 4090 Laptop', null]]);   // the worker's card is not one of this machine's
    assert.deepEqual(T.labelGpus({ gpus: [] }, topo.build({ detected: [] })), []);
    assert.deepEqual(T.labelGpus(null, null), []);
    // no topology (the device probe has not answered): identical readings are still told apart, by PCI order
    assert.deepEqual(T.labelGpus(TWO_STATS, null).map((x) => [x.gpu.pci, x.label, x.card]), [['0e:00.0', 'RX 7900 XTX #2', null], ['0b:00.0', 'RX 7900 XTX #1', null]]);
    // a card the build does not list (an iGPU llama.cpp skipped) keeps its own name
    assert.deepEqual(T.labelGpus({ gpus: [gpu({ pci: '00:02.0', gpu_name: 'Intel(R) UHD Graphics 770' }), gpu({ pci: '01:00.0', gpu_name: 'NVIDIA GeForce RTX 4090' })] }, one).map((x) => x.label), ['UHD 770', 'RTX 4090']);
    // without a topology the old name matching still works, and still hands each identical reading out once
    const twins = T.mapDevicesToGpus(D.planDevices({ devices: [{ id: 'ROCm0', name: XTX }, { id: 'ROCm1', name: XTX }] }, {}), TWO_STATS, TWO_XTX);
    assert.notEqual(twins[0].gpu, twins[1].gpu);
});
