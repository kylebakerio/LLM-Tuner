'use strict';
// --- MACHINE TOPOLOGY (2026-10-12) ---
// One description of the hardware this dashboard is running on, and the questions every launcher asks of it. Nothing in
// here (or in a caller) may name a particular card: the dashboard has run on an RX 7900 XTX + RTX 3060, then on two
// RX 7900 XTX, and is meant to run on machines it has never seen.
//
//   build({ detected, hostRamMib, workers })           -> topology
//   cardOfId(topology, 'Vulkan1')                      -> the physical card that id reaches, or null
//   cardKeysOf(topology, ['ROCm0', 'Vulkan1'])         -> Set of card keys (launch guard: do two launches share a card?)
//   resolveDevices(devices, topology)                  -> a profile's device list re-pointed at this machine's cards
//   availability(config, topology)                     -> can this saved profile run here, and if not, what does it need
//   placementLabel(devices, topology)                  -> "RX 7900 XTX #2 alone", "2x RX 7900 XTX, 1:1", ...
//   launchDevices(devices, topology, { reference })    -> { devices, warnings, idMap }: resolveDevices for a launch
//   launchGate(config, topology, { reference })        -> null, or why /api/start refuses this launch on this machine
//   laneCards(lane, runtime, topology)                 -> which of this machine's cards a queue lane sits on, in words
//
// PHYSICAL CARDS. llama.cpp lists a card once per backend (ROCm1 and Vulkan1 are the same card in a ROCm+Vulkan
// build). lib/devices.js physicalCards() groups those by card name; identical cards are paired BY ORDER within each
// backend. That pairing is an assumption (nothing in --list-devices says which Vulkan id is which ROCm id), so such
// cards carry `orderAssumed: true` and the UI should say so where it matters. A card's key is its name plus its
// ordinal among identical cards ("amd radeon rx 7900 xtx#2"): stable across backends and across restarts, and it
// tells two identical cards apart, which the card NAME alone (the old launch guard, reconcileDeviceIds) cannot.
//
// Pure (no I/O). Unit-tested in test/topology.test.js with one-card, two-identical, mixed-vendor, CPU-only and
// RPC-worker fixtures.

const { gpuKey, physicalCards } = require('./devices');

/** "AMD Radeon RX 7900 XTX (RADV NAVI31)" -> "RX 7900 XTX"; "NVIDIA GeForce RTX 4090 Laptop GPU" -> "RTX 4090 Laptop". */
function shortName(name) {
    return String(name || '').replace(/\(.*?\)/g, ' ')
        .replace(/\b(AMD|NVIDIA|Intel\(R\)|Intel|Advanced Micro Devices,? Inc\.?|Corporation)\b/gi, ' ')
        .replace(/\b(Radeon|GeForce|Graphics|GPU)\b/gi, ' ')
        .replace(/\s+/g, ' ').trim() || String(name || '').trim();
}

const backendOf = (id) => String(id || '').replace(/\d+$/, '');
const isRemoteId = (id) => /^RPC\d*$/i.test(String(id || ''));

/**
 * detected: [{ id, description, totalMib, freeMib }] from `llama-server --list-devices` (server4.js probeDevices, kept by lib/deviceprobe.js).
 * workers: [{ name, ... }] configured RPC workers (other machines' cards; they are never "this machine's" cards).
 */
function build({ detected = [], hostRamMib = null, workers = [] } = {}) {
    const raw = physicalCards(detected);
    const counts = new Map();
    for (const c of raw) counts.set(gpuKey(c.name), (counts.get(gpuKey(c.name)) || 0) + 1);
    const seen = new Map();
    const cards = raw.map((c) => {
        const k = gpuKey(c.name);
        const ordinal = (seen.get(k) || 0) + 1; seen.set(k, ordinal);
        const count = counts.get(k);
        const short = shortName(c.name);
        return {
            key: `${k}#${ordinal}`,
            name: c.name, short, label: count > 1 ? `${short} #${ordinal}` : short,
            vendor: c.vendor, ordinal, count,
            vramMib: Math.max(0, ...c.backends.map((b) => b.totalMib || 0)),
            ids: c.backends.map((b) => b.id), preferredId: c.preferredId,
            orderAssumed: count > 1 && c.backends.length > 1,
        };
    });
    const groups = [...counts.entries()].map(([k, n]) => {
        const c = cards.find((x) => gpuKey(x.name) === k);
        return `${n > 1 ? n + 'x ' : ''}${c.short} ${Math.round(c.vramMib / 1024)}G`;
    });
    const ram = Number.isFinite(hostRamMib) && hostRamMib > 0 ? Math.round(hostRamMib) : null;
    return {
        cards, hostRamMib: ram,
        workers: (workers || []).map((w) => (typeof w === 'string' ? { name: w } : w)).filter((w) => w && w.name),
        signature: [groups.length ? groups.join(' + ') : 'no GPU', ram ? `${Math.round(ram / 1024)}G RAM` : null].filter(Boolean).join(' | '),
    };
}

function cardOfId(topology, id) {
    const want = String(id || '').trim();
    return ((topology && topology.cards) || []).find((c) => c.ids.includes(want)) || null;
}

/** Card keys a list of device ids touches. An id this machine does not have keeps its own name as the key (`id:CUDA0`). */
function cardKeysOf(topology, ids) {
    const out = new Set();
    for (const id of ids || []) {
        if (!id || isRemoteId(id) || id === 'none') continue;
        const c = cardOfId(topology, id);
        out.add(c ? c.key : `id:${id}`);
    }
    return out;
}

/** The id that reaches `card` through the same backend as `like` (ROCm0 -> ROCm1), else the card's preferred id. */
function idOn(card, like) {
    const b = backendOf(like);
    return card.ids.find((x) => backendOf(x) === b) || card.preferredId;
}

/**
 * Re-point a saved device list at this machine. devices: [{ id, name?, vramMib?, share? } | { worker }].
 * Per local device, in order:  the card it names, under its own id        -> kept
 *                              the same card model under another id        -> 'moved'
 *                              no such card, but a free one at least as big -> 'substitute' (never validated here)
 *                              nothing fits                                 -> 'unavailable'
 * A card is handed out once, so "two RX 7900 XTX" needs two of them. Returns { status, devices, cards, kinds, notes,
 * missing } (`cards`: the card key each device landed on, null where it did not; `kinds`: how each got there --
 * 'kept' | 'moved' | 'byId' | 'substitute' | null). opts.reference: see sameCardAs below.
 *
 * A BARE ID (a device saved with no card name: a hand-written profile, an old one, `-dev ROCm1` typed into a form)
 * that this build does not list says nothing about which card it meant -- except through the machine's fullest
 * listing (opts.reference): if ROCm1 is the second of two identical cards there, and this build reaches that same
 * card as Vulkan1, the device moves to Vulkan1 ('byId', status 'moved'). That is the only fallback: with no
 * reference, an id the reference does not know, or that card already taken, the device is 'unavailable'. It is never
 * placed by its number (ROCm1 is not "the second device of whatever this build has") and never on the first free
 * card, because a wrong guess there puts a model on the card another launch is using.
 */
function resolveDevices(devices, topology, opts = {}) {
    const cards = (topology && topology.cards) || [];
    // Which of several identical cards a saved id means, when this build cannot say: ROCm1 is not an id in a
    // Vulkan-only build, but the machine's fullest listing (`opts.reference`, another build's topology) knows it is
    // the second of the two, so it moves to this build's id for the SECOND card, not to the first free one.
    const ref = opts.reference && opts.reference !== topology ? opts.reference : null;
    const sameCardAs = (d, free) => {
        const home = ref ? cardOfId(ref, d.id) : null;
        return (home && free.find((c) => c.key === home.key)) || free[0] || null;
    };
    const taken = new Set();
    const notes = [], missing = [];
    let status = 'ready';
    const rank = { ready: 0, moved: 1, substitute: 2, unavailable: 3 };
    const worse = (s) => { if (rank[s] > rank[status]) status = s; };
    const want = (devices || []).map((d) => ({ ...d }));
    // Pass 1: devices whose id already reaches the card they name keep it, so a later device cannot take it first.
    const out = want.map((d) => {
        if (d.worker || d.rpcEndpoint || isRemoteId(d.id)) return d;
        const cur = cardOfId(topology, d.id);
        if (cur && !taken.has(cur.key) && (!d.name || gpuKey(cur.name) === gpuKey(d.name))) { taken.add(cur.key); return { ...d, _card: cur, _kind: 'kept' }; }
        return d;
    });
    for (let i = 0; i < out.length; i++) {
        const d = out[i];
        if (d._card) continue;
        if (d.worker || d.rpcEndpoint || isRemoteId(d.id)) {
            if (d.worker && !(topology.workers || []).some((w) => w.name === d.worker)) { worse('unavailable'); missing.push(`RPC worker "${d.worker}"`); }
            continue;
        }
        const nameKey = d.name ? gpuKey(d.name) : null;
        const same = nameKey ? sameCardAs(d, cards.filter((c) => gpuKey(c.name) === nameKey && !taken.has(c.key))) : null;
        if (same) {
            taken.add(same.key); worse('moved');
            const id = idOn(same, d.id);
            notes.push(`${shortName(d.name)}: ${d.id} is now ${id}`);
            out[i] = { ...d, id, _card: same, _kind: 'moved' };
            continue;
        }
        // a bare id this build does not list: the card the machine's fullest listing says it is, and only that card
        const home = !nameKey && ref && !cardOfId(topology, d.id) ? cardOfId(ref, d.id) : null;
        const here = home ? cards.find((c) => c.key === home.key && !taken.has(c.key)) : null;
        if (here) {
            taken.add(here.key); worse('moved');
            const id = idOn(here, d.id);
            notes.push(`${d.id} is ${here.label} on this machine, which this build reaches as ${id}${home.orderAssumed || here.orderAssumed ? ' (identical cards paired by listing order)' : ''}`);
            out[i] = { ...d, id, _card: here, _kind: 'byId' };
            continue;
        }
        const need = Number(d.vramMib) || 0;
        const sub = need > 0 ? cards.filter((c) => !taken.has(c.key) && c.vramMib >= need * 0.97).sort((a, b) => a.vramMib - b.vramMib)[0] : null;
        if (sub) {
            taken.add(sub.key); worse('substitute');
            const id = idOn(sub, d.id);
            notes.push(`${d.name ? shortName(d.name) : d.id} is not in this machine; ${sub.label} (${Math.round(sub.vramMib / 1024)} GB) stands in`);
            out[i] = { ...d, id, name: sub.name, vramMib: sub.vramMib, _card: sub, _kind: 'substitute' };
            continue;
        }
        worse('unavailable');
        missing.push(d.name ? `${shortName(d.name)}${need ? ` (${Math.round(need / 1024)} GB)` : ''}` : `device ${d.id}`);
    }
    return { status, devices: out.map(({ _card, _kind, ...d }) => d), cards: out.map((d) => (d._card ? d._card.key : null)), kinds: out.map((d) => d._kind || null), notes, missing };
}

function shellIds(text) {
    const ids = [];
    for (const m of String(text || '').matchAll(/(?:^|\s)(?:-dev|--device|-devd|--device-draft)\s+(\S+)/g)) ids.push(...m[1].split(','));
    for (const m of String(text || '').matchAll(/=((?:ROCm|CUDA|Vulkan|SYCL|Metal|RPC)\d+)/g)) ids.push(m[1]);
    return [...new Set(ids.map((s) => s.replace(/['"]/g, '').trim()).filter((s) => s && s !== 'none'))];
}

/**
 * Can this saved profile run on this machine?  config: a profile's config (lib/devices.js device list, or a raw
 * command, or an engine with its own launcher). Optional `config.needs`: { hostRamMib, minCards, minVramMib, vendor }.
 * -> { status: 'ready' | 'moved' | 'substitute' | 'unavailable', reason, devices, placement }
 */
function availability(config, topology, opts = {}) {
    const cfg = config || {};
    const needs = cfg.needs || {};
    const problems = [];
    let status = 'ready', devices = null, notes = [];
    if (needs.hostRamMib && topology.hostRamMib && topology.hostRamMib < needs.hostRamMib) {
        problems.push(`${Math.round(needs.hostRamMib / 1024)} GB of memory (this machine has ${Math.round(topology.hostRamMib / 1024)})`);
    }
    if (needs.minCards || needs.minVramMib || needs.vendor) {
        const fit = topology.cards.filter((c) => (!needs.vendor || c.vendor === needs.vendor) && (!needs.minVramMib || c.vramMib >= needs.minVramMib * 0.97));
        const n = needs.minCards || 1;
        if (fit.length < n) {
            problems.push(`${n > 1 ? n + ' ' : (needs.vendor ? 'an ' : 'a ')}${needs.vendor ? needs.vendor.toUpperCase() + ' ' : ''}card${n > 1 ? 's' : ''}${needs.minVramMib ? ` with ${Math.ceil(needs.minVramMib / 1024)} GB` : ''}`);
        }
    }
    const raw = (cfg.launchMode === 'raw' || (!Array.isArray(cfg.devices) || !cfg.devices.length)) && (cfg.rawCommand || cfg.argString);
    if (Array.isArray(cfg.devices) && cfg.devices.length && cfg.launchMode !== 'raw') {
        const r = resolveDevices(cfg.devices, topology, opts);
        status = r.status; devices = r.devices; notes = r.notes;
        for (const m of r.missing) problems.push(m);
        // extra arguments can pin tensors to a device by id (-ot '...=CUDA0'): those ids have to exist here too
        const absent = shellIds(cfg.argString).filter((id) => !isRemoteId(id) && !cardOfId(topology, id));
        if (absent.length && !problems.length) problems.push(`device${absent.length > 1 ? 's' : ''} ${absent.join(', ')} (named in its extra arguments)`);
    } else if (raw) {
        const absent = shellIds(raw).filter((id) => !isRemoteId(id) && !cardOfId(topology, id));
        if (absent.length) problems.push(`device${absent.length > 1 ? 's' : ''} ${absent.join(', ')} (named in its command)`);
    }
    if (problems.length) return { status: 'unavailable', reason: 'Needs ' + problems.join(' and ') + '.', devices, placement: null };
    const reason = status === 'substitute' ? notes.join('; ') + '. Not validated on this machine.' : status === 'moved' ? notes.join('; ') + '.' : '';
    return { status, reason, devices, placement: devices ? placementLabel(devices, topology) : null };
}

/**
 * The gate POST /api/start applies (2026-10-13): may this launch start on this machine? `config` is the launch as
 * sent -- the raw command when it carries one (that text is what runs), else the saved device list and extra
 * arguments -- plus optional `needs`. -> null (go ahead) | { status: 'unavailable', reason }.
 * Only `unavailable` stops a launch: `moved` and `substitute` are launched re-pointed, with their warnings, as
 * before. With no card known (the device probe has not answered, or this is a CPU-only machine) nothing is claimed
 * and nothing is refused -- the same rule as launchDevices: llama-server then reports what it cannot find.
 */
function launchGate(config, topology, opts = {}) {
    if (!topology || !Array.isArray(topology.cards) || !topology.cards.length) return null;
    const cfg = config || {};
    const raw = typeof cfg.rawCommand === 'string' && cfg.rawCommand.trim() ? cfg.rawCommand : null;
    const a = availability(raw ? { launchMode: 'raw', rawCommand: raw, needs: cfg.needs } : { devices: cfg.devices, argString: cfg.argString, needs: cfg.needs }, topology, opts);
    return a.status === 'unavailable' ? { status: 'unavailable', reason: a.reason } : null;
}

/** A short human name for where a launch sits: "RX 7900 XTX #2 alone", "2x RX 7900 XTX, 1:1", "RTX 4090 Laptop + RTX 3060, 2:1". */
function placementLabel(devices, topology) {
    const parts = [];
    for (const d of devices || []) {
        if (d.worker) { parts.push({ label: `${d.worker} (RPC)`, share: d.share }); continue; }
        const c = cardOfId(topology, d.id);
        parts.push({ label: c ? c.label : (d.name ? shortName(d.name) : d.id), short: c ? c.short : null, share: d.share });
    }
    if (!parts.length) return 'CPU only';
    if (parts.length === 1) return `${parts[0].label} alone`;
    const shares = parts.map((p) => Number(p.share) || 0);
    const g = shares.reduce((a, b) => { while (b) [a, b] = [b, a % b]; return a; }, 0) || 1;
    const ratio = shares.every((s) => s > 0) ? ', ' + shares.map((s) => Math.round(s / g)).join(':') : '';
    const allSame = parts.every((p) => p.short && p.short === parts[0].short);
    return (allSame ? `${parts.length}x ${parts[0].short}` : parts.map((p) => p.label).join(' + ')) + ratio;
}

/**
 * resolveDevices for a launch (server4.js planLaunchDevices): the device list that will actually run, what to tell the
 * user about it, and which ids changed (so --spec-draft-device can follow its card).
 * A device this machine cannot place keeps its id and gets a warning: the launch then fails in llama-server with its
 * own message, as it always did, instead of silently running somewhere else. With no cards known (the device probe
 * has not answered, or failed) nothing is touched and nothing is claimed.
 * -> { status, devices, warnings: [string], idMap: { <saved id>: <id used> } }
 */
function launchDevices(devices, topology, opts = {}) {
    const list = (devices || []).map((d) => ({ ...d }));
    if (!topology || !Array.isArray(topology.cards) || !topology.cards.length) return { status: 'ready', devices: list, warnings: [], idMap: {} };
    const r = resolveDevices(list, topology, opts);
    const warnings = [];
    const idMap = {};
    r.devices.forEach((d, i) => {
        const was = list[i];
        if (was.worker || was.rpcEndpoint || isRemoteId(was.id)) return;
        if (r.cards[i]) {
            if (d.id === was.id) return;
            idMap[was.id] = d.id;
            const card = topology.cards.find((c) => c.key === r.cards[i]);
            // a bare id followed to its card through the machine's fullest listing (resolveDevices 'byId')
            if (r.kinds[i] === 'byId') {
                const home = opts.reference ? cardOfId(opts.reference, was.id) : null;
                warnings.push(`${was.id} is ${card.label} on this machine; this build reaches it as ${d.id}; using ${d.id}${card.orderAssumed || (home && home.orderAssumed) ? ' (identical cards paired by listing order)' : ''}`);
                return;
            }
            warnings.push(was.name && gpuKey(was.name) === gpuKey(d.name)
                ? `${card.label} moved from ${was.id} to ${d.id}; using ${d.id}`
                : `${was.name ? shortName(was.name) : was.id} is not in this machine; using ${card.label} (${d.id}) instead -- not validated here`);
            return;
        }
        const cur = cardOfId(topology, was.id);
        warnings.push(cur && was.name ? `${was.id} is now ${cur.label}, not ${shortName(was.name)}`
            : was.name ? `${shortName(was.name)} (${was.id}) is not in this machine`
            : `${was.id} is not a device in this build`);
    });
    return { status: r.status, devices: r.devices, warnings, idMap };
}

/**
 * The cards a codebench queue lane sits on, for the lane widgets. runtime: queue_lanes.runtime_json ({ devices?: [id],
 * gpu?: "<card name>" }). A lane's device list holds llama.cpp ids when the lane serves on this machine. The queue's
 * own convention says which lanes those are: `local-*` lanes run here (lib/launchguard.js relies on the same), any
 * other lane with a card is another machine's (`remote`: its device names are not ids here, its card is the `gpu`
 * its runner published). A local lane that lists no device takes whatever its items ask for: every card here.
 * -> { label, here, remote, cards: [card key] }   here: true = on cards this machine has, false = on cards it lacks,
 *                                                  null = the lane says nothing about where it runs
 */
function laneCards(lane, runtime, topology) {
    const rt = runtime && typeof runtime === 'object' ? runtime : {};
    const cards = (topology && topology.cards) || [];
    const ids = (Array.isArray(rt.devices) ? rt.devices : []).map(String).filter(Boolean);
    const gpu = typeof rt.gpu === 'string' && rt.gpu.trim() ? rt.gpu.trim() : null;
    const local = /^local\b/.test(String(lane || ''));
    const on = (list) => ({ label: placementLabel(list.map((c) => ({ id: c.preferredId })), topology).replace(/ alone$/, ''), here: true, remote: false, cards: list.map((c) => c.key) });
    const elsewhere = (label) => ({ label, here: false, remote: !local, cards: [] });
    if (ids.length) {
        const hit = ids.map((id) => cardOfId(topology, id));
        // every id is a card here and (when the lane names its card) it is that card model
        if (hit.every(Boolean) && (!gpu || hit.some((c) => gpuKey(c.name) === gpuKey(gpu)))) return on([...new Map(hit.map((c) => [c.key, c])).values()]);
        return elsewhere(gpu ? shortName(gpu) : ids.join(' + '));
    }
    if (gpu) {
        const own = cards.filter((c) => gpuKey(c.name) === gpuKey(gpu));
        return own.length && local ? on(own) : elsewhere(shortName(gpu));
    }
    // nothing published but a serving port: the lane that runs whatever device list each item asks for
    if (Object.keys(rt).length && local) return cards.length ? on(cards) : { label: 'no GPU', here: false, remote: false, cards: [] };
    return { label: null, here: null, remote: false, cards: [] };
}

module.exports = { build, shortName, cardOfId, cardKeysOf, resolveDevices, availability, launchGate, placementLabel, shellIds, backendOf, launchDevices, laneCards };
