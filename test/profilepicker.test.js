'use strict';
// ui/profilepicker/rows.js: what the launch panel's profile picker shows about each saved profile
// (model, ctx, KV, devices, MTP) and the order it lists them in (by model, best quality first).
const test = require('node:test');
const assert = require('node:assert/strict');

// rows.js reads the hardware wording off globalThis.TopoView (ui/topology/view.js, a classic script the page loads
// before its modules); requiring it here is that load.
const V = require('../ui/topology/view.js');
const topo = require('../lib/topology');
const load = () => import('../ui/profilepicker/rows.js');

const XTX = { id: 'ROCm0', name: 'AMD Radeon RX 7900 XTX', share: 75 };
const N3060 = { id: 'CUDA0', name: 'NVIDIA GeForce RTX 3060', share: 25 };
const Q4 = '/home/kyle/.cache/huggingface/hub/models--unsloth--Qwen3.8-27B-GGUF/snapshots/abc/Qwen3.8-27B-UD-Q4_K_XL.gguf';
const Q4_LOCAL = '/home/kyle/AI/experiment-1/models/Qwen3.8-27B-UD-Q4_K_XL.gguf';
const Q6 = '/home/kyle/.cache/huggingface/hub/models--unsloth--Qwen3.8-27B-GGUF/snapshots/abc/Qwen3.8-27B-UD-Q6_K_XL.gguf';
const FLASH = '/home/kyle/AI/experiment-1/models/Qwen3.8-Flash-Next-UD-Q2_K_XL-00001-of-00003.gguf';
const SWIFT = '/data/models/Swift-Qwen3.8-27B/Swift-Qwen3.8-27B-Q4_K_L.gguf';

test('profileFacts: ctx, KV, devices (named cards, ids, RPC workers, legacy fields), MTP', async () => {
    const R = await load();
    const f = R.profileFacts('daily-27b', { config: { modelPath: Q4, ctx: 229376, cacheK: 'f16', cacheV: 'f16', specType: 'draft-mtp', specDraftNMax: 2, devices: [XTX, N3060] }, savedAt: 1, lastLoadedAt: 5 });
    assert.equal(f.ctxText, '224k'); assert.equal(f.kv, 'f16');
    assert.equal(f.devicesText, 'RX 7900 XTX 75 · RTX 3060 25'); assert.equal(f.rpc, false);
    assert.equal(f.mtp, true); assert.equal(f.draftN, 2); assert.equal(f.lastUsed, 5);
    assert.equal(f.modelKey, 'local:qwen3.8-27b:q4-k-xl');
    assert.equal(f.file, 'Qwen3.8-27B-UD-Q4_K_XL.gguf');
    // split-model file names drop the -00001-of-00003 (the shared modelname helper)
    assert.equal(R.profileFacts('f', { config: { modelPath: FLASH } }).file, 'Qwen3.8-Flash-Next-UD-Q2_K_XL.gguf');
    // mixed KV, a combined spec type, 1M context
    const g = R.profileFacts('g', { config: { ctx: 1048576, cacheK: 'q8_0', cacheV: 'f16', specType: 'draft-mtp,ngram-map-k4v' } });
    // the one context rule (ui/shared/ctxlabel.js, 2026-10-25): 1048576 reads 1024k, as on the Models page (was '1M' here only)
    assert.equal(g.ctxText, '1024k'); assert.equal(g.kv, 'q8_0/f16'); assert.equal(g.mtp, true);
    assert.equal(R.profileFacts('h', { config: { specType: 'ngram-simple' } }).mtp, false);
    // legacy profile: deviceA + rpcTarget + tensorSplit, no devices list
    const l = R.profileFacts('27b-rpc', { config: { deviceA: 'ROCm0', rpcTarget: 'laptop', tensorSplit: 60 } });
    assert.equal(l.devicesText, 'ROCm0 60 · RPC 40'); assert.equal(l.rpc, true);   // a bare id stays an id: it is never turned into a card
    // bare ids, a disabled row, a worker entry; no shares -> no numbers
    assert.equal(R.profileFacts('i', { config: { devices: [{ id: 'CUDA0' }, { id: 'ROCm0', enabled: false }, { worker: 'laptop-4090' }] } }).devicesText, 'CUDA0 · RPC');
    assert.equal(R.deviceLabel({ id: 'CUDA1', name: 'NVIDIA GeForce RTX 4090 Laptop GPU' }), 'RTX 4090 Laptop');
    assert.equal(R.deviceLabel({ id: 'SYCL0', name: 'Intel(R) Arc(TM) B580 Graphics' }), 'Arc B580');   // a card this code has never heard of
    assert.equal(R.deviceLabel({ id: 'RPC0' }), 'RPC'); assert.equal(R.deviceLabel(null), null);
    // strata profile facts: base config, int8 KV, context parsed; no device list -- it shows what it needs, if it says
    const s = R.profileFacts('bench · Strata Coder IQ1_M · 1M · KV int8 · YaRN×4 (strata engine)', {
        config: { engine: 'strata', strataBase: '/home/kyle/AI/Strata-0.1.32/strata-coder-iq1_m-1m-int8.json' }
    });
    assert.equal(s.ctxText, '1024k');   // the one context rule (2026-10-25)
    assert.equal(s.kv, 'int8');
    assert.equal(s.devicesText, null);
    assert.equal(s.file, 'strata-coder-iq1_m-1m-int8');
    const sn = R.profileFacts('opt · Strata', { config: { engine: 'strata', strataBase: '/x/strata-coder-iq1_m-1m-int8.json', needs: { vendor: 'amd', minVramMib: 24000, hostRamMib: 47000 } } });
    assert.equal(sn.devicesText, 'needs AMD card with 24 GB · 46 GB of memory');
    // 27B XTX-only profile facts: ROCm0 only, q8_0 KV, 128k ctx
    const x = R.profileFacts('bench · Qwen3.8-27B UD-Q4_K_XL · 128k · KV q8_0 · MTP (XTX only)', {
        config: {
            devices: [{ id: 'ROCm0', name: 'AMD Radeon RX 7900 XTX', share: 100 }],
            modelPath: Q4, ctx: 131072, cacheK: 'q8_0', cacheV: 'q8_0', specType: 'draft-mtp', specDraftNMax: 2
        }
    });
    assert.equal(x.devicesText, 'RX 7900 XTX');
    assert.equal(x.kv, 'q8_0');
    assert.equal(x.ctxText, '128k');
    assert.equal(x.mtp, true);
    // an empty / broken entry never throws
    const e = R.profileFacts('empty', undefined);
    assert.equal(e.ctxText, null); assert.equal(e.kv, null); assert.equal(e.devicesText, null); assert.equal(e.modelKey, null);
});

test('profileGroups: grouped by model (same weights through two paths = one group), models best quality first, most recent first inside', async () => {
    const R = await load();
    const store = {
        'q4-a': { config: { modelPath: Q4 }, savedAt: 10, lastLoadedAt: 100 },
        'q4-b': { config: { modelPath: Q4_LOCAL }, savedAt: 200 },            // never loaded: its save time
        'q6': { config: { modelPath: Q6 }, savedAt: 50 },
        'swift': { config: { modelPath: SWIFT }, savedAt: 60 },
        'flash': { config: { modelPath: FLASH }, savedAt: 70 },
        'old-q4': { config: { modelPath: Q4, archived: true }, savedAt: 1 },
        'old-flash': { config: { modelPath: FLASH }, savedAt: 2, obsolete: true },
        'nomodel': { config: {} },
    };
    const names = ['q4-a', 'q4-b', 'q6', 'swift', 'flash', 'old-q4', 'old-flash', 'nomodel', 'not-in-store'];
    // ranked as pickerRows() gives it: Q6 above Q4; Swift and Flash not benchmarked
    const row = (key, display, y, rate) => ({ key, option: { value: key }, model: { key, display }, point: y == null ? null : { key, y, rate, n: 40 } });
    const ranked = {
        rated: [row('local:qwen3.8-27b:q6-k-xl', 'Qwen3.8-27B Q6_K_XL', 0.8, 0.85), row('local:qwen3.8-27b:q4-k-xl', 'Qwen3.8-27B Q4_K_XL', 0.7, 0.75)],
        unrated: [row('local:swift-qwen3.8-27b:q4-k-l', 'Swift-Qwen3.8-27B Q4_K_L', null)],
    };
    const { groups, archived } = R.profileGroups(names, store, ranked);
    assert.deepEqual(groups.map((g) => g.display), ['Qwen3.8-27B Q6_K_XL', 'Qwen3.8-27B Q4_K_XL', 'Qwen3.8-Flash-Next-UD-Q2_K_XL', 'Swift-Qwen3.8-27B Q4_K_L', 'No model set']);
    assert.deepEqual(groups.map((g) => g.rank), [1, 2, null, null, null]);
    assert.deepEqual(groups[1].profiles.map((f) => f.name), ['q4-b', 'q4-a']);   // 200 (saved) beats 100 (loaded)
    assert.deepEqual(groups[4].profiles.map((f) => f.name), ['nomodel', 'not-in-store']);
    // archived / obsolete: pulled out whatever their model, still carrying the model's name
    assert.deepEqual(archived.map((f) => f.name), ['old-flash', 'old-q4']);
    assert.equal(archived[1].display, 'Qwen3.8-27B Q4_K_XL');
    // no quality data at all (catalog failed): still grouped, by name
    const bare = R.profileGroups(['q6', 'q4-a', 'swift'], store, null);
    assert.deepEqual(bare.groups.map((g) => g.display), ['Qwen3.8-27B-UD-Q4_K_XL', 'Qwen3.8-27B-UD-Q6_K_XL', 'Swift-Qwen3.8-27B-Q4_K_L']);
    assert.ok(bare.groups.every((g) => g.rank == null));
});

test('profileMatches: every word somewhere in name, model, ctx, KV, devices or "mtp"', async () => {
    const R = await load();
    const f = R.profileFacts('opt-q4-229k-f16-mtp (stable)', { config: { modelPath: Q4, ctx: 229376, cacheK: 'f16', cacheV: 'f16', specType: 'draft-mtp', devices: [XTX, N3060] } });
    f.display = 'Qwen3.8-27B Q4_K_XL';
    for (const q of ['', 'stable', 'Q4_K_XL', '224k', 'f16', 'xtx 3060', '7900 rtx', 'MTP', 'qwen3.8 stable']) assert.equal(R.profileMatches(f, q), true, q);
    for (const q of ['q6', 'rpc', 'stable q8_0']) assert.equal(R.profileMatches(f, q), false, q);
});

test('the profile picker module mounts only where the select exists and imports what it names', async () => {
    // No DOM here: importing it must not throw when document has no #load-profile-select.
    globalThis.document = { getElementById: () => null };
    try { await import('../ui/profilepicker/index.js'); } finally { delete globalThis.document; }
});

// ---- how each profile fits THIS machine (/api/profiles `availability`, lib/topology.js) ----
const dev = (id, description, totalMib) => ({ id, description, totalMib, freeMib: totalMib });
const XTXN = 'AMD Radeon RX 7900 XTX', R3060N = 'NVIDIA GeForce RTX 3060';
const MACHINES = {
    twoIdentical: [dev('ROCm0', XTXN, 24560), dev('ROCm1', XTXN, 24560), dev('Vulkan0', XTXN + ' (RADV NAVI31)', 24560), dev('Vulkan1', XTXN + ' (RADV NAVI31)', 24560)],
    mixed: [dev('CUDA0', R3060N, 12288), dev('ROCm0', XTXN, 24560)],
    oneCard: [dev('CUDA0', 'NVIDIA GeForce RTX 4090', 24564)],
    cpuOnly: [],
};
const FIT_STORE = {
    'one card': { config: { modelPath: Q4, ctx: 131072, devices: [{ id: 'ROCm0', name: XTXN, share: 100 }] }, lastLoadedAt: 50 },
    'second card': { config: { modelPath: Q4, ctx: 131072, devices: [{ id: 'ROCm1', name: XTXN, share: 100 }] }, lastLoadedAt: 40 },
    'both cards': { config: { modelPath: Q6, ctx: 131072, devices: [{ id: 'ROCm0', name: XTXN, share: 50 }, { id: 'ROCm1', name: XTXN, share: 50 }], argString: '-sm tensor' }, lastLoadedAt: 30 },
    'old split': { config: { modelPath: Q4, ctx: 65536, devices: [XTX, N3060] }, lastLoadedAt: 99 },
    'old split, sized': { config: { modelPath: Q4, ctx: 65536, devices: [{ ...XTX, vramMib: 24560 }, { ...N3060, vramMib: 12288 }] }, lastLoadedAt: 20 },
    'strata': { config: { engine: 'strata', strataBase: '/x/strata-coder-iq1_m-128k-int8.json', needs: { vendor: 'amd', minVramMib: 24000 } }, lastLoadedAt: 10 },
};
// what server4.js profileAvailability sends for a machine
const availabilityOn = (k) => {
    const t = topo.build({ detected: MACHINES[k], hostRamMib: 64200 });
    return Object.fromEntries(Object.entries(FIT_STORE).map(([n, e]) => { const a = topo.availability(e.config, t, { reference: t }); return [n, { status: a.status, reason: a.reason, placement: a.placement }]; }));
};

test('two identical cards: runnable profiles say where they run here; the ones this machine lacks are set apart with the reason', async () => {
    const R = await load();
    const av = availabilityOn('twoIdentical');
    const { groups, archived, unavailable } = R.profileGroups(Object.keys(FIT_STORE), FIT_STORE, null, av);
    const shown = groups.flatMap((g) => g.profiles);
    assert.deepEqual(Object.fromEntries(shown.map((f) => [f.name, [f.devicesText, f.fit.status]])), {
        'one card': ['RX 7900 XTX #1 alone', 'ready'],
        'second card': ['RX 7900 XTX #2 alone', 'ready'],
        'both cards': ['2x RX 7900 XTX, 1:1', 'ready'],
        'old split, sized': ['2x RX 7900 XTX, 3:1', 'substitute'],
        strata: ['needs AMD card with 24 GB', 'ready'],
    });
    // the most recently used profile of all is one this machine cannot run: it is not at the top of anything
    assert.deepEqual(unavailable.map((f) => [f.name, f.fit.reason, f.devicesText]), [['old split', 'Needs RTX 3060.', 'RX 7900 XTX 75 · RTX 3060 25']]);
    assert.deepEqual(archived, []);
    const sub = shown.find((f) => f.name === 'old split, sized');
    assert.match(sub.fit.reason, /RTX 3060 is not in this machine; RX 7900 XTX #2 \(24 GB\) stands in\. Not validated on this machine\./);
    assert.equal(sub.ownDevicesText, 'RX 7900 XTX 75 · RTX 3060 25', 'what it was saved as stays visible');
    // search reaches the placement and the reason
    assert.equal(R.profileMatches(shown.find((f) => f.name === 'second card'), '#2 alone'), true);
    assert.equal(R.profileMatches(unavailable[0], 'needs 3060'), true);
    assert.equal(R.profileMatches(sub, 'stand-in'), true);
});

test('the same profiles on other machines: mixed vendors, one card, no GPU, and a server that says nothing', async () => {
    const R = await load();
    const split = (k) => { const g = R.profileGroups(Object.keys(FIT_STORE), FIT_STORE, null, availabilityOn(k)); return [g.groups.flatMap((x) => x.profiles).map((f) => f.name).sort(), g.unavailable.map((f) => f.name).sort()]; };
    assert.deepEqual(split('mixed'), [['old split', 'old split, sized', 'one card', 'second card', 'strata'], ['both cards']]);
    assert.deepEqual(split('oneCard'), [[], ['both cards', 'old split', 'old split, sized', 'one card', 'second card', 'strata']]);
    assert.deepEqual(split('cpuOnly')[0], []);
    const mixed = R.profileGroups(Object.keys(FIT_STORE), FIT_STORE, null, availabilityOn('mixed'));
    const byName = Object.fromEntries(mixed.groups.flatMap((g) => g.profiles).map((f) => [f.name, f]));
    assert.deepEqual([byName['second card'].fit.status, byName['second card'].devicesText], ['moved', 'RX 7900 XTX alone']);   // ROCm1 there is ROCm0 here
    assert.equal(byName['old split'].devicesText, 'RX 7900 XTX + RTX 3060, 3:1');
    assert.match(mixed.unavailable[0].fit.reason, /^Needs RX 7900 XTX/);
    // an older server (no availability): every profile is listed as before, labelled from its own device names
    for (const none of [undefined, null, {}]) {
        const g = R.profileGroups(Object.keys(FIT_STORE), FIT_STORE, null, none);
        assert.deepEqual(g.unavailable, []);
        assert.equal(g.groups.flatMap((x) => x.profiles).length, 6);
        assert.equal(g.groups.flatMap((x) => x.profiles).find((f) => f.name === 'old split').devicesText, 'RX 7900 XTX 75 · RTX 3060 25');
    }
    // an archived profile stays under archived, whatever its fit
    const arch = R.profileGroups(['old split'], { 'old split': { ...FIT_STORE['old split'], archived: true } }, null, availabilityOn('twoIdentical'));
    assert.deepEqual([arch.archived.length, arch.unavailable.length], [1, 0]);
});

// ---- the modal itself, in a DOM (linkedom): the fit of each profile is drawn, the unrunnable ones are folded ----
test('picker modal: runnable profiles listed with where they run; unrunnable ones folded under what they need; the machine named', async (t) => {
    const { parseHTML } = require('linkedom');
    const { window, document } = parseHTML('<!doctype html><html><head></head><body><select id="load-profile-select"><option value="">Load…</option></select></body></html>');
    const had = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch, localStorage: globalThis.localStorage, MutationObserver: globalThis.MutationObserver, Event: globalThis.Event };
    t.after(() => { for (const k of Object.keys(had)) { if (had[k] === undefined) delete globalThis[k]; else globalThis[k] = had[k]; } });
    // linkedom has no layout or focus: the two calls the picker makes on them are no-ops here
    for (let proto = Object.getPrototypeOf(document.createElement('div')); proto && proto !== Object.prototype; proto = Object.getPrototypeOf(proto)) {
        if (Object.prototype.hasOwnProperty.call(proto, 'setAttribute') || Object.prototype.hasOwnProperty.call(proto, 'getAttribute')) {
            if (!proto.scrollIntoView) proto.scrollIntoView = () => {};
            if (!proto.focus) proto.focus = () => {};
            break;
        }
    }
    const sel = document.getElementById('load-profile-select');
    for (const n of Object.keys(FIT_STORE)) { const o = document.createElement('option'); o.value = n; o.textContent = n; sel.appendChild(o); }
    const machine = topo.build({ detected: MACHINES.twoIdentical, hostRamMib: 64200 });
    let serveFit = true;
    Object.assign(globalThis, { document, window, localStorage: { getItem: () => null, setItem() {} }, Event: window.Event,
        MutationObserver: window.MutationObserver || class { observe() {} } });
    globalThis.fetch = async (url) => {
        const body = String(url).startsWith('/api/profiles')
            ? { version: 3, profiles: FIT_STORE, ...(serveFit ? { availability: availabilityOn('twoIdentical'), topology: machine } : {}) }
            : { error: 'no catalog in this test' };
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => body };
    };
    await import('../ui/profilepicker/index.js?dom');
    const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };
    const open = async () => { document.getElementById('profile-picker-btn').dispatchEvent(new window.Event('click')); await settle(); };
    await open();
    const modal = document.getElementById('pp-modal');
    const rows = () => [...modal.querySelectorAll('.pp-row')].map((r) => r.textContent.replace(/\s+/g, ' ').trim());
    assert.equal(rows().length, 5, 'the five this machine can run');
    assert.ok(rows().some((r) => /second card.*RX 7900 XTX #2 alone/.test(r)));
    assert.ok(rows().some((r) => /both cards.*2x RX 7900 XTX, 1:1/.test(r)));
    assert.ok(rows().some((r) => /old split, sized.*stand-in card.*2x RX 7900 XTX, 3:1.*RTX 3060 is not in this machine/.test(r)), 'a stand-in is marked, with its reason');
    assert.ok(!rows().some((r) => /^old split /.test(r)), 'the profile that needs a card this machine lacks is not among them');
    const fold = modal.querySelector('[data-pp-gone]');
    assert.match(fold.textContent, /Not runnable on this machine \(1\)/);
    assert.match(modal.querySelector('[data-pp-note]').textContent, /This machine: 2x RX 7900 XTX 24G \| 63G RAM/);
    // opening the fold shows it, greyed, with what it needs
    fold.dispatchEvent(new window.Event('click', { bubbles: true }));
    const gone = [...modal.querySelectorAll('.pp-row')].find((r) => /old split —|old split\s/.test(r.textContent) && !/sized/.test(r.textContent));
    assert.ok(gone && /opacity-60/.test(gone.getAttribute('class')));
    assert.match(gone.textContent, /not on this machine[\s\S]*Needs RTX 3060\./);
    // searching for it opens the fold by itself
    modal.querySelector('[data-pp-close]').dispatchEvent(new window.Event('click', { bubbles: true }));
    await open();
    const input = modal.querySelector('[data-pp-search]');
    input.value = 'needs 3060'; input.dispatchEvent(new window.Event('input'));
    assert.deepEqual(rows().length, 1);
    // an older server: no availability, no topology -- every profile listed, nothing folded, no machine line
    modal.querySelector('[data-pp-close]').dispatchEvent(new window.Event('click', { bubbles: true }));
    serveFit = false;
    await open();
    assert.equal(rows().length, 6);
    assert.equal(modal.querySelector('[data-pp-gone]'), null);
    assert.doesNotMatch(modal.querySelector('[data-pp-note]').textContent, /This machine/);
    assert.ok(rows().some((r) => /old split.*RX 7900 XTX 75 · RTX 3060 25/.test(r)), 'labelled from its own device names, as before');
});
