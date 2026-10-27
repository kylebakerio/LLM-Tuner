// The launch panel's model picker, the DOM-free half: which catalog model a gguf file is, and the
// order and numbers each launchable model is shown with. Every quality and time number comes from
// the Models overview's own fit (fitGroups / ladderPoints), and every comparison is priced with the
// ladder's own head-to-head helper (pairwiseCost), so the picker and the Quality ladder cannot
// disagree about a model. Comparisons are against the CURRENTLY SELECTED model, not ladder neighbours.

import { pairwiseCost, solvedCosts, LADDER_MIN_N, strengthRank } from '../shared/leaderboard.js';

// ---- gguf -> catalog key ---------------------------------------------------------------
// A browser copy of lib/models.js's splitGgufName() + localModel().key. test/models.test.js holds
// the two to the same answer over every real gguf name, so a change on one side fails there.
const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9.]+/g, '-').replace(/^-+|-+$/g, '');
const QUANT_RE = /[-_.](UD-)?((?:I?Q\d+(?:_[0-9A-Za-z]+)*)|(?:PTQ\d+_\d+)|(?:PQ\d+_\d+)|BF16|F16|F32)$/i;
const SPLIT_RE = /-\d{5}-of-\d{5}$/;
const FAMILY_ALIAS = { 'qwen-qwen3.6-35b-a3b': 'qwen3.6-35b-a3b', 'qwen-qwen3.8-27b': 'qwen3.8-27b' };

/** The catalog key of a local gguf (path or basename): local:<family>:<quant>. */
export function ggufModelKey(pathOrName) {
    let name = String(pathOrName || '').trim().replace(/\\/g, '/');
    if (name.includes('/')) name = name.slice(name.lastIndexOf('/') + 1);
    name = name.replace(/\.gguf$/i, '').replace(SPLIT_RE, '');
    let quant = null;
    const m = QUANT_RE.exec(name);
    if (m) { quant = m[2].toUpperCase(); name = name.slice(0, m.index); }
    let familySlug = slug(name).replace(/_/g, '-');
    if (FAMILY_ALIAS[familySlug]) familySlug = FAMILY_ALIAS[familySlug];
    return `local:${familySlug}:${slug(quant || 'unknown')}`;
}

// ---- speed -----------------------------------------------------------------------------
/**
 * Prefill and generation t/s at 32k depth, the way the Models page's Raw speed board reads them:
 * each launch config's at32k point, only with at least 3 samples there, the fastest config for
 * each column separately (they are never blended). null when nothing was measured at 32k.
 */
export function speedAt32k(m) {
    let prefill = null, gen = null;
    for (const c of ((m && m.speedConfigs) || [])) {
        const p = c.at32k;
        if (!p || (p.n || 0) < 3) continue;
        if (p.prefillTps != null && (!prefill || p.prefillTps > prefill.tps)) prefill = { tps: p.prefillTps, n: p.n };
        if (p.genTps != null && (!gen || p.genTps > gen.tps)) gen = { tps: p.genTps, n: p.n };
    }
    return prefill || gen ? { prefill, gen } : null;
}

// A record is THIN when too little backs it to trust its place: fewer scored tasks than this, or a
// 95% interval wider than this many points.
export const THIN_TASKS = 20, THIN_WIDTH = 0.4;

/**
 * The picker's rows. options: [{value (gguf path), text}] as the select holds them; points:
 * ladderPoints() over the fit (cost 'time', so costTasks are per-task walls); models: catalog.models.
 *
 * rated    launchable models with a rate (point.y: robust or difficulty-weighted, whichever the
 *          points were built with), strictly BEST FIRST by that rate (ties: the weighted rate, then
 *          the name). Each carries `width` (of its 95% interval), `thin`, and `tokenTasks` (taskId ->
 *          tokens_out over its solved tasks, for the head-to-head token comparison).
 * unrated  launchable models with no rate, alphabetical.
 * Two files of the same weights (local dir and HF cache) share one point.
 * Nothing here is relative: compareTo() prices every row against whichever model is current.
 * `rowKeyOf` (2026-10-14): the catalog row a gguf's key lands on when the points and models come from the FOLDED
 * catalog the Models page shows (leaderboard.js overviewCatalog / overviewRowKey): an f32ssm copy's file -> the
 * original file's row, so it carries that row's point. `key` stays the gguf's own key (the profile picker groups by it).
 */
export function pickerRows(options, points, models, { rowKeyOf = null } = {}) {
    const pointOf = new Map();
    for (const p of points) {
        pointOf.set(p.key, p);
        for (const g of (p._others || [])) if (g && g.m && !pointOf.has(g.m.key)) pointOf.set(g.m.key, p);
    }
    const modelOf = new Map((models || []).map((m) => [m.key, m]));
    const rows = options.map((o) => {
        const key = ggufModelKey(o.value || o.text);
        const rk = rowKeyOf ? rowKeyOf(key) : key;
        const p = pointOf.get(rk) || pointOf.get(key) || null;
        return { option: o, key, point: p && p.y != null ? p : null, model: modelOf.get(rk) || modelOf.get(key) || null };
    });
    const rated = rows.filter((r) => r.point).map((r) => {
        const width = r.point.hi != null && r.point.lo != null ? r.point.hi - r.point.lo : null;
        const tokenTasks = r.point._g ? solvedCosts(r.point._g.tasks, 'tokens_out') : (r.point.tokenTasks || null);
        return { ...r, width, tokenTasks, thin: (r.point.n || 0) < THIN_TASKS || (width != null && width > THIN_WIDTH) };
    }).sort((a, b) => (strengthRank(b.point) - strengthRank(a.point)) || (b.point.y - a.point.y)   // low end of the strength range first (2026-09-29; leaderboard.js strengthRank, 10-21)
        || String(a.option.text).localeCompare(String(b.option.text)));
    const unrated = rows.filter((r) => !r.point)
        .sort((a, b) => String(a.option.text).localeCompare(String(b.option.text), undefined, { numeric: true, sensitivity: 'base' }));
    return { rated, unrated };
}

/**
 * One cost of `row` against `cur`: head to head (pairwiseCost: geometric mean over the tasks both
 * solved) when they share at least LADDER_MIN_N solved tasks, else the ratio of the two indexes
 * (`fbA`/`fbB`, each measured on its own tasks), marked `approx`. -> {ratio, n, approx} | null.
 */
function costVs(curTasks, rowTasks, fbCur, fbRow) {
    const pw = pairwiseCost({ costTasks: curTasks }, { costTasks: rowTasks });
    if (pw.n >= LADDER_MIN_N && pw.ratio > 0) return { ratio: pw.ratio, n: pw.n, approx: false };
    if (fbCur > 0 && fbRow > 0) return { ratio: fbRow / fbCur, n: pw.n, approx: true };
    return null;
}

/**
 * How `row` compares with `cur` (both rated rows), in the current model's terms:
 *   same     the same weights as the current model (the row itself, or its other file)
 *   pts      percentage points of solve rate, row minus current, on the active rate (point.y)
 *   noise    the two 95% intervals overlap: the difference could be noise
 *   time     wall time of row ÷ current: head to head over their shared solved tasks, or the
 *            relative-solve-time index ratio when they share under LADDER_MIN_N (approx)
 *   tokens   tokens per solve, the same way (fallback: the tokens-per-solve ratio)
 * null when there is no current rated row to compare against.
 */
export function compareTo(row, cur) {
    if (!row || !row.point || !cur || !cur.point) return null;
    const a = cur.point, b = row.point;
    if (a.key === b.key) return { same: true };
    const ok = (v) => v != null && Number.isFinite(v);
    const noise = ok(a.lo) && ok(a.hi) && ok(b.lo) && ok(b.hi) && a.lo < b.hi && b.lo < a.hi;
    return {
        same: false,
        pts: (b.y - a.y) * 100,
        noise,
        time: costVs(a.costTasks, b.costTasks, a.relTime, b.relTime),
        tokens: costVs(cur.tokenTasks, row.tokenTasks, a.tokensPerSolve, b.tokensPerSolve),
    };
}
