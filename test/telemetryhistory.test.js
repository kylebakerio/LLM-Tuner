const test = require('node:test');
const assert = require('node:assert');
const { createTelemetryHistory } = require('../lib/telemetryhistory');

const reading = (temp, opts = {}) => ({
    gpus: [
        { host: 'local', pci: '09:00.0', gpu_name: 'NVIDIA GeForce RTX 3060', gpu_util: 99, gpu_pwr: 160, gpu_temp: temp, vram_used: 11264 },
        ...(opts.noXtx ? [] : [{ host: 'local', pci: '0c:00.0', gpu_name: 'AMD Radeon RX 7900 XTX', gpu_util: 50, gpu_pwr: 300, gpu_temp: temp + 5, vram_used: 24576 }]),
    ],
    hosts: { local: { cpu_util: 25, cpu_temp: 40, net_bytes: opts.net ?? 0 } },
});

test('telemetry history: raw window, a GPU missing from one tick is a gap, not a zero', () => {
    const h = createTelemetryHistory({ capacity: 100 });
    h.push(reading(60), {}, 1000);
    h.push(reading(61, { noXtx: true }), {}, 2000);   // amdgpu_top timed out this tick
    h.push(reading(62), {}, 3000);
    const r = h.range({ from: 0, to: 5000, field: 'temp' });
    assert.deepStrictEqual(r.t, [1000, 2000, 3000]);
    assert.strictEqual(r.downsampled, false);
    const xtx = r.series.find((s) => /7900/.test(s.name));
    assert.deepStrictEqual(xtx.data, [65, null, 67]);
    assert.deepStrictEqual(r.extent, { first: 1000, last: 3000 });
});

test('telemetry history: ring drops the oldest; net MB/s from byte deltas; tps only when given', () => {
    const h = createTelemetryHistory({ capacity: 3 });
    for (let i = 0; i < 5; i++) h.push(reading(60 + i, { net: i * 1048576 }), i === 4 ? { genTps: 42 } : {}, (i + 1) * 1000);
    assert.strictEqual(h.size, 3);
    const net = h.range({ from: 0, to: 1e9, field: 'net' });
    assert.deepStrictEqual(net.t, [3000, 4000, 5000]);
    assert.deepStrictEqual(net.series[0].data, [1, 1, 1]);
    const tps = h.range({ from: 0, to: 1e9, field: 'tps' });
    assert.deepStrictEqual(tps.series[0].data, [null, null, 42]);
});

test('telemetry history: over `max`, equal time buckets of means', () => {
    const h = createTelemetryHistory({ capacity: 1000 });
    for (let i = 0; i < 100; i++) h.push(reading(i), {}, i * 1000);
    const r = h.range({ from: 0, to: 99999, max: 10, field: 'temp' });
    assert.strictEqual(r.downsampled, true);
    assert.strictEqual(r.bucketMs, 10000);
    assert.strictEqual(r.t.length, 10);
    const g = r.series.find((s) => /3060/.test(s.name));
    assert.strictEqual(g.data[0], 4.5);     // mean of 0..9
    assert.strictEqual(g.data[9], 94.5);
});

test('telemetry history: samples older than the retention age out', () => {
    const h = createTelemetryHistory({ capacity: 100, retentionMs: 10000 });
    for (let i = 0; i < 30; i++) h.push(reading(60), {}, i * 1000);
    assert.deepStrictEqual(h.extent(), { first: 19000, last: 29000 });
});

// 2026-10-06: every busy server (queue lane) gets its own generation / prompt-read columns, so Monitor and the
// telemetry charts read one history.
test('lanes: one gen and one prefill column per server, valued only in that phase', () => {
    const { createTelemetryHistory } = require('../lib/telemetryhistory');
    const h = createTelemetryHistory({ capacity: 16 });
    const stats = { gpus: [{ host: 'local', pci: '0c:00.0', gpu_name: 'XTX', gpu_util: 90, gpu_pwr: 300, gpu_temp: 70, vram_used: 2048 }] };
    h.push(stats, { lanes: [{ lane: 'local-gpu', label: '7900 XTX Strata', phase: 'gen', gen: 61.5, prefill: 0 },
        { lane: 'local-3060', label: 'RTX 3060 llama.cpp', phase: 'prefill', gen: 0, prefill: 350 }] }, 1000);
    h.push(stats, { lanes: [{ lane: 'local-gpu', label: '7900 XTX Strata', phase: 'busy', gen: 0, prefill: 0 }] }, 2000);
    const r = h.range({ from: 0, to: 3000 });
    const col = (k) => r.series.find((s) => s.key === k);
    assert.deepStrictEqual(col('lane:local-gpu:gen').data, [61.5, null]);
    assert.deepStrictEqual(col('lane:local-gpu:prefill').data, [null, null]);
    assert.deepStrictEqual(col('lane:local-3060:prefill').data, [350, null]);   // absent at the second tick: a gap, not a zero
    assert.strictEqual(col('lane:local-3060:gen').name, 'RTX 3060 llama.cpp');
    assert.strictEqual(col('lane:local-gpu:gen').kind, 'lane');
});

test('two identical cards are two series, each with its own label (the PCI address keys the column)', () => {
    const h = createTelemetryHistory({ capacity: 8 });
    const xtx = (pci, label, temp) => ({ host: 'local', index: 0, pci, gpu_name: 'AMD Radeon RX 7900 XTX', label, gpu_util: 1, gpu_pwr: 10, gpu_temp: temp, vram_used: 1024 });
    h.push({ hosts: {}, gpus: [xtx('0b:00.0', 'RX 7900 XTX #1', 48), xtx('0e:00.0', 'RX 7900 XTX #2', 42)] }, {}, 1000);
    const temps = h.range({ from: 0, to: 2000, field: 'temp' }).series;
    assert.deepStrictEqual(temps.map((s) => [s.id, s.name, s.label, s.data]), [
        ['local|0b:00.0', 'AMD Radeon RX 7900 XTX', 'RX 7900 XTX #1', [48]], ['local|0e:00.0', 'AMD Radeon RX 7900 XTX', 'RX 7900 XTX #2', [42]]]);
    // an older reading without a label still records (label null): the client numbers such series itself
    const old = createTelemetryHistory({ capacity: 8 });
    old.push({ hosts: {}, gpus: [{ host: 'local', pci: '09:00.0', gpu_name: 'NVIDIA GeForce RTX 3060', gpu_temp: 50 }] }, {}, 1000);
    assert.strictEqual(old.range({ from: 0, to: 2000, field: 'temp' }).series[0].label, null);
});

// 2026-10-27 (Kyle: "clicking to zoom on the t/s chart is broken"): with queue lanes busy the Tokens/sec chart had only
// genTps, null or a flat 0 under Strata on :8080. Generation is now the lanes' sum; prefill a reading per changed rate.
test('telemetry history: tps generation is the busy lanes\' sum; prefill readings only when a rate changes', () => {
    const h = createTelemetryHistory({ capacity: 100 });
    const lane = (id, phase, gen, prefill) => ({ lane: id, label: id, phase, gen, prefill });
    h.push(reading(60), { genTps: 0, lanes: [lane('a', 'gen', 50, 700), lane('b', 'prefill', 0, 300)] }, 1000);   // both new
    h.push(reading(60), { genTps: 0, lanes: [lane('a', 'gen', 52, 700), lane('b', 'prefill', 0, 300)] }, 2000);   // nothing new
    h.push(reading(60), { genTps: 0, lanes: [lane('a', 'busy', 0, 700), lane('b', 'gen', 40, 320)] }, 3000);      // b's next read
    h.push(reading(60), { genTps: 0, lanes: [lane('b', 'gen', 41, 320)] }, 4000);                                 // a went idle
    h.push(reading(60), { genTps: 0, lanes: [lane('a', 'prefill', 0, 700), lane('b', 'gen', 41, 320)] }, 5000);   // a back, same rate
    h.push(reading(60), { genTps: 33 }, 6000);                                                                    // no lanes: genTps
    const r = h.range({ from: 0, to: 1e9, field: 'tps' });
    const gen = r.series.find((s) => s.id === 'tps'), pre = r.series.find((s) => s.id === 'prefill');
    assert.deepStrictEqual(gen.data, [50, 52, 40, 41, 41, 33]);
    assert.deepStrictEqual(pre.data, [500, null, 320, null, 700, null]);
    assert.strictEqual(pre.kind, 'tps');
});

test('telemetry history: the dashboard\'s own server\'s prefill rate is a reading too', () => {
    const h = createTelemetryHistory({ capacity: 100 });
    h.push(reading(60), { genTps: null, prefillTps: 900 }, 1000);
    h.push(reading(60), { genTps: 12, prefillTps: 900 }, 2000);
    h.push(reading(60), { genTps: 12, prefillTps: null }, 3000);
    const pre = h.range({ from: 0, to: 1e9, field: 'tps' }).series.find((s) => s.id === 'prefill');
    assert.deepStrictEqual(pre.data, [900, null, null]);
});
