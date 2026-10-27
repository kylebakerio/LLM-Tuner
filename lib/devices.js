'use strict';
// --- LAUNCH DEVICE MODEL ---
// A launch runs on an ORDERED list of compute devices:
//
//   devices: [ { id: 'Vulkan1', name: 'AMD Radeon RX 7900 XTX', share: 50 },
//              { worker: 'laptop', share: 30 },           // an RPC worker
//              { id: 'CUDA0', name: 'NVIDIA GeForce RTX 3060', share: 20 } ]
//
// List order is -dev order is -ts order (layer split hands layers out in that
// order). Local devices carry the llama.cpp id plus the card's name, so a
// profile survives device ids shifting when a card is added or removed (see
// reconcileDeviceIds). Worker devices name an rpcWorkers entry; their RPC<n>
// ids are assigned here from --rpc order, never stored.
//
// Pure (no I/O): server4.js supplies worker config, endpoints and detected
// devices. Unit-tested in test/devices.test.js.

// RPC worker: a bare `ggml-rpc-server` binary on a remote host, started and
// stopped over SSH. dashboard.config.json `rpcWorkers: { <name>: {...} }`
// overrides these per field; `ssh` defaults to the name, so a worker called
// "laptop" uses the ~/.ssh/config alias "laptop".
const DEFAULT_WORKER = {
    ssh: '',
    port: 50052,
    binary: '~/llama-rpc/ggml-rpc-server',
    devices: '',                               // rpc-server -d list; empty = all non-CPU devices
    logFile: '~/llama-rpc/rpc-server.log',
    // rpc-server -c: the worker keeps every tensor over 10 MB in its own
    // ~/.cache/llama.cpp/rpc, and later loads of the same model send only
    // hashes -- a warm cache means weights never cross the network again.
    cache: true,
    // How llama-server reaches the worker. 'ssh': rpc-server listens only on
    // the worker's 127.0.0.1 and RPC rides an `ssh -L` forward the dashboard
    // manages, so the unauthenticated RPC port is never on a network, and it
    // works over any path `ssh <target>` does (LAN, Tailscale, a Cloudflare
    // ProxyCommand). 'direct': rpc-server listens on 0.0.0.0 and --rpc dials
    // host:port -- trusted LAN only, no SSH encryption overhead.
    link: 'ssh',
    localPort: 50052,                          // this machine's end of the ssh forward; unique per worker
};

const WORKER_NAME_RE = /^[A-Za-z0-9_.-]{1,40}$/;
const SSH_TARGET_RE = /^([a-zA-Z0-9._-]+@)?[a-zA-Z0-9][a-zA-Z0-9.-]*$/;
// Backend-prefixed llama.cpp device ids (CUDA0, Vulkan1, ROCm0, ...). RPC ids
// are excluded on purpose: they're derived from workers.
const LOCAL_DEVICE_ID_RE = /^(?!RPC\d)[A-Za-z]+\d+$/;

function str(v) {
    if (v === null || v === undefined) return undefined;
    const s = String(v).trim();
    return s.length > 0 ? s : undefined;
}

function num(v) {
    if (v === null || v === undefined || typeof v === 'boolean') return undefined;
    if (typeof v === 'string' && v.trim() === '') return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
}

function isPort(n) {
    return n !== undefined && Number.isInteger(n) && n >= 1 && n <= 65535;
}

// --- WORKERS ---

// `rpcWorkers` map, or the pre-multi-worker single `rpcWorker` block (loaded
// as a worker named "worker").
function workersFromConfig(parsed) {
    const out = {};
    if (parsed && parsed.rpcWorkers && typeof parsed.rpcWorkers === 'object' && !Array.isArray(parsed.rpcWorkers)) {
        for (const [name, w] of Object.entries(parsed.rpcWorkers)) {
            if (WORKER_NAME_RE.test(name) && w && typeof w === 'object') out[name] = { ...DEFAULT_WORKER, ...w };
        }
    } else if (parsed && parsed.rpcWorker && typeof parsed.rpcWorker === 'object') {
        out.worker = { ...DEFAULT_WORKER, ...parsed.rpcWorker };
    }
    return out;
}

// Validated worker settings. The binary/log paths and device list are
// interpolated into a shell line run on the worker over SSH, so they're
// restricted to plain path/name characters (a leading ~ expands remotely).
function validateWorker(name, raw) {
    const w = { ...DEFAULT_WORKER, ...(raw || {}) };
    const where = `rpcWorkers.${name}`;
    const safePath = /^[A-Za-z0-9_.\/~-]+$/;
    if (!safePath.test(String(w.binary)) || !safePath.test(String(w.logFile))) {
        throw new Error(`${where}.binary and .logFile must be plain paths`);
    }
    const port = num(w.port);
    if (!isPort(port)) throw new Error(`${where}.port must be an integer between 1 and 65535`);
    const localPort = num(w.localPort);
    if (!isPort(localPort)) throw new Error(`${where}.localPort must be an integer between 1 and 65535`);
    const devices = str(w.devices) || '';
    if (devices && !/^[A-Za-z0-9_,-]+$/.test(devices)) {
        throw new Error(`${where}.devices must be a comma-separated device list`);
    }
    const ssh = str(w.ssh) || name;
    if (!SSH_TARGET_RE.test(ssh)) throw new Error(`${where}.ssh must be user@host or an ssh alias`);
    const link = w.link === 'direct' ? 'direct' : 'ssh';
    return {
        name, ssh, port, localPort, devices, link,
        binary: w.binary, logFile: w.logFile, cache: w.cache !== false,
        bindHost: link === 'ssh' ? '127.0.0.1' : '0.0.0.0',
        // pgrep -x matches the kernel's 15-char process name.
        procName: String(w.binary).split('/').pop().slice(0, 15),
        // Devices this worker exposes, so RPC ids after it are numbered right.
        // An unpinned worker is assumed to serve one (pin it: rpc-server
        // otherwise serves every non-CPU device, iGPUs included).
        deviceCount: devices ? devices.split(',').length : 1,
    };
}

// A device's `worker` names a configured worker, or is an ssh target used
// ad hoc (old profiles stored rpcTarget as "laptop" or "user@host").
function findWorker(workers, ref) {
    if (workers && Object.prototype.hasOwnProperty.call(workers, ref)) return validateWorker(ref, workers[ref]);
    for (const [name, w] of Object.entries(workers || {})) {
        if (str(w.ssh) === ref) return validateWorker(name, w);
    }
    if (SSH_TARGET_RE.test(ref)) return validateWorker(ref.replace(/[^A-Za-z0-9_.-]/g, '_'), { ssh: ref });
    return null;
}

// --- DEVICE LISTS ---

function sanitizeDevices(list) {
    if (!Array.isArray(list)) return [];
    const out = [];
    for (const d of list) {
        if (!d || typeof d !== 'object') continue;
        const worker = str(d.worker);
        const id = str(d.id);
        const entry = {};
        if (worker) {
            entry.worker = worker;
            const wd = num(d.workerDevice);
            if (wd !== undefined && Number.isInteger(wd) && wd > 0) entry.workerDevice = wd;
        } else if (id && LOCAL_DEVICE_ID_RE.test(id)) {
            entry.id = id;
            const name = str(d.name);
            if (name) entry.name = name;
            // The card's memory when the profile was saved: lets lib/topology.js offer a card at least as
            // big when this card model is not in the machine the profile is opened on.
            const vram = num(d.vramMib);
            if (vram !== undefined && vram > 0) entry.vramMib = Math.round(vram);
        } else {
            continue;
        }
        const share = num(d.share);
        if (share !== undefined && share >= 0) entry.share = share;
        if (d.enabled === false) entry.enabled = false;
        out.push(entry);
    }
    return out;
}

// Pre-device-list configs: deviceA / deviceB / rpcTarget / tensorSplit (a
// 0-99 share for A, the rest to B or the worker).
function legacyToDevices(cfg) {
    const a = str(cfg.deviceA);
    const b = str(cfg.deviceB);
    const rpc = str(cfg.rpcTarget);
    const ts = num(cfg.tensorSplit);
    const split = ts !== undefined && ts >= 0 && ts < 100 ? ts : undefined;
    const second = b && b !== a ? { id: b } : (rpc ? { worker: rpc } : null);
    const devices = [];
    if (a) devices.push(second && split !== undefined ? { id: a, share: split } : { id: a });
    if (second) devices.push(a && split !== undefined ? { ...second, share: 100 - split } : second);
    return sanitizeDevices(devices);
}

// The device list a config means: `devices` when present (even empty = let
// llama-server pick), else converted from the legacy fields.
function configDevices(cfg) {
    if (!cfg || typeof cfg !== 'object') return [];
    return Array.isArray(cfg.devices) ? sanitizeDevices(cfg.devices) : legacyToDevices(cfg);
}

// Enabled devices with ids assigned (RPC<n> in --rpc order) and the workers
// they need. Throws on unknown workers, duplicate devices, clashing ports.
function planDevices(cfg, workers) {
    const used = [];
    const devices = [];
    let nextRpc = 0;
    for (const d of configDevices(cfg).filter((x) => x.enabled !== false)) {
        if (!d.worker) {
            devices.push(d);
            continue;
        }
        let u = used.find((x) => x.ref === d.worker);
        if (!u) {
            const w = findWorker(workers, d.worker);
            if (!w) throw new Error(`Unknown RPC worker "${d.worker}"`);
            u = { ref: d.worker, worker: w, rpcBase: nextRpc };
            used.push(u);
            nextRpc += w.deviceCount;
        }
        const idx = d.workerDevice || 0;
        if (idx >= u.worker.deviceCount) {
            throw new Error(`RPC worker "${u.worker.name}" serves ${u.worker.deviceCount} device(s); it has no device #${idx}`);
        }
        devices.push({ ...d, id: `RPC${u.rpcBase + idx}` });
    }
    const seen = new Set();
    for (const d of devices) {
        if (seen.has(d.id)) throw new Error(`Device ${d.id} is listed twice`);
        seen.add(d.id);
    }
    const ports = new Map();
    for (const u of used) {
        if (u.worker.link !== 'ssh') continue;
        const other = ports.get(u.worker.localPort);
        if (other) throw new Error(`RPC workers "${other}" and "${u.worker.name}" both use localPort ${u.worker.localPort}`);
        ports.set(u.worker.localPort, u.worker.name);
    }
    return { devices, workers: used.map((u) => ({ ref: u.ref, ...u.worker, rpcBase: u.rpcBase })) };
}

// --- SPLIT MODE ---
// How llama.cpp divides a model over more than one device (--split-mode / -sm). `layer` (whole layers per device, the
// default here and in llama.cpp) and `tensor` (experimental: single tensors placed across devices) are offered.
// `row` is deprecated upstream and fails at load; `none` means one device and is what a one-device launch already is.
// A config says it in `splitMode`, or -- every profile saved before the field existed -- as `-sm tensor` in its extra
// arguments, which llama-server reads last and therefore wins.
const SPLIT_MODES = ['layer', 'tensor'];
const SPLIT_MODE_ROW = 'Split mode "row" is deprecated in llama.cpp and fails to load: use layer or tensor.';
function splitModeOf(cfg) {
    const c = cfg || {};
    const tokens = String(c.argString || '').match(/'[^']*'|"[^"]*"|\S+/g) || [];
    let extra = null;
    for (let i = 0; i < tokens.length - 1; i++) if (tokens[i] === '-sm' || tokens[i] === '--split-mode') extra = tokens[i + 1].replace(/^['"]|['"]$/g, '').toLowerCase();
    const field = str(c.splitMode) ? String(c.splitMode).toLowerCase() : null;
    const mode = extra || field || 'layer';
    return {
        mode,
        source: extra ? 'extra' : field ? 'field' : 'default',
        // the field says one thing and the extra arguments another: the extra arguments are what llama-server obeys
        overridden: !!(extra && field && extra !== field),
        problem: mode === 'row' ? SPLIT_MODE_ROW : (SPLIT_MODES.includes(mode) || mode === 'none' ? null : `Unknown split mode "${mode}": use layer or tensor.`),
    };
}

// llama-server flags for a plan. `endpointFor(worker)` gives what --rpc dials.
// --rpc must precede -dev: RPC devices only exist once --rpc is parsed.
// opts.splitMode: 'tensor' for a tensor split; anything else is the layer split every launch had before the field.
function deviceArgs(plan, endpointFor, opts = {}) {
    const args = [];
    if (plan.devices.length === 0) return args;
    if (plan.workers.length > 0) args.push('--rpc', plan.workers.map(endpointFor).join(','));
    if (plan.devices.length > 1) args.push('--split-mode', opts.splitMode === 'tensor' ? 'tensor' : 'layer');
    args.push('-dev', plan.devices.map((d) => d.id).join(','));
    if (plan.devices.length > 1) {
        const shares = plan.devices.map((d) => d.share);
        if (shares.every((s) => s !== undefined) && shares.some((s) => s > 0)) args.push('-ts', shares.join(','));
    }
    return args;
}

// Legacy fields derived from a plan, for readers that haven't moved to
// `devices` yet (old web UI restore, telemetry routing, CSV RPC column).
function devicesToLegacy(plan) {
    const local = plan.devices.filter((d) => !d.worker);
    const remote = plan.devices.find((d) => d.worker);
    const w = remote && plan.workers.find((x) => x.ref === remote.worker);
    let tensorSplit = null;
    if (plan.devices.length > 1) {
        const shares = plan.devices.map((d) => d.share);
        const total = shares.reduce((s, x) => s + (x || 0), 0);
        if (shares.every((s) => s !== undefined) && total > 0) tensorSplit = Math.round((shares[0] / total) * 100);
    }
    return {
        deviceA: local[0] ? local[0].id : null,
        deviceB: local[1] ? local[1].id : null,
        rpcTarget: w ? w.ssh : null,
        tensorSplit,
    };
}

function lastFlagValue(args, names) {
    let value;
    for (let i = 0; i < args.length - 1; i++) {
        if (names.includes(args[i])) value = args[i + 1];
    }
    return value;
}

// The device list a raw command actually uses (-dev / -ts / --rpc), so a
// hand-edited launch is recorded as what ran. Workers are recognized by the
// endpoint they'd be dialed at; unknown endpoints stay as bare RPC entries.
function devicesFromArgs(args, workers, endpointFor) {
    const dev = lastFlagValue(args, ['-dev', '--device']);
    if (!dev || dev === 'none') return null;
    const shares = (lastFlagValue(args, ['-ts', '--tensor-split']) || '').split(/[,/]/).filter(Boolean).map(Number);
    const rpcIds = new Map();
    let next = 0;
    for (const ep of (lastFlagValue(args, ['--rpc']) || '').split(',').filter(Boolean)) {
        let owner = null;
        for (const name of Object.keys(workers || {})) {
            try {
                const w = validateWorker(name, workers[name]);
                if (endpointFor(w) === ep) { owner = w; break; }
            } catch { /* invalid worker config: can't be the owner */ }
        }
        const count = owner ? owner.deviceCount : 1;
        for (let k = 0; k < count; k++) {
            rpcIds.set(`RPC${next + k}`, owner ? { worker: owner.name, ...(k > 0 ? { workerDevice: k } : {}) } : { id: `RPC${next + k}`, rpcEndpoint: ep });
        }
        next += count;
    }
    return dev.split(',').map((id, i) => {
        const entry = /^RPC\d+$/.test(id) ? { ...(rpcIds.get(id) || { id }) } : { id };
        if (Number.isFinite(shares[i])) entry.share = shares[i];
        return entry;
    });
}

// --- DETECTED DEVICES ---

// Card identity for matching across backends and tools: the CUDA and Vulkan
// listings, nvidia-smi and amdgpu_top name the same card slightly differently
// ("AMD Radeon RX 7900 XTX (RADV NAVI31)" vs "AMD Radeon RX 7900 XTX").
function gpuKey(name) {
    return String(name || '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim();
}

// Profiles store each local device's card name; when the id now points at a
// different card (a card was added/removed and ids shifted), re-point it at
// the same card under the same backend, or warn when that's ambiguous.
function reconcileDeviceIds(devices, detected) {
    const warnings = [];
    if (!Array.isArray(detected) || detected.length === 0) return { devices, warnings };
    const byId = new Map(detected.map((d) => [d.id, d]));
    const out = devices.map((d) => {
        if (d.worker || d.rpcEndpoint) return d;
        const cur = byId.get(d.id);
        if (!d.name) {
            if (!cur) warnings.push(`${d.id} is not a device in this build`);
            return d;
        }
        if (cur && gpuKey(cur.description) === gpuKey(d.name)) return d;
        const backend = d.id.replace(/\d+$/, '');
        const matches = detected.filter((x) => x.id.replace(/\d+$/, '') === backend && gpuKey(x.description) === gpuKey(d.name));
        if (matches.length === 1) {
            warnings.push(`${d.name} moved from ${d.id} to ${matches[0].id}; using ${matches[0].id}`);
            return { ...d, id: matches[0].id };
        }
        const now = cur ? `is now ${cur.description}` : 'is not a device in this build';
        warnings.push(`${d.id} ${now}, not ${d.name}${matches.length > 1 ? ' (several identical cards: choose the device again)' : ''}`);
        return d;
    });
    return { devices: out, warnings };
}

// One entry per physical card, with every backend id it's reachable through
// (the CUDA+Vulkan build lists an NVIDIA card as both CUDA0 and Vulkan0).
// Identical cards can't be told apart by name: their ids are paired by order
// within each backend and the cards are flagged `ambiguous`.
function physicalCards(detected) {
    const groups = new Map();
    for (const d of detected || []) {
        if (/^RPC\d+$/.test(d.id)) continue;
        const key = gpuKey(d.description);
        if (!groups.has(key)) groups.set(key, new Map());
        const backend = d.id.replace(/\d+$/, '');
        const byBackend = groups.get(key);
        if (!byBackend.has(backend)) byBackend.set(backend, []);
        byBackend.get(backend).push(d);
    }
    const cards = [];
    for (const byBackend of groups.values()) {
        const count = Math.max(...[...byBackend.values()].map((list) => list.length));
        for (let k = 0; k < count; k++) {
            const backends = [];
            for (const list of byBackend.values()) if (list[k]) backends.push(list[k]);
            const name = backends[0].description.replace(/\s*\(.*?\)\s*/g, ' ').trim();
            const nvidia = /nvidia/i.test(name);
            // CUDA for NVIDIA (faster prefill in the Aug 2026 bench), ROCm
            // then Vulkan otherwise.
            const preferred = backends.find((b) => (nvidia ? /^CUDA/ : /^ROCm/).test(b.id))
                || backends.find((b) => /^Vulkan/.test(b.id)) || backends[0];
            cards.push({
                name,
                vendor: nvidia ? 'nvidia' : (/amd|radeon/i.test(name) ? 'amd' : 'other'),
                backends: backends.map(({ id, totalMib, freeMib }) => ({ id, totalMib, freeMib })),
                preferredId: preferred.id,
                ambiguous: count > 1,
            });
        }
    }
    return cards;
}

module.exports = {
    DEFAULT_WORKER, SSH_TARGET_RE,
    workersFromConfig, validateWorker, findWorker,
    sanitizeDevices, legacyToDevices, configDevices, planDevices, deviceArgs, devicesToLegacy,
    SPLIT_MODES, splitModeOf,
    devicesFromArgs, gpuKey, reconcileDeviceIds, physicalCards,
};
