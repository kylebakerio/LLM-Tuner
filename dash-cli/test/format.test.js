import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fmt, toGB, pad, pctColor, throttleBadges, fmtUptime, portFromCommand } from '../src/format.js';

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
