'use strict';
// ONE CONTEXT-LABEL RULE (2026-10-25, Kyle: "one context-label rule"). ui/shared/ctxlabel.js ctxLabel(): a size named in
// thousands reads its name (local-128k's 128000 -> 128k), any other in kibi as before (131072 -> 128k, 262144 -> 256k).
// Until now the catalog had it (lib/models.js) while a dozen other places did n / 1024 themselves, so 128000 read "125k"
// there; now lib/models.js, lib/runlabel.js, the ES modules (through ui/benchmarks/util.js) and the classic scripts
// (script.js, the launch sidebar) all call the one function. And commonWindow(): a merged row's agent-window note, one
// rule for the server's groups and the pages'.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const CL = require('../ui/shared/ctxlabel.js');
const M = require('../lib/models');
const A = require('../lib/annotations');

const ui = (rel) => import(pathToFileURL(path.join(__dirname, '..', 'ui', rel)).href);

// every n_ctx in codebench results/ on 2026-10-25, with what every page printed for it (Math.round(n / 1024) + 'k')
const ON_RECORD = [32768, 65536, 81920, 98304, 122880, 131072, 196608, 229376, 262144, 524288, 1048576];

test('the rule: every server context on record reads as before; a size named in thousands reads its name', () => {
    for (const n of ON_RECORD) assert.equal(CL.ctxLabel(n), `${Math.round(n / 1024)}k`, String(n));
    assert.equal(CL.ctxLabel(128000), '128k', 'local-128k: 128000 = 125 x 1024 read "125k" outside the catalog');
    assert.equal(CL.ctxLabel(63000), '63k');
    assert.equal(CL.ctxLabel(80000), '80k');
    assert.equal(CL.ctxLabel('262144'), '256k', 'a form field\'s string');
    assert.equal(CL.ctxLabel(512), '512', 'below 1024: the number (the profile picker and model page printed it so)');
    for (const x of [null, undefined, 0, -1, '', 'x', NaN]) assert.equal(CL.ctxLabel(x), null, String(x));
});

test('one copy: lib/models.js, util.js and the classic-script global are the same function', async () => {
    assert.equal(M.ctxLabel, CL.ctxLabel);
    assert.equal(globalThis.CtxLabel.ctxLabel, CL.ctxLabel);
    const U = await ui('benchmarks/util.js');
    assert.equal(U.ctxLabel, CL.ctxLabel);
    assert.equal(U.commonWindow, CL.commonWindow);
});

test('no second copy: nothing under lib/ or ui/, script.js or the public server formats a context with n / 1024 itself', () => {
    const root = path.join(__dirname, '..');
    // `${Math.round(x / 1024)}k`, Math.round(x / 1024) + 'k', `${esc(Math.round(x / 1024))}k`, x % 1024 === 0 ? `${x / 1024}k`
    const RE = /Math\.round\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*?\/\s*1024\s*\)\)?\s*(?:\}k|\+\s*'k')|%\s*1024\s*===\s*0\s*\?\s*`\$\{[^}]*\/\s*1024\}k/;
    // not context sizes: the prefill charts' prompt-length axis ticks (ui/models/charts.js); and the rule itself
    const ALLOWED = { 'ui/models/charts.js': 2, 'ui/shared/ctxlabel.js': 1 };
    const files = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.js$/.test(e.name)) files.push(p); } };
    walk(path.join(root, 'ui')); walk(path.join(root, 'lib'));
    for (const f of ['script.js', 'server4.js', 'public/server.js', 'public/staticsite.js']) files.push(path.join(root, f));
    const hits = {};
    for (const f of files) {
        const rel = path.relative(root, f).split(path.sep).join('/');
        fs.readFileSync(f, 'utf-8').split('\n').forEach((l, i) => { if (RE.test(l)) (hits[rel] = hits[rel] || []).push(i + 1); });
    }
    const extra = Object.entries(hits).filter(([f, ls]) => ls.length !== (ALLOWED[f] || 0)).map(([f, ls]) => `${f}:${ls.join(',')}`);
    assert.deepEqual(extra, [], 'a context formatted outside ui/shared/ctxlabel.js');
});

test('the places that printed 125k for 128000 now read 128k, and power-of-two contexts read as before', async () => {
    // lib/models.js configKey (a launch's short label: the Models page's launchSummary, the speed rows)
    assert.match(M.configKey(M.parseFlags('/b/llama-server -m /m/x.gguf -c 128000')), /\b128k\b/);
    assert.match(M.configKey(M.parseFlags('/b/llama-server -m /m/x.gguf -c 98304')), /\b96k\b/);
    // lib/runlabel.js (the Live card's line)
    const RL = require('../lib/runlabel');
    assert.match(RL.describeRun({ runner: 'opencode' }, { model_path: '/m/Qwen3.8-27B-UD-Q2_K_XL.gguf', n_ctx: 128000 }).line, / · 128k ctx/);
    assert.match(RL.describeRun({ runner: 'opencode' }, { model_path: '/m/Qwen3.8-27B-UD-Q2_K_XL.gguf', n_ctx: 65536 }).line, / · 64k ctx/);
    // ui/benchmarks/util.js (the Live card's chip)
    const U = await ui('benchmarks/util.js');
    assert.match(U.runInfoHtml({ ctx: 128000 }), />128k ctx</);
    assert.match(U.runInfoHtml({ ctx: 262144 }), />256k ctx</);
    // ui/shared/leaderboard.js: a Strata config's max context, ctxText without a catalog label
    const L = await ui('shared/leaderboard.js');
    assert.match(L.strataLaunchText({ config: 'x.json', facts: { ctx: 128000 } }, true, 262144), /128k max context/);
    assert.equal(L.ctxText({ n_ctx: 128000 }, 'row'), '128k ctx', 'a catalog from before 10-25 (no ctx_label): the same rule');
    assert.equal(L.ctxText({ n_ctx: 229376 }, 'short'), '224k');
    // ui/profilepicker/rows.js (the launch panel's profile chips)
    const R = await ui('profilepicker/rows.js');
    assert.equal(R.profileFacts('p', { config: { ctx: 128000 } }).ctxText, '128k');
    assert.equal(R.profileFacts('p', { config: { ctx: 131072 } }).ctxText, '128k');
    assert.equal(R.profileFacts('p', { config: { ctx: 229376 } }).ctxText, '224k');
});

test('the classic scripts read it from the global: index.html loads ctxlabel.js before script.js and the sidebar', () => {
    const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf-8');
    const at = (src) => html.indexOf(`<script src="./${src}"`);
    assert.ok(at('ui/shared/ctxlabel.js') > 0);
    assert.ok(at('ui/shared/ctxlabel.js') < at('script.js'));
    assert.ok(at('ui/shared/ctxlabel.js') < at('ui/shared/sidegroups.js'));
    // ...and the public site serves it (util.js imports it): both allowlists
    const S = require('../public/staticsite');
    assert.ok(S.ASSET_FILES.some(([k]) => k === 'ui/shared/ctxlabel.js'));
    assert.match(fs.readFileSync(path.join(__dirname, '..', 'public', 'server.js'), 'utf-8'), /'ui\/shared\/ctxlabel\.js'/);
});

// ---------------------------------------------------------------- a merged row's agent-window note
const AW = { window: 128000, effective_ctx: 131072, server_n_ctx: 262144, model: 'llama-local/local-128k', compaction_at: 111616, action: 'out-of-step', label: '128k', serverLabel: '256k' };

test('commonWindow: the note every member carries, else none', () => {
    assert.equal(CL.commonWindow([]), null);
    assert.deepEqual(CL.commonWindow([{ agentWindow: AW }, { agentWindow: { ...AW } }]), AW, 'identical notes: kept');
    assert.equal(CL.commonWindow([{ agentWindow: AW }, {}]), null, 'with a run without one: plain');
    assert.equal(CL.commonWindow([{}, { agentWindow: AW }]), null, 'in either order');
    assert.equal(CL.commonWindow([{ agentWindow: AW }, { agentWindow: { ...AW, server_n_ctx: 196608, serverLabel: '192k' } }]), null, 'two servers: plain');
    assert.equal(CL.commonWindow([null, { agentWindow: AW }]), null);
});

test('groupConfigs: a row pooling configs with and without a window reads plainly; the catalog configs are not touched', async () => {
    const L = await ui('shared/leaderboard.js');
    const m = { key: 'local:x:q4', display: 'X Q4' };
    const facets = (placement) => ({ weights: m.key, harness: { runner: 'opencode' }, context: { n_ctx: 131072, flags: ['-c 131072'] }, output: [], kv: [], other: [], placement });
    const base = { runner: 'opencode', n_ctx: 131072, ctx_label: '128k', tasks: {}, dirs: [] };
    const win = { ...base, facets: facets(['-c 262144', '-ncmoe 2']), agentWindow: AW, agg: { scored: 200 }, dirs: ['w'], launchSummary: 'b · 256k · ncmoe2' };
    const real = { ...base, facets: facets([]), agg: { scored: 70 }, dirs: ['r'], launchSummary: 'b · 128k' };
    const small = { ...base, facets: facets(['-ncmoe 26']), agg: { scored: 1 }, dirs: ['s'], launchSummary: 'b · 128k · ncmoe26' };
    for (const order of [[win, real, small], [real, small, win], [small, win, real]]) {
        const [g] = L.groupConfigs(order.map((c) => ({ m, c })), L.FACET_DEFAULTS.quality);
        assert.equal(g.members.length, 3);
        assert.equal(g.c, real, 'the words come from the most-scored member without a window: a real launch at the row\'s size');
        assert.equal(L.ctxText(g.c, 'row'), '128k ctx');
        assert.equal(L.configText(m, g.c), 'opencode · 128k ctx · b · 128k');
        assert.deepEqual(g.varies, ['placement']);
        assert.ok(g.members.some((e) => /agent window/.test(L.configText(e.m, e.c, true))), 'the window member\'s own line keeps its note');
    }
    assert.equal(win.agentWindow, AW, 'the catalog config keeps its note');
    // every member under a window, but not the same one: a copy of the most-scored, without the note
    const win2 = { ...win, agentWindow: { ...AW, server_n_ctx: 196608, serverLabel: '192k' }, agg: { scored: 5 }, dirs: ['w2'] };
    const [g2] = L.groupConfigs([{ m, c: win }, { m, c: win2 }], L.FACET_DEFAULTS.quality);
    assert.notEqual(g2.c, win);
    assert.deepEqual([g2.c.agg.scored, g2.c.agentWindow, L.ctxText(g2.c, 'row')], [200, undefined, '128k ctx']);
    assert.equal(win.agentWindow, AW);
    const [solo] = L.groupConfigs([{ m, c: win }], L.FACET_DEFAULTS.quality);
    assert.equal(solo.c, win, 'one member: the config itself');
    assert.equal(L.ctxText(solo.c, 'row'), '128k ctx (agent window; 256k server)');
});

// lib/models.js groupEntriesByConfig, both orders of the batteries: a window battery read first and then an in-step one,
// and the other way round, give one quality row with no note
const ORN = '/m/Ornith-1.5-35B-Q4_K_M.gguf';
const launch = (c) => `/b/llama-server -m ${ORN} -c ${c} -ngl 999 -fa on -np 1 --jinja --cache-type-k q8_0 --cache-type-v q8_0 -dev CUDA0,CUDA1${c > 131072 ? ' -ncmoe 2' : ''}`;
const RAW_AW = { asked: 'llama-local/local-128k', model: 'llama-local/local-128k', window: 128000, server_n_ctx: 262144, compaction_at: 111616, effective_ctx: 131072, action: 'out-of-step', why: 'x' };
function tree(t, dirs) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ctxl-root-'));
    for (const d of ['tasks', 'annotations', 'session-store']) fs.mkdirSync(path.join(root, d), { recursive: true });
    let n = 0;
    for (const [dir, c, aw] of dirs) for (const task of ['tk-1', 'tk-2']) {
        fs.mkdirSync(path.join(root, 'results', dir), { recursive: true });
        const f = path.join(root, 'results', dir, `${task}.json`);
        const cfg = { runner: 'opencode', model: 'llama-local/local-128k', prompt_level: 'L2', harness_mode: 'agentic', timeout_s: 7200 };
        fs.writeFileSync(f, JSON.stringify({ task, runner: 'opencode', model: cfg.model, status: 'pass', manifest: cfg, cap_used: 7200,
            server: { model_path: ORN, build_info: 'b1-abc', n_ctx: c, launch_command: launch(c) }, ...(aw ? { agent_window: aw } : {}),
            run: { wall_s: 600, tokens_out: 100, tool_calls: 5, exit_code: 0 }, score: { solved: true, assertions: { passed: 1, failed: 0, total: 1 } } }));
        const ts = Date.parse('2026-10-23T12:00:00Z') / 1000 + n++ * 60;
        fs.utimesSync(f, ts, ts);
    }
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
}

for (const [name, dirs] of [
    ['window battery first', [['a-orn-262k', 262144, RAW_AW], ['b-orn-128k', 131072, null]]],
    ['in-step battery first', [['a-orn-128k', 131072, null], ['b-orn-262k', 262144, RAW_AW]]],
]) {
    test(`listLeaderboards: one 128k quality row with no note (${name}); the catalog keeps one config per server`, (t) => {
        tree(t, dirs);
        const q = M.listLeaderboards().quality;
        assert.equal(q.length, 1);
        assert.deepEqual([q[0].dirs.length, q[0].n_ctx, q[0].ctx_label, q[0].agentWindow], [2, 131072, '128k', undefined]);
        const m = M.listModels().models.find((x) => x.configs && x.configs.some((c) => c.dirs.includes(dirs[0][0])));
        assert.equal(m.configs.length, 2, 'full: -ncmoe 2 and the server\'s -c 262144 (placement) keep the speed rows apart');
        const w = m.configs.find((c) => c.agentWindow);
        assert.equal(w.dirs.join(), dirs.find((d) => d[2])[0]);
        assert.match(w.launchCommand, / -c 262144 /, 'the real launch');
    });
}
