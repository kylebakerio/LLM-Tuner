'use strict';
// The public site's LIVE answers as files (2026-10-22). See public/STATIC-ARCHITECTURE.md.
//
// The public site is moving to Cloudflare as a static build; what it still asks the lab for -- the probe and the live
// status -- is served by public/live_server.py, a stdlib file server with no logic: GET /api/stats, /api/live and
// /api/models/running each return one file from logs/public-api/. Kyle: "tiny python server sounds fine" (it replaces
// the ~0.7 GiB node `public` process for this). So the dashboard writes those files, unprompted, every tick, already
// in their final public shape: the same transform public/server.js applies to logs/public-live.json (liveRunning +
// sanitizePayload, lib/publicdata.js), done here once.
//
//   live.json     GET /api/live: busy lanes and running batteries, each named after its model, scrubbed
//   running.json  GET /api/models/running: the running batteries' dir / task / tasks / runner / state
//   stats.json    GET /api/stats: only the static page's PROBE reads it ("is the lab up?": a numeric generatedAt).
//                 Its generatedAt is the DEPLOYED snapshot's (public/.static-deployed.json), never later, so no page --
//                 even one built before static-mode.js stopped asking the lab for data -- asks this lab for a catalog
//                 it does not serve.
//
// Staleness is the file server's call (it answers 503 when a file is older than its limit, which a page reads as
// "offline"); `stale` in live.json is what it was when written. Pure but for writeAtomic (test/publicliveapi.test.js).

const fs = require('fs');
const path = require('path');
const { liveRunning, sanitizePayload } = require('./publicdata');

const STALE_MS = 30000;   // public/server.js: a snapshot older than this is stale

/** battery dir -> its model's display name, from a Models catalog (lib/models.js listModels shape): the live page names
 *  models, not queue labels. public/server.js batteryModels() does the same over the public catalog. */
function batteryModels(cat) {
    const map = {};
    for (const m of (cat && cat.models) || []) for (const b of m.batteries || []) if (b && b.dir) map[b.dir] = m.display;
    return map;
}

/** The dashboard's raw snapshot (logs/public-live.json: { at, lanes, running, items }) -> GET /api/live's answer,
 *  exactly as public/server.js liveSnapshot() serves it. */
function liveAnswer(raw, names, now) {
    const j = raw || {};
    const items = j.items && typeof j.items === 'object' ? j.items : {};
    const running = (j.running || []).map((r) => liveRunning(r, Object.prototype.hasOwnProperty.call(items, r.dir) ? items[r.dir] : null, (names || {})[r.dir]));
    return sanitizePayload({ at: j.at || 0, lanes: j.lanes || [], running, stale: !(now - (j.at || 0) < STALE_MS) });
}

/** GET /api/live's answer -> GET /api/models/running's (public/server.js running()). */
function runningAnswer(live) {
    return { running: ((live && live.running) || []).map(({ dir, task, tasks, runner, state }) => ({ dir, task, tasks, runner, state })) };
}

/** public/.static-deployed.json (publish-static.js, after a deploy; or null) -> GET /api/stats's answer: the deployed
 *  snapshot's numbers when the deploy recorded them, and its generatedAt (0 before the first deploy: still a number,
 *  so the probe reads "up", and never later than any snapshot a page can hold). */
function statsAnswer(deployed) {
    const d = deployed && typeof deployed === 'object' ? deployed : {};
    const stats = d.stats && typeof d.stats === 'object' ? d.stats : {};
    return { ...stats, generatedAt: Number.isFinite(Number(d.generatedAt)) ? Number(d.generatedAt) : 0 };
}

/** Every file public/live_server.py serves, by name. */
function apiFiles(raw, { names = {}, deployed = null, now = Date.now() } = {}) {
    const live = liveAnswer(raw, names, now);
    return { 'live.json': live, 'running.json': runningAnswer(live), 'stats.json': statsAnswer(deployed) };
}

/** Write { name: object } into `dir`, each through a temp file in the same directory + rename: a reader never sees
 *  half a file. */
function writeAtomic(dir, files) {
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, obj] of Object.entries(files)) {
        const file = path.join(dir, name);
        const tmp = `${file}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(obj));
        fs.renameSync(tmp, file);
    }
}

module.exports = { batteryModels, liveAnswer, runningAnswer, statsAnswer, apiFiles, writeAtomic, STALE_MS };
