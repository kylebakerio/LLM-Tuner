// Launch guard (2026-10-10; topology-driven since 2026-10-12). The dashboard's own launch (/api/start: web UI and
// dash-cli) and the codebench queue share this machine's GPUs, and nothing told a launch that a queue item was already
// on its card: starting the daily model in the middle of a 12-hour battery would take its VRAM (or just fail to bind
// its port). This module answers one question, with no I/O: which RUNNING queue items sit on a card this launch needs?
// /api/preview-command reports them (`busy`) and /api/start refuses with 409 CARD_BUSY unless `force` is set.
//
// Cards are PHYSICAL cards from lib/topology.js, not device ids and not card models: the same card is ROCm1 in one
// backend and Vulkan1 in another, and two identical cards are two cards (until 2026-10-12 this file keyed on the model
// name, so a second RX 7900 XTX looked like the first). No topology (the device probe failed) = ids compared as text.

const topo = require('./topology');

function flagValues(tokens, names) {
    const out = [];
    for (let i = 0; i < tokens.length - 1; i++) if (names.includes(tokens[i])) out.push(tokens[i + 1]);
    return out;
}
const tokensOf = (cmd) => String(cmd || '').match(/'[^']*'|"[^"]*"|\S+/g) || [];
const splitIds = (list) => list.join(',').split(',').map((s) => s.replace(/['"]/g, '').trim()).filter(Boolean);
const allCards = (topology) => ((topology && topology.cards) || []).map((c) => c.key);
const cardLabel = (topology, key) => { const c = ((topology && topology.cards) || []).find((x) => x.key === key); return c ? c.label : key.replace(/^id:/, ''); };

/**
 * Card keys a launch needs. `devices` is the planned device list ({id, name} / {worker}) when the caller has one;
 * otherwise the command's -dev / --device list. A llama-server command with no device list uses every card
 * (llama.cpp's default). An engine with its own launcher (Strata) takes the cards its `--gpu` list names, by position,
 * else the first card. RPC devices are another machine: no local card.
 */
function neededCards({ command = '', args = [], devices = null, topology = null } = {}) {
    const argv = args.map(String);
    // A planned device list wins: the server reads a Strata config's own `gpu` list into it (strataPlanDevices).
    const planned = Array.isArray(devices) && devices.some((d) => d && (typeof d === 'string' || d.id));
    if (!planned && /queue-serve\.sh|strata/i.test(String(command))) {
        const cards = (topology && topology.cards) || [];
        const gpus = splitIds(flagValues(argv, ['--gpu'])).map(Number).filter((n) => Number.isInteger(n) && n >= 0);
        if (!cards.length) return (gpus.length ? gpus : [0]).map((n) => `index:${n}`);
        return [...new Set((gpus.length ? gpus : [0]).map((n) => (cards[n] ? cards[n].key : `index:${n}`)))];
    }
    let ids;
    if (Array.isArray(devices) && devices.length) {
        ids = devices.filter((d) => !(d && (d.worker || d.rpc || d.rpcEndpoint))).map((d) => (typeof d === 'string' ? d : (d && d.id) || '')).filter(Boolean);
        if (!ids.length) return [];
    } else {
        ids = splitIds(flagValues(argv, ['-dev', '--device']));
        if (ids.includes('none')) return [];
        if (!ids.length) return allCards(topology);
    }
    return [...topo.cardKeysOf(topology, ids)];
}

/**
 * Running queue items -> [{lane, device, card, cardKey, itemId, label}], one entry per card an item holds.
 * item: {id, lane, label, launch_cmd, env_json}; runtimes: queue_lanes.runtime_json by lane (its `devices`).
 * An item's devices: env CODEBENCH_DEVICES, else its own -dev list, else its lane's device list. A local lane's item
 * that names no device at all holds every card (the queue runner gates it the same way). Another machine's lane
 * holds none of this machine's cards: its device names are not ids here.
 */
function busyCards(items, runtimes = {}, topology = null) {
    const out = [];
    for (const it of items || []) {
        if (!it || !it.lane) continue;
        let env = {};
        try { env = JSON.parse(it.env_json || '{}') || {}; } catch { env = {}; }
        let ids = String(env.CODEBENCH_DEVICES || '').split(',').map((s) => s.trim()).filter(Boolean);
        if (!ids.length) ids = splitIds(flagValues(tokensOf(it.launch_cmd), ['-dev', '--device']));
        if (!ids.length) ids = ((runtimes[it.lane] && runtimes[it.lane].devices) || []).map(String);
        let pairs;
        if (ids.length) pairs = ids.filter((id) => id !== 'none').map((id) => [id, [...topo.cardKeysOf(topology, [id])][0]]).filter(([, k]) => k);
        else pairs = /^local\b/.test(it.lane) ? allCards(topology).map((k) => [null, k]) : [];
        const seen = new Set();
        for (const [id, k] of pairs) {
            if (seen.has(k)) continue; seen.add(k);
            const c = ((topology && topology.cards) || []).find((x) => x.key === k);
            out.push({ lane: it.lane, device: id || (c ? c.preferredId : null), card: cardLabel(topology, k), cardKey: k, itemId: it.id, label: it.label || null });
        }
    }
    return out;
}

/** The busy entries that collide with what a launch needs. */
function conflicts(needed, busy) {
    const want = new Set(needed || []);
    return (busy || []).filter((b) => want.has(b.cardKey));
}

/** One sentence for the 409. */
function describe(list) {
    const byItem = new Map();
    for (const b of list) { if (!byItem.has(b.itemId)) byItem.set(b.itemId, { label: b.label, cards: [] }); byItem.get(b.itemId).cards.push(b.card); }
    return [...byItem.entries()].map(([id, v]) => `the ${v.cards.join(' and ')} ${v.cards.length > 1 ? 'are' : 'is'} running queue item ${id}${v.label ? ` (${v.label})` : ''}`).join('; ');
}

module.exports = { neededCards, busyCards, conflicts, describe };
