const http = require('http');
const net = require('net');
const fs = require('fs/promises');
const path = require('path');
const zlib = require('zlib');
// Big JSON answers, compressed when the browser accepts it (2026-10-06, Kyle: "the models page is a relatively heavy
// load"): the Models catalog is 1.7 MB as text and ~150 KB as brotli, for ~15 ms of CPU. Small bodies go out as is.
function sendJsonCompressed(req, res, obj, headers = {}) {
    return sendCompressed(req, res, Buffer.from(JSON.stringify(obj)), { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers }, 4096);
}
// The same for any text body (the page's HTML, a JS or CSS file): brotli or gzip per Accept-Encoding, as is under
// `min` bytes. `ready`: { br, gzip } functions returning a Promise of the already-compressed body (lib/assets.js
// keeps one per file version), so a cached file is not compressed again per request. Never used for the SSE
// streams (text/event-stream must not be buffered).
function sendCompressed(req, res, body, headers = {}, min = 1024, ready = null) {
    const accept = String(req.headers['accept-encoding'] || '');
    const base = { Vary: 'Accept-Encoding', ...headers };
    const enc = /\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : null;
    if (body.length < min || !enc) { res.writeHead(200, base); return res.end(body); }
    const done = (err, out) => {
        if (err) { res.writeHead(200, base); return res.end(body); }
        res.writeHead(200, { ...base, 'Content-Encoding': enc });
        res.end(out);
    };
    if (ready) return ready[enc]().then((out) => done(null, out), done);
    if (enc === 'br') zlib.brotliCompress(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 4, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length } }, done);
    else zlib.gzip(body, { level: 6 }, done);
}
const os = require('os');
const { spawn, exec, execFile } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const ROOT_DIR = path.join(__dirname, '..');
const PORT = 3000;
const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10MB payload limit to prevent OOM
// /api/chat alone gets a much higher ceiling: llama.cpp's native input_video/
// input_audio content types (see the CHAT PROXY handler) carry a whole media
// file as raw base64 (~1.33x its original size) inside the same JSON body as
// the rest of the conversation. Every other route stays at the 10MB default.
const MAX_CHAT_BODY_SIZE = 100 * 1024 * 1024; // 100MB

// --- STATE ---
let llamaProcess = null;
let pythonProcess = null;
let serverState = 'stopped';
let currentModel = '';
let isRpc = false;
let launchPending = false; // /api/start is awaiting the RPC worker
let clients = [];
let loadStartTime = 0;
let serverStartedAt = 0;   // ms epoch of the current launch; kept after load (loadStartTime is zeroed at ready) so clients can show uptime
let finalLoadTime = 0;
let currentLaunchCommand = '';
// Full structured config passed to the most recent /api/start (Item 22: lets a
// freshly-connected/refreshed client repopulate the launch-config UI from the
// server's authoritative state instead of staying blank). Cleared once the
// server actually stops so a dead run's config isn't offered as "current".
let currentLaunchConfig = null;

// Live phase state of the in-flight request, parsed from llama-server's
// progress lines -- stamped onto each telemetry sample as it's taken so the
// per-request/monitor charts get REAL per-tick rates and prefill progress,
// not just a flat completion-time average painted across the whole phase.
let liveProgress = {};
// Previous prompt-processing progress point, for deriving an instantaneous
// prefill rate (llama.cpp only reports a cumulative one). Reset per request.
let lastPrefillPoint = null;
// net-throughput delta state for server-recorded samples
let lastSampleNetBytes = null;
let lastSampleNetTime = null;

// --- BENCH STATE (llama-bench runner, Bench tab) ---
let benchQueue = [];        // server-side matrix queue (survives page closes)
let benchQueueTotal = 0;
let benchCurrentLabel = ''; // label of the run in flight (for reconnecting clients)
function launchBenchProcess(cfg) {
    const benchBin = getLlamaServerBinary(cfg.build).replace(/llama-server$/, 'llama-bench');
    const args = ['-m', cfg.modelPath];
    if (cfg.rawArgs) {
        // manual run line: everything after the resolved -m, verbatim
        // (tokenizeCommand so quoted spans stay single arguments)
        args.push(...tokenizeCommand(String(cfg.rawArgs).trim()));
        return spawnBench(benchBin, args);
    }
    if (cfg.fa != null) args.push('-fa', cfg.fa ? '1' : '0');
    if (cfg.cacheK) args.push('-ctk', cfg.cacheK);
    if (cfg.cacheV) args.push('-ctv', cfg.cacheV);
    if (cfg.nPrompt != null && cfg.nPrompt !== '') args.push('-p', String(cfg.nPrompt));
    if (cfg.nGen != null && cfg.nGen !== '') args.push('-n', String(cfg.nGen));
    if (cfg.depths) args.push('-d', String(cfg.depths));
    if (cfg.reps != null && cfg.reps !== '') args.push('-r', String(cfg.reps));
    if (cfg.devices) args.push('-dev', String(cfg.devices));
    if (cfg.splitMode) args.push('-sm', String(cfg.splitMode));
    if (cfg.tensorSplit) args.push('-ts', String(cfg.tensorSplit));
    if (cfg.extraArgs) args.push(...tokenizeCommand(String(cfg.extraArgs).trim()));
    return spawnBench(benchBin, args);
}
function spawnBench(benchBin, args) {
    benchRunning = true;
    benchLastCommand = `${benchBin} ${args.join(' ')}`;
    benchLog(`--- ${new Date().toLocaleString()} ---`);
    benchLog(`$ ${benchLastCommand}`);
    try {
        benchProcess = spawn(benchBin, args);
    } catch (err) {
        benchRunning = false;
        benchLog(`[bench] failed to spawn: ${err.message}`);
        return err.message;
    }
    let benchLineBuf = '';
    const onBenchData = (d) => {
        benchLineBuf += d.toString();
        const lines = benchLineBuf.split(/\r\n|\r|\n/);
        benchLineBuf = lines.pop();
        for (const line of lines) benchLog(line);
    };
    benchProcess.stdout.on('data', onBenchData);
    benchProcess.stderr.on('data', onBenchData);
    // One-shot: on a failed spawn BOTH 'error' and 'exit' fire, and running
    // this twice would overwrite benchLastSamples with an empty buffer and
    // advance the matrix queue by TWO runs.
    let runFinished = false;
    const finishRun = (logLine, doneTag) => {
        if (runFinished) return;
        runFinished = true;
        benchRunning = false;
        benchProcess = null;
        benchLastSamples = takeRequestSamples();
        benchLog(logLine);
        broadcastState(doneTag);
        maybeStartNextQueued();
    };
    benchProcess.on('error', (err) => finishRun(`[bench] error: ${err.message}`, 'BENCH_DONE:error'));
    benchProcess.on('exit', (code, signal) => {
        if (benchLineBuf) benchLog(benchLineBuf);
        finishRun(`[bench] exited with ${signal ? `signal ${signal}` : `code ${code}`}`, `BENCH_DONE:${code ?? 'signal'}`);
    });
    return null;
}
function maybeStartNextQueued() {
    try {
        if (benchQueue.length === 0) { benchQueueTotal = 0; return; }
        if (llamaProcess) {
            benchLog('[matrix] a model was launched mid-matrix -- aborting remaining runs');
            benchQueue = []; benchQueueTotal = 0;
            return;
        }
        const next = benchQueue.shift();
        const k = benchQueueTotal - benchQueue.length;
        benchCurrentLabel = next.label || next.devices || 'run';
        benchLog(`===== llama-bench ${k}/${benchQueueTotal}: ${benchCurrentLabel} =====`);
        const err = launchBenchProcess(next);
        if (err) maybeStartNextQueued();
    } catch (err) {
        // A malformed queued config (e.g. a build id that no longer exists in
        // dashboard.config.json) throws inside launchBenchProcess -- and this
        // fires from a process 'exit' handler, so an uncaught throw would take
        // the whole dashboard down mid-matrix.
        benchQueue = []; benchQueueTotal = 0;
        benchLog(`[matrix] aborted: ${err.message}`);
    }
}

let benchProcess = null;
// Cumulative across runs (capped) -- the client renders this verbatim, so
// switching tabs / refreshing restores the WHOLE session's results, not just
// the current run. Every line is also appended to logs/bench-history.log,
// which survives dashboard restarts (the last chunk is reloaded on boot).
let benchOutput = [];
const BENCH_OUTPUT_MAX_LINES = 4000;
let benchRunning = false;
let benchLastCommand = '';
// Telemetry during bench runs: same 1s sampler the request path uses, driven
// by an explicit timer (bench output goes quiet for minutes during deep
// prefills, so the activity-timeout sampler would stop mid-test). Snapshot on
// exit so the buffer can't bleed into the next real request's series.
let benchSampleTimer = null;
let benchLastSamples = [];
let benchLogWriteChain = Promise.resolve();
function benchLog(line) {
    benchOutput.push(line);
    if (benchOutput.length > BENCH_OUTPUT_MAX_LINES) benchOutput = benchOutput.slice(-3000);
    broadcastState(`BENCH:${line}`);
    // Serialized: parallel un-awaited appendFile calls can land OUT OF ORDER
    // in the file, which corrupted block parsing after a restart reload.
    benchLogWriteChain = benchLogWriteChain
        .then(() => fs.appendFile(path.join(LOGS_DIR, 'bench-history.log'), line + '\n'))
        .catch(() => {});
}

// --- LOCAL (NON-DOCKER) LAUNCH CONFIG ---
// dashboard.config.json is user-editable and gitignored (see dashboard.config.example.json);
// missing/invalid file silently falls back to this default. llamaServerBuilds
// is a list (not a single path) so the GUI can offer a "Build" selector for
// local-multi-gpu mode -- e.g. a Vulkan-only build vs. a combined CUDA+Vulkan
// build of the same repo, which expose different devices for the same
// physical GPUs (a CUDA-capable NVIDIA card only shows up as a native CUDA
// device when launched from a binary actually compiled with GGML_CUDA=ON).
const DEFAULT_LLAMA_SERVER_BUILDS = [
    { id: 'default', label: 'Default', path: path.join(os.homedir(), 'llama.cpp', 'build', 'bin', 'llama-server') }
];
// Launch devices (an ordered list: local GPUs and RPC workers) and RPC worker
// settings -- see lib/devices.js. Workers come from dashboard.config.json's
// `rpcWorkers` map (or the older single `rpcWorker` block).
const devicesModel = require('./lib/devices');
const telemetryModel = require('./lib/telemetry');
const benchDb = require('./lib/db');
const historyMerge = require('./lib/history'); // History's CSV + bench.sqlite merge (2026-09-30, Kyle)
const mmprojModel = require('./lib/mmproj');
const ModelName = require('./ui/shared/modelname.js'); // model display names (split suffix dropped), shared with the browser and dash-cli
const modelScan = require('./lib/modelscan');     // GET /api/models: the gguf files under the model roots (split models once, at their total size)
const webFetch = require('./lib/webfetch');
const sweepModel = require('./lib/sweep');
const suitesModel = require('./lib/suites');
const codebenchModel = require('./lib/codebench'); // quality benchmarks: spawns ~/code/codebench, reads its results (plugin seam)
const modelsModel = require('./lib/models');      // Models tab: one record per model, assembled from the CSV, llama-bench, the sweep, codebench and BEST-CONFIGS (read-only)
// GET /api/models/catalog answers from this prebuilt buffer (lib/catalogcache.js, 2026-10-06): the bytes, their
// brotli/gzip forms and an ETag, rebuilt only when lib/models.js catalogSignature() says an input changed.
// `fresh`: a build this buffer will keep must not be older than the request table (the index's own 20 s memo could be).
// Since 2026-10-21 the build runs on a worker thread (lib/catalogworker.js: the same listModels + disk sizes) and never
// inside a request once there is an answer; `build` below is the same build on this thread, used only if the worker fails.
// modelRoots() is a function declaration further down (hoisted), read per build.
const catalogWorker = require('./lib/catalogworker').createCatalogWorker({ roots: () => modelRoots() });
const modelsCatalog = require('./lib/catalogcache').createCatalogCache({
    signature: () => modelsModel.catalogSignature(),
    buildPacked: () => catalogWorker.build(),
    onError: (err) => console.warn('/api/models/catalog: worker build failed, building on the server thread:', err.message),
    build: async () => {
        let out = modelsModel.listModels({ fresh: true });
        // diskBytes for local models whose runs never recorded a model_path (lib/modelscan.js)
        try { out = modelScan.fillDiskBytes(out, await modelScan.scanModelDirs(modelRoots()), (p) => modelsModel.canonicalModel(p).key); }
        catch (err) { console.warn('/api/models/catalog: disk sizes from the model scan failed:', err.message); }
        return strengthBootModel.attach(out);   // the cached strength bootstrap, as the worker's build carries it
    },
});
const { etagMatches } = require('./lib/catalogcache');
// STRENGTH RANGES FROM A CLUSTER BOOTSTRAP (2026-10-25, Kyle: "Yes run the bootstrap"; lib/strengthboot.js): 200 refits of
// the whole fit over resampled task groups, in a child process at nice 19 on its own timer (never per result), reading
// the catalog this server already holds (peek: never a build). A new answer is cached in logs/strength-bootstrap.json
// and the catalog is rebuilt so it carries it (`strengthBootstrap`; the pages apply it in ui/shared/leaderboard.js fitFor).
const strengthBootModel = require('./lib/strengthboot');
const strengthBoot = strengthBootModel.createStrengthBoot({
    catalog: () => { const e = modelsCatalog.peek(); return e ? { body: e.body, inputs: e.sig && e.sig.inputs } : null; },
    onDone: () => { modelsCatalog.rebuild().catch((err) => console.warn('catalog rebuild after the strength bootstrap failed:', err.message)); },
});
// The page's own JS/CSS under /v/<hash>/..., immutable and never stale (lib/assets.js, 2026-10-06).
const appAssets = require('./lib/assets').createAssets(__dirname);
const ASSET_IMMUTABLE = require('./lib/assets').IMMUTABLE;
const slotsModel = require('./lib/slots');        // live rates for a llama-server we did NOT launch, from its GET /slots
const livechatModel = require('./lib/livechat');
const telemetryHistory = require('./lib/telemetryhistory').createTelemetryHistory();   // every telemetry tick since start (GET /api/telemetry/range)
const laneTps = require('./lib/lanetps');
const laneProcs = require('./lib/laneprocs');
const gpuSafety = require('./lib/gpusafety');   // 2026-10-17: what may touch the cards while the queue has work on them (no boot probe, guarded port cleanup)
const topologyModel = require('./lib/topology');   // this machine's cards (identical ones told apart), profile availability
const pathsModel = require('./lib/paths');         // ~ / ${ROOT} / modelsRoot in dashboard.config.json and profile paths
const deviceProbe = require('./lib/deviceprobe');  // when a --list-devices probe may run, and what is served when it may not
const launchGuard = require('./lib/launchguard');   // which running queue items sit on a card a launch needs
const reqTally = require('./lib/reqtally').createTally();   // what asks this server for what (GET /api/debug/requests, 2026-10-22)
const reqSamples = require('./lib/reqsamples');   // every request's telemetry series, the queue lanes' too, kept in bench.sqlite (2026-10-22)
const gateModel = require('./lib/gate');          // the tunnel gate's login: a wrong password's answer (remoteAccess.failRedirect), the page's script
const postsRepo = require('./lib/postsrepo');   // ai lab blog: the editor's read/write side (GitHub-backed), /posts   // ports held by each queue lane's process tree (lane engine discovery)   // combined live t/s across GPU lanes (GET /api/lanes/live, 2026-10-01)  // Bench -> Live's live chat: relays codebench's record-proxy --tap feed (dialled only while a client watches)
const tpsModel = require('./lib/tps');            // Bench -> Live: per-task prefill/gen t/s averages (token-weighted)
const autoqueueModel = require('./lib/autoqueue'); // Bench -> codebench -> Auto queue: planner settings, dry-run / real enqueue of generated queue scripts
const queueModel = require('./lib/queue').createQueue({ topology: () => currentTopology() }); autoqueueModel.setQueue(queueModel); // Bench -> codebench -> Queue: benchmark queue rows in bench.sqlite (run by codebench/tools/queue_runner.py); Auto queue enqueues into it
// Auto queue continuous refill (lib/autoqueue.js refill, 2026-10-15): OFF unless logs/autoqueue.json says refill.enabled with
// lanes listed; the timer only looks at the settings once a minute. The planner runs on the Models catalog's prebuilt answer.
// The same timer runs the lane FLOOR (2026-10-21) when floor.enabled: every lane under floor.hours of work gets some.
let aqCatalogMemo = { etag: null, obj: null };
async function aqCatalog() {
    const { entry } = await modelsCatalog.get();
    if (aqCatalogMemo.etag !== entry.etag) aqCatalogMemo = { etag: entry.etag, obj: JSON.parse(entry.body.toString('utf-8')) };
    return aqCatalogMemo.obj;
}
const aqRefillTimer = autoqueueModel.startRefillTimer({ catalog: aqCatalog });
const strataModel = require('./lib/strata'); // Strata engine (Qwen3.8-Flash-Next IQ3_XXS / coder IQ1_M): base configs + GUI-override merge, launched via queue-serve.sh
codebenchModel.broadcast = (payload) => { const data = JSON.stringify({ state: serverState, model: currentModel, isRpc, log: '', error: '', loadStartTime, startedAt: serverStartedAt, finalLoadTime, launchCommand: currentLaunchCommand, launchConfig: currentLaunchConfig, codebench: JSON.parse(payload) }); for (const c of clients) { try { c.write(`event: codebench\ndata: ${data}\n\n`); } catch { /* reaped by the heartbeat */ } } }; // named SSE event (browser onmessage never sees it; lib/sweep.js skips non-`data:` frames) wrapped in the normal state envelope so dash-cli, which reads every data: line as state, is not blanked by it
// lib/runlabel.js names no card itself: ids are named from each record's machine, this machine's device list, then
// dashboard.config.json `deviceNames` (set in loadDashboardConfig) for cards that have left the machine. The device
// list it is given comes from the CACHE only (cachedDetected): naming a recorded run must never spawn a binary --
// the Models catalog describes every launch command in the request log, most of them of builds long gone.
codebenchModel.setDeviceResolver((binary) => cachedDetected(binary)); // Live view: name device ids after the card they are on in THIS machine
const applyRunLabelNames = () => require('./lib/runlabel').configure({ detected: (binary) => cachedDetected(binary), cardNames: dashboardConfig.deviceNames || null });
sweepModel.port = PORT; // lib/sweep talks to this server over loopback
const DASHBOARD_CONFIG_FILE = path.join(__dirname, 'dashboard.config.json');
let dashboardConfig = { llamaServerBuilds: DEFAULT_LLAMA_SERVER_BUILDS, rpcWorkers: {} };
// The path roots of dashboard.config.json (lib/paths.js): `~`, `${NAME}` from `pathRoots` or the environment, and
// `modelsRoot`. Every path the config or a profile gives THIS machine goes through expandPath; a path that starts
// with "/" comes back as it went in. (rpcWorkers `binary` / `logFile` do not: they are paths on the worker.)
let pathCtx = pathsModel.context({});
const expandPath = (p) => pathsModel.expand(p, pathCtx);

// A build entry is usable only if it carries a non-empty binary path --
// dashboard.config.json is user-editable, and a half-deleted entry must not
// corrupt the build list (see getLlamaServerBinary below).
function isValidBuild(b) {
    return b && typeof b.path === 'string' && b.path.trim().length > 0;
}

async function loadDashboardConfig() {
    try {
        const parsed = JSON.parse(await fs.readFile(DASHBOARD_CONFIG_FILE, 'utf-8'));
        pathCtx = pathsModel.context(parsed);
        let builds = null;
        if (Array.isArray(parsed.llamaServerBuilds)) {
            builds = parsed.llamaServerBuilds.filter(isValidBuild).map((b) => ({ ...b, path: expandPath(b.path.trim()) }));
        } else if (typeof parsed.llamaServerBinary === 'string' && parsed.llamaServerBinary.trim() !== '') {
            // Old single-path config format, from before builds existed --
            // wrap it as a one-item build list rather than requiring every
            // existing dashboard.config.json to be hand-migrated.
            builds = [{ id: 'default', label: 'Default', path: expandPath(parsed.llamaServerBinary.trim()) }];
        }
        if (builds && builds.length > 0) {
            dashboardConfig.llamaServerBuilds = builds;
        }
        dashboardConfig.rpcWorkers = devicesModel.workersFromConfig(parsed);
        if (typeof parsed.llamaHost === 'string') {
            dashboardConfig.llamaHost = parsed.llamaHost;
        }
        if (parsed.remoteAccess && typeof parsed.remoteAccess === 'object') {
            dashboardConfig.remoteAccess = parsed.remoteAccess;
        }
        if (Number.isInteger(parsed.liveChatTapPort) && parsed.liveChatTapPort > 0) {
            dashboardConfig.liveChatTapPort = parsed.liveChatTapPort;
        }
        // Extra model roots for GET /api/models, scanned after the built-in ones (see modelRoots).
        if (Array.isArray(parsed.modelDirs)) {
            dashboardConfig.modelDirs = parsed.modelDirs.filter((d) => typeof d === 'string' && d.trim()).map((d) => expandPath(d.trim()));
        }
        // `modelsRoot`: where this machine keeps its models. Scanned like a modelDirs entry, and what a relative or
        // `${MODELS}/...` model path in a profile is under.
        if (pathCtx.modelsRoot) dashboardConfig.modelsRoot = pathCtx.modelsRoot;
        // Names for device ids that recorded runs use but this machine can no longer name (a card that has since
        // been taken out): { "CUDA": "NVIDIA GeForce RTX 3060" }, keyed by id or by backend. Display only.
        if (parsed.deviceNames && typeof parsed.deviceNames === 'object' && !Array.isArray(parsed.deviceNames)) {
            dashboardConfig.deviceNames = Object.fromEntries(Object.entries(parsed.deviceNames).filter(([k, v]) => /^[A-Za-z]+\d*$/.test(k) && typeof v === 'string' && v.trim()));
        }
    } catch {
        // missing/invalid config file -- keep the default
    }
    applyRunLabelNames();
}

// llama-server's listen address. Loopback by default: other machines reach it
// through Tailscale (`tailscale serve --tcp 8080`), not the LAN. Set
// dashboard.config.json `llamaHost` (e.g. "0.0.0.0") to expose it directly.
function getLlamaHost() {
    const h = dashboardConfig.llamaHost;
    return typeof h === 'string' && h.trim() !== '' ? h.trim() : '127.0.0.1';
}

function getLlamaServerBuilds() {
    return dashboardConfig.llamaServerBuilds;
}

// --- RPC WORKERS ---
// A worker is referenced by its rpcWorkers name (profiles, `devices` entries)
// or by an ssh target (the web/CLI worker field, old rpcTarget values).
function resolveWorker(ref) {
    const w = devicesModel.findWorker(dashboardConfig.rpcWorkers, String(ref || '').trim());
    if (!w) throw new Error(`Unknown RPC worker "${ref}"`);
    return w;
}

// Configured workers for the clients' pickers; an invalid entry is listed
// with its error rather than hidden.
function listRpcWorkers() {
    return Object.keys(dashboardConfig.rpcWorkers).map((name) => {
        try {
            const w = resolveWorker(name);
            return { name, ssh: w.ssh, port: w.port, devices: w.devices, deviceCount: w.deviceCount, cache: w.cache, link: w.link };
        } catch (err) {
            return { name, error: err.message };
        }
    });
}

// What --rpc dials for a worker: this machine's end of its ssh forward, or the
// worker itself.
function rpcEndpointFor(w) {
    return w.link === 'ssh' ? `127.0.0.1:${w.localPort}` : `${hostFromRpcTarget(w.ssh)}:${w.port}`;
}

// /api/worker/* bodies name the worker as `worker` (an rpcWorkers name) or
// `worker_ssh` (an ssh target, as the web and CLI worker fields send). Throws
// with a message fit for the response.
function workerFromBody(body) {
    const ref = (body && (body.worker || body.worker_ssh)) || '';
    if (!String(ref).trim()) throw new Error('Missing worker (or worker_ssh)');
    return resolveWorker(ref);
}

// --- RPC WORKER CONTROL (over SSH) ---
// Shared by the /api/worker/* endpoints and /api/start's auto-start. Each
// takes a validated worker (resolveWorker, or a planDevices worker entry).
async function startRpcWorker(w) {
    // setsid+nohup with every fd redirected detaches the server so the SSH
    // session can return. The `&` must background ONLY that command:
    // `mkdir && setsid ... &` backgrounds the whole list in a subshell that
    // keeps SSH's stdout open, and SSH never exits. The short wait catches a
    // binary that dies on startup (bad -d device, port in use) and reports its
    // log tail as the error.
    const devArg = w.devices ? ` -d ${w.devices}` : '';
    const cacheArg = w.cache ? ' -c' : '';
    // A worker already listening on the wrong address (link mode changed) is
    // restarted rather than reported as running.
    const cmd = `pgrep -a -x ${w.procName} | grep -q -- "-H ${w.bindHost} " && { echo "already running"; exit 0; }; ` +
        `pkill -x ${w.procName} && sleep 1; ` +
        `mkdir -p "$(dirname ${w.logFile})" || exit 1; ` +
        `setsid nohup ${w.binary} -H ${w.bindHost} -p ${w.port}${devArg}${cacheArg} </dev/null >${w.logFile} 2>&1 & ` +
        `sleep 3; pgrep -x ${w.procName} >/dev/null || { echo "rpc-server exited on startup:" >&2; tail -n 20 ${w.logFile} >&2; exit 1; }`;
    return runSSHCommand(w.ssh, cmd);
}

async function stopRpcWorker(w) {
    const cmd = `pkill -x ${w.procName}; for i in 1 2 3 4 5 6; do pgrep -x ${w.procName} >/dev/null || exit 0; sleep 0.5; done; ` +
        `pkill -9 -x ${w.procName}; exit 0`;
    return runSSHCommand(w.ssh, cmd);
}

// 'offline' means SSH itself failed (host down, off the network, bad key).
async function getRpcWorkerStatus(w) {
    try {
        const { stdout } = await runSSHCommand(w.ssh, `pgrep -x ${w.procName} >/dev/null && echo running || echo stopped`);
        return { status: stdout.trim() === 'running' ? 'running' : 'stopped' };
    } catch (err) {
        return { status: 'offline', error: err.message };
    }
}

async function getRpcWorkerLogs(w) {
    const { stdout, stderr } = await runSSHCommand(w.ssh, `tail -n 50 ${w.logFile} 2>/dev/null || echo "no rpc-server log yet (${w.logFile})"`);
    return stdout || stderr || 'No logs available.';
}

function probeTcp(host, port, timeoutMs) {
    return new Promise((resolve) => {
        const sock = require('net').connect({ host, port });
        const done = (ok) => { sock.destroy(); resolve(ok); };
        sock.setTimeout(timeoutMs, () => done(false));
        sock.once('connect', () => done(true));
        sock.once('error', () => done(false));
    });
}

// The `ssh -L` forwards for link 'ssh', one per worker, owned by the dashboard.
const rpcTunnels = new Map(); // worker name -> { proc, key }

function closeRpcTunnel(name) {
    const t = rpcTunnels.get(name);
    if (!t) return;
    try { t.proc.kill('SIGTERM'); } catch { /* already gone */ }
    rpcTunnels.delete(name);
}

function closeAllRpcTunnels() {
    for (const name of [...rpcTunnels.keys()]) closeRpcTunnel(name);
}
process.on('exit', closeAllRpcTunnels);

async function ensureRpcTunnel(w) {
    // Reused only while it still forwards to the same place.
    const key = `${w.ssh}|${w.localPort}|${w.port}`;
    const existing = rpcTunnels.get(w.name);
    if (existing && existing.key === key && existing.proc.exitCode === null) return;
    closeRpcTunnel(w.name);
    const sshTarget = w.ssh;
    // ExitOnForwardFailure: a local port that's already taken must fail the
    // tunnel, not leave llama-server dialing whatever else holds it.
    const proc = spawn('ssh', ['-N', '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
        '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=10', '-o', 'ServerAliveCountMax=3',
        '-L', `127.0.0.1:${w.localPort}:127.0.0.1:${w.port}`, sshTarget], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    proc.stderr.on('data', (d) => { stderr += d; });
    proc.on('error', () => { /* surfaced through exitCode below */ });
    proc.on('exit', (code) => {
        const cur = rpcTunnels.get(w.name);
        if (cur && cur.proc === proc) rpcTunnels.delete(w.name);
        console.log(`RPC ssh tunnel to ${w.name} (${sshTarget}) closed (code ${code})${stderr.trim() ? ': ' + stderr.trim() : ''}`);
    });
    rpcTunnels.set(w.name, { proc, key });
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        if (proc.exitCode !== null) break;
        if (await probeTcp('127.0.0.1', w.localPort, 1000)) {
            // Give ExitOnForwardFailure a moment to fire on a taken port.
            await new Promise((r) => setTimeout(r, 300));
            if (proc.exitCode === null) return;
            break;
        }
        await new Promise((r) => setTimeout(r, 300));
    }
    closeRpcTunnel(w.name);
    throw new Error(`ssh tunnel to ${sshTarget} failed${stderr.trim() ? ': ' + stderr.trim() : ' (timed out)'}`);
}

// Make sure a worker is serving before llama-server dials it, so booting a
// config (or profile) with workers is one click. For link 'direct',
// reachability is probed (over Wi-Fi the process can be up while the port
// isn't reachable); for link 'ssh', a live forward plus a running worker is
// the check.
async function ensureRpcWorker(w, onStatus) {
    if (w.link === 'ssh') {
        onStatus(`RPC worker ${w.name}: checking ggml-rpc-server on ${w.ssh}`);
        await startRpcWorker(w);
        await ensureRpcTunnel(w);
        return;
    }
    const host = hostFromRpcTarget(w.ssh);
    if (await probeTcp(host, w.port, 3000)) return;
    onStatus(`RPC worker ${w.name}: starting ggml-rpc-server on ${w.ssh}`);
    await startRpcWorker(w);
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
        if (await probeTcp(host, w.port, 3000)) return;
        await new Promise((r) => setTimeout(r, 500));
    }
    throw new Error(`RPC worker ${w.name} started on ${w.ssh}, but ${host}:${w.port} is not reachable from this machine`);
}

// Resolves a build id to its binary path, falling back to the first
// configured build if the id is missing/unknown -- e.g. a saved profile or
// restored launch config from before builds existed (no `build` field at
// all), or a stale id left over after dashboard.config.json was edited to
// remove a build.
function getLlamaServerBinary(buildId) {
    const builds = getLlamaServerBuilds();
    if (!builds || builds.length === 0) {
        throw new Error('No valid llama-server builds configured');
    }
    const found = buildId ? builds.find(b => b.id === buildId) : null;
    return (found || builds[0]).path;
}

// The llama-server binary a launch ACTUALLY runs. A raw-command launch (every launch sweep, every
// script-style line) names its binary in the command and carries no `build` field, and falling back
// to builds[0] meant looking up the WRONG build's --list-devices (build-next: CUDA + Vulkan, no
// ROCm0) -- so ROCm0 never got a card name, never matched the XTX reading, and the CLI drew it
// "offline" for every such launch. The command wins; `build` is the fallback.
function launchBinaryOf(config, command) {
    const cmd = command || (config && config.rawCommand) || '';
    const m = /(^|\s)(\/\S*llama-server)(?=\s|$)/.exec(String(cmd));
    if (m) return m[2];
    return getLlamaServerBinary(config && config.build);
}
// --list-devices per build binary, and the one rule for when that probe may run (lib/deviceprobe.js): at boot, on an
// explicit refresh, or while nothing is on a local card. A probe initialises every backend on every card, and one
// that landed mid-decode stalled a two-card engine three times on 2026-10-12 -- so everything that wants a device
// list goes through this cache, and a reader that meets a binary it has no listing of (`detectedFor`: a build first
// seen in a raw command, a build whose boot probe timed out) gets a probe only when the cards are free.
// The good listings are kept in the dashboard's own logs/ (beside lib-stamp.json), so a restart can serve them too.
const DEVICE_CACHE_FILE = path.join(__dirname, 'logs', 'device-cache.json');
const deviceCache = deviceProbe.createDeviceCache({ probe: (binary) => probeDevices(binary), busy: () => localCardsBusy(), hardBusy: () => queueHardBusy(),
    onChange: (snap) => { fs.mkdir(path.dirname(DEVICE_CACHE_FILE), { recursive: true }).then(() => fs.writeFile(DEVICE_CACHE_FILE, JSON.stringify(snap))).catch(() => {}); } });
function detectedFor(binary) {
    const hit = deviceCache.get(binary);
    if (!hit && binary) deviceCache.touch(binary);
    return hit || null;
}
// Why a probe should not run now (null = the local cards are free): this dashboard's own server or benchmark, a
// running queue item on a local lane, another server on the managed port, or a card that is visibly loaded -- the
// last is what sees a sweep script or any other tool the dashboard did not start.
function localCardsBusy() {
    let runningItems = [];
    try { runningItems = Object.values(laneInfo().running || {}); } catch { runningItems = []; }
    // 2026-10-17: right after a start there are no readings yet, and the readings are what see work nothing here started
    if (!lastServerTelemetry) return 'no telemetry reading yet';
    // the last telemetry tick's readings of THIS machine's cards (already labelled; a worker's cards are not ours)
    const gpus = ((lastServerTelemetry && lastServerTelemetry.stats && lastServerTelemetry.stats.gpus) || []).filter((g) => g && (g.host || 'local') === 'local');
    return deviceProbe.busyReason({ ownServer: !!llamaProcess, pending: !!launchPending, bench: !!benchProcess, external: externalSource, runningItems, gpus });
}

// The hard rule (lib/gpusafety.js): the queue has work on this machine's cards -- a running local-lane item in the
// queue database, a local lane's runner with processes under it (from /proc: also a lane still loading its engine),
// a battery holding the 8080 lock, or a queue database that could not be read. No probe runs then, "probe now"
// included. Cached 3 s (the readers are telemetry ticks and device-table requests).
let hardBusyCache = { at: 0, why: null };
function queueHardBusy() {
    if (Date.now() - hardBusyCache.at < 3000) return hardBusyCache.why;
    let why;
    try {
        const info = laneInfo();
        let lockHeld = false;
        try { lockHeld = require('child_process').spawnSync('flock', ['-n', '/tmp/codebench-lldash.lock', 'true'], { timeout: 2000 }).status === 1; } catch { lockHeld = false; }
        why = gpuSafety.hardBusyReason({ runningItems: Object.values(info.running || {}), queueWork: gpuSafety.localQueueWork(laneProcs.readProcs()), lockHeld, queueUnread: info.ok === false });
    } catch (err) {
        why = `the queue state could not be read (${err.message})`;
    }
    hardBusyCache = { at: Date.now(), why };
    return why;
}


// Running queue items on a card this launch needs (lib/launchguard.js). [] when free or when the queue cannot be read.
function launchConflicts(command, args, devices) {
    const info = laneInfo();
    const topology = currentTopology(/(^|\/)llama-server$/.test(String(command || '')) ? command : null);
    return launchGuard.conflicts(launchGuard.neededCards({ command, args, devices, topology }), launchGuard.busyCards(Object.values(info.running || {}), info.runtimes || {}, topology));
}
function launchBusy(command, args, devices) {
    try { return launchConflicts(command, args, devices).map(({ cardKey, ...b }) => b); } catch { return []; }
}

// The cached --list-devices of a build, else the fullest cached listing (ids mean the same card in every build of
// one machine; a build just sees more or fewer backends). Never probes. null before the first probe has answered.
function cachedDetected(binary) {
    const own = binary ? deviceCache.get(binary) : null;
    if (own && own.length) return own;
    return deviceCache.fullest();
}

// This machine as lib/topology.js sees it: the cards of the given build's --list-devices (cached), or, with no build,
// of the richest cached listing (the build that sees the most devices sees every card through some backend).
function currentTopology(binary) {
    let detected = binary ? detectedFor(binary) : null;
    if (!detected || !detected.length) detected = deviceCache.fullest();
    let workers = [];
    try { workers = listRpcWorkers().filter((w) => !w.error); } catch { workers = []; }
    return topologyModel.build({ detected: detected || [], hostRamMib: os.totalmem() / 1048576, workers });
}
// A Strata config that lists GPU 1 needs two cards, whatever the profile's own `needs` says (or does not say): the
// engine counts GPUs by position, and strataPlanDevices would otherwise map an index this machine lacks onto card 0.
// -> the config with `needs.minCards` raised to what its `gpu` list (or `--gpu`) asks for; untouched for any other engine.
function withStrataNeeds(cfg, args) {
    if (!cfg || cfg.engine !== 'strata') return cfg;
    let idx = [];
    try { idx = strataModel.gpuIndexes(args); } catch { idx = []; }
    if (!idx.length) return cfg;
    const want = Math.max(...idx) + 1;
    const needs = cfg.needs && typeof cfg.needs === 'object' ? cfg.needs : {};
    return (Number(needs.minCards) || 1) >= want ? cfg : { ...cfg, needs: { ...needs, minCards: want } };
}
// Every saved profile's fit on this machine: { <name>: { status, reason, placement } } (lib/topology.js availability).
function profileAvailability(doc) {
    const out = {};
    for (const [name, p] of Object.entries((doc && doc.profiles) || {})) {
        try {
            const cfg = (p && p.config) || {};
            let binary = null;
            try { binary = cfg.engine && cfg.engine !== 'llama' ? null : launchBinaryOf(cfg); } catch { binary = null; }
            // a Strata profile's cards: its base file's "gpu", or its own `gpu` override (lib/strata.js availabilityArgs)
            const strataArgs = cfg.engine === 'strata' ? strataModel.availabilityArgs(cfg) : [];
            const { status, reason, placement, devices } = topologyModel.availability(withStrataNeeds(cfg, strataArgs), currentTopology(binary), { reference: currentTopology() });
            out[name] = { status, reason, placement };
            if (cfg.engine === 'strata' && status !== 'unavailable' && cfg.strataBase) {
                const sd = strataPlanDevices(strataArgs);
                if (sd.length) out[name].placement = topologyModel.placementLabel(sd, currentTopology());
            }
            // the device list re-pointed at this machine, for a client to load instead of the saved one
            if (devices && (status === 'moved' || status === 'substitute')) out[name].devices = devices;
        } catch (err) { out[name] = { status: 'ready', reason: '', placement: null }; }
    }
    return out;
}

// One `--list-devices` run. Only lib/deviceprobe.js calls this (deviceCache): it decides when, and keeps the result.
async function probeDevices(binary) {
    // Hard timeout: device enumeration talks to the Vulkan/CUDA loader, which
    // can hang (e.g. a TB4 eGPU in a bad power/link state).
    //
    // NO DISPLAY FOR THE PROBE. Vulkan enumeration blocks when it can REACH an
    // X display -- not when it cannot. This server runs from pm2 with DISPLAY
    // inherited from whatever session saved the dump, so for as long as nobody
    // was logged in graphically the probe connected to nothing, failed
    // instantly and listed every card. The moment `systemctl start gdm3` put a
    // real :1 up (19 Sep 2026, 14:40), every Vulkan-carrying build started
    // timing out here and /api/devices went empty -- which reads in the UI as
    // "the desktop card is gone", leaving only the RPC workers. Listing
    // devices never needs a display, so it does not get one.
    const probeEnv = { ...process.env };
    delete probeEnv.DISPLAY;
    delete probeEnv.WAYLAND_DISPLAY;
    const { stdout } = await execFileAsync(binary, ['--list-devices'], { timeout: 8000, maxBuffer: 1024 * 1024, env: probeEnv });
    const devices = [];
    const lineRe = /^(\S+):\s*(.+?)\s*\((\d+) MiB, (\d+) MiB free\)$/;
    for (const rawLine of stdout.split('\n')) {
        const m = rawLine.trim().match(lineRe);
        if (m) devices.push({ id: m[1], description: m[2], totalMib: parseInt(m[3], 10), freeMib: parseInt(m[4], 10) });
    }
    return devices;
}

// In-memory ring buffer for master logs (last 500 lines) — sidesteps the
// docker compose run --rm one-off container issue (see dashboard-bugs1-analysis.md item 5)
let masterLogBuffer = [];
const MASTER_LOG_BUFFER_SIZE = 500;

// --- PATH HELPERS ---
const HF_CACHE_DIR = process.env.HF_HOME || process.env.HUGGINGFACE_HUB_CACHE || path.join(os.homedir(), '.cache', 'huggingface', 'hub');

// --- SAFE SSE BROADCAST ---
function broadcastState(logLine = '', errorMessage = '') {
    if (typeof ensureLoopbackBridge === 'function') {
        if (serverState === 'ready') ensureLoopbackBridge();
        else closeLoopbackBridge();
    }
    // `external` is non-null only while an unmanaged llama-server on :8080 is
    // being polled (see pollExternalSlots) -- serverState stays 'stopped' then,
    // so clients use it to tell "nothing running" from "someone else's server".
    const payload = JSON.stringify({ state: serverState, model: currentModel, isRpc, log: logLine, error: errorMessage, loadStartTime, startedAt: serverStartedAt, finalLoadTime, launchCommand: currentLaunchCommand, launchConfig: currentLaunchConfig, external: externalSlotsEligible() ? externalSource : null });
    const deadClients = [];
    for (const client of clients) {
        try {
            client.write(`data: ${payload}\n\n`);
        } catch (err) {
            deadClients.push(client);
        }
    }
    clients = clients.filter(c => !deadClients.includes(c));
}

// --- PER-TASK T/S (lib/tps.js) ---
// Every finished request's prefill/gen numbers go to the accumulator of the task running when it
// ended: exact llama-server timings from the tap while the live-chat relay has it dialled, else the
// /slots poll's `finished` request (pollExternalSlots) -- one source per request, never both. In
// memory, so a page reload keeps it and a dashboard restart does not; tasks with nothing here fall
// back to the request log over their time window (dbTaskTps), cached TPS_DB_TTL_MS because
// queue-launched servers' rows only arrive when codebench's db-import-llama-logs.py runs.
const taskTps = tpsModel.createBook();
const TPS_DB_TTL_MS = 60000;
const tpsDbCache = new Map();   // task key -> { at, val }
// Only a battery whose agent talks to the local server (`llama-local/...`) owns its requests: a
// cloud battery (claude/haiku) can run beside it, and adoption shows the NEWEST battery, which
// may be the cloud one -- then the local battery is looked up on its own (scan cached 10 s).
const isLocalBattery = (l) => !!(l && l.battery && l.battery.config && /^llama-local\//.test(l.battery.config.model || ''));
let localLiveCache = { at: 0, l: null };
function localBatteryLive() {
    const l = codebenchModel.live({ maxAgeMs: Infinity });   // the cached transcript tail is fine: only the labels are needed
    if (isLocalBattery(l)) return l;
    if (Date.now() - localLiveCache.at < 10000) return localLiveCache.l;
    let other = null;
    try {
        const rec = codebenchModel.scanBatteries().find((r) => r.adoptable && /^llama-local\//.test((r.battery && r.battery.model) || ''));
        other = rec ? codebenchModel.adoptedLive(rec) : null;
    } catch { other = null; }
    localLiveCache = { at: Date.now(), l: other };
    return other;
}
function runningTaskKey() {
    if (laneInfo().running['local-gpu']) return laneTaskKey('local-gpu');   // the default tap / external server is the local-gpu lane's
    const l = localBatteryLive();
    const c = l && l.running ? l.current : null;
    return c && l.battery && l.battery.name ? tpsModel.taskKey(l.battery.name, c.task, c.run) : null;
}
const isoSec = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');   // `completed_at` is stored without ms
function dbTaskTps(key, windowFn) {
    const hit = tpsDbCache.get(key);
    if (hit && Date.now() - hit.at < TPS_DB_TTL_MS) return hit.val;
    let val = null;
    const w = windowFn();
    if (w && w.from && w.to >= w.from) {
        const rows = benchDb.requestsBetween(isoSec(w.from - 1000), isoSec(w.to + 5000));
        val = rows ? tpsModel.fromRows(tpsModel.rowsForModel(rows, w.modelPath)) : null;
    }
    tpsDbCache.set(key, { at: Date.now(), val });
    if (tpsDbCache.size > 500) tpsDbCache.delete(tpsDbCache.keys().next().value);
    return val;
}
// A finished task's window and server, from its result JSON: manifest.started_at + run.wall_s.
const fsSync = require('fs');   // one small read per task per TPS_DB_TTL_MS, on a cache miss only
function resultWindow(outDir, task, run) {
    if (!outDir) return null;
    const f = path.join(outDir, run > 1 ? `${task}__r${run}.json` : `${task}.json`);
    try {
        const d = JSON.parse(fsSync.readFileSync(f, 'utf-8'));
        const wall = Number(d.run && d.run.wall_s) || 0;
        const from = Date.parse((d.manifest || {}).started_at) || (fsSync.statSync(f).mtimeMs - wall * 1000);
        return { from, to: from + wall * 1000, modelPath: (d.server || {}).model_path || null };
    } catch { return null; }
}
// {"task#run": {pp, gen, n, src, ...} | null} for the battery in `l` (codebenchModel.live()).
function codebenchTps(l) {
    if (!l || !l.battery || !l.battery.name || !isLocalBattery(l)) return null;   // a cloud battery's requests never reach this server
    const name = l.battery.name, out = {};
    const one = (task, run, windowFn) => {
        const key = tpsModel.taskKey(name, task, run);
        out[`${task}#${run || 1}`] = taskTps.get(key) || dbTaskTps(key, windowFn);
    };
    const c = l.running ? l.current : null;
    for (const t of l.tasks || []) {
        if (t.status === 'running' || (c && t.task === c.task && (t.run || 1) === (c.run || 1))) continue;
        one(t.task, t.run, () => resultWindow(l.outDir || l.battery.out, t.task, t.run || 1));
    }
    if (c) one(c.task, c.run, () => {
        if (!c.startedAt) return null;
        // The running task's server: the external one only for the local-gpu lane; another lane's from a finished
        // task of the same battery. Unknown -> no window (a null model filter would mix in every lane's requests).
        const lane = laneOfBattery(name);
        let modelPath = null;
        if (!lane || lane === 'local-gpu') modelPath = externalSource && externalSource.modelPath;
        else for (const t of l.tasks || []) {
            if (t.status === 'running') continue;
            const w = resultWindow(l.outDir || l.battery.out, t.task, t.run || 1);
            if (w && w.modelPath) { modelPath = w.modelPath; break; }
        }
        return modelPath ? { from: c.startedAt, to: Date.now(), modelPath } : null;
    });
    return out;
}

// --- LIVE CHAT per GPU lane (2026-09-30) ---
// Every GPU queue lane (codebench tools/queue_runner.py: local-gpu plus one lane per card or remote machine) runs its own
// record-proxy with its own tap port, published in queue_lanes.runtime_json. /api/livechat?battery=<dir> dials
// the tap of that battery's lane; without ?battery= (or for local-gpu) it is the original relay below.
// `runtimes` (whole runtime_json) and the running item's id added 2026-10-01 for /api/lanes/live: its
// lane labels use runtime.gpu, its engine probe goes to runtime.server_port, and a new item id resets
// that lane's meter (a different model's rates must not linger).
const laneInfoCache = { at: 0, taps: {}, running: {}, runtimes: {} };
function laneInfo() {
    if (Date.now() - laneInfoCache.at < 5000) return laneInfoCache;
    const taps = {}, running = {}, runtimes = {};
    let ok = true;   // false: the queue database is there but could not be read (lib/gpusafety.js reads that as busy)
    try {
        const Database = require('better-sqlite3');
        const ro = new Database(benchDb.DB_PATH, { readonly: true, fileMustExist: true });
        try {
            const cols = ro.prepare('PRAGMA table_info(queue_lanes)').all().map((c) => c.name);
            if (cols.includes('runtime_json')) for (const r of ro.prepare('SELECT lane, runtime_json FROM queue_lanes').all()) {
                let j = {}; try { j = JSON.parse(r.runtime_json || '{}') || {}; } catch { j = {}; }
                if (Number(j.tap_port)) taps[r.lane] = Number(j.tap_port);
                runtimes[r.lane] = j;
            }
            for (const r of ro.prepare("SELECT id, lane, label, model, launch_cmd, env_json FROM queue_items WHERE status='running'").all()) running[r.lane] = r;
        } finally { ro.close(); }
    } catch { ok = !fsSync.existsSync(benchDb.DB_PATH); /* no db: default relay only */ }
    Object.assign(laneInfoCache, { at: Date.now(), taps, running, runtimes, ok });
    return laneInfoCache;
}
function laneOfBattery(dir) {
    if (!dir) return null;
    for (const [lane, r] of Object.entries(laneInfo().running)) if (r.label === dir) return lane;
    try {
        const Database = require('better-sqlite3');
        const ro = new Database(benchDb.DB_PATH, { readonly: true, fileMustExist: true });
        try { const r = ro.prepare('SELECT lane FROM queue_items WHERE label=? ORDER BY id DESC LIMIT 1').get(dir); return r ? r.lane : null; } finally { ro.close(); }
    } catch { return null; }
}
// The task key of the battery a lane is running now (2026-10-01: with two GPU lanes the NEWEST local battery is not
// necessarily the one a tap's request came from -- the XTX's Strata timings were landing on the 3060's task).
function laneTaskKey(lane) {
    const l = laneBatteryLive(lane);
    const c = l && l.running ? l.current : null;
    return c && l.battery && l.battery.name ? tpsModel.taskKey(l.battery.name, c.task, c.run) : null;
}
// The battery a lane is running now, as lib/codebench.js's live state (null: fall back to the old guess).
function laneBatteryLive(lane) {
    const r = laneInfo().running[lane];
    if (!r || !r.label) return null;
    try { const rec = codebenchModel.scanBatteries().find((x) => x.dir === r.label); return rec ? codebenchModel.adoptedLive(rec) : null; } catch { return null; }
}
function chatCtx(l) {
    const c = l && l.current;
    const cfg = l && l.battery && l.battery.config ? l.battery.config : {};
    return {
        battery: l && l.running && l.battery ? l.battery.name : null,
        runner: cfg.runner || null, scaffold: cfg.scaffold || null, agentModel: cfg.model || null,
        task: c ? c.task : null, run: c ? c.run : null, of: c ? c.of : null, index: c ? c.index : null, total: c ? c.total : null,
        done: l ? l.done : null, planned: l ? l.total : null,
    };
}
const laneRelays = new Map();   // tap port -> relay, for lanes other than the default tap
// --- PER-REQUEST SAMPLES FOR EVERY LANE (lib/reqsamples.js, 2026-10-22) ---
// Kyle: "in monitor, 'no telemetry samples for this request', always...". A lane's rows (LANE_COMPLETION) had no run id
// and nothing recorded their progress; the only series were those of a server this dashboard launched, 30 of them, in
// memory. Each lane request now gets one: its tap frames open and close it, the telemetry loop appends the lane's live
// record (lanesLive(): the same records the sidebar, Monitor's lane lines and the Live view's strip read) every tick,
// and the store keeps them in bench.sqlite (request_samples), flushed every FLUSH_MS, bounded by count and age.
const laneRequests = reqSamples.createRecorder();
const requestSamplesStore = reqSamples.createStore({ db: () => benchDb.open(), warn: (m) => console.error(m) });
setInterval(() => { if (requestSamplesStore.pendingCount()) requestSamplesStore.flush(); }, reqSamples.FLUSH_MS).unref();
// The queue lane the default tap (18090) belongs to: the one running an item with that tap port, or null.
function defaultTapLane() {
    const info = laneInfo();
    return Object.keys(info.running).find((l) => info.taps[l] === defaultTapPort()) || null;
}
// What a lane request's series is labelled with when it starts or ends: its queue item and engine, and its cards' readings.
function laneRequestCtx(lane) {
    const item = laneInfo().running[lane] || {};
    const eng = laneEngine.get(lane);
    return { itemId: item.id ?? null, label: item.label || null, engine: (eng && eng.engine) || null,
        devices: laneDeviceReadings(lane, lastServerTelemetry && lastServerTelemetry.stats) };
}
// One frame from a lane's record-proxy tap, either relay kind: the lane's meter, its request series, and on an edge (a
// request sent, its first token, its end: lib/lanetps.js feed) the lanes tick pushed now, not on the next 1 s tick.
function onLaneTapEvent(lane, port, ev) {
    const now = Date.now();
    const edge = laneMeter(port).feed(ev, now);
    if (lane && ev && ev.type === 'request') laneRequests.begin(lane, ev, laneRequestCtx(lane), now);
    if (edge) lanesEdge();
}
// One lib/lanetps.js meter per tap port, fed by that port's relay (onEvent) -- the same single tap
// connection the live chat uses, so watching the chat and the combined t/s never dial a tap twice.
const laneMeters = new Map();
const defaultTapPort = () => dashboardConfig.liveChatTapPort || livechatModel.DEFAULT_TAP_PORT;
function laneMeter(port) {
    if (!laneMeters.has(port)) laneMeters.set(port, laneTps.createLaneMeter());
    return laneMeters.get(port);
}
// Split out of relayForBattery 2026-10-01 so /api/lanes/live can reach a lane's relay by lane name.
function relayForLane(lane) {
    const port = lane ? laneInfo().taps[lane] : null;
    if (!port || port === defaultTapPort()) return liveChat;
    if (!laneRelays.has(port)) {
        laneRelays.set(port, livechatModel.createRelay({
            port, log: (m) => console.log(`[${lane}] ${m}`),
            onEvent: (ev) => onLaneTapEvent(lane, port, ev),
            onEnd: (ev) => { taskTps.addTimings(laneTaskKey(lane), ev.timings, 'tap'); broadcastLaneCompletion(lane, ev); },
            getCtx: () => { const l = laneBatteryLive(lane); return { model: null, lane, ...chatCtx(l) }; },
        }));
    }
    return laneRelays.get(port);
}
function relayForBattery(dir) {
    return relayForLane(laneOfBattery(dir));
}

// --- LIVE CHAT (lib/livechat.js) ---
// Labels for the chat header: which battery/task is running (lib/codebench.js's live state,
// throttled there) and which model the external server has loaded.
const liveChat = livechatModel.createRelay({
    port: () => dashboardConfig.liveChatTapPort || livechatModel.DEFAULT_TAP_PORT,   // dashboard.config.json `liveChatTapPort`, read per dial
    log: (m) => console.log(m),
    onEvent: (ev) => onLaneTapEvent(defaultTapLane(), defaultTapPort(), ev),   // the local-gpu lane's meter (lib/lanetps.js) and request series
    onEnd: (ev) => {
        taskTps.addTimings(runningTaskKey(), ev.timings, 'tap');
        // Monitor row for the default tap's lane (the queue's local-gpu lane), when a queue item is what is running there.
        { const dl = defaultTapLane(); if (dl) broadcastLaneCompletion(dl, ev); }
        // The live prefill card for an external server: each finished request's exact prefill rate.
        const t = ev.timings || {};
        if (externalSource && Number(t.prompt_n) >= 32 && Number(t.prompt_per_second) > 0) {
            externalSource.prefillTps = +Number(t.prompt_per_second).toFixed(2);
            broadcastState(`PREFILL_PROGRESS:1.00:${Number(t.prompt_per_second).toFixed(2)}:${Number(t.prompt_n)}:${Number(t.prompt_per_second).toFixed(2)}`);
        }
    },
    getCtx: () => {
        const l = laneBatteryLive('local-gpu') || localBatteryLive();   // this tap carries the local-gpu lane's server
        const c = l && l.current;
        return {
            model: (externalSource && externalSource.model) || null,
            battery: l && l.running && l.battery ? l.battery.name : null,
            runner: l && l.battery && l.battery.config ? l.battery.config.runner || null : null,
            scaffold: l && l.battery && l.battery.config ? l.battery.config.scaffold || null : null,   // pi: none | sol-pi
            agentModel: l && l.battery && l.battery.config ? l.battery.config.model || null : null,
            task: c ? c.task : null, run: c ? c.run : null, of: c ? c.of : null, index: c ? c.index : null, total: c ? c.total : null,
            done: l ? l.done : null, planned: l ? l.total : null,
        };
    },
});

// --- COMBINED LIVE T/S ACROSS LOCAL LANES (GET /api/lanes/live, lib/lanetps.js; 2026-10-01) ---
// Kyle: with 2 local lanes running, the sidebar's generation/prefill numbers are the two models
// COMBINED. A local lane = one whose runtime_json publishes a tap_port (cloud's is {}) and that has a
// queue item running. With 2+ of them the browser's poll gets each lane's live rate (its tap meter)
// and the sums; with 0-1 it gets {combined:false} and the cards stay on the single-server path.
// Not a broadcastState tick: script.js's 'stopped' branch zeroes the cards and refetches history
// on every /api/status frame without `external` (3060 + XTX lanes, nothing on :8080), and dash-cli
// takes every frame as a state envelope.
// Taps are dialled only while it matters: 2+ local lanes busy AND a browser polled within
// LANES_WANT_MS. The non-default relays are released after that (setWanted(false) -> they linger
// livechat's LINGER_MS, then hang up unless a chat viewer holds them). The default 18090 relay is
// left alone: pollExternalSlots keeps it wanted whenever :8080 is up, and un-wanting it here would
// fight that.
const LANES_WANT_MS = 30000;
let lanesPolledAt = 0;
const lanesWanted = new Set();            // non-default relays this feature set wanted
const laneItemSeen = new Map();           // lane -> running item id its meter was last reset for
const laneEngine = new Map();             // lane -> { itemId, engine, at } from /props (async, once per item)
// Ports each lane's process tree listens on (lib/laneprocs.js), refreshed in the background every 15 s while
// lanes are being polled: a `shell` item serves wherever its script says (the Strata needle sweep: :18089),
// not on the lane's runtime server_port, and the lane read as idle while its GPU was flat out (Kyle, 2026-10-01).
// Same snapshot: the PCI buses each lane holds VRAM on, which names the card for a lane whose runtime_json has
// no `gpu` (local-gpu read "gpu" -- Kyle, 2026-10-01).
let lanePortsMap = new Map(), laneGpusMap = new Map(), lanePortsAt = 0, lanePortsBusy = false;
function refreshLanePorts() {
    if (lanePortsBusy || Date.now() - lanePortsAt < 15000) return;
    lanePortsBusy = true;
    laneProcs.laneSnapshot().then((r) => { lanePortsMap = r.ports; laneGpusMap = r.gpus; lanePortsAt = Date.now(); })
        .catch(() => {}).finally(() => { lanePortsBusy = false; });
}
/**
 * The card(s) a lane is on, in words ("RX 7900 XTX #2", "2x RX 7900 XTX", "RTX 4090 Laptop"); null if unknown.
 * Where its processes hold VRAM wins (a lane can be pointed at another card): PCI bus -> that reading's label. Before
 * the first process snapshot, and for a lane on another machine, it is what the lane's device list resolves to on this
 * machine, or the card name its runner published (lib/topology.js laneCards). No card is named in code.
 */
// The telemetry readings (fetchCurrentTelemetry's stats.gpus) of the cards a lane's processes hold VRAM on; [] for a lane
// on another machine or before the first process snapshot.
function laneGpus(lane, stats) {
    const buses = laneGpusMap.get(lane) || [];
    const gpus = (stats && stats.gpus) || [];
    const norm = (b) => String(b || '').toLowerCase().replace(/^[0-9a-f]{4,8}:(?=[0-9a-f]{2}:)/, '');
    return buses.map((b) => gpus.find((x) => (x.host || 'local') === 'local' && norm(x.pci) === b)).filter(Boolean);
}
// The same, as a chart sample's `devices` (lib/telemetry.js sampleFromRecord's shape; VRAM in GB).
function laneDeviceReadings(lane, stats) {
    return laneGpus(lane, stats).map((g) => ({ id: g.card || g.pci || null, label: g.label || topologyModel.shortName(g.gpu_name), host: 'local',
        util: g.gpu_util ?? null, pwr: g.gpu_pwr ?? null, temp: g.gpu_temp ?? null,
        vram: g.vram_used != null ? +(g.vram_used / 1024).toFixed(2) : null, thermal: isRealThermal(g) }));
}
function laneCardName(lane, runtime) {
    const names = laneGpus(lane, lastServerTelemetry && lastServerTelemetry.stats)
        .map((g) => g.label || topologyModel.shortName(g.gpu_name)).filter(Boolean);
    if (names.length) return laneTps.joinCardLabels(names);
    try { return topologyModel.laneCards(lane, runtime, currentTopology()).label; } catch { return null; }
}
// What engine answers on a port: Strata's /metrics carries {engine, live}; llama-server's /props a build_info.
async function engineAt(port) {
    try {
        const m = await (await fetch(`http://127.0.0.1:${port}/metrics`, { signal: AbortSignal.timeout(1200) })).json();
        if (m && m.engine && 'live' in m) return 'Strata';
    } catch { /* not JSON metrics: llama's are Prometheus text, or nothing listens */ }
    try {
        const p = await (await fetch(`http://127.0.0.1:${port}/props`, { signal: AbortSignal.timeout(1200) })).json();
        return laneTps.engineOf(p);
    } catch { return null; }
}
function probeLaneEngine(lane, itemId, runtime) {
    refreshLanePorts();
    const hit = laneEngine.get(lane);
    if (hit && hit.itemId === itemId && (hit.engine || Date.now() - hit.at < 30000)) return hit;
    laneEngine.set(lane, { itemId, engine: hit && hit.itemId === itemId ? hit.engine : null, port: hit && hit.itemId === itemId ? hit.port : null, at: Date.now() });
    // The lane's own server_port first; then every port its process tree holds (minus the tap and proxy).
    const own = Number(runtime.server_port) || Number(runtime.proxy_port) || null;
    const skip = new Set([Number(runtime.tap_port), Number(runtime.proxy_port)].filter(Boolean));
    const candidates = [own, ...(lanePortsMap.get(lane) || []).filter((p) => !skip.has(p) && p !== own)].filter(Boolean);
    const mapReady = lanePortsAt > 0;
    (async () => {
        for (const port of candidates) {
            const e = await engineAt(port);
            if (e) { laneEngine.set(lane, { itemId, engine: e, port, at: Date.now() }); return; }
        }
        // Nothing yet. If the process-port map hadn't loaded (first poll after a restart), retry on the next poll
        // instead of waiting out the 30 s back-off.
        const cur = laneEngine.get(lane);
        if (!mapReady && cur && cur.itemId === itemId && !cur.engine) cur.at = 0;
    })().catch(() => { /* loading / gone: label without engine, retried in 30 s */ });
    return laneEngine.get(lane);
}
// Exact live rates from each lane's engine (lib/lanetps.js laneRates: preferred over the tap's
// text-based estimate, which measured 20-35% off). ~1 Hz, only while lanesLive() last saw 2+ lanes
// AND a browser polled within LANES_WANT_MS; straight to runtime.server_port (no proxy hop). Not
// pollExternalSlots: that one stays the single-server path for :8080, untouched.
const LANE_ENGINE_POLL_MS = 1000;
let laneEngineTargets = [];               // [{lane, itemId, port, engine}] from the last combined lanesLive()
const laneSamples = new Map();            // lane -> engine sample {at, src, phase, gen, prefill, progress}
const laneSlotStates = new Map();         // lane -> { itemId, st } (lib/slots.js reducer state, llama lanes)
// The engine's word on a lane; a change of phase is pushed at once like a tap edge (lanesEdge).
function setLaneSample(lane, smp) {
    const prev = laneSamples.get(lane);
    laneSamples.set(lane, smp);
    if (smp && (!prev || prev.phase !== smp.phase)) lanesEdge();
}
async function pollLaneEngines() {
    const now = Date.now();
    if (now - lanesPolledAt > LANES_WANT_MS || laneEngineTargets.length < 1) return;
    await Promise.all(laneEngineTargets.map(async (t) => {
        if (!t.port || !t.engine) return;   // engine unknown yet: the tap meter carries the lane
        // A sample is stamped when its poll was SENT (2026-10-22): the engine may have answered from the moment before a
        // tap edge that landed while the answer travelled, and laneRates trusts a sample only when it is newer than the edge.
        const sentAt = Date.now();
        try {
            if (t.engine === 'Strata') {
                const j = await (await fetch(`http://127.0.0.1:${t.port}/metrics`, { signal: AbortSignal.timeout(1500) })).json();
                const smp = laneTps.parseStrataLive(j, sentAt);
                if (smp) setLaneSample(t.lane, smp);
            } else {
                const slots = await (await fetch(`http://127.0.0.1:${t.port}/slots`, { signal: AbortSignal.timeout(1500) })).json();
                if (!Array.isArray(slots) || !slots.length) return;
                let ss = laneSlotStates.get(t.lane);
                if (!ss || ss.itemId !== t.itemId) { ss = { itemId: t.itemId, st: null }; laneSlotStates.set(t.lane, ss); }
                const out = slotsModel.stepSlots(ss.st, slots, Date.now());
                ss.st = out.state;
                setLaneSample(t.lane, laneTps.slotsSample(out, sentAt));
            }
        } catch { /* loading / restarting / gone: the sample goes stale and the tap meter takes over */ }
    }));
}
(function laneEngineTick() {
    pollLaneEngines().catch(() => {}).finally(() => setTimeout(laneEngineTick, LANE_ENGINE_POLL_MS).unref());
})();
function lanesLive() {
    const now = Date.now();
    const info = laneInfo();
    const local = laneTps.busyLocalLanes(info);
    const keep = new Set();
    const release = () => { for (const r of lanesWanted) if (!keep.has(r)) { r.setWanted(false); lanesWanted.delete(r); } };
    // One busy lane is reported too (2026-10-01): a queue lane serving off :8080 (the 3060's :18381) is invisible
    // to the single-server path, so with only that lane busy the cards read 0.0 while it generated. `combined`
    // still needs 2+ (lib/lanetps.js combine), which is what tells the browser to sum.
    if (local.length < 1) { release(); laneEngineTargets = []; return { combined: false, at: now, lanes: [] }; }
    const targets = [];
    const lanes = local.map((lane) => {
        const item = info.running[lane], runtime = info.runtimes[lane] || {};
        const relay = relayForLane(lane);
        relay.setWanted(true);
        if (relay !== liveChat) { lanesWanted.add(relay); keep.add(relay); }
        const meter = laneMeter(info.taps[lane]);
        if (laneItemSeen.has(lane) && laneItemSeen.get(lane) !== item.id) { meter.reset(); laneSamples.delete(lane); }
        laneItemSeen.set(lane, item.id);
        // Where the lane's VRAM actually is wins over the lane's declared gpu (a lane can be pointed at another card);
        // the declared one / the item label are the fallback before the first process snapshot.
        const gpu = laneCardName(lane, runtime) || laneTps.gpuShort(runtime, item.label, lane);
        const probed = probeLaneEngine(lane, item.id, runtime) || {};
        const engine = probed.engine || null;
        targets.push({ lane, itemId: item.id, port: probed.port || Number(runtime.server_port) || null, engine });
        return { lane, label: engine ? `${gpu} ${engine}` : gpu, gpu, engine, item: item.label || null, model: item.model || null,
            enginePort: probed.port || null, ports: lanePortsMap.get(lane) || [],
            tap: info.taps[lane], connected: relay.connected(), ...laneTps.laneRates(meter.rates(now), laneSamples.get(lane), now) };
    });
    laneEngineTargets = targets;
    release();   // a lane that finished its item since the last poll
    return { at: now, ...laneTps.combine(lanes) };
}
// --- MONITOR: EVERY SERVER AT ONCE (2026-10-06) ---
// Kyle: "monitor should allow us to monitor all separate servers running concurrently ... as opposed to the combined
// summary numbers we see in telemetry", and its omni graph was "out of sync with the telemetry graphs". The cause: the
// omni graph was stitched from three other sources (per-request sample batches of the ONE server on :8080, a separate
// /api/logs/active-samples fetch, and a client-side idle filler), none of which knew about a second server. Now the
// telemetry loop takes ONE snapshot per tick -- every GPU plus every busy lane's phase and rates -- and the sidebar,
// the telemetry charts (history) and Monitor all read that same tick (GET /api/telemetry/latest: {t, stats, lanes, live}).
const laneTaskCache = new Map();   // lane -> { at, itemId, ctx }: the lane's current task (a results scan; 5 s is plenty)
function laneTaskCtx(lane, itemId) {
    const hit = laneTaskCache.get(lane);
    if (hit && hit.itemId === itemId && Date.now() - hit.at < 5000) return hit.ctx;
    let ctx = null;
    try { ctx = chatCtx(laneBatteryLive(lane)); } catch { ctx = null; }
    laneTaskCache.set(lane, { at: Date.now(), itemId, ctx });
    return ctx;
}
let lanesLiveFull = [];   // the last lanesForMonitor()'s whole lane records (lanesLive): what the request series samples
function lanesForMonitor() {
    lanesPolledAt = Date.now();        // keeps the lane engine sampler going with no browser open: history records lanes too
    const L = lanesLive();
    lanesLiveFull = L.lanes || [];
    const info = laneInfo();
    return (L.lanes || []).map((l) => {
        const item = info.running[l.lane] || {};
        const c = laneTaskCtx(l.lane, item.id) || {};
        return { lane: l.lane, label: l.label, gpu: l.gpu || null, engine: l.engine || null, item: l.item || null, model: l.model || null,
            phase: l.phase || 'idle', gen: l.gen || 0, prefill: l.prefill || 0, progress: l.progress ?? null, connected: !!l.connected,
            runner: c.runner || null, task: c.task || null, index: c.index ?? null, total: c.total ?? null };
    });
}
// One finished response on a lane's server -> a Monitor row. The queue's servers are not this dashboard's child, so
// logCompletedRequest() never sees them; the tap's `end` event carries the engine's own timings.
// 2026-10-22: the row carries `runId` (rec:<item label>:<tap id>, lib/reqsamples.js), under which its sample series is
// kept for GET /api/logs/samples, and a small `detail` for the expand modal. The end the tap replays on (re)connect --
// every dashboard restart -- was a second row for a request already listed; one already kept is not broadcast again.
function broadcastLaneCompletion(lane, ev) {
    try {
        const t = ev && ev.timings;
        const rec = laneRequests.end(lane, ev, laneRequestCtx(lane), Date.now());   // closes its series either way
        if (!t || !(Number(t.predicted_n) > 0 || Number(t.prompt_n) > 0)) return;
        if (rec) {
            const kept = requestSamplesStore.identity(rec.runId, rec.tStart, rec.itemId);
            if (kept === 'same' && !rec.live) return;
            if (kept === 'other') rec.runId = `${rec.runId}@${rec.itemId ?? rec.tStart}`;   // a queue label run again: its seq restarted
            requestSamplesStore.put(rec);
        }
        const info = laneInfo(), item = info.running[lane] || {};
        const label = (lanesForMonitorLast.find((l) => l.lane === lane) || {}).label || lane;
        const n = (v) => (Number.isFinite(Number(v)) && v != null ? Number(v) : null);
        broadcastState(`LANE_COMPLETION:${JSON.stringify({
            runId: rec ? rec.runId : null,
            timestamp: rec ? rec.completedAt : Date.now(), lane, server: label, model: item.label || lane, side: !!ev.side,
            promptTokens: n(t.prompt_n), promptTps: n(t.prompt_per_second), genTokens: n(t.predicted_n), genTps: n(t.predicted_per_second),
            wallTime: ((n(t.prompt_ms) || 0) + (n(t.predicted_ms) || 0)) / 1000 || null,
            draftAccepted: n(t.draft_n_accepted), draftGenerated: n(t.draft_n),
            draftAcceptRate: Number(t.draft_n) > 0 ? Number(t.draft_n_accepted || 0) / Number(t.draft_n) : null,
            detail: { lane, server: label, item: item.label || null, itemId: item.id ?? null, engine: rec ? rec.engine : null,
                cacheTokens: n(t.cache_n), promptMs: n(t.prompt_ms), genMs: n(t.predicted_ms) },
        })}`);
    } catch (e) { /* a Monitor row is best-effort */ }
}
let lanesForMonitorLast = [];

// --- PUBLIC LIVE SNAPSHOT (public/server.js and public/live_server.py read it; 2026-10-02) ---
// The public site (lab.kylebaker.io; it was ai.kylebaker.io until 2026-10-22) never calls this process. This writes
// logs/public-live.json every 3 s: each busy lane's card, engine, phase and live rates, and each running battery's
// label, current task NAME and progress. Nothing else: no ports, paths, commands, prompts or transcripts (and the
// public side scrubs it again through lib/publicdata.js).
// 2026-10-22, the static site (public/STATIC-ARCHITECTURE.md): the same tick also writes the public API's answers into
// logs/public-api/ (lib/publiclive.js: live.json, running.json, stats.json), which public/live_server.py serves as they
// are. UNPROMPTED: it used to write only while public/server.js had touched logs/public-live.want in the last 30 s, but
// the file server has no write path, and a static page's first probe must find a fresh file.
// 2026-10-07 (Kyle: "the 'what's running now' should include the 'question' that queue item answers, and how many
// passes/fails it is currently at"): `items` -- battery -> the running queue item's QUESTION and its tally (passed /
// failed / excluded / remaining). A separate top-level key on purpose: public/server.js copies it field by field
// (lib/publicdata.js liveRunning), and a public process started before this existed ignores it. Kyle's note on the
// item, the item's notes, its launch command and its paths are never read into this file (publicdata.liveItem).
const publicData = require('./lib/publicdata');
const publicLive = require('./lib/publiclive');
const PUBLIC_LIVE_FILE = path.join(ROOT_DIR, 'logs', 'public-live.json');
const PUBLIC_API_DIR = path.join(ROOT_DIR, 'logs', 'public-api');                  // public/live_server.py's LIVE_DIR
const PUBLIC_DEPLOYED = path.join(__dirname, 'public', '.static-deployed.json');   // publish-static.js: the deployed snapshot
// battery dir -> model display name, from the Models catalog's prebuilt answer: peek() never starts a build (the
// catalog's own timers keep it current); parsed again only when its ETag moves.
let publicNames = { etag: null, map: {} };
function publicBatteryNames() {
    const e = modelsCatalog.peek();
    if (e && e.etag !== publicNames.etag) {
        try { publicNames = { etag: e.etag, map: publicLive.batteryModels(JSON.parse(e.body.toString('utf-8'))) }; } catch { /* keep the last map */ }
    }
    return publicNames.map;
}
let publicDeployed = { mtimeMs: -1, value: null };
function publicDeployedRecord() {
    let st = null;
    try { st = fsSync.statSync(PUBLIC_DEPLOYED); } catch { return null; }   // never deployed
    if (st.mtimeMs !== publicDeployed.mtimeMs) {
        let value = null;
        try { value = JSON.parse(fsSync.readFileSync(PUBLIC_DEPLOYED, 'utf8')); } catch { /* unreadable: keep the last, look again next tick */ }
        publicDeployed = value ? { mtimeMs: st.mtimeMs, value } : { mtimeMs: -1, value: publicDeployed.value };
    }
    return publicDeployed.value;
}
const publicResultCache = new Map();   // result file -> { mtimeMs, status }
function publicBatteryProgress(r) {
    const tasks = Array.isArray(r.battery && r.battery.tasks) ? r.battery.tasks : [];
    let done = 0, solved = 0, current = null;
    const statuses = [];   // of the finished tasks, for the tally (null: the result file is mid-write)
    for (const t of tasks) {
        const f = path.join(r.path, `${t}.json`);
        let st = null;
        try { st = fsSync.statSync(f); } catch { if (!current) current = t; continue; }
        done++;
        let hit = publicResultCache.get(f);
        if (!hit || hit.mtimeMs !== st.mtimeMs) {
            let status = null;
            try { status = JSON.parse(fsSync.readFileSync(f, 'utf8')).status || null; } catch { /* mid-write */ }
            hit = { mtimeMs: st.mtimeMs, status };
            publicResultCache.set(f, hit);
        }
        if (/^pass/.test(hit.status || '')) solved++;
        statuses.push(hit.status);
    }
    return { progress: { task: current, tasks: tasks.length, done, solved }, statuses };
}
setInterval(() => {
    try {
        lanesPolledAt = Date.now();   // keep the lane engine sampler going (the telemetry loop does too)
        const L = lanesLive();
        const lanes = (Array.isArray(L.lanes) ? L.lanes : []).map((l) => ({ lane: l.lane, card: l.gpu, engine: l.engine || null,
            phase: l.phase || 'idle', gen: l.gen || 0, prefill: l.prefill || 0, progress: l.progress ?? null, battery: l.item || null,
            read: l.lastReadTps || 0, readN: l.lastReadN || 0 }));   // the last sizeable prefill, for a card that is generating
        const running = [], items = {};
        for (const r of codebenchModel.scanBatteries()) {
            if (!r.adoptable) continue;
            const b = r.battery || {};
            const { progress, statuses } = publicBatteryProgress(r);
            running.push({ dir: r.dir, runner: b.runner || null, state: r.state, lane: laneOfBattery(r.dir), ...progress });
            let item = null;
            try { item = queueModel.runningFor(r.dir); } catch { item = null; }   // a battery no queue item started: counts only
            items[r.dir] = publicData.liveItem(item, publicData.liveTally(statuses, progress.tasks, { solved: codebenchModel.SOLVED, excluded: codebenchModel.EXCLUDED }));
        }
        const raw = { at: Date.now(), lanes, running, items };
        publicLive.writeAtomic(path.dirname(PUBLIC_LIVE_FILE), { [path.basename(PUBLIC_LIVE_FILE)]: raw });
        publicLive.writeAtomic(PUBLIC_API_DIR, publicLive.apiFiles(raw, { names: publicBatteryNames(), deployed: publicDeployedRecord(), now: raw.at }));
    } catch (e) { /* best-effort: the files age, and the public side reads them as stale / offline */ }
}, 3000).unref();

setInterval(() => {
    if (!lanesWanted.size || Date.now() - lanesPolledAt < LANES_WANT_MS) return;
    for (const r of lanesWanted) r.setWanted(false);
    lanesWanted.clear();
}, 10000).unref();

// --- LIVE TICKS ON THE STATUS STREAM (2026-10-22) ---
// Kyle: "cloudflare says lab.kylebaker.io got 65.1k requests in the last 24 hours ... that's an internal site ... sounds
// like some terrible inefficiency" (lab.* was this dashboard until the swap that night). The page polled
// GET /api/telemetry/latest every second, hidden tabs included, and GET /api/lanes/live every second while a lane was
// busy: 99-154 requests a minute from one open tab, each a Cloudflare request on the tunnel. A client that opens the
// stream as /api/status?ticks=1 gets both pushed instead, as NAMED events: `telemetry` with every reading the telemetry
// loop takes (the GET's body), `lanes` every LANES_TICK_MS (the GET's body). Named, and only to clients that ask:
// dash-cli and lib/sweep.js read every data: line of this stream as a state envelope, and script.js's 'stopped' branch
// redraws on every plain frame (see the note above lanesLive). The GET routes stay, for a stream that has gone quiet.
const LANES_TICK_MS = 1000;
const tickClients = new Set();
const tickFrame = (event, body) => `event: ${event}\ndata: ${JSON.stringify(body)}\n\n`;
function sendTick(event, body) {
    if (!tickClients.size) return;
    const frame = tickFrame(event, body);
    for (const c of tickClients) { try { c.write(frame); } catch { /* gone: its 'close' removes it */ } }
}
/** GET /api/lanes/live's answer, and the `lanes` tick's: a browser is watching, so the lane engine sampler keeps going. */
function lanesLiveAnswer() {
    lanesPolledAt = Date.now();
    try { return lanesLive(); } catch (e) { return { combined: false, error: e.message }; }
}
setInterval(() => { if (tickClients.size) sendTick('lanes', lanesLiveAnswer()); }, LANES_TICK_MS).unref();
// EDGES (2026-10-22, Kyle: the Live view's "generating / reading the prompt" strip "seems ... a second or two late"). Measured
// that day on local-gpu: the tap's first token reached the strip 2.1 s later at the median (the engine poll ~1 s, this
// 1 s tick, then the page's own 1 s redraw). A lane's edge -- its tap's request / first token / end, or its engine's
// phase changing -- now sends the lanes answer within LANES_EDGE_MS, marked `edge: true` (the page redraws the strip on
// it, and leaves the sidebar's 1 s series alone). Coalesced: one frame for a burst (an end and the next request).
const LANES_EDGE_MS = 25;
let lanesEdgeTimer = null;
function lanesEdge() {
    if (!tickClients.size || lanesEdgeTimer) return;
    lanesEdgeTimer = setTimeout(() => { lanesEdgeTimer = null; sendTick('lanes', { ...lanesLiveAnswer(), edge: true }); }, LANES_EDGE_MS);
}

// --- SSE HEARTBEAT ---
// Comment-line keepalives on /api/status so idle SSE connections don't get
// reaped by proxies, terminals, or idle timeouts. SSE spec: lines starting
// with ':' are comments -- the browser EventSource and the llama-cli TUI both
// ignore them (the CLI uses them to detect a healthy but quiet stream).
// .unref(): a test harness that closes the server should not be held open by
// this timer.
setInterval(() => {
    const deadClients = [];
    for (const client of clients) {
        try {
            client.write(': ping\n\n');
        } catch (err) {
            deadClients.push(client);
        }
    }
    if (deadClients.length > 0) clients = clients.filter(c => !deadClients.includes(c));
    liveChat.ping();
    for (const r of laneRelays.values()) r.ping();
}, 15000).unref();

// --- REMOTE ACCESS: Cloudflare tunnel + hard password gate ---
// `cloudflared tunnel --url http://127.0.0.1:PORT` (trycloudflare, no
// account) publishes this dashboard to a random https://xxx.trycloudflare.com.
// With dashboard.config.json `remoteAccess.tunnelConfig` set, a NAMED tunnel
// (`cloudflared tunnel --config <file> run`) publishes it at a fixed hostname
// instead (`remoteAccess.url`: https://ai.kylebaker.io; lab.kylebaker.io is the public site, public/server.js -- the two
// names were the other way round until 2026-10-22) -- same gate.
// Because cloudflared forwards from localhost, tunnel traffic and local
// traffic are indistinguishable by IP -- so the gate is GLOBAL while the
// tunnel is up: EVERY request (static files, REST, SSE) must authenticate
// before any dashboard bytes are served. The only unauthenticated response is
// the gate page itself (it has to be, in order to collect the password).
// Stopping the tunnel drops the gate; local use is exactly as before.
//
// Credentials: the password is PBKDF2-HMAC-SHA256 (200k iters) against a
// random per-boot salt (never persisted -- a restart revokes everything).
// Two auth paths, both checked per request:
//   - Authorization: Bearer <password>  (CLI on another machine; TLS via the
//     tunnel edge, and the gate means the password only ever crosses a link
//     the operator just unlocked)
//   - mc_session=<random token> cookie  (browsers, after /api/tunnel/login;
//     tokens live in memory and die with the process)
const crypto = require('crypto');
let tunnelProcess = null;
let tunnelUrl = null;
let tunnelSalt = null;
let tunnelPasswordHash = null;
// Stable password fingerprint for signing browser sessions: HMAC of the password under the on-disk
// session secret. tunnelPasswordHash can't be used for that -- its salt is random PER BOOT, so signing
// with it invalidated every browser's cookie on every restart (fixed 2026-10-01).
let tunnelPasswordTag = null;
let tunnelStarting = false;
const tunnelSessions = new Set();

function tunnelGateActive() {
    return tunnelProcess !== null || tunnelStarting;
}

function hashTunnelPassword(password, salt) {
    return crypto.pbkdf2Sync(String(password), salt, 200000, 64, 'sha256');
}

// Browser sessions are SIGNED tokens, not entries in a Set: the Set lived in this process's memory,
// so every `pm2 restart dashboard` logged every open page out, and a page that had loaded before the
// restart got 401s on its next fetch -- shown as misleading "no scored result" errors (Kyle,
// 2026-09-25). A token is `s1.<epoch>.<expiry>.<hmac>`, keyed by a secret kept on disk (0600) plus
// the current password hash, so it survives restarts but not a password change. stopTunnel() bumps
// the epoch, which still logs everyone out when the tunnel is cycled, as the Set.clear() did.
const SESSION_SECRET_FILE = path.join(os.homedir(), '.config', 'ai-dashboard', 'session-secret.json');
let _sessionSecret = null;   // read once; bumpSessionEpoch() updates it in place
function sessionSecret() {
    if (_sessionSecret) return _sessionSecret;
    try { const j = JSON.parse(fsSync.readFileSync(SESSION_SECRET_FILE, 'utf-8')); if (j && j.key) return (_sessionSecret = j); } catch { /* first use */ }
    const j = _sessionSecret = { key: crypto.randomBytes(32).toString('hex'), epoch: 1 };
    try { fsSync.mkdirSync(path.dirname(SESSION_SECRET_FILE), { recursive: true }); fsSync.writeFileSync(SESSION_SECRET_FILE, JSON.stringify(j), { mode: 0o600 }); } catch { /* sessions then last only this process */ }
    return j;
}
function sessionSig(epoch, exp) {
    const s = sessionSecret();
    return crypto.createHmac('sha256', s.key + ':' + (tunnelPasswordTag || '')).update(`${epoch}.${exp}`).digest('hex');
}
const SESSION_MAX_AGE_S = 30 * 86400;   // 30 days; cycling the tunnel (epoch bump) or changing the password still logs everyone out
function mintSession(maxAgeS = SESSION_MAX_AGE_S) {
    const epoch = sessionSecret().epoch, exp = Math.floor(Date.now() / 1000) + maxAgeS;
    return `s1.${epoch}.${exp}.${sessionSig(epoch, exp)}`;
}
function validSignedSession(v) {
    const m = /^s1\.(\d+)\.(\d+)\.([0-9a-f]{64})$/.exec(String(v || ''));
    if (!m || !tunnelPasswordTag) return false;
    if (Number(m[1]) !== sessionSecret().epoch || Number(m[2]) < Date.now() / 1000) return false;
    const want = Buffer.from(sessionSig(Number(m[1]), Number(m[2])), 'hex'), got = Buffer.from(m[3], 'hex');
    return want.length === got.length && crypto.timingSafeEqual(want, got);
}
function bumpSessionEpoch() {
    const s = sessionSecret(); s.epoch = (s.epoch || 1) + 1;
    try { fsSync.writeFileSync(SESSION_SECRET_FILE, JSON.stringify(s), { mode: 0o600 }); } catch { /* ignore */ }
}

function verifyTunnelPassword(password) {
    if (!tunnelPasswordHash || !tunnelSalt) return false;
    const candidate = hashTunnelPassword(password, tunnelSalt);
    return crypto.timingSafeEqual(candidate, tunnelPasswordHash);
}

// A Bearer password is checked on EVERY request that carries it, and the check is a PBKDF2 of 200k iterations: ~110 ms
// of this one thread each time (2026-10-22). Browsers never pay it (signed session cookies, an HMAC); scripts that send
// the password as a Bearer did (dash-cli, the laptop thermal guards, the harness). So the last Bearer that matched is
// remembered as a SHA-256 digest, for the current password hash only: the tunnel's next start (new salt, maybe a new
// password) forgets it. A wrong password still costs the full PBKDF2, as before.
let bearerOk = { hash: null, digest: null };
function bearerMatches(token) {
    if (!tunnelPasswordHash) return false;
    const digest = crypto.createHash('sha256').update(String(token)).digest();
    if (bearerOk.hash === tunnelPasswordHash && bearerOk.digest && crypto.timingSafeEqual(digest, bearerOk.digest)) return true;
    if (!verifyTunnelPassword(token)) return false;
    bearerOk = { hash: tunnelPasswordHash, digest };
    return true;
}

// A single random token minted at startup for lib/sweep.js's loopback calls.
// The headless sweep runner drives this server's own /api/start|chat|stop over
// 127.0.0.1, which the tunnel gate would otherwise 401. Checked separately from
// `tunnelSessions` on purpose: stopTunnel() clears that Set, and a sweep must
// not lose its authorization just because the tunnel was cycled mid-run. The
// token is never written to disk, logged, or sent anywhere off-process, so it
// grants nothing to anyone who couldn't already read this process's memory.
const INTERNAL_SESSION = crypto.randomBytes(32).toString('hex');
sweepModel.authToken = INTERNAL_SESSION; // must be after the const: TDZ, not hoisted

// remoteAccess.allowIps: peers trusted without the password, matched on the
// SOCKET's remote address (never a header -- X-Forwarded-For/CF-Connecting-IP
// are client-controlled). Meant for Tailscale peers hitting :3000 directly.
// Loopback entries are dropped: cloudflared forwards tunnel traffic from
// 127.0.0.1, so allowing loopback would open the public tunnel to everyone.
function gateAllowedIp(req) {
    const list = (dashboardConfig.remoteAccess || {}).allowIps;
    if (!Array.isArray(list) || !list.length) return false;
    const ip = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
    if (!ip || ip === '::1' || ip.startsWith('127.')) return false;
    return list.some(a => String(a).trim() === ip);
}

function tunnelAuthenticated(req) {
    if (gateAllowedIp(req)) return true;
    const bearer = req.headers['authorization'];
    if (typeof bearer === 'string' && bearer.startsWith('Bearer ') && bearer.trim().length > 7) {
        if (bearerMatches(bearer.slice(7).trim())) return true;
    }
    const cookie = req.headers['cookie'];
    if (typeof cookie === 'string') {
        for (const part of cookie.split(';')) {
            const eq = part.indexOf('=');
            if (eq === -1) continue;
            const name = part.slice(0, eq).trim();
            const value = part.slice(eq + 1).trim();
            if (name === 'mc_session' && (value === INTERNAL_SESSION || tunnelSessions.has(value) || validSignedSession(value))) return true;
        }
    }
    return false;
}

const TUNNEL_GATE_PAGE = `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>LL-Dash — locked</title>
<link rel="icon" href="/favicon.ico" sizes="16x16 32x32 48x48">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>
  body { background: #0a0a0f; color: #d4d4d8; font-family: system-ui, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; }
  .card { background: #18181b; border: 1px solid #27272a; border-radius: 12px; padding: 2.5rem 2rem; width: min(22rem, 90vw); text-align: center; }
  h1 { font-size: 1.1rem; margin: 0 0 .25rem; color: #818cf8; }
  p.sub { font-size: .8rem; color: #71717a; margin: 0 0 1.5rem; }
  input { width: 100%; box-sizing: border-box; background: #09090b; border: 1px solid #3f3f46; border-radius: 8px; color: #e4e4e7; padding: .6rem .75rem; font-size: .9rem; }
  button { width: 100%; box-sizing: border-box; margin-top: .75rem; background: #4f46e5; border: 0; border-radius: 8px; color: #fff; padding: .6rem; font-size: .9rem; font-weight: 600; cursor: pointer; }
  button:disabled { background: #3f3f46; cursor: default; }
  .err { color: #f87171; font-size: .8rem; min-height: 1.2em; margin: .75rem 0 0; }
</style>
</head>
<body>
<div class="card">
  <h1>LL-Dash</h1>
  <p class="sub">Remote access is password-protected. This dashboard is exposed through a Cloudflare tunnel.</p>
  <form id="f" autocomplete="off">
    <input type="password" id="pw" placeholder="password" autofocus>
    <button id="go" type="submit">Unlock</button>
  </form>
  <p class="err" id="err"></p>
</div>
<script>
${gateModel.GATE_PAGE_SCRIPT}
</script>
</body>
</html>`;

// The KBIO favicon set (experiment-1/favicon-kbio/, copied into this dir): served by the static route below, and
// reachable before the gate's password.
const SITE_ICONS = new Set(['/favicon.ico', '/favicon.svg', '/apple-touch-icon.png', '/icon-192.png', '/icon-512.png']);
function tunnelGateResponse(req, res) {
    // Browsers hitting a page get the gate form; API/SSE clients get 401 JSON
    // (the CLI turns it into a password prompt). No dashboard bytes either way.
    const wantsHtml = req.method === 'GET' && /html/i.test(String(req.headers['accept'] || ''));
    if (wantsHtml) {
        res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
        return res.end(TUNNEL_GATE_PAGE);
    }
    res.writeHead(401, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    return res.end(JSON.stringify({ error: 'authentication required (tunnel gate active)' }));
}

function getRemoteAccessConfig() {
    const r = dashboardConfig.remoteAccess || {};
    const tunnelConfig = toNonEmptyString(r.tunnelConfig);
    return {
        binary: toNonEmptyString(r.cloudflared) || 'cloudflared',
        tunnelConfig: tunnelConfig ? expandPath(tunnelConfig) : null,
        url: toNonEmptyString(r.url) || null,
        autoStart: r.autoStart === true,
        passwordFile: toNonEmptyString(r.passwordFile)
            ? expandPath(toNonEmptyString(r.passwordFile))
            : null,
    };
}

function stopTunnel() {
    if (tunnelProcess) {
        try { tunnelProcess.kill('SIGTERM'); } catch { /* already gone */ }
        tunnelProcess = null;
    }
    tunnelUrl = null;
    tunnelSalt = null;
    tunnelPasswordHash = null;
    tunnelPasswordTag = null;
    tunnelSessions.clear();
    bumpSessionEpoch();   // signed sessions too: cycling the tunnel still logs everyone out
    tunnelStarting = false;
}

// Start a trycloudflare quick tunnel to this dashboard and wait (up to 30 s)
// for the URL to appear in cloudflared's logs. The PASSWORD is required up
// front -- the gate arms as soon as this returns, so there is no window where
// the tunnel is public but unguarded.
function startTunnel(password) {
    return new Promise((resolve, reject) => {
        if (tunnelGateActive()) return reject(new Error('tunnel already running'));
        if (typeof password !== 'string' || password.length < 4) {
            return reject(new Error('password required (min 4 characters)'));
        }
        // Known as soon as the gate arms (tunnelStarting), so a valid cookie works through the startup window
        // instead of bouncing to the login page until cloudflared reports up.
        tunnelPasswordTag = crypto.createHmac('sha256', sessionSecret().key).update('tunnel-password:' + String(password)).digest('hex');
        const ra = getRemoteAccessConfig();
        const args = ra.tunnelConfig
            ? ['tunnel', '--no-autoupdate', '--config', ra.tunnelConfig, 'run']
            : ['tunnel', '--url', `http://127.0.0.1:${PORT}`, '--no-autoupdate'];
        let proc;
        try {
            proc = spawn(ra.binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
        } catch (err) {
            return reject(new Error('failed to start cloudflared: ' + err.message));
        }
        let settled = false;
        const fail = (msg) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            try { proc.kill('SIGTERM'); } catch { /* ignore */ }
            // A failed start must NOT leave the gate armed with no usable
            // password -- that would lock the operator out of their own
            // dashboard. Clear every bit of tunnel state.
            if (tunnelProcess === proc) tunnelProcess = null;
            tunnelStarting = false;
            tunnelUrl = null;
            tunnelSalt = null;
            tunnelPasswordHash = null;
            tunnelPasswordTag = null;
            reject(new Error(msg));
        };
        // A quick tunnel is up once it prints its random URL; a named tunnel
        // once it registers an edge connection (its URL is fixed, from config).
        const upRe = ra.tunnelConfig ? /Registered tunnel connection/i : /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
        const onOutput = (data) => {
            const m = String(data).match(upRe);
            if (m && !settled) {
                settled = true;
                clearTimeout(timer);
                tunnelUrl = ra.tunnelConfig ? (ra.url || 'named tunnel') : m[0];
                tunnelStarting = false; // success: no longer "starting" (the status endpoint and the UI badge depend on this flipping)
                tunnelSalt = crypto.randomBytes(32);
                tunnelPasswordHash = hashTunnelPassword(password, tunnelSalt);
                resolve(tunnelUrl);
            }
        };
        proc.stdout.on('data', onOutput);
        proc.stderr.on('data', onOutput);
        proc.on('error', (err) => fail(err.code === 'ENOENT' ? 'cloudflared not found on this host' : 'cloudflared error: ' + err.message));
        proc.on('exit', (code) => {
            if (!settled) return fail(`cloudflared exited before the tunnel came up (code ${code})`);
            // Unexpected death after a successful start -- clear state so the
            // UI/CLI don't believe a dead tunnel is still public. A deliberate
            // stop has already cleared tunnelProcess, so it is not restarted.
            if (tunnelProcess !== proc) return;
            stopTunnel();
            scheduleTunnelAutoStart('tunnel exited unexpectedly');
        });
        tunnelStarting = true;
        tunnelProcess = proc;
        const timer = setTimeout(() => fail('cloudflared tunnel did not come up within 30 s'), 30000);
    });
}

// --- TUNNEL AUTOSTART ---
// With remoteAccess.autoStart and remoteAccess.passwordFile set, the tunnel
// comes up when the dashboard starts (e.g. at boot, with no one there to use
// the toggle), gated by the password in that file. Retries every 60 s while
// the network or cloudflared is not ready, and after an unexpected exit.
let tunnelAutoStartTimer = null;
async function autoStartTunnel() {
    tunnelAutoStartTimer = null;
    const ra = getRemoteAccessConfig();
    if (!ra.autoStart || tunnelGateActive()) return;
    if (!ra.passwordFile) {
        console.error('tunnel autostart: remoteAccess.passwordFile is not set; not starting');
        return;
    }
    let password;
    try {
        password = (await fs.readFile(ra.passwordFile, 'utf-8')).trim();
    } catch (err) {
        console.error(`tunnel autostart: cannot read ${ra.passwordFile}: ${err.message}; not starting`);
        return;
    }
    try {
        const url = await startTunnel(password);
        console.log(`tunnel autostart: up at ${url}`);
        broadcastState('', `tunnel up: ${url}`);
    } catch (err) {
        scheduleTunnelAutoStart(err.message);
    }
}
function scheduleTunnelAutoStart(reason) {
    if (!getRemoteAccessConfig().autoStart || tunnelAutoStartTimer) return;
    console.error(`tunnel autostart: ${reason}; retrying in 60 s`);
    tunnelAutoStartTimer = setTimeout(autoStartTunnel, 60000);
}

// --- SAFE REQUEST BODY PARSER ---
function parseBody(req, maxSize = MAX_BODY_SIZE) {
    return new Promise((resolve, reject) => {
        let body = '';
        let size = 0;
        req.on('data', chunk => {
            size += chunk.length;
            if (size > maxSize) {
                req.destroy();
                return reject(new Error('Payload too large'));
            }
            body += chunk;
        });
        req.on('end', () => resolve(body));
        req.on('error', reject);
    });
}

// --- GGUF MODEL ROOTS ---
// Scanned in this order by lib/modelscan.js, and the first path a file is reached by wins:
// ROOT/models first (it holds symlinks into /data/models, and saved profiles store those paths),
// then /data/models (where downloads land; a model there with no symlink used to be invisible),
// then the HF hub cache, then dashboard.config.json `modelDirs` (e.g. an external drive).
function modelRoots() {
    return [
        { dir: path.join(ROOT_DIR, 'models'), source: 'local' },
        { dir: '/data/models', source: 'local' },
        { dir: HF_CACHE_DIR, source: 'huggingface' },
        ...(dashboardConfig.modelsRoot ? [{ dir: dashboardConfig.modelsRoot, source: 'local' }] : []),
        ...(dashboardConfig.modelDirs || []).map((dir) => ({ dir, source: 'local' })),
    ];
}

// --- SSH EXECUTION (SECURE & CORRECTED) ---
// "user@host" or a bare ~/.ssh/config alias ("laptop"). No leading '-', so a
// target can never be read by ssh as an option.
function isValidSSHHost(host) {
    return /^([a-zA-Z0-9._-]+@)?[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(String(host || ''));
}

async function runSSHCommand(host, command) {
    if (!isValidSSHHost(host)) throw new Error('Invalid SSH host format');
    return new Promise((resolve, reject) => {
        // Pass command as a single trailing argument so SSH sends it verbatim to the remote shell
        const ssh = spawn('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=5', host, command]);
        // A remote command that never closes its output (e.g. a badly detached
        // background process) would otherwise hang the HTTP request forever.
        const timer = setTimeout(() => ssh.kill('SIGKILL'), 30000);
        ssh.on('exit', () => clearTimeout(timer));
        let stdout = '', stderr = '';
        ssh.stdout.on('data', d => stdout += d);
        ssh.stderr.on('data', d => stderr += d);
        ssh.on('close', code => {
            if (code === 0) resolve({ stdout, stderr });
            else reject(new Error(stderr || `SSH exited with code ${code}`));
        });
        ssh.on('error', reject);
    });
}

// --- PORT CLEANUP --- (2026-10-17: lib/gpusafety.js cleanupPortSafely, at startup only; `fuser -k` is gone)

// --- SHARED ARG BUILDER ---
// Flags common to both launch modes (Docker+RPC and local-multi-gpu). `mapModelPath`
// remaps host paths to container paths in Docker mode, or is the identity function
// for a directly-spawned local process. `deviceArgs` is the mode-specific device/split
// selection (--rpc+--split-mode for Docker RPC, or -dev+--split-mode for local Vulkan),
// injected at the same position the old RPC-only block used to occupy.
// --- FLAG REFERENCE (searchable popover in the UI) ---
// Parses `llama-server --help`'s output into {flags, description, section,
// insertText, primaryFlag} entries. Description text is column-aligned at a
// fixed indent (verified against real output: 40 chars) rather than "first
// big gap after the flag names", which breaks on short/long alias pairs like
// "-c,    --ctx-size N" (the gap between "-c," and "--ctx-size" would
// otherwise look like the flags/description boundary). A flag-name group that
// overflows past that column with no room for a trailing padding gap (e.g.
// "--prefill-assistant, --no-prefill-assistant") has no description on its
// own line -- the actual description is the following indented line(s),
// handled by the continuation-line branch below.
const HELP_DESC_COLUMN = 40;
// Help text is static per binary, not globally -- different builds (e.g.
// CUDA+Vulkan vs Vulkan-only) can expose different flags, so this is keyed by
// build id rather than a single cached value.
const cachedFlagReferenceByBuild = new Map();
function parseHelpFlags(helpText) {
    const lines = helpText.split('\n');
    const entries = [];
    let currentSection = 'general';
    for (const rawLine of lines) {
        const line = rawLine.replace(/\r$/, '');
        if (/^-{3,}.*-{3,}$/.test(line.trim())) {
            currentSection = line.trim().replace(/^-+\s*/, '').replace(/\s*-+$/, '');
            continue;
        }
        if (!line.trim()) continue;
        if (!/^\s/.test(line)) {
            const candidateFlagPart = line.slice(0, HELP_DESC_COLUMN);
            let flagPart, descPart;
            if (candidateFlagPart.trimEnd().length < HELP_DESC_COLUMN) {
                flagPart = candidateFlagPart.trim();
                descPart = line.slice(HELP_DESC_COLUMN).trim();
            } else {
                flagPart = line.trim();
                descPart = '';
            }
            entries.push({ flags: flagPart, description: descPart, section: currentSection });
        } else if (entries.length > 0) {
            const last = entries[entries.length - 1];
            last.description = (last.description ? last.description + ' ' : '') + line.trim();
        }
    }
    for (const e of entries) {
        const flagTokens = e.flags.match(/--?[\w-]+/g) || [];
        const longForm = [...flagTokens].reverse().find(t => t.startsWith('--')) || flagTokens[flagTokens.length - 1] || '';
        const withoutFlags = e.flags.replace(/^(-{1,2}[\w-]+,?\s*)+/, '').trim();
        e.insertText = withoutFlags ? `${longForm} ` : longForm;
        e.primaryFlag = longForm;
    }
    return entries;
}

// True when the build's parsed --help reference lists the flag. The cache is
// warmed at boot (initServer) and lazily filled by /api/flags; a build with
// NO cached reference yet is assumed modern (every current build has had
// these flags for a long time, and a genuinely old build would reject an
// unknown flag loudly at launch -- visible in the log, not a silent misfire).
function buildSupportsFlag(buildId, flag) {
    const flags = cachedFlagReferenceByBuild.get(buildId);
    if (!flags || flags.length === 0) return true;
    return flags.some((f) => (f.flags || '').includes(flag));
}

// Coerce a UI/API value to a finite number, or undefined when it's missing,
// empty, or not numeric. Number.isNaN() alone is NOT sufficient: it doesn't
// coerce, so '' and 'abc' sail through it, and an empty string would emit a
// flag with no value (e.g. `--top-k` "").
function toFiniteNumber(v) {
    if (v === null || v === undefined) return undefined;
    if (typeof v === 'boolean') return undefined;
    if (typeof v === 'string' && v.trim() === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}

// Coerce to a non-empty trimmed string, or undefined. Preserves "0" (unlike
// `v || undefined`, which would drop a legitimate zero).
function toNonEmptyString(v) {
    if (v === null || v === undefined) return undefined;
    const s = String(v).trim();
    return s.length > 0 ? s : undefined;
}

function buildLlamaArgs(config, { mapModelPath, deviceArgs }) {
    // Validate the required knobs up front so a malformed config fails with a
    // clear message instead of spawning `llama-server -m undefined -c NaN`
    // (a blank ctx/ngl field reaches us as NaN -> JSON null).
    const modelPath = toNonEmptyString(config.modelPath);
    if (!modelPath) throw new Error('modelPath is required');

    const ctx = toFiniteNumber(config.ctx);
    const ngl = toFiniteNumber(config.ngl);
    if (ctx === undefined || ngl === undefined) {
        throw new Error('ctx and ngl must be numbers');
    }

    // Port: the UI has no port field today, but a raw command (or a future UI)
    // may set one -- and the /slots poll + CSV rows depend on this being real.
    const port = toFiniteNumber(toNonEmptyString(config.port) || '8080');
    if (port === undefined || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('port must be an integer between 1 and 65535');
    }

    const args = ['-m', mapModelPath(modelPath),
        '-c', String(ctx), '-ngl', String(ngl),
        '--host', getLlamaHost(), '--port', String(port), '--metrics'];

    if (config.fa) args.push('-fa', 'on');
    const cacheK = toNonEmptyString(config.cacheK);
    if (cacheK) args.push('--cache-type-k', cacheK);
    const cacheV = toNonEmptyString(config.cacheV);
    if (cacheV) args.push('--cache-type-v', cacheV);
    // specType is a comma-separated list of strategies (llama-server accepts
    // e.g. `--spec-type draft-mtp,ngram-simple`); older configs stored a
    // single value, which is just a one-item list.
    const specType = toNonEmptyString(config.specType);
    if (specType) {
        args.push('--spec-type', specType);
        const specDraftNMax = toFiniteNumber(config.specDraftNMax);
        args.push('--spec-draft-n-max', String(specDraftNMax !== undefined ? specDraftNMax : 2));
        const specDraftNMin = toFiniteNumber(config.specDraftNMin);
        if (specDraftNMin !== undefined) {
            args.push('--spec-draft-n-min', String(specDraftNMin));
        }
        const specDraftModel = toNonEmptyString(config.specDraftModel);
        if (specDraftModel) args.push('--spec-draft-model', specDraftModel);
        // Shared ngram knobs: llama-server namespaces them per strategy
        // (--spec-ngram-map-k4v-size-n etc.), so emit the same value for each
        // checked strategy that takes them. Blank fields omit the flags
        // (llama defaults: size-n 12, size-m 48, min-hits 1).
        const ngramFlagStems = { 'ngram-simple': 'ngram-simple', 'ngram-map-k': 'ngram-map-k', 'ngram-map-k4v': 'ngram-map-k4v' };
        for (const type of specType.split(',').map(s => s.trim())) {
            const stem = ngramFlagStems[type];
            if (!stem) continue;
            const sizeN = toFiniteNumber(config.specNgramSizeN);
            if (sizeN !== undefined) args.push(`--spec-${stem}-size-n`, String(sizeN));
            const sizeM = toFiniteNumber(config.specNgramSizeM);
            if (sizeM !== undefined) args.push(`--spec-${stem}-size-m`, String(sizeM));
            const minHits = toFiniteNumber(config.specNgramMinHits);
            if (minHits !== undefined) args.push(`--spec-${stem}-min-hits`, String(minHits));
        }
        args.push('-np', '1');
    }
    const specDraftNgl = toFiniteNumber(config.specDraftNgl);
    if (specDraftNgl !== undefined) args.push('--spec-draft-ngl', String(specDraftNgl));
    // Where the draft/MTP model runs: a LOCAL device id only (same id shape
    // as lib/devices.js, RPC<n> excluded) -- drafting on an RPC worker would
    // put a network round trip in every draft step.
    const specDraftDevice = toNonEmptyString(config.specDraftDevice);
    if (specDraftDevice) {
        if (!/^(?!RPC\d)[A-Za-z]+\d+$/.test(specDraftDevice)) {
            throw new Error('specDraftDevice must be a local device id (e.g. Vulkan1)');
        }
        args.push('--spec-draft-device', specDraftDevice);
    }
    // preserveThinking is a legacy field (older saved profiles) that implies
    // reasoningPreserve -- dedupe so the flag is only emitted once.
    const preserveThinking = !!config.preserveThinking;
    const reasoningPreserve = !!config.reasoningPreserve;
    if (preserveThinking) {
        args.push('--chat-template-kwargs', JSON.stringify({ preserve_thinking: true }));
    }
    if (preserveThinking || reasoningPreserve) {
        args.push('--reasoning-preserve');
    }
    args.push(...deviceArgs);
    const temp = toFiniteNumber(config.temp);
    if (temp !== undefined) args.push('--temp', String(temp));
    const topK = toFiniteNumber(config.topK);
    if (topK !== undefined) args.push('--top-k', String(topK));
    const topP = toFiniteNumber(config.topP);
    if (topP !== undefined) args.push('--top-p', String(topP));
    const minP = toFiniteNumber(config.minP);
    if (minP !== undefined) args.push('--min-p', String(minP));
    const presencePenalty = toFiniteNumber(config.presencePenalty);
    if (presencePenalty !== undefined) args.push('--presence-penalty', String(presencePenalty));
    const repeatPenalty = toFiniteNumber(config.repeatPenalty);
    if (repeatPenalty !== undefined) args.push('--repeat-penalty', String(repeatPenalty));
    const nCpuMoe = toFiniteNumber(config.nCpuMoe);
    // --n-cpu-moe is emitted LAST (below, after argString): llama.cpp applies tensor overrides
    // first-match-wins in command-line order, and -ncmoe appends CPU patterns for layers 0..N-1
    // where it appears. Emitted here, before the argString's `-ot ...=CUDA0` rules, it silently
    // disabled them -- every Flash-Next profile since 2026-09-22 kept its "3060" experts on the CPU.
    // --jinja must precede --chat-template-file -- llama.cpp only accepts a
    // custom (non-built-in) template file when --jinja was already set by the
    // time it processes this flag (see arg.cpp's --chat-template-file help text).
    // So a custom template file forces --jinja even if the checkbox is off.
    const chatTemplateFile = toNonEmptyString(config.chatTemplateFile);
    if (config.jinja || chatTemplateFile) args.push('--jinja');
    if (chatTemplateFile) args.push('--chat-template-file', chatTemplateFile);
    const mmprojPath = toNonEmptyString(config.mmprojPath);
    if (config.mmprojEnabled && mmprojPath) {
        args.push('--mmproj', mmprojPath);
        // Keep the projector in system RAM instead of VRAM (frees ~0.9 GB for
        // the F16 Qwen3.8 mmproj; the vision encoder only runs when an image
        // is actually embedded). That's the dashboard's default: the flag is
        // emitted unless the config explicitly asks for GPU placement
        // (mmprojOffload: true, llama.cpp's own default) -- and only for
        // builds that know the flag (older llama.cpp dies on unknown options).
        if (config.mmprojOffload !== true && buildSupportsFlag(config.build, '--mmproj-offload')) {
            args.push('--no-mmproj-offload');
        }
    }
    const loadMode = toNonEmptyString(config.loadMode);
    if (loadMode) args.push('-lm', loadMode);
    const verbosity = toFiniteNumber(config.verbosity);
    if (verbosity !== undefined) args.push('-lv', String(verbosity));
    // Item 6: pass-through raw arg string (takes priority when provided).
    // tokenizeCommand (not a plain whitespace split) so quoted spans like
    // `--chat-template-kwargs '{"preserve_thinking": true}'` survive as ONE
    // argument instead of quote-laden fragments.
    const argString = toNonEmptyString(config.argString);
    if (argString) {
        const rawTokens = tokenizeCommand(argString.trim());
        for (let i = 0; i < rawTokens.length; i++) {
            const t = rawTokens[i];
            if (t === '-m' && i + 1 < rawTokens.length) {
                args.push('-m', mapModelPath(rawTokens[++i]));
            } else {
                args.push(t);
            }
        }
    }
    if (nCpuMoe !== undefined) args.push('--n-cpu-moe', String(nCpuMoe));
    return args;
}

// --- LAUNCH COMMAND RESOLUTION (structured config -> command + args) ---
// Shared by /api/preview-command (which only needs the resolved command/args
// to show the user, never spawns anything) and /api/start's fallback path
// (used when the raw-command box is empty). This is the "convenience
// generator" for the box's starting content -- once a user has edited the
// box, THIS function is no longer consulted for that launch; see the
// rawCommand branch in /api/start.
//
// The master always launches natively (no Docker) on an ordered device list
// -- any mix of local GPUs and RPC workers (lib/devices.js). Configs from
// clients that still send deviceA/deviceB/rpcTarget/tensorSplit are converted.
function resolveLaunchCommand(config) {
    if (config.engine === 'strata') {
        const r = strataModel.resolveLaunch(config.strataBase, config);
        const tokens = tokenizeCommand(r.command);
        const command = tokens[0];
        const args = tokens.slice(1);
        const plan = { devices: strataPlanDevices(args), workers: [], warnings: [] };
        return { command, args, plan };
    }
    const command = getLlamaServerBinary(config.build);
    const mapModelPath = (p) => p; // raw host path, no container mount to remap into
    const plan = planLaunchDevices(config);
    // How a launch on several devices is divided (lib/devices.js splitModeOf). `row` in the field is refused here;
    // in the extra arguments it is the user's own text, so it is only warned about.
    const split = devicesModel.splitModeOf(config);
    if (split.problem && split.source === 'field') throw new Error(split.problem);
    if (split.problem) plan.warnings.push(split.problem);
    if (split.overridden) plan.warnings.push(`Extra arguments set the split mode to ${split.mode}; that is what llama-server uses`);
    plan.splitMode = plan.devices.length > 1 ? split.mode : null;
    const deviceArgs = devicesModel.deviceArgs(plan, rpcEndpointFor, { splitMode: config.splitMode });
    // the draft model follows its card when that card's id was re-pointed
    const draft = config.specDraftDevice && plan.idMap[config.specDraftDevice];
    const args = buildLlamaArgs(draft ? { ...config, specDraftDevice: draft } : config, { mapModelPath, deviceArgs });
    return { command, args, plan };
}

// The card(s) an engine with its own launcher (Strata) runs on: the cards its `--gpu` list names by position, else the
// first card -- the rule lib/launchguard.js applies. As launch devices ({ id, name }), so telemetry and the device
// table read it like any other launch. [] while no card is known (the device probe has not answered).
function strataPlanDevices(args) {
    const cards = currentTopology().cards;
    if (!cards.length) return [];
    let list = String(extractLastFlagValue(args || [], '--gpu') || '').split(',');
    // Strata's own configs keep the list in the JSON file (`"gpu": 0` or `"gpu": [0, 1]`), not on the command line.
    const cfgPath = (args || []).find((x) => /\.json$/.test(String(x)));
    if (!extractLastFlagValue(args || [], '--gpu') && cfgPath) {
        try { const g = JSON.parse(fsSync.readFileSync(cfgPath, 'utf8')).gpu; if (g !== undefined && g !== null) list = [].concat(g).map(String); } catch { /* unreadable: first card */ }
    }
    const gpus = list.map((x) => Number(String(x).trim())).filter((n) => String(n) !== 'NaN' && Number.isInteger(n) && n >= 0 && cards[n]);
    return [...new Set(gpus.length ? gpus : [0])].map((n) => ({ id: cards[n].preferredId, name: cards[n].name }));
}

// The device plan for a config: local devices re-pointed at THIS machine's
// cards (lib/topology.js launchDevices, against this build's cached
// --list-devices: an id that moved follows its card, two identical cards stay
// two cards, a card this machine lacks is replaced by one at least as big
// when the profile recorded its size), RPC ids assigned, workers validated.
// `warnings` says what was re-pointed or doesn't match; `idMap` which saved
// ids became which (so --spec-draft-device can follow). While the build's
// device list is unknown nothing is re-pointed, as before.
function planLaunchDevices(config) {
    const binary = launchBinaryOf(config);
    const detected = detectedFor(binary);
    const saved = devicesModel.configDevices(config);
    let devices = saved, warnings = [], idMap = {}, status = 'ready';
    if (detected && detected.length) {
        ({ devices, warnings, idMap, status } = topologyModel.launchDevices(saved, currentTopology(binary), { reference: currentTopology() }));
    }
    const plan = devicesModel.planDevices({ devices }, dashboardConfig.rpcWorkers);
    plan.warnings = warnings;
    plan.idMap = idMap;
    plan.status = status;
    return plan;
}

// The host --rpc dials for an SSH target ("laptop", "user@laptop",
// "user@192.168.1.125"). `ssh -G` applies ~/.ssh/config, so a Host alias's
// HostName -- the LAN IP at home, a Tailscale address away -- is the single
// place to repoint the worker. Falls back to the literal host, minus any
// user@ and :port (the RPC port, rpcWorker.port, is appended separately).
function hostFromRpcTarget(target) {
    const s = String(target || '').trim();
    const literal = (s.split('@').pop() || s).split(':')[0];
    if (!isValidSSHHost(s)) return literal;
    try {
        const out = require('child_process').execFileSync('ssh', ['-G', s],
            { encoding: 'utf-8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
        const m = out.match(/^hostname\s+(\S+)$/m);
        // An IPv6 HostName can't be written as host:port for --rpc.
        return m && !m[1].includes(':') ? m[1] : literal;
    } catch {
        return literal;
    }
}

// Shell-safe quoting for the displayed/copied launch command. JSON.stringify
// is not shell-safe: inside its double quotes, $, backtick, and ! can still
// expand in an interactive shell. Single quotes are inert (except for the
// '\'' escape), so anything not plain-safe gets wrapped in those.
function shellQuoteArg(arg) {
    const s = String(arg);
    if (s.length === 0) return "''";
    // No quoting needed for simple values -- keeps the command readable.
    if (/^[A-Za-z0-9._\/:-]+$/.test(s)) return s;
    return "'" + s.replace(/'/g, "'\\''") + "'";
}

// The displayed/broadcast command stays copy-pasteable and unambiguous about
// argument boundaries (see shellQuoteArg).
function formatCommand(command, args) {
    return [shellQuoteArg(command), ...args.map(shellQuoteArg)].join(' ');
}

// Last occurrence of `flag`'s value (the FOLLOWING token) in a token array --
// later flags override earlier ones, same as the shell / llama-server do.
function extractLastFlagValue(tokens, flag) {
    for (let i = tokens.length - 1; i >= 0; i--) {
        if (tokens[i] === flag && i + 1 < tokens.length) return tokens[i + 1];
    }
    return undefined;
}

// Minimal shell-lite tokenizer for the raw-command box: splits on whitespace,
// respecting single/double-quoted spans (no escape-sequence support -- good
// enough for llama-server flags and JSON args like --chat-template-kwargs
// '{"preserve_thinking": true}', which is the actual case this needs to handle).
function tokenizeCommand(str) {
    const tokens = [];
    let current = '';
    let quoteChar = null;
    for (let i = 0; i < str.length; i++) {
        const c = str[i];
        if (quoteChar) {
            if (c === quoteChar) quoteChar = null;
            else current += c;
        } else if (c === '"' || c === "'") {
            quoteChar = c;
        } else if (/\s/.test(c)) {
            if (current.length > 0) { tokens.push(current); current = ''; }
        } else {
            current += c;
        }
    }
    if (current.length > 0) tokens.push(current);
    return tokens;
}

// --- SHARED PROCESS SPAWN + LIFECYCLE ---
// Lines that mean the process is actually dying or unusable. Deliberately NOT
// "any line containing 'error:' or 'abort'" -- llama-server logs non-fatal
// client aborts and per-request errors all the time, and the old substring
// check would have SIGTERM'd a healthy model server over any of them. A
// process that exits on its own is handled by the 'close' handler below.
// "failed to fit params to free device memory" was here too, but it's not
// actually fatal: llama.cpp's own common_init_result ctor calls
// common_fit_params(), ignores its return value, and proceeds to
// llama_model_load_from_file() regardless. It fires whenever -ngl/-ts are
// pinned and the config is close to the edge (which ours always is), and the
// real allocator frequently succeeds anyway -- killing on sight of this line
// was aborting launches that would have come up fine. Genuine failures still
// surface via the 'ready' timeout or a real exit/crash (see 'close' handler).
const FATAL_LINE_RE = /llama_server: fatal error|segfault|out of memory/i;

// An allocator out-of-memory line while the model is still loading (e.g.
// `ggml_backend_cuda_buffer_type_alloc_buffer: ... cudaMalloc failed: out of
// memory` during compute-buffer reservation). llama.cpp can still recover from
// these, so they aren't fatal until the model is up.
function isRecoverableLoadOom(line) {
    return (serverState === 'starting' || serverState === 'loading')
        && /out of memory/i.test(line)
        && !/llama_server: fatal error|segfault/i.test(line);
}
// The master is always a directly-spawned llama-server binary now (no Docker
// invocation). `onErrorCleanup`, if given, is called (in addition to
// `proc.kill()`) when handleLogs detects an abort/OOM/error line -- currently
// always omitted, since a direct spawn has nothing extra to tear down; kept
// as a hook for whatever future launch path might need one.
function spawnLlamaProcess(command, args, { cwd, onErrorCleanup } = {}) {
    const proc = spawn(command, args, { cwd: cwd || ROOT_DIR, stdio: ['ignore', 'pipe', 'pipe'] });

    // Line-buffering to prevent regex misses when stdout chunks split a single
    // log line across multiple 'data' events (item 7)
    let logLineBuffer = '';

    const handleLogs = (d) => {
        const text = d.toString();
        process.stdout.write(text);

        // Buffer partial lines to handle chunk boundaries (item 7). \r counts
        // as a line terminator -- otherwise a \r-only output phase grows this
        // buffer (and re-splits all of it per chunk) for as long as the phase
        // lasts. The cap is a last-resort bound for a process that emits
        // unbounded output with no line breaks at all.
        logLineBuffer += text;
        const bufferedLines = logLineBuffer.split(/\r\n|\r|\n/);
        logLineBuffer = bufferedLines.pop() || '';
        if (logLineBuffer.length > 1_000_000) logLineBuffer = logLineBuffer.slice(-4096);

        for (const line of bufferedLines) {
            // Ring buffer for /api/master/logs (item 5) gets the SAME
            // reconstructed whole lines as the parser below -- pushing raw
            // chunk fragments used to split one physical line across two
            // entries whenever a chunk boundary landed mid-line.
            if (line.length > 0) {
                masterLogBuffer.push(line);
                if (masterLogBuffer.length > MASTER_LOG_BUFFER_SIZE) {
                    masterLogBuffer.shift();
                }
            }
            if (line.includes('load_model: loading model')) {
                serverState = 'loading';
                broadcastState();
            }
            else if (line.includes('llama_server: model loaded') || line.startsWith('ready: http://')) {
                // 'ready: http://' is the Strata engine's serve/server.py up-line -- same state
                // transition as llama-server's model-loaded line, since a strata launch goes
                // through /api/start's rawCommand branch too.
                const m = line.match(/ready:\s*http:\/\/[^:]+:(\d+)/);
                if (m && currentLaunchConfig) {
                    currentLaunchConfig.port = parseInt(m[1], 10);
                }
                console.log("MODEL LOADED! READY!");
                serverState = 'ready';
                if (loadStartTime > 0) {
                    finalLoadTime = ((Date.now() - loadStartTime) / 1000).toFixed(1);
                    loadStartTime = 0;
                }
                broadcastState();
            }
            else if (line.includes('launch_slot_:') && line.includes('processing task')) {
                // Unconditional per-request start signal -- unlike the progress
                // lines below (llama.cpp only prints those once n_decoded >= 100
                // or t_prompt_processing >= 3000ms internally), this always fires,
                // so it's the only reliable way to start Monitor Mode's telemetry
                // sampling for short/fast requests that never cross those thresholds.
                liveProgress = {}; // new request -- drop the previous one's phase state
                lastPrefillPoint = null;
                markRequestActivity();
            }
            else if (line.includes('prompt processing, n_tokens =')) {
                // llama.cpp's progress line reports a CUMULATIVE rate
                // (n_tokens / elapsed), not an instantaneous one. On a long
                // prefill that decays steadily as the rate drops with depth --
                // e.g. 664 -> 332 t/s over a 104k prompt -- so plotting it looks
                // like a rate curve but is actually a running average, and its
                // final value equals the summary line's average. Generation
                // doesn't have this problem because llama.cpp prints tg_3s
                // alongside tg; prefill has no equivalent, so derive it here
                // from the delta between consecutive progress lines.
                const nTokensMatch = line.match(/n_tokens =\s*(\d+)/);
                const progressMatch = line.match(/progress = (0\.\d+|1\.00)/);
                const tpsMatch = line.match(/(\d+\.?\d*)\s*tokens per second/);
                const elapsedMatch = line.match(/t =\s*([\d.]+)\s*s/);
                if (progressMatch) {
                    const nTokens = nTokensMatch ? nTokensMatch[1] : '0';
                    const tps = tpsMatch ? tpsMatch[1] : '0';
                    const nTok = parseInt(nTokens, 10) || 0;
                    const elapsed = elapsedMatch ? parseFloat(elapsedMatch[1]) : null;
                    let instTps = null;
                    if (elapsed != null && lastPrefillPoint) {
                        const dTok = nTok - lastPrefillPoint.nTok;
                        const dT = elapsed - lastPrefillPoint.t;
                        if (dTok > 0 && dT > 0.01) instTps = dTok / dT;
                    }
                    if (elapsed != null) lastPrefillPoint = { nTok, t: elapsed };
                    // First point of a prefill has no previous delta -- the
                    // cumulative value IS the instantaneous one there.
                    const shownTps = instTps != null ? instTps : (parseFloat(tps) || null);
                    liveProgress = {
                        prefillTps: shownTps,               // instantaneous: what charts/samples want
                        prefillTpsAvg: parseFloat(tps) || null, // cumulative, as llama.cpp reports it
                        prefillProgress: parseFloat(progressMatch[1]),
                        prefillTokens: nTok || null,
                    };
                    // 4th field appended; older clients read only 1-3 and are unaffected.
                    broadcastState(`PREFILL_PROGRESS:${progressMatch[1]}:${tps}:${nTokens}:${shownTps != null ? shownTps.toFixed(2) : ''}`);
                    markRequestActivity();
                }
            }
            else if (line.includes('print_timing:')) {
                // Live per-slot gen progress (print_timings_tg() in
                // tools/server/server-context.cpp -- at most one line per 3s,
                // and only once n_gen >= 100). The SLT_INF macro truncates
                // __func__ to 12 chars, so this line, the prefill-progress
                // line, and the final summary ALL share the "slot print_timing:
                // id N | task N | " prefix. The live line's actual format:
                //   n_gen =  100, tg = 27.00 t/s, tg_3s = 26.50 t/s
                //
                // It used to match "n_decoded =" -- a field that only exists in
                // the /slots HTTP JSON, never in stdout -- so this half of the
                // branch never fired. Consequences: no GEN_PROGRESS broadcasts
                // (sidebar's Gen card pegged on the last request's final value
                // for as long as no NEW dashboard request reset it), no genTps
                // in recorded samples (no gen line in the Monitor/History omni
                // graphs), and -- most damaging -- no markRequestActivity()
                // during generation, so the 3s activity-timeout sampler stopped
                // recording ~3s after prefill ended. That's why omni graphs
                // spanned only the prefill plus a tail (25s) while the CSV row
                // honestly said the request took 100+s.
                const nGenMatch = line.match(/n_gen\s*=\s*(\d+)/) || line.match(/n_decoded\s*=\s*(\d+)/);
                const tg3sMatch = line.match(/tg_3s\s*=\s*(\d+\.?\d*)\s*t\/s/);
                const tgMatch = line.match(/tg\s*=\s*(\d+\.?\d*)\s*t\/s/);
                if (nGenMatch && (tg3sMatch || tgMatch)) {
                    // tg_3s is the last-3-second window -- the actual current
                    // speed. tg is the average since generation started.
                    // Broadcast BOTH: the live Monitor row wants the average
                    // (tg), the sidebar card wants the instantaneous (tg_3s).
                    const avgTps = tgMatch ? tgMatch[1] : (tg3sMatch ? tg3sMatch[1] : '0');
                    const instTps = tg3sMatch ? tg3sMatch[1] : (tgMatch ? tgMatch[1] : '0');
                    // Generation phase -- clear any prefill-phase state so
                    // telemetry samples taken from here on carry the gen rate,
                    // not a stale prefill stamp. Use tg_3s for the server-side
                    // sample (instantaneous = better for a live chart line).
                    liveProgress = { genTps: parseFloat(instTps) || null, genTokens: parseInt(nGenMatch[1], 10) || null };
                    broadcastState(`GEN_PROGRESS:${avgTps}:${instTps}:${nGenMatch[1]}`);
                    markRequestActivity();
                }

                // Per-request completion summary (Monitor Mode / Item 12): three
                // lines per request, tagged by task id, arriving in this order --
                // "prompt eval time", "eval time", "total time" (the last of which
                // triggers the actual log+broadcast). The segment after the LAST
                // '|' distinguishes them; "prompt eval time" would otherwise also
                // match a plain /eval time/ substring check.
                const idTaskMatch = line.match(/id\s+(\d+)\s*\|\s*task\s+(\d+)/);
                if (idTaskMatch) {
                    const taskId = idTaskMatch[2];
                    const segments = line.split('|');
                    const lastSegment = segments[segments.length - 1].trim();
                    if (lastSegment.startsWith('prompt eval time')) {
                        const m = lastSegment.match(/=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens[^)]*?([\d.]+)\s*tokens per second/);
                        if (m) {
                            const existing = taskTimingsByTaskId.get(taskId) || {};
                            taskTimingsByTaskId.set(taskId, { ...existing, promptMs: parseFloat(m[1]), promptTokens: parseInt(m[2], 10), promptTps: parseFloat(m[3]) });
                        }
                    } else if (lastSegment.startsWith('eval time')) {
                        const m = lastSegment.match(/=\s*([\d.]+)\s*ms\s*\/\s*(\d+)\s*tokens[^)]*?([\d.]+)\s*tokens per second/);
                        if (m) {
                            const existing = taskTimingsByTaskId.get(taskId) || {};
                            taskTimingsByTaskId.set(taskId, { ...existing, genMs: parseFloat(m[1]), genTokens: parseInt(m[2], 10), genTps: parseFloat(m[3]) });
                        }
                    } else if (lastSegment.startsWith('total time')) {
                        const m = lastSegment.match(/=\s*([\d.]+)\s*ms/);
                        const timing = taskTimingsByTaskId.get(taskId) || {};
                        taskTimingsByTaskId.delete(taskId);
                        if (m) {
                            // Capture samples, the completion timestamp, AND
                            // the launch config/command NOW -- the sample
                            // buffer is shared, so waiting out the flush delay
                            // would let the next request's samples bleed into
                            // this one's series, and the prefill/gen split in
                            // logCompletedRequest counts genMs back from this
                            // moment, not from whenever we flush. The config is
                            // captured here too because a server stop within
                            // the flush window nulls currentLaunchConfig, which
                            // would leave the CSV row without a model/config.
                            const pending = {
                                timing: { ...timing, wallTimeS: (parseFloat(m[1]) / 1000).toFixed(2) },
                                samples: takeRequestSamples(),
                                completedAt: Date.now(),
                                config: currentLaunchConfig,
                                launchCommand: currentLaunchCommand,
                                timer: null,
                            };
                            pending.timer = setTimeout(() => {
                                pendingCompletionsByTaskId.delete(taskId);
                                logCompletedRequest(pending.timing, pending.samples, pending.completedAt, {
                                    config: pending.config,
                                    launchCommand: pending.launchCommand,
                                }).catch(() => { });
                            }, COMPLETION_FLUSH_DELAY_MS);
                            pendingCompletionsByTaskId.set(taskId, pending);
                            rememberCompletedTaskId(taskId);
                        }
                    } else if (lastSegment.startsWith('draft acceptance')) {
                        // `draft acceptance = 0.76471 (   13 accepted /    17 generated), mean len =  1.76`
                        // -- only printed when the request actually drafted tokens.
                        const dm = lastSegment.match(/=\s*([\d.]+)\s*\(\s*(\d+)\s*accepted\s*\/\s*(\d+)\s*generated\s*\)(?:\s*,\s*mean len\s*=\s*([\d.]+))?/);
                        const pending = pendingCompletionsByTaskId.get(taskId);
                        if (dm && pending) {
                            // No early flush any more: the slot-release line that carries the
                            // context depth ("stop processing: n_tokens = N") comes right after
                            // this one, and the pending timer (COMPLETION_FLUSH_DELAY_MS) waits for it.
                            Object.assign(pending.timing, {
                                draftAcceptRate: parseFloat(dm[1]),
                                draftAccepted: parseInt(dm[2], 10),
                                draftGenerated: parseInt(dm[3], 10),
                                draftMeanLen: dm[4] != null ? parseFloat(dm[4]) : null,
                            });
                        }
                    }
                }
            }
            else if (line.includes('stop processing: n_tokens =')) {
                // Slot release line -- fires on BOTH natural completion and
                // client-side cancel (opencode/agents abort streams constantly;
                // llama.cpp prints NO timing lines for those, so canceled
                // requests -- often the longest thinking runs -- silently
                // produced no row at all). After a grace delay, if no natural
                // completion was seen for this task, synthesize a row from the
                // live progress state.
                const relTaskMatch = line.match(/task\s+(\d+)/);
                // How many tokens the slot held when this request ended -- the context DEPTH the
                // request ran at. The per-request log never recorded it before 2026-09-24, so every
                // "prefill t/s at N tokens" figure could only mean N NEW tokens.
                const depthMatch = line.match(/stop processing: n_tokens\s*=\s*(\d+)/);
                const depthEnd = depthMatch ? parseInt(depthMatch[1], 10) : null;
                if (relTaskMatch && depthEnd != null) {
                    const pendingDone = pendingCompletionsByTaskId.get(relTaskMatch[1]);
                    if (pendingDone) pendingDone.timing.depthEnd = depthEnd;
                }
                if (relTaskMatch) {
                    const taskId = relTaskMatch[1];
                    const live = { ...liveProgress };
                    // Same config-capture rationale as the "total time" branch:
                    // the 400ms delay below can outlive a server stop.
                    const launchConfig = currentLaunchConfig;
                    const launchCommand = currentLaunchCommand;
                    setTimeout(() => {
                        if (pendingCompletionsByTaskId.has(taskId) || recentlyCompletedTaskIds.has(taskId)) return;
                        if (!live.genTokens && !live.prefillTokens) return; // nothing observed -- not worth a row
                        rememberCompletedTaskId(taskId); // guard against double-fire
                        const timing = {
                            promptTokens: live.prefillTokens ?? null,
                            promptTps: live.prefillTps ?? null,
                            genTokens: live.genTokens ?? null,
                            genTps: live.genTps ?? null,
                            aborted: true,
                            depthEnd,
                        };
                        logCompletedRequest(timing, takeRequestSamples(), Date.now(), {
                            config: launchConfig,
                            launchCommand,
                        }).catch(() => { });
                    }, 400);
                }
            }
            else if (line.includes('failed to fit params to free device memory')) {
                // llama.cpp's pre-load memory estimate, ~2 s in. Not fatal (see
                // FATAL_LINE_RE), but it's the early sign that the load will
                // probably run out of VRAM at the very end, after the weights
                // are uploaded -- say so now instead of a minute later.
                broadcastState('', 'LOAD WARNING: llama.cpp estimates this config does not fit in free VRAM. '
                    + 'n_gpu_layers is pinned, so it loads anyway; expect an out-of-memory failure when loading finishes '
                    + 'unless you lower context/shares or free VRAM (other GPU processes count against the estimate).');
            }
            else if (isRecoverableLoadOom(line)) {
                // Not the end of the load: llama.cpp retries the compute-buffer
                // allocation without pipeline parallelism (llama-context.cpp
                // sched_reserve), and if that fails too it throws and exits on
                // its own, which the 'close' handler reports. Killing here
                // aborted loads that could still come up.
                broadcastState('', 'LOAD WARNING: compute buffer allocation failed (' + line.trim().slice(-120)
                    + '); llama.cpp retries once without pipeline parallelism, which needs less VRAM.');
            }
            else if (FATAL_LINE_RE.test(line)) {
                serverState = 'stopped';
                proc.kill();
                if (onErrorCleanup) onErrorCleanup().catch(() => { });
                broadcastState('', 'Process error: ' + line.trim().slice(-200));
            }
        }
    };

    proc.stdout.on('data', handleLogs);
    proc.stderr.on('data', handleLogs);

    // Single source of truth for tearing down shared state: fires exactly once
    // per spawned process, after it has actually closed.
    proc.on('close', (code, signal) => {
        // Flush any final partial line (output without a trailing newline)
        // into the ring buffer before tearing down the listeners.
        if (logLineBuffer.length > 0) {
            masterLogBuffer.push(logLineBuffer);
            if (masterLogBuffer.length > MASTER_LOG_BUFFER_SIZE) {
                masterLogBuffer.shift();
            }
            logLineBuffer = '';
        }
        // FATAL_LINE_RE (correctly) no longer matches every 'error:' line, so
        // failures where llama-server exits ON ITS OWN before becoming ready
        // (failed to load model/draft, context creation, Vulkan OOM) would
        // otherwise die silently -- surface their last error lines. Must be
        // computed BEFORE the state reset below and sent in the SAME
        // broadcastState call as the 'stopped' transition -- the client only
        // renders a visible error bubble when state and error co-arrive in one
        // SSE message (see handleSseMessage's 'stopped' branch); splitting
        // them into two broadcasts (error-while-'starting', then
        // stopped-with-no-error) makes the failure die silently in the UI.
        let launchFailureMsg = '';
        if (llamaProcess === proc && serverState !== 'ready' && serverState !== 'stopped') {
            const errLines = masterLogBuffer.filter(l => /\sE\s|error|failed/i.test(l)).slice(-2);
            if (errLines.length > 0) {
                launchFailureMsg = 'Launch failed: ' + errLines.join(' | ').slice(0, 300);
            }
        }
        proc.stdout.removeAllListeners('data');
        proc.stderr.removeAllListeners('data');
        if (llamaProcess === proc) {
            llamaProcess = null;
            serverState = 'stopped';
            currentModel = '';
            isRpc = false;
            currentLaunchConfig = null;
            broadcastState('', launchFailureMsg);
        }
    });

    proc.on('error', (err) => {
        console.error('Llama process error:', err);
        if (llamaProcess === proc) {
            llamaProcess = null;
            serverState = 'stopped';
            currentLaunchConfig = null;
            broadcastState('', 'Failed to start process: ' + err.message);
        }
    });

    return proc;
}

// --- CSV LOG INIT ---
// Schema v2 (Item #24): Removed Category, Metric, Quant (never populated by client).
// Added run_id (auto-generated), model_name (short), prompt_tokens, arg_string.
// All string fields are quoted in output to handle commas in paths/args.
// Schema v4: added config_json (col 32) -- the full structured launch config
// (buildConfigFromUI() shape + rawCommand) that actually booted the server for
// this row, as JSON. Lets a later model-select/launch-mode change look up
// "what did I run last time for this exact combo" and restore it exactly,
// rather than reconstructing a guess from the scattered individual columns.
const CSV_HEADERS = "Timestamp,run_id,model_name,Model_Path,Ctx,NGL,RPC,Transport,arg_string,launch_command,Prompt Tok/s,Gen Tok/s,Prompt Latency (s),prompt_tokens,Master GPU Util (%),Master GPU Pwr (W),Master GPU Temp (C),Master CPU Util (%),Master CPU Temp (C),Master VRAM (MB),Master RAM (MB),Worker GPU Util (%),Worker GPU Pwr (W),Worker GPU Temp (C),Worker CPU Temp (C),Worker VRAM (MB),Worker RAM (MB),Net Throughput (MB/s),Gen Tokens,Reasoning Tokens,Wall Time (s),Load Time,config_json,Draft Accept Rate,Draft Accepted,Draft Generated,Draft Mean Len,Aborted,Prefill Tps Min,Prefill Tps Max,Gen Tps Min,Gen Tps Max,devices_json\n";
const LOGS_DIR = path.join(ROOT_DIR, 'logs');
const CSV_FILE = path.join(LOGS_DIR, 'benchmarks.csv');

// History chart's parsed-once CSV index (2026-10-01, Kyle) -- lib/history.js createCsvPointIndex:
// /api/logs/range is hit after every pan/zoom, so the 20 MB CSV is split once and only appended bytes
// are read after that. Sync reads on purpose: the tail read is a few KB, and an async read racing a
// second refresh() would double-append. Created lazily (splitCsvLine / parseNumOrNull are below).
let _historyCsvIndex = null;
const historyCsvIndex = {
    refresh() {
        if (!_historyCsvIndex) {
            const fsS = require('fs');
            _historyCsvIndex = historyMerge.createCsvPointIndex(CSV_FILE, {
                io: {
                    statSize: (f) => { try { return fsS.statSync(f).size; } catch { return null; } },
                    readRange: (f, start, end) => {
                        const fd = fsS.openSync(f, 'r');
                        try { const b = Buffer.alloc(end - start); const n = fsS.readSync(fd, b, 0, b.length, start); return b.subarray(0, n); }
                        finally { fsS.closeSync(fd); }
                    },
                },
                split: splitCsvLine, num: parseNumOrNull,
            });
        }
        return _historyCsvIndex.refresh();
    },
};

// Generate a short run_id: timestamp + 4 random hex chars
function generateRunId() {
    const ts = Date.now().toString(36);
    const rand = Math.random().toString(16).slice(2, 6);
    return `${ts}_${rand}`;
}

// Convert any CSV cell to a safe single-line string. Newlines inside a quoted
// field would break the line-based readers in /api/logs/recent and
// /api/logs/summary -- argString in particular comes from a UI textarea, so
// it can carry them. NaN/Infinity become '' (they can't be parsed back).
function csvValue(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number' && !Number.isFinite(v)) return '';
    return String(v).replace(/\r\n|\r|\n/g, ' ');
}

// Parse a CSV cell to a number or null -- unlike `parseFloat(x) || null`, a
// genuine 0 reading survives instead of collapsing to null.
function parseNumOrNull(s) {
    if (s === null || s === undefined) return null;
    const t = String(s).trim();
    if (t === '') return null;
    const n = Number(t);
    return Number.isFinite(n) ? n : null;
}

// Safely quote a CSV field — wraps in double-quotes, escaping internal quotes
function csvQuote(val) {
    if (val === null || val === undefined) return '""';
    const s = String(val);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
        return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
}

// Minimal CSV parser that respects double-quoted fields with embedded commas
// -- shared by /api/logs/summary and /api/logs/recent.
// Single forward character scan -- the previous indexOf-based version could
// send its cursor BACKWARDS on a `""""` sequence (an escaped empty string
// inside a quoted field, e.g. configJson's `""argString"":""""`), re-parsing
// the same line in an infinite loop and OOMing the whole server on the first
// /api/logs/summary call after such a row existed in the CSV.
function splitCsvLine(line) {
    if (!line) return [];
    const cols = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQuotes) {
            if (c === '"') {
                if (line[i + 1] === '"') { field += '"'; i++; } // escaped quote
                else inQuotes = false; // closing quote
            } else field += c;
        } else if (c === '"' && field.length === 0) {
            inQuotes = true; // opening quote of a quoted field
        } else if (c === ',') {
            cols.push(field);
            field = '';
        } else field += c;
    }
    cols.push(field);
    return cols;
}

// Shared by the /api/log HTTP route and logCompletedRequest() (server-side,
// client-agnostic completion capture -- see that function). `data` uses the
// same key names the old frontend-only /api/log payload used, so both
// callers can share this without a translation layer.
async function appendBenchmarkRow(data) {
    await fs.mkdir(LOGS_DIR, { recursive: true }); // self-healing: ensure dir exists even if lost mid-run
    const timestamp = new Date().toISOString();
    const runId = generateRunId();
    const modelPath = data.model || '';
    const modelName = modelPath.split('/').pop();
    // csvValue (not `x || ''`) for every field -- `||` treats a genuine 0
    // (idle GPU util, 0% CPU, a card with no throttle, etc.) as falsy and
    // silently substitutes '', making a real "zero" reading indistinguishable
    // from "field never populated" in the CSV. It also strips newlines so a
    // row always occupies exactly one physical line (see csvValue's comment).
    const fields = [
        timestamp,
        runId,
        csvQuote(csvValue(modelName)),
        csvQuote(csvValue(modelPath)),
        csvValue(data.ctx),
        csvValue(data.ngl),
        csvValue(data.rpc),
        csvQuote(csvValue(data.transport)),
        csvQuote(csvValue(data.argString)),
        csvQuote(csvValue(data.launchCommand)),
        csvValue(data.promptTps),
        csvValue(data.genTps),
        csvValue(data.promptLatency),
        csvValue(data.promptTokens),
        csvValue(data.gpuUtil),
        csvValue(data.gpuPwr),
        csvValue(data.masterGpuTemp),
        csvValue(data.cpuUtil),
        csvValue(data.masterCpuTemp),
        csvValue(data.gpuMem),
        csvValue(data.ramUsage),
        csvValue(data.workerGpuUtil),
        csvValue(data.workerGpuPwr),
        csvValue(data.workerGpuTemp),
        csvValue(data.workerCpuTemp),
        csvValue(data.workerVram),
        csvValue(data.workerRam),
        csvValue(data.netThroughput),
        csvValue(data.genTokens),
        csvValue(data.reasonTokens),
        csvValue(data.wallTime),
        csvValue(data.loadTime),
        csvQuote(csvValue(data.configJson)),
        // Speculative-decoding stats (blank when the run had no draft line).
        // Strictly appended after config_json -- consumers index it as col 32.
        csvValue(data.draftAcceptRate),
        csvValue(data.draftAccepted),
        csvValue(data.draftGenerated),
        csvValue(data.draftMeanLen),
        data.aborted ? '1' : '',
        // Per-request peak/low, appended like the draft columns before them.
        csvValue(data.prefillTpsMin), csvValue(data.prefillTpsMax),
        csvValue(data.genTpsMin), csvValue(data.genTpsMax),
        // Every launch device's reading at completion, as JSON (col 42). The
        // Master/Worker columns above only hold the first two devices.
        csvQuote(csvValue(data.devicesJson))
    ];
    await fs.appendFile(CSV_FILE, fields.join(',') + '\n');
    return runId;
}

// --- CLIENT-AGNOSTIC REQUEST COMPLETION CAPTURE (Monitor Mode) ---
// llama-server logs a `slot print_timing:` block for EVERY completed request
// regardless of which client sent it (this dashboard's chat, opencode, Cline,
// curl, anything hitting the OpenAI-compatible endpoint directly) -- three
// lines per request: "prompt eval time", "eval time", "total time", each
// tagged with `id <slot> | task <id>`. Since the server runs multiple slots
// concurrently (n_slots = 4 by default), several requests' lines can
// interleave in the stdout stream, so *timing* accumulation is keyed by task
// id, not a single shared buffer.
const taskTimingsByTaskId = new Map();

// Completions whose "total time" line has arrived but whose CSV write /
// COMPLETION broadcast is briefly deferred: llama-server prints the
// per-request `draft acceptance = ...` summary a few lines AFTER "total time"
// (see print_timings() in tools/server/server-context.cpp -- prompt eval /
// eval / total time / graphs reused, THEN the draft stats, and only when
// speculative decoding actually drafted something). Holding the completion
// for a beat lets that line join the same record; non-speculative runs (no
// acceptance line ever) flush on the timer with the draft fields absent.
const pendingCompletionsByTaskId = new Map(); // taskId -> { timing, samples, completedAt, timer }
const COMPLETION_FLUSH_DELAY_MS = 500;
// Task ids that reached a natural "total time" completion recently -- used by
// the abort detector (the "stop processing" release line fires for BOTH
// natural and canceled ends, and by the time its grace delay runs, a natural
// completion's pending entry may already have flushed and been deleted).
const recentlyCompletedTaskIds = new Set();
function rememberCompletedTaskId(taskId) {
    recentlyCompletedTaskIds.add(taskId);
    setTimeout(() => recentlyCompletedTaskIds.delete(taskId), 30000);
}

// Per-request telemetry sampling for Monitor Mode's "omni graph" (GPU
// power/temp/util over the course of a request, not just the final tps
// summary). Deliberately a SINGLE shared sample buffer, not per-task like the
// timing map above -- properly isolating samples per concurrent task would
// mean tagging each monitor.py poll to whichever task(s) were active at that
// instant, which is real complexity for a case (multiple truly-simultaneous
// requests from different clients) that's rare in this dashboard's actual
// usage (one interactive user, occasional external tool calls). Overlapping
// requests share the same sample series rather than each getting a perfectly
// isolated one -- an acceptable simplification, not a correctness issue for
// the timing/CSV data itself (only for how the graph looks under overlap).
// Activity-timeout heuristic rather than precise increment/decrement pairing:
// the prefill progress log line doesn't reliably carry a task id the way the
// print_timing lines do, so there's no clean per-task "this request just
// started" signal to count against later. Instead, any progress line (prefill
// or gen) just bumps lastActivityTimestamp; the sampling loop keeps running
// as long as something was seen recently, and stops itself after a quiet
// period. Simpler and self-healing (never gets stuck "active" forever from a
// missed decrement) at the cost of the same overlapping-requests imprecision
// already noted above.
let activeRequestSamples = [];
let lastActivityTimestamp = 0;
let telemetrySamplingTimer = null;
const SAMPLE_INTERVAL_MS = 1000;
const ACTIVITY_TIMEOUT_MS = 3000;
const MAX_SAMPLES_PER_REQUEST = 300; // ~5 min at 1s/sample; caps memory for a pathologically long request

// Guards against overlapping calls piling up -- fetchCurrentTelemetry can now
// take up to 10s (see its own comment), but the sampling interval below still
// ticks every 1s regardless of whether the previous call finished. Without
// this, a slow monitor.py would accumulate multiple concurrent in-flight
// requests to it, adding more load to the exact thing that's already slow.
let telemetrySampleInFlight = false;
async function takeOneTelemetrySample(statsArg) {
    if (telemetrySampleInFlight) return;
    telemetrySampleInFlight = true;
    try {
        const stats = statsArg || await fetchCurrentTelemetry();
        if (!stats) return;
        // Live context position from llama-server's /slots endpoint -- the only
        // client-agnostic source of real context usage (n_prompt_tokens tracks
        // the slot's absolute context position, growing during generation).
        try {
            // Validated: config.port only ever comes from the launch config or
            // a raw command's --port (see /api/start's sync) -- anything else
            // falls back to the default 8080.
            const port = portFromLaunchCommand();
            const slotsRes = await fetch(`http://localhost:${port}/slots`, { signal: AbortSignal.timeout(1500) });
            const slots = await slotsRes.json();
            const slot = Array.isArray(slots) ? slots[0] : null;
            if (slot && slot.n_ctx) {
                broadcastState(`CTX_LIVE:${slot.n_prompt_tokens ?? 0}:${slot.n_ctx}:${slot.is_processing ? 1 : 0}`);
            }
        } catch { /* endpoint disabled/unreachable -- context card just stays client-driven */ }
        // Net MB/s from the byte-counter delta -- used to be a client-only
        // computation, leaving the omni Net line permanently empty for
        // server-recorded samples.
        let netMbps = null;
        const nb = stats.master?.net_bytes;
        if (typeof nb === 'number' && lastSampleNetBytes != null && nb >= lastSampleNetBytes && lastSampleNetTime) {
            const dt = (Date.now() - lastSampleNetTime) / 1000;
            if (dt > 0.05) netMbps = +(((nb - lastSampleNetBytes) / 1048576) / dt).toFixed(2);
        }
        if (typeof nb === 'number') { lastSampleNetBytes = nb; lastSampleNetTime = Date.now(); }
        activeRequestSamples.push({
            t: Date.now(),
            netMbps,
            masterPwr: stats.master?.gpu_pwr ?? 0, masterTemp: stats.master?.gpu_temp ?? 0,
            // Per-sample thermal-throttle state, so the charts can mark the
            // exact stretch where a card was heat-limited. Deliberately only
            // /thermal/ reasons: sw_power_cap is permanently active on this rig
            // (80W firmware cap) and would mark every single sample.
            masterThermal: isRealThermal(stats.master),
            workerThermal: isRealThermal(stats.worker),
            masterGpuUtil: stats.master?.gpu_util ?? 0, masterCpuUtil: stats.master?.cpu_util ?? 0,
            workerPwr: stats.worker?.gpu_pwr ?? 0, workerTemp: stats.worker?.gpu_temp ?? 0,
            workerGpuUtil: stats.worker?.gpu_util ?? 0,
            // VRAM in GB (monitor.py reports MiB) -- lets the charts show KV
            // cache growth during long prefills.
            masterVram: stats.master?.vram_used != null ? +(stats.master.vram_used / 1024).toFixed(2) : null,
            workerVram: stats.worker?.vram_used != null ? +(stats.worker.vram_used / 1024).toFixed(2) : null,
            // Every launch device, in launch order (null with no launch) --
            // the master*/worker* fields above cover only the first two.
            devices: stats.devices ? stats.devices.map(telemetryModel.sampleFromRecord) : null,
            // Real per-tick phase data from llama-server's own progress lines
            // (see liveProgress). Null in whichever phase doesn't apply.
            prefillTps: liveProgress.prefillTps ?? null,
            // Cumulative rate as llama.cpp reports it -- charted alongside the
            // instantaneous one so the running average stays visible (it is what
            // the per-request summary row shows) without being mistaken for the
            // live rate.
            prefillTpsAvg: liveProgress.prefillTpsAvg ?? null,
            prefillProgress: liveProgress.prefillProgress ?? null,
            prefillPos: liveProgress.prefillTokens ?? null,
            genTps: liveProgress.genTps ?? null,
        });
        if (activeRequestSamples.length > MAX_SAMPLES_PER_REQUEST) activeRequestSamples.shift();
    } finally {
        telemetrySampleInFlight = false;
    }
}

// A REAL thermal limit, not just nvidia-smi's reason flags -- see
// lib/telemetry.js for why sw_thermal_slowdown alone doesn't count.
const { isRealThermal } = telemetryModel;

function markRequestActivity() {
    lastActivityTimestamp = Date.now();
    // Immediate first sample -- short requests can finish before the shared
    // 1s loop ever ticks. Cadence afterwards comes from the single unified
    // telemetry loop below (no per-request interval anymore).
    if (activeRequestSamples.length === 0) takeOneTelemetrySample();
}

// --- UNIFIED TELEMETRY LOOP ---
// One poller for everything: polls monitor.py at the user-selected rate
// (POST /api/telemetry/rate), caches the latest reading for the sidebar
// (GET /api/telemetry/latest -- no nvidia-smi shellout per sidebar tick
// anymore), and, while a request or bench run is active, records samples
// into activeRequestSamples for the omni charts. Replaces three separate
// pollers that all shelled out to nvidia-smi/amdgpu_top independently.
let telemetryPollMs = 1000;
let telemetryLoopTimer = null;
let lastServerTelemetry = null;
function startTelemetryLoop() {
    if (telemetryLoopTimer) clearInterval(telemetryLoopTimer);
    telemetryLoopTimer = setInterval(async () => {
        if (telemetrySampleInFlight) return;
        const stats = await fetchCurrentTelemetry();
        if (!stats) return;
        // The same tick for everyone: GPUs + every busy server's live rates (lanesForMonitor), and the single-server
        // path's rates (`live`) for a model this dashboard launched itself.
        let lanes = [];
        try { lanes = lanesForMonitor(); } catch { lanes = []; }
        lanesForMonitorLast = lanes;
        // Every open lane request's series takes this tick's record of its lane (lib/reqsamples.js).
        try { laneRequests.tick(lanesLiveFull, (lane) => laneDeviceReadings(lane, stats), Date.now()); } catch { /* best-effort */ }
        const genTpsNow = liveProgress.genTps ?? (externalSource && externalSource.busy ? externalSource.genTps : null);
        lastServerTelemetry = { t: Date.now(), stats, lanes,
            live: { genTps: genTpsNow ?? null, prefillTps: liveProgress.prefillTps ?? null, prefillProgress: liveProgress.prefillProgress ?? null } };
        sendTick('telemetry', lastServerTelemetry);   // the browsers' sidebars (LIVE TICKS): the same body GET /api/telemetry/latest returns
        // Full-screen telemetry charts read this (lib/telemetryhistory.js). Gen t/s: the managed server's
        // live rate while a request runs, else an external (queue) server's while it is busy.
        try {
            telemetryHistory.push(stats, { genTps: genTpsNow, prefillTps: liveProgress.prefillTps ?? null, lanes }, lastServerTelemetry.t);
        } catch { /* history is best-effort; never break the sampler */ }
        // Also record while a model is loading: on a VRAM-tight rig the load
        // window (VRAM climbing, power/temp ramp) is real signal, and skipping
        // it left a minutes-long hole at the head of every run's chart.
        const loading = serverState === 'starting' || serverState === 'loading';
        const recording = benchRunning || loading || (Date.now() - lastActivityTimestamp < ACTIVITY_TIMEOUT_MS);
        if (recording) await takeOneTelemetrySample(stats);
    }, telemetryPollMs);
}

// --- EXTERNAL SERVER TELEMETRY (/slots poll) ---
// Benchmark queues and codebench batteries launch llama-server on :8080
// themselves (sometimes behind a recording proxy on 8080 -> 18080), so none of
// the stdout parsing above ever sees their requests and the live cards sat at
// 0.0 t/s. While LL-Dash has no server of its own, poll that port's GET /slots
// at ~1 Hz (lib/slots.js turns the counters into rates) and broadcast the SAME
// PREFILL_PROGRESS / GEN_PROGRESS / CTX_LIVE lines the managed path emits, so
// the browser and the CLI render them unchanged. Only GET /slots and GET
// /props are ever sent. Deliberately display-only: no markRequestActivity(),
// no liveProgress, no logCompletedRequest() -- the benchmark's own log
// importer records these requests, and a second row per request would skew
// every stat built on the request log.
const EXTERNAL_SLOTS_PORT = 8080;
const EXTERNAL_SLOTS_POLL_MS = 1000;
const EXTERNAL_SLOTS_IDLE_POLL_MS = 5000; // nothing listening -- check back less often
let externalSource = null;      // { port, model, modelPath, nCtx, idTask, busy, prefillTps, genTps, last } while polling
let externalSlotState = null;   // lib/slots.js reducer state
let externalSlotsTimer = null;

// Only when LL-Dash itself has nothing running or starting: a managed server
// owns the port and gets the exact numbers from its own log lines.
function externalSlotsEligible() {
    return serverState === 'stopped' && !llamaProcess && !launchPending;
}

function dropExternalSource() {
    const had = externalSource !== null;
    externalSource = null;
    externalSlotState = null;
    return had;
}

// "Qwen3.8-Flash-Next-UD-Q3_K_XL" from ".../Qwen3.8-Flash-Next-UD-Q3_K_XL-00001-of-00003.gguf"
function modelNameFromPath(p) {
    return ModelName.modelName(p, { ext: false }) || null;
}

async function pollExternalSlots() {
    if (!externalSlotsEligible()) { dropExternalSource(); return EXTERNAL_SLOTS_POLL_MS; }
    let slots;
    try {
        const res = await fetch(`http://127.0.0.1:${EXTERNAL_SLOTS_PORT}/slots`, { signal: AbortSignal.timeout(1500) });
        slots = res.ok ? await res.json() : null;
    } catch { slots = null; } // refused / timed out / not JSON (a proxy's error page)
    if (!externalSlotsEligible()) { dropExternalSource(); return EXTERNAL_SLOTS_POLL_MS; } // a launch began mid-fetch
    if (!Array.isArray(slots) || slots.length === 0) {
        // Gone (or never there): one last broadcast so clients drop the label.
        if (dropExternalSource()) broadcastState();
        return EXTERNAL_SLOTS_IDLE_POLL_MS;
    }

    const adopted = externalSource === null;
    if (adopted) {
        externalSource = { port: EXTERNAL_SLOTS_PORT, model: null, modelPath: null, nCtx: null, idTask: null, busy: false, prefillTps: null, genTps: null, last: null };
        // Once per adoption: which model this is (label only; failure is fine).
        try {
            const props = await (await fetch(`http://127.0.0.1:${EXTERNAL_SLOTS_PORT}/props`, { signal: AbortSignal.timeout(1500) })).json();
            externalSource.modelPath = props?.model_path || null;
            externalSource.model = modelNameFromPath(props?.model_path);
        } catch { /* older build / proxy without /props -- stays unlabeled */ }
    }

    const out = slotsModel.stepSlots(externalSlotState, slots, Date.now());
    externalSlotState = out.state;
    // Gen only: a 1 Hz poll cannot time a prefill that takes 1-4 s (it read ~150 t/s where the tap's
    // timings said 220-420), while its per-token gen rate lands within ~5-10%. The tap, when dialled, reports both exactly.
    if (out.finished && !liveChat.connected()) taskTps.addRates(runningTaskKey(), { genTokens: out.finished.genTokens, genTps: out.finished.genTps }, 'slots');
    const wasBusy = externalSource.busy;
    externalSource.busy = !!out.ctx?.busy;
    externalSource.nCtx = out.ctx?.limit ?? externalSource.nCtx;
    externalSource.idTask = out.state.req ? out.state.req.taskId : externalSource.idTask;
    if (out.prefill) externalSource.prefillTps = +out.prefill.instTps.toFixed(2);   // else keep the tap's last exact rate
    if (typeof liveChat !== 'undefined' && liveChat.setWanted) liveChat.setWanted(true);
    externalSource.genTps = out.gen ? +out.gen.instTps.toFixed(2) : null;
    if (out.state.last) externalSource.last = out.state.last;

    // Same line shapes as the stdout parser's broadcasts above.
    if (out.prefill) {
        const p = out.prefill;
        broadcastState(`PREFILL_PROGRESS:${p.progress.toFixed(2)}:${p.cumTps != null ? p.cumTps.toFixed(2) : ''}:${p.nTokens}:${p.instTps.toFixed(2)}`);
    }
    if (out.gen) {
        const g = out.gen;
        broadcastState(`GEN_PROGRESS:${g.avgTps.toFixed(2)}:${g.instTps.toFixed(2)}:${g.nDecoded}`);
    }
    // Context every tick while busy; once on adoption and on the busy->idle edge otherwise.
    if (out.ctx && (externalSource.busy || wasBusy || adopted)) {
        broadcastState(`CTX_LIVE:${out.ctx.used}:${out.ctx.limit}:${externalSource.busy ? 1 : 0}`);
    }
    return EXTERNAL_SLOTS_POLL_MS;
}

function startExternalSlotsPoll() {
    const tick = async () => {
        let nextMs = EXTERNAL_SLOTS_POLL_MS;
        try { nextMs = await pollExternalSlots(); } catch (err) { console.error('[external-slots]', err.message); }
        externalSlotsTimer = setTimeout(tick, nextMs);
        externalSlotsTimer.unref();
    };
    tick();
}

// Called on a request's "total time" line -- hands back whatever samples have
// accumulated since the last call and resets for whatever comes next.
function takeRequestSamples() {
    const samples = activeRequestSamples;
    activeRequestSamples = [];
    liveProgress = {}; // request over -- don't let its last rates bleed into trailing samples
    lastPrefillPoint = null;
    return samples;
}

// Bounded ring buffer of the last N requests' full sample series, keyed by
// run_id -- lets Monitor Mode's request table show the omni graph for a
// recently-completed request even if that specific client wasn't connected
// (missed the COMPLETION broadcast) when it finished. Since 2026-10-22 each
// series is also kept in bench.sqlite (lib/reqsamples.js, with the queue
// lanes' requests), so a dashboard restart no longer loses them; this ring
// stays as the fast path for the newest ones.
const recentRequestSamples = new Map(); // run_id -> samples[]
const MAX_RECENT_REQUEST_SAMPLES = 30;
function rememberRequestSamples(runId, samples) {
    if (!samples || samples.length === 0) return;
    requestSamplesStore.put({ runId, source: 'lldash', completedAt: Date.now(), samples,
        reason: samples.length < 2 ? 'only one sample was taken while this request ran (it finished within one telemetry tick)' : null });
    recentRequestSamples.set(runId, samples);
    if (recentRequestSamples.size > MAX_RECENT_REQUEST_SAMPLES) {
        const oldestKey = recentRequestSamples.keys().next().value;
        recentRequestSamples.delete(oldestKey);
    }
}

// The running launch's device plan, or null (no launch, or a config that
// can't be planned any more, e.g. a worker removed from dashboard.config.json).
function currentLaunchPlan() {
    if (!currentLaunchConfig) return null;
    try {
        return devicesModel.planDevices(currentLaunchConfig, dashboardConfig.rpcWorkers);
    } catch {
        return null;
    }
}

async function fetchCurrentTelemetry() {
    try {
        // monitor.py always reports every local GPU; RPC workers are polled
        // over ssh only while the running launch uses them (an offline laptop
        // would otherwise stall every sample).
        const plan = currentLaunchPlan();
        const body = { workers: plan ? plan.workers.map((w) => ({ name: w.name, ssh: w.ssh })) : [] };
        const res = await fetch('http://localhost:8081/stats', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            // monitor.py shells out to nvidia-smi/amdgpu_top per call, which
            // can genuinely take several seconds under heavy GPU/CPU load --
            // confirmed live at 5.5s+ while a model was actively generating.
            // This used to time out at 3s, meaning every sample attempt
            // during a real generation silently failed and Monitor's
            // per-request telemetry graphs were empty for every single
            // request. 3s was tuned for an idle system, not a busy one.
            signal: AbortSignal.timeout(10000)
        });
        const stats = await res.json();
        if (!stats || !Array.isArray(stats.gpus)) return stats;
        // `devices`: one reading per launch device, in launch order. `master`/
        // `worker`: the legacy pair (first two launch devices, or the two
        // largest local GPUs with no launch) that the CSV columns, History,
        // the current charts and the CLI still read.
        // Each reading is labelled with its card ("RX 7900 XTX #2"; lib/telemetry.js labelGpus) and a launch device
        // takes the reading of the card its id reaches, so two identical cards are never swapped or merged.
        // A launch that names no device (llama-server picks; Strata before the device probe) reads like no launch.
        // The fullest topology: it knows every id of every backend (card keys and labels are the same in every
        // build), so a launch whose own build is not known here -- an engine with its own launcher -- still maps.
        let binary = null;
        try { binary = plan && plan.devices.length ? launchBinaryOf(currentLaunchConfig, currentLaunchCommand) : null; } catch { binary = null; }
        const topology = currentTopology();
        const detected = binary ? detectedFor(binary) : null;
        const mapping = plan && plan.devices.length ? telemetryModel.mapDevicesToGpus(plan, stats, detected, topology) : null;
        return {
            ...stats,
            gpus: telemetryModel.labelGpus(stats, topology).map((x) => ({ ...x.gpu, label: x.label, card: x.card ? x.card.key : null })),
            ...telemetryModel.legacyNodes(stats, mapping),
            devices: mapping ? mapping.map(telemetryModel.deviceRecord) : null,
        };
    } catch {
        return null; // best-effort -- a slow/unreachable monitor.py shouldn't block logging
    }
}

// Peak/low for one request, from its own phase-tagged sample series. Computed
// HERE rather than in the browser because the client-side version was gated on
// the dashboard's own chat controller -- a request from opencode, curl or the
// bench sweep silently got no range at all. Persisting it also lets History
// show ranges, which it never could: the CSV carried no sample data and the
// in-memory series is a bounded ring buffer.
function tpsRange(samples, key) {
    const vals = (samples || []).map(x => x && x[key])
        .filter(v => typeof v === 'number' && isFinite(v) && v > 0);
    if (vals.length < 2) return { min: null, max: null };
    return { min: Math.min(...vals), max: Math.max(...vals) };
}

// Fires once per completed request (on that task's "total time" line). Logs a
// CSV row and broadcasts a COMPLETION SSE event so any connected client
// (Monitor Mode) can update live -- independent of whether this dashboard's
// own chat UI happened to be the one that sent the request.
async function logCompletedRequest(timing, samples, completedAt, { config: cfgParam, launchCommand: launchCmdParam } = {}) {
    try {
        // `samples`, `completedAt`, and (when provided) the launch
        // config/command were all captured on the completion log line (see the
        // pendingCompletionsByTaskId machinery in handleLogs) -- the actual
        // write/broadcast may run up to COMPLETION_FLUSH_DELAY_MS later,
        // waiting for a possible draft-acceptance line, and a server stop in
        // that window would null the globals out from under us.
        samples = samples || [];
        completedAt = completedAt || Date.now();
        const cfgSource = cfgParam || currentLaunchConfig;
        const cfg = cfgSource || {};
        const launchCmd = launchCmdParam !== undefined ? launchCmdParam : currentLaunchCommand;
        // Split the sample series into a prefill-phase line and a gen-phase
        // line using the real, completion-time-computed durations (not a live
        // per-sample estimate, which we have no way to get server-side --
        // llama.cpp's own progress lines are rate-limited, see markRequestActivity's
        // comment). genMs is the actual generation-phase duration, so counting
        // back from the total-time log line's timestamp gives a real
        // prefill/gen boundary timestamp to split the samples on.
        // Samples already carry real per-tick rates when llama printed progress
        // lines while they were taken (see liveProgress stamping) -- the flat
        // completion-time average is only a FALLBACK for samples that have
        // nothing (short requests below llama's progress-print thresholds).
        if (samples.length > 0 && timing.genMs != null) {
            const prefillEndTime = completedAt - timing.genMs;
            for (const s of samples) {
                if (s.t < prefillEndTime) {
                    s.prefillTps = s.prefillTps ?? timing.promptTps ?? null;
                    s.genTps = null;
                } else {
                    s.prefillTps = null;
                    s.genTps = s.genTps ?? timing.genTps ?? null;
                }
            }
        }
        const stats = await fetchCurrentTelemetry();
        const master = stats?.master || {};
        const worker = stats?.worker || {};
        const pRange = tpsRange(samples, 'prefillTps');
        const gRange = tpsRange(samples, 'genTps');
        const benchRow = {
            prefillTpsMin: pRange.min, prefillTpsMax: pRange.max,
            genTpsMin: gRange.min, genTpsMax: gRange.max,
            model: cfg.modelPath || '',
            ctx: cfg.ctx || '',
            ngl: cfg.ngl || '',
            rpc: cfg.rpcTarget ? 'yes' : 'no',
            transport: cfg.rpcTarget ? (cfg.transport || '') : 'Local',
            argString: cfg.argString || '',
            launchCommand: launchCmd,
            promptTps: timing.promptTps ?? '',
            genTps: timing.genTps ?? '',
            promptLatency: timing.promptMs != null ? (timing.promptMs / 1000).toFixed(2) : '',
            promptTokens: timing.promptTokens ?? '',
            gpuUtil: master.gpu_util, gpuPwr: master.gpu_pwr, masterGpuTemp: master.gpu_temp,
            cpuUtil: master.cpu_util, masterCpuTemp: master.cpu_temp,
            gpuMem: master.vram_used, ramUsage: master.process_ram ?? master.ram_used,
            workerGpuUtil: worker.gpu_util, workerGpuPwr: worker.gpu_pwr, workerGpuTemp: worker.gpu_temp,
            workerCpuTemp: worker.cpu_temp, workerVram: worker.vram_used, workerRam: worker.process_ram ?? worker.ram_used,
            devicesJson: stats?.devices ? JSON.stringify(stats.devices) : '',
            genTokens: timing.genTokens ?? '',
            wallTime: timing.wallTimeS ?? '',
            loadTime: finalLoadTime || '',
            configJson: cfgSource ? JSON.stringify(cfgSource) : '',
            // netThroughput/reasonTokens are frontend-only concepts (a client-side
            // delta calc, and reasoning-token counting from rendered content) --
            // left blank here, same as any other row missing optional fields.
            draftAcceptRate: timing.draftAcceptRate,
            draftAccepted: timing.draftAccepted,
            draftGenerated: timing.draftGenerated,
            draftMeanLen: timing.draftMeanLen,
            aborted: !!timing.aborted,
        };
        const runId = await appendBenchmarkRow(benchRow);
        // SQLite is the record from 2026-09-24 on (lib/db.js); the CSV row stays for old readers.
        benchDb.insertRequest({ ...benchRow, runId, completedAt, depthEnd: timing.depthEnd ?? null });
        rememberRequestSamples(runId, samples);
        broadcastState(`COMPLETION:${JSON.stringify({
            runId,
            timestamp: Date.now(),
            model: (cfg.modelPath || '').split('/').pop(),
            promptTps: timing.promptTps, genTps: timing.genTps,
            promptTokens: timing.promptTokens, genTokens: timing.genTokens,
            wallTime: timing.wallTimeS,
            draftAcceptRate: timing.draftAcceptRate ?? null,
            draftAccepted: timing.draftAccepted ?? null,
            draftGenerated: timing.draftGenerated ?? null,
            draftMeanLen: timing.draftMeanLen ?? null,
            aborted: !!timing.aborted,
            prefillTpsMin: pRange.min, prefillTpsMax: pRange.max,
            genTpsMin: gRange.min, genTpsMax: gRange.max,
            metrics: samples,
            detail: {
                modelPath: cfg.modelPath,
                ctx: cfg.ctx,
                ngl: cfg.ngl,
                rpc: cfg.rpcTarget ?? 'no',
                transport: cfg.rpcTarget ? (cfg.transport || '') : 'Local',
                devices: cfg.devices ?? null,
                deviceStats: stats?.devices ?? null,
                launchCommand: launchCmd,
                promptLatency: timing.promptLatency || null,
                gpuUtil: master.gpu_util ?? null,
                gpuMemory: master.gpu_mem_used ?? null,
                gpuPower: master.gpu_power ?? null,
                gpuTemp: master.gpu_temp ?? null,
                cpuMemUsed: master.mem_used ?? null,
                cpuMemAvail: master.mem_avail ?? null,
            }
        })}`);
    } catch (err) {
        console.error('Failed to log completed request:', err);
    }
}

async function initLogsDir() {
    try {
        await fs.mkdir(LOGS_DIR, { recursive: true });
        try {
            await fs.access(CSV_FILE);
            await migrateCsvHeader();
        } catch {
            await fs.writeFile(CSV_FILE, CSV_HEADERS);
        }
    } catch (err) {
        console.warn('Failed to init logs directory:', err.message);
    }
}

// The header is written ONCE, at file creation. Every column added since then
// (draft stats, then the tps ranges) was appended to the ROWS without updating
// it, so the on-disk header drifted out of sync -- 32 names against 38-value
// rows. Positional readers (/api/logs/recent, /api/logs/summary) were fine, but
// anything name-based -- pandas, Excel, csv.DictReader -- silently mislabels
// every column past the truncation point and reads draft acceptance as empty.
// Rewrite the header in place whenever it doesn't match. Columns are only ever
// APPENDED, so old short rows stay valid: readers already guard with
// `cols.length > N`.
async function migrateCsvHeader() {
    try {
        const content = await fs.readFile(CSV_FILE, 'utf-8');
        const nl = content.indexOf('\n');
        if (nl === -1) return;
        const current = content.slice(0, nl + 1);
        if (current === CSV_HEADERS) return;
        const oldCols = current.trim().split(',').length;
        const newCols = CSV_HEADERS.trim().split(',').length;
        if (newCols < oldCols) {
            console.warn(`CSV header has MORE columns (${oldCols}) than the code expects (${newCols}) -- refusing to truncate; leaving as is.`);
            return;
        }
        await fs.writeFile(CSV_FILE + '.bak', content);
        await fs.writeFile(CSV_FILE, CSV_HEADERS + content.slice(nl + 1));
        console.log(`CSV header migrated ${oldCols} -> ${newCols} columns (backup at ${CSV_FILE}.bak)`);
    } catch (err) {
        console.warn('CSV header migration skipped:', err.message);
    }
}

// --- SHARED LAUNCH PROFILES ---
// The single source of truth for saved launch configs, shared by the browser
// UI (which kept them in per-browser localStorage) and llama-cli (which kept
// them in ~/.llama-cli/profiles.json) -- a profile saved in either shows up
// in both. Lives in LOGS_DIR next to the benchmark CSV: user data, not code.
//
// Schema (v3):
//   { "version": 3, "profiles": { "<name>": {
//       "config": { ...launchConfig fields... },
//       "savedAt": <ms>, "lastLoadedAt": <ms|null> } } }
// `config` holds the SAME keys the dashboard launch form / buildLlamaArgs
// understand (modelPath, ctx, ngl, fa, cacheK/V, spec*, sampling, jinja,
// argString, ...) so both clients apply it without translation.
const PROFILES_FILE = path.join(LOGS_DIR, 'profiles.json');
// Pre-shared-store location of the CLI's profiles -- imported once at
// bootstrap so nothing the user saved is lost.
const CLI_PROFILES_FILE = path.join(os.homedir(), '.llama-cli', 'profiles.json');

function normalizeProfileConfig(cfg) {
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) return {};
    // A client may send a whole entry ({name, config, savedAt, ...}) instead
    // of the bare config object -- unwrap it either way.
    const unwrapped = (cfg.config && typeof cfg.config === 'object') ? cfg.config : cfg;
    const { name, savedAt, lastLoadedAt, config: _c, ...rest } = unwrapped;
    // Profiles always carry `devices`. The legacy deviceA/deviceB/rpcTarget/
    // tensorSplit fields stay alongside until every client reads the list
    // (HETERO-DEVICES-PLAN.md phases 3-4).
    if (Array.isArray(rest.devices)) {
        rest.devices = devicesModel.sanitizeDevices(rest.devices);
    } else {
        const devices = devicesModel.legacyToDevices(rest);
        if (devices.length > 0) rest.devices = devices;
    }
    return rest;
}

async function initProfilesStore() {
    try {
        const exists = await fs.access(PROFILES_FILE).then(() => true, () => false);
        if (exists) return; // already bootstrapped -- never clobber
        const doc = { version: 3, profiles: {} };
        let importedFrom = null;
        try {
            const raw = JSON.parse(await fs.readFile(CLI_PROFILES_FILE, 'utf-8'));
            if (raw && raw.version === 2 && raw.profiles && typeof raw.profiles === 'object') {
                for (const [name, cfg] of Object.entries(raw.profiles)) {
                    doc.profiles[name] = { config: normalizeProfileConfig(cfg), savedAt: Date.now(), lastLoadedAt: null };
                }
                importedFrom = CLI_PROFILES_FILE;
            } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
                // Legacy llama-cli v1: { "<name>": { model, args } }
                for (const [name, p] of Object.entries(raw)) {
                    if (p && typeof p === 'object' && !Array.isArray(p)) {
                        doc.profiles[name] = {
                            config: { modelPath: p.model || '', argString: p.args || '' },
                            savedAt: Date.now(), lastLoadedAt: null,
                        };
                    }
                }
                importedFrom = CLI_PROFILES_FILE;
            }
        } catch { /* no CLI profiles to import */ }
        await fs.writeFile(PROFILES_FILE, JSON.stringify(doc, null, 2));
        const n = Object.keys(doc.profiles).length;
        console.log(`Profiles store ready at ${PROFILES_FILE} (${n} profile(s)${importedFrom ? ` imported from ${importedFrom}` : ''})`);
    } catch (err) {
        console.warn('Profiles store init failed:', err.message);
    }
}

async function loadProfilesDoc() {
    try {
        const doc = JSON.parse(await fs.readFile(PROFILES_FILE, 'utf-8'));
        if (doc && typeof doc.profiles === 'object' && doc.profiles) return doc;
    } catch { /* missing/corrupt -> empty */ }
    return { version: 3, profiles: {} };
}

async function saveProfilesDoc(doc) {
    await fs.mkdir(LOGS_DIR, { recursive: true });
    await fs.writeFile(PROFILES_FILE, JSON.stringify(doc, null, 2));
}

// --- HTTP SERVER ---
// Model-server port from the live launch command (--port N), defaulting to
// the documented 8080. Used by the /api/chat and /api/slots proxies so a
// custom-port launch is followed by the proxies automatically.
function portFromLaunchCommand() {
    const fromCfg = toFiniteNumber(currentLaunchConfig?.port);
    if (fromCfg !== undefined) return fromCfg;
    const m = String(currentLaunchCommand || '').match(/--port[ =](\d+)/);
    if (m) return parseInt(m[1], 10);
    if (/queue-serve\.sh/.test(currentLaunchCommand) || (currentLaunchConfig && currentLaunchConfig.engine === 'strata')) {
        return 8095;
    }
    return 8080;
}

// Loopback bridge on 127.0.0.1:8080: when the active model server is running on a
// custom port (such as Strata on 8095), local clients hardcoded to 8080 (like
// OpenCode's llama-local provider or Tailscale port forwarding) still connect cleanly.
let loopbackBridge = null;

function ensureLoopbackBridge() {
    const targetPort = portFromLaunchCommand();
    if (targetPort === 8080 || serverState !== 'ready') {
        closeLoopbackBridge();
        return;
    }
    if (loopbackBridge && loopbackBridge.targetPort === targetPort) {
        return;
    }
    closeLoopbackBridge();

    const bridge = net.createServer((clientSocket) => {
        const upstream = net.connect({ host: '127.0.0.1', port: targetPort }, () => {
            clientSocket.pipe(upstream);
            upstream.pipe(clientSocket);
        });
        upstream.on('error', () => { clientSocket.destroy(); });
        clientSocket.on('error', () => { upstream.destroy(); });
    });
    bridge.on('error', (err) => {
        console.warn(`[loopback-bridge] failed to bind 127.0.0.1:8080 -> :${targetPort}:`, err.message);
        try { bridge.close(); } catch {}
        if (loopbackBridge === bridge) loopbackBridge = null;
    });
    try {
        bridge.listen(8080, '127.0.0.1', () => {
            console.log(`[loopback-bridge] forwarding 127.0.0.1:8080 -> 127.0.0.1:${targetPort}`);
        });
        bridge.targetPort = targetPort;
        loopbackBridge = bridge;
    } catch (err) {
        console.warn(`[loopback-bridge] listen failed:`, err.message);
    }
}

function closeLoopbackBridge() {
    if (loopbackBridge) {
        try { loopbackBridge.close(); } catch {}
        loopbackBridge = null;
    }
}

const server = http.createServer(async (req, res) => {
    reqTally.count(req, res);   // every request, before OPTIONS and the gate: the gate's 401s are requests too
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') { res.writeHead(200); return res.end(); }

    // --- TUNNEL GATE (when a tunnel is up, nothing else is reachable) ---
    // Login is the single unauthenticated entry point; everything else must
    // already carry a valid Bearer password or session cookie.
    if (tunnelGateActive()) {
        if (req.url === '/api/tunnel/login' && req.method === 'POST') {
            let body;
            try { body = JSON.parse(await parseBody(req)); } catch { body = {}; }
            if (verifyTunnelPassword(body.password)) {
                const token = mintSession();   // signed: survives a dashboard restart
                res.writeHead(200, {
                    'Content-Type': 'application/json',
                    'Set-Cookie': `mc_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_MAX_AGE_S}`,
                });
                return res.end(JSON.stringify({ ok: true }));
            }
            // a wrong password: the same 401, plus where the gate page should send the browser (lib/gate.js)
            const fail = gateModel.loginFailure(dashboardConfig.remoteAccess);
            res.writeHead(fail.status, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(fail.body));
        }
        // The site's icons (2026-10-22) are the one other thing a locked browser may fetch: the gate page names them,
        // and a browser asks for /favicon.ico on its own. The same five images the public site serves; nothing else.
        if (!tunnelAuthenticated(req) && !(req.method === 'GET' && SITE_ICONS.has(req.url.split('?')[0]))) return tunnelGateResponse(req, res);
    }

    try {
        // --- VERSIONED ASSETS: /v/<hash>/script.js, /v/<hash>/ui/models/index.js, ... (lib/assets.js, 2026-10-06) ---
        // Immutable only while <hash> is the current one, and then from the very bytes that were hashed. Under an old
        // hash (a page opened before an edit, importing a module late) or for a file outside the set, the prefix is
        // dropped and the request is answered by the plain handlers below, uncached, as it always was.
        const vm = req.method === 'GET' ? /^\/v\/([0-9a-f]{6,40})(\/[^?#]*)/.exec(req.url) : null;
        if (vm) {
            const file = appAssets.versioned(vm[1], vm[2]);
            if (file) {
                return sendCompressed(req, res, file.body, { 'Content-Type': file.type, 'Cache-Control': ASSET_IMMUTABLE }, 1024,
                    { br: () => appAssets.encoded(file, 'br'), gzip: () => appAssets.encoded(file, 'gzip') });
            }
            if (/^\/(?:(?:vendor\/)?[\w.-]+|ui\/[\w-]+\/[\w.-]+)\.(?:js|css|map|ico|png|svg)$/.test(vm[2])) req.url = vm[2];   // only ever a static file
        }
        // --- UI ---
        if (req.url === '/' || req.url === '/index.html') {
            let content = await fs.readFile(path.join(__dirname, 'index.html'), 'utf-8');
            // Cache-busting: no-store alone proved insufficient -- browsers
            // still served a stale script.js (silently running old code against
            // a fresh index.html, which is exactly the mismatch the header was
            // meant to prevent). So every local asset URL carries a version: a
            // changed file is a different URL and CANNOT be served from cache,
            // while an unchanged one still caches normally.
            // Since 2026-10-06 the version is a path prefix, /v/<hash>/..., over the
            // bytes of ALL the app's JS and CSS (lib/assets.js), not ?v=<mtime> on the
            // tags in this file: the ES modules those tags import were never stamped
            // (relative imports drop a query string, but keep a directory), so 28
            // modules were re-downloaded on every load, `no-store`. Now they are
            // immutable under their hash and this page, still never cached, names it.
            content = appAssets.versionHtml(content);
            // anything local left outside that set keeps the old per-file mtime stamp
            const stamp = async (relPath) => {
                try {
                    const st = await fs.stat(path.join(__dirname, relPath));
                    return String(Math.floor(st.mtimeMs));
                } catch { return String(Date.now()); }
            };
            const assetRe = /(src|href)="(\.\/[^"?]+\.(?:js|css))"/g;
            const matches = [...content.matchAll(assetRe)];
            const versions = await Promise.all(matches.map(m => stamp(m[2])));
            let i = 0;
            content = content.replace(assetRe, (full, attr, url) => `${attr}="${url}?v=${versions[i++]}"`);
            return sendCompressed(req, res, Buffer.from(content), { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' });
        }

        // --- SSE STATUS ---
        else if (req.url === '/api/status' || req.url.startsWith('/api/status?')) {
            res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
            clients.push(res);
            broadcastState();
            // ?ticks=1: the browser's stream also carries the 1 Hz telemetry and lanes (LIVE TICKS above), the newest
            // of each at once so a fresh page has its sidebar numbers without a poll
            if (/[?&]ticks=1(?:&|$)/.test(req.url)) {
                tickClients.add(res);
                if (lastServerTelemetry) res.write(tickFrame('telemetry', lastServerTelemetry));
                res.write(tickFrame('lanes', lanesLiveAnswer()));
            }
            req.on('close', () => { clients = clients.filter(c => c !== res); tickClients.delete(res); });
            return;
        }

        // --- LIVE CHAT (lib/livechat.js): the agent<->model conversation from the proxy tap ---
        else if ((req.url === '/api/livechat' || req.url.startsWith('/api/livechat?')) && req.method === 'GET') {
            const bat = new URL(req.url, 'http://x').searchParams.get('battery');
            relayForBattery(bat).attach(req, res);
            return;
        }
        // --- AI LAB POST EDITOR (2026-10-02) -- behind this dashboard's gate; the public site only ever reads published posts.
        // GET /posts (the editor page), /api/posts/list, /api/posts/get?slug=, POST /api/posts/save, GET /posts/preview/<slug>.
        // The home page's copy (pages/home.md in the same repo, 2026-10-07) goes through the same routes: `home` in the
        // list, /api/posts/get?page=home, and `page: 'home'` in the body of save and preview.
        else if ((req.url === '/posts' || req.url === '/posts/') && req.method === 'GET') {
            try {
                const html = await fs.readFile(path.join(__dirname, 'ui', 'posts', 'index.html'), 'utf-8');
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
                return res.end(html);
            } catch { res.writeHead(404); return res.end('editor missing'); }
        }
        else if (req.url === '/api/posts/list' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            const home = await postsRepo.getHome();
            return res.end(JSON.stringify({ repo: postsRepo.REPO, posts: await postsRepo.listAll(), home: { title: home.title, updatedAt: home.updatedAt, exists: home.exists, builtin: home.builtin } }));
        }
        else if (req.url.startsWith('/api/posts/get?') && req.method === 'GET') {
            const getQ = new URLSearchParams(req.url.split('?')[1]);
            const post = getQ.get('page') === 'home' ? await postsRepo.getHome() : await postsRepo.get(getQ.get('slug'));
            res.writeHead(post ? 200 : 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            return res.end(JSON.stringify(post || { error: 'no such post' }));
        }
        else if (req.url === '/api/posts/save' && req.method === 'POST') {
            let body; try { body = JSON.parse(await parseBody(req)); } catch { body = null; }
            try {
                if (!body) throw new Error('bad JSON');
                const out = await postsRepo.save(body);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify(out));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: e.message }));
            }
        }
        else if (req.url === '/api/posts/preview' && req.method === 'POST') {
            // unsaved editor content, rendered as the public site will show it
            let body; try { body = JSON.parse(await parseBody(req)); } catch { body = {}; }
            if (body.page === 'home') {
                res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
                return res.end(require('./public/posts').homePreviewHtml({ title: body.title, kicker: typeof body.kicker === 'string' ? body.kicker : '', body: body.body }));
            }
            const tags = Array.isArray(body.tags) ? body.tags : String(body.tags || '').split(',').map((x) => x.trim()).filter(Boolean);
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
            return res.end(require('./public/posts').previewHtml({ title: body.title || '(untitled)', date: body.date || '', tags, body: body.body || '', draft: body.draft !== false }));
        }
        // Combined live t/s across local GPU lanes (lanesLive above). 2026-10-01. Since 2026-10-22 the browser gets it
        // on its status stream (`event: lanes`) and asks here only while that stream is quiet.
        else if (req.url === '/api/lanes/live' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            return res.end(JSON.stringify(lanesLiveAnswer()));
        }
        else if ((req.url === '/api/livechat/status' || req.url.startsWith('/api/livechat/status?')) && req.method === 'GET') {
            const bat = new URL(req.url, 'http://x').searchParams.get('battery');
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            return res.end(JSON.stringify(relayForBattery(bat).status()));
        }

        // --- MODELS TAB (lib/models.js) ---
        // NOTE the path: `/api/models` below is the long-standing gguf-file lister that the
        // launch sidebar depends on, so the Models tab's catalogue lives at
        // `/api/models/catalog` rather than taking that name away from it.
        // Every one of these is read-only and wrapped: a bug in lib/models.js must come back
        // as a 500 with a message, never as an exception inside the request handler.
        else if (req.url === '/api/models/catalog' && req.method === 'GET') {
            try {
                const { entry, refresh } = await modelsCatalog.get();
                // no-store, as before: the page keeps the ETag itself (ui/benchmarks/util.js catalogStore) and sends
                // If-None-Match, so "do I already have this" never depends on a browser or proxy cache.
                // X-Body-Length: the DECODED size, for the Results page's loading bar (ui/benchmarks/util.js createCatalogStore:
                // a stream reader counts decoded bytes, so the brotli/gzip Content-Length would overshoot; 2026-10-22)
                const head = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Accept-Encoding', ETag: entry.etag, 'X-Body-Length': String(entry.body.length) };
                if (etagMatches(req.headers['if-none-match'], entry.etag)) { res.writeHead(304, head); res.end(); }
                else {
                    const accept = String(req.headers['accept-encoding'] || '');
                    const enc = /\bbr\b/.test(accept) ? 'br' : /\bgzip\b/.test(accept) ? 'gzip' : null;
                    res.writeHead(200, enc ? { ...head, 'Content-Encoding': enc } : head);
                    res.end(enc ? entry[enc] : entry.body);
                }
                // A background rebuild (on the worker thread): after the response, and after the requests the page sent
                // alongside it (/api/models/running, /api/model) have been answered.
                if (refresh) setTimeout(refresh, 300);
                return;
            } catch (err) {
                console.error('/api/models/catalog failed:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: err.message }));
            }
        }
        // Batteries running right now and the task each is on (the first planned task without a result file:
        // a battery runs its list in order). The models chart outlines those cells (2026-09-30, Kyle), and dots the
        // cells of the tasks still to come (`planned`, 2026-10-24).
        else if (req.url === '/api/models/running' && req.method === 'GET') {
            const out = [];
            try {
                for (const r of codebenchModel.scanBatteries()) {
                    if (!r.adoptable) continue;
                    const tasks = Array.isArray(r.battery && r.battery.tasks) ? r.battery.tasks : [];
                    const task = tasks.find((t) => !fsSync.existsSync(path.join(r.path, `${t}.json`))) || null;
                    // the rest of its list (2026-10-24, Kyle: "the solve maps should put blue dots inside every rectangle that is
                    // planned in the current running queued set"): every other task with no result file yet, less the ones the
                    // duplicate guard dropped (skipped-scored.jsonl: already scored at this config, so they will not run)
                    let skipped = new Set();
                    try { skipped = new Set(fsSync.readFileSync(path.join(r.path, 'skipped-scored.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l).task; } catch { return null; } })); } catch { /* none */ }
                    const planned = task ? tasks.filter((t) => t !== task && !skipped.has(t) && !fsSync.existsSync(path.join(r.path, `${t}.json`))) : [];
                    // which catalog row it belongs to, known from its launch even before a first result (lib/models.js describeRunning)
                    let row = null; try { row = modelsModel.describeRunning(r, codebenchModel.queueServer(r.dir)); } catch (err) { console.error('describeRunning failed:', err.message); }
                    out.push({ dir: r.dir, task, tasks: tasks.length, planned, runner: (r.battery && r.battery.runner) || null, model: (r.battery && r.battery.model) || null, state: r.state,
                        modelKey: row ? row.modelKey : null, modelDisplay: row ? row.display : null, facets: row ? row.facets : null,
                        // the prompt level it runs at: its current task is the problem `<task>@L3` on the grid (2026-10-17)
                        level: row ? row.level || null : null });
                }
            } catch (err) { console.error('/api/models/running failed:', err); }
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            return res.end(JSON.stringify({ running: out }));
        }
        else if (req.url === '/api/models/leaderboards' && req.method === 'GET') {
            try {
                const out = modelsModel.listLeaderboards();
                res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
                return res.end(JSON.stringify(out));
            } catch (err) {
                console.error('/api/models/leaderboards failed:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: err.message }));
            }
        }
        else if (req.url === '/api/models/tasks' && req.method === 'GET') {
            try {
                const out = modelsModel.taskHistory();
                res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
                return res.end(JSON.stringify(out));
            } catch (err) {
                console.error('/api/models/tasks failed:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: err.message }));
            }
        }
        else if (req.url.startsWith('/api/model?') && req.method === 'GET') {
            try {
                const q = new URLSearchParams(req.url.slice(req.url.indexOf('?') + 1));
                const key = q.get('key');
                if (!key) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'key is required (see /api/models/catalog)' }));
                }
                // a row declared internal (dashboard.config.json `internalRowVariants`) is in no catalog and has no
                // page; `&internal=1` is the lab's own way to open one
                const out = modelsModel.getModel(key, { includeInternal: q.get('internal') === '1' });
                if (!out) {
                    res.writeHead(404, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: `no model with key ${key}` }));
                }
                return sendJsonCompressed(req, res, out);
            } catch (err) {
                console.error('/api/model failed:', err);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: err.message }));
            }
        }

        // --- MODELS ---
        else if (req.url === '/api/models') {
            // One entry per model file: split models once (part 1's path, the name without
            // "-00001-of-0000N", the size of all parts), a file reached by two paths once (the
            // other path in `aliases`). See lib/modelscan.js.
            let uniqueModels = [];
            try { uniqueModels = await modelScan.scanModelDirs(modelRoots()); }
            catch (err) { console.warn('Model scan failed:', err.message); }

            // Each model's matching multimodal projector (lib/mmproj.js), so
            // clients can fill the mmproj path in. The scan already lists the
            // mmproj*.gguf files; mtimes break ties between candidates.
            const mmprojCandidates = await Promise.all(uniqueModels
                .filter((m) => mmprojModel.isMmproj(m.path))
                .map(async (m) => ({ path: m.path, mtimeMs: (await fs.stat(m.path).catch(() => null))?.mtimeMs || 0 })));
            for (const m of uniqueModels) m.mmproj = mmprojModel.pickMmproj(m.path, mmprojCandidates);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(uniqueModels));
        }

        // Strip the ?v=<mtime> cache-busting stamp the html handler adds before
        // matching/resolving -- the pattern is $-anchored and the query is not
        // part of the filename.
        else if (req.url.split('?')[0].match(/^\/(?:vendor\/)?[\w.-]+\.(js|css|map|ico|png|svg)$/)) {
            const urlPath = req.url.split('?')[0];
            const filePath = path.join(__dirname, urlPath);
            // Prevent path traversal — ensure resolved path stays in __dirname
            if (!filePath.startsWith(__dirname)) {
                res.writeHead(403);
                return res.end('Forbidden');
            }
            const types = {
                '.js': 'application/javascript',
                '.css': 'text/css',
                '.map': 'application/json',
                '.ico': 'image/x-icon',
                '.png': 'image/png',
                '.svg': 'image/svg+xml'
            };
            try {
                const content = await fs.readFile(filePath);
                const headers = { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream' };
                // vendor/ assets are stable; the app's own js/css must never be
                // cached against a mismatched index.html (see the html handler).
                if (!urlPath.startsWith('/vendor/')) headers['Cache-Control'] = SITE_ICONS.has(urlPath) ? 'public, max-age=86400' : 'no-store';   // icons: the same bytes for days
                if (/\.(js|css|map|svg)$/.test(urlPath)) return sendCompressed(req, res, content, headers);   // text: compressed (2026-10-06)
                res.writeHead(200, headers);
                return res.end(content);
            } catch (err) {
                res.writeHead(404);
                return res.end('Not found');
            }
        }

        // --- BENCHMARK LOG (manual/external logging; the dashboard's own chat no
        // longer calls this automatically -- see logCompletedRequest() for the
        // client-agnostic capture that replaced it, Item 12/Monitor Mode) ---
        else if (req.url === '/api/log' && req.method === 'POST') {
            let body;
            try { body = JSON.parse(await parseBody(req)); } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }
            const runId = await appendBenchmarkRow(body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ success: true, run_id: runId }));
        }

        // --- CSV DOWNLOAD ---
        else if (req.url === '/api/logs/csv' && req.method === 'GET') {
            try {
                const csv = await fs.readFile(CSV_FILE, 'utf-8');
                res.writeHead(200, { 'Content-Type': 'text/csv' });
                return res.end(csv);
            } catch {
                res.writeHead(404);
                return res.end();
            }
        }

        // --- PER-REQUEST OMNI GRAPH SAMPLES (Monitor Mode) ---
        // Backs the "expand" view on a Monitor / History table row -- returns the
        // sample series collected while that specific request was in flight:
        // the in-memory ring (recentRequestSamples) for LL-Dash's own newest
        // requests, else bench.sqlite's request_samples (lib/reqsamples.js: every
        // queue lane's requests and LL-Dash's own, kept by count and age).
        // With fewer than 2 samples the answer carries `reason` (one sentence:
        // why), from the stored record or from the run id and the row's time
        // (`at`, ms, optional): older than the store, imported from a log, ...
        else if (req.url.startsWith('/api/logs/samples') && req.method === 'GET') {
            const queryParams = new URLSearchParams(req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '');
            const runId = queryParams.get('runId') || '';
            let out = null;
            const ring = runId ? recentRequestSamples.get(runId) : null;
            if (ring && ring.length >= 2) out = { samples: ring };
            else {
                const kept = runId ? requestSamplesStore.get(runId) : null;
                if (kept && kept.samples.length >= 2) out = { samples: kept.samples, note: kept.note || null, lane: kept.lane || null };
                else out = { samples: (kept && kept.samples) || ring || [], reason: (kept && kept.reason) || reqSamples.missingReason(runId, Number(queryParams.get('at')) || null, requestSamplesStore.bounds()) };
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(out));
        }

        // --- IN-PROGRESS REQUEST SAMPLES (Monitor's live rolling graph) ---
        // A read-only peek at activeRequestSamples -- NOT takeRequestSamples(),
        // which would drain the buffer that logCompletedRequest still needs at
        // completion time. Lets Monitor's "last 2 minutes" graph show something
        // while a request is still streaming, rather than only ever updating
        // once a request finishes (which could be minutes away for a long
        // generation, making the graph look dead despite real activity).
        else if (req.url === '/api/logs/active-samples' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ samples: activeRequestSamples }));
        }

        // --- HISTORY CHART WINDOW (2026-10-01, Kyle) ---
        // GET /api/logs/range?from=<ms>&to=<ms>&max=<n>[&view_from&view_to | &window=default]: the chart's points for requests completed in
        // [from, to], CSV + DB-only rows (same dedupe as /api/logs/recent), downsampled server-side to
        // <= max (default 1500, capped 100..4000) real points -- see lib/history.js for why min/max per
        // bucket. No from/to = the whole extent ("all"). Also returns the overall extent (how far the
        // chart can pan) and the default window (24 h to the newest request, widened if sparse).
        // The table still pages /api/logs/recent by runs; it no longer drives the chart.
        else if (req.url.startsWith('/api/logs/range') && req.method === 'GET') {
            try {
                const q = new URLSearchParams(req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '');
                const max = Math.max(100, Math.min(parseInt(q.get('max'), 10) || 1500, 4000));
                const csvAll = historyCsvIndex.refresh();
                const dbExt = benchDb.nonCsvExtent();
                const firsts = [csvAll.length ? csvAll[0].t : NaN, dbExt ? Date.parse(dbExt.first) : NaN].filter(Number.isFinite);
                const lasts = [csvAll.length ? csvAll[csvAll.length - 1].t : NaN, dbExt ? Date.parse(dbExt.last) : NaN].filter(Number.isFinite);
                const extent = firsts.length ? { first: Math.min(...firsts), last: Math.max(...lasts) } : null;
                // Default window: needs the newest ~300 timestamps across both sources (CSV tail + DB index walk).
                const DEFAULT_MIN = 300;
                const newestTs = historyMerge.mergeNewestFirst(
                    csvAll.slice(-DEFAULT_MIN).reverse().map(p => ({ t: p.t })),
                    (benchDb.newestNonCsvRequestKeys(DEFAULT_MIN) || []).map(r => ({ t: Date.parse(r.completed_at) })), 0, DEFAULT_MIN)
                    .reverse().map(e => e.t);
                const defaultWin = historyMerge.defaultWindow(extent, newestTs, DEFAULT_MIN);
                // window=default: the chart's first open -- the server picks the window and returns its points in one round trip.
                const useDefault = q.get('window') === 'default' && defaultWin;
                // q.has(), not Number(q.get()): Number(null) is 0, which made a bare /api/logs/range ask for 1970.
                const qNum = (k) => (q.has(k) && q.get(k) !== '' ? Number(q.get(k)) : NaN);
                let from = useDefault ? defaultWin.from : qNum('from'), to = useDefault ? defaultWin.to : qNum('to');
                if (!Number.isFinite(from)) from = extent ? extent.first : 0;
                if (!Number.isFinite(to)) to = extent ? extent.last : 0;
                if (to < from) [from, to] = [to, from];
                const vf = qNum('view_from'), vt = qNum('view_to');
                const view = !useDefault && Number.isFinite(vf) && Number.isFinite(vt) ? { from: vf, to: vt } : null;
                // DB bounds at second granularity (completed_at has no ms -- see lib/db.js), exact filter after.
                const isoSec = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
                const dbRows = extent ? (benchDb.nonCsvPointsBetween(isoSec(Math.floor(from / 1000) * 1000), isoSec(Math.ceil(to / 1000) * 1000)) || []) : [];
                const dbPoints = [];
                for (const r of dbRows) {
                    const t = Date.parse(r.completed_at);
                    if (!(t >= from && t <= to)) continue;
                    dbPoints.push(historyMerge.chartPoint(t, r.model_path ? r.model_path.split('/').pop() : null,
                        r.prefill_tps, r.gen_tps, r.prompt_tokens, r.gen_tokens));
                }
                const body = historyMerge.buildRangeResponse({
                    csvPoints: historyMerge.sliceRange(csvAll, from, to), dbPoints, from, to, max, extent, defaultWin, view,
                });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify(body));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: String(err && err.message || err) }));
            }
        }

        // --- RECENT COMPLETED REQUESTS (Monitor Mode backfill) ---
        // Structured (not raw CSV text) so the frontend doesn't need its own
        // CSV parser just to backfill the Monitor Mode chart/table on load --
        // the live stream after that comes from COMPLETION SSE events (see
        // logCompletedRequest's broadcastState call).
        else if (req.url.startsWith('/api/logs/recent') && req.method === 'GET') {
            try {
                const queryParams = new URLSearchParams(req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '');
                const limit = Math.max(1, Math.min(parseInt(queryParams.get('limit'), 10) || 50, 500));
                // offset counts back from the newest row -- offset=0 is the most
                // recent `limit` rows (unchanged default), offset=200 skips those
                // and returns the next `limit` older ones. Lets History page
                // backward through the full CSV instead of only ever seeing the
                // newest window of it.
                const offset = Math.max(0, parseInt(queryParams.get('offset'), 10) || 0);

                // A missing CSV is no longer fatal (2026-09-30, Kyle): the DB-only rows below can
                // still fill History on their own.
                const csv = await fs.readFile(CSV_FILE, 'utf-8').catch(() => '');
                const lines = csv.trim().split('\n').slice(1).filter(l => l.trim());

                // Merged CSV + bench.sqlite stream (2026-09-30, Kyle). Codebench-queue legs launch
                // their own servers, so their requests reach only the DB, never the CSV -- History
                // read the CSV alone and showed nothing past the last dashboard-launched request.
                // limit/offset now page newest-first over BOTH sources by completion time: take
                // the newest offset+limit of each (CSV is append-only, so its tail; the DB via the
                // completed_at index, light keys only), merge, slice, then fetch just this page's
                // full DB rows. Only the timestamp (col 0, never quoted) is read from the CSV keys,
                // so no 10k-line splitCsvLine per poll. `total` still counts every CSV data line
                // (including pre-v3 rows that are skipped below) so paging arithmetic is unchanged.
                const want = offset + limit;
                const csvKeys = [];
                for (let k = lines.length - 1; k >= 0 && csvKeys.length < want; k--) {
                    csvKeys.push({ t: Date.parse(lines[k].slice(0, lines[k].indexOf(','))), line: lines[k] });
                }
                const dbCount = benchDb.countNonCsvRequests() || 0;   // null (DB unavailable) -> CSV only, as before
                const dbKeys = dbCount ? (benchDb.newestNonCsvRequestKeys(want) || []).map(r => ({ t: Date.parse(r.completed_at), id: r.id })) : [];
                const page = historyMerge.mergeNewestFirst(csvKeys, dbKeys, offset, limit);
                const dbRowsById = new Map(benchDb.requestsByIds(page.filter(e => e.from === 'db').map(e => e.id)).map(r => [r.id, r]));
                const total = lines.length + dbCount;

                const rows = [];
                for (const entry of page) {
                    if (entry.from === 'db') {
                        const dbRow = dbRowsById.get(entry.id);
                        if (dbRow) rows.push(historyMerge.dbRowToRecentRow(dbRow));
                        continue;
                    }
                    const line = entry.line;
                    const cols = splitCsvLine(line);
                    if (cols.length < 32) continue; // only schema v3+ rows have model_name/transport at known offsets
                    rows.push({
                        timestamp: cols[0],
                        runId: cols[1],
                        model: cols[2],
                        transport: cols[7],
                        // parseNumOrNull (not `parseFloat() || null`) so a
                        // genuine 0 reading is reported as 0, not null.
                        promptTps: parseNumOrNull(cols[10]),
                        genTps: parseNumOrNull(cols[11]),
                        promptTokens: parseNumOrNull(cols[13]),
                        genTokens: parseNumOrNull(cols[28]),
                        wallTime: parseNumOrNull(cols[30]),
                        // Draft stats (cols 33+) only exist on rows logged since
                        // speculative-decoding capture was added; null elsewhere.
                        draftAcceptRate: cols.length > 33 ? parseNumOrNull(cols[33]) : null,
                        draftAccepted: cols.length > 34 ? parseNumOrNull(cols[34]) : null,
                        draftGenerated: cols.length > 35 ? parseNumOrNull(cols[35]) : null,
                        draftMeanLen: cols.length > 36 ? parseNumOrNull(cols[36]) : null,
                        aborted: cols.length > 37 ? cols[37] === '1' : false,
                        // Range columns (38+) exist only on rows logged since
                        // ranges were persisted; null on older rows.
                        prefillTpsMin: cols.length > 38 ? parseNumOrNull(cols[38]) : null,
                        prefillTpsMax: cols.length > 39 ? parseNumOrNull(cols[39]) : null,
                        genTpsMin: cols.length > 40 ? parseNumOrNull(cols[40]) : null,
                        genTpsMax: cols.length > 41 ? parseNumOrNull(cols[41]) : null,
                        // Full row detail for the expanded row view. Indices match
                        // CSV_HEADERS exactly -- this drifted out of sync with the
                        // header (every field from promptLatency on was reading
                        // 2-4 columns to the right of its real value, e.g. gpuTemp
                        // was actually reading Master VRAM) until this fix.
                        detail: {
                            modelPath: cols[3] || null,
                            ctx: parseNumOrNull(cols[4]),
                            ngl: parseNumOrNull(cols[5]),
                            rpc: cols[6] || null,
                            argString: cols[8] || null,
                            launchCommand: cols[9] || null,
                            promptLatency: parseNumOrNull(cols[12]),
                            reasonTokens: parseNumOrNull(cols[29]),
                            loadTime: parseNumOrNull(cols[31]),
                            // Hardware stats at completion (master)
                            gpuUtil: parseNumOrNull(cols[14]),
                            gpuPwr: parseNumOrNull(cols[15]),
                            gpuTemp: parseNumOrNull(cols[16]),
                            cpuUtil: parseNumOrNull(cols[17]),
                            cpuTemp: parseNumOrNull(cols[18]),
                            vram: parseNumOrNull(cols[19]),
                            ram: parseNumOrNull(cols[20]),
                            // Hardware stats at completion (worker) -- no
                            // "Worker CPU Util" column exists in the CSV, only GPU
                            // util/pwr/temp + CPU temp + VRAM/RAM.
                            wGpuUtil: cols.length > 21 ? parseNumOrNull(cols[21]) : null,
                            wGpuPwr: cols.length > 22 ? parseNumOrNull(cols[22]) : null,
                            wGpuTemp: cols.length > 23 ? parseNumOrNull(cols[23]) : null,
                            wCpuTemp: cols.length > 24 ? parseNumOrNull(cols[24]) : null,
                            wVram: cols.length > 25 ? parseNumOrNull(cols[25]) : null,
                            wRam: cols.length > 26 ? parseNumOrNull(cols[26]) : null,
                            netThroughput: cols.length > 27 ? parseNumOrNull(cols[27]) : null,
                            // Parsed launch config (structured JSON, if available)
                            config: cols.length > 32 && cols[32] ? (() => { try { return JSON.parse(cols[32]); } catch (e) { return null; } })() : null,
                            // Every launch device's reading at completion (col 42
                            // devices_json); null on rows logged before it existed.
                            deviceStats: cols.length > 42 && cols[42] ? (() => { try { return JSON.parse(cols[42]); } catch (e) { return null; } })() : null,
                        }
                    });
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ rows, total, hasMore: want < total }));
            } catch {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ rows: [], total: 0, hasMore: false }));
            }
        }

        // --- LOGS SUMMARY (Item 15b + Item #24 Schema v2) ---
        // Returns aggregate stats from the benchmarks CSV so the UI can
        // display "Best Gen Speed", "Avg Prefill", etc. without parsing
        // CSV on the client side.
        else if (req.url.startsWith('/api/logs/summary') && req.method === 'GET') {
            try {
                // Optional ?model=<basename>&transport=<Local|WiFi|TB4> filters --
                // "historical performance of THIS model + card(s) + connection
                // mode", not one global blended average across every run ever
                // logged (which is nearly meaningless once you've tried more than
                // one model/config).
                const queryString = req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '';
                const queryParams = new URLSearchParams(queryString);
                const filterModel = queryParams.get('model') || '';
                const filterTransport = queryParams.get('transport') || '';

                const csv = await fs.readFile(CSV_FILE, 'utf-8');
                const lines = csv.trim().split('\n').slice(1); // skip header
                if (lines.length === 0) {
                    // header-only (or empty) -- a CSV with exactly ONE data row
                    // is valid and must be aggregated, not discarded.
                    return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ count: 0 }));
                }
                // Schema v3 columns (0-indexed, 32 cols with launch_command):
                //  10=promptTps, 11=genTps, 12=promptLatency, 13=promptTokens,
                //  30=wallTime, 31=loadTime
                // Schema v2 (31 cols, no launch_command): 9=promptTps, 10=genTps, 11=promptLatency, 29=wallTime, 30=loadTime
                // Old schema (30 cols): 8=promptTps, 9=genTps, 10=promptLatency, 28=wallTime, 29=loadTime
                let n = 0, sumPromptTps = 0, sumGenTps = 0, sumPromptLat = 0, sumWallTime = 0, sumLoadTime = 0;
                let bestPromptTps = 0, bestGenTps = 0, bestPromptLat = Infinity, bestWallTime = Infinity, bestLoadTime = Infinity;
                // Rows are chronological (append-only CSV), so the last matching row
                // processed is the most recent run -- track its own actual values
                // (timestamp + its own prompt/gen tps + load time), not an average.
                // "Runs: N" still reports how many historical rows matched, but the
                // headline numbers are "what happened last time", not a blend.
                let lastModel = null, lastTimestamp = null, lastPromptTps = null, lastGenTps = null, lastLoadTime = null, lastConfig = null;
                for (const line of lines) {
                    if (!line.trim()) continue;
                    const cols = splitCsvLine(line);
                    // Need at least 25 cols to have the core metrics; auto-detect schema
                    if (cols.length < 25) continue;

                    // model_name (col 2) / Transport (col 7) only exist from schema v3
                    // onward (32+ cols) -- older rows have neither, so filters simply
                    // never match them (correctly excluded: we can't know what config
                    // produced them).
                    if (cols.length >= 32) {
                        const rowModel = cols[2];
                        const rowTransport = cols[7];
                        if (filterModel && rowModel !== filterModel) continue;
                        if (filterTransport && rowTransport !== filterTransport) continue;
                        lastModel = rowModel;
                        lastTimestamp = cols[0];
                        // config_json (col 32) only exists from schema v4 onward
                        // (33 cols). Reset per row: a newer row without
                        // config_json must not inherit the previous row's config.
                        lastConfig = null;
                        if (cols.length >= 33 && cols[32]) {
                            try { lastConfig = JSON.parse(cols[32]); } catch { /* older/malformed row -- skip */ }
                        }
                    } else if (filterModel || filterTransport) {
                        continue; // can't match a filter against a schema that has no model/transport columns
                    }

                    let pTps, gTps, pLat, wTime, lTime;
                    if (cols.length >= 32) {
                        // v3: 32 cols with launch_command
                        pTps = parseFloat(cols[10]);
                        gTps = parseFloat(cols[11]);
                        pLat = parseFloat(cols[12]);
                        wTime = parseFloat(cols[30]);
                        lTime = parseFloat(cols[31]);
                    } else if (cols.length >= 31) {
                        // v2: 31 cols without launch_command
                        pTps = parseFloat(cols[9]);
                        gTps = parseFloat(cols[10]);
                        pLat = parseFloat(cols[11]);
                        wTime = parseFloat(cols[29]);
                        lTime = parseFloat(cols[30]);
                    } else {
                        // old: 30 cols
                        pTps = parseFloat(cols[8]);
                        gTps = parseFloat(cols[9]);
                        pLat = parseFloat(cols[10]);
                        wTime = parseFloat(cols[28]);
                        lTime = parseFloat(cols[29]);
                    }
                    // "last*" tracks the most recent row's OWN values -- set
                    // unconditionally so a row missing a field reports null
                    // instead of silently falling back to an older row's number.
                    lastPromptTps = Number.isFinite(pTps) ? pTps : null;
                    lastGenTps = Number.isFinite(gTps) ? gTps : null;
                    lastLoadTime = Number.isFinite(lTime) ? lTime : null;
                    if (Number.isFinite(pTps))  { sumPromptTps += pTps;  if (pTps > bestPromptTps)  bestPromptTps = pTps; }
                    if (Number.isFinite(gTps))  { sumGenTps += gTps;   if (gTps > bestGenTps)     bestGenTps = gTps; }
                    if (Number.isFinite(pLat))  { sumPromptLat += pLat; if (pLat < bestPromptLat)   bestPromptLat = pLat; }
                    if (Number.isFinite(wTime)) { sumWallTime += wTime; if (wTime < bestWallTime)   bestWallTime = wTime; }
                    if (Number.isFinite(lTime)) { sumLoadTime += lTime; if (lTime < bestLoadTime)   bestLoadTime = lTime; }
                    n++;
                }
                // Round to 1 decimal -- raw division produces long floats like
                // 22.101066666666674 which is noise, not information, at this precision.
                const avg = (v, c) => c > 0 ? Math.round((v / c) * 10) / 10 : 0;
                const round1 = (v) => Number.isFinite(v) ? Math.round(v * 10) / 10 : 0;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                if (n === 0) {
                    // Item 15 Step 3: no matching history for this exact
                    // model/transport combo -- say so rather than showing a
                    // misleading zero.
                    return res.end(JSON.stringify({ count: 0, filtered: !!(filterModel || filterTransport) }));
                }
                return res.end(JSON.stringify({
                    count: n,
                    lastModel,
                    lastConfig,
                    lastTimestamp,
                    lastPromptTps: round1(lastPromptTps),
                    lastGenTps: round1(lastGenTps),
                    lastLoadTime: round1(lastLoadTime),
                    filtered: !!(filterModel || filterTransport),
                    avgPromptTps: avg(sumPromptTps, n),
                    avgGenTps: avg(sumGenTps, n),
                    avgPromptLatency: avg(sumPromptLat, n),
                    avgWallTime: avg(sumWallTime, n),
                    avgLoadTime: avg(sumLoadTime, n),
                    bestPromptTps: round1(bestPromptTps),
                    bestGenTps: round1(bestGenTps),
                    bestPromptLatency: isFinite(bestPromptLat) ? round1(bestPromptLat) : 0,
                    bestWallTime: isFinite(bestWallTime) ? round1(bestWallTime) : 0,
                    bestLoadTime: isFinite(bestLoadTime) ? round1(bestLoadTime) : 0,
                }));
            } catch {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ count: 0 }));
            }
        }

        // --- LIST CONFIGURED BUILDS (local-multi-gpu mode's "Build" selector) ---
        else if (req.url === '/api/builds' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ builds: getLlamaServerBuilds() }));
        }

        else if (req.url === '/api/worker/config' && req.method === 'GET') {
            // Top-level fields describe the first valid worker, for clients
            // that only know one (the web worker field, the CLI); `workers`
            // lists them all.
            const workers = listRpcWorkers();
            const first = workers.find((w) => !w.error) || {};
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                ssh: first.ssh || '', port: first.port, devices: first.devices, cache: first.cache, link: first.link, workers,
            }));
        }

        // --- REMOTE ACCESS TUNNEL (Cloudflare quick tunnel + password gate) ---
        // GET: status (url only while running). POST: {action:'start', password}
        // arms the gate and starts cloudflared, or {action:'stop'} tears it
        // down and drops the gate. Both clients (web sidebar, remote CLI) use
        // these; the CLI's `tunnel stop` subcommand is how you unlock a
        // dashboard you can no longer reach locally.
        else if (req.url === '/api/tunnel' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({
                active: tunnelProcess !== null && !tunnelStarting,
                starting: tunnelStarting,
                url: tunnelUrl || null,
            }));
        }
        else if (req.url === '/api/tunnel' && req.method === 'POST') {
            let body;
            try { body = JSON.parse(await parseBody(req)); } catch { body = {}; }
            if (body.action === 'stop') {
                const was = tunnelGateActive();
                stopTunnel();
                broadcastState('', was ? 'tunnel stopped' : '');
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ active: false }));
            }
            if (body.action !== 'start') {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: "action must be 'start' or 'stop'" }));
            }
            try {
                const url = await startTunnel(body.password);
                broadcastState('', `tunnel up: ${url}`);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ active: true, url }));
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: err.message }));
            }
        }

        // --- CHAT PROXY (streaming pass-through to the model server) ---
        // Remote clients (CLI behind the tunnel, browser on the tunnel URL)
        // reach the model through the SAME tunnel as the dashboard: the body
        // (messages/tools/chat_template_kwargs/images) passes through verbatim
        // and the SSE stream is piped straight back. The server's client-
        // agnostic capture still records every request to CSV + COMPLETION
        // from llama-server's own stdout, so chat stats work for any client.
        else if (req.url === '/api/chat' && req.method === 'POST') {
            if (serverState !== 'ready') {
                res.writeHead(409, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'no model running' }));
            }
            const port = portFromLaunchCommand() || 8080;
            const body = await parseBody(req, MAX_CHAT_BODY_SIZE);
            const upstream = http.request({
                host: '127.0.0.1', port, path: '/v1/chat/completions', method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
            }, (up) => {
                const headers = { 'Content-Type': up.headers['content-type'] || 'application/json' };
                if (up.headers['content-type'] && /event-stream/.test(up.headers['content-type'])) {
                    headers['Cache-Control'] = 'no-cache';
                    headers['Connection'] = 'keep-alive';
                }
                res.writeHead(up.statusCode || 502, headers);
                up.pipe(res);
            });
            upstream.on('error', (err) => {
                if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'model server unreachable: ' + err.message }));
            });
            req.on('close', () => { try { upstream.destroy(); } catch { /* already gone */ } });
            upstream.end(body);
            return;
        }

        // --- SLOTS PROXY (prefill-progress poll; remote-safe twin of :8080/slots) ---
        else if (req.url === '/api/slots' && req.method === 'GET') {
            const port = portFromLaunchCommand() || 8080;
            const req2 = http.request({ host: '127.0.0.1', port, path: '/slots', method: 'GET' }, (up) => {
                res.writeHead(up.statusCode || 502, { 'Content-Type': up.headers['content-type'] || 'application/json' });
                up.pipe(res);
            });
            req2.on('error', () => {
                if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify([]));
            });
            req2.end();
            return;
        }

        // --- KEYLESS WEB SEARCH (harness backing for the web_search tool) ---
        // DuckDuckGo's HTML endpoint: no API key, no account. Both clients
        // (CLI chat, web Interactive tab) call this when the model emits a
        // web_search tool call, so the search implementation lives in one
        // place. Results are title/url/snippet triples the model can cite.
        else if (req.url === '/api/web-search' && req.method === 'POST') {
            let body;
            try { body = JSON.parse(await parseBody(req)); } catch { body = {}; }
            const query = String(body.query || '').trim();
            const num = Math.max(1, Math.min(8, parseInt(body.num || 5, 10) || 5));
            if (!query) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'query is required' }));
            }
            try {
                const upstream = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
                    headers: { 'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0' },
                    signal: AbortSignal.timeout(15000),
                });
                if (!upstream.ok) throw new Error(`search endpoint HTTP ${upstream.status}`);
                const html = await upstream.text();
                const clean = (s) => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
                // Title and snippet are pulled as two separate flat passes and
                // zipped by index, rather than one regex spanning both --
                // DDG puts other markup between a result's title and its
                // snippet anchor, and a single pattern with a lazy `[\s\S]*?`
                // gap followed by an OPTIONAL snippet group never backtracks
                // to find it: the engine satisfies the (?:...)? by matching
                // it empty at the first position it tries (right after the
                // title), so the snippet capture was silently empty on every
                // result. Title and snippet anchors appear once per result in
                // the same order, so a straight zip lines them up correctly.
                const titleRe = /<a rel="nofollow" class="result__a" href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g;
                const snippetRe = /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g;
                const titles = [...html.matchAll(titleRe)];
                const snippets = [...html.matchAll(snippetRe)].map((s) => clean(s[1]));
                const results = [];
                for (const t of titles) {
                    if (results.length >= num) break;
                    let url = t[1];
                    const uddg = url.match(/[?&]uddg=([^&]+)/);
                    if (uddg) url = decodeURIComponent(uddg[1]);
                    results.push({ title: clean(t[2]), url, snippet: snippets[results.length] || '' });
                }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ query, count: results.length, results }));
            } catch (err) {
                res.writeHead(502, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'web search failed: ' + err.message }));
            }
        }

        // --- WEB FETCH (harness backing for the web_fetch tool) ---
        // Reads one page for the model and returns its readable text as
        // markdown (lib/webfetch.js: public addresses only, redirects
        // re-checked, download/time/text capped). Both chat clients call this.
        else if (req.url === '/api/web-fetch' && req.method === 'POST') {
            let body;
            try { body = JSON.parse(await parseBody(req)); } catch { body = {}; }
            const url = String(body.url || '').trim();
            if (!url) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'url is required' }));
            }
            const maxChars = Math.max(1000, Math.min(50000, parseInt(body.maxChars, 10) || webFetch.DEFAULT_MAX_CHARS));
            try {
                const page = await webFetch.fetchPage(url, { maxChars });
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ url, ...page }));
            } catch (err) {
                res.writeHead(502, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'web fetch failed: ' + err.message }));
            }
        }

        // --- BENCH: run llama-bench from a configured build (Bench tab) ---
        // Accepts a single config, or { queue: [cfg, ...] } -- the queue lives
        // SERVER-side and chains run-to-run on process exit, so closing the
        // browser tab no longer kills a matrix mid-flight.
        else if (req.url === '/api/bench/start' && req.method === 'POST') {
            let cfg;
            try { cfg = JSON.parse(await parseBody(req)); } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }
            if (benchRunning) {
                res.writeHead(409, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'A bench run is already in progress' }));
            }
            // llama-bench needs the VRAM the model server is holding; refuse
            // rather than letting both fight over it and produce garbage numbers.
            if (llamaProcess) {
                res.writeHead(409, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'Stop the running model first -- llama-bench needs its VRAM for clean numbers' }));
            }
            if (Array.isArray(cfg.queue)) {
                if (cfg.queue.length === 0 || cfg.queue.some(c => !c.modelPath)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    return res.end(JSON.stringify({ error: 'queue must be non-empty configs with modelPath' }));
                }
                benchQueue = cfg.queue.slice(1);
                benchQueueTotal = cfg.queue.length;
                const first = cfg.queue[0];
                benchCurrentLabel = first.label || first.devices || 'run';
                benchLog(`===== llama-bench 1/${benchQueueTotal}: ${benchCurrentLabel} =====`);
                const err = launchBenchProcess(first);
                if (err) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: err })); }
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ ok: true, queued: benchQueue.length, command: benchLastCommand }));
            }
            if (!cfg.modelPath) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'modelPath is required' }));
            }
            benchQueue = []; benchQueueTotal = 0;
            const err = launchBenchProcess(cfg);
            if (err) { res.writeHead(500, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: err })); }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true, command: benchLastCommand }));
        }
        // GET /api/telemetry/range?from=<ms>&to=<ms>&max=<n>&field=<temp|pwr|util|vram|cpu|cpuTemp|net|tps>
        // (tps = two series: generation, id 'tps', and prefill readings, id 'prefill'):
        // recorded telemetry since this process started, for the full-screen telemetry charts' pannable window
        // (lib/telemetryhistory.js; bucket means past `max`). No from/to = the last 30 min.
        else if (req.url.startsWith('/api/telemetry/range') && req.method === 'GET') {
            const q = new URL(req.url, 'http://x').searchParams;
            const n = (k) => (q.has(k) && q.get(k) !== '' && Number.isFinite(Number(q.get(k))) ? Number(q.get(k)) : undefined);
            const out = telemetryHistory.range({ from: n('from'), to: n('to'), max: Math.min(5000, Math.max(50, n('max') || 1500)), field: q.get('field') || null });
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            return res.end(JSON.stringify(out));
        }
        // The request tally (lib/reqtally.js, 2026-10-22): read-only, behind the gate like every route below it.
        else if (req.url === '/api/debug/requests' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
            return res.end(JSON.stringify(reqTally.snapshot()));
        }
        else if (req.url === '/api/telemetry/latest' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(lastServerTelemetry || { t: 0, stats: null }));
        }
        else if (req.url === '/api/telemetry/rate' && req.method === 'POST') {
            let rateBody;
            try { rateBody = JSON.parse(await parseBody(req)); } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }
            telemetryPollMs = Math.max(250, Math.min(5000, parseInt(rateBody.ms) || 1000));
            startTelemetryLoop();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true, ms: telemetryPollMs }));
        }

        // --- SHARED LAUNCH PROFILES (see initProfilesStore) ---
        else if (req.url === '/api/profiles' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            // `availability` and `topology` are computed per request for THIS machine and are never saved.
            const doc = await loadProfilesDoc();
            // Path fields are served as THIS machine's paths (lib/paths.js expandProfile), so every client keeps
            // comparing them with /api/models and the Strata list as it always did; a profile stored with absolute
            // paths is served byte for byte as stored.
            const served = { ...doc, profiles: Object.fromEntries(Object.entries(doc.profiles).map(([n, p]) => [n, p && p.config ? { ...p, config: pathsModel.expandProfile(p.config, pathCtx) } : p])) };
            return res.end(JSON.stringify({ ...served, availability: profileAvailability(served), topology: currentTopology() }));
        }
        else if (req.url === '/api/topology' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(currentTopology()));
        }
        else if (req.url === '/api/profiles' && req.method === 'POST') {
            let body;
            try { body = JSON.parse(await parseBody(req)); } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }
            const name = String(body.name || '').trim();
            if (!name || name.length > 80) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Profile name must be 1-80 characters' })); }
            const doc = await loadProfilesDoc();
            const existing = doc.profiles[name];
            // a client saves what it loaded: a path field that is just the expansion of the stored one keeps the
            // stored (portable) spelling; a profile stored with absolute paths is never rewritten into another form
            const config = pathsModel.keepPortable(existing && existing.config, normalizeProfileConfig(body.config ?? body.profile), pathCtx);
            const lastLoadedAt = toFiniteNumber(body.lastLoadedAt) ?? toFiniteNumber(body.profile && body.profile.lastLoadedAt);
            if (Object.keys(config).length === 0) {
                // Load-mark only ({name, lastLoadedAt}): touch the usage
                // timestamp without resaving the config -- and without
                // re-validating a model path that may since have moved.
                if (!existing) { res.writeHead(404); return res.end(JSON.stringify({ error: `Profile "${name}" not found` })); }
                doc.profiles[name] = {
                    ...existing,
                    lastLoadedAt: lastLoadedAt ?? existing.lastLoadedAt ?? null,
                };
            } else {
                // The model path is only meaningful on the machine that runs
                // llama-server -- validate it here, where the file actually
                // lives (a remote CLI client cannot check it locally).
                if (config.modelPath) {
                    const real = pathsModel.expandModel(config.modelPath, pathCtx);
                    try { await fs.access(real); }
                    catch { res.writeHead(400); return res.end(JSON.stringify({ error: `Model path not found: ${real}${real !== config.modelPath ? ` (written ${config.modelPath})` : ''}` })); }
                }
                doc.profiles[name] = {
                    config,
                    savedAt: Date.now(),
                    lastLoadedAt: lastLoadedAt ?? existing?.lastLoadedAt ?? null,
                };
            }
            await saveProfilesDoc(doc);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true, name }));
        }
        else if (req.url.startsWith('/api/profiles/') && req.method === 'DELETE') {
            const name = decodeURIComponent(req.url.slice('/api/profiles/'.length).split('?')[0]);
            const doc = await loadProfilesDoc();
            if (!name || !doc.profiles[name]) { res.writeHead(404); return res.end(JSON.stringify({ error: `Profile "${name}" not found` })); }
            delete doc.profiles[name];
            await saveProfilesDoc(doc);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true, name }));
        }
        else if (req.url === '/api/bench/note' && req.method === 'POST') {
            // Client-composed result blocks (e.g. Launch Sweep tables) appended
            // into the same transcript/accordion/history file as bench runs.
            let noteBody;
            try { noteBody = JSON.parse(await parseBody(req)); } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }
            const noteLines = Array.isArray(noteBody.lines) ? noteBody.lines.slice(0, 200) : [];
            for (const l of noteLines) benchLog(String(l).slice(0, 2000));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true }));
        }
        else if (req.url === '/api/bench/clear' && req.method === 'POST') {
            benchOutput = [];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true }));
        }
        else if (req.url === '/api/bench/restore' && req.method === 'POST') {
            // Undo for clear: reload the transcript tail from the disk log.
            try {
                const hist = await fs.readFile(path.join(LOGS_DIR, 'bench-history.log'), 'utf-8');
                benchOutput = hist.split('\n').filter(l => l !== '').slice(-1500);
            } catch { benchOutput = []; }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true, output: benchOutput }));
        }
        else if (req.url === '/api/bench/dequeue' && req.method === 'POST') {
            // Remove a not-yet-started run from the server-side matrix queue.
            let dq;
            try { dq = JSON.parse(await parseBody(req)); } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }
            const before = benchQueue.length;
            benchQueue = benchQueue.filter(q => q.label !== dq.label);
            if (benchQueue.length !== before) benchLog(`[matrix] dequeued: ${dq.label}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true, removed: before - benchQueue.length, queueRemaining: benchQueue.length }));
        }
        else if (req.url === '/api/bench/stop' && req.method === 'POST') {
            benchQueue = []; benchQueueTotal = 0; // stop also cancels queued matrix runs
            if (benchProcess) benchProcess.kill('SIGTERM');
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ ok: true }));
        }
        else if (req.url === '/api/bench/status' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ running: benchRunning, command: benchLastCommand, output: benchOutput,
                queueRemaining: benchQueue.length, queueTotal: benchQueueTotal,
                currentLabel: benchRunning ? benchCurrentLabel : '',
                samples: benchRunning ? activeRequestSamples : benchLastSamples }));
        }

        // --- HEADLESS LAUNCH SWEEP ---
        // The same runner the browser's Launch Sweep tab drives, but started
        // and polled over http so a sweep can be queued from a headless box or
        // over ssh and survives having no browser tab open at all. See
        // lib/sweep.js. Only one sweep at a time, and it refuses to start on
        // top of a running model so it can't fight an interactive session.
        else if (req.url === '/api/sweep/start' && req.method === 'POST') {
            let body;
            try { body = JSON.parse(await parseBody(req, MAX_CHAT_BODY_SIZE)); }
            catch { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }
            if (llamaProcess || launchPending) {
                res.writeHead(409, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'a model is already running -- stop it first' }));
            }
            if (benchRunning) {
                res.writeHead(409, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: 'llama-bench is running' }));
            }
            try {
                const out = await sweepModel.start(body);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ ok: true, ...out }));
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ error: err.message }));
            }
        }
        else if (req.url === '/api/sweep/status' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(sweepModel.status()));
        }
        else if (req.url === '/api/sweep/stop' && req.method === 'POST') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(sweepModel.stop()));
        }

        // --- EXTERNAL SUITES (EvalPlus / Aider polyglot) -- the "Suites" bench tab ---
        else if (req.url === '/api/suite/list' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(suitesModel.list()));
        }
        else if (req.url === '/api/suite/start' && req.method === 'POST') {
            let body; try { body = JSON.parse(await parseBody(req)); } catch { res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }
            if (serverState !== 'ready') { res.writeHead(409, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'no model running -- launch one first; suites use the served model' })); }
            try { const out = suitesModel.start(body); res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, ...out })); }
            catch (err) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: err.message })); }
        }
        else if (req.url === '/api/suite/status' && req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(suitesModel.status())); }
        else if (req.url === '/api/suite/stop' && req.method === 'POST') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(suitesModel.stop())); }

        // --- CODEBENCH (quality benchmarks, lib/codebench.js) -- the Bench tab's "codebench" sub-tab ---
        else if (req.url.startsWith('/api/codebench/') ) {
            const cbUrl = new URL(req.url, 'http://x'); const cbQ = cbUrl.searchParams; const cbPath = cbUrl.pathname;
            const cbJson = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(obj)); };
            try {
                if (cbPath === '/api/codebench/runs' && req.method === 'GET') return cbJson(200, { runs: codebenchModel.listRuns() });
                if (cbPath === '/api/codebench/run' && req.method === 'GET') return cbJson(200, codebenchModel.getRun(cbQ.get('dir') || ''));
                if (cbPath === '/api/codebench/result' && req.method === 'GET') return cbJson(200, codebenchModel.getResult(cbQ.get('dir') || '', cbQ.get('task') || ''));
                if (cbPath === '/api/codebench/tasks' && req.method === 'GET') return cbJson(200, await codebenchModel.listTasks());
                if (cbPath === '/api/codebench/models' && req.method === 'GET') return cbJson(200, { runner: cbQ.get('runner') || '', models: await codebenchModel.listModels(cbQ.get('runner') || '') });
                if (cbPath === '/api/codebench/live' && req.method === 'GET') {
                    const l = codebenchModel.live({ battery: cbQ.get('battery') || undefined });   // ?battery=<dir>: live view's lane switcher
                    try { l.tps = codebenchTps(l); } catch (err) { console.error('[tps]', err.message); l.tps = null; }   // per-task t/s; SSE snapshots do not carry it
                    // the queue item running this battery: its question, Kyle's note and its own notes, for the top of the Live view
                    try { l.queue_item = l.running && l.battery && l.battery.name ? queueModel.runningFor(l.battery.name) : null; } catch (err) { console.error('[queue item]', err.message); l.queue_item = null; }
                    return cbJson(200, l);
                }
                // Live view: each task's /100 difficulty, strength points and this battery's config's predicted P(solve), from the
                // Models page's fit (lib/liveodds.js; Kyle 2026-10-24). ?battery=<dir>&level=<prompt level>&tasks=a,b,c
                if (cbPath === '/api/codebench/odds' && req.method === 'GET') {
                    try {
                        const battery = String(cbQ.get('battery') || '');
                        const tasks = String(cbQ.get('tasks') || '').split(',').map((t) => t.trim()).filter(Boolean).slice(0, 500);
                        const [catalog, L] = await Promise.all([aqCatalog(), autoqueueModel.leaderboardModule()]);
                        let item = null;
                        try {
                            const r = battery ? queueModel.open().prepare("SELECT id FROM queue_items WHERE label=? OR result_dir LIKE ? ORDER BY id DESC LIMIT 1").get(battery, '%/' + battery) : null;
                            if (r) item = queueModel.get(r.id);
                        } catch { item = null; }
                        return cbJson(200, require('./lib/liveodds').liveOdds({ battery, tasks, level: cbQ.get('level') || '' },
                            { catalog, etag: aqCatalogMemo.etag, L, queue: queueModel, item }));
                    } catch (err) { console.error('[odds]', err.message); return cbJson(500, { error: err.message }); }
                }
                if (cbPath === '/api/codebench/start' && req.method === 'POST') {
                    let body; try { body = JSON.parse(await parseBody(req)); } catch { return cbJson(400, { error: 'Invalid JSON' }); }
                    try { return cbJson(200, codebenchModel.start(body)); } catch (err) { return cbJson(409, { error: err.message }); }
                }
                // --- ADDED 2026-09-22 (transcript viewer, task context panel, battery controls) ---
                // One task's transcript as normalised events (lib/codebench.js parseTranscript):
                // {task, runner, events[], stats, total, returned, truncated, next_from}. `from` is an
                // event index so the Live view can poll only what it does not already have.
                if (cbPath === '/api/codebench/transcript' && req.method === 'GET') return cbJson(200, codebenchModel.getTranscript(cbQ.get('dir') || '', cbQ.get('task') || '', { from: cbQ.get('from'), limit: cbQ.get('limit'), which: cbQ.get('which') }));
                // Everything a reader needs to understand one task: `run.py --show <id> --json`
                // (prompt levels, probes, the hidden tests' case titles, the expected failure modes).
                if (cbPath === '/api/codebench/task' && req.method === 'GET') return cbJson(200, await codebenchModel.getTaskInfo(cbQ.get('id') || ''));
                if (cbPath === '/api/codebench/cases' && req.method === 'GET') return cbJson(200, { task: cbQ.get('task') || '', results: codebenchModel.listTaskCases(cbQ.get('task') || '') });
                // Side experiments (Bench -> codebench -> Experiments): result JSONs carrying a verify-on-fail block. Never part of mainline scoring.
                if (cbPath === '/api/codebench/experiments/verify' && req.method === 'GET') return cbJson(200, { rows: codebenchModel.listVerifyRuns() });
                // Battery control per harness/CONTROL.md: the UI writes <out>/control.json, run.py
                // polls it between tasks. Works for an adopted battery too -- the files are the contract.
                if (cbPath === '/api/codebench/pause' && req.method === 'POST') return cbJson(200, codebenchModel.pause({ battery: cbQ.get('battery') || undefined }));
                if (cbPath === '/api/codebench/resume' && req.method === 'POST') return cbJson(200, codebenchModel.resume({ battery: cbQ.get('battery') || undefined }));
                if (cbPath === '/api/codebench/stop' && req.method === 'POST') {
                    let sbody = {}; try { const raw = await parseBody(req); if (raw && String(raw).trim()) sbody = JSON.parse(raw); } catch { sbody = {}; }   // no body = the old call = stop after the current task
                    return cbJson(200, codebenchModel.stop({ mode: sbody.mode, battery: sbody.battery || cbQ.get('battery') || undefined }));
                }
                // --- end of the 2026-09-22 additions ---
                if (cbPath === '/api/codebench/stop' && req.method === 'POST') return cbJson(200, codebenchModel.stop());
                // --- ADDED 2026-09-30 (Kyle: a finished task opens in the Live view, not a separate Transcript page) ---
                // One finished task in the live snapshot's own shape (lib/codebench.js taskSnapshot: result JSON +
                // transcript), so ui/benchmarks/live.js draws it with the running task's code. Read-only; `tps`
                // as on /live (codebenchTps reads the snapshot's tasks + outDir the same way).
                if (cbPath === '/api/codebench/task-snapshot' && req.method === 'GET') {
                    const ts = codebenchModel.taskSnapshot(cbQ.get('battery') || cbQ.get('dir') || '', cbQ.get('task') || '');
                    try { ts.tps = codebenchTps(ts); } catch (err) { console.error('[tps]', err.message); ts.tps = null; }
                    return cbJson(200, ts);
                }
                return cbJson(404, { error: 'unknown codebench route' });
            } catch (err) { return cbJson(400, { error: err.message }); }
        }
        // --- QUEUE (lib/queue.js handleApi): the benchmark queue's rows -- list, edit, reorder, stop controls, lane pause ---
        else if (req.url === '/api/queue' || req.url.startsWith('/api/queue/') || req.url.startsWith('/api/queue?')) {
            const qu = new URL(req.url, 'http://x');
            let qBody = null;
            if (req.method === 'POST') { try { const raw = await parseBody(req); qBody = raw && String(raw).trim() ? JSON.parse(raw) : {}; } catch { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'Invalid JSON' })); } }
            const out = require('./lib/queue').handleApi(queueModel, { method: req.method, path: qu.pathname, query: qu.searchParams, body: qBody }, { loadSettings: autoqueueModel.loadSettings });
            // Each lane's cards on THIS machine (2026-10-12; lib/queue.js laneCardInfo): `card` { label, here, remote }
            // and `parked` (a paused lane with no runner, or one whose cards are not in this machine). Display only.
            if (out.code === 200 && out.body && Array.isArray(out.body.lanes)) {
                try { out.body.lanes = require('./lib/queue').laneCardInfo(out.body.lanes, currentTopology()); out.body.machine = currentTopology().signature; } catch { /* the list as it was */ }
            }
            res.writeHead(out.code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify(out.body));
        }
        // --- AUTO QUEUE (lib/autoqueue.js): settings file, live-queue state, enqueue (dry run unless confirmed) ---
        else if (req.url.startsWith('/api/autoqueue/')) {
            const aqPath = req.url.split('?')[0];
            const aqJson = (code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); return res.end(JSON.stringify(obj)); };
            try {
                if (aqPath === '/api/autoqueue/settings' && req.method === 'GET') {
                    const st = autoqueueModel.loadSettings();
                    return aqJson(200, { settings: st, availability: autoqueueModel.availability(st), defaults: autoqueueModel.DEFAULT_SETTINGS, file: autoqueueModel.SETTINGS_FILE });
                }
                if (aqPath === '/api/autoqueue/settings' && (req.method === 'PUT' || req.method === 'POST')) {
                    let body; try { body = JSON.parse(await parseBody(req)); } catch { return aqJson(400, { error: 'Invalid JSON' }); }
                    const st = autoqueueModel.saveSettings(body);
                    return aqJson(200, { ok: true, settings: st, availability: autoqueueModel.availability(st) });
                }
                if (aqPath === '/api/autoqueue/state' && req.method === 'GET') {
                    const st = autoqueueModel.loadSettings();
                    // promptTasks: the tasks an L3 (L1) focus config can run (those with a prompt at that level)
                    return aqJson(200, { chain: autoqueueModel.detectChain(st.queue && st.queue.dir), pending: autoqueueModel.pendingRuns(st),
                        batches: autoqueueModel.listBatches(), backlog: autoqueueModel.parseExperiments(), promptTasks: autoqueueModel.promptTasksFor(st),
                        queueLanes: autoqueueModel.QUEUE_LANES, refillLast: aqRefillTimer.last(), floorLast: aqRefillTimer.lastFloor() });
                }
                // refill DRY RUN: what the continuous refill would insert on each lane right now (nothing is written)
                if (aqPath === '/api/autoqueue/refill' && req.method === 'GET') {
                    return aqJson(200, await autoqueueModel.refill({ dryRun: true }, { catalog: aqCatalog }));
                }
                // lane floor DRY RUN (2026-10-21): per lane, its queued hours and what the floor would release / insert now
                if (aqPath === '/api/autoqueue/floor' && req.method === 'GET') {
                    return aqJson(200, await autoqueueModel.floor({ dryRun: true }, { catalog: aqCatalog }));
                }
                if (aqPath === '/api/autoqueue/enqueue' && req.method === 'POST') {
                    let body; try { body = JSON.parse(await parseBody(req)); } catch { return aqJson(400, { error: 'Invalid JSON' }); }
                    // dry run unless the caller says otherwise AND confirms: the real path writes queueN.sh and starts it
                    return aqJson(200, autoqueueModel.enqueue({ batch: body.batch, dryRun: body.dryRun !== false, confirm: body.confirm === true }));
                }
                return aqJson(404, { error: 'unknown autoqueue route' });
            } catch (err) { return aqJson(400, { error: err.message }); }
        }
        // ui/<module>/<file>.js|css -- ES modules under ui/ (the static handler above only serves root-level and vendor/ files)
        else if (req.method === 'GET' && /^\/ui\/[\w-]+\/[\w.-]+\.(js|css)$/.test(req.url.split('?')[0])) {
            const uiPath = req.url.split('?')[0]; const uiFile = path.join(__dirname, uiPath);
            if (!uiFile.startsWith(path.join(__dirname, 'ui') + path.sep)) { res.writeHead(403); return res.end('Forbidden'); }
            try { const content = await fs.readFile(uiFile); return sendCompressed(req, res, content, { 'Content-Type': uiPath.endsWith('.css') ? 'text/css' : 'application/javascript', 'Cache-Control': 'no-store' }); }
            catch { res.writeHead(404); return res.end('Not found'); }
        }

        // --- FLAG REFERENCE (searchable popover) ---
        else if (req.url.startsWith('/api/flags') && req.method === 'GET') {
            const queryParams = new URLSearchParams(req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '');
            const buildId = queryParams.get('build') || '';
            if (cachedFlagReferenceByBuild.has(buildId)) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ flags: cachedFlagReferenceByBuild.get(buildId) }));
            }
            // `--help` is a probe as well (llama.cpp loads every backend before printing usage): the same rule as the
            // device list -- not while something is on a local card, unless asked with ?refresh=1.
            // refresh skips the soft rule only: never while the queue has work on the cards (lib/gpusafety.js)
            const flagsBusy = queueHardBusy() || (/^(1|true|yes)$/i.test(queryParams.get('refresh') || '') ? null : localCardsBusy());
            if (flagsBusy) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ flags: [], error: `not read while the cards are busy (${flagsBusy})`, deferred: true }));
            }
            try {
                const { stdout } = await execFileAsync(getLlamaServerBinary(buildId), ['--help'], { timeout: 8000, maxBuffer: 1024 * 1024 });
                const flags = parseHelpFlags(stdout);
                cachedFlagReferenceByBuild.set(buildId, flags);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ flags }));
            } catch (err) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ flags: [], error: err.message }));
            }
        }

        // --- LIST VULKAN/CUDA DEVICES (local-multi-gpu mode) ---
        else if (req.url.startsWith('/api/devices') && req.method === 'GET') {
            const queryParams = new URLSearchParams(req.url.includes('?') ? req.url.slice(req.url.indexOf('?') + 1) : '');
            let binary;
            try {
                const wantBuild = queryParams.get('build') || '';
                // With no explicit build, prefer the binary that is ACTUALLY RUNNING. The fallback
                // below is builds[0], which is a CUDA+Vulkan tree with no ROCm -- so a server
                // launched on ROCm0 had its device id resolve to nothing and telemetry rendered a
                // perfectly healthy 7900 XTX as "Offline". Reported twice by Kyle (2026-09-20/21).
                const runningBin = (currentLaunchCommand || '').trim().split(/\s+/)[0];
                if (!wantBuild && runningBin && runningBin.includes('llama-server')) {
                    binary = runningBin;
                } else {
                    binary = getLlamaServerBinary(wantBuild);
                }
            } catch (err) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ devices: [], error: err.message }));
            }
            // A probe runs only on `?refresh=1` or while nothing is on a local card (lib/deviceprobe.js; the boot
            // probe is initServer's). Otherwise, and whenever the probe fails or times out, the answer is the last
            // good listing with its age (`cached`, `cachedAt`, `ageMs`, `note`) -- a failed probe never empties the
            // device table again. A build with no listing of its own is shown the fullest listing another build
            // has (`borrowed`, `from`): the same cards, but possibly ids this build lacks, and it says so.
            // `devices` is the raw llama.cpp listing; `cards` groups it per physical GPU (one NVIDIA card is both
            // CUDA0 and Vulkan0); `workers` are the configured RPC workers.
            try {
                const refresh = /^(1|true|yes)$/i.test(queryParams.get('refresh') || '');
                const r = await deviceCache.request(binary, { refresh });
                const fromBuild = r.borrowed ? (getLlamaServerBuilds().find((b) => b.path === r.from) || {}).id || null : null;
                const topology = r.borrowed
                    ? topologyModel.build({ detected: r.devices, hostRamMib: os.totalmem() / 1048576, workers: listRpcWorkers().filter((w) => !w.error) })
                    : currentTopology(binary);
                const body = { devices: r.devices, cards: devicesModel.physicalCards(r.devices), workers: listRpcWorkers(), topology,
                    cached: r.cached, cachedAt: r.cachedAt, ageMs: r.ageMs, probed: r.probed, borrowed: r.borrowed, from: fromBuild,
                    note: r.note && fromBuild ? r.note.replace('as another build lists them', `as build "${fromBuild}" lists them`) : r.note };
                // `error` only when there is something wrong to say: with a listing to show it rides beside it
                if (r.error) body.error = r.error;
                // a "probe now" turned down because the queue has work on the cards (lib/gpusafety.js); `note` says why
                if (r.refused) body.refused = true;
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify(body));
            } catch (err) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ devices: [], error: err.message || 'failed' }));
            }
        }

        // --- PREVIEW LAUNCH COMMAND (raw-command-as-source-of-truth UI) ---
        // Same structured-config -> command resolution /api/start uses, minus
        // actually spawning anything. The frontend calls this on every GUI field
        // change to keep the editable raw-command textarea in sync; whatever text
        // sits in that box at Boot time is what actually gets tokenized and run
        // (see the rawCommand branch in /api/start below) -- this endpoint only
        // generates the *starting point* for editing, it is not itself the source
        // of truth once the user starts typing in the box.
        else if (req.url === '/api/preview-command' && req.method === 'POST') {
            let body;
            try { body = JSON.parse(await parseBody(req)); } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }
            try {
                const { command, args, plan } = resolveLaunchCommand(pathsModel.expandProfile(body, pathCtx));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                // placement / splitMode / status (2026-10-12): the launch in words for this machine ("2x RX 7900 XTX, 1:1"),
                // how it is split, and whether its devices were re-pointed (lib/topology.js). Additive.
                const topology = currentTopology(/(^|\/)llama-server$/.test(String(command || '')) ? command : null);
                return res.end(JSON.stringify({ command: formatCommand(command, args), devices: plan.devices, warnings: plan.warnings, busy: launchBusy(command, args, plan.devices),
                    placement: topologyModel.placementLabel(plan.devices, topology), splitMode: plan.splitMode || null, status: plan.status || 'ready', signature: topology.signature }));
            } catch (err) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ command: '', error: err.message }));
            }
        }

        // --- STRATA ENGINE (Qwen3.8-Flash-Next) ---
        // The Strata engine takes everything from its JSON config file (no CLI overrides), so
        // the GUI works in two steps: list the base configs, then merge the GUI's overrides
        // into a copy (lib/strata.js) and get back the queue-serve.sh command for it. No
        // overrides -> the base file itself is launched, nothing rewritten.
        else if (req.url === '/api/strata/configs' && req.method === 'GET') {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            // Every configured install (dashboard.config.json `strataInstalls`, STRATA_DIR first): each config carries
            // its `install` and `version`. `dir` / `serveScript` are the first install's, as before (null without one);
            // `installs` is always an array -- [] on a machine without Strata.
            // `thpOff`: the install's launcher runs the server with transparent huge pages off (0.1.44.1's nothp wrapper);
            // each config's `settings` = what the file sets for every override field (lib/strata.js describe); `kvTypes` =
            // what --kv takes; `overrideKeys` = the override fields this server merges (2026-10-17: + pipeline windows,
            // resident budget, gpu, layer split, stage trim, kernel copy).
            const installs = strataModel.installs().map((i) => ({ dir: i.dir, version: i.version, label: i.label, serveScript: i.serveScript, thpOff: i.thpOff, configs: strataModel.listConfigs(i.dir).length }));
            return res.end(JSON.stringify({ dir: strataModel.STRATA_DIR, serveScript: strataModel.SERVE_SCRIPT, configs: strataModel.listConfigs(), installs, kvTypes: strataModel.KV_TYPES, overrideKeys: strataModel.OVERRIDE_KEYS }));
        }

        else if (req.url === '/api/strata/preview' && req.method === 'POST') {
            let body;
            try { body = JSON.parse(await parseBody(req)); } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }
            try {
                const r = strataModel.resolveLaunch(body && body.base, (body && body.overrides) || {});
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ command: r.command, configPath: r.path, base: body.base, changed: r.path !== body.base, maxContext: r.maxContext }));
            } catch (err) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ command: '', error: err.message }));
            }
        }

        // --- START SERVER ---
        else if (req.url === '/api/start' && req.method === 'POST') {
            let body;
            try { body = JSON.parse(await parseBody(req)); } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }

            if (llamaProcess || launchPending) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Running' })); }

            // paths written ~/... or ${ROOT}/... (a profile from another machine, a hand-written config) are this
            // machine's paths from here on; an absolute path is untouched (lib/paths.js)
            let config = pathsModel.expandProfile(body, pathCtx);
            let command, args, plan;

            // The raw command box is the actual source of truth for what runs --
            // structured `config` fields are used for display/CSV/Item-22-restore
            // purposes and to seed the box's initial content (via /api/preview-command
            // above), but everything actually executed comes from tokenizing
            // whatever text the user left in that box. Only fall back to
            // reconstructing from structured fields if it's empty (e.g. a client
            // that hasn't loaded the new UI, or the box genuinely wasn't touched).
            // A failure here (bad build config, missing model/ctx/ngl, empty
            // box) must return a clean 400 -- NOT an unhandled rejection that
            // leaves the dashboard stuck in 'starting' with stale launch state.
            try {
                if (config.rawCommand && config.rawCommand.trim().length > 0) {
                    const tokens = tokenizeCommand(config.rawCommand.trim());
                    command = tokens[0];
                    args = tokens.slice(1);
                    if (!command) throw new Error('Invalid raw command');

                    const isStrata = config.engine === 'strata' || /queue-serve\.sh/.test(command);
                    if (isStrata) {
                        const cfgPath = args[0];
                        let sc = {};
                        if (cfgPath) {
                            try { sc = JSON.parse(fsSync.readFileSync(cfgPath, 'utf8')); } catch { /* ignore */ }
                        }
                        const mName = sc.model_name || (cfgPath ? path.basename(cfgPath, '.json') : 'strata');
                        const strataPort = toFiniteNumber(extractLastFlagValue(args, '--port')) || 8095;
                        config = { ...config, engine: 'strata', model: mName, modelPath: cfgPath || '', port: strataPort, devices: strataPlanDevices(args) };
                        plan = { devices: config.devices, workers: [] };
                    } else {
                        // The raw command is what actually runs, so sync the
                        // structured config from it -- otherwise the CSV row, the
                        // /slots poll, and worker telemetry would all use stale UI
                        // values for model/port/rpc.
                        const modelVal = extractLastFlagValue(args, '-m') ?? extractLastFlagValue(args, '--model');
                        // model = display name (basename), modelPath = the real path
                        if (modelVal) config = { ...config, model: String(modelVal).split('/').pop(), modelPath: modelVal };
                        const portVal = toFiniteNumber(extractLastFlagValue(args, '--port'));
                        if (portVal !== undefined) config = { ...config, port: portVal };
                        // -dev/-ts/--rpc: record the devices that actually run, and
                        // plan them to learn which workers need starting. The
                        // command runs verbatim regardless -- a device list that
                        // can't be planned (e.g. an --rpc endpoint no configured
                        // worker owns) just means nothing to auto-start.
                        const rawDevices = devicesModel.devicesFromArgs(args, dashboardConfig.rpcWorkers, rpcEndpointFor);
                        if (rawDevices) config = { ...config, devices: rawDevices };
                        try {
                            plan = devicesModel.planDevices(config, dashboardConfig.rpcWorkers);
                        } catch {
                            plan = { devices: [], workers: [] };
                        }
                    }
                } else {
                    ({ command, args, plan } = resolveLaunchCommand(config));
                    if (config.engine === 'strata') {
                        const cfgPath = args[0];
                        let sc = {};
                        if (cfgPath) {
                            try { sc = JSON.parse(fsSync.readFileSync(cfgPath, 'utf8')); } catch { /* ignore */ }
                        }
                        const mName = sc.model_name || (cfgPath ? path.basename(cfgPath, '.json') : 'strata');
                        const strataPort = toFiniteNumber(extractLastFlagValue(args, '--port')) || 8095;
                        config = { ...config, engine: 'strata', model: mName, modelPath: cfgPath || '', port: strataPort, devices: plan.devices };
                    }
                }
            } catch (err) {
                return res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: err.message }));
            }

            // This machine cannot run it (2026-10-13): a card it does not have, a device id its build does not list,
            // less memory than the profile says it needs (lib/topology.js launchGate). Until now only the clients
            // asked; a launch sent straight here started and failed in llama-server, or ran somewhere unintended.
            // `allowUnavailable: true` is the caller's explicit "launch it anyway" -- its own flag, not `force`,
            // which stays the busy-card answer -- and like `force` it is never stored with the config.
            if (!body.allowUnavailable) {
                let gate = null;
                try {
                    let gateBinary = null;
                    try { gateBinary = config.engine === 'strata' ? null : launchBinaryOf(config, formatCommand(command, args)); } catch { gateBinary = null; }
                    // an engine with its own launcher names no device id: what it needs is the request's `needs`
                    // (a client sends the loaded profile's) and the card count its own `gpu` list asks for
                    const gateNeeds = config.engine === 'strata' ? withStrataNeeds({ engine: 'strata', needs: body.needs }, args).needs : body.needs;
                    gate = topologyModel.launchGate(
                        config.rawCommand && config.rawCommand.trim() ? { rawCommand: config.rawCommand, needs: gateNeeds } : { devices: devicesModel.configDevices(body), argString: body.argString, needs: gateNeeds },
                        currentTopology(gateBinary), { reference: currentTopology() });
                } catch { gate = null; }   // the gate never turns a launch into a 500
                if (gate) {
                    return res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({
                        error: `This machine cannot run this launch as it is. ${gate.reason} Change its devices, or launch anyway.`,
                        code: 'UNAVAILABLE_HERE', availability: gate }));
                }
            }
            // A queue item is on a card this launch needs: say so instead of taking its VRAM (2026-10-10). The
            // caller confirms and repeats the request with force: true.
            if (!body.force) {
                const busy = launchBusy(command, args, plan && plan.devices);
                if (busy.length) {
                    return res.writeHead(409, { 'Content-Type': 'application/json' }).end(JSON.stringify({
                        error: `Card busy: ${launchGuard.describe(launchConflicts(command, args, plan && plan.devices))}. Stop that item or pause its lane first, or launch anyway.`,
                        code: 'CARD_BUSY', busy }));
                }
            }
            if (config && ('force' in config || 'allowUnavailable' in config)) { config = { ...config }; delete config.force; delete config.allowUnavailable; }   // one-off answers, not launch settings

            // Keep the legacy fields in step with the device list for readers
            // that haven't moved to it yet (telemetry routing, CSV, old UI).
            if (plan.devices.length > 0) {
                config = { ...config, devices: devicesModel.sanitizeDevices(plan.devices), ...devicesModel.devicesToLegacy(plan) };
            }

            // RPC: start every worker the launch uses (and its ssh forward) if
            // it isn't serving yet, so a config or profile with workers boots in
            // one click. launchPending blocks a second /api/start meanwhile.
            if (plan.workers.length > 0) {
                launchPending = true;
                try {
                    for (const w of plan.workers) {
                        await ensureRpcWorker(w, (msg) => { console.log(msg); broadcastState(msg); });
                    }
                } catch (err) {
                    return res.writeHead(400, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: `RPC worker: ${err.message}` }));
                } finally {
                    launchPending = false;
                }
            }

            currentModel = config.model || config.modelPath || '';
            isRpc = plan.workers.length > 0 || !!config.rpcTarget;
            currentLaunchConfig = config;
            serverState = 'starting';
            loadStartTime = Date.now();
            serverStartedAt = loadStartTime;
            finalLoadTime = 0;
            // Clear log buffer for fresh run (see dashboard-bugs1-analysis.md item 5)
            masterLogBuffer = [];
            broadcastState();

            currentLaunchCommand = formatCommand(command, args);
            console.log('LAUNCHING:', currentLaunchCommand);
            broadcastState('', 'LAUNCH CMD: ' + currentLaunchCommand);   // shows in chat as an "error"-style banner

            try {
                llamaProcess = spawnLlamaProcess(command, args, { cwd: ROOT_DIR });
            } catch (err) {
                // Synchronous spawn failure (e.g. non-string command) -- reset
                // the state just set above so the dashboard doesn't sit in
                // 'starting' forever with a dead launch config.
                llamaProcess = null;
                serverState = 'stopped';
                currentModel = '';
                isRpc = false;
                currentLaunchConfig = null;
                broadcastState('', 'Failed to start process: ' + err.message);
                return res.writeHead(500, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: err.message }));
            }

            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ status: 'launching' }));
        }

        // --- STOP SERVER ---
        else if (req.url === '/api/stop' && req.method === 'POST') {
            serverState = 'stopping';
            broadcastState();
            // The master always runs as a directly-spawned process now -- no
            // compose container to bring down.
            // Request the kill but don't null `llamaProcess` here -- the process's own
            // 'close' handler (registered at spawn time) is now the single place that
            // clears shared state, once the process has actually exited. Nulling it here
            // first was the other half of the race that used to crash the whole process
            // (see dashboard-bugs1-analysis.md item 13).
            if (llamaProcess) {
                const proc = llamaProcess;
                try {
                    proc.kill('SIGTERM');
                } catch { /* process may already be gone */ }
                // Escalate to SIGKILL if it ignores SIGTERM (e.g. stuck in a
                // long syscall) -- the 'close' handler is the only place that
                // clears state, so a kill that lands after close is a no-op.
                setTimeout(() => {
                    try { proc.kill('SIGKILL'); } catch { /* already gone */ }
                }, 3000).unref();
            }
            serverState = 'stopped';
            currentModel = '';
            isRpc = false;
            currentLaunchConfig = null;
            broadcastState();
            // Drop the RPC forward once llama-server is gone -- unless a new
            // boot has claimed it in the meantime.
            setTimeout(() => { if (!llamaProcess && !launchPending) closeAllRpcTunnels(); }, 4000).unref();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ status: 'stopped' }));
        }

        // --- WORKER START ---
        else if (req.url === '/api/worker/start' && req.method === 'POST') {
            let body;
            try { body = JSON.parse(await parseBody(req)); } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }
            try {
                const { stdout, stderr } = await startRpcWorker(workerFromBody(body));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: true, stdout, stderr }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: false, error: err.message }));
            }
        }

        // --- WORKER STOP ---
        else if (req.url === '/api/worker/stop' && req.method === 'POST') {
            let body;
            try { body = JSON.parse(await parseBody(req)); } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }
            try {
                const w = workerFromBody(body);
                closeRpcTunnel(w.name);
                const { stdout, stderr } = await stopRpcWorker(w);
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: true, stdout, stderr }));
            } catch (err) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ success: false, error: err.message }));
            }
        }

        // --- WORKER STATUS ---
        else if (req.url === '/api/worker/status' && req.method === 'POST') {
            let body;
            try { body = JSON.parse(await parseBody(req)); } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }
            let w;
            try { w = workerFromBody(body); } catch (err) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ status: 'offline', error: err.message }));
            }
            res.writeHead(200, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify(await getRpcWorkerStatus(w)));
        }

        // --- WORKER LOGS ---
        else if (req.url === '/api/worker/logs' && req.method === 'POST') {
            let body;
            try { body = JSON.parse(await parseBody(req)); } catch (e) { res.writeHead(400); return res.end(JSON.stringify({ error: 'Invalid JSON' })); }
            try {
                const logs = await getRpcWorkerLogs(workerFromBody(body));
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ logs }));
            } catch (err) {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                return res.end(JSON.stringify({ logs: `Failed to fetch logs: ${err.message}` }));
            }
        }

        // --- MASTER LOGS ---
        else if (req.url === '/api/master/logs' && req.method === 'GET') {
            // Serve from in-memory ring buffer instead of shelling out to docker compose logs,
            // which cannot see one-off run --rm containers (see dashboard-bugs1-analysis.md item 5)
            res.writeHead(200, { 'Content-Type': 'application/json' });
            const logs = masterLogBuffer.length > 0
                ? masterLogBuffer.join('\n')
                : 'No logs available. Start the server first.';
            return res.end(JSON.stringify({ logs }));
        }

        // --- 404 ---
        else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            return res.end(JSON.stringify({ error: 'Not found' }));
        }

    } catch (err) {
        console.error('Unhandled route error:', err);
        if (!res.headersSent) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Internal server error' }));
        }
    }
});

// --- SERVER INITIALIZATION ---
async function initServer() {
    await loadDashboardConfig();
    // NO PROBE AT STARTUP (2026-10-17, lib/gpusafety.js). The listings of the last run come back from
    // logs/device-cache.json; a build without one is probed on demand (a device table, a launch), under the one rule
    // of lib/deviceprobe.js: never while the queue has work on the cards, and otherwise only when nothing is on them.
    // Until 2026-10-17 every start probed each build it had no listing of -- and every build, when the queue database
    // read as idle -- and then ran `--help` per build; both initialise every backend on every card. The `--help` flag
    // cache now fills on the first /api/flags call that may read (buildSupportsFlag assumes a modern build meanwhile).
    try { deviceCache.seed(JSON.parse(await fs.readFile(DEVICE_CACHE_FILE, 'utf-8'))); } catch { /* first run, or unreadable: probed on demand */ }
    {
        const known = getLlamaServerBuilds().filter((b) => deviceCache.get(b.path)).length;
        console.log(`[startup] no device probe: ${known} of ${getLlamaServerBuilds().length} builds have a kept device list; the rest are probed on demand when the cards are free`);
    }
    await initLogsDir();
    // Bootstrap the shared profiles store from the CLI's legacy file (if the
    // store doesn't exist yet) BEFORE any client can read it.
    await initProfilesStore();
    // Ports 8080 (model server) and 8081 (monitor.py): an orphan of a previous dashboard would keep them and make the
    // next launch / monitor fail with EADDRINUSE. Only such an orphan is killed (lib/gpusafety.js portCleanupTargets):
    // a llama-server / Strata server on 8080, monitor.py on 8081, never anything in a queue runner's tree or a codebench
    // run. Until 2026-10-17 this was `fuser -k 8080/tcp`, spared only while /tmp/codebench-lldash.lock was held -- the
    // local-gpu lane's agent proxy listens on 127.0.0.1:8080 and was killed in the moments the lock was not held.
    for (const [port, allow] of [[8080, gpuSafety.MODEL_SERVER], [8081, gpuSafety.MONITOR]]) {
        try {
            const plan = await gpuSafety.cleanupPortSafely(port, allow);
            for (const pid of plan.kill) console.log(`[startup] port ${port}: stopped orphaned pid ${pid}`);
            for (const sp of plan.spare) console.log(`[startup] port ${port}: left pid ${sp.pid} alone (${sp.why})`);
        } catch (err) { console.warn(`[startup] port ${port} cleanup skipped: ${err.message}`); }
    }

    // Reload the tail of the bench transcript so a dashboard restart doesn't
    // present an empty Bench tab (the full history lives in the file).
    try {
        const benchHist = await fs.readFile(path.join(LOGS_DIR, 'bench-history.log'), 'utf-8');
        benchOutput = benchHist.split('\n').filter(l => l !== '').slice(-1500);
    } catch { /* no history yet */ }

    // No more startup recovery scan for a leftover `master-node` Docker
    // container here -- the master never launches in Docker anymore, so the
    // only thing that scan could ever find post-refactor is a stale container
    // from before this change. If you have one of those hanging around after
    // updating, tear it down manually: `docker compose -f
    // docker-compose.master.yml down`.

    // stdio must be 'ignore': the default pipes are never read here, so once
    // monitor.py printed 64KB (e.g. a stream of warnings) it would block on
    // write and its /stats endpoint would silently stall.
    pythonProcess = spawn('python3', ['monitor.py'], { cwd: __dirname, stdio: 'ignore' });
    // An unhandled 'error' event (python3 missing, spawn failure, ...) would
    // become an uncaughtException and take the whole dashboard down over a
    // missing monitor -- telemetry is best-effort, so log and move on.
    pythonProcess.on('error', (err) => {
        console.error('monitor.py spawn error:', err.message);
        pythonProcess = null;
    });
    pythonProcess.on('exit', () => {
        pythonProcess = null;
    });
    startTelemetryLoop();
    startExternalSlotsPoll();

    const shutdownHandler = async () => {
        // Directly-spawned processes -- must be killed explicitly or they're
        // orphaned on shutdown (no compose container to bring down instead).
        // Timers first, so nothing fires while the processes die.
        try { if (telemetryLoopTimer) clearInterval(telemetryLoopTimer); } catch { }
        try { if (externalSlotsTimer) clearTimeout(externalSlotsTimer); } catch { }
        try { requestSamplesStore.flush(); } catch { }   // the last FLUSH_MS of request series (a restart must not lose them)
        if (benchProcess) {
            try { benchProcess.kill(); } catch { }
        }
        if (llamaProcess) {
            try { llamaProcess.kill(); } catch { }
        }
        if (pythonProcess) {
            try { pythonProcess.kill(); } catch { }
        }
        if (tunnelProcess) {
            try { tunnelProcess.kill(); } catch { }
        }
        closeLoopbackBridge();
        process.exit(0);
    };

process.on('exit', () => {
    if (benchProcess) { try { benchProcess.kill(); } catch { } }
    if (pythonProcess) { try { pythonProcess.kill(); } catch { } }
});
process.on('SIGINT', shutdownHandler);
process.on('SIGTERM', shutdownHandler);

// Safety net for uncaught exceptions (Item 13, Step 5) — prevents silent
// crashes from taking down SSE, the models API, and Docker orchestration.
process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err?.stack || err);
    // Broadcast error state to connected SSE clients before shutting down
    try {
        serverState = 'stopped';
        broadcastState('', 'Server crash: ' + (err?.message || String(err)));
    } catch { /* broadcast may fail if clients array is corrupted */ }
    // Attempt graceful shutdown
    shutdownHandler();
});

// Catch rejected promises that bubble up (async handlers without try/catch)
process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason);
});

    // the public site follows this stamp: it restarts itself onto the lib/ code this process loaded (lib/codestamp.js)
    try { const rec = require('./lib/codestamp').writeStamp(); console.log(`[codestamp] lib ${rec.stamp}`); } catch (e) { console.error('[codestamp] could not write the stamp:', e.message); }
    server.listen(PORT, () => {
        console.log(`\n🚀 LL-Dash running at: http://localhost:${PORT}`);
        autoStartTunnel();
        // Pre-parse benchmarks.csv for the History chart (2026-10-01, Kyle): the one full parse is
        // ~220 ms of sync splitCsvLine on the 20 MB file; done here, off any request, the first
        // History open only reads the appended tail.
        setTimeout(() => { try { historyCsvIndex.refresh(); } catch { /* the route retries */ } }, 3000).unref();
        // And the Models catalog (2026-10-06): its first build reads the request log and every battery (~2 s after
        // a restart); done here, the first open of the Models tab answers from the buffer.
        setTimeout(() => { modelsCatalog.rebuild().catch((err) => console.warn('catalog warm-up failed:', err.message)); }, 5000).unref();
        // ... and kept current without anyone asking (2026-10-21): every 10 s, a background rebuild when a result landed
        // (or the request log moved over a minute ago), so an open of the Models tab is served the newest buffer at once.
        setInterval(() => { try { modelsCatalog.tick(); } catch (err) { console.warn('catalog tick failed:', err.message); } }, 10000).unref();
        // the strength bootstrap's timer: first look 3 min after the start, then every minute (a run at most every 30)
        strengthBoot.start();
    });
}

initServer().catch(err => {
    console.error('Failed to start server:', err);
    process.exit(1);
});
