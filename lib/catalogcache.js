'use strict';
// The Models catalog as a PREBUILT answer (2026-10-06, Kyle: "it still seems unnecessary and surprising that the
// models page is a relatively heavy load"). GET /api/models/catalog used to run listModels() and stringify and
// compress 1.7 MB on every request, inside the dashboard's one event loop. Now the server keeps the last answer
// -- the JSON bytes, their brotli and gzip forms, and an ETag -- and each request only asks a cheap signature
// (lib/models.js catalogSignature, ~15 ms) whether that answer is still the truth.
//
// NEVER BUILT INSIDE A REQUEST once there is an answer (2026-10-21, Kyle: "trying to load #models on lab.kylebaker.io
// is just stuck loading forever"; lab.* was this dashboard until 2026-10-22, it is ai.* now). The build had grown to
// 4-16 s (5.4 MB of JSON; the request table re-read whenever a lane logged a request, i.e. every minute while the
// lanes run), and it ran inside the request on the server's one thread, so the catalog AND every other request behind
// it waited: a cold Models open measured 38 s, /api/models/running 14 s, /api/lanes/live 30 s. Now:
//
//   no answer yet (just started)           -> built, and the request waits for it (the only wait there is)
//   a result landed / an input file changed -> the kept bytes now; rebuilt in the background at once
//   only requests were logged              -> the kept bytes; rebuilt in the background once they are SOFT_MS old
//   nothing the signature sees, MAX_AGE_MS -> the kept bytes; rebuilt in the background (task.yaml edits and model
//                                             files on disk are not in the signature)
//
// The server also calls tick() every few seconds (server4.js), so a result that lands is rebuilt in without anyone
// asking: the page's own look 15 s after a test ends (ui/models/index.js liveCatalog) finds it in. With `buildPacked`
// (lib/catalogworker.js) the build runs on a worker thread, so a rebuild no longer stalls the server at all; if the
// worker fails, `build` runs here as before.
//
// The ETag is a hash of the answer WITHOUT generatedAt, so a rebuild that changed nothing keeps its ETag and the
// browser keeps its page. Pure but for zlib: the signature, the build and the clock are passed in (test/catalogcache.test.js).

const crypto = require('crypto');
const zlib = require('zlib');
const { promisify } = require('util');

const SOFT_MS = 60 * 1000;
const MAX_AGE_MS = 5 * 60 * 1000;

/** What a request (or the timer) gets: 'build' (no answer yet: build and wait), 'serve', or 'serve+refresh' (serve the
 *  kept answer, rebuild in the background). */
function decide(entry, sig, now, { softMs = SOFT_MS, maxAgeMs = MAX_AGE_MS } = {}) {
    if (!entry) return 'build';
    if (entry.sig.inputs !== sig.inputs) return 'serve+refresh';
    const age = now - entry.builtAt;
    if (entry.sig.requests !== sig.requests) return age < softMs ? 'serve' : 'serve+refresh';
    return age < maxAgeMs ? 'serve' : 'serve+refresh';
}

/** The answer's bytes and its ETag. generatedAt is appended after hashing, so it never moves the ETag. */
function pack(obj) {
    const { generatedAt, ...rest } = obj || {};
    const core = JSON.stringify(rest);
    const etag = `"${crypto.createHash('sha1').update(core).digest('hex').slice(0, 20)}"`;
    const stamp = `"generatedAt":${JSON.stringify(generatedAt ?? null)}`;
    return { body: Buffer.from(core === '{}' ? `{${stamp}}` : `${core.slice(0, -1)},${stamp}}`), etag };
}

/** Does the request's If-None-Match name this ETag? (a list, `*`, and weak validators all count) */
function etagMatches(header, etag) {
    if (!header || !etag) return false;
    return String(header).split(',').map((s) => s.trim().replace(/^W\//, '')).some((t) => t === '*' || t === etag);
}

const brotli = promisify(zlib.brotliCompress), gzip = promisify(zlib.gzip);
// Compressed once per build, not per request, so it can afford a higher quality than the per-request helper's 4.
const compress = async (body) => {
    const [br, gz] = await Promise.all([
        brotli(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 6, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length } }),
        gzip(body, { level: 6 }),
    ]);
    return { br, gzip: gz };
};
/** pack() + compress(): every form of the answer, wherever it is built (here, or lib/catalogworker.js). */
async function packAll(obj) {
    const p = pack(obj);
    return { ...p, ...(await compress(p.body)) };
}

/**
 * build(): the catalog object (may be async). buildPacked() (optional): the packed answer { body, br, gzip, etag },
 * built elsewhere (a worker thread); when it throws, build() runs instead. signature(): { inputs, requests }, cheap.
 * get() -> { entry: { body, br, gzip, etag, sig, builtAt }, refresh: null | () => Promise } -- call refresh() after
 * the response has gone out. tick(): the server's timer -- a background rebuild when the answer is behind.
 * One build runs at a time; a request that finds no answer waits for the build already running.
 */
function createCatalogCache({ build, buildPacked = null, signature, now = Date.now, softMs = SOFT_MS, maxAgeMs = MAX_AGE_MS, onError = null }) {
    let entry = null, busy = null;
    function rebuild() {
        if (busy) return busy;
        // Read BEFORE building: a result that lands mid-build leaves this signature behind the disk, so the next
        // look rebuilds. Read after, it could claim the buffer holds something it does not.
        const sig = signature();
        busy = (async () => {
            let p = null;
            if (buildPacked) {
                try { p = await buildPacked(); } catch (err) { p = null; if (onError) onError(err); }
            }
            if (!p) p = await packAll(await build());
            entry = { body: p.body, br: p.br, gzip: p.gzip, etag: p.etag, sig, builtAt: now() };
            return entry;
        })().finally(() => { busy = null; });
        return busy;
    }
    const refreshLater = () => rebuild().catch(() => null);
    async function get() {
        const d = decide(entry, signature(), now(), { softMs, maxAgeMs });
        if (d === 'build') return { entry: await rebuild(), refresh: null };
        return { entry, refresh: d === 'serve+refresh' && !busy ? refreshLater : null };
    }
    function tick() {
        if (busy || !entry) return null;
        return decide(entry, signature(), now(), { softMs, maxAgeMs }) === 'serve+refresh' ? refreshLater() : null;
    }
    return { get, rebuild, tick, peek: () => entry, building: () => !!busy };
}

module.exports = { createCatalogCache, decide, pack, packAll, compress, etagMatches, SOFT_MS, MAX_AGE_MS };
