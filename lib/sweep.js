'use strict';
// --- HEADLESS LAUNCH SWEEP ---
// A server-side port of the browser's Launch Sweep runner (script.js's
// abRunQueued). Same job: for each queued config, launch the REAL llama-server,
// send the test prompt N times, harvest the timing broadcast, stop, move on --
// which is how the speculative stack gets measured at all, since llama-bench
// can't drive it.
//
// Why it exists: the browser version lives in a tab. It dies on a refresh, it
// needs a human to paste lines, and nothing outside that tab can start a run or
// read results. That makes it unusable from a headless box or over ssh, and it
// meant benchmark sweeps on two machines had to be hand-driven in lockstep.
//
// Design: this talks to the dashboard's OWN http api on loopback -- /api/start,
// /api/chat, /api/stop -- and subscribes to /api/status exactly as the browser
// does, rather than reaching into server4.js's internals. That keeps the launch
// path (raw-command tokenizing, device planning, RPC worker auto-start, CSV
// logging) byte-identical to the interactive one, so a headless result and a
// browser result for the same line are directly comparable. The cost is a few
// loopback round-trips per rep, which is nothing next to a model load.
const http = require('http');
const fs = require('fs');
const path = require('path');

// Results live in memory while a sweep runs, which means a dashboard restart
// used to lose them entirely -- the same "your runs aren't automatically
// saved" problem that moving off the browser was meant to fix. Every rep and
// every status change is mirrored here, so a completed sweep survives a
// restart and `--status` can still print it. Written via a temp file + rename
// so a crash mid-write can't leave a truncated JSON behind.
// SWEEP_STATE_FILE overrides it (tests point it at a temp file so they never clobber a real sweep's).
const STATE_FILE = process.env.SWEEP_STATE_FILE || path.join(__dirname, '..', 'sweep-state.json');

function persist() {
    if (!state) return;
    try {
        const tmp = STATE_FILE + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(state));
        fs.renameSync(tmp, STATE_FILE);
    } catch { /* a benchmark must not die because its journal couldn't write */ }
}

function loadPersisted() {
    try {
        const s = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        // A sweep can't survive the process that was driving it; anything the
        // file claims is "running" was killed by the restart.
        if (s.running) { s.running = false; s.error = (s.error ? s.error + '; ' : '') + 'dashboard restarted mid-sweep'; }
        return s;
    } catch { return null; }
}

const READY_TIMEOUT_MS = 15 * 60 * 1000; // a 27B near the VRAM ceiling loads slowly
const LOAD_STALL_MS = Number(process.env.SWEEP_LOAD_STALL_MS) || 4 * 60 * 1000;   // see waitForReady

// Resident memory (bytes) of the running llama-server processes, from /proc; null if none.
function serverRss() {
    const fs = require('fs');
    let total = 0, found = false;
    let pids = [];
    try { pids = fs.readdirSync('/proc').filter((d) => /^\d+$/.test(d)); } catch { return null; }
    for (const pid of pids) {
        try {
            const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8');
            if (!/llama-server/.test(cmd.split('\0')[0] || '')) continue;
            const m = /VmRSS:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf-8'));
            if (m) { total += Number(m[1]) * 1024; found = true; }
        } catch { /* process gone */ }
    }
    return found ? total : null;
}
const COMPLETION_TIMEOUT_MS = 30000;     // logCompletedRequest awaits nvidia-smi first
const POST_STOP_SETTLE_MS = 3000;        // VRAM release lags process exit
const READY_ERROR_GRACE_MS = 45000;      // an RPC load legitimately takes ~78 s

let state = null; // null = idle; see freshState()

function freshState(opts) {
    return {
        running: true, startedAt: Date.now(), finishedAt: null,
        reps: opts.reps, genTokens: opts.genTokens, promptChars: opts.prompt.length,
        cooldownSec: opts.cooldownSec, label: opts.label || null,
        current: null, cancelled: false, error: null,
        rows: opts.rows.map(r => ({ label: r.label, rawCommand: r.rawCommand, status: 'queued', results: [], error: null })),
    };
}

// --- loopback http helpers ---
function request(method, path, body, timeoutMs = 0) {
    return new Promise((resolve, reject) => {
        const data = body === undefined ? null : JSON.stringify(body);
        const req = http.request({
            host: '127.0.0.1', port: module.exports.port, path, method,
            headers: {
                ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
                // server4.js mints this at startup and the tunnel gate accepts
                // it; without it every loopback call 401s once a tunnel is up.
                ...(module.exports.authToken ? { Cookie: `mc_session=${module.exports.authToken}` } : {}),
            },
        }, (res) => {
            let out = '';
            res.setEncoding('utf8');
            res.on('data', (c) => { out += c; });
            res.on('end', () => resolve({ status: res.statusCode, body: out }));
        });
        if (timeoutMs) { req.setTimeout(timeoutMs, () => req.destroy(new Error('request timed out'))); }
        req.on('error', reject);
        req.end(data);
    });
}

async function getJson(path) {
    const r = await request('GET', path);
    try { return JSON.parse(r.body); } catch { return null; }
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// --- /api/status subscription ---
// One long-lived SSE connection for the whole sweep, mirroring the browser's.
// Carries both the launch state machine and the COMPLETION payloads (which
// server4.js broadcasts as a log line, not a distinct event type).
function openStatusStream(onState, onCompletion) {
    let buf = '';
    const req = http.request({
        host: '127.0.0.1', port: module.exports.port, path: '/api/status', method: 'GET',
        headers: module.exports.authToken ? { Cookie: `mc_session=${module.exports.authToken}` } : {},
    }, (res) => {
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
            buf += chunk;
            let i;
            while ((i = buf.indexOf('\n\n')) !== -1) {
                const frame = buf.slice(0, i); buf = buf.slice(i + 2);
                if (!frame.startsWith('data: ')) continue; // ': ping' keepalive
                let msg;
                try { msg = JSON.parse(frame.slice(6)); } catch { continue; }
                onState(msg);
                if (typeof msg.log === 'string' && msg.log.startsWith('COMPLETION:')) {
                    try { onCompletion(JSON.parse(msg.log.slice('COMPLETION:'.length))); } catch { /* partial */ }
                }
            }
        });
    });
    req.on('error', () => {});
    req.end();
    return req;
}

// --- line parsing (mirrors script.js parseManualLine) ---
// "label :: -m <model-name-substring> <server args...>". The -m value is
// matched against the model list and replaced with the full path; the rest is
// passed through verbatim.
function parseLine(line, models, binary) {
    const idx = line.indexOf('::');
    if (idx === -1) return { error: 'missing "::" separator' };
    const label = line.slice(0, idx).trim();
    const rest = line.slice(idx + 2).trim();
    if (!label) return { error: 'empty label' };
    const m = rest.match(/(^|\s)-m\s+(\S+)/);
    if (!m) return { error: 'no -m <model> in line' };
    const needle = m[2];
    const hits = models.filter(x => x.name.includes(needle) || x.path.includes(needle));
    if (hits.length === 0) return { error: `no model matches "${needle}"` };
    // Prefer an exact basename match, else the shortest name, so a substring
    // that is a prefix of several files resolves predictably instead of by
    // directory-scan order.
    const exact = hits.find(x => x.name === needle);
    const chosen = exact || hits.slice().sort((a, b) => a.name.length - b.name.length)[0];
    if (!exact && hits.length > 1) {
        return { error: `"${needle}" is ambiguous (${hits.length} matches: ${hits.slice(0, 3).map(x => x.name).join(', ')}...)` };
    }
    // llama-bench lines launch a broken server -- same guard the browser uses.
    if (/(^|\s)-p\s+\d|(^|\s)-d\s+\d|(^|\s)-r\s+\d/.test(rest) && !/--port/.test(rest)) {
        return { error: 'looks like a llama-bench line (-p/-d/-r, no --port)' };
    }
    const restWithPath = rest.replace(/(^|\s)-m\s+\S+/, `$1-m ${chosen.path}`);
    return { label, modelPath: chosen.path, rawCommand: `${binary} ${restWithPath}` };
}

// --- cooldown gate ---
// Hold until every GPU is at or below `targetC`, so a hot card from the
// previous config can't depress the next one's numbers. Gives up after
// maxWaitMs rather than stalling a long sweep forever.
async function cooldown(targetC, maxWaitMs = 10 * 60 * 1000) {
    if (!targetC) return { waitedMs: 0, reached: true };
    const t0 = Date.now();
    for (;;) {
        // /api/telemetry/latest is {t, stats}, and the per-card array is
        // stats.gpus (stats.devices exists but is empty on this rig). Verified
        // against the live endpoint -- an earlier guess at the top-level shape
        // read nothing and silently failed open, which is worse than no gate
        // because it looks like it worked.
        const t = await getJson('/api/telemetry/latest').catch(() => null);
        const st = t?.stats || t || {};
        const temps = [];
        for (const g of (st.gpus || [])) if (typeof g.gpu_temp === 'number') temps.push(g.gpu_temp);
        for (const d of (st.devices || [])) if (typeof d.temp === 'number') temps.push(d.temp);
        if (!temps.length && typeof st.master?.gpu_temp === 'number') temps.push(st.master.gpu_temp);
        const hottest = temps.length ? Math.max(...temps) : null;
        if (hottest == null || hottest <= targetC) return { waitedMs: Date.now() - t0, reached: true, hottest };
        if (Date.now() - t0 > maxWaitMs) return { waitedMs: Date.now() - t0, reached: false, hottest };
        if (state?.cancelled) return { waitedMs: Date.now() - t0, reached: false, hottest };
        await sleep(5000);
    }
}

// --- one rep's request ---
// Every rep must be a COLD prefill. llama-server keeps the slot's KV and, with cache_prompt on (its
// default), rep 2..N reuse the whole identical prompt: they logged a few prompt tokens, so a sweep
// line gave exactly ONE prefill sample and never reached the >=3 samples the Models page's 32k speed
// board needs (lib/models.js speedAtContextOf, ui/modelpicker/rank.js speedAt32k). cache_prompt:false
// makes the server drop the slot's tokens (n_past = 0) and prefill the whole prompt again.
// /api/chat forwards the body to /v1/chat/completions verbatim, so the field reaches llama-server.
function repChatBody(prompt, genTokens) {
    return {
        model: 'ab-test',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: genTokens,
        stream: false,
        cache_prompt: false,
    };
}

// --- the run loop ---
async function runAll(opts) {
    let liveState = 'stopped', liveError = '', liveDegraded = false;
    let lastLoadActivity = Date.now();
    let completionResolve = null;
    const stream = openStatusStream(
        (msg) => {
            if (msg.state) liveState = msg.state;
            if (typeof msg.log === 'string' || msg.state) lastLoadActivity = Date.now();
            // llama.cpp silently degrades when compute buffers don't fit: it
            // "retries without pipeline parallelism" and still reports ready.
            // Such loads served exactly two requests then segfaulted in
            // libamdhip64 (3 kernel-logged crashes, Qwen3.8-27B UD-Q4_K_XL f16 @262k). A row that
            // loaded this way is NOT a fit; mark it so ladders can't miss it.
            if (typeof msg.log === 'string' && /retrying without pipeline parallelism/.test(msg.log)) liveDegraded = true;
            // server4.js sends ADVISORY notices through the same `error` field,
            // prefixed 'LOAD WARNING:' -- llama.cpp's pre-load VRAM estimate
            // and its recoverable compute-buffer OOM, both of which it retries
            // and usually survives ("n_gpu_layers is pinned, so it loads
            // anyway"). Treating those as fatal made this runner kill loads
            // that would have come up: it explains the 3060-Vulkan, Q3_K_XL
            // Vulkan and Vulkan-split "never became ready" rows, all configs
            // tight enough on VRAM to trip the estimate. Only real failures
            // (e.g. 'Launch failed: ...') end the wait.
            if (msg.error && !/^(LOAD WARNING|LAUNCH CMD):/.test(msg.error)) liveError = msg.error;   // LAUNCH CMD is an info banner sent on the error channel; treating it as an error killed every load longer than 45 s (RPC, Lexar, 65k+)
        },
        (payload) => { if (completionResolve) { const r = completionResolve; completionResolve = null; r(payload); } },
    );

    // Returns '' on success, else WHY the wait ended -- callers put this in the
    // row error. "model never became ready" with no reason cost hours of
    // guesswork during the first overnight run.
    const waitForReady = async () => {
        const t0 = Date.now();
        lastLoadActivity = t0;
        let lastRss = serverRss(), lastRssAt = t0;
        let wasUp = false;   // the server left 'stopped' (starting/loading) at least once
        while (Date.now() - t0 < READY_TIMEOUT_MS) {
            if (liveState === 'ready') return '';
            if (liveState && liveState !== 'stopped') wasUp = true;
            // STALL: no log line and no resident-memory growth for LOAD_STALL_MS means the load is
            // stuck (2026-09-28: an XTX-only Flash load sat 15 min single-threaded -- CPU weight
            // repacking -- until READY_TIMEOUT_MS; nothing was learned from those minutes). Memory
            // growth counts as progress, so a long silent tensor read from disk is not a stall.
            {
                const rss = serverRss();
                if (rss != null && lastRss != null && Math.abs(rss - lastRss) > 64 * 2 ** 20) { lastRss = rss; lastRssAt = Date.now(); }
                else if (lastRss == null && rss != null) { lastRss = rss; lastRssAt = Date.now(); }
                const idle = Date.now() - Math.max(lastLoadActivity, lastRssAt);
                if (wasUp && liveState !== 'ready' && idle > LOAD_STALL_MS) {
                    return `load stalled: no log output and no memory growth for ${Math.round(idle / 1000)}s (state '${liveState}', ${rss != null ? Math.round(rss / 2 ** 30) + ' GiB resident' : 'no server process found'})`;
                }
            }
            // A load that CRASHES (an assertion abort, a segfault) sends no 'Launch failed', it just
            // goes back to 'stopped' -- and this loop used to wait out the full 15 min for a process
            // that was already gone (2026-09-26: an RPC layout aborted on output.weight in seconds and
            // the row took 900 s). Back to 'stopped' after being up = the process exited.
            if (wasUp && liveState === 'stopped' && Date.now() - t0 > READY_ERROR_GRACE_MS) {
                const ml = await getJson('/api/master/logs').catch(() => null);
                const tail = (ml?.logs || '').split('\n').filter(l => /\sE\s|error|failed|abort|assert|GGML_ASSERT|\.cpp:\d+:/i.test(l)).slice(-2).join(' | ').slice(0, 300);
                return `server exited during load${tail ? `: ${tail}` : ''}`;
            }
            // Fail fast on a REAL reported failure, not on the pre-launch
            // default still reading 'stopped'. The grace period must outlast a
            // legitimately slow start: an RPC worker's weights cross the
            // network -- measured at 78 s over wifi vs ~5 s for a local load --
            // and a stray broadcast inside a 5 s window used to kill the config.
            if (Date.now() - t0 > READY_ERROR_GRACE_MS && liveError) return `error during load: ${liveError}`;
            if (state.cancelled) return 'cancelled';
            await sleep(2000);
        }
        return `timed out after ${Math.round(READY_TIMEOUT_MS / 1000)}s (last state '${liveState}')`;
    };

    try {
        for (const row of state.rows) {
            if (state.cancelled) { row.status = 'cancelled'; continue; }
            state.current = row.label;
            row.status = 'running';
            try {
                await request('POST', '/api/stop').catch(() => {});
                await sleep(POST_STOP_SETTLE_MS);
                // Then wait for VRAM to actually come back. A fixed 3 s was
                // not enough between back-to-back 20 GB launches: the next
                // config's allocations raced the previous process's teardown
                // and configs that fit were reported as OOM (a Q6 ladder
                // showed 245k fitting while 229k "failed"). Poll telemetry
                // until every card is near idle, up to 60 s.
                for (let i = 0; i < 30; i++) {
                    const t = await getJson('/api/telemetry/latest').catch(() => null);
                    const gpus = (t?.stats || t || {}).gpus || [];
                    const busy = gpus.some(g => typeof g.vram_used === 'number' && g.vram_used > 1500);
                    if (!busy) break;
                    await sleep(2000);
                }
                if (opts.cooldownSec) row.cooldown = await cooldown(opts.cooldownSec);
                liveError = ''; liveState = 'stopped'; liveDegraded = false;
                const started = await request('POST', '/api/start', {
                    rawCommand: row.rawCommand,
                    modelPath: opts.rowMeta[row.label]?.modelPath,
                    model: (opts.rowMeta[row.label]?.modelPath || '').split('/').pop(),
                });
                if (started.status !== 200) throw new Error(`start refused (${started.status}): ${started.body.slice(0, 200)}`);
                // Clear again AFTER the start is accepted. The previous row's
                // killed process broadcasts its 'Launch failed' from an async
                // close handler, which can land after the pre-start reset and
                // poison this row's fail-fast check -- one failed config then
                // cascades into every config after it. Observed 2026-09-15:
                // three consecutive Q3_K_XL Vulkan rows "never became ready"
                // while the 4th (ROCm) and a straight retry of all three both
                // worked fine.
                liveError = '';
                const why = await waitForReady();
                if (why) {
                    let detail = why;
                    if (!detail) {
                        const ml = await getJson('/api/master/logs').catch(() => null);
                        detail = (ml?.logs || '').split('\n').filter(l => /\sE\s|error|failed/i.test(l)).slice(-2).join(' | ').slice(0, 300);
                    }
                    throw new Error(`model never became ready -- ${detail}`);
                }
                for (let rep = 0; rep < opts.reps && !state.cancelled; rep++) {
                    const arrived = new Promise(r => { completionResolve = r; });
                    const chat = await request('POST', '/api/chat', repChatBody(opts.prompt, opts.genTokens), 20 * 60 * 1000);
                    if (chat.status !== 200) throw new Error(`request failed (${chat.status})`);
                    // The timeout is cleared once the completion arrives: a pending 30 s timer per rep
                    // kept the process (and the test suite) alive long after a sweep finished.
                    let completionTimer;
                    const payload = await Promise.race([arrived, new Promise((r) => { completionTimer = setTimeout(() => r(null), COMPLETION_TIMEOUT_MS); })]);
                    clearTimeout(completionTimer);
                    completionResolve = null;
                    if (payload) { row.results.push(payload); persist(); }
                }
                row.status = state.cancelled ? 'cancelled' : 'done';
                if (liveDegraded) { row.degraded = true; row.error = 'LOADED DEGRADED: compute buffers did not fit; llama.cpp retried without pipeline parallelism (known to segfault under load)'; }
                persist();
            } catch (e) {
                row.status = 'error';
                row.error = e.message;
                persist();
            }
        }
    } finally {
        state.current = null;
        await request('POST', '/api/stop').catch(() => {});
        try { stream.destroy(); } catch { /* already gone */ }
        state.running = false;
        state.finishedAt = Date.now();
        persist();
    }
}

// --- public api ---
async function start(opts) {
    if (state && state.running) throw new Error('a sweep is already running');
    const lines = (opts.lines || []).map(l => String(l).trim()).filter(Boolean);
    if (!lines.length) throw new Error('no lines given');
    if (!opts.prompt || !String(opts.prompt).trim()) throw new Error('no prompt given');

    const models = await getJson('/api/models');
    if (!Array.isArray(models) || !models.length) throw new Error('model list unavailable');
    const builds = await getJson('/api/builds');
    const buildList = Array.isArray(builds) ? builds : (builds?.builds || []);
    // An explicit build wins. The heuristic below picks the first build mentioning cuda, which is
    // fine for models any build can load -- but it silently picks the WRONG one for a model whose
    // architecture only exists in a particular tree (Flash-Next / qwen4exp lives in llama.cpp-u144,
    // and vulkan-cuda cannot load it at all). Sweeping such a model was impossible before this.
    let build;
    if (opts.build) {
        build = buildList.find(b => (b.id || '') === opts.build);
        if (!build) {
            throw new Error(`unknown build "${opts.build}"; configured: ${buildList.map(b => b.id).join(', ')}`);
        }
    } else {
        // Same choice the browser's manual-lines path makes: first build whose
        // id or label mentions cuda, else the first one.
        build = buildList.find(b => /cuda/i.test(b.id || '') || /cuda/i.test(b.label || '')) || buildList[0];
    }
    if (!build?.path) throw new Error('no llama-server build configured');

    const rows = [], rowMeta = {}, errors = [];
    for (const line of lines) {
        const p = parseLine(line, models, build.path);
        if (p.error) { errors.push(`${p.error}: ${line.slice(0, 60)}`); continue; }
        rows.push({ label: p.label, rawCommand: p.rawCommand });
        rowMeta[p.label] = { modelPath: p.modelPath };
    }
    if (errors.length) throw new Error(errors.join(' | '));

    const resolved = {
        rows, rowMeta, prompt: String(opts.prompt),
        reps: Math.max(1, Number(opts.reps) || 5),
        genTokens: Math.max(1, Number(opts.genTokens) || 1024),
        cooldownSec: Number(opts.cooldownC ?? opts.cooldownSec) || 0,
        label: opts.label,
    };
    state = freshState(resolved);
    persist();
    // Deliberately not awaited: the http handler returns immediately and the
    // caller polls /api/sweep/status. An unhandled rejection here would take
    // the dashboard down mid-benchmark, so it is captured onto the state.
    runAll(resolved).catch((e) => { state.error = e.message; state.running = false; state.finishedAt = Date.now(); });
    return { rows: rows.map(r => r.label), build: build.path, reps: resolved.reps, genTokens: resolved.genTokens };
}

// Per-label summary so a poller gets the answer without re-deriving it.
function summarize(s) {
    const num = (a) => a.filter(v => v != null && v !== '').map(Number).filter(Number.isFinite);
    const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
    return s.rows.map(r => {
        const gen = num(r.results.map(x => x.genTps));
        const pp = num(r.results.map(x => x.promptTps));
        const acc = num(r.results.map(x => x.draftAcceptRate));
        const wall = num(r.results.map(x => x.wallTime));
        return {
            label: r.label, status: r.status, error: r.error, n: r.results.length,
            genTps: mean(gen), genTpsSpread: gen.length > 1 ? Math.max(...gen) - Math.min(...gen) : null,
            // Cold reps only. Every rep now sends cache_prompt:false (see
            // repChatBody), but sweeps recorded before 2026-09-28 had rep 2+
            // hit the prompt cache -- their "prompt t/s" is a few tokens over
            // fixed overhead, not a prefill rate -- so the filter stays.
            // Same >64-prompt-token rule the Bench view's isColdPrefill uses,
            // rather than assuming rep 1 is the cold one -- if rep 1's value
            // is missing, blindly taking pp[0] would report a cache hit as a
            // prefill measurement.
            promptTps: mean(num(r.results.filter(x => (x.promptTokens ?? 0) > 64).map(x => x.promptTps))),
            draftAcceptRate: mean(acc), wallTime: mean(wall),
            genTokens: r.results.length ? r.results[0].genTokens : null,
            promptTokens: r.results.length ? r.results[0].promptTokens : null,
        };
    });
}

function status() {
    if (!state) {
        const p = loadPersisted();
        if (!p) return { running: false, idle: true };
        state = p; // adopt it so --status keeps working after a restart
    }
    return {
        running: state.running, idle: false, error: state.error,
        startedAt: state.startedAt, finishedAt: state.finishedAt,
        current: state.current, cancelled: state.cancelled,
        reps: state.reps, genTokens: state.genTokens, promptChars: state.promptChars,
        summary: summarize(state),
        rows: state.rows,
    };
}

function stop() {
    if (!state || !state.running) return { running: false };
    state.cancelled = true;
    return { running: true, cancelled: true };
}

module.exports = { start, status, stop, parseLine, repChatBody, port: 3000, authToken: null };
