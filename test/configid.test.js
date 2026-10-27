// lib/configid.js -- ONE config identity for everything that decides "already ran" (2026-10-15, Kyle: "Thinking off
// should NEVER be blended with thinking on... Why would a different q blend with this one?" / "Prevent duplicate runs").
// The identity is the Models page's solve-map cell: the catalog row (weights by content + every row variant) with the
// tensor-split and f32ssm folds, then the quality facets.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const M = require('../lib/models.js');
const ID = require('../lib/configid.js');

async function loadLb() {
    const src = fs.readFileSync(path.join(__dirname, '..', 'ui', 'shared', 'leaderboard.js'), 'utf-8');
    const stub = 'data:text/javascript,' + encodeURIComponent(
        'export const esc=(s)=>String(s??"");export const fmtDur=(s)=>String(s);export const fmtN=(n)=>String(n);'
        + 'export const harnessLabel=(r)=>r||null;export const scaffoldBit=(r,s)=>s||null;'
        // the real context rule (ui/shared/ctxlabel.js, 2026-10-25): a stub never carries a copy of it
        + `import ${JSON.stringify(require('url').pathToFileURL(path.join(__dirname, '..', 'ui', 'shared', 'ctxlabel.js')).href)};export const { ctxLabel, commonWindow } = globalThis.CtxLabel;`);
    return import('data:text/javascript,' + encodeURIComponent(src.replace("from '../benchmarks/util.js'", `from '${stub}'`)));
}

const Q4 = '/home/kyle/.cache/huggingface/hub/models--unsloth--Qwen3.8-27B-GGUF/snapshots/4ca720/Qwen3.8-27B-UD-Q4_K_XL.gguf';
const LAUNCH = `/b/llama-server -m ${Q4} -c 131072 -ngl 999 -fa on -np 1 --jinja --spec-type draft-mtp,ngram-mod --cache-type-k q8_0 --cache-type-v q8_0 -dev ROCm0`;
const cfg = (o = {}) => ({ runner: 'opencode', model: 'llama-local/qwen38-27b-q4-128k', prompt_level: 'L2', harness_mode: 'agentic', timeout_s: 7200, ...o });
const spec = (o = {}) => ({ dir: 'b', config: cfg(o.config), launch: o.launch ?? LAUNCH, env: o.env || {}, ...(o.queueCmd ? { queueCmd: o.queueCmd } : {}) });

test.beforeEach(() => M.configure({ queueLaunch: new Map(), weightsRegistry: { paths: {} } }));
test.after(() => M.configure({}));

test('fold rules: the same tables as the browser (ui/shared/leaderboard.js) -- a drift fails here', async () => {
    const L = await loadLb();
    assert.deepStrictEqual([...ID.QUALITY_FACETS], L.FACET_DEFAULTS.quality);
    assert.deepStrictEqual(Object.fromEntries(Object.entries(L.FILE_VARIANTS).map(([k, v]) => [k, v.to])), { ...ID.FILE_VARIANTS });
    const keys = ['local:qwen3.8-27b:q6-k-xl~rv:tensor-split-two-xtx', 'local:qwen3.8-27b:q4-k-xl~nothink~rv:tensor-split-two-xtx',
        'local:qwen3.8-27b-gsq-rco-iq2-xs-mtp-f32ssm:unknown', 'local:qwen3.8-27b-gsq-rco-iq2-xs-mtp-f32ssm:unknown~tau',
        'local:qwen3.8-27b:q4-k-xl~nothink', 'local:qwen3.8-27b:q6-k-xl~file:73920218', 'local:qwen3.8-27b:q4-k-xl~rv:review-swift'];
    for (const k of keys) {
        const lb = L.fileBaseKey(L.tensorBaseKey(k) ?? k) ?? (L.tensorBaseKey(k) ?? k);
        assert.strictEqual(ID.rowKeyOf(k), lb, k);
    }
    // the cell key is the page's groupKeyOf over the folded weights
    const facets = { weights: 'local:qwen3.8-27b:q6-k-xl', harness: { runner: 'opencode' }, context: { n_ctx: 1 }, output: ['--jinja'], kv: [], other: [] };
    assert.strictEqual(ID.cellKey('local:qwen3.8-27b:q6-k-xl~rv:tensor-split-two-xtx', facets), L.groupKeyOf({ facets }, L.FACET_DEFAULTS.quality));
});

test('identity: thinking off, a review prompt, pi, tau and Jeff are other configs; MTP, placement and tensor-split are not', () => {
    const plain = ID.identityOfSpec(spec());
    assert.strictEqual(plain.modelKey, 'local:qwen3.8-27b:q4-k-xl');
    const differ = {
        'thinking off': spec({ launch: LAUNCH + ' --reasoning off' }),
        'review prompt': spec({ config: { prompt_level: 'L2+review' } }),
        'careful tone': spec({ config: { prompt_level: 'L2+careful-tone' } }),
        'L3 prompt': spec({ config: { prompt_level: 'L3' } }),
        'pi': spec({ config: { runner: 'pi', scaffold: 'none' } }),
        'pi + SoL-Pi': spec({ config: { runner: 'pi', scaffold: 'sol-pi' } }),
        'tau': spec({ config: { runner: 'tau', scaffold: 'default' } }),
        'jeff': spec({ config: { runner: 'jeff', scaffold: 'jeff' } }),
        'reasoning preserved': spec({ launch: LAUNCH + ' --reasoning-preserve' }),
        '64k': spec({ launch: LAUNCH.replace('-c 131072', '-c 65536') }),
        '3 h cap': spec({ config: { timeout_s: 10800 } }),
        'declared row variant': spec({ env: { CODEBENCH_ROW_VARIANT: 'subagents' } }),
        'other quant': spec({ launch: LAUNCH.replace(/Q4_K_XL/g, 'Q6_K_XL') }),
    };
    const seen = new Map([[plain.key, 'plain']]);
    for (const [name, s] of Object.entries(differ)) {
        const id = ID.identityOfSpec(s);
        assert.ok(id, name);
        assert.notStrictEqual(id.key, plain.key, `${name} must not be the plain config`);
        assert.ok(!seen.has(id.key), `${name} collides with ${seen.get(id.key)}`);
        seen.set(id.key, name);
    }
    const same = {
        'no MTP': spec({ launch: LAUNCH.replace(' --spec-type draft-mtp,ngram-mod', '') }),
        'other card': spec({ launch: LAUNCH.replace('-dev ROCm0', '-dev ROCm0,ROCm1 -sm tensor') }),
        'tensor-split row': spec({ env: { CODEBENCH_ROW_VARIANT: 'tensor-split-two-xtx' } }),
        'opencode alias': spec({ config: { model: 'llama-local/local-128k' } }),
        'another build': spec({ launch: LAUNCH.replace('/b/llama-server', '/other/build/bin/llama-server') }),
        // the queue does not re-run a task over KV type (the Models page shows it as another cell: identity.cell)
        'KV f16': spec({ launch: LAUNCH.replace(/ --cache-type-k q8_0 --cache-type-v q8_0/, '') }),
        'no --jinja': spec({ launch: LAUNCH.replace(' --jinja', '') }),
    };
    for (const [name, s] of Object.entries(same)) assert.strictEqual(ID.identityOfSpec(s).key, plain.key, `${name} is the same config`);
    assert.strictEqual(ID.identityOfSpec(same['tensor-split row']).rowKey, 'local:qwen3.8-27b:q4-k-xl');
    assert.notStrictEqual(ID.identityOfSpec(same['KV f16']).cell, plain.cell, 'the solve-map cell still tells KV types apart');
});

test('identity: the f32ssm copy is its original file; cloud effort and scaffold are part of it; nothing is guessed', () => {
    const copy = ID.identityOfSpec(spec({ launch: '/b/llama-server -m /data/models/Qwen3.8-27B-GSQ-RCO/Qwen3.8-27B-GSQ-RCO-IQ2_XS-mtp-f32ssm.gguf -c 81920 --jinja' }));
    const orig = ID.identityOfSpec(spec({ launch: '/b/llama-server -m /data/models/Qwen3.8-27B-GSQ-RCO/Qwen3.8-27B-GSQ-RCO-IQ2_XS-mtp.gguf -c 81920 --jinja' }));
    assert.strictEqual(copy.key, orig.key);
    assert.notStrictEqual(copy.modelKey, orig.modelKey, 'two catalog models, one cell');
    const claude = (effort, scaffold) => ID.identityOfSpec({ dir: 'c', config: { runner: 'claude', model: 'claude-haiku-4-5', prompt_level: 'L2', timeout_s: 7200, effort, scaffold }, launch: '' });
    assert.notStrictEqual(claude('low', 'solo').key, claude('medium', 'solo').key);
    assert.notStrictEqual(claude('low', 'solo').key, claude('low', 'default').key);
    assert.strictEqual(ID.identityOfSpec(spec({ launch: '' })), null, 'a local config with no model file is not identified');
});

test('specRun: the queue command carries the declared row variant; a Strata config names its file and context', (t) => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'cid-')); t.after(() => fs.rmSync(d, { recursive: true, force: true }));
    const r = ID.specRun(spec({ env: { CODEBENCH_ROW_VARIANT: 'ctx229k' }, queueCmd: LAUNCH }));
    assert.match(r.queueCmd, / #row-variant=ctx229k$/);
    assert.strictEqual(ID.specRun(spec({ env: { CODEBENCH_ROW_VARIANT: 'x' }, queueCmd: LAUNCH + ' #row-variant=x' })).queueCmd, LAUNCH + ' #row-variant=x');
    const sdir = path.join(d, 'Strata-0.1.43.1'); fs.mkdirSync(sdir);
    const json = path.join(sdir, 'strata-iq3_xxs.json');
    fs.writeFileSync(json, JSON.stringify({ args: ['--native', '/m/Qwen3.8-Flash-Next-GSQ-RCO-IQ3_XXS-00001-of-00002.gguf', '--max-context', '131072'] }, null, 1));
    const s = ID.specRun(spec({ launch: `${sdir}/queue-serve.sh ${json}` }));
    assert.strictEqual(s.run.server.model_path, '/m/Qwen3.8-Flash-Next-GSQ-RCO-IQ3_XXS-00001-of-00002.gguf');
    assert.strictEqual(s.run.server.n_ctx, 131072);
    assert.ok(!('launch_command' in s.run.server), 'a Strata result records no launch command, so its config may not either');
});

test('scoredIndex / scoredFor: only the config\'s own cell counts; excluded, +bonus, INVALID and other variants never do', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cid-')); t.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); M.configure({}); });
    fs.mkdirSync(path.join(tmp, 'cb', 'results'), { recursive: true }); fs.mkdirSync(path.join(tmp, 'cb', 'tasks'), { recursive: true });
    const srv = (launch) => ({ model_path: Q4, n_ctx: 131072, ...(launch ? { launch_command: launch } : {}) });
    const bat = (dir, launch, c, rows) => ({ dir, run: { dir, config: c, server: srv(launch), tasks: rows.length }, rows });
    const R = (task, status) => ({ task, status, ran_at: 1 });
    const bats = [
        bat('plain-a', LAUNCH, cfg(), [R('t-pass', 'pass'), R('t-fail', 'fail'), R('t-timeout', 'TIMEOUT'), R('t-overflow', 'OVERFLOW'), R('t-pass+bonus', 'pass')]),
        bat('nothink-a', LAUNCH + ' --reasoning off', cfg(), [R('t-nothink', 'pass')]),
        bat('review-a', LAUNCH, cfg({ prompt_level: 'L2+review' }), [R('t-review', 'pass')]),
        bat('INVALID-plain', LAUNCH, cfg(), [R('t-invalid', 'pass')]),
        bat('plain-mtpoff', LAUNCH.replace(' --spec-type draft-mtp,ngram-mod', ''), cfg(), [R('t-mtpoff__r2', 'fail')]),
        bat('tensor', LAUNCH.replace('-dev ROCm0', '-dev ROCm0,ROCm1 -sm tensor'), cfg(), [R('t-tensor', 'pass')]),
        bat('unrecorded', null, cfg(), [R('t-unrec', 'pass')]),
        bat('ctx64', LAUNCH.replace('-c 131072', '-c 65536'), cfg(), [R('t-64k', 'pass')]),
        // 3 h cap: a run that finished inside 2 h counts for the 2 h config too (Kyle 2026-09-24); a TIMEOUT or a longer run does not
        bat('cap3h', LAUNCH, cfg({ timeout_s: 10800 }), [{ ...R('t-3h-fast', 'fail'), wall_s: 3000 }, { ...R('t-3h-slow', 'pass'), wall_s: 9000 }, { ...R('t-3h-timeout', 'TIMEOUT'), wall_s: 7100 }]),
    ];
    bats.find((b) => b.dir === 'ctx64').run.server.n_ctx = 65536;
    M.configure({
        paths: { csv: path.join(tmp, 'none.csv'), bestConfigs: path.join(tmp, 'none.md'), benchLog: path.join(tmp, 'none.log'),
            sweepState: path.join(tmp, 's.json'), codebenchRoot: path.join(tmp, 'cb'), dashboardConfig: path.join(tmp, 'nope.json') },
        codebench: { listRuns: () => bats.map((b) => b.run), getRun: (dir) => ({ rows: bats.find((b) => b.dir === dir).rows }) },
        queueLaunch: new Map([['tensor', `${LAUNCH} #row-variant=tensor-split-two-xtx`]]),
        weightsRegistry: { paths: {} },
    });
    const index = ID.scoredIndex();
    const plain = ID.identityOfSpec(spec());
    assert.deepStrictEqual(Object.keys(ID.scoredFor(plain, null, index)).sort(), ['t-3h-fast', 't-fail', 't-mtpoff', 't-pass', 't-tensor', 't-timeout', 't-unrec']);
    const off = ID.identityOfSpec(spec({ launch: LAUNCH + ' --reasoning off' }));
    assert.deepStrictEqual(Object.keys(ID.scoredFor(off, null, index)), ['t-nothink']);
    assert.deepStrictEqual(Object.keys(ID.scoredFor(off, ['t-pass'], index)), [], 'the plain config\'s runs are not thinking-off runs');
    assert.deepStrictEqual(Object.keys(ID.scoredFor(ID.identityOfSpec(spec({ config: { prompt_level: 'L2+review' } })), null, index)), ['t-review']);
    assert.deepStrictEqual(ID.scoredFor(plain, ['t-pass'], index)['t-pass'], [{ status: 'pass', dir: 'plain-a', ranAt: 1 }]);
    assert.deepStrictEqual([...index.byDir.get('tensor')].length, 1);
    const cap3 = ID.identityOfSpec(spec({ config: { timeout_s: 10800 } }));
    assert.deepStrictEqual(Object.keys(ID.scoredFor(cap3, null, index)).sort(), ['t-3h-fast', 't-3h-slow', 't-3h-timeout'], 'the 3 h config keeps all three');
});

test('claimedFor: an EARLIER running item of the same config holds its unfinished tasks; a later one, or another config, does not', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cid-')); t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
    const mk = (name, c) => { const d = path.join(tmp, name); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'battery.json'), JSON.stringify({ config: c })); return d; };
    const a = mk('a', cfg()), b = mk('b', cfg()), off = mk('off', cfg());
    fs.writeFileSync(path.join(a, 't1.json'), '{}');
    const rows = [
        { id: 10, label: 'a', launch_cmd: LAUNCH, env_json: '{}', outcome_json: JSON.stringify({ launch_expanded: LAUNCH }), resolved_tasks_json: '["t1","t2","t3"]', result_dir: a, started_at: '2026-10-15T01:00:00Z' },
        { id: 12, label: 'b', launch_cmd: LAUNCH, env_json: '{}', outcome_json: '{}', resolved_tasks_json: '["t4"]', result_dir: b, started_at: '2026-10-15T03:00:00Z' },
        { id: 11, label: 'off', launch_cmd: LAUNCH + ' --reasoning off', env_json: '{}', outcome_json: '{}', resolved_tasks_json: '["t5"]', result_dir: off, started_at: '2026-10-15T00:00:00Z' },
    ];
    const db = { prepare: () => ({ all: () => rows }) };
    const id = ID.identityOfSpec(spec());
    const got = ID.claimedFor(id, null, { db, selfItem: 20, selfStarted: '2026-10-15T02:00:00Z' });
    assert.deepStrictEqual(got, { t2: { item: 10, label: 'a' }, t3: { item: 10, label: 'a' } }, 't1 finished, t4 belongs to a later item, t5 to thinking off');
});
