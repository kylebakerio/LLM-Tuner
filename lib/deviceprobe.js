'use strict';
// --- WHEN A DEVICE PROBE MAY RUN, AND WHAT IS SERVED WHEN IT MAY NOT (2026-10-13) ---
// `llama-server --list-devices` (and `--help`: llama.cpp loads every backend before it prints usage) initialises
// CUDA / ROCm / Vulkan on every card. On 2026-10-12 that stalled a two-card engine mid-decode three times out of
// three ("pipelined decode: verify: timed out at layer 35"), and until this file GET /api/devices ran a probe on
// EVERY call -- the launcher page, a build change, dash-cli's editor -- and so did any reader that met a binary the
// cache had not seen (every telemetry tick, for a build whose boot probe had timed out).
//
// The rule, in one place (2026-10-17: see lib/gpusafety.js):
//   never          while `hardBusy()` says the queue has work on this machine's cards -- not on an explicit refresh
//                  either ("probe now" is refused, with the reason), and not at boot: server4.js runs no boot probe
//   a probe runs   on an explicit refresh (GET /api/devices?refresh=1), or when nothing is on a local card (`busy()`)
//   otherwise      the cached listing is served, with its age
//   a failed probe never replaces or hides a good earlier listing: the last good one is served, marked cached
//   no listing     (never probed, or never successfully): the fullest listing another build has, marked `borrowed`
//                  -- the same cards, but ids this build may not have -- or nothing, with the reason
//
//   busyReason({ ownServer, pending, bench, external, runningItems, gpus })  -> string | null   (pure)
//   createDeviceCache({ probe, busy, hardBusy, now })
//     .get(binary)        last good listing or null. Never probes. (an array, as the old Map held)
//     .fullest()          the cached listing with the most devices, or null
//     .listings()         every good listing (for callers that used to iterate the Map's values)
//     .info(binary)       { at, error, errorAt } of that binary's listing
//     .request(binary, { refresh, boot }) -> Promise<{ devices, cached, cachedAt, ageMs, probed, borrowed, from, note, error, refused }>
//                         `refresh` / `boot` skip `busy()`, never `hardBusy()`; `refused` = a refresh that hardBusy turned down
//     .snapshot() / .seed(snapshot)   the good listings with their times, to keep across a restart: a restart with
//                         something on the cards then needs no probe at all (server4.js initServer)
//     .touch(binary)      what a synchronous reader calls for a binary it has no listing of: a probe if the rule
//                         allows one now (in the background, one at a time per binary, and not within 5 minutes
//                         of a failed one), else nothing
//
// No I/O of its own: `probe(binary)` is the caller's (server4.js runs the binary). Tested in test/deviceprobe.test.js.

// A card "has something on it" past these: a desktop session holds a few hundred MiB and idles at a few percent.
const BUSY_VRAM_MIB = 3000;
const BUSY_UTIL_PCT = 30;
const TOUCH_RETRY_MS = 5 * 60 * 1000;

/**
 * Why a probe should not run now, or null when the local cards are free.
 * runningItems: running queue items ({ id, lane, label }); only `local*` lanes are this machine (lib/launchguard.js).
 * gpus: the latest telemetry readings ({ label?, name?, vram_used (MiB), gpu_util (%) }) -- this is what sees work
 * the dashboard did not start (a sweep script, another tool).
 */
function busyReason({ ownServer = false, pending = false, bench = false, external = null, runningItems = [], gpus = [] } = {}) {
    if (ownServer) return 'a model launched from this dashboard is loaded';
    if (pending) return 'a launch is in progress';
    if (bench) return 'a benchmark run is in progress';
    const local = (runningItems || []).filter((it) => it && /^local\b/.test(String(it.lane || '')));
    if (local.length) return `queue item ${local.map((it) => it.id).join(', ')} is running on ${local.length > 1 ? 'local lanes' : 'lane ' + local[0].lane}`;
    if (external) return `another server is running on port ${external.port || '?'}`;
    for (const g of gpus || []) {
        if (!g || g.error) continue;
        const vram = Number(g.vram_used) || 0, util = Number(g.gpu_util) || 0;
        const name = g.label || g.name || 'a card';
        if (vram >= BUSY_VRAM_MIB) return `${name} holds ${(vram / 1024).toFixed(1)} GB`;
        if (util >= BUSY_UTIL_PCT) return `${name} is at ${Math.round(util)}%`;
    }
    return null;
}

const reasonOf = (err) => ((err && (err.killed || err.signal)) ? 'timed out' : ((err && err.message) || 'failed'));

function createDeviceCache({ probe, busy = () => null, hardBusy = () => null, now = () => Date.now(), onChange = null } = {}) {
    if (typeof probe !== 'function') throw new Error('createDeviceCache needs a probe(binary) function');
    const good = new Map();      // binary -> devices[] (the last listing that answered)
    const meta = new Map();      // binary -> { at, error, errorAt }
    const inFlight = new Map();  // binary -> Promise (one probe per binary at a time)

    const get = (binary) => good.get(binary) || null;
    const info = (binary) => meta.get(binary) || { at: null, error: null, errorAt: null };
    const listings = () => [...good.values()];
    function fullestEntry(except) {
        let best = null;
        for (const [bin, list] of good) if (bin !== except && list && list.length > ((best && best[1].length) || 0)) best = [bin, list];
        return best;
    }
    const fullest = () => { const e = fullestEntry(null); return e ? e[1] : null; };

    function run(binary) {
        if (inFlight.has(binary)) return inFlight.get(binary);
        const p = Promise.resolve().then(() => probe(binary)).then((devices) => {
            const list = Array.isArray(devices) ? devices : [];
            good.set(binary, list);
            meta.set(binary, { at: now(), error: null, errorAt: null });
            if (onChange) { try { onChange(snapshot()); } catch { /* keeping it is best-effort */ } }
            return { ok: true };
        }, (err) => {
            meta.set(binary, { ...info(binary), error: reasonOf(err), errorAt: now() });
            return { ok: false, error: reasonOf(err) };
        }).finally(() => inFlight.delete(binary));
        inFlight.set(binary, p);
        return p;
    }

    // What is served for `binary` right now, without probing.
    function served(binary, { probed, error = null, why = null }) {
        const own = good.get(binary);
        const at = info(binary).at;
        if (own) {
            const cached = !probed || !!error;
            const note = error ? `the probe ${error}; showing this build's device list from ${ageText(now() - at)} ago`
                : !probed ? `not re-probed (${why}); device list from ${ageText(now() - at)} ago` : null;
            return { devices: own, cached, cachedAt: at, ageMs: now() - at, probed, borrowed: false, from: null, note, error };
        }
        const other = fullestEntry(binary);
        const lead = error ? `the probe ${error}` : `not probed (${why})`;
        if (other && other[1].length) {
            const oat = info(other[0]).at;
            return { devices: other[1], cached: true, cachedAt: oat, ageMs: now() - oat, probed, borrowed: true, from: other[0],
                note: `${lead}; this build has no device list of its own yet, so the cards are shown as another build lists them -- an id this build lacks will fail at launch`,
                error: error || null };
        }
        return { devices: [], cached: false, cachedAt: null, ageMs: null, probed, borrowed: false, from: null,
            note: error ? null : `${lead}; no build has a device list yet`, error: error || `not probed: ${why}` };
    }

    async function request(binary, { refresh = false, boot = false } = {}) {
        const hard = hardBusy();
        if (hard) return { ...served(binary, { probed: false, why: hard }), refused: !!(refresh || boot) };
        const why = refresh || boot ? null : busy();
        if (why) return served(binary, { probed: false, why });
        const r = await run(binary);
        return served(binary, { probed: true, error: r.ok ? null : r.error });
    }

    function touch(binary) {
        if (!binary || good.has(binary) || inFlight.has(binary)) return false;
        // a binary whose probe just failed is not probed again by every reader that passes (a telemetry tick is one)
        const failedAt = info(binary).errorAt;
        if (failedAt && now() - failedAt < TOUCH_RETRY_MS) return false;
        if (hardBusy() || busy()) return false;
        run(binary);
        return true;
    }

    /** { <binary>: { at, devices } } of every good listing. */
    function snapshot() {
        const out = {};
        for (const [bin, list] of good) out[bin] = { at: info(bin).at, devices: list };
        return out;
    }
    /** Take listings kept from an earlier run. A binary that already has a listing keeps its own. -> how many were taken */
    function seed(snap) {
        let n = 0;
        for (const [bin, rec] of Object.entries(snap && typeof snap === 'object' ? snap : {})) {
            if (good.has(bin) || !rec || !Array.isArray(rec.devices) || !Number.isFinite(Number(rec.at))) continue;
            const list = rec.devices.filter((d) => d && typeof d.id === 'string' && typeof d.description === 'string');
            if (list.length !== rec.devices.length) continue;   // not a listing this code wrote: probe instead
            good.set(bin, list); meta.set(bin, { at: Number(rec.at), error: null, errorAt: null }); n++;
        }
        return n;
    }

    return { get, info, listings, fullest, request, touch, snapshot, seed, get size() { return good.size; } };
}

/** "40 s", "12 min", "3 h" -- for the note beside a cached listing. */
function ageText(ms) {
    const s = Math.max(0, Math.round((Number(ms) || 0) / 1000));
    if (s < 90) return `${s} s`;
    if (s < 5400) return `${Math.round(s / 60)} min`;
    return `${Math.round(s / 3600)} h`;
}

module.exports = { createDeviceCache, busyReason, ageText, BUSY_VRAM_MIB, BUSY_UTIL_PCT, TOUCH_RETRY_MS };
