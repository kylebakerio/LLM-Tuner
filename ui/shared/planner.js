// Auto queue planner: proposes the next codebench runs (model config x task) that improve the quality
// ladder most per hour. PURE: no DOM, no fetch, and one import -- the item response function itemP from leaderboard.js
// (2026-10-25: ONE P(solve) for the planner and the leaderboard; derive.js already loads that module) -- so node tests it
// directly and the Auto queue view (ui/autoqueue/) runs it client-side on every settings change.
import { itemP } from './leaderboard.js';
//
// The inputs come from the dashboard's GLOBAL Rasch fit (ui/shared/leaderboard.js difficultyAdjusted,
// adapted in ui/autoqueue/derive.js): every model has an ability theta (logit scale, centred on the mean
// task) with a standard error, every task a difficulty b with its own standard error.
//
//   p          = sigmoid(theta_m - b_t)                                1PL pass probability
//   I          = p (1 - p) * discount^(earlier attempts of this pair)  Fisher information of one run;
//                                                                      repeats are correlated, so each
//                                                                      earlier attempt multiplies by
//                                                                      `repeatDiscount` (0.3)
//   I_theta    = I / (1 + I se_b^2)       what the run says about the MODEL (a task of unknown
//                                          difficulty says little about who solved it)
//   I_b        = I / (1 + I se_m^2)       what it says about the TASK
//   VR(I, se)  = I se^2 / (1 + I se^2)    the fraction of the parameter's variance the run removes
//
// Three objectives, each normalised to its maximum over the candidates, then weighted by the user:
//   TOP        VR(I_theta, se_m) * max over neighbours n of OVL(m, n)
//              neighbours = the leader and the rungs just above / below among the top-K local models;
//              OVL = 2 Phi(-|theta_m - theta_n| / (2 sigma)), sigma^2 = (se_m^2 + se_n^2) / 2, the overlap
//              of the two ability distributions (1 = indistinguishable, 0 = separated). Zero outside top K.
//   SPEED      p * mean over the other top-K models n that SOLVED t of need(m, n), only for tasks m has not
//              run at its benchmark config. need = max(0, 1 - shared(m, n) / speedTargetShared), shared =
//              tasks both solved: head-to-head wall-time pricing (pairwiseCost) only exists on shared solves.
//   DIFFICULTY VR(I_b, se_b) * exp(-(b_t - theta_top)^2 / (2 focus^2))
//              theta_top = mean ability of the top K: a task every top model passes (or none does) cannot
//              rank the top, so calibration effort goes to tasks whose difficulty is near their ability.
// Roles: TOP and SPEED are multiplied by `roleBias` (0.3) for a model that is not a contender; DIFFICULTY on
// a task with fewer than 2 strong attempts by `roleBias` for a model that is not a scout.
//
// NO RE-RUNS BY DEFAULT (2026-10-14, Kyle: "yes, let's avoid previously done tests by default"; one run per task per
// config). A task the model config already ran at its benchmark config (m.cfg[task].ran, taken by derive.js on the
// FOLDED catalog, so a run on a tensor-split row or an f32ssm copy counts) is not a candidate unless `rerunScored` is
// on (the Auto queue's "include re-runs" box). Then the repeat discount above prices it. Pins keep their own "rerun";
// the cascade never re-ran a task at its config.
//
//   value      = w_top TOP' + w_speed SPEED' + w_diff DIFFICULTY'           (' = normalised)
//   minutes    = relTime_m * (p * solveMin_t + (1 - p) * failMin_t)       a fail on a hard task usually
//                                                                        burns most of the cap
//   rate       = value / (minutes + switch penalty if this model is not yet in the batch) * 60
//
// Greedy selection per lane (local, cloud: separate budgets) picks the best rate that fits, then updates
// the posterior (se_m^2 <- se_m^2 / (1 + I_theta se_m^2), the same for the task, shared counts += p) so
// the next pick sees diminishing returns. Pins go first; the cascade preset simulates the user's scaffold.
//
// FOCUS SET (2026-10-15, Kyle: "select which models we want to focus on, and then interpolates test runs for the models
// to keep their information/completion rate roughly comparable ... for 'comparable' we're seeking similar 'strength
// coverage'"). input.focus = the effective model ids the user picked (derive.js expandFocus: a focus entry at another
// prompt level is its own config, id `<id>.L3`). With a focus set:
//   - only focus configs get greedy candidates (pins and the cascade are unchanged); a focus config set to `ignored` plans
//     as a contender
//   - the TOP / SPEED ladder is the focus set itself (ranked by ability): that is the comparison being made
//   - BALANCE: strength coverage C_m = the share of the fit's 100 difficulty-weighted strength points (leaderboard.js
//     difficultyAdjusted taskPoints) the config has actually run at its benchmark config, plus what is already queued for
//     it, plus what this batch has given it so far. Each candidate's rate is multiplied by
//         f_m = (1 + max(0, C* - C_m) / 10)^balance          C in points (0-100), C* = the best-covered focus config
//     and f is recomputed after every pick, so a config 20 points behind is worth 3x at balance 1 (9x at 2) until it
//     catches up, and the best-covered one keeps f = 1. The TASK each config runs is still the most informative one:
//     overlaps between configs come from the information, not from a common list. Untried tasks carry no points; a
//     task's points include its `+bonus` test's (scored from the same run), as the fit's own coverage does.
//   - out.coverage: per focus config {current, pending, projected} (fractions of the 100 points), for the UI and refill
//   - `onlyQueueLane` (refill): candidates only for configs on that queue lane; C* is still taken over the whole focus set
// INTERLEAVED CHUNKS (chunkSchedule below): the batch is emitted as rows of `chunkTasks` runs, round-robin across the
// configs of each queue lane (A, B, A, B ...), so no config holds a card for a day.
//
// INFORMATION SCORING (2026-10-18, the default; `scoring: 'legacy'` restores the TOP / SPEED / DIFFICULTY value above).
// Kyle: "it should be aspiring to primarily test ones where we are relatively unsure if it will pass or fail -- doing a bunch
// of fast, easy tests doesn't give us much info when it has already passed much harder tests ... hone in on its level and
// ... run the tests with the highest uncertainty, with time as the secondary (but still important) factor."
//   The abilities and difficulties are the leaderboard's own 2PL fit (derive.js hands theta = the config group's fitted
//   ability incl. its facet effects, minus meanB, so it sits on the same centred scale as b; a = the task's discrimination):
//   p          = E_theta[ sigmoid(a_t (theta - b_t)) ],  theta ~ N(theta_m, se_m^2)    7-point Gauss-Hermite: a thin
//                                                                                       config's spread widens p toward 0.5
//   I          = a_t^2 E_theta[ p (1 - p) ] * repeatDiscount^(earlier attempts)       Fisher information about theta
//   info       = I / (1 + I se_b^2)       a task of uncertain difficulty (untried: b 1.5 ± 1.5) says less about theta
//   minutes    = expectedMinutes (the task's median solve / fail walls, scaled by the config's relative time)
//   score      = info * f_balance / (minutes + switch penalty)^timeGamma                 timeGamma 0.4 by default
// Time is the secondary factor: 0.4 means 8x the minutes costs 8^0.4 = 2.3x the score. p 0.5 at 40 min against p 0.95 at
// 5 min (a = 1): 0.25 / 40^0.4 = 0.0572 beats 0.0475 / 5^0.4 = 0.0250 (any gamma < ln(0.25/0.0475)/ln 8 = 0.80 keeps
// it); p 0.5 at the 120-min cap against p 0.95 at 5 min: 0.25 / 120^0.4 = 0.0368 beats 0.0250 (holds for gamma < 0.52).
// Time still counts: p 0.8 at 5 min (0.16 / 1.90 = 0.084) beats p 0.5 at 40 min.
// A run with info below `minInfo` (0.02 ~ p 0.98 at a = 1) is not proposed at any cost. Coverage balance (f), pins, the
// cascade, budgets, the switch penalty and the posterior update after each pick work as before.

export const PLANNER_DEFAULTS = {
    weights: { top: 1, speed: 0.6, difficulty: 0.8 },
    strategy: 'greedy',            // 'greedy' | 'cascade' | 'blend'
    blendShare: 0.5,               // blend: share of the local budget the cascade gets first
    repeatDiscount: 0.3,
    topK: 6,
    topIncludeCloud: false,        // TOP / SPEED rank the local ladder; cloud models are scouts by default
    roleBias: 0.3,
    focusWidth: 1.0,
    speedTargetShared: 10,
    validity: { minStrong: 4, strongGap: 1.0 },
    priors: { family: true, familyTau: 0.5, familyMinN: 12, untriedB: 1.5, untriedSE: 1.5, taskB: {} },
    minValue: 0.05,                // a candidate whose weighted, normalised value is below this is not worth any time
    rerunScored: false,            // offer tasks the config already ran (its benchmark config) again; off = one run per task per config
    budget: { localHours: 8, cloud: true, cloudHours: 2, switchMin: 5 },
    defaultWall: { solveMin: 20, failMin: 60 },
    cascade: { order: [], minReach: 0.25 },
    pins: [],
    focus: [],                     // [{model, promptLevel?}]: the settings' form; the planner reads input.focus (expanded ids)
    balance: 1,                    // coverage balancing among focus configs: f = (1 + deficit points / 10)^balance; 0 = off
    chunkTasks: 4,                 // tasks per queue row (chunkSchedule); 0 = one row per config
    onlyQueueLane: null,           // refill: candidates only for configs on this queue lane
    scoring: 'info',               // 'info' (expected information, time secondary) | 'legacy' (TOP / SPEED / DIFFICULTY value per minute)
    timeGamma: 0.4,                // info: score = info / minutes^timeGamma (0 = time ignored, 1 = per minute like legacy)
    minInfo: 0.02,                 // info: a run whose information is below this is not proposed (p 0.98 at a = 1)
    explainTop: 15,                // info: out.candidates keeps each config's best N first-round candidates (debug / dry run)
};

/** Coverage deficit factor (see the header): C, Cstar in strength points (0-100). */
export const balanceFactor = (C, Cstar, balance) => (balance > 0 ? Math.pow(1 + Math.max(0, Cstar - C) / 10, balance) : 1);

/**
 * A focus list over the runnable configs -> {models, focus}: a focus entry at a prompt level other than L2 becomes its own
 * config `<id>.<level>` (the prompt level is part of a config's identity: run.py CODEBENCH_PROMPT_LEVEL), carrying
 * `promptLevel` and the env that asks run.py for it. Unknown ids are skipped. The server has the same function
 * (lib/autoqueue.js expandFocus); test/autoqueue-focus.test.js checks the two agree.
 */
export function expandFocus(models, focus) {
    const out = (models || []).slice();
    const ids = [];
    for (const f of focus || []) {
        const base = f && (models || []).find((m) => m && m.id === f.model);
        if (!base) continue;
        const lvl = String(f.promptLevel || 'L2').toUpperCase();
        if (!/^L[123]$/.test(lvl)) continue;
        if (lvl === (base.promptLevel || 'L2')) { if (!ids.includes(base.id)) ids.push(base.id); continue; }
        const id = `${base.id}.${lvl}`;
        if (!out.some((m) => m.id === id)) {
            out.push({ ...base, id, label: `${base.label || base.id} · ${lvl}`, promptLevel: lvl, focusOf: base.id,
                env: { ...(base.env || {}), CODEBENCH_PROMPT_LEVEL: lvl } });
        }
        if (!ids.includes(id)) ids.push(id);
    }
    return { models: out, focus: ids };
}

/**
 * The batch as queue rows: each non-cascade leg cut into chunks of `chunkTasks` runs, and the chunks of each queue lane
 * interleaved round-robin in leg order (A1 B1 C1 A2 B2 A3 ...). Cascade legs pass through whole, first, in their order
 * (a stage's task set is decided at run time). chunkTasks 0 = the legs unchanged. `laneOf(leg)` -> the leg's queue lane.
 * -> [{...leg, runs, chunk, chunks}] in emission order; every lane's rows keep that relative order when inserted.
 */
export function chunkSchedule(legs, chunkTasks = 4, laneOf = (L) => L.queueLane || (L.lane === 'cloud' ? 'cloud' : 'local-gpu')) {
    const n = Math.max(0, Math.floor(Number(chunkTasks) || 0));
    const all = (legs || []).filter((L) => L && L.runs && L.runs.length);
    const out = all.filter((L) => L.cascade != null).map((L) => ({ ...L, queueLane: laneOf(L) }));
    const flat = all.filter((L) => L.cascade == null);
    if (!n) return [...out, ...flat.map((L) => ({ ...L, queueLane: laneOf(L), chunk: 1, chunks: 1 }))];
    const byLane = new Map();
    for (const L of flat) {
        const lane = laneOf(L);
        const pieces = [];
        for (let i = 0; i < L.runs.length; i += n) pieces.push(L.runs.slice(i, i + n));
        if (!byLane.has(lane)) byLane.set(lane, []);
        byLane.get(lane).push({ L, lane, pieces });
    }
    for (const list of byLane.values()) {
        for (let k = 0; list.some((x) => k < x.pieces.length); k++) {
            for (const x of list) if (k < x.pieces.length) {
                const runs = x.pieces[k];
                out.push({ ...x.L, queueLane: x.lane, runs, minutes: runs.reduce((a, r) => a + (r.expMinutes != null ? r.expMinutes : r.minutes || 0), 0), chunk: k + 1, chunks: x.pieces.length });
            }
        }
    }
    return out;
}

export const sigmoid = (x) => 1 / (1 + Math.exp(-x));   // the logistic as such; pass probabilities go through itemP
export const logit = (p) => Math.log(p / (1 - p));

// Abramowitz-Stegun 7.1.26: |error| < 1.5e-7, plenty for a weighting.
function erf(x) {
    const s = x < 0 ? -1 : 1; x = Math.abs(x);
    const t = 1 / (1 + 0.3275911 * x);
    const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
    return s * y;
}
export const normCdf = (z) => 0.5 * (1 + erf(z / Math.SQRT2));

/** Overlap of two ability distributions {theta, se}: 1 = the data cannot tell them apart, 0 = separated. */
export function overlap(a, b) {
    const sigma = Math.sqrt((a.se * a.se + b.se * b.se) / 2) || 1e-9;
    return 2 * normCdf(-Math.abs(a.theta - b.theta) / (2 * sigma));
}

/** The item a config meets in task t: {b, a, se}. A config may carry its own (m.items[task], e.g. an L3 config's `T@L3`
 *  problem once the fit has one); otherwise the task's own difficulty and discrimination (a = 1 when the fit has none). */
export function itemOf(m, t) {
    const o = m && m.items && m.items[t.id];
    if (o && Number.isFinite(o.b)) return { b: o.b, a: o.a > 0 ? o.a : 1, se: o.se != null ? o.se : t.se };
    return { b: t.b, a: t.a > 0 ? t.a : 1, se: t.se };
}
/** Point pass probability at the config's ability (2PL: sigmoid(a (theta - b)); a = 1 is the old 1PL). */
export const passProb = (m, t) => { const it = itemOf(m, t); return itemP(it.a, it.b, m.theta); };

// 7-point Gauss-Hermite (physicists'): E[f(X)], X ~ N(mu, sd^2) = sum_i w_i f(mu + sqrt2 sd x_i) / sqrt(pi)
const GH_X = [-2.651961356835233, -1.673551628767471, -0.8162878828589647, 0, 0.8162878828589647, 1.673551628767471, 2.651961356835233];
const GH_W = [0.0009717812450995192, 0.05451558281912703, 0.4256072526101278, 0.8102646175568073, 0.4256072526101278, 0.05451558281912703, 0.0009717812450995192];
/** Over theta ~ N(theta, se^2): p = E[sigmoid(a (theta - b))] and pq = E[p (1 - p)]. se 0 = the point values. */
export function predictive(theta, se, a, b) {
    if (!(se > 0)) { const p = itemP(a, b, theta); return { p, pq: p * (1 - p) }; }
    let p = 0, pq = 0;
    for (let i = 0; i < GH_X.length; i++) {
        const x = itemP(a, b, theta + Math.SQRT2 * se * GH_X[i]);
        p += GH_W[i] * x; pq += GH_W[i] * x * (1 - x);
    }
    const k = 1 / Math.sqrt(Math.PI);
    return { p: p * k, pq: pq * k };
}
/**
 * Expected information of one run of (m, t) (see the header): {p, I, info, a, b}. I = a^2 E[p(1-p)] x discount^repeats;
 * info = I / (1 + I se_b^2), what the run says about the config's ability.
 */
export function runInfo(m, t, repeats = 0, discount = 0.3) {
    const it = itemOf(m, t);
    const pr = predictive(m.theta, m.se, it.a, it.b);
    const I = it.a * it.a * pr.pq * Math.pow(discount, Math.max(0, repeats));
    const se2 = it.se != null ? it.se * it.se : 0;
    return { p: pr.p, I, info: I / (1 + I * se2), a: it.a, b: it.b };
}
/** Info-mode score of a candidate costing `minutes` (balance factor f): info x f / minutes^gamma. */
export const infoScore = (info, minutes, gamma, f = 1) => (info * f) / Math.pow(Math.max(minutes, 0.5), Math.max(0, gamma));
/** The pass probability the planner works with: the predictive one (info scoring) or the point one (legacy). */
const pOf = (m, t, s) => (s && s.scoring === 'legacy' ? passProb(m, t) : predictive(m.theta, m.se, itemOf(m, t).a, itemOf(m, t).b).p);

/** Fisher information of one more run at pass probability p, after `repeats` earlier runs of the pair. */
export function fisherInfo(p, repeats = 0, discount = 0.3) {
    return p * (1 - p) * Math.pow(discount, Math.max(0, repeats));
}

/** Fraction of a parameter's variance that information I removes (normal approximation). */
export const varianceReduction = (I, se) => (I * se * se) / (1 + I * se * se);

/** Expected wall minutes of (m, t) at pass probability p. */
export function expectedMinutes(m, t, p, s) {
    const dw = (s && s.defaultWall) || PLANNER_DEFAULTS.defaultWall;
    const cap = t.capMin || 120;
    const solve = Math.min(cap, t.solveMin != null ? t.solveMin : dw.solveMin);
    const fail = Math.min(cap, t.failMin != null ? t.failMin : dw.failMin);
    const rel = m.relTime > 0 ? m.relTime : 1;
    return Math.min(cap, rel * (p * solve + (1 - p) * fail));
}

/** Merge user settings over the defaults (one level deep for the nested groups). */
export function withDefaults(s) {
    const D = PLANNER_DEFAULTS, o = { ...D, ...(s || {}) };
    for (const k of ['weights', 'validity', 'priors', 'budget', 'defaultWall', 'cascade']) o[k] = { ...D[k], ...((s || {})[k] || {}) };
    o.priors.taskB = { ...((s && s.priors && s.priors.taskB) || {}) };
    o.pins = Array.isArray(o.pins) ? o.pins : [];
    o.focus = Array.isArray(o.focus) ? o.focus : [];
    o.balance = Number.isFinite(Number(o.balance)) ? Math.max(0, Number(o.balance)) : D.balance;
    o.scoring = o.scoring === 'legacy' ? 'legacy' : 'info';
    const nn = (v, d) => (v != null && v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
    o.timeGamma = nn(o.timeGamma, D.timeGamma);
    o.minInfo = nn(o.minInfo, D.minInfo);
    o.explainTop = Math.round(nn(o.explainTop, D.explainTop));
    return o;
}

/**
 * Family prior: quants of the same weights start with correlated abilities. Each model's fitted theta is
 * shrunk toward the precision-weighted mean of its FAMILY SIBLINGS (leave-one-out) with prior sd `tau`;
 * only models with fewer than `minN` scored tasks are shrunk (the prior is where a record STARTS);
 * a model with no data at all takes the siblings' mean (+ its `priorShift`, the user's expectation, e.g.
 * IQ2_XXS -1.0) with se = sqrt(tau^2 + se_mean^2). Returns new model objects; `prior` says what happened.
 */
export function applyFamilyPrior(models, { tau = 0.5, enabled = true, minN = 12 } = {}) {
    const byFam = new Map();
    for (const m of models) if (m.family && m.fitted) (byFam.get(m.family) || byFam.set(m.family, []).get(m.family)).push(m);
    return models.map((m) => {
        const sib = (byFam.get(m.family) || []).filter((x) => x.id !== m.id);
        const shift = m.priorShift || 0;
        // "start with": the prior is for thin records; a model with minN scored tasks stands on its own data
        if (m.fitted && (m.n || 0) >= minN) return { ...m, prior: 'none' };
        if (!enabled || !m.family || !sib.length) {
            if (m.fitted) return { ...m, prior: 'none' };
            // derive.js hands the fit's own prior for an unfitted config (its weights' model ability, else the population's)
            return { ...m, theta: (Number.isFinite(m.priorTheta) ? m.priorTheta : 0) + shift, se: m.priorSe > 0 ? m.priorSe : 1.5, prior: m.priorSource || 'global' };
        }
        const W = sib.reduce((a, x) => a + 1 / (x.se * x.se), 0);
        const mu = sib.reduce((a, x) => a + x.theta / (x.se * x.se), 0) / W + shift;
        const seMu = Math.sqrt(1 / W);
        const tau2 = tau * tau + seMu * seMu;
        if (!m.fitted) return { ...m, theta: mu, se: Math.sqrt(tau2), prior: 'family' };
        const prec = 1 / (m.se * m.se) + 1 / tau2;
        return { ...m, theta: (m.theta / (m.se * m.se) + mu / tau2) / prec, se: Math.sqrt(1 / prec), thetaFit: m.theta, seFit: m.se, prior: 'family' };
    });
}

/** Per-task prior difficulty: untried tasks default to "hard, wide"; a user override is a prior mean. */
export function applyTaskPriors(tasks, pri) {
    const P = { ...PLANNER_DEFAULTS.priors, ...(pri || {}) };
    const over = P.taskB || {};
    return tasks.map((t) => {
        const o = over[t.id];
        const has = o != null && o !== '' && Number.isFinite(Number(o));
        if (!t.tried) return { ...t, b: has ? Number(o) : P.untriedB, se: P.untriedSE, prior: has ? 'override' : 'untried' };
        if (!has) return t;
        const s0 = 0.75, prec = 1 / (t.se * t.se) + 1 / (s0 * s0);
        return { ...t, b: (t.b / (t.se * t.se) + Number(o) / (s0 * s0)) / prec, se: Math.sqrt(1 / prec), prior: 'override' };
    });
}

/** Tasks unsolved after N strong attempts: check the task, do not spend more runs on it. */
export function validityFlags(tasks, s) {
    const n = ((s && s.validity) || PLANNER_DEFAULTS.validity).minStrong;
    return tasks.filter((t) => t.tried && (t.nStrong || 0) >= n && !(t.strongPasses > 0))
        .map((t) => ({ task: t.id, nStrong: t.nStrong, attempts: t.attempts || t.nStrong,
            reason: `unsolved after ${t.nStrong} strong attempt${t.nStrong === 1 ? '' : 's'}: check the task is solvable as specified before running it again` }));
}

const pct = (p) => `${Math.round(p * 100)}%`;
const f1 = (x) => (x >= 0 ? '+' : '') + x.toFixed(1);

/** Everything the scorer needs that does not change per candidate. */
function context(input, s) {
    const models = input.models.map((m) => ({ ...m, se2: m.se * m.se, pendingSet: new Set(m.pending || []) }));
    const tasks = input.tasks.map((t) => ({ ...t, se2: t.se * t.se }));
    const flagged = validityFlags(tasks, s);
    const flaggedSet = new Set(flagged.map((f) => f.task));
    const byId = new Map(models.map((m) => [m.id, m]));
    const focusSet = new Set((input.focus || []).filter((id) => byId.has(id)));
    for (const m of models) {
        m.allowedSet = Array.isArray(m.allowedTasks) ? new Set(m.allowedTasks) : null;
        if (focusSet.has(m.id) && m.role === 'ignored') m.role = 'contender';   // focused: planned whatever its role
    }
    const ranked = models.filter((m) => m.role !== 'ignored' && (m.fitted || m.prior === 'family') && (s.topIncludeCloud || m.lane !== 'cloud'))
        .sort((a, b) => b.theta - a.theta);
    // with a focus set, the ladder TOP / SPEED work on is the focus set itself (the comparison the user asked for)
    const top = focusSet.size ? models.filter((m) => focusSet.has(m.id)).sort((a, b) => b.theta - a.theta) : ranked.slice(0, Math.max(1, s.topK));
    const topSet = new Set(top.map((m) => m.id));
    const thetaTop = top.length ? top.reduce((a, m) => a + m.theta, 0) / top.length : 0;
    // shared solved tasks between every pair of top models (any config of the model: its history)
    const solvedBy = new Map(models.map((m) => [m.id, new Set(Object.entries(m.hist || {}).filter(([, h]) => h.passes > 0).map(([t]) => t))]));
    const shared = new Map();
    for (const a of top) for (const b of top) if (a.id < b.id) {
        const A = solvedBy.get(a.id), B = solvedBy.get(b.id);
        let n = 0; for (const t of A) if (B.has(t)) n++;
        shared.set(a.id + '|' + b.id, n);
    }
    // strength coverage, in points (0-100): what each config ran at its benchmark config, and what is queued for it
    const points = new Map(tasks.map((t) => [t.id, Number(t.points) > 0 ? Number(t.points) : 0]));
    const cov = new Map();
    for (const m of models) {
        let cur = 0, pend = 0;
        const ran = m.cfg || {};
        // derive.js hands the fit's own number (bonus results included); a bare input sums the task points
        if (Number.isFinite(Number(m.coverage)) && m.coverage != null) cur = Number(m.coverage) * 100;
        else for (const [t, r] of Object.entries(ran)) if (r && r.ran) cur += points.get(t) || 0;
        for (const t of m.pending || []) if (!(ran[t] && ran[t].ran)) pend += points.get(t) || 0;
        cov.set(m.id, { current: cur, pending: pend, batch: 0 });
    }
    return { models, tasks, flagged, flaggedSet, byId, ranked, top, topSet, thetaTop, solvedBy, shared, focusSet, points, cov };
}
/** C* : the best-covered focus config's coverage (current + queued + this batch), in points. */
function coverageTarget(ctx) {
    let best = 0;
    for (const id of ctx.focusSet) { const c = ctx.cov.get(id); if (c) best = Math.max(best, c.current + c.pending + c.batch); }
    return best;
}
const coverageOf = (ctx, id) => { const c = ctx.cov.get(id); return c ? c.current + c.pending + c.batch : 0; };
const pairKey = (a, b) => (a < b ? a + '|' + b : b + '|' + a);

/** Neighbours of a top model on the ladder: the leader and the rungs just above and below. */
function neighbours(ctx, m) {
    const i = ctx.top.findIndex((x) => x.id === m.id);
    if (i < 0) return [];
    const out = new Set();
    if (i > 0) { out.add(ctx.top[0]); out.add(ctx.top[i - 1]); }
    if (i + 1 < ctx.top.length) out.add(ctx.top[i + 1]);
    return [...out];
}

/** Raw objective values of one candidate (not yet normalised or weighted). */
export function scoreRaw(ctx, m, t, s) {
    const reps = (m.hist && m.hist[t.id] && m.hist[t.id].attempts) || 0;
    if (s.scoring !== 'legacy') {
        // information scoring: what one run tells us about this config's ability (header: INFORMATION SCORING)
        const r = runInfo(m, t, reps, s.repeatDiscount);
        return { p: r.p, I: r.I, info: r.info, a: r.a, b: r.b, theta: m.theta, seTheta: m.se, reps, top: 0, speed: 0, diff: 0,
            why: { diff: { tried: !!t.tried, nStrong: t.nStrong || 0, b: r.b, se: t.se } }, minutes: expectedMinutes(m, t, r.p, s) };
    }
    const p = passProb(m, t);
    const I = fisherInfo(p, reps, s.repeatDiscount);
    const Itheta = I / (1 + I * t.se2), Ib = I / (1 + I * m.se2);
    const contender = m.role === 'contender' || m.role === 'both';
    const scout = m.role === 'scout' || m.role === 'both';
    const out = { p, I, reps, top: 0, speed: 0, diff: 0, why: {} };
    if (ctx.topSet.has(m.id)) {
        let best = 0, with_ = null;
        for (const n of neighbours(ctx, m)) { const o = overlap(m, n); if (o > best) { best = o; with_ = n; } }
        out.top = varianceReduction(Itheta, m.se) * best * (contender ? 1 : s.roleBias);
        out.why.top = with_ ? { with: with_.label, overlap: best } : null;
        const ran = m.cfg && m.cfg[t.id] && m.cfg[t.id].ran;
        if (!ran) {
            let sum = 0, bestNeed = 0, bestN = null;
            const others = ctx.top.filter((n) => n.id !== m.id);
            for (const n of others) {
                if (!ctx.solvedBy.get(n.id).has(t.id)) continue;
                const sh = ctx.shared.get(pairKey(m.id, n.id)) || 0;
                const need = Math.max(0, 1 - sh / s.speedTargetShared);
                sum += need;
                if (need > bestNeed) { bestNeed = need; bestN = { with: n.label, shared: Math.round(sh) }; }
            }
            out.speed = others.length ? (p * sum / others.length) * (contender ? 1 : s.roleBias) : 0;
            out.why.speed = bestN;
        }
    }
    const rel = Math.exp(-((t.b - ctx.thetaTop) ** 2) / (2 * s.focusWidth * s.focusWidth));
    const thin = (t.nStrong || 0) < 2;
    out.diff = varianceReduction(Ib, t.se) * rel * (thin && !scout ? s.roleBias : 1);
    out.why.diff = { tried: !!t.tried, nStrong: t.nStrong || 0, b: t.b, se: t.se };
    out.minutes = expectedMinutes(m, t, p, s);
    return out;
}

/** Info-mode reason: p, I and minutes, and the score they make. */
function infoReason(c, s, score) {
    const d = c.why && c.why.diff;
    const untried = d && !d.tried ? `; untried task (prior b ${f1(d.b)} ± ${d.se.toFixed(1)})` : '';
    return `${pct(c.p)} predicted pass; information ${c.info.toFixed(3)} (a ${c.a.toFixed(2)}, a²·p(1−p)${c.seTheta > 0 ? ` over ability ±${c.seTheta.toFixed(2)}` : ''})${untried}`
        + `${c.reps ? `; repeat #${c.reps + 1}` : ''}; ~${Math.round(c.minutes)} min; score ${score.toFixed(4)} (info ÷ minutes^${s.timeGamma})`;
}

function reasonOf(c, s) {
    const w = s.weights;
    const parts = [['top', w.top * c.nTop], ['speed', w.speed * c.nSpeed], ['diff', w.difficulty * c.nDiff]].sort((a, b) => b[1] - a[1]);
    const k = parts[0][1] > 0 ? parts[0][0] : 'diff';
    let why;
    if (k === 'top' && c.why.top) why = `separates ${c.label} from ${c.why.top.with} (overlap ${pct(c.why.top.overlap)})`;
    else if (k === 'speed' && c.why.speed) why = `adds a shared solve with ${c.why.speed.with} for head-to-head time (${c.why.speed.shared} shared)`;
    else {
        const d = c.why.diff;
        why = !d.tried ? `calibrates an untried task (prior b ${f1(d.b)} ± ${d.se.toFixed(1)})`
            : `calibrates difficulty near the top (b ${f1(d.b)} ± ${d.se.toFixed(1)}, ${Math.round(d.nStrong)} strong attempt${Math.round(d.nStrong) === 1 ? '' : 's'})`;
    }
    return `${pct(c.p)} predicted pass; ${why}${c.reps ? `; repeat #${c.reps + 1}` : ''}; ~${Math.round(c.minutes)} min`;
}

/** All candidates, scored (normalised by the caller). Never a task this config already ran, unless s.rerunScored. */
export function scoreAll(ctx, s, { exclude } = {}) {
    const cands = [];
    for (const m of ctx.models) {
        if (m.role === 'ignored' || m.available === false) continue;
        if (ctx.focusSet && ctx.focusSet.size && !ctx.focusSet.has(m.id)) continue;          // focus: only focus configs
        if (s.onlyQueueLane && (m.queueLane || (m.lane === 'cloud' ? 'cloud' : 'local-gpu')) !== s.onlyQueueLane) continue;
        for (const t of ctx.tasks) {
            if (ctx.flaggedSet.has(t.id) || t.invalid) continue;
            if (m.allowedSet && !m.allowedSet.has(t.id)) continue;                          // e.g. no prompt-L3.md for an L3 config
            if (exclude && exclude.has(m.id + '\u0000' + t.id)) continue;
            if (m.pendingSet && m.pendingSet.has(t.id)) continue;
            if (!s.rerunScored && m.cfg && m.cfg[t.id] && m.cfg[t.id].ran) continue;   // already ran at this config
            cands.push({ model: m.id, label: m.label, lane: m.lane || 'local', queueLane: m.queueLane || null, task: t.id, ...scoreRaw(ctx, m, t, s) });
        }
    }
    return cands;
}
function normalise(cands, maxes) {
    for (const c of cands) {
        c.nTop = maxes.top ? c.top / maxes.top : 0;
        c.nSpeed = maxes.speed ? c.speed / maxes.speed : 0;
        c.nDiff = maxes.diff ? c.diff / maxes.diff : 0;
    }
}
const maxesOf = (cands) => ({ top: Math.max(0, ...cands.map((c) => c.top)), speed: Math.max(0, ...cands.map((c) => c.speed)), diff: Math.max(0, ...cands.map((c) => c.diff)) });

/**
 * The cascade preset (the user's scaffold): stage k runs what every earlier stage failed. Statically, a
 * task reaches stage k with probability prod_{j<k} P(stage j fails it): 0 or 1 where stage j already ran
 * it at its benchmark config, else 1 - p. A stage lists the tasks it has not run at its config whose
 * reach is >= cascade.minReach; expected minutes are weighted by the reach. Stops at the budget.
 * -> {legs, minutes}
 */
export function cascadePlan(ctx, s, budgetMin, laneOf = () => 'local') {
    const order = (s.cascade.order || []).map((id) => ctx.byId.get(id)).filter(Boolean);
    const legs = [];
    let used = 0;
    if (order.length < 2) return { legs, minutes: 0, seed: [] };
    const reach = new Map(ctx.tasks.filter((t) => !ctx.flaggedSet.has(t.id) && !t.invalid).map((t) => [t.id, 1]));
    const prevName = [];
    let seed = [];
    for (let k = 0; k < order.length; k++) {
        const m = order[k];
        const runs = [];
        for (const t of ctx.tasks) {
            const r = reach.get(t.id); if (r == null) continue;
            const cfg = m.cfg && m.cfg[t.id];
            const p = pOf(m, t, s);
            if (k > 0 && m.available !== false && m.role !== 'ignored' && !(cfg && cfg.ran) && !m.pendingSet.has(t.id) && r >= s.cascade.minReach && laneOf(m) === 'local') {
                const minutes = expectedMinutes(m, t, p, s);
                const cost = r * minutes + (runs.length ? 0 : s.budget.switchMin);
                if (used + cost <= budgetMin) {
                    used += cost;
                    runs.push({ model: m.id, label: m.label, lane: 'local', task: t.id, p, minutes, expMinutes: r * minutes, reach: r, cascade: k,
                        reason: `${pct(p)} predicted pass; cascade stage ${k}: ${r >= 0.999 ? `${prevName.slice(-1)[0]} failed it` : `reached if earlier stages fail (${pct(r)})`}; ~${Math.round(minutes)} min` });
                }
            }
            // what reaches the next stage
            // a stage that will not run (unavailable, ignored, cloud after the seed) passes everything on
            const runsHere = k > 0 && m.available !== false && m.role !== 'ignored' && laneOf(m) === 'local';
            const fails = cfg && cfg.ran ? (cfg.passed ? 0 : 1) : (k === 0 ? 0 : (runsHere ? 1 - p : 1));
            reach.set(t.id, r * fails);
        }
        prevName.push(m.label);
        if (k === 0) seed = [...reach.entries()].filter(([, r]) => r > 0).map(([t]) => t);
        if (runs.length) legs.push({ model: m.id, label: m.label, lane: 'local', cascade: k, runs });
    }
    return { legs, minutes: used, seed };
}

/**
 * plan(input, settings) -> {legs, flagged, totals, ranking, notes}
 *   input.models: [{id, label, role ('scout'|'contender'|'both'|'ignored'), lane ('local'|'cloud'),
 *                   theta, se, fitted, family, priorShift, relTime, available, unavailableReason,
 *                   hist: {task: {attempts, passes}}, cfg: {task: {ran, passed}}}]
 *   input.tasks:  [{id, b, se, tried, nStrong, strongPasses, solveMin, failMin, capMin, invalid}]
 * Legs: one model config per leg (one server launch), pins first, then in the order greedy first chose
 * the model; each run {task, p, minutes, reason, pinned, cascade}.
 */
export function plan(input, settingsIn) {
    const s = withDefaults(settingsIn);
    const models0 = applyFamilyPrior(input.models, { tau: s.priors.familyTau, enabled: s.priors.family, minN: s.priors.familyMinN });
    const tasks0 = applyTaskPriors(input.tasks, s.priors);
    const ctx = context({ models: models0, tasks: tasks0, focus: input.focus || [] }, s);
    const notes = [];
    const ranking = ctx.ranked.map((m, i) => ({ id: m.id, label: m.label, theta: m.theta, se: m.se, top: i < s.topK, prior: m.prior, fitted: !!m.fitted }));
    const budgets = { local: s.budget.localHours * 60, cloud: s.budget.cloud ? s.budget.cloudHours * 60 : 0 };
    const used = { local: 0, cloud: 0 };
    const legs = new Map();            // model id -> leg
    const legOrder = [];
    const taken = new Set();
    // one leg per model config and kind: a cascade stage is its own server launch (its task set is
    // decided at run time from the previous stage's failures), so it is never merged with static runs
    const keyOf = (m, stage) => (stage != null ? `${m.id}#c${stage}` : m.id);
    const leg = (m, stage) => {
        const k = keyOf(m, stage);
        if (!legs.has(k)) { legs.set(k, { model: m.id, label: m.label, lane: m.lane || 'local', ...(m.queueLane ? { queueLane: m.queueLane } : {}), runs: [], minutes: 0, ...(stage != null ? { cascade: stage } : {}) }); legOrder.push(k); }
        return legs.get(k);
    };
    const switchFor = (m, stage) => ((m.lane || 'local') === 'local' && !legs.has(keyOf(m, stage)) ? s.budget.switchMin : 0);
    const add = (m, run, cost) => {
        const sw = switchFor(m, run.cascade);
        const L = leg(m, run.cascade);
        L.runs.push(run); L.minutes += run.minutes;
        used[L.lane] += cost + sw;
        taken.add(m.id + '\u0000' + run.task);
        const c = ctx.cov.get(m.id);
        if (c && !(m.cfg && m.cfg[run.task] && m.cfg[run.task].ran) && !m.pendingSet.has(run.task)) c.batch += ctx.points.get(run.task) || 0;
    };

    // 1. pins, in order. Already-run pairs at the model's config are skipped unless the pin says rerun.
    for (const pin of s.pins) {
        if (pin.enabled === false) continue;
        const m = ctx.byId.get(pin.model);
        if (!m) { notes.push(`pin skipped: unknown model ${pin.model}`); continue; }
        if (m.available === false) { notes.push(`pin skipped: ${m.label} ${m.unavailableReason || 'is not available'}`); continue; }
        const lane = m.lane || 'local';
        let cut = 0;
        for (const tid of pin.tasks || []) {
            const t = ctx.tasks.find((x) => x.id === tid);
            if (!t) continue;
            if (taken.has(m.id + '\u0000' + tid)) continue;
            if (!pin.rerun && m.cfg && m.cfg[tid] && m.cfg[tid].ran) continue;
            if (m.pendingSet.has(tid)) continue;       // already queued (a running or waiting queue)
            if (m.allowedSet && !m.allowedSet.has(tid)) continue;   // the config cannot run it (no prompt at its level)
            const p = pOf(m, t, s), minutes = expectedMinutes(m, t, p, s);
            if (used[lane] + minutes + switchFor(m) > budgets[lane]) { cut++; continue; }
            const rerun = !!(m.cfg && m.cfg[tid] && m.cfg[tid].ran);     // only reachable with pin.rerun
            add(m, { task: tid, p, minutes, pinned: true, ...(rerun ? { rerun: true } : {}), reason: `${pct(p)} predicted pass; pinned${pin.note ? `: ${pin.note}` : ''}; ~${Math.round(minutes)} min` }, minutes);
        }
        if (cut) notes.push(`pin "${pin.note || m.label}": ${cut} run(s) did not fit the ${lane} budget`);
    }

    // 2. cascade (strategy cascade, or its share of a blend)
    let cascadeOut = null;
    if (s.strategy === 'cascade' || s.strategy === 'blend') {
        const share = s.strategy === 'cascade' ? 1 : s.blendShare;
        const cp = cascadePlan(ctx, s, Math.max(0, budgets.local * share - used.local), (m) => m.lane || 'local');
        for (const L of cp.legs) {
            const m = ctx.byId.get(L.model);
            for (const r of L.runs) if (!taken.has(m.id + '\u0000' + r.task)) add(m, r, r.expMinutes);
        }
        cascadeOut = { order: s.cascade.order.slice(), seed: cp.seed };
        if (s.cascade.order.some((id) => { const m = ctx.byId.get(id); return m && m.lane === 'cloud'; }) && s.cascade.order.findIndex((id) => (ctx.byId.get(id) || {}).lane === 'cloud') > 0)
            notes.push('cascade: cloud stages after the first are not run by the local queue (the first stage is the seed)');
    }

    // 3. information-greedy for what is left
    let candidates = null;
    if (s.strategy !== 'cascade') {
        const infoMode = s.scoring !== 'legacy';
        let cands = scoreAll(ctx, s, { exclude: taken });
        const maxes = maxesOf(cands);      // normalise once: weights mean relative importance (legacy)
        normalise(cands, maxes);
        const weight = infoMode ? (c) => c.info : (c) => s.weights.top * c.nTop + s.weights.speed * c.nSpeed + s.weights.difficulty * c.nDiff;
        const floor = infoMode ? s.minInfo : s.minValue;
        // info: score = info x f / (minutes + switch)^gamma; legacy: value x f per hour
        const rateOf = infoMode ? (v, f, cost) => infoScore(v, cost, s.timeGamma, f) : (v, f, cost) => v * f / cost * 60;
        const balancing = ctx.focusSet.size > 1 && s.balance > 0;
        if (infoMode && s.explainTop > 0) {
            // DRY-RUN VIEW: each config's best first-round candidates, so "why this one" can be read off p / I / minutes
            const Cstar0 = balancing ? coverageTarget(ctx) : 0;
            const by = new Map();
            for (const c of cands) {
                const m = ctx.byId.get(c.model);
                const f = balancing ? balanceFactor(coverageOf(ctx, c.model), Cstar0, s.balance) : 1;
                const cost = c.minutes + switchFor(m);
                const row = { task: c.task, p: c.p, I: c.I, info: c.info, a: c.a, b: c.b, minutes: c.minutes, score: rateOf(c.info, f, cost), belowFloor: c.info < floor, points: ctx.points.get(c.task) || 0 };
                (by.get(c.model) || by.set(c.model, []).get(c.model)).push(row);
            }
            candidates = {};
            for (const [id, list] of by) {
                const m = ctx.byId.get(id);
                list.sort((x, y) => y.score - x.score);
                candidates[id] = { label: m.label, theta: m.theta, se: m.se, n: list.length, top: list.slice(0, s.explainTop) };
            }
        }
        for (let guard = 0; guard < 500; guard++) {
            let best = null, bestRate = 0, bestF = 1, bestCost = 0;
            const Cstar = balancing ? coverageTarget(ctx) : 0;
            const fOf = new Map();
            const factor = (id) => { if (!balancing) return 1; if (!fOf.has(id)) fOf.set(id, balanceFactor(coverageOf(ctx, id), Cstar, s.balance)); return fOf.get(id); };
            for (const c of cands) {
                const lane = c.lane;
                const m = ctx.byId.get(c.model);
                const cost = c.minutes + switchFor(m);
                if (used[lane] + cost > budgets[lane]) continue;
                const v = weight(c);
                if (v < floor) continue;
                const f = factor(c.model);
                const rate = rateOf(v, f, cost);
                if (rate > bestRate) { bestRate = rate; best = c; bestF = f; bestCost = cost; }
            }
            if (!best || bestRate <= 1e-9) break;
            const m = ctx.byId.get(best.model);
            const rerun = !!(m.cfg && m.cfg[best.task] && m.cfg[best.task].ran);   // only with s.rerunScored
            const covNote = balancing && bestF > 1.005 ? `; coverage ${Math.round(coverageOf(ctx, m.id))} of ${Math.round(Cstar)} pts (×${bestF.toFixed(1)})` : '';
            const common = { task: best.task, p: best.p, minutes: best.minutes, value: weight(best), ...(rerun ? { rerun: true } : {}),
                ...(balancing ? { balance: bestF } : {}), points: ctx.points.get(best.task) || 0 };
            add(m, infoMode
                ? { ...common, I: best.I, info: best.info, a: best.a, b: best.b, score: bestRate, costMin: bestCost, reason: infoReason(best, s, bestRate) + covNote }
                : { ...common, ratePerHour: bestRate, parts: { top: best.nTop, speed: best.nSpeed, difficulty: best.nDiff }, reason: reasonOf(best, s) + covNote }, best.minutes);
            // posterior update: diminishing returns for this model and this task
            const t = ctx.tasks.find((x) => x.id === best.task);
            const Ith = best.I / (1 + best.I * t.se2), Ib = best.I / (1 + best.I * m.se2);
            m.se2 = m.se2 / (1 + Ith * m.se2); m.se = Math.sqrt(m.se2);
            t.se2 = t.se2 / (1 + Ib * t.se2); t.se = Math.sqrt(t.se2);
            t.nStrong = (t.nStrong || 0) + (ctx.topSet.has(m.id) ? best.p : 0);
            if (ctx.topSet.has(m.id)) for (const n of ctx.top) if (n.id !== m.id && ctx.solvedBy.get(n.id).has(t.id)) {
                const k = pairKey(m.id, n.id); ctx.shared.set(k, (ctx.shared.get(k) || 0) + best.p);
            }
            cands = cands.filter((c) => !(c.model === best.model && c.task === best.task));
            for (const c of cands) if (c.model === best.model || c.task === best.task) {
                Object.assign(c, scoreRaw(ctx, ctx.byId.get(c.model), ctx.tasks.find((x) => x.id === c.task), s));
                c.nTop = maxes.top ? c.top / maxes.top : 0; c.nSpeed = maxes.speed ? c.speed / maxes.speed : 0; c.nDiff = maxes.diff ? c.diff / maxes.diff : 0;
            }
        }
    }

    // pinned runs lead their leg; legs holding pins lead the batch
    const out = legOrder.map((id) => legs.get(id));
    for (const L of out) L.runs.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
    out.sort((a, b) => (b.runs.some((r) => r.pinned) ? 1 : 0) - (a.runs.some((r) => r.pinned) ? 1 : 0));
    const totals = { local: { runs: 0, minutes: 0, legs: 0, budget: budgets.local }, cloud: { runs: 0, minutes: 0, legs: 0, budget: budgets.cloud } };
    for (const L of out) {
        const T = totals[L.lane];
        T.runs += L.runs.length; T.legs++;
        T.minutes += L.runs.reduce((a, r) => a + (r.expMinutes != null ? r.expMinutes : r.minutes), 0) + (L.lane === 'local' ? s.budget.switchMin : 0);
    }
    // strength coverage of each focus config: fractions of the fit's 100 points (current = ran at its benchmark config,
    // pending = queued for it, projected = both + this batch)
    const coverage = [...ctx.focusSet].map((id) => {
        const m = ctx.byId.get(id), c = ctx.cov.get(id);
        return { model: id, label: m.label, queueLane: m.queueLane || null, current: c.current / 100, pending: c.pending / 100, batch: c.batch / 100,
            projected: (c.current + c.pending + c.batch) / 100, runs: out.filter((L) => L.model === id).reduce((a, L) => a + L.runs.length, 0) };
    });
    if (ctx.focusSet.size) {
        const missing = (input.focus || []).filter((id) => !ctx.byId.has(id));
        if (missing.length) notes.push(`focus: unknown config(s) ${missing.join(', ')}`);
    }
    return { legs: out, flagged: ctx.flagged, totals, ranking, notes, thetaTop: ctx.thetaTop, cascade: cascadeOut, settings: s, coverage, focus: [...ctx.focusSet], scoring: s.scoring, candidates };
}
