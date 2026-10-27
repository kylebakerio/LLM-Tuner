import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import {
  STRATA_FIELDS, STRATA_PROFILE_KEYS, strataDraft, strataDraftToConfig, commitStrataField, displayStrataValue, installLine, baseItems,
} from '../src/strataform.js';
import { STRATA_OVERRIDE_KEYS, strataLaunchConfig } from '../src/launchplan.js';

const require = createRequire(import.meta.url);

test('the CLI sends exactly the override keys the server merges (lib/strata.js OVERRIDE_KEYS)', () => {
  const server = require('../../lib/strata.js');
  assert.deepEqual(STRATA_OVERRIDE_KEYS, server.OVERRIDE_KEYS);
  // every server key has an editor field (sampling under the profile names temp / topK / topP)
  const asProfile = server.OVERRIDE_KEYS.map((k) => (k === 'temperature' ? 'temp' : k));
  assert.deepEqual([...STRATA_PROFILE_KEYS].sort(), [...asProfile].sort());
  assert.equal(STRATA_FIELDS[0][0], 'strataBase');
});

test('strataDraft / strataDraftToConfig: round trip keeps the profile\'s own keys, drops rawCommand and blanks', () => {
  const cfg = { engine: 'strata', strataBase: '/s/a.json', rawCommand: '/s/queue-serve.sh /s/a.json', temperature: 0.6, topK: 20, gpu: [0, 1], kv: 'f16', tuningNote: 'n', needs: { minCards: 2 }, pipelineWindows: 0 };
  const d = strataDraft(cfg);
  assert.equal(d.temp, '0.6', 'temperature (web) is read as temp');
  assert.equal(d.gpu, '0,1');
  assert.equal(d.kv, 'fp16', 'the old f16 is the engine\'s fp16');
  assert.equal(d.pipelineWindows, '0', '0 is a value, not blank');
  assert.equal(d.spec, null);
  const out = strataDraftToConfig({ ...d, spec: '3', topK: null }, cfg);
  assert.deepEqual(out, { engine: 'strata', strataBase: '/s/a.json', temp: 0.6, gpu: '0,1', kv: 'fp16', tuningNote: 'n', needs: { minCards: 2 }, pipelineWindows: 0, spec: 3 });
  // and what a launch of it sends
  assert.deepEqual(strataLaunchConfig(out), { engine: 'strata', strataBase: '/s/a.json', kv: 'fp16', spec: 3, pipelineWindows: 0, gpu: '0,1', temperature: 0.6 });
});

test('commitStrataField: numbers in range, card lists, the layer split rule, fixed choices', () => {
  assert.deepEqual(commitStrataField('spec', ' 3 '), { value: '3' });
  assert.deepEqual(commitStrataField('spec', ''), { value: null });
  assert.match(commitStrataField('spec', '2.5').error, /whole number/);
  assert.deepEqual(commitStrataField('specMinP', '0.7'), { value: '0.7' });
  assert.match(commitStrataField('specMinP', '1.5').error, /from 0 to 1/);
  assert.deepEqual(commitStrataField('residentBudgetGib', '40'), { value: '40' });
  assert.deepEqual(commitStrataField('gpu', '0, 1,1'), { value: '0,1' });
  assert.match(commitStrataField('gpu', 'ROCm0').error, /card numbers/);
  assert.deepEqual(commitStrataField('layerSplit', 'AUTO'), { value: 'auto' });
  assert.deepEqual(commitStrataField('layerSplit', '16, 32'), { value: '16,32' });
  for (const bad of ['1', '32,16', '24,24', 'x']) assert.match(commitStrataField('layerSplit', bad).error, /rising from 2/);
  assert.deepEqual(commitStrataField('pipelineWindows', '2'), { value: '2' });
  assert.match(commitStrataField('pipelineWindows', '3').error, /one of 0, 1, 2/);
  assert.match(commitStrataField('kv', 'f16').error, /int8, fp16, q4_0, k8v4/);
});

test('displayStrataValue / installLine / baseItems: base values, the install and its THP-off launcher', () => {
  const entry = { path: '/n/strata-x.json', name: 'strata-x.json', maxContext: '262144', install: '/n', version: '0.1.44.1', settings: { spec: 3, kv: 'int8', stageTrim: 'on', temperature: 1 } };
  const installs = [{ dir: '/n', label: 'Strata 0.1.44.1 (current)', thpOff: true }, { dir: '/o', label: 'Strata 0.1.43.1', thpOff: false }];
  assert.deepEqual(displayStrataValue({ spec: null }, 'spec', entry), { text: 'base: 3', set: false });
  assert.deepEqual(displayStrataValue({ temp: null }, 'temp', entry), { text: 'base: 1', set: false });
  assert.deepEqual(displayStrataValue({ stageTrim: 'off' }, 'stageTrim', entry), { text: 'off — not set', set: true });
  assert.deepEqual(displayStrataValue({ strataBase: '/n/strata-x.json' }, 'strataBase', entry), { text: 'x  (Strata 0.1.44.1)', set: true, missing: false });
  assert.equal(displayStrataValue({ strataBase: '/z/strata-y.json' }, 'strataBase', null).missing, true);
  assert.equal(installLine(entry, installs), 'Strata 0.1.44.1 (current) — launcher runs the server with THP off');
  assert.equal(installLine({ ...entry, install: '/o' }, installs), 'Strata 0.1.43.1 — launcher leaves THP on · not the current install');
  assert.deepEqual(baseItems([entry], installs), [{ label: 'x', hint: 'Strata 0.1.44.1 (current) · 262k', value: '/n/strata-x.json' }]);
  assert.equal(baseItems([entry], installs, '/gone.json')[0].hint, '(current — not listed by the dashboard)');
});
