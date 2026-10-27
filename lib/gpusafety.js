'use strict';
// --- WHAT A DASHBOARD RESTART MAY DO TO THE GPUS AND TO THE QUEUE (2026-10-17) ---
// Kyle: "it seems like a mistake that the dashboard can't be restarted while a strata run happens. sounds like we
// should do some code separation here." The queue's engines (Strata, llama-server) are children of
// codebench/tools/queue_runner.py, its own pm2 process; pm2 restarting `dashboard` only takes down the dashboard's
// own tree (monitor.py, a server launched FROM the dashboard). What reached the queue's work from a restart was:
//
//   1. the boot device probes: `llama-server --list-devices` per configured build, then `--help` per build -- each
//      one initialises CUDA / ROCm / Vulkan on every card (what stalled the two-card Strata engine on 2026-10-12).
//      Since 2026-10-13 a restart "with something on the cards" skipped the builds it had a listing of, but it still
//      probed every build it had none of, and it decided "something on the cards" from the queue database alone
//      (an unreadable database read as "free") and from telemetry that does not exist yet at boot.
//   2. `fuser -k 8080/tcp` at boot: the local-gpu lane's record proxy listens on 127.0.0.1:8080 (the agent's model
//      endpoint). It was spared only while /tmp/codebench-lldash.lock was held; between the proxy coming up and
//      run.py taking the lock, or after run.py let go, a restart killed it.
//   3. "probe now" (`GET /api/devices?refresh=1`, `/api/flags?refresh=1`) probed whatever was running.
//
// Now: startup runs no probe and no `--help` at all (listings come from logs/device-cache.json; a build without one
// is probed on demand, under the rule below). A probe is REFUSED -- refresh or not -- while any of the hard signals
// says the queue has work on this machine's cards (`hardBusy`), and the soft rule (telemetry, the dashboard's own
// server) applies on top unless refreshed. The boot port cleanup kills only an orphaned model server / monitor
// (`portCleanupTargets`): never a process inside a queue runner's tree or a codebench run.
//
// Pure functions + two small readers (procs from lib/laneprocs.js, listeners from `ss`). Tested in
// test/gpusafety.test.js.
const { execFile } = require('child_process');
const laneProcs = require('./laneprocs');

const LOCAL_LANE = /^local\b/;
// Anything of the benchmark: a lane's runner, a battery's run.py, the agent proxy, the lock wrapper.
const QUEUE_PROC = /(^|[\s/])(queue_runner\.py|record-proxy\.js)(\s|$)|codebench\/harness\/run\.py|codebench-[\w.-]*\.lock/;

/**
 * The local lanes whose queue runner has work under it right now, from the process table: a runner process with at
 * least one descendant (an idle runner has none -- it sleeps between polls). [{ lane, pids }].
 * Independent of the queue database: a lane that is loading its engine before it marks the item running counts too.
 */
function localQueueWork(procs) {
    const trees = laneProcs.laneTrees(procs || []);
    const out = [];
    for (const [lane, pids] of trees) {
        if (!LOCAL_LANE.test(lane)) continue;
        const work = pids.slice(1);   // laneTrees lists the runner itself first
        if (work.length) out.push({ lane, pids: work });
    }
    return out.sort((a, b) => a.lane.localeCompare(b.lane));
}

/**
 * Why NO probe may run now, not even an explicit "probe now" -- or null. The hard signals, any one enough:
 *   runningItems  running queue items (queue database); a `local*` lane is this machine's cards
 *   queueWork     localQueueWork(): a local lane's runner has processes under it
 *   lockHeld      a codebench battery holds /tmp/codebench-lldash.lock (it serves the model on 8080)
 *   queueUnread   the queue database could not be read: not knowing is not "free"
 */
function hardBusyReason({ runningItems = [], queueWork = [], lockHeld = false, queueUnread = false } = {}) {
    const local = (runningItems || []).filter((it) => it && LOCAL_LANE.test(String(it.lane || '')));
    if (local.length) return `queue item ${local.map((it) => it.id).join(', ')} is running on ${local.length > 1 ? 'local lanes' : 'lane ' + local[0].lane}`;
    const work = (queueWork || []).filter((w) => w && LOCAL_LANE.test(String(w.lane || '')));
    if (work.length) return `the ${work.map((w) => w.lane).join(', ')} queue runner${work.length > 1 ? 's have' : ' has'} work running`;
    if (lockHeld) return 'a benchmark battery holds the model server';
    if (queueUnread) return 'the queue state could not be read';
    return null;
}

/** Ancestors of `pid` (nearest first), from procs [{pid, ppid, cmd}]. Stops at 1, at a loop or at an unknown pid. */
function ancestry(pid, procs) {
    const by = new Map((procs || []).map((p) => [p.pid, p]));
    const out = [], seen = new Set([pid]);
    let cur = by.get(pid);
    while (cur && cur.ppid > 1 && !seen.has(cur.ppid)) {
        seen.add(cur.ppid);
        const up = by.get(cur.ppid);
        if (!up) break;
        out.push(up); cur = up;
    }
    return out;
}

/**
 * Which listeners on a port the boot cleanup may kill: { kill: [pid], spare: [{ pid, why }] }.
 *   allow    RegExp a process's command line must match to be killable at all (8080: a llama-server or a Strata
 *            server; 8081: monitor.py)
 *   selfPid  this process (never)
 * A listener is spared when its command does not match `allow`, or when it or any ancestor is benchmark work
 * (QUEUE_PROC: a queue runner's tree, a codebench run, the agent proxy). What is killed is what the old dashboard left
 * behind; the queue's proxy on 8080 is a node process and never matches.
 */
function portCleanupTargets({ listenerPids = [], procs = [], allow, selfPid = process.pid } = {}) {
    const by = new Map((procs || []).map((p) => [p.pid, p]));
    const kill = [], spare = [];
    for (const pid of [...new Set(listenerPids)]) {
        const p = by.get(pid);
        if (!p) { spare.push({ pid, why: 'not in the process table' }); continue; }
        if (pid === selfPid) { spare.push({ pid, why: 'this process' }); continue; }
        if (QUEUE_PROC.test(p.cmd)) { spare.push({ pid, why: 'benchmark work' }); continue; }
        const q = ancestry(pid, procs).find((a) => QUEUE_PROC.test(a.cmd));
        if (q) { spare.push({ pid, why: `under ${q.cmd.split(' ').slice(0, 2).join(' ')} (pid ${q.pid})` }); continue; }
        if (!(allow instanceof RegExp) || !allow.test(p.cmd)) { spare.push({ pid, why: 'not a process this dashboard starts' }); continue; }
        kill.push(pid);
    }
    return { kill, spare };
}

// What the dashboard itself puts on its ports: a llama-server build, a Strata launch (queue-serve.sh -> server.py), monitor.py.
const MODEL_SERVER = /(^|[\s/])llama-server(\s|$)|(^|[\s/])queue-serve\.sh(\s|$)|serve\/server\.py\b.*--engine\s+strata/;
const MONITOR = /(^|[\s/])monitor\.py(\s|$)/;

/** -> Promise<number[]>: pids listening on TCP `port` (any address), via `ss`. [] when `ss` fails. */
function listenersOn(port) {
    return new Promise((resolve) => {
        execFile('ss', ['-ltnpH'], { timeout: 3000 }, (err, stdout) => {
            if (err) return resolve([]);
            const out = [];
            for (const [pid, ports] of laneProcs.parseSs(stdout)) if (ports.has(Number(port))) out.push(pid);
            resolve(out);
        });
    });
}

/**
 * The boot cleanup of one port: kills (SIGTERM) only what portCleanupTargets allows; returns the decision for the log.
 * `deps` for tests: { listeners(port), procs(), kill(pid) }.
 */
async function cleanupPortSafely(port, allow, deps = {}) {
    const listeners = deps.listeners || listenersOn;
    const procs = deps.procs || laneProcs.readProcs;
    const kill = deps.kill || ((pid) => process.kill(pid, 'SIGTERM'));
    const pids = await listeners(port);
    if (!pids.length) return { kill: [], spare: [] };
    let table = [];
    try { table = procs(); } catch { table = []; }
    const plan = portCleanupTargets({ listenerPids: pids, procs: table, allow, selfPid: deps.selfPid ?? process.pid });
    for (const pid of plan.kill) { try { kill(pid); } catch { /* gone */ } }
    return plan;
}

module.exports = { localQueueWork, hardBusyReason, ancestry, portCleanupTargets, cleanupPortSafely, listenersOn, MODEL_SERVER, MONITOR, QUEUE_PROC };
