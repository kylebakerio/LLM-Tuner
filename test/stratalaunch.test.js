// The Solve map's "Configs rolled up" card on a Strata row (2026-10-20, Kyle: hovering Flash-Next Q4_K_XL (Strata) read
// "launch flags not recorded" on almost every line). A Strata run has no llama-server launch command by design; the
// engine config file the queue item launched says how it ran. Display only: no row key moves.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const strata = require('../lib/strata');

async function loadLb() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'shared', 'leaderboard.js'), 'utf-8');
    const stub = 'data:text/javascript,' + encodeURIComponent(
        'export const esc=(s)=>String(s??"");export const fmtDur=(s)=>String(s);export const fmtN=(n)=>String(n);'
        + 'export const harnessLabel=(r)=>r||null;export const scaffoldBit=(r,s)=>s||null;'
        // the real context rule (ui/shared/ctxlabel.js, 2026-10-25): a stub never carries a copy of it
        + `import ${JSON.stringify(require('url').pathToFileURL(path.join(__dirname, '..', 'ui', 'shared', 'ctxlabel.js')).href)};export const { ctxLabel, commonWindow } = globalThis.CtxLabel;`);
    return import('data:text/javascript,' + encodeURIComponent(src.replace("from '../benchmarks/util.js'", `from '${stub}'`)));
}

// the shape of Strata 0.1.44.1's strata-ud-q4_k_xl-262k-int8-2xtx-pw2-kcopy-spec3-rb30-pdirect-iopf.json
const Q4KXL = {
    exe: '/x/engine/strata',
    args: ['--pack', '/x/packs/ud-q4_k_xl', '--native', '/data/models/Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00004.gguf', '--resident-budget-gib', '30',
        '--expert-cache', 'auto', '--spec', '3', '--spec-min-p', '0.7', '--max-context', '262144', '--kv', 'int8', '--pipeline-windows', '2'],
    backend: 'hip', sampling: { temperature: 1.0, top_p: 0.95, top_k: 20 },
    env: { STRATA_STAGE_TRIM: '1', STRATA_HIP_ADAPT_KERNEL_COPY: '1', STRATA_PROMPT_DIRECT: '1', STRATA_IO_PREFETCH: '1', STRATA_IO_STATS: '1' },
    gpu: [0, 1], layer_split: 'auto',
};

test('strata launchFacts: what a config file sets, no paths', () => {
    const f = strata.launchFacts(Q4KXL);
    assert.deepStrictEqual(f, {
        ctx: 262144, kv: 'int8', kvResident: null, gpus: [0, 1], layerSplit: 'auto', spec: 3, specMinP: 0.7, pipelineWindows: 2,
        residentBudgetGib: 30, rope: null, switches: ['stage trim', 'kernel copy', 'prompt direct', 'IO prefetch'],
        sampling: { temperature: 1, top_p: 0.95, top_k: 20 }, backend: 'hip' });
    assert.ok(!JSON.stringify(f).includes('/'), 'no path survives');
    const nopin = strata.launchFacts({ ...Q4KXL, env: { STRATA_RESIDENT_PIN: '0', STRATA_STAGE_TRIM: '0' }, gpu: 0 });
    assert.deepStrictEqual(nopin.switches, ['pageable RAM (no pin)'], 'a switch set to 0 is off');
    assert.deepStrictEqual([nopin.gpus, nopin.layerSplit], [[0], null]);
    const yarn = strata.launchFacts({ args: ['--rope-scaling', 'yarn', '--rope-scale', '2', '--kv-resident', '32768'] });
    assert.deepStrictEqual([yarn.rope, yarn.kvResident, yarn.sampling, yarn.gpus], ['yarn ×2', 32768, null, null]);
    assert.strictEqual(strata.launchFacts({}), null);
});

test('models.strataLaunchInfo: the exact file the queue item named; engine from the result; null for llama.cpp', () => {
    const M = require('../lib/models');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strata-launch-'));
    try {
        const base = path.join(dir, 'strata-ud-q4_k_xl-262k-int8-2xtx-pw2-kcopy-spec3-rb30-pdirect-iopf.json');
        fs.writeFileSync(base, JSON.stringify(Q4KXL));
        const cmd = `${dir}/Strata-0.1.44.1/queue-serve.sh ${base}`.replace(`${dir}/Strata`, '/home/k/AI/Strata');
        const srv = { build_info: 'Strata 0.1.44.1', model_path: '/data/models/x.gguf', n_ctx: 262144 };
        const si = M.strataLaunchInfo(cmd + ' #row-variant=foo', srv);
        assert.deepStrictEqual({ ...si, facts: undefined }, { engine: 'Strata 0.1.44.1', config: 'strata-ud-q4_k_xl-262k-int8-2xtx-pw2-kcopy-spec3-rb30-pdirect-iopf.json', derived: false, file: 'read', facts: undefined, editedSince: false });
        // a run older than the file: its settings are the file's NOW, and it says so
        const old = Date.now() - 86400e3;
        fs.utimesSync(base, new Date(), new Date());
        assert.strictEqual(M.strataLaunchInfo(cmd, srv, old).editedSince, true);
        assert.strictEqual(M.strataLaunchInfo(cmd, srv, Date.now() + 60e3).editedSince, false);
        assert.strictEqual(si.facts.residentBudgetGib, 30);
        assert.ok(!JSON.stringify(si).includes(dir), 'no path in what the catalog carries');
        // a dashboard-derived copy (GUI overrides): its own file is read, named after its base
        const dash = path.join(dir, 'strata-ud-q4_k_xl-262k-int8-2xtx.0.1.44.1.dash.json');
        fs.writeFileSync(dash, JSON.stringify({ ...Q4KXL, args: [...Q4KXL.args.slice(0, -2), '--pipeline-windows', '0'] }));
        const dsi = M.strataLaunchInfo(`/home/k/AI/Strata-0.1.44.1/queue-serve.sh ${dash}`, srv);
        assert.deepStrictEqual([dsi.config, dsi.derived, dsi.facts.pipelineWindows], ['strata-ud-q4_k_xl-262k-int8-2xtx.json', true, 0]);
        // the file is gone: named, settings unknown
        const gone = M.strataLaunchInfo(`/home/k/AI/Strata-0.1.44.1/queue-serve.sh ${dir}/strata-gone.json`, srv);
        assert.deepStrictEqual([gone.config, gone.file, gone.facts], ['strata-gone.json', 'missing', null]);
        // no queue item: the engine is still known
        assert.deepStrictEqual(M.strataLaunchInfo(null, srv), { engine: 'Strata 0.1.44.1', config: null, derived: false, file: 'not recorded', facts: null, editedSince: false });
        // llama.cpp: nothing
        assert.strictEqual(M.strataLaunchInfo('/b/llama-server -m /m/x.gguf -c 65536', { build_info: 'b8000 (abc)' }), null);
        assert.strictEqual(M.strataLaunchInfo(null, {}), null);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('configText: a Strata config reads as its config file; llama.cpp and truly unrecorded launches read as before', async () => {
    const { configText, strataLaunchText } = await loadLb();
    const m = { key: 'local:qwen3.8-flash-next:q4-k-xl~strata', display: 'Qwen3.8-Flash-Next Q4_K_XL (Strata)' };
    const base = { runner: 'opencode', n_ctx: 262144, timeout_s: 7200, launchUnknown: true, launchConflict: false, launchSummary: null, build_info: 'Strata 0.1.44.1' };
    const si = { engine: 'Strata 0.1.44.1', config: 'strata-ud-q4_k_xl-262k-int8-2xtx-pw2-kcopy-spec3-rb30-pdirect-iopf.json', derived: false, file: 'read', facts: strata.launchFacts(Q4KXL) };
    const full = configText(m, { ...base, strata: si }, true);
    assert.ok(!/unrecorded|not recorded/.test(full), full);
    assert.ok(full.includes('Strata config strata-ud-q4_k_xl-262k-int8-2xtx-pw2-kcopy-spec3-rb30-pdirect-iopf.json: KV int8, GPUs 0+1 (layer split auto), spec 3 (min-p 0.7), pipeline windows 2, resident budget 30 GiB, stage trim, kernel copy, prompt direct, IO prefetch, sampling temp 1 / top-p 0.95 / top-k 20'), full);
    assert.ok(!full.includes('max context'), 'the context the run recorded is already on the line; the file\'s is only added when it differs');
    assert.strictEqual(configText(m, { ...base, strata: si }, false), 'opencode · 256k ctx · Strata config strata-ud-q4_k_xl-262k-int8-2xtx-pw2-kcopy-spec3-rb30-pdirect-iopf · 120m cap');
    assert.ok(configText(m, { ...base, strata: { ...si, file: 'missing', facts: null } }, true).includes('(file no longer on disk: settings unknown)'));
    assert.ok(configText(m, { ...base, strata: { ...si, editedSince: true } }, true).includes('(file changed since this run: settings as it reads now)'));
    assert.ok(configText(m, { ...base, strata: { engine: 'Strata 0.1.32', config: null, file: 'not recorded', facts: null } }, true).includes('Strata (launch config not recorded)'));
    // llama.cpp: unchanged
    assert.strictEqual(configText(m, { ...base, build_info: null }, false), 'opencode · 256k ctx · launch flags unrecorded · 120m cap', 'nothing recorded at all: still says so');
    assert.strictEqual(configText(m, { ...base, launchUnknown: false, launchSummary: 'KV q8_0 · MTP' }, false), 'opencode · 256k ctx · KV q8_0 · MTP · 120m cap');
    assert.ok(configText(m, { ...base, launchConflict: true, strata: si }, false).includes('launch flags unknown (recorded command contradicts the server)'), 'a conflict is never papered over');
    assert.strictEqual(strataLaunchText(null, true), null);
});
