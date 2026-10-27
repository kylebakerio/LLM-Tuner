'use strict';
// Kyle, 2026-10-19: Strata config-name parts that only change speed (2xtx, pw<N>, kcopy, rb<N>, nopin, spec<N>) no longer
// split a row; parts that change answers (yarn<N>, esp, unslothtpl, ...) still do; a Strata run of an Unsloth UD file
// carries `strata`, so it never joins the llama.cpp row of the same file (lib/models.js strataVariant).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const M = require('../lib/models');

const UD_IQ4 = '/data/models/Qwen3.8-Flash-Next/UD-IQ4_XS/Qwen3.8-Flash-Next-UD-IQ4_XS-00001-of-00003.gguf';
const UD_Q4KXL = '/data/models/Qwen3.8-Flash-Next/UD-Q4_K_XL/Qwen3.8-Flash-Next-UD-Q4_K_XL-00001-of-00004.gguf';
const GSQ_IQ3 = '/home/kyle/AI/Strata-data/models/IQ3_XXS/Qwen3.8-Flash-Next-GSQ-RCO-IQ3_XXS-00001-of-00002.gguf';
const ORCA = '/data/models/Orca-Flash-Next-Uncensored/Qwen3.8-Flash-Next-Uncensored-IQ3_XXS-00001-of-00002.gguf';
const serve = (ver, cfg) => `/home/kyle/AI/Strata-${ver}/queue-serve.sh /home/kyle/AI/Strata-${ver}/${cfg}.json`;
const run = (model_path, build_info) => ({ config: { runner: 'opencode' }, server: { model_path, build_info, n_ctx: 262144 } });
const v = (model_path, build_info, cmd) => M.strataVariant({ server: { model_path, build_info } }, cmd);
const row = (model_path, build_info, cmd) => M.withLocalVariant(M.canonicalModel({ model_path }), run(model_path, build_info), null, cmd);

test('speed-only Strata parts: every queued Flash-Next UD-IQ4_XS / UD-Q4_K_XL config of one setup is one row', () => {
    const strata = { keys: ['strata'], bits: ['Strata'] };
    for (const [ver, c] of [['0.1.43.1', 'strata-ud-iq4_xs-128k-int8-2xtx'], ['0.1.43.1', 'strata-ud-iq4_xs-262k-int8-2xtx'],
        ['0.1.43.1', 'strata-ud-iq4_xs-262k-int8-2xtx-pw2-kcopy'], ['0.1.44.1', 'strata-ud-iq4_xs-262k-int8-2xtx-pw2-kcopy-spec3']]) {
        assert.deepStrictEqual(v(UD_IQ4, `Strata ${ver}`, serve(ver, c)), strata, c);
    }
    for (const c of ['strata-ud-q4_k_xl-262k-int8-2xtx-pw2-kcopy-spec3', 'strata-ud-q4_k_xl-262k-int8-2xtx-pw2-kcopy-spec3-rb30',
        'strata-ud-q4_k_xl-262k-int8-2xtx-pw2-kcopy-spec3-rb30-nopin']) {
        assert.deepStrictEqual(v(UD_Q4KXL, 'Strata 0.1.44.1', serve('0.1.44.1', c)), strata, c);
    }
    // the catalog keys, and no speed part left in the name
    const iq4 = row(UD_IQ4, 'Strata 0.1.44.1', serve('0.1.44.1', 'strata-ud-iq4_xs-262k-int8-2xtx-pw2-kcopy-spec3'));
    assert.strictEqual(iq4.key, 'local:qwen3.8-flash-next:iq4-xs~strata');
    assert.strictEqual(row(UD_IQ4, 'Strata 0.1.43.1', serve('0.1.43.1', 'strata-ud-iq4_xs-262k-int8-2xtx')).key, iq4.key);
    assert.match(iq4.display, /IQ4_XS \(Strata\)$/);
    const q4 = row(UD_Q4KXL, 'Strata 0.1.44.1', serve('0.1.44.1', 'strata-ud-q4_k_xl-262k-int8-2xtx-pw2-kcopy-spec3-rb30-nopin'));
    assert.strictEqual(q4.key, 'local:qwen3.8-flash-next:q4-k-xl~strata');
    assert.strictEqual(row(UD_Q4KXL, 'Strata 0.1.44.1', serve('0.1.44.1', 'strata-ud-q4_k_xl-262k-int8-2xtx-pw2-kcopy-spec3')).key, q4.key);
    for (const c of [iq4, q4]) assert.doesNotMatch(c.display, /2xtx|pw2|kcopy|spec3|rb30|nopin/);
    // a derived per-install copy reads the same
    assert.deepStrictEqual(v(UD_IQ4, 'Strata 0.1.44.1', '/home/kyle/AI/Strata-0.1.44.1/queue-serve.sh /l/strata-dashboard/strata-ud-iq4_xs-262k-int8-2xtx-pw2-kcopy-spec3.0.1.44.1.dash.json --port 18080'), strata);
    // 2gpu / split / auto (the older two-card names) are placement too
    assert.strictEqual(v(GSQ_IQ3, 'Strata 0.1.43.1', serve('0.1.43.1', 'strata-iq3_xxs-2gpu-split-auto')), null);
    assert.strictEqual(v(GSQ_IQ3, 'Strata 0.1.43.1', serve('0.1.43.1', 'strata-iq3_xxs-2gpu-split-pw2')), null);
});

test('pdirect / iopf (STRATA_PROMPT_DIRECT / STRATA_IO_PREFETCH) are speed-only: ...-rb30-pdirect[-iopf] is the ...-rb30 row (queue 1192/1193)', () => {
    const base = 'strata-ud-q4_k_xl-262k-int8-2xtx-pw2-kcopy-spec3-rb30';
    const ref = row(UD_Q4KXL, 'Strata 0.1.44.1', serve('0.1.44.1', base));
    assert.strictEqual(ref.key, 'local:qwen3.8-flash-next:q4-k-xl~strata');
    for (const c of [`${base}-pdirect`, `${base}-pdirect-iopf`, `${base}-iopf`]) {
        const r = row(UD_Q4KXL, 'Strata 0.1.44.1', serve('0.1.44.1', c));
        assert.strictEqual(r.key, ref.key, c);
        assert.strictEqual(r.display, ref.display, c);
        assert.doesNotMatch(r.display, /pdirect|iopf/);
        assert.deepStrictEqual(v(UD_Q4KXL, 'Strata 0.1.44.1', serve('0.1.44.1', c)), v(UD_Q4KXL, 'Strata 0.1.44.1', serve('0.1.44.1', base)), c);
    }
});

test('answer-changing Strata parts keep their own row; unchecked parts too', () => {
    const yarn = row(UD_IQ4, 'Strata 0.1.44.1', serve('0.1.44.1', 'strata-ud-iq4_xs-512k-yarn2-int8-2xtx-pw2-kcopy-spec3'));
    assert.strictEqual(yarn.key, 'local:qwen3.8-flash-next:iq4-xs~strata~yarn2');
    assert.match(yarn.display, /\(Strata, yarn2\)$/);
    assert.deepStrictEqual(v(UD_IQ4, 'Strata 0.1.43.1', serve('0.1.43.1', 'strata-ud-iq4_xs-1m-yarn4-int8-2xtx')), { keys: ['strata', 'yarn4'], bits: ['Strata', 'yarn4'] });
    assert.deepStrictEqual(v(GSQ_IQ3, 'Strata 0.1.32', serve('0.1.32', 'strata-iq3_xxs-esp')), { keys: ['esp'], bits: ['projection on'] });
    assert.deepStrictEqual(v(ORCA, 'Strata 0.1.32', serve('0.1.32', 'strata-orca-iq3_xxs-resident-unslothtpl')), { keys: ['unslothtpl'], bits: ['regular chat template'] });
    assert.deepStrictEqual(v(ORCA, 'Strata 0.1.32', serve('0.1.32', 'strata-orca-iq3_xxs-resident-loweffort')), { keys: ['loweffort'], bits: ['loweffort'] });
    assert.deepStrictEqual(v(GSQ_IQ3, 'Strata 0.1.43.1', serve('0.1.43.1', 'strata-iq3_xxs-2gpu-split27-trim-pw2-pffused')), { keys: ['split27', 'trim', 'pffused'], bits: ['split27', 'trim', 'pffused'] });
    // a row variant declared on the item still splits, after the engine part
    const rv = row(UD_IQ4, 'Strata 0.1.44.1', serve('0.1.44.1', 'strata-ud-iq4_xs-262k-int8-2xtx-pw2-kcopy-spec3') + ' #row-variant=answered-question');
    assert.strictEqual(rv.key, 'local:qwen3.8-flash-next:iq4-xs~strata~rv:answered-question');
});

test('the engine part: only a Strata run of an Unsloth UD file; the Strata-only files and llama.cpp keep their keys', () => {
    // Strata's own files: the stock rows are untouched
    assert.strictEqual(v(GSQ_IQ3, 'Strata 0.1.44.1', serve('0.1.44.1', 'strata-iq3_xxs')), null);
    assert.strictEqual(v(GSQ_IQ3, 'Strata 0.1.32', undefined), null);
    assert.strictEqual(v(ORCA, 'Strata 0.1.32', serve('0.1.32', 'strata-orca-iq3_xxs-ram44')), null);
    // a Strata UD run with no queue item (its engine recorded) is the same Strata row
    assert.deepStrictEqual(v(UD_IQ4, 'Strata 0.1.44.1', undefined), { keys: ['strata'], bits: ['Strata'] });
    // llama.cpp on the same file: the plain row, as before
    const ll = '/home/kyle/AI/llama-official/llama.cpp-u144/build-hip/bin/llama-server -m /home/kyle/AI/experiment-1/models/Qwen3.8-Flash-Next-UD-IQ4_XS-00001-of-00003.gguf -c 65536 -ctk q8_0 -ctv q8_0 --jinja';
    const llPath = '/home/kyle/AI/experiment-1/models/Qwen3.8-Flash-Next-UD-IQ4_XS-00001-of-00003.gguf';
    assert.strictEqual(v(llPath, 'b10499-6d0549831', ll), null);
    const llRow = M.withLocalVariant(M.canonicalModel({ model_path: llPath }), { config: { runner: 'opencode' }, server: { model_path: llPath, build_info: 'b10499-6d0549831', launch_command: ll } }, null, ll);
    assert.strictEqual(llRow.key, 'local:qwen3.8-flash-next:iq4-xs');
});

test('the planner and a running battery land on the same row as the stored results (configid.identityOfSpec / describeRunning)', (t) => {
    const CI = require('../lib/configid');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'speedneutral-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const eng = path.join(dir, 'Strata-0.1.44.1');
    fs.mkdirSync(eng);
    const cfg = path.join(eng, 'strata-ud-iq4_xs-262k-int8-2xtx-pw2-kcopy-spec3.json');
    fs.writeFileSync(cfg, JSON.stringify({ args: ['--native', UD_IQ4, '--max-context', '262144', '--spec', '3'] }));
    const launch = `${eng}/queue-serve.sh ${cfg}`;
    const id = CI.identityOfSpec({ dir: 'x', config: { runner: 'opencode', prompt_level: 'L2', timeout_s: 7200 }, launch });
    assert.strictEqual(id.modelKey, 'local:qwen3.8-flash-next:iq4-xs~strata');
    const live = M.describeRunning({ dir: 'x', battery: { runner: 'opencode' } }, { model_path: UD_IQ4, n_ctx: 262144, launch_command: launch, engine: 'strata' });
    assert.strictEqual(live.modelKey, id.modelKey);
});

test('auto-queue: the Strata UD-IQ4_XS config targets its own row; a saved plain catalogKey (the llama.cpp row) is stale', () => {
    const AQ = require('../lib/autoqueue');
    const def = AQ.DEFAULT_MODELS.find((m) => m.id === 'fn-udiq4xs-strata-262k');
    assert.strictEqual(def.catalogKey, 'local:qwen3.8-flash-next:iq4-xs~strata');
    assert.strictEqual(AQ.DEFAULT_MODELS.find((m) => m.id === 'flash-iq4').catalogKey, 'local:qwen3.8-flash-next:iq4-xs', 'the llama.cpp entry keeps the plain row');
    // logs/autoqueue.json as it is on 2026-10-19: the old 0.1.43.1 weights + cmd and the plain key
    const dir = def.weights.replace(/Strata-0\.1\.44\.1\/.*$/, 'Strata-0.1.43.1');
    const saved = { id: 'fn-udiq4xs-strata-262k', label: 'Flash-Next UD-IQ4_XS (Strata, 262k)', catalogKey: 'local:qwen3.8-flash-next:iq4-xs', role: 'contender',
        weights: `${dir}/strata-ud-iq4_xs-262k-int8-2xtx.json`, cmd: `${dir}/queue-serve.sh ${dir}/strata-ud-iq4_xs-262k-int8-2xtx.json` };
    const m = AQ.mergeModels([saved]).find((x) => x.id === 'fn-udiq4xs-strata-262k');
    assert.strictEqual(m.catalogKey, def.catalogKey);
    assert.strictEqual(m.cmd, def.cmd, 'the older stale set still applies on its own');
    // each set on its own: a user's cmd edit stays, the plain key still goes
    const edited = AQ.mergeModels([{ ...saved, cmd: `${saved.cmd} --mine` }]).find((x) => x.id === 'fn-udiq4xs-strata-262k');
    assert.match(edited.cmd, /--mine$/);
    assert.strictEqual(edited.catalogKey, def.catalogKey);
    // a key the user chose is never overridden
    const own = AQ.mergeModels([{ ...saved, catalogKey: 'local:qwen3.8-flash-next:iq4-xs~strata~rv:mine' }]).find((x) => x.id === 'fn-udiq4xs-strata-262k');
    assert.strictEqual(own.catalogKey, 'local:qwen3.8-flash-next:iq4-xs~strata~rv:mine');
});

test('catalog: the three UD-Q4_K_XL Strata configs are one row; each keeps its own speed (placement) facet, off for quality', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'speedneutral-cat-'));
    fs.mkdirSync(path.join(tmp, 'cbroot', 'results'), { recursive: true }); fs.mkdirSync(path.join(tmp, 'cbroot', 'tasks'), { recursive: true });
    t.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); M.configure({}); });
    const cfg = { runner: 'opencode', model: 'llama-local/local-262k', prompt_level: 'L2', harness_mode: 'agentic', timeout_s: 7200 };
    const bat = (dir) => ({ dir, ended: 1, config: cfg, server: { model_path: UD_Q4KXL, build_info: 'Strata 0.1.44.1', n_ctx: 262144 } });
    const row = (task, status) => ({ task, status, solved: status === 'pass', wall_s: 100, tokens_out: 10, tool_calls: 1 });
    const rows = { spec3: [row('a', 'pass')], rb30: [row('b', 'fail')], nopin: [row('a', 'fail'), row('c', 'pass')] };
    const names = { spec3: 'strata-ud-q4_k_xl-262k-int8-2xtx-pw2-kcopy-spec3', rb30: 'strata-ud-q4_k_xl-262k-int8-2xtx-pw2-kcopy-spec3-rb30', nopin: 'strata-ud-q4_k_xl-262k-int8-2xtx-pw2-kcopy-spec3-rb30-nopin' };
    M.configure({
        paths: { csv: path.join(tmp, 'none.csv'), bestConfigs: path.join(tmp, 'none.md'), benchLog: path.join(tmp, 'none.log'), sweepState: path.join(tmp, 'none.json'),
            codebenchRoot: path.join(tmp, 'cbroot'), dashboardConfig: path.join(tmp, 'nope.json') },
        codebench: { listRuns: () => Object.keys(rows).map(bat), getRun: (dir) => ({ rows: rows[dir] || [] }) },
        queueLaunch: new Map(Object.entries(names).map(([d, n]) => [d, serve('0.1.44.1', n)])),
    });
    const list = M.listModels();
    const keys = list.models.filter((m) => /flash-next:q4-k-xl/.test(m.key)).map((m) => m.key);
    assert.deepStrictEqual(keys, ['local:qwen3.8-flash-next:q4-k-xl~strata']);
    const m = list.models.find((x) => x.key === keys[0]);
    assert.deepStrictEqual(m.batteries.map((b) => b.dir).sort(), ['nopin', 'rb30', 'spec3']);
    assert.strictEqual(m.quality.scored, 3, 'task a ran twice: one task, two attempts');
    // one config per battery, each naming the config file it ran in the placement facet
    const placements = m.configs.map((c) => c.facets.placement).sort();
    assert.deepStrictEqual(placements, Object.values(names).map((n) => [`${n}.json`]).sort());
    // quality facets carry no trace of it: the three are one quality group
    const q = ['weights', 'harness', 'context', 'output', 'kv', 'other'];
    assert.strictEqual(new Set(m.configs.map((c) => JSON.stringify(q.map((k) => c.facets[k])))).size, 1);
    assert.doesNotMatch(m.display, /2xtx|pw2|kcopy|spec3|rb30|nopin/);
});
