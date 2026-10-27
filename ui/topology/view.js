// What the launcher and the monitor show about THIS machine's hardware (2026-10-12), the DOM-free part. The server
// describes the machine (GET /api/topology, lib/topology.js: physical cards, identical ones numbered) and says how
// each saved profile fits it (GET /api/profiles `availability`); this file turns that into the words and choices the
// page shows. (The queue's lane cards are worded by the queue view itself, ui/benchmarks/queue.js, from /api/queue.) No card, vendor or device id is named in here or in the code that calls it: a page built on it reads
// right on one card, two identical cards, mixed vendors or no GPU at all.
//
// Every function tolerates the field it reads being ABSENT (an older server, a failed fetch): a profile with no
// availability entry is treated as runnable and labelled from its own device names, exactly as before.
//
// A classic script, not an ES module, for the same reason as ui/shared/histwindow.js: script.js is a classic script
// and Node's require() cannot load ESM. Sets `globalThis.TopoView`, and `module.exports` under CommonJS
// (test/topoview.test.js). The ES modules (ui/profilepicker) read it off globalThis.
(function (root) {
    'use strict';

    // ---- names ---------------------------------------------------------------------------
    /** Same rule as lib/topology.js shortName: "AMD Radeon RX 7900 XTX (RADV NAVI31)" -> "RX 7900 XTX". */
    function shortName(name) {
        return String(name || '').replace(/\(.*?\)/g, ' ')
            .replace(/\b(AMD|NVIDIA|Intel\(R\)|Intel|Advanced Micro Devices,? Inc\.?|Corporation)\b/gi, ' ')
            .replace(/\b(Radeon|GeForce|Graphics|GPU)\b/gi, ' ')
            .replace(/\s+/g, ' ').trim() || String(name || '').trim();
    }
    /** Card identity across listings (lib/devices.js gpuKey). */
    const nameKey = (name) => String(name || '').toLowerCase().replace(/\(.*?\)/g, ' ').replace(/\s+/g, ' ').trim();
    const backendOf = (id) => String(id || '').replace(/\d+$/, '');
    const isRemoteId = (id) => /^RPC\d*$/i.test(String(id || ''));
    const cardsOf = (topology) => (topology && Array.isArray(topology.cards) ? topology.cards : []);
    const cardOfId = (topology, id) => cardsOf(topology).find((c) => (c.ids || []).includes(String(id || ''))) || null;

    /**
     * Number a list of things that have a card name: [{ ordinal, count, label }] in the same order. Two identical
     * cards are "#1" and "#2" (both numbered: "the plain one" and "#2" reads as two different models).
     */
    function numbered(names) {
        const counts = new Map(), seen = new Map();
        for (const n of names) counts.set(nameKey(n), (counts.get(nameKey(n)) || 0) + 1);
        return names.map((n) => {
            const k = nameKey(n), ordinal = (seen.get(k) || 0) + 1;
            seen.set(k, ordinal);
            const count = counts.get(k), short = shortName(n) || 'GPU';
            return { ordinal, count, short, label: count > 1 ? `${short} #${ordinal}` : short };
        });
    }

    // ---- the device table ----------------------------------------------------------------
    /**
     * Rows for the launch panel's device table from GET /api/devices: cards (lib/devices.js physicalCards) with the
     * label the topology gives each (else numbered here), the id it is reached through, and its memory.
     * -> [{ key, name, label, ordinal, count, vendor, backends, preferredId, vramMib, orderAssumed }]
     */
    function cardRows(cards, topology) {
        const list = Array.isArray(cards) ? cards : [];
        const nums = numbered(list.map((c) => c.name));
        return list.map((c, i) => {
            const backends = Array.isArray(c.backends) ? c.backends : [];
            const t = backends.map((b) => cardOfId(topology, b.id)).find(Boolean) || null;
            const vram = Math.max(0, ...backends.map((b) => Number(b.totalMib) || 0));
            return {
                key: `card:${c.name}#${nums[i].ordinal}`, name: c.name, vendor: c.vendor || (t && t.vendor) || 'other',
                label: t ? t.label : nums[i].label, ordinal: t ? t.ordinal : nums[i].ordinal, count: t ? t.count : nums[i].count,
                backends, preferredId: c.preferredId || (backends[0] && backends[0].id) || null,
                vramMib: (t && t.vramMib) || vram || null,
                // identical cards are told apart by listing order only (lib/topology.js orderAssumed)
                orderAssumed: t ? !!t.orderAssumed : !!c.ambiguous,
            };
        });
    }

    /**
     * Which table row a saved device means. rows: [{ kind: 'card', name, backends: [{id}], ordinal }], d: { id, name? },
     * used: Set of rows already taken, reference: the machine's fullest topology (GET /api/topology) or null.
     *   1. the row that HAS this id (and is the card the device names): ROCm1 is the second of two identical cards,
     *      whichever comes first in the table. Matching by name first enabled card #1 for a card-#2 profile.
     *   2. this build has no such id: the same physical card by the fullest listing (ROCm1 -> the row numbered #2)
     *   3. any free row of that card model
     *   4. a device saved without a name: the row that has the id
     * -> { row, how: 'id' | 'card' | 'name' | 'unnamed' } or null
     */
    function matchDeviceRow(rows, d, used, reference) {
        const free = (rows || []).filter((r) => r && r.kind === 'card' && !(used && used.has(r)));
        const has = (r) => (r.backends || []).some((b) => b.id === d.id);
        const same = (r) => !!d.name && nameKey(r.name) === nameKey(d.name);
        let row = free.find((r) => has(r) && (!d.name || same(r)));
        if (row) return { row, how: d.name ? 'id' : 'unnamed' };
        if (d.name) {
            const home = cardOfId(reference, d.id);
            if (home && nameKey(home.name) === nameKey(d.name)) {
                row = free.find((r) => same(r) && r.ordinal === home.ordinal);
                if (row) return { row, how: 'card' };
            }
            row = free.find(same);
            if (row) return { row, how: 'name' };
            return null;
        }
        return null;
    }
    /** The id to reach `row` through for a saved id: the id itself, else the same backend, else what the row had. */
    function idOnRow(row, savedId) {
        const b = (row.backends || []).find((x) => x.id === savedId) || (row.backends || []).find((x) => backendOf(x.id) === backendOf(savedId));
        return b ? b.id : (row.id || row.preferredId || null);
    }

    /**
     * Are two llama.cpp devices the same physical card (one card listed under two backends)? devices: /api/devices
     * entries ({ id, description }), topology: that response's. By card when the topology knows both ids -- two
     * identical cards share a description and are NOT the same card, one card under two backends has two slightly
     * different descriptions and IS. Without a topology: same card model through different backends is taken as one
     * card, two ids of one backend never are.
     */
    function samePhysical(a, b, topology) {
        if (!a || !b) return false;
        if (a.id === b.id) return true;
        const ca = cardOfId(topology, a.id), cb = cardOfId(topology, b.id);
        if (ca && cb) return ca.key === cb.key;
        return nameKey(a.description) === nameKey(b.description) && backendOf(a.id) !== backendOf(b.id);
    }

    // ---- saved profiles --------------------------------------------------------------------
    const FIT = {
        ready: { rank: 0, text: '', tone: 'ok', runnable: true },
        moved: { rank: 1, text: 'ids re-pointed', tone: 'note', runnable: true },
        substitute: { rank: 2, text: 'stand-in card', tone: 'warn', runnable: true },
        unavailable: { rank: 3, text: 'not on this machine', tone: 'off', runnable: false },
    };
    /**
     * One profile's fit on this machine, from /api/profiles `availability[name]`. Missing (older server) = runnable,
     * nothing to say. -> { status, reason, placement, devices, known, rank, text, tone, runnable }
     */
    function fitOf(availability, name) {
        const a = availability && typeof availability === 'object' ? availability[name] : null;
        const status = a && FIT[a.status] ? a.status : 'ready';
        return {
            status, reason: (a && a.reason) || '', placement: (a && a.placement) || null,
            devices: a && Array.isArray(a.devices) ? a.devices : null, known: !!a, ...FIT[status],
        };
    }
    /** Runnable profiles first (ready, then re-pointed, then stand-in), unavailable last; otherwise the given order. */
    function sortByFit(items, availability, nameOf) {
        const name = nameOf || ((x) => x.name);
        return (items || []).map((x, i) => ({ x, i, r: fitOf(availability, name(x)).rank }))
            .sort((a, b) => (a.r === 3) - (b.r === 3) || a.i - b.i).map((e) => e.x);
    }
    /**
     * The device list to load into the form for a profile: the server's re-pointed list when the saved ids are not
     * this machine's (moved / substitute), else the saved one. `note` is what to show beside the table.
     */
    function devicesToLoad(config, fit) {
        const saved = config && Array.isArray(config.devices) ? config.devices : null;
        if (fit && (fit.status === 'moved' || fit.status === 'substitute') && fit.devices) {
            return { devices: fit.devices, resolved: true, note: fit.reason || (fit.status === 'moved' ? 'Device ids re-pointed at this machine.' : 'A different card stands in on this machine.') };
        }
        return { devices: saved, resolved: false, note: fit && fit.status !== 'ready' ? (fit.reason || '') : '' };
    }
    /** The dropdown / chip text for where a profile runs: the server's placement, else its own device names. */
    function placementText(config, fit) {
        if (fit && fit.placement) return fit.placement;
        const cfg = config || {};
        const devs = (Array.isArray(cfg.devices) ? cfg.devices : []).filter((d) => d && d.enabled !== false);
        if (!devs.length) return null;
        const names = devs.map((d) => (d.worker ? `${d.worker} (RPC)` : (d.name ? shortName(d.name) : d.id)));
        if (names.length === 1) return `${names[0]} alone`;
        const shares = devs.map((d) => Number(d.share) || 0);
        const g = shares.reduce((a, b) => { while (b) [a, b] = [b, a % b]; return a; }, 0) || 1;
        const ratio = shares.every((s) => s > 0) ? ', ' + shares.map((s) => Math.round(s / g)).join(':') : '';
        return (names.every((n) => n === names[0]) ? `${names.length}x ${names[0]}` : names.join(' + ')) + ratio;
    }
    /**
     * Where the launch in the device table sits, in the server's words (lib/topology.js placementLabel): "RX 7900 XTX
     * #2 alone", "2x RX 7900 XTX, 1:1", "RTX 3060 + RX 7900 XTX, 1:3". rows: the ENABLED table rows in order
     * ({ kind: 'card', name, label, share } | { kind: 'worker', name, share }). '' with no row (llama-server picks).
     */
    function placementOfRows(rows) {
        const parts = (rows || []).map((r) => (r.kind === 'worker' ? { label: `${r.name} (RPC)`, short: null, share: r.share }
            : { label: r.label || shortName(r.name), short: shortName(r.name), share: r.share }));
        if (!parts.length) return '';
        if (parts.length === 1) return `${parts[0].label} alone`;
        const shares = parts.map((p) => Number(p.share) || 0);
        const g = shares.reduce((a, b) => { while (b) [a, b] = [b, a % b]; return a; }, 0) || 1;
        const ratio = shares.every((s) => s > 0) ? ', ' + shares.map((s) => Math.round(s / g)).join(':') : '';
        const allSame = parts.every((p) => p.short && p.short === parts[0].short);
        return (allSame ? `${parts.length}x ${parts[0].short}` : parts.map((p) => p.label).join(' + ')) + ratio;
    }
    /**
     * What a profile's `needs` asks of a machine, in words ("AMD card with 24 GB · 46 GB of memory"); '' without needs.
     * The numbers are the server's (lib/topology.js availability): card memory rounded UP, as "Needs an AMD card with
     * 24 GB." is -- a 24,000 MiB requirement is a 24 GB card, and this line used to say 23 beside the server's 24.
     */
    function needsText(needs) {
        const n = needs && typeof needs === 'object' ? needs : null;
        if (!n) return '';
        const bits = [];
        if (n.minCards || n.minVramMib || n.vendor) {
            const k = Number(n.minCards) || 1;
            bits.push(`${k > 1 ? k + ' ' : ''}${n.vendor ? String(n.vendor).toUpperCase() + ' ' : ''}card${k > 1 ? 's' : ''}${n.minVramMib ? ` with ${Math.ceil(n.minVramMib / 1024)} GB` : ''}`);
        }
        if (n.hostRamMib) bits.push(`${Math.round(n.hostRamMib / 1024)} GB of memory`);
        return bits.join(' · ');
    }

    // ---- split mode ------------------------------------------------------------------------
    // Mirror of lib/devices.js splitModeOf (test/topoview.test.js holds the two to the same answers).
    const SPLIT_MODES = [
        { value: 'layer', label: 'layer', title: 'Whole layers per device, in the table\'s order (llama.cpp\'s default).' },
        { value: 'tensor', label: 'tensor (experimental)', title: 'Single tensors placed across devices (-sm tensor). Experimental in llama.cpp.' },
    ];
    function splitModeOf(cfg) {
        const c = cfg || {};
        const tokens = String(c.argString || '').match(/'[^']*'|"[^"]*"|\S+/g) || [];
        let extra = null;
        for (let i = 0; i < tokens.length - 1; i++) if (tokens[i] === '-sm' || tokens[i] === '--split-mode') extra = tokens[i + 1].replace(/^['"]|['"]$/g, '').toLowerCase();
        const field = c.splitMode != null && String(c.splitMode).trim() ? String(c.splitMode).trim().toLowerCase() : null;
        const mode = extra || field || 'layer';
        return {
            mode, source: extra ? 'extra' : field ? 'field' : 'default', overridden: !!(extra && field && extra !== field),
            problem: mode === 'row' ? 'Split mode "row" is deprecated in llama.cpp and fails to load: use layer or tensor.'
                : (mode === 'layer' || mode === 'tensor' || mode === 'none' ? null : `Unknown split mode "${mode}": use layer or tensor.`),
        };
    }
    /** "tensor split (experimental)", "layer split", with where it was set when that is the extra arguments. */
    function splitModeText(split, deviceCount) {
        if (!split || !(deviceCount > 1)) return '';
        const what = split.mode === 'tensor' ? 'tensor split (experimental)' : split.mode === 'none' ? 'no split (-sm none)' : `${split.mode} split`;
        return split.source === 'extra' ? `${what}, set in extra arguments` : what;
    }

    // ---- launch summary and busy cards -----------------------------------------------------
    /** One line under the device table: "2x RX 7900 XTX, 1:1 · tensor split (experimental)". */
    function launchSummary({ placement, split, deviceCount } = {}) {
        return [placement || null, splitModeText(split, deviceCount) || null].filter(Boolean).join(' · ');
    }
    /**
     * A queue item on a card this launch needs (/api/preview-command `busy`, 409 CARD_BUSY `busy`: per physical card
     * { lane, device, card, itemId, label }). "RX 7900 XTX #2 (ROCm1) is running queue item 904 (fill) on lane local-rocm1".
     */
    function busyText(b) {
        if (!b) return '';
        const card = b.card || b.device || 'a card';
        const via = b.device && b.device !== card ? ` (${b.device})` : '';
        return `${card}${via} is running queue item ${b.itemId}${b.label ? ` (${b.label})` : ''}${b.lane ? ` on lane ${b.lane}` : ''}`;
    }
    /** Several busy entries, one sentence each, the same item's cards joined ("... #1 and ... #2 are running ..."). */
    function busyWarnings(list) {
        const byItem = new Map();
        for (const b of list || []) {
            if (!b) continue;
            const k = `${b.itemId}|${b.lane || ''}`;
            if (!byItem.has(k)) byItem.set(k, { ...b, cards: [] });
            const card = b.card || b.device || 'a card';
            byItem.get(k).cards.push(b.device && b.device !== card ? `${card} (${b.device})` : card);
        }
        return [...byItem.values()].map((v) => `${v.cards.join(' and ')} ${v.cards.length > 1 ? 'are' : 'is'} running queue item ${v.itemId}${v.label ? ` (${v.label})` : ''}${v.lane ? ` on lane ${v.lane}` : ''}: launching now takes ${v.cards.length > 1 ? 'those cards' : 'that card'}`);
    }

    /**
     * The question asked before a profile this machine cannot run as saved is loaded into the form. One text for the
     * dropdown (script.js loadLaunchProfile) and the picker (ui/profilepicker), which asks it BEFORE it closes, so
     * that "Cancel" leaves the picker open on the same row.
     */
    function unavailableConfirmText(name, fit) {
        return `"${name}" cannot run on this machine as saved.\n\n${(fit && fit.reason) || 'It needs hardware this machine does not have.'}\n\nLoad it anyway? Devices this machine lacks are left out of the form.`;
    }

    // ---- labels in narrow places ---------------------------------------------------------------
    /**
     * "RX 7900 XTX #2 @laptop" -> { name: "RX 7900 XTX", tail: " #2 @laptop" }. The name may be cut to fit; the tail
     * is what tells two identical cards apart and must not be (cut from the right, both read "RX 7900 XT…").
     * A label with no ordinal has no tail.
     */
    function labelParts(label) {
        const s = String(label == null ? '' : label);
        const m = /^(.*?\S)(\s+#\d+(?!\d).*)$/.exec(s);
        return m ? { name: m[1], tail: m[2] } : { name: s, tail: '' };
    }
    /**
     * HTML for a card label that keeps its ordinal at any width: the name shrinks behind an ellipsis, the tail does
     * not shrink. Inline styles, so it works wherever it is put (inside a flex row, a heading, a legend) without a
     * stylesheet. esc: the caller's HTML escaper.
     */
    function labelHtml(label, esc) {
        const e = typeof esc === 'function' ? esc : (x) => String(x).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
        const p = labelParts(label);
        const name = `<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${e(p.name)}</span>`;
        return `<span style="display:inline-flex;min-width:0;max-width:100%;vertical-align:bottom">${name}${p.tail ? `<span style="flex:none;white-space:pre">${e(p.tail)}</span>` : ''}</span>`;
    }

    // ---- the device list's own state ------------------------------------------------------------
    /**
     * What to say beside the device table about a GET /api/devices answer (lib/deviceprobe.js): nothing for a fresh
     * probe; for a cached, borrowed or failed one, the server's note (or one made from `error` / `ageMs` on a server
     * that sends none). -> { text, tone: 'info' | 'warn', failed, canRefresh } ; text '' = nothing to show.
     * `failed`: there is no device list to show at all (the manual-entry fallback applies).
     */
    function devicesNote(data) {
        const d = data && typeof data === 'object' ? data : {};
        const has = Array.isArray(d.cards) && d.cards.length > 0;
        if (!has) return { text: `Detection failed${d.error ? ` (${d.error})` : ''} — enter local device ids below.`, tone: 'warn', failed: true, canRefresh: true };
        if (d.borrowed) return { text: d.note || `This build's own device list is not known${d.from ? `; showing build "${d.from}"'s` : ''}.`, tone: 'warn', failed: false, canRefresh: true };
        if (d.error) return { text: d.note || `The probe ${d.error}; showing the last good device list.`, tone: 'warn', failed: false, canRefresh: true };
        if (d.cached) return { text: d.note || 'Device list from the cache (not re-probed).', tone: 'info', failed: false, canRefresh: true };
        return { text: '', tone: 'info', failed: false, canRefresh: false };
    }

    // ---- telemetry -------------------------------------------------------------------------
    /**
     * The GPU cards the sidebar shows, in order: the launch's devices while a model is up (each joined to its own
     * reading), else every GPU telemetry reports, else -- an older server -- the legacy master/worker pair.
     * -> [{ key, id, label, name, host, gpu }]. key = `${host}|${name label}` (stable from poll to poll, and what the
     * charts key their lines on). Labels are the server's (`label`: "RX 7900 XTX #2") when it sends them; without,
     * identical cards on a host are numbered here, both of them. A device finds its reading by PCI address when the
     * server sends one: by name alone, a launch on the second of two identical cards showed the first card's numbers.
     */
    function telemetryCardList(stats) {
        const s = stats || {};
        const cards = [];
        const push = (host, name, label, id, gpu) => {
            const display = `${label}${host !== 'local' ? ` @${host}` : ''}`;
            cards.push({ key: `${host}|${label}`, id: id || label, label: display, name: label, host, gpu });
        };
        const gpus = Array.isArray(s.gpus) ? s.gpus : null;
        // labels for readings the server did not label: numbered per host
        const own = new Map();
        if (gpus) {
            const byHost = new Map();
            for (const g of gpus) { const h = g.host || 'local'; if (!byHost.has(h)) byHost.set(h, []); byHost.get(h).push(g); }
            for (const list of byHost.values()) numbered(list.map((g) => g.gpu_name)).forEach((n, i) => own.set(list[i], n.label));
        }
        const labelOf = (g) => g.label || own.get(g) || shortName(g.gpu_name) || 'GPU';
        if (gpus && Array.isArray(s.devices) && s.devices.length > 0) {
            const claimed = new Set();
            const taken = new Map();
            for (const d of s.devices) {
                const host = d.host || 'local';
                const g = (d.pci ? gpus.find((x) => !claimed.has(x) && (x.host || 'local') === host && x.pci === d.pci) : null)
                    || gpus.find((x) => !claimed.has(x) && (x.host || 'local') === host && d.name && nameKey(x.gpu_name) === nameKey(d.name)) || null;
                if (g) claimed.add(g);
                let label = (g && labelOf(g)) || d.label || (d.name ? shortName(d.name) : d.id) || 'GPU';
                // two devices must never share a key (an older server labels identical cards alike)
                const n = (taken.get(`${host}|${label}`) || 0) + 1; taken.set(`${host}|${label}`, n);
                if (n > 1) label = `${label} #${n}`;
                push(host, d.name || d.id, label, d.id, g || {
                    gpu_name: d.name || d.id, gpu_util: d.util, gpu_pwr: d.pwr, gpu_temp: d.temp, mem_temp: d.mem_temp, fan_rpm: d.fan_rpm, fan_pct: d.fan_pct,
                    vram_used: d.vram_used, vram_total: d.vram_total, throttle_reasons: [], missing: d.util == null,
                });
            }
        } else if (gpus) {
            for (const g of gpus) push(g.host || 'local', g.gpu_name, labelOf(g), null, g);
        } else if (s.master) {
            push('local', s.master.gpu_name, shortName(s.master.gpu_name) || 'GPU', 'master', s.master);
            const w = s.worker;
            if (w && !w.nvidia_smi_error && !w.amdgpu_top_error) push('worker', w.gpu_name, shortName(w.gpu_name) || 'GPU', 'worker', w);
        }
        return cards;
    }
    /**
     * The devices of one chart sample ([{ id, label, host, ... }]) with labels that tell them apart: two devices of
     * one host that share a label (a sample recorded before the server numbered identical cards) become "#1" and
     * "#2", in the sample's own order. Everything else is returned as it is. The charts key a line on host + label,
     * so without this two identical cards drew as one line and the second card's readings were lost.
     */
    function distinctDevices(devices) {
        const list = Array.isArray(devices) ? devices : [];
        const count = new Map();
        for (const d of list) { const k = `${d.host}|${d.label}`; count.set(k, (count.get(k) || 0) + 1); }
        if (![...count.values()].some((n) => n > 1)) return list;
        const seen = new Map();
        return list.map((d) => {
            const k = `${d.host}|${d.label}`;
            if (count.get(k) < 2) return d;
            const n = (seen.get(k) || 0) + 1; seen.set(k, n);
            return { ...d, label: `${d.label} #${n}` };
        });
    }
    /**
     * Labels for the full-screen telemetry series ([{ kind, host, name, label? }]): the server's label where it sent
     * one, else the card's short name, identical ones on a host numbered -- all of them, so a card has the same
     * label (and colour) here as in the sidebar. -> one label per series, null for a series that is not a GPU.
     */
    function seriesLabels(series) {
        const list = Array.isArray(series) ? series : [];
        const out = list.map(() => null);
        const byHost = new Map();
        list.forEach((s, i) => {
            if (!s || s.kind !== 'gpu') return;
            if (s.label) { out[i] = s.label; return; }
            const h = s.host || 'local';
            if (!byHost.has(h)) byHost.set(h, []);
            byHost.get(h).push(i);
        });
        // one entry per card: a card has several series (temp, power, ...) only across fields, never within one chart
        for (const idx of byHost.values()) numbered(idx.map((i) => list[i].name)).forEach((n, k) => { out[idx[k]] = n.label; });
        return out;
    }
    /**
     * One card's readings as short text parts, missing sensors left out: ["86 °C", "mem 72 °C", "fan 2910 rpm (86%)",
     * "322 W", "95%"]. A stopped fan (0 rpm) is a reading. [] when the card has no reading at all.
     */
    function cardReadout(g) {
        if (!g || g.missing) return [];
        const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
        const out = [];
        const temp = num(g.gpu_temp), mem = num(g.mem_temp), rpm = num(g.fan_rpm), pct = num(g.fan_pct), pwr = num(g.gpu_pwr), util = num(g.gpu_util);
        if (temp != null) out.push(`${Math.round(temp)} °C`);
        if (mem != null) out.push(`mem ${Math.round(mem)} °C`);
        if (rpm != null) out.push(`fan ${Math.round(rpm)} rpm${pct != null ? ` (${Math.round(pct)}%)` : ''}`);
        else if (pct != null) out.push(`fan ${Math.round(pct)}%`);
        if (pwr != null) out.push(`${Math.round(pwr)} W`);
        if (util != null) out.push(`${Math.round(util)}%`);
        return out;
    }

    const api = { shortName, nameKey, numbered, cardRows, matchDeviceRow, idOnRow, samePhysical, fitOf, sortByFit, devicesToLoad, placementText, placementOfRows, needsText,
        SPLIT_MODES, splitModeOf, splitModeText, launchSummary, busyText, busyWarnings, telemetryCardList, distinctDevices, seriesLabels, cardReadout,
        labelParts, labelHtml, devicesNote, unavailableConfirmText };
    root.TopoView = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
