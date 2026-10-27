'use strict';
// ui/shared/modelname.js: the one model display-name helper (browser, server, dash-cli), and the
// model / mmproj / draft / other split that keeps non-models out of the launch lists.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const MN = require('../ui/shared/modelname.js');

const SPLIT = '/data/models/Qwen3.8-Flash-Next/UD-Q2_K_XL/Qwen3.8-Flash-Next-UD-Q2_K_XL-00001-of-00003.gguf';

test('modelName: basename without the split suffix, .gguf kept unless asked', () => {
    assert.equal(MN.modelName(SPLIT), 'Qwen3.8-Flash-Next-UD-Q2_K_XL.gguf');
    assert.equal(MN.modelName(SPLIT, { ext: false }), 'Qwen3.8-Flash-Next-UD-Q2_K_XL');
    // what the request log stores (model_name = the part-1 basename) and the SSE `model`
    assert.equal(MN.modelName('Qwen3.8-Flash-Next-UD-IQ4_XS-00001-of-00003.gguf'), 'Qwen3.8-Flash-Next-UD-IQ4_XS.gguf');
    assert.equal(MN.modelName('Qwen3.8-Flash-Next-UD-IQ4_XS-00001-of-00003'), 'Qwen3.8-Flash-Next-UD-IQ4_XS');
    // everything else unchanged
    assert.equal(MN.modelName('/m/Qwen3.8-27B-UD-Q4_K_XL.gguf'), 'Qwen3.8-27B-UD-Q4_K_XL.gguf');
    assert.equal(MN.modelName('Qwen3.8-Flash-Next-UD-Q2_K_XL'), 'Qwen3.8-Flash-Next-UD-Q2_K_XL');
    assert.equal(MN.modelName('C:\\m\\X-00002-of-00002.gguf'), 'X.gguf');
    assert.equal(MN.modelName(''), '');
    assert.equal(MN.modelName(null), '');
    assert.equal(MN.stripSplit('X-00001-of-00003.gguf'), 'X.gguf');
});

test('stripSplitIn: every split suffix inside a label, nothing else', () => {
    assert.equal(MN.stripSplitIn('custom: CUDA0 Qwen3.8-Flash-Next-UD-Q2_K_XL-00001-of-00003 fa=0'), 'custom: CUDA0 Qwen3.8-Flash-Next-UD-Q2_K_XL fa=0');
    assert.equal(MN.stripSplitIn('A-00001-of-00003.gguf — B-00001-of-00002 (x)'), 'A.gguf — B (x)');
    assert.equal(MN.stripSplitIn('run-00001-of-x'), 'run-00001-of-x');
    assert.equal(MN.stripSplitIn('flash-q2kxl-64k'), 'flash-q2kxl-64k');
    assert.equal(MN.stripSplitIn(undefined), '');
});

test('modelFileKind: every .gguf on the rig classified', () => {
    const cases = {
        // models (a full model with MTP layers baked in is still a model)
        '/data/models/Ornith-1.5-35B-A3B/Ornith-1.5-35B-Q4_K_M.gguf': 'model',
        '/data/models/Ornith-1.5-35B-A3B-MTP/Ornith-1.5-35B-A3B-APEX-MTP-I-Quality.gguf': 'model',
        '/m/Qwen3.8-27b-Terse-Coder.Q4_K_M.gguf': 'model',
        '/data/models/Bonsai2-27B/Ternary-Bonsai-2-27B-PTQ1_0.gguf': 'model',
        [SPLIT]: 'model',
        // projectors
        '/m/qwen-3.8-mmproj-F16.gguf': 'mmproj',
        '/hub/models--unsloth--Qwen3.8-27B-GGUF/snapshots/r/mmproj-F16.gguf': 'mmproj',
        // speculative-decoding drafts
        '/m/mtp-Qwen3.8-Flash-Next-Q8_0.gguf': 'draft',
        '/data/models/Gemma4-31B/MTP/mtp-gemma-4-31B-it-Q8_0.gguf': 'draft',
        '/lexar/mtp-Qwen3.8-Flash-Next-shared-BF16.gguf': 'draft',
        '/m/Qwen3.8-27B-DSpark-Q8_0.gguf': 'draft',
        '/m/Qwen3-0.6B-draft-Q8_0.gguf': 'draft',
        // not weights
        '/m/qwen-3.8-unsloth-3.0-chat-template.gguf': 'other',
        '/llama.cpp/models/ggml-vocab-qwen35.gguf': 'other',
    };
    for (const [p, kind] of Object.entries(cases)) assert.equal(MN.modelFileKind(p), kind, p);
    // by size: a tiny file is not a model; a split model is judged on ALL its parts
    assert.equal(MN.modelFileKind('/m/something.gguf', 9994), 'other');
    assert.equal(MN.modelFileKind(SPLIT, 78869128864), 'model');
    assert.equal(MN.modelFileKind(SPLIT, 10946624), 'other', 'part 1 alone (~11 MB) would read as a non-model');
    assert.equal(MN.modelFileKind('/m/qwen2.5-coder-7b-instruct-q4_k_m.gguf', 4683073536), 'model');
});

test('one helper everywhere: the global, util.js re-exports and dash-cli are the same functions', async () => {
    assert.equal(globalThis.ModelName, MN, 'the classic script sets globalThis.ModelName under Node too');
    const U = await import('../ui/benchmarks/util.js');
    assert.equal(U.modelName, MN.modelName);
    assert.equal(U.stripSplitIn, MN.stripSplitIn);
    const F = await import('../dash-cli/src/format.js');
    assert.equal(F.modelName(SPLIT), 'Qwen3.8-Flash-Next-UD-Q2_K_XL.gguf');
    assert.equal(F.isLaunchableModel({ path: '/m/mtp-x-Q8_0.gguf' }), false);
    assert.equal(F.isLaunchableModel({ path: SPLIT, kind: 'model' }), true);
    assert.equal(F.isLaunchableModel({ path: '/m/x.gguf', kind: 'mmproj' }), false, 'the server\'s kind wins');
    // server-side names: lib/modelscan.js's name and lib/tps.js's key
    const S = require('../lib/modelscan');
    assert.equal(S.displayName(path.basename(SPLIT)), 'Qwen3.8-Flash-Next-UD-Q2_K_XL.gguf');
});

test('Bench config line shows a split model without its suffix (the Live view uses it too)', async () => {
    const U = await import('../ui/benchmarks/util.js');
    const html = U.configLine({}, { model_path: SPLIT });
    assert.ok(html.includes('>Qwen3.8-Flash-Next-UD-Q2_K_XL.gguf<'), html);
    assert.ok(html.includes(`title="${SPLIT}"`), 'the full path stays in the tooltip');
});

test('the page loads the helper before script.js, and script.js routes its model names through it', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf-8');
    const at = (s) => html.indexOf(s);
    assert.ok(at('src="./ui/shared/modelname.js"') > 0 && at('src="./ui/shared/modelname.js"') < at('src="./script.js"'));
    const js = fs.readFileSync(path.join(__dirname, '..', 'script.js'), 'utf-8');
    // the display sites that drew a name from a file name themselves
    assert.ok(!/modelPath \|\| ''\)\.split\('\/'\)\.pop\(\)/.test(js), 'no model name taken straight from a path basename');
    assert.ok(js.includes('MN.modelName(r.model)'), 'Monitor / History request rows');
    assert.ok(js.includes('MN.modelName(s.model)'), 'History session headers');
    assert.ok(js.includes('filter(isLaunchableModel)'), 'the model lists offer models only');
});
