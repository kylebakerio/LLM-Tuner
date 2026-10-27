'use strict';
// The Models catalog built on a WORKER THREAD (2026-10-21, Kyle: "trying to load #models on lab.kylebaker.io is just
// stuck loading forever"; lab.* was the dashboard until 2026-10-22, ai.* now). listModels() is synchronous and takes
// 0.5-4 s warm, 5-7 s cold (every battery's results, the whole request table, 5.4 MB of JSON); on the server's one
// thread that froze every other request for as long.
// Here it runs on its own thread with its own copies of lib/models.js's file caches, which stay warm between builds
// because the thread stays up. The thread hands back the packed answer (lib/catalogcache.js packAll: body, brotli,
// gzip, ETag), so the server thread only stores bytes.
//
// One file, two sides: required by the server it exports createCatalogWorker(); started as a worker it builds.
// The build is the one server4.js always ran: listModels({ fresh: true }), then the disk sizes from the model scan, then
// (2026-10-25) the cached strength bootstrap (lib/strengthboot.js attach).

const { Worker, isMainThread, parentPort, workerData } = require('worker_threads');

const ROLE = 'models-catalog-build';

if (!isMainThread && workerData && workerData.role === ROLE) {
    const modelsModel = require('./models');
    const modelScan = require('./modelscan');
    const { packAll } = require('./catalogcache');
    const strengthBoot = require('./strengthboot');   // the cached strength bootstrap, carried by the catalog (2026-10-25)
    parentPort.on('message', async ({ id, roots }) => {
        const t0 = Date.now();
        try {
            let out = modelsModel.listModels({ fresh: true });
            // diskBytes for local models whose runs never recorded a model_path (lib/modelscan.js)
            try { out = modelScan.fillDiskBytes(out, await modelScan.scanModelDirs(roots || []), (p) => modelsModel.canonicalModel(p).key); }
            catch (err) { console.warn('/api/models/catalog: disk sizes from the model scan failed:', err.message); }
            strengthBoot.attach(out);   // `strengthBootstrap`: the ranges the pages apply (ui/shared/leaderboard.js fitFor)
            const p = await packAll(out);
            parentPort.postMessage({ id, ok: true, body: p.body, br: p.br, gzip: p.gzip, etag: p.etag, ms: Date.now() - t0 });
        } catch (err) {
            parentPort.postMessage({ id, ok: false, error: (err && err.stack) || String(err) });
        }
    });
}

const asBuffer = (u8) => (Buffer.isBuffer(u8) ? u8 : Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength));

/**
 * createCatalogWorker({ roots }) -> { build() -> Promise<{ body, br, gzip, etag, ms }>, stop() }.
 * roots: the model dirs to scan for disk sizes (or a function returning them, read per build). The thread is started on
 * the first build and kept; if it dies or a build takes longer than timeoutMs it is replaced on the next one.
 * `file` / `role` are for the test (a stand-in worker); the server uses the defaults.
 */
function createCatalogWorker({ roots = [], timeoutMs = 180000, file = __filename, role = ROLE } = {}) {
    let w = null, seq = 0;
    const waiting = new Map();
    // the builds sent to `me` (a replaced thread's exit must not fail the builds of the one after it)
    const failAll = (err, me = null) => { for (const [id, p] of waiting) { if (me && p.me !== me) continue; clearTimeout(p.timer); waiting.delete(id); p.reject(err); } };
    function spawn() {
        const me = new Worker(file, { workerData: { role } });
        me.on('message', (m) => {
            const p = waiting.get(m && m.id); if (!p) return;
            waiting.delete(m.id); clearTimeout(p.timer);
            if (!m.ok) return p.reject(new Error('catalog worker: ' + m.error));
            p.resolve({ body: asBuffer(m.body), br: asBuffer(m.br), gzip: asBuffer(m.gzip), etag: m.etag, ms: m.ms });
        });
        me.on('error', (err) => { if (w === me) w = null; failAll(err, me); });
        me.on('exit', (code) => { if (w === me) w = null; failAll(new Error(`catalog worker exited (${code})`), me); });
        me.unref();   // never keeps the process alive on its own
        return me;
    }
    function build() {
        if (!w) w = spawn();
        const me = w, id = ++seq;
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                waiting.delete(id);
                if (w === me) w = null;
                me.terminate().catch(() => {});
                reject(new Error(`catalog worker: no answer in ${Math.round(timeoutMs / 1000)} s`));
            }, timeoutMs);
            if (timer.unref) timer.unref();
            waiting.set(id, { resolve, reject, timer, me });
            me.postMessage({ id, roots: typeof roots === 'function' ? roots() : roots });
        });
    }
    function stop() { const me = w; w = null; failAll(new Error('catalog worker stopped')); return me ? me.terminate() : Promise.resolve(); }
    return { build, stop };
}

module.exports = { createCatalogWorker, ROLE };
