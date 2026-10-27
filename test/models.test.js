// lib/models.js -- identity, aggregation math, and loose BEST-CONFIGS parsing.
//
// The identity tests carry every real identifier shape found in the data on 2026-09-22
// (logs/benchmarks.csv model names, the 44 codebench battery dirs, the opencode entries,
// the claude/agy ids). The MUST-NOT-MERGE block is the important half: a silent merge of
// two models is the failure this module exists to prevent, and it is invisible in the UI.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const M = require('../lib/models.js');

// ---------------------------------------------------------------- gguf name splitting

test('splitGgufName: family and quant over every real gguf shape', () => {
    const cases = [
        ['Qwen3.8-27B-UD-Q6_K_XL.gguf', 'Qwen3.8-27B', 'Q6_K_XL'],
        ['Qwen3.8-27B-UD-Q3_K_XL.gguf', 'Qwen3.8-27B', 'Q3_K_XL'],
        ['Qwen3.8-27B-Q8_0.gguf', 'Qwen3.8-27B', 'Q8_0'],
        ['Qwen3.6-27B-IQ4_NL.gguf', 'Qwen3.6-27B', 'IQ4_NL'],
        ['Swift-Qwen3.8-27B-Q4_K_L.gguf', 'Swift-Qwen3.8-27B', 'Q4_K_L'],
        ['Huihui-Qwen3.8-27B-abliterated-UD-Q3_K_XL.gguf', 'Huihui-Qwen3.8-27B-abliterated', 'Q3_K_XL'],
        ['Ternary-Bonsai-2-27B-PTQ1_0.gguf', 'Ternary-Bonsai-2-27B', 'PTQ1_0'],
        ['qwen2.5-coder-7b-instruct-q4_k_m.gguf', 'qwen2.5-coder-7b-instruct', 'Q4_K_M'],
        ['gemma-4-12b-it-UD-Q8_K_XL.gguf', 'gemma-4-12b-it', 'Q8_K_XL'],
        // multi-part split files must lose the -00001-of-00003 suffix
        ['Qwen3.8-Flash-Next-UD-Q2_K_XL-00001-of-00003.gguf', 'Qwen3.8-Flash-Next', 'Q2_K_XL'],
        ['Qwen3.8-Flash-Next-UD-IQ1_S-00001-of-00003.gguf', 'Qwen3.8-Flash-Next', 'IQ1_S'],
        // full paths
        ['/home/kyle/AI/experiment-1/models/Qwen3.8-27B-UD-Q4_K_XL.gguf', 'Qwen3.8-27B', 'Q4_K_XL'],
    ];
    for (const [input, family, quant] of cases) {
        const got = M.splitGgufName(input);
        assert.strictEqual(got.family, family, `family of ${input}`);
        assert.strictEqual(got.quant, quant, `quant of ${input}`);
    }
});

test('splitGgufName: every part of a split gguf folds to the same key', () => {
    const a = M.canonicalModel('Qwen3.8-Flash-Next-UD-Q2_K_XL-00001-of-00003.gguf');
    const b = M.canonicalModel('Qwen3.8-Flash-Next-UD-Q2_K_XL-00003-of-00003.gguf');
    assert.strictEqual(a.key, b.key);
});

// ---------------------------------------------------------------- canonicalModel: merge

test('canonicalModel: the four identifier shapes for one local model agree', () => {
    const fromPath = M.canonicalModel('/home/kyle/AI/experiment-1/models/Qwen3.8-27B-UD-Q3_K_XL.gguf');
    const fromName = M.canonicalModel('Qwen3.8-27B-UD-Q3_K_XL.gguf');
    const fromOpencode = M.canonicalModel('llama-local/qwen38-27b-q3-64k');
    const fromBattery = M.canonicalModel({ runner: 'opencode', model: 'llama-local/qwen38-27b-q3-64k', dir: 't1-qwen38-27b-q3-64k' });
    const fromServer = M.canonicalModel({ runner: 'opencode', model: 'llama-local/qwen38-27b-q3-64k', model_path: '/x/Qwen3.8-27B-UD-Q3_K_XL.gguf', dir: 't1-27bq3-AUTO-genprogress' });
    for (const c of [fromName, fromOpencode, fromBattery, fromServer]) assert.strictEqual(c.key, fromPath.key);
    assert.strictEqual(fromPath.provider, 'local');
    assert.strictEqual(fromPath.quant, 'Q3_K_XL');
    assert.strictEqual(fromServer.via, 'model_path');
    assert.strictEqual(fromOpencode.via, 'alias');
});

test('canonicalModel: claude ids fold, short and long and dated', () => {
    const keys = ['haiku', 'claude-haiku-4-5', 'claude-haiku-4-5-20251001'].map((s) => M.canonicalModel(s).key);
    assert.deepStrictEqual(new Set(keys).size, 1);
    assert.strictEqual(keys[0], 'cloud:anthropic:claude-haiku-4-5');
    assert.strictEqual(M.canonicalModel('haiku').provider, 'cloud');
    assert.strictEqual(M.canonicalModel('haiku').vendor, 'anthropic');
    assert.strictEqual(M.canonicalModel('opus').key, 'cloud:anthropic:claude-opus-5');
    assert.strictEqual(M.canonicalModel('claude-opus-5[1m]').key, 'cloud:anthropic:claude-opus-5');
});

test('canonicalModel: an agy effort suffix is an axis, not a different model', () => {
    const lo = M.canonicalModel('gemini-3.8-flash-low');
    const hi = M.canonicalModel('gemini-3.8-flash-high');
    assert.strictEqual(lo.key, hi.key);
    assert.strictEqual(lo.key, 'cloud:google:gemini-3.8-flash');
    assert.strictEqual(lo.effort, 'low');
    assert.strictEqual(hi.effort, 'high');
});

test('canonicalModel: the claude runner with no --model is opus, and says so', () => {
    const c = M.canonicalModel({ runner: 'claude', model: null, dir: 'night-claude' });
    assert.strictEqual(c.key, 'cloud:anthropic:claude-opus-5');
    assert.strictEqual(c.via, 'runner_default');
    assert.match(c.heuristicNote, /BEST-CONFIGS/);
});

// ---------------------------------------------------------------- MUST NOT merge

test('canonicalModel: different quants of the same family are different models', () => {
    const q3 = M.canonicalModel('Qwen3.8-27B-UD-Q3_K_XL.gguf').key;
    const q4 = M.canonicalModel('Qwen3.8-27B-UD-Q4_K_XL.gguf').key;
    const q6 = M.canonicalModel('Qwen3.8-27B-UD-Q6_K_XL.gguf').key;
    assert.strictEqual(new Set([q3, q4, q6]).size, 3);
});

test('canonicalModel: finetunes never fold into their base model', () => {
    const base = M.canonicalModel('Qwen3.8-27B-UD-Q4_K_XL.gguf').key;
    const swift = M.canonicalModel('Swift-Qwen3.8-27B-Q4_K_L.gguf').key;
    const abl = M.canonicalModel('Huihui-Qwen3.8-27B-abliterated-UD-Q3_K_XL.gguf').key;
    assert.strictEqual(new Set([base, swift, abl]).size, 3);
});

test('canonicalModel: a reused opencode id does NOT resolve on its own', () => {
    // llama-local/qwen3.8-27b-q6 was never renamed: night-q4, night-q6, night-abliterated
    // and q4-262k-* all report it. On its own it must be flagged, not guessed.
    const bare = M.canonicalModel('llama-local/qwen3.8-27b-q6');
    assert.strictEqual(bare.ambiguous, true);
    assert.match(bare.ambiguousNote, /never renamed|reused|DIFFERENT/i);
    assert.match(bare.via, /ambiguous/);
});

test('canonicalModel: the battery-dir override disambiguates the reused ids', () => {
    const id = 'llama-local/qwen3.8-27b-q6';
    const q4 = M.canonicalModel({ runner: 'opencode', model: id, dir: 'night-q4' });
    const q6 = M.canonicalModel({ runner: 'opencode', model: id, dir: 'night-q6' });
    const abl = M.canonicalModel({ runner: 'opencode', model: id, dir: 'night-abliterated' });
    assert.notStrictEqual(q4.key, q6.key);
    assert.notStrictEqual(q4.key, abl.key);
    assert.strictEqual(q4.quant, 'Q4_K_XL');
    assert.strictEqual(q6.quant, 'Q6_K_XL');
    assert.strictEqual(abl.family, 'Huihui-Qwen3.8-27B-abliterated');
    for (const c of [q4, q6, abl]) assert.strictEqual(c.via, 'battery_override');
});

test('canonicalModel: flash-next 32k/64k/128k ids are context, not identity', () => {
    // Same id family, three different quants -- resolved only by the dir override.
    const iq1 = M.canonicalModel({ runner: 'opencode', model: 'llama-local/flash-next-32k', dir: 'flash-iq1s-32k' });
    const iq4 = M.canonicalModel({ runner: 'opencode', model: 'llama-local/flash-next-32k', dir: 'flash-iq4xs-32k' });
    const q3 = M.canonicalModel({ runner: 'opencode', model: 'llama-local/flash-next-32k', dir: 'flash-q3kxl-32k' });
    assert.strictEqual(new Set([iq1.key, iq4.key, q3.key]).size, 3);
    assert.strictEqual(iq1.quant, 'IQ1_S');
    // 128k and 32k of the SAME quant are one model (n_ctx is a config axis)
    const iq1_128 = M.canonicalModel({ runner: 'opencode', model: 'llama-local/flash-next-128k', dir: 'flash-iq1s-128k' });
    assert.strictEqual(iq1.key, iq1_128.key);
});

test('canonicalModel: an unknown dir for an ambiguous id falls back to the dir quant token, flagged', () => {
    const c = M.canonicalModel({ runner: 'opencode', model: 'llama-local/flash-next-64k', dir: 'flash-q2kxl-99k-brandnew' });
    assert.strictEqual(c.via, 'dir_heuristic');
    assert.strictEqual(c.quant, 'Q2_K_XL');
    assert.match(c.heuristicNote, /ambiguous/);
});

test('canonicalModel: a run with no model and no model_path is unresolved, never folded', () => {
    const c = M.canonicalModel({ runner: 'agy', model: null, dir: 'agy-20260919' });
    assert.strictEqual(c.unresolved, true);
    assert.match(c.key, /^unresolved:/);
    assert.notStrictEqual(c.key, M.canonicalModel('gemini-3.8-flash-low').key);
});

test('canonicalModel: a cloud model never collides with a local one', () => {
    assert.match(M.canonicalModel('haiku').key, /^cloud:/);
    assert.match(M.canonicalModel('Qwen3.8-27B-UD-Q6_K_XL.gguf').key, /^local:/);
});

test('canonicalModel: empty input is null, not a phantom model', () => {
    assert.strictEqual(M.canonicalModel(null), null);
    assert.strictEqual(M.canonicalModel(''), null);
    assert.strictEqual(M.canonicalModel('   '), null);
});

// ---------------------------------------------------------------- flag parsing

test('parseFlags: a real Flash-Next launch command', () => {
    const cmd = "/home/kyle/AI/llama-official/llama.cpp-u144/build-hip/bin/llama-server -m /models/Qwen3.8-Flash-Next-UD-Q2_K_XL-00001-of-00003.gguf -c 65536 -ngl 999 -fa on -np 1 --jinja --load-mode none -dev CUDA0,ROCm0 -ts 11,37 -ot 'blk.(21|22).ffn_(up|down)_exps=CUDA0' --cache-type-k q8_0 --cache-type-v q8_0 -ncmoe 30 -md /d/mtp.gguf --spec-type draft-mtp -devd ROCm0 --spec-draft-n-max 2";
    const f = M.parseFlags(cmd);
    assert.strictEqual(f.devices, 'CUDA0,ROCm0');
    assert.strictEqual(f.ts, '11,37');
    assert.strictEqual(f.ctx, 65536);
    assert.strictEqual(f.ngl, 999);
    assert.strictEqual(f.kvK, 'q8_0');
    assert.strictEqual(f.kvV, 'q8_0');
    assert.strictEqual(f.ncmoe, 30);
    assert.strictEqual(f.specType, 'draft-mtp');
    assert.strictEqual(f.specDraftN, 2);
    assert.strictEqual(f.draftDev, 'ROCm0');
    assert.strictEqual(f.fa, true);
    assert.strictEqual(f.buildDir, 'llama.cpp-u144/build-hip');
    assert.match(f.modelPath, /Q2_K_XL/);
    assert.match(f.ot, /ffn_/);
});

test('parseFlags: a quoted value reads the same as an unquoted one', () => {
    const a = M.parseFlags("llama-server -dev 'CUDA0,Vulkan0' -ts '11,37'");
    const b = M.parseFlags('llama-server -dev CUDA0,Vulkan0 -ts 11,37');
    assert.strictEqual(a.devices, b.devices);
    assert.strictEqual(M.configKey(a), M.configKey(b));
});

test('parseFlags: an empty command yields nulls, not throws', () => {
    const f = M.parseFlags('');
    assert.strictEqual(f.devices, null);
    assert.strictEqual(f.ctx, null);
    assert.strictEqual(M.configKey(f), 'unlabelled');
});

// ---------------------------------------------------------------- llama-bench transcript

test('parseLlamaBenchLog: pulls the model from -m, the depth from the test name', () => {
    const log = [
        '===== llama-bench 1/2: xtx-solo =====',
        '--- 2026-09-20 10:00:00 ---',
        '$ /b/bin/llama-bench -m /models/Qwen3.8-27B-UD-Q6_K_XL.gguf -p 8192 -n 128 -d 0,32768 -dev ROCm0',
        '| model | size | backend | ngl | test | t/s |',
        '| ----- | ---- | ------- | --- | ---- | --- |',
        '| qwen3 27B Q6_K | 20 GiB | ROCm | 99 | pp8192 | 704.90 ± 3.10 |',
        '| qwen3 27B Q6_K | 20 GiB | ROCm | 99 | tg128 | 37.70 ± 0.10 |',
        '| qwen3 27B Q6_K | 20 GiB | ROCm | 99 | pp8192 @ d32768 | 402.10 ± 5.00 |',
        '[bench] exited with code 0',
    ].join('\n');
    const blocks = M.parseLlamaBenchLog(log);
    assert.strictEqual(blocks.length, 1);
    const b = blocks[0];
    assert.match(b.flags.modelPath, /Q6_K_XL/);
    // identity comes from -m, NOT from the table's own "model" column
    assert.strictEqual(M.canonicalModel(b.flags.modelPath).key, 'local:qwen3.8-27b:q6-k-xl');
    assert.deepStrictEqual(b.rows.map((r) => [r.kind, r.depth, r.tps]), [
        ['prefill', 0, 704.9], ['gen', 0, 37.7], ['prefill', 32768, 402.1],
    ]);
});

test('parseLlamaBenchLog: a sweep block (no llama-bench binary) is not a bench block', () => {
    const log = [
        '===== llama-server: OPT-ncmoe30 =====',
        '--- 2026-09-21 01:00:00 ---',
        '$ /b/bin/llama-server -m /models/x-Q2_K_XL.gguf -c 65536',
        '| rep | prompt tok | prompt t/s | gen tok | gen t/s | draft acc | wall (s) |',
        '| --- | --- | --- | --- | --- | --- | --- |',
        '| 1 | 30000 | 303.4 | 1024 | 21.1 | 45% | 58.2 |',
        '[sweep] done',
    ].join('\n');
    assert.deepStrictEqual(M.parseLlamaBenchLog(log), []);
});

// ---------------------------------------------------------------- aggregation math

const row = (task, status, extra = {}) => ({
    dir: extra.dir || 'b1', ended: extra.ended ?? 1000, invalid: !!extra.invalid,
    row: {
        task, status, solved: status === 'pass' || status === 'pass*',
        tokens_out: extra.tokens_out ?? 1000, wall_s: extra.wall_s ?? 600,
        tool_calls: extra.tool_calls ?? 10,
        assertions: extra.assertions ?? null, p2p: null, p2p_broken: null,
        anomalies: [], status_derived: false,
    },
});

const META = new Map([
    ['t-a', { id: 't-a', tier: 't1', sample_group: null }],
    ['t-b', { id: 't-b', tier: 't2', sample_group: null }],
    ['t-c', { id: 't-c', tier: 'trap', sample_group: null }],
    ['widget', { id: 'widget', tier: 't1', sample_group: 'demo-widget-off-by-one' }],
    ['widget-orig', { id: 'widget-orig', tier: 'trap', sample_group: 'demo-widget-off-by-one' }],
]);

test('foldQualityRows: the same task re-run across batteries counts once (latest wins)', () => {
    const folded = M.foldQualityRows([
        row('t-a', 'fail', { dir: 'old', ended: 100 }),
        row('t-a', 'pass', { dir: 'new', ended: 900 }),
        row('t-b', 'pass', { dir: 'new', ended: 900 }),
    ], META);
    assert.strictEqual(folded.length, 2);
    assert.strictEqual(folded.find((f) => f.row.task === 't-a').row.status, 'pass');
    assert.strictEqual(folded.find((f) => f.row.task === 't-a').dir, 'new');
});

test('foldQualityRows: every task in a sample_group counts as its own task', () => {
    const folded = M.foldQualityRows([
        row('widget', 'pass', { ended: 500 }),
        row('widget-orig', 'fail', { ended: 900 }),
        row('t-a', 'pass'),
    ], META);
    assert.strictEqual(folded.length, 3, 'widget and widget-orig are two tasks, not one sample');
    assert.strictEqual(folded.find((f) => f.row.task === 'widget').row.status, 'pass', 'a later fail on the sibling does not erase this pass');
    assert.strictEqual(folded.find((f) => f.row.task === 'widget-orig').sample_group, 'demo-widget-off-by-one', 'the group survives as a label');
});

test('foldQualityRows: an INVALID-* battery contributes nothing', () => {
    const folded = M.foldQualityRows([
        row('t-a', 'pass', { dir: 'INVALID-x', invalid: true, ended: 9999 }),
        row('t-a', 'fail', { dir: 'good', ended: 1 }),
    ], META);
    assert.strictEqual(folded.length, 1);
    assert.strictEqual(folded[0].row.status, 'fail');
});

test('aggregateQuality: excluded statuses leave the denominator', () => {
    const samples = M.foldQualityRows([
        row('t-a', 'pass'), row('t-b', 'fail'),
        row('t-c', 'OVERFLOW'),
    ], META);
    const q = M.aggregateQuality(samples);
    assert.strictEqual(q.attempted, 3);
    assert.strictEqual(q.scored, 2, 'OVERFLOW is not a model answer');
    assert.strictEqual(q.excluded, 1);
    assert.strictEqual(q.solved, 1);
    assert.strictEqual(q.solveRate, 0.5);
});

test('aggregateQuality: ABORTED and PROVIDER_ERROR are excluded, TIMEOUT is not', () => {
    const meta = new Map([['x1', { tier: 't1' }], ['x2', { tier: 't1' }], ['x3', { tier: 't1' }]]);
    const q = M.aggregateQuality(M.foldQualityRows([
        row('x1', 'ABORTED'), row('x2', 'PROVIDER_ERROR'), row('x3', 'TIMEOUT'),
    ], meta));
    assert.strictEqual(q.excluded, 2);
    assert.strictEqual(q.scored, 1);
    assert.strictEqual(q.solved, 0);
    assert.strictEqual(q.solveRate, 0);
});

test('aggregateQuality: per-solve costs use only solved tasks; medians alongside means', () => {
    const meta = new Map([['a', { tier: 't1' }], ['b', { tier: 't1' }], ['c', { tier: 't1' }]]);
    const q = M.aggregateQuality(M.foldQualityRows([
        row('a', 'pass', { tokens_out: 1000, wall_s: 100, tool_calls: 5 }),
        row('b', 'pass', { tokens_out: 3000, wall_s: 300, tool_calls: 15 }),
        row('c', 'fail', { tokens_out: 90000, wall_s: 3600, tool_calls: 400 }),   // must not drag the per-solve cost
    ], meta));
    assert.strictEqual(q.tokensPerSolve.mean, 2000);
    assert.strictEqual(q.tokensPerSolve.median, 2000);
    assert.strictEqual(q.tokensPerSolve.n, 2);
    assert.strictEqual(q.wallPerSolve.mean, 200);
    assert.strictEqual(q.toolCallsPerSolve.mean, 10);
    // solves/hour: the denominator is ALL scored wall, including the failure you paid for
    assert.strictEqual(q.wallTotal_s, 4000);
    assert.ok(Math.abs(q.solvesPerHour - (2 / (4000 / 3600))) < 1e-9);
});

test('aggregateQuality: assertions sum only over results that carry them', () => {
    const meta = new Map([['a', {}], ['b', {}]]);
    const q = M.aggregateQuality(M.foldQualityRows([
        row('a', 'pass', { assertions: { passed: 4, total: 4 } }),
        row('b', 'fail', { assertions: null }),
    ], meta));
    assert.deepStrictEqual(q.assertions, { passed: 4, total: 4, tasks: 1 });
});

test('aggregateQuality: tier breakdown', () => {
    const q = M.aggregateQuality(M.foldQualityRows([
        row('t-a', 'pass'), row('t-b', 'fail'), row('t-c', 'pass'),
    ], META));
    assert.deepStrictEqual(q.byTier.t1, { scored: 1, solved: 1, excluded: 0 });
    assert.deepStrictEqual(q.byTier.t2, { scored: 1, solved: 0, excluded: 0 });
    assert.deepStrictEqual(q.byTier.trap, { scored: 1, solved: 1, excluded: 0 });
});

test('aggregateQuality: nothing attempted is null, never 0%', () => {
    const q = M.aggregateQuality([]);
    assert.strictEqual(q.solveRate, null);
    assert.strictEqual(q.solvesPerHour, null);
    assert.strictEqual(q.tokensPerSolve, null);
});

// ---------------------------------------------------------------- buckets / stats

test('bucketPrompt: the cache-hit floor is its own bucket and huge prompts do not fall off', () => {
    assert.strictEqual(M.bucketPrompt(4), 64);
    assert.strictEqual(M.bucketPrompt(64), 64);
    assert.strictEqual(M.bucketPrompt(65), 256);
    assert.strictEqual(M.bucketPrompt(30000), 32768);
    assert.strictEqual(M.bucketPrompt(500000), 524288);
    assert.strictEqual(M.bucketPrompt(null), null);
});

test('median/mean ignore nulls rather than treating them as zero', () => {
    assert.strictEqual(M.median([1, null, 3]), 2);
    assert.strictEqual(M.mean([1, null, 3]), 2);
    assert.strictEqual(M.median([]), null);
});

// ---------------------------------------------------------------- task.yaml

test('parseTaskYaml: id, tier and sample_group off a task file shape (invented values)', () => {
    const y = [
        'id: demo-widget-off-by-one-orig',
        'repo: /srv/repos/demo-app',
        'variant: fix',
        'category:',
        '- tier-trap',
        '- root-cause',
        'base_sha: "abc1234"',
        'note: "a sibling of the fixed variant; grouped for reporting."',
        'sample_group: demo-widget-off-by-one',
    ].join('\n');
    const t = M.parseTaskYaml(y);
    assert.strictEqual(t.id, 'demo-widget-off-by-one-orig');
    assert.strictEqual(t.sample_group, 'demo-widget-off-by-one');
    assert.strictEqual(t.tier, 'trap');
    assert.deepStrictEqual(t.category, ['tier-trap', 'root-cause']);
});

test('parseTaskYaml: tier_predicted beats the category tag', () => {
    const t = M.parseTaskYaml('id: x\ncategory:\n- tier-t2\n- bug\ntier_predicted: t3\n');
    assert.strictEqual(t.tier, 't3');
});

test('parseTaskYaml: wrapped story / probes read whole, and the prompt is never read', () => {
    const t = M.parseTaskYaml([
        'id: x', 'variant: avoid', 'category: [bug, tier-t2]',
        "story: 'Demo story: a label that read like ''the widget is ready''",
        "  was shown too early.'",
        'probes: Tracing why the last widget in a list is never drawn',
        '  (an off-by-one in the loop bound).',
        'weak_model_failure: >-', '  Pads the list with a dummy widget', '  instead of fixing the bound.',
        'prompt: |', '  SECRET the whole task', 'timeout_s: 7200',
    ].join('\n'));
    assert.strictEqual(t.variant, 'avoid');
    assert.deepStrictEqual(t.category, ['bug', 'tier-t2']);
    assert.strictEqual(t.tier, 't2');
    assert.strictEqual(t.story, "Demo story: a label that read like 'the widget is ready' was shown too early.");
    assert.strictEqual(t.probes, 'Tracing why the last widget in a list is never drawn (an off-by-one in the loop bound).');
    assert.strictEqual(t.weak_model_failure, 'Pads the list with a dummy widget instead of fixing the bound.');
    assert.strictEqual(t.timeout_s, 7200);
    assert.ok(!JSON.stringify(t).includes('SECRET'), 'prompt text must not be parsed');
});

// ---------------------------------------------------------------- BEST-CONFIGS

const BEST_SNIPPET = `# Best known config per model

## Rule
Every run script states which entry it implements.

## Qwen3.8-Flash-Next (all quants) — agent/codebench work
Build: \`~/AI/llama-official/llama.cpp-u144\` (unsloth PR #144) — **required**.

    -dev CUDA0,Vulkan0 -ts 11,37
    -c 65536 -fa on --cache-type-k q8_0 --cache-type-v q8_0 -ngl 999
    --spec-type draft-mtp --spec-draft-n-max 3 --spec-draft-p-min 0.5

**SUPERSEDED 2026-09-21 by a 13-config sweep (5 reps, 1024 gen tokens).**
Use instead, on the rebuilt \`llama.cpp-u144/build-hip\` tree:

    -dev CUDA0,ROCm0 -ts 11,37 -ncmoe 28
    --cache-type-k q8_0 --cache-type-v q8_0 -fa on -c 65536
    --spec-type draft-mtp --spec-draft-n-max 2

| | old | new | gain |
|---|---|---|---|
| generation | 18.8 t/s | 21.1 t/s | +12% |

- **The MTP optimum is backend-dependent.**

## Qwen3.8-27B (dense, all quants) — including Swift
Build: \`~/AI/llama-official/llama.cpp/build-all\` (stock).

    -dev ROCm0,CUDA0 -ts 3,1
    -c 65536 -fa on --cache-type-k f16 --cache-type-v f16 -ngl 999

- f16 KV is **+24% generation** over q8_0 on this model.

## Gemma 4 (added 2026-09-22) — **PROVISIONAL, nothing measured yet**
Starting point (to be replaced by measurement, not assumed):

    -dev ROCm0 -ngl 999 -c 65536 -fa on --cache-type-k f16 --cache-type-v f16
`;

test('parseBestConfigs: the LAST non-superseded block wins, not the first match', () => {
    const s = M.parseBestConfigs(BEST_SNIPPET);
    const flash = s.find((x) => /Flash-Next/.test(x.title));
    assert.ok(flash);
    assert.strictEqual(flash.blocks.length, 2);
    assert.strictEqual(flash.history.length, 1, 'the Vulkan/MTP-n3 block is history');
    assert.strictEqual(flash.current.parsed.devices, 'CUDA0,ROCm0');
    assert.strictEqual(flash.current.parsed.ncmoe, 28);
    assert.strictEqual(flash.current.parsed.specDraftN, 2);
    assert.strictEqual(flash.history[0].parsed.specDraftN, 3, 'the superseded one is kept, marked');
    assert.match(flash.supersedeNote, /SUPERSEDED 2026-09-21/);
    assert.strictEqual(flash.tuned, true);
    assert.strictEqual(flash.provisional, false);
});

test('parseBestConfigs: a PROVISIONAL section is not a recommendation', () => {
    const s = M.parseBestConfigs(BEST_SNIPPET);
    const gemma = s.find((x) => /Gemma/.test(x.title));
    assert.ok(gemma);
    assert.strictEqual(gemma.provisional, true);
    assert.strictEqual(gemma.tuned, false, 'provisional is never "tuned"');
    assert.ok(gemma.current, 'the starting-point flags are still parsed, just not endorsed');
});

test('parseBestConfigs: build line and tables survive', () => {
    const s = M.parseBestConfigs(BEST_SNIPPET);
    const dense = s.find((x) => /Qwen3\.8-27B/.test(x.title));
    assert.match(dense.build, /build-all/);
    assert.strictEqual(dense.current.parsed.kvK, 'f16');
    const flash = s.find((x) => /Flash-Next/.test(x.title));
    assert.ok(flash.tables.length >= 2);
});

test('parseBestConfigs: garbage in, empty out -- never throws', () => {
    assert.deepStrictEqual(M.parseBestConfigs(''), []);
    assert.deepStrictEqual(M.parseBestConfigs(null), []);
    assert.ok(Array.isArray(M.parseBestConfigs('no headings here at all\njust prose')));
});

test('matchBestConfigs: finetunes land on their base entry, unrelated models on nothing', () => {
    const s = M.parseBestConfigs(BEST_SNIPPET);
    const pick = (name) => {
        const m = M.matchBestConfigs(M.canonicalModel(name), s);
        return m && m.title;
    };
    assert.match(pick('Qwen3.8-Flash-Next-UD-IQ1_S.gguf'), /Flash-Next/);
    assert.match(pick('Qwen3.8-27B-UD-Q6_K_XL.gguf'), /Qwen3\.8-27B/);
    assert.match(pick('Swift-Qwen3.8-27B-Q4_K_L.gguf'), /Qwen3\.8-27B/);
    assert.match(pick('Huihui-Qwen3.8-27B-abliterated-UD-Q3_K_XL.gguf'), /Qwen3\.8-27B/);
    assert.match(pick('gemma-4-26B-A4B-it-UD-Q6_K_XL.gguf'), /Gemma 4/);
    assert.strictEqual(pick('Qwen3.6-27B-UD-Q6_K_XL.gguf'), null, 'no entry means no entry');
    assert.strictEqual(M.matchBestConfigs(M.canonicalModel('haiku'), s), null, 'cloud models have no launch flags');
});

// ---------------------------------------------------------------- CSV

test('splitCsvLine: quoted fields with commas and escaped quotes', () => {
    const cols = M.splitCsvLine('2026-01-01,abc,"a,b","he said ""hi""",7');
    assert.deepStrictEqual(cols, ['2026-01-01', 'abc', 'a,b', 'he said "hi"', '7']);
});

// ---------------------------------------------------------------- end-to-end on fixtures

// The catalog buffer (lib/catalogcache.js, 2026-10-06) is rebuilt when this signature moves. A task result landing
// in a battery dir that already exists must move it: the old signature only counted dirs, so a finished task waited.
test('catalogSignature: a result landing in an existing battery dir, or one rewritten in place, changes `inputs`', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'models-sig-'));
    const dir = path.join(tmp, 'cbroot', 'results', 'battery-a');
    fs.mkdirSync(dir, { recursive: true });
    fs.mkdirSync(path.join(tmp, 'cbroot', 'tasks'), { recursive: true });
    fs.writeFileSync(path.join(dir, 't1.json'), '{}');
    t.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); M.configure({}); });
    M.configure({ paths: { csv: path.join(tmp, 'none.csv'), bestConfigs: path.join(tmp, 'none.md'), benchLog: path.join(tmp, 'none.log'),
        sweepState: path.join(tmp, 'none.json'), codebenchRoot: path.join(tmp, 'cbroot') }, codebench: { listRuns: () => [], getRun: () => ({ rows: [] }) } });
    const a = M.catalogSignature();
    assert.deepStrictEqual(M.catalogSignature(), a, 'stable while nothing changes');
    assert.strictEqual(a.requests, '-', 'a fixture request source is not the live database');
    fs.writeFileSync(path.join(dir, 't2.json'), '{}');
    const b = M.catalogSignature();
    assert.notStrictEqual(b.inputs, a.inputs, 'a second result in the same dir');
    const later = new Date(Date.now() + 5000);
    fs.utimesSync(path.join(dir, 't1.json'), later, later);   // rewritten in place: the dir's own mtime does not move
    const c = M.catalogSignature();
    assert.notStrictEqual(c.inputs, b.inputs, 'a result rewritten in place');
    // what a running queue does all day without changing anything the index reads: the next task's work dir, a log
    // beside the results, a battery dir made ahead of time -- none of these may cost a rebuild
    fs.mkdirSync(path.join(dir, 't3'));
    fs.writeFileSync(path.join(dir, 'run.log'), 'x');
    fs.mkdirSync(path.join(tmp, 'cbroot', 'results', 'battery-b'));
    assert.strictEqual(M.catalogSignature().inputs, c.inputs, 'work dirs, logs and empty battery dirs are not results');
    fs.writeFileSync(path.join(tmp, 'cbroot', 'results', 'battery-b', 'battery.json'), '{}');
    assert.notStrictEqual(M.catalogSignature().inputs, c.inputs, 'a new battery, once it has its battery.json');
});

test('listModels/getModel over a fixture tree: no crash, no silent merge', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'models-test-'));
    const csv = path.join(tmp, 'benchmarks.csv');
    const headers = new Array(42).fill('');
    headers[0] = 'Timestamp'; headers[2] = 'model_name'; headers[3] = 'Model_Path';
    const mk = (ts, name, promptTok, promptTps, genTps) => {
        const c = new Array(42).fill('');
        c[0] = ts; c[1] = 'run' + ts; c[2] = name; c[3] = '/models/' + name; c[4] = '65536';
        c[9] = '/b/bin/llama-server -m /models/' + name + ' -c 65536 -dev ROCm0';
        c[10] = String(promptTps); c[11] = String(genTps); c[13] = String(promptTok);
        c[28] = '512'; c[30] = '30'; c[31] = '12.0';
        return c.join(',');
    };
    fs.writeFileSync(csv, [headers.join(','),
        mk('2026-09-01T00:00:00.000Z', 'Qwen3.8-27B-UD-Q6_K_XL.gguf', 8000, 700, 37),
        mk('2026-09-01T00:01:00.000Z', 'Qwen3.8-27B-UD-Q4_K_XL.gguf', 8000, 710, 38),
        mk('2026-09-01T00:02:00.000Z', 'Qwen3.8-27B-UD-Q6_K_XL.gguf', 4, 9, 36),   // cache hit
    ].join('\n') + '\n');
    const best = path.join(tmp, 'BEST-CONFIGS.md');
    fs.writeFileSync(best, BEST_SNIPPET);
    fs.writeFileSync(path.join(tmp, 'bench-history.log'), '');
    fs.writeFileSync(path.join(tmp, 'sweep-state.json'), JSON.stringify({ rows: [] }));
    fs.mkdirSync(path.join(tmp, 'cbroot', 'results'), { recursive: true });
    fs.mkdirSync(path.join(tmp, 'cbroot', 'tasks'), { recursive: true });

    t.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); M.configure({}); });

    M.configure({
        paths: {
            csv, bestConfigs: best, benchLog: path.join(tmp, 'bench-history.log'),
            sweepState: path.join(tmp, 'sweep-state.json'), codebenchRoot: path.join(tmp, 'cbroot'),
            dashboardConfig: path.join(tmp, 'nope.json'),
        },
        codebench: { listRuns: () => [], getRun: () => ({ rows: [] }) },
    });

    const list = M.listModels();
    assert.strictEqual(list.models.length, 2, 'Q6 and Q4 are two models, not one');
    const q6 = list.models.find((m) => m.key === 'local:qwen3.8-27b:q6-k-xl');
    assert.strictEqual(q6.counts.requests, 2);
    assert.strictEqual(q6.provider, 'local');
    assert.ok(q6.sources.length >= 1);

    const detail = M.getModel('local:qwen3.8-27b:q6-k-xl');
    assert.strictEqual(detail.history.total, 2);
    // CSV rows never recorded their context DEPTH, only the request's new tokens, so none of them
    // may be placed on the prefill-vs-context curve (2026-09-24): an 8k-token request on a deep
    // cache ran at the deep context's speed, not at 8k.
    const curve = detail.speedDetail.curve.fromRequests;
    assert.strictEqual(curve.length, 0);
    assert.match(detail.tunings.title, /Qwen3\.8-27B/);
    assert.strictEqual(M.getModel('local:does-not-exist:q4'), null);
});

// ---------------------------------------------------------------- spread vs variation

test('spread is half the range, and needs at least two values', () => {
    assert.strictEqual(M.spread([43.0, 45.0]), 1);
    assert.strictEqual(M.spread([46.4]), null, 'one rep is not a spread');
    assert.strictEqual(M.spread([]), null);
    // nulls are ignored, not treated as zero
    assert.strictEqual(M.spread([10, null, 20]), 5);
});

test('quantile gives the middle half of a distribution', () => {
    const a = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    assert.strictEqual(M.quantile(a, 0.25), 3);
    assert.strictEqual(M.quantile(a, 0.5), 5);
    assert.strictEqual(M.quantile(a, 0.75), 7);
    assert.strictEqual(M.quantile([], 0.5), null);
});

// ---------------------------------------------------------------- BEST-CONFIGS block choice

test('parseBestConfigs: the last block wins only if it looks like launch flags', () => {
    const s = M.parseBestConfigs([
        '## Some Model',
        'Starting point:',
        '',
        '    -dev ROCm0 -ngl 999 -c 65536 --cache-type-k f16',
        '',
        'Fire it with:',
        '',
        '    bench-tools/sweep-submit.py --lines ~/lines.txt --reps 5',
        '',
    ].join('\n'));
    const sec = s.find((x) => /Some Model/.test(x.title));
    assert.ok(sec.current, 'a section with two indented blocks still has a current one');
    assert.strictEqual(sec.current.parsed.devices, 'ROCm0', 'the run command is not a config');
    assert.strictEqual(sec.current.parsed.kvK, 'f16');
});

// ---------------------------------------------------------------- ui/shared/leaderboard.js
// The browser modules are ES modules; Node loads them here via data: URLs with the DOM-facing
// import stubbed, which both proves they EVALUATE (a top-level throw would blank the tab) and
// lets the honest-numbers helpers be tested for real.

async function loadLeaderboardModule() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'shared', 'leaderboard.js'), 'utf-8');
    const stub = 'data:text/javascript,' + encodeURIComponent(
        'export const esc=(s)=>String(s??"");export const fmtDur=(s)=>String(s);export const fmtN=(n)=>String(n);'
        + 'export const harnessLabel=(r)=>r||null;export const scaffoldBit=(r,s)=>s||null;'
        // the real context rule (ui/shared/ctxlabel.js, 2026-10-25): a stub never carries a copy of it
        + `import ${JSON.stringify(require('url').pathToFileURL(path.join(__dirname, '..', 'ui', 'shared', 'ctxlabel.js')).href)};export const { ctxLabel, commonWindow } = globalThis.CtxLabel;`);   // the real ones: test/pi.test.js
    const patched = src.replace("from '../benchmarks/util.js'", `from '${stub}'`);
    return import('data:text/javascript,' + encodeURIComponent(patched));
}

test('ui/shared/leaderboard.js evaluates without a DOM', async () => {
    const lb = await loadLeaderboardModule();
    assert.strictEqual(typeof lb.createLeaderboard, 'function');
    assert.strictEqual(lb.SERIES.length, 8, 'eight fixed categorical hues, never cycled');
    assert.ok(lb.QUALITY_COLUMNS.length && lb.SPEED_COLUMNS.length);
    assert.strictEqual(lb.SPEED_COLUMNS[0].id, 'wall', 'speed boards sort on wall clock first, not generation t/s');
});

test('wilson: 11/12 and 10/11 overlap — the board must call them tied', async () => {
    const { wilson } = await loadLeaderboardModule();
    const a = wilson(11, 12);   // 92%
    const b = wilson(10, 11);   // 91%
    assert.ok(a.lo < b.hi && b.lo < a.hi, 'their intervals overlap');
    assert.ok(a.hi - a.lo > 0.3, `at n=12 the interval is wide (got ${((a.hi - a.lo) * 100).toFixed(0)} points)`);
    // a genuinely separated pair must NOT be called tied
    const strong = wilson(100, 100), weak = wilson(10, 100);
    assert.ok(!(strong.lo < weak.hi && weak.lo < strong.hi));
    assert.strictEqual(wilson(0, 0), null);
});

// ui/modelpicker/rank.js imports leaderboard.js, which imports util.js: load the copied ui/ tree as
// ESM (the same trick as the evaluates-without-throwing test below) with the load-time globals stubbed.
async function loadPickerRank(t) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-picker-'));
    t.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
    fs.cpSync(path.join(__dirname, '..', 'ui'), path.join(tmp, 'ui'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));
    const had = { document: globalThis.document, window: globalThis.window };
    globalThis.document = globalThis.document || { addEventListener() {}, getElementById: () => null, querySelector: () => null, querySelectorAll: () => [] };
    globalThis.window = globalThis.window || { addEventListener() {} };
    t.after(() => { if (!had.document) delete globalThis.document; if (!had.window) delete globalThis.window; });
    return import(`file://${path.join(tmp, 'ui', 'modelpicker', 'rank.js')}`);
}

test('model picker: every launchable gguf maps to the same catalog key the server gives it', async (t) => {
    const { ggufModelKey } = await loadPickerRank(t);
    // every shape the launch dropdown lists: split parts, UD-, a dot before the quant, HF-cache paths,
    // non-model ggufs (mmproj, chat template), plus whatever is in the models dir on this machine
    const names = [
        'Qwen3.8-Flash-Next-UD-Q2_K_XL-00001-of-00003.gguf', 'Qwen3.8-27b-Terse-Coder.Q4_K_M.gguf',
        'Swift-Qwen3.8-27B-Q4_K_L.gguf', 'Huihui-Qwen3.8-27B-abliterated-UD-Q3_K_XL.gguf',
        'qwen2.5-coder-7b-instruct-q4_k_m.gguf', 'Ternary-Bonsai-2-27B-PTQ1_0.gguf', 'Qwen_Qwen3.6-35B-A3B-Q4_K_M.gguf',
        '/home/kyle/.cache/huggingface/hub/models--unsloth--Qwen3.8-27B-GGUF/snapshots/x/Qwen3.8-27B-UD-Q4_K_XL.gguf',
        'qwen-3.8-mmproj-F16.gguf', 'qwen-3.8-unsloth-3.0-chat-template.gguf', 'mtp-gemma-4-12b-it-Q8_0.gguf',
    ];
    const dir = '/home/kyle/AI/experiment-1/models';
    try { names.push(...fs.readdirSync(dir).filter((f) => f.endsWith('.gguf'))); } catch { /* not on this machine */ }
    for (const n of names) assert.strictEqual(ggufModelKey(n), M.canonicalModel(n).key, n);
});

test('model picker: rows strictly by quality, best first, unbenchmarked apart', async (t) => {
    const { pickerRows, ggufModelKey } = await loadPickerRank(t);
    const opt = (file) => ({ value: '/m/' + file, text: file });
    const options = [opt('B-Q4_K_M.gguf'), opt('zeta-Q8_0.gguf'), opt('A-Q4_K_M.gguf'), opt('C-Q4_K_M.gguf'), opt('D-Q4_K_M.gguf'),
        opt('alpha-Q8_0.gguf'), { value: '/hf/A-Q4_K_M.gguf', text: 'A-Q4_K_M.gguf [HF cache]' }];
    const P = (file, y, lo, hi, relTime, n, rate = y) => ({ key: ggufModelKey(file), label: file, y, rate, lo, hi, relTime, n, _others: [] });
    const points = [
        P('A-Q4_K_M.gguf', 0.90, 0.85, 0.95, 2.0, 100),
        P('B-Q4_K_M.gguf', 0.60, 0.50, 0.70, 1.0, 50),
        P('C-Q4_K_M.gguf', 0.70, 0.30, 0.95, 0.5, 8),
        P('D-Q4_K_M.gguf', 0.70, 0.60, 0.80, 3.0, 40, 0.75),   // ties C on the rate; better weighted -> above C though slower
        { ...P('cloud', 0.80, 0.7, 0.9, 0.1, 40), key: 'cloud:x:y' },   // not launchable: never listed
    ];
    const { rated, unrated } = pickerRows(options, points, []);
    assert.deepStrictEqual(rated.map((r) => r.option.value),
        ['/m/A-Q4_K_M.gguf', '/hf/A-Q4_K_M.gguf', '/m/D-Q4_K_M.gguf', '/m/B-Q4_K_M.gguf', '/m/C-Q4_K_M.gguf'],
        'best first by the LOW END of the strength range (2026-09-29): thin C (0.70, range 0.30-0.95) now sits below proven B (0.60, 0.50-0.70); both files of A together; never by speed');
    assert.deepStrictEqual(unrated.map((r) => r.option.text), ['alpha-Q8_0.gguf', 'zeta-Q8_0.gguf'], 'not benchmarked: alphabetical');
    assert.ok(rated.every((r) => !('step' in r) && !('below' in r)), 'no ladder-step fields any more');
    const c = rated.find((r) => r.point.key === ggufModelKey('C-Q4_K_M.gguf'));
    assert.strictEqual(c.thin, true, '8 tasks and a 65-point interval is a thin record');
    assert.strictEqual(rated[0].thin, false);
});

test('model picker: every row is compared with the current model, head to head or ≈ by index', async (t) => {
    const { pickerRows, compareTo, ggufModelKey } = await loadPickerRank(t);
    const opt = (file) => ({ value: '/m/' + file, text: file });
    const options = ['Q4-Q4_K_XL.gguf', 'Q2-Q2_K_XL.gguf', 'THIN-Q3_K_XL.gguf'].map(opt).concat([{ value: '/hf/Q4-Q4_K_XL.gguf', text: 'Q4 [HF]' }]);
    const P = (file, y, lo, hi, relTime, n, extra) => ({ key: ggufModelKey(file), label: file, y, rate: y, lo, hi, relTime, n, _others: [], ...extra });
    // Q2's per-task wall is 1.34x Q4's on 27 shared tasks, although its INDEX says it is faster (0.75 / 2.0):
    // the head-to-head number must win. Tokens: 0.68x, head to head over the same tasks.
    const shared = T(27);
    const points = [
        P('Q4-Q4_K_XL.gguf', 0.79, 0.79, 0.98, 2.0, 34, { costTasks: costs(shared, 100), tokenTasks: costs(shared, 1000), tokensPerSolve: 1000 }),
        P('Q2-Q2_K_XL.gguf', 0.77, 0.77, 0.99, 1.5, 33, { costTasks: costs(shared, 134), tokenTasks: costs(shared, 680), tokensPerSolve: 700 }),
        // the thin one shares 3 solved tasks with each: under LADDER_MIN_N, so it falls back to the index ratio
        P('THIN-Q3_K_XL.gguf', 0.40, 0.20, 0.60, 3.0, 6, { costTasks: costs(T(3), 50), tokenTasks: costs(['x1'], 5), tokensPerSolve: 2000 }),
    ];
    const { rated } = pickerRows(options, points, []);
    const row = (k) => rated.find((r) => r.option.value === '/m/' + k);
    const q4 = row('Q4-Q4_K_XL.gguf'), q2 = row('Q2-Q2_K_XL.gguf'), thin = row('THIN-Q3_K_XL.gguf');

    // current = Q4: Q2 is 1.34x slower head to head, 2 points worse, within noise
    const a = compareTo(q2, q4);
    assert.ok(Math.abs(a.time.ratio - 1.34) < 1e-9 && a.time.n === 27 && a.time.approx === false, 'head to head over the 27 shared tasks, not 1.5/2.0');
    assert.ok(Math.abs(a.pts - -2) < 1e-9, 'points of the active rate, row minus current');
    assert.strictEqual(a.noise, true, 'the two intervals overlap');
    assert.ok(Math.abs(a.tokens.ratio - 0.68) < 1e-9 && !a.tokens.approx, 'tokens head to head too');

    // flip the current model: the numbers flip with it
    const b = compareTo(q4, q2);
    assert.ok(Math.abs(b.time.ratio - 1 / 1.34) < 1e-9 && b.time.n === 27, 'Q4 reads ~0.75x time when Q2 is current');
    assert.ok(Math.abs(b.pts - 2) < 1e-9);
    assert.ok(Math.abs(b.tokens.ratio * a.tokens.ratio - 1) < 1e-9);

    // under 5 shared tasks: the relative-time index ratio, marked approximate, with the shared count
    const c = compareTo(thin, q4);
    assert.strictEqual(c.time.approx, true);
    assert.strictEqual(c.time.n, 3);
    assert.ok(Math.abs(c.time.ratio - 1.5) < 1e-9, '3.0 / 2.0');
    assert.ok(Math.abs(c.tokens.ratio - 2) < 1e-9 && c.tokens.approx && c.tokens.n === 0, 'tokens fall back to tokens per solve');
    assert.ok(Math.abs(c.pts - -39) < 1e-9);
    assert.strictEqual(c.noise, false, '20-60% vs 79-98%: separated, not noise');

    // no fallback when an index is missing
    assert.strictEqual(compareTo({ ...thin, point: { ...thin.point, relTime: null } }, q4).time, null);
    // the current model itself, and the other file of its weights, are "same"; no current model -> nothing
    assert.deepStrictEqual(compareTo(q4, q4), { same: true });
    assert.deepStrictEqual(compareTo(rated.find((r) => r.option.value === '/hf/Q4-Q4_K_XL.gguf'), q4), { same: true });
    assert.strictEqual(compareTo(q2, null), null);
});

test('ladderSteps: every model is a rung, and each step is priced in the other measure', async () => {
    const { ladderSteps } = await loadLeaderboardModule();
    const P = (key, x, y, lo, hi) => ({ key, x, y, lo, hi });
    const pts = [
        P('slow-good', 2.0, 0.90, 0.85, 0.95),
        P('fast-weak', 0.5, 0.60, 0.55, 0.65),
        P('mid', 1.0, 0.70, 0.40, 0.80),
        P('fast-better', 0.8, 0.72, 0.60, 0.82),  // faster than mid AND better: a free step up from it
        P('no-time', null, 0.99, 0.9, 1),        // nowhere to put it
    ];
    // quality order: worst at the bottom, nothing dropped for being dominated
    const q = ladderSteps(pts, 'quality');
    assert.deepStrictEqual(q.rungs.map((r) => r.key), ['fast-weak', 'mid', 'fast-better', 'slow-good']);
    assert.deepStrictEqual(q.unplaced.map((u) => u.key), ['no-time']);
    assert.strictEqual(q.rungs[0].step, null, 'the bottom rung has no step into it');
    const s1 = q.rungs[1].step;                  // fast-weak -> mid: +10 pts for 2x time
    assert.ok(Math.abs(s1.pts - 10) < 1e-9 && Math.abs(s1.mult - 2) < 1e-9);
    assert.ok(Math.abs(s1.perPt - 10) < 1e-9, '100% more time over 10 pts = 10% per point');
    assert.strictEqual(s1.noise, true, 'mid 40-80% overlaps fast-weak 55-65%: within noise');
    assert.strictEqual(s1.free, false);
    const s2 = q.rungs[2].step;                  // mid -> fast-better: +2 pts for 0.8x time
    assert.strictEqual(s2.free, true, 'faster AND better is free');
    assert.ok(s2.perPt < 0);
    const s3 = q.rungs[3].step;                  // fast-better -> slow-good: +18 pts for 2.5x
    assert.ok(Math.abs(s3.perPt - 150 / 18) < 1e-9);
    assert.strictEqual(s3.noise, false, '85-95% clears 60-82%: a real step');
    // a gain too small to price
    const tiny = ladderSteps([P('a', 1, 0.800, 0.7, 0.9), P('b', 2, 0.803, 0.7, 0.9)], 'quality');
    assert.strictEqual(tiny.rungs[1].step.perPt, null, 'a 0.3-pt gain has no per-point price');

    // cost order: slowest at the bottom, climbing toward speed prices the quality given up
    const c = ladderSteps(pts, 'cost');
    assert.deepStrictEqual(c.rungs.map((r) => r.key), ['slow-good', 'mid', 'fast-better', 'fast-weak']);
    const t1 = c.rungs[1].step;                  // slow-good -> mid: 2x faster for -20 pts
    assert.ok(Math.abs(t1.speedup - 2) < 1e-9 && Math.abs(t1.pts + 20) < 1e-9);
    assert.ok(Math.abs(t1.perHalving - 20) < 1e-9, '20 pts given up for one halving of time');
    assert.strictEqual(t1.free, false);
    assert.strictEqual(c.rungs[2].step.free, true, 'mid -> fast-better is faster and better');
    const t3 = c.rungs[3].step;                  // fast-better -> fast-weak: 1.6x faster, -12 pts
    assert.ok(Math.abs(t3.perHalving - 12 / Math.log2(1.6)) < 1e-9);
});

// Head-to-head costs: per-task maps for the ladder tests below. costs(ids, v) -> {id: v(i)}
const costs = (ids, v) => Object.fromEntries(ids.map((t, i) => [t, typeof v === 'function' ? v(i) : v]));
const T = (n, from = 0) => Array.from({ length: n }, (_, i) => `t${i + from}`);

test('pairwiseCost: geometric mean of B/A over the tasks both solved, and how many', async () => {
    const { pairwiseCost, solvedCosts } = await loadLeaderboardModule();
    const a = { costTasks: { t1: 10, t2: 100, t3: 50, onlyA: 1 } };
    const b = { costTasks: { t1: 20, t2: 50, t3: 400, onlyB: 9 } };
    const r = pairwiseCost(a, b);
    assert.strictEqual(r.n, 3, 'only t1..t3 are common');
    assert.ok(Math.abs(r.ratio - Math.cbrt(2 * 0.5 * 8)) < 1e-12, 'geomean of 2, 0.5, 8 = 2');
    assert.deepStrictEqual(pairwiseCost(a, { costTasks: {} }), { ratio: null, n: 0 });
    assert.deepStrictEqual(pairwiseCost(a, {}), { ratio: null, n: 0 }, 'no per-task costs: nothing to compare');
    // only solved, non-excluded tasks with a positive cost count
    const m = solvedCosts({ s: { solved: true, wall_s: 5 }, f: { solved: false, wall_s: 9 }, x: { solved: true, excluded: true, wall_s: 3 }, z: { solved: true, wall_s: 0 } }, 'wall_s');
    assert.deepStrictEqual(m, { s: 5 });
});

test('ladderSteps: steps are priced head to head on common solved tasks, index ratio only under LADDER_MIN_N', async () => {
    const { ladderSteps, LADDER_MIN_N } = await loadLeaderboardModule();
    assert.strictEqual(LADDER_MIN_N, 5);
    const P = (key, x, y, costTasks) => ({ key, x, y, lo: y - 0.05, hi: y + 0.05, costTasks });
    // 6 common tasks, B takes exactly 3x A's wall on each: 3x head to head, whatever the indexes say
    const ok = ladderSteps([P('A', 1.0, 0.5, costs(T(8), 10)), P('B', 1.5, 0.7, costs(T(6), 30))], 'quality');
    const s = ok.rungs[1].step;
    assert.strictEqual(s.n, 6);
    assert.strictEqual(s.indirect, false);
    assert.ok(Math.abs(s.mult - 3) < 1e-12, `head-to-head 3x, not the 1.5x index ratio (got ${s.mult})`);
    assert.ok(Math.abs(s.perPt - 10) < 1e-9, '200% more time over 20 points = +10% per +1%');
    // 4 common tasks: too few, back to the index ratio, marked indirect
    const thin = ladderSteps([P('A', 1.0, 0.5, costs(T(4), 10)), P('B', 1.5, 0.7, costs(T(4), 30))], 'quality').rungs[1].step;
    assert.strictEqual(thin.n, 4);
    assert.strictEqual(thin.indirect, true);
    assert.ok(Math.abs(thin.mult - 1.5) < 1e-12, 'fallback: x ratio');
    // no common tasks at all
    const none = ladderSteps([P('A', 1.0, 0.5, costs(T(6), 10)), P('B', 2.0, 0.7, costs(T(6, 100), 30))], 'quality').rungs[1].step;
    assert.strictEqual(none.n, 0);
    assert.strictEqual(none.indirect, true);
    assert.ok(Math.abs(none.mult - 2) < 1e-12);
});

test('ladder regression: faster by index but slower head to head reads SLOWER in both views (Flash Q2 vs 27B Q4)', async () => {
    const { ladderSteps, ladderStepText } = await loadLeaderboardModule();
    // the shape of the real bug: Flash-Next Q2_K_XL's index (0.72x the 27B Q4_K_XL's) said faster;
    // on the 30 tasks both solved it took ~1.34x the wall time.
    const q4 = { key: 'q4', label: '27B Q4_K_XL', x: 1.87, y: 0.788, lo: 0.70, hi: 0.86, costTasks: costs(T(32), (i) => 100 + i) };
    const flash = { key: 'flash', label: 'Flash Q2_K_XL', x: 1.34, y: 0.794, lo: 0.71, hi: 0.86, costTasks: costs(T(31, 2), (i) => 1.34 * (102 + i)) };
    const q = ladderSteps([q4, flash], 'quality');
    assert.deepStrictEqual(q.rungs.map((r) => r.key), ['q4', 'flash'], 'rungs by rate');
    const s = q.rungs[1].step;
    assert.strictEqual(s.n, 30);
    assert.ok(Math.abs(s.mult - 1.34) < 1e-9, `head to head 1.34x the time (got ${s.mult})`);
    assert.strictEqual(s.free, false, 'slower is not free');
    const qt = ladderStepText(s, { order: 'quality', costWord: 'time' });
    assert.doesNotMatch(qt.headline, /faster|free/, qt.headline);
    assert.match(qt.detail, /^\+0\.6% solve for 1\.34× time · 30 shared tasks/, qt.detail);
    // speed view: the index still places Flash above (cheaper), but the step must say slower
    const c = ladderSteps([q4, flash], 'cost');
    assert.deepStrictEqual(c.rungs.map((r) => r.key), ['q4', 'flash']);
    const cs = c.rungs[1].step;
    assert.ok(cs.speedup < 1);
    const ct = ladderStepText(cs, { order: 'cost', costWord: 'time' });
    assert.match(ct.headline, /^slower head to head/, ct.headline);
    assert.doesNotMatch(ct.headline + ct.detail, /faster|free/);
    assert.match(ct.detail, /1\.34× time for \+0\.6% solve/);
    // and the old index-only reading, for contrast: without per-task costs the step is indirect
    const idx = ladderSteps([{ ...q4, costTasks: null }, { ...flash, costTasks: null }], 'quality').rungs[1].step;
    assert.strictEqual(idx.indirect, true);
    assert.ok(idx.mult < 1);
    assert.match(ladderStepText(idx, { order: 'quality' }).detail, /≈0\.72× time · ≈ indirect \(0 shared\)/);
    assert.strictEqual(ladderStepText(idx, { order: 'quality' }).headline, '≈faster, same quality', 'an indirect claim is marked in the headline too');
});

test('ladderStepText: percentage points written +x% / −x%, never "pts"', async () => {
    const { ladderSteps, ladderStepText } = await loadLeaderboardModule();
    const P = (key, y, c) => ({ key, x: 1, y, lo: y - 0.01, hi: y + 0.01, costTasks: costs(T(10), c) });
    const q = ladderSteps([P('a', 0.50, 10), P('b', 0.60, 18.1)], 'quality').rungs[1].step;   // +10 points for 1.81x
    const qt = ladderStepText(q, { order: 'quality', costWord: 'time' });
    assert.strictEqual(qt.headline, '+8.1% time per +1%');
    assert.strictEqual(ladderStepText(q, { order: 'quality', short: true }).headline, '+8.1% per +1%');
    const c = ladderSteps([{ ...P('slow', 0.60, 40), x: 2 }, { ...P('fast', 0.57, 10), x: 0.5 }], 'cost');
    const cs = c.rungs[1].step;                   // 4x faster head to head for -3 points
    const ct = ladderStepText(cs, { order: 'cost', costWord: 'time' });
    assert.strictEqual(ct.headline, '−1.5% solve per halving of time');
    assert.strictEqual(ct.detail, '4.00× faster for −3.0% solve · 10 shared tasks');
    // cheaper AND better: "free", with its numbers (never "free lunch")
    const f = ladderSteps([P('a', 0.500, 10), P('b', 0.514, 7.2)], 'quality').rungs[1].step;
    const ft = ladderStepText(f, { order: 'quality', costWord: 'time' });
    assert.strictEqual(ft.headline, 'free: +1.4% solve at 0.72× time');
    assert.strictEqual(ft.compact, 'free · +1.4% solve · 0.72× time · noise', 'intervals ±1 point overlap');
    assert.strictEqual(ladderStepText(f, { order: 'quality', short: true }).headline, 'free');
    for (const t of [qt, ct, ft]) assert.doesNotMatch(t.headline + t.detail, /pts|lunch/);
});

test('ladderSteps: a step whose rung below shares too few solved tasks is re-anchored on the nearest lower rung that shares enough', async () => {
    const { ladderSteps, ladderStepText } = await loadLeaderboardModule();
    const P = (key, x, y, costTasks) => ({ key, label: key, x, y, lo: y - 0.05, hi: y + 0.05, costTasks });
    // A (bottom) and C share t0..t7; B (between them) shares only 2 tasks with C
    const A = P('A', 1.0, 0.40, costs(T(8), 10));
    const B = P('B', 0.5, 0.50, costs(['t0', 't1', 'x1', 'x2', 'x3', 'x4'], 10));
    const C = P('C', 1.2, 0.60, costs(T(8), 25));
    const { rungs } = ladderSteps([A, B, C], 'quality');
    assert.deepStrictEqual(rungs.map((r) => r.key), ['A', 'B', 'C']);
    const s = rungs[2].step;
    assert.strictEqual(s.basis, 'reanchored');
    assert.strictEqual(s.reanchored, true);
    assert.strictEqual(s.indirect, false);
    assert.strictEqual(s.vsKey, 'A');
    assert.strictEqual(s.vsIndex, 0);
    assert.strictEqual(s.n, 8, 'the tasks C shares with A');
    assert.ok(Math.abs(s.mult - 2.5) < 1e-12, 'priced against A: 25/10');
    assert.ok(Math.abs(s.pts - 20) < 1e-9, 'and the gain is against A too: 60% - 40%');
    const w = ladderStepText(s, { order: 'quality' });
    assert.strictEqual(w.basis, 'vs #1, 8 shared');
    assert.match(w.compact, /^vs #1: \+20% solve · 2\.50× time/);
    assert.strictEqual(ladderStepText(s, { rank: () => '#7' }).basis, 'vs #7, 8 shared', 'the picker names rungs its own way');
    // B vs A: 6 tasks, but only t0, t1 shared -> no lower rung either -> indirect against the rung below
    const sb = rungs[1].step;
    assert.strictEqual(sb.basis, 'indirect');
    assert.strictEqual(sb.vsKey, 'A');
    assert.strictEqual(sb.n, 2);
    assert.ok(Math.abs(sb.mult - 0.5) < 1e-12, 'index ratio 0.5 / 1.0');
    assert.strictEqual(ladderStepText(sb, { order: 'quality' }).basis, '≈ indirect (2 shared)');
    // the adjacent rung wins whenever it shares enough, even when a lower one shares more
    const B2 = P('B', 0.5, 0.50, costs(T(5), 20));
    const s2 = ladderSteps([A, B2, C], 'quality').rungs[2].step;
    assert.strictEqual(s2.basis, 'direct');
    assert.strictEqual(s2.vsKey, 'B');
    assert.strictEqual(ladderStepText(s2, { order: 'quality' }).basis, '5 shared tasks');
});

test('ladderPoints: the fastest time config needs LADDER_MIN_N solved tasks, and carries its per-task walls', async () => {
    const { ladderPoints } = await loadLeaderboardModule();
    const m = { key: 'm', display: 'M', weightsKey: 'm' };
    const solved = (ids, wall) => Object.fromEntries(ids.map((t) => [t, { solved: true, credit: 1, attempts: 1, wall_s: wall, tokens_out: 1000 }]));
    const qg = { key: 'q', m, q: { attempted: 12, scored: 12, tokensPerSolve: 1000 }, tasks: solved(T(12), 50) };
    const lucky = { key: 't-lucky', qg, tasks: solved(T(2), 5) };      // 2 tasks: a noisy index
    const real = { key: 't-real', qg, tasks: solved(T(10, 2), 50) };
    const fit = { adj: new Map([['q', { rate: 0.8, lo: 0.7, hi: 0.9 }]]), tAll: [lucky, real],
        rel: new Map([['t-lucky', { index: 0.5, tasks: 2 }], ['t-real', { index: 2.0, tasks: 10 }]]) };
    const [p] = ladderPoints(fit, [qg], { how: 'robust', cost: 'time' });
    assert.strictEqual(p.y, 0.7, 'robust: the lower end');
    assert.strictEqual(p._tg, real, 'a 2-task index is not "fastest"');
    assert.strictEqual(p.relTime, 2.0);
    assert.strictEqual(Object.keys(p.costTasks).length, 10);
    const [pt] = ladderPoints(fit, [qg], { cost: 'tokens' });
    assert.strictEqual(Object.keys(pt.costTasks).length, 12, 'tokens: the quality group\'s own tasks');
    // only small configs: the fastest of them, rather than nothing
    const fit2 = { ...fit, tAll: [lucky], rel: new Map([['t-lucky', { index: 0.5, tasks: 2 }]]) };
    assert.strictEqual(ladderPoints(fit2, [qg])[0]._tg, lucky);
});

// 2026-10-21 (Kyle: "why is iq3 xxs the strongest local model on the speed x quality graph, and is far lower in the
// solve map...?" / "this logic should live in one place"): bestConfigOf is the one rule for which config stands for
// several; the ladder (and pickers) and the battery -> strength map use it, so a thin re-run with a higher low end no
// longer stands for its model anywhere.
test('bestConfigOf: only configs with real evidence compete; ladderPoints and strengthForDirs use it', async () => {
    const { ladderPoints, bestConfigOf, strengthForDirs, BEST_CONFIG_MIN_N, BEST_CONFIG_MIN_FRAC } = await loadLeaderboardModule();
    assert.deepStrictEqual([BEST_CONFIG_MIN_N, BEST_CONFIG_MIN_FRAC], [10, 0.25]);
    const m = { key: 'm', display: 'M', weightsKey: 'm' };
    const g = (key, scored, dirs = [key]) => ({ key, m, q: { attempted: scored, scored }, tasks: {}, dirs });
    const main = g('main', 90), side = g('side', 30), thin = g('thin', 6), tiny = g('tiny', 4);
    const lo = { main: 0.44, side: 0.46, thin: 0.50, tiny: 0.49, thin2: 0.20 };
    const byLo = (x) => lo[x.key];
    assert.strictEqual(bestConfigOf([main, side, thin, tiny], byLo), side, '>= 10 and >= a quarter of 90: side beats main by low end');
    assert.strictEqual(bestConfigOf([main, thin, tiny], byLo), main, 'the 6-task config with the higher low end does not win');
    assert.strictEqual(bestConfigOf([thin, tiny], byLo), thin, 'nothing eligible: the most-tested alone');
    const thin2 = g('thin2', 6);
    assert.strictEqual(bestConfigOf([thin2, thin, tiny], byLo), thin, 'a tie on most-tested goes to the better low end, not list order');
    assert.strictEqual(bestConfigOf([], byLo), null);
    assert.strictEqual(bestConfigOf([g('a', 20), g('b', 20)], () => 1).key, 'a', 'a tie keeps the first of equal evidence');
    const fit = { adj: new Map([['main', { rate: 0.51, lo: 0.44, hi: 0.59 }], ['thin', { rate: 0.635, lo: 0.50, hi: 0.77 }],
        ['tiny', { rate: 0.60, lo: 0.49, hi: 0.74 }]]), tAll: [], rel: new Map() };
    const [p] = ladderPoints(fit, [thin, tiny, main], { how: 'adjusted' });
    assert.strictEqual(p._g, main, 'the ladder: the 90-task config, not the 6-task one');
    assert.strictEqual(p.y, 0.51);
    // a battery split over a thin and a thick config reads the thick one's strength
    const split = [g('main', 90, ['b1']), g('thin', 6, ['b1'])];
    const byDir = new Map([['b1', fit.adj.get('thin')]]);
    byDir.groupsByDir = new Map([['b1', split.map((x) => [x, fit.adj.get(x.key)])]]);
    assert.strictEqual(strengthForDirs(byDir, ['b1']).a, fit.adj.get('main'));
});

// 2026-10-21 (Kyle: "experiments with few results should have high variability and select rank based on the lowest bound
// number ... should apply to every ordered quality sorting on the page"): strengthRank is the one order; the boards sort
// the strength column by it (strengthMetric's `sort`), the ladder climbs by it, and a step that goes down is "surer".
test('strengthRank: the one strength order -- boards, ladder rungs, and the words for a step down', async () => {
    const { strengthRank, strengthMetric, ladderSteps, ladderStepText, ladderPointOf } = await loadLeaderboardModule();
    assert.strictEqual(strengthRank(null), -1);
    assert.strictEqual(strengthRank({ rate: 0.5 }), -1, 'no range, no rank');
    assert.strictEqual(strengthRank({ rate: 0.5, lo: 0.42, hi: 0.6 }), 0.42);
    const thin = { rate: 0.568, lo: 0.42, hi: 0.79, strength: 56.8, n: 23, coverage: 0.05 };
    const proven = { rate: 0.539, lo: 0.49, hi: 0.58, strength: 53.9, n: 70, coverage: 0.67 };
    const q = { solved: 1, scored: 2 };
    assert.strictEqual(strengthMetric(thin, q).v, 0.568, 'the cell still prints the strength');
    assert.ok(strengthMetric(proven, q).sort > strengthMetric(thin, q).sort, 'and sorts by the low end: the proven row first');
    // the ladder climbs by rank: the thin row (higher midpoint, lower low end) is the lower rung
    const P = (key, a, x) => ({ key, label: key, y: a.rate, rank: strengthRank(a), lo: a.lo, hi: a.hi, x, n: 20,
        costTasks: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`t${i}`, x * 100])) });
    const { rungs } = ladderSteps([P('proven', proven, 1.0), P('thin', thin, 1.2)], 'quality');
    assert.deepStrictEqual(rungs.map((r) => r.key), ['thin', 'proven']);
    const s = rungs[1].step;
    assert.ok(s.pts < 0, 'the step up loses midpoint');
    assert.strictEqual(s.perPt, null, 'and is never priced');
    assert.match(ladderStepText(s, { order: 'quality' }).headline, /^surer, not higher: −2\.9% solve at /);
    assert.match(ladderStepText(s, { order: 'quality', short: true }).headline, /^surer, −2\.9% solve$/);
    // a point without `rank` (an older caller) climbs by y, as before
    assert.deepStrictEqual(ladderSteps([{ ...P('a', proven, 1), rank: undefined }, { ...P('b', thin, 1), rank: undefined }], 'quality').rungs.map((r) => r.key), ['a', 'b']);
    // ladderPointOf carries the rank and the row's own key/label (the Models page passes the Rows switch's)
    const qg = { key: 'g', m: { key: 'm', display: 'M' }, q: { scored: 70, tokensPerSolve: 900 }, tasks: {} };
    const pt = ladderPointOf(qg, proven, null, new Map(), { key: 'row', label: 'M · best config' });
    assert.deepStrictEqual([pt.key, pt.label, pt.rank, pt.y, pt.x], ['row', 'M · best config', 0.49, 0.539, null]);
});

// 2026-10-21 (Kyle: "the speedxquality chart should follow whatever is selected at the top, so that it matches"): the
// Models page's ladder, frontier and cost charts take their rows from the Rows switch (rowsPerModel), the ladder no longer
// has its own pick (ladderPoints is the pickers'), and every strength order there goes through strengthRank.
test('Models page: Speed x quality and the cost charts follow the Rows switch; one strength order', () => {
    const page = fs.readFileSync(path.join(__dirname, '..', 'ui', 'models', 'index.js'), 'utf-8');
    const body = (name) => { const i = page.indexOf(`const ${name} = () => {`); assert.ok(i >= 0, name); return page.slice(i, page.indexOf('\n        };', i)); };
    assert.ok(/rowsPerModel\(/.test(body('paintLadder')) && /ladderPointOf\(/.test(body('paintLadder')), 'the ladder: the switch\'s rows');
    assert.ok(!/ladderPoints\(/.test(page), 'no second pick on the page');
    assert.ok(/rowsPerModel\(/.test(body('paintFrontier')), 'the frontier: the switch\'s rows');
    for (const c of ['paintTok', 'paintWall', 'paintGb', 'paintGbt']) {
        assert.ok(/rowsPerModel\(/.test(body(c)) && !/bestPerModel\(/.test(body(c)), `${c}: the switch's rows`);
        assert.ok(/rowName\(/.test(body(c)), `${c}: the switch's names`);
    }
    const sw = page.slice(page.indexOf("wireToggle('chart-rows'"), page.indexOf("wireToggle('chart-rows'") + 400);
    for (const c of ['paintGrid', 'paintFrontier', 'paintLadder', 'paintTok', 'paintWall', 'paintGb', 'paintGbt']) assert.ok(sw.includes(c + '()'), `the switch repaints ${c}`);
    assert.ok(!/a \? a\.lo : -1/.test(page) && !/\.lo - x\.lo|y\.lo - x\.lo/.test(page), 'no local low-end order left');
    assert.ok(/return strengthRank\(a\);/.test(page), 'the Solve map\'s rank is strengthRank');
});

test('commonTaskSet: the intersection, and whether the sets differed at all', async () => {
    const { commonTaskSet } = await loadLeaderboardModule();
    const rows = [
        { tasks: { a: {}, b: {}, c: {} } },
        { tasks: { b: {}, c: {}, d: {} } },
        { tasks: {} },                       // no data: ignored, not treated as an empty set
    ];
    const r = commonTaskSet(rows);
    assert.deepStrictEqual([...r.ids].sort(), ['b', 'c']);
    assert.strictEqual(r.rowsCompared, 2);
    assert.strictEqual(r.allSame, false, 'different sets must be flagged so the board can warn');
    const same = commonTaskSet([{ tasks: { a: {} } }, { tasks: { a: {} } }]);
    assert.strictEqual(same.allSame, true);
});

test('qualityMetricsFor: restricting to a task set is a real recomputation', async () => {
    const { qualityMetricsFor } = await loadLeaderboardModule();
    const tasks = {
        a: { solved: true, excluded: false, tokens_out: 1000, wall_s: 100, tool_calls: 5 },
        b: { solved: false, excluded: false, tokens_out: 9000, wall_s: 900, tool_calls: 90 },
        c: { solved: true, excluded: false, tokens_out: 3000, wall_s: 300, tool_calls: 15 },
        d: { solved: false, excluded: true, tokens_out: 0, wall_s: 10, tool_calls: 0 },   // OVERFLOW-like
    };
    const all = qualityMetricsFor(tasks, null);
    assert.strictEqual(all.scored, 3, 'the excluded task leaves the denominator');
    assert.strictEqual(all.excluded, 1);
    assert.strictEqual(all.solved, 2);
    assert.ok(Math.abs(all.solveRate - 2 / 3) < 1e-9);
    assert.strictEqual(all.tokensPerSolve, 2000, 'per-solve cost uses only solved tasks');

    const common = qualityMetricsFor(tasks, new Set(['a', 'b']));
    assert.strictEqual(common.scored, 2);
    assert.strictEqual(common.solved, 1);
    assert.strictEqual(common.solveRate, 0.5, 'restricted rate is recomputed, not filtered after the fact');
    assert.strictEqual(common.tokensPerSolve, 1000);
});

test('every Models-tab browser module evaluates without throwing', async (t) => {
    // A module that throws on load does not fail loudly in a browser -- the feature is just
    // silently absent. Copy the ui/ tree somewhere Node will treat as ESM, stub the two globals
    // these modules touch at load time, and import each entry point.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-eval-'));
    t.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });
    fs.cpSync(path.join(__dirname, '..', 'ui'), path.join(tmp, 'ui'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'package.json'), JSON.stringify({ type: 'module' }));

    const listeners = [];
    const el = () => null;
    globalThis.document = { getElementById: el, querySelector: el, querySelectorAll: () => [], createElement: () => ({ classList: { add() {}, remove() {}, toggle() {} }, addEventListener() {}, append() {} }), addEventListener() {} };
    globalThis.window = { addEventListener: (k) => listeners.push(k), dispatchEvent() {}, Chart: undefined };
    globalThis.localStorage = { getItem: () => null, setItem() {}, removeItem() {} };
    globalThis.fetch = async () => ({ ok: false, status: 404, text: async () => '', json: async () => ({}) });
    t.after(() => { delete globalThis.document; delete globalThis.window; delete globalThis.localStorage; delete globalThis.fetch; });

    for (const entry of ['ui/shared/leaderboard.js', 'ui/models/charts.js', 'ui/models/detail.js',
        'ui/models/index.js', 'ui/leaderboards/index.js', 'ui/benchmarks/board.js', 'ui/modelpicker/index.js']) {
        const mod = await import(`file://${path.join(tmp, entry)}`);
        assert.ok(mod && typeof mod === 'object', `${entry} imported`);
    }
    // The modules that wire themselves up must do so through events, not by running work at load
    assert.ok(listeners.includes('suite:finished'), 'ui/leaderboards listens for finished suite runs');
});

test('every arbitrary-value Tailwind class the UI uses actually exists in the CSS', () => {
    // vendor/tailwind.css is a STATIC build. Arbitrary-value utilities (max-w-[860px],
    // aspect-square, max-h-[380px]) are JIT-only, so they are simply absent and the class
    // silently does nothing -- the markup looks correct and the page ignores it. Three separate
    // attempts to stop the Models cards spanning an ultrawide failed that way before anyone
    // thought to check the stylesheet. index.html carries a hand-written block for these; this
    // test is what keeps it in sync with the markup.
    const root = path.join(__dirname, '..');
    const css = fs.readFileSync(path.join(root, 'vendor', 'tailwind.css'), 'utf-8')
        + fs.readFileSync(path.join(root, 'index.html'), 'utf-8');
    const used = new Set();
    const walk = (dir) => {
        for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
            const p = path.join(dir, d.name);
            if (d.isDirectory()) { walk(p); continue; }
            if (!d.name.endsWith('.js')) continue;
            const src = fs.readFileSync(p, 'utf-8');
            for (const m of src.matchAll(/class="([^"]*)"/g)) {
                for (const tok of m[1].split(/\s+/)) {
                    // only the bracket utilities: everything else is in the vendor build already
                    if (/\[[^\]]+\]/.test(tok) && !tok.includes('${')) used.add(tok.replace(/^[a-z-]+:/, ''));
                }
            }
        }
    };
    walk(path.join(root, 'ui'));
    const missing = [...used].filter((t) => !css.includes(t) && !css.includes(t.replace(/([[\]/.])/g, '\\$1')));
    assert.deepEqual(missing, [], `arbitrary-value classes with no CSS rule (add them to index.html): ${missing.join(', ')}`);
});

test('every model detail page renders without throwing', async (t) => {
    // The module-evaluates test does not catch a ReferenceError inside a template literal, because
    // the template only runs when something renders it. `th` was used in the by-configuration
    // table and never imported; nothing failed until a page was actually opened. This renders the
    // quality tab for every model that has one.
    const models = require(path.join(__dirname, '..', 'lib', 'models.js'));
    // Earlier tests point PATHS at fixtures and restore with configure({}); do the same so this
    // one reads the real corpus regardless of what ran before it.
    models.configure({});
    const cat = models.listModels();
    const mk = (id) => ({ id, innerHTML: '', textContent: '', dataset: {}, style: {},
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        addEventListener() {}, append() {}, appendChild() {}, prepend() {}, remove() {}, setAttribute() {}, querySelector: (s) => mk(s), querySelectorAll: () => [],
        closest: () => mk('c'), insertAdjacentHTML() {}, getContext: () => null });
    globalThis.document = { getElementById: (id) => mk(id), querySelector: (s) => mk(s), querySelectorAll: () => [], createElement: () => mk('c') };
    globalThis.window = { addEventListener() {}, Chart: undefined };
    t.after(() => { delete globalThis.document; delete globalThis.window; });
    const { renderDetail } = await import(`file://${path.join(__dirname, '..', 'ui', 'models', 'detail.js')}`);
    const withQuality = cat.models.filter((x) => x.counts.qualityTasks > 0);
    if (!withQuality.length) { t.skip('no codebench results on this machine'); return; }
    for (const x of withQuality) {
        const d = models.getModel(x.key);
        for (const view of ['speed', 'quality', 'history', 'sources']) {
            assert.doesNotThrow(() => renderDetail(mk('root'), d, { view, onBack() {}, openBattery() {} }),
                `${x.display} / ${view}`);
        }
    }
});

test('denominators never include excluded rows, and every scoring path agrees', () => {
    // Terse-Coder read 9/12 with a single failure: two PROVIDER_ERROR rows were sitting in the
    // bottom of a fraction they had been excluded from, and the per-task map disagreed with
    // aggregateQuality by two tasks on the same data (8/9 vs 10/11) because one took its numbers
    // from the latest run and the other from the fold. One task was `excluded: true` AND
    // `solved: true` at once.
    const models = require(path.join(__dirname, '..', 'lib', 'models.js'));
    models.configure({});
    const cat = models.listModels();
    const withQuality = cat.models.filter((x) => x.counts.qualityTasks > 0);
    if (!withQuality.length) { return; }
    const EX = ['OVERFLOW', 'KILLED', 'PROVIDER_ERROR', 'ABORTED', 'CAP_TOO_LOW', 'HARNESS_ERROR', 'CONTAMINATED', 'TASK_INVALID', 'CUTOFF'];   // = lib/models.js EXCLUDED_STATUS
    const SC = ['pass', 'pass*', 'TIMEOUT', 'fail'];
    const near = (a, b) => Math.abs(a - b) < 1e-3;   // the aggregate stores credit to 3 decimals (17.333 for 17 1/3)
    for (const x of withQuality) {
        const q = x.quality, tasks = x.tasks || {};
        // 1. no row is excluded and solved at the same time
        for (const [id, t] of Object.entries(tasks)) {
            assert.ok(!(t.excluded && t.solved), `${x.display}/${id}: excluded and solved at once`);
        }
        // 2. the counts' scored half sums to `scored`, the excluded half to `excluded`
        const sumSc = SC.reduce((a, k) => a + (q.counts[k] || 0), 0);
        const sumEx = EX.reduce((a, k) => a + (q.counts[k] || 0), 0);
        assert.ok(near(sumSc, q.scored), `${x.display}: counts scored ${sumSc} != scored ${q.scored}`);
        assert.ok(near(sumEx, q.excluded), `${x.display}: counts excluded ${sumEx} != excluded ${q.excluded}`);
        // 3. the task map and the aggregate agree
        let sc = 0, so = 0, ex = 0;
        for (const t of Object.values(tasks)) {
            if (t.excluded) { ex++; continue; }
            sc++; if (t.solved) so += (t.credit != null ? t.credit : 1);
        }
        assert.ok(near(so, q.solved) && sc === q.scored && ex === q.excluded,
            `${x.display}: task map ${so}/${sc} (${ex} excl) vs aggregate ${q.solved}/${q.scored} (${q.excluded} excl)`);
        // 4. solved can never exceed scored, and scored never exceeds attempted
        assert.ok(q.solved <= q.scored + 1e-9 && q.scored <= q.attempted, `${x.display}: impossible totals`);
    }
});

// ---------------------------------------------------------------- Strata variants, running rows, hidden rows (2026-10-07)
const IQ3 = '/home/kyle/AI/Strata-data/models/IQ3_XXS/Qwen3.8-Flash-Next-GSQ-RCO-IQ3_XXS-00001-of-00002.gguf';
const CODER = '/home/kyle/AI/Strata-data/models/coder-IQ1_M/Qwen3.8-Flash-Next-GSQ-RCO-IQ1_M-00001-of-00002.gguf';
const ORCA = '/data/models/Orca-Flash-Next-Uncensored/Qwen3.8-Flash-Next-Uncensored-IQ3_XXS-00001-of-00002.gguf';
const serve = (dir, cfg) => `/home/kyle/AI/${dir}/queue-serve.sh /home/kyle/AI/${dir}/${cfg}.json`;

test('Strata variants: the stock configs are no variant; a projection or another template is its own; the engine version is a build, not a variant', () => {
    const v = (model_path, build_info, cmd) => M.strataVariant({ server: { model_path, build_info, n_ctx: 131072 } }, cmd);
    // stock, in every form the existing rows hold: no queue item at all, the old unversioned dir, 0.1.30, and the
    // context / KV / memory names -- none of which may split a row that was whole
    assert.strictEqual(v(IQ3, 'Strata 0.1.32', undefined), null);
    assert.strictEqual(v(IQ3, 'Strata 0.1.30', serve('Strata', 'strata-iq3_xxs')), null);
    assert.strictEqual(v(IQ3, 'Strata 0.1.32', serve('Strata-0.1.32', 'strata-iq3_xxs')), null);
    for (const c of ['strata-coder-iq1_m', 'strata-coder-iq1_m-128k-int8', 'strata-coder-iq1_m-1m-int8', 'strata-coder-iq1_m-512k', 'strata-coder-iq1_m-262k-q4']) assert.strictEqual(v(CODER, 'Strata 0.1.32', serve('Strata-0.1.32', c)), null, c);
    for (const c of ['strata-orca-iq3_xxs', 'strata-orca-iq3_xxs-resident', 'strata-orca-iq3_xxs-ram44']) assert.strictEqual(v(ORCA, 'Strata 0.1.32', serve('Strata-0.1.32', c)), null, c);
    // the variants
    assert.deepStrictEqual(v(IQ3, 'Strata 0.1.32', serve('Strata-0.1.32', 'strata-iq3_xxs-esp')), { keys: ['esp'], bits: ['projection on'] });
    assert.deepStrictEqual(v(ORCA, 'Strata 0.1.32', serve('Strata-0.1.32', 'strata-orca-iq3_xxs-resident-unslothtpl')), { keys: ['unslothtpl'], bits: ['regular chat template'] });
    // a later engine with the stock config is the SAME model row (the version is the `build` facet: off for quality, on for speed)
    assert.strictEqual(v(IQ3, 'Strata 0.1.40.3', serve('Strata-0.1.40.3', 'strata-iq3_xxs')), null);
    assert.strictEqual(v(IQ3, 'Strata 0.1.40.3', undefined), null);
    assert.deepStrictEqual(v(IQ3, undefined, serve('Strata-0.1.40.3', 'strata-iq3_xxs-esp')), { keys: ['esp'], bits: ['projection on'] }, 'the projection on a later engine is still the projection row');
    const d32 = M.runDescriptor({ dir: 'a', config: { runner: 'opencode' }, server: { model_path: IQ3, build_info: 'Strata 0.1.32', n_ctx: 131072 } }, 'local', 'k').facets;
    const d40 = M.runDescriptor({ dir: 'b', config: { runner: 'opencode' }, server: { model_path: IQ3, build_info: 'Strata 0.1.40.3', n_ctx: 131072 } }, 'local', 'k').facets;
    const pick = (f, ks) => JSON.stringify(ks.map((k) => f[k]));
    assert.strictEqual(pick(d32, ['weights', 'harness', 'context', 'output', 'kv', 'other']), pick(d40, ['weights', 'harness', 'context', 'output', 'kv', 'other']), 'quality facets: the same row');
    assert.notStrictEqual(pick(d32, ['build']), pick(d40, ['build']), 'the build facet (speed rows; the "engine version" chip) tells them apart');
    // the same for llama.cpp: another build dir / commit of an otherwise identical launch
    const ll = (bin, info) => M.runDescriptor({ dir: 'c', config: { runner: 'opencode', timeout_s: 7200 }, server: { model_path: '/m/q4.gguf', n_ctx: 131072, build_info: info, launch_command: `${bin} -m /m/q4.gguf -c 131072 --jinja --cache-type-k q8_0 --cache-type-v q8_0` } }, 'local', 'k');
    const b1 = ll('/a/llama.cpp/build-all/bin/llama-server', 'b10499-6d0549831'), b2 = ll('/a/llama.cpp-moecache/build-all/bin/llama-server', 'b10600-0123abc');
    assert.strictEqual(b1.identity('quality'), b2.identity('quality'));
    assert.notStrictEqual(b1.identity('full'), b2.identity('full'));
    // a variant nobody named yet still gets its own row, shown as written
    assert.deepStrictEqual(v(IQ3, 'Strata 0.1.32', serve('Strata-0.1.32', 'strata-iq3_xxs-steer2')), { keys: ['steer2'], bits: ['steer2'] });
    // not Strata at all
    assert.strictEqual(M.strataVariant({ server: { model_path: '/m/q4.gguf', build_info: 'b10499-6d0549831' } }, '/bin/llama-server -m /m/q4.gguf -c 131072'), null);
    // folded into the model's identity like thinking-off: own key, own name
    const c = M.withLocalVariant(M.canonicalModel({ model_path: IQ3 }), { config: { runner: 'opencode' }, server: { model_path: IQ3, build_info: 'Strata 0.1.32' } }, null, serve('Strata-0.1.32', 'strata-iq3_xxs-esp'));
    assert.strictEqual(c.key, 'local:qwen3.8-flash-next-gsq-rco:iq3-xxs~esp');
    assert.match(c.display, /IQ3_XXS \(projection on\)$/);
    assert.strictEqual(M.withLocalVariant(M.canonicalModel({ model_path: IQ3 }), { config: { runner: 'opencode' }, server: { model_path: IQ3, build_info: 'Strata 0.1.32' } }, null, serve('Strata-0.1.32', 'strata-iq3_xxs')).key, 'local:qwen3.8-flash-next-gsq-rco:iq3-xxs');
});

test('catalog: a Strata battery with a config variant files under its own row, the stock row keeps the rest (every engine version); never-identified models with nothing scored are left out', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'models-rows-'));
    fs.mkdirSync(path.join(tmp, 'cbroot', 'results'), { recursive: true }); fs.mkdirSync(path.join(tmp, 'cbroot', 'tasks'), { recursive: true });
    t.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); M.configure({}); });
    const cfg = (model) => ({ runner: 'opencode', model, prompt_level: 'L2', harness_mode: 'agentic', timeout_s: 7200 });
    const strata = (dir, build) => ({ dir, ended: 1, config: cfg('llama-local/local-128k'), server: { model_path: IQ3, build_info: build, n_ctx: 131072 } });
    const row = (task, status) => ({ task, status, solved: status === 'pass', wall_s: 100, tokens_out: 10, tool_calls: 1 });
    const rows = {
        'iq3-early': [row('a', 'pass')], 'iq3-queued': [row('b', 'fail')], 'esp-battery': [row('a', 'fail'), row('b', 'pass')], 'smoke-0403': [row('a', 'pass')],
        'junk-all-excluded': [row('a', 'OVERFLOW'), row('b', 'KILLED')], 'unknown-but-scored': [row('a', 'fail')],
    };
    M.configure({
        paths: { csv: path.join(tmp, 'none.csv'), bestConfigs: path.join(tmp, 'none.md'), benchLog: path.join(tmp, 'none.log'), sweepState: path.join(tmp, 'none.json'),
            codebenchRoot: path.join(tmp, 'cbroot'), dashboardConfig: path.join(tmp, 'nope.json') },
        codebench: {
            listRuns: () => [strata('iq3-early', 'Strata 0.1.30'), strata('iq3-queued', 'Strata 0.1.32'), strata('esp-battery', 'Strata 0.1.32'), strata('smoke-0403', 'Strata 0.1.40.3'),
                { dir: 'junk-all-excluded', ended: 1, config: cfg('llama-local/local-999k'), server: null }, { dir: 'unknown-but-scored', ended: 1, config: cfg('llama-local/local-998k'), server: null }],
            getRun: (dir) => ({ rows: rows[dir] || [] }),
        },
        queueLaunch: new Map([['iq3-queued', serve('Strata-0.1.32', 'strata-iq3_xxs')], ['esp-battery', serve('Strata-0.1.32', 'strata-iq3_xxs-esp')]]),
    });
    const list = M.listModels();
    const dirs = Object.fromEntries(list.models.map((m) => [m.key, m.batteries.map((b) => b.dir).sort()]));
    assert.deepStrictEqual(dirs['local:qwen3.8-flash-next-gsq-rco:iq3-xxs'], ['iq3-early', 'iq3-queued', 'smoke-0403'], 'the stock row: no item, an old engine, the stock config, a later engine');
    assert.deepStrictEqual(dirs['local:qwen3.8-flash-next-gsq-rco:iq3-xxs~esp'], ['esp-battery']);
    assert.strictEqual(Object.keys(dirs).filter((k) => /strata-0/.test(k)).length, 0, 'no row per engine version');
    assert.match(list.models.find((m) => m.key.endsWith('~esp')).display, /\(projection on\)$/);
    // hidden: not identified AND nothing scored; an unidentified model with a real answer stays
    assert.strictEqual(dirs['unresolved:local-999k'], undefined);
    assert.deepStrictEqual(dirs['unresolved:local-998k'], ['unknown-but-scored']);
    assert.ok(!M.listLeaderboards().quality.some((r) => r.modelKey === 'unresolved:local-999k'));
    assert.ok(M.listLeaderboards().quality.some((r) => r.modelKey === 'unresolved:local-998k'));
    assert.strictEqual(M.getModel('unresolved:local-999k').key, 'unresolved:local-999k', 'nothing is deleted: a direct link still answers');
});

// 2026-10-13: the plan-only first stage of a two-stage experiment scores as fails by design and was in the public
// catalog. dashboard.config.json `internalRowVariants` names the row variants that are working material.
test('internalRowVariants (dashboard.config.json): such rows are in no catalog, board, task page or model page; the data is untouched', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'models-internal-'));
    fs.mkdirSync(path.join(tmp, 'cbroot', 'results'), { recursive: true }); fs.mkdirSync(path.join(tmp, 'cbroot', 'tasks'), { recursive: true });
    t.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); M.configure({}); });
    const Q4 = '/m/Qwen3.8-27B-UD-Q4_K_XL.gguf';
    const cfgFile = path.join(tmp, 'dashboard.config.json');
    const cfg = (runner = 'opencode') => ({ runner, model: 'llama-local/qwen38-27b-q4-128k', prompt_level: 'L2', harness_mode: 'agentic', timeout_s: 7200 });
    const run = (dir, runner) => ({ dir, ended: 1, config: cfg(runner), server: { model_path: Q4, build_info: 'b10499-6d0549831', n_ctx: 131072 } });
    const row = (task, status, wall) => ({ task, status, solved: status === 'pass', wall_s: wall, tokens_out: 10, tool_calls: 1 });
    const rows = { main: [row('a', 'pass', 100), row('b', 'pass', 100)], plan: [row('a', 'fail', 900), row('b', 'pass', 10)], 'plan-tau': [row('a', 'fail', 900)], tensor: [row('a', 'pass', 50)] };
    const cmd = '/a/llama.cpp/build-all/bin/llama-server -m ' + Q4 + ' -c 131072 -dev ROCm0';
    const configure = () => M.configure({
        paths: { csv: path.join(tmp, 'none.csv'), bestConfigs: path.join(tmp, 'none.md'), benchLog: path.join(tmp, 'none.log'), sweepState: path.join(tmp, 'none.json'),
            codebenchRoot: path.join(tmp, 'cbroot'), dashboardConfig: cfgFile },
        codebench: { listRuns: () => [run('main'), run('plan'), run('plan-tau', 'tau'), run('tensor')], getRun: (dir) => ({ rows: rows[dir] || [] }) },
        queueLaunch: new Map([['main', cmd], ['plan', cmd + ' #row-variant=plan-only-stage'], ['plan-tau', cmd + ' #row-variant=Plan-Only-Stage'], ['tensor', cmd + ' #row-variant=tensor-split-two-xtx']]),
    });
    const BASE = 'local:qwen3.8-27b:q4-k-xl', PLAN = BASE + '~rv:plan-only-stage', TENSOR = BASE + '~rv:tensor-split-two-xtx';
    const keys = () => M.listModels().models.map((m) => m.key).sort();
    // no list (and no config file at all): every row, as before
    configure();
    const all = keys();
    assert.ok(all.includes(PLAN) && all.includes(TENSOR) && all.includes(BASE), all.join(' '));
    const planTau = all.find((k) => k.startsWith(PLAN + '~'));
    assert.ok(planTau, 'another harness on the same variant is its own row: the variant is not the last part of its key');
    const relBefore = M.listModels().models.find((m) => m.key === BASE).configs.map((c) => c.agg.relSolveTime);
    // listed: the variant's rows -- every one of them -- are gone from the catalog and from what is built from it
    fs.writeFileSync(cfgFile, JSON.stringify({ internalRowVariants: ['plan-only-stage', 'not a slug!', 7] }));
    configure();
    assert.deepStrictEqual(keys(), [BASE, TENSOR].sort());
    assert.ok(!JSON.stringify(M.listModels()).includes('plan-only-stage'), 'no key, display text or battery of it anywhere in the catalog');
    assert.ok(!M.listLeaderboards().quality.some((r) => String(r.modelKey).includes('rv:plan-only-stage')));
    assert.ok(!JSON.stringify(M.taskHistory()).includes('plan-only-stage'));
    assert.strictEqual(M.getModel(PLAN), null, 'no page: this is what the public site asks');
    assert.strictEqual(M.getModel(planTau), null);
    assert.strictEqual(M.getModel(PLAN, { includeInternal: true }).key, PLAN, 'the lab can still open it on purpose');
    assert.strictEqual(M.getModel(TENSOR).key, TENSOR, 'a row variant that is not listed is a row like any other');
    // a hidden row is nobody's peer: its 10 s solve of `b` no longer shapes the visible rows' relative solve time
    const relAfter = M.listModels().models.find((m) => m.key === BASE).configs.map((c) => c.agg.relSolveTime);
    assert.notDeepStrictEqual(relAfter, relBefore);
    assert.deepStrictEqual([M.isInternalRow(PLAN), M.isInternalRow(planTau), M.isInternalRow(TENSOR), M.isInternalRow(BASE + '~rv:plan-only-stage-2')], [true, true, false, false]);
    // the list is read from the file as it is now
    fs.writeFileSync(cfgFile, JSON.stringify({ internalRowVariants: [] }));
    configure();
    assert.ok(keys().includes(PLAN));
});

test('reliabilityNotes (dashboard.config.json): a machine\'s hardware notes come from its config, none are built in', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'models-rel-'));
    t.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); M.configure({}); });
    const cfgFile = path.join(tmp, 'dashboard.config.json');
    const paths = { csv: path.join(tmp, 'none.csv'), bestConfigs: path.join(tmp, 'none.md'), benchLog: path.join(tmp, 'none.log'), sweepState: path.join(tmp, 'none.json'),
        codebenchRoot: path.join(tmp, 'cbroot'), dashboardConfig: cfgFile };
    const stub = { listRuns: () => [], getRun: () => ({ rows: [] }) };
    M.configure({ paths, codebench: stub });
    assert.deepStrictEqual(M.reliabilityNotes({ devices: 'Vulkan0,Vulkan1' }), [], 'no config: no note about anyone\'s card');
    fs.writeFileSync(cfgFile, JSON.stringify({ reliabilityNotes: [{ id: 'v', devicesMatch: 'Vulkan', note: ' device-lost under load ' }, { devicesMatch: '(', note: 'bad pattern' }, { devicesMatch: 'CUDA' }, 'junk',
        { id: 'two', devicesMatch: '^CUDA0,CUDA1$', note: 'the enclosure link drops' }] }));
    M.configure({ paths, codebench: stub });
    assert.deepStrictEqual(M.reliabilityNotes({ devices: 'Vulkan0' }), ['device-lost under load']);
    assert.deepStrictEqual(M.reliabilityNotes({ devices: 'ROCm0,vulkan1' }), ['device-lost under load'], 'case-insensitive, anywhere in the list: the rule the built-in note had');
    assert.deepStrictEqual(M.reliabilityNotes({ devices: 'CUDA0,CUDA1' }), ['the enclosure link drops']);
    assert.deepStrictEqual([M.reliabilityNotes({ devices: 'ROCm0,CUDA0' }), M.reliabilityNotes(null), M.reliabilityNotes({})], [[], [], []]);
    // build ids: a build path written with ~ or a root is the same build
    fs.writeFileSync(cfgFile, JSON.stringify({ pathRoots: { LLAMA: '/opt/llama' }, llamaServerBuilds: [{ id: 'a', path: '/x/build/bin/llama-server' }, { id: 'b', path: '${LLAMA}/build-b/bin/llama-server' }] }));
    M.configure({ paths, codebench: stub });
    assert.deepStrictEqual([M.buildIdFor('/x/build/bin/llama-bench'), M.buildIdFor('/opt/llama/build-b/bin/llama-server'), M.buildIdFor('/nope/bin/llama-server'), M.buildIdFor(null)], ['a', 'b', null, null]);
});

test('a running battery is described as the row its results will be filed under, from its launch alone', () => {
    const cfg = { runner: 'opencode', model: 'llama-local/local-80k', prompt_level: 'L2', harness_mode: 'agentic', timeout_s: 7200, effort: null, scaffold: null, network: 'on' };
    const battery = (o = {}) => ({ runner: 'opencode', model: 'llama-local/local-80k', timeout_s: 7200, config: cfg, ...o });
    const quality = (facets) => JSON.stringify(['weights', 'harness', 'context', 'output', 'kv', 'other'].map((k) => [k, facets[k] ?? null]));
    // llama-server: the queue item's expanded command against what a result of the same launch records (plus --port)
    const IQ2 = '/data/models/Qwen3.8-27B-GSQ-RCO/Qwen3.8-27B-GSQ-RCO-IQ2_XS-mtp-f32ssm.gguf';
    const cmd = `/b/llama-server -m ${IQ2} -c 81920 -ngl 999 -fa on -np 1 --jinja --spec-type draft-mtp --cache-type-k q4_0 --cache-type-v q4_0 -dev CUDA0`;
    const live = M.describeRunning({ dir: 'new-battery', battery: battery() }, { model_path: IQ2, n_ctx: 81920, launch_command: cmd, launch_command_source: 'queue-item' });
    const storedRun = { dir: 'old-battery', config: cfg, server: { model_path: IQ2, n_ctx: 81920, launch_command: `${cmd} --port 18080`, build_info: 'b1' } };
    const storedModel = M.withLocalVariant(M.canonicalModel({ model_path: IQ2 }), storedRun, null);
    assert.strictEqual(live.modelKey, storedModel.key);
    assert.strictEqual(quality(live.facets), quality(M.runDescriptor(storedRun, 'local', storedModel.key).facets));
    // another context is another row
    const other = M.describeRunning({ dir: 'new-battery', battery: battery() }, { model_path: IQ2, n_ctx: 131072, launch_command: cmd.replace('81920', '131072') });
    assert.notStrictEqual(quality(other.facets), quality(live.facets));
    // Strata: a result records no launch command, so the running one carries none either -- and the variant is in the model
    const esp = M.describeRunning({ dir: 'esp-new', battery: battery({ model: 'llama-local/local-128k', config: { ...cfg, model: 'llama-local/local-128k' } }) },
        { model_path: IQ3, n_ctx: 131072, launch_command: serve('Strata-0.1.32', 'strata-iq3_xxs-esp'), engine: 'strata' });
    assert.strictEqual(esp.modelKey, 'local:qwen3.8-flash-next-gsq-rco:iq3-xxs~esp');
    assert.match(esp.display, /\(projection on\)$/);
    const storedEsp = { dir: 'esp-old', config: { ...cfg, model: 'llama-local/local-128k' }, server: { model_path: IQ3, build_info: 'Strata 0.1.32', n_ctx: 131072 } };
    assert.strictEqual(quality(esp.facets), quality(M.runDescriptor(storedEsp, 'local', esp.modelKey).facets));
    // cloud: the runner's model id (effort inside it for agy) -- no server at all
    const agy = M.describeRunning({ dir: 'agy-x', battery: { runner: 'agy', model: 'gemini-3.8-flash-low', timeout_s: 7200, config: { ...cfg, runner: 'agy', model: 'gemini-3.8-flash-low' } } }, null);
    assert.strictEqual(agy.modelKey, 'cloud:google:gemini-3.8-flash@low');
    // claude: effort and scaffold from battery.json, folded into the key as for a stored battery
    const haiku = M.describeRunning({ dir: 'haiku55-medium-solo-x', battery: { runner: 'claude', model: 'claude-haiku-5-5', timeout_s: 7200, config: { ...cfg, runner: 'claude', model: 'claude-haiku-5-5', effort: 'medium', scaffold: 'solo' } } }, null);
    assert.deepStrictEqual([haiku.modelKey, haiku.display], ['cloud:anthropic:claude-haiku-5-5@medium/solo', 'Claude Haiku 5.5 (medium, solo)']);
    assert.strictEqual(M.describeRunning({ dir: 'x', battery: {} }, null), null, 'nothing to go on: no row is invented');
});

test('modelDisplayNames (dashboard.config.json): a model is shown under another name; its key, slug and variant suffix are untouched', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'models-names-'));
    t.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); M.configure({}); });
    const cfgFile = path.join(tmp, 'dashboard.config.json');
    const paths = { csv: path.join(tmp, 'none.csv'), bestConfigs: path.join(tmp, 'none.md'), benchLog: path.join(tmp, 'none.log'), sweepState: path.join(tmp, 'none.json'),
        codebenchRoot: path.join(tmp, 'cbroot'), dashboardConfig: cfgFile };
    const stub = { listRuns: () => [], getRun: () => ({ rows: [] }) };
    M.configure({ paths, codebench: stub });   // no config file yet: named after the gguf, as always
    const plain = M.canonicalModel({ model_path: ORCA });
    assert.deepStrictEqual([plain.key, plain.display], ['local:qwen3.8-flash-next-uncensored:iq3-xxs', 'Qwen3.8-Flash-Next-Uncensored IQ3_XXS']);
    // by key: the full display text
    fs.writeFileSync(cfgFile, JSON.stringify({ modelDisplayNames: { 'local:qwen3.8-flash-next-uncensored:iq3-xxs': 'Orca Qwen3.8-Flash-Next-Uncensored IQ3_XXS', 'Qwen3.8-27B-Uncensored': 'Orca Qwen3.8-27B-Uncensored', 'local:not-a-string:q4': 7 } }));
    M.configure({ paths, codebench: stub });
    const c = M.canonicalModel({ model_path: ORCA });
    assert.deepStrictEqual([c.key, c.familySlug, c.display, c.family, c.quant], [plain.key, plain.familySlug, 'Orca Qwen3.8-Flash-Next-Uncensored IQ3_XXS', 'Orca Qwen3.8-Flash-Next-Uncensored', 'IQ3_XXS']);
    // the variant suffix is added after the name, the key after the key
    const v = M.withLocalVariant(c, { config: { runner: 'opencode' }, server: { model_path: ORCA, build_info: 'Strata 0.1.32' } }, null, serve('Strata-0.1.32', 'strata-orca-iq3_xxs-resident-unslothtpl'));
    assert.deepStrictEqual([v.key, v.display], ['local:qwen3.8-flash-next-uncensored:iq3-xxs~unslothtpl', 'Orca Qwen3.8-Flash-Next-Uncensored IQ3_XXS (regular chat template)']);
    // by family: every quant of it, the quant appended
    const f = M.canonicalModel('/data/models/Orca-Qwen3.8-27B-Uncensored/Qwen3.8-27B-Uncensored-Q4_K_M.gguf');
    assert.deepStrictEqual([f.key, f.display, f.family], ['local:qwen3.8-27b-uncensored:q4-k-m', 'Orca Qwen3.8-27B-Uncensored Q4_K_M', 'Orca Qwen3.8-27B-Uncensored']);
    assert.strictEqual(M.canonicalModel('/m/Qwen3.8-27B-Uncensored-Q6_K.gguf').display, 'Orca Qwen3.8-27B-Uncensored Q6_K');
    // everything else as filed; a config without the map (or without the file) changes nothing
    assert.strictEqual(M.canonicalModel({ model_path: IQ3 }).display, 'Qwen3.8-Flash-Next-GSQ-RCO IQ3_XXS');
    fs.writeFileSync(cfgFile, JSON.stringify({ llamaServerBuilds: [] }));
    M.configure({ paths, codebench: stub });
    assert.strictEqual(M.canonicalModel({ model_path: ORCA }).display, plain.display);
});

// Kyle, 2026-10-10: the large-context and sub-agent composite experiments "would be their own 'row'". Context and
// the opencode agent setup are facets inside a row, so the queue item declares it: CODEBENCH_ROW_VARIANT=<slug>.
test('a declared row variant (CODEBENCH_ROW_VARIANT on the queue item) files the battery under its own row', () => {
    const Q4 = '/m/Qwen3.8-27B-UD-Q4_K_XL.gguf';
    const run = { config: { runner: 'opencode' }, server: { model_path: Q4, build_info: 'b10499-6d0549831', n_ctx: 229376 } };
    const cmd = '/a/llama.cpp/build-all/bin/llama-server -m ' + Q4 + ' -c 229376 -dev ROCm0';
    const base = M.canonicalModel({ model_path: Q4 });
    assert.strictEqual(M.withLocalVariant(base, run, null, cmd).key, base.key, 'no marker: the main row, whatever the context');
    const big = M.withLocalVariant(base, run, null, cmd + ' #row-variant=ctx229k');
    assert.strictEqual(big.key, base.key + '~rv:ctx229k');
    assert.match(big.display, /\(229k context\)$/);
    const sub = M.withLocalVariant(base, run, null, cmd + ' #row-variant=subagents');
    assert.strictEqual(sub.key, base.key + '~rv:subagents');
    assert.match(sub.display, /\(sub-agents reminder in the system prompt\)$/);
    // an unnamed slug is shown as written; the marker does not disturb the Strata config-name rule
    assert.deepStrictEqual(M.rowVariant('x #row-variant=New-Thing'), { key: 'rv:new-thing', bit: 'New-Thing' });
    assert.strictEqual(M.rowVariant(cmd), null);
    const IQ1 = '/p/qwen3.8-flash-next-coder-gsq-rco-iq1_m.pack';
    const sv = M.strataVariant({ server: { model_path: IQ1, build_info: 'Strata 0.1.32' } }, '/home/k/AI/Strata-0.1.32/queue-serve.sh /home/k/AI/Strata-0.1.32/strata-coder-iq1_m-1m-int8.json #row-variant=ctx1m');
    assert.strictEqual(sv, null, 'a context-only Strata config is still the stock config; the row split comes from the marker');
});
