// Auto queue INFORMATION SCORING (2026-10-18, Kyle: "it should be aspiring to primarily test ones where we are relatively
// unsure if it will pass or fail -- doing a bunch of fast, easy tests doesn't give us much info when it has already passed
// much harder tests ... hone in on its level and ... run the tests with the highest uncertainty, with time as the secondary
// (but still important) factor"). ui/shared/planner.js scores a run by info = a^2 E[p(1-p)] / (1 + I se_b^2) over
// minutes^timeGamma, with p the leaderboard fit's own 2PL pass probability (ui/autoqueue/derive.js hands the fitted ability,
// not logit(strength)). Nothing here starts a process or touches a real queue or settings file.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'aq-info-test-'));
process.env.AUTOQUEUE_SETTINGS = path.join(TMP, 'autoqueue.json');
process.env.AUTOQUEUE_BATCHES = path.join(TMP, 'autoqueue-batches.json');
const AQ = require('../lib/autoqueue.js');
let uiDir = null;
test.after(() => { fs.rmSync(TMP, { recursive: true, force: true }); if (uiDir) fs.rmSync(uiDir, { recursive: true, force: true }); });

async function ui(rel) {
    if (!uiDir) {
        uiDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ui-aqi-'));
        fs.cpSync(path.join(__dirname, '..', 'ui'), path.join(uiDir, 'ui'), { recursive: true });
        fs.writeFileSync(path.join(uiDir, 'package.json'), JSON.stringify({ type: 'module' }));
    }
    return import(`file://${path.join(uiDir, 'ui', rel)}`);
}
const P = () => ui('shared/planner.js');

// ---------------------------------------------------------------- synthetic planner input (planner scale: centred b)
function model(id, theta, se, extra = {}) {
    return { id, label: id, role: 'contender', lane: 'local', theta, se, fitted: true, n: 40, relTime: 1, available: true, hist: {}, cfg: {}, ...extra };
}
function task(id, b, extra = {}) {
    return { id, b, a: 1, se: 0.3, tried: true, nStrong: 3, strongPasses: 2, solveMin: 20, failMin: 20, capMin: 120, points: 1, ...extra };
}
// a b that gives point pass probability p at ability theta (a = 1)
const bFor = (theta, p) => theta - Math.log(p / (1 - p));
const ran = (ids) => Object.fromEntries(ids.map((t) => [t, { ran: true, passed: true }]));
const base = (over = {}) => ({ budget: { localHours: 40, cloud: false, cloudHours: 0, switchMin: 0 }, ...over });
const runsOf = (out, id) => out.legs.filter((L) => L.model === id).flatMap((L) => L.runs);

test('info scoring is the default; the arithmetic of the default gamma (p 0.5 at 40 min beats p 0.95 at 5 min)', async () => {
    const { PLANNER_DEFAULTS, withDefaults, infoScore, fisherInfo } = await P();
    assert.strictEqual(PLANNER_DEFAULTS.scoring, 'info');
    assert.strictEqual(PLANNER_DEFAULTS.timeGamma, 0.4);
    assert.strictEqual(withDefaults({}).scoring, 'info');
    assert.strictEqual(withDefaults({ scoring: 'legacy' }).scoring, 'legacy');
    assert.strictEqual(withDefaults({ scoring: 'nonsense' }).scoring, 'info');
    assert.strictEqual(AQ.DEFAULT_SETTINGS.scoring, 'info');
    assert.strictEqual(AQ.DEFAULT_SETTINGS.timeGamma, PLANNER_DEFAULTS.timeGamma, 'server and browser defaults agree');
    assert.strictEqual(AQ.DEFAULT_SETTINGS.minInfo, PLANNER_DEFAULTS.minInfo);
    const g = PLANNER_DEFAULTS.timeGamma;
    const coin40 = infoScore(fisherInfo(0.5), 40, g), easy5 = infoScore(fisherInfo(0.95), 5, g);
    assert.ok(Math.abs(coin40 - 0.0572) < 1e-4 && Math.abs(easy5 - 0.0250) < 1e-4, `${coin40} vs ${easy5}`);
    assert.ok(coin40 > easy5);
    assert.ok(infoScore(fisherInfo(0.5), 120, g) > easy5, 'even a p 0.5 run at the 2 h cap beats a p 0.95 run at 5 min');
    assert.ok(infoScore(fisherInfo(0.8), 5, g) > coin40, 'time still counts: p 0.8 at 5 min beats p 0.5 at 40 min');
    assert.ok(Math.log(fisherInfo(0.5) / fisherInfo(0.95)) / Math.log(8) > 0.79, 'the 40-vs-5 anchor holds for any gamma < 0.80');
});

test('(1) a config that passed hard tasks does not get easy, fast tasks first', async () => {
    const { plan } = await P();
    const theta = 2.5;
    // it passed four hard tasks (b around its ability); what is left: eight easy 3-minute tasks and two hard 45-minute ones
    const hardDone = ['h1', 'h2', 'h3', 'h4'].map((id, i) => task(id, 2.2 + i * 0.2));
    const easy = Array.from({ length: 8 }, (_, i) => task(`e${i}`, -1 + i * 0.1, { solveMin: 3, failMin: 5 }));
    const hard = [task('H1', 2.4, { solveMin: 45, failMin: 90 }), task('H2', 2.7, { solveMin: 45, failMin: 90 })];
    const X = model('X', theta, 0.3, { cfg: ran(hardDone.map((t) => t.id)) });
    const out = plan({ models: [X], tasks: [...hardDone, ...easy, ...hard], focus: ['X'] }, base());
    const order = runsOf(out, 'X').map((r) => r.task);
    assert.deepStrictEqual(order.slice(0, 2).sort(), ['H1', 'H2'], `the hard, uncertain tasks first: ${order.join(' ')}`);
    for (const r of runsOf(out, 'X').filter((x) => x.task.startsWith('e'))) assert.ok(r.p > 0.9, `${r.task} is a near-certain pass (${r.p})`);
    assert.ok(order.every((t) => !hardDone.some((h) => h.id === t)), 'never a re-run of what it already passed');
    // priced per minute (gamma 1, how the legacy rate divides) the same information puts an easy 3-minute task first:
    // time as the SECONDARY factor is what keeps the hard ones in front
    const perMinute = plan({ models: [X], tasks: [...hardDone, ...easy, ...hard], focus: ['X'] }, base({ timeGamma: 1 }));
    assert.ok(runsOf(perMinute, 'X')[0].task.startsWith('e'), `per minute: ${runsOf(perMinute, 'X')[0].task} first`);
});

test('(2) the tasks with p ~ 0.5 rank first (equal time)', async () => {
    const { plan } = await P();
    const theta = 1.2;
    const ps = [0.03, 0.15, 0.35, 0.5, 0.65, 0.85, 0.97];
    const tasks = ps.map((p) => task(`p${Math.round(p * 100)}`, bFor(theta, p)));
    const out = plan({ models: [model('X', theta, 0.05)], tasks, focus: ['X'] }, base({ minInfo: 0 }));
    const runs = runsOf(out, 'X');
    assert.strictEqual(runs[0].task, 'p50', `first: ${runs.map((r) => r.task).join(' ')}`);
    assert.deepStrictEqual(runs.slice(1, 3).map((r) => r.task).sort(), ['p35', 'p65']);
    assert.deepStrictEqual(runs.slice(-2).map((r) => r.task).sort(), ['p3', 'p97'], 'the near-certain outcomes come last');
    // the debug list shows the same order with p, I and minutes
    const top = out.candidates.X.top;
    assert.strictEqual(top[0].task, 'p50');
    assert.ok(Math.abs(top[0].p - 0.5) < 0.01 && Math.abs(top[0].I - 0.25) < 0.01 && top[0].minutes === 20, JSON.stringify(top[0]));
    assert.match(runs[0].reason, /50% predicted pass; information 0\.2\d+ .*~20 min; score/);
    // the discrimination counts: the same p on a sharper task is worth a^2 more
    const sharp = plan({ models: [model('X', theta, 0.05)], tasks: [task('flat', bFor(theta, 0.5)), task('sharp', theta - Math.log(0.6 / 0.4) / 1.5, { a: 1.5 })], focus: ['X'] }, base({ minInfo: 0 }));
    assert.strictEqual(runsOf(sharp, 'X')[0].task, 'sharp', 'p 0.6 at a 1.5 (I 0.54) beats p 0.5 at a 1 (I 0.25)');
});

test('(3) time breaks ties among similar information', async () => {
    const { plan, PLANNER_DEFAULTS } = await P();
    const theta = 1;
    const tasks = [task('slow', bFor(theta, 0.5), { solveMin: 40, failMin: 40 }), task('fast', bFor(theta, 0.52), { solveMin: 10, failMin: 10 }),
        task('mid', bFor(theta, 0.48), { solveMin: 20, failMin: 20 })];
    const out = plan({ models: [model('X', theta, 0.05)], tasks, focus: ['X'] }, base());
    assert.deepStrictEqual(runsOf(out, 'X').map((r) => r.task), ['fast', 'mid', 'slow']);
    // ... and time is ignored at gamma 0 (information only): the exact coin flip first
    const g0 = plan({ models: [model('X', theta, 0.05)], tasks, focus: ['X'] }, base({ timeGamma: 0 }));
    assert.strictEqual(runsOf(g0, 'X')[0].task, 'slow');
    // the default anchor through the planner: p 0.5 at 40 min before p 0.95 at 5 min
    const anchor = plan({ models: [model('X', theta, 0.01)], tasks: [task('easy5', bFor(theta, 0.95), { solveMin: 5, failMin: 5 }), task('coin40', bFor(theta, 0.5), { solveMin: 40, failMin: 40 })], focus: ['X'] },
        base({ timeGamma: PLANNER_DEFAULTS.timeGamma }));
    assert.deepStrictEqual(runsOf(anchor, 'X').map((r) => r.task), ['coin40', 'easy5']);
});

test('info: the floor drops near-certain runs; an uncertain ability widens p toward 0.5 (Gauss-Hermite)', async () => {
    const { plan, predictive, runInfo, sigmoid } = await P();
    const theta = 1;
    const out = plan({ models: [model('X', theta, 0.01)], tasks: [task('sure', bFor(theta, 0.995)), task('coin', bFor(theta, 0.5))], focus: ['X'] }, base());
    assert.deepStrictEqual(runsOf(out, 'X').map((r) => r.task), ['coin'], 'p 0.995 (I 0.005) is below minInfo 0.02');
    assert.ok(Math.abs(predictive(0, 0, 1, 0).p - 0.5) < 1e-12);
    const point = sigmoid(2), wide = predictive(2, 1.5, 1, 0).p;
    assert.ok(wide < point && wide > 0.5, `uncertain ability: p ${wide.toFixed(3)} between 0.5 and the point ${point.toFixed(3)}`);
    assert.ok(Math.abs(predictive(2, 1e-9, 1, 0).p - point) < 1e-9, 'se -> 0: the point value');
    // E[p] for N(0, 1) against the probit approximation sigmoid(mu / sqrt(1 + pi s^2 / 8)) (a known close match)
    assert.ok(Math.abs(predictive(1, 1, 1, 0).p - sigmoid(1 / Math.sqrt(1 + Math.PI / 8))) < 0.01);
    // a task of uncertain difficulty says less about the ability: info = I / (1 + I se_b^2)
    const m = { theta: 0, se: 0 }, r1 = runInfo(m, { id: 't', b: 0, a: 1, se: 0 }), r2 = runInfo(m, { id: 't', b: 0, a: 1, se: 1.5 });
    assert.ok(Math.abs(r1.info - 0.25) < 1e-12 && Math.abs(r2.info - 0.25 / (1 + 0.25 * 2.25)) < 1e-12);
});

test('info: coverage balance still moves runs to the focus config that is behind', async () => {
    const { plan } = await P();
    // 20 tasks of 5 points; A has run 12 (60 points), B 4 (20 points). A's remaining tasks are a little MORE informative.
    const ids = Array.from({ length: 20 }, (_, i) => `t${i}`);
    const tasks = ids.map((t) => task(t, 0, { points: 5 }));
    const mk = () => ({ models: [model('A', 0.1, 0.2, { cfg: ran(ids.slice(0, 12)) }), model('B', 1.2, 0.2, { cfg: ran(ids.slice(16)) })], tasks, focus: ['A', 'B'] });
    const s = base({ budget: { localHours: 3, cloud: false, cloudHours: 0, switchMin: 0 } });
    const off = plan(mk(), { ...s, balance: 0 }), on = plan(mk(), { ...s, balance: 2 });
    assert.ok(runsOf(off, 'A').length > runsOf(off, 'B').length, `without balance A wins on information (${runsOf(off, 'A').length} vs ${runsOf(off, 'B').length})`);
    assert.ok(runsOf(on, 'B').length > runsOf(off, 'B').length && runsOf(on, 'B').length > runsOf(on, 'A').length, `balance on: B catches up (${runsOf(on, 'B').length} vs ${runsOf(on, 'A').length})`);
    assert.match(runsOf(on, 'B')[0].reason, /coverage \d+ of \d+ pts \(×\d/);
});

// ---------------------------------------------------------------- derive: the SAME p as the leaderboard fit
function fixture() {
    const tk = (solved, wall = 600) => ({ status: solved ? 'pass' : 'fail', solved, excluded: false, credit: solved ? 1 : 0, attempts: 1, passes: solved ? 1 : 0, wall_s: wall, ran_at: 1 });
    const cfg = (runnerModel, tasks, n_ctx = 131072) => ({ key: runnerModel, runnerModel, n_ctx, timeout_s: 7200, dirs: [runnerModel],
        facets: { weights: 'w', harness: { runnerModel }, context: { n_ctx } }, agg: { attempted: Object.keys(tasks).length, scored: Object.keys(tasks).length }, tasks });
    const mk = (key, configs) => ({ key, display: key, weightsKey: key, counts: { qualityTasks: 5 }, quality: {}, configs: configs.map((c) => ({ ...c, facets: { ...c.facets, weights: key } })) });
    // S passes the hard ones, M the middle, W only the easy; S has not run x1 / x2 (a hard one, an easy one)
    const T = ['e1', 'e2', 'e3', 'm1', 'm2', 'm3', 'h1', 'h2', 'h3', 'x1', 'x2'];
    const res = (pass) => Object.fromEntries(T.filter((t) => pass[t] != null).map((t) => [t, tk(pass[t], t.startsWith('e') || t === 'x2' ? 180 : 2400)]));
    const catalog = { allTaskIds: T, taskMeta: {}, models: [
        mk('local:S', [cfg('S', res({ e1: 1, e2: 1, e3: 1, m1: 1, m2: 1, m3: 1, h1: 1, h2: 1, h3: 0 }))]),
        mk('local:S2', [cfg('S2', res({ e1: 1, e2: 1, e3: 1, m1: 1, m2: 1, m3: 1, h1: 1, h2: 0, h3: 1, x1: 1, x2: 1 }))]),
        mk('local:M', [cfg('M', res({ e1: 1, e2: 1, e3: 1, m1: 1, m2: 0, m3: 1, h1: 0, h2: 0, h3: 0, x1: 0, x2: 1 }))]),
        mk('local:W', [cfg('W', res({ e1: 1, e2: 1, e3: 0, m1: 0, m2: 0, m3: 0, h1: 0, h2: 0, h3: 0, x1: 0, x2: 1 }))]),
        mk('local:W2', [cfg('W2', res({ e1: 1, e2: 0, e3: 1, m1: 0, m2: 1, m3: 0, h1: 0, h2: 0, h3: 0, x1: 0, x2: 1 }))]),
    ] };
    const settings = { models: [
        { id: 'S', catalogKey: 'local:S', role: 'contender', nCtx: 131072 },
        { id: 'W', catalogKey: 'local:W', role: 'contender', nCtx: 131072 },
        { id: 'S-pi', catalogKey: 'local:S', role: 'contender', runner: 'pi' },          // no fitted group: S's model prior
        { id: 'ghost', catalogKey: 'local:none', role: 'contender' },                    // no row at all: the population prior
    ], focus: [{ model: 'S' }] };
    return { catalog, settings };
}

test('derive: the planner\'s p for a fitted config is the leaderboard fit\'s sigmoid(a (theta - (b + meanB))), not logit(strength)', async () => {
    const { derive } = await ui('autoqueue/derive.js');
    const { passProb, sigmoid, logit } = await P();
    const { catalog, settings } = fixture();
    const d = derive(catalog, settings);
    const adj = d.fit.adj;
    for (const id of ['S', 'W']) {
        const m = d.input.models.find((x) => x.id === id);
        const g = d.groupsOf.get(id).planning, a = adj.get(g.key);
        assert.ok(Math.abs(m.theta - (a.theta - adj.meanB)) < 1e-12, `${id}: theta is the fitted ability on the centred scale`);
        assert.ok(Math.abs(m.theta - logit(Math.min(0.995, Math.max(0.005, a.rate)))) > 0.05, `${id}: not logit(strength) any more`);
        for (const t of d.input.tasks.filter((x) => x.tried)) {
            const want = sigmoid(adj.taskDiscrimination.get(t.id) * (a.theta - (adj.taskDifficulty.get(t.id) + adj.meanB)));
            assert.ok(Math.abs(passProb(m, t) - want) < 1e-9, `${id} ${t.id}: ${passProb(m, t)} vs the fit's ${want}`);
            assert.strictEqual(t.a, adj.taskDiscrimination.get(t.id));
        }
    }
    const S = d.input.models.find((x) => x.id === 'S');
    const x1 = d.input.tasks.find((t) => t.id === 'x1'), x2 = d.input.tasks.find((t) => t.id === 'x2');
    assert.ok(passProb(S, x2) > 0.85 && passProb(S, x1) < passProb(S, x2), `x1 hard ${passProb(S, x1).toFixed(2)}, x2 easy ${passProb(S, x2).toFixed(2)}`);
    // unfitted configs: the fit's prior, not 0 +/- 1.5
    const pi = d.input.models.find((x) => x.id === 'S-pi'), ghost = d.input.models.find((x) => x.id === 'ghost');
    assert.strictEqual(pi.fitted, false);
    assert.strictEqual(pi.priorSource, 'model');
    assert.ok(Math.abs(pi.theta - (adj.models.get('local:S').theta - adj.meanB)) < 1e-12);
    assert.strictEqual(ghost.priorSource, 'population');
    assert.ok(Math.abs(ghost.theta - (adj.abilityPrior.mu - adj.meanB)) < 1e-12 && Math.abs(ghost.se - adj.abilityPrior.tau) < 1e-12);
});

test('derive + plan end to end: the strong config is sent to the hard unrun task first, with p / I / minutes on the run', async () => {
    const { derive, plannerCatalog } = await ui('autoqueue/derive.js');
    const { plan } = await P();
    const { catalog, settings } = fixture();
    const d = derive(plannerCatalog(catalog), settings);
    const out = plan(d.input, { ...settings, budget: { localHours: 20, cloud: false, cloudHours: 0, switchMin: 5 } });
    const runs = runsOf(out, 'S');
    assert.strictEqual(runs[0].task, 'x1', `first: ${runs.map((r) => `${r.task} p${r.p.toFixed(2)}`).join(', ')}`);
    for (const k of ['p', 'I', 'info', 'minutes', 'score']) assert.ok(Number.isFinite(runs[0][k]), `run carries ${k}`);
    assert.ok(out.candidates.S.top.length >= 1 && out.candidates.S.top[0].task === 'x1');
});

test('refill dry run: each chunk lists its runs with p, I and minutes, and each config its best candidates; the batch keeps {task}', async () => {
    const mods = { ...(await P()), ...(await ui('autoqueue/derive.js')) };
    const { catalog, settings } = fixture();
    const s = { ...AQ.loadSettings(), models: settings.models.map((m) => ({ ...m, queueLane: 'local-gpu' })), focus: [{ model: 'S' }], refill: { enabled: false, lanes: ['local-gpu'], minHours: 3, topUpHours: 6, intervalMin: 15 } };
    const res = AQ.planRefill({ settings: s, catalog, lanes: [{ lane: 'local-gpu', paused: false }], active: [], mods });
    const L = res.lanes.find((x) => x.lane === 'local-gpu');
    assert.strictEqual(L.action, 'fill', L.reason);
    assert.strictEqual(L.scoring, 'info');
    const r0 = L.chunks[0].runs[0];
    for (const k of ['task', 'p', 'I', 'info', 'minutes', 'score']) assert.ok(r0[k] != null, `chunk run has ${k}: ${JSON.stringify(r0)}`);
    assert.ok(L.candidates.S && L.candidates.S.top.length > 0 && L.candidates.S.top[0].p != null);
    assert.ok(L.batch.legs.every((x) => x.runs.every((r) => Object.keys(r).join() === 'task')), 'what the queue guard reads is unchanged');
});

test('settings: scoring / timeGamma / minInfo are validated and saved', () => {
    assert.throws(() => AQ.saveSettings({ scoring: 'fast' }), /scoring must be info or legacy/);
    assert.throws(() => AQ.saveSettings({ timeGamma: 3 }), /timeGamma/);
    assert.throws(() => AQ.saveSettings({ minInfo: -1 }), /minInfo/);
    const s = AQ.saveSettings({ scoring: 'legacy', timeGamma: 0.3, minInfo: 0.01 });
    assert.deepStrictEqual([s.scoring, s.timeGamma, s.minInfo], ['legacy', 0.3, 0.01]);
    assert.strictEqual(AQ.loadSettings().scoring, 'legacy');
    fs.rmSync(process.env.AUTOQUEUE_SETTINGS);
    assert.strictEqual(AQ.loadSettings().scoring, 'info', 'a settings file without the key reads the default');
});

test('derive: an L3 config meets the `T@L3` problem where the fit has one, else T shifted by the median level gap', async () => {
    const { derive } = await ui('autoqueue/derive.js');
    const { passProb } = await P();
    const { catalog, settings } = fixture();
    // level problems as the staged prompt-level change keys them (`T@L3`): harder than their L2 task for these configs
    const tk = (solved) => ({ status: solved ? 'pass' : 'fail', solved, excluded: false, credit: solved ? 1 : 0, attempts: 1, passes: solved ? 1 : 0, wall_s: 600, ran_at: 1 });
    const l3 = { 'e1@L3': [1, 1, 0, 0, 0], 'e2@L3': [1, 0, 1, 0, 0], 'm1@L3': [1, 1, 0, 0, 0], 'm2@L3': [0, 1, 0, 0, 0] };
    catalog.models.forEach((m, i) => { for (const [k, v] of Object.entries(l3)) m.configs[0].tasks[k] = tk(v[i]); });
    const s = { ...settings, models: [...settings.models, { id: 'S3', catalogKey: 'local:S', role: 'contender', promptLevel: 'L3' }], focus: [{ model: 'S' }, { model: 'S', promptLevel: 'L3' }] };
    const d = derive(catalog, s);
    const adj = d.fit.adj;
    const S3 = d.input.models.find((x) => x.id === 'S.L3') || d.input.models.find((x) => x.id === 'S3');
    assert.ok(S3 && S3.items, 'the L3 config carries its level items');
    assert.ok(Math.abs(S3.items.e1.b - adj.taskDifficulty.get('e1@L3')) < 1e-12 && S3.items.e1.a === adj.taskDiscrimination.get('e1@L3'));
    const T = new Map(d.input.tasks.map((t) => [t.id, t]));
    const diffs = ['e1', 'e2', 'm1', 'm2'].map((t) => adj.taskDifficulty.get(`${t}@L3`) - T.get(t).b).sort((a, b) => a - b);
    const shift = (diffs[1] + diffs[2]) / 2;
    assert.ok(Math.abs(S3.items.h1.b - (T.get('h1').b + shift)) < 1e-12 && S3.items.h1.a === 1 && S3.items.h1.se > T.get('h1').se, 'no h1@L3: h1 shifted by the median gap');
    assert.ok(!d.input.models.find((x) => x.id === 'S').items, 'the L2 config meets the tasks themselves');
    assert.ok(passProb(S3, T.get('e1')) !== passProb({ ...S3, items: null }, T.get('e1')), 'the planner reads the item');
    assert.ok(d.input.tasks.every((t) => !t.id.includes('@')), 'level problems are never candidates of their own');
});
