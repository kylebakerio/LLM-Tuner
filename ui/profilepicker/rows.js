// The launch panel's profile picker, the DOM-free half: what each saved profile runs (model,
// context, KV cache, devices, MTP), how it fits THIS machine, and the order the picker lists them
// in. The model side reuses the model picker's own pieces (ggufModelKey -> the catalog, pickerRows
// -> the Quality ladder's order), so a profile's model reads exactly as it does in the model picker.
//
// Hardware (2026-10-12): nothing here names a card. A device is called what its stored name says
// (shortened), and where a profile runs on this machine comes from the server's `availability`
// (lib/topology.js) through ui/topology/view.js (globalThis.TopoView, a classic script loaded
// before the modules): "2x RX 7900 XTX, 1:1", "Needs RTX 3060.". Without that (an older server)
// every profile reads as runnable and is labelled from its own device names, as before.

import { modelName, ctxLabel } from '../benchmarks/util.js';
import { ggufModelKey } from '../modelpicker/rank.js';

// ---- one profile ----------------------------------------------------------------------
// A profile's context in words: ctxLabel (ui/shared/ctxlabel.js via util.js), the rule every page and the catalog use
// (2026-10-25: this file had its own, which read 1048576 "1M" where the Models page reads "1024k"; no saved profile has
// one). "64k", "224k", "128k" for local-128k's 128000; null without a context size.

/** "f16", "q8_0", or "q8_0/f16" when K and V differ; null when neither is set. */
export function kvLabel(cfg) {
    const k = cfg && cfg.cacheK, v = cfg && cfg.cacheV;
    if (!k && !v) return null;
    return k && v && k !== v ? `${k}/${v}` : (k || v);
}

const tv = () => globalThis.TopoView || null;
// A card's short name: its product name without vendor words (the dashboard-wide rule, lib/topology.js shortName).
const shortCard = (name) => (tv() ? tv().shortName(name) : String(name || '').replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim());

// What a device is called: its stored card name (ids move when a GPU is added or the profile is
// opened on another machine), RPC for a worker, else the bare id. An id is never turned into a card.
export function deviceLabel(d) {
    if (!d) return null;
    if (d.worker) return 'RPC';
    const name = String(d.name || '').trim();
    if (name) return shortCard(name);
    const id = String(d.id || '');
    if (/^RPC\d*$/i.test(id)) return 'RPC';
    return id || null;
}

// A profile's devices, in order, with shares. Newer profiles carry `devices`; an old one has only
// deviceA/deviceB/rpcTarget/tensorSplit (the same fallback script.js's legacyDevicesFallback reads).
export function profileDevices(cfg) {
    const c = cfg || {};
    let list;
    if (Array.isArray(c.devices)) list = c.devices.filter((d) => d && d.enabled !== false);
    else {
        const a = c.deviceA || null;
        const b = c.deviceB && c.deviceB !== c.deviceA ? c.deviceB : null;
        const ts = Number(c.tensorSplit);
        const split = c.tensorSplit != null && Number.isFinite(ts) && ts >= 0 && ts < 100 ? ts : null;
        const second = b ? { id: b } : (c.rpcTarget ? { worker: c.rpcTarget } : null);
        list = [];
        if (a) list.push(second && split != null ? { id: a, share: split } : { id: a });
        if (second) list.push(a && split != null ? { ...second, share: 100 - split } : second);
    }
    return list.map((d) => ({ label: deviceLabel(d), share: Number.isFinite(Number(d.share)) && d.share != null ? Number(d.share) : null, worker: d.worker || null }))
        .filter((d) => d.label);
}

/** "RX 7900 XTX 75 · RTX 3060 25" (shares shown only when every device has one), "RX 7900 XTX", or null. */
export function devicesText(devs) {
    if (!devs || !devs.length) return null;
    const shares = devs.length > 1 && devs.every((d) => d.share != null);
    return devs.map((d) => (shares ? `${d.label} ${d.share}` : d.label)).join(' · ');
}

// MTP: the model's own multi-token-prediction head as the speculative draft.
export const isMtp = (cfg) => /(^|,)\s*draft-mtp\b/.test(String((cfg && cfg.specType) || ''));

// An archived / obsolete profile. No such flag is stored today; these are the spellings a store
// that grows one is likely to use, on the entry or inside its config.
export function isArchived(entry) {
    const e = entry || {}, c = e.config || {};
    return !!(e.archived || e.obsolete || c.archived || c.obsolete || e.status === 'archived' || e.status === 'obsolete');
}

/**
 * Everything a picker row shows about one saved profile. entry: the store's {config, savedAt, lastLoadedAt};
 * availability: /api/profiles `availability` (how each profile fits this machine), absent on an older server.
 */
export function profileFacts(name, entry, availability) {
    const e = entry && typeof entry === 'object' ? entry : {};
    const cfg = (e.config && typeof e.config === 'object') ? e.config : {};
    const isStrata = cfg.engine === 'strata';
    const strataFile = isStrata && cfg.strataBase ? (cfg.strataBase.split('/').pop() || '').replace(/\.json$/, '') : null;
    const modelPath = isStrata ? (cfg.strataBase || '') : (cfg.modelPath || cfg.model || '');
    // An engine with its own launcher lists no devices: what it asks of a machine is its `needs`.
    const devices = isStrata ? [] : profileDevices(cfg);
    const V = tv();
    const fit = V ? V.fitOf(availability, name) : { status: 'ready', reason: '', placement: null, devices: null, known: false, rank: 0, text: '', tone: 'ok', runnable: true };
    const needs = V ? V.needsText(cfg.needs) : '';

    let ctx = Number(cfg.ctx) || Number(cfg.maxContext) || null;
    if (!ctx && isStrata) {
        const text = `${name} ${cfg.strataBase || ''}`;
        if (/\b1m\b/i.test(text)) ctx = 1048576;
        else if (/\b512k\b/i.test(text)) ctx = 524288;
        else if (/\b262k\b/i.test(text)) ctx = 262144;
        else if (/\b128k\b/i.test(text)) ctx = 131072;
        else if (/\b64k\b/i.test(text)) ctx = 65536;
    }

    let kv = kvLabel(cfg);
    if (!kv && isStrata) {
        if (/int8/i.test(`${name} ${cfg.strataBase || ''}`)) kv = 'int8';
        else if (/q4/i.test(`${name} ${cfg.strataBase || ''}`)) kv = 'q4';
    }

    const file = isStrata ? strataFile : (modelPath ? modelName(modelPath) : null);
    const modelKey = isStrata ? (strataFile ? `strata:${strataFile}` : 'strata') : (modelPath ? ggufModelKey(modelPath) : null);
    // Where it runs: on THIS machine when the server says ("2x RX 7900 XTX, 1:1"), else the profile's own device
    // names with their shares; an engine without a device list shows what it needs instead.
    const own = devicesText(devices);
    const devText = (fit.runnable && fit.placement) || own || (needs ? `needs ${needs}` : null);

    return {
        name,
        engine: cfg.engine || null,
        modelPath,
        modelKey,
        file,
        ctx,
        ctxText: ctxLabel(ctx),
        kv,
        devices,
        devicesText: devText,
        ownDevicesText: own,
        needsText: needs,
        fit,
        rpc: devices.some((d) => d.worker || d.label === 'RPC'),
        mtp: isMtp(cfg),
        specType: cfg.specType || null,
        draftN: Number(cfg.specDraftNMax) || null,
        cpuMoe: Number(cfg.nCpuMoe) || null,
        note: cfg.tuningNote || null,
        lastUsed: Number(e.lastLoadedAt) || Number(e.savedAt) || 0,
        archived: isArchived(e),
    };
}

// ---- the list --------------------------------------------------------------------------
/**
 * The picker's groups. names: the profile names the native select offers (the only ones a pick can
 * set); store: /api/profiles' `profiles` map (may be missing a name, or be {} when the fetch failed);
 * ranked: pickerRows() over one option per distinct modelPath ({value: modelPath}).
 *
 * -> { groups, archived }. Each group is one model (by catalog key, so the same weights reached
 * through two paths are one group): {key, display, row (the picker row: point/model/thin or null),
 * rank (ladder place or null), profiles: [facts]}. Groups run best quality first (the ladder's
 * order), then the unbenchmarked models by name, then profiles with no model. Inside a group,
 * most recently used first, as the dropdown sorted them. Archived profiles are pulled out into
 * `archived` (same facts, most recent first) whatever their model. Profiles this machine cannot run
 * (availability status `unavailable`) are pulled out into `unavailable` the same way, so the groups
 * hold only what can be launched here; a profile that is both is listed as archived.
 */
export function profileGroups(names, store, ranked, availability) {
    const s = store || {};
    const rowOf = new Map();   // model key -> picker row
    const rated = (ranked && ranked.rated) || [], unrated = (ranked && ranked.unrated) || [];
    const rankOf = new Map();
    for (const r of rated) {
        if (!rankOf.has(r.point.key)) rankOf.set(r.point.key, rankOf.size + 1);
        if (!rowOf.has(r.key)) rowOf.set(r.key, r);
    }
    for (const r of unrated) if (!rowOf.has(r.key)) rowOf.set(r.key, r);
    // every profile carries its model's display name: the catalog's, else the file name
    const facts = (names || []).map((n) => {
        const f = profileFacts(n, s[n], availability);
        const row = rowOf.get(f.modelKey || '') || null;
        const isStrata = f.engine === 'strata';
        f.display = row && row.model ? row.model.display : (f.file ? (isStrata ? 'Strata ' + f.file.replace(/^strata-/, '') : modelName(f.modelPath, { ext: false })) : 'No model set');
        return f;
    });
    const archived = facts.filter((f) => f.archived).sort((a, b) => b.lastUsed - a.lastUsed || a.name.localeCompare(b.name));
    const unavailable = facts.filter((f) => !f.archived && !f.fit.runnable).sort((a, b) => b.lastUsed - a.lastUsed || a.name.localeCompare(b.name));
    const byKey = new Map();
    for (const f of facts.filter((x) => !x.archived && x.fit.runnable)) {
        const key = f.modelKey || '';
        if (!byKey.has(key)) {
            const row = rowOf.get(key) || null;
            byKey.set(key, { key, row, display: f.display, rank: row && row.point ? rankOf.get(row.point.key) ?? null : null, profiles: [] });
        }
        byKey.get(key).profiles.push(f);
    }
    const groups = [...byKey.values()];
    for (const g of groups) g.profiles.sort((a, b) => b.lastUsed - a.lastUsed || a.name.localeCompare(b.name));
    const order = (g) => (g.rank != null ? 0 : g.key ? 1 : 2);
    groups.sort((a, b) => order(a) - order(b)
        || (a.rank != null && b.rank != null ? a.rank - b.rank || ((b.row.point.rate ?? -1) - (a.row.point.rate ?? -1)) : 0)
        || a.display.localeCompare(b.display, undefined, { numeric: true, sensitivity: 'base' }));
    return { groups, archived, unavailable };
}

/** Does a profile match the search box (every word somewhere)? Name, model file and display, ctx, KV, devices (its own names and where it runs here), fit, "mtp". */
export function profileMatches(f, q) {
    if (!q) return true;
    const fit = f.fit || {};
    const hay = [f.name, f.file, f.display, f.ctxText, f.kv, f.devicesText, f.ownDevicesText, f.rpc ? 'rpc' : '', fit.text, fit.reason, f.mtp ? 'mtp' : '', f.specType, f.note].filter(Boolean).join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).filter(Boolean).every((w) => hay.includes(w));
}
