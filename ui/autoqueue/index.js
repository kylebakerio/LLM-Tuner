// Bench -> codebench -> Auto queue: the planner's settings, its proposed batch, and the enqueue buttons.
// The planner (ui/shared/planner.js) runs HERE, client-side, on the catalog's global fit (derive.js) every
// time a setting changes; settings persist server-side in logs/autoqueue.json (GET/PUT /api/autoqueue/settings)
// so the planner and the user share one copy. Nothing runs until the user presses "Enqueue" and confirms:
// "Preview script" is a dry run (the server writes the equivalent script to logs/autoqueue-dryrun/ and starts nothing);
// "Enqueue" INSERTS rows into the benchmark queue (Bench -> codebench -> Queue), which the queue runner executes.
import { esc, fmtDur, api, setHtml, catalogStore } from '../benchmarks/util.js';
import { plan, chunkSchedule } from '../shared/planner.js';
import { derive, resolveTasks, plannerCatalog } from './derive.js';

const BTN = 'px-2 py-0.5 rounded border border-gray-700 text-[11px] text-gray-300 hover:bg-gray-800';
const BTN_ON = 'px-2 py-0.5 rounded border border-indigo-500 bg-indigo-600 text-[11px] text-white';
const PRIMARY = 'px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-md text-xs font-semibold';
const DANGER = 'px-3 py-1.5 bg-red-600 hover:bg-red-500 text-white rounded-md text-xs font-semibold';
const INPUT = 'bg-gray-950 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] text-gray-200';
const H = 'text-[10px] font-semibold uppercase tracking-wider text-gray-500';

// Layout the vendored Tailwind build does not carry (its content globs only scan index.html and script.js).
const CSS = `
#cb-view-autoqueue .aq-grid{display:grid;grid-template-columns:minmax(0,1fr);gap:.75rem}
@media (min-width:1100px){#cb-view-autoqueue .aq-grid{grid-template-columns:minmax(0,1fr) minmax(0,1.4fr)}}
#cb-view-autoqueue .aq-row{display:grid;grid-template-columns:1.6rem minmax(0,1fr) auto;gap:.1rem .5rem;align-items:start}
#cb-view-autoqueue .aq-kv{display:grid;grid-template-columns:minmax(0,9rem) minmax(0,1fr) 2.6rem;gap:.25rem .5rem;align-items:center}
#cb-view-autoqueue input[type=range]{width:100%;accent-color:#6366f1}
#cb-view-autoqueue pre{white-space:pre;overflow:auto;max-height:28rem}
#cb-view-autoqueue details>summary{cursor:pointer;list-style:none}
#cb-view-autoqueue details>summary::-webkit-details-marker{display:none}
#cb-view-autoqueue .aq-num{font-variant-numeric:tabular-nums}
#cb-view-autoqueue .aq-strike{text-decoration:line-through;opacity:.5}
`;
function injectCss() {
    if (document.getElementById('aq-style')) return;
    const st = document.createElement('style'); st.id = 'aq-style'; st.textContent = CSS; document.head.appendChild(st);
}

const pct = (p) => `${Math.round(p * 100)}%`;
const mins = (m) => fmtDur(Math.round(m * 60));
const getPath = (o, p) => p.split('.').reduce((a, k) => (a == null ? a : a[k]), o);
function setPath(o, p, v) { const ks = p.split('.'); let x = o; for (const k of ks.slice(0, -1)) x = x[k] = x[k] || {}; x[ks[ks.length - 1]] = v; }
const legKey = (L) => L.model + (L.cascade != null ? `#c${L.cascade}` : '');

export function createAutoQueueView(root) {
    injectCss();
    const st = { catalog: null, settings: null, availability: {}, defaults: null, server: null, derived: null, out: null,
        removed: new Set(), legOrder: null, runOrder: {}, saveTimer: null, saveMsg: '', dry: null, refillDry: null, loading: false, error: null };

    root.innerHTML = `
        <div class="text-[11px] text-gray-400 leading-snug">Proposes the next codebench runs that improve the quality ladder most per hour, from the same global difficulty fit as the Models tab.
            Nothing runs until you press <b>Enqueue</b> and confirm (it adds rows to the <b>Queue</b> view); <b>Preview script</b> is a dry run.</div>
        <div id="aq-status" class="text-[11px] text-gray-500"></div>
        <div class="aq-grid">
            <div id="aq-settings" class="space-y-2 min-w-0"></div>
            <div id="aq-proposal" class="space-y-2 min-w-0"></div>
        </div>`;
    const elStatus = root.querySelector('#aq-status');
    const elSettings = root.querySelector('#aq-settings');
    const elProposal = root.querySelector('#aq-proposal');

    async function load() {
        if (st.loading) return;
        st.loading = true; st.error = null;
        elStatus.textContent = 'loading the catalog and the planner settings…';
        try {
            // the catalog is the page's one copy (util.js catalogStore, 2026-10-06): asked again here, answered 304 when nothing changed
            const [s, srv, cat] = await Promise.all([api('/api/autoqueue/settings'), api('/api/autoqueue/state'), catalogStore.load().then((r) => (r.error ? r : r.catalog))]);
            for (const r of [s, srv, cat]) if (r && r.error) throw new Error(r.error);
            st.settings = s.settings; st.availability = s.availability || {}; st.defaults = s.defaults; st.file = s.file;
            st.server = srv; st.catalog = cat;
            replan(); renderSettings(); renderProposal();
        } catch (e) {
            st.error = e.message;
            elStatus.innerHTML = `<span class="text-red-300">Auto queue could not load: ${esc(e.message)}</span>`;
        } finally { st.loading = false; }
    }
    async function refreshServer() {
        const srv = await api('/api/autoqueue/state');
        if (!srv.error) { st.server = srv; replan(); renderProposal(); }
    }

    // ------------------------------------------------------------ planning
    function planSettings() {
        const s = JSON.parse(JSON.stringify(st.settings));
        s.pins = (s.pins || []).map((p) => ({ ...p, tasks: resolveTasks(p.tasks || [], st.derived.input) }));
        return s;
    }
    // The Models page's fold switches (ui/models/index.js, the same browser storage keys; both fold by default):
    // the planner's "already scored" sets and its fit are taken on the catalog as that page shows it (derive.js plannerCatalog).
    function foldPrefs() {
        const get = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
        return { tensorRows: get('models_tensor_rows_v2') === 'separate' ? 'separate' : 'combine',
            fileQuality: get('models_f32ssm_quality') === 'separate' ? 'separate' : 'merge' };
    }
    function replan() {
        const pending = (st.server && st.server.pending && st.server.pending.byModel) || {};
        st.derived = derive(plannerCatalog(st.catalog, foldPrefs()), st.settings, st.availability, pending, (st.server && st.server.promptTasks) || {});
        st.out = plan(st.derived.input, planSettings());
        st.byId = new Map(st.derived.input.models.map((m) => [m.id, m]));
    }
    /** The proposal after the user's removals and reorders. */
    function editedLegs() {
        let legs = st.out.legs.map((L) => ({ ...L, key: legKey(L), runs: L.runs.filter((r) => !st.removed.has(`${legKey(L)}|${r.task}`)) }));
        for (const L of legs) {
            const ord = st.runOrder[L.key];
            if (ord) L.runs.sort((a, b) => (ord.indexOf(a.task) + 1 || 1e9) - (ord.indexOf(b.task) + 1 || 1e9));
        }
        if (st.legOrder) legs.sort((a, b) => (st.legOrder.indexOf(a.key) + 1 || 1e9) - (st.legOrder.indexOf(b.key) + 1 || 1e9));
        return legs.filter((L) => L.runs.length);
    }
    /** The proposal as the queue rows Enqueue inserts: chunks of `chunkTasks`, interleaved per queue lane (planner chunkSchedule). */
    function queueRows() {
        const legs = editedLegs().map((L) => ({ ...L, queueLane: (st.byId.get(L.model) || {}).queueLane || (L.lane === 'cloud' ? 'cloud' : 'local-gpu') }));
        return chunkSchedule(legs, st.settings.chunkTasks ?? 4);
    }
    const onSettingsChanged = (structural) => {
        replan();
        if (structural) renderSettings();
        renderProposal();
        scheduleSave();
    };
    function scheduleSave() {
        clearTimeout(st.saveTimer);
        st.saveMsg = 'saving…'; paintSaveMsg();
        st.saveTimer = setTimeout(async () => {
            const r = await api('/api/autoqueue/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(st.settings) });
            if (r.error) {
                st.saveMsg = `not saved: ${r.error}`;
                // a lane refill may not be switched on for (paused): untick it, so the rest of the settings still save
                const m = /refill cannot be switched on for ([\w., -]+): the lane is paused/.exec(r.error);
                if (m && st.settings.refill) {
                    const bad = new Set(m[1].split(',').map((x) => x.trim()));
                    st.settings.refill.lanes = (st.settings.refill.lanes || []).filter((l) => !bad.has(l));
                    renderSettings(); scheduleSave();
                    st.saveMsg = `not saved: ${r.error} (unticked it; saving the rest)`;
                }
            }
            else { st.saveMsg = `saved ${new Date().toLocaleTimeString()}`; st.availability = r.availability || st.availability; }
            paintSaveMsg();
        }, 600);
    }
    function paintSaveMsg() {
        const el = root.querySelector('#aq-save'); if (el) { el.textContent = st.saveMsg; el.className = `text-[10px] ${/not saved/.test(st.saveMsg) ? 'text-red-300' : 'text-gray-500'}`; }
    }

    // ------------------------------------------------------------ settings panel
    const slider = (path, label, min, max, step, title) => {
        const v = Number(getPath(st.settings, path));
        return `<label class="aq-kv" title="${esc(title || '')}"><span class="text-[11px] text-gray-400">${esc(label)}</span>
            <input type="range" data-path="${path}" data-kind="range" min="${min}" max="${max}" step="${step}" value="${v}">
            <span class="text-[11px] text-gray-200 font-mono text-right aq-num" data-out="${path}">${v}</span></label>`;
    };
    const num = (path, label, step, title, w = 'w-16') => `<label class="flex items-center gap-1 text-[11px] text-gray-400" title="${esc(title || '')}">${esc(label)}
            <input type="number" step="${step}" data-path="${path}" data-kind="num" value="${esc(getPath(st.settings, path))}" class="${INPUT} ${w}"></label>`;
    const check = (path, label, title) => `<label class="flex items-center gap-1 text-[11px] text-gray-400 cursor-pointer" title="${esc(title || '')}">
            <input type="checkbox" data-path="${path}" data-kind="bool" class="accent-indigo-500" ${getPath(st.settings, path) ? 'checked' : ''}>${esc(label)}</label>`;
    const section = (key, title, body, open = true) => `<details data-key="aq-set-${key}" ${open ? 'open' : ''} class="bg-gray-900/50 border border-gray-800 rounded-lg p-2">
            <summary class="${H}">▸ ${esc(title)}</summary><div class="mt-2 space-y-2">${body}</div></details>`;

    function renderSettings() {
        const s = st.settings;
        // settings saved before 2026-10-18 (or a server not yet restarted) carry no scoring keys: show the planner's defaults
        for (const [k, v] of [['scoring', 'info'], ['timeGamma', 0.4], ['minInfo', 0.02]]) if (s[k] == null) s[k] = v;
        const models = s.models || [];
        const dm = new Map(st.derived.input.models.map((m) => [m.id, m]));
        const rank = new Map((st.out.ranking || []).map((r) => [r.id, r]));
        const roleSel = (m) => `<select data-role="${esc(m.id)}" class="${INPUT}">${['contender', 'scout', 'both', 'ignored'].map((r) => `<option ${m.role === r ? 'selected' : ''}>${r}</option>`).join('')}</select>`;
        const modelRows = models.map((m) => {
            const d = dm.get(m.id) || {}; const av = st.availability[m.id] || {};
            const r = rank.get(m.id);
            const th = r ? `θ ${r.theta.toFixed(2)} ± ${r.se.toFixed(2)}${r.prior === 'family' ? ' <span class="text-yellow-300" title="thin record: starts from its family siblings (family prior)">fam</span>' : ''}` : (d.fitted ? `θ ${d.theta.toFixed(2)} ± ${d.se.toFixed(2)}` : '<span class="text-gray-600">no data</span>');
            return `<div class="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-gray-800 py-1">
                <span class="text-[11px] text-gray-200 w-full min-w-0 truncate" title="${esc(m.catalogKey || '')}">${esc(m.label || m.id)}
                    <span class="text-[10px] text-gray-600">${esc(m.lane === 'cloud' || m.runner === 'claude' ? `cloud · effort ${m.effort || '—'} · ${m.scaffold || ''}` : (m.opencodeModel || ''))}</span></span>
                <span class="text-[10px] text-gray-400 font-mono aq-num flex-1 min-w-0">${th} · n ${d.n || 0} · ${d.relTime ? d.relTime.toFixed(2) + '× time' : '—'}</span>
                ${av.ok === false ? `<span class="text-[10px] text-red-300 break-all w-full" title="${esc(av.reason || '')}">✕ ${esc((av.reason || 'unavailable').replace(/:.*\//, ': …/'))}</span>` : ''}
                ${roleSel(m)}</div>`;
        }).join('');
        const order = (s.cascade && s.cascade.order) || [];
        const cascadeRows = order.map((id, i) => `<div class="flex items-center gap-1 text-[11px] text-gray-300">
                <span class="text-gray-600 w-5">${i}</span><span class="flex-1 min-w-0 truncate">${esc((models.find((m) => m.id === id) || {}).label || id)}${i === 0 ? ' <span class="text-gray-500">(seed: its failures start the cascade)</span>' : ''}</span>
                <button type="button" class="${BTN}" data-cas-up="${i}" ${i === 0 ? 'disabled' : ''}>↑</button><button type="button" class="${BTN}" data-cas-down="${i}" ${i === order.length - 1 ? 'disabled' : ''}>↓</button>
                <button type="button" class="${BTN}" data-cas-del="${i}" title="remove from the cascade">✕</button></div>`).join('')
            + `<div class="flex items-center gap-1"><select data-cas-add class="${INPUT}"><option value="">+ add a stage…</option>${models.filter((m) => !order.includes(m.id)).map((m) => `<option value="${esc(m.id)}">${esc(m.label || m.id)}</option>`).join('')}</select></div>`;
        const pins = (s.pins || []).map((p, i) => {
            const n = resolveTasks(p.tasks || [], st.derived.input).length;
            return `<div class="border border-gray-800 rounded p-2 space-y-1">
                <div class="flex flex-wrap items-center gap-1">
                    <select data-pin="${i}" data-pin-field="model" class="${INPUT}">${models.map((m) => `<option value="${esc(m.id)}" ${m.id === p.model ? 'selected' : ''}>${esc(m.label || m.id)}</option>`).join('')}</select>
                    <label class="flex items-center gap-1 text-[10px] text-gray-400"><input type="checkbox" class="accent-indigo-500" data-pin="${i}" data-pin-field="enabled" ${p.enabled !== false ? 'checked' : ''}>on</label>
                    <label class="flex items-center gap-1 text-[10px] text-gray-400" title="also re-run tasks this config already ran"><input type="checkbox" class="accent-indigo-500" data-pin="${i}" data-pin-field="rerun" ${p.rerun ? 'checked' : ''}>rerun</label>
                    <span class="text-[10px] text-gray-500 aq-num">${n} task${n === 1 ? '' : 's'}</span>
                    <button type="button" class="${BTN} ml-auto" data-pin-del="${i}">✕</button></div>
                <input type="text" data-pin="${i}" data-pin-field="tasks" value="${esc((p.tasks || []).join(' '))}" placeholder="task ids or @discriminating @cascade-bottom @unsolved @untried" class="${INPUT} w-full font-mono">
                <input type="text" data-pin="${i}" data-pin-field="note" value="${esc(p.note || '')}" placeholder="note (shown as the reason)" class="${INPUT} w-full"></div>`;
        }).join('') + `<button type="button" class="${BTN}" data-pin-add>+ pin</button>
            <div class="text-[10px] text-gray-500">Pins run first. Selectors: <span class="font-mono">@discriminating</span> (the local models split on it), <span class="font-mono">@cascade-bottom</span> (every local model that ran it failed), <span class="font-mono">@unsolved</span>, <span class="font-mono">@untried</span>. A task this config already ran is skipped unless “rerun”; tasks a live queue will still run are skipped.</div>`;
        const backlog = ((st.server && st.server.backlog) || []).map((b) => {
            const on = (s.pins || []).some((p) => p.from === b.id);
            return `<label class="flex items-start gap-1.5 text-[11px] ${b.plannable ? 'text-gray-300 cursor-pointer' : 'text-gray-600'}" title="${esc(b.notes)}">
                <input type="checkbox" class="accent-indigo-500 mt-0.5" data-backlog="${esc(b.id)}" ${on ? 'checked' : ''} ${b.plannable ? '' : 'disabled'}>
                <span class="min-w-0"><span class="font-mono text-gray-500">${esc(b.id)}</span> ${esc(b.title)} <span class="text-[10px] text-gray-500">— ${esc(b.status)}${b.plannable ? ` · pins ${b.pins.map((p) => `${esc(p.model)} ${esc(p.tasks.join(' '))}`).join(', ')}` : ' · nothing the planner can run yet'}</span></span></label>`;
        }).join('') || '<div class="text-[11px] text-gray-600">no open items found in EXPERIMENTS.md</div>';
        const taskB = Object.entries((s.priors && s.priors.taskB) || {}).map(([k, v]) => `${k}=${v}`).join('\n');

        setHtml(elSettings, `
            <div class="flex items-center justify-between"><span class="${H}">Settings</span>
                <span class="flex items-center gap-2"><span id="aq-save" class="text-[10px] text-gray-500">${esc(st.saveMsg || '')}</span>
                <button type="button" class="${BTN}" data-reset title="restore the default settings (models, roles, weights, cascade); pins are kept">defaults</button></span></div>
            ${section('strategy', 'Strategy', `
                <div class="flex flex-wrap gap-1">${[['greedy', 'information-greedy'], ['cascade', 'cascade (your scaffold)'], ['blend', 'blend']].map(([k, l]) =>
                    `<button type="button" data-strat="${k}" class="${s.strategy === k ? BTN_ON : BTN}">${l}</button>`).join('')}</div>
                ${s.strategy === 'blend' ? slider('blendShare', 'cascade share of local budget', 0, 1, 0.05) : ''}
                <div class="text-[10px] text-gray-500">Cascade: each stage runs what the previous stage failed (decided at run time from the DB, like queue15). Greedy: the scoring below. Blend: the cascade gets its share of the local hours first, greedy fills the rest.</div>
                <div class="flex flex-wrap items-center gap-x-2 gap-y-1 pt-1 border-t border-gray-800">${check('rerunScored', 'include re-runs', 'also propose tasks a config already ran at its benchmark config (a tensor-split run or an f32ssm copy counts as that config). Off: one run per task per config.')}
                    <span class="text-[10px] text-gray-500">${s.rerunScored ? 'on: tasks a config already ran can be proposed again (priced by the repeat discount)' : 'off (default): a task a config already ran is never proposed for it again; pins have their own “rerun”'}</span></div>`)}
            ${section('focus', `Focus set${(s.focus || []).length ? ` (${(s.focus || []).length})` : ''}`, focusHtml())}
            ${section('refill', `Continuous refill${s.refill && s.refill.enabled ? ' — ON' : ' — off'}`, refillHtml(), !!(s.refill && s.refill.enabled))}
            ${section('score', `Scoring — ${s.scoring === 'legacy' ? 'legacy objectives' : 'information first'}`, `
                <div class="flex flex-wrap gap-1">${[['info', 'information first (default)'], ['legacy', 'legacy objectives']].map(([k, l]) =>
                    `<button type="button" data-scoring="${k}" class="${(s.scoring || 'info') === k ? BTN_ON : BTN}">${l}</button>`).join('')}</div>
                ${(s.scoring || 'info') === 'legacy' ? '<div class="text-[10px] text-gray-500">Legacy: the weighted TOP / SPEED / DIFFICULTY value below, per minute.</div>' : `
                <div class="text-[10px] text-gray-500">Each candidate run scores <span class="font-mono">info ÷ minutes^γ</span>: info = a²·p(1−p), the Fisher information one run gives about the config’s ability, with p the leaderboard fit’s own predicted pass (2PL, the config’s ability ± its uncertainty) — highest where the outcome is a coin flip; minutes = the task’s median wall time scaled by the config’s speed. γ = 0.4: 8× the minutes costs 2.3× the score, so a p 0.5 task at 40 min beats a p 0.95 task at 5 min.</div>
                ${slider('timeGamma', 'time exponent γ', 0, 1, 0.05, 'score = info / minutes^γ; 0 = time ignored, 1 = per minute (the legacy weighting)')}
                ${slider('minInfo', 'min information per run', 0, 0.1, 0.005, 'a run whose information a²·p(1−p) is below this is not proposed (0.02 ≈ p 0.98 at a = 1)')}`}`)}
            ${section('weights', 'Objectives (legacy scoring)', `
                ${slider('weights.top', 'TOP: separate the leaders', 0, 3, 0.1, 'variance a run removes from a top model’s ability × how much its interval overlaps the leader / its ladder neighbours')}
                ${slider('weights.speed', 'SPEED: head-to-head time', 0, 3, 0.1, 'p(solve) × how far each pair of top models is from enough shared solved tasks to price their wall-time step')}
                ${slider('weights.difficulty', 'DIFFICULTY: calibrate tasks', 0, 3, 0.1, 'variance a run removes from a task’s difficulty × closeness of that difficulty to the top models’ ability')}`)}
            ${section('budget', 'Budget', `
                <div class="flex flex-wrap gap-x-3 gap-y-1">${num('budget.localHours', 'local hours', 0.5)} ${num('budget.switchMin', 'model switch (min)', 1, 'a local server is launched per leg: charged once per leg, so runs batch per model')}</div>
                <div class="flex flex-wrap gap-x-3 gap-y-1">${check('budget.cloud', 'cloud lane (runs in parallel)')} ${num('budget.cloudHours', 'cloud hours', 0.5)}</div>`)}
            ${section('scoring', 'Scoring details', `
                ${slider('repeatDiscount', 'repeat discount', 0, 1, 0.05, 'information of a run × this, per earlier attempt of the same (model, task): repeats are correlated')}
                ${slider('roleBias', 'off-role factor', 0, 1, 0.05, 'TOP/SPEED for non-contenders and DIFFICULTY on untried tasks for non-scouts are multiplied by this')}
                ${slider('minValue', 'min value per run', 0, 0.5, 0.01, 'a run whose weighted value is below this is not proposed at any cost')}
                <div class="flex flex-wrap gap-x-3 gap-y-1">${num('topK', 'top K', 1, 'how many local models count as “the top” for TOP / SPEED', 'w-12')}
                    ${num('validity.minStrong', 'validity flag after', 1, 'a task unsolved after this many strong attempts is flagged for a validity check instead of more runs', 'w-12')}
                    ${num('validity.strongGap', 'strong = within', 0.1, 'an attempt is strong when the model’s ability is within this many logits of the leader', 'w-16')}
                    ${num('focusWidth', 'focus width', 0.1, 'DIFFICULTY weights tasks by exp(-(b - θtop)² / 2w²)', 'w-16')}</div>`, false)}
            ${section('priors', 'Priors', `
                <div class="flex flex-wrap gap-x-3 gap-y-1">${check('priors.family', 'family correlation', 'quants of the same weights start from their siblings’ ability (only models with a thin record)')}
                    ${num('priors.familyTau', 'family sd', 0.1, 'how far a quant may sit from its family, in logits', 'w-16')}
                    ${num('priors.familyMinN', 'thin below n', 1, 'records with fewer scored tasks get the family prior', 'w-12')}</div>
                ${slider('priors.untriedB', 'untried task difficulty', -1, 4, 0.1, 'prior difficulty of a task nobody ran (logits above the average task; the top models sit around +2)')}
                <label class="block text-[11px] text-gray-400">per-task prior difficulty (<span class="font-mono">task=b</span>, one per line)
                    <textarea data-taskb rows="2" class="${INPUT} w-full font-mono">${esc(taskB)}</textarea></label>`, false)}
            ${section('models', 'Models & roles', `<div class="text-[10px] text-gray-500">scouts shake down untried / uncertain tasks (DIFFICULTY); contenders are ranked and timed (TOP / SPEED); ignored models only inform the fit.</div>${modelRows}`)}
            ${section('cascade', 'Cascade order', cascadeRows, s.strategy !== 'greedy')}
            ${section('pins', 'Pins', pins)}
            ${section('backlog', 'Backlog (EXPERIMENTS.md)', `<div class="text-[10px] text-gray-500">Tick an open item to add its suggested pins.</div>${backlog}`, false)}
        `);
        wireSettings();
    }

    // ------------------------------------------------------------ focus set + refill (2026-10-15)
    function focusHtml() {
        const s = st.settings; const models = s.models || [];
        const on = new Set((s.focus || []).map((f) => `${f.model}|${(f.promptLevel || 'L2').toUpperCase()}`));
        const dm = new Map(st.derived.input.models.map((m) => [m.id, m]));
        const rows = models.filter((m) => m.lane !== 'cloud' && m.runner !== 'claude').map((m) => {
            const d = dm.get(m.id) || {};
            const box = (lvl) => `<label class="flex items-center gap-1 text-[10px] text-gray-400 cursor-pointer" title="plan for ${esc(m.label || m.id)} at prompt level ${lvl}${lvl === 'L3' ? ' (its own config: only tasks with a prompt-L3.md)' : ''}">
                <input type="checkbox" class="accent-indigo-500" data-focus="${esc(m.id)}|${lvl}" ${on.has(`${m.id}|${lvl}`) ? 'checked' : ''}>${lvl}</label>`;
            return `<div class="flex items-center gap-2 border-b border-gray-800 py-0.5">
                <span class="text-[11px] text-gray-300 flex-1 min-w-0 truncate" title="${esc(m.catalogKey || '')}">${esc(m.label || m.id)}</span>
                <span class="text-[10px] text-gray-500 font-mono aq-num" title="strength coverage: share of the 100 difficulty-weighted points it has a result for at its config (every row of that identity: KV variants, long-cap runs that finished inside 2 h) — what balancing uses. In brackets: the Models page's “% tested” for its main row.">${d.coverage != null ? `${Math.round(d.coverage * 100)}%` : ''}${d.fitCoverage != null ? ` (${Math.round(d.fitCoverage * 100)})` : ''}</span>
                <span class="text-[10px] text-gray-600 font-mono">${esc(m.queueLane || 'local-gpu')}</span>${box('L2')}${box('L3')}</div>`;
        }).join('');
        return `<div class="text-[10px] text-gray-500">Only focus configs get proposed runs (pins still run). Runs stay the most informative ones; the balance below weights configs that are behind on <b>strength coverage</b> (the share of the 100 difficulty-weighted points a config has actually run) by (1 + points behind / 10)^balance, so they catch up. L3 is its own config (prompt level is part of the identity).</div>
            ${slider('balance', 'balance strength', 0, 3, 0.1, 'f = (1 + max(0, C* - C) / 10)^balance, C in points (0-100), C* = the best-covered focus config; 0 = off')}
            <div class="flex flex-wrap gap-x-3 gap-y-1">${num('chunkTasks', 'tasks per queue row', 1, 'each config’s runs are cut into rows of this many tasks and the rows of a lane are interleaved (A, B, A, B …); 0 = one row per config', 'w-12')}
                ${(s.focus || []).length ? `<button type="button" class="${BTN}" data-focus-clear>clear focus</button>` : ''}</div>
            <div class="max-h-64 overflow-auto">${rows}</div>`;
    }
    function refillHtml() {
        const s = st.settings; const R = s.refill || {};
        const lanes = (st.server && st.server.queueLanes) || ['local-gpu', 'local-rocm1', 'laptop-4090', 'laptop-3060'];
        const focusLanes = new Set((st.out.coverage || []).map((c) => c.queueLane));
        const laneBoxes = lanes.map((l) => `<label class="flex items-center gap-1 text-[11px] text-gray-400 cursor-pointer"><input type="checkbox" class="accent-indigo-500" data-refill-lane="${esc(l)}" ${(R.lanes || []).includes(l) ? 'checked' : ''}>${esc(l)}${focusLanes.has(l) ? '' : ' <span class="text-gray-600">(no focus config)</span>'}</label>`).join('');
        const d = st.refillDry;
        const dry = !d ? '' : d.loading ? '<div class="text-[11px] text-gray-500">asking the server…</div>' : d.error ? `<div class="text-[11px] text-red-300">${esc(d.error)}</div>`
            : `<div class="space-y-1">${d.note ? `<div class="text-[11px] text-yellow-300">${esc(d.note)}</div>` : ''}${(d.lanes || []).map((L) => `<div class="border-t border-gray-800 pt-1">
                <div class="text-[11px] ${L.action === 'fill' ? 'text-gray-200' : 'text-gray-500'}"><span class="font-mono">${esc(L.lane)}</span>${L.refill ? '' : ' <span class="text-gray-600">(not in refill lanes)</span>'} — ${esc(L.reason)}</div>
                ${(L.chunks || []).map((c, i) => `<div class="text-[10px] text-gray-400 font-mono break-all">${i + 1}. ${esc(c.label)} [${c.chunk}/${c.chunks}] ${c.runs && c.runs.length && c.runs[0].info != null
                    ? c.runs.map((r) => `<span title="p ${pct(r.p)} · I ${r.info} · ~${r.minutes} min · score ${r.score}">${esc(r.task)} <span class="text-gray-600">(${pct(r.p)}, I ${Number(r.info).toFixed(2)}, ${r.minutes}m)</span></span>`).join(' ')
                    : esc(c.tasks.join(' '))} ~${c.minutes} min</div>`).join('')}
                ${L.alreadyQueued && L.alreadyQueued.length ? `<div class="text-[10px] text-yellow-300">guard drops ${L.alreadyQueued.length} already queued</div>` : ''}
                ${L.pendingContinuation && L.pendingContinuation.length ? `<div class="text-[10px] text-gray-300">guard holds ${L.pendingContinuation.length} unfinished (awaiting a continuation, not run fresh): <span class="font-mono">${esc(L.pendingContinuation.map((d) => d.task).join(' '))}</span></div>` : ''}</div>`).join('')}</div>`;
        return `<div class="text-[10px] text-gray-500">Off by default. When on, the server checks every <i>interval</i>: a ticked lane whose pending planner rows estimate under <i>refill below</i> gets the planner's next <i>top up</i> hours for the focus configs on that lane, as interleaved rows. Paused lanes are skipped (and cannot be ticked while paused); the cloud lane is never refilled; nothing already run or already queued at the same config is added.</div>
            <div class="flex flex-wrap gap-x-3 gap-y-1">${check('refill.enabled', 'refill on')} ${num('refill.minHours', 'refill below (h)', 0.5, '', 'w-16')} ${num('refill.topUpHours', 'top up (h)', 0.5, '', 'w-16')} ${num('refill.intervalMin', 'interval (min)', 1, '', 'w-16')}</div>
            <div class="flex flex-wrap gap-x-3 gap-y-1">${laneBoxes}</div>
            <div><button type="button" class="${BTN}" data-refill-dry title="what refill would insert right now (writes nothing)">dry run refill</button></div>${dry}`;
    }

    function wireSettings() {
        const s = st.settings;
        elSettings.querySelectorAll('[data-path]').forEach((el) => {
            const kind = el.dataset.kind, p = el.dataset.path;
            const ev = kind === 'range' ? 'input' : 'change';
            el.addEventListener(ev, () => {
                const v = kind === 'bool' ? el.checked : Number(el.value);
                if (kind !== 'bool' && !Number.isFinite(v)) return;
                setPath(s, p, v);
                const out = elSettings.querySelector(`[data-out="${p}"]`); if (out) out.textContent = String(v);
                onSettingsChanged(p === 'rerunScored' || p === 'refill.enabled');
            });
        });
        elSettings.querySelectorAll('[data-strat]').forEach((b) => b.addEventListener('click', () => { s.strategy = b.dataset.strat; resetEdits(); onSettingsChanged(true); }));
        elSettings.querySelectorAll('[data-scoring]').forEach((b) => b.addEventListener('click', () => { s.scoring = b.dataset.scoring; resetEdits(); onSettingsChanged(true); }));
        // focus set: one checkbox per config and prompt level
        elSettings.querySelectorAll('[data-focus]').forEach((el) => el.addEventListener('change', () => {
            const [id, lvl] = el.dataset.focus.split('|');
            const key = (f) => `${f.model}|${(f.promptLevel || 'L2').toUpperCase()}`;
            s.focus = (s.focus || []).filter((f) => key(f) !== `${id}|${lvl}`);
            if (el.checked) s.focus.push(lvl === 'L2' ? { model: id } : { model: id, promptLevel: lvl });
            resetEdits(); onSettingsChanged(true);
        }));
        elSettings.querySelector('[data-focus-clear]')?.addEventListener('click', () => { s.focus = []; resetEdits(); onSettingsChanged(true); });
        elSettings.querySelectorAll('[data-refill-lane]').forEach((el) => el.addEventListener('change', () => {
            s.refill = s.refill || {};
            const lanes = new Set(s.refill.lanes || []);
            if (el.checked) lanes.add(el.dataset.refillLane); else lanes.delete(el.dataset.refillLane);
            s.refill.lanes = [...lanes]; onSettingsChanged(true);
        }));
        elSettings.querySelector('[data-refill-dry]')?.addEventListener('click', async () => {
            st.refillDry = { loading: true }; renderSettings();
            st.refillDry = await api('/api/autoqueue/refill'); renderSettings();
        });
        elSettings.querySelectorAll('[data-role]').forEach((el) => el.addEventListener('change', () => {
            const m = s.models.find((x) => x.id === el.dataset.role); if (m) m.role = el.value; onSettingsChanged(true);
        }));
        const order = s.cascade.order;
        const mv = (i, j) => { const t = order[i]; order[i] = order[j]; order[j] = t; onSettingsChanged(true); };
        elSettings.querySelectorAll('[data-cas-up]').forEach((b) => b.addEventListener('click', () => { const i = Number(b.dataset.casUp); if (i > 0) mv(i, i - 1); }));
        elSettings.querySelectorAll('[data-cas-down]').forEach((b) => b.addEventListener('click', () => { const i = Number(b.dataset.casDown); if (i < order.length - 1) mv(i, i + 1); }));
        elSettings.querySelectorAll('[data-cas-del]').forEach((b) => b.addEventListener('click', () => { order.splice(Number(b.dataset.casDel), 1); onSettingsChanged(true); }));
        elSettings.querySelector('[data-cas-add]')?.addEventListener('change', (e) => { if (e.target.value) { order.push(e.target.value); onSettingsChanged(true); } });
        elSettings.querySelectorAll('[data-pin]').forEach((el) => el.addEventListener('change', () => {
            const p = s.pins[Number(el.dataset.pin)]; const f = el.dataset.pinField;
            if (f === 'enabled' || f === 'rerun') p[f] = el.checked;
            else if (f === 'tasks') p.tasks = el.value.split(/[\s,]+/).filter(Boolean);
            else p[f] = el.value;
            onSettingsChanged(true);
        }));
        elSettings.querySelectorAll('[data-pin-del]').forEach((b) => b.addEventListener('click', () => { s.pins.splice(Number(b.dataset.pinDel), 1); onSettingsChanged(true); }));
        elSettings.querySelector('[data-pin-add]')?.addEventListener('click', () => {
            const first = (s.models.find((m) => m.role !== 'ignored') || s.models[0] || {}).id;
            s.pins.push({ model: first, tasks: ['@discriminating'], note: '', enabled: true }); onSettingsChanged(true);
        });
        elSettings.querySelectorAll('[data-backlog]').forEach((el) => el.addEventListener('change', () => {
            const item = ((st.server && st.server.backlog) || []).find((b) => b.id === el.dataset.backlog); if (!item) return;
            s.pins = (s.pins || []).filter((p) => p.from !== item.id);
            if (el.checked) for (const p of item.pins) s.pins.push({ model: p.model, tasks: p.tasks.slice(), note: `${item.id}: ${item.title}`.slice(0, 80), enabled: true, from: item.id });
            onSettingsChanged(true);
        }));
        elSettings.querySelector('[data-taskb]')?.addEventListener('change', (e) => {
            const o = {};
            for (const line of e.target.value.split('\n')) { const m = /^\s*([\w.-]+)\s*[=:]\s*(-?[\d.]+)\s*$/.exec(line); if (m) o[m[1]] = Number(m[2]); }
            s.priors.taskB = o; onSettingsChanged(false);
        });
        elSettings.querySelector('[data-reset]')?.addEventListener('click', () => {
            if (!st.defaults) return;
            const pins = s.pins;
            st.settings = { ...JSON.parse(JSON.stringify(st.defaults)), pins };
            resetEdits(); onSettingsChanged(true);
        });
    }
    function resetEdits() { st.removed.clear(); st.legOrder = null; st.runOrder = {}; }

    // ------------------------------------------------------------ proposal panel
    function renderProposal() {
        const out = st.out; const legs = editedLegs();
        const s = st.settings;
        const tot = { local: { runs: 0, min: 0, legs: 0 }, cloud: { runs: 0, min: 0, legs: 0 } };
        for (const L of legs) { const T = tot[L.lane] || tot.local; T.legs++; T.runs += L.runs.length; T.min += L.runs.reduce((a, r) => a + (r.expMinutes != null ? r.expMinutes : r.minutes), 0) + (L.lane === 'local' ? s.budget.switchMin : 0); }
        const chain = st.server && st.server.chain;
        const pend = (st.server && st.server.pending) || { queues: [] };
        const pendTxt = pend.queues.map((q) => `${esc(q.name)}: ${q.legs.map((l) => `${esc(((st.byId.get(l.model) || {}).label) || l.om || '?')} ${l.tasks.length}`).join(', ') || 'nothing left'}`).join(' · ');
        elStatus.innerHTML = chain
            ? `Enqueue appends the batch to the <b>Queue</b> (Bench → codebench → Queue) as rows of ${esc(String(s.chunkTasks ?? 4))} tasks interleaved per lane (each config's own lane: local-gpu unless it names one), after whatever is already pending there; cloud rows go in <b>held</b> until Kyle releases them.${chain.waitFor ? ` <span class="text-yellow-300">⚠ queue${chain.waitFor}.sh is still running: the GPU lane waits for it.</span>` : ''}
               ${pendTxt ? `<span class="text-gray-600">Still queued, never re-proposed — ${pendTxt}.</span>` : ''}`
            : '';
        const removedN = st.removed.size;
        const legHtml = legs.map((L, li) => {
            const m = st.byId.get(L.model) || {};
            const lm = L.runs.reduce((a, r) => a + (r.expMinutes != null ? r.expMinutes : r.minutes), 0);
            const chip = (t, cls) => `<span class="px-1.5 py-0.5 rounded text-[10px] ${cls}">${t}</span>`;
            return `<details open data-key="leg:${esc(L.key)}" class="bg-gray-900/50 border border-gray-800 rounded-lg">
                <summary class="flex flex-wrap items-center gap-1 px-2 py-1.5">
                    <span class="text-gray-600 text-[11px] w-5">${li + 1}</span>
                    <span class="text-xs text-gray-200 font-semibold min-w-0 break-words" style="flex:1 1 12rem">${esc(m.label || L.model)}</span>
                    ${L.lane === 'cloud' ? chip('cloud lane', 'bg-indigo-600/20 text-indigo-300') : chip('local', 'bg-gray-800 text-gray-400')}
                    ${L.cascade != null ? chip(`cascade stage ${L.cascade}`, 'bg-yellow-900/40 text-yellow-300') : ''}
                    ${L.runs.some((r) => r.pinned) ? chip('pinned', 'bg-green-900/40 text-green-300') : ''}
                    <span class="text-[10px] text-gray-400 aq-num">${L.runs.length} run${L.runs.length === 1 ? '' : 's'} · ~${mins(lm)}</span>
                    ${L.cascade == null ? `<button type="button" class="${BTN}" data-leg-up="${esc(L.key)}" title="move leg up">↑</button><button type="button" class="${BTN}" data-leg-down="${esc(L.key)}" title="move leg down">↓</button>` : ''}
                    <button type="button" class="${BTN}" data-leg-del="${esc(L.key)}" title="remove the whole leg">✕</button>
                </summary>
                <div class="px-2 pb-2 space-y-1">${L.runs.map((r, ri) => `
                    <div class="aq-row border-t border-gray-800 pt-1">
                        <span class="text-[10px] text-gray-600 aq-num">${ri + 1}</span>
                        <div class="min-w-0">
                            <div class="text-[11px] text-gray-200 font-mono break-all">${esc(r.task)}</div>
                            <div class="text-[10px] text-gray-400 leading-snug">${esc(r.reason)}${r.reach != null && r.reach < 0.999 ? ` <span class="text-gray-600">(expected ${Math.round(r.expMinutes)} min)</span>` : ''}</div>
                        </div>
                        <span class="flex items-center gap-1">
                            <span class="text-[11px] font-mono aq-num ${r.p >= 0.7 ? 'text-green-300' : r.p >= 0.35 ? 'text-yellow-300' : 'text-orange-300'}" title="predicted pass probability">${pct(r.p)}</span>
                            ${r.info != null ? `<span class="text-[10px] font-mono aq-num text-gray-400" title="information a²·p(1−p) of this run about the config's ability (score ${r.score != null ? r.score.toFixed(4) : '?'})">I ${r.info.toFixed(2)}</span>` : ''}
                            ${L.cascade == null ? `<button type="button" class="${BTN}" data-run-up="${esc(L.key)}|${esc(r.task)}" title="earlier in the leg">↑</button>` : ''}
                            <button type="button" class="${BTN}" data-run-del="${esc(L.key)}|${esc(r.task)}" title="remove">✕</button></span>
                    </div>`).join('')}</div></details>`;
        }).join('');
        const cov = (out.coverage || []);
        const covHtml = cov.length ? `<details open data-key="aq-coverage" class="bg-gray-900/50 border border-gray-800 rounded-lg p-2"><summary class="${H}">▸ focus: strength coverage (now → after this batch)</summary>
            <div class="mt-1 space-y-0.5">${cov.map((c) => `<div class="flex items-center gap-2 text-[11px]"><span class="flex-1 min-w-0 truncate text-gray-200">${esc(c.label)}</span>
                <span class="font-mono aq-num text-gray-400" title="ran at its config (every row of that identity): what balancing uses">${Math.round(c.current * 100)}%</span>
                ${(st.byId.get(c.model) || {}).fitCoverage != null ? `<span class="font-mono aq-num text-gray-600" title="the Models page's % tested for its main row (one KV type, the 2 h cap)">(page ${Math.round(st.byId.get(c.model).fitCoverage * 100)})</span>` : ''}
                ${c.pending > 0.0049 ? `<span class="font-mono aq-num text-gray-500" title="already queued for it">+${Math.round(c.pending * 100)} queued</span>` : ''}
                ${((st.byId.get(c.model) || {}).pendingContinuation || []).length ? `<span class="font-mono aq-num text-gray-300" title="unfinished: these runs stopped to ask a question, and their saved sessions wait for a continuation with the original prompt -- counted as covered, never proposed fresh: ${esc(st.byId.get(c.model).pendingContinuation.join(', '))}">${st.byId.get(c.model).pendingContinuation.length} awaiting continuation</span>` : ''}
                <span class="font-mono aq-num text-indigo-300" title="after this batch">→ ${Math.round(c.projected * 100)}%</span>
                <span class="text-[10px] text-gray-500 w-16 text-right">${c.runs} run${c.runs === 1 ? '' : 's'}</span></div>`).join('')}</div>
            <div class="text-[10px] text-gray-500 mt-1">Coverage = share of the fit’s 100 difficulty-weighted strength points the config has a result for at its config identity (all its rows: KV types, long-cap runs inside 2 h; untried tasks carry none) — this drives the balance. “page” = the Models page’s % tested for the config’s main row, which only grows when new runs use that row’s launch (KV type). Balance ${esc(String(s.balance ?? 1))}.</div></details>` : '';
        const rowsQ = queueRows();
        const rowsHtml = rowsQ.length ? `<details data-key="aq-rows" class="bg-gray-900/50 border border-gray-800 rounded-lg p-2"><summary class="${H}">▸ queue rows Enqueue inserts (${rowsQ.length}, ${esc(String(s.chunkTasks ?? 4))} tasks a row, interleaved per lane)</summary>
            <div class="mt-1 space-y-0.5">${rowsQ.map((r, i) => `<div class="text-[10px] text-gray-400 font-mono break-all"><span class="text-gray-600">${i + 1}</span> ${esc(r.queueLane)} · ${esc(r.label || r.model)}${r.cascade != null ? ` (cascade ${r.cascade})` : ` [${r.chunk}/${r.chunks}]`}${r.queueLane === 'cloud' ? ' <span class="text-yellow-300">held for Kyle’s OK</span>' : ''}: ${esc(r.runs.map((x) => x.task).join(' '))}</div>`).join('')}</div></details>` : '';
        const flagged = (out.flagged || []).map((f) => `<div class="text-[11px]"><span class="font-mono text-yellow-300 break-all">${esc(f.task)}</span> <span class="text-gray-400">— ${esc(f.reason)}</span></div>`).join('');
        const ranking = (out.ranking || []).map((r, i) => `<div class="flex items-center gap-2 text-[11px] ${r.top ? 'text-gray-200' : 'text-gray-500'}">
                <span class="w-5 text-gray-600">${i + 1}</span><span class="flex-1 min-w-0 truncate">${esc(r.label)}</span>
                <span class="font-mono aq-num">${r.theta.toFixed(2)} ± ${r.se.toFixed(2)}</span>${r.top ? '<span class="text-[10px] text-indigo-300">top</span>' : '<span class="text-[10px] w-5"></span>'}</div>`).join('');
        const batches = ((st.server && st.server.batches) || []).map((b) => `<div class="text-[11px] text-gray-300 border-t border-gray-800 pt-1">
                <span class="font-mono">${b.n ? `queue${b.n}` : `rows ${(b.items || []).map((x) => `#${x}`).join(' ')}`}</span> <span class="text-gray-500">${esc(new Date(b.at).toLocaleString())}${b.waitFor ? ` · after queue${b.waitFor}` : ''}</span>
                ${b.queueState ? `<span class="${b.queueState.state === 'done' ? 'text-green-300' : b.queueState.state === 'running' ? 'text-indigo-300' : 'text-yellow-300'}">local ${esc(b.queueState.state)}</span>` : ''}
                ${b.cloudState ? `<span class="${b.cloudState.state === 'done' ? 'text-green-300' : 'text-indigo-300'}">cloud ${esc(b.cloudState.state)}</span>` : ''}
                <div class="text-[10px] text-gray-500">${b.legs.map((l) => `${esc(l.model)} ×${l.tasks.length}`).join(' · ')}${b.queueState && b.queueState.last ? ` — ${esc(b.queueState.last)}` : ''}</div></div>`).join('')
            || '<div class="text-[11px] text-gray-600">nothing enqueued from here yet</div>';
        const dry = st.dry ? `<div class="space-y-1">
                <div class="text-[11px] ${st.dry.error ? 'text-red-300' : 'text-gray-400'}">${st.dry.error ? esc(st.dry.error) : (st.dry.dryRun
                    ? `Dry run: written to <span class="font-mono break-all">${esc(Object.values(st.dry.files || {}).join(', '))}</span>, not started.`
                    : `Enqueued ${(st.dry.items || []).length} queue row(s): ${(st.dry.items || []).map((i) => `<span class="font-mono">#${i.id} ${esc(i.label || i.kind)}${i.status === 'paused' ? ' (held)' : ''}</span>`).join(', ')} — see the Queue view.${(st.dry.held || []).length ? ` <span class="text-yellow-300">${st.dry.held.length} cloud row(s) are HELD until Kyle releases them.</span>` : ''}`)}</div>
                ${!st.dry.error && st.dry.alreadyQueued && st.dry.alreadyQueued.length ? `<div class="text-[11px] text-yellow-300">Left out ${st.dry.alreadyQueued.length} run(s) already queued at the same config: <span class="font-mono break-all">${st.dry.alreadyQueued.map((d) => `${esc(((st.byId && st.byId.get(d.model)) || {}).label || d.model)} ${esc(d.task)}`).join(', ')}</span></div>` : ''}
                ${!st.dry.error && st.dry.pendingContinuation && st.dry.pendingContinuation.length ? `<div class="text-[11px] text-gray-300">Left out ${st.dry.pendingContinuation.length} run(s) that are unfinished at the config and wait for a continuation of their saved session (not a fresh run): <span class="font-mono break-all">${st.dry.pendingContinuation.map((d) => `${esc(((st.byId && st.byId.get(d.model)) || {}).label || d.model)} ${esc(d.task)}`).join(', ')}</span></div>` : ''}
                ${!st.dry.error && st.dry.dropped && st.dry.dropped.length ? `<div class="text-[11px] text-yellow-300">Left out ${st.dry.dropped.length} run(s) the config already ran (one run per task per config): <span class="font-mono break-all">${st.dry.dropped.map((d) => `${esc(((st.byId && st.byId.get(d.model)) || {}).label || d.model)} ${esc(d.task)}`).join(', ')}</span></div>` : ''}
                ${st.dry.scripts && st.dry.scripts.queue ? `<pre data-key="aq-dry-q" class="text-[10px] text-gray-300 bg-gray-950 border border-gray-800 rounded p-2 font-mono">${esc(st.dry.scripts.queue)}</pre>` : ''}
                ${st.dry.scripts && st.dry.scripts.cloud ? `<pre data-key="aq-dry-c" class="text-[10px] text-gray-300 bg-gray-950 border border-gray-800 rounded p-2 font-mono">${esc(st.dry.scripts.cloud)}</pre>` : ''}</div>` : '';

        setHtml(elProposal, `
            <div class="flex flex-wrap items-center justify-between gap-2"><span class="${H}">Proposed batch <span class="normal-case font-normal text-gray-500">— ${esc(s.strategy)}</span></span>
                <span class="flex flex-wrap gap-1"><button type="button" class="${BTN}" data-refresh title="re-read the catalog, the live queues and the settings">reload</button>
                ${removedN || st.legOrder || Object.keys(st.runOrder).length ? `<button type="button" class="${BTN}" data-restore>restore ${removedN ? `${removedN} removed` : 'order'}</button>` : ''}</span></div>
            <div class="grid grid-cols-2 gap-2">
                <div class="bg-gray-900/50 border border-gray-800 rounded-lg p-2"><div class="${H}">local</div>
                    <div class="text-xs text-gray-200 aq-num">${tot.local.runs} runs · ${tot.local.legs} legs</div>
                    <div class="text-[11px] text-gray-400 aq-num">~${mins(tot.local.min)} of ${mins(s.budget.localHours * 60)}</div></div>
                <div class="bg-gray-900/50 border border-gray-800 rounded-lg p-2"><div class="${H}">cloud lane</div>
                    <div class="text-xs text-gray-200 aq-num">${s.budget.cloud ? `${tot.cloud.runs} runs` : 'off'}</div>
                    <div class="text-[11px] text-gray-400 aq-num">${s.budget.cloud ? `~${mins(tot.cloud.min)} of ${mins(s.budget.cloudHours * 60)}` : ''}</div></div>
            </div>
            ${(out.notes || []).map((n) => `<div class="text-[11px] text-yellow-300">⚠ ${esc(n)}</div>`).join('')}
            ${covHtml}
            ${flagged ? `<details open data-key="aq-flagged" class="bg-yellow-900/20 border border-yellow-800 rounded-lg p-2"><summary class="${H}">▸ validity checks (${out.flagged.length}) — not proposed</summary><div class="mt-1 space-y-1">${flagged}</div></details>` : ''}
            ${legHtml || '<div class="text-xs text-gray-500 py-3">Nothing worth running within the budget. Raise a weight or the budget, add a pin, or lower “min value per run”.</div>'}
            ${rowsHtml}
            <div class="flex flex-wrap items-center gap-2 pt-1">
                <button type="button" class="${PRIMARY}" data-dry ${legs.length ? '' : 'disabled'}>Preview script (dry run)</button>
                <button type="button" class="${DANGER}" data-enqueue ${legs.length ? '' : 'disabled'}>Enqueue…</button>
                <span class="text-[10px] text-gray-500">Enqueue asks for confirmation, then adds the batch to the Queue as rows (edit, reorder or cancel them there).</span></div>
            ${dry}
            <details data-key="aq-ranking" class="bg-gray-900/50 border border-gray-800 rounded-lg p-2"><summary class="${H}">▸ ability ranking the planner used (θ, logits vs the average task)</summary><div class="mt-1 space-y-0.5">${ranking}</div></details>
            <details data-key="aq-batches" open class="bg-gray-900/50 border border-gray-800 rounded-lg p-2"><summary class="${H}">▸ enqueued batches</summary><div class="mt-1 space-y-1">${batches}</div></details>
        `);
        wireProposal(legs);
    }

    function wireProposal(legs) {
        const keys = () => (st.legOrder || legs.map((L) => L.key)).slice();
        elProposal.querySelectorAll('[data-leg-up],[data-leg-down]').forEach((b) => b.addEventListener('click', (e) => {
            e.preventDefault();
            const k = b.dataset.legUp || b.dataset.legDown; const order = keys(); const i = order.indexOf(k);
            const j = b.dataset.legUp ? i - 1 : i + 1;
            if (i < 0 || j < 0 || j >= order.length) return;
            [order[i], order[j]] = [order[j], order[i]]; st.legOrder = order; renderProposal();
        }));
        elProposal.querySelectorAll('[data-leg-del]').forEach((b) => b.addEventListener('click', (e) => {
            e.preventDefault();
            const L = legs.find((x) => x.key === b.dataset.legDel); if (!L) return;
            for (const r of L.runs) st.removed.add(`${L.key}|${r.task}`); renderProposal();
        }));
        elProposal.querySelectorAll('[data-run-del]').forEach((b) => b.addEventListener('click', () => { st.removed.add(b.dataset.runDel); renderProposal(); }));
        elProposal.querySelectorAll('[data-run-up]').forEach((b) => b.addEventListener('click', () => {
            const [k, t] = b.dataset.runUp.split('|'); const L = legs.find((x) => x.key === k); if (!L) return;
            const order = L.runs.map((r) => r.task); const i = order.indexOf(t); if (i <= 0) return;
            [order[i - 1], order[i]] = [order[i], order[i - 1]]; st.runOrder[k] = order; renderProposal();
        }));
        elProposal.querySelector('[data-restore]')?.addEventListener('click', () => { resetEdits(); renderProposal(); });
        elProposal.querySelector('[data-refresh]')?.addEventListener('click', () => load());
        elProposal.querySelector('[data-dry]')?.addEventListener('click', () => submit(true));
        elProposal.querySelector('[data-enqueue]')?.addEventListener('click', () => {
            const chain = st.server && st.server.chain;
            const n = legs.reduce((a, L) => a + L.runs.length, 0);
            const rows = queueRows();
            const lanes = [...new Set(rows.map((r) => r.queueLane))];
            const cloudN = rows.filter((r) => r.queueLane === 'cloud').length;
            const msg = `Enqueue ${n} run(s) as ${rows.length} queue row(s)?\n\nThis adds them to the benchmark Queue (${lanes.join(', ')}), after what is already pending. The queue runner starts them in order unless the lane is paused.${cloudN ? `\n\n${cloudN} cloud row(s) go in HELD: they need Kyle's OK (release them in the Queue view).` : ''}`;
            if (!window.confirm(msg)) return;
            submit(false);
        });
    }

    function batchPayload() {
        // `rerun` (a pin's "rerun", or a re-run proposed under "include re-runs") and `rerunScored` tell the server's
        // guard (lib/queue.js dropScored) that these re-runs are wanted; anything else it already scored is dropped.
        return { strategy: st.settings.strategy, plannedAt: new Date().toISOString(), cascade: st.out.cascade, rerunScored: !!st.settings.rerunScored,
            totals: st.out.totals, chunkTasks: st.settings.chunkTasks ?? 4,
            // the legs AS QUEUE ROWS: chunks of chunkTasks, interleaved per lane (the server inserts them in this order)
            legs: queueRows().map((L) => ({ model: L.model, lane: L.lane, cascade: L.cascade ?? null, ...(L.chunk ? { chunk: L.chunk, chunks: L.chunks } : {}),
                runs: L.runs.map((r) => ({ task: r.task, ...(r.rerun ? { rerun: true } : {}) })) })) };
    }
    async function submit(dryRun) {
        const r = await api('/api/autoqueue/enqueue', { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ batch: batchPayload(), dryRun, confirm: !dryRun }) });
        st.dry = r;
        if (!dryRun && !r.error) { resetEdits(); await refreshServer(); return; }
        renderProposal();
    }

    return {
        load: () => { if (!st.catalog) return load(); return refreshServer(); },
        reload: load,
    };
}
