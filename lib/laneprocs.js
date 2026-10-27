// Where a queue lane's engine actually listens (2026-10-01). A lane's runtime_json names the port its
// `run` items use (server_port), but a `shell` item is an arbitrary script -- the Strata needle sweep serves
// on :18089 -- so the lane looked idle while the XTX was flat out. The truth is in the process table: every
// port held by a descendant of that lane's `queue_runner.py --lane <lane>` belongs to the lane's work.
//
// The same process tree also says which CARD a lane is on (2026-10-01, Kyle: the local-gpu lane was labelled
// "gpu"): AMD processes list their DRM device and VRAM in /proc/<pid>/fdinfo, NVIDIA's appear in
// `nvidia-smi --query-compute-apps`. A lane's GPUs are the PCI buses its processes hold VRAM on.
//
// parse* are pure (tested); laneSnapshot() reads /proc, `ss` and nvidia-smi and is cached by the caller.
const fs = require('fs');
const { execFile } = require('child_process');

/** `ss -ltnpH` text -> Map<pid, Set<port>> (listening TCP, any address). */
function parseSs(text) {
    const out = new Map();
    for (const line of String(text || '').split('\n')) {
        const m = /\s(\S+):(\d+)\s+\S+\s+users:\((.*)\)\s*$/.exec(line);
        if (!m) continue;
        const port = Number(m[2]);
        for (const pm of m[3].matchAll(/pid=(\d+)/g)) {
            const pid = Number(pm[1]);
            if (!out.has(pid)) out.set(pid, new Set());
            out.get(pid).add(port);
        }
    }
    return out;
}

/** procs [{pid, ppid, cmd}] -> Map<lane, pid[]> of every descendant (inclusive) of each lane's queue runner. */
function laneTrees(procs) {
    const kids = new Map();
    for (const p of procs) { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p.pid); }
    const out = new Map();
    for (const p of procs) {
        const m = /^\S*python\S*\s+\S*queue_runner\.py\b.*\s--lane[ =]([\w.-]+)/.exec(p.cmd);
        if (!m) continue;
        const seen = [], stack = [p.pid];
        while (stack.length) { const x = stack.pop(); seen.push(x); for (const k of kids.get(x) || []) stack.push(k); }
        out.set(m[1], seen);
    }
    return out;
}

function readProcs() {
    const procs = [];
    for (const d of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(d)) continue;
        try {
            const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
            const ppid = Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
            const cmd = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').replace(/\0/g, ' ');
            procs.push({ pid: Number(d), ppid, cmd });
        } catch { /* exited meanwhile */ }
    }
    return procs;
}

/** -> Promise<Map<lane, number[]>>: the TCP ports each lane's process tree is listening on. */
function lanePorts() {
    return new Promise((resolve) => {
        execFile('ss', ['-ltnpH'], { timeout: 3000 }, (err, stdout) => {
            if (err) return resolve(new Map());
            let trees;
            try { trees = laneTrees(readProcs()); } catch { return resolve(new Map()); }
            const byPid = parseSs(stdout);
            const out = new Map();
            for (const [lane, pids] of trees) {
                const ports = new Set();
                for (const pid of pids) for (const port of byPid.get(pid) || []) ports.add(port);
                out.set(lane, [...ports].sort((a, b) => a - b));
            }
            resolve(out);
        });
    });
}

/** A DRM fdinfo file -> { bus: 'bb:dd.f', vramKiB } or null (not a GPU fd / no VRAM). */
function parseFdinfo(text) {
    const pdev = /drm-pdev:\s*(?:[0-9a-f]{4}:)?([0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f])/i.exec(text || '');
    if (!pdev) return null;
    const vram = /drm-(?:memory|total)-vram:\s*(\d+)\s*KiB/i.exec(text);
    const kib = vram ? Number(vram[1]) : 0;
    return kib > 0 ? { bus: pdev[1].toLowerCase(), vramKiB: kib } : null;
}
/** `nvidia-smi --query-compute-apps=pid,gpu_bus_id,used_memory --format=csv,noheader` -> Map<pid, [{bus, vramKiB}]>. */
function parseNvApps(text) {
    const out = new Map();
    for (const line of String(text || '').split('\n')) {
        const m = /^\s*(\d+)\s*,\s*(?:[0-9a-f]{4,8}:)?([0-9a-f]{2}:[0-9a-f]{2}\.[0-9a-f])\s*(?:,\s*(\d+)\s*MiB)?/i.exec(line);
        if (!m) continue;
        const pid = Number(m[1]);
        if (!out.has(pid)) out.set(pid, []);
        out.get(pid).push({ bus: m[2].toLowerCase(), vramKiB: m[3] ? Number(m[3]) * 1024 : 0 });
    }
    return out;
}
// A card counts for a lane only past this much VRAM: a multi-backend llama-server (CUDA+ROCm+Vulkan) opens every
// card it can see and holds a few KiB on each -- the 3060's server showed 40 KiB on the XTX beside 11 GB on the 3060.
const MIN_LANE_VRAM_KIB = 256 * 1024;
/** Map<bus, KiB> -> the buses a lane is really on (>= MIN_LANE_VRAM_KIB; else the single largest, if any). */
function pickBuses(perBus) {
    const real = [...perBus].filter(([, k]) => k >= MIN_LANE_VRAM_KIB).map(([b]) => b);
    if (real.length) return real.sort();
    const top = [...perBus].sort((a, b) => b[1] - a[1])[0];
    return top && top[1] > 0 ? [top[0]] : [];
}
function amdBuses(pid) {
    const buses = new Map();   // bus -> KiB
    let fds = [];
    try { fds = fs.readdirSync(`/proc/${pid}/fdinfo`); } catch { return buses; }
    for (const fd of fds) {
        let t = '';
        try { t = fs.readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8'); } catch { continue; }
        if (!t.includes('drm-pdev')) continue;
        const r = parseFdinfo(t);
        if (r) buses.set(r.bus, (buses.get(r.bus) || 0) + r.vramKiB);
    }
    return buses;
}
const run = (cmd, args) => new Promise((resolve) => execFile(cmd, args, { timeout: 3000 }, (err, stdout) => resolve(err ? '' : stdout)));
// Is an NVIDIA GPU installed? From sysfs, never nvidia-smi: with no card, every nvidia-smi call makes the kernel
// module load, fail and log "NVRM: No NVIDIA GPU found" (2026-10-06, the 3060 out of the machine). Cached 30 s.
let nvSeen = { at: 0, has: false };
function hasNvidiaGpu() {
    if (Date.now() - nvSeen.at < 30000) return nvSeen.has;
    let has = false;
    try {
        for (const d of fs.readdirSync('/sys/bus/pci/devices')) {
            try {
                if (fs.readFileSync(`/sys/bus/pci/devices/${d}/vendor`, 'utf8').trim() === '0x10de'
                    && fs.readFileSync(`/sys/bus/pci/devices/${d}/class`, 'utf8').trim().startsWith('0x03')) { has = true; break; }
            } catch { /* device went away */ }
        }
    } catch { /* no sysfs */ }
    nvSeen = { at: Date.now(), has };
    return has;
}

/** -> Promise<{ ports: Map<lane, number[]>, gpus: Map<lane, string[]> }> (gpus = PCI buses, 'bb:dd.f'). */
async function laneSnapshot() {
    const [ssOut, nvOut] = await Promise.all([run('ss', ['-ltnpH']), hasNvidiaGpu() ? run('nvidia-smi', ['--query-compute-apps=pid,gpu_bus_id,used_memory', '--format=csv,noheader']) : '']);
    let trees;
    try { trees = laneTrees(readProcs()); } catch { return { ports: new Map(), gpus: new Map() }; }
    const byPid = parseSs(ssOut), nv = parseNvApps(nvOut);
    const ports = new Map(), gpus = new Map();
    for (const [lane, pids] of trees) {
        const ps = new Set(), perBus = new Map();
        const add = (bus, kib) => perBus.set(bus, (perBus.get(bus) || 0) + kib);
        for (const pid of pids) {
            for (const port of byPid.get(pid) || []) ps.add(port);
            for (const g of nv.get(pid) || []) add(g.bus, g.vramKiB);
            for (const [b, kib] of amdBuses(pid)) add(b, kib);
        }
        ports.set(lane, [...ps].sort((a, b) => a - b));
        gpus.set(lane, pickBuses(perBus));
    }
    return { ports, gpus };
}

module.exports = { parseSs, laneTrees, readProcs, lanePorts, parseFdinfo, parseNvApps, pickBuses, laneSnapshot };   // readProcs: also lib/gpusafety.js (2026-10-17)
