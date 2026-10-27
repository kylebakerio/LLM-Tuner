'use strict';
// LIVE ODDS (Kyle, 2026-10-24: "the live view should show the problem difficulty of the problem being worked on, and a
// predicted odds of success, and should also show those numbers in columns next to the status column for the task list").
//
// Everything comes from the ONE fit: ui/shared/leaderboard.js fitFor over the Models page's default view, built the way
// lib/autoqueue.js planFloor builds it. Per problem: its /100 difficulty (taskDifficulty100: the strength at which a
// config has a 50/50 chance on it), its band word and its strength points; and the chance THIS battery's config passes it,
// P(solve) = sigmoid(a * (theta - b)), at the ability of the Models-page row the config is filed under. That row is found
// by battery dirs, as the floor planner finds a template's row (autoqueue floorGroup): the battery's own dir plus every dir
// its queue item's config identity has a scored run in (queue draftDirs, at L2 and L3), so a fresh battery of a known
// config has its config's odds before its own first result lands. A config with no scored run anywhere has no row yet:
// its odds are null (the difficulty and points still show).
const AQ = require('./autoqueue');

let memo = { etag: null, fit: null };            // the fit, rebuilt only when the catalog changes (a new result lands)
let dirMemo = { key: null, dirs: null };        // the config's dirs, per (queue item, catalog)

function fitOf(catalog, etag, L) {
    if (memo.fit && etag != null && memo.etag === etag) return memo.fit;
    const v = L.overviewView({ store: { getItem: () => null } });
    const shown = L.overviewCatalog(catalog, v);
    const fit = L.fitFor(shown.models, v.keepQ, v.keepT);
    memo = { etag, fit };
    return fit;
}

/** The problem id of a battery task at a prompt level: `<task>@L3` off the default L2 prompt (leaderboard.js problemOf
 *  read the other way); a repeat's result-file suffix (`__r2`) is not part of it. */
function problemId(task, level) {
    const t = String(task).replace(/__r\d+$/, '');
    const l = String(level || '').split('+')[0].trim().toUpperCase();
    return /^L\d+$/.test(l) && l !== 'L2' ? `${t}@${l}` : t;
}

/** The fields draftDirs takes, from a queue item (lib/queue get / a raw row). */
function fieldsOf(item) {
    let env = item.env && typeof item.env === 'object' ? item.env : null;
    if (!env) { try { env = JSON.parse(item.env_json || '{}') || {}; } catch { env = {}; } }
    return { lane: item.lane, runner: item.runner || 'opencode', model: item.model, launch_cmd: item.launch_cmd, timeout_s: Number(item.timeout_s) || 7200, env };
}

function configDirs(battery, item, queue, etag) {
    const dirs = new Set(battery ? [battery] : []);
    if (!item || !queue || typeof queue.draftDirs !== 'function') return dirs;
    const key = `${item.id}|${etag}`;
    if (dirMemo.key !== key) {
        const found = new Set();
        try {
            const f = fieldsOf(item);
            for (const level of ['L2', 'L3']) for (const d of queue.draftDirs({ ...f, env: AQ.floorEnv(f.env, { level }) })) found.add(d);
        } catch { /* identity unknown: the battery's own dir only */ }
        dirMemo = { key, dirs: found };
    }
    for (const d of dirMemo.dirs) dirs.add(d);
    return dirs;
}

/**
 * ({battery, tasks, level}, deps) -> { row: {label, strength, lo, hi, n, coverage} | null, why, tasks: {task: {problem,
 * difficulty, band, points, p}} }. deps: { catalog (raw), etag, L (leaderboard module), queue (lib/queue), item (the
 * battery's queue item, or null) }. difficulty / points null: the problem is not in the fit (nobody scored it, or a
 * diagnostic task); p null: no row for the config yet.
 */
function liveOdds({ battery, tasks, level }, deps) {
    const fit = fitOf(deps.catalog, deps.etag, deps.L);
    const A = fit.adj;
    // the battery's own dir first; only a battery with no scored result yet asks the config identity (queue draftDirs: its
    // first call builds the identity index, ~9 s on 10-24, so it is never asked when the battery already has a row)
    const g = (battery && AQ.floorGroup(fit, new Set([battery]))) || AQ.floorGroup(fit, configDirs(battery, deps.item, deps.queue, deps.etag));
    const a = g ? A.get(g.key) : null;
    const theta = a && a.theta != null ? a.theta : null;
    const out = {
        at: new Date().toISOString(),
        row: a ? { label: g.label || (g.m && g.m.display) || g.key, strength: a.strength, lo: a.lo * 100, hi: a.hi * 100, n: a.n, coverage: a.coverage } : null,
        why: a ? null : 'no Models-page row has a scored run of this config yet',
        tasks: {},
    };
    for (const t of tasks || []) {
        const pid = problemId(t, level);
        const d = A.taskDifficulty.get(pid);
        if (d == null) { out.tasks[t] = { problem: pid, difficulty: null, band: null, points: null, p: null }; continue; }
        const d100 = A.taskDifficulty100 ? A.taskDifficulty100.get(pid) : null;
        out.tasks[t] = {
            problem: pid,
            difficulty: d100 != null ? d100 : null,
            band: d100 != null ? deps.L.difficultyBand(d100).word : null,
            points: A.taskPoints && A.taskPoints.has(pid) ? A.taskPoints.get(pid) : null,
            p: theta != null ? deps.L.pSolve(A, theta, pid) : null,   // the one P(solve) (leaderboard.js pSolve -> itemP)
        };
    }
    return out;
}

module.exports = { liveOdds, problemId, fieldsOf };
