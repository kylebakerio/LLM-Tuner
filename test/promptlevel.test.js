'use strict';
// PROMPT LEVELS ARE PROBLEMS (2026-10-17). Kyle: "you've made 'prompt L3' just another version of the same test. No,
// every different prompt is a different PROBLEM. Now q2 looks stronger than q8 because l3 prompts have been attempted
// by one not the other but the passes and fails of the easy version and hard versions are all mixed up. fix that."
// A result of task T at prompt level L3 is the problem `T@L3` (its bonus test `T@L3+bonus`): its own difficulty, task
// points, grid column and task page, metadata from T. The level left the config's identity: one model + launch +
// harness at L2 and at L3 is ONE row with two problems. Prompt VARIANTS (careful-tone, review ...) are unchanged.
// "Already ran" still compares problems (lib/configid scheduleKey, byte for byte what it was).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseHTML } = require('linkedom');
const M = require('../lib/models');
const ID = require('../lib/configid');
const P = require('../lib/publicdata');

const lb = () => import('../ui/shared/leaderboard.js');
const Q4 = '/m/Qwen3.8-27B-UD-Q4_K_XL.gguf';
const LAUNCH = `/b/llama-server -m ${Q4} -c 131072 -ngl 999 -fa on -np 1 --jinja --spec-type draft-mtp,ngram-mod --cache-type-k q8_0 --cache-type-v q8_0 -dev ROCm0`;
const cfg = (o = {}) => ({ runner: 'opencode', model: 'llama-local/qwen38-27b-q4-128k', prompt_level: 'L2', harness_mode: 'agentic', timeout_s: 7200, ...o });
const srv = () => ({ model_path: Q4, n_ctx: 131072, launch_command: LAUNCH, build_info: 'b1-abc' });

test('problem ids: T at L2, T@L3 at L3, T@L3+bonus for its bonus; a task NAMED -L3 is its own task; both copies agree', async () => {
    const L = await lb();
    const cases = [['fix-a', 'L3', 'fix-a@L3'], ['fix-a', 'L2', 'fix-a'], ['fix-a', null, 'fix-a'], ['fix-a', '', 'fix-a'], ['fix-a', 'L2+docs', 'fix-a'],
        ['fix-a', 'L3+careful-tone', 'fix-a@L3'], ['fix-a', 'l1', 'fix-a@L1'], ['fix-b+bonus', 'L3', 'fix-b@L3+bonus'], ['demo-combo-fix-L3', 'L2', 'demo-combo-fix-L3'],
        ['demo-combo-fix-L3', 'L3', 'demo-combo-fix-L3@L3']];
    for (const [t, l, want] of cases) {
        assert.equal(M.problemId(t, l), want, `${t} ${l}`);
        assert.equal(L.problemId(t, l), want, `browser: ${t} ${l}`);
    }
    for (const id of ['fix-a', 'fix-a@L3', 'fix-b+bonus', 'fix-b@L3+bonus', 'demo-combo-fix-L3', 'demo-combo-fix-L3@L3', 'x@y']) {
        assert.deepEqual(L.problemOf(id), M.problemOf(id), id);
        const p = M.problemOf(id);
        assert.equal(M.problemId(p.task, p.level), id, `round trip ${id}`);
    }
    assert.deepEqual(M.problemOf('fix-b@L3+bonus'), { id: 'fix-b@L3+bonus', task: 'fix-b+bonus', base: 'fix-b', level: 'L3', bonus: true });
    assert.deepEqual(M.problemOf('demo-combo-fix-L3'), { id: 'demo-combo-fix-L3', task: 'demo-combo-fix-L3', base: 'demo-combo-fix-L3', level: 'L2', bonus: false });
    for (const pl of [null, '', 'L2', 'L3', 'L2+careful-tone', 'L3+careful-tone', 'L2+implement-plan-task-first']) {
        assert.equal(L.promptLevel(pl), M.promptLevelOf(pl), String(pl));
        assert.equal(L.promptVariant(pl) ? `L2+${L.promptVariant(pl)}` : 'L2', M.promptWithoutLevel(pl), String(pl));
    }
});

test('runDescriptor: the level is not in the identity (L2 and L3 of one config are one row); the variant still is', () => {
    M.configure({ queueLaunch: new Map(), weightsRegistry: { paths: {} } });
    const key = 'local:qwen3.8-27b:q4-k-xl';
    const d = (pl) => M.runDescriptor({ dir: 'b', config: cfg({ prompt_level: pl }), server: srv() }, 'local', key);
    const id = (pl) => d(pl).identity('full');
    assert.equal(id('L3'), id('L2'));
    assert.equal(id(null), id('L2'));
    assert.equal(id('L3+careful-tone'), id('L2+careful-tone'));
    assert.notEqual(id('L2+careful-tone'), id('L2'));
    assert.deepEqual([d('L3').level, d('L3').facets.harness.prompt_level, d('L3+careful-tone').facets.harness.prompt_level, d(null).level], ['L3', 'L2', 'L2+careful-tone', 'L2']);
    // an L2 row's identity string is what it always was (the harness facet spells the prompt 'L2')
    assert.match(id('L2'), /"prompt_level":"L2","harness_mode":"agentic"/);
    M.configure({});
});

test('configid: the scheduling key is unchanged (level back in the harness, same place), so an L2 run never covers T at L3', () => {
    M.configure({ queueLaunch: new Map(), weightsRegistry: { paths: {} } });
    const spec = (pl) => ({ dir: 'b', config: cfg({ prompt_level: pl }), launch: LAUNCH, env: {} });
    const l3 = ID.identityOfSpec(spec('L3')), l2 = ID.identityOfSpec(spec('L2')), l3c = ID.identityOfSpec(spec('L3+careful-tone'));
    assert.notEqual(l3.key, l2.key);
    // the key as it was built before 2026-10-17 (the harness facet carrying the recorded prompt_level), byte for byte
    const old = (pl) => { const f = M.runDescriptor({ dir: 'b', config: cfg({ prompt_level: pl }), server: { model_path: Q4, n_ctx: 131072, launch_command: LAUNCH } }, 'local', l2.modelKey).facets;
        return ID.scheduleKey(l2.modelKey, { ...f, harness: { ...f.harness, prompt_level: pl } }); };
    assert.equal(l3.key, old('L3'));
    assert.equal(l3c.key, old('L3+careful-tone'));
    assert.equal(l2.key, old('L2'));
    assert.equal(JSON.parse(l3.key)[1][1].prompt_level, 'L3', 'tools/tier-list.py reads key[1][1].prompt_level');
    assert.equal(l3.cell, l2.cell, 'the solve-map cell: one row');
    M.configure({});
});

// ---------------------------------------------------------------- the catalog over a fixture codebench
function fixture(t) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'promptlevel-'));
    const root = path.join(tmp, 'cb');
    t.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); M.configure({}); });
    const task = (repo, id, extra) => { const d = path.join(root, 'tasks', repo, id); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'task.yaml'), `id: ${id}\n${extra || ''}`); };
    task('r', 'fix-a', 'tier_predicted: t1\nsample_group: grp\ncategory: [bugfix]\n');
    task('r', 'fix-a2', 'tier_predicted: t2\nsample_group: grp\n');
    task('r', 'fix-b', 'tier_predicted: t3\nextra_tests:\n- test/x.js\n');
    task('r', 'multi-x-L3', 'tier_predicted: t3\n');
    task('_synthetic', 'needle', 'category: [needle, diagnostic]\n');
    task('r', 'gone', 'retired: true\n');
    fs.mkdirSync(path.join(root, 'results'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tasks', 'skills.json'), JSON.stringify({ tags: { sync: 'sync bugs' }, tasks: { 'fix-a': ['sync'] } }));
    const row = (task, status, o = {}) => ({ task, status, solved: status === 'pass', wall_s: 300, tokens_out: 900, tool_calls: 4, ran_at: 1, ...o });
    // a row with its own config (a result's manifest): the level read from it, not from the battery's
    const own = (r, pl) => ({ ...r, rowConfig: { config: cfg({ prompt_level: pl }), server: srv() } });
    const bats = {
        'q4-l2': { config: cfg(), rows: [row('fix-a', 'pass'), row('fix-a2', 'pass'), row('fix-b', 'pass'), { ...row('fix-b+bonus', 'pass'), bonus: true, parent: 'fix-b' }, row('multi-x-L3', 'pass'), row('needle', 'pass')] },
        'q4-l3': { config: cfg({ prompt_level: 'L3' }), rows: [row('fix-a', 'fail'), row('fix-b', 'fail'), { ...row('fix-b+bonus', 'fail'), bonus: true, parent: 'fix-b' }, row('needle', 'fail'), row('gone', 'pass')] },
        'q4-mixed': { config: cfg(), rows: [own(row('fix-a2', 'fail'), 'L3')] },
        'INVALID-q4-l3': { config: cfg({ prompt_level: 'L3' }), rows: [row('multi-x-L3', 'pass')] },
        'q4-careful-l3': { config: cfg({ prompt_level: 'L3+careful-tone' }), rows: [row('fix-a', 'pass')] },
        'q4-careful-l2': { config: cfg({ prompt_level: 'L2+careful-tone' }), rows: [row('fix-b', 'pass')] },
    };
    M.configure({
        paths: { csv: path.join(tmp, 'none.csv'), bestConfigs: path.join(tmp, 'none.md'), benchLog: path.join(tmp, 'none.log'), sweepState: path.join(tmp, 's.json'),
            codebenchRoot: root, dashboardConfig: path.join(tmp, 'nope.json') },
        codebench: { listRuns: () => Object.entries(bats).map(([dir, b], i) => ({ dir, ended: i + 1, config: b.config, server: srv(), tasks: b.rows.length })),
            getRun: (dir) => ({ rows: bats[dir].rows }) },
        queueLaunch: new Map(), weightsRegistry: { paths: {} },
    });
    return { root, bats };
}

test('catalog: ONE config row holds T and T@L3 as two problems; the careful-tone variant stays its own row at both levels', (t) => {
    fixture(t);
    const cat = M.listModels();
    assert.equal(cat.models.length, 1);
    const m = cat.models[0];
    const plain = m.configs.filter((c) => c.prompt_level === 'L2');
    assert.equal(plain.length, 1, 'L2 and L3 batteries of one config: one row');
    const c = plain[0];
    assert.deepEqual(c.dirs.sort(), ['q4-l2', 'q4-l3', 'q4-mixed']);
    assert.deepEqual(c.prompt_levels, ['L2', 'L3']);
    assert.deepEqual(Object.keys(c.tasks).sort(), ['fix-a', 'fix-a2', 'fix-a2@L3', 'fix-a@L3', 'fix-b', 'fix-b+bonus', 'fix-b@L3', 'fix-b@L3+bonus', 'multi-x-L3']);
    // the easy and the hard version never fold into one sample: fix-a passed at L2, failed at L3
    assert.deepEqual([c.tasks['fix-a'].credit, c.tasks['fix-a@L3'].credit, c.tasks['fix-a'].attempts, c.tasks['fix-a@L3'].attempts], [1, 0, 1, 1]);
    assert.equal(c.tasks['fix-a2@L3'].credit, 0, 'a row whose own config says L3 is the L3 problem, whatever its battery says');
    assert.equal(c.agg.attempted, 9);
    // the diagnostic task at either level is shown apart, never scored
    assert.deepEqual(Object.keys(c.diagnostics).sort(), ['needle', 'needle@L3']);
    // the model's own roll-up: the same nine problems, never T's two levels in one sample
    assert.deepEqual(Object.keys(m.tasks).sort(), ['fix-a', 'fix-a2', 'fix-a2@L3', 'fix-a@L3', 'fix-b', 'fix-b+bonus', 'fix-b@L3', 'fix-b@L3+bonus', 'multi-x-L3']);
    // it pools CONFIGS (careful-tone's L3 pass of fix-a joins the plain L3 fail), never levels (the L2 pass stays T's)
    assert.deepEqual([m.tasks['fix-a'].credit, m.tasks['fix-a@L3'].credit, m.tasks['fix-a@L3'].attempts], [1, 0.5, 2]);
    // careful-tone: one row for its L2 and L3 runs, its problems kept apart
    const careful = m.configs.filter((x) => x.prompt_level === 'L2+careful-tone');
    assert.equal(careful.length, 1);
    assert.deepEqual(Object.keys(careful[0].tasks).sort(), ['fix-a@L3', 'fix-b']);
    assert.deepEqual(careful[0].prompt_levels, ['L2', 'L3']);
});

test('problem universe: tasks + level problems with a result (not INVALID-, not retired, not diagnostic); metadata from the task', (t) => {
    fixture(t);
    const cat = M.listModels();
    const levelIds = Object.keys(cat.taskMeta).filter((id) => id.includes('@')).sort();
    assert.deepEqual(levelIds, ['fix-a2@L3', 'fix-a@L3', 'fix-b@L3', 'fix-b@L3+bonus', 'needle@L3']);
    // suite: fix-a, fix-a2, fix-b, fix-b+bonus, multi-x-L3 (5; needle is diagnostic, gone retired). The 4 L3 problems are
    // in the metadata but not the total: 1 or 2 config rows scored them, under LEVEL_MIN_CONFIGS (the threshold test below)
    assert.equal(cat.taskTotal, 5);
    assert.equal(cat.models[0].taskTotal, 5);
    assert.deepEqual([cat.taskMeta['fix-a@L3'].unscored, cat.taskMeta['fix-a@L3'].scoredConfigs, cat.taskMeta['fix-b@L3'].scoredConfigs, cat.levelMinConfigs], [true, 2, 1, 5]);
    assert.equal(cat.taskMeta['fix-a'].unscored, undefined, 'plain L2 tasks are never held back');
    assert.ok(!cat.allTaskIds.some((id) => id.includes('@')), 'the planner\'s candidates stay task ids');
    assert.equal(cat.allTaskIds.length, 5);
    const a = cat.taskMeta['fix-a@L3'];
    assert.deepEqual([a.tier, a.sample_group, a.repo, a.category, a.level, a.base, a.label, a.skills], ['t1', 'grp', 'r', ['bugfix'], 'L3', 'fix-a', 'fix-a (prompt L3)', ['sync']]);
    const b = cat.taskMeta['fix-b@L3+bonus'];
    assert.deepEqual([b.bonus, b.parent, b.level, b.base, b.tier], [true, 'fix-b@L3', 'L3', 'fix-b', 't3']);
    assert.equal(cat.taskMeta['needle@L3'].diagnostic, true, 'diagnostic follows the task');
    assert.ok(cat.diagnosticTaskIds.includes('needle@L3'));
    assert.ok(!('gone@L3' in cat.taskMeta) && !('gone' in cat.taskMeta), 'retired follows the task');
    assert.ok(!('multi-x-L3@L3' in cat.taskMeta), 'only in an INVALID- battery: not a problem yet');
    // the helpers on their own
    const meta = M.readTaskMeta();
    assert.equal(M.metaOf(meta, 'fix-a@L3').tier, 't1');
    assert.equal(M.metaOf(meta, 'nope@L3'), null);
    assert.equal(M.isDiagnosticTask('needle@L3', meta), true);
    assert.equal(M.scoredTaskTotal(M.withLevelProblems(meta, ['fix-a@L3', 'needle@L3', 'nope@L3'])), M.scoredTaskTotal(meta) + 1);
    // a problem not scored yet still shows (its row's tasks map), marked; the coverage numerator leaves it out
    const plain = cat.models[0].configs.find((c) => c.prompt_level === 'L2');
    assert.equal(plain.tasks['fix-a@L3'].unscored, true);
    assert.deepEqual([plain.agg.attempted, plain.agg.counted], [9, 5]);
    // the model page's samples carry the result file's id
    const s = M.getModel(cat.models[0].key).qualityDetail.samples.find((x) => x.task === 'fix-a@L3');
    assert.deepEqual([s.base_task, s.level, s.tier], ['fix-a', 'L3', 't1']);
    // the Live view's per-task baseline is per problem
    const h = M.taskHistory().tasks;
    assert.deepEqual([h['fix-a'].solvedBy, h['fix-a@L3'].configs], [1, 2]);
    // the public catalog keeps a problem's level and task name
    assert.deepEqual(P.sanitizeCatalog(cat).taskMeta['fix-a@L3'].level, 'L3');
    assert.deepEqual(P.sanitizeCatalog(cat).taskMeta['fix-a@L3'].base, 'fix-a');
});

test('strength fit over the catalog: T@L3 is its own item with its own points; the prompt facet keys on the variant only', async (t) => {
    fixture(t);
    const L = await lb();
    const cat = M.listModels();
    const fit = L.fitFor(cat.models, L.FACET_DEFAULTS.quality, L.FACET_DEFAULTS.full);
    for (const id of ['fix-a', 'fix-a@L3', 'fix-b@L3+bonus']) assert.ok(fit.adj.taskDifficulty.has(id), id);
    assert.ok(fit.adj.taskDifficulty.get('fix-a@L3') > fit.adj.taskDifficulty.get('fix-a'), 'failed at L3 everywhere it was not passed: harder than its L2 self');
    // 2 config rows scored it (< LEVEL_MIN_CONFIGS): held -- a difficulty of its own, 0 points
    assert.equal(fit.adj.taskPoints.get('fix-a@L3'), 0);
    assert.equal(fit.adj.levelUnscored.get('fix-a@L3'), 2);
    // with the minimum at 1 it is an item of the fit like any task
    const adj1 = L.difficultyAdjusted(fit.qAll, { minConfigs: 1 });
    assert.ok(adj1.taskPoints.get('fix-a@L3') > 0);
    const facets = [...fit.adj.facetEffects.keys()];
    assert.ok(!facets.some((k) => /^prompt:L3/.test(k)), facets.join(' '));
    assert.ok(facets.includes('prompt:L2+careful-tone'), facets.join(' '));
    // the fit facet on its own: an L3+careful-tone config shares the L2 variant's key; a bare L3 one (an older catalog) has none
    const tk = (s) => ({ status: s ? 'pass' : 'fail', solved: !!s, excluded: false, credit: s, attempts: 1, passes: s });
    const g = (key, pl, tasks) => ({ key, m: { key: 'm' + key }, c: { facets: { harness: { prompt_level: pl } } }, tasks });
    const adj = L.difficultyAdjusted([g('a', 'L3', { x: tk(1), y: tk(0) }), g('b', 'L3+careful-tone', { x: tk(1) }), g('c', 'L2', { x: tk(0), y: tk(1) })]);
    assert.deepEqual([...adj.facetEffects.keys()], ['prompt:L2+careful-tone']);
});

test('per-case results (lib/codebench listTaskCases): T is its L2 results only, T@L3 its L3 ones', (t) => {
    const C = require('../lib/codebench');
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'promptlevel-cases-'));
    t.after(() => { fs.rmSync(root, { recursive: true, force: true }); C._resetForTests(); C.configure({}); });
    fs.mkdirSync(path.join(root, 'tasks', 'r', 'fix-a'), { recursive: true });
    fs.writeFileSync(path.join(root, 'tasks', 'r', 'fix-a', 'task.yaml'), 'id: fix-a\n');
    const result = (pl, status) => ({ task: 'fix-a', runner: 'opencode', status, manifest: { runner: 'opencode', ...(pl ? { prompt_level: pl } : {}), timeout_s: 7200 },
        run: { wall_s: 60 }, score: { solved: status === 'pass', fail_to_pass: { cases: [{ name: 'c1', status: status === 'pass' ? 'pass' : 'fail' }] } } });
    for (const [dir, pl, st] of [['b-l2', 'L2', 'pass'], ['b-old', null, 'pass'], ['b-l3', 'L3', 'fail'], ['b-l3c', 'L3+careful-tone', 'fail']]) {
        fs.mkdirSync(path.join(root, 'results', dir), { recursive: true });
        fs.writeFileSync(path.join(root, 'results', dir, 'fix-a.json'), JSON.stringify(result(pl, st)));
    }
    C._resetForTests(); C.configure({ root, python: 'python3' });
    assert.deepEqual(C.listTaskCases('fix-a', root).map((x) => x.dir), ['b-l2', 'b-old']);
    assert.deepEqual(C.listTaskCases('fix-a@L3', root).map((x) => x.dir), ['b-l3', 'b-l3c']);
    assert.deepEqual(C.listTaskCases('fix-a@L1', root), []);
});

test('planner (derive.js levelTasks): an L3 config reads its row\'s T@L3 problems as task T; an L2 one never sees them', async () => {
    const { levelTasks } = await import('../ui/autoqueue/derive.js');
    const r = (passes) => ({ attempts: 1, passes });
    const tasks = { a: r(1), 'a@L3': r(0), 'b+bonus': r(1), 'b@L3+bonus': r(0), 'multi-x-L3': r(1) };
    assert.deepEqual(Object.keys(levelTasks(tasks, 'L2').tasks).sort(), ['a', 'b+bonus', 'multi-x-L3']);
    const l3 = levelTasks(tasks, 'L3');
    assert.deepEqual(Object.keys(l3.tasks).sort(), ['a', 'b+bonus']);
    assert.equal(l3.tasks.a.passes, 0);
    assert.deepEqual(l3.problem, { a: 'a@L3', 'b+bonus': 'b@L3+bonus' });
});

test('task page: T@L3 renders under T\'s name with its level and a link to T; T links its level problem; no cross-level sibling', async (t) => {
    const { document, window } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
    const had = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch };
    globalThis.document = document; globalThis.window = window;
    globalThis.fetch = async () => ({ ok: false, status: 404, json: async () => ({ error: 'no server here' }), text: async () => '' });
    t.after(() => { Object.assign(globalThis, had); });
    const { renderTask } = await import('../ui/models/task.js');
    const tk = (credit) => ({ status: credit ? 'pass' : 'fail', solved: !!credit, excluded: false, credit, attempts: 1, passes: credit, wall_s: 100 });
    const catalog = { taskTotal: 5, allTaskIds: ['fix-a', 'fix-a2'], taskMeta: {
        'fix-a': { repo: 'r', tier: 't1', sample_group: 'grp', category: [] }, 'fix-a2': { repo: 'r', tier: 't2', sample_group: 'grp', category: [] },
        'fix-a@L3': { repo: 'r', tier: 't1', sample_group: 'grp', category: [], level: 'L3', base: 'fix-a', label: 'fix-a (prompt L3)' } } };
    // one config ran fix-a2 at L2 only: on the L3 page it must NOT stand in as a sample_group sibling
    const groups = [{ key: 'g1', m: { key: 'm1', display: 'Model One' }, c: {}, members: [], dirs: ['d1'], tasks: { 'fix-a2': tk(0) }, q: { attempted: 1 } }];
    const ctx = (id) => ({ id, catalog, groups, adj: null, rows: 'best', setRows() {}, detailHtml: () => '', openModel() {}, openTask() {}, onBack() {} });
    const root = document.getElementById('root');
    renderTask(root, ctx('fix-a@L3'));
    const html = root.innerHTML;
    assert.match(html, /prompt L3/);
    assert.match(html, /data-open-task="fix-a"/, 'links its task');
    assert.ok(!/data-open-task="fix-a2"/.test(html), 'the L2 sibling is not this problem\'s sibling');
    assert.ok(!/Model One/.test(html), 'an L2 result never shows on the L3 page');
    renderTask(root, ctx('fix-a'));
    assert.match(root.innerHTML, /data-open-task="fix-a@L3"/, 'T\'s page links its L3 problem');
    assert.match(root.innerHTML, /data-open-task="fix-a2"/, 'and keeps its own L2 sibling');
});

// ---------------------------------------------------------------- minimum configs first (Kyle, 2026-10-17)
test('LEVEL_MIN_CONFIGS: one number, server and browser', async () => {
    const L = await lb();
    assert.equal(M.LEVEL_MIN_CONFIGS, 5);
    assert.equal(L.LEVEL_MIN_CONFIGS, M.LEVEL_MIN_CONFIGS);
});

test('fit threshold: a level problem scored by 4 groups earns 0 points and moves no ability; by 5 it is an item like any task', async () => {
    const L = await lb();
    const tk = (s) => ({ status: s ? 'pass' : 'fail', solved: !!s, excluded: false, credit: s, attempts: 1, passes: s });
    const base = (i) => ({ a: tk(1), b: tk(i % 2), c: tk(i % 3 ? 1 : 0), d: tk(0) });
    const g = (i, extra) => ({ key: 'g' + i, m: { key: 'm' + i }, c: {}, tasks: { ...base(i), ...extra } });
    const four = [0, 1, 2, 3].map((i) => g(i, { 'x@L3': tk(0) })).concat([4, 5].map((i) => g(i, {})));
    const five = [0, 1, 2, 3, 4].map((i) => g(i, { 'x@L3': tk(0) })).concat([g(5, {})]);
    const a4 = L.difficultyAdjusted(four), a5 = L.difficultyAdjusted(five);
    assert.equal(a4.taskPoints.get('x@L3'), 0);
    assert.equal(a4.levelUnscored.get('x@L3'), 4);
    assert.ok(a4.taskDifficulty.get('x@L3') > a4.taskDifficulty.get('a'), 'held, but still given a difficulty from its results');
    assert.ok(Math.abs([...a4.taskPoints.values()].reduce((s, x) => s + x, 0) - 100) < 1e-6, 'the 100 points are the scored problems\'');
    // a held problem moves nothing: the same fit as without it
    const none = L.difficultyAdjusted(four.map((x) => ({ ...x, tasks: Object.fromEntries(Object.entries(x.tasks).filter(([k]) => k !== 'x@L3')) })));
    for (const k of ['g0', 'g4']) assert.ok(Math.abs(a4.get(k).strength - none.get(k).strength) < 1e-9, k);
    assert.ok(a5.taskPoints.get('x@L3') > 0);
    assert.ok(!a5.levelUnscored.has('x@L3'));
    // plain L2 tasks are never held, however few ran them
    const one = L.difficultyAdjusted([g(0, { lonely: tk(1) }), g(1, {})]);
    assert.ok(one.taskPoints.get('lonely') > 0);
});

test('server threshold: 5 distinct config rows with a scored result -> points and in the total; 4 (or excluded / INVALID- runs) -> not yet', (t) => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'promptlevel-min-'));
    const root = path.join(tmp, 'cb');
    t.after(() => { fs.rmSync(tmp, { recursive: true, force: true }); M.configure({}); });
    for (const id of ['fix-a', 'fix-b']) { const d = path.join(root, 'tasks', 'r', id); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'task.yaml'), `id: ${id}\n`); }
    fs.mkdirSync(path.join(root, 'results'), { recursive: true });
    const row = (task, status) => ({ task, status, solved: status === 'pass', wall_s: 300, tokens_out: 900, tool_calls: 4, ran_at: 1 });
    const at = (ctx) => ({ model_path: Q4, n_ctx: ctx, launch_command: LAUNCH.replace('-c 131072', `-c ${ctx}`) });
    const CTX = [32768, 65536, 98304, 131072, 196608];   // five contexts: five config rows
    const bats = {};
    CTX.forEach((ctx, i) => { bats[`l3-${ctx}`] = { config: cfg({ prompt_level: 'L3' }), server: at(ctx), rows: [row('fix-a', i % 2 ? 'pass' : 'fail'), ...(i < 4 ? [row('fix-b', 'pass')] : [])] }; });
    bats['l3-excluded'] = { config: cfg({ prompt_level: 'L3' }), server: at(262144), rows: [row('fix-b', 'PROVIDER_ERROR')] };   // not a scored result
    bats['INVALID-l3'] = { config: cfg({ prompt_level: 'L3' }), server: at(229376), rows: [row('fix-b', 'pass')] };          // not either
    bats['l3-again'] = { config: cfg({ prompt_level: 'L3' }), server: at(32768), rows: [row('fix-b', 'pass')] };              // a row already counted
    bats.l2 = { config: cfg(), server: at(131072), rows: [row('fix-a', 'pass'), row('fix-b', 'pass')] };
    M.configure({
        paths: { csv: path.join(tmp, 'none.csv'), bestConfigs: path.join(tmp, 'none.md'), benchLog: path.join(tmp, 'none.log'), sweepState: path.join(tmp, 's.json'),
            codebenchRoot: root, dashboardConfig: path.join(tmp, 'nope.json') },
        codebench: { listRuns: () => Object.entries(bats).map(([dir, b], i) => ({ dir, ended: i + 1, config: b.config, server: b.server, tasks: b.rows.length })),
            getRun: (dir) => ({ rows: bats[dir].rows }) },
        queueLaunch: new Map(), weightsRegistry: { paths: {} },
    });
    const cat = M.listModels();
    assert.deepEqual([cat.taskMeta['fix-a@L3'].scoredConfigs, cat.taskMeta['fix-a@L3'].unscored], [5, undefined]);
    assert.deepEqual([cat.taskMeta['fix-b@L3'].scoredConfigs, cat.taskMeta['fix-b@L3'].unscored], [4, true]);
    assert.equal(cat.taskTotal, 3, 'fix-a, fix-b, fix-a@L3');
    assert.equal(M.isUnscoredProblem('fix-b@L3'), true);
    assert.equal(M.isUnscoredProblem('fix-a@L3'), false);
    // and the browser's fit agrees on the same rows
    return lb().then((L) => {
        const fit = L.fitFor(cat.models, L.FACET_DEFAULTS.quality, L.FACET_DEFAULTS.full);
        assert.ok(fit.adj.taskPoints.get('fix-a@L3') > 0);
        assert.equal(fit.adj.taskPoints.get('fix-b@L3'), 0);
        assert.equal(fit.adj.levelUnscored.get('fix-b@L3'), 4);
    });
});
