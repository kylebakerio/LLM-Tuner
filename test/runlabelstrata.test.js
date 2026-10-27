'use strict';
// 2026-10-20: a running Strata battery has no llama-server launch command; the Live card must name the engine instead of
// saying "launch flags not recorded".
const test = require('node:test');
const assert = require('node:assert');
const { describeRun } = require('../lib/runlabel');

test('describeRun: a Strata server record carries its engine, a llama.cpp one does not', () => {
    const strata = describeRun({ runner: 'opencode' }, { model_path: '/data/models/x/Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00004.gguf', build_info: 'Strata 0.1.44.1', n_ctx: '262144' }, { detected: null });
    assert.strictEqual(strata.engine, 'Strata 0.1.44.1');
    assert.strictEqual(strata.launchCommand, null);
    assert.strictEqual(strata.local, true);
    const llama = describeRun({ runner: 'opencode' }, { launch_command: '/x/llama-server -m /m/Qwen3.8-27B-UD-Q4_K_XL.gguf -c 131072 -dev ROCm0', build_info: 'b8000 (abc)' }, { detected: null });
    assert.strictEqual(llama.engine, null);
});
