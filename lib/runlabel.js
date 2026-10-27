'use strict';
// What is actually running, in words a person reads at a glance: "Qwen3.8-27B Q2_K_XL · 64k ctx ·
// KV q8_0 · RX 7900 XTX only · MTP on · opencode · L2". The battery label ("q2cq4-q8kv-xtx") and the
// opencode model id ("llama-local/q2max", a user alias in opencode.json) say nothing about the
// weights; the server provenance the harness records (harness/run.py server_provenance: model_path,
// n_ctx, launch_command read from the serving process's argv) says everything. Pure: the Live view
// (lib/codebench.js liveSnapshot) and its tests call it with plain objects.
//
// Absence of evidence is not "off": with no launch command, MTP / KV / devices are unknown and are
// reported as null, never as "MTP off" or "f16".

const { canonicalModel, parseFlags } = require('./models');
const { ctxLabel } = require('../ui/shared/ctxlabel.js');   // a context size in words: the one rule (2026-10-25)

// --- DEVICE NAMES ---
// A launch command names devices by llama.cpp id (-dev ROCm0,CUDA0); a person wants the card. No card is named in this
// file: a name comes from the evidence, in this order --
//   1. the record's own machine (harness/run.py machine_identity: `server.machine.gpus`; for a logged request, the
//      `machines` row its `machine_fp` points at). Per vendor in bus order: CUDA ids are that machine's NVIDIA cards,
//      ROCm ids its AMD cards. It also says how many identical cards that machine had, so "#2" is only written where
//      there was a second one.
//   2. the record's own device list (`server.device_names`: { id: card name }, a logged request's `devices_json` --
//      what the dashboard listed for that launch when the request ran). It names any id, Vulkan included, and it says
//      nothing about how many such cards there were: an id named this way is never numbered from this machine.
//   3. this machine's --list-devices (opts.detected), which also names Vulkan ids -- but only where it can speak for
//      the record: a record whose machine had other cards (other memory sizes, another count) is not described by
//      the cards that are here now, and a record made on ANOTHER machine (see below) never is.
//   4. `deviceNames` in dashboard.config.json: names for ids that recorded runs use but nothing above can name -- a
//      card that has since left the machine, or a process with no device list at all. Keyed by id ("CUDA0") or
//      backend ("CUDA"). They are THIS machine's names: they never name a card of another machine, and never an id
//      the record's machine had no card for (a CUDA id on a record whose machine lists no NVIDIA card).
//   5. nothing: the id itself ("Vulkan0 only"). Never a guess.
// Card names are shortened by lib/topology.js shortName ("RX 7900 XTX", "RTX 4090 Laptop").
//
// ANOTHER MACHINE (2026-10-13). `CUDA0` has meant the RTX 3060 on the desktop and the RTX 4090 on the laptop on the
// same day. A record is another machine's when it says so (`server.remote`: a codebench remote lane) or when its
// machine record carries a host that is not this one (os.hostname(); a logged request has no `remote`, only its
// machine). Such a record is named from sources 1 and 2 only, and its label says which machine it was:
// "laptop: RTX 4090 Laptop only", "laptop: RTX 4090 Laptop + RTX 3060 (split 2:1)". The machine's name is
// `machineNames` in dashboard.config.json ({ "<fingerprint, host or lane>": "<name>" }) when it has one, else the
// host the record carries, else the lane. A record with no machine information at all is read as before: as this
// machine's.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { shortName } = require('./topology');

const CONFIG_FILE = path.join(__dirname, '..', 'dashboard.config.json');
const thisHost = () => { try { return os.hostname() || null; } catch { return null; } };
let defaults = { detected: null, cardNames: null, machineNames: null, host: thisHost(), configFile: CONFIG_FILE };
let fileConfig;   // { deviceNames, machineNames } read from the config file: undefined = not read yet
/**
 * What every caller resolves with unless it passes its own opts. server4.js sets `detected` (its cached device lists;
 * it must not probe) and `cardNames` (its loaded deviceNames). A process that never calls this (the public site
 * builds its catalog in its own process) still reads `deviceNames` and `machineNames` from dashboard.config.json,
 * once, so the same record is named the same way everywhere. configFile: null turns that off (tests).
 * host: the name this machine's own records carry (default os.hostname()); tests pin it.
 */
function configure(o) {
    const c = o || {};
    defaults = { detected: c.detected || null, cardNames: c.cardNames || null, machineNames: c.machineNames || null,
        host: 'host' in c ? c.host : thisHost(), configFile: 'configFile' in c ? c.configFile : CONFIG_FILE };
    fileConfig = undefined;
}
const plainObject = (x) => (x && typeof x === 'object' && !Array.isArray(x) ? x : null);
function configFromFile() {
    if (fileConfig === undefined) {
        fileConfig = { deviceNames: null, machineNames: null };
        if (defaults.configFile) {
            try {
                const j = JSON.parse(fs.readFileSync(defaults.configFile, 'utf8'));
                fileConfig = { deviceNames: plainObject(j && j.deviceNames), machineNames: plainObject(j && j.machineNames) };
            } catch { /* no config file: ids stay ids */ }
        }
    }
    return fileConfig;
}
const configuredNames = () => defaults.cardNames || configFromFile().deviceNames;
const configuredMachineNames = () => defaults.machineNames || configFromFile().machineNames;

const sameHost = (a, b) => String(a).trim().toLowerCase() === String(b).trim().toLowerCase();
/**
 * Was this record made on another machine than the one reading it? ctx: { machine, remote, host }.
 * true: the record says so (`remote`), or its machine record names a host that is not this one. A record that
 * names no host (older runs, hand-built records) is this machine's as far as anyone can tell.
 */
function isForeign(ctx) {
    const c = ctx || {};
    if (c.remote) return true;
    const theirs = c.machine && typeof c.machine.host === 'string' ? c.machine.host.trim() : '';
    const mine = 'host' in c ? c.host : defaults.host;
    return !!(theirs && mine && !sameHost(theirs, mine));
}
/** The name a label gives another machine: configured (`machineNames`, by fingerprint, host or lane), the host its
 *  record carries (only a record that captured the hardware has a real one), the lane that served it. */
function machineName(machine, remote, names) {
    const m = machine || {};
    const n = names || configuredMachineNames() || {};
    const host = typeof m.host === 'string' ? m.host.trim() : '';
    const lane = remote && typeof remote.lane === 'string' ? remote.lane.trim() : '';
    const configured = (m.fingerprint && n[m.fingerprint]) || (host && n[host]) || (lane && n[lane]) || null;
    if (configured) return String(configured).trim();
    if (host && Array.isArray(m.gpus) && m.gpus.length) return host;
    return lane || host || 'another machine';
}

const VENDOR_OF_BACKEND = { cuda: 'nvidia', rocm: 'amd' };   // llama.cpp backends that reach one vendor's cards only
// sysfs/pci.ids names ("Advanced Micro Devices, Inc. [AMD/ATI] Device 744c (rev c8)") identify a chip, not a product
const isProductName = (n) => !!n && !/\[|\bDevice [0-9a-f]{4}\b/i.test(String(n));
const near = (a, b) => !a || !b || Math.abs(a - b) <= 0.03 * Math.max(a, b);
function cardFromDescription(desc) {
    const d = String(desc || '').trim();
    return d ? shortName(d) : null;
}
/**
 * One device id -> { id, name (short, or null), ordinal, count } from the evidence above.
 * ctx: { machine, named: { id: card name }, detected: [{ id, description, totalMib? }], cardNames, remote, host }.
 */
function resolveDevice(id, ctx) {
    const s = String(id || '').trim();
    const c = ctx || {};
    const out = { id: s, name: null, ordinal: null, count: null };
    if (/^RPC\d*/i.test(s)) return { ...out, name: 'remote' };
    const m = /^([A-Za-z]+?)(\d+)$/.exec(s);
    const backend = m ? m[1] : s, index = m ? Number(m[2]) : 0;
    const listed = c.machine && Array.isArray(c.machine.gpus) ? c.machine.gpus.filter((g) => g && g.vendor !== 'intel') : null;
    const gpus = listed && listed.length ? listed : null;   // an empty list is a machine whose hardware was not captured
    const vendor = VENDOR_OF_BACKEND[backend.toLowerCase()];
    const own = gpus && vendor ? gpus.filter((g) => g.vendor === vendor) : null;
    const g = own ? own[index] : null;
    const foreign = isForeign(c);
    if (g) {
        const twin = (x) => x.name === g.name && (x.vram_mib || null) === (g.vram_mib || null);
        out.count = own.filter(twin).length; out.ordinal = own.slice(0, index + 1).filter(twin).length;
        if (isProductName(g.name)) out.name = shortName(g.name);
    }
    // the record's own device list: what this id was called when the launch ran
    const said = c.named && typeof c.named === 'object' ? c.named[s] : null;
    const fromRecord = !out.name && typeof said === 'string' && isProductName(said) ? cardFromDescription(said) : null;
    if (fromRecord) out.name = fromRecord;
    // This machine's listing is not asked about another machine's record, nor about a record whose own device list
    // it contradicts: a launch that listed CUDA0 as an RTX 3060 was not made on a machine with no such device, so
    // that machine's ROCm0 is not "#1 of two" here either.
    const listing = !foreign && Array.isArray(c.detected) ? c.detected : null;
    const contradicted = !!(listing && c.named && typeof c.named === 'object' && Object.entries(c.named).some(([nid, nname]) => {
        if (typeof nname !== 'string' || !isProductName(nname) || /^RPC\d*/i.test(nid)) return false;
        const d = listing.find((x) => x && x.id === nid);
        return !d || cardFromDescription(d.description) !== cardFromDescription(nname);
    }));
    const detected = contradicted ? null : listing;
    const hit = detected ? detected.find((d) => d && d.id === s) : null;
    if (hit) {
        const sameBackend = detected.filter((d) => d && d.id.replace(/\d+$/, '') === backend);
        // May this machine's listing speak for the record's machine? With no record of that machine it is all there
        // is. With one: a vendor backend's id must be a card of that size there; a backend that reaches every vendor
        // (Vulkan) only when both machines have the same cards.
        let speaks = true;
        if (gpus && vendor) speaks = !!g && near(g.vram_mib, hit.totalMib);
        else if (gpus) {
            const mine = sameBackend.map((d) => d.totalMib || 0).sort((x, y) => x - y), theirs = gpus.map((x) => x.vram_mib || 0).sort((x, y) => x - y);
            speaks = mine.length === theirs.length && mine.every((v, i) => near(v, theirs[i]));
        }
        if (speaks) {
            if (!out.name) out.name = cardFromDescription(hit.description);
            // The listing also says whether the card has a twin -- for a record of a machine with these cards, or
            // for one with no record at all whose name is this listing's. Not for a bare name the record gave with
            // no machine behind it: how many such cards there are HERE is not that record's count.
            if (out.count == null && (gpus || !fromRecord)) {
                const twins = sameBackend.filter((d) => cardFromDescription(d.description) === cardFromDescription(hit.description));
                out.count = twins.length; out.ordinal = twins.indexOf(hit) + 1;
            }
        }
    }
    // configured names are this machine's: not for another machine's record, and not for an id the record's machine
    // had no card for (its list of that vendor's cards is shorter than the id asks for)
    if (!out.name && !foreign && !(own && !g)) {
        const names = c.cardNames || configuredNames();
        const n = names ? (names[s] || names[backend]) : null;
        if (n) out.name = cardFromDescription(n);
    }
    return out;
}
function deviceLabel(id, detected, ctx) {
    const s = String(id || '').trim();
    if (!s) return null;
    const r = resolveDevice(s, { ...(ctx || {}), detected: Array.isArray(detected) ? detected : (ctx && ctx.detected) || null });
    if (!r.name) return s;
    return r.count > 1 ? `${r.name} #${r.ordinal}` : r.name;
}
function devicesSummary(devArg, detected, ts, hasRpc, ctx) {
    const ids = String(devArg || '').replace(/^['"]|['"]$/g, '').split(',').map((x) => x.trim()).filter(Boolean);
    if (!ids.length) return hasRpc ? { ids: [], names: ['remote'], label: 'with RPC (devices not pinned)' } : null;
    const each = ids.map((id) => deviceLabel(id, detected, ctx)).filter(Boolean);
    const names = [...new Set(each)];
    // "2x RX 7900 XTX" when the launch spans several of one card (two ids are two cards even where nothing says
    // which is which); otherwise the cards in -dev order, which is the layer order
    const base = each.map((n) => n.replace(/ #\d+$/, ''));
    let label = each.length === 1 ? `${each[0]} only`
        : (base.every((b) => b === base[0]) ? `${each.length}x ${base[0]}` : names.join(' + '));
    if (each.length > 1 && ts) label += ` (split ${String(ts).replace(/^['"]|['"]$/g, '').replace(/,/g, ':')})`;
    return { ids, names, label };
}

/**
 * One label for a launch config whose requests carry different evidence (lib/models.js prefillCurve groups requests
 * by launch command; the same command has run on the desktop before and after its second card, and its older
 * requests carry no machine record at all). list: [{ label, n, recorded }] -- `recorded`: the label rests on the
 * record's own machine or device list, not on this machine's names.
 *   one label                                   -> it
 *   recorded labels agree                       -> theirs (an unrecorded request of the same launch does not outvote
 *                                                  a record)
 *   they differ only in which twin ("#1", "#2") -> the label without the number: the launch ran on one such card,
 *                                                  and on a machine where that card had no twin
 *   they name different cards                   -> each, most requests first, joined with " / ": the same command
 *                                                  ran on different hardware, and the label says so
 */
function mergeDeviceLabels(list) {
    const tally = (items) => {
        const m = new Map();
        for (const x of items) if (x && x.label) m.set(x.label, (m.get(x.label) || 0) + (Number(x.n) || 0));
        return [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([label]) => label);
    };
    const all = (list || []).filter((x) => x && x.label);
    if (!all.length) return null;
    const recorded = all.filter((x) => x.recorded);
    const pool = recorded.length ? recorded : all;
    const labels = tally(pool);
    if (labels.length === 1) return labels[0];
    const bare = tally(pool.map((x) => ({ ...x, label: x.label.replace(/ #\d+(?= |,|$)/g, '') })));
    return bare.length === 1 ? bare[0] : labels.join(' / ');
}

function describeRun(config, server, opts) {
    const c = config || {}, s = server || {};
    const o = opts || {};
    const cmd = s.launch_command || null;
    const f = cmd ? parseFlags(cmd) : null;
    const modelPath = s.model_path || (f && f.modelPath) || null;
    const canon = modelPath ? canonicalModel(modelPath)
        : (c.model || c.runner ? canonicalModel({ model: c.model || null, runner: c.runner || null }) : null);
    const model = canon && !canon.unresolved ? { display: canon.display, key: canon.key, family: canon.family || null, quant: canon.quant || null }
        : (canon ? { display: canon.display || null, key: canon.key || null, family: null, quant: null, unresolved: true } : null);
    const ctx = Number(s.n_ctx) || (f && f.ctx) || null;
    let kv = null, mtp = null, spec = null, devices = null, moe = null;
    // what the record itself says about its hardware: its machine, and what it listed for each device id
    const rctx = { machine: s.machine || null, named: s.device_names || null, remote: s.remote || null, cardNames: o.cardNames || null };
    if ('host' in o) rctx.host = o.host;
    const foreign = isForeign(rctx);
    if (f) {
        const k = f.kvK || 'f16', v = f.kvV || 'f16';
        kv = k === v ? k : `${k}/${v}`;
        mtp = f.specType === 'draft-mtp';
        if (f.specType && !mtp) spec = f.specType + (f.draftModel ? ` (${String(f.draftModel).split('/').pop()})` : '');
        else if (!f.specType && f.draftModel) spec = `draft ${String(f.draftModel).split('/').pop()}`;
        // This machine's listing is asked only where the record itself leaves an id's name open -- or its count, for a
        // record that has a machine to compare this one with (a Vulkan id: named by the record's device list,
        // numbered only if that machine had these very cards) -- and never for a server that ran on another machine.
        // (server4.js's resolver answers from its cache; it does not probe.)
        const devArg = f.devices || s.devices;
        const hasCards = !!(s.machine && Array.isArray(s.machine.gpus) && s.machine.gpus.length);
        const open = !foreign && String(devArg || '').split(',').map((x) => x.replace(/['"]/g, '').trim()).filter((id) => id && !/^RPC/i.test(id))
            .some((id) => { const r = resolveDevice(id, { ...rctx, cardNames: {} }); return !r.name || (r.count == null && hasCards); });
        const resolver = o.detected !== undefined ? o.detected : defaults.detected;
        const detected = !open ? null : (typeof resolver === 'function' ? resolver(f.binary) : resolver);
        devices = devicesSummary(devArg, detected, f.ts, /(^|\s)--rpc\s/.test(cmd), rctx);
        moe = f.ncmoe || null;
    } else if (s.devices) {
        const resolver = o.detected !== undefined ? o.detected : defaults.detected;
        devices = devicesSummary(s.devices, foreign || typeof resolver === 'function' ? null : resolver, null, false, rctx);
    }
    // A server on ANOTHER machine (a codebench remote lane, 2026-10-06: harness/run.py records server.remote and that
    // machine's own identity; a logged request carries the machine alone). Its CUDA0 is not a card of this machine:
    // the ids were named from the machine the row recorded (above), and the label says which machine that was.
    if (foreign && devices) {
        const where = machineName(s.machine, s.remote, o.machineNames);
        devices = { ...devices, machine: where, label: `${where}: ${devices.label}` };
    }
    if (moe) devices = { ...(devices || { ids: [], names: [] }), label: `${devices ? devices.label + ', ' : ''}${moe} MoE layers on CPU` };
    const [level, ...variantBits] = String(c.prompt_level || '').split('+');
    const runnerModel = c.model ? String(c.model).replace(/^llama-local\//, '') : null;
    const harness = c.runner ? `${c.runner}${c.scaffold ? ` (${c.scaffold})` : ''}` : null;
    const local = !!(s.model_path || cmd);
    const bits = [];
    if (model && model.display) bits.push(model.display);
    if (ctx) bits.push(`${ctxLabel(ctx)} ctx`);
    if (kv) bits.push(`KV ${kv}`);
    if (devices) bits.push(devices.label);
    if (mtp != null) bits.push(mtp ? 'MTP on' : (spec ? `spec ${spec}` : 'MTP off'));
    if (harness) bits.push(harness);
    if (level) bits.push(level + (variantBits.length ? `+${variantBits.join('+')}` : ''));
    return {
        model, ctx, kv, mtp, spec, devices,
        harness, runner: c.runner || null, scaffold: c.scaffold || null, effort: c.effort || null,
        runnerModel, promptLevel: level || null, variant: variantBits.length ? variantBits.join('+') : null,
        local,
        // a Strata run has no llama-server command: its settings are in its config file (2026-10-20, Live card said
        // "launch flags not recorded" for every running Strata battery)
        engine: /^strata\b/i.test(String(s.build_info || '')) ? String(s.build_info) : null,
        // where the facts came from, so the UI can say "not recorded" rather than guess
        source: cmd ? (s.launch_command_source || 'launch_command') : (s.model_path ? 'model_path' : (canon ? 'runner model id' : null)),
        launchCommand: cmd,
        line: bits.join(' · ') || null,
    };
}

module.exports = { describeRun, deviceLabel, devicesSummary, mergeDeviceLabels, cardFromDescription, resolveDevice, isForeign, machineName, configure };
