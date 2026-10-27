'use strict';
// --- TELEMETRY: per-GPU readings -> launch devices ---
// monitor.py reports every GPU it can see, plus per-host CPU/RAM/net:
//
//   { hosts: { local: { cpu_name, cpu_util, cpu_temp, ram_used, ram_total, process_ram,
//                       net_bytes, net_by_interface, error }, laptop: {...} },
//     gpus:  [ { host, index, pci, vendor, gpu_name, vram_used, vram_total, process_vram,
//                gpu_pwr, gpu_temp, gpu_util, gpu_throttle, throttle_reasons, error,
//                mem_temp, fan_rpm, fan_pct (null where the card has no such sensor) } ] }
//
// GPU entries reuse the old per-node field names, so the legacy `master` /
// `worker` pair (still read by the CSV columns, History, the current charts
// and the CLI) is a merge of one GPU with its host. This module maps a
// launch's device plan onto the list and derives that pair. Pure; tested in
// test/telemetry.test.js.
const { gpuKey } = require('./devices');
const topologyModel = require('./topology');

const OFFLINE_NODE = {
    gpu_name: 'Offline', gpu_throttle: false, throttle_reasons: [],
    vram_used: 0, vram_total: 1, process_vram: 0, gpu_pwr: 0, gpu_temp: 0, gpu_util: 0,
    ram_used: 0, ram_total: 1, process_ram: 0, cpu_name: 'Offline', cpu_util: 0, cpu_temp: 0,
    net_bytes: 0, nvidia_smi_error: true,
};

// Which reading is which card, and what to call it. monitor.py reports GPUs per host with their PCI address;
// lib/topology.js numbers identical cards in llama.cpp's listing order. Nothing ties a PCI address to a llama.cpp id,
// so identical cards are paired BY ORDER: the k-th reading of a card model (by PCI address) is card #k -- the same
// assumption topology.js flags as `orderAssumed`. A GPU llama.cpp does not list (or any GPU when there is no topology)
// is numbered among the identical readings of its own host.
// -> [{ gpu, card (topology card or null), label }] in `stats.gpus` order; label "RX 7900 XTX #2", "RTX 4090 Laptop".
function labelGpus(stats, topology) {
    const gpus = (stats && stats.gpus) || [];
    const cards = (topology && topology.cards) || [];
    const groups = new Map();   // host|card model -> readings, by PCI address
    for (const g of gpus) {
        const k = `${g.host || 'local'}|${gpuKey(g.gpu_name)}`;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(g);
    }
    const out = new Map();
    for (const [k, list] of groups) {
        const sorted = list.slice().sort((a, b) => String(a.pci || '').localeCompare(String(b.pci || '')) || (a.index || 0) - (b.index || 0));
        const local = k.startsWith('local|');
        const same = local ? cards.filter((c) => gpuKey(c.name) === k.slice('local|'.length)).sort((a, b) => a.ordinal - b.ordinal) : [];
        sorted.forEach((g, i) => {
            const card = same[i] || null;
            const short = topologyModel.shortName(g.gpu_name) || 'GPU';
            out.set(g, { gpu: g, card, label: card ? card.label : (sorted.length > 1 ? `${short} #${i + 1}` : short) });
        });
    }
    return gpus.map((g) => out.get(g));
}

// For each planned device ({ id, name?, worker? } from planDevices), the GPU
// reading it runs on, or null. A local device is the reading of the physical
// card its id reaches (`topology`, lib/topology.js: ROCm1 is the SECOND of two
// identical cards -- matching by name alone gave a card-2 launch card 1's
// readings). Without a topology, or for an id it does not know, it falls back
// to the card name (the device's stored name, else the build's --list-devices
// description), each GPU claimed once. Worker devices take the worker host's
// GPUs in its -d order.
function mapDevicesToGpus(plan, stats, detected, topology) {
    const gpus = (stats && stats.gpus) || [];
    const descById = new Map((detected || []).map((d) => [d.id, d.description]));
    const labelled = labelGpus(stats, topology);
    const claimed = new Set();
    // devices whose card is known claim their reading first, so a name-matched device cannot take it
    const devices = (plan && plan.devices) || [];
    const byCard = devices.map((d) => {
        if (d.worker) return null;
        const card = topology ? topologyModel.cardOfId(topology, d.id) : null;
        const hit = card ? labelled.find((x) => x.card && x.card.key === card.key && !claimed.has(x.gpu)) : null;
        if (hit) claimed.add(hit.gpu);
        return hit || null;
    });
    return devices.map((d, i) => {
        let gpu = byCard[i] ? byCard[i].gpu : null;
        if (!gpu && d.worker) {
            const w = (plan.workers || []).find((x) => x.ref === d.worker);
            const onHost = w ? gpus.filter((g) => g.host === w.name) : [];
            gpu = onHost[d.workerDevice || 0] || null;
        } else if (!gpu) {
            const name = d.name || descById.get(d.id);
            if (name) {
                gpu = gpus.find((g) => g.host === 'local' && !claimed.has(g) && gpuKey(g.gpu_name) === gpuKey(name)) || null;
            }
        }
        if (gpu) claimed.add(gpu);
        const lab = gpu ? labelled.find((x) => x.gpu === gpu) : null;
        return { device: d, gpu, label: lab ? lab.label : null };
    });
}

// One GPU merged with its host's CPU/RAM/net, in the old node shape.
function nodeFor(stats, gpu) {
    if (!gpu) return null;
    const host = (stats.hosts && stats.hosts[gpu.host]) || {};
    const { host: _h, index: _i, pci: _p, vendor, error, ...gpuFields } = gpu;
    const node = { ...OFFLINE_NODE, ...host, ...gpuFields };
    delete node.error;
    delete node.nvidia_smi_error;
    node[vendor === 'amd' ? 'amdgpu_top_error' : 'nvidia_smi_error'] = !!error;
    return node;
}

// Legacy { master, worker }: the launch's first two mapped devices, or with no
// launch the two largest local GPUs (so bench charts still show both cards).
// `worker` is omitted when there's no second GPU, as monitor.py used to.
function legacyNodes(stats, mapping) {
    const gpus = (stats && stats.gpus) || [];
    const pair = mapping
        ? mapping.map((m) => m.gpu).filter(Boolean).slice(0, 2)
        : gpus.filter((g) => g.host === 'local').sort((a, b) => (b.vram_total || 0) - (a.vram_total || 0)).slice(0, 2);
    const local = (stats && stats.hosts && stats.hosts.local) || {};
    const out = { master: nodeFor(stats, pair[0]) || { ...OFFLINE_NODE, ...local } };
    if (pair[1]) out.worker = nodeFor(stats, pair[1]);
    return out;
}

// A REAL thermal limit, as opposed to what nvidia-smi's reason flags say.
// Measured on this rig: `sw_thermal_slowdown` asserts while the GPU is idle or
// at low clocks (it fires throughout model load at 40-52C and goes quiet under
// full compute at 60-63C) -- it means "clocks below max", not "too hot". Its
// matching lifetime counter is equally useless, ticking ~11s per 20s of wall
// time on a 50C idle GPU. So require corroboration from the actual
// temperature, and treat hw_thermal_slowdown (real hardware protection) as
// authoritative on its own.
const THERMAL_TEMP_FLOOR = 75; // C -- below this, ignore any sw thermal claim
function isRealThermal(dev) {
    const reasons = (dev && dev.throttle_reasons) || [];
    if (reasons.some((r) => /hw_thermal/i.test(String(r)))) return true;
    const temp = Number(dev && dev.gpu_temp);
    return reasons.some((r) => /thermal/i.test(String(r))) && Number.isFinite(temp) && temp >= THERMAL_TEMP_FLOOR;
}

// Short card label for charts and tables: "RTX 3060", "RX 7900 XTX",
// "RTX 4090 Laptop".
function shortGpuName(name) {
    return String(name || '')
        .replace(/\(.*?\)/g, ' ')
        .replace(/\b(NVIDIA|GeForce|AMD|Radeon|GPU)\b/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim() || String(name || '');
}

// Per-device reading for a launch device (VRAM in MB) -- what telemetry
// responses, CSV rows and completion records carry. `null` readings mean the
// device's GPU wasn't found in telemetry (e.g. the worker is unreachable).
// `label` tells identical cards apart ("RX 7900 XTX #2", from mapDevicesToGpus);
// `pci` lets a client pick the same reading out of `gpus` without re-matching
// by name. fan / mem_temp are null where monitor.py has no such sensor.
function deviceRecord({ device, gpu, label }) {
    const name = gpu ? gpu.gpu_name : (device.name || null);
    return {
        id: device.id,
        name,
        label: label || (name ? shortGpuName(name) : device.id),
        host: gpu ? gpu.host : (device.worker || 'local'),
        pci: gpu ? (gpu.pci ?? null) : null,
        share: device.share ?? null,
        util: gpu ? gpu.gpu_util : null,
        pwr: gpu ? gpu.gpu_pwr : null,
        temp: gpu ? gpu.gpu_temp : null,
        mem_temp: gpu ? (gpu.mem_temp ?? null) : null,
        fan_rpm: gpu ? (gpu.fan_rpm ?? null) : null,
        fan_pct: gpu ? (gpu.fan_pct ?? null) : null,
        vram_used: gpu ? gpu.vram_used : null,
        vram_total: gpu ? gpu.vram_total : null,
        thermal: gpu ? isRealThermal(gpu) : false,
    };
}

// The compact per-device part of one chart sample (VRAM in GB, like the
// legacy sample fields).
function sampleFromRecord(r) {
    return {
        id: r.id, label: r.label, host: r.host, util: r.util, pwr: r.pwr, temp: r.temp,
        vram: r.vram_used != null ? +(r.vram_used / 1024).toFixed(2) : null,
        thermal: r.thermal,
    };
}

module.exports = {
    OFFLINE_NODE, labelGpus, mapDevicesToGpus, legacyNodes, isRealThermal, shortGpuName, deviceRecord, sampleFromRecord,
};
