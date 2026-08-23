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

test('throttleBadges', () => {
  assert.equal(throttleBadges([]), '');
  assert.equal(throttleBadges(null), '');
  assert.match(throttleBadges(['sw_power_cap']), /PWR-CAP/);
  assert.match(throttleBadges(['weird_reason']), /WEIRD_REASON/);
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
