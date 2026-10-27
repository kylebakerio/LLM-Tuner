'use strict';
// Request tables' relative colour ramp (ui/shared/relcolor.js), 2026-10-01, Kyle: continuous, relative
// per set, percentile-bounded, direction per column, neutral when nothing can be ranked.
const test = require('node:test');
const assert = require('node:assert/strict');
const R = require('../ui/shared/relcolor.js');

const hue = (css) => Number(/oklch\([\d.]+ [\d.]+ ([\d.]+)\)/.exec(css)[1]);

test('robustDomain uses the 5th..95th percentiles and ignores non-numbers', () => {
    const vals = Array.from({ length: 101 }, (_, i) => i);            // 0..100
    assert.deepEqual(R.robustDomain(vals), { lo: 5, hi: 95 });
    assert.deepEqual(R.robustDomain([null, undefined, '', NaN, 1, 3]), { lo: 1.1, hi: 2.9 });
    assert.equal(R.robustDomain([7]), null);
    assert.equal(R.robustDomain([4, 4, 4]), null);
    assert.equal(R.robustDomain([]), null);
});

test('one outlier does not flatten the rest', () => {
    const vals = [40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 3];
    const d = R.robustDomain(vals);
    assert.ok(hue(R.style(55, d)) - hue(R.style(45, d)) > 40, 'the 40s..50s still spread across the ramp');
    assert.equal(hue(R.style(3, d)), 25, 'the outlier clamps to the red end');
});

test('ramp is continuous and directional', () => {
    const d = { lo: 0, hi: 100 };
    assert.equal(hue(R.style(0, d, true)), 25);
    assert.equal(hue(R.style(100, d, true)), 145);
    assert.equal(hue(R.style(50, d, true)), 85);
    assert.equal(hue(R.style(0, d, false)), 145, 'lower-better: the minimum is green');
    const hs = [10, 20, 30, 40].map((v) => hue(R.style(v, d)));
    for (let i = 1; i < hs.length; i++) assert.ok(hs[i] > hs[i - 1], 'strictly increasing, no thresholds');
});

test('neutral when there is nothing to rank', () => {
    assert.equal(R.style(5, null), R.NEUTRAL);
    assert.equal(R.style(null, { lo: 0, hi: 1 }), R.NEUTRAL);
    assert.equal(R.style('x', { lo: 0, hi: 1 }), R.NEUTRAL);
});
