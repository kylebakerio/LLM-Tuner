'use strict';
// Scored launch recipes by their shape, not their device ids (lib/recipes.js, 2026-10-13), and the presets
// lib/queue.js builds from them. The first block is the recorded profiles: their output must stay the text the
// literal-id matchers produced.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const R = require('../lib/recipes');
const topo = require('../lib/topology');
const { createQueue } = require('../lib/queue');

const XTX = 'AMD Radeon RX 7900 XTX', R3060 = 'NVIDIA GeForce RTX 3060';
const dev = (id, description, totalMib) => ({ id, description, totalMib, freeMib: totalMib - 500 });
const TWO = topo.build({ detected: [dev('ROCm0', XTX, 24560), dev('ROCm1', XTX, 24560), dev('Vulkan0', XTX + ' (RADV NAVI31)', 24560), dev('Vulkan1', XTX + ' (RADV NAVI31)', 24560)], hostRamMib: 64200 });
const BUILDS = [{ id: 'next', path: '/b/next/llama-server' }, { id: 'all', path: '/b/all/llama-server' }];
const VARS_3060 = { STOCK: '/b/all/llama-server', D27MTP: '-ngl 999 -fa on -np 1 --jinja -dev ROCm0,CUDA0 -ts 3,1 --cache-type-k f16 --cache-type-v f16 --spec-type draft-mtp --spec-draft-n-max 2 -devd ROCm0' };
const VARS_TWOXTX = { STOCK: '/b/all/llama-server', D27MTP: '-ngl 999 -fa on -np 1 --jinja -dev ROCm0,ROCm1 -ts 1,1 --cache-type-k f16 --cache-type-v f16 --spec-type draft-mtp,ngram-mod --spec-draft-n-max 2 -devd ROCm0' };
const base = { build: 'all', modelPath: '/m/x.gguf', ctx: 131072, ngl: 999, fa: true, jinja: true, specType: 'draft-mtp', specDraftNMax: 2 };
// the two recorded shapes, exactly as logs/profiles.json holds them
const SPLIT = { ...base, ctx: 65536, cacheK: 'f16', cacheV: 'f16', specDraftDevice: 'ROCm0', devices: [{ id: 'ROCm0', name: XTX, share: 75 }, { id: 'CUDA0', name: R3060, share: 25 }] };
const ALONE = { ...base, cacheK: 'q8_0', cacheV: 'q8_0', specDraftDevice: 'ROCm0', devices: [{ id: 'ROCm0', name: XTX, share: 100 }], rawCommand: '/b/all/llama-server -m /m/x.gguf --port 8080' };

test('recorded recipes: the same text the literal-id matchers wrote', () => {
    const ctx = { vars: VARS_3060, builds: BUILDS };
    assert.deepStrictEqual(R.launchFor(SPLIT, ctx), { recipe: 'two-card-3-1', launchCmd: '$STOCK -m /m/x.gguf -c 65536 $D27MTP', warning: null });
    assert.deepStrictEqual(R.launchFor(ALONE, ctx), { recipe: 'single-card', warning: null,
        launchCmd: '$STOCK -m /m/x.gguf -c 131072 -ngl 999 -fa on --cache-type-k q8_0 --cache-type-v q8_0 --spec-type draft-mtp --spec-draft-n-max 2 -np 1 --spec-draft-device ROCm0 -dev ROCm0 --jinja' });
    // the stock build is the one `$STOCK` is, or the configured id; another build is not this recipe
    assert.strictEqual(R.stockBuildId(ctx), 'all');
    assert.strictEqual(R.stockBuildId({ vars: {}, builds: BUILDS }), null);
    assert.strictEqual(R.stockBuildId({ vars: {}, builds: BUILDS, stockBuild: 'next' }), 'next');
    assert.strictEqual(R.launchFor({ ...ALONE, build: 'next' }, ctx).recipe, 'raw');
    assert.strictEqual(R.launchFor({ ...ALONE, build: 'next' }, ctx).launchCmd, '/b/all/llama-server -m /m/x.gguf', 'host / port are the queue runner\'s');
    assert.deepStrictEqual(R.launchFor({ ...SPLIT, build: 'next' }, ctx), { recipe: null, launchCmd: '', warning: null });
    // what was never the recipe still is not: other KV types, no MTP, a third share
    assert.strictEqual(R.launchFor({ ...SPLIT, cacheK: 'q8_0' }, ctx).recipe, null);
    assert.strictEqual(R.launchFor({ ...ALONE, specType: 'ngram-mod', rawCommand: '' }, ctx).recipe, null);
    assert.strictEqual(R.launchFor({ ...SPLIT, devices: [{ id: 'ROCm0', name: XTX, share: 50 }, { id: 'CUDA0', name: R3060, share: 50 }] }, ctx).recipe, null);
});

test('the same shapes on other ids: a second identical card, another machine', () => {
    const ctx = { vars: VARS_TWOXTX, builds: BUILDS, topology: TWO };
    // the second of two identical cards alone: the recipe, with ITS id (the literal matcher knew only ROCm0)
    const second = R.launchFor({ ...ALONE, specDraftDevice: 'ROCm1', devices: [{ id: 'ROCm1', name: XTX, share: 100 }] }, ctx);
    assert.strictEqual(second.recipe, 'single-card');
    assert.match(second.launchCmd, / --spec-draft-device ROCm1 -dev ROCm1 --jinja$/);
    // a bare id is enough; the draft on another device is not this recipe
    assert.strictEqual(R.launchFor({ ...ALONE, specDraftDevice: 'CUDA1', devices: [{ id: 'CUDA1' }] }, ctx).recipe, 'single-card');
    assert.strictEqual(R.launchFor({ ...ALONE, specDraftDevice: 'ROCm0', devices: [{ id: 'ROCm1', name: XTX, share: 100 }] }, ctx).recipe, 'raw');
    // two cards 3:1 on two NVIDIA cards of another machine
    const other = R.launchFor({ ...SPLIT, specDraftDevice: 'CUDA0', devices: [{ id: 'CUDA0', name: 'NVIDIA GeForce RTX 4090', share: 75 }, { id: 'CUDA1', name: R3060, share: 25 }] }, { vars: {}, builds: BUILDS, stockBuild: 'all' });
    assert.deepStrictEqual([other.recipe, other.warning], ['two-card-3-1', null]);
    // one card under two backends is not "two cards"
    assert.strictEqual(R.launchFor({ ...SPLIT, devices: [{ id: 'ROCm0', share: 75 }, { id: 'Vulkan0', share: 25 }] }, ctx).recipe, null);
    assert.strictEqual(R.launchFor({ ...SPLIT, devices: [{ id: 'ROCm0', share: 75 }, { id: 'ROCm1', share: 25 }] }, ctx).recipe, 'two-card-3-1');
    // an RPC worker is not a local card
    assert.strictEqual(R.launchFor({ ...SPLIT, devices: [{ id: 'ROCm0', name: XTX, share: 75 }, { worker: 'laptop', share: 25 }] }, ctx).recipe, null);
});

test('$D27MTP is only said to be the profile\'s placement while it is', () => {
    // 2026-10-12: the variables file moved to ROCm0,ROCm1 1:1; the recorded 3:1 profile still matched and would have run that
    const r = R.launchFor(SPLIT, { vars: VARS_TWOXTX, builds: BUILDS });
    assert.strictEqual(r.launchCmd, '$STOCK -m /m/x.gguf -c 65536 $D27MTP', 'the text is unchanged');
    assert.match(r.warning, /^\$D27MTP now places a model on ROCm0,ROCm1 1:1, not on this profile's ROCm0,CUDA0 3:1/);
    assert.deepStrictEqual(R.placementOf(VARS_TWOXTX.D27MTP), { ids: ['ROCm0', 'ROCm1'], ts: [1, 1], draft: 'ROCm0' });
    assert.deepStrictEqual(R.placementOf("-dev 'CUDA0,CUDA1' --tensor-split 6,2"), { ids: ['CUDA0', 'CUDA1'], ts: [6, 2], draft: null });
    assert.strictEqual(R.launchFor({ ...SPLIT, specDraftDevice: 'CUDA0', devices: [{ id: 'CUDA0', share: 75 }, { id: 'CUDA1', share: 25 }] }, { vars: { STOCK: '/b/all/llama-server', D27MTP: '-dev CUDA0,CUDA1 -ts 6,2 -devd CUDA0' }, builds: BUILDS }).warning, null, '6:2 is 3:1');
});

test('laneFor: a profile confined to one card goes to that card\'s lane, when the config names one', () => {
    const map = { 'NVIDIA GeForce RTX 3060': 'local-3060' };
    const only = (d) => ({ devices: [d] });
    assert.strictEqual(R.laneFor(only({ id: 'CUDA0', name: R3060, share: 100 }), { laneByCard: map }), 'local-3060');
    assert.strictEqual(R.laneFor(only({ id: 'Vulkan0', name: 'NVIDIA GeForce RTX 3060 (NVK)', share: 100 }), { laneByCard: map }), 'local-3060', 'the card, under any id');
    assert.strictEqual(R.laneFor(only({ id: 'ROCm0', name: XTX, share: 100 }), { laneByCard: map }), 'local-gpu');
    assert.strictEqual(R.laneFor(SPLIT, { laneByCard: map }), 'local-gpu', 'two devices: not confined');
    assert.strictEqual(R.laneFor(only({ id: 'CUDA0', name: R3060 }), {}), 'local-gpu', 'nothing configured: no lane is assumed');
    // a bare id: by the topology's card for it, or by the id as written in the config
    assert.strictEqual(R.laneFor(only({ id: 'ROCm1' }), { laneByCard: { [XTX]: 'local-amd' }, topology: TWO }), 'local-amd');
    assert.strictEqual(R.laneFor(only({ id: 'CUDA0' }), { laneByCard: { CUDA0: 'local-3060' } }), 'local-3060');
    assert.strictEqual(R.laneFor(only({ id: 'CUDA0' }), { laneByCard: map }), 'local-gpu');
});

// --- lib/queue.js presets, end to end on fixture files (no live profiles, no live config) ---
test('queue presets: profiles, config and variables from files; portable paths; the lane from the config', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'recipes-test-'));
    try {
        fs.mkdirSync(path.join(dir, 'models'));
        fs.writeFileSync(path.join(dir, 'models', 'x.gguf'), 'gguf');
        fs.writeFileSync(path.join(dir, 'vars.env'), `STOCK=${dir}/all/llama-server\nD27MTP="-dev ROCm0,CUDA0 -ts 3,1 -devd ROCm0"\n`);
        fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ modelsRoot: path.join(dir, 'models'), pathRoots: { LLAMA: dir },
            llamaServerBuilds: [{ id: 'main', path: '${LLAMA}/all/llama-server' }], queue: { laneByCard: { [R3060]: 'local-3060' } } }));
        const cfg = (o) => ({ config: { ...base, build: 'main', cacheK: 'q8_0', cacheV: 'q8_0', ...o } });
        fs.writeFileSync(path.join(dir, 'profiles.json'), JSON.stringify({ version: 3, profiles: {
            'bench · A (one card)': cfg({ modelPath: '${MODELS}/x.gguf', specDraftDevice: 'ROCm1', devices: [{ id: 'ROCm1', name: XTX, share: 100 }] }),
            'bench · B (small card)': cfg({ modelPath: 'x.gguf', specDraftDevice: 'CUDA0', specType: 'ngram-mod', devices: [{ id: 'CUDA0', name: R3060, share: 100 }], rawCommand: '${LLAMA}/all/llama-server -m ${MODELS}/x.gguf --port 8080' }),
            'bench · C (no recipe)': cfg({ modelPath: '/nowhere/y.gguf', specType: 'ngram-mod', devices: [{ id: 'ROCm0', name: XTX, share: 100 }] }),
            'daily · not a bench profile': cfg({ devices: [{ id: 'ROCm0' }] }),
        } }));
        const q = createQueue({ dbPath: path.join(dir, 'bench.sqlite'), envFiles: [path.join(dir, 'vars.env')], profilesPath: path.join(dir, 'profiles.json'), configFile: path.join(dir, 'config.json'), topology: () => TWO });
        const p = Object.fromEntries(q.presets({ models: [] }).presets.map((x) => [x.label.slice(8, 9), x]));
        assert.deepStrictEqual(Object.keys(p).sort(), ['A', 'B', 'C']);
        // the stock build is found by its path ($STOCK), written with a root in the config
        assert.strictEqual(p.A.launch_cmd, `$STOCK -m ${dir}/models/x.gguf -c 131072 -ngl 999 -fa on --cache-type-k q8_0 --cache-type-v q8_0 --spec-type draft-mtp --spec-draft-n-max 2 -np 1 --spec-draft-device ROCm1 -dev ROCm1 --jinja`);
        assert.deepStrictEqual([p.A.lane, p.A.weights, p.A.weightsOk], ['local-gpu', `${dir}/models/x.gguf`, true]);
        // a relative model path is under modelsRoot; the raw command's roots are expanded; the lane is the card's
        assert.deepStrictEqual([p.B.lane, p.B.weightsOk, p.B.launch_cmd], ['local-3060', true, `${dir}/all/llama-server -m ${dir}/models/x.gguf`]);
        assert.deepStrictEqual([p.C.launch_cmd, p.C.note, p.C.weightsOk], ['', 'not a known recipe: fill in the launch command', false]);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
