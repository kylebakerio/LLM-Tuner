'use strict';
// STRENGTH RANGES FROM A CLUSTER BOOTSTRAP, the server's side (2026-10-25, Kyle: "Yes run the bootstrap"). The method and
// how a page applies the answer live in ui/shared/leaderboard.js ("strength ranges from a cluster bootstrap"); this file
// is WHEN it runs, WHERE, and how the answer reaches every catalog.
//
//   its own timer   a catalog build follows every result (lib/catalogcache.js); 200 refits of the whole fit do not. The
//                   server checks every CHECK_MS; a run starts only when the catalog's inputs moved since the last check
//                   and the last run started at least MIN_GAP_MS ago (30 min). The child first fingerprints what the fit
//                   is fed (every row's scored cells, the task groups, the fit's code) and stops after one fit when that
//                   matches the cache: a speed log or a running battery's partial file moves the inputs, not the rows.
//   lowest priority a CHILD PROCESS (a worker thread cannot be niced on its own), started under `nice -n 19` and, where
//                   it exists, `ionice -c 3`; node --single-threaded (no V8 background threads) and a 1-thread libuv pool,
//                   so it is one thread that runs only when nothing else wants the CPU (the lanes' llama-server / Strata
//                   host work comes first). The server thread only writes the catalog it already holds into the child's
//                   stdin and reads ~0.3 MB back: nothing is parsed or fitted on it. A run past TIMEOUT_MS is killed.
//   cached          logs/strength-bootstrap.json (written whole: tmp + rename), read back by attach() -- the catalog
//                   worker (lib/catalogworker.js), the server's own fallback build and the public server (public/server.js,
//                   and so the static site's data/catalog.json) put it in the catalog as `strengthBootstrap`.
//
// One file, two sides: required, it exports the timer and attach(); started as `node lib/strengthboot.js --child`, it reads
// the catalog JSON on stdin and writes the bootstrap payload (or {unchanged}) on stdout.

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const CACHE_FILE = process.env.STRENGTH_BOOT_FILE || path.join(__dirname, '..', '..', 'logs', 'strength-bootstrap.json');
const UI_DIR = path.join(__dirname, '..', 'ui');
const CHECK_MS = 60 * 1000;
const MIN_GAP_MS = 30 * 60 * 1000;
const FIRST_DELAY_MS = 3 * 60 * 1000;   // after a (re)start: the catalog's first build and the page loads come first
const TIMEOUT_MS = 20 * 60 * 1000;      // ~1 min of CPU; at nice 19 behind busy lanes it can take several

// ------------------------------------------------------------------ the cache, as the catalog builds read it
let memo = { key: null, payload: null };
/** The cached payload, or null (none yet, unreadable). Re-read only when the file's mtime / size change. */
function loadCache(file = CACHE_FILE) {
    let st;
    try { st = fs.statSync(file); } catch { return null; }
    const key = `${file}:${st.mtimeMs}:${st.size}`;
    if (memo.key === key) return memo.payload;
    let payload = null;
    try { payload = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { payload = null; }
    if (!payload || typeof payload !== 'object' || !Array.isArray(payload.rows)) payload = null;
    memo = { key, payload };
    return payload;
}
/** The catalog object with the cached bootstrap in it (`strengthBootstrap`); unchanged when there is none. */
function attach(catalog, file = CACHE_FILE) {
    if (!catalog || typeof catalog !== 'object') return catalog;
    const p = loadCache(file);
    if (p) catalog.strengthBootstrap = p;
    return catalog;
}

// ------------------------------------------------------------------ the child: one bootstrap
/** The code the numbers come from: the fit (and its one item response function), ui/shared/leaderboard.js. */
function codeHash() {
    const h = crypto.createHash('sha1');
    for (const f of ['shared/leaderboard.js']) { try { h.update(f + '\0' + fs.readFileSync(path.join(UI_DIR, f))); } catch { h.update(f); } }
    return h.digest('hex').slice(0, 16);
}
/** What the bootstrap is a function of: every row's scored cells, every problem's task group, B, seed and the code. */
function fingerprint(L, fit, taskMeta, { B, seed, code }) {
    const h = crypto.createHash('sha1');
    h.update(JSON.stringify([code, B, seed]));
    const groupOf = L.taskGroupOf(taskMeta);
    for (const g of fit.qAll) {
        h.update('\n' + g.key + '|' + ((g.m && (g.m.weightsKey || g.m.key)) || ''));
        for (const [pid, r] of Object.entries(g.tasks || {}).sort((x, y) => (x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0))) {
            if (!r || r.excluded || r.credit == null || !(r.attempts > 0)) continue;
            h.update(`|${pid}:${groupOf(pid)}:${r.attempts}:${r.credit}`);
        }
    }
    return h.digest('hex').slice(0, 20);
}
/** catalog object -> payload (or { unchanged, fp } when prevFp matches). opts: { B, seed, prevFp, L }. */
async function runBootstrap(catalog, { B = null, seed = null, prevFp = null, L = null } = {}) {
    const { pathToFileURL } = require('url');
    const lb = L || await import(pathToFileURL(path.join(UI_DIR, 'shared/leaderboard.js')).href);
    const cat = { ...catalog };
    delete cat.strengthBootstrap;   // the answer is never its own input
    const nB = B || lb.BOOT.B, nSeed = seed == null ? lb.BOOT.SEED : seed;
    // the Models page's default view, exactly as lib/liveodds.js and lib/autoqueue.js build it
    const v = lb.overviewView({ store: { getItem: () => null } });
    const shown = lb.overviewCatalog(cat, v);
    const fit = lb.fitFor(shown.models, v.keepQ, v.keepT);
    const code = codeHash();
    const fp = fingerprint(lb, fit, cat.taskMeta, { B: nB, seed: nSeed, code });
    if (prevFp && prevFp === fp) return { unchanged: true, fp };
    const w0 = Date.now(), c0 = process.cpuUsage();
    const boot = lb.strengthBootstrap(fit.qAll, { B: nB, seed: nSeed, taskMeta: cat.taskMeta });
    const cpu = process.cpuUsage(c0), all = process.cpuUsage();   // the refits; the whole child (parse + fits)
    let nice = null; try { nice = os.getPriority(); } catch { /* unknown */ }
    return lb.bootstrapPayload(fit, boot, {
        view: { tensorRows: v.tensorRows === 'separate' ? 'separate' : 'combine', fileQuality: v.fileRows && v.fileRows.quality === 'separate' ? 'separate' : 'merge', keepQ: v.keepQ, credit: 'binary' },
        extra: { fp, code, catalogAt: catalog.generatedAt || null, refitMs: Date.now() - w0, refitCpuMs: Math.round((cpu.user + cpu.system) / 1000),
            cpuMs: Math.round((all.user + all.system) / 1000), nice },
    });
}

if (require.main === module && process.argv.includes('--child')) {
    const chunks = [];
    process.stdin.on('data', (c) => chunks.push(c));
    process.stdin.on('end', async () => {
        try {
            const catalog = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            const B = Number(process.env.STRENGTH_BOOT_B) || null;
            const out = await runBootstrap(catalog, { B, prevFp: process.env.STRENGTH_BOOT_PREV_FP || null });
            process.stdout.write(JSON.stringify(out));
        } catch (err) {
            process.stderr.write(String((err && err.stack) || err));
            process.exitCode = 1;
        }
    });
}

// ------------------------------------------------------------------ the server's timer
/** The command line of the child: lowest CPU (and, where there is ionice, idle I/O) priority, one thread. */
function childCommand({ node = process.execPath, file = __filename, haveIonice = fs.existsSync('/usr/bin/ionice') } = {}) {
    const nodeArgs = ['--single-threaded', file, '--child'];
    const args = ['-n', '19', ...(haveIonice ? ['/usr/bin/ionice', '-c', '3'] : []), node, ...nodeArgs];
    return { cmd: fs.existsSync('/usr/bin/nice') ? '/usr/bin/nice' : null, args, fallback: { cmd: node, args: nodeArgs } };
}
/** Should the timer start a run now? Pure: 'run' | 'running' | 'no-catalog' | 'seen' (no new inputs since the last
 *  look) | 'wait' (the last run started under minGapMs ago). */
function decide({ running, inputs, lastInputs, lastStartAt, now, minGapMs = MIN_GAP_MS, haveCache }) {
    if (running) return 'running';
    if (inputs == null) return 'no-catalog';
    if (haveCache && inputs === lastInputs) return 'seen';
    if (lastStartAt != null && now - lastStartAt < minGapMs) return 'wait';
    return 'run';
}
/**
 * createStrengthBoot({ catalog, onDone }) -> { start, stop, tick, status }.
 *   catalog(): { body (the catalog JSON bytes), inputs (its signature) } | null -- the server's prebuilt answer, never a build
 *   onDone(payload): after a new payload is cached (the server rebuilds its catalog so the pages get it)
 * The rest are for tests: file, timings, spawn, now, log.
 */
function createStrengthBoot({ catalog, onDone = null, file = CACHE_FILE, checkMs = CHECK_MS, minGapMs = MIN_GAP_MS, firstDelayMs = FIRST_DELAY_MS,
    timeoutMs = TIMEOUT_MS, B = null, spawnFn = spawn, now = Date.now, log = (m) => console.log(m), command = childCommand() }) {
    let child = null, lastInputs = null, lastStartAt = null, timer = null, first = null;
    const st = { runs: 0, last: null };
    function finish(rec) { st.last = rec; log(`[strength-bootstrap] ${rec.ok ? (rec.unchanged ? 'unchanged' : `${rec.rows} rows, ${rec.models} models, B ${rec.B}`) : 'FAILED: ' + rec.error} -- wall ${Math.round(rec.wallMs / 1000)} s, cpu ${rec.cpuMs != null ? Math.round(rec.cpuMs / 1000) + ' s' : '?'}, nice ${rec.nice ?? '?'}`); }
    function run(body, inputs) {
        const t0 = now(), prev = loadCache(file);
        const env = { ...process.env, UV_THREADPOOL_SIZE: '1', ...(B ? { STRENGTH_BOOT_B: String(B) } : {}), ...(prev && prev.fp ? { STRENGTH_BOOT_PREV_FP: prev.fp } : {}) };
        const opts = { stdio: ['pipe', 'pipe', 'pipe'], env, cwd: path.join(__dirname, '..') };
        let c;
        try { c = command.cmd ? spawnFn(command.cmd, command.args, opts) : spawnFn(command.fallback.cmd, command.fallback.args, opts); }
        catch (err) { finish({ ok: false, error: err.message, wallMs: 0 }); return Promise.resolve(null); }
        child = c; lastStartAt = t0; lastInputs = inputs; st.runs += 1;
        // without nice (no /usr/bin/nice): at least the child's main thread at 19
        if (!command.cmd) { try { os.setPriority(c.pid, 19); } catch { /* best effort */ } }
        const out = [], err = [];
        c.stdout.on('data', (d) => out.push(d));
        c.stderr.on('data', (d) => { if (err.length < 64) err.push(d); });
        const kill = setTimeout(() => { try { c.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
        if (kill.unref) kill.unref();
        c.stdin.on('error', () => { /* the child died first: reported on exit */ });
        c.stdin.end(body);
        return new Promise((resolve) => {
            c.on('error', (e) => err.push(Buffer.from(String(e.message))));
            c.on('close', async (code, signal) => {
                clearTimeout(kill); child = null;
                const wallMs = now() - t0;
                let p = null;
                if (code === 0) { try { p = JSON.parse(Buffer.concat(out).toString('utf8')); } catch { p = null; } }
                if (!p) { finish({ ok: false, error: signal ? `killed (${signal})` : `exit ${code}: ${Buffer.concat(err).toString('utf8').slice(0, 400)}`, wallMs }); return resolve(null); }
                if (p.unchanged) { finish({ ok: true, unchanged: true, wallMs, cpuMs: null, nice: null }); return resolve(null); }
                p.inputs = crypto.createHash('sha1').update(String(inputs)).digest('hex').slice(0, 16);
                p.wallMs = wallMs;
                try {
                    const tmp = `${file}.tmp-${process.pid}`;
                    await fs.promises.writeFile(tmp, JSON.stringify(p));
                    await fs.promises.rename(tmp, file);
                } catch (e) { finish({ ok: false, error: 'cache write: ' + e.message, wallMs }); return resolve(null); }
                finish({ ok: true, rows: p.rows.length, models: p.models.length, B: p.B, wallMs, cpuMs: p.cpuMs, nice: p.nice });
                if (onDone) { try { onDone(p); } catch { /* the catalog rebuild reports its own errors */ } }
                resolve(p);
            });
        });
    }
    async function tick() {
        let e = null;
        try { e = await catalog(); } catch { e = null; }
        const d = decide({ running: !!child, inputs: e ? e.inputs : null, lastInputs, lastStartAt, now: now(), minGapMs, haveCache: !!loadCache(file) });
        if (d !== 'run' || !e || !e.body) return d;
        await run(e.body, e.inputs);
        return d;
    }
    function start() {
        if (timer || first) return;
        first = setTimeout(() => { first = null; tick().catch(() => {}); timer = setInterval(() => { tick().catch(() => {}); }, checkMs); if (timer.unref) timer.unref(); }, firstDelayMs);
        if (first.unref) first.unref();
    }
    function stop() { if (first) clearTimeout(first); if (timer) clearInterval(timer); first = timer = null; if (child) { try { child.kill('SIGKILL'); } catch { /* gone */ } } }
    const status = () => ({ running: !!child, runs: st.runs, last: st.last, lastStartAt, file });
    return { start, stop, tick, status, run };
}

module.exports = { createStrengthBoot, decide, childCommand, attach, loadCache, runBootstrap, fingerprint, CACHE_FILE, MIN_GAP_MS, CHECK_MS };
