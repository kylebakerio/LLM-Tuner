import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmt, toGB, pad, pctColor, throttleBadges, fmtUptime, portFromCommand, clipLabel, thermalParts, thermalLine, telemetryPanels } from '../src/format.js';

test('fmt', () => {
  assert.equal(fmt(null), '--');
  assert.equal(fmt(452.123, ' t/s', 1), '452.1 t/s');
  assert.equal(fmt(0), '0');
  assert.equal(fmt('abc'), 'abc');
  assert.equal(fmt(NaN), '--');
});

test('toGB / pad / pctColor', () => {
  assert.equal(toGB(1024), '1.0');
  assert.equal(toGB(null), '--');
  assert.equal(pad('ab', 5), 'ab   ');
  assert.equal(pad('abcdef', 3), 'abcdef');
  assert.equal(pctColor(0.5), 'green');
  assert.equal(pctColor(0.75), 'yellow');
  assert.equal(pctColor(0.95), 'red');
});

test('throttleBadges (dashboard-accurate, per isRealThermal lessons)', () => {
  const segs = (d) => throttleBadges(d).segments;
  // sw_power_cap: permanently-active firmware cap (80W on this rig) --
  // informational only, never an alarm.
  assert.deepEqual(segs({ throttle_reasons: ['sw_power_cap'], gpu_temp: 63 }),
    [{ label: 'pwr-cap', level: 'info' }]);
  // sw_thermal_slowdown at a cool reading means "clocks below max", not
  // "too hot" -- ignored (it fires all through model load at 40-52C).
  assert.deepEqual(segs({ throttle_reasons: ['sw_thermal_slowdown'], gpu_temp: 50 }), []);
  // ...but trusted when the card is actually hot.
  assert.deepEqual(segs({ throttle_reasons: ['sw_thermal_slowdown'], gpu_temp: 78 }),
    [{ label: 'SW-THERM', level: 'real' }]);
  // hw_thermal is hardware protection -- authoritative regardless of temp.
  assert.deepEqual(segs({ throttle_reasons: ['hw_thermal_slowdown'], gpu_temp: 41 }),
    [{ label: 'THERM', level: 'real' }]);
  // A power brake is a real (non-thermal) limit.
  assert.deepEqual(segs({ throttle_reasons: ['hw_power_brake_slowdown'], gpu_temp: 40 }),
    [{ label: 'PWR-BRAKE', level: 'warn' }]);
  assert.deepEqual(segs({ throttle_reasons: [], gpu_temp: 63 }), []);
  assert.deepEqual(segs(null), []);
  // maxWidth drops the lowest priority first -- and never hides a real thermal.
  assert.deepEqual(
    throttleBadges({ throttle_reasons: ['hw_thermal_slowdown', 'sw_power_cap'], gpu_temp: 80 }, 6).segments.map((s) => s.label),
    ['THERM']);
  assert.deepEqual(
    throttleBadges({ throttle_reasons: ['hw_thermal_slowdown'], gpu_temp: 80 }, 2).segments.map((s) => s.label),
    ['THERM']);
});

test('fmtUptime', () => {
  assert.equal(fmtUptime(0), '--:--:--');
  assert.equal(fmtUptime(61_500), '00:01:01');
  assert.equal(fmtUptime(3_723_000), '01:02:03');
});

test('portFromCommand', () => {
  assert.equal(portFromCommand('/x/llama-server --port 8080 -m y'), 8080);
  assert.equal(portFromCommand('/x/llama-server --port 9999'), 9999);
  assert.equal(portFromCommand('no port here'), 8080);
  assert.equal(portFromCommand(null, 1234), 1234);
});

test('clipLabel: a cut card label keeps the ordinal that tells identical cards apart', () => {
  assert.equal(clipLabel('RX 7900 XTX #2', 14), 'RX 7900 XTX #2', 'fits: untouched');
  // the plain cut both cards used to get: "RX 7900 XT…" twice
  assert.equal(clipLabel('RX 7900 XTX #1', 11), 'RX 7900… #1');
  assert.equal(clipLabel('RX 7900 XTX #2', 11), 'RX 7900… #2');
  assert.notEqual(clipLabel('RX 7900 XTX #1', 8), clipLabel('RX 7900 XTX #2', 8), 'still two different cards at 8 columns');
  assert.equal(clipLabel('RX 7900 XTX #12', 9), 'RX 7… #12', 'a two-digit ordinal is kept whole');
  // what follows the ordinal gives way before the name does
  assert.equal(clipLabel('RX 7900 XTX #2 · ROCm1 50%', 20), 'RX 7900 XTX #2 · RO…');
  assert.equal(clipLabel('RX 7900 XTX #2 · ROCm1 50%', 15), 'RX 7900 XTX #2…');
  assert.equal(clipLabel('RX 7900 XTX #2 alone', 12), 'RX 7900… #2');
  // no ordinal (a single card, a reason, a model name): the usual cut
  assert.equal(clipLabel('RTX 4090 Laptop', 10), 'RTX 4090 …');
  assert.equal(clipLabel('Needs RTX 3060.', 9), 'Needs RT…');
  // never longer than asked, down to nothing
  for (const w of [0, 1, 2, 3, 4, 5, 6, 7, 30]) assert.ok(clipLabel('RX 7900 XTX #2 alone', w).length <= w, `width ${w}`);
  assert.equal(clipLabel(null, 5), '');
});

test('thermalLine: temperature, then memory temperature and fan where the card has the sensor', () => {
  // AMD (monitor.py reads the card's own hwmon dir): all three
  const amd = { gpu_temp: 96.2, mem_temp: 102, fan_rpm: 2950, fan_pct: 86 };
  assert.equal(thermalLine(amd), '96°C · mem 102°C · fan 2950 rpm (86%)');
  // NVIDIA (nvidia-smi): fan percent only, no memory temperature -- nothing in their place
  const nv = { gpu_temp: 82, mem_temp: null, fan_rpm: null, fan_pct: 45 };
  assert.equal(thermalLine(nv), '82°C · fan 45%');
  assert.deepEqual(thermalParts(nv).map((p) => p.key), ['temp', 'fan']);
  // a card with neither, and telemetry from a server that sends neither field
  assert.equal(thermalLine({ gpu_temp: 50, mem_temp: null, fan_rpm: null, fan_pct: null }), '50°C');
  assert.equal(thermalLine({ gpu_temp: 50 }), '50°C');
  assert.doesNotMatch(thermalLine({ gpu_temp: 50 }), /--|fan|mem/);
  // a stopped fan is a reading, not a missing sensor
  assert.equal(thermalLine({ gpu_temp: 40, fan_rpm: 0, fan_pct: 0 }), '40°C · fan 0 rpm (0%)');
  // no reading at all
  assert.equal(thermalLine(null), '');
  assert.equal(thermalLine({}), '');
  // narrow panels: whole parts go, last first (the duty, the fan, the memory temperature); never a cut-off number
  assert.equal(thermalLine(amd, 31), '96°C · mem 102°C · fan 2950 rpm');
  assert.equal(thermalLine(amd, 30), '96°C · mem 102°C');
  assert.equal(thermalLine(amd, 15), '96°C');
  for (const w of [4, 12, 16, 22, 31, 37, 60]) assert.ok(thermalLine(amd, w).length <= w, `width ${w}`);
});

test('telemetryPanels: fan and memory temperature reach the panel from either telemetry shape', () => {
  const xtx = { host: 'local', index: 0, pci: '0b:00.0', vendor: 'amd', gpu_name: 'AMD Radeon RX 7900 XTX', gpu_util: 90, vram_used: 20000, vram_total: 24560,
    process_vram: 0, gpu_pwr: 320, gpu_temp: 96, mem_temp: 102, fan_rpm: 2950, fan_pct: 86, throttle_reasons: [], error: false };
  // no launch: the panel's gpu IS the stats.gpus entry
  const idle = telemetryPanels({ hosts: { local: {} }, gpus: [xtx], devices: [] });
  assert.equal(thermalLine(idle[0].gpu), '96°C · mem 102°C · fan 2950 rpm (86%)');
  // a launch device whose reading has no matching gpus entry: built from the per-device record
  const rec = { id: 'ROCm0', name: 'Some Other Name', host: 'local', util: 90, pwr: 320, temp: 96, mem_temp: 102, fan_rpm: 2950, fan_pct: 86, vram_used: 20000, vram_total: 24560 };
  const launch = telemetryPanels({ hosts: { local: {} }, gpus: [], devices: [rec] });
  assert.equal(thermalLine(launch[0].gpu), '96°C · mem 102°C · fan 2950 rpm (86%)');
  // an older server's record carries neither: just the temperature
  const old = telemetryPanels({ hosts: { local: {} }, gpus: [], devices: [{ id: 'CUDA0', name: 'X', host: 'local', util: 5, pwr: 30, temp: 44, vram_used: 1, vram_total: 2 }] });
  assert.equal(thermalLine(old[0].gpu), '44°C');
});
