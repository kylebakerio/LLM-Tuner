'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const strata = require('../lib/strata');

test('strata: merge and hasOverrides respect positive overrides', () => {
    assert.equal(strata.hasOverrides({ maxContext: 0 }), false);
    assert.equal(strata.hasOverrides({ maxContext: null }), false);
    assert.equal(strata.hasOverrides({ maxContext: '' }), false);
    assert.equal(strata.hasOverrides({ maxContext: 524288 }), true);
    assert.equal(strata.hasOverrides({ kvResident: 0 }), false);
    assert.equal(strata.hasOverrides({ kvResident: 32768 }), true);
    assert.equal(strata.hasOverrides({ spec: 0 }), false);
    assert.equal(strata.hasOverrides({ spec: 4 }), true);
});

test('strata: resolveLaunch generates command pointing to base when no overrides', () => {
    const base = '/home/kyle/AI/Strata-0.1.32/strata-coder-iq1_m-512k-int8.json';
    const res = strata.resolveLaunch(base, { maxContext: 0, kvResident: 0 });
    assert.equal(res.path, base);
    assert.ok(res.command.includes(base));
    assert.ok(res.command.includes('--port 8080'));
});

// --- installs as a list (2026-10-13): fixtures in a temp dir, no real Strata needed ---
const fs = require('fs');
const os = require('os');
const path = require('path');

function fakeInstall(root, name, files, { serve = true, versionFile = null } = {}) {
    const dir = path.join(root, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const [f, ctx] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), JSON.stringify({ exe: path.join(dir, 'engine', 'strata'), args: ['--max-context', String(ctx)], cwd: dir, port: 8080 }));
    if (serve) fs.writeFileSync(path.join(dir, 'queue-serve.sh'), '#!/bin/sh\n');
    if (versionFile) fs.writeFileSync(path.join(dir, 'VERSION'), versionFile);
    return dir;
}

test('strata installs: every configured install is listed, each config with its install and version', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-installs-'));
    const a = fakeInstall(root, 'Strata-0.1.32', { 'strata-iq3_xxs.json': 131072, 'strata-coder-iq1_m-1m-int8.json': 1048576, 'notes.json': 1 });
    const b = fakeInstall(root, 'Strata-0.1.43.1', { 'strata-iq3_xxs.json': 131072, 'strata-iq3_xxs-2gpu-split27-trim-pw2.json': 131072 });
    const c = fakeInstall(root, 'strata-nightly', { 'strata-x.json': 4096 }, { versionFile: 'v0.2.0-rc1 (abc123)\n' });
    try {
        strata.configure({ installs: [a, { dir: b, label: 'two-card build' }, c, a, path.join(root, 'gone')] });
        const ins = strata.installs({ env: {} });
        assert.deepEqual(ins.map((i) => [path.basename(i.dir), i.version, i.label]), [['Strata-0.1.32', '0.1.32', 'Strata 0.1.32'], ['Strata-0.1.43.1', '0.1.43.1', 'two-card build'], ['strata-nightly', '0.2.0-rc1', 'Strata 0.2.0-rc1'], ['gone', null, 'gone']]);
        assert.equal(ins[1].serveScript, path.join(b, 'queue-serve.sh'));
        const list = strata.listConfigs();
        // the two profiles the terminal client could not find: same file name in two installs, told apart by path
        assert.deepEqual(list.filter((x) => x.name === 'strata-iq3_xxs.json').map((x) => [x.path, x.version]), [[path.join(a, 'strata-iq3_xxs.json'), '0.1.32'], [path.join(b, 'strata-iq3_xxs.json'), '0.1.43.1']]);
        const two = list.find((x) => x.path === path.join(b, 'strata-iq3_xxs-2gpu-split27-trim-pw2.json'));
        assert.deepEqual([two.install, two.version, two.maxContext], [b, '0.1.43.1', '131072']);
        assert.equal(list.length, 5, 'strata-*.json only; a missing install lists nothing');
        // the fields older readers use are still there
        assert.deepEqual(Object.keys(list[0]).slice(0, 3), ['path', 'name', 'maxContext']);
        assert.equal(strata.STRATA_DIR, a);
        assert.equal(strata.SERVE_SCRIPT, path.join(a, 'queue-serve.sh'));
        // one directory, as before
        assert.equal(strata.listConfigs(b).length, 2);
        // a launch uses the config's OWN install's launcher
        assert.equal(strata.resolveLaunch(two.path).command, `${path.join(b, 'queue-serve.sh')} ${two.path} --port 8080`);
    } finally { strata.configure(null); fs.rmSync(root, { recursive: true, force: true }); }
});

test('strata installs: STRATA_DIR is still honoured and comes first; no install = Strata simply absent', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-installs-'));
    const a = fakeInstall(root, 'Strata-0.1.32', { 'strata-a.json': 1 });
    const b = fakeInstall(root, 'Strata-9.9', { 'strata-b.json': 1 }, { serve: false });
    try {
        strata.configure({ installs: [a] });
        assert.deepEqual(strata.installs({ env: { STRATA_DIR: b } }).map((i) => i.version), ['9.9', '0.1.32']);
        strata.configure({ installs: [] });
        assert.deepEqual(strata.installs({ env: {} }), []);
        const none = strata.installs({ env: {} }).flatMap((i) => strata.listConfigs(i.dir));
        assert.deepEqual(none, []);
        // a config whose install has no launcher, on a machine with no install: a clear error, not a path to nowhere
        const saved = process.env.STRATA_DIR; delete process.env.STRATA_DIR;
        try {
            assert.equal(strata.STRATA_DIR, null);
            assert.throws(() => strata.resolveLaunch(path.join(b, 'strata-b.json')), /no Strata launcher \(queue-serve\.sh\) found/);
        } finally { if (saved !== undefined) process.env.STRATA_DIR = saved; }
    } finally { strata.configure(null); fs.rmSync(root, { recursive: true, force: true }); }
});

test('strata gpuIndexes: the GPUs a launch asks for, by position, as written', () => {
    const files = { '/x/one.json': '{"args":[],"gpu":0}', '/x/two.json': '{"args":[],"gpu":[0,1]}', '/x/none.json': '{"args":[]}', '/x/bad.json': 'not json' };
    const read = (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; };
    assert.deepEqual(strata.gpuIndexes(['/x/one.json', '--port', '8080'], read), [0]);
    assert.deepEqual(strata.gpuIndexes(['/x/two.json', '--port', '8080'], read), [0, 1]);
    assert.deepEqual(strata.gpuIndexes(['/x/two.json', '--gpu', '1'], read), [1], 'the command line wins over the file');
    assert.deepEqual(strata.gpuIndexes(['--gpu', '0,1,1,x,-2'], read), [0, 1]);
    assert.deepEqual([strata.gpuIndexes(['/x/none.json'], read), strata.gpuIndexes(['/x/bad.json'], read), strata.gpuIndexes(['/x/missing.json'], read), strata.gpuIndexes([], read)], [[], [], [], []]);
});

// --- 2026-10-17: the overrides the current best configs need (0.1.44.1 two-XTX: spec 3 / 0.7, pipeline windows 2,
// resident budget 40, gpu [0, 1] + layer split, STRATA_STAGE_TRIM / STRATA_HIP_ADAPT_KERNEL_COPY) ---
const BASE = () => ({
    exe: '/nonexistent/engine/strata', cwd: '/nonexistent/Strata-0.1.44.1', port: 8080, gpu: 0,
    args: ['--pack', '/p', '--spec', '4', '--spec-min-p', '0.5', '--max-context', '131072', '--kv', 'int8'],
    env: { STRATA_HIPBLASLT_TUNING: '/t.txt', STRATA_MTP_PREFILL_SYNC: '1' }, sampling: { temperature: 1, top_p: 0.95, top_k: 20 },
});
const arg = (cfg, f) => { const i = cfg.args.indexOf(f); return i === -1 ? null : cfg.args[i + 1]; };

test('strata merge: pipeline windows (0 is a value), resident budget, gpu, layer split', () => {
    assert.equal(strata.hasOverrides({ pipelineWindows: 0 }), true, '0 = off is an override, not blank');
    assert.equal(strata.hasOverrides({ pipelineWindows: '' }), false);
    assert.equal(strata.hasOverrides({ gpu: '' }), false);
    assert.equal(strata.hasOverrides({ gpu: '0,1' }), true);
    assert.equal(strata.hasOverrides({ residentBudgetGib: 40 }), true);
    assert.equal(strata.hasOverrides({ layerSplit: 'auto' }), true);
    const m = strata.merge(BASE(), { pipelineWindows: 2, residentBudgetGib: 40, gpu: '0,1', layerSplit: '27', spec: 3, specMinP: 0.7 });
    assert.deepEqual([arg(m, '--pipeline-windows'), arg(m, '--resident-budget-gib'), arg(m, '--spec'), arg(m, '--spec-min-p')], ['2', '40', '3', '0.7']);
    assert.deepEqual([m.gpu, m.layer_split], [[0, 1], '27']);
    assert.equal(arg(strata.merge(BASE(), { pipelineWindows: 0 }), '--pipeline-windows'), '0');
    // one card stays a number, as setup writes it; a list of one card too
    assert.equal(strata.merge(BASE(), { gpu: [1] }).gpu, 1);
    assert.equal(strata.merge(BASE(), { gpu: '1' }).gpu, 1);
    // nothing given: the file as it was
    assert.deepEqual(strata.merge(BASE(), {}), BASE());
});

test('strata merge: env switches on / off; KV types the engine takes (f16 read as fp16)', () => {
    const on = strata.merge(BASE(), { stageTrim: 'on', kernelCopy: true });
    assert.deepEqual([on.env.STRATA_STAGE_TRIM, on.env.STRATA_HIP_ADAPT_KERNEL_COPY], ['1', '1']);
    assert.equal(on.env.STRATA_HIPBLASLT_TUNING, '/t.txt', 'the other env entries stay');
    const off = strata.merge({ ...BASE(), env: { ...BASE().env, STRATA_STAGE_TRIM: '1', STRATA_HIP_ADAPT_KERNEL_COPY: '1' } }, { stageTrim: 'off', kernelCopy: '0' });
    assert.equal('STRATA_STAGE_TRIM' in off.env, false);
    assert.equal('STRATA_HIP_ADAPT_KERNEL_COPY' in off.env, false);
    assert.deepEqual(strata.merge(BASE(), { stageTrim: 'off' }), BASE(), 'off on a file without it changes nothing');
    assert.equal(arg(strata.merge(BASE(), { kv: 'f16' }), '--kv'), 'fp16');
    assert.equal(arg(strata.merge(BASE(), { kv: 'q4' }), '--kv'), 'q4_0');
    assert.deepEqual(strata.KV_TYPES, ['int8', 'fp16', 'q4_0', 'k8v4']);
});

test('strata overrideProblems: what the engine / server.py would refuse, said before a launch', () => {
    assert.deepEqual(strata.overrideProblems({ spec: 3, pipelineWindows: 2, gpu: '0,1', layerSplit: '27', stageTrim: 'on', kv: 'int8' }, BASE()), []);
    const p = (o, base = BASE()) => strata.overrideProblems(o, base).join(' | ');
    assert.match(p({ kv: 'bf16' }), /KV type "bf16"/);
    assert.match(p({ pipelineWindows: 3 }), /mode 0, 1 or 2/);
    assert.match(p({ residentBudgetGib: -1 }), /above 0/);
    assert.match(p({ gpu: 'ROCm0' }), /card numbers/);
    assert.match(p({ stageTrim: 'maybe' }), /on or off/);
    assert.match(p({ layerSplit: '1', gpu: '0,1' }), /rising from 2/);
    assert.match(p({ layerSplit: '16,32', gpu: '0,1' }), /2 number\(s\) for 2 cards/);
    assert.match(p({ layerSplit: '27' }, { ...BASE(), gpu: [0, 1, 2] }), /1 number\(s\) for 3 cards/, 'the base file\'s cards count when no gpu override');
    assert.equal(p({ layerSplit: 'auto', gpu: '0,1' }), '');
});

test('strata describe: what a config file sets, in the overrides\' names', () => {
    const d = strata.describe({ ...BASE(), gpu: [0, 1], layer_split: 'auto', args: [...BASE().args, '--pipeline-windows', '2', '--resident-budget-gib', '40'], env: { STRATA_STAGE_TRIM: '1', STRATA_HIP_ADAPT_KERNEL_COPY: '1' } });
    assert.deepEqual({ spec: d.spec, specMinP: d.specMinP, pipelineWindows: d.pipelineWindows, residentBudgetGib: d.residentBudgetGib, gpu: d.gpu, layerSplit: d.layerSplit, stageTrim: d.stageTrim, kernelCopy: d.kernelCopy, kv: d.kv, maxContext: d.maxContext, temperature: d.temperature },
        { spec: 4, specMinP: 0.5, pipelineWindows: 2, residentBudgetGib: 40, gpu: '0,1', layerSplit: 'auto', stageTrim: 'on', kernelCopy: 'on', kv: 'int8', maxContext: 131072, temperature: 1 });
    const one = strata.describe(BASE());
    assert.deepEqual([one.gpu, one.layerSplit, one.pipelineWindows, one.stageTrim, one.kernelCopy], ['0', null, null, 'off', 'off']);
});

test('strata resolveLaunch: derived copies are per install; a flag the config\'s engine lacks is refused; launcher THP-off is read', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-1017-'));
    const out = path.join(root, 'derived');
    const mk = (name, engineText, serveText) => {
        const dir = path.join(root, name);
        fs.mkdirSync(path.join(dir, 'engine'), { recursive: true });
        fs.writeFileSync(path.join(dir, 'engine', 'strata'), engineText);
        fs.writeFileSync(path.join(dir, 'queue-serve.sh'), serveText);
        const cfg = { ...BASE(), exe: path.join(dir, 'engine', 'strata'), cwd: dir };
        fs.writeFileSync(path.join(dir, 'strata-iq3_xxs.json'), JSON.stringify(cfg));
        return dir;
    };
    const old = mk('Strata-0.1.32', 'ELF ... --spec --kv ...', '#!/bin/bash\n# nothp would go here\nexec python serve/server.py "$@"\n');
    const neu = mk('Strata-0.1.44.1', 'ELF ... --spec --pipeline-windows --resident-budget-gib ...', '#!/bin/bash\nexec /x/Strata-0.1.44.1/nothp /venv/python serve/server.py "$@"\n');
    try {
        const a = strata.resolveLaunch(path.join(old, 'strata-iq3_xxs.json'), { spec: 3 }, { outDir: out });
        const b = strata.resolveLaunch(path.join(neu, 'strata-iq3_xxs.json'), { spec: 3, pipelineWindows: 2 }, { outDir: out });
        assert.notEqual(a.path, b.path, 'same file name in two installs: two copies');
        assert.equal(path.basename(b.path), 'strata-iq3_xxs.0.1.44.1.dash.json');
        assert.equal(b.config.log, path.join(out, 'strata-iq3_xxs.0.1.44.1.dash.log'));
        assert.ok(b.command.startsWith(path.join(neu, 'queue-serve.sh')), 'the config\'s own install\'s launcher');
        assert.throws(() => strata.resolveLaunch(path.join(old, 'strata-iq3_xxs.json'), { pipelineWindows: 2 }, { outDir: out }), /--pipeline-windows is not an option of this config's engine/);
        assert.throws(() => strata.resolveLaunch(path.join(neu, 'strata-iq3_xxs.json'), { gpu: '0,1', layerSplit: '16,32' }, { outDir: out }), /Strata overrides for strata-iq3_xxs\.json: layer split "16,32" has 2 number\(s\) for 2 cards/);
        const two = strata.resolveLaunch(path.join(neu, 'strata-iq3_xxs.json'), { gpu: '0,1', layerSplit: '27', stageTrim: 'on' }, { outDir: out });
        assert.deepEqual([two.config.gpu, two.config.layer_split, two.config.env.STRATA_STAGE_TRIM], [[0, 1], '27', '1']);
        // overrides that only repeat the file: the file itself is launched
        assert.equal(strata.resolveLaunch(path.join(neu, 'strata-iq3_xxs.json'), { spec: 4, kv: 'int8', gpu: '0' }, { outDir: out }).path, path.join(neu, 'strata-iq3_xxs.json'));
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
    // no flag check when the engine cannot be read (a config written for another machine): no refusal
    assert.equal(strata.engineHas('/nonexistent/strata', '--pipeline-windows'), null);
});

test('strata installs: thpOff from the launcher (a comment does not count); listConfigs carries each file\'s settings', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-thp-'));
    const a = fakeInstall(root, 'Strata-0.1.44.1', { 'strata-a.json': 262144 });
    const b = fakeInstall(root, 'Strata-0.1.43.1', { 'strata-a.json': 131072 });
    fs.writeFileSync(path.join(a, 'queue-serve.sh'), '#!/bin/bash\nexec /home/k/AI/Strata-0.1.44.1/nothp /venv/bin/python serve/server.py --engine strata --config "$cfg" "$@"\n');
    fs.writeFileSync(path.join(b, 'queue-serve.sh'), '#!/bin/bash\n# no nothp here (PR_SET_THP_DISABLE is 0.1.44.1 only)\nexec python serve/server.py "$@"\n');
    try {
        strata.configure({ installs: [{ dir: a, label: 'current' }, b] });
        assert.deepEqual(strata.installs({ env: {} }).map((i) => [i.version, i.thpOff]), [['0.1.44.1', true], ['0.1.43.1', false]]);
        const list = strata.listConfigs();
        assert.deepEqual(list.map((c) => [c.version, c.settings && c.settings.maxContext]), [['0.1.44.1', 262144], ['0.1.43.1', 131072]]);
    } finally { strata.configure(null); fs.rmSync(root, { recursive: true, force: true }); }
});

test('strata availabilityArgs: a profile\'s gpu override is the card list the availability check reads', () => {
    const files = { '/x/one.json': '{"args":[],"gpu":0}' };
    const read = (p) => { if (!(p in files)) throw new Error('ENOENT'); return files[p]; };
    assert.deepEqual(strata.availabilityArgs({ engine: 'strata', strataBase: '/x/one.json' }), ['/x/one.json']);
    assert.deepEqual(strata.gpuIndexes(strata.availabilityArgs({ engine: 'strata', strataBase: '/x/one.json' }), read), [0]);
    assert.deepEqual(strata.gpuIndexes(strata.availabilityArgs({ engine: 'strata', strataBase: '/x/one.json', gpu: '0,1' }), read), [0, 1]);
    assert.deepEqual(strata.gpuIndexes(strata.availabilityArgs({ engine: 'strata', strataBase: '/x/one.json', gpu: [1] }), read), [1]);
    assert.deepEqual(strata.availabilityArgs({}), []);
});

test('strata derived copies: the per-install name (<base>.<version>.dash.json) keys the same row variant as the base file', () => {
    const M = require('../lib/models');
    const run = { server: { model_path: '/x/Qwen3.8-Flash-Next-GSQ-RCO-IQ3_XXS-00001-of-00002.gguf' } };
    const v = (cmd) => JSON.stringify(M.strataVariant(run, cmd));
    const base = v('/h/Strata-0.1.43.1/queue-serve.sh /h/Strata-0.1.43.1/strata-iq3_xxs-2gpu-split27-trim-pw2.json');
    assert.equal(v('/h/Strata-0.1.44.1/queue-serve.sh /l/strata-dashboard/strata-iq3_xxs-2gpu-split27-trim-pw2.0.1.44.1.dash.json --port 18080'), base);
    assert.equal(v('/h/Strata-0.1.43.1/queue-serve.sh /l/strata-dashboard/strata-iq3_xxs-2gpu-split27-trim-pw2.dash.json'), base);
    assert.equal(M.strataVariant(run, '/h/Strata-0.1.44.1/queue-serve.sh /l/strata-iq3_xxs.0.1.44.1.dash.json'), null, 'no version digits as variant keys');
});
