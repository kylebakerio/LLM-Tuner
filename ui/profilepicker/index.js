// The launch panel's saved-profile picker, the model picker's twin (ui/modelpicker/index.js). The
// native <select id="load-profile-select"> stays in the DOM: script.js fills it (renderSavedConfigs),
// reads it (delete, save) and listens to its 'change' (loadLaunchProfile: the form, devices, raw
// command). It is hidden and a button stands in its place. The button opens a modal listing every
// profile the select offers, grouped by model, the models best quality first (the Models page's
// Quality ladder, via the model picker's own ranking), each profile with its context, KV cache,
// devices and MTP. Picking a row sets the select's value and fires the same 'change' the dropdown
// fires, so loading a profile behaves exactly as before.
//
// Each row also says how the profile fits THIS machine (/api/profiles `availability`, lib/topology.js): where it
// runs ("2x RX 7900 XTX, 1:1"), a marker when its device ids were re-pointed or another card stands in, and the
// profiles this machine cannot run folded into their own section with what they need. No card is named in this file.
//
// Read-only: it GETs /api/profiles for the details and never writes the store.

import { esc, catalogStore } from '../benchmarks/util.js';
import { fitFor, ladderPoints, overviewView, overviewCatalog, overviewRowKey } from '../shared/leaderboard.js';
import { pickerRows, speedAt32k, THIN_TASKS, THIN_WIDTH } from '../modelpicker/rank.js';
import { profileGroups, profileMatches, isArchived } from './rows.js';

const select = document.getElementById('load-profile-select');
if (select) mount(select);

function mount(sel) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.id = 'profile-picker-btn';
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.className = 'flex-1 min-w-0 flex items-center gap-2 bg-gray-800 hover:bg-gray-700 border border-indigo-900/60 rounded-md px-2 py-1.5 text-xs text-gray-300 text-left';
    sel.classList.add('hidden');
    sel.after(btn);
    // The label follows the select however its value changes: a pick here, script.js re-rendering
    // the options after a save / delete / load (it sets .value in the same task, so the observer's
    // callback sees the new value).
    const sync = () => {
        const o = sel.selectedOptions && sel.selectedOptions[0];
        const has = o && o.value;
        btn.innerHTML = `<span class="truncate min-w-0 flex-1 ${has ? '' : 'text-gray-500'}">${esc(has ? o.value : 'Load saved profile…')}</span><span class="text-gray-500 shrink-0">▾</span>`;
        btn.title = has ? o.textContent : 'Load a saved profile';
    };
    sel.addEventListener('change', sync);
    new MutationObserver(sync).observe(sel, { childList: true, subtree: true, attributes: true });
    sync();
    const picker = createPicker(sel, () => { sync(); btn.focus(); });
    btn.addEventListener('click', () => picker.open());
}

// ------------------------------------------------------------ data
// The same catalog and fit the model picker ranks with (its facet chips and ladder rate).
// The page's one catalog (ui/benchmarks/util.js catalogStore, 2026-10-06): shared with the Models tab, so opening this
// picker after it costs no request inside the minute, and one "still current?" request (a 304) after that.
const CATALOG_TTL = 60 * 1000;
function loadCatalog() {
    return catalogStore.load({ maxAgeMs: CATALOG_TTL }).then((r) => (r.error ? { error: r.error } : r.catalog));
}
// One quality measure everywhere (2026-09-29): strength /100 -- the fit's rate (ui/shared/leaderboard.js).
const ladderHow = () => 'adjusted';
// -> { profiles, availability, topology }. `availability` / `topology` are absent on an older server: then every
// profile is listed as runnable and nothing is said about the machine.
// `failed`: the request did not answer -- there are then NO details, which is not the same as "no model set".
function loadStore() {
    return fetch('/api/profiles').then((r) => r.json())
        .then((d) => ({ profiles: (d && d.profiles) || {}, availability: (d && d.availability) || null, topology: (d && d.topology) || null, failed: false }))
        .catch(() => ({ profiles: null, availability: null, topology: null, failed: true }));
}
// One picker option per distinct model path the profiles use, ranked like the model picker ranks.
function rankModels(paths, catalog) {
    const options = [...new Set(paths.filter(Boolean))].map((p) => ({ value: p, text: p }));
    if (!catalog || catalog.error) return { ...pickerRows(options, [], []), how: ladderHow(), error: catalog && catalog.error };
    // The Models page's own fit object: the catalog as that page shows it (tensor-split rows and f32ssm copies folded, by
    // its switches) on its chart chips (leaderboard.js overviewView, 2026-10-14). The raw catalog was another fit: a
    // folded model's number differed from the page's (IQ2_XS-mtp 37 here, 59 there) and its copies were rows of their own.
    const v = overviewView(), shown = overviewCatalog(catalog, v);
    const fit = fitFor(shown.models, v.keepQ, v.keepT);
    return { ...pickerRows(options, ladderPoints(fit, fit.qAll, { how: ladderHow(), cost: 'time' }), shown.models, { rowKeyOf: (k) => overviewRowKey(shown, k) }), how: ladderHow() };
}

// ------------------------------------------------------------ formatting
const pct = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
const tps = (v) => (v >= 100 ? Math.round(v).toLocaleString() : v.toFixed(1));
const fmtRel = (v) => `${v < 1 ? v.toFixed(2) : v.toFixed(1)}×`;
function ago(ms) {
    if (!ms) return null;
    const s = (Date.now() - ms) / 1000;
    if (s < 3600) return `${Math.max(1, Math.round(s / 60))} min ago`;
    if (s < 86400) return `${Math.round(s / 3600)} h ago`;
    return `${Math.round(s / 86400)} d ago`;
}

// ------------------------------------------------------------ the modal
function createPicker(sel, onClose) {
    const style = document.createElement('style');
    // Phone: a full-screen sheet. From md up: a centred panel (as the model picker; the vendored
    // Tailwind build is static and lacks most sizing utilities).
    style.textContent = `
      #pp-modal .pp-panel { position: absolute; inset: 0; }
      @media (min-width: 768px) { #pp-modal .pp-panel { inset: auto; left: 50%; top: 5vh; transform: translateX(-50%); width: min(900px, 94vw); max-height: 90vh; border-radius: 0.75rem; } }
      #pp-modal .pp-list { min-height: 0; }
      #pp-modal .pp-row[data-pp-current="1"] { background: rgba(99, 102, 241, 0.12); box-shadow: inset 3px 0 0 #6366f1; }
      #pp-modal .pp-row[data-active="1"] { background: rgba(79, 70, 229, 0.22); box-shadow: inset 3px 0 0 #818cf8; }`;
    document.head.appendChild(style);
    const root = document.createElement('div');
    root.id = 'pp-modal';
    root.className = 'fixed inset-0 bg-black/80 hidden z-50';
    root.innerHTML = `
      <div class="pp-panel bg-gray-900 border border-gray-700 flex flex-col" role="dialog" aria-modal="true" aria-label="Load a saved profile">
        <div class="p-3 border-b border-gray-800 space-y-2">
          <div class="flex items-center gap-2">
            <div class="text-sm font-semibold text-gray-100">Load a saved profile</div>
            <div class="text-[10px] text-gray-500">grouped by model · best quality first</div>
            <button type="button" data-pp-close class="ml-auto px-2 text-gray-500 hover:text-gray-200" aria-label="close">✕</button>
          </div>
          <input data-pp-search type="text" placeholder="filter profiles… (name, model, 128k, q8_0, a card name, rpc, mtp)" autocomplete="off" spellcheck="false"
            class="w-full bg-gray-950 border border-gray-700 rounded px-2 py-1.5 text-sm text-gray-200" />
          <div data-pp-note class="text-[10px] text-gray-500"></div>
        </div>
        <div data-pp-list class="pp-list flex-1 overflow-y-auto"></div>
      </div>`;
    document.body.appendChild(root);
    const input = root.querySelector('[data-pp-search]');
    const list = root.querySelector('[data-pp-list]');
    let store = null, ranked = null, error = null, loading = false;
    let storeFailed = false;   // /api/profiles did not answer: names only, and it says so
    let availability = null, topology = null;   // this machine, from the same /api/profiles response
    let visible = [], active = 0, showArchived = false, showUnavailable = false;

    const names = () => [...sel.options].filter((o) => o.value).map((o) => o.value);
    const badge = (t, cls, { style = '', title = '' } = {}) => `<span class="px-1 rounded text-[9px] shrink-0 ${cls}"${style ? ` style="${style}"` : ''}${title ? ` title="${esc(title)}"` : ''}>${t}</span>`;

    const groupHead = (g) => {
        const r = g.row, p = r && r.point;
        const bits = [];
        if (p) {
            const sc = (v) => (v == null ? '—' : String(Math.round(v * 100)));
            bits.push(`<span class="font-mono text-gray-100" title="strength /100: difficulty-weighted points over the whole corpus, the expected score at the ability its results give it">${sc(p.y)}<span class="text-gray-500">/100</span></span>`);
            bits.push(`<span class="${r.thin ? 'text-amber-300' : ''}">95% ${sc(p.lo)}–${sc(p.hi)}${p.coverage != null ? ` · ${Math.round(p.coverage * 100)}% tested` : ''} · ${p.n} tasks</span>`);
            if (p.relTime != null) bits.push(`<span title="relative solve time (the Models page's time index): 2× = twice as long as a typical config on the same task">${fmtRel(p.relTime)} time</span>`);
        } else if (g.key) bits.push('<span class="text-gray-600">not benchmarked</span>');
        const s = r && r.model ? speedAt32k(r.model) : null;
        if (s) bits.push(`<span class="text-gray-500" title="median t/s at ~32k context depth, fastest launch config for each (at least 3 samples)">pp ${s.prefill ? tps(s.prefill.tps) : '—'} · tg ${s.gen ? tps(s.gen.tps) : '—'} t/s @32k</span>`);
        const thin = r && r.thin ? badge('thin', '', { style: 'background:rgba(120,53,15,0.6);color:#fde68a',
            title: `thin record: under ${THIN_TASKS} tasks or an interval wider than ${Math.round(THIN_WIDTH * 100)} points, so its place could move a lot with more runs` }) : '';
        return `<div class="sticky top-0 z-10 px-3 py-1.5 bg-gray-950 border-b border-gray-800">
          <div class="flex items-center gap-2 min-w-0">
            ${g.rank != null ? `<span class="text-[10px] text-gray-500 font-mono shrink-0">#${g.rank}</span>` : ''}
            <span class="text-xs font-semibold text-gray-200 truncate min-w-0 flex-1">${esc(g.display)}</span>${thin}
            <span class="text-[10px] text-gray-500 shrink-0">${g.profiles.length} profile${g.profiles.length === 1 ? '' : 's'}</span>
          </div>
          ${bits.length ? `<div class="flex flex-wrap gap-x-3 gap-y-0.5 text-[10px] text-gray-400 mt-0.5">${bits.join('')}</div>` : ''}
        </div>`;
    };
    const rowHtml = (f, i, withModel) => {
        const isCur = f.name === sel.value;
        const chip = (t, cls = 'bg-gray-800 text-gray-300', title = '') => `<span class="px-1.5 rounded font-mono ${cls}"${title ? ` title="${esc(title)}"` : ''}>${esc(t)}</span>`;
        const chips = [];
        if (f.ctxText) chips.push(chip(f.ctxText, 'bg-gray-800 text-gray-200', `context ${f.ctx.toLocaleString()} tokens`));
        if (f.kv) chips.push(chip(`KV ${f.kv}`, 'bg-gray-800 text-gray-300', 'KV cache type (K/V)'));
        const fit = f.fit || { status: 'ready', runnable: true, text: '', reason: '' };
        if (f.devicesText) chips.push(chip(f.devicesText, f.rpc ? 'bg-purple-900/50 text-purple-200' : 'bg-gray-800 text-gray-300',
            `${fit.runnable && fit.placement ? 'where it runs on this machine' : 'devices as saved'}${f.ownDevicesText && f.ownDevicesText !== f.devicesText ? ` — saved as ${f.ownDevicesText}` : ''}${f.rpc ? ' · uses an RPC worker' : ''}`));
        // how it fits this machine, when there is something to say
        const fitBadge = fit.status === 'moved' ? badge('ids re-pointed', 'border border-gray-700 text-sky-300', { title: fit.reason })
            : fit.status === 'substitute' ? badge('stand-in card', 'bg-amber-900/40 text-amber-200', { title: `${fit.reason} Its speed and memory fit have not been checked here.` })
            : fit.status === 'unavailable' ? badge('not on this machine', 'bg-red-900/20 text-red-300', { title: fit.reason }) : '';
        if (f.mtp) chips.push(chip(`MTP${f.draftN ? ` ×${f.draftN}` : ''}`, 'bg-green-900/50 text-green-200', 'speculative decoding with the model\'s own MTP head'));
        else if (f.specType) chips.push(chip(f.specType, 'bg-gray-800 text-gray-400', 'speculative decoding type'));
        if (f.cpuMoe) chips.push(chip(`cpu-moe ${f.cpuMoe}`, 'bg-gray-800 text-gray-400', '--n-cpu-moe: expert layers kept on the CPU'));
        const used = ago(f.lastUsed);
        return `<button type="button" class="pp-row w-full text-left px-3 py-2 border-b border-gray-800 hover:bg-gray-800${fit.runnable ? '' : ' opacity-60'}" data-pp-i="${i}"${isCur ? ' data-pp-current="1"' : ''}>
          <div class="flex items-center gap-2 min-w-0">
            <span class="text-sm ${isCur ? 'text-white font-semibold' : 'text-gray-100'} truncate min-w-0 flex-1">${esc(f.name)}</span>
            ${isCur ? badge('current', 'border border-indigo-500 text-indigo-300') : ''}
            ${fitBadge}
            ${f.archived ? badge('archived', 'border border-gray-700 text-gray-500') : ''}
            ${used ? `<span class="text-[10px] text-gray-500 shrink-0" title="last loaded (or saved)">${used}</span>` : ''}
          </div>
          <div class="flex flex-wrap items-center gap-1.5 text-[10px] mt-0.5">${chips.join('')}
            ${withModel ? `<span class="text-gray-400">${esc(f.display)}</span>` : ''}
            ${f.file ? `<span class="text-gray-600 font-mono break-all">${esc(f.file)}</span>` : '<span class="text-amber-300">no model path</span>'}</div>
          ${fit.status !== 'ready' && fit.reason ? `<div class="text-[10px] mt-0.5 ${fit.runnable ? 'text-gray-400' : 'text-red-300'}">${esc(fit.reason)}</div>` : ''}
          ${f.note ? `<div class="text-[10px] text-gray-500 mt-0.5 truncate" title="${esc(f.note)}">${esc(f.note)}</div>` : ''}
        </button>`;
    };

    // A row with nothing but the profile's name: what is drawn while its details are not known.
    const plainRow = (name, i) => `<button type="button" data-pp-i="${i}" data-pp-current="${name === sel.value ? 1 : 0}" class="pp-row w-full text-left px-3 py-1.5 border-b border-gray-800/60 hover:bg-gray-800/60">
          <span class="text-xs text-gray-200">${esc(name)}</span></button>`;

    // Only the list is re-rendered: the search box is never replaced, so typing keeps its focus.
    const paint = () => {
        const q = input.value.trim();
        // No details yet (the first open, before /api/profiles has answered) or none to be had (it did not answer):
        // the names, which are known, and a line saying which it is. Until 2026-10-13 every profile was drawn from an
        // empty store here -- under "No model set", with "no model path" -- for as long as the request took.
        if (!store) {
            const shown = names().filter((n) => !q || n.toLowerCase().includes(q.toLowerCase()));
            visible = shown.map((name) => ({ name }));
            list.innerHTML = `<div class="px-3 py-2 text-[10px] ${storeFailed ? 'text-amber-300' : 'text-gray-500'}">${storeFailed ? 'Profile details could not be loaded (the dashboard did not answer). Names only:' : 'Loading profile details…'}</div>`
                + shown.map((name, i) => plainRow(name, i)).join('');
            if (active >= visible.length) active = Math.max(0, visible.length - 1);
            mark(false);
            return;
        }
        const { groups, archived, unavailable } = profileGroups(names(), store || {}, ranked, availability);
        const shownGroups = groups.map((g) => ({ ...g, profiles: g.profiles.filter((f) => profileMatches(f, q)) })).filter((g) => g.profiles.length);
        const arch = archived.filter((f) => profileMatches(f, q));
        const archOpen = showArchived || (!!q && arch.length > 0);
        // Profiles this machine cannot run as saved: folded away under what they need, opened by a click or a search hit.
        const gone = unavailable.filter((f) => profileMatches(f, q));
        const goneOpen = showUnavailable || (!!q && gone.length > 0);
        visible = [];
        let html = (loading ? '<div class="px-3 py-2 text-[10px] text-gray-500">Loading profile details…</div>' : '')
            + (storeFailed ? '<div class="px-3 py-2 text-[10px] text-amber-300">Could not refresh the profile details (the dashboard did not answer); these are from the last time it did.</div>' : '')
            + (error ? `<div class="px-3 py-2 text-[10px] text-amber-300">No quality data (${esc(error)}); models are listed by name.</div>` : '');
        for (const g of shownGroups) {
            html += groupHead(g);
            for (const f of g.profiles) { html += rowHtml(f, visible.length, false); visible.push(f); }
        }
        if (gone.length) {
            html += `<button type="button" data-pp-gone class="w-full text-left sticky top-0 z-10 px-3 py-1.5 bg-gray-950 border-b border-gray-800 text-[10px] font-semibold uppercase tracking-wider text-gray-500 hover:text-gray-300" title="Saved for hardware this machine does not have. Each says what it needs; picking one asks before loading it.">${goneOpen ? '▾' : '▸'} Not runnable on this machine (${gone.length})</button>`;
            if (goneOpen) for (const f of gone) { html += rowHtml(f, visible.length, true); visible.push(f); }
        }
        if (arch.length) {
            html += `<button type="button" data-pp-arch class="w-full text-left sticky top-0 z-10 px-3 py-1.5 bg-gray-950 border-b border-gray-800 text-[10px] font-semibold uppercase tracking-wider text-gray-500 hover:text-gray-300">${archOpen ? '▾' : '▸'} Archived / obsolete (${arch.length})</button>`;
            if (archOpen) for (const f of arch) { html += rowHtml(f, visible.length, true); visible.push(f); }
        }
        if (!visible.length && !arch.length && !gone.length) html += `<div class="px-3 py-4 text-xs text-gray-500 text-center">${names().length ? 'No profile matches.' : 'No saved profiles yet — Save Profile at the bottom of the panel adds one.'}</div>`;
        list.innerHTML = html;
        if (active >= visible.length) active = Math.max(0, visible.length - 1);
        const note = root.querySelector('[data-pp-note]');
        if (note) note.innerHTML = `Models ordered as the Models page's Quality ladder is set (by strength /100), unbenchmarked models after; inside a model, most recently used first. `
            + 'Picking a profile loads it into the launch form, as the dropdown did. ↑↓ move · Enter loads · Esc closes.'
            + (topology && topology.signature ? ` <span class="text-gray-600" title="This machine, as detected. Each profile shows where it would run here.">This machine: <span class="font-mono">${esc(topology.signature)}</span>.</span>` : '');
        mark(false);
    };
    const mark = (scroll = true) => {
        list.querySelectorAll('.pp-row').forEach((el) => { el.dataset.active = Number(el.dataset.ppI) === active ? '1' : '0'; });
        const el = list.querySelector(`.pp-row[data-pp-i="${active}"]`);
        if (el && scroll) el.scrollIntoView({ block: 'nearest' });
    };
    const pick = (i) => {
        const f = visible[i];
        if (!f) return;
        // A profile this machine cannot run as saved: ask HERE, while the picker is still open. "Cancel" then leaves
        // it open on the same row (asked after closing, as script.js's own load does, declining dropped the user out
        // of the picker). A yes is passed on so the load does not ask a second time.
        const TV = globalThis.TopoView;
        const fit = f.fit || (typeof window.__profileFitOf === 'function' ? window.__profileFitOf(f.name) : null);
        if (fit && fit.runnable === false && sel.value !== f.name) {
            if (!window.confirm(TV && TV.unavailableConfirmText ? TV.unavailableConfirmText(f.name, fit) : `"${f.name}" cannot run on this machine as saved. Load it anyway?`)) { active = i; mark(); input.focus(); return; }
            sel.dataset.unavailableOk = f.name;
        }
        close();
        // exactly what choosing it in the dropdown did: a new value, then 'change' (none for the same one)
        if (sel.value !== f.name && [...sel.options].some((o) => o.value === f.name)) {
            sel.value = f.name;
            sel.dispatchEvent(new Event('change'));
        }
    };
    const close = () => { root.classList.add('hidden'); document.body.style.overflow = ''; onClose(); };
    const focusCurrent = () => {
        const at = visible.findIndex((f) => f.name === sel.value);
        active = at >= 0 ? at : 0; mark();
    };
    const open = () => {
        input.value = '';
        showArchived = false; showUnavailable = false;
        root.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
        loading = true; error = null;
        paint(); focusCurrent();
        input.focus();
        Promise.all([loadStore(), loadCatalog()]).then(([doc, cat]) => {
            storeFailed = !!doc.failed;
            if (doc.failed) { loading = false; if (!root.classList.contains('hidden')) paint(); return; }   // keep what an earlier open loaded, if anything
            const st = doc.profiles;
            store = st; availability = doc.availability; topology = doc.topology;
            // the current profile is one this machine cannot run: open that section, so its highlight is on screen
            if (availability && availability[sel.value] && availability[sel.value].status === 'unavailable') showUnavailable = true;
            // an archived current profile opens the archived section, so its highlight is on screen
            if (st[sel.value] && isArchived(st[sel.value])) showArchived = true;
            const paths = names().map((n) => { const c = (st[n] && st[n].config) || {}; return c.modelPath || c.model || ''; });
            try { ranked = rankModels(paths, cat); error = ranked.error || null; } catch (e) { ranked = null; error = String((e && e.message) || e); }
            loading = false;
            if (root.classList.contains('hidden')) return;
            const keep = visible[active] && visible[active].name;
            paint();
            const at = visible.findIndex((f) => f.name === (keep || sel.value));
            active = at >= 0 ? at : 0; mark();
        });
    };

    input.addEventListener('input', () => { active = 0; paint(); });
    list.addEventListener('click', (e) => {
        if (e.target.closest('[data-pp-arch]')) { showArchived = !showArchived; paint(); return; }
        if (e.target.closest('[data-pp-gone]')) { showUnavailable = !showUnavailable; paint(); return; }
        const b = e.target.closest('.pp-row'); if (b) pick(Number(b.dataset.ppI));
    });
    list.addEventListener('mousemove', (e) => { const b = e.target.closest('.pp-row'); if (b && Number(b.dataset.ppI) !== active) { active = Number(b.dataset.ppI); mark(false); } });
    root.querySelector('[data-pp-close]').addEventListener('click', close);
    root.addEventListener('click', (e) => { if (e.target === root) close(); });
    root.addEventListener('keydown', (e) => {
        // stopPropagation: the page's own Escape handler would also close the phone's launch drawer under it
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(visible.length - 1, active + 1); mark(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, active - 1); mark(); }
        else if (e.key === 'Enter') { e.preventDefault(); pick(active); }
    });
    return { open, close };
}
