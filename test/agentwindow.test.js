'use strict';
// THE AGENT'S WINDOW (2026-10-25, Kyle on the Ornith "262k" row that ran a 128k agent window on a 262k server: "I think we
// just leave it at 128k on the solve map"; and "the logic for this stuff exists in one place and won't be duplicated or out
// of sync"). The harness decides the context a run is filed under (harness/agent_window.py effective_ctx: the server's
// n_ctx while the agent's alias is in step with it; when it is not, the server size the alias's window runs on in step,
// local-128k -> 131072 -- since ~13:00 10-25, Kyle: merge the two Ornith 128k rows, "They differ only in the server's
// size, which the agent never sees") and records it as `agent_window.effective_ctx` on the result and on the battery
// config. The dashboard reads it and never re-derives it:
//  - lib/codebench.js configOf carries `agent_window` into the row's config;
//  - lib/models.js runDescriptor files the run under it (context.n_ctx) and files its context flags at that size too
//    (filedFacets: -c 131072; the server's own -c 262144 moves to `placement`, so speed rows still keep the servers apart);
//    adds ctx_label (ctxLabel, ui/shared/ctxlabel.js: 131072 and 128000 both read 128k) and, only out of step,
//    agentWindow (display);
//  - lib/configid.js keys follow (scheduleKey: n_ctx; cellKey: QUALITY_FACETS, placement not among them): the 262k-server
//    runs share the in-step 128k row's keys; a spec not started yet has no record and keys at its launch -c, where the
//    harness will put the alias;
//  - ui/shared/leaderboard.js ctxText: a config's words ("128k ctx (agent window; 256k server)"); a row pooling runs with
//    and without a window reads plainly "128k ctx" (commonWindow).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = require('../lib/annotations');
const M = require('../lib/models');
const ID = require('../lib/configid');
const { sanitizeCatalog } = require('../lib/publicdata');

const ORN = '/m/Ornith-1.5-35B-Q4_K_M.gguf';
const launch = (c) => `/b/llama-server -m ${ORN} -c ${c} -ngl 999 -fa on -np 1 --jinja --cache-type-k q8_0 --cache-type-v q8_0 -dev CUDA0,CUDA1`;
const server = (c) => ({ model_path: ORN, build_info: 'b11815-abc', n_ctx: c, launch_command: launch(c) });
const cfg = (model, o = {}) => ({ runner: 'opencode', model, prompt_level: 'L2', harness_mode: 'agentic', timeout_s: 7200, ...o });
// the harness's records (harness/agent_window.py resolve / ran_as_asked)
// AW_OUT: the record on the 214 Ornith "262k" results since ~13:00 10-25 (effective_ctx 131072; the morning's said 128000)
const AW_OUT = { asked: 'llama-local/local-128k', model: 'llama-local/local-128k', window: 128000, server_n_ctx: 262144, compaction_at: 111616,
    effective_ctx: 131072, action: 'out-of-step', why: 'ran before the harness kept the agent\'s window in step with the server (recorded 2026-10-25)' };
const AW_262 = { asked: 'llama-local/local-262k', model: 'llama-local/local-262k', window: 262144, server_n_ctx: 262144, compaction_at: 245760,
    effective_ctx: 262144, action: 'in-step', why: 'local-262k (262144) on a 262144 server' };
const AW_128 = { asked: 'llama-local/local-128k', model: 'llama-local/local-128k', window: 128000, server_n_ctx: 131072, compaction_at: 111616,
    effective_ctx: 131072, action: 'in-step', why: 'local-128k (128000) on a 131072 server' };

test.beforeEach(() => M.configure({ queueLaunch: new Map(), weightsRegistry: { paths: {} } }));
test.after(() => M.configure({}));

// ---------------------------------------------------------------- the label rule
test('ctxLabel: every server context on record reads as before (kibi); a window named in thousands reads its name', () => {
    // every n_ctx in results/ on 2026-10-25, with what the pages printed (Math.round(n / 1024) + 'k')
    for (const n of [32768, 65536, 81920, 98304, 122880, 131072, 196608, 229376, 262144, 524288, 1048576])
        assert.equal(M.ctxLabel(n), `${Math.round(n / 1024)}k`, String(n));
    assert.equal(M.ctxLabel(128000), '128k', 'local-128k: 128000 is 125 x 1024, and must not read 125k');
    assert.equal(M.ctxLabel(63000), '63k');
    assert.equal(M.ctxLabel(1024000), '1024k');
    for (const x of [null, 0, undefined, 'x']) assert.equal(M.ctxLabel(x), null);
});

// ---------------------------------------------------------------- runDescriptor
const KEY = 'local:ornith-1.5-35b:q4-k-m';
const desc = (config, srv) => M.runDescriptor({ dir: 'b', config, server: srv }, 'local', KEY);

test('runDescriptor: no agent_window, or one in step, files the run exactly as before', () => {
    const before = desc(cfg('llama-local/local-128k'), server(131072));
    assert.equal(before.n_ctx, 131072);
    assert.deepEqual(before.facets.context, { n_ctx: 131072, flags: ['-c 131072'] });
    assert.equal(before.ctx_label, '128k');
    assert.equal(before.agentWindow, undefined, 'nothing extra on an in-step run');
    // a new result of the same config: the harness recorded it in step (effective_ctx = the server's)
    const inStep = desc(cfg('llama-local/local-128k', { agent_window: AW_128 }), server(131072));
    assert.equal(inStep.identity('quality'), before.identity('quality'));
    assert.equal(inStep.identity('full'), before.identity('full'));
    assert.deepEqual(inStep.facets, before.facets);
    assert.equal(inStep.agentWindow, undefined);
    assert.equal(ID.scheduleKey(KEY, inStep.facets, 'L2'), ID.scheduleKey(KEY, before.facets, 'L2'));
    // an unusable record changes nothing either
    for (const aw of [{}, { effective_ctx: null }, { effective_ctx: 0 }, 'x'])
        assert.equal(desc(cfg('llama-local/local-128k', { agent_window: aw }), server(131072)).identity('full'), before.identity('full'), JSON.stringify(aw));
    // a cloud run has no record and no server context
    const cloud = M.runDescriptor({ dir: 'c', config: { runner: 'claude', model: 'claude-x' }, server: {} }, 'cloud', 'cloud:x');
    assert.equal(cloud.n_ctx, null); assert.equal(cloud.ctx_label, null); assert.equal(cloud.agentWindow, undefined);
});

test('runDescriptor: out of step -> filed at 131072 with -c 131072, the in-step 128k row\'s keys; the server\'s -c goes to placement', () => {
    const d = desc(cfg('llama-local/local-128k', { agent_window: AW_OUT }), server(262144));
    assert.equal(d.n_ctx, 131072);
    assert.deepEqual(d.facets.context, { n_ctx: 131072, flags: ['-c 131072'] }, 'context flags filed at the effective size (filedFacets)');
    assert.deepEqual(d.facets.placement, ['-c 262144', '-dev CUDA0,CUDA1', '-fa on', '-ngl 999'], 'the server\'s own size: placement (speed rows)');
    assert.equal(d.launchConflict, false, 'the conflict check compares the launch -c with the SERVER, not the window');
    assert.equal(d.launchUnknown, false);
    // the real launch, wherever it is shown
    assert.match(d.launchCommand, / -c 262144 /);
    assert.match(d.launchSummary, /256k/);
    assert.deepEqual(d.facets.kv, ['--cache-type-k q8_0', '--cache-type-v q8_0']);
    assert.equal(d.ctx_label, '128k');
    assert.deepEqual(d.agentWindow, { window: 128000, effective_ctx: 131072, server_n_ctx: 262144, model: 'llama-local/local-128k', compaction_at: 111616,
        action: 'out-of-step', label: '128k', serverLabel: '256k' });
    const real128 = desc(cfg('llama-local/local-128k'), server(131072));
    const real262 = desc(cfg('llama-local/local-262k', { agent_window: AW_262 }), server(262144));
    // quality, the schedule key and the solve-map cell: one config with the in-step 128k row; a real 262k run apart
    assert.equal(d.identity('quality'), real128.identity('quality'));
    assert.equal(ID.scheduleKey(KEY, d.facets, 'L2'), ID.scheduleKey(KEY, real128.facets, 'L2'));
    assert.equal(ID.cellKey(KEY, d.facets), ID.cellKey(KEY, real128.facets));
    assert.notEqual(ID.cellKey(KEY, real262.facets), ID.cellKey(KEY, real128.facets));
    assert.match(ID.scheduleKey(KEY, real262.facets, 'L2'), /\["n_ctx",262144\]/);
    // speed / `full`: the two servers stay apart (the placement facet)
    assert.notEqual(d.identity('full'), real128.identity('full'));
    // -np and the other context flags stay; a record the harness wrote says where it is filed, nothing re-derives it
    const np = M.runDescriptor({ dir: 'b', config: cfg('llama-local/local-128k', { agent_window: AW_OUT }), server: { ...server(262144), launch_command: launch(262144).replace('-np 1', '-np 2') } }, 'local', KEY);
    assert.deepEqual(np.facets.context.flags, ['-c 131072', '-np 2']);
    const morning = desc(cfg('llama-local/local-128k', { agent_window: { ...AW_OUT, effective_ctx: 128000 } }), server(262144));
    assert.deepEqual([morning.n_ctx, morning.facets.context.flags], [128000, ['-c 128000']], 'the morning\'s record (128000) would be filed at 128000');
});

// ---------------------------------------------------------------- end to end: results -> catalog, identity, guard
const T0 = Date.parse('2026-10-23T12:00:00Z') / 1000;
function result(task, model, c, aw) {
    return { task, runner: 'opencode', model, status: 'pass', server: server(c), manifest: cfg(model), cap_used: 7200, ...(aw ? { agent_window: aw } : {}),
        run: { wall_s: 600, tokens_out: 100, tool_calls: 5, exit_code: 0 }, score: { solved: true, assertions: { passed: 3, failed: 0, total: 3 } } };
}
const DIRS = { real128: 'orn-128k-20261022', window128: 'orn-262k-20261023', real262: 'orn-262k-synced-20261025', inStep128: 'orn-128k-synced-20261025' };
function tree(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aw-root-'));
    for (const d of ['tasks', 'annotations', 'session-store']) fs.mkdirSync(path.join(root, d), { recursive: true });
    let n = 0;
    const put = (dir, data) => {
        fs.mkdirSync(path.join(root, 'results', dir), { recursive: true });
        const f = path.join(root, 'results', dir, `${data.task}.json`);
        fs.writeFileSync(f, JSON.stringify(data));
        const ts = T0 + n++ * 60;
        fs.utimesSync(f, ts, ts);
    };
    put(DIRS.real128, result('tk-1', 'llama-local/local-128k', 131072));                     // the real 128k row (before 10-25: no record)
    put(DIRS.real128, result('tk-2', 'llama-local/local-128k', 131072));
    put(DIRS.window128, result('tk-1', 'llama-local/local-128k', 262144, AW_OUT));           // the Ornith "262k" runs (backfilled)
    put(DIRS.window128, result('tk-3', 'llama-local/local-128k', 262144, AW_OUT));
    // an ABORTED one with no server record of its own: read against the battery's server, and carrying its own record (the
    // backfill takes the dir's shared server n_ctx for it), so it is filed with its siblings, not as a 262k row of its own
    put(DIRS.window128, { ...result('tk-5', 'llama-local/local-128k', 262144, AW_OUT), server: null, status: 'ABORTED', aborted: true, score: { solved: false } });
    put(DIRS.real262, result('tk-2', 'llama-local/local-262k', 262144, AW_262));            // a real 262k run, after the harness change
    put(DIRS.inStep128, result('tk-4', 'llama-local/local-128k', 131072, AW_128));           // a new in-step 128k run: the real 128k row
    const had = process.env.CODEBENCH_ANNOTATIONS_DIR;
    process.env.CODEBENCH_ANNOTATIONS_DIR = path.join(root, 'annotations');
    A._resetForTests();
    t.after(() => {
        if (had === undefined) delete process.env.CODEBENCH_ANNOTATIONS_DIR; else process.env.CODEBENCH_ANNOTATIONS_DIR = had;
        A._resetForTests(); M.configure({}); fs.rmSync(root, { recursive: true, force: true });
    });
    M.configure({
        paths: { csv: path.join(root, 'none.csv'), bestConfigs: path.join(root, 'none.md'), benchLog: path.join(root, 'none.log'), sweepState: path.join(root, 'none.json'),
            codebenchRoot: root, dashboardConfig: path.join(root, 'nope.json') },
        queueLaunch: new Map(), weightsRegistry: { paths: {} },
    });
    return root;
}
const ctxOf = (key) => JSON.parse(key).find(([k]) => k === 'n_ctx')[1];

test('catalog: the 128k-window runs are a config of their own (placement), one Solve-map row with the real 128k runs, read plainly "128k ctx"', async (t) => {
    tree(t);
    const cat = JSON.parse(JSON.stringify(M.listModels()));
    const m = cat.models.find((x) => x.key === KEY);
    assert.ok(m, 'the Ornith row');
    const by = new Map(m.configs.map((c) => [c.dirs.slice().sort().join(','), c]));
    assert.equal(m.configs.length, 3, 'real 128k (two dirs), the 128k window on a 262k server, real 262k');
    const real128 = by.get([DIRS.real128, DIRS.inStep128].sort().join(','));
    assert.ok(real128, 'a new in-step 128k result joins the real 128k row (same key as a result with no record)');
    assert.deepEqual([real128.n_ctx, real128.ctx_label, real128.agentWindow], [131072, '128k', undefined]);
    const w = by.get(DIRS.window128);
    assert.deepEqual([w.n_ctx, w.ctx_label, w.agentWindow.server_n_ctx, w.agentWindow.serverLabel], [131072, '128k', 262144, '256k']);
    assert.deepEqual(w.facets.context, { n_ctx: 131072, flags: ['-c 131072'] });
    assert.ok(w.facets.placement.includes('-c 262144'));
    assert.equal(w.tasks['tk-5'].status, 'ABORTED', 'the ABORTED row without a server record is in the 128k-window config');
    const r262 = by.get(DIRS.real262);
    assert.deepEqual([r262.n_ctx, r262.ctx_label, r262.agentWindow], [262144, '256k', undefined]);
    // the battery list on the model page
    const bat = new Map(m.batteries.map((b) => [b.dir, b]));
    assert.deepEqual([bat.get(DIRS.window128).n_ctx, bat.get(DIRS.window128).ctx_label, bat.get(DIRS.window128).agentWindow.serverLabel], [131072, '128k', '256k']);
    assert.deepEqual([bat.get(DIRS.real128).n_ctx, bat.get(DIRS.real128).agentWindow], [131072, undefined]);
    // the rows' words (ui/shared/leaderboard.js configText / ctxText)
    const L = await import('../ui/shared/leaderboard.js');
    assert.match(L.configText(m, real128), / · 128k ctx · /);
    assert.match(L.configText(m, w), / · 128k ctx \(agent window; 256k server\) · /);
    assert.match(L.configText(m, w, true), /128k ctx: agent window local-128k = 128000 tokens, compacting at 111616, on a server with n_ctx 262144 \(256k\), filed with the in-step 128k runs/);
    assert.match(L.configText(m, w, true), /-c 262144/, 'the full text shows the real launch');
    assert.match(L.configText(m, r262), / · 256k ctx · /);
    // the quality rows (the Models page's groups): the window runs join the real 128k row; real 262k apart
    const entries = m.configs.map((c) => ({ m, c }));
    const groups = L.groupConfigs(entries, L.FACET_DEFAULTS.quality);
    assert.equal(groups.length, 2);
    const g128 = groups.find((g) => g.dirs.includes(DIRS.window128));
    assert.deepEqual(g128.dirs.slice().sort(), [DIRS.inStep128, DIRS.real128, DIRS.window128].sort());
    assert.ok(g128.varies.includes('placement'), 'merged runs differ only in placement (the server size)');
    assert.equal(g128.c.agentWindow, undefined, 'a row pooling runs with and without a window has none');
    assert.match(L.configText(g128.m, g128.c), / · 128k ctx · /);
    assert.doesNotMatch(L.configText(g128.m, g128.c), /agent window/);
    assert.equal(L.ctxText(g128.c, 'short'), '128k');
    assert.ok(w.agentWindow, 'the catalog config itself is not touched (folds and fits are memoised on it)');
    // each member's own line keeps its note
    assert.ok(g128.members.some((e) => /agent window local-128k/.test(L.configText(e.m, e.c, true))));
    // public: the note survives the scrub, and the leak gate finds nothing
    const pub = sanitizeCatalog(cat).models.find((x) => x.key === KEY);
    assert.deepEqual(pub.configs.find((c) => c.dirs.includes(DIRS.window128)).agentWindow, w.agentWindow);
    const S = require('../public/staticsite');
    assert.deepEqual(S.leakScan('data/catalog.json', JSON.stringify(sanitizeCatalog(cat))).filter((h) => /dropped key/.test(h.what)), []);
});

test('server-side rows (the Benchmarks board): the 128k quality row pools both and reads plainly; a battery keeps its note', async (t) => {
    tree(t);
    const L = await import('../ui/shared/leaderboard.js');
    const q = M.listLeaderboards().quality.filter((x) => x.modelKey === KEY);
    assert.equal(q.length, 2, 'the 128k row (three batteries) and the real 262k row');
    const r128 = q.find((x) => x.dirs.includes(DIRS.window128));
    assert.deepEqual(r128.dirs.slice().sort(), [DIRS.inStep128, DIRS.real128, DIRS.window128].sort());
    assert.deepEqual([r128.n_ctx, r128.ctx_label, r128.agentWindow], [131072, '128k', undefined], 'mixed: no note, whichever run came first');
    assert.equal(L.ctxText(r128, 'row'), '128k ctx');
    // ...and a row of window runs only keeps it (the catalog's own config for that battery)
    const cfgW = M.listModels().models.find((x) => x.key === KEY).configs.find((c) => c.dirs.includes(DIRS.window128));
    assert.equal(L.ctxText(cfgW, 'row'), '128k ctx (agent window; 256k server)');
    const bat = M.listModels().models.find((x) => x.key === KEY).batteries.find((b) => b.dir === DIRS.window128);
    assert.equal(L.ctxText(bat, 'row'), '128k ctx (agent window; 256k server)', 'the model page\'s battery list');
});

test('identity: scored index and the duplicate guard key the 128k-window runs with the real 128k row; a real 262k run is never deduped against them', (t) => {
    tree(t);
    const idx = ID.scoredIndex();
    const k = (dir) => [...idx.byDir.get(dir)];
    assert.equal(k(DIRS.real128).length, 1);
    assert.deepEqual(k(DIRS.inStep128), k(DIRS.real128), 'in step: the same key as a result with no record');
    assert.equal(ctxOf(k(DIRS.real128)[0]), 131072);
    assert.equal(k(DIRS.window128).length, 1, 'the ABORTED row without a server record keys with its siblings');
    assert.deepEqual(k(DIRS.window128), k(DIRS.real128), 'the same schedule key as the real 128k row');
    assert.equal(ctxOf(k(DIRS.real262)[0]), 262144);
    const CLI = require('../tools/config-identity');
    const tasks = ['tk-1', 'tk-2', 'tk-3', 'tk-4'];
    const scored = (spec) => { const r = CLI.answer('check', { spec, tasks }); return [r.identity && r.identity.key, Object.keys(r.scored).sort()]; };
    // the in-battery guard (harness/config_identity.py Guard.from_env): the battery config carries agent_window
    const guard262 = { dir: 'orn-262k-new', config: cfg('llama-local/local-262k', { agent_window: AW_262 }), server: server(262144) };
    assert.deepEqual(scored(guard262), [k(DIRS.real262)[0], ['tk-2']], 'a real 262k battery skips only real 262k runs, not tk-1 / tk-3 (128k window)');
    // a queue item before launch (run.py --print-config: no record; the launch -c, where the harness will put the alias)
    const pre262 = { dir: null, config: cfg('llama-local/local-128k'), launch: launch(262144) };
    assert.deepEqual(scored(pre262), [k(DIRS.real262)[0], ['tk-2']], 'pre-launch: keyed at -c 262144');
    const pre128 = { dir: null, config: cfg('llama-local/local-128k'), launch: launch(131072) };
    assert.deepEqual(scored(pre128), [k(DIRS.real128)[0], ['tk-1', 'tk-2', 'tk-3', 'tk-4']], 'the 262k-server window runs count as scored at 128k');
    // a battery that runs a 128k window on a 262k server on purpose (CODEBENCH_AGENT_WINDOW=as-asked): its guard keys where
    // the harness files it (131072, the real 128k row): it is the same config, so it skips what that row scored
    const guardAsAsked = { dir: 'orn-asasked', config: cfg('llama-local/local-128k', { agent_window: { ...AW_OUT, action: 'as-asked' } }), server: server(262144) };
    assert.deepEqual(scored(guardAsAsked), [k(DIRS.real128)[0], ['tk-1', 'tk-2', 'tk-3', 'tk-4']]);
    // ...but before launch such an item keys at its -c (the alias window is not modelled: lib/configid.js specRun), so it
    // needs CODEBENCH_ALLOW_RERUN on the item (documented there)
    const preAsAsked = { dir: null, config: cfg('llama-local/local-128k'), launch: launch(262144), env: { CODEBENCH_AGENT_WINDOW: 'as-asked' } };
    assert.equal(scored(preAsAsked)[0], k(DIRS.real262)[0]);
});
