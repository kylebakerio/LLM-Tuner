'use strict';
// Strength and its 95% range (ui/shared/leaderboard.js difficultyAdjusted), 2026-10-25. Kyle: "Raw pass rate is near
// useless and should never be used in the formula"; "Range fix yes".
//   strength = S(theta) = sum over EVERY task of points_j * P(theta, j): a config's results enter only through theta
//   range    = theta's exact 95% posterior through the same S, whose prior is what the REST of the data says about
//              theta (its model's other configs + the population prior, its facets, eps's prior): never its own results
//   model    = S(alpha), range alpha +- 1.96 / sqrt(info summed over the model's configs + 1/tau^2) through S
const test = require('node:test');
const assert = require('node:assert/strict');

const loadLb = () => import('../ui/shared/leaderboard.js');
const sig = (z) => 1 / (1 + Math.exp(-z));
const tk = (credit, attempts = 1) => ({ attempts, passes: credit * attempts, credit, excluded: false, solved: credit > 0, wall_s: 60, tokens_out: 1000 });
const grp = (key, w, tasks, extra = {}) => ({ key, m: { key: w, weightsKey: w }, c: { n_ctx: 131072, facets: { harness: { runner: 'opencode' }, ...extra } }, tasks });
// a small corpus: 24 tasks of graded difficulty, configs of graded ability (deterministic records), one model with a
// well-tested config and a thin one, a perfect record and an all-fail record
const TASKS = Array.from({ length: 24 }, (_, i) => 't' + i);
const rec = (skill, ids = TASKS) => Object.fromEntries(ids.map((t) => { const i = +t.slice(1); return [t, tk(i < skill ? 1 : (i * 7 + skill * 3) % 5 === 0 ? 1 : 0)]; }));
function corpus({ sibling = true } = {}) {
    const g = [
        grp('s1', 'S1', rec(20)), grp('s2', 'S2', rec(16)), grp('s3', 'S3', rec(12)), grp('s4', 'S4', rec(8)), grp('s5', 'S5', rec(4)),
        grp('perfect', 'P', rec(99, TASKS.slice(0, 6))), grp('zero', 'Z', Object.fromEntries(TASKS.slice(10, 16).map((t) => [t, tk(0)]))),
        grp('a-thin', 'A', rec(14, ['t2', 't9', 't15'])),
    ];
    if (sibling) g.push(grp('a-main', 'A', rec(14)));
    return g;
}
// S(th) from the exported maps alone
const S = (adj, th) => { let s = 0; for (const [t, pts] of adj.taskPoints) { if (!pts) continue; s += pts * sig(adj.taskDiscrimination.get(t) * (th - adj.taskDifficulty.get(t) - adj.meanB)); } return s; };

test('strength is S(theta) on every task: points x fitted P(solve), no raw credit, for configs and models', async () => {
    const L = await loadLb();
    const groups = corpus(), adj = L.difficultyAdjusted(groups);
    const pts = [...adj.taskPoints.values()].reduce((a, x) => a + x, 0);
    assert.ok(Math.abs(pts - 100) < 1e-9, 'the points sum to 100');
    for (const g of groups) {
        const a = adj.get(g.key);
        assert.ok(Math.abs(a.strength - S(adj, a.theta)) < 1e-9, `${g.key}: strength ${a.strength} = S(theta) ${S(adj, a.theta)}`);
        assert.equal(a.rate, a.strength / 100);
    }
    for (const [k, m] of adj.models) assert.ok(Math.abs(m.strength - S(adj, m.theta)) < 1e-9, `model ${k}: S(alpha)`);
    // the perfect record (6 of 6 easy tasks) earns no free 100 on the tasks it ran: its strength is below the points
    // those six tasks plus its predicted rest would give with raw credit
    const p = adj.get('perfect'), ran = TASKS.slice(0, 6);
    const rawStyle = ran.reduce((s, t) => s + adj.taskPoints.get(t), 0) + [...adj.taskPoints].filter(([t]) => !ran.includes(t)).reduce((s, [t, x]) => s + x * sig(adj.taskDiscrimination.get(t) * (p.theta - adj.taskDifficulty.get(t) - adj.meanB)), 0);
    assert.ok(p.strength < rawStyle, 'its P(solve) on the six it passed is below 1');
    // one order: S rises with theta, so strength orders the configs exactly as theta does
    const by = (f) => groups.map((g) => g.key).sort((x, y) => f(adj.get(y)) - f(adj.get(x)));
    assert.deepEqual(by((a) => a.strength), by((a) => a.theta));
});

test('the range is theta\'s posterior through S and contains the strength (the posterior peaks at theta)', async () => {
    const L = await loadLb();
    const adj = L.difficultyAdjusted(corpus());
    for (const [k, a] of adj) {
        // strictly inside: the code's min/max guard would show as lo === rate or hi === rate
        assert.ok(a.lo < a.rate && a.rate < a.hi, `${k}: ${a.lo} < ${a.rate} < ${a.hi}`);
        assert.ok(a.lo > 0 && a.hi < 1, `${k}: S never reaches 0 or 100 (no clamp)`);
    }
    for (const [k, m] of adj.models) assert.ok(m.lo < m.rate && m.rate < m.hi, `model ${k}`);
});

// The no-double-count prior, pinned: a model's ONLY config gets the population prior N(mu + facets, 1/P_E + tau^2) (its
// model's information less its own share is zero), so its range is exactly this grid posterior through S. Until
// 2026-10-25 the prior's variance was 0.35^2 + 1/(the model's information INCLUDING this config + 1/tau^2), centred on
// alpha + facets with this config's results already in alpha: its results counted twice and its range was narrower.
test('a config\'s own results are not in its prior: a lone config\'s range is the population-prior posterior', async () => {
    const L = await loadLb();
    const groups = corpus(), adj = L.difficultyAdjusted(groups);
    const { mu, tau } = adj.abilityPrior, vE = 0.35 * 0.35;
    const LO = -10, HI = 14, STEP = 0.02, N = Math.round((HI - LO) / STEP) + 1;
    const post = (cells, cen, pv) => {
        const lp = new Float64Array(N); let mx = -Infinity;
        for (let k = 0; k < N; k++) {
            const th = LO + k * STEP; let v = -0.5 * (th - cen) * (th - cen) / pv;
            for (const [t, y, w] of cells) { const z = adj.taskDiscrimination.get(t) * (th - adj.taskDifficulty.get(t) - adj.meanB); v += w * (y * -Math.log1p(Math.exp(-z)) + (1 - y) * -Math.log1p(Math.exp(z))); }
            lp[k] = v; if (v > mx) mx = v;
        }
        let tot = 0; const pd = lp.map((v) => Math.exp(v - mx)); for (const x of pd) tot += x;
        const at = (q) => { let c = 0; for (let k = 0; k < N; k++) { c += pd[k] / tot; if (c >= q) return LO + k * STEP; } return HI; };
        return [at(0.025), at(0.975)];
    };
    for (const key of ['s2', 's4', 'perfect', 'zero']) {   // each its model's only config, at the baseline facets
        const g = groups.find((x) => x.key === key), a = adj.get(key);
        const cells = Object.entries(g.tasks).map(([t, r]) => [t, r.credit, r.attempts]);
        const [qlo, qhi] = post(cells, mu, vE + tau * tau);
        // the 0.02 grid: allow the next grid point either side
        assert.ok(S(adj, qlo - STEP) - 1e-9 <= a.lo * 100 && a.lo * 100 <= S(adj, qlo + STEP) + 1e-9, `${key} lo ${a.lo * 100} vs S(${qlo}) ${S(adj, qlo)}`);
        assert.ok(S(adj, qhi - STEP) - 1e-9 <= a.hi * 100 && a.hi * 100 <= S(adj, qhi + STEP) + 1e-9, `${key} hi ${a.hi * 100} vs S(${qhi}) ${S(adj, qhi)}`);
        // ...and it is wider than the double-counted prior gave (variance 0.35^2 + 1/(own info + 1/tau^2), centre theta - eps,
        // eps being theta - mu for a lone config at the baseline here up to its share; using theta - eps ~ alpha)
        let info = 0; for (const [t, , w] of cells) { const p = sig(adj.taskDiscrimination.get(t) * (a.theta - adj.taskDifficulty.get(t) - adj.meanB)); info += w * adj.taskDiscrimination.get(t) ** 2 * p * (1 - p); }
        const alpha = adj.models.get(g.m.weightsKey).theta;
        const [olo, ohi] = post(cells, alpha, vE + 1 / (info + 1 / (tau * tau)));
        assert.ok(a.hi - a.lo > (S(adj, ohi) - S(adj, olo)) / 100, `${key}: wider than the old double-counted prior`);
    }
});

test('a config\'s range narrows with what its model\'s OTHER configs show, not with its own results', async () => {
    const L = await loadLb();
    const alone = L.difficultyAdjusted(corpus({ sibling: false })).get('a-thin');
    const withSib = L.difficultyAdjusted(corpus({ sibling: true })).get('a-thin');
    assert.ok(withSib.hi - withSib.lo < alone.hi - alone.lo, `a well-tested sibling narrows the thin config's range: ${withSib.hi - withSib.lo} < ${alone.hi - alone.lo}`);
    // and the well-tested sibling's own range is not narrowed by the thin one's three tasks counting it twice: it stays
    // within a hair of the range it would have as its model's only config
    const main = L.difficultyAdjusted(corpus()).get('a-main');
    const mainAlone = L.difficultyAdjusted(corpus().filter((g) => g.key !== 'a-thin')).get('a-main');
    assert.ok(Math.abs((main.hi - main.lo) - (mainAlone.hi - mainAlone.lo)) < 0.03, `${main.hi - main.lo} vs ${mainAlone.hi - mainAlone.lo}`);
});

test('the model range is alpha +- 1.96 sd through S, sd from every config\'s information plus the population prior', async () => {
    const L = await loadLb();
    const groups = corpus(), adj = L.difficultyAdjusted(groups);
    const { tau } = adj.abilityPrior, m = adj.models.get('A');
    let info = 0;
    for (const g of groups.filter((x) => x.m.weightsKey === 'A')) {
        const th = adj.get(g.key).theta;
        for (const [t, r] of Object.entries(g.tasks)) { const a = adj.taskDiscrimination.get(t), p = sig(a * (th - adj.taskDifficulty.get(t) - adj.meanB)); info += r.attempts * a * a * p * (1 - p); }
    }
    const sd = 1 / Math.sqrt(info + 1 / (tau * tau));
    assert.ok(Math.abs(m.lo * 100 - S(adj, m.theta - 1.96 * sd)) < 1e-9 && Math.abs(m.hi * 100 - S(adj, m.theta + 1.96 * sd)) < 1e-9, `${m.lo} ${m.hi}`);
});
