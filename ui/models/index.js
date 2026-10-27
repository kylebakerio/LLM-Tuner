// Results tab (called "Models" until 2026-10-22, Kyle: "the 'models' page should be 'results'"; its route is #results,
// and #models links still open it -- ui/shared/route.js; inside the app the tab is still `models`). Lands on an OVERVIEW
// of every model side by side (leaderboards + the three decision-relevant graphs); clicking a row or a point opens that
// model's detail view.
// The searchable picker is secondary navigation, not the landing page.
//
// Wires itself into index.html's #tab-models / #models-view without script.js needing to know
// anything but "hide this view when another tab is clicked".

import { esc, fmtDur, fmtN, harnessLabel, pollEvery, ctxLabel, catalogStore, statusChip, answeredChip, overflowChip, unfinishedChip, answeredLines, answeredCategory, unfinishedLines, unfinishedCategory, PASS_AT_CAP_NOTE, SPECIAL_PASS_FILL, SPECIAL_PASS_EDGE, UNFINISHED_FILL, UNFINISHED_HATCH } from '../benchmarks/util.js';
import { promptVariant, problemId, LEVEL_MIN_CONFIGS, STATUS_COLOR, createLeaderboard, QUALITY_COLUMNS, commonTaskSet, weightsOf, weightsLabel, configText, ctxText, FACETS, FACET_DEFAULTS, groupConfigs, relSolveTimes, groupMetrics, facetBar, mergeTasks, mergeUnfinished, foldTensorRun, foldFileRun, fileVariantRows, timeKeepWith, fileSpeedModels, FILE_FACET, FILE_FACET_LABEL, overviewCatalog, inQualityFit, difficultyAdjusted, ADJ_COLUMN, strengthByDir, qualityMetricsFor, wilson, showPopover, hidePopover, ladderSteps, ladderStepText, LADDER_MIN_PTS, LADDER_MIN_SPEEDUP, LADDER_MIN_N, fitFor, ladderPointOf, bestConfigOf, BEST_CONFIG_MIN_N, BEST_CONFIG_MIN_FRAC, strengthRank, HIGHLIGHT, modelMatcher, ensureHighlightStyle, SERIES, compareRows, compareMany, compareTag, compareColor, likeSegments, manySegments, taskOutcome, taskFamily, overlaps, reportCard, REPORT_CARD_THIN, speedOf, partialCreditOf, fastSpeedOf, speedConfigShare, relIndexOf, SPEED_BANDS, SPEED_MIN_REQ, strengthGap, rangeNote } from '../shared/leaderboard.js';
import { createLoadPanel, nextPaint, RESULTS_STEPS, RESULTS_TITLE } from '../shared/loadbar.js';
// The overview fit by battery dir, for the detail page's strength column; recomputed when the catalog object changes.
const strengthDirCache = { at: null, k: null, v: null };
// Batteries running now and their current task (GET /api/models/running), for the grid's glowing cells; polled while
// the overview shows. (2026-09-30, Kyle)
let runningNow = [];
let runningAt = 0;      // when runningNow was last asked for
let runningTimer = null;
// The public site (public/server.js, lab.kylebaker.io; ai.* until 2026-10-22) loads this same module with window.PUBLIC_SITE set: no task
// pages (they show task content -- prompts and hidden tests stay private), no links into the dashboard's Bench
// tab, and a running cell opens the public Live page instead of the dashboard's live view.
const PUBLIC = typeof window !== 'undefined' && !!window.PUBLIC_SITE;
// Navigation (2026-10-06, Kyle: "all clicks to navigate anywhere in the app should use navigation properly such that
// the browser 'back' functionality correctly works as expected"). In the dashboard ui/shared/route.js owns history
// (window.Nav): a click here asks it for a route -- ONE entry, also when the route is in another tab -- and it calls
// showRoute() below to draw, as it does for Back/Forward and a pasted link. The public site has no router and does
// not serve that file: there (NAV null) this module keeps its own two history calls, as before.
const NAV = PUBLIC || typeof window === 'undefined' ? null : (window.Nav || null);
const routeTo = (r) => NAV.go(window.Route.format(r), { again: 'page' });   // again: a second click on a page that failed to load retries it
function openLiveFor(dir) {
    if (PUBLIC) { window.dispatchEvent(new CustomEvent('site:navigate', { detail: { path: '/live', dir } })); return; }
    routeTo({ tab: 'bench', sub: 'codebench', view: 'live', dir });   // Live, on that battery's running task
}
import { prefillSeries, lineIds, loadFocus, saveFocus, resolveFocus, toggleFocus, focusLabel } from './prefill.js';
import { prefillVsContext, setLineFocus, setLineHover, focusLegend, lineStyle, solveRateVsCost, qualityLadder, statusMix, taskGrid, capWallLine, costPerSolve, destroyAll, colorFor, setHighlight, repaintHighlight } from './charts.js';
import { renderDetail } from './detail.js';
import { renderTask, difficultyRank } from './task.js';

const btn = document.getElementById('tab-models');
const view = document.getElementById('models-view');
if (btn && view) init();

const errorText = (status, t) => (PUBLIC ? 'This data is not available right now — try again in a minute.' : status === 404
    ? 'the /api/model* routes are not live yet — server4.js has them, but the dashboard process needs a restart (ask the coordinator; do not restart pm2 yourself)'
    : `HTTP ${status}${t ? ': ' + t.slice(0, 200) : ''}`);
const api = async (url) => {
    const r = await fetch(url);
    if (!r.ok) return { error: errorText(r.status, await r.text().catch(() => '')) };
    try { return await r.json(); } catch { return { error: 'bad JSON from ' + url }; }
};

function init() {
    view.innerHTML = `
      <div class="space-y-4">
        <div id="mv-error" class="hidden text-xs text-red-200 bg-red-900/25 border border-red-800/50 rounded p-3"></div>
        <div id="mv-overview"></div>
        <div id="mv-detail" class="hidden"></div>
      </div>`;
    const errEl = view.querySelector('#mv-error');
    const overviewEl = view.querySelector('#mv-overview');
    const detailEl = view.querySelector('#mv-detail');

    let catalog = null;
    // TENSOR-SPLIT ROWS (2026-10-13, Kyle: "a button that lets us choose whether tensor split should separate or combine
    // for quality config readings in the solve map"; it is the "tensor split" chip of the quality charts' bar in the
    // Config grouping accordion -- his place for it -- ON = separate). `rawCatalog` is what the server sent; `catalog`,
    // which everything below reads, is that same object ('separate': each tensor-split row is a row, as filed) or its
    // folded twin ('combine': leaderboard.js foldTensorRows -- one object per source catalog, so the fit and board
    // caches hold). It is not a facet: the split is in the model key, so no keep-list can pool or part these runs.
    let rawCatalog = null;
    // Default COMBINE since 2026-10-14 (Kyle: "make sure tensor split is disabled, by default, as a quality-differentiator
    // on the solve map"; 26 of 28 + no token-level difference, so it is a placement, not a different model). The stored
    // choice moved to a new key so a browser that saved the old default ('separate') starts from the new one. The public
    // site keeps each tensor-split run as its own row (no chip there; changing it is a public change).
    // Public merges too (Kyle 2026-10-14: a tensor-split row showed as its own model on ai.kylebaker.io, the public site then); no chip there.
    let tensorRows = 'combine';
    try { const v = localStorage.getItem('models_tensor_rows_v2'); if (!PUBLIC && (v === 'separate' || v === 'combine')) tensorRows = v; } catch { /* private mode */ }
    // F32SSM COPIES (2026-10-14, Kyle: "...the results should merge, you can add in a config toggle that lets one
    // manually select whether those should be separated on quality or speed and by default we will say it should
    // differentiate on neither"). Two chips, "f32ssm copies" on the quality bar and on the time bar, both OFF (= merged)
    // by default; the public site always merges and has neither. Quality ON shows the raw rows (each copy a row of its
    // own, so its times are its own too); quality OFF folds the copies into the original file's row (leaderboard.js
    // foldFileVariants, after the tensor fold so a tensor-split copy reaches its copy row first), and then the time chip
    // ON keeps the copies' configs apart on the time charts, the Speed board and the prefill chart.
    const storedRows = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
    let fileRows = fileVariantRows(PUBLIC, { quality: storedRows('models_f32ssm_quality'), speed: storedRows('models_f32ssm_speed') });
    // (2026-10-14: the one copy of this rule is leaderboard.js overviewCatalog, which the Benchmarks board and the pickers
    // also call with this page's stored switches, so they fit the very catalog object this page fits)
    const shownCatalog = (raw) => overviewCatalog(raw, { tensorRows, fileRows });
    // the time charts' keep-list, with the copies kept apart when the time chip says so
    const timeKeep = () => timeKeepWith(chartKeep.t || storedKeep('models-charts-t', FACET_DEFAULTS.full), fileRows);
    // The whole overview is drawn again from the other catalog object (every board, chart and count reads `catalog`).
    // Compare ticks name rows that may no longer exist, so they are cleared, and said so. The accordions that were
    // open (the chip sits in one) are opened again: the redraw rebuilds them shut.
    function setTensorRows(v) {
        if (v === tensorRows || !rawCatalog) return;
        tensorRows = v;
        try { localStorage.setItem('models_tensor_rows_v2', v); } catch { /* private mode */ }
        redrawRows('The tensor split rows changed, so the ticks were cleared.');
    }
    // (the f32ssm chips: `which` is 'quality' or 'speed'; the same whole redraw as the tensor chip)
    function setFileRows(which, v) {
        if (PUBLIC || fileRows[which] === v || !rawCatalog) return;
        try { localStorage.setItem('models_f32ssm_' + which, v); } catch { /* private mode */ }
        fileRows = fileVariantRows(false, { ...fileRows, [which]: v });
        redrawRows('The f32ssm copy rows changed, so the ticks were cleared.');
    }
    function redrawRows(hint) {
        catalog = shownCatalog(rawCatalog); CG = null;
        if (comparePicks.length) { comparePicks = []; comparePicksRows = null; compareHint = hint; }
        const open = [...overviewEl.querySelectorAll('details[data-key]')].filter((d) => d.open).map((d) => d.dataset.key);
        const top = view.scrollTop;
        renderOverview();
        for (const k of open) { const d = [...overviewEl.querySelectorAll('details[data-key]')].find((x) => x.dataset.key === k); if (d) d.open = true; }
        if (top) view.scrollTop = top;
    }
    const tensorChip = { id: 'tensor', label: 'tensor split',
        title: 'A run with llama.cpp\'s tensor split (-sm tensor: one model spread across two cards) is filed as a row of its own. ON keeps it that way. OFF pools it with the same model\'s other runs for every quality reading on this page; the time charts still keep it apart while "GPU placement" is on, because card placement changes speed.',
        isOn: () => tensorRows === 'separate', set: (on) => setTensorRows(on ? 'separate' : 'combine'), dflt: false };
    const fileChipQ = { id: 'f32ssm-q', label: 'f32ssm copies',
        title: 'Qwen3.8-27B-GSQ-RCO IQ2_XS / IQ2_S / IQ3_XXS were run for a while from local "-mtp-f32ssm" re-saves (SSM tensors stored as f32, an old CUDA-12 work-around; the weights are otherwise the same). OFF (default) pools those runs with the original -mtp file\'s runs for every quality reading on this page. ON keeps each copy a row of its own (and then its times are its own too).',
        isOn: () => fileRows.quality === 'separate', set: (on) => setFileRows('quality', on ? 'separate' : 'merge'), dflt: false };
    const fileChipT = { id: 'f32ssm-t', label: 'f32ssm copies',
        title: 'OFF (default): runs on the f32ssm re-saves and on the original -mtp files share their time rows, Speed board row and prefill line. ON keeps the copies apart there (labelled "f32ssm copy"). Always on while the quality chip keeps the copies as rows of their own.',
        isOn: () => fileRows.speedSplit, set: (on) => setFileRows('speed', on ? 'separate' : 'merge'), dflt: false,
        disabled: () => fileRows.quality === 'separate' };
    let loaded = false;
    let detailCtx = { view: 'speed' };
    let CG = null;          // the overview's chart groups + Rasch fit; the task page reads them too
    let shownTask = null;   // the task page on show, so popstate can tell "already here" from "switch"
    let shownModel = null;  // the same for a model's page: { key, ctx } (ctx.view is its open tab, ctx.setView switches it)
    let shownCompare = null; // the same for a compare page: its two row ids, joined

    function showError(msg) { errEl.textContent = msg; errEl.classList.remove('hidden'); }
    function clearError() { errEl.classList.add('hidden'); }

    // One fetch at a time: a refresh on #results/... asks twice (the tab click and the restore), and
    // a slower first answer re-rendering the overview would hide the page the second one opened.
    let inflight = null;
    // Every view (the Models tab, a model page, a task page) asks for the catalog when it opens (Kyle,
    // 2026-09-30: a run finished since the first load was missing while the live goals matrix showed it).
    // The only reuse is an answer from the last few seconds, so one click never asks twice.
    // Asking is now cheap (2026-10-06, Kyle: "it still seems unnecessary and surprising that the models page is a
    // relatively heavy load"): the catalog is the page's shared copy (util.js catalogStore), the request carries its
    // ETag, and when nothing changed the server answers 304 and the SAME object comes back -- so `drawn`, the catalog
    // object the overview on screen was drawn from, still equals `catalog` and nothing is drawn again. Opening the
    // tab with nothing new used to refetch 1.7 MB and rebuild every chart (~0.8 s of a frozen page) each time.
    const CATALOG_MAX_AGE_MS = 5000;
    let catalogAt = 0;
    let drawn = null;         // the catalog object the overview's DOM and charts show; null = it has to be drawn
    let repaintGrid = null;   // the drawn overview's own grid painter (for a change in the running batteries)
    const catalogStale = () => !catalog || Date.now() - catalogAt > CATALOG_MAX_AGE_MS;
    const pageOnShow = () => !detailEl.classList.contains('hidden');
    // A model or task page drops its own charts; the overview's (mv-*) stay alive under it, so Back shows it as it was.
    const dropPageCharts = () => destroyAll((id) => id.startsWith('mv-'));
    function load(force) {
        if (loaded && !force) { if (!pageOnShow() && drawn !== catalog) renderOverview(); return Promise.resolve(); }
        if (inflight && !force) return inflight;
        inflight = loadNow().finally(() => { inflight = null; });
        return inflight;
    }
    // Ask for the catalog; false when there is none to show. An unchanged catalog is the same object as before.
    // onProgress: the loading panel's download / parse steps (util.js createCatalogStore).
    async function refreshCatalog(quiet, onProgress) {
        const r = await catalogStore.load(onProgress ? { onProgress } : undefined);
        if (r.error) { if (!quiet) showError(r.status ? errorText(r.status, r.text) : r.error); return false; }
        if (r.catalog !== rawCatalog) { rawCatalog = r.catalog; catalog = shownCatalog(rawCatalog); CG = null; }
        catalogAt = Date.now();
        loaded = true;
        return true;
    }
    // The batteries running now; true when the list changed.
    async function fetchRunning() {
        let next;
        try { const j = await api('/api/models/running'); next = (j && j.running) || []; } catch { return false; }
        const changed = JSON.stringify(next) !== JSON.stringify(runningNow);
        runningNow = next; runningAt = Date.now();
        return changed;
    }
    // THE LOADING PANEL (2026-10-22, Kyle: "the 'loading' for that page should have a loading bar and a better
    // animation -- that goes for both ai and lab subdomain pages"): ui/shared/loadbar.js, the same one the public site
    // shows while this module's code arrives. Its bar moves only on real events: the catalog's bytes against the size the
    // server announced, then each step as it ends -- reading the JSON, the strength fit (fitFor, warmed here so the
    // overview's draw reuses it), drawing. Each synchronous step gets a frame to paint first (nextPaint), or the bar would
    // jump from the download straight to the finished page.
    const mb = (n) => `${(n / 1048576).toFixed(n < 10485760 ? 1 : 0)} MB`;
    const LOAD_STEPS = () => RESULTS_STEPS.map((x) => ({ ...x, state: x.id === 'code' ? 'done' : 'todo' }));   // this code is running: `code` is done
    // The catalog's download and parse, onto a panel's `data` / `parse` steps (util.js createCatalogStore onProgress).
    const catalogProgress = (panel) => async (p) => {
        if (p.phase === 'data') panel.set('data', { frac: p.total ? p.loaded / p.total : null, detail: p.total ? `${mb(p.loaded)} of ${mb(p.total)}` : `${mb(p.loaded)} so far` });
        else if (p.phase === 'parse') { panel.set('data', { detail: mb(p.loaded) }); panel.start('parse'); await nextPaint(); }
    };
    // A task or compare page opened cold (a pasted link, nothing loaded yet): the same panel over the page's own spot.
    function coldPanel(title) {
        overviewEl.classList.add('hidden'); detailEl.classList.remove('hidden');
        const panel = createLoadPanel(detailEl, title, [{ id: 'code', label: 'Page code', state: 'done' }, { id: 'data', label: 'Results data' },
            { id: 'parse', label: 'Reading it' }, { id: 'draw', label: 'Drawing the page' }]);
        panel.start('data');
        return { panel, onProgress: catalogProgress(panel) };
    }
    async function loadNow() {
        clearError();
        // only before the first answer: with an overview on screen the page stays as it is while we ask
        const panel = catalog ? null : createLoadPanel(overviewEl, RESULTS_TITLE, LOAD_STEPS());
        if (panel) panel.start('data');
        const onProgress = panel ? catalogProgress(panel) : null;
        // the running batteries come WITH the catalog, so the grid is painted once, already outlined (it used to be
        // painted, then painted again ~0.3 s later when the running list arrived)
        const [ok, ranChanged] = await Promise.all([refreshCatalog(false, onProgress), fetchRunning()]);
        if (!ok) { if (!catalog) overviewEl.innerHTML = ''; return; }
        if (pageOnShow()) return;   // a model or task page opened meanwhile: the overview is drawn when it is next shown
        if (drawn !== catalog) {
            if (panel) {
                panel.start('fit'); await nextPaint();
                if (!CG) CG = buildChartGroups();   // the Rasch fit, cached per catalog object: renderOverview reuses it
                panel.start('draw'); await nextPaint();
                if (pageOnShow() || drawn === catalog) return;   // a page opened, or another call drew it, while we yielded
            }
            // the old overview stayed up while we asked: draw the new one where the reader is, not from the top
            const top = view.scrollTop;
            renderOverview();
            if (top) view.scrollTop = top;
        } else if (ranChanged && repaintGrid) repaintGrid();
    }
    // LIVE RESULTS (Kyle, 2026-10-09: "the solve map should fill in, live, as tests complete"). The running outline
    // was already polled; the results were only read when the page was opened. Now, when the running list changes
    // (a task ended or began) and every few minutes besides, the catalog is asked for again -- a conditional request
    // on the lab dashboard (304 when nothing changed) -- and the overview is redrawn in place ONLY when test results
    // moved. Request/speed data alone moving does not redraw anything: that still waits for a visit.
    const qualitySig = (c) => (c && c.models ? c.models.reduce((a, m) => a + ((m.counts && m.counts.qualityTasks) || 0), 0) + ':'
        + c.models.reduce((a, m) => a + ((m.quality && m.quality.solved) || 0), 0).toFixed(2) + ':' + c.models.length : '');
    let liveBusy = false;
    async function liveCatalog() {
        if (!catalog || inflight || liveBusy) return;
        liveBusy = true;
        try {
            const before = qualitySig(rawCatalog);
            const r = await catalogStore.load();
            if (r.error || !r.catalog || r.catalog === rawCatalog || qualitySig(r.catalog) === before) return;
            rawCatalog = r.catalog; catalog = shownCatalog(rawCatalog); CG = null; catalogAt = Date.now();
            if (pageOnShow() || view.classList.contains('hidden') || overviewEl.classList.contains('hidden')) return;   // drawn when next shown (drawn !== catalog)
            const top = view.scrollTop;
            renderOverview();
            if (top) view.scrollTop = top;
        } finally { liveBusy = false; }
    }
    // Put the overview on show: as it was when nothing changed under it, drawn from the catalog in hand otherwise.
    function showOverview() {
        detailEl.classList.add('hidden');
        overviewEl.classList.remove('hidden');
        if (!catalog) return;
        if (drawn !== catalog) renderOverview();
        else if (Date.now() - runningAt > 5000) fetchRunning().then((ch) => { if (ch && repaintGrid && drawn === catalog && !pageOnShow()) repaintGrid(); });
    }

    // ------------------------------------------------------------ overview
    let boardId = 'quality';
    let search = '';
    let wallSort = 'value';
    const gridRank = 'adjusted';
    let gridCells = 'outcome';   // 'outcome' (pass/fail per run) | 'subtests' (hidden-test assertions passed)
    // 'combined' (one row per model: every config pooled, ranked by MODEL strength -- the default since 09-29)
    // | 'top' (one row per model: its single best config, with an evidence floor; Kyle 10-03) | 'all' (every config)
    let chartRows = 'combined';
    const frontierY = 'adjusted';
    // A facet chip bar's stored choice (facetBar keeps it in localStorage), for code that runs before the bar is mounted.
    const storedKeep = (store, dflt) => {
        try { const v = JSON.parse(localStorage.getItem('facets_' + store) || 'null'); if (Array.isArray(v)) return v; } catch { /* private mode */ }
        return dflt;
    };
    // The two chart chip bars' choices, known from the start (2026-10-06): a task page can now open without the
    // overview ever being drawn, and it must group and label by the stored choice, as the mounted bars would.
    const chartKeep = { q: storedKeep('models-charts-q', FACET_DEFAULTS.quality), t: storedKeep('models-charts-t', FACET_DEFAULTS.full) };
    const cloudTime = () => ((chartKeep.q || FACET_DEFAULTS.quality).includes('served') ? 'split' : 'combine');
    let frontierX = 'time';      // 'time' (task-weighted) | 'tokens'
    let wallMetric = 'relative'; // 'relative' (task-weighted) | 'raw'
    const gbRank = 'adjusted';
    let prefillMode = 'model';   // prefill chart: 'model' (one line per model, its most-used config) | 'config' (every config)
    let ladderOrder = 'quality'; // quality ladder rungs: 'quality' (price each step in cost) | 'cost' (price it in quality)
    let ladderX = 'time';        // quality ladder cost: 'time' (relative solve time) | 'tokens'
    // Speed x quality card (2026-10-01): one card, two views -- the frontier scatter or the ladder.
    let frontierView = 'frontier';   // 'frontier' | 'ladder'
    let frontierCfgs = 'off';        // frontier: draw every model's config trail ('trail'), or only the hovered model's ('off')
    let costView = 'tok';            // cost-per-solve card: 'tok' | 'wall' | 'gb'
    let gbtMetric = 'relative';      // strength per time per GB: 'relative' (task-weighted time) | 'raw' (seconds per solve)
    // ONE quality measure everywhere (Kyle, 2026-09-29): strength /100 -- the Rasch fit's `rate` IS the strength
    // (ui/shared/leaderboard.js difficultyAdjusted). The old difficulty-weighted / robust / pass-ratio / raw toggles are gone.
    const ladderY = 'adjusted';
    try {
        prefillMode = localStorage.getItem('models_prefill_mode') === 'config' ? 'config' : 'model';
        ladderOrder = localStorage.getItem('models_ladder_order') === 'cost' ? 'cost' : 'quality';
        ladderX = localStorage.getItem('models_ladder_x') === 'tokens' ? 'tokens' : 'time';
        frontierX = localStorage.getItem('models_frontier_x') === 'tokens' ? 'tokens' : 'time';
        wallMetric = localStorage.getItem('models_wall_metric') === 'raw' ? 'raw' : 'relative';
        frontierView = localStorage.getItem('models_frontier_view') === 'ladder' ? 'ladder' : 'frontier';
        frontierCfgs = localStorage.getItem('models_frontier_cfgs') === 'trail' ? 'trail' : 'off';
        costView = ['tok', 'wall', 'gb'].includes(localStorage.getItem('models_cost_view')) ? localStorage.getItem('models_cost_view') : 'tok';
        gbtMetric = localStorage.getItem('models_gbt_metric') === 'raw' ? 'raw' : 'relative';
    } catch { /* private mode */ }
    const toggle = (attr, val, cur) => `chip${val === cur ? ' is-on' : ''}`;   // .chip / .chip-group: tailwind.src.css
    // Wire a group of buttons [data-<attr>] to a state setter + repaint, remembering the choice.
    const wireToggle = (attr, store, get, set, repaint) => overviewEl.querySelectorAll(`[data-${attr}]`).forEach((b) => b.addEventListener('click', () => {
        set(b.dataset[attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase())]);
        try { localStorage.setItem(store, get()); } catch { /* private mode */ }
        overviewEl.querySelectorAll(`[data-${attr}]`).forEach((x) => { x.className = toggle(attr, x.dataset[attr.replace(/-([a-z])/g, (_, c) => c.toUpperCase())], get()); });
        repaint();
    }));
    try {
        gridCells = localStorage.getItem('models_grid_cells') === 'subtests' ? 'subtests' : 'outcome';
        { const v = localStorage.getItem('models_chart_rows'); chartRows = v === 'all' ? 'all' : v === 'top' ? 'top' : 'combined'; }
    } catch { /* private mode */ }
    try { wallSort = localStorage.getItem('models_wall_sort') === 'quality' ? 'quality' : 'value'; } catch { /* private mode */ }

    // ---- Solve map compare mode (2026-10-11, Kyle: "a 'compare' mode we can toggle on on the solve map. it should make
    // checkboxes show up by every row, and a compare button show up"). Off on every page load (it is not remembered),
    // so the map opens exactly as it always has. The ticks are kept as row IDENTITIES, never row objects: every live
    // redraw rebuilds the grid and its rows. A row's identity is its model's weights (rows: combined / best config per
    // model -- which config is best can change as results arrive, the model does not) or its config group's key
    // (rows: all configs). Changing the Rows view changes what a row IS, so it clears the ticks and says so.
    // Any number of rows may be ticked (2026-10-20, Kyle: "allow selecting an arbitrary number of models"; until then a
    // third tick was refused). Two open the head-to-head page; three or more open the side-by-side page (drawCompareMany).
    let compareOn = false;
    let comparePicks = [];         // in the order ticked: { id, cid (the id the compare page takes), name }
    let comparePicksRows = null;   // the Rows view the ticks were made in
    let compareHint = '';          // one line in the bar: a refused third tick, ticks dropped by a view change
    // row i's identity colour and letter: leaderboard.js compareColor / compareTag (never a status colour)
    const rowPickId = (r) => (!r || !r._g || r.pending ? null : chartRows === 'all' ? r._g.key : weightsOf(r._g.m));
    // what the compare page is asked for: the model (its pooled row) or that one config group
    const rowCompareId = (r) => (chartRows === 'combined' ? r._g.m.key : r._g.key);
    const rowCompareName = (r) => r._g.label || r._g.m.display;
    function paintCompareBar() {
        overviewEl.querySelectorAll('[data-compare-mode]').forEach((b) => {
            const on = (b.dataset.compareMode === 'on') === compareOn;
            b.className = on ? 'chip is-on' : 'chip'; b.setAttribute('aria-pressed', on ? 'true' : 'false');
        });
        const bar = overviewEl.querySelector('#mv-cmp-bar');
        if (!bar) return;
        bar.classList.toggle('hidden', !compareOn);
        if (!compareOn) { bar.innerHTML = ''; return; }
        // it stays in view while the rows scroll under it (the map is ~60 rows tall); the public site's own sticky header sits above
        const head = PUBLIC ? document.querySelector('.site-head') : null;
        bar.style.top = `${head ? head.offsetHeight : 0}px`;
        const n = comparePicks.length;
        const say = compareHint || (n === 0 ? 'Tick two or more rows: click a row\u2019s box or its name.' : n === 1 ? 'Tick at least one more row.'
            : n === 2 ? 'Two rows ticked: Compare opens them head to head, or tick more to see them side by side.' : `${n} rows ticked: Compare opens them side by side.`);
        bar.innerHTML = `<div style="display:flex;flex-wrap:wrap;align-items:center;gap:0.4rem 0.6rem;padding:0.4rem 0.55rem;margin-bottom:0.5rem;border-radius:10px;border:1px solid rgba(116,119,246,0.5);background:var(--surface-2, #1b1e27);box-shadow:0 6px 16px -10px rgba(0,0,0,0.9)">`
            + `<button type="button" id="mv-cmp-go" class="btn btn-sm ${n >= 2 ? 'btn-primary' : ''}" ${n >= 2 ? '' : 'disabled'} title="${n === 2 ? 'Open the two ticked rows head to head' : n > 2 ? `Open the ${n} ticked rows side by side` : 'Tick two or more rows first'}">Compare (${n})</button>`
            + comparePicks.map((p, i) => `<span class="stat-chip" style="max-width:100%"><b style="color:${compareColor(i)}">${compareTag(i)}</b><span style="max-width:24rem;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.name)}</span>`
                + `<button type="button" data-cmp-drop="${i}" style="padding:0 0.15rem;color:#959cab" aria-label="Untick ${esc(p.name)}" title="Untick this row">\u2715</button></span>`).join('')
            + `<span style="font-size:11.5px;color:${compareHint ? '#fcd34d' : '#959cab'}" aria-live="polite">${esc(say)}</span>`
            + `<button type="button" id="mv-cmp-exit" class="btn btn-sm btn-ghost" style="margin-left:auto" title="Leave compare mode: the boxes go and the map is as it was">\u2715 Exit compare</button></div>`;
    }

    // The search box HIGHLIGHTS, it does not filter (2026-10-10, Kyle: "instead of 'filter models', let's have whatever
    // is typed into there put a gold highlight around models that match"). Every model is always drawn; the ones the
    // term matches (leaderboard.js modelMatcher: the rule the filter used) are ringed in gold wherever a model is
    // drawn. A board row, a chart row or a point stands for a SET OF WEIGHTS, so it is gold when any catalog entry on
    // those weights matches -- the rows the filter used to keep. Kept per (catalog, term): the painters ask per row.
    let hitMemo = { of: null, term: null, match: () => false, w: new Set(), byKey: new Map(), n: 0 };
    function hits() {
        const term = search.trim().toLowerCase();
        if (hitMemo.of === catalog && hitMemo.term === term) return hitMemo;
        const match = modelMatcher(term), w = new Set(), byKey = new Map();
        let n = 0;
        for (const m of (catalog && catalog.models) || []) { byKey.set(m.key, m); if (match(m)) { w.add(weightsOf(m)); n++; } }
        hitMemo = { of: catalog, term, match, w, byKey, n };
        return hitMemo;
    }
    // Is this drawn row highlighted? Chart and board rows carry their config group (_g); a prefill line, a speed-board
    // row and a ladder-table row carry the model's key; a "testing now" row with no stored run its model (_m).
    const rowHit = (r) => {
        const h = hits();
        if (!h.w.size || !r) return false;
        const m = (r._g && r._g.m) || r._m || h.byKey.get(r.key);
        return !!m && h.w.has(weightsOf(m));
    };
    setHighlight(rowHit);   // the charts read it whenever they draw (charts.js)
    ensureHighlightStyle();
    let boardNow = null;    // the leaderboard on show
    // The DOM half: the count beside the box, the All-models tiles (one per catalog entry: its own match) and the
    // ladder's step table.
    function markHighlight() {
        const h = hits();
        const cnt = overviewEl.querySelector('#mv-search-n');
        if (cnt) {
            cnt.textContent = h.term ? (h.n ? `${h.n} match${h.n === 1 ? '' : 'es'}` : 'no match') : '';
            cnt.style.color = h.n ? `var(--hl-gold, ${HIGHLIGHT})` : '';
        }
        overviewEl.querySelectorAll('[data-pick]').forEach((b) => b.toggleAttribute('data-hl', h.match(h.byKey.get(b.dataset.pick))));
        overviewEl.querySelectorAll('[data-ladder-key]').forEach((tr) => tr.toggleAttribute('data-hl', rowHit({ key: tr.dataset.ladderKey })));
    }
    // A new term only RE-STYLES: no fit, no chart and no DOM is rebuilt (the board is re-rendered from its kept rows).
    function applyHighlight() {
        if (!catalog || drawn !== catalog) return;
        markHighlight();
        if (boardNow) boardNow.render();
        repaintHighlight();
    }

    // SHORT summary boards. The full board for each of these lives in the tab that owns it
    // (codebench's Leaderboard view for quality, the llama-bench and sweep cards for speed);
    // this page is the cross-model overview, so it shows the top of each and links across.
    const SUMMARY_LIMIT = 5;
    const openBenchSub = (r) => () => routeTo({ tab: 'bench', ...r });
    // "How these numbers are adjusted" -- behind the info button on each board.
    const M = (title, items) => `<div class="text-xs font-semibold text-gray-100 mb-1">${title}</div><ul class="list-disc ml-4 space-y-1 text-gray-300">${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
    const METHOD_GROUPING = [
        '<b>One row per set of weights</b> (each quant is its own). Its runs are grouped into configs; the row shows the config that is best <i>for the column you rank by</i>. Hover or tap a row for everything that was rolled into it.',
        '<b>What merges:</b> runs merge only when every setting that could change an answer matches (harness, context, sampling, KV type, time cap, unknown flags). On quality boards, speed-only settings (MTP/draft, GPU placement, engine version -- the llama.cpp build or Strata version --, machine) are folded; on time and speed boards they are kept apart.',
    ];
    const METHOD_SCORING = [
        '<b>Excluded runs are not answers:</b> OVERFLOW, KILLED, PROVIDER_ERROR, ABORTED, CAP_TOO_LOW, HARNESS_ERROR, CONTAMINATED and TASK_INVALID leave the denominator entirely — never counted as failures.',
        '<b>Repeats count fractionally:</b> a task passed 1 of 2 times is half a solve, so a failing repeat lowers the score instead of replacing it. <code>sample_group</code> siblings (the same bug at two stages) count once.',
        '<b>Strength /100</b>: every task anyone has attempted is worth points in proportion to its difficulty (the chance a typical config fails it), and the points sum to 100. A config\'s strength is its expected score on all of them at the ability its results give it, from an item-response model, P(solve) = sigmoid(discrimination × (ability − difficulty)), fitted jointly over every config and task: its own pass/fail results set that ability and are never added in raw, so one lucky or unlucky run moves it only as far as the fit lets it. Easy tasks everyone solves are worth almost nothing; a thin perfect record (3/3 easy tasks) cannot read as strong, and configs that ran different tasks are comparable.',
        '<b>Coverage</b>: how many of the 100 points a config actually ran — the direct evidence behind its ability. Low coverage = mostly inferred (from few tasks and its model\'s other configs); run more of the heavy tasks to firm it up.',
        '<b>Intervals:</b> 95% ranges sit under each strength. They come from a <b>cluster bootstrap</b>: whole task groups (a task with its prompt levels, its bonus test, its stale-tests twin and its sample group) are resampled and the whole fit -- difficulties and strengths -- is refitted 200 times; the range is the spread of the strength over those refits, around the strength the full data give. So it covers what the tasks leave uncertain (fitted difficulties, related problems, which problems the suite happens to hold), not only the row\'s own runs. Most of that extra width is a shift every row shares (a set of harder tasks lowers every strength together), so it says how far a strength could move as the suite changes, not how two rows compare. A thin row keeps its own posterior, plus that shared part, wherever that is wider; a row newer than the last bootstrap shows its posterior range until the next one (its tooltip says which). Neighbours marked <b>=</b> cannot be ordered: the 95% range of the GAP between them, from the same refits (the shared shift cancels), includes 0. To compare any two rows, open <b>Compare</b>.',
        '<b>Coverage:</b> how much of the suite a row attempted. "common tasks only" recomputes every raw number over the tasks all rows share.',
    ];
    const BOARDS = {
        quality: {
            label: 'Quality',
            note: '<b>strength /100</b>: difficulty-weighted points over the whole corpus — the expected score on every task at the ability a model\'s results give it (Rasch fit across every model and task); beneath it the 95% range and how many of the 100 points were actually tested. Raw solve rate is over <b>scored</b> tasks only: OVERFLOW, KILLED, PROVIDER_ERROR and ABORTED are excluded — they are not model answers, so they are counted separately and never as failures. One sample per task, and a task run more than once counts <b>fractionally</b> — 4 passes of 5 attempts is 0.8 of a solve, so a repeat that fails lowers the score instead of replacing it. <code>sample_group</code> siblings fold to one sample. Excluded runs are not attempts and never enter the denominator.',
            columns: [ADJ_COLUMN, ...QUALITY_COLUMNS.slice(0, 3)],
            commonTasks: true, defaultSort: 'adjSolveRate', source: 'quality',
            method: M('How the Quality board is adjusted', [...METHOD_GROUPING, ...METHOD_SCORING]),
            more: PUBLIC ? null : { label: 'full quality master list, one row per config →', onClick: openBenchSub({ sub: 'codebench', view: 'board' }) },
        },
        efficiency: {
            label: 'Efficiency',
            note: 'Output tokens per <b>solved</b> task. A model that fails cheaply is not efficient — read this next to the quality board, never instead of it. Grouped like Quality: MTP, GPU placement and build do not change what the model writes, so they are folded; wall-clock figures live on the Solve time board.',
            columns: [QUALITY_COLUMNS[3], QUALITY_COLUMNS[5], QUALITY_COLUMNS[0]],
            commonTasks: true, defaultSort: 'tokensPerSolve', source: 'quality',
            method: M('How the Efficiency board is adjusted', [...METHOD_GROUPING,
                '<b>Tokens per solve</b> is the mean output tokens over SOLVED tasks only; a solved run that recorded 0 tokens is treated as unrecorded, not free. For each task, the runs that passed supply the cost.',
                '<b>Across model families</b> token counts are not directly comparable (tokenizers differ by 20–40%); read it within a family, or with a speed per token.',
                ...METHOD_SCORING.slice(0, 2)]),
            more: PUBLIC ? null : { label: 'full quality master list, one row per config →', onClick: openBenchSub({ sub: 'codebench', view: 'board' }) },
        },
        solvetime: {
            label: 'Solve time',
            note: '<b>Relative solve time</b>: one joint fit of wall clock over every config and every task at least two configs solved (log time = config speed + task length), so each config is placed on the same scale. 1× = a typical config; 0.5× = half the time on the same work; 2× = twice as long. Ratios between two configs match their head-to-head comparison up to noise. It replaces solves/hour, which could not say solves <i>of what</i>. Tasks no other config solved are counted but not scored. Every facet separates here — MTP, build, placement and context all change a wall clock.',
            columns: [
                { id: 'relSolveTime', label: 'rel. time', kind: 'num', dir: 'asc', title: 'relative solve time: a joint fit of wall time over every config and task (the length of each task factored out), so 2× = twice as long as a typical config on the same task; only tasks at least two configs solved count' },
                QUALITY_COLUMNS[4], QUALITY_COLUMNS[0],
            ],
            commonTasks: false, defaultSort: 'relSolveTime', source: 'full',
            method: M('How the Solve time board is adjusted', [...METHOD_GROUPING,
                '<b>Relative solve time:</b> a joint fit of wall clock over every config and task (log time = config speed + task length), on tasks at least two configs solved. 1× = a typical config, 0.5× = half the time on the same work. Easy tasks solved fast cannot outweigh hard ones solved fast, and every config sits on one scale.',
                'Tasks no other config solved have no peer: counted, not scored. Wall clock comes from the runs that passed.',
                '<b>Every facet separates here</b> — MTP, build, GPU placement, machine and context all change a wall clock.',
                ...METHOD_SCORING.slice(0, 1)]),
            more: PUBLIC ? null : { label: 'full quality master list, one row per config →', onClick: openBenchSub({ sub: 'codebench', view: 'board' }) },
        },
        speed: {
            label: 'Raw speed (local)',
            note: 'One fixed point for every model: <b>32k</b> — llama-bench depths, or logged requests with 24k–40k <i>new</i> prompt tokens (the request log does not yet record how full the context already was, so a small request on a deep cache does not count here). At least 3 samples at the point. A model with nothing measured there is not listed — a number from another context is not comparable. Each model is shown under its fastest launch config for the column you rank by; configs separate on every flag and the build. '
                + 'Prefill and generation are never blended. Cloud models are not here: their only rate is tokens ÷ wall clock, which is not comparable to a measured prefill.',
            columns: [
                { id: 'prefill32k', label: 'prefill t/s @32k', kind: 'num', dir: 'desc', title: 'median prefill rate measured within 24k–40k tokens of context' },
                { id: 'gen32k', label: 'gen t/s @32k', kind: 'num', dir: 'desc', title: 'median generation rate measured within 24k–40k tokens of context' },
                { id: 'requests', label: 'samples', kind: 'int', dir: 'desc' },
            ],
            commonTasks: false, defaultSort: 'prefill32k', source: 'speed',
            method: M('How the Speed board is adjusted', [
                '<b>One fixed point, 32k context DEPTH:</b> how full the context was when prefill finished (tokens already cached + the new ones) — the number a prefill rate depends on. Requests are placed only if their depth is known (live llama-server log since 2026-09-24, recovered from opencode transcripts, or imported from battery server logs); older requests with no recoverable depth are left out, not guessed. llama-bench rows use their explicit depth.',
                'A band of 24k–40k counts as 32k. A config needs at least 3 samples there; a model with none is not listed.',
                '<b>Each model shows its fastest launch config for the column you rank by;</b> configs separate on every flag and the build. Prefill and generation are never blended. Prompt-cache hits (≤64 new tokens) are not prefill rates and are excluded.',
                '<b>Pairing with quality:</b> quality folds speed-only settings, so a speed row applies to any quality result on the same weights, context and KV type.']),
            more: PUBLIC ? null : { label: 'full per-config speed board (with wall clock and rep spread) →', onClick: openBenchSub({ sub: 'server' }) },
        },
    };

    // ONE row per SET OF WEIGHTS per board, under its BEST config for the board's own dimension:
    // best solve rate on Quality, cheapest per solve on Efficiency, and so on. A model can therefore
    // sit on different configs on different boards, and the sublabel says which. A config is the
    // full thing (launch flags, context, runner, effort, cap); every one of them is listed on the
    // model's page. Blending configs into one row described none of them.
    function familyGroups(models) {
        const map = new Map();
        for (const m of models) {
            const f = weightsOf(m);
            if (!map.has(f)) map.set(f, []);
            map.get(f).push(m);
        }
        return map;
    }

    // Every candidate row per set of weights, for one board: one row per config under the board's
    // own grouping (qualityConfigs folds MTP/placement/build; configs separates everything).
    // ---- details card for one config group (board rows and chart rows share it) ----
    const facetLabel = (id) => (FACETS.find((f) => f.id === id) || {}).label || (id === FILE_FACET ? FILE_FACET_LABEL : id);
    const pctTxt = (v) => (v == null ? '—' : `${(v * 100).toFixed(0)}%`);
    function groupDetailHtml(g, { adj, rel, keep, others, column } = {}) {
        const q = g.q || qualityMetricsFor(g.tasks, null);
        const a = adj && adj.get(g.key);
        const rt = rel && rel.get(g.key);
        const folded = FACETS.map((f) => f.id).filter((id) => !(keep || []).includes(id));
        const excl = Object.values(g.tasks).filter((t) => t.excluded).length;
        const lines = [];
        lines.push(`<div class="text-xs font-semibold text-gray-100">${esc(g.m.display)}</div>`);
        lines.push(`<div class="text-gray-400">${esc(g.m.provider)}${g.c.runner ? ' · ' + esc(harnessLabel(g.c.runner, g.c.scaffold)) : ''}${column ? ` · shown for <b>${esc(column)}</b>` : ''}</div>`);
        lines.push(`<div class="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 font-mono">`
            + `<span class="text-gray-400">weighted solve rate</span><span>${a ? `${pctTxt(a.rate)} <span class="text-gray-500">[${pctTxt(a.lo)}–${pctTxt(a.hi)}]</span>` : '—'}</span>`
            + `<span class="text-gray-400">raw solved</span><span>${Math.round(q.solved * 100) / 100}/${q.scored} scored${excl ? ` + ${excl} excluded` : ''}</span>`
            + `<span class="text-gray-400">coverage</span><span>${q.counted ?? q.attempted}/${catalog.taskTotal ?? '?'} tasks</span>`
            + (q.tokensPerSolve ? `<span class="text-gray-400">tokens / solve</span><span>${Math.round(q.tokensPerSolve).toLocaleString()}</span>` : '')
            + (rt && rt.index != null ? `<span class="text-gray-400">relative time</span><span>${rt.index.toFixed(2)}× typical (${rt.tasks} tasks)</span>` : '')
            + `</div>`);
        lines.push(`<div class="mt-1.5 text-gray-300"><b>Config${g.members.length > 1 ? `s rolled up (${g.members.length})` : ''}</b></div>`);
        // identical lines once, with how many configs read that way (several batteries of one Strata config file, 2026-10-20)
        const memberLines = [];
        for (const e of g.members) { const t = configText(e.m, e.c, true), hit = memberLines.find((x) => x.t === t); if (hit) hit.n++; else memberLines.push({ t, n: 1 }); }
        lines.push(`<ul class="list-disc ml-4 text-gray-400">${memberLines.slice(0, 6).map((x) => `<li>${esc(x.t)}${x.n > 1 ? ` <span class="text-gray-500" title="${x.n} configs read the same here: they differ in a setting this line does not show, or ran as separate batteries">×${x.n}</span>` : ''}</li>`).join('')}${memberLines.length > 6 ? `<li>… ${memberLines.length - 6} more</li>` : ''}</ul>`);
        if (g.varies && g.varies.length) lines.push(`<div class="text-amber-300/90">Merged runs differ only in: ${g.varies.map(facetLabel).map(esc).join(', ')} — folded here because they cannot change an answer.</div>`);
        lines.push(`<div class="text-gray-500">Folded on this view: ${folded.length ? folded.map(facetLabel).map(esc).join(', ') : 'nothing (every setting kept apart)'}.</div>`);
        lines.push(`<div class="text-gray-500">Batteries: ${esc(g.dirs.slice(0, 8).join(', '))}${g.dirs.length > 8 ? ` … +${g.dirs.length - 8}` : ''}</div>`);
        if (others && others.length > 1) lines.push(`<div class="mt-1 text-gray-400">This model has ${others.length} configs on this view; this is its best for the ranked column. Others: ${others.filter((o) => o !== g).slice(0, 5).map((o) => { const oa = adj && adj.get(o.key); return esc(shortCfgOf(o.c)) + (oa ? ` ${pctTxt(oa.rate)}` : ''); }).join(' · ')}</div>`);
        lines.push(reportCardHtml(g, adj));   // public too (Kyle 2026-10-14 ~18:45: skills are "not a gameable target")
        return lines.join('');
    }
    // ---- the config's report card: good at X, weak at Y (2026-10-14; ui/shared/leaderboard.js reportCard) ----
    // Per skill tag (codebench tasks/skills.json, via catalog.taskMeta[id].skills): how far the config does better or
    // worse on that tag's tasks than its overall ability predicts, from the same fit as its strength. Labelled only when
    // the 90% interval clears 0. Shown on the public site as well: skill-level numbers only, no task names in it.
    function reportCardHtml(g, adj) {
        let rc = null;
        try { rc = reportCard(g, adj, catalog.taskMeta, catalog.skillTags); } catch { rc = null; }
        if (!rc) return '';
        const sgn = (v) => (v == null ? '—' : `${v > 0 ? '+' : ''}${v.toFixed(2)}`);
        const callChip = (r) => (r.call === 'strength' ? '<span class="px-1 rounded bg-emerald-900/50 text-emerald-200">strength</span>'
            : r.call === 'weakness' ? '<span class="px-1 rounded bg-red-900/50 text-red-200">weakness</span>'
                : `<span class="text-gray-600">${r.ran ? 'no clear difference' : 'not run'}</span>`);
        const rows = rc.tags.map((r) => `<tr class="border-b border-gray-800/50 ${r.ran ? '' : 'text-gray-600'}" title="${esc(`${r.tag}: ${r.def || ''}\nchange in ability on this tag vs the config overall: ${sgn(r.delta)} (90% ${sgn(r.lo)} to ${sgn(r.hi)}); P(better than predicted) ${Math.round(r.pPos * 100)}%\nexpected score on the tag ${r.score == null ? '—' : Math.round(r.score)}/100${r.scoreLo != null ? ` (${Math.round(r.scoreLo)}–${Math.round(r.scoreHi)} over the interval)` : ''}`)}">
              <td class="pr-2 py-0.5 font-mono ${r.ran && !r.thin ? 'text-gray-200' : ''}">${esc(r.tag)}</td>
              <td class="pr-2 py-0.5 text-right font-mono">${r.ran ? `${sgn(r.delta)} <span class="text-gray-500">[${sgn(r.lo)}, ${sgn(r.hi)}]</span>` : '—'}</td>
              <td class="pr-2 py-0.5 text-right font-mono ${r.thin && r.ran ? 'text-amber-300/80' : ''}" title="tasks with this tag the config ran / tasks with this tag${r.thin && r.ran ? ` -- fewer than ${REPORT_CARD_THIN}: thin` : ''}">${r.ran}/${r.tagged}</td>
              <td class="pr-2 py-0.5 text-right font-mono" title="passes / scored runs on those tasks">${r.attempts ? `${r.passes}/${r.attempts}` : '—'}</td>
              <td class="pr-2 py-0.5 text-right font-mono" title="expected score on the tag at this ability, /100, difficulty-weighted as strength is">${r.score == null ? '—' : Math.round(r.score)}</td>
              <td class="py-0.5">${callChip(r)}</td></tr>`).join('');
        return `<div class="mt-2 pt-2 border-t border-gray-800">
            <div class="text-gray-300"><b>Report card</b> <span class="text-gray-500">by skill tag, against this config's own overall strength</span></div>
            <div class="mt-0.5 ${rc.strengths.length || rc.weaknesses.length ? 'text-gray-100' : 'text-gray-400'}">${esc(rc.summary)}</div>
            ${rc.thin ? `<div class="text-amber-300/90">Thin evidence: ${rc.n < 20 ? `only ${rc.n} scored tasks in all` : `${rc.thinTags} of the tags it ran have fewer than ${REPORT_CARD_THIN} tasks`}, so most tags cannot move far from "as predicted".</div>` : ''}
            <table class="mt-1 w-full text-[10px]"><thead><tr class="text-gray-500 border-b border-gray-800">
              <th class="text-left pr-2 font-medium">tag</th><th class="text-right pr-2 font-medium" title="change in ability on the tag's tasks vs what the config's overall ability predicts (logit units), with its 90% interval">vs overall [90%]</th>
              <th class="text-right pr-2 font-medium">ran</th><th class="text-right pr-2 font-medium">passes</th><th class="text-right pr-2 font-medium">score</th><th></th></tr></thead>
              <tbody class="text-gray-400">${rows}</tbody></table>
            <div class="mt-1 text-gray-500">A tag is a strength or weakness only when its whole 90% interval is on one side of 0; the prior (s = ${rc.s}) holds a tag with few tasks near "as predicted". Task difficulty and discrimination come from the same 2PL fit as strength. Labels are rare by design: with no real tag effect, about 1 card in 70 would show one by chance; a config that passes nearly everything has little left to tell its tags apart.</div>
          </div>`;
    }
    // --reasoning off / -rea off changes answers (it is in the quality facets), so short labels must show it
    // One config as [dimension, text] pairs, only on the facets `keep` separates by (see label()).
    const relevantBits = (c, keep) => {
        const f = c.facets || {}, h = f.harness || {}, out = [];
        const has = (k) => keep.includes(k);
        if (has('harness')) {
            out.push(['runner', c.runner && c.runner !== 'opencode' ? harnessLabel(c.runner, c.scaffold) : 'opencode']);
            if (h.effort) out.push(['effort', `effort ${h.effort}`]);
            // the prompt VARIANT: the level is not part of a config (a task at L3 is its own problem, `T@L3`)
            out.push(['prompt', promptVariant(h.prompt_level) ? `prompt +${promptVariant(h.prompt_level)}` : 'default prompt']);
            out.push(['cap', h.timeout_s ? `${Math.round(h.timeout_s / 60)}m cap` : 'cap unrecorded']);
        }
        // the context it is filed under (ctxText: an agent window out of step with its server says so, 2026-10-25)
        if (has('context')) out.push(['ctx', c.n_ctx ? ctxText(c, c.agentWindow ? 'row' : 'short') : 'ctx ?']);
        if (has('kv')) { const k = (f.kv || []).join(' '); const m = /(?:cache-type-k|-ctk)\s+(\S+)/.exec(k); out.push(['kv', `KV ${m ? m[1] : 'f16'}`]); }
        if (has('output')) {
            const o = []; if (thinkOff(c)) o.push('thinking off');
            for (const x of f.output || []) if (x !== '--jinja' && !/^(--reasoning|-rea)\s+off$/.test(x)) o.push(x.replace(/^--/, ''));
            out.push(['output', o.join(' · ') || 'default template']);
        }
        if (has('speculative')) out.push(['spec', c.mtp ? 'MTP' : ((f.speculative || []).length ? 'draft' : 'no MTP')]);
        if (has('placement')) out.push(['placement', (f.placement || []).map(String).join(' ') || 'default placement']);
        if (has('build')) out.push(['build', c.build_info ? (/^Strata/.test(c.build_info) ? c.build_info : `build ${c.build_info}`) : 'build ?']);
        if (has('machine')) out.push(['machine', f.machine && f.machine.fingerprint ? `machine ${String(f.machine.fingerprint).slice(0, 6)}` : 'machine ?']);
        if (has('served')) out.push(['served', f.served || 'date ?']);
        if (has('other')) out.push(['other', (f.other || []).map(String).join(' ') || 'no other flags']);
        if (has(FILE_FACET)) out.push(['file', f[FILE_FACET] ? `${f[FILE_FACET]} copy` : 'original file']);
        return out;
    };
    const thinkOff = (c) => ((c.facets || {}).output || []).some((f) => /^(--reasoning|-rea)\s+off$/.test(f));
    const shortCfgOf = (c) => [ctxText(c, 'short'), c.mtp ? 'MTP' : null, thinkOff(c) ? 'thinking off' : null, c.effort, c.runner === 'pi' ? harnessLabel(c.runner, c.scaffold) : c.scaffold,
        c.timeout_s && `${Math.round(c.timeout_s / 60)}m cap`, cloudTime() === 'split' ? (c.facets || {}).served : null].filter(Boolean).join(' ') || 'config';

    // Which facets separate runs, per board (chips above the board; defaults in FACET_DEFAULTS).
    const facetKeep = {};
    // The candidates are a pure function of (catalog, board, kept facets), and each build runs a strength
    // fit (~150-200 ms): kept until one of the three changes, so sorting a board or painting it again costs nothing
    // (2026-10-06; it was rebuilt on every sort click). The search text is not one of them since 2026-10-10: it
    // highlights rows, it no longer picks them.
    let boardMemo = { of: null, key: null, v: null };
    function boardCandidates(id) {
        const mk = JSON.stringify([id, facetKeep[id] || null, fileRows.speedSplit]);
        if (boardMemo.of === catalog && boardMemo.key === mk) return boardMemo.v;
        const v = buildBoardCandidates(id);
        boardMemo = { of: catalog, key: mk, v };
        return v;
    }
    function buildBoardCandidates(id) {
        const spec = BOARDS[id];
        const groups = new Map();
        // Group every model's finest-grain configs on the kept facets, per set of weights, and
        // compute relative solve time over ALL resulting groups (peers depend on the grouping).
        // (a time board -- source 'full' -- keeps the f32ssm copies apart when the time chip says so, as the time charts do)
        const keep = spec.source === 'full' ? timeKeepWith(facetKeep[id] || FACET_DEFAULTS.full, fileRows) : (facetKeep[id] || FACET_DEFAULTS.quality);
        const allGroups = new Map();
        if (spec.source !== 'speed') {
            for (const [wk, members] of familyGroups(catalog.models || [])) {
                const entries = [];
                for (const m of members) for (const c of (m.configs || [])) if (c.agg && c.agg.attempted) entries.push({ m, c });
                if (entries.length) allGroups.set(wk, groupConfigs(entries, keep));
            }
        }
        const rel = relSolveTimes([...allGroups.values()].flat());
        // Difficulty-weighted solve rate, fitted over every group on this board at once.
        // The charts' fit is the same fit when it ran over the same groups (2026-10-06): the same facets, and group
        // for group the same members -- the charts leave harness-incompatible models out, so one of those on the
        // board means its own fit.
        // 2026-10-14: compared over the models the fit takes (leaderboard.js inQualityFit): a harness-incompatible model's
        // rows (qwen2.5-coder-7b) made the board fit on its own whenever one was in the catalog -- i.e. always -- and 76
        // configs read up to 1.4 points off the solve map's number on the same page. Its rows now show no strength, as on
        // the charts and the Benchmarks board.
        const flat = [...allGroups.values()].flat().filter((g) => inQualityFit(g.m));
        const shared = (() => {
            if (spec.source === 'speed') return null;
            const keepQ = chartKeep.q || storedKeep('models-charts-q', FACET_DEFAULTS.quality);
            if (JSON.stringify(keep) !== JSON.stringify(keepQ)) return null;
            const fit = fitFor(catalog.models, keepQ, timeKeep());
            const size = new Map(fit.qAll.map((g) => [g.key, g.members.length]));
            return flat.length === fit.qAll.length && flat.every((g) => size.get(g.key) === g.members.length) ? fit.adj : null;
        })();
        const adj = shared || difficultyAdjusted(flat);
        for (const [wk, members] of familyGroups(catalog.models || [])) {
            const fam = weightsLabel(members[0]);
            const rows = [];
            const copyRows = new Map();   // f32ssm copies kept apart on speed: tag -> their own rows (the time chip)
            if (spec.source === 'speed') {
                for (const m of members) {
                    if (m.provider !== 'local') continue;
                    for (const c of (m.speedConfigs || [])) {
                        const p = c.at32k;
                        if (!p || (p.prefillTps == null && p.genTps == null)) continue;
                        // One logged request is not a speed: a single 28,858-token prompt "prefilled"
                        // in 3.2 s (9,004 t/s against ~800 for every other config of that model) would
                        // otherwise head the board. A config needs 3 samples at the point to represent a model.
                        if ((p.n || 0) < 3) continue;
                        // Logged requests are banded by NEW prompt tokens (what llama-server's timing line
                        // reports), not by how full the context was; llama-bench rows are true depths.
                        const note = `${p.source}, median over n=${p.n}${p.ctx ? (p.source === 'llama-bench' ? ` at depth ~${Math.round(p.ctx).toLocaleString()}` : ` at ~${Math.round(p.ctx).toLocaleString()} new prompt tokens`) : ''}`;
                        const copy = fileRows.speedSplit && c[FILE_FACET];
                        if (copy && !copyRows.has(copy)) copyRows.set(copy, []);
                        (copy ? copyRows.get(copy) : rows).push({
                            key: copy ? (c.fileFoldedFrom || m.key) : m.key, label: copy ? `${fam} · ${copy} copy` : fam,
                            sublabel: [c.buildId ? `build ${c.buildId}` : null, c.specType, c.ctx && `${ctxLabel(c.ctx)} ctx`].filter(Boolean).join(' · '),
                            sublabelFull: c.id || c.configKey,
                            metrics: {
                                prefill32k: p.prefillTps != null ? { v: p.prefillTps, n: p.n, note } : null,
                                gen32k: p.genTps != null ? { v: p.genTps, n: p.n, note } : null,
                                requests: p.n,
                            },
                            n: p.n, coverage: null, warnings: [],
                        });
                    }
                }
            } else {
                const total = catalog.taskTotal;
                const byW = allGroups.get(wk) || [];
                for (const g of byW) {
                    const { q, metrics } = groupMetrics(g, rel, adj);
                    if (!q.attempted) continue;
                    const m = g.m;
                    const merged = g.members.length > 1
                        ? `${g.members.length} configs merged${g.varies.length ? ` (differing in ${g.varies.map(facetLabel).join(', ')})` : ''}` : null;
                    rows.push({
                        key: m.key, label: fam,
                        sublabel: [configText(m, g.c), merged].filter(Boolean).join(' · '),
                        sublabelFull: g.members.map((e) => configText(e.m, e.c, true)).join('\n') + ' — batteries: ' + g.dirs.join(', '),
                        badges: m.ambiguous ? '<span class="px-1 rounded bg-amber-900/60 text-amber-200 text-[9px]">ambiguous id</span>' : (m.unresolved ? '<span class="px-1 rounded bg-red-900/60 text-red-200 text-[9px]">unresolved</span>' : ''),
                        metrics, n: q.scored,
                        coverage: { attempted: q.counted ?? q.attempted, total: m.taskTotal || total },
                        tasks: g.tasks,
                        warnings: [],
                        _g: g, _adj: adj, _rel: rel, _keep: keep,
                    });
                }
            }
            if (rows.length) groups.set(wk, rows);
            for (const [tag, list] of copyRows) groups.set(`${wk}~${FILE_FACET}:${tag}`, list);
        }
        return groups;
    }

    const metricVal = (m) => {
        const v = m && typeof m === 'object' ? m.v : m;
        if (v && typeof v === 'object') return v.total ? v.passed / v.total : null;   // assertions x/y
        return v == null || !Number.isFinite(Number(v)) ? null : Number(v);
    };
    // ONE row per set of weights: its best candidate on the column being ranked (ties go to more
    // evidence). A model with no value on that column is left off -- on Speed that is the rule
    // (no 32k measurement, not listed); elsewhere it falls back to its best row on the board's
    // default column so it is not silently dropped.
    function rowsForSort(id, colId, dir) {
        const spec = BOARDS[id];
        const out = [];
        for (const rows of boardCandidates(id).values()) {
            // The strength column picks a model's config by the LOW END of its range, as the ladder, the pickers and the
            // Benchmarks board do (Kyle 2026-10-15: "they should all agree"); other columns pick by their value. On the
            // quality boards the pick is leaderboard.js bestConfigOf, the one rule (2026-10-21): only configs with enough
            // scored tasks compete, so a thin config cannot stand for its model on any column. Speed rows keep their own
            // bar (3 samples at the point, above).
            // A cell's `sort` (the strength column's strengthRank, leaderboard.js strengthMetric) is what the board orders
            // by, so the pick reads it too (2026-10-21); other cells their value.
            const pick = (col) => {
                const val = (r) => { const m = r.metrics[col]; return m && typeof m === 'object' && m.sort != null ? m.sort : metricVal(m); };
                const has = rows.filter((r) => val(r) != null);
                if (spec.source !== 'speed') return bestConfigOf(has, (r) => (dir === 'asc' ? -val(r) : val(r)), (r) => r.n || 0);
                let best = null;
                for (const r of has) {
                    const v = val(r), bv = best && val(best);
                    if (!best || (v !== bv ? (dir === 'asc' ? v < bv : v > bv) : (r.n || 0) > (best.n || 0))) best = r;
                }
                return best;
            };
            const best = pick(colId) || (spec.source === 'speed' ? null : pick(spec.defaultSort));
            if (!best) continue;
            const colLabel = ((spec.columns || []).find((c) => c.id === colId) || {}).label || colId;
            out.push({ ...best, sublabel: best.sublabel + (rows.length > 1 ? ` · best of ${rows.length} configs` : ''),
                _others: rows.map((r) => r._g).filter(Boolean), _column: colLabel });
        }
        return out;
    }

    // ------------------------------------------------------------ chart groups (the fit, without the paint)
    // The charts plot CONFIG GROUPS, not whole models: every model's finest-grain configs grouped
    // on the facets chosen in the two chip bars. Quality charts (grid, status mix, frontier y,
    // tokens, GB) default to the quality facets -- speed-only settings collapsed, so quality
    // evidence is never split by MTP, placement, build or machine. Time charts (wall clock,
    // frontier x) default to every facet, since all of those change a wall clock.
    // Out of renderOverview since 2026-10-06, so a task page opened first can have the fit without the overview
    // being drawn (and then hidden) for it. The fit comes from fitFor(): one per catalog object and facet choice,
    // the same object the pickers read -- so nothing here may change it beyond the labels below, which depend only
    // on the facets it is keyed by.
    // The detail page's strength column: the overview's fit by battery dir, on the chart chips (strengthByDir).
    function detailStrength(cat) {
        const keepQ = chartKeep.q || storedKeep('models-charts-q', FACET_DEFAULTS.quality), keepT = timeKeep();
        const k = JSON.stringify([keepQ, keepT]);
        if (strengthDirCache.at !== cat || strengthDirCache.k !== k) Object.assign(strengthDirCache, { at: cat, k, v: strengthByDir(cat.models || [], keepQ, keepT) });
        return strengthDirCache.v;
    }
    function buildChartGroups() {
        const keepQ = chartKeep.q || storedKeep('models-charts-q', FACET_DEFAULTS.quality), keepT = timeKeep();
        // the models whose rows are drawn: every one with quality runs a chart can use
        const shownKeys = new Set((catalog.models || []).filter((m) => m.counts.qualityTasks > 0 && !m.quality.harnessIncompatible
            && (m.configs || []).some((c) => c.agg && c.agg.attempted)).map((m) => m.key));
        // A model's rows are labelled by ONLY what differs among them, on the facets this chart
        // separates by (Kyle, 2026-09-29): "128k MTP 120m cap" on ten rows said nothing -- MTP cannot
        // change an answer (collapsed on quality charts), and a cap or context every row shares is not
        // a difference. g.cfgDiff is that text; '' when the model has a single row.
        const label = (groups, keep) => {
            const perW = new Map();
            for (const g of groups) { const w = weightsOf(g.m); if (!perW.has(w)) perW.set(w, []); perW.get(w).push(g); }
            for (const list of perW.values()) {
                const bits = list.map((g) => new Map(relevantBits(g.c, keep)));
                // per dimension, the value most of this model's rows share (ties: the value of the row
                // with the most scored tasks) -- a row shows only where it departs from that
                const norm = new Map();
                for (const dim of new Set(bits.flatMap((b) => [...b.keys()]))) {
                    const n = new Map();
                    list.forEach((g, i) => { const v = bits[i].get(dim); n.set(v, (n.get(v) || 0) + 1 + ((g.q && g.q.scored) || 0) / 1e6); });
                    norm.set(dim, [...n.entries()].sort((a, b) => b[1] - a[1])[0][0]);
                }
                list.forEach((g, i) => {
                    const diff = [...bits[i].entries()].filter(([d, v]) => v !== norm.get(d)).map(([, v]) => v);
                    g.cfgNorm = [...norm.values()].filter((v) => v && !/^(opencode|default prompt|default template|no other flags)$/.test(v)).join(' · ');
                    g.cfgDiff = list.length > 1 ? (diff.join(' · ') || `standard: ${g.cfgNorm}`) : '';
                    g.label = g.m.display + (list.length > 1 ? ` · ${g.cfgDiff}` : '');
                });
            }
        };
        // PARTIAL POINTS (2026-10-19): with the Solve map's "sub-tests" cells on, the overview's strengths and task
        // difficulties are fitted from the same partial shares the boxes show (leaderboard.js partialCreditOf), each task
        // weighted once; "pass / fail" (the default) is the binary fit. The boards below the charts stay binary.
        const fit = fitFor(catalog.models, keepQ, keepT, { credit: gridCells === 'subtests' ? 'partial' : 'binary' });
        label(fit.qAll, keepQ); label(fit.tAll, keepT);
        // every time group is linked (g.qg) to its quality group; a shown one's is shown too
        const qG = fit.qAll.filter((g) => shownKeys.has(g.m.key));
        const tG = fit.tAll.filter((g) => shownKeys.has(g.m.key));
        // A COPY of the fit's rates: the per-model rows add their own entries (bestPerModel, 'model:<weights>'), which
        // must not land in the map every other reader of this fit shares.
        const adj = new Map(fit.adj);
        for (const k of Object.keys(fit.adj)) adj[k] = fit.adj[k];   // taskDifficulty, taskPoints, models, ...
        // the same for the relative solve times: a row placed at its fastest speed config adds its own entry (fastestFor)
        const rel = new Map(fit.rel);
        Object.defineProperty(rel, 'fit', { value: fit.rel.fit, enumerable: false });
        return { qG, tG, adj, rel, fit, fast: new Map() };
    }

    // A row's SPEED CONFIGS: the time groups (every facet kept apart) of a quality group, or of every quality group of a
    // model for its pooled "combined" row ({ isModel, rep, m }). The compare page's per-config rates and fastestFor read it.
    const speedGroupsOf = (qg) => CG.tG.filter((g) => (qg && qg.isModel ? (qg.rep && CG.qG.some((x) => x === g.qg && weightsOf(x.m) === weightsOf(qg.m))) : g.qg === qg));
    // The row at its fastest speed config (leaderboard.js fastSpeedOf: THE rule, and every task re-priced at that config's
    // rates), once per row per chart fit. null for a row with no measured rate (a cloud model, runs with no request log).
    const fastFor = (qg) => {
        if (!qg) return null;
        const k = qg.isModel ? `model:${weightsOf(qg.m)}` : qg.key;
        if (CG.fast.has(k)) return CG.fast.get(k);
        const tasks = qg.tasks || (qg.isModel ? mergeTasks(CG.qG.filter((x) => weightsOf(x.m) === weightsOf(qg.m)).map((x) => x.tasks)) : {});
        const v = fastSpeedOf(tasks, speedGroupsOf(qg));
        CG.fast.set(k, v ? { ...v, rowTasks: tasks } : null);
        return CG.fast.get(k);
    };

    // (Out of renderOverview since 2026-10-11: the compare page prices a row's time by the same rule.)
    // The time group that goes with a model's chosen quality group: its FASTEST SPEED CONFIG.
    // Since 2026-10-22 that is leaderboard.js fastestSpeedConfig, the one rule (Kyle: "the speed should separately be
    // based on the fastest config ... I wouldn't want the speed to falsely be bogged down by having run low-speed quality
    // runs"): measured throughput at the row's own token mix, with an evidence bar. Before, it was the lowest relative
    // solve time among configs with at least LADDER_MIN_N solved tasks, which kept Flash-Next UD-Q4_K_XL (Strata) on its
    // rb30 runs (~43 tok/s decode) after it had been measured at ~62 on v0.2.2 rb42 -- three tasks each, too few for that bar.
    // When every task of the row ran at that config, it is that config's own time group (measured, as before). When not,
    // it is that config with the ROW'S tasks re-priced at its rates (fastSpeedOf: tool and test time as measured, the
    // model's part at the fastest config), placed on the fit's scale (relIndexOf), and marked `estimated`: a thin config's
    // own handful of tasks would say more about which tasks it ran than about its speed.
    // A row with no measured rate keeps the old rule (lowest relative solve time, or seconds per solve for the raw wall
    // metric; only configs with at least LADDER_MIN_N solved tasks compete, any config when none has: Flash-Next
    // UD-Q2_K_XL's 2-task config (1.36x) was plotted instead of its 31-task one (2.5x)).
    // the charts' tooltip line for a time that is such an estimate (frontier, ladder, wall-clock and per-GB cost charts)
    const estNote = (tg) => (tg && tg.estimated ? `time estimated at its fastest speed config (${speedLabel(tg.from, speedGroupsOf(tg.from && tg.from.qg))}): its tasks' model time re-priced at that config's rates` : null);
    const fastestFor = (qg, raw = false) => {
        const list = speedGroupsOf(qg);
        const fs = fastFor(qg);
        if (fs) {
            const F = fs.fastest.g;
            const all = Object.values(fs.tasks);
            if (all.length && all.every((t) => t.how === 'measured')) return F;
            const k = `${F.key}\u0000at-fastest:${qg.isModel ? weightsOf(qg.m) : qg.key}`;
            if (!CG.fast.has(k)) {
                // the row's tasks at the fastest config; a task its runs could not be re-priced on keeps no wall clock
                const tasks = Object.fromEntries(Object.entries(fs.rowTasks).map(([id, c]) => [id, fs.tasks[id] || { ...c, wall_s: null }]));
                const g = { ...F, key: k, tasks, estimated: true, from: F };
                g.q = qualityMetricsFor(tasks, null);
                CG.rel.set(k, relIndexOf(CG.rel, tasks) || { index: null, tasks: 0, noPeer: 0 });
                CG.fast.set(k, g);
            }
            return CG.fast.get(k);
        }
        const cost = (g) => { if (raw) return g.q.wallPerSolve || Infinity; const r = CG.rel.get(g.key); return r && r.index != null ? r.index : Infinity; };
        const solved = (g) => (raw ? (g.q.solved || 0) : ((CG.rel.get(g.key) || {}).tasks || 0));
        const enough = list.filter((g) => solved(g) >= LADDER_MIN_N);
        return (enough.length ? enough : list).sort((a, b) => cost(a) - cost(b))[0] || null;
    };

    // the Speed x quality card's line under its title, per view (the card's first draw and the view switch)
    const FV_SUB = {
        ladder: 'The quality ladder — every row a rung (the Solve map\'s Rows switch), ranked by the low end of its range, each step priced in the other measure',
        frontier: 'Strength against what it costs to get a solve. Up and to the left is better; the staircase is the frontier — every row on it (the Solve map\'s Rows switch) is not beaten on both at once.',
    };

    let renderGen = 0;      // a newer renderOverview() cancels the older one's deferred work
    function renderOverview() {
        const gen = ++renderGen;
        drawn = catalog;
        boardNow = null;
        detailEl.classList.add('hidden');
        overviewEl.classList.remove('hidden');
        // The search box is replaced with everything else below: a redraw under someone typing in it (a live
        // catalog, Reload) puts the caret back in the new one.
        const oldBox = overviewEl.querySelector('#mv-search');
        const typing = oldBox && document.activeElement === oldBox ? [oldBox.selectionStart, oldBox.selectionEnd] : null;
        const models = catalog.models || [];
        const qModels = models.filter((m) => m.counts.qualityTasks > 0);
        const cov = commonTaskSet(qModels.map((m) => ({ tasks: m.tasks })));
        overviewEl.innerHTML = `
          <!-- On an ultrawide the cards were stretching to the full viewport, which makes a
               chart a letterbox and a table a row of far-apart columns. Cap and centre the
               column; the charts inside cap themselves again. -->
          <div class="space-y-4 max-w-[1600px] mx-auto">
            <div class="flex flex-wrap items-end gap-3 pt-1">
              <div class="min-w-0">
                <h2 class="text-[20px] font-semibold tracking-tight text-white">Results</h2>
                <div class="flex flex-wrap gap-1.5 mt-1.5">
                  <span class="stat-chip"><b>${fmtN((catalog.models || []).length)}</b> models</span>
                  <span class="stat-chip"><b>${fmtN(models.filter((m) => m.provider === 'cloud').length)}</b> cloud</span>
                  <span class="stat-chip"><b>${fmtN(catalog.taskTotal)}</b> codebench tasks</span>
                  <span class="stat-chip"><b>${fmtN(qModels.length)}</b> with quality runs</span>
                </div>
              </div>
              <div class="ml-auto flex items-center gap-2">
                <span id="mv-search-n" class="text-[11px] font-medium text-gray-500 whitespace-nowrap" aria-live="polite" title="catalog models matching the term — each is ringed in gold wherever it is drawn below; nothing is hidden"></span>
                <div class="relative">
                  <svg class="w-3.5 h-3.5 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-500 pointer-events-none" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M9 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM2 9a7 7 0 1112.45 4.39l3.08 3.08a.75.75 0 11-1.06 1.06l-3.08-3.08A7 7 0 012 9z" clip-rule="evenodd"/></svg>
                  <input id="mv-search" placeholder="Highlight models…" value="${esc(search)}" class="field !w-60 !pl-8" aria-label="Highlight models" title="Type part of a model's name, family or quant: matching models get a gold ring in every chart and board below. Nothing is hidden." />
                </div>
                <button id="mv-reload" class="btn btn-sm" title="Reload the catalog">Reload</button>
              </div>
            </div>

            <details class="card-plain group" data-key="mv-grouping">
              <summary class="flex items-center gap-2 px-4 py-2.5 text-[12px] text-gray-300">
                <svg class="w-3.5 h-3.5 text-gray-500 transition-transform group-open:rotate-90" viewBox="0 0 20 20" fill="currentColor"><path fill-rule="evenodd" d="M7.21 14.77a.75.75 0 01.02-1.06L11.17 10 7.23 6.29a.75.75 0 111.04-1.08l4.5 4.25a.75.75 0 010 1.08l-4.5 4.25a.75.75 0 01-1.06-.02z" clip-rule="evenodd"/></svg>
                <span class="font-medium">Config grouping</span>
                <span class="text-gray-500">— which settings split a model into separate rows and points</span>
              </summary>
              <div class="px-4 pb-3 pt-1 space-y-2 border-t border-gray-800">
                <div class="text-[11px] text-gray-500 pt-2">Quality charts (task grid, status mix, frontier height, tokens, GB) collapse speed-only settings by default; time charts (wall clock, frontier position) keep every setting apart. Each chart shows one row / point per model (its best quality config); the task grid's "all configs" toggle lists every config instead, grouped under its model.${PUBLIC ? '' : ' <b class="text-gray-400">tensor split</b>: on, a run spread across two cards with llama.cpp\'s tensor split is a row of its own; off, it is pooled with the same model\'s other runs. <b class="text-gray-400">f32ssm copies</b> (Qwen3.8-27B-GSQ-RCO IQ2_XS / IQ2_S / IQ3_XXS run from local f32-SSM re-saves): off on both bars, their runs are pooled with the original -mtp file\'s; on the quality bar, each copy is a row of its own; on the time bar, the copies keep their own time rows, Speed board row and prefill line.'}</div>
                <div class="flex flex-wrap items-center gap-2"><span class="ctl-label w-24">quality charts</span><div id="mv-cf-q"></div></div>
                <div class="flex flex-wrap items-center gap-2"><span class="ctl-label w-24">time charts</span><div id="mv-cf-t"></div></div>
              </div>
            </details>

            <section class="card">
              <div class="card-head">
                <div class="min-w-0">
                  <h3 class="card-title">Solve map</h3>
                  <div class="card-sub">What each model solved — one box per task, rows ranked by strength (low end of its 95% range)</div>
                </div>
                <div class="card-tools">
                  <span class="ctl"><span class="ctl-label">Rows</span><span class="chip-group">
                    <button type="button" data-chart-rows="combined" class="${toggle('chart-rows', 'combined', chartRows)}" title="One row per model: every config's results pooled, ranked by the model's strength">combined</button>
                    <button type="button" data-chart-rows="top" class="${toggle('chart-rows', 'top', chartRows)}" title="One row per model: its single best config (only configs with at least ${BEST_CONFIG_MIN_N} scored tasks and ${Math.round(BEST_CONFIG_MIN_FRAC * 100)}% of the model's most-tested config compete, so a thin lucky config can't win)">best config per model</button>
                    <button type="button" data-chart-rows="all" class="${toggle('chart-rows', 'all', chartRows)}">all configs</button></span></span>
                  <span class="ctl" title="Cloud models change behind the same name. Split keeps each day's runs of a cloud model as its own config, so you can follow it over time; combine pools them."><span class="ctl-label">Cloud over time</span><span class="chip-group">
                    <button type="button" data-cloud-time="combine" class="${toggle('cloud-time', 'combine', cloudTime())}">combine</button>
                    <button type="button" data-cloud-time="split" class="${toggle('cloud-time', 'split', cloudTime())}">split by date</button></span></span>
                  <span class="ctl"><span class="ctl-label">Cells</span><span class="chip-group">
                    <button type="button" data-grid-cells="outcome" class="${toggle('grid-cells', 'outcome', gridCells)}">pass / fail</button>
                    <button type="button" data-grid-cells="subtests" class="${toggle('grid-cells', 'subtests', gridCells)}">sub-tests</button></span></span>
                  <span class="ctl" title="Compare mode: a box appears beside every row. Tick two rows, then Compare, to see them head to head: what each solved that the other missed, where each one's wins sit, speed, and how sure the difference is."><span class="ctl-label">Compare</span><span class="chip-group">
                    <button type="button" data-compare-mode="off" class="${compareOn ? 'chip' : 'chip is-on'}" aria-pressed="${compareOn ? 'false' : 'true'}">off</button>
                    <button type="button" data-compare-mode="on" class="${compareOn ? 'chip is-on' : 'chip'}" aria-pressed="${compareOn ? 'true' : 'false'}">on</button></span></span>
                </div>
              </div>
              <div class="flex flex-wrap items-center gap-x-4 gap-y-1.5 mb-1 text-[11px] text-gray-400">
                <span class="legend-item"><span class="legend-sw" style="background:${STATUS_COLOR.pass}"></span>pass</span>
                <span class="legend-item"><span class="legend-sw" style="background:linear-gradient(${STATUS_COLOR.pass} 50%, ${STATUS_COLOR.fail} 50%)"></span>passed on some runs</span>
                <span class="legend-item"><span class="legend-sw" style="background:${STATUS_COLOR.TIMEOUT}"></span>timeout</span>
                <span class="legend-item"><span class="legend-sw" style="background:${STATUS_COLOR.fail}"></span>fail</span>
                <span class="legend-item"><span class="legend-sw" style="background:#4a4f5c"></span>excluded</span>
                <span class="legend-item"><span class="legend-sw" style="background:rgba(148,163,184,0.14)"></span>not attempted</span>
                <span class="legend-item" title="counts exactly as a pass; the condition is on hover: the code passed the tests although the run hit the time limit (pass*), or the run stopped to ask a question, the original prompt was re-supplied (re-sent at the end of the run, or a continuation of its saved session), and then it passed, or it passed after the conversation outgrew the context window (the agent compacted and carried on)"><span class="legend-sw" style="background:${SPECIAL_PASS_FILL};box-shadow:inset 0 0 0 1px ${SPECIAL_PASS_EDGE}"></span>passed under special conditions</span>
                <span class="legend-item" title="the run stopped to ask a question that has not been answered with the original prompt yet: in no count, pass rate or strength until it is"><span class="legend-sw" style="background:${UNFINISHED_FILL};background-image:repeating-linear-gradient(135deg, ${UNFINISHED_HATCH} 0 1px, transparent 1px 4px)"></span>unfinished: awaiting answer</span>
                <span class="legend-item"><span class="legend-sw" style="background:transparent;box-shadow:0 0 0 1.5px #93c5fd, 0 0 6px #60a5fa"></span>running now</span>
                <span class="legend-item" title="a task a running battery still has to run (the rest of its list, after the one it is on)"><span class="legend-sw" style="background:rgba(148,163,184,0.14);background-image:radial-gradient(circle, #60a5fa 0 2.5px, rgba(15,23,42,0.9) 2.5px 3.5px, transparent 3.5px)"></span>queued in a running battery</span>
                <details class="how ml-auto"><summary>How to read this</summary><div id="mv-grid-desc" class="how-body"></div></details>
              </div>
              <!-- min width + horizontal scroll: on a phone the labels and ~100 task cells need more
                   room than the screen has; squeezing them clipped the labels and made cells unhittable. -->
              <div id="mv-cmp-bar" class="hidden" style="position:sticky;top:0;z-index:20"></div>
              <div class="w-full overflow-x-auto"><div id="mv-grid-box" style="min-width:980px"><canvas id="mv-chart-grid"></canvas></div></div>
            </section>

            <section class="card">
              <div class="card-head">
                <div class="min-w-0">
                  <h3 class="card-title">Speed × quality</h3>
                  <div class="card-sub" data-fv-sub>${FV_SUB[frontierView]}</div>
                </div>
                <div class="card-tools">
                  <span class="ctl"><span class="ctl-label">View</span><span class="chip-group">
                    <button type="button" data-frontier-view="frontier" class="${toggle('frontier-view', 'frontier', frontierView)}">frontier</button>
                    <button type="button" data-frontier-view="ladder" class="${toggle('frontier-view', 'ladder', frontierView)}">ladder</button></span></span>
                  <span data-fv="frontier" class="ctl ${frontierView === 'ladder' ? 'hidden' : ''}" title="time: relative solve time — a joint fit of wall clock over every config and task (task length factored out; 1× = a typical config), so fast easy solves cannot outweigh fast hard ones. tokens: mean output tokens per solve."><span class="ctl-label">Cost</span><span class="chip-group">
                    <button type="button" data-frontier-x="time" class="${toggle('frontier-x', 'time', frontierX)}">time</button>
                    <button type="button" data-frontier-x="tokens" class="${toggle('frontier-x', 'tokens', frontierX)}">tokens</button></span></span>
                  <span data-fv="frontier" data-fv-cfgs class="ctl ${frontierView === 'ladder' || chartRows === 'all' ? 'hidden' : ''}" title="Draw each model's other configs as small points joined to it by a thin line in the model's colour: how far quantization, context or speculative settings move a model along both axes."><span class="ctl-label">Configs</span><span class="chip-group">
                    <button type="button" data-frontier-cfgs="off" class="${toggle('frontier-cfgs', 'off', frontierCfgs)}">on hover</button>
                    <button type="button" data-frontier-cfgs="trail" class="${toggle('frontier-cfgs', 'trail', frontierCfgs)}">all</button></span></span>
                  <span data-fv="ladder" class="ctl ${frontierView === 'ladder' ? '' : 'hidden'}" title="quality: rungs by solve rate, each step priced in % more time (or tokens) per +1% of solve rate. speed: rungs by time (or tokens), each step priced in % of solve rate given up per halving."><span class="ctl-label">Rungs by</span><span class="chip-group">
                    <button type="button" data-ladder-order="quality" class="${toggle('ladder-order', 'quality', ladderOrder)}">quality</button>
                    <button type="button" data-ladder-order="cost" class="${toggle('ladder-order', 'cost', ladderOrder)}">${ladderX === 'tokens' ? 'tokens' : 'speed'}</button></span></span>
                  <span data-fv="ladder" class="ctl ${frontierView === 'ladder' ? '' : 'hidden'}" title="time: relative solve time of the model's fastest config (joint fit over every config and task; 1× = a typical config). tokens: mean output tokens per solve."><span class="ctl-label">Cost</span><span class="chip-group">
                    <button type="button" data-ladder-x="time" class="${toggle('ladder-x', 'time', ladderX)}">time</button>
                    <button type="button" data-ladder-x="tokens" class="${toggle('ladder-x', 'tokens', ladderX)}">tokens</button></span></span>
                </div>
              </div>
              <div data-fv="frontier" class="${frontierView === 'ladder' ? 'hidden' : ''}">
                <div class="flex flex-wrap items-center gap-x-4 gap-y-1.5 mb-2 text-[11px] text-gray-400">
                  <span class="legend-item"><span class="legend-sw !rounded-full" style="background:#8c91fd"></span>local</span>
                  <span class="legend-item"><span class="legend-sw rotate-45 !rounded-[2px] !w-2 !h-2" style="background:#8c91fd"></span>cloud</span>
                  <span class="legend-item"><span class="inline-block w-5 border-t-2 border-dashed" style="border-color:#a6acff"></span>frontier</span>
                  <span class="legend-item"><span class="inline-block w-px h-3 bg-gray-400"></span>95% range</span>
                  <span class="legend-item text-gray-500">faded = beaten on both axes by a model on the frontier</span>
                  <details class="how ml-auto"><summary>How to read this</summary><div class="how-body">
                    Height is <b>strength /100</b> (whiskers: its 95% range); it accounts for which tasks each config ran, so configs with different task sets are comparable.
                    Horizontal position is the cost of a solve: <b>time</b> is the relative solve time of the model's fastest config (a joint fit of wall clock over every config and task, task length factored out; 1× = a typical config), <b>tokens</b> the mean output tokens per solve.
                    The fastest config is picked by measured throughput (generation and prompt t/s by context depth, priced at the row's own token mix, with at least ${SPEED_MIN_REQ} requests); a row whose runs were not all at it is placed at its tasks re-priced at that config's rates (tool and test time as measured) — an estimate, so slow quality runs do not drag a model right.
                    The dashed staircase joins the models no other model beats on both axes at once; everything under it to the right is dominated.
                    <b>Config trails</b>: hover a model (or pick <b>all</b>) to see its other configs as small points joined to it — how far a quant, context or speculative setting moves it on both axes.
                    Click a point for that model's card; scroll to zoom, drag to pan, double-click to reset.
                    ${cov.rowsCompared > 1 && !cov.allSame ? `<span class="${frontierY === 'raw' ? 'text-amber-300' : ''}">On <b>raw</b>, configs here attempted different task sets (${cov.ids.size} shared), so raw heights are not directly comparable.</span>` : ''}
                  </div></details>
                </div>
                <div class="w-full" style="height:520px"><canvas id="mv-chart-frontier"></canvas></div>
              </div>
              <div data-fv="ladder" class="${frontierView === 'ladder' ? '' : 'hidden'}">
                <details class="how mb-2"><summary>How to read this</summary><div id="mv-ladder-desc" class="how-body"></div></details>
                <div id="mv-ladder-box" class="w-full" style="height:460px"><canvas id="mv-chart-ladder"></canvas></div>
              </div>
              <details class="how mt-3" ${frontierView === 'ladder' ? 'open' : ''} data-key="mv-ladder-table"><summary>Step-by-step cost table</summary>
                <div class="w-full overflow-x-auto mt-2"><div id="mv-ladder-table"></div></div>
              </details>
            </section>

            <div class="grid grid-cols-1 xl:grid-cols-2 gap-4">
              <section class="card">
                <div class="card-head">
                  <div class="min-w-0">
                    <h3 class="card-title">Prefill vs context</h3>
                    <div class="card-sub">Which model stays usable at 64k — local models only</div>
                  </div>
                  <div class="card-tools"><span class="chip-group"><button type="button" data-prefill-mode="model" class="${toggle('prefill-mode', 'model', prefillMode)}" title="one line per model, at the launch config with the most logged requests">per model</button><button type="button" data-prefill-mode="config" class="${toggle('prefill-mode', 'config', prefillMode)}" title="one line per launch config with at least 20 logged requests">every config</button></span></div>
                </div>
                <details class="how mb-2"><summary>How to read this</summary><div class="how-body">Points are medians of logged requests bucketed by context depth when prefill finished (cache hits ≤64 tokens and requests with no recorded depth excluded), or llama-bench depths for a model with no such requests. Tap a legend entry to focus that line (the rest fade back); tap more entries to focus them too, tap a focused one again to let it go. With nothing focused every line is drawn normally. Hover a line to bring it forward. <span id="mv-prefill-note"></span></div></details>
                <div class="w-full" style="height:520px"><canvas id="mv-chart-prefill"></canvas></div>
                <div id="mv-prefill-legend"></div>
              </section>

              <section class="card">
                <div class="card-head">
                  <div class="min-w-0">
                    <h3 class="card-title">Cost per solve</h3>
                    <div class="card-sub" data-cost-sub>${costView === 'tok' ? 'Output tokens per solved task — mean over solved tasks, cheapest first' : costView === 'gb' ? 'Strength per GB of weights, and per second per GB — most quality first; local only (a cloud model has no disk footprint here)' : 'Wall clock per solve, fastest config of each model'}</div>
                  </div>
                  <div class="card-tools"><span class="chip-group">
                    <button type="button" data-cost-view="tok" class="${toggle('cost-view', 'tok', costView)}">tokens</button>
                    <button type="button" data-cost-view="wall" class="${toggle('cost-view', 'wall', costView)}">wall clock</button>
                    <button type="button" data-cost-view="gb" class="${toggle('cost-view', 'gb', costView)}">strength / GB</button></span></div>
                </div>
                <div data-cost-panel="tok" class="${costView === 'tok' ? '' : 'hidden'}">
                  <div class="w-full max-h-[520px] overflow-auto"><div id="mv-cost-tok-box" style="height:380px;min-width:520px"><canvas id="mv-cost-tok"></canvas></div></div>
                </div>
                <div data-cost-panel="wall" class="${costView === 'wall' ? '' : 'hidden'}">
                  <div class="flex flex-wrap items-center gap-x-4 gap-y-2 mb-2">
                    <span class="ctl"><span class="ctl-label">Sort</span><span class="chip-group">
                      <button type="button" data-wall-sort="value" class="${toggle('wall-sort', 'value', wallSort)}">speed</button>
                      <button type="button" data-wall-sort="quality" class="${toggle('wall-sort', 'quality', wallSort)}" title="strength, ranked by the low end of its 95% range (as in the Solve map), highest first">quality</button></span></span>
                    <span class="ctl"><span class="ctl-label">Measure</span><span class="chip-group">
                      <button type="button" data-wall-metric="relative" class="${toggle('wall-metric', 'relative', wallMetric)}">task-weighted</button>
                      <button type="button" data-wall-metric="raw" class="${toggle('wall-metric', 'raw', wallMetric)}">raw mean</button></span></span>
                    <details class="how ml-auto"><summary>About the measures</summary><div class="how-body"><b>task-weighted</b> (default): a joint fit of wall clock over every config and task, with the length of each task factored out — 0.5× is twice as fast as a typical config on the same work. <b>raw mean</b>: plain mean wall clock over solved tasks, which rewards having solved easy tasks.</div></details>
                  </div>
                  <div class="w-full max-h-[520px] overflow-auto"><div id="mv-cost-wall-box" style="height:380px;min-width:520px"><canvas id="mv-cost-wall"></canvas></div></div>
                </div>
                <div data-cost-panel="gb" class="${costView === 'gb' ? '' : 'hidden'}">
                  <div class="text-[11px] text-gray-500 mb-2">Strength /100 ÷ weights on disk in GB (shards summed) — how much quality each GB of VRAM buys. Higher is better.</div>
                  <div class="w-full max-h-[520px] overflow-auto"><div id="mv-cost-gb-box" style="height:380px;min-width:520px"><canvas id="mv-cost-gb"></canvas></div></div>
                  <div class="mt-5 pt-4 border-t border-gray-800">
                    <div class="flex flex-wrap items-start gap-x-4 gap-y-2 mb-2">
                      <div class="min-w-0">
                        <div class="text-[13.5px] font-semibold text-gray-100">Strength per second, per GB</div>
                        <div class="text-[11px] text-gray-500">Strength /100 ÷ (time per solve × GB of weights) — quality for both the time and the memory it costs. Higher is better.</div>
                      </div>
                      <span class="ctl ml-auto"><span class="ctl-label">Time</span><span class="chip-group">
                        <button type="button" data-gbt-metric="relative" class="${toggle('gbt-metric', 'relative', gbtMetric)}" title="relative solve time of the model's fastest config: a joint fit of wall clock over every config and task, task length factored out (1× = a typical config on the same work)">task-weighted</button>
                        <button type="button" data-gbt-metric="raw" class="${toggle('gbt-metric', 'raw', gbtMetric)}" title="plain mean wall-clock seconds per solved task (fastest config) -- rewards having solved easy tasks">raw seconds</button></span></span>
                    </div>
                    <div class="w-full max-h-[520px] overflow-auto"><div id="mv-cost-gbt-box" style="height:380px;min-width:520px"><canvas id="mv-cost-gbt"></canvas></div></div>
                  </div>
                </div>
              </section>
            </div>

            <section class="card space-y-3">
              <div class="card-head !mb-0">
                <div class="min-w-0">
                  <h3 class="card-title">Leaderboards</h3>
                  <div class="card-sub">Summary boards — click any row for that model</div>
                </div>
                <div class="card-tools"><span class="chip-group">
                  ${Object.entries(BOARDS).map(([k, b]) => `<button type="button" data-board="${k}" class="chip">${esc(b.label)}</button>`).join('')}</span></div>
              </div>
              <div id="mv-facets"></div>
              <div id="mv-board"></div>
            </section>

            <section class="card">
              <div class="card-head">
                <div class="min-w-0">
                  <h3 class="card-title">All models</h3>
                  <div class="card-sub">Speed runs · quality batteries · logged requests</div>
                </div>
              </div>
              <div class="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-2">${models.map((m) => `
                <button type="button" data-pick="${esc(m.key)}" class="model-tile">
                  <div class="flex items-center gap-1.5 min-w-0">
                    <span class="truncate text-[12.5px] font-medium text-gray-100">${esc(m.display)}</span>
                    ${m.ambiguous ? '<span class="tag tag-amber">ambiguous</span>' : ''}
                    ${m.unresolved ? '<span class="tag tag-red">unresolved</span>' : ''}
                    ${m.provider === 'cloud' ? '<span class="tag tag-sky">cloud</span>' : ''}</div>
                  <div class="flex gap-3 mt-1 text-[11px] text-gray-500">
                    <span><span class="text-gray-300 font-mono">${m.counts.benchRuns + m.counts.sweepRows}</span> speed</span>
                    <span><span class="text-gray-300 font-mono">${m.counts.qualityBatteries}</span> quality</span>
                    <span><span class="text-gray-300 font-mono">${fmtN(m.counts.requests)}</span> requests</span></div>
                </button>`).join('')}</div>
            </section>
          </div>`;

        const si = overviewEl.querySelector('#mv-search');
        if (typing) { si.focus(); try { si.setSelectionRange(typing[0], typing[1]); } catch { /* not a text input */ } }
        // Typing re-styles in place (applyHighlight): the page is not drawn again, so the box keeps its focus and
        // caret by itself. Debounced so a word typed quickly repaints once, not once per letter.
        let searchTimer = null;
        si.addEventListener('input', () => {
            search = si.value;
            clearTimeout(searchTimer);
            searchTimer = setTimeout(applyHighlight, 80);
        });
        overviewEl.querySelector('#mv-reload').addEventListener('click', () => { drawn = null; load(true); });   // asked for by hand: drawn again even when the server says nothing changed
        overviewEl.querySelectorAll('[data-pick]').forEach((b) => b.addEventListener('click', () => openModel(b.dataset.pick)));

        // charts
        // Every measured point, not the two-or-three summary ones. The falloff between 8k and
        // 64k is the whole question this chart asks, and a line drawn between two endpoints
        // cannot show it -- Flash-Next holding flat and a dense 27B collapsing look identical.
        // Logged requests first (that is real workload), llama-bench depths where there are no
        // requests (clean, but synthetic).
        // One line per model at its most-used launch config, every model with data (ui/models/prefill.js);
        // "every config" splits each model into its configs with >=20 requests. 20 hues x 3 dash styles
        // give 60 distinct lines before any pair repeats, so nothing folds out any more.
        // Line FOCUS (2026-10-14, Kyle: tap a legend entry to focus it, tap another to focus it too, tap a focused one
        // again to let it go; none focused = every line normal). The focused set is remembered per viewer and per mode
        // (ui/models/prefill.js loadFocus; an id no longer on the chart is dropped). Nothing is ever hidden: the rest fade.
        const lineStore = () => { try { return window.localStorage; } catch { return null; } };
        const paintPrefill = () => {
        const prefillLines = prefillSeries(fileSpeedModels(models, fileRows.speedSplit && fileRows.quality === 'merge'), prefillMode);
        const mode = prefillMode;
        const ids = lineIds(prefillLines, mode);
        let focused = resolveFocus(loadFocus(lineStore(), 'prefill', mode), ids);
        saveFocus(lineStore(), 'prefill', mode, focused);   // stale ids out of storage too
        let legend = null;
        const chart = prefillVsContext('mv-chart-prefill', prefillLines, { ids, focused });
        const setFocused = (next) => {
            focused = next;
            saveFocus(lineStore(), 'prefill', mode, focused);
            setLineFocus(chart, focused);
            if (legend) legend.set(focused);
        };
        legend = focusLegend(overviewEl.querySelector('#mv-prefill-legend'), {
            items: prefillLines.map((s, i) => ({ id: ids[i], label: s.label, config: s.config, n: s.n, row: s, ...lineStyle(i) })),
            focused, status: focusLabel,
            onToggle: (id) => setFocused(toggleFocus(focused, id)),
            onClear: () => setFocused(new Set()),
            onHover: (id) => setLineHover(chart, id),
        });
        if (chart) chart.$onHl = legend.paintHl;
        const pNote = overviewEl.querySelector('#mv-prefill-note');
        if (pNote) {
            const nModels = new Set(prefillLines.map((x) => x.key)).size;
            pNote.textContent = (prefillMode === 'config'
                ? `${prefillLines.length} lines over ${nModels} models: every launch config with at least 20 depth-bearing requests (a model with none that large keeps its one line).`
                : `${nModels} models, each at its most-used launch config (most depth-bearing requests; the tooltip names it), or switch to "every config".`)
                + ' The focused lines are remembered on this device, per mode.';
        }
        };
        paintPrefill();

        // ------------------------------------------------------------ chart groups
        // The charts plot CONFIG GROUPS, not whole models: every model's finest-grain configs grouped
        // on the facets chosen in the two chip bars. Quality charts (grid, status mix, frontier y,
        // tokens, GB) default to the quality facets -- speed-only settings collapsed, so quality
        // evidence is never split by MTP, placement, build or machine. Time charts (wall clock,
        // frontier x) default to every facet, since all of those change a wall clock.
        // The fits (task difficulty, difficulty-weighted rates, relative solve time) are GLOBAL: they
        // run over every model, whatever the search box says. (The box was a filter until 2026-10-10 and
        // fitting only the filtered models made the task columns reorder, and even disappear, as it
        // changed -- Kyle, 2026-09-25. It now only highlights: every row is drawn, the matches in gold.)
        // The fit itself is buildChartGroups() above (shared with the task page and, through fitFor, the pickers).
        const shortCfg = (c) => [ctxText(c, 'short'), c.mtp ? 'MTP' : null, thinkOff(c) ? 'thinking off' : null, c.effort, c.runner === 'pi' ? harnessLabel(c.runner, c.scaffold) : c.scaffold,
            c.timeout_s && `${Math.round(c.timeout_s / 60)}m cap`, cloudTime() === 'split' ? (c.facets || {}).served : null].filter(Boolean).join(' ');
        const lb95 = (k, n) => {
            if (!n) return null;
            const z = 1.96, p = k / n, d = 1 + (z * z) / n;
            return ((p + (z * z) / (2 * n)) - z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
        };
        const fmtRel = (v) => `${v < 1 ? v.toFixed(2) : v.toFixed(1)}×`;
        CG = null;   // current chart groups; rebuilt when a chip changes
        const rebuildChartGroups = () => { CG = buildChartGroups(); };
        const rankValue = (g, how) => {
            if (how === 'ratio') return g.failed > 0 ? g.passed / g.failed : (g.passed > 0 ? Infinity : -1);
            const a = CG.adj.get(g.key);
            // robust = the LOWER end of the difficulty-weighted interval: difficulty AND evidence in one
            if (how === 'raw') return g.q.solveRate != null ? g.q.solveRate : -1;
            // RANK BY THE LOW END of the strength range (Kyle, 2026-09-29): a thin record's wide range
            // leaves its low end low, so proven results outrank unproven ones; strength itself is still shown.
            // leaderboard.js strengthRank, the one place that order lives (2026-10-21).
            return strengthRank(a);
        };

        // frontier: one point per TIME group, at the solve rate of the QUALITY group it belongs to
        // A row's key and name under the Rows switch, for every chart that follows it (the frontier, the ladder, the cost
        // charts; 2026-10-21, Kyle: "the speedxquality chart should follow whatever is selected at the top").
        const rowName = (qg) => ({ key: chartRows === 'combined' ? qg.m.key : qg.key,
            label: chartRows === 'all' ? qg.label : chartRows === 'top' ? `${qg.m.display} · ${qg.cfgDiff || qg.cfgNorm || 'best config'}` : qg.m.display });
        // frontier: one point per row of the Rows switch (combined: the model; best config per model; all configs),
        // placed at the fastest speed config of that row (time axis) or its tokens per solve
        const paintFrontier = () => {
            const picks = rowsPerModel(frontierY === 'raw' ? 'raw' : gridRank === 'robust' ? 'robust' : 'adjusted');
            const pts = picks.map(({ g: qg, others }) => {
                const a = CG.adj.get(qg.key);
                const rawCi = wilson(qg.passed, qg.passed + qg.failed);
                const y = frontierY === 'raw' ? qg.q.solveRate : (a ? a.rate : null);
                const ci = frontierY === 'raw' ? rawCi : (a ? { lo: a.lo, hi: a.hi } : null);
                const tg = fastestFor(qg);
                const rt = tg ? CG.rel.get(tg.key) : null;
                // Config trail (2026-10-01): each of the model's configs at its own strength and its own fastest
                // speed config -- how far a quant or a setting moves the model on both axes. Best-per-model only
                // ("all configs" already plots every config as its own point).
                // Always computed; drawn for every model with "show trails", else only for the hovered one.
                const trail = chartRows === 'combined' && others && others.length > 1
                    ? others.map((cg) => {
                        const ca = CG.adj.get(cg.key), ctg = fastestFor(cg), crt = ctg ? CG.rel.get(ctg.key) : null;
                        const cx = frontierX === 'tokens' ? (cg.q.tokensPerSolve || null) : (crt && crt.index != null ? crt.index : null);
                        return ca && cx != null ? { x: cx, y: ca.rate, label: cg.cfgDiff || cg.label || '' } : null;
                    }).filter(Boolean)
                    : null;
                return { ...rowName(qg),
                    solveRate: y, lo: ci ? ci.lo : null, hi: ci ? ci.hi : null,
                    x: frontierX === 'tokens' ? (qg.q.tokensPerSolve || null) : (rt && rt.index != null ? rt.index : null),
                    xNote: frontierX === 'tokens' ? null : estNote(tg),
                    trail: trail && trail.length > 1 ? trail : null,
                    provider: qg.m.provider, n: qg.q.scored, attempted: qg.q.counted ?? qg.q.attempted, total: catalog.taskTotal, _g: qg, _others: others };
            }).filter((p) => p.solveRate != null);
            return solveRateVsCost('mv-chart-frontier', pts, (key, ev) => {
                const p = pts.find((x) => x.key === key);
                if (!p) return;
                showPopover(ev ? ev.clientX : 200, ev ? ev.clientY : 200,
                    groupDetailHtml(p._g, { adj: CG.adj, keep: chartKeep.q || FACET_DEFAULTS.quality, others: p._others, column: rankLabel() }),
                    { pin: true, actions: [{ label: 'Model details →', onClick: () => openModel(p._g.m.key) }] });
            }, {
                ...(frontierX === 'tokens' ? {} : { xLabel: 'relative solve time of its fastest config (joint fit, 1× = typical config; left is faster)', log: true,
                    fmtX: (v) => `${fmtRel(v)} time`, tick: (v) => fmtRel(Number(v)) }),
                yLabel: frontierY === 'raw' ? 'raw solve rate (95% Wilson interval)' : 'strength /100 (95% range)',
                pareto: true, trails: frontierCfgs === 'trail',
                ...(frontierX === 'tokens' ? { xLabel: 'output tokens per solved task (log) — left is cheaper' } : {}),
            });
        };

        // "best per model" = the MODEL, not its luckiest config (Kyle, 2026-09-29): a max over configs with
        // unequal evidence rewards the thinnest row (winner's curse). One row per model: every config's tasks
        // pooled (fractional credit), ranked by MODEL strength (the hierarchical fit's model ability at the
        // baseline settings, fit.adj.models). Its representative config (for popups, time, cost) is the
        // model's most-tested config. "all configs" still shows every config with its own strength.
        const modelRowCache = new Map();
        const bestPerModel = () => {
            const byW = new Map();
            for (const g of CG.qG) { const w = weightsOf(g.m); if (!byW.has(w)) byW.set(w, []); byW.get(w).push(g); }
            const out = [];
            for (const [w, list] of byW.entries()) {
                const rep = list.slice().sort((a, b) => (b.q.attempted - a.q.attempted) || (rankValue(b) - rankValue(a)))[0];
                let mg = modelRowCache.get(w);
                if (!mg || mg._cg !== CG) {
                    const tasks = mergeTasks(list.map((g) => g.tasks));
                    const scored = Object.values(tasks).filter((t) => !t.excluded && t.credit != null);
                    mg = { key: 'model:' + w, m: rep.m, c: rep.c, tasks, unfinished: mergeUnfinished(list.map((g) => g.unfinished)), members: list.flatMap((g) => g.members || []),
                        dirs: list.flatMap((g) => g.dirs || []), varies: [], q: qualityMetricsFor(tasks, null),
                        passed: scored.reduce((a, t) => a + t.credit, 0), label: rep.m.display, isModel: true, rep, _cg: CG };
                    mg.failed = scored.length - mg.passed;
                    const ms = CG.fit.adj.models && CG.fit.adj.models.get(w);
                    if (ms) CG.adj.set(mg.key, { ...ms, strength: ms.strength });
                    modelRowCache.set(w, mg);
                }
                out.push({ g: mg, others: list });
            }
            return out;
        };
        // "all configs": every quality group, clumped by model (models in the order of their best
        // group, configs within a model best first). Each entry still carries the model's full list.
        // "best config per model" (Kyle, 2026-10-03): the model's single best config, but only among configs with real
        // evidence (>= 10 scored tasks and >= a quarter of its most-tested config), else its most-tested config.
        // The rule itself is leaderboard.js bestConfigOf, the one place it lives (2026-10-21).
        const topConfigOf = (list, how) => bestConfigOf(list, (g) => rankValue(g, how));
        const rowsPerModel = (how = gridRank) => {
            if (chartRows === 'top') {
                return bestPerModel(how).map(({ others }) => ({ g: topConfigOf(others, how), others }))
                    .sort((a, b) => (rankValue(b.g, how) - rankValue(a.g, how)) || (b.g.q.attempted - a.g.q.attempted));
            }
            const best = bestPerModel(how).sort((a, b) => (rankValue(b.g, how) - rankValue(a.g, how)) || (b.g.q.attempted - a.g.q.attempted));
            if (chartRows !== 'all') return best;
            return best.flatMap(({ g, others }) => others.slice()
                .sort((a, b) => (a === g ? -1 : b === g ? 1 : 0) || (rankValue(b, how) - rankValue(a, how)) || (b.q.attempted - a.q.attempted))
                .map((x, i) => ({ g: x, others, secondary: i > 0 })));
        };
        const rankLabel = () => ({ adjusted: 'strength /100', robust: 'robust (lower bound of the difficulty-weighted rate)', ratio: 'pass ratio' }[gridRank]);
        const GRID_DESC = {
            adjusted: '<b class="text-gray-300">Ranked by strength /100</b>: difficulty-weighted points over the whole corpus — the expected score on every task at the ability a model\'s results give it, from a Rasch fit over every model and task. Ranked by the LOW end of each range, so a thin record cannot outrank a proven one; the tag after each name is the strength [range] and how much of it was actually tested.',
            robust: '<b class="text-gray-300">Ranked robust</b>: the lower end of each model\'s 95% difficulty-weighted interval — what its solve rate is <i>at least</i>, given both how hard its tasks were and how many it ran. A 3/3 record ranks below a 90/100 one here.',
            ratio: '<b class="text-gray-300">Ranked by pass ratio</b>: passes ÷ failures, with no allowance for task difficulty or amount of evidence — 1 pass and 0 failures ranks first.',
        };
        const chartRowPick = (rows) => (key, ev) => {
            const r = rows.find((x) => x.key === key);
            if (!r || !r._g) return;
            showPopover(ev ? ev.clientX : 200, ev ? ev.clientY : 200,
                groupDetailHtml(r._g, { adj: CG.adj, keep: chartKeep.q || FACET_DEFAULTS.quality, others: r._others, column: rankLabel() }),
                { pin: true, actions: [{ label: 'Model details →', onClick: () => openModel(r._g.m.key) }] });
        };
        // A tap INSIDE the grid is a cell: one model on one task. It opens a small card naming what
        // was hit (at phone width a cell is a few px, so a tap has to be confirmable before it
        // navigates) with both ways out: the task's page and the model's. The row labels on the left
        // still open the model card directly.
        const cellPick = (task, r, ev, { cell, counts }) => {
            if (!r || !r._g) return;
            const meta = (catalog.taskMeta || {})[task] || {};
            const dr = difficultyRank(CG.adj.taskDifficulty, task);
            showPopover(ev ? ev.clientX : 200, ev ? ev.clientY : 200,
                `<div class="text-xs font-semibold text-gray-100 font-mono break-all">${esc(task)}</div>`
                + `<div class="text-gray-400">${[meta.level && `prompt ${meta.level} (a problem of its own)`, meta.unscored && `not scored yet: ${meta.scoredConfigs || 0} of ${catalog.levelMinConfigs || LEVEL_MIN_CONFIGS} configs`, meta.repo, meta.variant, meta.tier && 'tier ' + meta.tier].filter(Boolean).map(esc).join(' · ') || 'codebench task'}</div>`
                + `<div class="mt-1.5"><span class="text-gray-400">${esc(r._g.label || r._g.m.display)}:</span> <b>${esc(cell.t)}</b></div>`
                // pass*: the category note everywhere; the lab adds the run's wall clock (charts.js capWallLine)
                + (cell.atCap ? `<div class="mt-1 pl-2" style="border-left:3px solid ${SPECIAL_PASS_EDGE}"><div class="text-gray-300">${esc(PASS_AT_CAP_NOTE)}</div>${cell.capWall ? `<div class="text-gray-400">${esc(capWallLine(cell.capWall))}</div>` : ''}</div>` : '')
                + (cell.answered ? `<div class="mt-1 pl-2" style="border-left:3px solid ${SPECIAL_PASS_EDGE}"><div class="text-gray-300">${esc(answeredCategory(cell.answered, cell.answered.passed > 0 ? 'passed' : 'failed'))}</div>${answeredLines(cell.answered).map((l) => `<div class="text-gray-400">${esc(l)}</div>`).join('')}</div>` : '')
                + (cell.unfinished ? `<div class="mt-1 pl-2" style="border-left:3px solid ${UNFINISHED_FILL}"><div class="text-gray-300">${esc(unfinishedCategory(cell.unfinished))}${cell.unfinishedOnly ? '' : ' (another run of it)'}</div>${unfinishedLines(cell.unfinished).map((l) => `<div class="text-gray-400">${esc(l)}</div>`).join('')}</div>` : '')
                + `<div class="text-gray-500">${counts.seen ? `solved by ${counts.solved} of ${counts.seen} rows here` : 'no row here has run it'}${dr ? ` · ${dr.text} by difficulty` : ''}</div>`,
                { pin: true, actions: [...(PUBLIC ? [] : [{ label: 'Task page →', onClick: () => openTask(task) }]), { label: 'Model details →', onClick: () => openModel(r._g.m.key) }] });
        };
        // cost bars: each row carries its model's chosen group and the rest of its configs
        const chartRowPickRows = (key, ev, r) => {
            if (!r || !r._g) return;
            showPopover(ev ? ev.clientX : 200, ev ? ev.clientY : 200,
                groupDetailHtml(r._g, { adj: CG.adj, keep: chartKeep.q || FACET_DEFAULTS.quality, others: r._others, column: rankLabel() }),
                { pin: true, actions: [{ label: 'Model details →', onClick: () => openModel(r._g.m.key) }] });
        };
        let gridChart = null;   // the Solve map's chart, so a tick only repaints it
        const paintGrid = () => {
            const desc = overviewEl.querySelector('#mv-grid-desc');
            if (desc) desc.innerHTML = `${GRID_DESC[gridRank] || ''} Tasks run in the same order on every row: <b class="text-gray-300">easiest on the left, hardest on the right</b>, by task difficulty from the same fit (recomputed as results arrive; tasks nobody has run sit at the far right). Green is a pass, a green-over-red cell a task passed on only some of its runs, amber a timeout, red a miss, dark grey excluded, faint grey never attempted. <b class="text-gray-300">Dark green</b> (with a light edge): passed under special conditions — it counts exactly as a pass, and the hover says which condition: the code passed the tests although the run hit the time limit (pass*), or the run stopped to ask a question, the original prompt was re-supplied (re-sent at the end of the run, or a continuation of its saved session), and then it passed, or it passed after the conversation outgrew the context window (the agent compacted and carried on). <b class="text-gray-300">Hatched mid gray</b>: unfinished — the run stopped to ask a question not yet answered with the original prompt; it is in no count, pass rate or strength until it is. A <b class="text-gray-300">glowing blue outline</b> is the task a battery is running now; a <b class="text-gray-300">blue dot</b> is a task that battery still has queued (the rest of its list). Tap a model's name for its details, or a box for that task: its page lists every model that ran it.${gridCells === 'subtests' ? ' <b class="text-gray-300">Sub-tests view</b>: each box shows <b class="text-gray-300">progress beyond base</b>: of the hidden-test cases the untouched base code fails, the share the runs turned green (hover: "+1 of 6 new"), summed over its runs; an amber corner marks regressions (cases the base passes that the run broke). Tasks without a recorded baseline show the raw share of assertions passed; results recorded before assertions were logged keep their pass/fail colour; ≈ marks figures derived from totals or an older oracle version. <b class="text-gray-300">Strength in this view is fitted from these partial points</b> (each task counted once, whatever its number of sub-tests), not from pass / fail; the task order follows that fit too.' : ''}${chartRows === 'all' ? ' <b class="text-gray-300">All configs</b>: every config a model ran, indented under its best one.' : ''}`;
            const rateTag = (g) => { const a = CG.adj.get(g.key); return a ? `  ${Math.round(a.rate * 100)} [${Math.round(a.lo * 100)}–${Math.round(a.hi * 100)}] · ${Math.round((a.coverage || 0) * 100)}% tested` : ''; };   // strength /100, 95% range, coverage
            // sub-tests: colour each box by the hidden-test assertions passed over all its runs, so a
            // near miss (8 of 9) reads differently from a flat fail; boxes with no assertion record
            // (older results) keep their pass/fail colour.
            // With a baseline (tools/baselines.py) the box shows PROGRESS BEYOND BASE: the share of the
            // cases that fail on the untouched base which the runs turned green ("+1 of 6 new"), since
            // most raw sub-test credit is cases the base already passes. Regressions (base passes the
            // run broke) are marked on the box. Without a baseline: raw assertions, as before.
            const cellsOf = (tasks) => gridCells !== 'subtests' ? tasks : Object.fromEntries(Object.entries(tasks).map(([id, t]) => {
                if (t.excluded) return [id, t];
                const p = t.progressAll, a = t.assertionsAll;
                const tail = (t.status === 'TIMEOUT' ? 'TIMEOUT' : 'fail');
                if (p && p.of > 0) {
                    const txt = `${p.approx ? '≈ ' : ''}+${p.count} of ${p.of} new beyond base${p.runs > 1 ? ` (over ${p.runs} runs)` : ''}`
                        + `${p.regressions ? ` · ${p.regressions} regression${p.regressions === 1 ? '' : 's'} (base passes now failing)` : ''}`
                        + `${a ? ` · raw ${a.passed}/${a.total}` : ''}${p.approx ? ' · approximate: from totals or an older oracle version' : ''}`;
                    return [id, { ...t, credit: partialCreditOf(t), passes: p.count, attempts: p.of, status: t.credit >= 1 ? t.status : tail, cellText: txt, regress: p.regressions || 0 }];
                }
                if (!a || !a.total) return [id, t];
                const f = a.passed / a.total;
                return [id, { ...t, credit: partialCreditOf(t), passes: a.passed, attempts: a.total, status: f >= 1 ? 'pass' : tail, cellText: `passed ${a.passed} of ${a.total} sub-tests (raw: no baseline for this task yet)` }];
            }));
            // Structured label fields for the grid's label table (charts.js taskGrid): name | strength [range] | tested.
            // `label` stays the full one-line text -- it is the tooltip title.
            const tagOf = (g) => { const a = g && CG.adj.get(g.key); return a ? { strength: Math.round(a.rate * 100), lo: Math.round(a.lo * 100), hi: Math.round(a.hi * 100), coverage: a.coverage || 0 } : {}; };
            const rows = rowsPerModel().map(({ g, others, secondary }) => ({
                key: chartRows === 'combined' ? g.m.key : g.key,
                label: chartRows === 'all'
                    ? (secondary ? '   ↳ ' + (g.cfgDiff || 'config') : g.label) + rateTag(g)
                    : chartRows === 'top'
                        ? g.m.display + rateTag(g) + ` · best of ${others.length} cfg${others.length > 1 ? 's' : ''}: ${g.cfgDiff || g.cfgNorm || g.label}`
                        : g.m.display + rateTag(g) + (others.length > 1 ? ` · ${others.length} cfgs` : ''),
                name: chartRows === 'all' ? (secondary ? '↳ ' + (g.cfgDiff || 'config') : g.label) : g.m.display,
                note: chartRows === 'top' ? (g.cfgDiff || g.cfgNorm || '') : chartRows !== 'all' && others.length > 1 ? `${others.length} configs` : '',
                secondary: chartRows === 'all' && !!secondary, ...tagOf(g),
                tasks: cellsOf(g.tasks), ...(g.unfinished ? { unfinished: g.unfinished } : {}), rank: rankValue(g, gridRank), attempted: g.q.attempted, _g: g, _others: others }));
            // Running now: outline the cell of every task a battery is on. A battery's config not shown as a row (best per
            // model, and not the best config) gets its own "testing now" row under its model, so it is always visible.
            const keepQ = chartKeep.q || FACET_DEFAULTS.quality;
            const keyOf = (facets) => JSON.stringify(['weights', ...keepQ].map((k) => [k, (facets || {})[k] ?? null]));
            const groupForRun = (run) => {
                const dir = run.dir;
                const hit = CG.fit.qAll.find((x) => (x.dirs || []).includes(dir));
                if (hit) return hit;
                for (const m of catalog.models || []) for (const c of m.configs || []) {   // in the catalog, not in a chart group
                    if (!(c.dirs || []).includes(dir)) continue;
                    return CG.fit.qAll.find((x) => x.key === keyOf(c.facets)) || { pseudo: true, m, label: m.display };
                }
                // No scored task yet, so the catalog does not know this battery -- for up to a whole task (2 h) its
                // cell sat in a new row at the bottom, as if the config were untested (Kyle, 2026-10-07). The server
                // says which row its results WILL be filed under (lib/models.js describeRunning: the same model
                // identity and facets as a stored row, from its launch): that row, else that model.
                if (run.modelKey) {
                    const g = run.facets ? CG.fit.qAll.find((x) => x.key === keyOf(run.facets)) : null;
                    if (g) return g;
                    const m = (catalog.models || []).find((x) => x.key === run.modelKey);
                    if (m) return { pseudo: true, m, label: m.display };
                }
                return null;
            };
            for (const filed of runningNow) {
                if (!filed.task) continue;
                const run = foldFileRun(foldTensorRun(filed, catalog.tensorFolded), catalog);   // rows combined: a tensor-split battery is its base model's, an f32ssm copy's its original file's
                // a config with no stored run at all: a row of its own, named as its results will be (or after the battery)
                const g = groupForRun(run) || { pseudo: true, m: null, label: run.modelDisplay || run.dir };
                // best per model: each row POOLS every config of its weights, so a running config of a shown model is
                // that row (only a model with no row at all gets a "testing now" row); all configs: its own row
                let row = rows.find((x) => x._g === g)
                    || (chartRows !== 'all' && g.m && rows.find((x) => x._g && x._g.m && weightsOf(x._g.m) === weightsOf(g.m)));
                if (!row) {
                    row = g.pseudo
                        ? { key: 'run:' + run.dir, label: '⟳ testing now: ' + g.label, name: '⟳ testing now: ' + g.label, pending: true, tasks: {}, rank: -1, attempted: 0, _g: null, _m: g.m, _others: [] }
                        : { key: 'run:' + g.key, label: '   ⟳ testing now: ' + (chartRows === 'all' ? g.label : (g.cfgDiff || g.cfgNorm || g.label)) + rateTag(g),
                            name: '⟳ testing now: ' + (chartRows === 'all' ? g.label : (g.cfgDiff || g.cfgNorm || g.label)), pending: true, secondary: true, ...tagOf(g),
                            tasks: cellsOf(g.tasks), ...(g.unfinished ? { unfinished: g.unfinished } : {}), rank: rankValue(g, gridRank), attempted: g.q.attempted, _g: g, _others: [g] };
                    let at = -1;   // under its model's rows; else under the rows of the same weights (another effort of a cloud model)
                    rows.forEach((x, i) => { if (x._g && g.m && x._g.m.key === g.m.key) at = i; });
                    if (at < 0) rows.forEach((x, i) => { if (x._g && g.m && x._g.m && weightsOf(x._g.m) === weightsOf(g.m)) at = i; });
                    if (at >= 0) rows.splice(at + 1, 0, row); else rows.push(row);
                }
                // the cell is its PROBLEM's: a battery at prompt L3 is on `T@L3` (the server's `level`, describeRunning)
                const cell = problemId(run.task, run.level);
                (row.running = row.running || new Set()).add(cell);
                (row.runDirs = row.runDirs || new Map()).set(cell, run.dir);
                // the rest of its list (2026-10-24, Kyle: "blue dots inside every rectangle that is planned in the current
                // running queued set"), as problems at its level, on the same row
                for (const t of run.planned || []) (row.planned = row.planned || new Set()).add(problemId(t, run.level));
            }
            // Compare mode: only the ticks that still have a row here survive a redraw (see comparePicks, top of init).
            if (compareOn && comparePicks.length) {
                const had = comparePicks.length, moved = comparePicksRows !== chartRows;
                comparePicks = moved ? [] : comparePicks.map((p) => { const r = rows.find((x) => rowPickId(x) === p.id); return r ? { id: p.id, cid: rowCompareId(r), name: rowCompareName(r) } : null; }).filter(Boolean);
                if (comparePicks.length < had) compareHint = moved ? 'The Rows view changed, so the ticks were cleared.' : 'A ticked row is no longer on the map, so its tick was dropped.';
            }
            // 'on' | 'off' | null (a "testing now" row has no finished record to compare). No 'dim' since 2026-10-20: any number may be ticked
            const pickState = (r) => { const id = rowPickId(r); return !id ? null : comparePicks.some((p) => p.id === id) ? 'on' : 'off'; };
            // In compare mode a click on a row's label (its box or its name) ticks or unticks it, instead of opening its card.
            const togglePick = (key) => {
                const r = rows.find((x) => x.key === key), id = rowPickId(r);
                const at = id ? comparePicks.findIndex((p) => p.id === id) : -1;
                hidePopover(true);
                if (!id) compareHint = 'That row is still being tested: it has no finished record to compare yet.';
                else if (at >= 0) { comparePicks.splice(at, 1); compareHint = ''; }
                else { if (!comparePicks.length) comparePicksRows = chartRows; comparePicks.push({ id, cid: rowCompareId(r), name: rowCompareName(r) }); compareHint = ''; }
                if (gridChart) { try { gridChart.draw(); } catch { /* destroyed under us */ } }
                paintCompareBar();
            };
            const box = overviewEl.querySelector('#mv-grid-box');
            if (box) box.style.height = Math.max(160, rows.length * 22 + 44) + 'px';   // + the header strip (layout.padding.top)
            // easiest -> hardest by the fit's task difficulty; never-attempted tasks after
            const td = CG.adj.taskDifficulty || new Map();
            const attempted = [...td.keys()].sort((a, b) => td.get(a) - td.get(b));
            const order = attempted.concat((catalog.allTaskIds || []).filter((t) => !td.has(t)).sort());
            gridChart = taskGrid('mv-chart-grid', rows, catalog.allTaskIds || [], compareOn ? togglePick : chartRowPick(rows), { order, publicSite: PUBLIC, unit: gridCells === 'subtests' ? 'sub-tests' : 'runs', groupOf: chartRows === 'all' ? (r) => (r._g ? weightsOf(r._g.m) : r.key) : null, onCell: cellPick,
                ...(compareOn ? { tick: pickState } : {}),   // the row checkboxes (charts.js taskGrid); absent = the grid as it always was
                onRunningCell: (task, r) => { const dir = r.runDirs && r.runDirs.get(task); if (dir) openLiveFor(dir); },
                // hover a row label ~1 s: that row's config detail (same card as a frontier point); unpinned, so it goes when the pointer does
                onLabelHover: (r, ev) => { if (r && r._g) showPopover(ev.clientX + 12, ev.clientY + 8, groupDetailHtml(r._g, { adj: CG.adj, keep: chartKeep.q || FACET_DEFAULTS.quality, others: r._others, column: rankLabel() }), { actions: [{ label: 'Model details →', onClick: () => openModel(r._g.m.key) }] }); },
                onLabelLeave: () => setTimeout(() => { if (!document.querySelector('.lb-pop:hover')) hidePopover(); }, 250) });   // grace to move onto the card
            paintCompareBar();
        };
        // Compare mode on / off. Either way the ticks start empty; off puts the map back exactly as it was.
        const setCompare = (on) => {
            if (on === compareOn) return;
            compareOn = on; comparePicks = []; comparePicksRows = null; compareHint = '';
            paintGrid();
        };

        const paintStatus = () => { const srows = bestPerModel().map(({ g, others }) => {
            const counts = { 'pass': 0, 'pass*': 0, TIMEOUT: 0, fail: 0, excluded: 0 };
            for (const t of Object.values(g.tasks)) {
                if (t.excluded || t.credit == null) { counts.excluded += 1; continue; }
                counts[t.status === 'pass*' ? 'pass*' : 'pass'] += t.credit;
                counts[t.status === 'TIMEOUT' ? 'TIMEOUT' : 'fail'] += 1 - t.credit;
            }
            const a = CG.adj.get(g.key);
            const half = a ? Math.round(((a.hi - a.lo) / 2) * 100) : null;
            return { key: g.m.key, label: g.m.display + (half != null ? `  (±${half})` : ''),
                rate: g.q.solveRate, ci: half, attempted: g.q.attempted, scored: g.q.scored,
                repeated: 0, attemptsTotal: g.q.attempted, counts, rank: rankValue(g, gridRank), _g: g, _others: others };
        }).sort((a, b) => (b.rank - a.rank) || (b.attempted - a.attempted));
            // The status-mix chart was retired 2026-09-24: the task grid shows the same thing per task
            // and each grid row now carries its weighted rate. Kept as a no-op so callers stay simple.
            void srows; };

        // Every row keeps its label: the box grows ~20 px per row and the card scrolls.
        const sizeBox = (id, n) => { const b = overviewEl.querySelector(`#${id}-box`); if (b) b.style.height = `${Math.max(200, n * 20 + 60)}px`; };
        // The cost charts show the Rows switch's rows too (rowsPerModel, 2026-10-21); "combined" is the old one row per model.
        const paintTok = () => { const tr = rowsPerModel().filter(({ g }) => g.q.solved > 0 && g.q.tokensPerSolve); sizeBox('mv-cost-tok', tr.length); return costPerSolve('mv-cost-tok', tr.map(({ g, others }) => ({
            ...rowName(g), provider: g.m.provider, solved: Math.round(g.q.solved * 100) / 100,
            attempted: g.q.attempted, rate: g.q.solveRate, value: g.q.tokensPerSolve, _g: g, _others: others,
        })), 'output tokens per solve', (v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : Math.round(v)), 'value', chartRowPickRows); };

        const paintWall = () => {
            const raw = wallMetric === 'raw';
            const wr = rowsPerModel(wallSort === 'robust' ? 'robust' : 'adjusted').map(({ g: qg, others }) => ({ qg, others, tg: fastestFor(qg, raw) }))
                .filter((x) => x.tg && x.tg.q.solved > 0);
            sizeBox('mv-cost-wall', wr.length);
            return costPerSolve('mv-cost-wall', wr.map(({ qg, tg, others }) => {
                const rt = CG.rel.get(tg.key), a = CG.adj.get(qg.key);
                // quality sort: difficulty-weighted rate; robust sort: the lower end of its interval
                return { ...rowName(qg), provider: qg.m.provider, solved: Math.round(tg.q.solved * 100) / 100,
                    // quality sort ranks by the LOW END of the strength range, as the Solve map does (Kyle, 09-29 / 10-03:
                    // the point estimate floated Ternary-Bonsai's 9 easy solves above far better-tested models)
                    attempted: tg.q.attempted, rate: a ? strengthRank(a) : qg.q.solveRate,
                    value: raw ? tg.q.wallPerSolve : (rt && rt.index != null ? rt.index : null), detail: estNote(tg), _g: qg, _others: others };
            }), raw ? 'seconds per solve (fastest config)' : 'relative solve time of the fastest config (joint fit, 1× = typical)',
                raw ? (v) => (v >= 3600 ? `${(v / 3600).toFixed(1)}h` : v >= 60 ? `${Math.round(v / 60)}m` : `${Math.round(v)}s`) : fmtRel, wallSort === 'value' ? 'value' : 'quality', chartRowPickRows);
        };

        const paintGb = () => { const gr = rowsPerModel(gbRank === 'raw' ? 'raw' : gbRank).filter(({ g }) => g.m.diskBytes); sizeBox('mv-cost-gb', gr.length); return costPerSolve('mv-cost-gb', gr.map(({ g, others }) => {
            const a = CG.adj.get(g.key);
            const rate = gbRank === 'robust' ? (a ? a.lo : null) : gbRank === 'raw' ? g.q.solveRate : (a ? a.rate : null);
            // Strength per GB (2026-10-01, Kyle): points of strength /100 bought by each GB of weights -- a yield,
            // so higher is better and the best sits on top. (Was the inverse, GB per point, cheapest first.)
            const gb = g.m.diskBytes / 1e9;
            return { ...rowName(g), provider: g.m.provider, solved: Math.round(g.q.solved * 100) / 100,
                attempted: g.q.attempted, rate, value: rate > 0 && gb > 0 ? (rate * 100) / gb : null,
                detail: rate > 0 ? `strength ${Math.round(rate * 100)} ÷ ${gb.toFixed(1)} GB of weights` : null, _g: g, _others: others };
        }), 'strength /100 per GB of weights', (v) => `${v.toFixed(v >= 10 ? 1 : 2)}`, 'desc', chartRowPickRows, { per: 'strength points per GB' }); };

        // Strength per second per GB (2026-10-02, Kyle): strength /100 ÷ (time per solve × GB of weights), so a model
        // has to be strong, fast AND small to rank. Time is the model's fastest config, like the wall-clock chart:
        // task-weighted (relative solve time, 1× = typical -- the unit is then "points per 1×-time per GB") or raw
        // mean seconds per solve. Local only (a cloud model has no weights on disk here).
        const sig3 = (v) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v >= 1 ? v.toFixed(2) : v.toPrecision(3));
        const paintGbt = () => {
            const raw = gbtMetric === 'raw';
            const rows = rowsPerModel('adjusted').filter(({ g }) => g.m.diskBytes).map(({ g: qg, others }) => ({ qg, others, tg: fastestFor(qg, raw) }))
                .filter((x) => x.tg && x.tg.q.solved > 0);
            sizeBox('mv-cost-gbt', rows.length);
            return costPerSolve('mv-cost-gbt', rows.map(({ qg, tg, others }) => {
                const a = CG.adj.get(qg.key), rt = CG.rel.get(tg.key);
                const strength = a ? a.rate * 100 : null;
                const t = raw ? tg.q.wallPerSolve : (rt && rt.index != null ? rt.index : null);
                const gb = qg.m.diskBytes / 1e9;
                const tText = raw ? `${Math.round(t)} s per solve` : `${fmtRel(t || 0)} time`;
                return { ...rowName(qg), provider: qg.m.provider, solved: Math.round(tg.q.solved * 100) / 100,
                    attempted: tg.q.attempted, rate: a ? a.rate : null,
                    value: strength > 0 && t > 0 && gb > 0 ? strength / (t * gb) : null,
                    detail: strength > 0 && t > 0 ? `strength ${Math.round(strength)} ÷ (${tText} × ${gb.toFixed(1)} GB)${tg.estimated ? ' · time estimated at its fastest speed config' : ''}` : null, _g: qg, _others: others };
            }), raw ? 'strength /100 per second per GB' : 'strength /100 per 1× solve time per GB', sig3, 'desc', chartRowPickRows,
            { per: raw ? 'strength points per second per GB' : 'strength points per (1× time × GB)' });
        };

        // Quality ladder: the frontier's points (the Rows switch's rows, each placed at its fastest config), every one
        // a rung, in quality order (strengthRank: the low end of the range) or cost order; ladderSteps() prices each
        // step in the other measure. Since 2026-10-21 it follows the Rows switch like the frontier (it was always best
        // config per model, by its own rule, so it disagreed with the Solve map); a row's speed configs stay one rung,
        // its fastest.
        const fmtTok = (v) => (v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 0 : 1)}k tok` : `${Math.round(v)} tok`);
        const paintLadder = () => {
            const tokens = ladderX === 'tokens', robust = ladderY === 'robust', byCost = ladderOrder === 'cost';
            const costWord = tokens ? 'tokens' : 'time', faster = tokens ? 'cheaper' : 'faster';
            overviewEl.querySelectorAll('[data-ladder-order="cost"]').forEach((b) => { b.textContent = tokens ? 'tokens' : 'speed'; });
            const fmtX = tokens ? fmtTok : fmtRel;
            const how = robust ? 'robust' : 'adjusted';
            const pts = rowsPerModel(how).map(({ g: qg, others }) => { const tg = fastestFor(qg); return { ...ladderPointOf(qg, CG.adj.get(qg.key), tg, CG.rel,
                { how, cost: tokens ? 'tokens' : 'time', ...rowName(qg), others }), xNote: tokens ? null : estNote(tg) }; });
            const { rungs, unplaced } = ladderSteps(pts, byCost ? 'cost' : 'quality');
            const pick = (key, ev) => {
                const p = pts.find((x) => x.key === key);
                if (!p) return;
                showPopover(ev ? ev.clientX : 200, ev ? ev.clientY : 200,
                    groupDetailHtml(p._g, { adj: CG.adj, keep: chartKeep.q || FACET_DEFAULTS.quality, others: p._others, column: robust ? 'robust (lower bound of the difficulty-weighted rate)' : 'difficulty-weighted rate' }),
                    { pin: true, actions: [{ label: 'Model details →', onClick: () => openModel(p._g.m.key) }] });
            };
            const rateWord = 'strength /100';
            const steps = rungs.filter((r) => r.step);
            const nFree = steps.filter((r) => r.step.free).length, nNoise = steps.filter((r) => r.step.noise).length;
            const nIndirect = steps.filter((r) => r.step.indirect).length;
            const desc = overviewEl.querySelector('#mv-ladder-desc');
            if (desc) desc.innerHTML = (byCost
                ? `Every model is a point: <b class="text-gray-300">up = ${faster}</b> (${tokens ? 'output tokens per solve' : 'relative solve time'}, log, slowest at the bottom), <b class="text-gray-300">right = better</b> (${rateWord}), both to scale; the rail joins them slowest to fastest. Each step is priced in quality: <b class="text-gray-300">% of solve rate given up per halving of ${costWord}</b> = percentage points given up ÷ log₂(speedup), so −4% means each halving of ${costWord} costs 4 percentage points (steps under ${LADDER_MIN_SPEEDUP}× have no rate). The bar through each point is its 95% interval.`
                : `Every row is a point: <b class="text-gray-300">height = its ${rateWord}</b>, <b class="text-gray-300">left–right = its ${tokens ? 'output tokens per solve' : 'relative solve time'}</b> (log), both to scale, so a tall step is a big gain and a long lean a big cost; the rail joins them worst to best <b class="text-gray-300">by the low end of each 95% range</b>, as every quality ranking on this page, so a thin record cannot out-rank a proven one (a step that goes down is <i>surer, not higher</i>: a higher low end under a lower midpoint), and the bar through each point is its 95% interval. Each step up is priced in ${costWord}: <b class="text-gray-300">% more ${costWord} per +1%</b> = (${costWord} ratio − 1) × 100 ÷ percentage points gained, so +10% means each percentage point of solve rate cost 10% more ${costWord} (steps under +${LADDER_MIN_PTS}%, one percentage point, have no rate).`)
                + ` Solve-rate changes (+1.4% solve, −3.0% solve) are <b class="text-gray-300">percentage points of solve rate</b>, not relative change.
                The ${costWord} ratio of a step is <b class="text-gray-300">head to head</b>: the geometric mean of ${tokens ? 'output tokens' : 'wall time'}, upper ÷ lower rung, over the tasks <i>both</i> solved. When the rung just below shares under ${LADDER_MIN_N} solved tasks, the step is priced against the nearest lower rung that shares ${LADDER_MIN_N} (<i>vs #k</i>); when none does it is <b class="text-gray-300">≈ indirect</b>, the ratio of the two ${tokens ? 'tokens-per-solve figures' : 'relative times'}, each measured on its own tasks: a rough estimate that can even point the wrong way${steps.length ? ` (${nIndirect} of ${steps.length} steps here)` : ''}. A point's position is its own index, so a rail can lean against its label; the label is the head-to-head number.
                <span class="text-amber-300">Amber</span>: a step that is paid for. <span class="text-green-300">Green, free</span>: ${faster} <i>and</i> better, head to head. <b class="text-gray-300">Dashed</b>: the two rungs' 95% intervals overlap, so the step may be noise${steps.length ? ` (${nNoise} of ${steps.length} steps here; ${nFree} free)` : ''}.
                Step labels sit beside their rails where they fit without covering a name; the rest (and all of them on a phone) are in the tooltip — hover or tap a point — and in the table below. The rows are the Solve map's <b class="text-gray-300">Rows</b> switch (${chartRows === 'combined' ? 'combined: one per model, every config pooled' : chartRows === 'top' ? 'best config per model' : 'all configs'}), each at its fastest ${tokens ? 'config' : `speed config (by measured throughput, with at least ${SPEED_MIN_REQ} requests; a row whose runs were not all there is placed at its tasks re-priced at that config's rates, an estimate)`}. Tap a point or a name for that row.${unplaced.length ? ` Not placed (no ${tokens ? 'token count' : 'relative time'}): ${unplaced.map((u) => esc(u.label)).join(', ')}.` : ''}`;
            const box = overviewEl.querySelector('#mv-ladder-box');
            if (box) box.style.height = `${Math.max(320, rungs.length * 30 + 90)}px`;
            const tbl = overviewEl.querySelector('#mv-ladder-table');
            if (tbl) {
                const pc = (v) => (v == null ? '—' : `${Math.round(v * 100)}%`);
                const th = (t, right, title) => `<th class="px-1 py-0.5 ${right ? 'text-right' : 'text-left'} font-semibold text-gray-400"${title ? ` title="${esc(title)}"` : ''}>${t}</th>`;
                const td = (t, cls = '') => `<td class="px-1 py-0.5 ${cls}">${t}</td>`;
                const nBasis = { direct: 0, reanchored: 0, indirect: 0 };
                for (const r of steps) nBasis[r.step.basis]++;
                // top rung first, as the chart reads; each row carries the step up INTO it. Numbered by RANK from the top
                // (2026-10-02, Kyle: the bottom-first rung index read as "reverse order" in a top-first table); a re-anchored
                // step's "vs #k" uses the same rank, so it names a row you can see.
                const N = rungs.length;
                const rankOf = (st) => `#${N - st.vsIndex}`;
                tbl.innerHTML = rungs.length ? `<table class="text-[10px] whitespace-nowrap w-full">
                  <thead><tr class="border-b border-gray-800">${th('#', false, 'rank from the top of the ladder')}${th('model')}
                    ${th('strength', true, 'strength /100 (its 95% range in small text)')}
                    ${th(tokens ? 'tokens / solve' : 'time', true, tokens ? 'mean output tokens per solved task' : 'relative solve time: a joint fit of wall time over every config and task (the length of each task factored out), so 2× = twice as long as a typical config on the same task; only tasks at least two configs solved count. 1× = a typical config.')}
                    ${th('step vs rung below', false, `what the step up into this rung gains in solve rate (percentage points) and what it costs in ${costWord}, head to head`)}
                    ${th('per step', true, byCost ? 'percentage points of solve rate given up per halving of the cost' : `% more ${costWord} per +1 percentage point of solve rate`)}
                    ${th('based on', false, `how the step was priced: solved tasks the two rungs share; "vs #k" = re-anchored on a lower rung because the rung just below shares under ${LADDER_MIN_N}; "≈ indirect" = no rung below shares ${LADDER_MIN_N}, so the ratio of the two ${tokens ? 'token counts' : 'relative times'}`)}</tr></thead>
                  <tbody>${rungs.map((r, i) => ({ r, i })).reverse().map(({ r, i }) => {
                      const s = r.step;
                      const tone = !s ? 'text-gray-600' : s.free ? 'text-green-300' : 'text-amber-300';
                      const w = s ? ladderStepText(s, { order: byCost ? 'cost' : 'quality', costWord, rank: rankOf }) : null;
                      return `<tr class="border-b border-gray-800 cursor-pointer" data-ladder-key="${esc(r.key)}"${rowHit(r) ? ' data-hl="1"' : ''}>
                        ${td(N - i, 'text-gray-500')}${td(esc(r.label), 'text-gray-200')}
                        ${td(`${pc(r.y)} <span class="text-gray-500">${pc(r.lo)}–${pc(r.hi)}</span>`, 'text-right font-mono text-gray-200')}
                        ${td(fmtX(r.x), 'text-right font-mono text-gray-300')}
                        ${td(w ? w.move : 'bottom rung', `font-mono ${tone}`)}
                        ${td(w ? w.headline.replace(/^(≈?free):.*$/, '$1') : '—', `text-right font-mono font-semibold ${tone}`)}
                        ${td(s ? `${w.basis}${s.noise ? ' <span class="text-gray-600">· within noise</span>' : ''}` : '', s && s.indirect ? 'text-gray-500' : 'text-gray-400')}</tr>`;
                  }).join('')}</tbody></table>
                  <div class="text-[10px] text-gray-500 mt-1"><b class="text-gray-400">strength</b>: strength /100, with its 95% range; changes are points of strength. <b class="text-gray-400">${tokens ? 'tokens / solve' : 'time'}</b>: ${tokens ? 'mean output tokens per solved task' : 'joint fit of wall time over every config and task (1× = a typical config on the same task)'}. <b class="text-gray-400">based on</b>: the solved tasks the step's two rungs share (head to head); <i>vs #k</i> when the rung just below shares under ${LADDER_MIN_N} and a lower rung is used instead; <i>≈ indirect</i> when none does. Here: ${nBasis.direct} head to head, ${nBasis.reanchored} re-anchored, ${nBasis.indirect} indirect.</div>`
                    : '<div class="text-[10px] text-gray-500">No model here has both a rate and a cost to place.</div>';
                tbl.querySelectorAll('[data-ladder-key]').forEach((tr) => tr.addEventListener('click', (ev) => pick(tr.dataset.ladderKey, ev)));
            }
            return qualityLadder('mv-chart-ladder', rungs, pick, {
                order: byCost ? 'cost' : 'quality', costWord, fmtX: tokens ? (v) => `${fmtTok(v)}/solve` : (v) => `${fmtRel(v)} time`,
                xLabel: tokens ? 'output tokens per solve (log) — left is cheaper' : 'relative solve time of its fastest config (joint fit over every config and task, log) — left is faster',
                tick: tokens ? (v) => fmtTok(Number(v)).replace(' tok', '') : (v) => fmtRel(Number(v)),
                rateLabel: robust ? 'robust rate: lower end of the difficulty-weighted 95% interval' : 'strength /100 (95% range)',
            });
        };

        const paintCharts = () => { rebuildChartGroups(); paintFrontier(); paintLadder(); paintGrid(); paintStatus(); paintTok(); paintWall(); paintGb(); paintGbt(); };
        // poll the running batteries while this overview is on screen; repaint the grid only when they change
        repaintGrid = () => { if (CG && !overviewEl.classList.contains('hidden')) paintGrid(); };
        // a changed running list means a test just ended or began: look for its result shortly after (the server needs
        // a moment to index it), and look anyway every 3 minutes (the last task of an item ends without a new one starting)
        const loadRunning = async (alsoResults) => {
            const changed = await fetchRunning();
            if (changed) { repaintGrid(); setTimeout(liveCatalog, 15000); } else if (alsoResults) liveCatalog();
        };
        if (runningTimer) runningTimer.stop();
        let ticks = 0;
        runningTimer = pollEvery(() => (!view.classList.contains('hidden') && !overviewEl.classList.contains('hidden') ? loadRunning(++ticks % 9 === 0) : null), 20000);
        // loadNow() asks for the running list together with the catalog, so a draw that follows it has it already
        if (Date.now() - runningAt > 5000) loadRunning();
        const syncCloudToggle = () => overviewEl.querySelectorAll('[data-cloud-time]').forEach((x) => { x.className = toggle('cloud-time', x.dataset.cloudTime, cloudTime()); });
        const mountFacetBars = () => {
            chartKeep.q = facetBar(overviewEl.querySelector('#mv-cf-q'), 'models-charts-q', FACET_DEFAULTS.quality, (k) => { chartKeep.q = k; syncCloudToggle(); paintCharts(); }, PUBLIC ? [] : [tensorChip, fileChipQ]);
            chartKeep.t = facetBar(overviewEl.querySelector('#mv-cf-t'), 'models-charts-t', FACET_DEFAULTS.full, (k) => { chartKeep.t = k; syncCloudToggle(); paintCharts(); }, PUBLIC ? [] : [fileChipT]);
        };
        mountFacetBars();
        // "cloud over time" is the 'served' facet on BOTH chart kinds at once: split = keep each
        // day's cloud runs apart (track a model as the provider changes it), combine = pool them.
        overviewEl.querySelectorAll('[data-cloud-time]').forEach((b) => b.addEventListener('click', () => {
            const on = b.dataset.cloudTime === 'split';
            const set = (store, cur, dflt) => {
                const k = (cur || dflt).filter((x) => x !== 'served').concat(on ? ['served'] : []);
                try { localStorage.setItem('facets_' + store, JSON.stringify(k)); } catch { /* private mode */ }
            };
            set('models-charts-q', chartKeep.q, FACET_DEFAULTS.quality);
            set('models-charts-t', chartKeep.t, FACET_DEFAULTS.full);
            mountFacetBars(); syncCloudToggle(); paintCharts();
        }));
        paintCharts();
        markHighlight();   // the count, the tiles, the ladder table; the charts and the board read the term as they draw
        wireToggle('frontier-x', 'models_frontier_x', () => frontierX, (v) => { frontierX = v; }, paintFrontier);
        wireToggle('ladder-order', 'models_ladder_order', () => ladderOrder, (v) => { ladderOrder = v; }, paintLadder);
        wireToggle('ladder-x', 'models_ladder_x', () => ladderX, (v) => { ladderX = v; }, paintLadder);
        // the cells choose the fit too (buildChartGroups: partial points under sub-tests), so every chart is redrawn
        wireToggle('grid-cells', 'models_grid_cells', () => gridCells, (v) => { gridCells = v; }, paintCharts);
        wireToggle('chart-rows', 'models_chart_rows', () => chartRows, (v) => { chartRows = v; }, () => {
            // every chart that shows the switch's rows (2026-10-21: the ladder and the cost charts too)
            paintGrid(); paintFrontier(); paintLadder(); paintTok(); paintWall(); paintGb(); paintGbt();
            overviewEl.querySelectorAll('[data-fv-cfgs]').forEach((el) => el.classList.toggle('hidden', frontierView !== 'frontier' || chartRows === 'all'));
        });
        // compare mode: its switch, and the bar's buttons (delegated: the bar is filled again on every tick)
        overviewEl.querySelectorAll('[data-compare-mode]').forEach((b) => b.addEventListener('click', () => setCompare(b.dataset.compareMode === 'on')));
        { const bar = overviewEl.querySelector('#mv-cmp-bar');
            if (bar) bar.addEventListener('click', (e) => {
                const drop = e.target.closest('[data-cmp-drop]');
                if (drop) { comparePicks.splice(Number(drop.dataset.cmpDrop), 1); compareHint = ''; if (gridChart) { try { gridChart.draw(); } catch { /* destroyed under us */ } } paintCompareBar(); return; }
                if (e.target.closest('#mv-cmp-exit')) { setCompare(false); return; }
                if (e.target.closest('#mv-cmp-go') && comparePicks.length >= 2) openCompare(comparePicks.map((p) => p.cid));
            }); }
        wireToggle('wall-metric', 'models_wall_metric', () => wallMetric, (v) => { wallMetric = v; }, paintWall);
        wireToggle('wall-sort', 'models_wall_sort', () => wallSort, (v) => { wallSort = v; }, paintWall);
        wireToggle('prefill-mode', 'models_prefill_mode', () => prefillMode, (v) => { prefillMode = v === 'config' ? 'config' : 'model'; }, paintPrefill);
        // The view and cost switches swap panels IN PLACE (2026-10-02, Kyle: "there's a hang, and then the page shoves
        // me down"): they used to re-render the whole overview -- every chart and the strength fit recomputed, and the
        // page briefly collapsed while it was rebuilt, losing the scroll position. Now: show/hide, new caption, and
        // repaint only the charts in the panel that just became visible (a chart drawn while hidden has no size).
        const COST_SUB = {
            tok: 'Output tokens per solved task — mean over solved tasks, cheapest first',
            wall: 'Wall clock per solve, fastest config of each model',
            gb: 'Strength per GB of weights, and per second per GB — most quality first; local only (a cloud model has no disk footprint here)',
        };
        const applyFrontierView = () => {
            overviewEl.querySelectorAll('[data-fv]').forEach((el) => el.classList.toggle('hidden', el.dataset.fv !== frontierView || (el.hasAttribute('data-fv-cfgs') && chartRows === 'all')));
            const sub = overviewEl.querySelector('[data-fv-sub]'); if (sub) sub.textContent = FV_SUB[frontierView];
            const tbl = overviewEl.querySelector('details[data-key="mv-ladder-table"]'); if (tbl && frontierView === 'ladder') tbl.open = true;
            if (frontierView === 'ladder') paintLadder(); else paintFrontier();
        };
        const applyCostView = () => {
            overviewEl.querySelectorAll('[data-cost-panel]').forEach((el) => el.classList.toggle('hidden', el.dataset.costPanel !== costView));
            const sub = overviewEl.querySelector('[data-cost-sub]'); if (sub) sub.textContent = COST_SUB[costView];
            if (costView === 'tok') paintTok(); else if (costView === 'wall') paintWall(); else { paintGb(); paintGbt(); }
        };
        wireToggle('frontier-view', 'models_frontier_view', () => frontierView, (v) => { frontierView = v === 'ladder' ? 'ladder' : 'frontier'; }, applyFrontierView);
        wireToggle('cost-view', 'models_cost_view', () => costView, (v) => { costView = ['tok', 'wall', 'gb'].includes(v) ? v : 'tok'; }, applyCostView);
        wireToggle('gbt-metric', 'models_gbt_metric', () => gbtMetric, (v) => { gbtMetric = v === 'raw' ? 'raw' : 'relative'; }, paintGbt);
        wireToggle('frontier-cfgs', 'models_frontier_cfgs', () => frontierCfgs, (v) => { frontierCfgs = v === 'trail' ? 'trail' : 'off'; }, paintFrontier);
        // remember the open/closed state of the page's <details data-key> panels
        overviewEl.querySelectorAll('details[data-key]').forEach((d) => {
            const k = 'models_details_' + d.dataset.key;
            try { const v = localStorage.getItem(k); if (v === '1') d.open = true; else if (v === '0') d.open = false; } catch { /* private mode */ }
            d.addEventListener('toggle', () => { try { localStorage.setItem(k, d.open ? '1' : '0'); } catch { /* private mode */ } });
        });

        // board
        const ON = 'chip is-on';
        const OFF = 'chip';
        const paintBoard = () => {
            overviewEl.querySelectorAll('[data-board]').forEach((b) => { b.className = b.dataset.board === boardId ? ON : OFF; });
            const spec = BOARDS[boardId];
            const lb = createLeaderboard(overviewEl.querySelector('#mv-board'), {
                id: 'models-' + boardId, columns: spec.columns, defaultSort: spec.defaultSort,
                note: '<b>One row per set of weights</b> (each quant is its own), shown under its best config for the column you rank by — named beneath it, full config on hover. Only configs with at least ' + BEST_CONFIG_MIN_N + ' scored tasks and ' + Math.round(BEST_CONFIG_MIN_FRAC * 100) + '% of the model\'s most-tested config compete (else its most-tested config), as everywhere strength picks a config. Click a row for every config it has run. ' + spec.note,
                commonTasks: spec.commonTasks,
                // Land on the tab that matches the board, where every config is listed.
                onRow: (r) => { detailCtx.view = boardId === 'speed' ? 'speed' : 'quality'; openModel(r.key); },
                limit: SUMMARY_LIMIT, more: spec.more,
                emptyText: spec.source === 'speed' ? 'No model has a speed measurement near 32k context yet.' : 'No model has data for this board yet.',
                rowsForSort: (colId, dir) => rowsForSort(boardId, colId, dir),
                method: spec.method || null,
                highlight: rowHit,
                rowDetail: (r) => (r._g ? groupDetailHtml(r._g, { adj: r._adj, rel: r._rel, keep: r._keep, others: r._others, column: r._column })
                    : `<div class="text-xs font-semibold text-gray-100">${esc(r.label)}</div><div class="text-gray-400 font-mono">${esc(r.sublabelFull || r.sublabel || '')}</div>`),
            });
            boardNow = lb;
            const fEl = overviewEl.querySelector('#mv-facets');
            if (spec.source === 'speed') {
                // Speed rows are launch configs from the request log and llama-bench, which carry no
                // harness facets; every flag and the build already separate them.
                fEl.innerHTML = '<div class="text-[10px] text-gray-600">speed configs always separate on every launch flag and build</div>';
            } else {
                const id = boardId;
                facetKeep[id] = facetBar(fEl, 'models-' + id, FACET_DEFAULTS[spec.source === 'full' ? 'full' : 'quality'], (k) => { facetKeep[id] = k; lb.render(); });
            }
            lb.render();
        };
        overviewEl.querySelectorAll('[data-board]').forEach((b) => b.addEventListener('click', () => { boardId = b.dataset.board; paintBoard(); }));
        // The leaderboards sit under four screens of charts and can need a strength fit of their own (~150-200 ms):
        // painted a moment after the charts, so those are on screen first (2026-10-06).
        setTimeout(() => { if (gen === renderGen) paintBoard(); }, 0);
    }

    // ------------------------------------------------------------ detail
    // `fromHistory` is set when popstate put us here: the entry already exists, so pushing
    // another would need two Backs to leave one detail view. In the dashboard that is the router's
    // job: a fresh open only asks it for the route, and it comes back through showRoute with fromHistory set.
    async function openModel(key, fromHistory) {
        if (!fromHistory && NAV) { const tab = detailCtx.view; detailCtx.view = 'speed'; routeTo({ tab: 'models', model: key, view: tab }); return; }
        shownTask = null; shownModel = null; shownCompare = null;
        if (!fromHistory) {
            try { history.pushState({ tab: 'tab-models', model: key }, '', '#results/' + encodeURIComponent(key)); }
            catch { /* history is unavailable in some embedded views; navigation still works */ }
        }
        const route = NAV && NAV.current();
        const moved = () => !!NAV && NAV.current() !== route;   // Back (or another click) while this was loading: that route's draw wins
        clearError();
        overviewEl.classList.add('hidden');
        detailEl.classList.remove('hidden');
        const panel = createLoadPanel(detailEl, 'Loading the model', [{ id: 'data', label: catalogStale() ? 'Its record and the latest results' : 'Its record' }, { id: 'draw', label: 'Drawing its page' }]);
        panel.start('data');
        dropPageCharts();
        // The catalog and the model's own record are asked for TOGETHER, and the overview is not drawn for a page
        // that is about to cover it (2026-10-06): this used to wait for the catalog, draw the whole overview
        // (~0.8 s), hide it, and only then ask for the model. A changed catalog leaves `drawn` behind it, so the
        // overview is drawn when it is next shown.
        const [, j] = await Promise.all([catalogStale() ? refreshCatalog(true) : true, api('/api/model?key=' + encodeURIComponent(key))]);
        if (moved()) return;
        if (j.error) { detailEl.innerHTML = ''; showOverview(); showError(j.error); return; }
        panel.start('draw'); await nextPaint();
        if (moved()) return;
        detailCtx.key = key;     // so popstate can tell "already showing this model" from "switch to it"
        try { localStorage.setItem('models_last_key', key); } catch { /* private mode */ }
        const ctx = {
            view: detailCtx.view,
            onView: NAV ? (v) => routeTo({ tab: 'models', model: key, view: v }) : null,
            // Every catalog entry on the same WEIGHTS (a cloud model's other efforts / scaffolds),
            // so the detail page lists every config those weights have run, not only this entry's.
            family: catalog ? (catalog.models || []).filter((x) => weightsOf(x) === weightsOf(j)) : [j],
            // the overview's fit on its chart chips (2026-10-14: it was always the default chips, so a page with other chips
            // showed other numbers here than on its own charts)
            strengthByDir: catalog ? detailStrength(catalog) : null,
            // its fastest speed config over every codebench run of these weights (fastFor: the rule the charts and the compare
            // page use), for the Speed tab (2026-10-22)
            fastestSpeed: (() => {
                try {
                    if (!catalog) return null;
                    if (!CG) CG = buildChartGroups();
                    const rep = CG.qG.find((g) => weightsOf(g.m) === weightsOf(j));
                    if (!rep) return null;
                    const row = { isModel: true, rep, m: rep.m }, f = fastFor(row);
                    return f ? { label: speedLabel(f.fastest.g, speedGroupsOf(row)), sp: f.fastest.sp, thin: f.fastest.thin, of: f.configs.length,
                        configKey: (f.fastest.g.c || {}).launchSummary || null } : null;
                } catch { return null; }
            })(),
            openModel: (k) => { if (k !== key) openModel(k); },
            openTask: PUBLIC ? null : (t) => openTask(t),
            // Go through history rather than straight to the overview, so the in-page button and
            // the browser's Back end up in the same place instead of disagreeing by one entry.
            onBack: () => { if (NAV) NAV.up('#results'); else if (history.state && history.state.model) history.back(); else { shownModel = null; dropPageCharts(); showOverview(); } },
            // Land in the Benchmarks tab's battery list with this battery open -- or, with a task, in Live showing that task.
            openBattery: (dir, task) => routeTo({ tab: 'bench', sub: 'codebench', view: task ? 'live' : 'runs', dir, task }),
        };
        renderDetail(detailEl, j, ctx);
        shownModel = { key, ctx };
        detailCtx = { view: 'speed' };
    }

    // ------------------------------------------------------------ task page
    // One codebench task across every model: #results/task/<id>. Same history pattern as a model.
    function openTask(id, fromHistory) {
        if (PUBLIC) return;   // task pages show task content: never on the public site
        if (!fromHistory && NAV) { routeTo({ tab: 'models', task: id }); return; }
        if (!fromHistory) {
            try { history.pushState({ tab: 'tab-models', task: id }, '', '#results/task/' + encodeURIComponent(id)); }
            catch { /* history is unavailable in some embedded views; navigation still works */ }
        }
        const route = NAV && NAV.current();
        clearError();
        // Ask for the catalog first when the one in hand is old (as every view does when it opens), then draw from
        // whichever we have. Only the FIT is needed here, not the overview: it used to be drawn and hidden for this.
        if (catalogStale()) {
            const cold = catalog ? null : coldPanel('Loading the task');
            refreshCatalog(false, cold && cold.onProgress).then(async () => {
                if (cold && catalog) { cold.panel.start('draw'); await nextPaint(); }
                if (!NAV || NAV.current() === route) { if (catalog) drawTask(id); else { detailEl.innerHTML = ''; showOverview(); } }
            });
            return;
        }
        drawTask(id);
    }
    function drawTask(id) {
        if (!CG) CG = buildChartGroups();      // the fit the overview's charts use (cached per catalog: fitFor)
        overviewEl.classList.add('hidden');
        detailEl.classList.remove('hidden');
        dropPageCharts();
        shownTask = id; shownModel = null; shownCompare = null;
        renderTask(detailEl, {
            id, catalog, groups: CG.qG, adj: CG.adj, rows: chartRows, highlight: rowHit,
            // the overview's Rows toggle follows this one: it is drawn again when next shown
            setRows: (v) => { chartRows = v; drawn = null; try { localStorage.setItem('models_chart_rows', v); } catch { /* private mode */ } },
            detailHtml: (g, others) => groupDetailHtml(g, { adj: CG.adj, keep: chartKeep.q || storedKeep('models-charts-q', FACET_DEFAULTS.quality), others }),
            openModel: (k) => openModel(k),
            openTask: (t) => { if (t !== id) openTask(t); },
            onBack: () => { if (NAV) NAV.up('#results'); else if (history.state && history.state.task) history.back(); else { shownTask = null; dropPageCharts(); showOverview(); } },
        });
        view.scrollTop = 0;   // #models-view is the scroller; a tap far down the grid would open the page mid-way
    }

    // ------------------------------------------------------------ compare page
    // Two Solve map rows head to head: #results/compare/<a>/<b> (2026-10-11, Kyle: "a view that compares the selected
    // two models ... the strengths and weaknesses of each model compared, which tests each passed that the other
    // failed or did better on than the other, their speed and strength, the confidence of the result"). Same history
    // pattern as a task page. An id says what the row stands for: a MODEL's key (the "combined" row: every config of
    // its weights pooled, strength = the model's) or a CONFIG GROUP's key (a "best config" / "all configs" row; it is
    // a JSON string, so it starts with "["). Everything shown is already in the page -- the catalog and the
    // overview's fit; the arithmetic is leaderboard.js compareRows(). Outcomes are always pass / fail per run, whatever
    // the map's Cells switch shows.
    // ---- the like-for-like tiles and bar, from one ordered segment list (likeSegments / manySegments): the bar leaves a
    // 0 out, a tile shows it unless the segment is optional (core false); either way the tiles keep the bar's order.
    // Tiles wrap at phone width in reading order (auto-fit grid: no breakpoint classes needed).
    const segTiles = (segs) => `<div data-like-tiles style="display:grid;grid-template-columns:repeat(auto-fit,minmax(8.5rem,1fr));gap:0.5rem">${segs.filter((x) => x.core || x.n > 0).map((x) =>
        `<div class="tile" data-seg="${esc(x.key)}" style="border-top:3px solid ${x.color}" title="${esc(x.sub)}"><div class="tile-label"><span class="legend-sw" style="background:${x.color};margin-right:0.3rem"></span>${esc(x.label)}</div><div class="tile-value">${x.n}</div><div class="tile-sub">${esc(x.sub)}</div></div>`).join('')}</div>`;
    const segBar = (segs, n) => {
        const on = segs.filter((x) => x.n > 0);
        if (!n || !on.length) return '';
        return `<div role="img" data-like-bar aria-label="${esc(on.map((x) => `${x.label} ${x.n}`).join(', '))}" style="display:flex;gap:2px;height:16px;border-radius:5px;overflow:hidden;margin:0.6rem 0 0.35rem">
              ${on.map((x) => `<div data-seg="${esc(x.key)}" title="${esc(x.label)}: ${x.n} of ${n}" style="flex:${x.n} ${x.n} 0;min-width:3px;background:${x.color}"></div>`).join('')}</div>
            <div class="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-gray-400">${on.map((x) => `<span class="legend-item"><span class="legend-sw" style="background:${x.color}"></span>${esc(x.label)} <b class="text-gray-200">${x.n}</b></span>`).join('')}</div>`;
    };
    // A speed config's name among a row's speed configs `groups`: its speed-only settings (MTP / draft, GPU placement or the
    // Strata config file, engine version, machine) where the row's configs differ -- all of the first three for a row with
    // one -- and a Strata config file cut to the name parts the row's configs do not all share
    // ("rb42-pf4096-pdirect-iopf.json · Strata 0.1.47" for strata-ud-q4_k_xl-262k-int8-2xtx-pw2-kcopy-spec3-rb42-...).
    const strataFileOf = (g) => ((((g && g.c) || {}).facets || {}).placement || []).map(String).find((p) => /\.json$/.test(p)) || null;
    function speedLabel(g, groups) {
        if (!g) return '';
        const list = groups && groups.length ? groups : [g];
        const files = list.map(strataFileOf).filter(Boolean);
        let k = 0;
        if (files.length > 1) {
            const parts = files.map((f) => f.replace(/\.json$/, '').split('-'));
            while (parts.every((x) => x[k] != null && x[k] === parts[0][k])) k++;
        }
        const bits = (x) => {
            const c = x.c || {}, f = c.facets || {}, file = strataFileOf(x);
            const place = file ? `${file.replace(/\.json$/, '').split('-').slice(k).join('-') || file.replace(/\.json$/, '')}.json` : ((f.placement || []).map(String).join(' ') || 'default placement');
            return [['spec', c.mtp ? 'MTP' : ((f.speculative || []).length ? 'draft' : (file ? '' : 'no MTP'))], ['placement', place],
                ['build', c.build_info ? (/^Strata/.test(c.build_info) ? c.build_info : `build ${c.build_info}`) : 'build ?'],
                ['machine', f.machine && f.machine.fingerprint ? `machine ${String(f.machine.fingerprint).slice(0, 6)}` : 'machine ?'],
                ['file', f[FILE_FACET] ? `${f[FILE_FACET]} copy` : '']];
        };
        const all = list.map((x) => new Map(bits(x))), mine = new Map(bits(g));
        const differ = [...mine.keys()].filter((d) => new Set(all.map((m) => m.get(d))).size > 1);
        const dims = differ.length ? differ : ['spec', 'placement', 'build'];
        const t = dims.map((d) => mine.get(d)).filter(Boolean).join(' · ') || 'its one speed config';
        return t.length > 110 ? t.slice(0, 109) + '…' : t;
    }
    function compareSide(id) {
        const lowEnd = (g) => strengthRank(CG.adj.get(g.key));
        if (String(id).startsWith('[')) {
            const g = CG.qG.find((x) => x.key === id);
            if (!g) return null;
            const sibs = CG.qG.filter((x) => weightsOf(x.m) === weightsOf(g.m)).length;
            return { id, pooled: false, m: g.m, timeOf: g, tasks: g.tasks, unfinished: g.unfinished || null, a: CG.adj.get(g.key) || null, name: g.label || g.m.display,
                note: `one config${sibs > 1 ? ` of this model's ${sibs}` : ''}${g.cfgNorm ? ` · ${g.cfgNorm}` : ''}` };
        }
        const m = (catalog.models || []).find((x) => x.key === id);
        const w = m ? weightsOf(m) : id;
        const list = CG.qG.filter((x) => weightsOf(x.m) === w);
        if (!list.length) return null;
        // named after its most-tested config's entry, as the map's combined row is (bestPerModel)
        const rep = list.slice().sort((x, y) => (y.q.attempted - x.q.attempted) || (lowEnd(y) - lowEnd(x)))[0];
        return { id, pooled: true, m: rep.m, timeOf: { isModel: true, rep, m: rep.m }, tasks: mergeTasks(list.map((g) => g.tasks)), unfinished: mergeUnfinished(list.map((g) => g.unfinished)),
            a: (CG.fit.adj.models && CG.fit.adj.models.get(w)) || null, name: rep.m.display,
            note: list.length > 1 ? `every config pooled (${list.length} configs)` : 'its one config' };
    }
    // Does the router in this page know the compare route? (ui/shared/route.js is a separate file: a browser can hold
    // an older copy for a while. Then the page is drawn without a history entry rather than not at all.)
    // With three or more rows the router must keep every id (an older route.js kept two): probed with as many as asked.
    const compareRouted = (n = 2) => { try { const ids = Array.from({ length: Math.max(2, n) }, (_, i) => 'r' + i); const c = window.Route.parse(window.Route.format({ tab: 'models', compare: ids })).compare; return !!NAV && Array.isArray(c) && c.length === ids.length; } catch { return false; } };
    const compareHash = (ids) => '#results/compare/' + ids.map((x) => encodeURIComponent(x)).join('/');
    // ids: the rows, in order (two: the head-to-head page; more: side by side). An old caller's (a, b) still works.
    function openCompare(ids, fromHistory, more) {
        if (!Array.isArray(ids)) { ids = [ids, fromHistory]; fromHistory = more; }
        if (!fromHistory && compareRouted(ids.length)) { routeTo({ tab: 'models', compare: ids }); return; }
        if (!fromHistory && !NAV) {
            try { history.pushState({ tab: 'tab-models', compare: ids }, '', compareHash(ids)); }
            catch { /* history is unavailable in some embedded views; navigation still works */ }
        }
        const route = NAV && NAV.current();
        clearError();
        hidePopover(true);
        // as a task page: ask for the catalog first when the one in hand is old, then draw from whichever we have
        if (catalogStale()) {
            const cold = catalog ? null : coldPanel('Loading the comparison');
            refreshCatalog(false, cold && cold.onProgress).then(async () => {
                if (cold && catalog) { cold.panel.start('draw'); await nextPaint(); }
                if (!NAV || NAV.current() === route) { if (catalog) drawCompare(ids); else { detailEl.innerHTML = ''; showOverview(); } }
            });
            return;
        }
        drawCompare(ids);
    }
    // Replace this entry with another set of rows (swap, drop a row): in place of this comparison, not a step on top of it
    function replaceCompare(ids) {
        if (compareRouted(ids.length)) { NAV.go(window.Route.format({ tab: 'models', compare: ids }), { replace: true }); return; }
        if (!NAV) { try { history.replaceState({ tab: 'tab-models', compare: ids, ...(history.state && history.state.cold ? { cold: true } : {}) }, '', compareHash(ids)); } catch { /* embedded view */ } }
        drawCompare(ids);
    }
    function compareBack() {
        if (compareRouted()) { NAV.up('#results'); return; }
        if (!NAV && history.state && Array.isArray(history.state.compare) && !history.state.cold) { history.back(); return; }
        // opened from a link (state.cold: no entry of ours to step back over): show the overview, and drop the link from the address bar
        if (!NAV) { try { history.replaceState(null, '', location.pathname + location.search); } catch { /* embedded view */ } }
        shownCompare = null; dropPageCharts(); showOverview();
    }
    function drawCompare(ids) {
        if (ids.length > 2) { drawCompareMany(ids); return; }
        const [idA, idB] = ids;
        if (!CG) CG = buildChartGroups();      // the fit the overview's charts use (cached per catalog: fitFor)
        overviewEl.classList.add('hidden');
        detailEl.classList.remove('hidden');
        dropPageCharts();
        shownTask = null; shownModel = null; shownCompare = idA + '\n' + idB;
        const onBack = () => {
            if (compareRouted()) { NAV.up('#results'); return; }
            if (!NAV && history.state && Array.isArray(history.state.compare) && !history.state.cold) { history.back(); return; }
            // opened from a link (state.cold: no entry of ours to step back over): show the overview, and drop the link from the address bar
            if (!NAV) { try { history.replaceState(null, '', location.pathname + location.search); } catch { /* embedded view */ } }
            shownCompare = null; dropPageCharts(); showOverview();
        };
        const S = [compareSide(idA), compareSide(idB)];
        const TAG = ['A', 'B'];
        const tag = (i) => `<b style="color:${compareColor(i)}">${TAG[i]}</b>`;
        const head = `<div class="flex flex-wrap items-center gap-2">
              <button type="button" id="mc-back" class="btn btn-ghost btn-sm -ml-2">← Results</button>
              <div class="min-w-0"><div class="text-[17px] font-semibold text-white">Compare</div>
                <div class="text-[11px] text-gray-500">two Solve map rows, head to head — from the results already on this page</div></div>
              ${S[0] && S[1] ? '<button type="button" id="mc-swap" class="btn btn-sm ml-auto" title="Swap which row is A and which is B">⇄ Swap A and B</button>' : ''}
            </div>`;
        if (!S[0] || !S[1]) {
            detailEl.innerHTML = `<div class="space-y-3 max-w-[1100px] mx-auto">${head}
              <div class="text-xs text-red-200 bg-red-900/25 border border-red-800/50 rounded p-3">${!S[0] && !S[1] ? 'Neither of these rows is' : 'One of these rows is not'} on the Solve map right now${idA === idB ? '' : ' (a model with no scored run, or a config that the current “Config grouping” no longer keeps apart)'}. Go back, tick two rows and compare again.</div></div>`;
            detailEl.querySelector('#mc-back').addEventListener('click', onBack);
            view.scrollTop = 0;
            return;
        }
        const [A, B] = S;
        const td = CG.adj.taskDifficulty || new Map();
        const meta = catalog.taskMeta || {};
        const familyOf = (t) => (meta[t] && meta[t].repo) || taskFamily(t);   // the task's repo; the id's first word when the catalog names none
        const cmp = compareRows(A, B, { difficulty: td, familyOf });
        const rev = compareRows(B, A, { difficulty: td, familyOf });           // the same facts from B's side (its per-task ratios)
        const C = [cmp, rev], sh = cmp.shared, same = idA === idB;
        const nm = S.map((x) => esc(x.name));
        const who = (i) => `${tag(i)} <span class="text-gray-200">${nm[i]}</span>`;
        // numbers
        const n1 = (v) => (Math.round(v * 10) / 10).toLocaleString(undefined, { maximumFractionDigits: 1 });   // credit: task-equivalents (1 of 2 runs = 0.5)
        const times = (v) => (v == null ? '—' : `${v < 1 ? v.toFixed(2) : v.toFixed(1)}×`);
        const pc = (v) => `${Math.round((v || 0) * 100)}%`;
        const str = (x) => (x.a ? { s: Math.round(x.a.rate * 100), lo: Math.round(x.a.lo * 100), hi: Math.round(x.a.hi * 100), cov: x.a.coverage || 0 } : null);
        const ST = S.map(str);
        const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;

        // ---- one cell's outcome, as a chip
        const chipCls = 'inline-block px-1.5 py-0.5 rounded text-[10px] font-mono';
        const oChip = (o) => {
            if (!o) return `<span class="${chipCls} bg-gray-800 text-gray-500" title="this row has no run of the task">not run</span>`;
            if (o.kind === 'excluded') return `<span class="${chipCls} bg-gray-800 text-gray-400" title="run, but not a model answer: left out of every count">${esc(o.text)}</span>`;
            if (o.kind === 'partial') return `<span class="${chipCls} font-semibold bg-yellow-900/40 text-amber-300" title="passed ${o.passes} of ${o.attempts} scored runs">pass ${o.passes}/${o.attempts}</span>`;
            return statusChip(o.kind) + (o.attempts > 1 ? `<span class="text-[10px] font-mono text-gray-500" title="${o.passes} of ${o.attempts} scored runs passed"> ×${o.attempts}</span>` : '');
        };
        const taskName = (id) => (PUBLIC ? `<span class="font-mono text-[11.5px] text-gray-200 break-all">${esc(id)}</span>`
            : `<button type="button" data-open-task="${esc(id)}" class="font-mono text-[11.5px] text-indigo-300 hover:text-white text-left break-all" title="Open this task's page">${esc(id)}</button>`);
        const diffText = (id) => { const dr = difficultyRank(td, id); return dr ? dr.text : 'not placed by difficulty'; };
        // one task: its name, where it sits by difficulty, both cells. `flip` puts side B's cell first (B's own list).
        const itemRow = (x, flip) => {
            const cells = [[0, x.a], [1, x.b]];
            if (flip) cells.reverse();
            return `<div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-1 border-t border-gray-800/60">
                <span class="min-w-0">${taskName(x.id)} <span class="text-[10px] text-gray-500 whitespace-nowrap">${esc(diffText(x.id))}</span></span>
                <span class="ml-auto inline-flex items-center gap-1 whitespace-nowrap">${cells.map(([i, o]) => `${tag(i)} ${oChip(o)}${answeredChip(((i ? B : A).tasks[x.id] || {}).answered)}${overflowChip(((i ? B : A).tasks[x.id] || {}).overflowed, ((i ? B : A).tasks[x.id] || {}).passes)}${o ? '' : unfinishedChip(((i ? B : A).unfinished || {})[x.id])}`).join('<span class="text-gray-600 px-0.5">·</span>')}</span></div>`;
        };
        const listOf = (items, flip, empty) => (items.length ? items.map((x) => itemRow(x, flip)).join('') : `<div class="text-[11px] text-gray-600 py-1.5 border-t border-gray-800/60">${empty}</div>`);
        const subhead = (t) => `<div class="text-[10px] uppercase tracking-wider text-gray-500 mt-3" style="margin-bottom:0.15rem">${t}</div>`;
        const tile = (label, value, sub, title) => `<div class="tile" ${title ? `title="${esc(title)}"` : ''}><div class="tile-label">${label}</div><div class="tile-value">${value}</div><div class="tile-sub">${sub || ''}</div></div>`;

        // ---- token rates (2026-10-18, Kyle: "on the a/b compare pages, I'd like to see the avg tg and pp speeds for
        // each config being compared"): leaderboard.js speedOf, token-weighted over the row's runs, from the request log.
        // A quality row folds MTP, placement, engine and machine, so it can pool several speed configs: those are its
        // time groups (CG.tG, every facet kept apart, as the time charts), each listed with its own rates.
        const tps = (v) => (v == null ? '—' : v >= 100 ? fmtN(Math.round(v)) : v.toFixed(1));
        // 2026-10-22: each row's FASTEST speed config (fastFor: leaderboard.js fastSpeedOf, the one rule) beside the pooled
        // figures -- the chips, the raw rates, and the estimate below read it; quality, credit and the maps never do.
        const SPD = S.map((x) => {
            const all = speedOf(x.tasks), shared = sh.n ? speedOf(x.tasks, sh.ids) : null;
            const groups = speedGroupsOf(x.timeOf);
            const configs = groups.map((g) => ({ g, sp: speedOf(g.tasks) })).filter((e) => e.sp && e.sp.of > 0)
                .sort((p, q) => (q.sp.runs - p.sp.runs) || (q.sp.of - p.sp.of));
            return { all, shared, configs, groups, fs: fastFor(x.timeOf) };
        });
        // why there is no figure: a cloud row has no local server; a local one may have no request log for its runs
        const whyNone = (sp) => (!sp ? 'a cloud model: no local server timing' : `no request log for ${sp.of === 1 ? 'its run' : `any of its ${sp.of} runs`}`);
        const basis = (sp) => (!sp || !sp.runs ? whyNone(sp)
            : `${sp.runs === sp.of ? plural(sp.runs, 'run') : `${sp.runs} of ${plural(sp.of, 'run')}`} · ${fmtN(Math.round(sp.req))} requests${sp.sl ? ` (${sp.sl === sp.runs ? 'all' : sp.sl} from the Strata engine's log)` : ''}`);
        const fastOf = (i) => (SPD[i].fs ? SPD[i].fs.fastest : null);
        const fastName = (i) => (fastOf(i) ? speedLabel(fastOf(i).g, SPD[i].groups) : '');
        const fastBasis = (i) => { const f = fastOf(i); return f ? `speed from ${fastName(i)}: ${fmtN(Math.round(f.sp.req))} requests over ${plural(f.sp.tasks, 'task')}${f.thin ? ` (no speed config of this row has ${SPEED_MIN_REQ} requests at the depths its work runs at: the most-measured one stands in)` : ''}` : ''; };
        const speedChip = (i) => {
            const d = SPD[i], f = fastOf(i);
            if (!f) return d.all && d.all.runs
                ? `<span class="stat-chip" title="generation t/s, token-weighted over ${esc(basis(d.all))} (every run of its tasks, from the server's request log)"><b>${tps(d.all.tg)}</b> tg t/s</span>`
                    + `<span class="stat-chip" title="prompt-processing t/s (new prompt tokens), token-weighted over ${esc(basis(d.all))}"><b>${tps(d.all.pp)}</b> pp t/s</span>`
                : `<span class="stat-chip" title="${esc(whyNone(d.all))}"><b>—</b> tg / pp t/s</span>`;
            const pooled = d.configs.length > 1 && d.all && d.all.runs ? ` Every run of the row pooled: ${tps(d.all.tg)} tg / ${tps(d.all.pp)} pp t/s.` : '';
            return `<span class="stat-chip" title="${esc(`generation t/s at this row's fastest speed config, token-weighted, all depths — ${fastBasis(i)}.${pooled}`)}"><b>${tps(f.sp.tg)}</b> tg t/s</span>`
                + `<span class="stat-chip" title="${esc(`prompt-processing t/s (new prompt tokens) at this row's fastest speed config, all depths — ${fastBasis(i)}.${pooled}`)}"><b>${tps(f.sp.pp)}</b> pp t/s</span>`
                + (d.configs.length > 1 ? `<span class="stat-chip" title="${esc(`${fastBasis(i)}. The row's runs used ${d.configs.length} speed configs; the rates here are its fastest one's (see Speed and cost).`)}">fastest of ${d.configs.length} configs</span>` : '');
        };

        // ---- 1. the two rows, and how sure the difference in strength is
        const sideCard = (x, i) => {
            const c = C[0][i ? 'b' : 'a'], st = ST[i];
            return `<div class="tile" style="border-color:${compareColor(i)}66">
                <div class="flex items-start gap-2"><span class="tag" style="background:${compareColor(i)};color:#fff">${TAG[i]}</span>
                  <div class="min-w-0"><button type="button" data-open-model="${esc(x.m.key)}" class="text-[14px] font-semibold text-white hover:text-indigo-300 text-left break-words" title="Open this model's page">${esc(x.name)}</button>
                    <div class="text-[11px] text-gray-500">${esc(x.note)}</div></div></div>
                <div class="mt-2 flex flex-wrap items-baseline gap-x-2">
                  <span class="tile-value" style="font-size:26px">${st ? st.s : '—'}</span><span style="font-size:11px;font-weight:500;color:#747b8c">/100 strength</span>
                  <span class="text-[11.5px] text-gray-400 font-mono"${x.a && x.a.range ? ` title="${esc(rangeNote(x.a))}"` : ''}>${st ? `95% range ${st.lo}–${st.hi}${x.a && x.a.range && x.a.range.source !== 'bootstrap' ? ' · posterior' : ''}` : 'no strength estimate'}</span></div>
                <div class="flex flex-wrap gap-1.5 mt-2">
                  ${st ? `<span class="stat-chip" title="how many of the 100 difficulty points this row actually ran: the direct evidence its ability (and so its strength) is fitted from"><b>${pc(st.cov)}</b> tested</span>` : ''}
                  <span class="stat-chip" title="tasks with at least one scored run${c.excluded ? `; ${c.excluded} more have only excluded runs (not model answers)` : ''}"><b>${fmtN(c.scored)}</b> tasks scored</span>
                  <span class="stat-chip" title="scored runs; ${plural(c.repeated, 'task')} run more than once"><b>${fmtN(c.runs)}</b> attempts</span>
                  <span class="stat-chip" title="scored runs that passed (${n1(c.credit)} task-equivalents: a task passed on 1 of 2 runs counts 0.5)"><b>${fmtN(c.runsPassed)}</b> passed</span>
                  ${speedChip(i)}
                </div></div>`;
        };
        // both ranges on one 0-100 axis: whether they overlap is the picture
        const both = ST[0] && ST[1];
        const ov = both && overlaps(A.a, B.a);
        // THE GAP (2026-10-25): A - B with its own 95% range (leaderboard.js strengthGap: from the same bootstrap refits, so
        // what moves every row together cancels; two rows' ranges can overlap while their gap is clear of 0). Whether one
        // row is shown to be the stronger is the gap's call; the overlap picture stays.
        const gapOf = (x) => (x.pooled ? weightsOf(x.m) : x.id);
        const G = both && !same ? strengthGap(CG.fit, gapOf(A), gapOf(B)) : null;
        const sep = G ? G.resolved : both && !ov;
        const band = both && ov ? [Math.max(A.a.lo, B.a.lo) * 100, Math.min(A.a.hi, B.a.hi) * 100] : null;
        const rangeRow = (i) => { const a = S[i].a; return `<div class="flex items-center gap-2" style="height:18px"><span style="width:14px;text-align:center">${tag(i)}</span>
              <div style="position:relative;flex:1;height:18px">
                <div style="position:absolute;left:0;right:0;top:8.5px;height:1px;background:rgba(255,255,255,0.08)"></div>
                <div style="position:absolute;left:${(a.lo * 100).toFixed(2)}%;width:${Math.max(0.6, (a.hi - a.lo) * 100).toFixed(2)}%;top:6px;height:6px;border-radius:3px;background:${compareColor(i)};opacity:0.5"></div>
                <div style="position:absolute;left:calc(${(a.rate * 100).toFixed(2)}% - 2.5px);top:2px;width:5px;height:14px;border-radius:2px;background:${compareColor(i)}"></div>
              </div></div>`; };
        const rangePlot = !both ? '' : `<div class="mt-3" role="img" aria-label="The two 95% strength ranges on one 0 to 100 axis: ${ov ? 'they overlap' : 'they do not overlap'}">
              <div style="position:relative">
                ${band ? `<div style="position:absolute;left:calc(22px + (100% - 22px) * ${(band[0] / 100).toFixed(4)});width:calc((100% - 22px) * ${((band[1] - band[0]) / 100).toFixed(4)});top:-3px;bottom:-3px;background:rgba(255,255,255,0.07);border-left:1px dashed rgba(255,255,255,0.35);border-right:1px dashed rgba(255,255,255,0.35)" title="where the two ranges overlap: ${Math.round(band[0])}–${Math.round(band[1])}"></div>` : ''}
                ${rangeRow(0)}${rangeRow(1)}
              </div>
              <div class="flex justify-between text-[10px] text-gray-600 font-mono" style="margin-left:22px"><span>0</span><span>25</span><span>50</span><span>75</span><span>100</span></div>
            </div>`;
        const lead = both ? (ST[0].s === ST[1].s ? -1 : ST[0].s > ST[1].s ? 0 : 1) : -1;
        const gap = both ? Math.abs(ST[0].s - ST[1].s) : 0;
        const rangesTxt = both ? `${TAG[0]} ${ST[0].lo}–${ST[0].hi}, ${TAG[1]} ${ST[1].lo}–${ST[1].hi}` : '';
        const g1 = (v) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}`;
        const gapTxt = G ? `the gap ${TAG[0]} − ${TAG[1]} is <b class="text-white">${g1(G.gap)}</b> points, 95% range ${g1(G.lo)} to ${g1(G.hi)} (${G.source === 'bootstrap' ? `from the same ${G.refits} bootstrap refits, so what moves both rows together cancels${G.ahead != null ? `; ${TAG[0]} ahead in ${Math.round(G.ahead * 100)}% of them` : ''}` : 'both ranges as if independent: one of the rows is not in the last bootstrap'})` : '';
        const verdict = same ? 'Both sides are the same row.'
            : !both ? `There is no strength estimate for ${!ST[0] && !ST[1] ? 'either row' : !ST[0] ? nm[0] : nm[1]}, so the two cannot be ranked by strength.`
            : G ? (G.resolved
                ? `<b class="text-white">${nm[G.gap > 0 ? 0 : 1]} is the stronger</b>: ${gapTxt}, clear of 0. ${ov ? `Their own 95% ranges overlap (${rangesTxt}); the gap is what is measured.` : `Their own 95% ranges do not overlap either (${rangesTxt}).`}`
                : `<b class="text-white">Neither row is shown to be the stronger</b>: ${gapTxt}, which includes 0. Their own 95% ranges: ${rangesTxt}.`)
            : ov ? `<b class="text-white">The 95% ranges overlap</b> (${rangesTxt}). ${lead < 0 ? `Both read ${ST[0].s}/100` : `The ${gap}-point gap in strength (${ST[0].s} against ${ST[1].s})`} is inside the uncertainty: on this evidence neither row is shown to be the stronger.`
                : `<b class="text-white">The 95% ranges do not overlap</b> (${rangesTxt}). ${nm[lead]}'s ${gap}-point lead in strength is larger than the uncertainty in both estimates.`;
        const thin = S.map((x, i) => (ST[i] && ST[i].cov < 0.25 ? `${nm[i]} has run only ${pc(ST[i].cov)} of the difficulty points, so its strength rests on little direct evidence.` : '')).filter(Boolean).join(' ');
        // A thin overlap (compareRows shared.thin): the like-for-like section covers only a sliver of the two records, so
        // each row's OWN record leads, and every like-for-like block below carries the warning (2026-10-18).
        const ownRec = (i) => { const c = C[0][i ? 'b' : 'a']; return `${nm[i]} passed ${n1(c.credit)} of its ${plural(c.scored, 'scored task')}`; };
        const thinTxt = sh.n && sh.thin ? `They have run mostly different tasks: only ${plural(sh.n, 'task')} of ${TAG[0]}'s ${cmp.a.scored} and ${TAG[1]}'s ${cmp.b.scored} scored tasks ${sh.n === 1 ? 'is' : 'are'} shared, so the like-for-like counts below rest on ${sh.n === 1 ? 'that one task' : `those ${sh.n}`} and say little about the two rows. On their own tasks (different sets, not comparable): ${ownRec(0)}; ${ownRec(1)}.` : '';
        const thinBox = thinTxt ? `<div class="text-[12px] text-amber-200 bg-amber-900/20 border border-amber-800/40 rounded p-3 mb-3" data-thin-overlap="1">A thin overlap: the counts below cover ${sh.n === 1 ? 'the one task' : `the ${sh.n} tasks`} both rows have scored, not their records (${ownRec(0)}; ${ownRec(1)}). ${TAG[0]} has ${plural(cmp.gaps.onlyA.length, 'scored task')} ${TAG[1]} never ran and ${TAG[1]} has ${cmp.gaps.onlyB.length} ${TAG[0]} never ran, listed under “Not comparable”.</div>` : '';
        const likeTxt = sh.n === 0 ? 'They have no scored task in common, so nothing here is like-for-like.'
            : sh.thin ? thinTxt
            : `On the <b class="text-white">${plural(sh.n, 'shared task')}</b> (scored by both) they differ on ${sh.differ}: ${nm[0]} is ahead on ${sh.aAhead}, ${nm[1]} on ${sh.bAhead}. `
                + (sh.singleRun === 0 ? 'Both ran every one of them more than once.'
                    : `${sh.singleRun === sh.n ? (sh.n === 1 ? 'It rests' : `All ${sh.n} rest`) : `${sh.singleRun} of the ${sh.n} rest`} on a single run on at least one side, and a single run can go the other way on a repeat — a lead of a few tasks is not a settled result.`);

        // ---- 2. like-for-like: the split, and the tasks behind it
        // The summary tiles and the bar under them are drawn from ONE ordered list (leaderboard.js likeSegments), so the
        // boxes read left to right in the bar's order, in its colours, with its counts (2026-10-20, Kyle).
        const SEGS = likeSegments(sh, { tags: TAG, colors: [compareColor(0), compareColor(1)] });
        const likeTiles = segTiles(SEGS);
        const splitBar = segBar(SEGS, sh.n);
        const aheadCol = (i) => {
            const L = sh.lists, only = i ? L.bOnly : L.aOnly, better = i ? L.bBetter : L.aBetter, o = 1 - i;
            return `<div class="min-w-0"><div class="text-[13px] font-semibold text-gray-100">${who(i)} ahead <span class="text-gray-500 font-normal">· ${only.length + better.length}</span></div>
                ${subhead(`passed where ${TAG[o]} missed · ${only.length}`)}${listOf(only, !!i, 'none')}
                ${better.length ? subhead(`did better, on partial credit · ${better.length}`) + listOf(better, !!i, 'none') : ''}</div>`;
        };

        // ---- 3. where each one's wins sit
        const lead2 = (va, vb) => (Math.abs(va - vb) < 0.05 ? ['text-gray-300', 'text-gray-300'] : va > vb ? ['text-white font-semibold', 'text-gray-500'] : ['text-gray-500', 'text-white font-semibold']);
        const numTd = (v, cls) => `<td class="px-2 py-1 text-right font-mono ${cls || 'text-gray-300'}">${v}</td>`;
        const th = (t, title, left) => `<th class="px-2 py-1 ${left ? 'text-left' : 'text-right'} text-[10px] uppercase tracking-wider text-gray-500 font-semibold border-b border-gray-800" ${title ? `title="${esc(title)}"` : ''}>${t}</th>`;
        const groupRows = (list, label, extra) => list.map((g) => { const [ca, cb] = lead2(g.creditA, g.creditB); return `<tr class="border-t border-gray-800/60">
              <td class="px-2 py-1 text-gray-200">${label(g)}</td>${numTd(g.n)}${numTd(g.n ? n1(g.creditA) : '—', ca)}${numTd(g.n ? n1(g.creditB) : '—', cb)}${numTd(g.aAhead || '·')}${numTd(g.bAhead || '·')}${numTd(g.bothFail || '·')}${extra ? numTd(g.onlyA || '·', 'text-gray-500') + numTd(g.onlyB || '·', 'text-gray-500') : ''}</tr>`; }).join('');
        const groupHead = (first, extra) => `<thead><tr>${th(first, null, true)}${th('shared', 'tasks both rows have scored')}${th(`${TAG[0]} solved`, 'task-equivalents on the shared tasks: a task passed on 1 of 2 runs counts 0.5')}${th(`${TAG[1]} solved`, 'task-equivalents on the shared tasks')}${th(`${TAG[0]} ahead`, 'shared tasks where A has more credit than B')}${th(`${TAG[1]} ahead`, 'shared tasks where B has more credit than A')}${th('both miss', 'shared tasks neither passed on any run')}${extra ? th(`only ${TAG[0]} ran`, 'scored by A, not by B: not comparable') + th(`only ${TAG[1]} ran`, 'scored by B, not by A: not comparable') : ''}</tr></thead>`;
        const BAND = { easiest: 'easiest third', middle: 'middle third', hardest: 'hardest third' };
        const bandTable = cmp.bands.length ? `<div class="overflow-x-auto"><table class="w-full text-xs">${groupHead('difficulty')}<tbody>${groupRows(cmp.bands, (g) => BAND[g.key])}</tbody></table></div>`
            : '<div class="text-[11px] text-gray-600">Fewer than three shared tasks: nothing to split.</div>';
        const famTable = cmp.families.length ? `<div class="overflow-x-auto"><table class="w-full text-xs">${groupHead('family', true)}<tbody>${groupRows(cmp.families, (g) => `<span class="font-mono">${esc(g.key)}</span>`, true)}</tbody></table></div>` : '';
        const compTable = cmp.composites.length ? `<div class="overflow-x-auto"><table class="w-full text-xs"><thead><tr>${th('composite task', null, true)}${th('difficulty', null, true)}${th(TAG[0], null, true)}${th(TAG[1], null, true)}</tr></thead><tbody>
              ${cmp.composites.map((x) => `<tr class="border-t border-gray-800/60"><td class="px-2 py-1">${taskName(x.id)}</td><td class="px-2 py-1 text-[11px] text-gray-500 whitespace-nowrap">${esc(diffText(x.id))}</td><td class="px-2 py-1 whitespace-nowrap">${oChip(x.a)}</td><td class="px-2 py-1 whitespace-nowrap">${oChip(x.b)}</td></tr>`).join('')}</tbody></table></div>`
            : '<div class="text-[11px] text-gray-600">Neither row has run a composite task.</div>';
        // Plain statements, each one a count the tables above show. A fact is WON by one side; it is that side's strength
        // and, said the other way round, the other side's weak spot. Thresholds: a family needs 3 shared tasks and a lead
        // of a whole task; speed and tokens need LADDER_MIN_N shared solved tasks, most of them won, and a 10% gap.
        const facts = (i) => {
            const c = C[i], s = c.shared, o = 1 - i, out = [];
            const won = G ? (G.gap > 0 ? 0 : 1) === i : lead === i, why = G ? 'and the 95% range of the gap is clear of 0' : 'and the 95% ranges do not overlap';
            if (both && sep && won) out.push([`Stronger overall: strength ${ST[i].s} against ${ST[o].s}, ${why}.`, `Weaker overall: strength ${ST[o].s} against ${ST[i].s}, ${why}.`]);
            if (s.aAhead) {
                const where = c.bands.length ? ` By difficulty: ${c.bands[2].aAhead} in the hardest third of the shared tasks, ${c.bands[1].aAhead} in the middle, ${c.bands[0].aAhead} in the easiest.` : '';
                out.push([`Ahead on ${s.aAhead} of the ${plural(s.n, 'shared task')}: passed ${s.aOnly} that ${TAG[o]} missed${s.aBetter ? `, and did better on ${s.aBetter} on partial credit` : ''}.${where}`,
                    `Behind on ${s.aAhead} of the ${plural(s.n, 'shared task')}: missed ${s.aOnly} that ${TAG[i]} passed${s.aBetter ? `, and did worse on ${s.aBetter} on partial credit` : ''}.${where}`]);
            }
            for (const f of c.families) if (f.n >= 3 && f.creditA - f.creditB >= 1) out.push([`Leads on ${f.key}: ${n1(f.creditA)} solved against ${n1(f.creditB)}, of ${f.n} shared tasks.`, `Trails on ${f.key}: ${n1(f.creditB)} solved against ${n1(f.creditA)}, of ${f.n} shared tasks.`]);
            for (const x of c.composites) if (x.a && x.a.scored && x.b && x.b.scored && x.a.credit > x.b.credit) out.push([`Composite task ${x.id}: ${x.a.text}, against ${x.b.text}.`, `Composite task ${x.id}: ${x.b.text}, against ${x.a.text}.`]);
            // wall clock: as run, or -- when a row's paired runs were not all at its fastest speed config -- the estimate at
            // each row's fastest config (EST below), so a slow quality run does not make a row "slower" here either
            const sp = EST.warn ? EST.speed[i] : c.speed, at = EST.warn ? ' (estimated at each row\'s fastest speed config)' : '';
            if (sp.n >= LADDER_MIN_N && sp.aFaster > sp.bFaster && sp.ratio <= 1 / LADDER_MIN_SPEEDUP) out.push([`Faster on ${sp.aFaster} of the ${sp.n} tasks both solved: a median of ${times(sp.ratio)} ${TAG[o]}'s wall clock on the same task${at}.`, `Slower on ${sp.aFaster} of the ${sp.n} tasks both solved: a median of ${times(1 / sp.ratio)} ${TAG[i]}'s wall clock on the same task${at}.`]);
            const tk = c.speed.tok;
            if (tk.n >= LADDER_MIN_N && tk.aFewer > tk.bFewer && tk.ratio <= 1 / LADDER_MIN_SPEEDUP) out.push([`Fewer output tokens on ${tk.aFewer} of ${tk.n} tasks both solved: a median of ${times(tk.ratio)} ${TAG[o]}'s.`, `More output tokens on ${tk.aFewer} of ${tk.n} tasks both solved: a median of ${times(1 / tk.ratio)} ${TAG[i]}'s.`]);
            return out;
        };
        // ---- speed at each row's FASTEST speed config (2026-10-22, Kyle: "a warning that notes that it wasn't run at fastest
        // config, shows estimated times based on tokens re-multiplied by fastest config expected performance, and then also
        // has a separate comparison that is raw gen/prefill speed results for fastest configs for each"). Three parts:
        //   A  the paired wall clock as run (cmp.speed, every run, unchanged) + which speed configs ran those tasks when
        //      they were not all a row's fastest (speedConfigShare);
        //   B  the same paired summary over the tasks RE-PRICED at each row's fastest config (fastSpeedOf: tool and test
        //      time as measured, model time at that config's rates); a row with no measured rate (cloud) keeps its walls;
        //   C  the fastest configs' own rates by context depth, generation and prompt apart.
        const EST = (() => {
            const share = S.map((x, i) => speedConfigShare(SPD[i].fs, cmp.speed.ids));
            const notAt = share.map((w) => w.n > 0 && w.atFastest < w.n);
            const tasksOf = (i) => (SPD[i].fs ? SPD[i].fs.tasks : S[i].tasks);
            const speed = [compareRows({ tasks: tasksOf(0) }, { tasks: tasksOf(1) }).speed, compareRows({ tasks: tasksOf(1) }, { tasks: tasksOf(0) }).speed];
            // the fastest configs' own runs, measured: only worth reading with LADDER_MIN_N tasks both solved there
            const direct = fastOf(0) && fastOf(1) ? compareRows(fastOf(0).g, fastOf(1).g).speed : null;
            return { share, notAt, warn: notAt.some(Boolean), speed, direct };
        })();
        const F = [facts(0), facts(1)];
        const ul = (items, empty) => (items.length ? `<ul class="list-disc ml-4 space-y-1 text-[12px] text-gray-300">${items.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : `<div class="text-[11.5px] text-gray-600">${empty}</div>`);
        const swCol = (i) => `<div class="min-w-0"><div class="text-[13px] font-semibold text-gray-100">${who(i)}</div>
              ${subhead('strengths against ' + TAG[1 - i])}${ul(F[i].map((f) => f[0]), 'Nothing in this data sets it ahead.')}
              ${subhead('weak spots against ' + TAG[1 - i])}${ul(F[1 - i].map((f) => f[1]), 'Nothing in this data sets it behind.')}</div>`;
        const hardMiss = cmp.bands.length ? `, ${cmp.bands[2].bothFail} of them in the hardest third` : '';

        // ---- 4. speed and cost
        const sp = cmp.speed, tk = sp.tok;
        const few = (n) => (n > 0 && n < LADDER_MIN_N ? ` <span class="text-amber-300">Only ${plural(n, 'task')}: too few to read much into.</span>` : '');
        const fasterTxt = sp.n === 0 ? '' : sp.aFaster === sp.bFaster ? `Each was the faster on ${sp.aFaster} of the ${sp.n}.`
            : `${nm[sp.aFaster > sp.bFaster ? 0 : 1]} was the faster on ${Math.max(sp.aFaster, sp.bFaster)} of the ${sp.n}${sp.same ? ` (${sp.same} equal)` : ''}.`;
        const speedBody = sp.n === 0 ? '<div class="text-[11.5px] text-gray-600">No shared task was solved by both with a wall clock recorded, so there is no like-for-like speed to show.</div>'
            : `<div class="grid grid-cols-2 md:grid-cols-4 gap-2">
                ${tile(`${tag(0)}&nbsp;median wall clock`, fmtDur(sp.medA), `over the ${plural(sp.n, 'task')} both solved`)}
                ${tile(`${tag(1)}&nbsp;median wall clock`, fmtDur(sp.medB), `over the same ${plural(sp.n, 'task')}`)}
                ${tile('per task, A ÷ B', times(sp.ratio), `median over the ${plural(sp.n, 'task')}; below 1× = A faster`, `Each task's wall clock for A divided by B's, then the median. Geometric mean of the same ratios: ${times(sp.geo)}.`)}
                ${tile('faster on', `${sp.aFaster}<span style="font-size:11px;font-weight:500;color:#747b8c;margin-left:0.2rem;letter-spacing:0">A</span> · ${sp.bFaster}<span style="font-size:11px;font-weight:500;color:#747b8c;margin-left:0.2rem;letter-spacing:0">B</span>`, `of ${plural(sp.n, 'task')}${sp.same ? ` · ${sp.same} equal` : ''}`)}
              </div>
              <div class="text-[11.5px] text-gray-400 mt-2">${fasterTxt} Per task, ${nm[0]} took a median of <b class="text-gray-200">${times(sp.ratio)}</b> ${nm[1]}'s wall clock.${few(sp.n)}</div>`;
        const tokBody = tk.n === 0 ? '<div class="text-[11.5px] text-gray-600 mt-3">No shared solved task has an output-token count on both sides.</div>'
            : `<div class="grid grid-cols-2 md:grid-cols-4 gap-2 mt-3">
                ${tile(`${tag(0)}&nbsp;output tokens per solve`, fmtN(Math.round(tk.medA)), `median over ${plural(tk.n, 'task')} both solved`)}
                ${tile(`${tag(1)}&nbsp;output tokens per solve`, fmtN(Math.round(tk.medB)), `median over the same ${plural(tk.n, 'task')}`)}
                ${tile('per task, A ÷ B', times(tk.ratio), 'median; below 1× = A used fewer', `Geometric mean of the same ratios: ${times(tk.geo)}.`)}
                ${tile('fewer on', `${tk.aFewer}<span style="font-size:11px;font-weight:500;color:#747b8c;margin-left:0.2rem;letter-spacing:0">A</span> · ${tk.bFewer}<span style="font-size:11px;font-weight:500;color:#747b8c;margin-left:0.2rem;letter-spacing:0">B</span>`, `of ${plural(tk.n, 'task')}${tk.same ? ` · ${tk.same} equal` : ''}`)}
              </div>${few(tk.n) ? `<div class="text-[11.5px] mt-1">${few(tk.n)}</div>` : ''}`;
        // A: the paired tasks above were not all run at a row's fastest speed config -- say which configs ran them
        const warnLine = (i) => {
            const w = EST.share[i];
            if (!EST.notAt[i]) return '';
            const list = w.others.slice(0, 3).map((o) => `${speedLabel(o.g, SPD[i].groups)} on ${o.tasks}`).join('; ') + (w.others.length > 3 ? `; ${w.others.length - 3} more configs` : '');
            return `<li>${who(i)}: <b class="text-amber-100">${w.n - w.atFastest} of its ${plural(w.n, 'paired task')}</b> ran (all or partly) at speed configs other than its fastest (<span class="font-mono">${esc(fastName(i))}</span>): <span class="font-mono">${esc(list)}</span>.</li>`;
        };
        const warnBox = !EST.warn ? '' : `<div class="text-[12px] text-amber-200 bg-amber-900/20 border border-amber-800/40 rounded p-3 mb-3" data-speed-not-fastest="1">
              <b>Not run at the fastest config.</b> These wall clocks are as the runs went, and a row's runs can come from several speed configs (the row folds speed-only settings: MTP, GPU placement, engine version, Strata's RAM budget and prompt chunk):
              <ul class="list-disc ml-4 mt-1 space-y-0.5">${[0, 1].map(warnLine).join('')}</ul>
              <div class="mt-1">Below: the same tasks re-priced at each row's fastest config, and that config's own rates.</div></div>`;
        // B: the estimate at each row's fastest config, in A's shape
        const es = EST.speed[0];
        const medOf = (i, field) => { const T = SPD[i].fs ? SPD[i].fs.tasks : null; const v = T ? es.ids.map((id) => T[id] && T[id][field]).filter((x) => x != null && x >= 0).sort((a, b) => a - b) : []; return v.length ? (v.length % 2 ? v[(v.length - 1) / 2] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2) : null; };
        const estState = (i) => (!SPD[i].fs ? 'as run (no measured rate: nothing to re-price)'
            : es.ids.every((id) => (SPD[i].fs.tasks[id] || {}).how === 'measured') ? `measured at its fastest config (${fastName(i)})` : `estimated at ${fastName(i)}`);
        const estTile = (i) => tile(`${tag(i)}&nbsp;median wall clock&nbsp;<span class="text-amber-300" style="text-transform:none">est.</span>`, fmtDur(i ? es.medB : es.medA),
            `${medOf(i, 'model_fast_s') != null ? `model time ${fmtDur(medOf(i, 'model_fast_s'))}${medOf(i, 'model_s') != null && Math.abs(medOf(i, 'model_s') - medOf(i, 'model_fast_s')) > 0.5 ? ` (as run ${fmtDur(medOf(i, 'model_s'))})` : ''}` : 'model time unknown'}`,
            `${estState(i)}. Each task: its wall clock less the time the server spent on its requests (as logged), plus its prompt tokens read and tokens generated at the fastest config's measured rates for their context depth. Tool and test time stay as measured. Median over the ${es.n} paired tasks; model time = the server's part.`);
        const directTxt = !EST.direct ? '' : EST.direct.n >= LADDER_MIN_N
            ? ` Measured directly, on the ${plural(EST.direct.n, 'task')} both rows solved AT their fastest configs: medians ${fmtDur(EST.direct.medA)} and ${fmtDur(EST.direct.medB)}, ${times(EST.direct.ratio)} per task.`
            : ` The two fastest configs share ${EST.direct.n ? `only ${plural(EST.direct.n, 'solved task')}` : 'no solved task'}: too few for a measured comparison at those configs alone, hence the estimate.`;
        const estBody = !EST.warn
            ? `<div class="text-[11.5px] text-gray-400 mt-3" data-speed-at-fastest="measured">${SPD[0].fs && SPD[1].fs ? 'Both rows ran every paired task at their fastest speed config: the figures above are measured at it, and the estimate there would read the same.' : 'No row has a measured rate to re-price, or none of its paired tasks ran elsewhere: the figures above stand.'}</div>`
            : es.n === 0 ? '<div class="text-[11.5px] text-gray-600 mt-3">No paired task could be re-priced (no request timings for those runs).</div>'
            : `${subhead('estimated at each row’s fastest speed config — tokens re-priced at its measured rates')}
              <div class="grid grid-cols-2 md:grid-cols-4 gap-2" data-speed-at-fastest="estimated">
                ${estTile(0)}${estTile(1)}
                ${tile('per task, A ÷ B&nbsp;<span class="text-amber-300" style="text-transform:none">est.</span>', times(es.ratio), `median over the ${plural(es.n, 'task')}; below 1× = A faster`, `Geometric mean of the same ratios: ${times(es.geo)}.`)}
                ${tile('faster on&nbsp;<span class="text-amber-300" style="text-transform:none">est.</span>', `${es.aFaster}<span style="font-size:11px;font-weight:500;color:#747b8c;margin-left:0.2rem;letter-spacing:0">A</span> · ${es.bFaster}<span style="font-size:11px;font-weight:500;color:#747b8c;margin-left:0.2rem;letter-spacing:0">B</span>`, `of ${plural(es.n, 'task')}${es.same ? ` · ${es.same} equal` : ''}`)}
              </div>
              <div class="text-[11.5px] text-gray-400 mt-2">An ESTIMATE: ${tag(0)} ${esc(estState(0))}; ${tag(1)} ${esc(estState(1))}. Per task, ${nm[0]} would take a median of <b class="text-gray-200">${times(es.ratio)}</b> ${nm[1]}'s wall clock.${es.n < sp.n ? ` Over ${es.n} of the ${sp.n} paired tasks: the rest ran only at configs with no measured rate.` : ''}${directTxt}${few(es.n)}</div>`;
        // C: the fastest configs' own rates, by context depth; generation and prompt never blended
        const rawRow = (i) => {
            const f = fastOf(i);
            if (!f) return `<tr class="border-t border-gray-800/60"><td class="px-2 py-1">${who(i)}</td><td colspan="7" class="px-2 py-1 text-[11px] text-gray-500">${esc(whyNone(SPD[i].all))}</td></tr>`;
            const b = f.sp.bands, cell = (v, n) => `<td class="px-2 py-1 text-right font-mono text-gray-200" title="${n != null ? `${fmtN(Math.round(n))} requests` : ''}">${n != null && n < 1 ? '—' : tps(v)}</td>`;
            return `<tr class="border-t border-gray-800/60" title="${esc(fastBasis(i))}"><td class="px-2 py-1">${who(i)} <div class="text-[10.5px] text-gray-500 font-mono break-all">${esc(fastName(i))}${f.thin ? ' <span class="text-amber-300">(thin)</span>' : ''}</div></td>
                ${cell(f.sp.tg, f.sp.req)}${b.map((x) => cell(x.tg, x.req)).join('')}${cell(f.sp.pp, f.sp.req)}${b.map((x) => cell(x.pp, x.req)).join('')}
                <td class="px-2 py-1 text-right font-mono text-[11px] text-gray-400 whitespace-nowrap">${fmtN(Math.round(f.sp.req))} <span class="text-gray-600">(${b.map((x) => fmtN(Math.round(x.req))).join(' · ')})</span><div class="text-gray-600">${plural(f.sp.tasks, 'task')}</div></td></tr>`;
        };
        const rawRates = `${subhead('raw rates at each row’s fastest speed config — generation (tg) and prompt processing (pp), t/s, by context depth')}
              <div class="overflow-x-auto"><table class="w-full text-xs" data-fastest-rates="1"><thead><tr>${th('row · its fastest speed config', null, true)}${th('tg all', 'generation, every depth')}${SPEED_BANDS.map((b) => th(`tg ${b.label}`, `generation, ${b.title}`)).join('')}${th('pp all', 'prompt processing (new prompt tokens), every depth')}${SPEED_BANDS.map((b) => th(`pp ${b.label}`, `prompt processing, ${b.title}`)).join('')}${th('requests', `all (${SPEED_BANDS.map((b) => b.label).join(' · ')}) and tasks`)}</tr></thead><tbody>${rawRow(0)}${rawRow(1)}</tbody></table></div>
              <div class="text-[11px] text-gray-500 mt-2">The fastest config: the one that would do the row's own work (its prompt tokens read and tokens generated at each depth, over all its runs) in the least model time at its measured rates, among configs with at least ${SPEED_MIN_REQ} requests and 5 in each depth band the row's work runs in; within 3% of each other, the better-measured one. Context depth = tokens in the context once the prompt is read. Rates are token-weighted, from the server's request log (llama.cpp) or the Strata engine's own log.</div>`;

        // the page's own whole-record figures for these rows: the fastest config's place in the joint time fit, and mean tokens per solve
        const whole = S.map((x, i) => {
            const tg = fastestFor(x.timeOf), rt = tg ? CG.rel.get(tg.key) : null, q = qualityMetricsFor(x.tasks, null);
            return { rel: rt && rt.index != null ? rt : null, cfg: tg && (x.pooled || tg.estimated) ? speedLabel(tg.from || tg, SPD[i].groups) : '', est: !!(tg && tg.estimated), tok: q.tokensPerSolve || null, solved: q.solved };
        });
        const wholeRow = (i) => `<tr class="border-t border-gray-800/60"><td class="px-2 py-1">${who(i)}</td>
              <td class="px-2 py-1 text-right font-mono text-gray-200">${whole[i].rel ? times(whole[i].rel.index) : '—'}${whole[i].est ? ' <span class="text-amber-300 text-[10px]">est.</span>' : ''}</td>
              <td class="px-2 py-1 text-[11px] text-gray-500">${whole[i].rel ? `${plural(whole[i].rel.tasks, 'solved task')} in the fit${whole[i].cfg ? ` · ${whole[i].est ? 'its tasks re-priced at its fastest config' : 'its fastest config'}: ${esc(whole[i].cfg)}` : ''}` : 'not enough solved tasks shared with other configs'}</td>
              <td class="px-2 py-1 text-right font-mono text-gray-200">${whole[i].tok ? fmtN(Math.round(whole[i].tok)) : '—'}</td>
              <td class="px-2 py-1 text-[11px] text-gray-500">${whole[i].tok ? 'mean over every task it solved' : 'no solve with a token count'}</td></tr>`;

        const SUB_LABEL = 'text-[11px] text-gray-400';
        const spdRow = (label, sp, sub, title) => `<tr class="border-t border-gray-800/60"${title ? ` title="${esc(title)}"` : ''}><td class="px-2 py-1 ${sub ? SUB_LABEL : ''}" style="${sub ? 'padding-left:1.6rem' : ''}">${label}</td>
              <td class="px-2 py-1 text-right font-mono ${sub ? 'text-gray-300' : 'text-gray-100'}">${sp && sp.runs ? tps(sp.tg) : '—'}</td>
              <td class="px-2 py-1 text-right font-mono ${sub ? 'text-gray-300' : 'text-gray-100'}">${sp && sp.runs ? tps(sp.pp) : '—'}</td>
              <td class="px-2 py-1 text-[11px] text-gray-500">${esc(basis(sp))}</td></tr>`;
        const spdRows = (i) => {
            const d = SPD[i], out = [spdRow(`${who(i)} <span class="text-[11px] text-gray-500">· every run</span>`, d.all, false)];
            if (sh.n && d.all) out.push(spdRow(`on the ${plural(sh.n, 'shared task')}`, d.shared, true, 'only the tasks both rows have scored: the same tasks on both sides'));
            if (d.configs.length > 1) {
                const MAXC = 8, F = fastOf(i) && fastOf(i).g;
                // the row's fastest first (marked), then the rest by runs
                const list = [...d.configs.filter((e) => e.g === F), ...d.configs.filter((e) => e.g !== F)];
                for (const e of list.slice(0, MAXC)) {
                    const full = e.g.cfgDiff || e.g.cfgNorm || e.g.label || 'one speed config';
                    const short = speedLabel(e.g, d.groups);
                    out.push(spdRow(`${e.g === F ? '<span class="text-emerald-300 font-semibold" title="this row\'s fastest speed config (the rule under Speed and cost)">★ fastest</span> ' : ''}<span class="font-mono">${esc(short)}</span>`, e.sp, true, `one speed config of this row (launch settings, MTP, GPU placement, engine version and machine all the same): ${full}`));
                }
                if (d.configs.length > MAXC) out.push(`<tr><td colspan="4" class="px-2 py-1 text-[11px] text-gray-600" style="padding-left:1.6rem">+ ${d.configs.length - MAXC} more speed configs with fewer runs</td></tr>`);
            }
            return out.join('');
        };
        const pooledNote = SPD.some((d) => d.configs.length > 1) ? ' A row that pools several speed configs (different GPU placement, MTP, engine version or machine) mixes them in its first line; each config follows on its own line, its fastest (★) first.' : '';
        const tokRates = `${subhead('token rates of every speed config — generation (tg) and prompt processing (pp), t/s, all depths')}
              <div class="overflow-x-auto"><table class="w-full text-xs"><thead><tr>${th('row', null, true)}${th('tg t/s', 'generation: generated tokens ÷ generation time')}${th('pp t/s', 'prompt processing: new prompt tokens ÷ prefill time')}${th('based on', null, true)}</tr></thead><tbody>${spdRows(0)}${spdRows(1)}</tbody></table></div>
              <div class="text-[11px] text-gray-500 mt-2">Token-weighted, as the per-task t/s on Bench → Live: all tokens ÷ all time over every request the row's runs made (passed, failed or excluded; INVALID batteries left out), from the server's own request log — llama-server's timings for llama.cpp, the record proxy's for Strata, and for a Strata run the proxy did not record, the engine's own log (shared out by wall clock when several runs used one engine start). Not a rate at a stated context: an agent run's context grows as it works, so these sit below short-context llama-bench figures and are not the overview's “@32k” medians. “—”: a cloud model, or runs with no request log (a Strata leg run without the record proxy, a run from before 2026-09-24 with no recorded start, a server another lane also ran the same weights on with no launch command to tell them apart).${pooledNote}</div>`;

        // ---- 5. what is not comparable
        const gapList = (items, i) => `<details class="how" ${items.length && items.length <= 8 ? 'open' : ''}><summary><span>Only ${who(i)} has scored <span class="text-gray-500">· ${plural(items.length, 'task')}</span></span></summary>
              <div class="how-body">${listOf(items, !!i, 'none')}</div></details>`;

        detailEl.innerHTML = `
          <div class="space-y-3 max-w-[1100px] mx-auto" id="mc-page">
            ${head}
            <section class="card">
              <div class="grid grid-cols-1 md:grid-cols-2 gap-2">${sideCard(A, 0)}${sideCard(B, 1)}</div>
              ${rangePlot}
              <div class="text-[10px] uppercase tracking-wider text-gray-500 mb-1" style="margin-top:1rem">How sure is the difference</div>
              <div class="text-[13px] text-gray-300 space-y-1.5" id="mc-verdict">
                <p>${verdict}${thin ? ' ' + thin : ''}</p>
                ${same ? '' : `<p>${likeTxt}</p>`}
                <p class="text-[11px] text-gray-500">Strength is each row's whole record on the page's difficulty-weighted fit (its expected score on every task at the ability its results give it), not only the tasks the two share. Which row is ahead is read from the 95% range of the GAP between them (from the same bootstrap refits, where the shift both rows share when the suite's tasks change cancels): their own ranges can overlap while the gap is clear of 0, and a gap whose range includes 0 means the data cannot separate them, not that they are equal.</p>
              </div>
            </section>

            ${sh.n ? '' : `<section class="card"><h3 class="card-title">Like for like: nothing to compare</h3>
              <div class="card-sub">These two rows have no scored task in common, so there is no task-by-task comparison, no shared map and no like-for-like speed. What each has run is listed under “Not comparable” below.</div></section>`}
            <section class="card${sh.n ? '' : ' hidden'}">
              <div class="card-head"><div class="min-w-0"><h3 class="card-title">Like for like: the ${plural(sh.n, 'task')} both have scored${sh.thin ? ' — a thin overlap' : ''}</h3>
                <div class="card-sub">Solved, in task-equivalents (a task passed on 1 of 2 runs counts 0.5): ${tag(0)} <b class="text-gray-200">${n1(sh.creditA)}</b> of ${sh.n} · ${tag(1)} <b class="text-gray-200">${n1(sh.creditB)}</b> of ${sh.n}</div></div></div>
              ${thinBox}
              ${likeTiles}
              ${splitBar}
              <div class="grid grid-cols-1 md:grid-cols-2 gap-x-6" style="row-gap:1rem;margin-top:1rem">${aheadCol(0)}${aheadCol(1)}</div>
              <div class="text-[11px] text-gray-500 mt-3">Most difficult first, by the page's task difficulty. Each line shows both rows' result on that task: pass, fail, TIMEOUT, or “pass 1/3” when it passed on only some of its runs (×n = run n times).</div>
            </section>

            <section class="card${sh.n ? '' : ' hidden'}">
              <div class="card-head"><div class="min-w-0"><h3 class="card-title">The shared tasks, side by side</h3>
                <div class="card-sub">The Solve map for just these two rows, on the ${plural(sh.n, 'task')} both have scored — easiest on the left, hardest on the right. Colours as on the map; hover or tap a box for the task.</div></div></div>
              ${sh.n ? '<div class="w-full overflow-x-auto"><div id="mc-grid-box" style="min-width:720px;height:96px"><canvas id="mc-grid"></canvas></div></div>' : '<div class="text-[11.5px] text-gray-600">No shared task to draw.</div>'}
            </section>

            <section class="card">
              <div class="card-head"><div class="min-w-0"><h3 class="card-title">Strengths and weak spots</h3>
                <div class="card-sub">Where each row's wins sit — by difficulty, by task family, and on the composite tasks. Counts on the shared tasks only; every line below is one of the counts in the tables.${sh.n && sh.thin ? ` <span class="text-amber-300">Only ${plural(sh.n, 'task')} shared: “nothing sets it ahead” here means too little overlap to tell, not a tie.</span>` : ''}</div></div></div>
              <div class="grid grid-cols-1 md:grid-cols-2 gap-x-6" style="row-gap:1rem">${swCol(0)}${swCol(1)}</div>
              ${sh.bothFail ? `<div class="text-[11.5px] text-gray-400 mt-3">Neither passes ${plural(sh.bothFail, 'shared task')}${hardMiss}.</div>` : ''}
              ${subhead('by difficulty — the shared tasks in three equal slices, easiest to hardest')}${bandTable}
              ${subhead('by task family — the repo a task comes from')}${famTable}
              ${subhead('composite tasks — several fixes in one sitting')}${compTable}
            </section>

            <section class="card">
              <div class="card-head"><div class="min-w-0"><h3 class="card-title">Speed and cost</h3>
                <div class="card-sub">Like for like: only tasks both rows solved, the same tasks on both sides. Wall clock as run first; then, when a row's runs were not all at its fastest speed config, the same tasks estimated at it; then each row's fastest config's own rates.</div></div></div>
              ${subhead('as run — measured wall clock, every run')}
              ${warnBox}
              ${speedBody}
              ${estBody}
              ${rawRates}
              ${tokBody}
              ${tokRates}
              ${subhead('each row’s whole record, as the page’s charts show it — over its own tasks, not like for like')}
              <div class="overflow-x-auto"><table class="w-full text-xs"><thead><tr>${th('row', null, true)}${th('relative solve time', '1× = a typical config in the joint fit over every config and task; lower is faster')}${th('', null, true)}${th('output tokens / solve')}${th('', null, true)}</tr></thead><tbody>${wholeRow(0)}${wholeRow(1)}</tbody></table></div>
              <div class="text-[11px] text-gray-500 mt-2">Wall clock is the mean of a task's passing runs and depends on the machine and the launch settings as well as the model; a pooled row mixes its configs. Tokenizers differ across families by 20–40%, so token counts compare best within a family.</div>
            </section>

            <section class="card">
              <div class="card-head"><div class="min-w-0"><h3 class="card-title">Not comparable: tasks only one of them has scored</h3>
                <div class="card-sub">${tag(0)} has ${plural(cmp.gaps.onlyA.length, 'task')} ${TAG[1]} has not scored; ${tag(1)} has ${plural(cmp.gaps.onlyB.length, 'task')} ${TAG[0]} has not scored. None of these count above: a task one row never ran (or only has excluded runs of) says nothing about which is better.</div></div></div>
              <div class="space-y-2">${gapList(cmp.gaps.onlyA, 0)}${gapList(cmp.gaps.onlyB, 1)}</div>
            </section>
          </div>`;

        detailEl.querySelector('#mc-back').addEventListener('click', onBack);
        // the same comparison the other way round: in place of this entry, not a step on top of it
        detailEl.querySelector('#mc-swap').addEventListener('click', () => replaceCompare([idB, idA]));
        detailEl.querySelectorAll('[data-open-model]').forEach((b) => b.addEventListener('click', () => openModel(b.dataset.openModel)));
        detailEl.querySelectorAll('[data-open-task]').forEach((b) => b.addEventListener('click', () => openTask(b.dataset.openTask)));

        // the two-row map: the same painter as the Solve map, over the shared tasks only
        if (sh.n) {
            const rows = S.map((x, i) => ({ key: 'cmp:' + i, label: `${TAG[i]} · ${x.name}`, name: `${TAG[i]} · ${x.name}`,
                ...(ST[i] ? { strength: ST[i].s, lo: ST[i].lo, hi: ST[i].hi, coverage: ST[i].cov } : {}), tasks: x.tasks, ...(x.unfinished ? { unfinished: x.unfinished } : {}), _m: x.m }));
            taskGrid('mc-grid', rows, sh.ids, null, { order: sh.ids, publicSite: PUBLIC, onCell: (task, r, ev) => {
                const x = { id: task, a: taskOutcome(A.tasks[task]), b: taskOutcome(B.tasks[task]) };
                showPopover(ev ? ev.clientX : 200, ev ? ev.clientY : 200,
                    `<div class="text-xs font-semibold text-gray-100 font-mono break-all">${esc(task)}</div><div class="text-gray-500">${esc(diffText(task))} by difficulty${meta[task] && meta[task].repo ? ' · ' + esc(meta[task].repo) : ''}</div>`
                    + `<div class="mt-1.5">${who(0)}: ${oChip(x.a)}${answeredChip((A.tasks[task] || {}).answered)}${overflowChip((A.tasks[task] || {}).overflowed, (A.tasks[task] || {}).passes)}</div><div class="mt-1">${who(1)}: ${oChip(x.b)}${answeredChip((B.tasks[task] || {}).answered)}${overflowChip((B.tasks[task] || {}).overflowed, (B.tasks[task] || {}).passes)}</div>`,
                    { pin: true, actions: PUBLIC ? [] : [{ label: 'Task page →', onClick: () => openTask(task) }] });
            } });
        }
        if (PUBLIC) { const h = document.querySelector('.site-head'); try { window.scrollTo(0, Math.max(0, detailEl.getBoundingClientRect().top + window.scrollY - (h ? h.offsetHeight : 0) - 12)); } catch { /* no window scroll */ } }
        else view.scrollTop = 0;   // #models-view is the scroller; Compare is pressed far down the map
    }

    // ------------------------------------------------------------ compare page, three or more rows
    // Any number of Solve map rows side by side (2026-10-20, Kyle: "let's update compare mode to allow selecting an
    // arbitrary number of models"). Two rows keep their head-to-head page (drawCompare above); three or more get this one:
    // every row's strength on one axis, the like-for-like split over the tasks EVERY row scored, the N-row map of those
    // tasks, a pairwise table (each cell opens that pair's head-to-head page), speed and token rates, and what is not
    // comparable. The arithmetic is leaderboard.js compareMany; row i keeps its letter and colour (compareTag /
    // compareColor) everywhere on the page. Layouts are auto-fill grids and scrolling tables, so N rows fit a phone.
    function drawCompareMany(ids) {
        if (!CG) CG = buildChartGroups();
        overviewEl.classList.add('hidden');
        detailEl.classList.remove('hidden');
        dropPageCharts();
        shownTask = null; shownModel = null; shownCompare = ids.join('\n');
        const N = ids.length;
        const S = ids.map(compareSide);
        const TAG = ids.map((_, i) => compareTag(i));
        const tag = (i) => `<b style="color:${compareColor(i)}">${TAG[i]}</b>`;
        const plural = (n, one, many) => `${n} ${n === 1 ? one : (many || one + 's')}`;
        const head = `<div class="flex flex-wrap items-center gap-2">
              <button type="button" id="mc-back" class="btn btn-ghost btn-sm -ml-2">← Results</button>
              <div class="min-w-0"><div class="text-[17px] font-semibold text-white">Compare · ${N} rows</div>
                <div class="text-[11px] text-gray-500">Solve map rows side by side — from the results already on this page. Every pair also has its own head-to-head page: see “Pair by pair”.</div></div>
            </div>`;
        const wireBack = () => detailEl.querySelector('#mc-back').addEventListener('click', compareBack);
        const missing = S.map((x, i) => (x ? -1 : i)).filter((i) => i >= 0);
        if (missing.length) {
            const rest = ids.filter((_, i) => S[i]);
            detailEl.innerHTML = `<div class="space-y-3 max-w-[1100px] mx-auto">${head}
              <div class="text-xs text-red-200 bg-red-900/25 border border-red-800/50 rounded p-3">${missing.length === N ? 'None of these rows is' : `${plural(missing.length, 'of these rows is', 'of these rows are')}`} on the Solve map right now (a model with no scored run, or a config that the current “Config grouping” no longer keeps apart)${missing.length < N ? `: ${missing.map((i) => `<span class="font-mono break-all">${esc(ids[i])}</span>`).join(', ')}` : ''}.
                ${rest.length >= 2 ? `<div class="mt-2"><button type="button" id="mc-rest" class="btn btn-sm btn-primary">Compare the other ${rest.length}</button></div>` : ' Go back, tick the rows and compare again.'}</div></div>`;
            wireBack();
            const r = detailEl.querySelector('#mc-rest');
            if (r) r.addEventListener('click', () => replaceCompare(rest));
            view.scrollTop = 0;
            return;
        }
        const td = CG.adj.taskDifficulty || new Map();
        const meta = catalog.taskMeta || {};
        const familyOf = (t) => (meta[t] && meta[t].repo) || taskFamily(t);
        const cmp = compareMany(S, { difficulty: td, familyOf });
        const sh = cmp.shared;
        const nm = S.map((x) => esc(x.name));
        const who = (i) => `${tag(i)} <span class="text-gray-200">${nm[i]}</span>`;
        const n1 = (v) => (Math.round(v * 10) / 10).toLocaleString(undefined, { maximumFractionDigits: 1 });
        const pc = (v) => `${Math.round((v || 0) * 100)}%`;
        const ST = S.map((x) => (x.a ? { s: Math.round(x.a.rate * 100), lo: Math.round(x.a.lo * 100), hi: Math.round(x.a.hi * 100), cov: x.a.coverage || 0 } : null));
        const chipCls = 'inline-block px-1.5 py-0.5 rounded text-[10px] font-mono';
        const oChip = (o) => {
            if (!o) return `<span class="${chipCls} bg-gray-800 text-gray-500" title="this row has no run of the task">not run</span>`;
            if (o.kind === 'excluded') return `<span class="${chipCls} bg-gray-800 text-gray-400" title="run, but not a model answer: left out of every count">${esc(o.text)}</span>`;
            if (o.kind === 'partial') return `<span class="${chipCls} font-semibold bg-yellow-900/40 text-amber-300" title="passed ${o.passes} of ${o.attempts} scored runs">pass ${o.passes}/${o.attempts}</span>`;
            return statusChip(o.kind) + (o.attempts > 1 ? `<span class="text-[10px] font-mono text-gray-500" title="${o.passes} of ${o.attempts} scored runs passed"> ×${o.attempts}</span>` : '');
        };
        const taskName = (id) => (PUBLIC ? `<span class="font-mono text-[11.5px] text-gray-200 break-all">${esc(id)}</span>`
            : `<button type="button" data-open-task="${esc(id)}" class="font-mono text-[11.5px] text-indigo-300 hover:text-white text-left break-all" title="Open this task's page">${esc(id)}</button>`);
        const diffText = (id) => { const dr = difficultyRank(td, id); return dr ? dr.text : 'not placed by difficulty'; };
        // one task: its name, where it sits by difficulty, and every row's cell (they wrap at phone width)
        const itemRow = (x) => `<div class="flex flex-wrap items-center gap-x-2 gap-y-0.5 py-1 border-t border-gray-800/60">
                <span class="min-w-0">${taskName(x.id)} <span class="text-[10px] text-gray-500 whitespace-nowrap">${esc(diffText(x.id))}</span></span>
                <span class="ml-auto inline-flex flex-wrap items-center gap-1">${x.o.map((o, i) => `<span class="whitespace-nowrap">${tag(i)} ${oChip(o)}${answeredChip((S[i].tasks[x.id] || {}).answered)}${overflowChip((S[i].tasks[x.id] || {}).overflowed, (S[i].tasks[x.id] || {}).passes)}${o ? '' : unfinishedChip((S[i].unfinished || {})[x.id])}</span>`).join('<span class="text-gray-600 px-0.5">·</span>')}</span></div>`;
        const listOf = (items, empty) => (items.length ? items.map(itemRow).join('') : `<div class="text-[11px] text-gray-600 py-1.5 border-t border-gray-800/60">${empty}</div>`);
        const fold = (summary, items, empty) => `<details class="how" ${items.length && items.length <= 8 ? 'open' : ''}><summary><span>${summary} <span class="text-gray-500">· ${plural(items.length, 'task')}</span></span></summary>
              <div class="how-body">${listOf(items, empty)}</div></details>`;
        const subhead = (t) => `<div class="text-[10px] uppercase tracking-wider text-gray-500 mt-3" style="margin-bottom:0.15rem">${t}</div>`;
        const th = (t, title, left) => `<th class="px-2 py-1 ${left ? 'text-left' : 'text-right'} text-[10px] uppercase tracking-wider text-gray-500 font-semibold border-b border-gray-800 whitespace-nowrap" ${title ? `title="${esc(title)}"` : ''}>${t}</th>`;
        const td_ = (v, cls) => `<td class="px-2 py-1 text-right font-mono ${cls || 'text-gray-300'}">${v}</td>`;
        const tps = (v) => (v == null ? '—' : v >= 100 ? fmtN(Math.round(v)) : v.toFixed(1));
        const grid = (min) => `display:grid;grid-template-columns:repeat(auto-fill,minmax(${min},1fr));gap:0.5rem`;

        // ---- 1. the rows, and their strength on one axis
        const SPD = S.map((x) => { const groups = speedGroupsOf(x.timeOf); return { all: speedOf(x.tasks), shared: sh.n ? speedOf(x.tasks, sh.ids) : null, groups, fs: fastFor(x.timeOf) }; });
        const sideCard = (x, i) => {
            const c = cmp.sides[i], st = ST[i];
            return `<div class="tile" style="border-color:${compareColor(i)}">
                <div class="flex items-start gap-2"><span class="tag" style="background:${compareColor(i)};color:#fff">${TAG[i]}</span>
                  <div class="min-w-0" style="flex:1"><button type="button" data-open-model="${esc(x.m.key)}" class="text-[13.5px] font-semibold text-white hover:text-indigo-300 text-left break-words" title="Open this model's page">${esc(x.name)}</button>
                    <div class="text-[11px] text-gray-500">${esc(x.note)}</div></div>
                  <button type="button" data-mc-drop="${i}" class="btn btn-ghost btn-sm" style="padding:0 0.35rem" title="Compare without this row" aria-label="Compare without ${esc(x.name)}">✕</button></div>
                <div class="mt-2 flex flex-wrap items-baseline gap-x-2">
                  <span class="tile-value" style="font-size:24px">${st ? st.s : '—'}</span><span style="font-size:11px;font-weight:500;color:#747b8c">/100 strength</span>
                  <span class="text-[11.5px] text-gray-400 font-mono">${st ? `95% ${st.lo}–${st.hi}` : 'no strength estimate'}</span></div>
                <div class="flex flex-wrap gap-1.5 mt-2">
                  ${st ? `<span class="stat-chip" title="how many of the 100 difficulty points this row actually ran: the direct evidence its ability (and so its strength) is fitted from"><b>${pc(st.cov)}</b> tested</span>` : ''}
                  <span class="stat-chip" title="tasks with at least one scored run"><b>${fmtN(c.scored)}</b> tasks scored</span>
                  <span class="stat-chip" title="scored runs that passed (${n1(c.credit)} task-equivalents)"><b>${fmtN(c.runsPassed)}</b>/${fmtN(c.runs)} runs passed</span>
                </div></div>`;
        };
        const withA = S.map((x, i) => i).filter((i) => ST[i]);
        const rangeRow = (i) => { const a = S[i].a; return `<div class="flex items-center gap-2" style="height:18px"><span style="width:22px;text-align:center;font-size:11px">${tag(i)}</span>
              <div style="position:relative;flex:1;height:18px">
                <div style="position:absolute;left:0;right:0;top:8.5px;height:1px;background:rgba(255,255,255,0.08)"></div>
                ${a ? `<div style="position:absolute;left:${(a.lo * 100).toFixed(2)}%;width:${Math.max(0.6, (a.hi - a.lo) * 100).toFixed(2)}%;top:6px;height:6px;border-radius:3px;background:${compareColor(i)};opacity:0.5"></div>
                <div style="position:absolute;left:calc(${(a.rate * 100).toFixed(2)}% - 2.5px);top:2px;width:5px;height:14px;border-radius:2px;background:${compareColor(i)}" title="${esc(S[i].name)}: ${ST[i].s} (95% ${ST[i].lo}–${ST[i].hi})"></div>`
                    : '<div style="position:absolute;left:0;top:3px;font-size:10px;color:#747b8c">no strength estimate</div>'}
              </div></div>`; };
        const rangePlot = `<div class="mt-3" role="img" aria-label="The ${N} rows' 95% strength ranges on one 0 to 100 axis">
              ${S.map((_, i) => rangeRow(i)).join('')}
              <div class="flex justify-between text-[10px] text-gray-600 font-mono" style="margin-left:30px"><span>0</span><span>25</span><span>50</span><span>75</span><span>100</span></div></div>`;
        const ranked = withA.slice().sort((p, q) => ST[q].s - ST[p].s || p - q);
        const sep = [], close = [];
        // a pair is separated when the 95% range of its GAP is clear of 0 (strengthGap, 2026-10-25: the same bootstrap
        // refits, the drift both share cancelled); without a gap for the pair, when their own ranges do not overlap
        const gidOf = (x) => (x.pooled ? weightsOf(x.m) : x.id);
        let byGap = true;
        for (let p = 0; p < ranked.length; p++) for (let q = p + 1; q < ranked.length; q++) {
            const i = ranked[p], j = ranked[q], G = strengthGap(CG.fit, gidOf(S[i]), gidOf(S[j]));
            if (!G) byGap = false;
            (G ? !G.resolved : overlaps(S[i].a, S[j].a)) ? close.push([i, j]) : sep.push([i, j]);
        }
        const pairTxt = (list, word) => { const MAX = 12; return list.slice(0, MAX).map(([i, j]) => `${TAG[i]} ${word} ${TAG[j]}`).join(', ') + (list.length > MAX ? ` and ${list.length - MAX} more` : ''); };
        const noA = S.map((_, i) => i).filter((i) => !ST[i]);
        const verdict = (ranked.length ? `Ranked by strength: ${ranked.map((i) => `${tag(i)} ${ST[i].s}`).join(' · ')}. ` : '')
            + (ranked.length < 2 ? '' : !sep.length ? `<b class="text-white">${byGap ? 'No pair’s gap is clear of 0' : 'Every pair’s 95% ranges overlap'}</b>: on this evidence no row is shown to be stronger than another.`
                : `<b class="text-white">The data separates ${plural(sep.length, 'pair')}</b> (${byGap ? 'the 95% range of the gap clear of 0' : 'ranges that do not overlap'}): ${pairTxt(sep, 'above')}.${close.length ? ` Inside the uncertainty: ${pairTxt(close, 'and')}.` : ''}`)
            + (noA.length ? ` No strength estimate for ${noA.map((i) => tag(i)).join(', ')}.` : '');
        const thin = S.map((x, i) => (ST[i] && ST[i].cov < 0.25 ? `${TAG[i]} has run only ${pc(ST[i].cov)} of the difficulty points, so its strength rests on little direct evidence.` : '')).filter(Boolean).join(' ');

        // ---- 2. like for like: the tasks every row scored
        const SEGS = manySegments(sh, { tags: TAG, colors: TAG.map((_, i) => compareColor(i)) });
        const credits = TAG.map((_, i) => `${tag(i)} <b class="text-gray-200">${n1(sh.credit[i])}</b>`).join(' · ');
        const thinBox = sh.n && sh.thin ? `<div class="text-[12px] text-amber-200 bg-amber-900/20 border border-amber-800/40 rounded p-3 mb-3" data-thin-overlap="1">A thin overlap: only ${plural(sh.n, 'task')} ${sh.n === 1 ? 'is' : 'are'} scored by all ${N} rows, so the counts below rest on ${sh.n === 1 ? 'that one task' : `those ${sh.n}`} and say little about the rows. Pairs often share more: see “Pair by pair”, and each row's tasks outside this set under “Not comparable”.</div>` : '';
        const perRow = `<div class="overflow-x-auto mt-3"><table class="w-full text-xs"><thead><tr>${th('row', null, true)}${th('solved', 'task-equivalents on these tasks: a task passed on 1 of 2 runs counts 0.5')}${th('alone ahead', 'it had more credit than every other row')}${th('shared lead', 'tied for the most credit with some (not all) other rows')}${th('behind', 'another row had more credit')}</tr></thead><tbody>
              ${S.map((x, i) => `<tr class="border-t border-gray-800/60"><td class="px-2 py-1" style="min-width:10rem">${who(i)}</td>${td_(n1(sh.credit[i]), 'text-gray-100')}${td_(sh.perRow[i].alone || '·')}${td_(sh.perRow[i].sharedLead || '·')}${td_(sh.perRow[i].behind || '·')}</tr>`).join('')}</tbody></table></div>`;
        const leadLists = `<div class="space-y-2 mt-3">${S.map((x, i) => fold(`${who(i)} alone ahead`, sh.lists.lead[i], 'none')).join('')}
              ${sh.split ? fold('A shared lead (some rows, not all)', sh.lists.split, 'none') : ''}</div>`;
        const likeCard = !sh.n ? `<section class="card"><h3 class="card-title">Like for like: no task all ${N} rows have scored</h3>
              <div class="card-sub">There is no task every row has a scored run of, so there is no split across all ${N}. Pairs may still share tasks: see “Pair by pair” below, and each pair's own page.</div></section>`
            : `<section class="card">
              <div class="card-head"><div class="min-w-0"><h3 class="card-title">Like for like: the ${plural(sh.n, 'task')} all ${N} rows have scored${sh.thin ? ' — a thin overlap' : ''}</h3>
                <div class="card-sub">Solved, in task-equivalents (a task passed on 1 of 2 runs counts 0.5), of ${sh.n}: ${credits}</div></div></div>
              ${thinBox}
              ${segTiles(SEGS)}
              ${segBar(SEGS, sh.n)}
              ${perRow}
              ${leadLists}
              <div class="text-[11px] text-gray-500 mt-3">Each shared task is counted once: all pass, all miss, the same partial credit on every row, one row alone ahead (more credit than every other), or a lead shared by some rows. Most difficult first. ${sh.singleRun ? `${sh.singleRun === sh.n ? 'Every one' : `${sh.singleRun} of the ${sh.n}`} rest${sh.singleRun === 1 ? 's' : ''} on a single run on at least one row; a single run can go the other way on a repeat.` : ''}</div>
            </section>
            <section class="card">
              <div class="card-head"><div class="min-w-0"><h3 class="card-title">The shared tasks, side by side</h3>
                <div class="card-sub">The Solve map for just these ${N} rows, on the ${plural(sh.n, 'task')} all of them have scored — easiest on the left, hardest on the right. Hover or tap a box for the task.</div></div></div>
              <div class="w-full overflow-x-auto"><div id="mc-grid-box" style="min-width:720px;height:${Math.max(96, N * 22 + 52)}px"><canvas id="mc-grid"></canvas></div></div>
            </section>`;

        // ---- 3. pair by pair: each cell is that pair's head-to-head page
        const pairCell = (i, j) => {
            if (i === j) return '<td class="px-2 py-1 text-center text-gray-700">—</td>';
            const p = cmp.pairs[i][j];
            if (!p.n) return `<td class="px-2 py-1 text-center text-gray-600" title="${esc(`${TAG[i]} and ${TAG[j]} have no scored task in common`)}">·</td>`;
            const cls = p.ahead > p.behind ? 'text-white font-semibold' : p.ahead < p.behind ? 'text-gray-500' : 'text-gray-300';
            return `<td class="px-1 py-1 text-center"><button type="button" data-mc-pair="${i},${j}" class="font-mono ${cls} hover:text-indigo-300${p.thin ? ' opacity-70' : ''}" title="${esc(`${TAG[i]} ahead of ${TAG[j]} on ${p.ahead}, behind on ${p.behind}, of the ${p.n} tasks both scored${p.thin ? ' (a thin overlap)' : ''}. Open ${TAG[i]} against ${TAG[j]} head to head.`)}">${p.ahead}–${p.behind}<span class="text-gray-600 text-[10px]">/${p.n}${p.thin ? '*' : ''}</span></button></td>`;
        };
        const pairTable = `<div class="overflow-x-auto"><table class="text-xs" style="min-width:100%"><thead><tr>${th('row ahead–behind of column / shared', null, true)}${S.map((_, j) => `<th class="px-2 py-1 text-center border-b border-gray-800">${tag(j)}</th>`).join('')}</tr></thead><tbody>
              ${S.map((x, i) => `<tr class="border-t border-gray-800/60"><td class="px-2 py-1 whitespace-nowrap" style="max-width:16rem;overflow:hidden;text-overflow:ellipsis">${who(i)}</td>${S.map((_, j) => pairCell(i, j)).join('')}</tr>`).join('')}</tbody></table></div>`;

        // ---- 4. speed and cost
        const sp = cmp.speed;
        const spTable = !sp.n ? '<div class="text-[11.5px] text-gray-600">No task was solved by every row with a wall clock recorded on all of them, so there is no like-for-like speed to show.</div>'
            : `<div class="overflow-x-auto"><table class="w-full text-xs"><thead><tr>${th('row', null, true)}${th('median wall clock', `over the ${sp.n} tasks every row solved`)}${th('fastest on', 'tasks where this row alone had the shortest wall clock')}${th('median output tokens', sp.tok.n ? `over the ${sp.tok.n} tasks every row solved with a token count` : 'no token counts on every row')}</tr></thead><tbody>
              ${S.map((x, i) => `<tr class="border-t border-gray-800/60"><td class="px-2 py-1" style="min-width:10rem">${who(i)}</td>${td_(fmtDur(sp.med[i]), 'text-gray-100')}${td_(sp.fastest[i] || '·')}${td_(sp.tok.n ? fmtN(Math.round(sp.tok.med[i])) : '—')}</tr>`).join('')}</tbody></table></div>
              <div class="text-[11.5px] text-gray-400 mt-1">Over the ${plural(sp.n, 'task')} every row solved.${sp.n < LADDER_MIN_N ? ` <span class="text-amber-300">Only ${plural(sp.n, 'task')}: too few to read much into.</span>` : ''}</div>`;
        const basis = (s) => (!s ? 'a cloud model: no local server timing' : !s.runs ? `no request log for ${s.of === 1 ? 'its run' : `any of its ${s.of} runs`}` : `${s.runs === s.of ? plural(s.runs, 'run') : `${s.runs} of ${plural(s.of, 'run')}`} · ${fmtN(Math.round(s.req))} requests`);
        // each row at its FASTEST speed config (2026-10-22; as on the two-row page): which configs ran the paired tasks (A),
        // the paired summary re-priced at the fastest configs (B), and their own rates by depth (C)
        const fastOf = (i) => (SPD[i].fs ? SPD[i].fs.fastest : null);
        const fastName = (i) => (fastOf(i) ? speedLabel(fastOf(i).g, SPD[i].groups) : '');
        const share = S.map((x, i) => speedConfigShare(SPD[i].fs, sp.ids));
        const notAt = share.map((w) => w.n > 0 && w.atFastest < w.n);
        const est = compareMany(S.map((x, i) => ({ tasks: SPD[i].fs ? SPD[i].fs.tasks : x.tasks })), { difficulty: td, familyOf }).speed;
        const warnBox = !notAt.some(Boolean) ? '' : `<div class="text-[12px] text-amber-200 bg-amber-900/20 border border-amber-800/40 rounded p-3 mt-2" data-speed-not-fastest="1">
              <b>Not run at the fastest config.</b> The wall clocks above are as the runs went:
              <ul class="list-disc ml-4 mt-1 space-y-0.5">${S.map((x, i) => (!notAt[i] ? '' : `<li>${who(i)}: <b class="text-amber-100">${share[i].n - share[i].atFastest} of its ${plural(share[i].n, 'paired task')}</b> ran (all or partly) at speed configs other than its fastest (<span class="font-mono">${esc(fastName(i))}</span>): <span class="font-mono">${esc(share[i].others.slice(0, 3).map((o) => `${speedLabel(o.g, SPD[i].groups)} on ${o.tasks}`).join('; '))}${share[i].others.length > 3 ? `; ${share[i].others.length - 3} more configs` : ''}</span>.</li>`)).join('')}</ul></div>`;
        const estState = (i) => (!SPD[i].fs ? 'as run (no measured rate)' : est.ids.every((id) => (SPD[i].fs.tasks[id] || {}).how === 'measured') ? 'measured at its fastest config' : 'estimated at its fastest config');
        const estTable = !notAt.some(Boolean) ? '' : !est.n ? '<div class="text-[11.5px] text-gray-600 mt-2">No task every row solved could be re-priced (no request timings for those runs).</div>'
            : `${subhead('estimated at each row’s fastest speed config — tokens re-priced at its measured rates')}
              <div class="overflow-x-auto"><table class="w-full text-xs" data-speed-at-fastest="estimated"><thead><tr>${th('row', null, true)}${th('median wall clock est.', `over the ${est.n} tasks every row solved, each re-priced: wall clock less the server's logged time on its requests, plus its tokens at the fastest config's rates by depth`)}${th('fastest on', 'tasks where this row alone had the shortest estimated wall clock')}${th('', null, true)}</tr></thead><tbody>
              ${S.map((x, i) => `<tr class="border-t border-gray-800/60"><td class="px-2 py-1" style="min-width:10rem">${who(i)}</td>${td_(fmtDur(est.med[i]), 'text-gray-100')}${td_(est.fastest[i] || '·')}<td class="px-2 py-1 text-[11px] text-gray-500">${esc(estState(i))}${fastOf(i) ? `: ${esc(fastName(i))}` : ''}</td></tr>`).join('')}</tbody></table></div>
              <div class="text-[11.5px] text-gray-400 mt-1">An ESTIMATE over ${est.n === sp.n ? `the same ${plural(est.n, 'task')}` : `${est.n} of the ${sp.n} tasks (the rest ran only at configs with no measured rate)`}: tool and test time as measured, the model's part at the fastest config's rates by context depth.</div>`;
        const rawTable = `${subhead('raw rates at each row’s fastest speed config — tg / pp t/s by context depth')}
              <div class="overflow-x-auto"><table class="w-full text-xs" data-fastest-rates="1"><thead><tr>${th('row · fastest speed config', null, true)}${th('tg all')}${SPEED_BANDS.map((b) => th(`tg ${b.label}`, `generation, ${b.title}`)).join('')}${th('pp all')}${SPEED_BANDS.map((b) => th(`pp ${b.label}`, `prompt processing, ${b.title}`)).join('')}${th('requests', `all (${SPEED_BANDS.map((b) => b.label).join(' · ')})`)}</tr></thead><tbody>
              ${S.map((x, i) => { const f = fastOf(i); if (!f) return `<tr class="border-t border-gray-800/60"><td class="px-2 py-1" style="min-width:10rem">${who(i)}</td><td colspan="7" class="px-2 py-1 text-[11px] text-gray-500">${esc(basis(SPD[i].all))}</td></tr>`;
                    const c = (v, n) => td_(n != null && n < 1 ? '—' : tps(v), 'text-gray-200');
                    return `<tr class="border-t border-gray-800/60"><td class="px-2 py-1" style="min-width:10rem">${who(i)}<div class="text-[10.5px] text-gray-500 font-mono break-all">${esc(fastName(i))}${f.thin ? ' <span class="text-amber-300">(thin)</span>' : ''}</div></td>${c(f.sp.tg, f.sp.req)}${f.sp.bands.map((b) => c(b.tg, b.req)).join('')}${c(f.sp.pp, f.sp.req)}${f.sp.bands.map((b) => c(b.pp, b.req)).join('')}${td_(`${fmtN(Math.round(f.sp.req))} <span class="text-gray-600">(${f.sp.bands.map((b) => fmtN(Math.round(b.req))).join(' · ')})</span>`)}</tr>`; }).join('')}</tbody></table></div>`;
        const whole = S.map((x) => { const tg = fastestFor(x.timeOf), rt = tg ? CG.rel.get(tg.key) : null, q = qualityMetricsFor(x.tasks, null); return { rel: rt && rt.index != null ? rt : null, est: !!(tg && tg.estimated), tok: q.tokensPerSolve || null }; });
        const rateTable = `<div class="overflow-x-auto"><table class="w-full text-xs"><thead><tr>${th('row', null, true)}${th('tg t/s', 'generation, token-weighted over every run of the row (every speed config pooled)')}${th('pp t/s', 'prompt processing, token-weighted over every run of the row (every speed config pooled)')}${sh.n ? th('tg / pp on shared', `the same, on the ${sh.n} tasks all rows scored`) : ''}${th('relative solve time', '1× = a typical config in the joint fit; lower is faster (the row at its fastest speed config; est. = its tasks re-priced at that config)')}${th('output tokens / solve', 'mean over every task it solved')}${th('based on', null, true)}</tr></thead><tbody>
              ${S.map((x, i) => { const a = SPD[i].all, s2 = SPD[i].shared; return `<tr class="border-t border-gray-800/60"><td class="px-2 py-1" style="min-width:10rem">${who(i)}</td>${td_(a && a.runs ? tps(a.tg) : '—', 'text-gray-100')}${td_(a && a.runs ? tps(a.pp) : '—', 'text-gray-100')}${sh.n ? td_(s2 && s2.runs ? `${tps(s2.tg)} / ${tps(s2.pp)}` : '—') : ''}${td_(whole[i].rel ? `${whole[i].rel.index < 1 ? whole[i].rel.index.toFixed(2) : whole[i].rel.index.toFixed(1)}×${whole[i].est ? ' <span class="text-amber-300 text-[10px]">est.</span>' : ''}` : '—')}${td_(whole[i].tok ? fmtN(Math.round(whole[i].tok)) : '—')}<td class="px-2 py-1 text-[11px] text-gray-500 whitespace-nowrap">${esc(basis(a))}</td></tr>`; }).join('')}</tbody></table></div>
              <div class="text-[11px] text-gray-500 mt-2">Token rates here are token-weighted over every request the row's runs made, every speed config pooled (as run); the table above has each row's fastest config alone. Relative solve time and tokens per solve are each row's whole record, over its own tasks — not like for like. Each pair's page lists a pooled row's speed configs one by one.</div>`;

        // ---- 5. not comparable
        const outsideList = `<div class="space-y-2">${S.map((x, i) => fold(`${who(i)} has scored, and not every other row has`, cmp.outside[i], 'none')).join('')}</div>`;

        detailEl.innerHTML = `
          <div class="space-y-3 max-w-[1100px] mx-auto" id="mc-page" data-compare-rows="${N}">
            ${head}
            <section class="card">
              <div style="${grid('15rem')}">${S.map(sideCard).join('')}</div>
              ${rangePlot}
              <div class="text-[10px] uppercase tracking-wider text-gray-500 mb-1" style="margin-top:1rem">How sure are the differences</div>
              <div class="text-[13px] text-gray-300 space-y-1.5" id="mc-verdict">
                <p>${verdict}${thin ? ' ' + esc(thin) : ''}</p>
                <p class="text-[11px] text-gray-500">Strength is each row's whole record on the page's difficulty-weighted fit (its expected score on every task at the ability its results give it). Ranges that overlap mean the data cannot separate two rows; it does not mean they are equal.</p>
              </div>
            </section>
            ${likeCard}
            <section class="card">
              <div class="card-head"><div class="min-w-0"><h3 class="card-title">Pair by pair</h3>
                <div class="card-sub">Each cell: the row's lead over the column's row — tasks it was ahead on – tasks it was behind on / tasks both scored (each pair over its OWN shared tasks, usually more than all ${N} share). Tap a cell for that pair's head-to-head page. * a thin overlap.</div></div></div>
              ${pairTable}
            </section>
            <section class="card">
              <div class="card-head"><div class="min-w-0"><h3 class="card-title">Speed and cost</h3>
                <div class="card-sub">Like for like: only tasks every row solved, the same tasks for each.</div></div></div>
              ${subhead('as run — measured wall clock, every run')}
              ${spTable}
              ${warnBox}
              ${estTable}
              ${rawTable}
              ${subhead('token rates as run, and each row’s whole record')}
              ${rateTable}
            </section>
            <section class="card">
              <div class="card-head"><div class="min-w-0"><h3 class="card-title">Not comparable: tasks not every row has scored</h3>
                <div class="card-sub">None of these count in the like-for-like split above (a pair's own page counts the ones that pair shares).</div></div></div>
              ${outsideList}
            </section>
          </div>`;

        wireBack();
        detailEl.querySelectorAll('[data-mc-drop]').forEach((b) => b.addEventListener('click', () => { const k = Number(b.dataset.mcDrop); replaceCompare(ids.filter((_, i) => i !== k)); }));
        detailEl.querySelectorAll('[data-mc-pair]').forEach((b) => b.addEventListener('click', () => { const [i, j] = b.dataset.mcPair.split(',').map(Number); openCompare([ids[i], ids[j]]); }));
        detailEl.querySelectorAll('[data-open-model]').forEach((b) => b.addEventListener('click', () => openModel(b.dataset.openModel)));
        detailEl.querySelectorAll('[data-open-task]').forEach((b) => b.addEventListener('click', () => openTask(b.dataset.openTask)));
        if (sh.n) {
            const rows = S.map((x, i) => ({ key: 'cmp:' + i, label: `${TAG[i]} · ${x.name}`, name: `${TAG[i]} · ${x.name}`,
                ...(ST[i] ? { strength: ST[i].s, lo: ST[i].lo, hi: ST[i].hi, coverage: ST[i].cov } : {}), tasks: x.tasks, ...(x.unfinished ? { unfinished: x.unfinished } : {}), _m: x.m }));
            taskGrid('mc-grid', rows, sh.ids, null, { order: sh.ids, publicSite: PUBLIC, onCell: (task, r, ev) => {
                showPopover(ev ? ev.clientX : 200, ev ? ev.clientY : 200,
                    `<div class="text-xs font-semibold text-gray-100 font-mono break-all">${esc(task)}</div><div class="text-gray-500">${esc(diffText(task))} by difficulty${meta[task] && meta[task].repo ? ' · ' + esc(meta[task].repo) : ''}</div>`
                    + S.map((x, i) => `<div class="mt-1">${who(i)}: ${oChip(taskOutcome(x.tasks[task]))}${answeredChip((x.tasks[task] || {}).answered)}${overflowChip((x.tasks[task] || {}).overflowed, (x.tasks[task] || {}).passes)}</div>`).join(''),
                    { pin: true, actions: PUBLIC ? [] : [{ label: 'Task page →', onClick: () => openTask(task) }] });
            } });
        }
        if (PUBLIC) { const h = document.querySelector('.site-head'); try { window.scrollTo(0, Math.max(0, detailEl.getBoundingClientRect().top + window.scrollY - (h ? h.offsetHeight : 0) - 12)); } catch { /* no window scroll */ } }
        else view.scrollTop = 0;
    }

    if (!NAV) btn.addEventListener('click', () => { load(catalogStale()); });
    // The dashboard's route handler: what #results, #results/<key>[/<tab>], #results/task/<id> or #results/compare/<a>/<b> puts on show (#models... too: route.js). Coming to
    // the tab, or pressing its button again, draws the route fresh (every view loads the catalog when it opens, above);
    // within the tab a page already on show is left alone, and only its open tab is switched.
    function showRoute(r, info) {
        if (r.tab !== 'models') return;
        const fresh = !info.prev || info.prev.tab !== 'models' || info.again === 'tab';
        const paged = !detailEl.classList.contains('hidden');
        if (r.task) { if (fresh || !paged || shownTask !== r.task) openTask(r.task, true); return; }
        if (r.compare) { if (fresh || !paged || shownCompare !== r.compare.join('\n')) openCompare(r.compare, true); return; }
        if (r.model) {
            if (fresh || !paged || !shownModel || shownModel.key !== r.model) { detailCtx.view = r.view; openModel(r.model, true); }
            else if (shownModel.ctx.view !== r.view) shownModel.ctx.setView(r.view);
            return;
        }
        if (paged) { shownTask = null; shownModel = null; shownCompare = null; dropPageCharts(); showOverview(); }
        if (fresh) load(catalogStale());
    }
    window.addEventListener('models:open', (e) => { if (e.detail && e.detail.key) openModel(e.detail.key); });

    // This module loads after script.js, and over the tunnel that can take a moment. A click on
    // Results in that window was handled by script.js alone: it showed the (still empty) view, and
    // nothing asked for the data until a second click (Kyle, 2026-09-24). So on start: if the tab
    // is already showing, load now. And a refresh on #results or #results/<key> reopens it there
    // instead of dropping back to the Interactive tab.
    // Deferred a tick: init() runs while this module is still evaluating, before `api` exists.
    // #results/task/<id> is a task page; any other #results/<key> is a model (a key's own "/" is encoded).
    // #results/compare/<a>/<b> is a compare page (two ids, each one's own "/" encoded). Every one of them also as
    // #models/... (the tab's name until 2026-10-22): public links like /results#models/compare/a/b must keep working.
    const hashTask = (/^#(?:results|models)\/task\/(.+)$/.exec(location.hash) || [])[1];
    const hashCmp = hashTask ? null : /^#(?:results|models)\/compare\/([^/]+)\/([^/].*)$/.exec(location.hash);
    const hashKey = hashTask || hashCmp ? null : (/^#(?:results|models)\/(.+)$/.exec(location.hash) || [])[1];
    const unhash = (x) => { try { return decodeURIComponent(x); } catch { return x; } };
    const openHashCompare = () => {
        if (!catalog) return;
        // one id per segment (route.js parse): two or more rows
        const ids = [hashCmp[1], ...hashCmp[2].split('/')].filter((x) => x !== '').map(unhash);
        // Stamp the entry the link opened, so Back from a model page opened from here returns to this comparison
        // (cold: there is no overview entry of ours beneath it for "← All models" to step back to).
        try { history.replaceState({ tab: 'tab-models', compare: ids, cold: true }, ''); } catch { /* history is unavailable in some embedded views */ }
        openCompare(ids, true);
    };
    setTimeout(() => {
        if (NAV) { NAV.on(showRoute); return; }   // the router tells a late handler the route the page opened on
        // the public site shows this view from the start: a compare link is the one page it reopens from the hash
        if (!view.classList.contains('hidden')) { const p = load(false); if (hashCmp) p.then(openHashCompare); }
        else if (/^#(?:results|models)(\/|$)/.test(location.hash)) {
            btn.click();
            if (hashKey) load(false).then(() => openModel(decodeURIComponent(hashKey)));
            else if (hashTask) load(false).then(() => { if (catalog) openTask(decodeURIComponent(hashTask)); });
            else if (hashCmp) load(false).then(openHashCompare);
        }
    }, 0);

    // Back out of a model detail returns to the overview rather than leaving the dashboard.
    // Only the model half is handled here; script.js owns which TAB a history entry belongs to.
    if (!NAV) window.addEventListener('popstate', (e) => {
        const st = e.state || {};
        if (st.task) { if (detailEl.classList.contains('hidden') || shownTask !== st.task) openTask(st.task, true); return; }
        if (Array.isArray(st.compare)) { if (detailEl.classList.contains('hidden') || shownCompare !== st.compare.join('\n')) openCompare(st.compare, true); return; }
        if (st.model) { if (detailEl.classList.contains('hidden') || detailCtx.key !== st.model) openModel(st.model, true); return; }
        if (!detailEl.classList.contains('hidden')) { shownTask = null; shownModel = null; shownCompare = null; dropPageCharts(); showOverview(); }
    });
}

export { colorFor };
