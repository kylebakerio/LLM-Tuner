// Auto queue: the catalog (/api/models/catalog) + the planner settings -> the planner's input.
// The numbers are the dashboard's GLOBAL fit, the same one the Models overview and the model picker read
// (qualityEntries + fitGroups on FACET_DEFAULTS), so the planner cannot disagree with the ladder about who
// is ahead. What is added here: a per-task standard error (the fit only exports the point difficulty),
// the strong-attempt counts behind the validity flag, typical wall times, and the mapping from the
// settings' RUNNABLE model configs (id, catalog key, opencode id, launch command) to fitted groups.
import { FACET_DEFAULTS, fitFor, mergeTasks, relSolveTimes, foldTensorRows, foldFileVariants, promptVariant, problemOf, problemId, itemP } from '../shared/leaderboard.js';
import { withDefaults, expandFocus } from '../shared/planner.js';

const PRIOR = 1 / (1.5 * 1.5);      // the fit's own N(0, 1.5^2) prior on b
const lvlOf = (spec) => String((spec && spec.promptLevel) || 'L2').toUpperCase();
const med = (a) => { const n = a.filter((v) => Number.isFinite(v)).sort((x, y) => x - y); if (!n.length) return null; const k = n.length >> 1; return n.length % 2 ? n[k] : (n[k - 1] + n[k]) / 2; };
// for a config with no fitted group: the spread of its ability around its weights' model ability (config remainder sd 0.35
// and as much again for facets this adapter does not map), the fit's own N(0, 0.35^2) remainder prior widened
const MODEL_PRIOR_SE = Math.hypot(0.35, 0.35);

/**
 * THE PLANNER READS THE FOLDED CATALOG (2026-10-14). The Models page folds tensor-split rows (foldTensorRows) and the
 * f32ssm file copies (foldFileVariants) into their base config by default; a planner on the raw catalog counted a
 * task scored only on a tensor-split row or a copy as UNSCORED for the base config and proposed it again (Kyle: one
 * run per task per config; today: Qwen3.8-27B Q6_K_XL's 18 benchmark-config tasks, all on its two-XTX tensor-split row).
 * plannerCatalog() applies the same folds in the same order (tensor first, so a tensor-split copy reaches its copy
 * row), following the Models page's switches: `tensorRows` 'combine' | 'separate', `fileQuality` 'merge' | 'separate'
 * (both fold by default). The folds are memoised per catalog object, so the fit cache keeps holding.
 */
export function plannerCatalog(raw, { tensorRows = 'combine', fileQuality = 'merge' } = {}) {
    const t = tensorRows === 'separate' ? raw : foldTensorRows(raw);
    return fileQuality === 'separate' ? t : foldFileVariants(t);
}
/** The catalog row a runnable config's `catalogKey` lands on in a (possibly) folded catalog: a tensor-split key -> its
 *  base row, an f32ssm copy -> the original file's row, and an original file whose row is a renamed copy (no run on
 *  the original yet) -> that copy's row. A key the folds did not touch is returned as it is. */
export function rowKey(catalog, key) {
    let k = key;
    if (catalog && catalog.tensorFolded && catalog.tensorFolded[k]) k = catalog.tensorFolded[k];
    if (catalog && catalog.fileFolded && catalog.fileFolded[k]) k = catalog.fileFolded[k];
    if (catalog && catalog.fileRenamed && catalog.fileRenamed[k]) k = catalog.fileRenamed[k];
    return k;
}

/** Does a fitted quality group belong to this runnable model config? The row, and (2026-10-15) the HARNESS the config
 *  runs under: its runner (opencode unless it says), the plain prompt (no variant) and agentic mode. A row's
 *  review-prompt, careful-tone or plan groups are other configs of the same weights: counting their runs as this
 *  config's put their tasks down as "already ran" here (Kyle: "Why would a different q blend with this one?").
 *  The prompt LEVEL is no longer a group's (2026-10-17): see levelTasks. */
export function groupMatches(g, spec) {
    if (g.m.key !== spec.catalogKey) return false;
    const c = g.c || {};
    const wantRunner = spec.runner || (spec.lane === 'cloud' ? 'claude' : 'opencode');
    if ((c.runner || 'opencode') !== wantRunner) return false;
    // a prompt VARIANT (review, careful-tone, plan ...) is another config; the prompt LEVEL is not (2026-10-17): an L2 and an
    // L3 config of one row share its groups, and each reads only its own level's problems from them (levelTasks)
    if (promptVariant(c.prompt_level)) return false;
    if ((c.harness_mode || 'agentic') !== 'agentic') return false;
    const rm = String(g.c.runnerModel || '');
    const mt = spec.match || {};
    if (mt.runnerModelIncludes && !rm.includes(mt.runnerModelIncludes)) return false;
    if (mt.runnerModelExcludes && rm.includes(mt.runnerModelExcludes)) return false;
    return true;
}

/**
 * PROMPT LEVELS ARE PROBLEMS (2026-10-17): a group's task map holds T (its L2 runs) and `T@L3` (its L3 runs) as two
 * problems. A config at level `level` (spec.promptLevel; L2 unless it says) runs the suite's TASKS at that level, so its
 * record is the problems at its level, keyed back to their task ids: the planner's candidates, `allowedTasks`, `pending`
 * and the queue all speak task ids. An L2 run of T never covers T at L3, nor the other way round.
 * -> { [taskId]: entry } (bonus problems keep their `+bonus`), and `problem` (taskId -> its problem id) for the points.
 */
export function levelTasks(tasks, level) {
    const lvl = String(level || 'L2').toUpperCase();
    const out = {}, problem = {};
    for (const [id, r] of Object.entries(tasks || {})) {
        const p = problemOf(id);
        if (p.level !== lvl) continue;
        out[p.task] = r; problem[p.task] = id;
    }
    return { tasks: out, problem };
}

/**
 * derive(catalog, settings, availability) -> {input: {models, tasks, focus}, fit, groupsOf, lead}
 *   catalog: plannerCatalog(raw catalog) -- the folded one, as the Models page shows it
 *   availability: {modelId: {ok, reason}} from the server (weights on disk, launch command present)
 *   pending: {modelId: [task]} runs a running or waiting queue will make (server pendingRuns): never re-proposed
 *   promptTasks: {L3: [task ids with a prompt-L3.md]} from the server: a config at that level can only run those
 * The focus list (settings.focus) is expanded here (expandFocus: an L3 focus entry is its own config `<id>.L3`), so
 * input.models carries those configs and input.focus their ids. Each model also gets `queueLane` (the queue lane its rows
 * go to), `coverage` (the share of the fit's 100 strength points it ran at its benchmark config: Σ taskPoints over cfg)
 * and `fitCoverage` (the fit's own number for its planning group); each task its `points`.
 */
export function derive(catalog, settingsIn, availability = {}, pending = {}, promptTasks = {}) {
    const s = withDefaults(settingsIn);
    const ex = expandFocus((settingsIn && settingsIn.models) || [], (settingsIn && settingsIn.focus) || []);
    const specs = ex.models;
    const fit = fitFor(catalog.models, FACET_DEFAULTS.quality, FACET_DEFAULTS.full);   // cached per catalog object (2026-10-06)
    const adj = fit.adj;
    // THE FIT'S OWN ABILITY (2026-10-18). Until today this was logit(a.rate), and a.rate is the STRENGTH (expected score on
    // the whole corpus, 0-1), not an ability: 27B UD-Q4_K_XL read 0.66 against its fitted 1.93, and with b centred on meanB
    // (-0.74) and no discrimination the planner put p ~ 0.55 on tasks the fit gives 0.95+ -- the "most informative" tasks it
    // chased were easy ones. Now: theta = the group's fitted ability (model + its facet effects + remainder) - meanB, on the
    // same centred scale as taskDifficulty, and p = sigmoid(a_t (theta - b_t)) is the leaderboard's own P(solve).
    const meanB = adj.meanB || 0;
    const aOf = (tid) => { const v = adj.taskDiscrimination && adj.taskDiscrimination.get(tid); return v > 0 ? v : 1; };
    const thetaOf = (g) => { const a = adj.get(g.key); return a && Number.isFinite(a.theta) ? a.theta - meanB : null; };
    const rel = relSolveTimes(fit.qAll);
    const relOf = (g) => { const r = rel.get(g.key); return r && r.index != null ? r.index : null; };

    // ---- tasks: difficulty, its SE, strong attempts, typical walls
    const lead = Math.max(...fit.qAll.filter((g) => (adj.get(g.key) || {}).n >= 10).map(thetaOf).filter((x) => x != null));
    const strongGap = s.validity.strongGap;
    const acc = new Map();
    const T = (id) => acc.get(id) || acc.set(id, { info: 0, nStrong: 0, strongPasses: 0, attempts: 0, passes: 0, solve: [], fail: [] }).get(id);
    for (const g of fit.qAll) {
        const th = thetaOf(g); if (th == null) continue;
        const a = adj.get(g.key);
        const strong = th >= lead - strongGap && a.n >= 5;
        const ri = relOf(g) || 1;
        for (const [tid, r] of Object.entries(g.tasks)) {
            if (!r || r.excluded || !(r.attempts > 0)) continue;
            const b = adj.taskDifficulty.get(tid); if (b == null) continue;
            const at = aOf(tid), p = itemP(at, b, th);
            const x = T(tid);
            x.info += r.attempts * at * at * p * (1 - p);
            x.attempts += r.attempts; x.passes += r.passes || 0;
            if (strong) { x.nStrong += r.attempts; x.strongPasses += r.passes || 0; }
            if (r.wall_s > 0) (r.solved ? x.solve : x.fail).push(r.wall_s / ri / 60);
        }
    }
    // a bonus test (`<id>+bonus`, 2026-10-14) is a result of its parent's run, never a task to queue
    // ... and a diagnostic task (category `diagnostic`, 2026-10-17) is a functional check, never a candidate --
    // the server already leaves it out of allTaskIds; this holds for an older catalog too
    const meta = catalog.taskMeta || {};
    // ... nor a level problem (`T@L3`): a config's candidates are the suite's tasks, run at its own level (levelTasks)
    const ids = (catalog.allTaskIds || [...adj.taskDifficulty.keys()]).filter((id) => !/\+bonus$/.test(id) && !(meta[id] && meta[id].diagnostic) && problemOf(id).level === 'L2');
    const tasks = ids.map((id) => {
        const b = adj.taskDifficulty.get(id);
        const x = acc.get(id);
        const capMin = ((meta[id] && meta[id].timeout_s) || 7200) / 60;
        return { id, b: b != null ? b : null, a: b != null ? aOf(id) : 1, se: x ? 1 / Math.sqrt(x.info + PRIOR) : null, tried: b != null,
            // a task's strength points INCLUDE its bonus test's (`<id>+bonus` is scored from the same run): what running it adds to coverage
            points: ((adj.taskPoints && adj.taskPoints.get(id)) || 0) + ((adj.taskPoints && adj.taskPoints.get(`${id}+bonus`)) || 0),
            nStrong: x ? x.nStrong : 0, strongPasses: x ? x.strongPasses : 0, attempts: x ? x.attempts : 0, passes: x ? x.passes : 0,
            solveMin: x ? med(x.solve) : null, failMin: x ? med(x.fail) : null, capMin,
            repo: meta[id] && meta[id].repo, tier: meta[id] && meta[id].tier };
    });

    // ---- prompt-level problems (only once the fit scores `T@L3` as its own problem: the staged prompt-level change)
    // A config at level L meets `T@L` where the fit has it. Where the fit has other level-L problems but not this one, it
    // meets T's difficulty shifted by the median (b(T@L) - b(T)) over the tasks that have both (at least 3; L3 vs L2 fitted
    // +1.04 on 2026-10-17), with a = 1 and the shift's spread added to the se: a level problem nobody ran is not the easier
    // L2 task. Without any level-L problem in the fit (the live fit: the level is a config facet) there are no items.
    const levelCache = new Map();
    const levelItems = (lvl) => {
        if (lvl === 'L2') return {};
        if (levelCache.has(lvl)) return levelCache.get(lvl);
        const out = {}, diffs = [];
        for (const t of tasks) {
            const pid = `${t.id}@${lvl}`, bb = adj.taskDifficulty.get(pid);
            if (bb == null) continue;
            out[t.id] = { b: bb, a: aOf(pid) };
            if (t.b != null) diffs.push(bb - t.b);
        }
        if (diffs.length >= 3) {
            const shift = med(diffs), sd = Math.sqrt(diffs.reduce((a2, d) => a2 + (d - shift) ** 2, 0) / (diffs.length - 1));
            for (const t of tasks) if (!out[t.id] && t.b != null) out[t.id] = { b: t.b + shift, a: 1, se: Math.hypot(t.se || 0, sd), shifted: shift };
        }
        levelCache.set(lvl, out);
        return out;
    };

    // ---- runnable model configs -> fitted groups
    const groupsOf = new Map();
    const models = specs.map((spec) => {
        const G = fit.qAll.filter((g) => groupMatches(g, { ...spec, catalogKey: rowKey(catalog, spec.catalogKey) }));
        // "at its benchmark config" follows cascade.py: same context (when the spec names one) and the 2 h cap
        const cfgG = G.filter((g) => (spec.nCtx ? g.c.n_ctx === spec.nCtx : true) && Number(g.c.timeout_s) === 7200);
        const byScored = (list) => list.slice().sort((a, b) => (b.q.scored - a.q.scored)
            || (Math.max(0, ...Object.values(b.tasks).map((t) => t.ran_at || 0)) - Math.max(0, ...Object.values(a.tasks).map((t) => t.ran_at || 0))));
        const pg = byScored(cfgG.filter((g) => adj.get(g.key)))[0] || byScored(G.filter((g) => adj.get(g.key)))[0] || null;
        groupsOf.set(spec.id, { all: G, cfg: cfgG, planning: pg });
        // this config's own level's problems only, keyed by task id (levelTasks): an L2 config's record is T, an L3 one's T@L3
        const lvl = String(spec.promptLevel || 'L2').toUpperCase();
        const own = (t) => levelTasks(t, lvl).tasks;
        const hist = {};
        for (const [tid, r] of Object.entries(G.length ? own(mergeTasks(G.map((g) => g.tasks))) : {}))
            if (r && !r.excluded && r.attempts > 0) hist[tid] = { attempts: r.attempts, passes: r.passes || 0 };
        const cfg = {};
        for (const [tid, r] of Object.entries(cfgG.length ? own(mergeTasks(cfgG.map((g) => g.tasks))) : {}))
            if (r && !r.excluded && r.attempts > 0) cfg[tid] = { ran: true, passed: (r.passes || 0) > 0 };
        // a run under a LONGER cap that finished (not TIMEOUT) inside 2 h counts as a 2 h-cap run (Kyle 2026-09-24; the queue's
        // identity guard, lib/configid scoredIndex, counts it the same way): without this the planner proposed composites the
        // guard then dropped (27B Q8_K_XL / Q2_K_XL / Flash-Next GSQ-RCO IQ3_XXS, 2026-10-15)
        for (const g of G) {
            if (!(Number(g.c.timeout_s) > 7200) || (spec.nCtx && g.c.n_ctx !== spec.nCtx)) continue;
            for (const [tid, r] of Object.entries(own(g.tasks)))
                if (r && !r.excluded && r.attempts > 0 && !cfg[tid] && r.status !== 'TIMEOUT' && r.wall_s > 0 && r.wall_s <= 7200) cfg[tid] = { ran: true, passed: (r.passes || 0) > 0 };
        }
        // UNFINISHED at its config (2026-10-19, Kyle): a run that stopped to ask the user, whose saved session waits for a
        // CONTINUATION, covers its task (it is not proposed fresh); a pruned or unrebuildable session leaves the task free.
        // `unfinished` sits beside a group's `tasks` (lib/models.js unfinishedMap): it is in no count.
        const pendingContinuation = [];
        for (const g of cfgG) for (const [tid, u] of Object.entries(own(g.unfinished || {})))
            if (u && !cfg[tid] && (u.saved || 0) + (u.unknown || 0) > 0) { cfg[tid] = { ran: true, passed: false, pendingContinuation: true }; pendingContinuation.push(tid); }
        const a = pg ? adj.get(pg.key) : null;
        // no fitted group yet: start from the fit's ability of its WEIGHTS (adj.models, the model at the baseline settings;
        // its own facets are not mapped here), else the population's (abilityPrior), on the same centred scale
        let prior = null;
        if (!a) {
            const row = (catalog.models || []).find((x) => x && x.key === rowKey(catalog, spec.catalogKey));
            const mm = row && adj.models && adj.models.get(row.weightsKey || row.key);
            const ap = adj.abilityPrior || { mu: 0, tau: 1.5 };
            prior = mm && Number.isFinite(mm.theta) ? { theta: mm.theta - meanB, se: MODEL_PRIOR_SE, source: 'model' }
                : { theta: ap.mu - meanB, se: ap.tau, source: 'population' };
        }
        // an L3 (L1) config meets the `T@L3` PROBLEM where the fit has one (the staged prompt-level change scores levels as
        // problems); without one it meets the task's own difficulty, and its prompt facet carries the level (live fit)
        const items = levelItems(lvlOf(spec));
        const av = availability[spec.id] || availability[spec.focusOf] || {};
        const lane = spec.lane || (spec.runner === 'claude' ? 'cloud' : 'local');
        // the points of the PROBLEMS it ran (an L3 config's `T@L3`), the bonus test's with them as everywhere
        let covPts = 0; for (const t of Object.keys(cfg)) covPts += (adj.taskPoints && adj.taskPoints.get(problemId(t, lvl))) || 0;
        const lvlTag = lvl !== 'L2' ? lvl : null;
        return {
            id: spec.id, label: spec.label || spec.id, role: spec.role || 'ignored', lane,
            queueLane: lane === 'cloud' ? 'cloud' : (spec.queueLane || 'local-gpu'), promptLevel: spec.promptLevel || 'L2',
            allowedTasks: lvlTag && Array.isArray(promptTasks[lvlTag]) ? promptTasks[lvlTag] : null,
            coverage: covPts / 100, fitCoverage: a && a.coverage != null ? a.coverage : null,
            family: spec.family || null, priorShift: Number(spec.priorShift) || 0,
            fitted: !!a, theta: a ? a.theta - meanB : prior.theta, se: a ? a.se : prior.se, n: a ? a.n : 0,
            ...(prior ? { priorTheta: prior.theta, priorSe: prior.se, priorSource: prior.source } : {}),
            ...(Object.keys(items).length ? { items } : {}), strength: a && a.strength != null ? a.strength : null,
            relTime: (pg && relOf(pg)) || Number(spec.relTimeGuess) || null,
            available: av.ok !== false, unavailableReason: av.reason || null,
            hist, cfg, planningDirs: pg ? pg.dirs : [], pending: pending[spec.id] || [], pendingContinuation,
        };
    });
    // a model with no timing inherits its family's mean relative time
    for (const m of models) if (!(m.relTime > 0)) {
        const sib = models.filter((x) => x.family && x.family === m.family && x.relTime > 0);
        m.relTime = sib.length ? sib.reduce((a2, x) => a2 + x.relTime, 0) / sib.length : 1;
    }
    return { input: { models, tasks, focus: ex.focus }, fit, groupsOf, lead, meanB };
}

/**
 * Task selectors a pin may use instead of an explicit list:
 *   @discriminating  tasks the local models split on at their benchmark configs (>= 1 pass and >= 1 fail)
 *   @cascade-bottom  tasks every local model that ran them failed (>= 2 ran it, none passed)
 *   @unsolved        tasks nobody has solved, any model, any config
 *   @untried         tasks with no scored run at all
 */
export function resolveTasks(list, input) {
    const out = [];
    // every non-ignored local model with a record at its benchmark config: the cascade's own view of who split
    const contenders = input.models.filter((m) => m.role !== 'ignored' && m.fitted && m.lane !== 'cloud' && Object.keys(m.cfg).length);
    for (const x of list || []) {
        if (!String(x).startsWith('@')) { out.push(x); continue; }
        for (const t of input.tasks) {
            const ran = contenders.filter((m) => m.cfg[t.id]);
            const pass = ran.filter((m) => m.cfg[t.id].passed).length;
            const ok = x === '@discriminating' ? (pass > 0 && pass < ran.length)
                : x === '@cascade-bottom' ? (ran.length >= 2 && pass === 0)
                : x === '@unsolved' ? (t.tried && !(t.passes > 0))
                : x === '@untried' ? !t.tried : false;
            if (ok) out.push(t.id);
        }
    }
    return [...new Set(out)];
}
