// --- Globals & Utils ---
let abortController = null;
const escapeHtml = (unsafe) => unsafe.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Safe formatting helpers -- avoid NaN/Infinity leaking into % widths or "0%" masquerading as real data
function isNum(v) { return typeof v === 'number' && Number.isFinite(v); }
// A blank numeric field means "omit this flag, let llama-server use its own
// default" -- not "0" or whatever parseFloat/parseInt does with an empty
// string (NaN). Used by buildConfigFromUI() for every optional sampling
// param, so e.g. clearing Repeat Penalty actually drops --repeat-penalty
// instead of coercing to a value llama-server might reject outright (0 is
// invalid for it; 1.0, not 0, is its own "disabled" value).
function numFieldOrNull(id, parser) {
    const v = parser(document.getElementById(id).value);
    return isNum(v) ? v : null;
}
function fmtPct(value, decimals = 1) { return isNum(value) ? `${value.toFixed(decimals)}%` : '--%'; }
function fmtUnit(value, unit, decimals = 0) { return isNum(value) ? `${value.toFixed(decimals)}${unit}` : `--${unit}`; }
// Compute "avg (min–max)" from an array of {tps} samples. Returns just the
// average if there's only one sample (no meaningful range). Used for both
// prefill and gen t/s display on completed Monitor/History rows.
function fmtTpsWithRange(samples, avgTps) {
    if (!samples || samples.length === 0) return avgTps != null ? `${Number(avgTps).toFixed(1)}` : '--';
    const vals = samples.map(s => s.tps).filter(v => isNum(v) && v > 0);
    if (vals.length === 0) return avgTps != null ? `${Number(avgTps).toFixed(1)}` : '--';
    const avg = avgTps != null ? Number(avgTps).toFixed(1) : (vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(1);
    if (vals.length === 1) return avg;
    const lo = Math.min(...vals).toFixed(1);
    const hi = Math.max(...vals).toFixed(1);
    return `${avg} (${lo}–${hi})`;
}
// Build a red kwargs annotation for restored messages — used both in the
// reasoning area (in place of the trace when thinking is off) and in the
// raw view. Returns '' when there are no kwargs.
function buildKwargsAnnotation(kw) {
    if (!kw || Object.keys(kw).length === 0) return '';
    const parts = [];
    if (kw.enable_thinking === false) parts.push('<span style="color:#f87171;font-weight:bold">THINKING OFF</span>');
    else if (kw.enable_thinking === true) parts.push('<span style="color:#4ade80">thinking enabled</span>');
    for (const [k, v] of Object.entries(kw)) {
        if (k === 'enable_thinking') continue;
        parts.push(`<span style="color:#f87171">${escapeHtml(k)}: ${escapeHtml(JSON.stringify(v))}</span>`);
    }
    return parts.length ? `<div class="text-xs font-mono text-gray-400">${parts.join(' · ')}</div>` : '';
}
function safeRatioPct(numerator, denominator) {
    if (!isNum(numerator) || !isNum(denominator) || denominator <= 0) return 0;
    const pct = (numerator / denominator) * 100;
    return isNum(pct) ? Math.max(0, Math.min(pct, 100)) : 0;
}

// --- SSE log/error hooks (kept intentionally lightweight; the real
// user-facing error surface is the chat-box error bubble in the
// 'stopped' state handler below) ---
// Despite the name, this is console-only -- the actual visible error bubble
// renders in handleSseMessage's `state === 'stopped'` branch (chat-container
// red box), which requires the SSE message carrying the error to also carry
// state:'stopped'. If a server-side error path broadcasts them separately,
// the error is logged here but never shown on screen.
function displayErrorInUI(err) { console.error('[llama-server error]', err); }
function appendLogToUI(log) { console.debug('[llama-server log]', log); }

let tpsHistory = []; let netHistory = [];
let tpsChart = null; let netChart = null;
let lastNetBytes = 0;

// Base VRAM trackers
let isModelLoaded = false;
let masterBaseVram = 0;

// The master always launches natively now -- there's no other launch mode to
// choose (see server4.js resolveLaunchCommand). Kept as a constant (not a
// selector-driven variable) purely so config objects, the CSV, and saved
// profiles keep writing/reading the same 'launchMode' field they always have
// -- 'local-multi-gpu' is a historical value now, not a meaningful choice.
const currentLaunchMode = 'local-multi-gpu';
// Declared here (not down with the rest of the worker-logs-toggle state,
// see "Worker Docker Control & Polling Logic" below) because it
// can be referenced as early as page-load via restoreLastLaunchConfig()
// -- a `let` declared later in the file is in the temporal dead zone until its
// own declaration line executes, so referencing it that early throws a
// ReferenceError even though the reference is inside a function (only the
// function's *call* needs to happen after the declaration, and that call can
// happen before script evaluation reaches line 1250 or wherever it now lives).
let workerLogsInterval = null;

// Active Session Trackers for CSV
let sessionData = {};

// --- Chat History Tracking ---
let allChatSessions = [];
let currentSessionId = Date.now().toString();
let currentContextLimit = 110000; 
let currentContextTokens = 0;
// Token-weighted running averages: avg = total tokens / total seconds, so a
// 145k-token prefill dominates a 19-token one instead of counting equally.
let runningAverages = {
    prefillTokens: 0,
    prefillSeconds: 0,
    genTokens: 0,
    genSeconds: 0
};
// Delta-tracking for live running average updates during prefill.
// Each PREFILL_PROGRESS broadcast gives cumulative (nTokens so far,
// runningAvgTps since prefill start). The elapsed seconds for this
// batch of tokens = nTokens / runningAvgTps. To avoid double-counting,
// track the delta from the previous broadcast and only add that.
let lastPrefillBatchTokens = 0;
let lastGenBatchTokens = 0;

function updateAverageUI() {
    if (runningAverages.prefillSeconds > 0) {
        const avgPrefill = (runningAverages.prefillTokens / runningAverages.prefillSeconds).toFixed(1);
        document.getElementById('metric-prefill-avg').innerText = `${avgPrefill} t/s`;
    }
    if (runningAverages.genSeconds > 0) {
        const avgGen = (runningAverages.genTokens / runningAverages.genSeconds).toFixed(1);
        document.getElementById('metric-gen-avg').innerText = `${avgGen} t/s`;
    }
}

function resetRunningAverages() {
    runningAverages = {
        prefillTokens: 0,
        prefillSeconds: 0,
        genTokens: 0,
        genSeconds: 0
    };
    try {
        localStorage.removeItem('cluster_averages');
    } catch (e) {}
    document.getElementById('metric-prefill-avg').innerText = '0.0 t/s';
    document.getElementById('metric-gen-avg').innerText = '0.0 t/s';
}

// Item 4: Do NOT restore avg speed from localStorage on page load.
// Averages should start fresh each session to avoid stale cross-session data.
// (They are still saved during a session so refresh during a run doesn't lose them,
// but we clear the stored value on load so a cold start begins at 0.)
try {
    localStorage.removeItem('cluster_averages');
} catch (e) {}

function saveMetricsToAverages(prefillSpeed, genSpeed, prefillTokens, genTokens) {
    const pSpeed = parseFloat(prefillSpeed);
    const gSpeed = parseFloat(genSpeed);
    // Weight each request by its token count (seconds = tokens / tps). If the
    // token count is missing, fall back to a 1-second weight so the request
    // still registers instead of being dropped.
    if (!isNaN(pSpeed) && pSpeed > 0) {
        const pTok = parseFloat(prefillTokens);
        const tok = (!isNaN(pTok) && pTok > 0) ? pTok : pSpeed;
        runningAverages.prefillTokens += tok;
        runningAverages.prefillSeconds += tok / pSpeed;
    }
    if (!isNaN(gSpeed) && gSpeed > 0) {
        const gTok = parseFloat(genTokens);
        const tok = (!isNaN(gTok) && gTok > 0) ? gTok : gSpeed;
        runningAverages.genTokens += tok;
        runningAverages.genSeconds += tok / gSpeed;
    }
    try {
        localStorage.setItem('cluster_averages', JSON.stringify(runningAverages));
    } catch (e) {}
    updateAverageUI();
}

function updateContextUI(currentUsed, limit) {
    const limitVal = parseInt(limit) || 110000;
    document.getElementById('context-tokens-text').innerText = `${currentUsed.toLocaleString()} / ${limitVal.toLocaleString()}`;
    document.getElementById('context-limit-text').innerText = `Limit: ${limitVal.toLocaleString()}`;
    const pct = Math.min((currentUsed / limitVal) * 100, 100);
    document.getElementById('context-percent-text').innerText = `${pct.toFixed(1)}% used`;
    document.getElementById('context-bar').style.width = `${pct}%`;
}

// --- Init Charts ---
function createChart(ctxId, color) {
    const ctx = document.getElementById(ctxId).getContext('2d');
    return new Chart(ctx, {
        type: 'line',
        data: { labels: [], datasets: [{ data: [], borderColor: color, borderWidth: 1.5, fill: true, backgroundColor: color.replace('1)', '0.1)'), pointRadius: 0, tension: 0.2 }] },
        options: { responsive: true, maintainAspectRatio: false, animation: { duration: 0 }, scales: { x: { display: false }, y: { display: true, ticks: { color: '#6b7280', font: {size: 8} } } }, plugins: { legend: { display: false } } }
    });
}

function createDualAxisTpsChart(ctxId) {
    const ctx = document.getElementById(ctxId).getContext('2d');
    return new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                {
                    label: 'Prefill',
                    data: [],
                    borderColor: 'rgba(96, 165, 250, 1)',
                    borderWidth: 2,
                    fill: false,
                    pointRadius: 3,
                    showLine: false,
                    yAxisID: 'yPrefill'
                },
                {
                    label: 'Generation',
                    data: [],
                    borderColor: 'rgba(74, 222, 128, 1)',
                    borderWidth: 1.5,
                    fill: true,
                    backgroundColor: 'rgba(74, 222, 128, 0.1)',
                    pointRadius: 0,
                    tension: 0.2,
                    yAxisID: 'yGen'
                }
            ]
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: { duration: 0 },
            scales: {
                x: { display: false },
                yPrefill: {
                    type: 'linear',
                    position: 'left',
                    ticks: { color: '#60a5fa', font: { size: 8 } },
                    grid: { color: 'rgba(96, 165, 250, 0.05)' }
                },
                yGen: {
                    type: 'linear',
                    position: 'right',
                    ticks: { color: '#4ade80', font: { size: 8 } },
                    grid: { drawOnChartArea: false }
                }
            },
            plugins: {
                legend: { display: false }
            }
        }
    });
}

function createDualLineChart(ctxId) {
    const ctx = document.getElementById(ctxId).getContext('2d');
    return new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                { label: 'Master', data: [], borderColor: 'rgba(250, 204, 21, 1)', borderWidth: 1.5, fill: false, pointRadius: 0, tension: 0.2 },
                { label: 'Worker', data: [], borderColor: 'rgba(248, 113, 113, 1)', borderWidth: 1.5, fill: false, pointRadius: 0, tension: 0.2 }
            ]
        },
        options: { responsive: true, maintainAspectRatio: false, animation: { duration: 0 }, scales: { x: { display: false }, y: { display: true, ticks: { color: '#6b7280', font: {size: 8} } } }, plugins: { legend: { display: false } } }
    });
}

tpsChart = createDualAxisTpsChart('tpsChart');
netChart = createChart('netChart', 'rgba(96, 165, 250, 1)');
let tempChart = createDualLineChart('tempChart');
let pwrChart = createDualLineChart('pwrChart');
let cpuChart = createDualLineChart('cpuChart');
let gpuUtilChart = createDualLineChart('gpuUtilChart');
let cpuTempChart = createDualLineChart('cpuTempChart');

let tempHistory = []; let pwrHistory = []; let cpuHistory = [];
let gpuUtilHistory = []; let cpuTempHistory = [];
// These feed the expand view's scroll-back, so they deliberately keep far more
// than the sidebar's last-30 -- but "unbounded for the life of the page" at one
// sample/sec means ~43k entries per array over an overnight sweep. 20k is still
// ~5.5h of scroll-back at 1Hz, with the memory actually bounded.
const TELEMETRY_HISTORY_CAP = 20000;
function capTelemetryHistories() {
    for (const h of [tempHistory, pwrHistory, cpuHistory, gpuUtilHistory, cpuTempHistory]) {
        if (h.length > TELEMETRY_HISTORY_CAP) h.splice(0, h.length - TELEMETRY_HISTORY_CAP);
    }
    if (window.chartEvents && window.chartEvents.length > 500) {
        window.chartEvents.splice(0, window.chartEvents.length - 500);
    }
}
// Full histories for expand modals (net/tps are single-line charts)
let netHistoryFull = []; // {time, value}
let tpsHistoryFull = []; // {time, value}

// UI Listeners for Transport and Tensor Split
document.getElementById('transport-type').addEventListener('change', (e) => {
    const val = e.target.value;
    const sshInput = document.getElementById('worker-ssh');
    if (val === 'TB4') {
        sshInput.value = 'kyle4090@169.254.61.173';
    } else {
        sshInput.value = 'kyle4090@192.168.1.125';
    }
});

document.getElementById('server-tensor-split').addEventListener('input', (e) => {
    const masterPct = e.target.value;
    const workerPct = 100 - masterPct;
    document.getElementById('ts-val-display').innerText = `${masterPct}% / ${workerPct}%`;
    refreshCommandPreview();
});

// --- Advanced panel toggle ---
document.getElementById('btn-advanced-toggle').addEventListener('click', () => {
    const panel = document.getElementById('advanced-panel');
    const icon = document.getElementById('advanced-icon');
    const isHidden = panel.classList.toggle('hidden');
    icon.innerHTML = isHidden ? '&#9654;' : '&#9660;';
});
// Speculative decoding: any combination of strategy checkboxes; the shared
// options row (draft n-max/n-min, draft model) only shows when at least one
// strategy is selected.
function getCheckedSpecTypes() {
    return [...document.querySelectorAll('.spec-type-cb:checked')].map(cb => cb.value);
}
// Strategies that take the shared ngram size-n/size-m/min-hits knobs (each via
// its own namespaced flags; ngram-mod/ngram-cache have different or no knobs).
const NGRAM_MAP_STRATEGIES = ['ngram-simple', 'ngram-map-k', 'ngram-map-k4v'];
document.querySelectorAll('.spec-type-cb').forEach(cb => cb.addEventListener('change', () => {
    const checked = getCheckedSpecTypes();
    document.getElementById('spec-options').classList.toggle('hidden', checked.length === 0);
    document.getElementById('spec-ngram-options').classList.toggle('hidden',
        !checked.some(t => NGRAM_MAP_STRATEGIES.includes(t)));
    refreshCommandPreview();
}));

// --- Fetch Local Models ---
async function fetchModels() {
    try {
        const res = await fetch('/api/models');
        const models = await res.json();
        const select = document.getElementById('model-select');
        select.innerHTML = '';
        // Sorted by name: the API returns local-dir models then HF-cache ones,
        // in readdir order, which is effectively arbitrary and made a specific
        // quant hard to pick out of a long list. numeric:true so Q3/Q6/Q8 and
        // 3.6/3.8 sort naturally rather than lexically.
        models.sort((a, b) => String(a.name).localeCompare(String(b.name), undefined, { numeric: true, sensitivity: 'base' }));
        models.forEach(m => {
            const opt = document.createElement('option'); 
            // IMPORTANT: value is the full host path (not just filename) so the
            // server can correctly resolve models that live outside the local
            // /models mount (e.g. the Hugging Face cache dir).
            opt.value = m.path; opt.textContent = `${m.name} (${m.size} GB)${m.source === 'huggingface' ? ' [HF cache]' : ''}`; 
            select.appendChild(opt); 
        });
    } catch (e) {}
}
// Exposed so applyConfigToUI() can await it before touching #model-select's
// value -- see that function for why (a bare fetchModels() call here isn't
// enough since callers of applyConfigToUI can run before this resolves).
const modelsLoadedPromise = fetchModels();

// Local-multi-gpu mode's "Build" selector -- which compiled llama-server
// binary to launch (configured server-side in dashboard.config.json). Same
// early-population race as fetchModels() above, same fix (expose the promise,
// await it before applyConfigToUI() touches #build-select's value).
async function fetchBuilds() {
    try {
        const res = await fetch('/api/builds');
        const data = await res.json();
        const select = document.getElementById('build-select');
        select.innerHTML = '';
        (data.builds || []).forEach(b => {
            const opt = document.createElement('option');
            opt.value = b.id; opt.textContent = b.label || b.id;
            opt.title = b.path || '';
            select.appendChild(opt);
        });
    } catch (e) {}
}
const buildsLoadedPromise = fetchBuilds();
// Switching builds can change which devices are reachable for the same
// physical GPUs (see detectDevices()'s own comment), so re-detect
// automatically rather than leaving a stale list from the previous build.
document.getElementById('build-select').addEventListener('change', detectDevices);
// Auto-detect devices as soon as the Build selector is populated, rather than
// requiring a manual "Detect Devices" click -- hotplugging a GPU isn't
// supported by the kernel, so the device list is static for the life of the
// boot and there's nothing to gain by making the user ask for it. Exposed as
// a promise for the same reason buildsLoadedPromise/modelsLoadedPromise are:
// applyConfigToUI() needs the dropdown options to exist before it can restore
// a saved deviceA/deviceB selection into them.
const devicesDetectedPromise = buildsLoadedPromise.then(detectDevices);

// --- Auto-snap to last-used config for this model + transport ---
// Triggered only by model-select and rpc-toggle changes -- the two
// "which setup am I in" selections the user actually asked for ("whenever I
// select a model, or when I turn RPC on/off"). Deliberately NOT wired to
// finer controls (device pickers, tensor split): those don't change the
// model+transport lookup key (transport is 'Local' whenever RPC is off,
// regardless of which specific local GPUs are chosen), so re-snapping there
// would just re-fetch the same historical config and silently revert
// whatever device pairing the user just picked.
let isApplyingHistoricalSnap = false;
// Bumped by both this function and refreshCommandPreview() on every tracked
// field change. snapToLastUsedConfig's fetch is a real network+file-read round
// trip -- if the user edits something else (e.g. drags the tensor-split
// slider) while it's in flight, applying the historical config once it
// resolves would silently clobber that fresher edit. Capturing the generation
// before the await and checking it's still current after is a standard
// stale-response guard for exactly this race (confirmed live: without this,
// a tensor-split drag right after a model-select change got overwritten back
// to the old historical -ts value once the snap's fetch finally resolved).
let configOperationGeneration = 0;
async function snapToLastUsedConfig() {
    if (isApplyingHistoricalSnap) return; // reentrancy guard -- applyConfigToUI's own
    // change-event dispatches (model-select, tensor-split) would otherwise re-trigger this
    const myGeneration = ++configOperationGeneration;
    try {
        const modelPath = document.getElementById('model-select').value;
        const modelBasename = modelPath ? modelPath.split('/').pop() : '';
        if (!modelBasename) return;
        const rpcEnabled = document.getElementById('rpc-toggle').checked;
        const transport = rpcEnabled ? document.getElementById('transport-type').value : 'Local';
        const params = new URLSearchParams({ model: modelBasename, transport: transport || '' });
        const res = await fetch(`/api/logs/summary?${params.toString()}`);
        const data = await res.json();
        if (myGeneration !== configOperationGeneration) return; // something newer happened while this was in flight
        if (data && data.lastConfig) {
            isApplyingHistoricalSnap = true;
            try {
                await applyConfigToUI(data.lastConfig);
            } finally {
                isApplyingHistoricalSnap = false;
            }
        }
    } catch (e) {
        // Best-effort -- leave current fields alone on any failure.
    }
}

// --- Item 15c: Load historical stats summary from server ---
// Filtered by the currently-selected model + connection mode ("the card(s),
// and if RPC, wifi vs TB4") -- a single global average across every model
// you've ever tried is close to meaningless once you've tried more than one.
async function loadHistoricalStats() {
    const el = document.getElementById('historical-stats');
    try {
        const modelPath = document.getElementById('model-select').value;
        const modelBasename = modelPath ? modelPath.split('/').pop() : '';
        // Never fall through to an unfiltered query -- if we can't tell what
        // model is actually selected (e.g. the dropdown hasn't finished
        // populating yet), showing the *global* blended/last-row stats with
        // no indication they're unfiltered looked exactly like "stats for the
        // wrong model" (in practice, whatever was logged most recently
        // server-side, regardless of what's selected here).
        if (!modelBasename) { el.classList.add('hidden'); el.innerHTML = ''; return; }
        const rpcEnabled = document.getElementById('rpc-toggle').checked;
        const transport = rpcEnabled ? document.getElementById('transport-type').value : 'Local';
        const params = new URLSearchParams({ model: modelBasename });
        if (transport) params.set('transport', transport);

        const res = await fetch(`/api/logs/summary?${params.toString()}`);
        const data = await res.json();
        if (!data || data.count === 0) {
            if (data && data.filtered) {
                el.innerHTML = `<div class="text-gray-600 italic">No history yet for this model/connection.</div>`;
                el.classList.remove('hidden');
            } else {
                el.classList.add('hidden');
                el.innerHTML = '';
            }
            return;
        }
        // Headline numbers are the LAST run's own actual values, not an average
        // across history -- "what happened last time", not a blend of every run.
        const lastLoad = data.lastLoadTime != null ? `${data.lastLoadTime}s` : 'N/A';
        const lastGen = data.lastGenTps != null ? `${data.lastGenTps} t/s` : 'N/A';
        const lastPrompt = data.lastPromptTps != null ? `${data.lastPromptTps} t/s` : 'N/A';
        const lastWhen = data.lastTimestamp ? new Date(data.lastTimestamp).toLocaleString() : 'N/A';
        el.innerHTML = `
            <div>Runs: <span class="text-gray-300">${data.count}</span> | Last: <span class="text-gray-300">${lastWhen}</span></div>
            <div>Load: <span class="text-gray-300">${lastLoad}</span> | Prefill: <span class="text-gray-300">${lastPrompt}</span> | Gen: <span class="text-gray-300">${lastGen}</span></div>
        `;
        el.classList.remove('hidden');
    } catch {
        el.classList.add('hidden');
    }
}
loadHistoricalStats();

// --- Server SSE State ---
let eventSource = null;
let lastSseAt = Date.now();
function connectSSE() {
    if (eventSource) { try { eventSource.close(); } catch (e) {} }
    eventSource = new EventSource('/api/status');
    eventSource.onmessage = handleSseMessage;
}
// Watchdog: EventSource usually auto-reconnects, but a silently-dead stream
// means Monitor stops adding rows with no visible symptom. The /api/status
// handler pushes a state broadcast on connect, so a forced reconnect always
// produces a message and resets the clock.
setInterval(() => {
    if (document.visibilityState === 'visible' && Date.now() - lastSseAt > 45000) {
        connectSSE();
    }
}, 15000);
window.addEventListener('beforeunload', () => eventSource.close());

// --- GLOBAL TRACKERS (Must be outside the handler) ---
let currentLoadTime = "N/A";
let uiTimerInterval = null;

function setHardwareConfigLocked(locked) {
    const hwc = document.getElementById('hardware-config-section');
    hwc.querySelectorAll('select, input, button').forEach(el => el.disabled = locked);
    hwc.classList.toggle('opacity-50', locked);
    hwc.classList.toggle('pointer-events-none', locked);
}

// --- THE SSE HANDLER ---
let lastLaunchCommand = '';
// Tracks the config that actually booted the currently-running server (as
// opposed to buildConfigFromUI(), which reflects *current* GUI state and can
// drift from it -- the GUI is locked while running, but this is the
// authoritative source). Always kept current (not one-shot like
// populateLaunchConfig), since it's what gets written to the CSV's
// config_json column per completed prompt -- see the /api/log call site.
let lastKnownLaunchConfig = null;
function handleSseMessage(e) {
    const data = JSON.parse(e.data);
    lastSseAt = Date.now();
    lastKnownServerState = data.state || lastKnownServerState;
    if (data.model) lastKnownModelName = data.model;
    if (data.launchCommand) lastLaunchCommand = data.launchCommand;
    if (data.launchConfig) lastKnownLaunchConfig = data.launchConfig;
    if (data.launchConfig) populateLaunchConfig(data.launchConfig);
    const badge = document.getElementById('engine-status');
    const input = document.getElementById('user-prompt');
    const btn = document.getElementById('submit-btn');
    const timerDiv = document.getElementById('boot-timer');

    // 0. ERRORS & LOGS (run first; never throws, so state handling below always runs)
    if (data.error) {
        // 'LAUNCH CMD:' is an informational banner that rides the error channel
        // -- it must not overwrite the real failure reason the sweep reports.
        if (!data.error.startsWith('LAUNCH CMD:')) lastKnownServerError = data.error;
        displayErrorInUI(data.error);
    } else if (data.log) {
        appendLogToUI(data.log);
        if (data.log.startsWith('PREFILL_PROGRESS:')) {
            // Format from server: PREFILL_PROGRESS:<progress 0-1>:<tps>:<nTokens>
            const parts = data.log.split(':');
            const progress = parseFloat(parts[1]);
            const tps = parseFloat(parts[2]);
            const nTokens = parseInt(parts[3]);
            handlePrefillProgress(progress, tps, nTokens);
        }
        else if (data.log.startsWith('GEN_PROGRESS:')) {
            // Format from server: GEN_PROGRESS:<avgTps>:<instTps>:<nDecoded>
            // avgTps = overall average since gen started (for live Monitor row)
            // instTps = last-3s window, i.e. current speed (for sidebar card)
            const parts = data.log.split(':');
            const avgTps = parseFloat(parts[1]);
            const instTps = parseFloat(parts[2]);
            const nDecoded = parseInt(parts[3]);
            handleGenProgress(avgTps, instTps, nDecoded);
        }
        else if (data.log.startsWith('COMPLETION:')) {
            // Server-side, client-agnostic completion capture (Monitor Mode) --
            // fires for EVERY finished request regardless of which client sent
            // it, not just this dashboard's own chat. See logCompletedRequest()
            // in server4.js.
            try {
                const payload = JSON.parse(data.log.slice('COMPLETION:'.length));
                console.log(`[sse] COMPLETION received: runId=${payload.runId} genTps=${payload.genTps} abCaptureResolve armed = ${!!abCaptureResolve}`);
                handleMonitorCompletion(payload);
                // Avg Speed used to only update from this dashboard's own chat
                // stream-reading code (submitPrompt), so it silently stayed at
                // 0.0 for any request that came from elsewhere (opencode, Cline,
                // curl, ...) even though Live Speed updated fine (that's driven
                // by the separate, already-client-agnostic PREFILL_PROGRESS/
                // GEN_PROGRESS broadcasts). This event fires for every completed
                // request regardless of origin with real server-computed tps, so
                // it's the one place that can drive Avg Speed correctly for all
                // of them -- submitPrompt's own calls were removed in favor of
                // this single source.
                saveMetricsToAverages(payload.promptTps, payload.genTps, payload.promptTokens, payload.genTokens);
            } catch (e) { /* malformed payload -- ignore this one, not worth breaking the SSE handler over */ }
        }
        else if (data.log.startsWith('CTX_LIVE:')) {
            // Real context usage straight from llama-server's /slots endpoint --
            // works for requests from ANY client, unlike the old chat-side-only
            // token estimate.
            const parts = data.log.split(':');
            const used = parseInt(parts[1]), limit = parseInt(parts[2]);
            if (!isNaN(used) && !isNaN(limit) && limit > 0) updateContextUI(used, limit);
        }
        else if (data.log.startsWith('BENCH_DONE:')) {
            stopBenchProgress();
            setBenchRunningUI(false);
            if (benchCurrentRunLabel) {
                setBenchRowStatus(benchCurrentRunLabel, data.log === 'BENCH_DONE:0' ? 'done' : 'failed');
            }
            benchCurrentRunLabel = null;
            renderBenchCustomRows();
        }
        else if (data.log.startsWith('BENCH:')) {
            appendBenchLine(data.log.slice('BENCH:'.length));
        }
    }

    // 1. Handle live ticking timer + boot overlay animation
    const bootOverlay = document.getElementById('boot-overlay');
    const bootTimerDisplay = document.getElementById('boot-timer-display');
    const bootStatusText = document.getElementById('boot-status-text');
    const bootProgressFill = document.getElementById('boot-progress-fill');

    if (data.loadStartTime > 0 && !uiTimerInterval) {
        // A new model launch means a new config -- carrying the previous
        // config's requests in the running averages makes the number an
        // uninterpretable blend of two setups (e.g. pre- and post-ngram
        // speculation), so each launch starts its averages fresh.
        resetRunningAverages();
        timerDiv.classList.remove('hidden');
        // Show boot overlay in chat area
        bootOverlayWanted = true;
        syncBootOverlay();
        // Hide empty state while booting
        const emptyStateEl = document.getElementById('empty-state');
        if (emptyStateEl) emptyStateEl.classList.add('hidden');

        uiTimerInterval = setInterval(() => {
            const elapsed = ((Date.now() - data.loadStartTime) / 1000).toFixed(1);
            timerDiv.innerText = `Booting: ${elapsed}s...`;
            bootTimerDisplay.innerText = `${elapsed}s`;
            // Estimate progress from historical load times for this model.
            // Falls back to a slow time-based animation if no history exists.
            const modelKey = (data.model || 'unknown').split('/').pop();
            const hist = JSON.parse(localStorage.getItem('loadTimes') || '{}');
            const times = hist[modelKey] || [];
            const avg = times.length > 0 ? times.reduce((a, b) => a + b, 0) / times.length : null;
            let pct;
            if (avg) {
                // Historical estimate: elapsed / average, with a 95% cap
                pct = Math.min((parseFloat(elapsed) / avg) * 100, 95);
            } else {
                // No history: slow time-based animation (60s to 95%)
                pct = Math.min((parseFloat(elapsed) / 60) * 100, 95);
            }
            bootProgressFill.style.width = `${pct}%`;
        }, 100);
    }

    // 2. Handle State Changes
    if (data.state === 'stopped') {
        clearInterval(uiTimerInterval); uiTimerInterval = null;
        // Hide boot overlay when engine is stopped
        bootOverlayWanted = false;
        syncBootOverlay();
        bootProgressFill.style.width = '0%';
        timerDiv.classList.add('hidden');
        // Restore empty state
        const emptyStateEl = document.getElementById('empty-state');
        if (emptyStateEl && document.getElementById('chat-container').querySelector('.msg-wrapper') === null) {
            emptyStateEl.classList.remove('hidden');
        }
        badge.className = 'flex items-center gap-2 px-3 py-2 rounded-lg bg-red-900/20 border border-red-800 text-red-400 text-xs font-semibold';
        badge.innerHTML = '<span class="h-2 w-2 rounded-full bg-red-500"></span> ENGINE STOPPED';
        document.getElementById('btn-start-server').classList.remove('hidden'); 
        document.getElementById('btn-stop-server').classList.add('hidden');
        input.disabled = true; btn.disabled = true; attachBtn.disabled = true; isModelLoaded = false;

        // Restore hardware config controls (previously these could get stuck
        // disabled forever because this reset lived in an unreachable
        // duplicate 'stopped' branch further down)
        setHardwareConfigLocked(false);

        if (data.error) {
            const chatBox = document.getElementById('chat-container');
            if (document.getElementById('empty-state')) document.getElementById('empty-state').classList.add('hidden');
            // insertAdjacentHTML, not innerHTML += (see submitPrompt's note) --
            // an error bubble must not re-parse the chat box and destroy
            // existing messages' omni-chart canvases.
            chatBox.insertAdjacentHTML('beforeend', `<div class="msg-wrapper p-4 rounded-xl border border-red-900/50 bg-red-900/10 max-w-4xl mx-auto shadow-sm w-full mb-4 text-red-400 text-sm font-semibold">${escapeHtml(data.error)}</div>`);
            chatBox.scrollTop = chatBox.scrollHeight;
            // Item 8c: Highlight log panels red on crash
            const mlc = document.getElementById('master-logs-container');
            if (mlc) {
                mlc.className = 'bg-red-950/30 rounded-lg border-2 border-red-600 overflow-hidden';
            }
            const wlc = document.getElementById('worker-logs-container');
            if (wlc) {
                wlc.className = 'bg-red-950/20 rounded-lg border border-red-800/50 overflow-hidden';
            }
        } else {
            // Reset log panels to normal when no error
            const mlc = document.getElementById('master-logs-container');
            if (mlc) {
                mlc.className = 'bg-gray-800/50 rounded-lg border border-gray-700/50 overflow-hidden';
            }
            const wlc = document.getElementById('worker-logs-container');
            if (wlc) {
                wlc.className = 'bg-gray-800/50 rounded-lg border border-gray-700/50 overflow-hidden';
            }
        }
        
        // Reset Telemetry
        document.getElementById('metric-prefill').innerText = '0.0 t/s';
        document.getElementById('metric-prefill-tokens').innerText = '0 tokens';
        document.getElementById('metric-gen').innerText = '0.0 t/s';
        document.getElementById('metric-gen-tokens').innerText = '0 tokens';
        document.getElementById('current-tps').innerText = '0.0';
        document.getElementById('status-indicator').innerText = 'Generating...';
        // Reset running averages when engine is stopped (model change boundary)
        resetRunningAverages();
        // Item 15c: Refresh historical stats after each run
        loadHistoricalStats();
    
    } else if (data.state === 'starting' || data.state === 'loading' || data.state === 'stopping') {
        setHardwareConfigLocked(true);

        // Item 4: Reset avg speed at boot time so each new run starts fresh
        resetRunningAverages();

        badge.className = 'flex items-center gap-2 px-3 py-2 rounded-lg bg-yellow-900/20 border border-yellow-800 text-yellow-400 text-xs font-semibold';
        badge.innerHTML = data.state === 'stopping'
            ? `<span class="h-2 w-2 rounded-full bg-yellow-500 animate-pulse"></span> STOPPING...`
            : `<span class="h-2 w-2 rounded-full bg-yellow-500 animate-pulse"></span> ${data.state === 'loading' ? 'LOADING MODEL' : 'BOOTING...'}`;
        // Keep "Load Model" visible-but-grayed (via setHardwareConfigLocked's
        // disabled+opacity above) instead of hiding it outright -- it used to
        // vanish during boot/stop and only reappear once fully 'stopped',
        // which read as a missing button rather than a busy one.
        document.getElementById('btn-start-server').classList.remove('hidden');
        document.getElementById('btn-stop-server').classList.remove('hidden');


    // } else if (!isModelLoaded) { 
    // note: this part fixed by kyle.
    } else if (data.state === 'ready') {
        isModelLoaded = true;
        // Capture real load time from server (fixes Item 15a: was always "N/A")
        if (data.finalLoadTime) currentLoadTime = data.finalLoadTime;
        // Record load time per model for future progress bar estimation
        if (data.finalLoadTime && data.model) {
            const modelKey = data.model.split('/').pop();
            try {
                const hist = JSON.parse(localStorage.getItem('loadTimes') || '{}');
                if (!hist[modelKey]) hist[modelKey] = [];
                hist[modelKey].push(parseFloat(data.finalLoadTime));
                // Keep last 10 loads per model
                if (hist[modelKey].length > 10) hist[modelKey] = hist[modelKey].slice(-10);
                localStorage.setItem('loadTimes', JSON.stringify(hist));
            } catch (e) {}
        }
        setTimeout(() => { masterBaseVram = currentVramSnapshot; }, 2000);

        // Bug: a client that connects (or refreshes) while the server is
        // ALREADY 'ready' jumps straight into this branch, skipping the
        // 'starting'/'loading' branch above entirely -- which is the only
        // place that showed the Kill button and locked the hardware config.
        // Without this, a fresh connect to an already-running server left the
        // Kill button permanently hidden and the config panel unlocked, even
        // though a model was actively running.
        document.getElementById('btn-start-server').classList.add('hidden');
        document.getElementById('btn-stop-server').classList.remove('hidden');
        setHardwareConfigLocked(true);

        // to test:
        // remove 'disabled' from the #user-prompt and the #submit-btn
        document.querySelector('#user-prompt').disabled = false;
        document.querySelector('#submit-btn').disabled = false;
        attachBtn.disabled = false;


        // Identify and remove existing Tailwind classes that might clash
        const clashingClasses = Array.from(badge.classList).filter(cls => 
            cls.startsWith('bg-') || 
            cls.startsWith('text-') || 
            cls.startsWith('border-')

            && !cls.includes('green')
            // this 'green' exclusion isn't working, so this runs over and over again. not a significant bug, but annoying.
        );
        
        if (clashingClasses.length > 0) {
            badge.classList.remove(...clashingClasses);
        }

        // Apply new green theme classes
        // bg-green-100: background
        // text-green-800: text color
        // border-green-600: trim/border color
        // border: enables the border
        badge.classList.add(
            'bg-green-100',
            'text-green-800',
            'border',
            'border-green-600'
        );

        // BUG FIX: Hide boot overlay when model is fully loaded
        if (uiTimerInterval) { clearInterval(uiTimerInterval); uiTimerInterval = null; }
        bootProgressFill.style.width = '100%';
        
        bootStatusText.innerText = 'Model Loaded!';
        // todo: the badge outline and background and text colors are still red
        badge.innerHTML = `<span class="h-2 w-2 rounded-full bg-green-500 animate-pulse"></span> ${data.state === 'ready' ? 'RUNNING' : 'BOOTING...'}`;
        setTimeout(() => {
            bootOverlayWanted = false;
            syncBootOverlay();
            // Restore empty state if chat is empty
            const emptyStateEl = document.getElementById('empty-state');
            if (emptyStateEl) emptyStateEl.classList.remove('hidden');
        }, 600);
    }
}
connectSSE();

// --- Item #22: Persist last launch config to localStorage ---
const LAST_LAUNCH_CONFIG_KEY = 'last_launch_config';
// Prefill for the mmproj path field on a config that's never set one --
// this rig's known-working multimodal projector (found the hard way: HF
// snapshot caching put it in a different snapshot dir than the model
// weights it's paired with by default).
const DEFAULT_MMPROJ_PATH = '/home/kyle/.cache/huggingface/hub/models--unsloth--Qwen3.8-27B-GGUF/snapshots/27af057ecb382ddfea5d12837360a8980560e3ed/mmproj-F16.gguf';

function saveLastLaunchConfig(config) {
    try { localStorage.setItem(LAST_LAUNCH_CONFIG_KEY, JSON.stringify(config)); } catch(e) {}
}

// Shared by both config-restore paths (Item #22): the synchronous localStorage
// fallback below, and the SSE-driven populateLaunchConfig() (which restores
// from the server's own authoritative in-memory config -- more reliable since
// it reflects what's *actually running*, not just what this browser last sent).
async function applyConfigToUI(config) {
    // Restore model selection -- wait for fetchModels() to have actually
    // populated the <option> elements first. Without this, setting .value
    // on a <select> with no matching <option> yet (fetchModels() is async and
    // may still be in flight) silently no-ops and leaves the default model
    // selected, which is what was happening here before this await was added.
    await modelsLoadedPromise;
    const modelSelect = document.getElementById('model-select');
    if (config.modelPath && modelSelect) {
        modelSelect.value = config.modelPath;
        modelSelect.dispatchEvent(new Event('change'));
    }

    // Restore build selection -- same "wait for options to exist first" reasoning
    // as the model select above. Falls back to whatever's already selected
    // (fetchBuilds()'s default) if the saved build id no longer exists among the
    // currently-configured builds.
    await buildsLoadedPromise;
    const buildSelect = document.getElementById('build-select');
    // devicesDetectedPromise's detection already ran by this point, against
    // whatever build fetchBuilds() defaulted to (its first option) -- if the
    // saved config restores a DIFFERENT build here, that detection was for
    // the wrong binary (confirmed live: restoring "Vulkan + CUDA" over a
    // default "Vulkan Only" left the device dropdowns showing only the
    // Vulkan-only device list, missing CUDA0 entirely). Track that so device
    // restoration below can re-detect instead of trusting the stale result.
    let buildChanged = false;
    if (config.build != null && buildSelect && [...buildSelect.options].some(o => o.value === config.build)) {
        buildChanged = buildSelect.value !== config.build;
        buildSelect.value = config.build;
    }

    // Restore numeric fields
    if (config.ctx != null) document.getElementById('server-ctx').value = config.ctx;
    if (config.ngl != null) document.getElementById('server-ngl').value = config.ngl;

    // Restore toggles
    const rpcChecked = !!config.rpcTarget;
    document.getElementById('rpc-toggle').checked = rpcChecked;
    if (config.rpcTarget) document.getElementById('worker-ssh').value = config.rpcTarget;
    if (config.transport) document.getElementById('transport-type').value = config.transport;
    // Syncs worker-ssh-controls' enabled/disabled state and GPU B's forced-None
    // state to whatever rpc-toggle was just set to -- setting .checked directly
    // (as opposed to a real click) doesn't fire a 'change' event, so this
    // wouldn't otherwise run for a restored config with RPC enabled.
    applyRpcToggleUI();
    if (config.fa != null) document.getElementById('server-fa').checked = config.fa;
    if (config.reasoningPreserve != null) document.getElementById('reasoning-preserve-toggle').checked = config.reasoningPreserve;

    // Restore text fields
    if (config.cacheK != null) document.getElementById('server-cache-k').value = config.cacheK;
    if (config.cacheV != null) document.getElementById('server-cache-v').value = config.cacheV;
    if (config.tensorSplit != null) document.getElementById('server-tensor-split').value = config.tensorSplit;
    document.getElementById('server-tensor-split').dispatchEvent(new Event('input'));

    // Restore device selection (manual fields always; dropdowns only if
    // detection already populated matching options) -- await the auto-detect
    // triggered on load so this isn't racing it, unless restoring the build
    // above just invalidated that detection (see buildChanged), in which
    // case re-run it for the build actually being restored instead of
    // trusting the stale result. Skip GPU B when RPC is enabled
    // (applyRpcToggleUI already forced it to "None" above) -- an old saved
    // profile from before RPC and local split were mutually exclusive could
    // otherwise reintroduce a stale deviceB value here.
    if (buildChanged) await detectDevices(); else await devicesDetectedPromise;
    if (config.deviceA != null) {
        document.getElementById('device-manual-a').value = config.deviceA;
        const selA = document.getElementById('device-select-a');
        if ([...selA.options].some(o => o.value === config.deviceA)) selA.value = config.deviceA;
    }
    if (config.deviceB != null && !rpcChecked) {
        document.getElementById('device-manual-b').value = config.deviceB;
        const selB = document.getElementById('device-select-b');
        if ([...selB.options].some(o => o.value === config.deviceB)) selB.value = config.deviceB;
    }

    // Restore speculative decoding settings -- specType is a comma-separated
    // list of strategies (old configs stored a single value, which parses as a
    // one-item list here and restores as one checked box).
    const specTypes = (config.specType || '').split(',').map(s => s.trim()).filter(Boolean);
    document.querySelectorAll('.spec-type-cb').forEach(cb => { cb.checked = specTypes.includes(cb.value); });
    document.getElementById('spec-options').classList.toggle('hidden', specTypes.length === 0);
    if (config.specDraftNMax != null) document.getElementById('mtp-draft-n').value = config.specDraftNMax;
    document.getElementById('spec-draft-n-min').value = config.specDraftNMin ?? '';
    document.getElementById('spec-draft-model').value = config.specDraftModel || '';
    document.getElementById('spec-ngram-options').classList.toggle('hidden',
        !specTypes.some(t => NGRAM_MAP_STRATEGIES.includes(t)));
    document.getElementById('spec-ngram-size-n').value = config.specNgramSizeN ?? '';
    document.getElementById('spec-ngram-size-m').value = config.specNgramSizeM ?? '';
    document.getElementById('spec-ngram-min-hits').value = config.specNgramMinHits ?? '';

    // Restore sampling params -- ?? '' (not a hardcoded numeric default) so a
    // field the user deliberately left blank (buildConfigFromUI's
    // numFieldOrNull -> null, meaning "omit this flag, let llama-server use
    // its own default") comes back blank too, rather than silently
    // reappearing with the dashboard's own pre-filled value on next load.
    document.getElementById('server-temp').value = config.temp ?? '';
    document.getElementById('server-top-k').value = config.topK ?? '';
    document.getElementById('server-top-p').value = config.topP ?? '';
    document.getElementById('server-min-p').value = config.minP ?? '';
    document.getElementById('server-presence-penalty').value = config.presencePenalty ?? '';
    document.getElementById('server-repeat-penalty').value = config.repeatPenalty ?? '';

    // Restore MoE CPU offload (optional -- blank omits the flag entirely)
    document.getElementById('server-n-cpu-moe').value = config.nCpuMoe ?? '';

    // Restore jinja + chat template file
    document.getElementById('jinja-toggle').checked = !!config.jinja;
    document.getElementById('server-chat-template-file').value = config.chatTemplateFile || '';

    // Restore multimodal (mmproj). `?? DEFAULT_MMPROJ_PATH` (not `||`) so a
    // config that never had this field (older saved profile) prefills the
    // known-good path, but a field the user explicitly cleared to '' stays
    // cleared.
    document.getElementById('mmproj-toggle').checked = !!config.mmprojEnabled;
    document.getElementById('server-mmproj-path').value = config.mmprojPath ?? DEFAULT_MMPROJ_PATH;

    // Restore load mode
    document.getElementById('server-load-mode').value = config.loadMode || '';

    // Restore verbosity -- floor of 3 (info). Below that, llama-server itself
    // suppresses the log lines this dashboard's status detection and telemetry
    // capture parse (see the field's own tooltip), so a config saved before
    // that floor existed (the old default was 0) gets clamped up rather than
    // silently breaking the dashboard on restore.
    const verbosityRestore = Number(config.verbosity);
    document.getElementById('server-verbosity').value = (Number.isFinite(verbosityRestore) && verbosityRestore >= 3) ? verbosityRestore : 3;

    // Restore extra args
    document.getElementById('extra-args').value = config.argString || '';

    // The launch command box is read-only and always regenerated from the
    // fields just restored above (including extra-args) -- it's no longer
    // possible to hand-edit it directly, so there's nothing else to restore
    // here. See the box's own comment for why (a stored literal rawCommand
    // used to get shown here instead, which could hold flags -- e.g. a custom
    // jinja chat template -- that lived nowhere else and silently vanished
    // the moment anything regenerated the box, such as snapToLastUsedConfig
    // firing off this same function's model-select change-event dispatch).
    refreshCommandPreview();

    // Re-render saved configs for the restored model
    renderSavedConfigs();
}

function restoreLastLaunchConfig() {
    try {
        const saved = localStorage.getItem(LAST_LAUNCH_CONFIG_KEY);
        if (!saved) return;
        // applyConfigToUI is async -- a synchronous try/catch around a bare call
        // to it would NOT catch anything it throws (async functions convert
        // throws into promise rejections, not synchronous exceptions), so this
        // needs its own .catch() rather than relying on the try/catch below.
        applyConfigToUI(JSON.parse(saved)).catch(e => console.warn('Failed to restore last launch config:', e));
    } catch(e) {
        console.warn('Failed to restore last launch config:', e);
    }
}

// Item #22 (SSE path): a freshly-connected/refreshed client gets the server's
// authoritative current launch config (if a server is actually running) over
// the /api/status SSE stream (see server4.js broadcastState's `launchConfig`
// field) and uses it to populate the UI -- more reliable than the localStorage
// fallback above since it reflects this specific browser's own last launch,
// which may be stale or belong to a different session entirely. One-shot: only
// applied once per page load, so it never clobbers in-progress user edits.
let hasAppliedServerConfig = false;
function populateLaunchConfig(config) {
    if (hasAppliedServerConfig || !config) return;
    hasAppliedServerConfig = true;
    try {
        // Same async/.catch() note as restoreLastLaunchConfig() above.
        applyConfigToUI(config).catch(e => console.warn('Failed to populate launch config from server:', e));
    } catch (e) {
        console.warn('Failed to populate launch config from server:', e);
    }
}

// Builds the structured config object from the current GUI field values.
// Shared by the Boot Cluster click handler and refreshCommandPreview() --
// used to seed the raw-command box's content, NOT as the thing actually sent
// to run the server (see the rawCommand branch in server4.js /api/start).
function buildConfigFromUI() {
    const specTypes = getCheckedSpecTypes();
    const specEnabled = specTypes.length > 0;
    // Dropdown value wins if detection populated it and it's still selected,
    // otherwise fall back to whatever's in the manual text field. GPU B is
    // forced to "None" whenever RPC is enabled (see applyRpcToggleUI), so
    // reading it here needs no separate RPC gate.
    const deviceA = document.getElementById('device-select-a').value || document.getElementById('device-manual-a').value.trim() || null;
    const deviceB = document.getElementById('device-select-b').value || document.getElementById('device-manual-b').value.trim() || null;
    const rpcEnabled = document.getElementById('rpc-toggle').checked;
    return {
        modelPath: document.getElementById('model-select').value, // full host path, not just filename
        build: document.getElementById('build-select').value || null,
        ctx: parseInt(document.getElementById('server-ctx').value),
        ngl: parseInt(document.getElementById('server-ngl').value),
        launchMode: currentLaunchMode, // historical field, kept for CSV/profile back-compat -- always 'local-multi-gpu' now
        rpcTarget: rpcEnabled ? document.getElementById('worker-ssh').value.trim() : null,
        transport: rpcEnabled ? document.getElementById('transport-type').value : null,
        deviceA, deviceB,
        fa: document.getElementById('server-fa').checked,
        cacheK: document.getElementById('server-cache-k').value,
        cacheV: document.getElementById('server-cache-v').value,
        tensorSplit: (deviceB || rpcEnabled) ? parseInt(document.getElementById('server-tensor-split').value) : null,
        specType: specEnabled ? specTypes.join(',') : null,
        specDraftNMax: specEnabled ? parseInt(document.getElementById('mtp-draft-n').value || '2') : null,
        specDraftNMin: specEnabled ? numFieldOrNull('spec-draft-n-min', parseInt) : null,
        specDraftModel: specEnabled ? (document.getElementById('spec-draft-model').value.trim() || null) : null,
        specNgramSizeN: specEnabled ? numFieldOrNull('spec-ngram-size-n', parseInt) : null,
        specNgramSizeM: specEnabled ? numFieldOrNull('spec-ngram-size-m', parseInt) : null,
        specNgramMinHits: specEnabled ? numFieldOrNull('spec-ngram-min-hits', parseInt) : null,
        reasoningPreserve: document.getElementById('reasoning-preserve-toggle').checked,
        temp: numFieldOrNull('server-temp', parseFloat),
        topK: numFieldOrNull('server-top-k', parseInt),
        topP: numFieldOrNull('server-top-p', parseFloat),
        minP: numFieldOrNull('server-min-p', parseFloat),
        presencePenalty: numFieldOrNull('server-presence-penalty', parseFloat),
        repeatPenalty: numFieldOrNull('server-repeat-penalty', parseFloat),
        nCpuMoe: numFieldOrNull('server-n-cpu-moe', parseInt),
        jinja: document.getElementById('jinja-toggle').checked,
        chatTemplateFile: document.getElementById('server-chat-template-file').value.trim() || null,
        mmprojEnabled: document.getElementById('mmproj-toggle').checked,
        mmprojPath: document.getElementById('server-mmproj-path').value.trim() || null,
        loadMode: document.getElementById('server-load-mode').value || null,
        verbosity: numFieldOrNull('server-verbosity', parseInt),
        argString: document.getElementById('extra-args').value.trim() || null
    };
}

// --- Flag Reference (searchable popover, click-to-insert) ---
// Keyed by build id -- different builds (e.g. Vulkan-only vs Vulkan+CUDA) can
// expose different flags, so a cache hit for one build must not be served for
// another.
let flagReferenceCacheByBuild = new Map();
let flagReferenceCache = null; // the currently-active build's cache, for renderFlagReference()
async function openFlagReference() {
    const modal = document.getElementById('flag-reference-modal');
    const statusEl = document.getElementById('flag-reference-status');
    modal.classList.remove('hidden');
    modal.classList.add('flex');
    document.getElementById('flag-reference-search').focus();
    const buildId = document.getElementById('build-select').value || '';
    if (flagReferenceCacheByBuild.has(buildId)) {
        flagReferenceCache = flagReferenceCacheByBuild.get(buildId);
        statusEl.textContent = '';
    } else {
        statusEl.textContent = 'Loading...';
        try {
            const res = await fetch('/api/flags?build=' + encodeURIComponent(buildId));
            const data = await res.json();
            flagReferenceCache = data.flags || [];
            flagReferenceCacheByBuild.set(buildId, flagReferenceCache);
            statusEl.textContent = data.error ? `Failed to load: ${data.error}` : '';
        } catch (e) {
            statusEl.textContent = `Failed to load: ${e.message}`;
            flagReferenceCache = [];
        }
    }
    renderFlagReference('');
}

function insertFlagIntoCommand(insertText) {
    // Inserts into Extra llama-server args, not the (read-only) launch command
    // box -- that box is always regenerated from the structured fields plus
    // this one, so it's the only place a manually-picked flag can actually
    // persist across a profile load / model-select snap / page refresh.
    const box = document.getElementById('extra-args');
    const start = box.selectionStart ?? box.value.length;
    const end = box.selectionEnd ?? box.value.length;
    const before = box.value.slice(0, start);
    const after = box.value.slice(end);
    // Separate from adjacent text with a space unless we're at a boundary that
    // already has one (start of box, or already-whitespace neighbor).
    const needsLeadingSpace = before.length > 0 && !/\s$/.test(before);
    const insert = (needsLeadingSpace ? ' ' : '') + insertText;
    box.value = before + insert + after;
    const cursor = (before + insert).length;
    box.focus();
    box.setSelectionRange(cursor, cursor);
    document.getElementById('flag-reference-modal').classList.add('hidden');
    document.getElementById('flag-reference-modal').classList.remove('flex');
    refreshCommandPreview();
}

function renderFlagReference(query) {
    const list = document.getElementById('flag-reference-list');
    const q = query.trim().toLowerCase();
    const entries = !q ? flagReferenceCache : flagReferenceCache.filter(e =>
        e.flags.toLowerCase().includes(q) || e.description.toLowerCase().includes(q));
    list.innerHTML = '';
    if (!entries || entries.length === 0) {
        list.innerHTML = '<div class="text-gray-600 italic text-sm">No matching flags.</div>';
        return;
    }
    let currentSection = null;
    for (const e of entries) {
        if (!q && e.section !== currentSection) {
            currentSection = e.section;
            const header = document.createElement('div');
            header.className = 'text-[10px] uppercase tracking-wider text-gray-500 font-semibold pt-2 first:pt-0';
            header.textContent = currentSection;
            list.appendChild(header);
        }
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'w-full text-left px-2 py-1.5 rounded hover:bg-gray-800 border border-transparent hover:border-gray-700 transition-colors';
        row.innerHTML = `<div class="font-mono text-xs text-indigo-300">${escapeHtml(e.flags)}</div><div class="text-[11px] text-gray-500 mt-0.5">${escapeHtml(e.description)}</div>`;
        row.addEventListener('click', () => insertFlagIntoCommand(e.insertText));
        list.appendChild(row);
    }
}

document.getElementById('btn-flag-reference').addEventListener('click', openFlagReference);
document.getElementById('btn-flag-reference-close').addEventListener('click', () => {
    document.getElementById('flag-reference-modal').classList.add('hidden');
    document.getElementById('flag-reference-modal').classList.remove('flex');
});
document.getElementById('flag-reference-search').addEventListener('input', (e) => renderFlagReference(e.target.value));

// --- Raw launch command box: a read-only, always-regenerated preview of what
// will actually be spawned (see server4.js /api/start's rawCommand branch --
// it still sends this box's literal text, so what you see here is exactly
// what runs). GUI fields regenerate it via /api/preview-command on any change;
// the box itself can't be hand-edited, so anything not exposed by a GUI field
// (a custom flag, a jinja chat-template path, ...) belongs in Extra
// llama-server args instead, which IS a real persisted field.
let rawCommandRefreshTimer = null;
function refreshCommandPreview() {
    // Runs synchronously (not inside the debounce below) so the tensor-split
    // slider/labels react immediately to a device or RPC change instead of
    // waiting on the network round-trip's debounce.
    updateTensorSplitVisibility();
    // Invalidate any in-flight snapToLastUsedConfig() -- see that function's
    // comment on configOperationGeneration for why (this is the "user edited
    // something else" signal it checks for before applying a late result).
    configOperationGeneration++;
    clearTimeout(rawCommandRefreshTimer);
    rawCommandRefreshTimer = setTimeout(async () => {
        // Piggyback the historical-stats lookup on the same debounce -- it's
        // driven by the same model/connection-mode fields.
        loadHistoricalStats();
        const box = document.getElementById('raw-launch-command');
        // Don't clobber an in-progress hand-edit -- if the user is focused in
        // the box, a GUI field change (however that happened) shouldn't yank
        // their cursor/selection out from under them.
        if (document.activeElement === box) return;
        const statusEl = document.getElementById('raw-command-status');
        try {
            const res = await fetch('/api/preview-command', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(buildConfigFromUI())
            });
            const data = await res.json();
            if (data.command) {
                box.value = data.command;
                statusEl.textContent = '';
            } else {
                statusEl.textContent = data.error || 'preview failed';
            }
        } catch (e) {
            statusEl.textContent = 'preview failed (' + e.message + ')';
        }
    }, 300);
}

document.getElementById('btn-start-server').addEventListener('click', () => {
    const config = buildConfigFromUI();
    // The raw command box is what actually runs -- see server4.js /api/start.
    config.rawCommand = document.getElementById('raw-launch-command').value.trim();
    // Save config for page refresh restoration (Item #22)
    saveLastLaunchConfig(config);
    fetch('/api/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config) });
});

// Any GUI field that feeds buildConfigFromUI() regenerates the command preview.
['model-select', 'server-ctx', 'server-ngl', 'worker-ssh', 'server-fa',
 'server-cache-k', 'server-cache-v', 'mtp-draft-n', 'spec-draft-n-min',
 'spec-draft-model', 'spec-ngram-size-n', 'spec-ngram-size-m',
 'spec-ngram-min-hits', 'reasoning-preserve-toggle',
 'server-verbosity', 'extra-args', 'device-select-a', 'device-select-b',
 'device-manual-a', 'device-manual-b',
 'server-temp', 'server-top-k', 'server-top-p', 'server-min-p',
 'server-presence-penalty', 'server-repeat-penalty', 'server-n-cpu-moe',
 'jinja-toggle', 'server-chat-template-file', 'mmproj-toggle', 'server-mmproj-path', 'server-load-mode'
].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', refreshCommandPreview);
});

// Model selection additionally snaps the whole setup to the last config used
// with this model (see snapToLastUsedConfig's comment for why this is scoped
// to model-select/rpc-toggle only, not every field above).
document.getElementById('model-select').addEventListener('change', snapToLastUsedConfig);

// Restore last launch config on page load (Item #22)
restoreLastLaunchConfig();
// Also regenerate the preview once models have loaded, in case restore found
// nothing saved and the box would otherwise stay empty until the user touches
// a field.
modelsLoadedPromise.then(refreshCommandPreview);
// Populate the profile dropdown unconditionally -- applyConfigToUI() (called
// via restoreLastLaunchConfig above) also does this, but only runs at all if
// there's something saved to restore; without this, a fresh browser with
// saved profiles but no last-launch-config would show an empty dropdown.
renderSavedConfigs();

// --- Launch Profiles (localStorage) ---
// Saves the ENTIRE launch setup (model, launch mode, devices, every field,
// the raw command) as a named profile -- not just the extra-args box, which
// is what the old per-model "arg_configs" version did (and which required a
// non-empty extra-args box to save anything at all, so saving a plain
// model+ctx+mode setup with no extra flags was simply impossible). Profiles
// are global (not nested per-model) since the model choice is itself part of
// what a profile restores.
const LAUNCH_PROFILES_KEY = 'launch_profiles';
function getLaunchProfiles() {
    try { return JSON.parse(localStorage.getItem(LAUNCH_PROFILES_KEY) || '[]'); } catch { return []; }
}
function saveLaunchProfiles(profiles) { localStorage.setItem(LAUNCH_PROFILES_KEY, JSON.stringify(profiles)); }

// Name of the profile most recently loaded (or saved) THIS session -- Save
// Profile defaults to overwriting it, since "tweak a setting, re-save the
// profile I'm working with" is the common loop. With no profile touched yet
// this session, the default is a fresh name derived from the model instead.
let sessionActiveProfileName = null;

function saveCurrentConfig() {
    const modelLabel = document.getElementById('model-select').selectedOptions[0]?.textContent.replace(/\s*\(.*/, '') || 'profile';
    const defaultName = sessionActiveProfileName || modelLabel;
    const promptMsg = sessionActiveProfileName
        ? `Profile name (Enter overwrites "${sessionActiveProfileName}", or type a new name):`
        : 'Profile name:';
    const name = prompt(promptMsg, defaultName);
    if (!name) return;
    sessionActiveProfileName = name;
    const config = buildConfigFromUI();
    config.rawCommand = document.getElementById('raw-launch-command').value.trim();
    const profiles = getLaunchProfiles();
    const existingIdx = profiles.findIndex(p => p.name === name);
    const entry = { name, config, savedAt: Date.now() };
    if (existingIdx >= 0) profiles[existingIdx] = entry; else profiles.push(entry);
    saveLaunchProfiles(profiles);
    renderSavedConfigs();
    document.getElementById('load-profile-select').value = name;
}

function loadLaunchProfile(name) {
    const profiles = getLaunchProfiles();
    const entry = profiles.find(p => p.name === name);
    if (!entry) return;
    // Track separately from savedAt -- the dropdown sorts by most-recently-USED,
    // not most-recently-saved (a profile you saved once ages ago but load every
    // day should stay near the top, not sink below one you tweaked-and-saved
    // yesterday but haven't actually used since).
    entry.lastLoadedAt = Date.now();
    sessionActiveProfileName = name;
    saveLaunchProfiles(profiles);
    // Reuse snapToLastUsedConfig's reentrancy guard: applyConfigToUI sets
    // model-select's value and dispatches a 'change' event on it (to drive
    // downstream listeners), which is the SAME event snapToLastUsedConfig is
    // wired to. Without this guard, that dispatch fires a competing snap
    // fetch that resolves shortly after and overwrites the profile just
    // loaded with "last used config for this model" instead -- looked like
    // the profile's settings flashing in and then vanishing a moment later.
    isApplyingHistoricalSnap = true;
    applyConfigToUI(entry.config)
        .catch(e => console.warn('Failed to load profile:', e))
        .finally(() => { isApplyingHistoricalSnap = false; });
    renderSavedConfigs();
    document.getElementById('load-profile-select').value = name;
}

// Parse a llama-server arg string into the structured config fields that
// applyConfigToUI understands, so line-pasted profiles populate the GUI
// (model dropdown, ctx, spec checkboxes, samplers...) and not just the raw
// command box. Flags buildLlamaArgs re-adds automatically are dropped;
// unrecognized flags land in argString (the extra-args box).
function parseServerArgsToConfig(rest) {
    const t = rest.split(/\s+/).filter(Boolean);
    const cfg = {};
    const extras = [];
    const AUTO_SKIP_VAL = new Set(['--host', '--port', '-np', '--split-mode']);
    const AUTO_SKIP = new Set(['--metrics', '--jinja']);
    for (let i = 0; i < t.length; i++) {
        const f = t[i];
        const v = t[i + 1];
        const take = () => { i++; return v; };
        if (f === '-c') cfg.ctx = parseInt(take());
        else if (f === '-ngl') cfg.ngl = parseInt(take());
        else if (f === '-fa') { const x = take(); cfg.fa = (x === 'on' || x === '1'); }
        else if (f === '-ctk' || f === '--cache-type-k') cfg.cacheK = take();
        else if (f === '-ctv' || f === '--cache-type-v') cfg.cacheV = take();
        else if (f === '--spec-type') cfg.specType = take();
        else if (f === '--spec-draft-n-max') cfg.specDraftNMax = parseInt(take());
        else if (f === '--spec-draft-n-min') cfg.specDraftNMin = parseInt(take());
        else if (f === '--spec-draft-model') cfg.specDraftModel = take();
        else if (/^--spec-ngram-.*-size-n$/.test(f)) cfg.specNgramSizeN = parseInt(take());
        else if (/^--spec-ngram-.*-size-m$/.test(f)) cfg.specNgramSizeM = parseInt(take());
        else if (/^--spec-ngram-.*-min-hits$/.test(f)) cfg.specNgramMinHits = parseInt(take());
        else if (f === '-dev' || f === '--device') { const d = take().split(/[,/]/); cfg.deviceA = d[0] || null; cfg.deviceB = d[1] || null; }
        else if (f === '-ts' || f === '--tensor-split') { const d = take().split(/[,/]/); cfg.tensorSplit = parseInt(d[0]); }
        else if (f === '--temp') cfg.temp = parseFloat(take());
        else if (f === '--top-k') cfg.topK = parseInt(take());
        else if (f === '--top-p') cfg.topP = parseFloat(take());
        else if (f === '--min-p') cfg.minP = parseFloat(take());
        else if (f === '--presence-penalty') cfg.presencePenalty = parseFloat(take());
        else if (f === '--repeat-penalty') cfg.repeatPenalty = parseFloat(take());
        else if (f === '--n-cpu-moe') cfg.nCpuMoe = parseInt(take());
        else if (f === '-lv') cfg.verbosity = parseInt(take());
        else if (f === '--reasoning-preserve') cfg.reasoningPreserve = true;
        else if (AUTO_SKIP_VAL.has(f)) { take(); }
        else if (AUTO_SKIP.has(f)) { /* re-added automatically */ }
        else extras.push(f); // e.g. -fitt 256 (value token follows and also lands here)
    }
    if (extras.length) cfg.argString = extras.join(' ');
    return cfg;
}

// Paste-a-profile: 'name :: -m <model-substring> <server args>' becomes a
// saved profile whose rawCommand (the launch source of truth) is the given
// args with the CUDA+Vulkan binary and resolved model path prepended.
document.getElementById('btn-paste-profile').addEventListener('click', async () => {
    const line = prompt('Profile line:  name :: -m <model-substring> <server args>');
    if (!line || !line.trim()) return;
    const models = [...document.getElementById('model-select').options]
        .filter(o => o.value).map(o => ({ name: o.textContent, path: o.value }));
    const parsed = parseManualLine(line, models);
    if (parsed.error) { alert(parsed.error); return; }
    let binary = '';
    try {
        const { builds } = await (await fetch('/api/builds')).json();
        binary = (builds.find(b => /cuda/i.test(b.id) || /cuda/i.test(b.label)) || builds[0])?.path || '';
    } catch (e) {}
    if (!binary) { alert('could not resolve a build binary'); return; }
    const name = line.includes('::') ? line.slice(0, line.indexOf('::')).trim() : parsed.label.slice(0, 40);
    const config = {
        ...parseServerArgsToConfig(parsed.rest),
        rawCommand: `${binary} -m ${parsed.modelPath} ${parsed.rest}`,
        modelPath: parsed.modelPath,
        model: parsed.modelPath.split('/').pop(),
    };
    const profiles = getLaunchProfiles();
    const existingIdx = profiles.findIndex(pr => pr.name === name);
    const entry = { name, config, savedAt: Date.now() };
    if (existingIdx >= 0) profiles[existingIdx] = entry; else profiles.push(entry);
    saveLaunchProfiles(profiles);
    renderSavedConfigs();
    document.getElementById('load-profile-select').value = name;
    sessionActiveProfileName = name;
});

function deleteLaunchProfile(name) {
    saveLaunchProfiles(getLaunchProfiles().filter(p => p.name !== name));
    if (sessionActiveProfileName === name) sessionActiveProfileName = null;
    renderSavedConfigs();
}

// Renders into #load-profile-select (a dropdown at the top of the panel --
// selecting a profile loads it immediately) rather than the old per-model
// button list, which also required a non-empty extra-args box to save
// anything and is why saving "never quite worked properly".
function renderSavedConfigs() {
    const select = document.getElementById('load-profile-select');
    const previousValue = select.value;
    // Most-recently-loaded first; a profile never explicitly (re)loaded since
    // being saved falls back to its save time, so a brand new profile still
    // shows up near the top rather than at the bottom.
    const profiles = getLaunchProfiles().sort((a, b) => (b.lastLoadedAt || b.savedAt || 0) - (a.lastLoadedAt || a.savedAt || 0));
    select.innerHTML = '<option value="">Load Saved Profile...</option>';
    for (const p of profiles) {
        const opt = document.createElement('option');
        opt.value = p.name;
        const isRpcProfile = !!p.config.rpcTarget;
        opt.textContent = `${p.name} — ${isRpcProfile ? 'RPC' : 'Local'} · ${(p.config.modelPath || '').split('/').pop()}`;
        select.appendChild(opt);
    }
    // Keep the current selection if it still exists (e.g. after a save/delete
    // elsewhere), rather than always resetting to the placeholder.
    if (profiles.some(p => p.name === previousValue)) select.value = previousValue;
}

document.getElementById('btn-save-config').addEventListener('click', saveCurrentConfig);
document.getElementById('load-profile-select').addEventListener('change', (e) => {
    if (e.target.value) loadLaunchProfile(e.target.value);
});
document.getElementById('btn-delete-profile').addEventListener('click', () => {
    const select = document.getElementById('load-profile-select');
    if (select.value) deleteLaunchProfile(select.value);
});
document.getElementById('btn-stop-server').addEventListener('click', async () => {
    try {
        await fetch('/api/stop', { method: 'POST' });
    } catch (e) {}
    // Apply the "stopped" UI state directly from this click, rather than
    // waiting on the SSE broadcast alone -- reported as sometimes sticking on
    // "RUNNING" until a manual page refresh, which points at that broadcast
    // occasionally not landing (or landing before the badge element it needs
    // even exists, e.g. if this fires during a brief reconnect). /api/stop's
    // response confirms the server-side stop already happened, so it's safe
    // to reflect that immediately; the SSE branch still runs redundantly
    // whenever its own message does arrive, applying the same end state.
    const badge = document.getElementById('engine-status');
    badge.className = 'flex items-center gap-2 px-3 py-2 rounded-lg bg-red-900/20 border border-red-800 text-red-400 text-xs font-semibold';
    badge.innerHTML = '<span class="h-2 w-2 rounded-full bg-red-500"></span> ENGINE STOPPED';
    document.getElementById('btn-start-server').classList.remove('hidden');
    document.getElementById('btn-stop-server').classList.add('hidden');
    document.getElementById('user-prompt').disabled = true;
    document.getElementById('submit-btn').disabled = true;
    setHardwareConfigLocked(false);
});

// --- HF Modal Logic ---
function openHFModal() { document.getElementById('hf-modal').classList.remove('hidden'); document.getElementById('hf-modal').classList.add('flex'); }
function closeHFModal() { document.getElementById('hf-modal').classList.add('hidden'); document.getElementById('hf-modal').classList.remove('flex'); }
async function searchHF() {
    const q = document.getElementById('hf-search-input').value.trim();
    if(!q) return;
    const resDiv = document.getElementById('hf-results'); resDiv.innerHTML = '<div class="text-sm text-gray-400">Searching...</div>';
    try {
        const res = await fetch(`https://huggingface.co/api/models?search=${q}&sort=downloads&direction=-1&limit=10`);
        const data = await res.json();
        resDiv.innerHTML = data.filter(m => m.id.toLowerCase().includes('gguf')).map(m => `
            <div class="bg-gray-800 p-3 rounded-lg border border-gray-700">
                <div class="font-bold text-sm text-indigo-400">${m.id}</div>
                <div class="text-[10px] text-gray-500 mt-1 mb-2">Downloads: ${m.downloads}</div>
                <div class="bg-gray-900 p-2 rounded border border-gray-700 flex justify-between items-center group">
                    <code class="text-[10px] text-gray-400 select-all font-mono">wget https://huggingface.co/${m.id}/resolve/main/model.gguf -P ./models/</code>
                </div>
            </div>
        `).join('') || '<div class="text-sm text-gray-500">No GGUF models found.</div>';
    } catch (e) { resDiv.innerHTML = '<div class="text-sm text-red-400">Search failed.</div>'; }
}

// --- Chat & Benchmarking Logic ---
function toggleRaw(btnEl, isMarkdown) {
    const contentDiv = btnEl.closest('.msg-wrapper').querySelector('.msg-content');
    const rawText = btnEl.dataset.raw;
    if (btnEl.dataset.mode === 'raw') {
        contentDiv.innerHTML = isMarkdown ? marked.parse(rawText) : escapeHtml(rawText);
        contentDiv.className = isMarkdown ? 'msg-content prose prose-invert max-w-none text-sm mt-2 overflow-x-auto break-words' : 'msg-content text-gray-100 text-sm mt-2 whitespace-pre-wrap overflow-x-auto break-words';
        btnEl.dataset.mode = 'rendered';
        btnEl.innerText = 'View Raw';
    } else {
        // Kwargs annotation: THINKING OFF / custom template kwargs, shown in
        // red above the raw content so the user knows what template options
        // were applied to this request.
        let kwHtml = '';
        const kwRaw = btnEl.dataset.kwargs;
        if (kwRaw) {
            try {
                const kw = JSON.parse(kwRaw);
                const parts = [];
                if (kw.enable_thinking === false) parts.push('<span style="color:#f87171;font-weight:bold">THINKING OFF</span>');
                else if (kw.enable_thinking === true) parts.push('<span style="color:#4ade80">thinking enabled</span>');
                for (const [k, v] of Object.entries(kw)) {
                    if (k === 'enable_thinking') continue;
                    parts.push(`<span style="color:#f87171">${escapeHtml(k)}: ${escapeHtml(JSON.stringify(v))}</span>`);
                }
                if (parts.length) kwHtml = `<div class="text-xs font-mono mb-2 px-3 pt-2">${parts.join(' · ')}</div>`;
            } catch (e) {}
        }
        contentDiv.innerHTML = kwHtml + `<pre class="text-xs text-gray-300 overflow-x-auto p-3 bg-gray-950 rounded border border-gray-800">${escapeHtml(rawText)}</pre>`;
        contentDiv.className = 'msg-content mt-2 overflow-x-auto break-words';
        btnEl.dataset.mode = 'raw';
        btnEl.innerText = 'View Rendered';
    }
}

function toggleReasoning(headerEl) {
    const body = headerEl.nextElementSibling;
    const icon = headerEl.querySelector('.r-icon');
    if (body.style.maxHeight) {
        body.style.maxHeight = null;
        body.classList.remove('fade-bottom');
        icon.innerText = '▲';
    } else {
        body.style.maxHeight = '4.5rem';
        body.classList.add('fade-bottom');
        icon.innerText = '▼';
    }
}

// Long chat messages (prompts or responses) collapse to a preview height with
// a fade-out + "Show more" toggle, same visual language as the existing
// reasoning-trace collapse above. Applied post-hoc (not during live streaming
// -- see the two call sites) so the collapse boundary doesn't jump around
// while a response is still being read live.
const MSG_COLLAPSE_HEIGHT = 320; // px -- roughly a 12-15 line preview
function applyMessageCollapse(el) {
    if (!el || el.dataset.collapseChecked) return;
    el.dataset.collapseChecked = '1';
    const naturalHeight = el.scrollHeight;
    if (naturalHeight <= MSG_COLLAPSE_HEIGHT + 40) return; // not worth collapsing
    el.classList.add('fade-bottom');
    el.style.maxHeight = MSG_COLLAPSE_HEIGHT + 'px';
    el.style.overflow = 'hidden';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'msg-collapse-toggle block text-[11px] text-indigo-400 hover:text-indigo-300 mt-1.5 font-medium';
    btn.textContent = 'Show more ▾';
    btn.addEventListener('click', () => {
        const isCollapsed = el.style.maxHeight === MSG_COLLAPSE_HEIGHT + 'px';
        if (isCollapsed) {
            el.style.maxHeight = naturalHeight + 'px';
            el.classList.remove('fade-bottom');
            btn.textContent = 'Show less ▴';
        } else {
            el.style.maxHeight = MSG_COLLAPSE_HEIGHT + 'px';
            el.classList.add('fade-bottom');
            btn.textContent = 'Show more ▾';
            el.scrollIntoView({ block: 'nearest' });
        }
    });
    el.insertAdjacentElement('afterend', btn);
}
function collapseLongMessagesIn(containerEl) {
    containerEl.querySelectorAll('.msg-content').forEach(applyMessageCollapse);
}

let currentVramSnapshot = 0;
let chatContext = []; // Stores conversation history for the API
// isColdStart removed - all prompts now logged to CSV

// --- Prefill sparkline (replaces the old flat prefill/think/answer bar) ---
// `points` is an array of {progress, tps} samples captured live from the
// server's PREFILL_PROGRESS broadcasts during the current generation.
let activePrefillSamples = [];
let activeTimelineEls = null; // { svg, prefillLine, thinkLine, answerLine } for the in-flight response bubble
// Latest prefill t/s from the server's PREFILL_PROGRESS broadcasts -- consumed
// by submitPrompt's 1s tpsLoop so prefill actually lands in the live Tokens/sec
// chart (the loop used to null out the whole Prefill dataset every tick).
let livePrefillTps = null;
let livePrefillProgress = null;
// Live gen t/s samples (instantaneous) -- used to compute the min-max range
// displayed on the completed Monitor/History row alongside the average.
let activeGenSamples = [];

// Monitor tab's Live Request card -- driven by the same broadcasts as the
// sidebar so it reflects requests from any client, not just this chat.
let prefillEtaState = null; // { p0, t0, lastP } -- progress-rate baseline for the ETA
function updateLiveRequestCard(phase, data) {
    const phaseEl = document.getElementById('live-req-phase');
    if (!phaseEl) return;
    const prefillBlock = document.getElementById('live-req-prefill');
    const genBlock = document.getElementById('live-req-gen');
    const idleBlock = document.getElementById('live-req-idle');
    prefillBlock.classList.toggle('hidden', phase !== 'prefill');
    genBlock.classList.toggle('hidden', phase !== 'gen');
    idleBlock.classList.toggle('hidden', phase !== 'idle');
    if (phase === 'prefill') {
        phaseEl.textContent = 'prefill';
        phaseEl.className = 'text-[10px] font-semibold px-2 py-0.5 rounded-full bg-yellow-900/40 text-yellow-400';
        const pct = (data.progress * 100);
        document.getElementById('live-req-pos').textContent = isNaN(data.nTokens) ? '?' : data.nTokens.toLocaleString();
        document.getElementById('live-req-prefill-tps').textContent = isNaN(data.tps) ? '' : `${data.tps.toFixed(1)} t/s`;
        document.getElementById('live-req-bar').style.width = `${pct.toFixed(1)}%`;
        document.getElementById('live-req-pct').textContent = `${pct.toFixed(1)}%`;
        // ETA from the observed rate of PROGRESS over wall time, not from
        // token counts: llama's progress fraction is measured against the
        // whole task (cached prefix included) while n_tokens only counts
        // newly-processed tokens, so tokens/progress math misestimates
        // whenever the prompt cache absorbed part of the prefill.
        const now = Date.now();
        if (!prefillEtaState || data.progress < prefillEtaState.lastP) {
            prefillEtaState = { p0: data.progress, t0: now, lastP: data.progress }; // new request
        }
        prefillEtaState.lastP = data.progress;
        let eta = '';
        const dp = data.progress - prefillEtaState.p0;
        if (dp > 0.005) {
            const secs = (1 - data.progress) * (now - prefillEtaState.t0) / dp / 1000;
            eta = secs >= 90 ? `est. ${(secs / 60).toFixed(1)} min left` : `est. ${secs.toFixed(0)}s left`;
        }
        document.getElementById('live-req-eta').textContent = eta;
    } else if (phase === 'gen') {
        phaseEl.textContent = 'generating';
        phaseEl.className = 'text-[10px] font-semibold px-2 py-0.5 rounded-full bg-green-900/40 text-green-400';
        document.getElementById('live-req-decoded').textContent = isNaN(data.nDecoded) ? '?' : data.nDecoded.toLocaleString();
        document.getElementById('live-req-gen-tps').textContent = isNaN(data.tps) ? '' : `${data.tps.toFixed(1)} t/s`;
    } else {
        phaseEl.textContent = 'idle';
        phaseEl.className = 'text-[10px] font-semibold px-2 py-0.5 rounded-full bg-gray-800 text-gray-500';
    }
}

function handlePrefillProgress(progress, tps, nTokens) {
    if (!isNaN(progress) && !isNaN(tps)) {
        activePrefillSamples.push({ progress, tps });
        livePrefillTps = tps;
        livePrefillProgress = progress;
        // Update session-wide weighted average in real time using deltas.
        // nTokens/tokensPerSec = accumulated seconds since prefill start.
        // Delta tokens = nTokens - lastPrefillBatchTokens; delta seconds = deltaTokens / tps.
        if (!isNaN(nTokens) && nTokens > 0 && tps > 0) {
            const deltaTokens = nTokens - lastPrefillBatchTokens;
            if (deltaTokens > 0) {
                runningAverages.prefillTokens += deltaTokens;
                runningAverages.prefillSeconds += deltaTokens / tps;
                lastPrefillBatchTokens = nTokens;
                updateAverageUI();
            }
        }
    }
    updateLiveRequestCard('prefill', { progress, tps, nTokens });
    liveMonitorRow = { ...(liveMonitorRow || { startedAt: Date.now() }), live: true, model: lastKnownModelName, promptTokens: isNaN(nTokens) ? null : nTokens, promptTps: isNaN(tps) ? null : tps };
    if (isMonitorModeActive) renderMonitorTable();
    const abLive = document.getElementById('ab-live');
    const abLiveText = `prefill ${(progress * 100).toFixed(1)}% — ${isNaN(nTokens) ? '?' : nTokens.toLocaleString()} tok @ ${isNaN(tps) ? '?' : tps.toFixed(1)} t/s`;
    if (abLive) abLive.textContent = abLiveText;
    updateLiveSweepBlock(abLiveText);
    const pct = isNaN(progress) ? 0 : (progress * 100).toFixed(1);
    // status-indicator's ticking text is owned solely by submitPrompt's own
    // tpsLoop (1s interval) -- it used to also get overwritten from here,
    // racing against tpsLoop at a different cadence (this fires whenever a
    // PREFILL_PROGRESS broadcast happens to arrive, which is rate-limited
    // server-side and not on a fixed schedule) and visibly flickering between
    // the two independently-worded strings. This function still owns the
    // sidebar metric/loading-bar/sparkline below, just not that one element.

    // Live prefill speed in the sidebar card, updated as real samples arrive
    if (!isNaN(tps)) {
        document.getElementById('metric-prefill').innerText = `${tps.toFixed(1)} t/s`;
        if (!isNaN(nTokens)) document.getElementById('metric-prefill-tokens').innerText = `${nTokens} tokens`;
    }

    // Update the prefill loading bar inside the active response bubble
    const activeBubble = document.getElementById('active-ast');
    if (activeBubble) {
        const barContainer = activeBubble.querySelector('.prefill-loading-bar-container');
        if (barContainer) {
            barContainer.classList.remove('hidden');
            const fill = barContainer.querySelector('.prefill-bar-fill');
            const pctSpan = barContainer.querySelector('.prefill-bar-pct');
            const tokensSpan = barContainer.querySelector('.prefill-bar-tokens');
            const tpsSpan = barContainer.querySelector('.prefill-bar-tps');
            if (fill) fill.style.width = `${pct}%`;
            if (pctSpan) pctSpan.innerText = `${pct}%`;
            if (tokensSpan) tokensSpan.innerText = isNaN(nTokens) ? '0' : nTokens.toLocaleString();
            if (tpsSpan) tpsSpan.innerText = isNaN(tps) ? '0' : tps.toFixed(0);
        }
    }

    drawPrefillSparkline(activeTimelineEls, activePrefillSamples, 1, 0, 0, true);
}

// Hide the prefill loading bar when prefill phase is complete
function hidePrefillLoadingBar() {
    const activeBubble = document.getElementById('active-ast');
    if (activeBubble) {
        const barContainer = activeBubble.querySelector('.prefill-loading-bar-container');
        if (barContainer) barContainer.classList.add('hidden');
    }
}

// Handle live generation progress from server's print_timing SSE events
// Format: GEN_PROGRESS:<avgTps>:<instTps>:<nDecoded>
function handleGenProgress(avgTps, instTps, nDecoded) {
    // status-indicator is owned by submitPrompt's tpsLoop -- see the matching
    // note in handlePrefillProgress above.
    updateLiveRequestCard('gen', { tps: instTps, nDecoded });
    // Update session-wide weighted average in real time.
    if (!isNaN(nDecoded) && nDecoded > 0 && !isNaN(avgTps) && avgTps > 0) {
        const deltaTokens = nDecoded - lastGenBatchTokens;
        if (deltaTokens > 0) {
            runningAverages.genTokens += deltaTokens;
            runningAverages.genSeconds += deltaTokens / avgTps;
            lastGenBatchTokens = nDecoded;
            updateAverageUI();
        }
    }
    // Live Monitor row gets the AVERAGE (not the instantaneous window)
    liveMonitorRow = { ...(liveMonitorRow || { startedAt: Date.now() }), live: true, model: lastKnownModelName, genTokens: isNaN(nDecoded) ? null : nDecoded, genTps: isNaN(avgTps) ? null : avgTps };
    if (isMonitorModeActive) renderMonitorTable();
    const abLiveG = document.getElementById('ab-live');
    // instTps (master) is the instantaneous rate; the live sweep block shows
    // the same text as the top strip so the two can't drift.
    const abLiveGText = `generating ${isNaN(nDecoded) ? '?' : nDecoded.toLocaleString()} tok @ ${isNaN(instTps) ? '?' : instTps.toFixed(1)} t/s`;
    if (abLiveG) abLiveG.textContent = abLiveGText;
    updateLiveSweepBlock(abLiveGText);

    // Sidebar card gets the instantaneous speed (current, not average)
    if (!isNaN(instTps)) {
        document.getElementById('metric-gen').innerText = `${instTps.toFixed(1)} t/s`;
    }
    if (!isNaN(nDecoded)) {
        document.getElementById('metric-gen-tokens').innerText = `${nDecoded} tokens`;
    }
    // Track instantaneous gen samples for min-max range at completion
    if (!isNaN(instTps)) activeGenSamples.push({ tps: instTps, nDecoded });
}

// Builds/updates the SVG timeline. widthPct* are 0-100 proportions of the
// total elapsed time occupied by each phase; samples is the live/stored
// {progress, tps}[] array for the prefill phase (the only phase we have a
// real time series for).
function drawPrefillSparkline(els, samples, prefillWidthPct, thinkWidthPct, answerWidthPct, stillLoading) {
    if (!els) return;
    const VB_W = 1000, VB_H = 100, MID = 50;
    const totalPct = stillLoading ? 100 : (prefillWidthPct + thinkWidthPct + answerWidthPct) || 100;
    const pStart = 0;
    const pEnd = stillLoading ? VB_W : (prefillWidthPct / totalPct) * VB_W;
    const tEnd = stillLoading ? VB_W : pEnd + (thinkWidthPct / totalPct) * VB_W;
    const aEnd = stillLoading ? VB_W : tEnd + (answerWidthPct / totalPct) * VB_W;

    if (samples && samples.length > 0) {
        const tpsVals = samples.map(s => s.tps).filter(v => !isNaN(v));
        const maxTps = Math.max(...tpsVals, 1);
        const minTps = Math.min(...tpsVals, maxTps);
        const range = Math.max(maxTps - minTps, 1);
        const pts = samples.map(s => {
            const x = pStart + (isNaN(s.progress) ? 0 : s.progress) * (pEnd - pStart);
            const norm = isNaN(s.tps) ? 0.5 : (s.tps - minTps) / range;
            const y = VB_H - 10 - (norm * (VB_H - 20)); // higher tps -> higher on the graph
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        });
        els.prefillLine.setAttribute('points', pts.join(' '));
    } else {
        // No samples yet (or none ever arrived) -- flat placeholder line so
        // the segment is still visible.
        els.prefillLine.setAttribute('points', `${pStart},${MID} ${pEnd},${MID}`);
    }

    if (!stillLoading) {
        els.thinkLine.setAttribute('points', thinkWidthPct > 0 ? `${pEnd},${MID} ${tEnd},${MID}` : '');
        els.answerLine.setAttribute('points', answerWidthPct > 0 ? `${tEnd},${MID} ${aEnd},${MID}` : '');
    }
}

// Active-response hardware chart state (set by submitPrompt, read by pollTelemetry)
let responseMetrics = [];
let hwChartInst = null;
let hwChartContainer = null;
let hwChartCanvas = null;
// Track current phase for dynamic t/s line color: 'prefill' | 'think' | 'answer'
let currentResponsePhase = 'prefill';
// Per-second token rates for the LAST tpsLoop tick, split by phase. Written by
// submitPrompt's tpsLoop (which counts SSE deltas -- the ONLY observer that
// knows which tokens are reasoning vs content; llama-server's stdout timing
// lines count all decoded tokens together), read by pollTelemetry when it
// builds omni samples. The split lets the omni charts draw Thinking Tok/s and
// Answer Tok/s as separate lines (see buildOmniDatasets).
let lastThinkTps = 0;
let lastAnswerTps = 0;

async function submitPrompt() {
    const inputEl = document.getElementById('user-prompt');
    const text = inputEl.value.trim();
    if (!text) return;
    // Clear immediately on send, not at completion -- clearing at completion
    // both delayed the visual feedback of having sent (the box kept showing
    // the just-submitted text for the whole generation) and blew away
    // whatever the user had typed in the meantime if they'd started drafting
    // their next message before this one finished.
    inputEl.value = '';

    const timestamp = new Date().toLocaleTimeString();
    chatContext.push({ role: 'user', content: text, timestamp, images: attachedImages.length > 0 ? attachedImages.map(img => img.dataUrl) : null });

    // Always pass full chat context so the server can reuse KV-cache
    // Build API messages: when a user message has attached images, format as
    // OpenAI multimodal content array ([{type:"text",...}, {type:"image_url",...}])
    // so llama.cpp's mtmd multimodal backend can process them.
    const apiMessages = chatContext.map(m => {
        if (m.images && m.images.length > 0) {
            return {
                role: m.role,
                content: [
                    { type: 'text', text: m.content },
                    ...m.images.map(url => ({ type: 'image_url', image_url: { url } }))
                ]
            };
        }
        return { role: m.role, content: m.content };
    });
    // Consume the attached images so they don't persist into the next prompt
    attachedImages = [];
    const attachedImageContainer = document.getElementById('attached-images');
    if (attachedImageContainer) attachedImageContainer.remove();

    // Reset live batch trackers for running average delta computation
    lastPrefillBatchTokens = 0;
    lastGenBatchTokens = 0;
    // Prepare UI & Reset session data
    inputEl.disabled = true; document.getElementById('submit-btn').disabled = true; document.getElementById('status-indicator').classList.remove('hidden'); document.getElementById('abort-btn').classList.remove('hidden');
    document.getElementById('status-indicator').innerText = 'Loading context...';

    // Build UI Bubbles
    // insertAdjacentHTML, NOT `innerHTML +=` -- the latter re-serializes and
    // re-parses the ENTIRE chat box, replacing every existing node. That
    // destroys earlier messages' <canvas> elements along with their Chart.js
    // omni graphs (and the __hwMetrics attached to their wrappers), which is
    // why a finished message's graph vanished the instant the next prompt was
    // sent. Appending parsed fragments leaves existing nodes -- and their
    // chart instances -- untouched.
    const chatBox = document.getElementById('chat-container');
    const latestUserMsg = [...chatContext].reverse().find(m => m.role === 'user');
    const imgThumbs = (latestUserMsg && latestUserMsg.images) ? `<div class="flex flex-wrap gap-2 mb-2">${latestUserMsg.images.map(u => `<img src="${u}" class="h-16 w-16 object-cover rounded-lg border border-gray-600">`).join('')}</div>` : '';
    chatBox.insertAdjacentHTML('beforeend', `
        <div class="msg-wrapper p-4 rounded-xl border border-gray-700 bg-gray-800 max-w-4xl mx-auto shadow-sm w-full mb-4">
            <div class="flex justify-between items-center mb-2">
                <div class="text-xs text-gray-300 uppercase">User</div>
                <div class="flex items-center gap-3">
                    <div class="text-[10px] text-gray-500">${timestamp}</div>
                    <button class="text-[10px] text-gray-500 hover:text-gray-300 transition-colors" data-mode="rendered" data-raw="${escapeHtml(text)}" onclick="toggleRaw(this, false)">View Raw</button>
                </div>
            </div>
            ${imgThumbs}
            <div class="msg-content text-sm text-gray-100 whitespace-pre-wrap overflow-x-auto break-words">${escapeHtml(text)}</div>
        </div>
        <div id="active-ast" class="msg-wrapper p-5 rounded-xl border border-indigo-900/30 bg-gray-900 max-w-4xl mx-auto shadow-sm w-full mb-4">
            <div class="flex justify-between items-center mb-2">
                <div class="text-xs text-indigo-400 uppercase tracking-wider">Assistant</div>
                <div class="flex items-center gap-3">
                    <div class="text-[10px] text-gray-500">${timestamp}</div>
                    <button class="raw-btn text-[10px] text-gray-500 hover:text-gray-300 transition-colors hidden" data-mode="rendered" onclick="toggleRaw(this, true)">View Raw</button>
                </div>
            </div>
            <div class="metrics-timeline-container w-full mb-3 mt-2">
                <div class="timeline-graph-wrap w-full h-6 rounded-md bg-gray-800 overflow-hidden mb-1">
                    <svg class="timeline-graph-svg w-full h-full" viewBox="0 0 1000 100" preserveAspectRatio="none">
                        <polyline class="timeline-prefill-line" points="" fill="none" stroke="#eab308" stroke-width="6" />
                        <polyline class="timeline-think-line" points="" fill="none" stroke="#3b82f6" stroke-width="6" />
                        <polyline class="timeline-answer-line" points="" fill="none" stroke="#22c55e" stroke-width="6" />
                    </svg>
                </div>
                <div class="flex text-[9px] text-gray-500 gap-4 px-1">
                    <div class="label-prefill text-yellow-500/80 font-mono">Loading Context...</div>
                    <div class="label-think text-blue-500/80 font-mono hidden">Think: <span class="val"></span></div>
                    <div class="label-answer text-green-500/80 font-mono hidden">Answer: <span class="val"></span></div>
                </div>
                <!-- Prefill Loading Bar -->
                <div class="prefill-loading-bar-container hidden mt-2 space-y-1">
                    <div class="flex justify-between text-[9px] font-mono">
                        <span class="prefill-bar-label text-yellow-400">Processing Prompt...</span>
                        <span class="prefill-bar-stats text-gray-400"><span class="prefill-bar-pct">0%</span> &mdash; <span class="prefill-bar-tokens">0</span> tokens @ <span class="prefill-bar-tps">0</span> t/s</span>
                    </div>
                    <div class="w-full bg-gray-950 rounded-full h-2 overflow-hidden border border-gray-800">
                        <div class="prefill-bar-fill bg-gradient-to-r from-yellow-600 to-yellow-400 h-full rounded-full transition-all duration-150 ease-out" style="width: 0%"></div>
                    </div>
                </div>
                <div class="hw-chart-container hidden mt-2 border border-gray-800/60 rounded-lg bg-gray-950/50 p-2 cursor-pointer" style="height:140px" onclick="expandHwChart(this)">
                    <canvas class="hw-chart-canvas"></canvas>
                </div>
            </div>
            <div class="reasoning-container hidden border border-gray-800 rounded-lg bg-gray-950/50 mb-3 mt-2">
                <div class="flex justify-between px-3 py-1.5 bg-gray-800/30 text-[10px] text-gray-400 border-b border-gray-800 cursor-pointer hover:bg-gray-800/50 transition-colors" onclick="toggleReasoning(this)">
                    <span>🧠 Reasoning Trace <span class="r-tokens text-gray-500 ml-1">(~0 tokens)</span></span>
                    <span class="r-icon">▼</span>
                </div>
                <div class="reasoning-body text-xs text-gray-500 font-mono p-3 overflow-x-auto overflow-y-hidden relative cursor-pointer fade-bottom" style="max-height: 4.5rem;" onclick="toggleReasoning(this.previousElementSibling)"></div>
            </div>
            <div class="msg-content prose prose-invert max-w-none text-sm overflow-x-auto break-words"></div>
        </div>
    `);
    chatBox.scrollTop = chatBox.scrollHeight;
    // The user bubble's content is static from the moment it's inserted, so
    // it can be collapse-checked immediately (unlike the assistant bubble
    // below, which is still empty and will stream in over time).
    applyMessageCollapse(document.getElementById('active-ast').previousElementSibling.querySelector('.msg-content'));
    const astEl = document.getElementById('active-ast');
    const timelineEls = {
        container: astEl.querySelector('.metrics-timeline-container'),
        pLbl: astEl.querySelector('.label-prefill'),
        tLbl: astEl.querySelector('.label-think'),
        aLbl: astEl.querySelector('.label-answer')
    };
    const contentBody = astEl.querySelector('.msg-content');
    const reasoningBox = astEl.querySelector('.reasoning-container');
    const reasoningBody = astEl.querySelector('.reasoning-body');
    const reasoningTokens = astEl.querySelector('.r-tokens');
    const rawBtn = astEl.querySelector('.raw-btn');

    abortController = new AbortController();
    let tokenCount = 0; 
    let startTime = Date.now();
    window.__promptStartTime = startTime;
    let timeToFirstToken = 0;
    let timeToFirstContent = 0;
    let reasoningTokenCount = 0;
    let answerTokenCount = 0;
    let prefillMetrics = null;
    let thinkMetrics = null;
    let answerMetrics = null;
    // Reset module-level hw chart state for this new response
    responseMetrics = [];
    hwChartInst = null;
    hwChartContainer = astEl.querySelector('.hw-chart-container');
    hwChartCanvas = astEl.querySelector('.hw-chart-canvas');
    // Attach this message's metrics array to ITS OWN container by reference
    // (not a copy -- keeps growing as responseMetrics is pushed to while this
    // is the active/streaming message). expandHwChart() reads from whichever
    // container was actually clicked instead of always reading the shared
    // module-level `responseMetrics`, which only ever reflects the latest
    // message -- without this, clicking an older message's chart expanded
    // using the wrong (newer, or empty) data, which is why it "seemed
    // inconsistent" (worked right after that message finished, before the
    // module-level variable got reassigned to the next one, broke after).
    hwChartContainer.__hwMetrics = responseMetrics;

    // Start CSV Data payload
    sessionData = {
        model: document.getElementById('model-select').value,
        ctx: document.getElementById('server-ctx').value,
        ngl: document.getElementById('server-ngl').value,
        rpc: document.getElementById('rpc-toggle').checked ? 'yes' : 'no',
        transport: document.getElementById('rpc-toggle').checked ? document.getElementById('transport-type').value : 'Local',
        argString: document.getElementById('extra-args').value.trim() || '',
        promptTokens: 0,
        gpuMem: currentVramSnapshot,
        wallTime: 0,
        loadTime: currentLoadTime 
    };

    // Reset charts
    tpsChart.data.labels = [];
    tpsChart.data.datasets[0].data = []; // Prefill Speed
    tpsChart.data.datasets[1].data = []; // Gen Speed
    tpsChart.update('none');
    livePrefillTps = null; // stale prefill from the previous request must not plot into this one
    lastThinkTps = 0; lastAnswerTps = 0; // stale per-phase rates from the previous request must not plot into this one

    // Reset live numbers
    document.getElementById('metric-prefill').innerText = '0.0 t/s';
    document.getElementById('metric-prefill-tokens').innerText = '0 tokens';
    document.getElementById('metric-gen').innerText = '0.0 t/s';
    document.getElementById('metric-gen-tokens').innerText = '0 tokens';

    // Calculate context limit and estimate prompt tokens
    currentContextLimit = parseInt(document.getElementById('server-ctx').value) || 110000;
    const estimatedPromptTokens = Math.ceil((text.length + 100) / 4) + currentContextTokens;
    updateContextUI(estimatedPromptTokens, currentContextLimit);

    let totalTokensGenerated = 0;
    let thinkTokenCount = 0;   // reasoning deltas since last tpsLoop tick
    let contentTokenCount = 0; // content deltas since last tpsLoop tick
    window.lastSlotProgress = '';

    let slotsLoop = setInterval(async () => {
        if (timeToFirstToken > 0) return clearInterval(slotsLoop);
        try {
            const res = await fetch('http://localhost:8080/slots');
            const slots = await res.json();
            if (slots && slots.length > 0) {
                const slot = slots.find(s => s.state === 1) || slots[0];
                // n_decoded lives under next_token in llama-server's /slots
                // response, not as a top-level field -- reading slot.n_decoded
                // directly was always undefined, hence "undefined / N (NaN%)".
                const nDecoded = slot.next_token?.n_decoded;
                if (slot.n_prompt_tokens > 0 && nDecoded != null) {
                    const pct = Math.min((nDecoded / slot.n_prompt_tokens) * 100, 100).toFixed(1);
                    window.lastSlotProgress = `${nDecoded} / ${slot.n_prompt_tokens} (${pct}%)`;
                }
                         }
                    } catch (e) {
                        // Re-throw server errors so the outer handler displays them.
                        // Swallow benign parse failures (partial lines, empty chunks).
                        if (e.message && !e.message.includes('JSON') && !e.message.includes('Unexpected') && !e.message.startsWith('data:')) throw e;
                    }
    }, 250);

    let lastTpsTickAt = Date.now();
    let tpsLoop = setInterval(() => {
        // Average over ACTUAL elapsed time -- when the event loop stalls (heavy
        // downloads/disk IO), the tick fires late with accumulated tokens; the
        // old fixed-1s assumption plotted that as a fake burst (observed: a
        // "1252 t/s" spike during a model download).
        const nowTick = Date.now();
        const dtSec = Math.max(0.25, (nowTick - lastTpsTickAt) / 1000);
        lastTpsTickAt = nowTick;
        const tps = tokenCount / dtSec; tokenCount = 0;
        const thinkTps = thinkTokenCount / dtSec; thinkTokenCount = 0;
        const answerTps = contentTokenCount / dtSec; contentTokenCount = 0;
        lastThinkTps = thinkTps; lastAnswerTps = answerTps;
        document.getElementById('current-tps').innerText = tps.toFixed(1);
        document.getElementById('metric-gen').innerText = `${tps.toFixed(1)} t/s`;
        
        // During the prefill phase (no token generated yet), record the latest
        // prefill t/s reported by the server's PREFILL_PROGRESS broadcasts so
        // it plots on the chart's left axis; once generation starts the entry
        // gets null and only the gen line advances.
        tpsHistory.push({ time: Math.floor((Date.now()-startTime)/1000), tps, prefillTps: timeToFirstToken === 0 ? livePrefillTps : null });
        if(tpsHistory.length > 30) tpsHistory.shift();
        // Full history for expand modal
        tpsHistoryFull.push({ time: new Date().toLocaleTimeString(), tps });
        if (tpsHistoryFull.length > 200) tpsHistoryFull.shift();
        refreshExpandedChartLive();

        tpsChart.data.labels = tpsHistory.map(h => h.time);
        tpsChart.data.datasets[0].data = tpsHistory.map(h => h.prefillTps ?? null);
        tpsChart.data.datasets[1].data = tpsHistory.map(h => h.tps);
        tpsChart.update('none');

        if (timeToFirstToken === 0) {
            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
            if (window.lastSlotProgress) {
                document.getElementById('status-indicator').innerText = `Loading context... ${window.lastSlotProgress} [${elapsed}s]`;
            } else {
                document.getElementById('status-indicator').innerText = `Loading context... [${elapsed}s]`;
            }
        } else {
            document.getElementById('status-indicator').innerText = 'Generating...';
        }

        // Dynamic Context growth during streaming
        const liveContext = estimatedPromptTokens + totalTokensGenerated;
        updateContextUI(liveContext, currentContextLimit);
        document.getElementById('metric-gen-tokens').innerText = `${totalTokensGenerated} tokens`;
        
        // Live Generation Average calculation
        if (timeToFirstToken > 0) {
            const genTime = ((Date.now() - startTime) / 1000) - timeToFirstToken;
            // (metric-gen-avg is the session-weighted box -- not written here;
            // see the matching note in the prefill path.)
        }
    }, 1000);

    try {
        // Per-request chat template kwargs (thinking on/off + free-form JSON)
        const chatBody = { model: sessionData.model, messages: apiMessages, stream: true, stream_options: { include_usage: true } };
        const thinkSel = document.getElementById('chat-thinking')?.value;
        let templateKwargs = {};
        if (thinkSel === 'on') templateKwargs.enable_thinking = true;
        else if (thinkSel === 'off') templateKwargs.enable_thinking = false;
        const kwRaw = document.getElementById('chat-kwargs')?.value.trim();
        if (kwRaw) {
            try { Object.assign(templateKwargs, JSON.parse(kwRaw)); }
            catch (e) { displayErrorInUI('extra kwargs is not valid JSON -- ignored for this request'); }
        }
        if (Object.keys(templateKwargs).length > 0) chatBody.chat_template_kwargs = templateKwargs;
        const response = await fetch('http://localhost:8080/v1/chat/completions', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(chatBody),
            signal: abortController.signal
        });

        // Handle HTTP error responses (e.g. model doesn't support images).
        // fetch doesn't throw on 4xx/5xx — only on network failures.
        if (!response.ok) {
            const errBody = await response.text();
            let msg;
            try { const j = JSON.parse(errBody); msg = j.error?.message || j.error || errBody; } catch { msg = errBody; }
            throw new Error(msg);
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder("utf-8");
        let fullContent = ""; let fullReasoning = "";

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            const chunk = decoder.decode(value, { stream: true });
            
            if (timeToFirstToken === 0) {
                window.chartEvents.push({ time: Date.now(), label: 'Prefill Done', color: '#facc15', offset: 20 });
                timeToFirstToken = (Date.now() - startTime) / 1000; // in seconds
                sessionData.promptLatency = timeToFirstToken.toFixed(2);
                
                // Phase transition: prefill → think
                currentResponsePhase = 'think';
                // Hide the prefill loading bar now that prompt processing is done
                hidePrefillLoadingBar();
                
                const promptTokensEst = estimatedPromptTokens - currentContextTokens;
                const livePrefillAvg = (promptTokensEst / timeToFirstToken).toFixed(1);
                prefillMetrics = { time: timeToFirstToken.toFixed(1), tokens: promptTokensEst, tps: livePrefillAvg };
                
                timelineEls.pLbl.innerHTML = `Prefill: <span class="val text-gray-200">${prefillMetrics.time}s | ${prefillMetrics.tokens}t | ${prefillMetrics.tps} t/s</span>`;
                timelineEls.container.classList.remove('hidden');

                // NOTE: deliberately NOT writing metric-prefill-avg here -- that
                // box is the SESSION-weighted average (fed by COMPLETION events
                // via saveMetricsToAverages); a per-prompt estimate was
                // clobbering it (a 4-token cache-hit prompt once painted it
                // "2.1 t/s"). Per-prompt numbers live in the bubble timeline.
                document.getElementById('metric-prefill').innerText = `${livePrefillAvg} t/s`;
                document.getElementById('metric-prefill-tokens').innerText = `${promptTokensEst} tokens`;
            }

            const lines = chunk.split('\n');
            for (const line of lines) {
                if (line.startsWith('data: ') && line !== 'data: [DONE]') {
                    try {
                        const data = JSON.parse(line.slice(6));

                        // Server returned an error mid-stream
                        if (data.error) {
                            throw new Error(data.error.message || data.error);
                        }
                        
                        // End of stream Usage metrics
                        if (data.usage) {
                            sessionData.genTokens = data.usage.completion_tokens;
                            sessionData.reasonTokens = reasoningTokenCount;
                            sessionData.promptTokens = data.usage.prompt_tokens;

                            // Correct the live prefill estimate with the server's real
                            // prompt_tokens count. The live value (set when the first
                            // token arrived, above) divides an ESTIMATED new-message
                            // token count by timeToFirstToken -- correct only when the
                            // whole prior context is cache-hit and skipped. Whenever it
                            // isn't (slot switch, cache eviction, first turn), the real
                            // prompt_tokens llama-server actually processed is far larger
                            // than the estimate, so the estimate-based tps reads far too
                            // low (e.g. "1.5 t/s" for a request that really ran ~400 t/s).
                            // Recompute from ground truth now that usage is known.
                            if (timeToFirstToken > 0) {
                                const realPromptTps = (data.usage.prompt_tokens / timeToFirstToken).toFixed(1);
                                prefillMetrics = { time: timeToFirstToken.toFixed(1), tokens: data.usage.prompt_tokens, tps: realPromptTps };
                                timelineEls.pLbl.innerHTML = `Prefill: <span class="val text-gray-200">${prefillMetrics.time}s | ${prefillMetrics.tokens}t | ${prefillMetrics.tps} t/s</span>`;
                            }
                            sessionData.promptTps = prefillMetrics.tps;

                            const finalAnsTime = ((Date.now() - startTime) / 1000) - timeToFirstToken - timeToFirstContent;
                            answerMetrics = { time: finalAnsTime.toFixed(1), tokens: answerTokenCount, tps: (answerTokenCount/finalAnsTime).toFixed(1) };
                            timelineEls.aLbl.innerHTML = `Answer: <span class="val text-gray-200">${answerMetrics.time}s | ${answerMetrics.tokens}t | ${answerMetrics.tps} t/s</span>`;
                            // The draft-acceptance summary arrives ~0.5s later on the
                            // COMPLETION broadcast -- register this bubble to receive it.
                            pendingDraftStatsEl = timelineEls.aLbl.parentElement;
                            pendingDraftStatsExpiry = Date.now() + 8000;
                            
                            // Final static render of the sparkline: proportional widths by time, real tps curve for prefill
                            const totalTime = timeToFirstToken + timeToFirstContent + finalAnsTime;
                            const pPct = totalTime > 0 ? (timeToFirstToken / totalTime) * 100 : 100;
                            const tPct = totalTime > 0 ? (timeToFirstContent / totalTime) * 100 : 0;
                            const aPct = totalTime > 0 ? (finalAnsTime / totalTime) * 100 : 0;
                            drawPrefillSparkline(activeTimelineEls, activePrefillSamples, pPct, tPct, aPct, false);
                            
                            sessionData.genTps = answerMetrics.tps;
                            sessionData.wallTime = (Date.now() - startTime) / 1000;

                            // Lock in exact numbers
                            document.getElementById('metric-prefill').innerText = `${sessionData.promptTps} t/s`;
                            document.getElementById('metric-prefill-tokens').innerText = `${data.usage.prompt_tokens} tokens`;
                            document.getElementById('metric-gen').innerText = `${sessionData.genTps} t/s`;
                            document.getElementById('metric-gen-tokens').innerText = `${data.usage.completion_tokens} tokens`;

                            // Running averages are now updated from the server's
                            // client-agnostic COMPLETION broadcast (see the SSE
                            // handler), not here -- this dashboard's own requests
                            // trigger that same broadcast (server4.js's log-tailing
                            // sees every request hitting llama-server, including
                            // this one), so updating it here too would double-count.

                            // Lock in exact context tokens
                            currentContextTokens = data.usage.prompt_tokens + data.usage.completion_tokens;
                            updateContextUI(currentContextTokens, currentContextLimit);

                            // Prefill now plots live from tpsLoop's per-tick
                            // prefillTps samples (fed by PREFILL_PROGRESS
                            // broadcasts) -- the old "write promptTps into
                            // data[0] here" hack fought that series and was
                            // wiped by the next tick's rebuild anyway.
                        }

                        if (data.choices && data.choices.length > 0) {
                            tokenCount++; totalTokensGenerated++;
                            const delta = data.choices[0].delta;
                            
                            if (delta.reasoning_content) {
                                if (reasoningTokenCount === 0) {
                                    timelineEls.tLbl.classList.remove('hidden');
                                }
                                reasoningTokenCount++;
                                thinkTokenCount++;
                                
                                const currThinkTime = ((Date.now() - startTime) / 1000) - timeToFirstToken;
                                if (currThinkTime > 0.1) {
                                    timelineEls.tLbl.innerHTML = `Think: <span class="val text-gray-200">${currThinkTime.toFixed(1)}s | ${reasoningTokenCount}t | ${(reasoningTokenCount/currThinkTime).toFixed(1)} t/s</span>`;
                                }
                                
                                fullReasoning += delta.reasoning_content;
                                reasoningBox.classList.remove('hidden');
                                reasoningBody.innerText = fullReasoning;
                                reasoningTokens.innerText = `(~${Math.ceil(fullReasoning.length/4)} tokens)`;
                                reasoningBody.scrollTop = reasoningBody.scrollHeight;
                            }
                            if (delta.content) {
                                if (timeToFirstContent === 0) {
                                    // Phase transition: think → answer
                                    currentResponsePhase = 'answer';
                                    timeToFirstContent = ((Date.now() - startTime) / 1000) - timeToFirstToken;
                                    timelineEls.aLbl.classList.remove('hidden');
                                    
                                    if (reasoningTokenCount > 0) {
                                        thinkMetrics = { time: timeToFirstContent.toFixed(1), tokens: reasoningTokenCount, tps: (reasoningTokenCount/timeToFirstContent).toFixed(1) };
                                        timelineEls.tLbl.innerHTML = `Think: <span class="val text-gray-200">${thinkMetrics.time}s | ${thinkMetrics.tokens}t | ${thinkMetrics.tps} t/s</span>`;
                                    }
                                }
                                answerTokenCount++;
                                contentTokenCount++;
                                
                                const currAnsTime = ((Date.now() - startTime) / 1000) - timeToFirstToken - timeToFirstContent;
                                if (currAnsTime > 0.1) {
                                    timelineEls.aLbl.innerHTML = `Answer: <span class="val text-gray-200">${currAnsTime.toFixed(1)}s | ${answerTokenCount}t | ${(answerTokenCount/currAnsTime).toFixed(1)} t/s</span>`;
                                }
                                
                                fullContent += delta.content;
                                
                                if (rawBtn.dataset.mode === 'rendered') {
                                    contentBody.innerHTML = marked.parse(fullContent);
                                } else {
                                    contentBody.innerHTML = `<pre class="text-xs text-gray-300 overflow-x-auto p-3 bg-gray-950 rounded border border-gray-800">${escapeHtml(fullContent)}</pre>`;
                                }
                                rawBtn.dataset.raw = fullContent;
                                rawBtn.classList.remove('hidden');
                            }
                            
                            // Auto scroll only if close to bottom
                            if(chatBox.scrollHeight - chatBox.scrollTop < chatBox.clientHeight + 100) {
                                chatBox.scrollTop = chatBox.scrollHeight;
                            }
                        }
                    } catch (e) {}
                }
            }
        }
        chatContext.push({ role: 'assistant', content: fullContent, reasoning: fullReasoning, timestamp: new Date().toLocaleTimeString(), prefillMetrics, thinkMetrics, answerMetrics, responseMetrics, prefillSamples: activePrefillSamples, templateKwargs: Object.keys(templateKwargs).length > 0 ? templateKwargs : null });
        // Store kwargs on the raw button so the "View Raw" toggle can display
        // them as a red annotation (THINKING OFF, custom kwargs, etc.)
        if (rawBtn && Object.keys(templateKwargs).length > 0) {
            rawBtn.dataset.kwargs = JSON.stringify(templateKwargs);
        }
        // Now that streaming is done and fullContent is final, check whether
        // this response is long enough to collapse -- checking mid-stream
        // would mean the collapse boundary jumping around under the user's
        // eyes while they're still reading the live response.
        applyMessageCollapse(contentBody);
        currentContextTokens = estimatedPromptTokens + totalTokensGenerated;
        // Reset active chart references so pollTelemetry stops feeding them
        responseMetrics = [];
        hwChartInst = null;
        activeTimelineEls = null;
        activePrefillSamples = [];
        saveChatSession(); // Save updated session history

        window.chartEvents.push({ time: Date.now(), label: 'Resp Done', color: '#4ade80', offset: 40 });

        // Stop UI state
        clearInterval(tpsLoop);
        clearInterval(slotsLoop);
        document.getElementById('submit-btn').disabled = false; document.getElementById('abort-btn').classList.add('hidden'); document.getElementById('status-indicator').classList.add('hidden'); inputEl.disabled = false; inputEl.focus();

        // Write to CSV
        try {
            const logPayload = {
                ...sessionData,
                launchCommand: lastLaunchCommand,
                // Full config that actually booted this server (not current GUI
                // state, which can drift) -- lets a later model-select/launch-mode
                // change look up "what did I run last time" and restore it exactly.
                configJson: lastKnownLaunchConfig ? JSON.stringify(lastKnownLaunchConfig) : ''
            };
            await fetch('/api/log', { method: 'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(logPayload) });
        } catch(e) {}
        
    } catch (err) { if(err.name!=='AbortError') contentBody.insertAdjacentHTML('beforeend', `<br>Error: ${escapeHtml(err.message)}`); }
    finally {
        clearInterval(tpsLoop); clearInterval(slotsLoop); abortController = null;
        inputEl.disabled = false; inputEl.focus(); document.getElementById('submit-btn').disabled = false;
        document.getElementById('status-indicator').classList.add('hidden'); document.getElementById('abort-btn').classList.add('hidden');
        document.getElementById('active-ast').removeAttribute('id');
        // Stop pollTelemetry from feeding the completed bubble's chart
        hwChartContainer = null; hwChartCanvas = null; hwChartInst = null;
        activeTimelineEls = null; activePrefillSamples = []; activeGenSamples = [];
        // Reset prompt token counter
        document.getElementById('input-token-count').innerText = '~0 tokens';
    }
}

document.getElementById('submit-btn').addEventListener('click', submitPrompt);
// The Stop button fires abortController.abort(), which rejects the in-flight
// fetch with an AbortError — caught by the try/catch above (err.name==='AbortError'
// is silently swallowed) and the finally block restores the UI.
document.getElementById('abort-btn').addEventListener('click', () => {
    if (abortController) abortController.abort();
});

// --- Multimodal image attachment ---
// Stores base64 data URLs of attached images. Cleared after submission.
let attachedImages = []; // [{ dataUrl, name }]
const attachBtn = document.getElementById('attach-image-btn');
const imageInput = document.getElementById('image-file-input');
if (attachBtn && imageInput) {
    attachBtn.addEventListener('click', () => imageInput.click());
    imageInput.addEventListener('change', () => {
        Array.from(imageInput.files).forEach(file => {
            const reader = new FileReader();
            reader.onload = () => {
                attachedImages.push({ dataUrl: reader.result, name: file.name });
                renderAttachedImageThumbnails();
            };
            reader.readAsDataURL(file);
        });
        imageInput.value = ''; // reset so re-selecting the same file works
    });
}
// Render/remove thumbnails above the textarea
function renderAttachedImageThumbnails() {
    let container = document.getElementById('attached-images');
    if (!container) {
        container = document.createElement('div');
        container.id = 'attached-images';
        container.className = 'flex flex-wrap gap-2 mb-2';
        const ta = document.getElementById('user-prompt');
        ta.parentElement.insertBefore(container, ta);
    }
    container.innerHTML = '';
    attachedImages.forEach((img, i) => {
        const wrap = document.createElement('div');
        wrap.className = 'relative group';
        wrap.innerHTML = `<img src="${img.dataUrl}" class="h-16 w-16 object-cover rounded-lg border border-gray-700" title="${escapeHtml(img.name)}">
            <button type="button" class="absolute -top-1 -right-1 h-4 w-4 rounded-full bg-red-600 text-white text-[10px] leading-4 hover:bg-red-500 opacity-0 group-hover:opacity-100 transition-opacity" title="Remove">✕</button>`;
        wrap.querySelector('button').addEventListener('click', () => {
            attachedImages.splice(i, 1);
            renderAttachedImageThumbnails();
        });
        container.appendChild(wrap);
    });
    if (attachedImages.length === 0) container.remove();
}

// --- Tokens/sec chart x-axis toggle (time-spaced vs evenly-spaced) ---
// `flag` is an object { value: boolean } so the closure reads/writes it directly.
function initTpsChartToggle(btnId, chartGetter, flag, storageKey, isMonitor) {
    const btn = document.getElementById(btnId);
    if (!btn) return;
    const chart = chartGetter();
    if (!chart) return;
    btn.textContent = flag.value ? 'time' : 'cat';
    btn.addEventListener('click', () => {
        const c = chartGetter();
        if (!c) return;
        flag.value = !flag.value;
        localStorage.setItem(storageKey, flag.value);
        c.destroy();
        const canvas = document.getElementById(isMonitor ? 'monitorTpsChart' : 'historyTpsChart');
        if (canvas) {
            if (isMonitor) {
                window.monitorTpsChart = createTpsChart(canvas, flag.value);
                renderMonitorChart();
            } else {
                window.historyTpsChart = createTpsChart(canvas, flag.value);
                renderHistoryChart();
            }
        }
        btn.textContent = flag.value ? 'time' : 'cat';
    });
}

// --- Live token counter on prompt textarea ---
document.getElementById('user-prompt').addEventListener('input', (e) => {
    const est = Math.ceil(e.target.value.length / 4);
    document.getElementById('input-token-count').innerText = `~${est} tokens`;
});

// --- Same estimator, mirrored onto the A/B sweep's test prompt ---
document.getElementById('ab-prompt').addEventListener('input', (e) => {
    const est = Math.ceil(e.target.value.length / 4);
    document.getElementById('ab-prompt-token-count').innerText = `~${est} tokens`;
});

// --- Initialize Context UI ---
updateContextUI(0, document.getElementById('server-ctx').value);
document.getElementById('server-ctx').addEventListener('input', (e) => {
    currentContextLimit = parseInt(e.target.value) || 110000;
    updateContextUI(currentContextTokens, currentContextLimit);
});

// --- Worker Docker Control & Polling Logic ---
let showWorkerLogs = false;
let workerStatusInterval = null;
// workerLogsInterval declared near the top of the file (see comment there) --
// updateSecondNodeVisibility() needs it to exist before this point during page load.

async function updateWorkerStatus() {
    // SSH-polls the remote worker's docker compose status. It runs on a 5s
    // interval regardless of anything else in the UI -- the !rpcEnabled check
    // right below is what makes this a no-op (badge -> DISABLED) whenever RPC
    // isn't actually turned on, rather than a separate mode-based guard here.
    const workerSsh = document.getElementById('worker-ssh').value.trim();
    const rpcEnabled = document.getElementById('rpc-toggle').checked;
    const badge = document.getElementById('worker-status-badge');

    if (!workerSsh || !rpcEnabled) {
        badge.className = 'px-1.5 py-0.5 rounded text-[9px] font-semibold bg-gray-850 text-gray-500';
        badge.innerText = 'DISABLED';
        return;
    }
    
    try {
        const res = await fetch('/api/worker/status', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ worker_ssh: workerSsh })
        });
        const data = await res.json();
        
        // Only update if not currently transitioning (animating pulse)
        if (!badge.classList.contains('animate-pulse')) {
            const startBtn = document.getElementById('btn-worker-start');
            const tsContainer = document.getElementById('tensor-split-container');
            if (data.status === 'running') {
                badge.className = 'px-1.5 py-0.5 rounded text-[9px] font-semibold bg-green-900/20 border border-green-800 text-green-400';
                badge.innerText = 'RUNNING';
                tsContainer.classList.remove('hidden');
                startBtn.disabled = true;
                startBtn.classList.add('opacity-50', 'cursor-not-allowed');
            } else if (data.status === 'stopped') {
                badge.className = 'px-1.5 py-0.5 rounded text-[9px] font-semibold bg-yellow-900/20 border border-yellow-800 text-yellow-400';
                badge.innerText = 'STOPPED';
                tsContainer.classList.add('hidden');
                startBtn.disabled = false;
                startBtn.classList.remove('opacity-50', 'cursor-not-allowed');
            } else if (data.status === 'offline') {
                badge.className = 'px-1.5 py-0.5 rounded text-[9px] font-semibold bg-red-900/20 border border-red-800 text-red-400';
                badge.innerText = 'OFFLINE';
                tsContainer.classList.add('hidden');
                startBtn.disabled = false;
                startBtn.classList.remove('opacity-50', 'cursor-not-allowed');
            }
        }
    } catch (e) {
        if (!badge.classList.contains('animate-pulse')) {
            badge.className = 'px-1.5 py-0.5 rounded text-[9px] font-semibold bg-red-900/20 border border-red-800 text-red-400';
            badge.innerText = 'ERROR';
        }
    }
}

async function fetchWorkerLogs() {
    if (!showWorkerLogs) return;
    const workerSsh = document.getElementById('worker-ssh').value.trim();
    const rpcEnabled = document.getElementById('rpc-toggle').checked;
    if (!workerSsh || !rpcEnabled) return;
    try {
        const res = await fetch('/api/worker/logs', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ worker_ssh: workerSsh })
        });
        const data = await res.json();
        document.getElementById('worker-logs-pre').innerText = data.logs || 'No logs returned.';
    } catch (e) {
        document.getElementById('worker-logs-pre').innerText = `Failed to fetch logs: ${e.message}`;
    }
}

document.getElementById('btn-worker-start').addEventListener('click', async () => {
    const workerSsh = document.getElementById('worker-ssh').value.trim();
    if (!workerSsh) return;
    const badge = document.getElementById('worker-status-badge');
    badge.className = 'px-1.5 py-0.5 rounded text-[9px] font-semibold bg-yellow-900/20 border border-yellow-800 text-yellow-400 animate-pulse';
    badge.innerText = 'STARTING...';
    try {
        const res = await fetch('/api/worker/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ worker_ssh: workerSsh })
        });
        const data = await res.json();
        badge.classList.remove('animate-pulse');
        if (data.success) {
            await updateWorkerStatus();
            if (showWorkerLogs) fetchWorkerLogs();
        } else {
            badge.className = 'px-1.5 py-0.5 rounded text-[9px] font-semibold bg-red-900/20 border border-red-800 text-red-400';
            badge.innerText = 'START FAILED';
            document.getElementById('worker-logs-pre').innerText = `Start failed:\n${data.error}\n${data.stderr}`;
        }
    } catch (e) {
        badge.classList.remove('animate-pulse');
        badge.className = 'px-1.5 py-0.5 rounded text-[9px] font-semibold bg-red-900/20 border border-red-800 text-red-400';
        badge.innerText = 'START FAILED';
        document.getElementById('worker-logs-pre').innerText = `Start failed: ${e.message}`;
    }
});

document.getElementById('btn-worker-stop').addEventListener('click', async () => {
    const workerSsh = document.getElementById('worker-ssh').value.trim();
    if (!workerSsh) return;
    const badge = document.getElementById('worker-status-badge');
    badge.className = 'px-1.5 py-0.5 rounded text-[9px] font-semibold bg-yellow-900/20 border border-yellow-800 text-yellow-400 animate-pulse';
    badge.innerText = 'STOPPING...';
    try {
        const res = await fetch('/api/worker/stop', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ worker_ssh: workerSsh })
        });
        const data = await res.json();
        badge.classList.remove('animate-pulse');
        if (data.success) {
            await updateWorkerStatus();
        } else {
            badge.className = 'px-1.5 py-0.5 rounded text-[9px] font-semibold bg-red-900/20 border border-red-800 text-red-400';
            badge.innerText = 'STOP FAILED';
        }
    } catch (e) {
        badge.classList.remove('animate-pulse');
        badge.className = 'px-1.5 py-0.5 rounded text-[9px] font-semibold bg-red-900/20 border border-red-800 text-red-400';
        badge.innerText = 'STOP FAILED';
    }
});

document.getElementById('btn-worker-logs-toggle').addEventListener('click', () => {
    showWorkerLogs = !showWorkerLogs;
    const body = document.getElementById('worker-logs-body');
    const icon = document.getElementById('worker-logs-icon');
    if (showWorkerLogs) {
        body.style.maxHeight = '40rem';
        icon.innerHTML = '&#9660;';
        fetchWorkerLogs();
        workerLogsInterval = setInterval(fetchWorkerLogs, 3000);
    } else {
        body.style.maxHeight = '0';
        icon.innerHTML = '&#9654;';
        clearInterval(workerLogsInterval);
    }
});

// --- Master Logs Logic ---
let showMasterLogs = false;
let masterLogsInterval = null;

async function fetchMasterLogs() {
    if (!showMasterLogs) return;
    try {
        const res = await fetch('/api/master/logs');
        const data = await res.json();
        const preEl = document.getElementById('master-logs-pre');
        const wasAtBottom = (preEl.scrollHeight - preEl.scrollTop - preEl.clientHeight) < 80;
        preEl.innerText = data.logs || 'No logs returned.';
        // Auto-scroll to bottom if user was near bottom, or on first load
        if (wasAtBottom || data.logs.includes('No logs')) {
            preEl.scrollTop = preEl.scrollHeight;
        }
    } catch (e) {
        document.getElementById('master-logs-pre').innerText = `Failed to fetch logs: ${e.message}`;
    }
}

document.getElementById('btn-master-logs-toggle').addEventListener('click', () => {
    showMasterLogs = !showMasterLogs;
    const body = document.getElementById('master-logs-body');
    const icon = document.getElementById('master-logs-icon');
    if (showMasterLogs) {
        body.style.maxHeight = '40rem';
        icon.innerHTML = '&#9660;';
        fetchMasterLogs();
        masterLogsInterval = setInterval(fetchMasterLogs, 3000);
    } else {
        body.style.maxHeight = '0';
        icon.innerHTML = '&#9654;';
        clearInterval(masterLogsInterval);
    }
});

// --- RPC Worker: optional, off by default, independent of local device
// selection (the master always launches natively -- see server4.js
// resolveLaunchCommand). Enabling it claims the "second compute target" slot
// for the remote worker, so GPU B is forced back to "None": the split stays
// exactly 2-way (this machine vs. the worker) rather than trying to support a
// 3-way local-A + local-B + worker split, which nothing here (the tensor-split
// slider, monitor.py's local_second_gpu/worker_ssh handling) is built for.
function applyRpcToggleUI() {
    const enabled = document.getElementById('rpc-toggle').checked;
    const controls = document.getElementById('worker-ssh-controls');
    controls.classList.toggle('opacity-50', !enabled);
    controls.querySelectorAll('button, input, select').forEach(el => el.disabled = !enabled);

    const selB = document.getElementById('device-select-b');
    const manualB = document.getElementById('device-manual-b');
    selB.disabled = enabled;
    manualB.disabled = enabled;
    if (enabled) { selB.value = ''; manualB.value = ''; }

    if (enabled) {
        updateWorkerStatus();
    } else {
        document.getElementById('worker-status-badge').className = 'px-1.5 py-0.5 rounded text-[9px] font-semibold bg-gray-850 text-gray-500';
        document.getElementById('worker-status-badge').innerText = 'DISABLED';
    }
    updateSecondNodeVisibility();
}
document.getElementById('rpc-toggle').addEventListener('change', () => {
    applyRpcToggleUI();
    refreshCommandPreview();
    snapToLastUsedConfig(); // transport (Local vs WiFi/TB4) changed
});

// Worker Logs / Worker RAM / the CPU-chart "Worker" legend row only make sense
// when a real remote RPC worker is configured -- meaningless for a local
// second GPU (both GPUs share this one host's RAM/CPU/log stream, there's no
// second host) and meaningless when RPC isn't actually enabled.
function updateSecondNodeVisibility() {
    const showWorkerSecondary = document.getElementById('rpc-toggle').checked;
    document.getElementById('worker-logs-container').classList.toggle('hidden', !showWorkerSecondary);
    document.getElementById('worker-ram-container').classList.toggle('hidden', !showWorkerSecondary);
    document.querySelectorAll('.node-b-cpu-row').forEach(el => el.classList.toggle('hidden', !showWorkerSecondary));
    if (!showWorkerSecondary && workerLogsInterval) { clearInterval(workerLogsInterval); workerLogsInterval = null; }
}

// Tensor split only makes sense with an actual second compute target to split
// across: a real second local GPU (deviceB set and different from deviceA) or
// an RPC worker -- these two cases can't overlap (see applyRpcToggleUI).
// RPC's own visibility here is driven by updateWorkerStatus() instead (only
// shown once the remote worker is confirmed actually running), so this only
// touches the container for the local-split case, to avoid fighting that.
// Node A/B labels follow the same split: "GPU A"/"GPU B" for a local pair,
// "Local"/"Worker" once RPC is in the picture.
function updateTensorSplitVisibility() {
    const deviceA = document.getElementById('device-select-a').value || document.getElementById('device-manual-a').value.trim();
    const deviceB = document.getElementById('device-select-b').value || document.getElementById('device-manual-b').value.trim();
    const localSplit = !!(deviceA && deviceB && deviceA !== deviceB);
    const rpcEnabled = document.getElementById('rpc-toggle').checked;
    if (!rpcEnabled) {
        document.getElementById('tensor-split-container').classList.toggle('hidden', !localSplit);
    }
    document.querySelectorAll('.node-a-label').forEach(el => { el.textContent = rpcEnabled ? 'Local' : 'GPU A'; });
    document.querySelectorAll('.node-b-label').forEach(el => { el.textContent = rpcEnabled ? 'Worker' : 'GPU B'; });
}

function renderDeviceOptions(devices) {
    const selA = document.getElementById('device-select-a');
    const selB = document.getElementById('device-select-b');
    selA.innerHTML = ''; selB.innerHTML = '';
    // GPU B defaults to "None" -- a single detected device (no eGPU/second GPU
    // connected) should mean a plain, unsplit single-GPU launch, not both
    // dropdowns landing on the same lone device (see resolveLaunchCommand in
    // server4.js, which now treats deviceA === deviceB as "no split configured"
    // too, but this makes "no second device" an explicit, selectable state
    // instead of relying on that as an implicit fallback).
    const noneOpt = document.createElement('option');
    noneOpt.value = ''; noneOpt.textContent = 'None (single GPU)';
    selB.appendChild(noneOpt);
    for (const d of devices) {
        const label = `${d.id} — ${d.description} (${d.freeMib} MiB free)`;
        for (const sel of [selA, selB]) {
            const opt = document.createElement('option');
            opt.value = d.id; opt.textContent = label;
            sel.appendChild(opt);
        }
    }
    // Default to the first two *distinct physical* discrete GPUs.
    // Two things a naive "first two discrete entries" would get wrong:
    // - An integrated GPU (e.g. an Intel iGPU alongside a laptop's dGPU) is
    //   almost never what you want in an A/B split by default, and can even
    //   report a deceptively large "VRAM" total via UMA/shared memory, so
    //   size isn't a reliable signal either.
    // - A build that supports more than one backend for the same card (e.g.
    //   this repo's CUDA+Vulkan build) lists that ONE physical GPU twice --
    //   confirmed live: an RTX 4090 shows up as both "CUDA0" and "Vulkan1".
    //   Taking the first two list entries picked CUDA0 + Vulkan1 (two paths
    //   to the SAME card) over CUDA0 + the actual second GPU (an eGPU on
    //   Vulkan2), silently dropping the eGPU from the launch entirely.
    // Dedupe by description (the physical card's name), preferring whichever
    // entry is CUDA-backed for a card that appears on both -- CUDA is the
    // faster native path, and picking it is the whole reason a CUDA+Vulkan
    // build exists over a Vulkan-only one. User can still override via the
    // dropdowns regardless of what's picked here.
    const discrete = devices.filter(d => !/intel|iris|uhd graphics/i.test(d.description));
    const byPhysicalGpu = new Map();
    for (const d of discrete) {
        const existing = byPhysicalGpu.get(d.description);
        if (!existing || (!/^CUDA/.test(existing.id) && /^CUDA/.test(d.id))) {
            byPhysicalGpu.set(d.description, d);
        }
    }
    const distinctGpus = [...byPhysicalGpu.values()];
    if (distinctGpus.length > 1) {
        selA.value = distinctGpus[0].id;
        selB.value = distinctGpus[1].id;
    }
    // 0 or 1 distinct physical GPUs found: selA defaults to its first option
    // (or stays empty), selB defaults to "None" (the option we just inserted
    // first) -- exactly the single-GPU/no-eGPU state, with no extra code needed.
}

// Runs automatically on page load (once the Build selector is populated, see
// devicesDetectedPromise) and again on the Build selector's change handler --
// different builds can expose different devices for the same physical GPUs
// (e.g. a CUDA+Vulkan build shows an extra native CUDA device for an NVIDIA
// card that a Vulkan-only build of the same repo can only reach through
// Vulkan), so switching builds re-runs detection automatically rather than
// leaving a stale device list from whichever build was previously selected.
// No manual trigger -- GPU hotplug isn't supported by the kernel, so the
// device list can't change without a reboot anyway.
async function detectDevices() {
    const statusEl = document.getElementById('device-detect-status');
    const dropdownRow = document.getElementById('device-dropdown-row');
    statusEl.classList.remove('hidden');
    statusEl.textContent = 'Detecting...';
    try {
        const buildId = document.getElementById('build-select').value;
        const res = await fetch(`/api/devices?build=${encodeURIComponent(buildId)}`);
        const data = await res.json();
        if (data.devices && data.devices.length > 0) {
            renderDeviceOptions(data.devices);
            dropdownRow.classList.remove('hidden');
            document.getElementById('device-manual-row').classList.add('hidden');
            statusEl.classList.add('hidden');
        } else {
            dropdownRow.classList.add('hidden');
            document.getElementById('device-manual-row').classList.remove('hidden');
            statusEl.textContent = `Detection failed${data.error ? ` (${data.error})` : ''} — enter device ids manually below.`;
        }
    } catch (e) {
        dropdownRow.classList.add('hidden');
        document.getElementById('device-manual-row').classList.remove('hidden');
        statusEl.textContent = `Detection failed (${e.message}) — enter device ids manually below.`;
    }
    // renderDeviceOptions() always defaults GPU B to a real device when 2+ are
    // found, regardless of RPC state -- re-assert the "RPC forces GPU B to
    // None" invariant in case this (re-)detection landed after the user had
    // already turned RPC on (e.g. toggled it before a Build-change re-detect
    // resolved).
    applyRpcToggleUI();
    refreshCommandPreview();
}

// Initialize polling intervals
workerStatusInterval = setInterval(updateWorkerStatus, 5000);
updateWorkerStatus();
// Sets the initial worker-logs/-ram/CPU-row visibility to match rpc-toggle's
// default (off) -- HTML's static classes already match this, this just keeps
// the two in sync from one place. applyConfigToUI() calls this itself too,
// for whenever a saved profile with RPC enabled restores after this runs.
applyRpcToggleUI();

// --- Hardware Polling ---
let workerBaseVram = 0;
let telemetryInterval = null;
let workerStatsMissingSince = null;
// Item 14: Telemetry fetch backoff + failure tracking + recovery notification
let telemetryConsecutiveFailures = 0;
let telemetryHadFailures = false; // track if we ever had failures in this session
const TELEMETRY_BASE_INTERVAL = 1000;
const TELEMETRY_MAX_BACKOFF = 10000; // cap at 10s

// monitor.py shells out to nvidia-smi/amdgpu_top per call, which can take
// several real seconds under heavy GPU/CPU load (confirmed live at 5.5s+
// during an active generation). Without a timeout, a slow response just made
// this poll slow; without this in-flight guard, the interval below (fires
// every pollingRate ms, default 1s) would pile up multiple concurrent
// requests on top of an already-slow monitor.py, making it slower still.
let telemetryPollInFlight = false;
let lastPolledTelemetry = null; // { t, stats } -- see its own assignment below for why
async function pollTelemetry() {
    if (telemetryPollInFlight) return;
    telemetryPollInFlight = true;
    try {
        // Reset consecutive failure counter on success
        const wasFailing = telemetryConsecutiveFailures > 0;
        telemetryConsecutiveFailures = 0;
        // Recovery notification: if we were failing, briefly show "recovered" then hide banner
        const banner = document.getElementById('telemetry-failure-banner');
        if (wasFailing && telemetryHadFailures && banner) {
            banner.className = 'flex items-center gap-2 px-3 py-2 rounded-lg bg-green-900/20 border border-green-700/50 text-green-300 text-xs font-mono';
            banner.querySelector('span:last-child').textContent = 'Telemetry recovered after downtime.';
            setTimeout(() => { banner.style.display = 'none'; telemetryHadFailures = false; }, 3000);
        } else if (banner) {
            banner.style.display = 'none';
        }
        // "worker" telemetry slot means one of two things, mutually exclusive
        // by construction (enabling RPC forces GPU B back to "None" -- see
        // applyRpcToggleUI): a real second local GPU (monitor.py
        // get_amd_stats()), or a remote RPC worker over SSH. monitor.py's
        // do_POST picks one or the other from this same body, so sending both
        // would silently drop the RPC worker's telemetry.
        const localSecondGpu = !!(document.getElementById('device-select-b').value || document.getElementById('device-manual-b').value.trim());
        const rpcEnabled = !localSecondGpu && document.getElementById('rpc-toggle').checked;
        // Single-poller architecture: the dashboard SERVER polls monitor.py at
        // the selected rate (one nvidia-smi/amdgpu_top shellout per tick,
        // total) and this just reads its cache -- the sidebar, the omni
        // recorder, and the charts all consume the same stream now.
        const res = await fetch('/api/telemetry/latest', { signal: AbortSignal.timeout(10000) });
        const wrapper = await res.json();
        const stats = wrapper.stats || {};

        // monitor.py always queries nvidia-smi into the "master" slot and
        // amdgpu_top into the "worker" slot, regardless of which physical
        // device the user assigned to GPU A vs GPU B in the launch config --
        // those two things were completely unlinked, so every telemetry card
        // showed the NVIDIA card as "Master"/GPU A even when the user had
        // picked it as GPU B. Detect which vendor is actually in the GPU A
        // dropdown and swap the two stat objects to match, so everything
        // downstream (which already just reads stats.master/stats.worker)
        // lines up with what the user actually selected. Only possible when
        // device detection succeeded (the dropdown's option text carries the
        // vendor name); manual device-id entry has no vendor info to go on,
        // so it's left as the historical nvidia=master default in that case.
        if (localSecondGpu && stats.worker) {
            const gpuASelect = document.getElementById('device-select-a');
            const gpuASelectedText = (gpuASelect && gpuASelect.selectedOptions[0]) ? gpuASelect.selectedOptions[0].textContent : '';
            if (/amd|radeon/i.test(gpuASelectedText)) {
                const tmp = stats.master; stats.master = stats.worker; stats.worker = tmp;
            }
        }

        // Guard: if the monitor didn't return master data at all, bail out
        // cleanly instead of throwing partway through a bunch of DOM writes.
        if (!stats || !stats.master) {
            document.getElementById('worker-status-badge').innerText = 'NO DATA';
            return;
        }

        // Cached for Monitor's rolling omni graph (see renderSessionOmniPreview)
        // to fill in the idle lulls between requests -- GPU power/temp/util
        // don't stop existing just because nothing's generating, but the
        // per-request sample buffer (activeRequestSamples) only accumulates
        // while a request is actually in flight, so without this the graph
        // had real data during generation and a dead gap in between, making
        // distant timestamps jump straight from one cluster of points to the
        // next instead of a continuous idle line.
        lastPolledTelemetry = { t: Date.now(), stats };
        if (stats.master?.gpu_name) omniGpuA = shortGpuName(stats.master.gpu_name, 'GPU A');
        if (stats.worker?.gpu_name) omniGpuB = shortGpuName(stats.worker.gpu_name, 'GPU B');
        
        let masterPwr = 0, masterTemp = 0, workerPwr = 0, workerTemp = 0;

        {
            currentVramSnapshot = stats.master.vram_used;
            sessionData.gpuUtil = stats.master.gpu_util; sessionData.gpuPwr = stats.master.gpu_pwr;
            sessionData.cpuUtil = stats.master.cpu_util; sessionData.ramUsage = stats.master.process_ram ?? stats.master.ram_used;
            sessionData.masterGpuTemp = stats.master.gpu_temp ?? 0;
            sessionData.masterCpuTemp = stats.master.cpu_temp ?? 0;
            masterPwr = stats.master.gpu_pwr;
            masterTemp = stats.master.gpu_temp;

            // Split VRAM Bar Master -- guarded against missing/zero vram_total
            // (this is what was previously showing a "full" bar next to "0 MB":
            // dividing by an undefined/0 total produced NaN/Infinity widths)
            const processVram = stats.master.process_vram ?? stats.master.vram_used;
            const vramTotal = stats.master.vram_total;
            const hasVramTotal = isNum(vramTotal) && vramTotal > 0;
            const wPct = hasVramTotal && masterBaseVram > 0 ? safeRatioPct(masterBaseVram, vramTotal) : 0;
            const cPct = hasVramTotal
                ? (masterBaseVram > 0 ? safeRatioPct(Math.max(processVram - masterBaseVram, 0), vramTotal) : safeRatioPct(processVram, vramTotal))
                : 0;
            const bgVram = Math.max((stats.master.vram_used ?? 0) - (processVram ?? 0), 0);
            const bgVramPct = hasVramTotal ? safeRatioPct(bgVram, vramTotal) : 0;
            
            document.getElementById('master-vram-text').innerText = hasVramTotal
                ? `${fmtUnit(stats.master.vram_used, ' MB')} (Llama: ${fmtUnit(processVram, ' MB')}, Sys: ${fmtUnit(bgVram, ' MB')})`
                : `-- MB (Llama: ${fmtUnit(processVram, ' MB')}, Sys: --)`;
            document.getElementById('master-vram-weights').style.width = `${wPct}%`;
            document.getElementById('master-vram-ctx').style.width = `${cPct}%`;
            document.getElementById('master-vram-bg').style.width = `${bgVramPct}%`;

            // RAM Bar Master (Process vs Background) -- same guard pattern
            const processRam = sessionData.ramUsage;
            const totalRamUsed = stats.master.ram_used;
            const ramTotal = stats.master.ram_total;
            const hasRamTotal = isNum(ramTotal) && ramTotal > 0;
            const bgRam = Math.max((totalRamUsed ?? 0) - (processRam ?? 0), 0);
            const processRamPct = hasRamTotal ? safeRatioPct(processRam, ramTotal) : 0;
            const bgRamPct = hasRamTotal ? safeRatioPct(bgRam, ramTotal) : 0;
            
            document.getElementById('master-ram-text').innerText = hasRamTotal
                ? `${fmtUnit(totalRamUsed, ' MB')} (Llama: ${fmtUnit(processRam, ' MB')}, Sys: ${fmtUnit(bgRam, ' MB')})`
                : `-- MB (Llama: ${fmtUnit(processRam, ' MB')}, Sys: --)`;
            document.getElementById('master-ram-bar').style.width = `${processRamPct}%`;
            document.getElementById('master-ram-bg').style.width = `${bgRamPct}%`;

            // Net Throughput Math
            const currentBytes = stats.master.net_bytes;
            if (isNum(currentBytes) && lastNetBytes > 0) {
                const mbs = (currentBytes - lastNetBytes) / 1_048_576; // True MB/s
                document.getElementById('current-net').innerHTML = `${mbs.toFixed(1)}<span class="text-[10px] text-gray-500 ml-1">MB/s</span>`;
                sessionData.netThroughput = mbs.toFixed(1); // logs peak or last
                netHistory.push({ time: Date.now(), mbps: mbs }); if(netHistory.length > 30) netHistory.shift();
                netChart.data.labels = netHistory.map(h => h.time); netChart.data.datasets[0].data = netHistory.map(h => h.mbps); netChart.update('none');
                // Full history for expand modal
                netHistoryFull.push({ time: new Date().toLocaleTimeString(), value: mbs });
                if (netHistoryFull.length > 200) netHistoryFull.shift();
                refreshExpandedChartLive();
            }
            if (isNum(currentBytes)) lastNetBytes = currentBytes;
        }
        
        // `gpu_util !== undefined` alone isn't a reliable "is this real data" check --
        // monitor.py's Offline/unreachable fallback dict (SSH failed, or amdgpu_top
        // failed) still sets gpu_util: 0, which is defined. Without also checking the
        // error flags, an unreachable RPC worker (rpc-toggle checked but nothing
        // actually running) rendered a flat "worker" line on every chart at 0 instead
        // of no line at all.
        const workerDataIsReal = !!stats.worker && !stats.worker.nvidia_smi_error && !stats.worker.amdgpu_top_error;
        const workerReporting = workerDataIsReal && (rpcEnabled || localSecondGpu);
        if (workerReporting) {
            workerStatsMissingSince = null;
            workerPwr = stats.worker.gpu_pwr;
            workerTemp = stats.worker.gpu_temp;

            document.getElementById('worker-vram-container').classList.remove('hidden');
            // RAM sub-panel stays hidden for a local second GPU regardless (both
            // GPUs share one CPU/RAM pool on this host) -- only a real remote
            // RPC worker has its own separate RAM to report.
            if (!localSecondGpu) document.getElementById('worker-ram-container').classList.remove('hidden');

            if (!workerBaseVram && stats.worker.vram_used > 500 && isModelLoaded) workerBaseVram = stats.worker.process_vram ?? stats.worker.vram_used; // capture base after load

            const workerProcessVram = stats.worker.process_vram ?? stats.worker.vram_used;
            const workerVramTotal = stats.worker.vram_total;
            const hasWorkerVramTotal = isNum(workerVramTotal) && workerVramTotal > 0;
            const wPct = hasWorkerVramTotal && workerBaseVram > 0 ? safeRatioPct(workerBaseVram, workerVramTotal) : 0;
            const cPct = hasWorkerVramTotal
                ? (workerBaseVram > 0 ? safeRatioPct(Math.max(workerProcessVram - workerBaseVram, 0), workerVramTotal) : safeRatioPct(workerProcessVram, workerVramTotal))
                : 0;
            const workerBgVram = Math.max((stats.worker.vram_used ?? 0) - (workerProcessVram ?? 0), 0);
            const workerBgVramPct = hasWorkerVramTotal ? safeRatioPct(workerBgVram, workerVramTotal) : 0;

            document.getElementById('worker-vram-text').innerText = hasWorkerVramTotal
                ? `${fmtUnit(stats.worker.vram_used, ' MB')} (Llama: ${fmtUnit(workerProcessVram, ' MB')}, Sys: ${fmtUnit(workerBgVram, ' MB')})`
                : `-- MB (Llama: ${fmtUnit(workerProcessVram, ' MB')}, Sys: --)`;
            document.getElementById('worker-vram-weights').style.width = `${wPct}%`;
            document.getElementById('worker-vram-ctx').style.width = `${cPct}%`;
            document.getElementById('worker-vram-bg').style.width = `${workerBgVramPct}%`;

            const workerRamUsed = stats.worker.process_ram ?? stats.worker.ram_used;
            const workerRamTotal = stats.worker.ram_total;
            const hasWorkerRamTotal = isNum(workerRamTotal) && workerRamTotal > 0;
            const ramPct = hasWorkerRamTotal ? safeRatioPct(workerRamUsed, workerRamTotal) : 0;
            const workerBgRam = Math.max((stats.worker.ram_used ?? 0) - (workerRamUsed ?? 0), 0);
            document.getElementById('worker-ram-text').innerText = hasWorkerRamTotal
                ? `${fmtUnit(stats.worker.ram_used, ' MB')} (Llama: ${fmtUnit(workerRamUsed, ' MB')}, Sys: ${fmtUnit(workerBgRam, ' MB')})`
                : `-- MB (Llama: ${fmtUnit(workerRamUsed, ' MB')}, Sys: --)`;
            document.getElementById('worker-ram-bar').style.width = `${ramPct}%`;
            document.getElementById('worker-ram-bg').style.width = `${hasWorkerRamTotal ? safeRatioPct(workerBgRam, workerRamTotal) : 0}%`;

            sessionData.workerGpuUtil = stats.worker.gpu_util;
            sessionData.workerGpuPwr = workerPwr;
            sessionData.workerVram = stats.worker.vram_used;
            sessionData.workerRam = workerRamUsed;
            sessionData.workerGpuTemp = stats.worker.gpu_temp ?? 0;
            sessionData.workerCpuTemp = stats.worker.cpu_temp ?? 0;
        } else {
            document.getElementById('worker-vram-container').classList.add('hidden');
            document.getElementById('worker-ram-container').classList.add('hidden');
            if (rpcEnabled && !workerStatsMissingSince) workerStatsMissingSince = Date.now();
        }

        // If RPC is enabled and the worker docker container is reported
        // "RUNNING" but stats have been missing for a while, surface that
        // distinctly instead of silently showing blank cards -- this is
        // the monitor.py <-> worker-node stats path, separate from the
        // docker start/stop path, and the two can disagree.
        const wBadge = document.getElementById('worker-status-badge');
        if (rpcEnabled && !workerReporting && workerStatsMissingSince && (Date.now() - workerStatsMissingSince > 8000) && wBadge.innerText === 'RUNNING') {
            wBadge.title = 'Worker container is up but monitor.py is not receiving GPU stats from it.';
        }

        // Update Temp, Power, CPU Charts and Labels
        const mGpu = stats.master.gpu_name || 'GPU';
        const wGpu = (stats.worker && stats.worker.gpu_name) ? stats.worker.gpu_name : 'GPU';
        
        document.querySelectorAll('.master-gpu-model').forEach(el => el.innerText = `(${mGpu})`);
        document.querySelectorAll('.worker-gpu-model').forEach(el => el.innerText = `(${wGpu})`);
        
        const mCpu = stats.master.cpu_name || 'CPU';
        const wCpu = (stats.worker && stats.worker.cpu_name) ? stats.worker.cpu_name : 'CPU';
        document.querySelectorAll('.master-cpu-model').forEach(el => el.innerText = `(${mCpu})`);
        document.querySelectorAll('.worker-cpu-model').forEach(el => el.innerText = `(${wCpu})`);
        
        // GPU Throttling UI Indicator — Item 9/16: granular throttle_reasons
        // Thermal reasons → temp card red pulse + badges. Power reasons (power cap,
        // power brake) → power card red pulse + badges. Each category only reacts
        // to its own graph, not the other's.
        const thermalReasons = new Set(['hw_thermal_slowdown', 'sw_thermal_slowdown']);
        const powerReasons = new Set(['sw_power_cap', 'hw_power_brake_slowdown']);
        const mReasons = stats.master.throttle_reasons || [];
        const wReasons = (stats.worker && stats.worker.throttle_reasons) || [];
        const allReasons = [...mReasons, ...wReasons];
        const hasThermal = allReasons.some(r => thermalReasons.has(r));
        const hasPower = allReasons.some(r => powerReasons.has(r));
        const tempCard = document.getElementById('card-gpu-temp');
        if (hasThermal) {
            tempCard.classList.add('bg-red-900/30', 'border-red-500/50', 'animate-pulse');
            tempCard.classList.remove('bg-gray-800/50', 'border-gray-700/50');
        } else {
            tempCard.classList.remove('bg-red-900/30', 'border-red-500/50', 'animate-pulse');
            tempCard.classList.add('bg-gray-800/50', 'border-gray-700/50');
        }
        const pwrCard = document.getElementById('card-gpu-pwr');
        if (hasPower) {
            pwrCard.classList.add('bg-red-900/30', 'border-red-500/50', 'animate-pulse');
            pwrCard.classList.remove('bg-gray-800/50', 'border-gray-700/50');
        } else {
            pwrCard.classList.remove('bg-red-900/30', 'border-red-500/50', 'animate-pulse');
            pwrCard.classList.add('bg-gray-800/50', 'border-gray-700/50');
        }

        // Render throttle badges — thermal reasons in #throttle-badges (temp card),
        // power reasons in #throttle-badges-pwr (power card). Item 16.
        // Deduplicate across BOTH master and worker: same reason shown once with combined tooltip
        const badgeContainer = document.getElementById('throttle-badges');
        const badgeContainerPwr = document.getElementById('throttle-badges-pwr');
        const throttleLabels = {
            'hw_thermal_slowdown': 'HW Thermal',
            'sw_thermal_slowdown': 'SW Thermal',
            'sw_power_cap': 'SW Power Cap',
            'hw_power_brake_slowdown': 'HW Power Brake'
        };
        // What each badge actually MEANS for a benchmark reading -- the labels
        // alone don't say whether a lit badge invalidates a measurement.
        const throttleHelp = {
            'hw_thermal_slowdown': 'The GPU itself cut clocks to protect the die. Any timing taken while this is lit is heat-limited and NOT comparable to a cool run.',
            'sw_thermal_slowdown': 'The driver reduced clocks because of temperature. Timings taken while lit are heat-limited and not comparable to a cool run.',
            'sw_power_cap': 'Clocks limited by the POWER cap, not heat. On a power-limited laptop GPU this is normally lit continuously and is expected -- it is not a reason to discard a measurement.',
            'hw_power_brake_slowdown': 'An external power limit (brake) is cutting clocks -- e.g. insufficient supply, not temperature.'
        };
        // Map reason -> Set<'master'|'worker'>
        const reasonMap = new Map();
        for (const r of mReasons) {
            if (!reasonMap.has(r)) reasonMap.set(r, new Set());
            reasonMap.get(r).add('master');
        }
        for (const r of wReasons) {
            if (!reasonMap.has(r)) reasonMap.set(r, new Set());
            reasonMap.get(r).add('worker');
        }

        // Always render all 4 badges (2 thermal, 2 power), toggling each between
        // gray/inactive and lit-up/active -- previously only active badges were
        // rendered at all, with the container's display toggled none/flex around
        // them. min-height on the container doesn't apply to a display:none
        // element, so that container collapsed to zero height between throttle
        // events and sprang back when one fired, bouncing the graph below it on
        // every transition. Keeping a constant 4-badge layout means the card's
        // height never changes regardless of throttle state.
        let badgeHTML = '';
        let badgeHTMLPwr = '';
        for (const [reason, label] of Object.entries(throttleLabels)) {
            const isThermal = thermalReasons.has(reason);
            const sources = reasonMap.get(reason);
            const active = !!sources;
            const activeClasses = isThermal
                ? 'bg-red-900/40 text-red-300 border border-red-500/50'
                : 'bg-yellow-900/30 text-yellow-300 border border-yellow-600/50';
            const inactiveClasses = 'bg-gray-800/40 text-gray-600 border border-gray-700/50';
            const help = throttleHelp[reason] || '';
            const tooltip = active
                ? `${[...sources].join(' + ').replace(/^./, c => c.toUpperCase())}: ${label} -- ACTIVE. ${help}`
                : `${label}: not active. ${help}`;
            const badge = `<span class="px-1.5 py-0.5 text-[9px] font-semibold rounded ${active ? activeClasses : inactiveClasses}" title="${tooltip}">${label}</span>`;
            if (isThermal) badgeHTML += badge; else badgeHTMLPwr += badge;
        }
        badgeContainer.innerHTML = badgeHTML;
        badgeContainerPwr.innerHTML = badgeHTMLPwr;

        if (workerReporting) {
            document.getElementById('current-temp').innerHTML = `<span class="text-yellow-400">${fmtUnit(masterTemp, '°C')}</span> <span class="text-gray-500">/</span> <span class="text-red-400">${fmtUnit(workerTemp, '°C')}</span>`;
            document.getElementById('current-pwr').innerHTML = `<span class="text-yellow-400">${fmtUnit(masterPwr, 'W')}</span> <span class="text-gray-500">/</span> <span class="text-red-400">${fmtUnit(workerPwr, 'W')}</span>`;
            document.getElementById('current-cpu').innerHTML = `<span class="text-yellow-400">${fmtPct(stats.master.cpu_util)}</span> <span class="text-gray-500">/</span> <span class="text-red-400">${fmtPct(stats.worker.cpu_util)}</span>`;
            document.getElementById('current-gpu-util').innerHTML = `<span class="text-yellow-400">${fmtPct(stats.master.gpu_util, 0)}</span> <span class="text-gray-500">/</span> <span class="text-red-400">${fmtPct(stats.worker.gpu_util, 0)}</span>`;
            document.getElementById('current-cpu-temp').innerHTML = `<span class="text-yellow-400">${fmtUnit(stats.master.cpu_temp, '°C')}</span> <span class="text-gray-500">/</span> <span class="text-red-400">${fmtUnit(stats.worker.cpu_temp, '°C')}</span>`;
            const now = Date.now();
            tempHistory.push({ time: now, master: masterTemp, worker: workerTemp });
            pwrHistory.push({ time: now, master: masterPwr, worker: workerPwr });
            cpuHistory.push({ time: now, master: stats.master.cpu_util, worker: stats.worker.cpu_util });
            gpuUtilHistory.push({ time: now, master: stats.master.gpu_util, worker: stats.worker.gpu_util });
            cpuTempHistory.push({ time: now, master: stats.master.cpu_temp ?? 0, worker: stats.worker.cpu_temp ?? 0 });
            capTelemetryHistories();
            
            const tSlice = tempHistory.slice(-30);
            tempChart.data.labels = tSlice.map(h => h.time); tempChart.data.datasets[0].data = tSlice.map(h => h.master); tempChart.data.datasets[1].data = tSlice.map(h => h.worker); tempChart.update('none');
            const pSlice = pwrHistory.slice(-30);
            pwrChart.data.labels = pSlice.map(h => h.time); pwrChart.data.datasets[0].data = pSlice.map(h => h.master); pwrChart.data.datasets[1].data = pSlice.map(h => h.worker); pwrChart.update('none');
            const cSlice = cpuHistory.slice(-30);
            cpuChart.data.labels = cSlice.map(h => h.time); cpuChart.data.datasets[0].data = cSlice.map(h => h.master); cpuChart.data.datasets[1].data = cSlice.map(h => h.worker); cpuChart.update('none');
            const guSlice = gpuUtilHistory.slice(-30);
            gpuUtilChart.data.labels = guSlice.map(h => h.time); gpuUtilChart.data.datasets[0].data = guSlice.map(h => h.master); gpuUtilChart.data.datasets[1].data = guSlice.map(h => h.worker); gpuUtilChart.update('none');
            const ctSlice = cpuTempHistory.slice(-30);
            cpuTempChart.data.labels = ctSlice.map(h => h.time); cpuTempChart.data.datasets[0].data = ctSlice.map(h => h.master); cpuTempChart.data.datasets[1].data = ctSlice.map(h => h.worker); cpuTempChart.update('none');
        } else {
            document.getElementById('current-temp').innerHTML = `<span class="text-yellow-400">${fmtUnit(masterTemp, '°C')}</span> <span class="text-gray-500">/</span> <span class="text-red-400">--°C</span>`;
            document.getElementById('current-pwr').innerHTML = `<span class="text-yellow-400">${fmtUnit(masterPwr, 'W')}</span> <span class="text-gray-500">/</span> <span class="text-red-400">--W</span>`;
            document.getElementById('current-cpu').innerHTML = `<span class="text-yellow-400">${fmtPct(stats.master.cpu_util)}</span> <span class="text-gray-500">/</span> <span class="text-red-400">--%</span>`;
            document.getElementById('current-gpu-util').innerHTML = `<span class="text-yellow-400">${fmtPct(stats.master.gpu_util, 0)}</span> <span class="text-gray-500">/</span> <span class="text-red-400">--%</span>`;
            document.getElementById('current-cpu-temp').innerHTML = `<span class="text-yellow-400">${fmtUnit(stats.master.cpu_temp, '°C')}</span> <span class="text-gray-500">/</span> <span class="text-red-400">--°C</span>`;
            
            const now = Date.now();
            tempHistory.push({ time: now, master: masterTemp, worker: null });
            pwrHistory.push({ time: now, master: masterPwr, worker: null });
            cpuHistory.push({ time: now, master: stats.master.cpu_util, worker: null });
            gpuUtilHistory.push({ time: now, master: stats.master.gpu_util, worker: null });
            cpuTempHistory.push({ time: now, master: stats.master.cpu_temp ?? 0, worker: null });
            capTelemetryHistories();

            // Dataset[1] (the worker/GPU-B line) must still be cleared here, not
            // just left unset -- otherwise it keeps rendering whatever stale data
            // it last had from before workerReporting went false (e.g. a
            // transient blip, or simply never having been cleared since boot),
            // which is why a "worker" line kept appearing on these charts even
            // with no second node actually reporting.
            const tSlice = tempHistory.slice(-30);
            tempChart.data.labels = tSlice.map(h => h.time); tempChart.data.datasets[0].data = tSlice.map(h => h.master); tempChart.data.datasets[1].data = tSlice.map(h => h.worker); tempChart.update('none');
            const pSlice = pwrHistory.slice(-30);
            pwrChart.data.labels = pSlice.map(h => h.time); pwrChart.data.datasets[0].data = pSlice.map(h => h.master); pwrChart.data.datasets[1].data = pSlice.map(h => h.worker); pwrChart.update('none');
            const cSlice = cpuHistory.slice(-30);
            cpuChart.data.labels = cSlice.map(h => h.time); cpuChart.data.datasets[0].data = cSlice.map(h => h.master); cpuChart.data.datasets[1].data = cSlice.map(h => h.worker); cpuChart.update('none');
            const guSlice = gpuUtilHistory.slice(-30);
            gpuUtilChart.data.labels = guSlice.map(h => h.time); gpuUtilChart.data.datasets[0].data = guSlice.map(h => h.master); gpuUtilChart.data.datasets[1].data = guSlice.map(h => h.worker); gpuUtilChart.update('none');
            const ctSlice = cpuTempHistory.slice(-30);
            cpuTempChart.data.labels = ctSlice.map(h => h.time); cpuTempChart.data.datasets[0].data = ctSlice.map(h => h.master); cpuTempChart.data.datasets[1].data = ctSlice.map(h => h.worker); cpuTempChart.update('none');
        }
        refreshExpandedChartLive();
        // --- Feed active response hw chart ---
        if (typeof responseMetrics !== 'undefined' && hwChartCanvas) {
            // Split into a prefill-phase line and a gen-phase line, same idea as
            // the server-side per-request samples: only one of the two is ever
            // populated for a given sample, based on which phase was active when
            // it was taken, so they render as two distinct non-overlapping lines.
            const isPrefillPhase = currentResponsePhase === 'prefill';
            const prefillTpsVal = parseFloat(document.getElementById('metric-prefill').innerText) || 0;
            // Gen rate split into thinking vs answer (see lastThinkTps/
            // lastAnswerTps) -- each is 0 in whichever phase isn't running, so
            // the two lines never overlap. Server-recorded samples (Monitor/
            // History) can't make this split and carry a single combined
            // genTps instead.
            const snap = {
                t: Date.now(),
                masterPwr: stats.master ? stats.master.gpu_pwr : 0,
                masterTemp: stats.master ? stats.master.gpu_temp : 0,
                masterGpuUtil: stats.master ? stats.master.gpu_util : 0,
                masterCpuUtil: stats.master ? stats.master.cpu_util : 0,
                workerPwr: workerReporting ? stats.worker.gpu_pwr : 0,
                workerTemp: workerReporting ? stats.worker.gpu_temp : 0,
                workerGpuUtil: workerReporting ? stats.worker.gpu_util : 0,
                netMbps: parseFloat(sessionData.netThroughput) || 0,
                masterVram: stats.master?.vram_used != null ? +(stats.master.vram_used / 1024).toFixed(2) : null,
                workerVram: workerReporting && stats.worker?.vram_used != null ? +(stats.worker.vram_used / 1024).toFixed(2) : null,
                prefillProgress: isPrefillPhase ? livePrefillProgress : null,
                prefillTps: isPrefillPhase ? prefillTpsVal : null,
                thinkTps: lastThinkTps > 0 ? +lastThinkTps.toFixed(1) : null,
                answerTps: lastAnswerTps > 0 ? +lastAnswerTps.toFixed(1) : null
            };
            responseMetrics.push(snap);
            refreshExpandedHwChartLive();

            // Phase-dependent color for the Tokens/Sec line
            const phaseColors = { prefill: '#eab308', think: '#3b82f6', answer: '#22c55e' };
            const tpsLineColor = phaseColors[currentResponsePhase] || '#22c55e';

            if (hwChartInst) {
                setOmniDatasets(hwChartInst, buildOmniDatasets(responseMetrics, tpsLineColor));
            } else if (responseMetrics.length >= 2 && hwChartContainer) {
                hwChartContainer.classList.remove('hidden');
                // Compact options for this small inline preview -- no axis
                // titles/time labels (not enough room to be legible at this
                // size), but the same color-matched tooltip and per-GPU/
                // prefill-vs-gen data as the full expand-modal version. Click
                // through to the expand modal (onclick="expandHwChart(this)"
                // on the container) for the fully-labeled reading.
                const compactOptions = buildOmniOptions();
                compactOptions.scales.x.display = false;
                compactOptions.scales.x.title.display = false;
                compactOptions.scales.y.title.display = false;
                compactOptions.scales.y2.title.display = false;
                hwChartInst = new Chart(hwChartCanvas.getContext('2d'), {
                    type: 'line',
                    data: { datasets: buildOmniDatasets(responseMetrics, tpsLineColor) },
                    options: compactOptions,
                    plugins: [omniPointLabelsPlugin, omniGapBandsPlugin]
                });
            }
        }
    } catch (e) {
        console.error('pollTelemetry error:', e);
        telemetryConsecutiveFailures++;
        document.getElementById('worker-status-badge').innerText = 'ERROR';
        document.getElementById('worker-status-badge').className = 'px-2 py-0.5 rounded text-[10px] font-bold bg-red-900/50 text-red-400';
        document.getElementById('worker-status-badge').title = 'Telemetry polling error: ' + (e.message || String(e));
        // Update failure banner after 3+ consecutive failures
        const banner = document.getElementById('telemetry-failure-banner');
        if (banner) {
            if (telemetryConsecutiveFailures >= 3) {
                telemetryHadFailures = true;
                banner.style.display = 'flex';
                banner.className = 'flex items-center gap-2 px-3 py-2 rounded-lg bg-orange-900/20 border border-orange-700/50 text-orange-300 text-xs font-mono';
                document.getElementById('telemetry-failure-count').textContent = telemetryConsecutiveFailures;
            }
            // Backoff: double interval up to cap
            const backoffInterval = Math.min(TELEMETRY_BASE_INTERVAL * (2 ** Math.min(telemetryConsecutiveFailures - 1, 4)), TELEMETRY_MAX_BACKOFF);
            setTelemetryInterval(backoffInterval);
        }
    } finally {
        telemetryPollInFlight = false;
    }
}

let currentTelemetryRateMs = 1000;
function setTelemetryInterval(ms) {
    currentTelemetryRateMs = ms;
    if (telemetryInterval) clearInterval(telemetryInterval);
    telemetryInterval = setInterval(pollTelemetry, ms);
    // chart refresh cadence follows the recording rate, so Fast mode's extra
    // samples show up as they land instead of arriving in 2s batches.
    // try/catch: the initial call runs at script-load time, before the chart
    // timer `let`s below are initialized (TDZ) -- nothing to restart then.
    try {
        if (sessionOmniRefreshTimer) { stopSessionOmniRefresh(); startSessionOmniRefresh(); }
        if (benchOmniPollTimer) { clearInterval(benchOmniPollTimer); benchOmniPollTimer = null; startBenchOmniPoll(); }
    } catch (e) { /* load-time call: timers not declared yet */ }
}
setTelemetryInterval(1000);

document.getElementById('polling-rate').addEventListener('change', (e) => {
    const ms = parseInt(e.target.value);
    setTelemetryInterval(ms);
    // the server is the actual poller now -- keep its rate in sync
    fetch('/api/telemetry/rate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ms }) }).catch(() => {});
});

// --- Chat History UI ---
function buildStaticTimelineSvg(msg) {
    if (!msg.prefillMetrics) return '';
    const pTime = parseFloat(msg.prefillMetrics.time) || 0;
    const tTime = parseFloat(msg.thinkMetrics?.time || 0) || 0;
    const aTime = parseFloat(msg.answerMetrics?.time || 0) || 0;
    const total = pTime + tTime + aTime || 1;
    const VB_W = 1000, VB_H = 100, MID = 50;
    const pEnd = (pTime / total) * VB_W;
    const tEnd = pEnd + (tTime / total) * VB_W;
    const aEnd = tEnd + (aTime / total) * VB_W;

    let prefillPoints = `0,${MID} ${pEnd.toFixed(1)},${MID}`;
    const samples = (msg.prefillSamples || []).filter(s => !isNaN(s.tps) && !isNaN(s.progress));
    if (samples.length > 0) {
        const tpsVals = samples.map(s => s.tps);
        const maxTps = Math.max(...tpsVals, 1);
        const minTps = Math.min(...tpsVals, maxTps);
        const range = Math.max(maxTps - minTps, 1);
        prefillPoints = samples.map(s => {
            const x = s.progress * pEnd;
            const y = VB_H - 10 - (((s.tps - minTps) / range) * (VB_H - 20));
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        }).join(' ');
    }
    const thinkPoints = tTime > 0 ? `${pEnd.toFixed(1)},${MID} ${tEnd.toFixed(1)},${MID}` : '';
    const answerPoints = aTime > 0 ? `${tEnd.toFixed(1)},${MID} ${aEnd.toFixed(1)},${MID}` : '';

    return `
        <div class="timeline-graph-wrap w-full h-6 rounded-md bg-gray-800 overflow-hidden mb-1">
            <svg class="timeline-graph-svg w-full h-full" viewBox="0 0 1000 100" preserveAspectRatio="none">
                <polyline points="${prefillPoints}" fill="none" stroke="#eab308" stroke-width="6" />
                <polyline points="${thinkPoints}" fill="none" stroke="#3b82f6" stroke-width="6" />
                <polyline points="${answerPoints}" fill="none" stroke="#22c55e" stroke-width="6" />
            </svg>
        </div>`;
}

function renderChatSession(messages, scrollToIndex = -1) {
    const chatBox = document.getElementById('chat-container');
    chatBox.innerHTML = '';
    
    if (!messages || messages.length === 0) {
        chatBox.innerHTML = `<div class="h-full flex flex-col items-center justify-center text-center text-gray-400">
            <svg class="w-12 h-12 mb-3 opacity-20" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z"/></svg>
            Cluster Offline. Boot the server to begin.
        </div>`;
        return;
    }

    // insertAdjacentHTML per message (not innerHTML +=) -- this path starts
    // from an empty box and hydrates the charts once at the end, so behavior
    // is identical, but += would re-serialize the whole growing box on every
    // message (O(n^2) on long sessions) and is the same canvas-destroying
    // footgun as in submitPrompt.
    messages.forEach((msg, idx) => {
        const ts = msg.timestamp || '';
        if (msg.role === 'user') {
            const imgThumbs = msg.images ? `<div class="flex flex-wrap gap-2 mb-2">${msg.images.map(u => `<img src="${u}" class="h-16 w-16 object-cover rounded-lg border border-gray-600" loading="lazy">`).join('')}</div>` : '';
            chatBox.insertAdjacentHTML('beforeend', `
                <div id="msg-${idx}" class="msg-wrapper p-4 rounded-xl border border-gray-700 bg-gray-800 max-w-4xl mx-auto shadow-sm w-full mb-4">
                    <div class="flex justify-between items-center mb-2">
                        <div class="text-xs text-gray-300 uppercase">User</div>
                        <div class="flex items-center gap-3">
                            <div class="text-[10px] text-gray-500">${ts}</div>
                            <button class="text-[10px] text-gray-500 hover:text-gray-300 transition-colors" data-mode="rendered" data-raw="${escapeHtml(msg.content)}" onclick="toggleRaw(this, false)">View Raw</button>
                        </div>
                    </div>
                    ${imgThumbs}
                    <div class="msg-content text-sm text-gray-100 whitespace-pre-wrap overflow-x-auto break-words">${escapeHtml(msg.content)}</div>
                </div>
            `);
        } else if (msg.role === 'assistant') {
            chatBox.insertAdjacentHTML('beforeend', `
                <div id="msg-${idx}" class="msg-wrapper p-5 rounded-xl border border-indigo-900/30 bg-gray-900 max-w-4xl mx-auto shadow-sm w-full mb-4">
                    <div class="flex justify-between items-center mb-2">
                        <div class="text-xs text-indigo-400 uppercase tracking-wider">Assistant</div>
                        <div class="flex items-center gap-3">
                            <div class="text-[10px] text-gray-500">${ts}</div>
                            <button class="raw-btn text-[10px] text-gray-500 hover:text-gray-300 transition-colors" data-mode="rendered" data-raw="${escapeHtml(msg.content)}" ${msg.templateKwargs ? `data-kwargs='${JSON.stringify(msg.templateKwargs).replace(/'/g, "&#39;")}'` : ''} onclick="toggleRaw(this, true)">View Raw</button>
                        </div>
                    </div>
                    ${msg.prefillMetrics ? `
                    <div class="metrics-timeline-container w-full mb-3 mt-2">
                        ${buildStaticTimelineSvg(msg)}
                        <div class="flex text-[9px] text-gray-500 gap-4 px-1">
                            <div class="label-prefill text-yellow-500/80 font-mono">Prefill: <span class="val text-gray-200">${msg.prefillMetrics.time}s | ${msg.prefillMetrics.tokens}t | ${msg.prefillMetrics.tps} t/s</span></div>
                            ${msg.thinkMetrics ? `<div class="label-think text-blue-500/80 font-mono">Think: <span class="val text-gray-200">${msg.thinkMetrics.time}s | ${msg.thinkMetrics.tokens}t | ${msg.thinkMetrics.tps} t/s</span></div>` : ''}
                            ${msg.answerMetrics ? `<div class="label-answer text-green-500/80 font-mono">Answer: <span class="val text-gray-200">${msg.answerMetrics.time}s | ${msg.answerMetrics.tokens}t | ${msg.answerMetrics.tps} t/s</span></div>` : ''}
                        </div>
                        ${(msg.responseMetrics && msg.responseMetrics.length >= 2) ? `<div class="hw-history-chart-wrapper mt-2 border border-gray-800/60 rounded-lg bg-gray-950/50 p-1 cursor-pointer" style="height:90px" onclick="expandHwChart(this)"><canvas class="hw-history-chart" data-metrics='${JSON.stringify(msg.responseMetrics).replace(/'/g, "&#39;")}'></canvas></div>` : ''}
                    </div>
                    ` : ''}
                    ${msg.reasoning ? `
                    <div class="reasoning-container border border-gray-800 rounded-lg bg-gray-950/50 mb-3 mt-2">
                        <div class="flex justify-between px-3 py-1.5 bg-gray-800/30 text-[10px] text-gray-400 border-b border-gray-800 cursor-pointer hover:bg-gray-800/50 transition-colors" onclick="toggleReasoning(this)">
                            <span>🧠 Reasoning Trace <span class="r-tokens text-gray-500 ml-1">(~${Math.ceil(msg.reasoning.length/4)} tokens)</span></span>
                            <span class="r-icon">▼</span>
                        </div>
                        <div class="reasoning-body text-xs text-gray-500 font-mono p-3 overflow-x-auto overflow-y-hidden relative cursor-pointer fade-bottom" style="max-height: 4.5rem;" onclick="toggleReasoning(this.previousElementSibling)">${escapeHtml(msg.reasoning)}</div>
                    </div>
                    ` : (msg.templateKwargs ? `<div class="reasoning-container border border-gray-800 rounded-lg bg-gray-950/50 mb-3 mt-2"><div class="px-3 py-2">${buildKwargsAnnotation(msg.templateKwargs)}</div></div>` : '')}
                    <div class="msg-content prose prose-invert max-w-none text-sm overflow-x-auto break-words">${marked.parse(msg.content)}</div>
                </div>
            `);
        }
    });
    
    collapseLongMessagesIn(chatBox);
    setTimeout(() => {
        if (scrollToIndex >= 0) {
            const target = document.getElementById(`msg-${scrollToIndex}`);
            if (target) target.scrollIntoView({ behavior: 'smooth', block: 'center' });
        } else {
            chatBox.scrollTop = chatBox.scrollHeight;
        }
        // Hydrate saved hardware telemetry charts from stored data
        chatBox.querySelectorAll('.hw-history-chart').forEach(canvas => {
            try {
                const metrics = JSON.parse(canvas.dataset.metrics);
                if (!metrics || metrics.length < 2) return;
                // Attach to the clickable wrapper (see the onclick="expandHwChart(this)"
                // added above) so clicking a historical session's mini-chart expands it
                // the same way a live message's does -- these previously had no
                // expand handler wired up at all.
                const wrapper = canvas.closest('.hw-history-chart-wrapper');
                if (wrapper) wrapper.__hwMetrics = metrics;
                // Same shared builder + compact options as the LIVE inline
                // chart (see pollTelemetry) -- this used to be an ad-hoc 5-line
                // version (no prefill/think/answer tps, no VRAM, no CPU, no
                // gap bands), so restored bubbles drew a different set of lines
                // than the live ones they were captured from.
                const compactOptions = buildOmniOptions();
                compactOptions.scales.x.display = false;
                compactOptions.scales.x.title.display = false;
                compactOptions.scales.y.title.display = false;
                compactOptions.scales.y2.title.display = false;
                new Chart(canvas.getContext('2d'), {
                    type: 'line',
                    data: { datasets: buildOmniDatasets(metrics, 'rgba(74,222,128,1)') },
                    options: compactOptions,
                    plugins: [omniPointLabelsPlugin, omniGapBandsPlugin]
                });
            } catch(e) {}
        });
    }, 50);
}

function renderChatHistory() {
    const list = document.getElementById('history-list');
    list.innerHTML = '';
    
    allChatSessions.sort((a,b) => b.id - a.id).forEach(session => {
        const date = new Date(parseInt(session.id)).toLocaleString();
        
        const wrapper = document.createElement('div');
        wrapper.className = 'border border-gray-700/50 rounded-md bg-gray-850 overflow-hidden';
        
        const header = document.createElement('div');
        header.className = 'p-2 cursor-pointer hover:bg-gray-800 text-indigo-300 font-medium flex justify-between items-center';
        header.innerHTML = `<span>Session: ${date}</span><span class="text-[10px] text-gray-500">${session.messages.length} msgs</span>`;
        
        const msgList = document.createElement('div');
        msgList.className = 'hidden flex-col divide-y divide-gray-700/30 bg-gray-900 border-t border-gray-700/50';
        
        session.messages.filter(m => m.role === 'user').forEach(msg => {
            const row = document.createElement('div');
            // min-w-0 is required for truncate to actually take effect here --
            // row is a flex item (msgList is flex-col when expanded), and flex
            // items default to min-width:auto, which lets them grow to fit
            // their full text content regardless of the parent's width,
            // silently defeating text-overflow:ellipsis. Without it these were
            // rendering at full length (visually clipped raggedly by an
            // ancestor's overflow-hidden at best), not truncated to one line.
            row.className = 'p-2 pl-4 text-[10px] text-gray-400 truncate w-full min-w-0 hover:text-gray-200 cursor-pointer';
            row.innerText = msg.content;
            row.onclick = () => { 
                if (session.id !== currentSessionId) {
                    currentSessionId = session.id;
                    chatContext = [...session.messages];
                }
                const realIdx = session.messages.findIndex(m => m === msg);
                renderChatSession(session.messages, realIdx);
            };
            msgList.appendChild(row);
        });
        
        header.onclick = () => {
            msgList.classList.toggle('hidden');
            msgList.classList.toggle('flex');
            if (session.id !== currentSessionId) {
                currentSessionId = session.id;
                chatContext = [...session.messages];
                renderChatSession(chatContext, -1);
            }
        };
        
        wrapper.appendChild(header);
        wrapper.appendChild(msgList);
        list.appendChild(wrapper);
    });
}

function saveChatSession() {
    // Strip .images from messages before persisting — base64 data URLs would
    // blow past the ~5MB localStorage quota on a single photo upload.
    const msgsWithoutImages = chatContext.map(({ images: _drop, ...rest }) => rest);
    const existingIndex = allChatSessions.findIndex(s => s.id === currentSessionId);
    const session = { id: currentSessionId, messages: msgsWithoutImages };
    if (existingIndex > -1) {
        allChatSessions[existingIndex] = session;
    } else {
        allChatSessions.push(session);
    }
    try {
        localStorage.setItem('cluster_chat_history', JSON.stringify(allChatSessions));
    } catch (e) {
        // If we still exceed quota (old data from before the strip), wipe and retry
        if (e.name === 'QuotaExceededError') {
            console.warn('Chat history exceeded localStorage quota; trimming old sessions.');
            while (allChatSessions.length > 1) allChatSessions.shift();
            try { localStorage.setItem('cluster_chat_history', JSON.stringify(allChatSessions)); } catch(e2) {
                console.warn('Still over quota after trim; clearing history.', e2.message);
                localStorage.removeItem('cluster_chat_history');
            }
        } else throw e;
    }
    renderChatHistory();
}

try {
    const saved = localStorage.getItem('cluster_chat_history');
    if (saved) {
        allChatSessions = JSON.parse(saved);
        // Strip any images from previously-loaded sessions (may have been
        // saved before the strip fix, or from a different client version).
        allChatSessions.forEach(s => {
            s.messages.forEach(m => { delete m.images; });
        });
        renderChatHistory();
    }
} catch(e) {}

document.getElementById('btn-clear-history').addEventListener('click', () => {
    if(confirm("Clear all chat history?")) {
        allChatSessions = [];
        chatContext = [];
        currentSessionId = Date.now().toString();
        localStorage.removeItem('cluster_chat_history');
        document.getElementById('chat-container').innerHTML = `<div class="flex flex-col items-center justify-center h-full text-gray-600 text-sm" id="empty-state"><svg class="w-12 h-12 mb-3 opacity-20" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z"/></svg>Cluster Offline. Boot the server to begin.</div>`;
        renderChatHistory();
    }
});

// --- New Chat button ---
document.getElementById('btn-new-chat').addEventListener('click', () => {
    if (chatContext.length > 0) saveChatSession();
    chatContext = [];
    currentSessionId = Date.now().toString();
    document.getElementById('chat-container').innerHTML = `<div class="flex flex-col items-center justify-center h-full text-gray-600 text-sm" id="empty-state"><svg class="w-12 h-12 mb-3 opacity-20" fill="currentColor" viewBox="0 0 24 24"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm-1-13h2v6h-2zm0 8h2v2h-2z"/></svg>New chat started. Type your prompt below.</div>`;
    updateContextUI(0, currentContextLimit);
    document.getElementById('input-token-count').innerText = '~0 tokens';
});

// --- CSV Viewer ---
// Single forward character scan -- same fix as server4.js's splitCsvLine: the
// previous indexOf-based version could send its cursor backwards on a `""""`
// sequence (escaped empty string inside a quoted field) and loop forever,
// freezing the tab on rows the server writes for configs with empty values.
function parseCSVLine(line) {
    if (!line) return [];
    const cols = [];
    let field = '';
    let inQuotes = false;
    for (let i = 0; i < line.length; i++) {
        const c = line[i];
        if (inQuotes) {
            if (c === '"') {
                if (line[i + 1] === '"') { field += '"'; i++; } // escaped quote
                else inQuotes = false; // closing quote
            } else field += c;
        } else if (c === '"' && field.length === 0) {
            inQuotes = true; // opening quote of a quoted field
        } else if (c === ',') {
            cols.push(field);
            field = '';
        } else field += c;
    }
    cols.push(field);
    return cols;
}

document.getElementById('btn-view-csv').addEventListener('click', async () => {
    const modal = document.getElementById('csv-modal');
    const thead = document.querySelector('#csv-table thead');
    const tbody = document.querySelector('#csv-table tbody');
    
    thead.innerHTML = ''; tbody.innerHTML = '';
    modal.classList.remove('hidden'); modal.classList.add('flex');
    
    try {
        const res = await fetch('/api/logs/csv');
        if(!res.ok) throw new Error('No logs found');
        const text = await res.text();
        
        const lines = text.trim().split('\n');
        if (lines.length === 0) return;
        
        const rows = lines.map(l => parseCSVLine(l));
        
        // Headers
        const trH = document.createElement('tr');
        rows[0].forEach(h => { const th = document.createElement('th'); th.className = 'px-3 py-2 font-semibold bg-gray-800'; th.innerText = h; trH.appendChild(th); });
        thead.appendChild(trH);
        
        // Data
        rows.slice(1).forEach(r => {
            const tr = document.createElement('tr');
            r.forEach(c => { const td = document.createElement('td'); td.className = 'px-3 py-2'; td.innerText = c; tr.appendChild(td); });
            tbody.appendChild(tr);
        });
    } catch(e) {
        tbody.innerHTML = `<tr><td class="p-4 text-center text-red-400">Failed to load CSV: ${e.message}</td></tr>`;
    }
});
document.getElementById('close-csv-btn').addEventListener('click', () => {
    const modal = document.getElementById('csv-modal');
    modal.classList.add('hidden'); modal.classList.remove('flex');
});

// --- Expand Chart Modal ---
window.chartEvents = [];
let expandedChartInst = null;
// Which chart (if any) is currently open in the expand modal -- checked by
// refreshExpandedChartLive(), called from every place the underlying history
// arrays get a new data point, so the modal updates in real time instead of
// showing a static snapshot from the moment it was opened.
let currentExpandedChartId = null;
// Long-omni expand state: the full series plus the colour it's drawn in.
// Declared here with the other expand state (not beside renderOmniChartCore)
// because closeExpandModal/expandChart, defined above it, both reset it.
let omniExpandFull = null;
let omniExpandColor = 'rgba(74,222,128,1)';
let currentExpandedIsHw = false;

// Renders the launch-config + metrics details panel below the expanded omni
// chart. Called from expandMonitorRequestChart when a row is clicked.
function renderExpandDetails(row) {
    const det = document.getElementById('expand-details');
    if (!det) return;
    const d = row.detail;
    if (!d) { det.innerHTML = ''; det.classList.add('hidden'); return; }
    const cfg = d.config || {};
    const fmt = (v, u) => v != null ? `${Number(v).toFixed(u ?? 1)}` : '--';
    const fmtKb = v => v != null ? `${(Number(v) / 1024).toFixed(1)} GB` : '--';
    const esc = v => v != null ? escapeHtml(String(v)) : '--';

    // Build config section from parsed launch config
    let cfgHtml = '';
    if (cfg.modelPath) {
        cfgHtml += `<div class="grid grid-cols-2 sm:grid-cols-3 gap-x-6 gap-y-1 text-xs font-mono">`;
        cfgHtml += `<span class="text-gray-500">model</span><span class="text-gray-200 col-span-2 break-all">${esc(cfg.modelPath)}</span>`;
        if (cfg.ctx) cfgHtml += `<span class="text-gray-500">ctx</span><span class="text-gray-200">${cfg.ctx}</span>`;
        if (cfg.ngl) cfgHtml += `<span class="text-gray-500">ngl</span><span class="text-gray-200">${cfg.ngl}</span>`;
        if (cfg.port) cfgHtml += `<span class="text-gray-500">port</span><span class="text-gray-200">${cfg.port}</span>`;
        if (cfg.build) cfgHtml += `<span class="text-gray-500">build</span><span class="text-gray-200">${esc(cfg.build)}</span>`;
        if (cfg.devices) cfgHtml += `<span class="text-gray-500">devices</span><span class="text-gray-200">${esc(JSON.stringify(cfg.devices))}</span>`;
        if (cfg.tensorSplit) cfgHtml += `<span class="text-gray-500">tensor-split</span><span class="text-gray-200">${esc(cfg.tensorSplit)}</span>`;
        if (cfg.rpcTarget) cfgHtml += `<span class="text-gray-500">rpc</span><span class="text-gray-200">${esc(cfg.rpcTarget)}</span>`;
        if (cfg.cacheK) cfgHtml += `<span class="text-gray-500">cache-k</span><span class="text-gray-200">${esc(cfg.cacheK)}${cfg.cacheV ? ' / ' + esc(cfg.cacheV) : ''}</span>`;
        if (cfg.specType) cfgHtml += `<span class="text-gray-500">spec</span><span class="text-gray-200">${esc(cfg.specType)}${cfg.specDraftNMax != null ? ' (max ' + cfg.specDraftNMax + ')' : ''}</span>`;
        if (cfg.sampling) {
            const s = cfg.sampling;
            cfgHtml += `<span class="text-gray-500">sampling</span><span class="text-gray-200">temp ${s.temp ?? '--'} top-k ${s.top_k ?? '--'} top-p ${s.top_p ?? '--'}${s.min_p != null ? ' min-p ' + s.min_p : ''}</span>`;
        }
        if (cfg.jinja !== undefined) cfgHtml += `<span class="text-gray-500">jinja</span><span class="text-gray-200">${cfg.jinja ? 'on' : 'off'}</span>`;
        if (cfg.chatTemplateFile) cfgHtml += `<span class="text-gray-500">template</span><span class="text-gray-200">${esc(cfg.chatTemplateFile)}</span>`;
        if (cfg.mmprojEnabled && cfg.mmprojPath) cfgHtml += `<span class="text-gray-500">mmproj</span><span class="text-gray-200">${esc(cfg.mmprojPath)}</span>`;
        if (cfg.loadMode) cfgHtml += `<span class="text-gray-500">load</span><span class="text-gray-200">${esc(cfg.loadMode)}</span>`;
        if (cfg.verbosity != null) cfgHtml += `<span class="text-gray-500">verbosity</span><span class="text-gray-200">${cfg.verbosity}</span>`;
        cfgHtml += `</div>`;
    }

    // Raw command (copyable)
    const rawCmd = d.launchCommand || cfg.rawCommand || cfg.argString || null;

    det.innerHTML = `
    <div class="bg-gray-900 border border-gray-700 rounded-xl p-4 text-xs space-y-3">
        <h3 class="text-sm font-bold text-white mb-2">Request Details</h3>
        ${cfgHtml}
        ${rawCmd ? `<div class="mt-2"><div class="text-gray-500 mb-1">Launch command</div><div class="relative"><pre class="text-[10px] font-mono text-gray-300 bg-gray-950 rounded border border-gray-800 p-2 overflow-x-auto break-all">${esc(rawCmd)}</pre><button onclick="navigator.clipboard.writeText(this.parentElement.querySelector('pre').textContent);this.textContent='Copied!';setTimeout(()=>{this.textContent='Copy'},1500)" class="absolute top-1 right-1 text-[10px] text-gray-500 hover:text-gray-300 bg-gray-800 px-1.5 py-0.5 rounded border border-gray-700">Copy</button></div></div>` : ''}
        <div class="grid grid-cols-2 sm:grid-cols-4 gap-x-6 gap-y-1 text-xs font-mono">
            <span class="text-gray-500">timestamp</span><span class="text-gray-200">${row.timestamp ? new Date(row.timestamp).toLocaleString() : '--'}</span>
            <span class="text-gray-500">run id</span><span class="text-gray-200">${esc(row.runId)}</span>
            <span class="text-gray-500">wall time</span><span class="text-gray-200">${fmt(row.wallTime)}s</span>
            <span class="text-gray-500">load time</span><span class="text-gray-200">${fmt(d.loadTime)}s</span>
            <span class="text-gray-500">prompt latency</span><span class="text-gray-200">${fmt(d.promptLatency)}s</span>
            <span class="text-gray-500">reason tokens</span><span class="text-gray-200">${d.reasonTokens != null ? d.reasonTokens : '--'}</span>
            <span class="text-gray-500">GPU util</span><span class="text-gray-200">${fmt(d.gpuUtil)}%</span>
            <span class="text-gray-500">GPU power</span><span class="text-gray-200">${fmt(d.gpuPwr)}W</span>
            <span class="text-gray-500">GPU temp</span><span class="text-gray-200">${fmt(d.gpuTemp)}°C</span>
            <span class="text-gray-500">VRAM</span><span class="text-gray-200">${fmtKb(d.vram)}</span>
            <span class="text-gray-500">CPU util</span><span class="text-gray-200">${fmt(d.cpuUtil)}%</span>
            <span class="text-gray-500">CPU temp</span><span class="text-gray-200">${fmt(d.cpuTemp)}°C</span>
            <span class="text-gray-500">RAM</span><span class="text-gray-200">${fmtKb(d.ram)}</span>
            ${row.draftAcceptRate != null ? `<span class="text-gray-500">draft acc</span><span class="text-purple-400">${(row.draftAcceptRate * 100).toFixed(0)}% (${row.draftAccepted}/${row.draftGenerated})</span>` : ''}
            ${row.aborted ? '<span class="text-orange-400 col-span-2">⚠ aborted</span>' : ''}
        </div>
    </div>`;
    det.classList.remove('hidden');
}

function closeExpandModal() {
    const modal = document.getElementById('expand-modal');
    modal.classList.add('hidden');
    modal.classList.remove('flex');
    expandedChartInst?.destroy();
    expandedChartInst = null;
    currentExpandedChartId = null;
    currentExpandedIsHw = false;
    currentExpandedHwMetricsRef = null;
    omniExpandFull = null; // stale omni state must not hijack the slider
    currentExpandedMonitorRunId = null;
    // Clear details panel
    const det = document.getElementById('expand-details');
    if (det) { det.innerHTML = ''; det.classList.add('hidden'); }
}
window.closeExpandModal = closeExpandModal;
document.getElementById('expand-modal').addEventListener('click', (e) => {
    // Only the backdrop itself, not a click that bubbled up from the header,
    // chart, or close button -- those already have their own handling (or
    // shouldn't close the modal at all, e.g. clicking the chart to hover it).
    if (e.target === e.currentTarget) closeExpandModal();
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !document.getElementById('expand-modal').classList.contains('hidden')) {
        closeExpandModal();
    }
});
document.getElementById('expand-scroll-slider').addEventListener('input', () => {
    // applyExpandTimeWindow (called via refreshExpandedChartLive ->
    // getExpandChartData) reads this slider's own current value/max to decide
    // both the visible window AND whether to treat the new position as "live"
    // going forward, so a manual drag just needs to trigger a re-render.
    if (redrawOmniExpandWindow()) return;
    refreshExpandedChartLive();
});
document.getElementById('expand-zoom-in').addEventListener('click', () => {
    expandWindowSize = Math.max(10, Math.round(expandWindowSize / 1.5));
    if (redrawOmniExpandWindow()) return;
    refreshExpandedChartLive();
});
document.getElementById('expand-zoom-out').addEventListener('click', () => {
    expandWindowSize = Math.min(5000, Math.round(expandWindowSize * 1.5));
    if (redrawOmniExpandWindow()) return;
    refreshExpandedChartLive();
});

// tempHistory/pwrHistory/cpuHistory/gpuUtilHistory/cpuTempHistory grow
// unbounded for the life of the page (netHistoryFull/tpsHistoryFull are
// capped at 200) -- the mini sidebar view only ever shows the last 30
// points, and the full-screen expand used to just dump the ENTIRE history
// onto one chart (fine early in a session, unreadable/dense after a few
// hours). This windows it instead: EXPAND_DEFAULT_WINDOW points visible at
// once (3x the mini view), with a slider to scroll back through older data
// and zoom buttons to change how many points are visible at a time.
const EXPAND_DEFAULT_WINDOW = 90;
let expandWindowSize = EXPAND_DEFAULT_WINDOW;

// Slider value is an absolute start-index into the full array, not a
// distance-from-live offset -- simpler to reason about, and "am I at the
// live edge" is just value===max. Called every time new data arrives
// (fullLength grows) as well as on open/zoom/scroll, so it both applies the
// current window AND keeps the slider's own max/value in sync: if the
// previous position was pinned to live (value was at the previous max), the
// view auto-follows new data by moving to the new max; otherwise the view
// stays anchored to the same absolute index range while more data
// accumulates behind it, exactly like a paused live-stream scrubber.
function applyExpandTimeWindow(fullLabels, fullData0, fullData1) {
    const slider = document.getElementById('expand-scroll-slider');
    const L = fullLabels.length;
    const prevMax = parseInt(slider.max, 10) || 0;
    const prevValue = parseInt(slider.value, 10) || 0;
    const wasLive = prevValue >= prevMax;
    const newMax = Math.max(0, L - expandWindowSize);
    slider.max = newMax;
    slider.value = wasLive ? newMax : Math.min(prevValue, newMax);
    const windowStart = parseInt(slider.value, 10) || 0;
    const windowEnd = Math.min(windowStart + expandWindowSize, L);
    const isLive = windowEnd >= L;
    const statusEl = document.getElementById('expand-time-status');
    if (statusEl) statusEl.textContent = `${isLive ? 'Live' : 'Paused'} · ${Math.max(windowEnd - windowStart, 0)} samples`;
    return {
        labels: fullLabels.slice(windowStart, windowEnd),
        data0: fullData0.slice(windowStart, windowEnd),
        data1: fullData1 ? fullData1.slice(windowStart, windowEnd) : null
    };
}

function getExpandChartData(chartId) {
    let fullLabels = [], fullData0 = [], fullData1 = [], isSingleLine = false, singleColor = null, singleLabel = '';
    if (chartId === 'tempChart') { fullLabels = tempHistory.map(h=>h.time); fullData0 = tempHistory.map(h=>h.master); fullData1 = tempHistory.map(h=>h.worker); }
    else if (chartId === 'pwrChart') { fullLabels = pwrHistory.map(h=>h.time); fullData0 = pwrHistory.map(h=>h.master); fullData1 = pwrHistory.map(h=>h.worker); }
    else if (chartId === 'cpuChart') { fullLabels = cpuHistory.map(h=>h.time); fullData0 = cpuHistory.map(h=>h.master); fullData1 = cpuHistory.map(h=>h.worker); }
    else if (chartId === 'gpuUtilChart') { fullLabels = gpuUtilHistory.map(h=>h.time); fullData0 = gpuUtilHistory.map(h=>h.master); fullData1 = gpuUtilHistory.map(h=>h.worker); }
    else if (chartId === 'cpuTempChart') { fullLabels = cpuTempHistory.map(h=>h.time); fullData0 = cpuTempHistory.map(h=>h.master); fullData1 = cpuTempHistory.map(h=>h.worker); }
    else if (chartId === 'netChart') {
        fullLabels = netHistoryFull.map(h=>h.time); fullData0 = netHistoryFull.map(h=>h.value);
        isSingleLine = true; singleColor = 'rgba(96, 165, 250, 1)'; singleLabel = 'Net MB/s';
    }
    else if (chartId === 'tpsChart') {
        fullLabels = tpsHistoryFull.map(h=>h.time); fullData0 = tpsHistoryFull.map(h=>h.tps);
        isSingleLine = true; singleColor = 'rgba(74, 222, 128, 1)'; singleLabel = 'Tokens/sec';
    }
    else return null;
    const windowed = applyExpandTimeWindow(fullLabels, fullData0, fullData1);
    return { fullLabels: windowed.labels, fullData0: windowed.data0, fullData1: windowed.data1, isSingleLine, singleColor, singleLabel };
}

// Called from every history-array push site (see call sites) -- no-ops
// unless the currently-open modal chart matches, so it's safe to call
// unconditionally from all of them.
function refreshExpandedChartLive() {
    if (!currentExpandedChartId || currentExpandedIsHw || !expandedChartInst) return;
    const data = getExpandChartData(currentExpandedChartId);
    if (!data) return;
    expandedChartInst.data.labels = data.fullLabels;
    expandedChartInst.data.datasets[0].data = data.fullData0;
    if (!data.isSingleLine) expandedChartInst.data.datasets[1].data = data.fullData1;
    expandedChartInst.update('none');
}

window.expandChart = function(chartId, title) {
    const modal = document.getElementById('expand-modal');
    const titleEl = document.getElementById('expand-modal-title');
    const canvas = document.getElementById('expandedChartCanvas');

    titleEl.innerText = title;
    modal.classList.remove('hidden'); modal.classList.add('flex');
    currentExpandedChartId = chartId;
    currentExpandedIsHw = false;
    omniExpandFull = null; // classic chart owns the slider now

    // Fresh zoom/scroll state each time a (possibly different) chart is
    // opened -- start at the default 3x-mini window, pinned to live (slider
    // reset to its max further down inside getExpandChartData/
    // applyExpandTimeWindow, since wasLive is read from the slider's current
    // value === its current max, which this 0/0 reset always satisfies).
    expandWindowSize = EXPAND_DEFAULT_WINDOW;
    const scrollSlider = document.getElementById('expand-scroll-slider');
    scrollSlider.max = 0;
    scrollSlider.value = 0;
    document.getElementById('expand-time-controls').classList.remove('hidden');
    document.getElementById('expand-time-controls').classList.add('flex');

    const chartData = getExpandChartData(chartId);
    if (!chartData) return;
    const { fullLabels, fullData0, fullData1, isSingleLine, singleColor, singleLabel } = chartData;

    setTimeout(() => {
        if (expandedChartInst) { expandedChartInst.destroy(); }

        const verticalLinePlugin = {
            id: 'verticalLines',
            afterDraw: chart => {
                const ctx = chart.ctx;
                const xAxis = chart.scales.x;
                const yAxis = chart.scales.y;
                if (!xAxis || !yAxis) return;
                window.chartEvents.forEach(evt => {
                    const x = xAxis.getPixelForValue(evt.time);
                    if (x >= xAxis.left && x <= xAxis.right) {
                        ctx.save();
                        ctx.beginPath();
                        ctx.moveTo(x, yAxis.top);
                        ctx.lineTo(x, yAxis.bottom);
                        ctx.lineWidth = 2;
                        ctx.strokeStyle = evt.color;
                        ctx.setLineDash([5, 5]);
                        ctx.stroke();
                        ctx.fillStyle = evt.color;
                        ctx.font = '12px monospace';
                        ctx.fillText(evt.label, x + 5, yAxis.top + 15 + (evt.offset || 0));
                        ctx.restore();
                    }
                });
            }
        };

        if (isSingleLine) {
            expandedChartInst = new Chart(canvas.getContext('2d'), {
                type: 'line',
                plugins: [verticalLinePlugin],
                data: {
                    labels: fullLabels,
                    datasets: [{
                        label: singleLabel,
                        data: fullData0,
                        borderColor: singleColor,
                        backgroundColor: singleColor.replace('1)', '0.1)'),
                        fill: true, borderWidth: 1.5, pointRadius: 0, tension: 0.2
                    }]
                },
                options: {
                    responsive: true, maintainAspectRatio: false, animation: { duration: 0 },
                    interaction: { intersect: false, mode: 'index' },
                    plugins: { legend: { display: true, labels: { color: '#9ca3af' } } },
                    scales: { x: { display: false }, y: { grid: { color: 'rgba(55, 65, 81, 0.5)' }, ticks: { color: '#9ca3af' } } }
                }
            });
        } else {
            expandedChartInst = new Chart(canvas.getContext('2d'), {
                type: 'line',
                plugins: [verticalLinePlugin],
                data: {
                    labels: fullLabels,
                    datasets: [
                        { label: 'Master', data: fullData0, borderColor: 'rgba(250, 204, 21, 1)', backgroundColor: 'rgba(250, 204, 21, 0.1)', fill: true, borderWidth: 1.5, pointRadius: 0, tension: 0.2 },
                        { label: 'Worker', data: fullData1, borderColor: 'rgba(248, 113, 113, 1)', backgroundColor: 'rgba(248, 113, 113, 0.1)', fill: true, borderWidth: 1.5, pointRadius: 0, tension: 0.2 }
                    ]
                },
                options: {
                    responsive: true, maintainAspectRatio: false, animation: { duration: 0 },
                    interaction: { intersect: false, mode: 'index' },
                    plugins: { legend: { display: true, labels: { color: '#9ca3af' } } },
                    scales: { x: { display: false }, y: { grid: { color: 'rgba(55, 65, 81, 0.5)' }, ticks: { color: '#9ca3af' } } }
                }
            });
        }
    }, 50);
};

// Expands a per-response hardware chart (hw-chart-container) into the shared
// #expand-modal. Distinct from expandChart() above because it plots
// per-answer samples, not the sidebar's rolling histories.
//
// `containerEl` is the specific .hw-chart-container that was clicked (see the
// `onclick="expandHwChart(this)"` in the message template) -- reads that
// element's OWN __hwMetrics array (attached by reference when that message
// started streaming) rather than the shared module-level `responseMetrics`,
// which only ever reflects the CURRENT/latest message. Without this, clicking
// an older message's chart expanded using whatever the newest message's data
// happened to be (or nothing, if no new message had started yet) -- which is
// why it "seemed inconsistent, but mostly worked": right after a message
// finished it happened to still be the one `responseMetrics` pointed at, and
// broke as soon as a new message started.
let currentExpandedHwMetricsRef = null;

// Shared Chart.js construction for every "omni graph" in the dashboard --
// the inline mini chart in a live/historical chat bubble (hwChartInst), the
// expand-modal version (renderOmniChartCore, used by both that and
// expandMonitorRequestChart's Monitor/History table rows), and the rolling
// session-wide graph (sessionOmniPreviewChart). One dataset builder + one
// options builder means a labeling/color/axis fix here applies everywhere at
// once instead of drifting across four near-duplicate chart configs.
//
// netMbps/prefillTps/genTps are frontend-observed-only metrics for chat-
// message-sourced samples (a client-side delta calc and the live sidebar
// readout respectively) -- server-sourced samples (any Monitor/History row or
// session-omni sample, backed by markRequestActivity's capture rather than a
// chat message's own responseMetrics) simply won't have netMbps, so that one
// line renders as a gap for those, while everything else populates normally.
function formatOmniTimeLabel(t) {
    return t ? new Date(t).toLocaleTimeString([], { hour12: false }) : '';
}

// {x,y} point objects (x = real epoch ms) plus a linear x-scale, rather than
// a plain value array plotted against a shared category-label array. With a
// category axis, a chart's whole horizontal scale is spaced by POINT COUNT,
// not real time -- on a sliding window (Monitor's "last 2 minutes" preview)
// the point count changes on every tick as samples age in/out, so the entire
// line visibly rescaled/wobbled each refresh even though nothing about the
// underlying data was unstable. Linear x keeps each point pinned to its
// actual timestamp, so the shape only changes where the data actually did.
let omniSmoothing = false;
try { omniSmoothing = localStorage.getItem('omni_smoothing') === '1'; } catch (e) {}
function setOmniSmoothing(on) {
    omniSmoothing = on;
    try { localStorage.setItem('omni_smoothing', on ? '1' : ''); } catch (e) {}
    document.querySelectorAll('.omni-smooth-cb').forEach(cb => { cb.checked = on; });
    // re-render whatever charts are alive; the rest pick it up on their next tick
    try { renderSessionOmniPreview(); } catch (e) {}
    try { if (benchOmniChartInst?.$lastSamples) renderBenchOmni(benchOmniChartInst.$lastSamples); } catch (e) {}
    try { refreshExpandedChartLive(); } catch (e) {}
    try {
        if (expandedChartInst?.$lastMetrics) {
            setOmniDatasets(expandedChartInst, buildOmniDatasets(expandedChartInst.$lastMetrics, expandedChartInst.$lastColor));
        }
    } catch (e) {}
}
function toPoints(metrics, key) {
    const pts = metrics.map(s => ({ x: s.t, y: s[key] ?? null }));
    if (!omniSmoothing) return pts;
    // exponential weighted moving average; nulls are gaps that reset the
    // average so phases don't bleed into each other
    const alpha = 0.3;
    let ema = null;
    return pts.map(p => {
        if (p.y == null || isNaN(p.y)) { ema = null; return p; }
        ema = ema == null ? p.y : alpha * p.y + (1 - alpha) * ema;
        return { x: p.x, y: +ema.toFixed(2) };
    });
}

// Shortened real GPU names for chart labels (set from telemetry once known).
let omniGpuA = 'GPU A', omniGpuB = 'GPU B';
function shortGpuName(full, fallback) {
    if (!full) return fallback;
    const m = full.match(/4090|5090|4080|3090|7900\s?XTX|XTX|7800|Iris/i);
    return m ? m[0].toUpperCase().replace(/\s/g, '') : full.split(' ').slice(-2).join(' ');
}
// A telemetry gap (sampler stalled, model loading, nothing recorded) must not
// be drawn as a line bridging minutes of missing data. Gaps get a null
// breaker sample (lines blank out) and a gray band (omniGapBandsPlugin).
function omniGapThreshold() { return Math.max(4000, (currentTelemetryRateMs || 1000) * 4); }
function injectGapBreaks(metrics) {
    if (!metrics || metrics.length < 2) return metrics;
    const th = omniGapThreshold();
    const out = [];
    for (let i = 0; i < metrics.length; i++) {
        if (i > 0 && metrics[i].t - metrics[i - 1].t > th) out.push({ t: metrics[i - 1].t + 1 }); // all-null breaker
        out.push(metrics[i]);
    }
    return out;
}
const omniGapBandsPlugin = {
    id: 'omniGapBands',
    beforeDatasetsDraw(chart) {
        const xs = chart.scales.x;
        if (!xs || !chart.chartArea) return;
        let times = [];
        for (const ds of chart.data.datasets) {
            if ((ds.data || []).length > times.length) times = ds.data.map(pt => pt.x);
        }
        const th = omniGapThreshold();
        const ctx = chart.ctx;
        ctx.save();
        ctx.fillStyle = 'rgba(148,163,184,0.09)';
        for (let i = 1; i < times.length; i++) {
            if (times[i] - times[i - 1] > th) {
                const x1 = xs.getPixelForValue(times[i - 1]);
                const x2 = xs.getPixelForValue(times[i]);
                ctx.fillRect(x1, chart.chartArea.top, x2 - x1, chart.chartArea.bottom - chart.chartArea.top);
            }
        }
        ctx.restore();
    }
};
// Thermal-throttle highlighting: any segment of a temperature line whose
// endpoint was recorded while the card reported a THERMAL throttle reason is
// drawn thick and red, so a heat-limited stretch is visible at a glance rather
// than having to be inferred from the temperature's absolute value (which on
// this rig looks unremarkable -- the 4090 throttles in the 80s).
// sw_power_cap is excluded upstream; it is always on here.
function thermalSegment(metrics, field) {
    if (!metrics?.some(m => m && m[field])) return {};
    const hot = (ctx) => {
        const i = ctx.p1DataIndex;
        return metrics[i] && metrics[i][field];
    };
    return {
        segment: {
            borderColor: (ctx) => hot(ctx) ? 'rgba(239,68,68,1)' : undefined,
            borderWidth: (ctx) => hot(ctx) ? 2.5 : undefined,
            borderDash: (ctx) => hot(ctx) ? [] : undefined,
        }
    };
}
function buildOmniDatasets(metrics, tpsLineColor) {
    metrics = injectGapBreaks(metrics);
    const A = omniGpuA, B = omniGpuB;
    return [
        { label: `${A} Power (W)`, data: toPoints(metrics, 'masterPwr'), borderColor: 'rgba(250,204,21,1)', backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 3, tension: 0.3, yAxisID: 'y' },
        { label: `${B} Power (W)`, data: toPoints(metrics, 'workerPwr'), borderColor: 'rgba(248,113,113,1)', backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 3, tension: 0.3, yAxisID: 'y' },
        { label: `${A} Temp (°C)`, data: toPoints(metrics, 'masterTemp'), borderColor: 'rgba(251,146,60,1)', backgroundColor: 'transparent', borderWidth: 1, pointRadius: 0, pointHoverRadius: 3, tension: 0.3, borderDash: [3,3], yAxisID: 'y2', ...thermalSegment(metrics, 'masterThermal') },
        { label: `${B} Temp (°C)`, data: toPoints(metrics, 'workerTemp'), borderColor: 'rgba(244,63,94,1)', backgroundColor: 'transparent', borderWidth: 1, pointRadius: 0, pointHoverRadius: 3, tension: 0.3, borderDash: [3,3], yAxisID: 'y2', ...thermalSegment(metrics, 'workerThermal') },
        { label: `${A} Util (%)`, data: toPoints(metrics, 'masterGpuUtil'), borderColor: 'rgba(167,139,250,1)', backgroundColor: 'transparent', borderWidth: 1, pointRadius: 0, pointHoverRadius: 3, tension: 0.3, borderDash: [2,2], yAxisID: 'y2' },
        { label: `${B} Util (%)`, data: toPoints(metrics, 'workerGpuUtil'), borderColor: 'rgba(217,70,239,1)', backgroundColor: 'transparent', borderWidth: 1, pointRadius: 0, pointHoverRadius: 3, tension: 0.3, borderDash: [2,2], yAxisID: 'y2' },
        { label: 'Net MB/s', data: toPoints(metrics, 'netMbps'), borderColor: 'rgba(96,165,250,1)', backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 3, tension: 0.3, yAxisID: 'y' },
        // Prefill, thinking, and answer tps are mutually exclusive per-sample
        // (each sample is only ever in one phase), so these render as distinct
        // non-overlapping segments rather than one line switching color.
        // On their own auto-scaled axis (y3) -- they used to sit on y2, whose
        // 0-100 clamp silently CLIPPED every prefill point above 100 t/s off
        // the chart (i.e. nearly all of them on this hardware).
        //
        // Gen is split into Thinking vs Answer where the data source can tell
        // them apart: the dashboard's own chat samples (the browser consumes
        // the SSE deltas and knows which are reasoning_content). Server-
        // recorded samples (Monitor/History/session graphs, bench) can't --
        // llama-server's stdout timing lines count all decoded tokens together
        // -- so they carry a single combined 'Gen Tok/s' line instead. All
        // three datasets always exist (fixed order keeps per-dataset
        // visibility state stable across setOmniDatasets updates); a dataset
        // with no non-null points simply draws nothing.
        { label: 'Prefill Tok/s', data: toPoints(metrics, 'prefillTps'), borderColor: 'rgba(234,179,8,1)', backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 3, tension: 0.3, yAxisID: 'y3', spanGaps: false },
        { label: 'Thinking Tok/s', data: toPoints(metrics, 'thinkTps'), borderColor: 'rgba(59,130,246,1)', backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 3, tension: 0.3, yAxisID: 'y3', spanGaps: false },
        { label: 'Answer Tok/s', data: toPoints(metrics, 'answerTps'), borderColor: 'rgba(74,222,128,1)', backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 3, tension: 0.3, yAxisID: 'y3', spanGaps: false },
        { label: 'Gen Tok/s', data: toPoints(metrics, 'genTps'), borderColor: tpsLineColor, backgroundColor: 'transparent', borderWidth: 1.5, pointRadius: 0, pointHoverRadius: 3, tension: 0.3, yAxisID: 'y3', spanGaps: false },
        { label: 'Prefill Progress (%)', data: metrics.map(s => ({ x: s.t, y: s.prefillProgress != null ? +(s.prefillProgress * 100).toFixed(1) : null })), borderColor: 'rgba(45,212,191,0.9)', backgroundColor: 'transparent', borderWidth: 1, pointRadius: 0, pointHoverRadius: 3, tension: 0.1, borderDash: [5,3], yAxisID: 'y2', spanGaps: false },
        { label: `VRAM ${A} (GB)`, data: toPoints(metrics, 'masterVram'), borderColor: 'rgba(148,163,184,0.8)', backgroundColor: 'transparent', borderWidth: 1, pointRadius: 0, pointHoverRadius: 3, tension: 0.3, borderDash: [1,2], yAxisID: 'y2' },
        { label: `VRAM ${B} (GB)`, data: toPoints(metrics, 'workerVram'), borderColor: 'rgba(100,116,139,0.8)', backgroundColor: 'transparent', borderWidth: 1, pointRadius: 0, pointHoverRadius: 3, tension: 0.3, borderDash: [1,2], yAxisID: 'y2' },
        { label: 'CPU %', data: toPoints(metrics, 'masterCpuUtil'), borderColor: 'rgba(248,113,113,0.5)', backgroundColor: 'transparent', borderWidth: 1, pointRadius: 0, pointHoverRadius: 3, tension: 0.3, borderDash: [2,2], yAxisID: 'y2' }
    ];
}

// Draws each visible line's current value directly next to its point at the
// hovered x position, color-matched to that line -- the built-in tooltip box
// lists every value in one stacked column, which is hard to tie back to which
// line is which at a glance. This runs alongside the normal tooltip (kept on,
// with color-matched text -- see buildOmniTooltipOptions) rather than
// replacing it, so exact values are still available in one place too.
const omniPointLabelsPlugin = {
    id: 'omniPointLabels',
    afterDraw(chart) {
        const tooltip = chart.tooltip;
        if (!tooltip || !tooltip.opacity || !tooltip.dataPoints || tooltip.dataPoints.length === 0) return;
        const idx = tooltip.dataPoints[0].dataIndex;
        const ctx = chart.ctx;
        ctx.save();
        ctx.font = '10px ui-monospace, monospace';
        ctx.textBaseline = 'middle';
        chart.data.datasets.forEach((ds, dsIndex) => {
            const meta = chart.getDatasetMeta(dsIndex);
            if (meta.hidden) return;
            const point = meta.data[idx];
            const val = ds.data[idx]?.y;
            if (!point || val == null || isNaN(val)) return;
            const text = Number(val).toFixed(1);
            const x = point.x + 6;
            const y = point.y;
            const w = ctx.measureText(text).width + 6;
            ctx.fillStyle = 'rgba(17,24,39,0.85)';
            ctx.fillRect(x - 2, y - 7, w, 14);
            ctx.fillStyle = ds.borderColor;
            ctx.fillText(text, x, y);
        });
        ctx.restore();
    }
};

// HTML tooltip for the omni charts: stacks properly ABOVE the canvas-drawn
// per-line labels (they used to fight, both unreadable), and waits 3s of
// hover before showing the full table -- the instant per-line labels cover
// the quick-glance case.
let omniTooltipEl = null;
function omniExternalTooltip(context) {
    const { chart, tooltip } = context;
    if (!omniTooltipEl) {
        omniTooltipEl = document.createElement('div');
        omniTooltipEl.style.cssText = 'position:fixed;pointer-events:none;z-index:9999;background:rgba(10,14,26,0.96);border:1px solid #374151;border-radius:8px;padding:8px 10px;font:11px ui-monospace,monospace;display:none;max-width:340px;';
        document.body.appendChild(omniTooltipEl);
    }
    if (!chart.$omniHoverBound) {
        chart.$omniHoverBound = true;
        chart.canvas.addEventListener('mouseenter', () => {
            chart.$omniHoverStart = Date.now();
            chart.$omniHoverTimer = setTimeout(() => { try { chart.update('none'); } catch (e) {} }, 3100);
        });
        chart.canvas.addEventListener('mouseleave', () => {
            clearTimeout(chart.$omniHoverTimer);
            chart.$omniHoverStart = null;
            omniTooltipEl.style.display = 'none';
        });
    }
    if (!tooltip || tooltip.opacity === 0 || !chart.$omniHoverStart || Date.now() - chart.$omniHoverStart < 3000) {
        omniTooltipEl.style.display = 'none';
        return;
    }
    const title = (tooltip.title || []).join(' ');
    const lines = (tooltip.dataPoints || []).map(dp =>
        `<div style="color:${dp.dataset.borderColor}">${escapeHtml(dp.dataset.label)}: ${escapeHtml(String(dp.formattedValue))}</div>`).join('');
    omniTooltipEl.innerHTML = `<div style="color:#9ca3af;margin-bottom:4px">${escapeHtml(title)}</div>${lines}`;
    const rect = chart.canvas.getBoundingClientRect();
    omniTooltipEl.style.display = 'block';
    let x = rect.left + tooltip.caretX + 14, y = rect.top + tooltip.caretY;
    const w = omniTooltipEl.offsetWidth, h = omniTooltipEl.offsetHeight;
    if (x + w > window.innerWidth - 8) x = rect.left + tooltip.caretX - w - 14;
    if (y + h > window.innerHeight - 8) y = window.innerHeight - h - 8;
    omniTooltipEl.style.left = x + 'px';
    omniTooltipEl.style.top = y + 'px';
}

// Legend hover solos that line: every other dataset hides, and only the
// hovered line's y-axis stays, for the duration of the hover.
function omniSoloDataset(chart, idx) {
    if (!chart.$omniSolo) {
        chart.$omniSolo = {
            hidden: chart.data.datasets.map((d, i) => chart.getDatasetMeta(i).hidden),
            axes: {},
        };
        for (const ax of ['y', 'y2', 'y3']) {
            if (chart.options.scales[ax]) chart.$omniSolo.axes[ax] = chart.options.scales[ax].display;
        }
    }
    const soloAxis = chart.data.datasets[idx].yAxisID || 'y';
    chart.data.datasets.forEach((d, i) => { chart.getDatasetMeta(i).hidden = i !== idx; });
    for (const ax of Object.keys(chart.$omniSolo.axes)) {
        chart.options.scales[ax].display = (ax === soloAxis);
    }
    chart.update('none');
}
// Reset all legend visibility on a chart back to defaults.
function omniResetLines(chart) {
    if (!chart) return;
    chart.$omniSolo = null;
    chart.data.datasets.forEach((d, i) => { chart.getDatasetMeta(i).hidden = !!d.hidden && false; });
    chart.data.datasets.forEach((d, i) => { chart.getDatasetMeta(i).hidden = false; });
    omniSyncAxes(chart);
    chart.update('none');
}

// Replace a chart's datasets WITHOUT losing per-dataset visibility state:
// assigning a fresh array resets Chart.js's metas, which was wiping hover
// solos and single-click toggles on every 2s data tick.
function setOmniDatasets(chart, datasets) {
    const hidden = chart.data.datasets.map((d, i) => chart.getDatasetMeta(i).hidden);
    chart.data.datasets = datasets;
    hidden.forEach((h, i) => { if (h !== null && h !== undefined && i < datasets.length) chart.getDatasetMeta(i).hidden = h; });
    chart.update('none');
}

// Show only the axes that some visible dataset actually uses.
function omniSyncAxes(chart) {
    const used = new Set();
    chart.data.datasets.forEach((d, i) => {
        const meta = chart.getDatasetMeta(i);
        const hidden = meta.hidden === null ? !!d.hidden : meta.hidden;
        if (!hidden) used.add(d.yAxisID || 'y');
    });
    for (const ax of ['y', 'y2', 'y3']) {
        if (chart.options.scales[ax]) chart.options.scales[ax].display = used.has(ax);
    }
}
function omniUnsolo(chart) {
    if (!chart.$omniSolo) return;
    chart.data.datasets.forEach((d, i) => { chart.getDatasetMeta(i).hidden = chart.$omniSolo.hidden[i]; });
    for (const ax of Object.keys(chart.$omniSolo.axes)) chart.options.scales[ax].display = chart.$omniSolo.axes[ax];
    chart.$omniSolo = null;
    chart.update('none');
}

function buildOmniOptions() {
    return {
        responsive: true, maintainAspectRatio: false, animation: { duration: 0 },
        interaction: { intersect: false, mode: 'index' },
        plugins: {
            legend: {
                display: true, labels: { color: '#9ca3af', font: { size: 9 }, boxWidth: 10, padding: 6 },
                onHover: (e, item, legend) => omniSoloDataset(legend.chart, item.datasetIndex),
                onLeave: (e, item, legend) => omniUnsolo(legend.chart),
                // single click: toggle a line (axes follow what's visible).
                // double click: LOCK the solo -- exactly the hover view, kept,
                // so further single clicks add lines back in from there.
                onClick: (e, item, legend) => {
                    const chart = legend.chart;
                    const idx = item.datasetIndex;
                    const now = Date.now();
                    const isDouble = chart.$lastLegendClick
                        && chart.$lastLegendClick.i === idx
                        && now - chart.$lastLegendClick.t < 350;
                    chart.$lastLegendClick = { i: idx, t: now };
                    // The click must act on the UNDERLYING state, not the
                    // hover-solo projection currently painted on screen --
                    // otherwise clicking a line while hovering its label
                    // toggles the hover-induced "on" back off and you can
                    // never add lines after a dblclick lock.
                    let base = chart.$omniSolo
                        ? chart.$omniSolo.hidden.map(h => h === null || h === undefined ? null : h)
                        : chart.data.datasets.map((d, i) => chart.getDatasetMeta(i).hidden);
                    const resolve = (h, i) => (h === null || h === undefined) ? !!chart.data.datasets[i].hidden : h;
                    if (isDouble) {
                        base = chart.data.datasets.map((d, i) => i !== idx); // lock solo
                    } else {
                        base[idx] = !resolve(base[idx], idx); // toggle within the real state
                    }
                    chart.$omniSolo = null; // the click defines a new baseline; hover-leave must not undo it
                    base.forEach((h, i) => { chart.getDatasetMeta(i).hidden = resolve(h, i); });
                    omniSyncAxes(chart);
                    chart.update('none');
                },
            },
            // Rendered as an HTML overlay (omniExternalTooltip) -- proper
            // stacking above the canvas point labels, 3s hover delay.
            tooltip: {
                enabled: false,
                external: omniExternalTooltip,
                callbacks: {
                    title: (items) => items.length ? formatOmniTimeLabel(items[0].parsed.x) : '',
                }
            }
        },
        scales: {
            x: {
                type: 'linear',
                display: true,
                ticks: {
                    color: '#6b7280', font: { size: 9 }, maxTicksLimit: 8, autoSkip: true, maxRotation: 0,
                    callback: (value) => formatOmniTimeLabel(value)
                },
                grid: { color: 'rgba(55,65,81,0.2)' },
                title: { display: true, text: 'Time', color: '#6b7280', font: { size: 9 } }
            },
            y: {
                position: 'left',
                grid: { color: 'rgba(55,65,81,0.4)' },
                ticks: { color: '#6b7280', font: { size: 9 } },
                title: { display: true, text: 'Watts / MB/s', color: '#6b7280', font: { size: 9 } }
            },
            y2: {
                position: 'right',
                grid: { drawOnChartArea: false },
                ticks: { color: '#6b7280', font: { size: 9 } },
                min: 0, max: 100,
                title: { display: true, text: '% / °C / GB', color: '#6b7280', font: { size: 9 } }
            },
            // Token rates get their own auto-scaled axis: prefill runs at
            // 100-300 t/s on this hardware and was being clipped by y2's 0-100
            // clamp (points outside axis range simply don't render).
            y3: {
                position: 'right',
                grid: { drawOnChartArea: false },
                ticks: { color: 'rgba(234,179,8,0.9)', font: { size: 9 } },
                min: 0,
                title: { display: true, text: 'tok/s', color: 'rgba(234,179,8,0.9)', font: { size: 9 } }
            }
        }
    };
}

function renderOmniChartCore(metrics, titleText, tpsLineColor, windowed) {
    const modal = document.getElementById('expand-modal');
    const titleEl = document.getElementById('expand-modal-title');
    const canvas = document.getElementById('expandedChartCanvas');
    titleEl.innerText = titleText;
    modal.classList.remove('hidden'); modal.classList.add('flex');
    // Zoom/scroll used to be hidden for every omni chart on the grounds that
    // they were "already-complete per-request" sets. That stopped being true
    // for the bench run chart, which now accumulates across a whole sweep --
    // so callers with a long series opt in via `windowed` and get the same
    // controls the classic sidebar charts use.
    const ctrls = document.getElementById('expand-time-controls');
    ctrls.classList.toggle('hidden', !windowed);
    ctrls.classList.toggle('flex', !!windowed);
    omniExpandFull = windowed ? metrics : null;
    omniExpandColor = tpsLineColor;
    if (windowed) { expandWindowSize = Math.min(EXPAND_DEFAULT_WINDOW * 4, Math.max(60, metrics.length)); }
    const view = windowed ? applyOmniExpandWindow(metrics) : metrics;
    if (expandedChartInst) { expandedChartInst.destroy(); }
    expandedChartInst = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: { datasets: buildOmniDatasets(view, tpsLineColor) },
        options: buildOmniOptions(),
        plugins: [omniPointLabelsPlugin, omniGapBandsPlugin]
    });
    expandedChartInst.$lastMetrics = metrics;
    expandedChartInst.$lastColor = tpsLineColor;
}

// Index-window the omni series using the same slider/zoom state the classic
// charts use, so the controls behave identically in both places.
function applyOmniExpandWindow(full) {
    const slider = document.getElementById('expand-scroll-slider');
    const L = full.length;
    const prevMax = parseInt(slider.max, 10) || 0;
    const prevValue = parseInt(slider.value, 10) || 0;
    const wasLive = prevValue >= prevMax;
    const newMax = Math.max(0, L - expandWindowSize);
    slider.max = newMax;
    slider.value = wasLive ? newMax : Math.min(prevValue, newMax);
    const start = parseInt(slider.value, 10) || 0;
    const end = Math.min(start + expandWindowSize, L);
    const statusEl = document.getElementById('expand-time-status');
    if (statusEl) statusEl.textContent = `${end >= L ? 'Live' : 'Paused'} · ${Math.max(end - start, 0)} of ${L} samples`;
    return full.slice(start, end);
}
function redrawOmniExpandWindow() {
    if (!omniExpandFull || !expandedChartInst) return false;
    setOmniDatasets(expandedChartInst, buildOmniDatasets(applyOmniExpandWindow(omniExpandFull), omniExpandColor));
    return true;
}

window.expandHwChart = function(containerEl) {
    const metrics = (containerEl && containerEl.__hwMetrics) ? containerEl.__hwMetrics : responseMetrics;
    if (!metrics || metrics.length < 2) return;

    // Only the currently-streaming message's array is still being pushed to
    // (older ones are frozen once superseded) -- label accordingly, and only
    // that case will actually update live via refreshExpandedHwChartLive().
    const isLive = metrics === responseMetrics;
    currentExpandedChartId = null;
    currentExpandedIsHw = true;
    currentExpandedHwMetricsRef = metrics;
    currentExpandedMonitorRunId = null;

    const phaseColors = { prefill: '#eab308', think: '#3b82f6', answer: '#22c55e' };
    const tpsLineColor = isLive ? (phaseColors[currentResponsePhase] || '#22c55e') : phaseColors.answer;
    renderOmniChartCore(metrics, isLive ? 'Live Response Telemetry' : 'Response Telemetry', tpsLineColor);
};

// Monitor Mode's per-request expand -- `inlineMetrics` comes straight from the
// live COMPLETION SSE payload for rows that arrived while this tab was open;
// backfilled rows (loaded from CSV, no inline metrics) fetch them from the
// server's short in-memory ring buffer instead (see /api/logs/samples),
// which only covers recently-completed requests -- older ones have no sample
// data to show, same as any CSV row from before this feature existed.
let currentExpandedMonitorRunId = null;
window.expandMonitorRequestChart = async function(runId, inlineMetrics, row) {
    currentExpandedChartId = null;
    currentExpandedIsHw = false;
    currentExpandedHwMetricsRef = null;
    currentExpandedMonitorRunId = runId;

    let metrics = inlineMetrics;
    if (!metrics) {
        const modal = document.getElementById('expand-modal');
        const titleEl = document.getElementById('expand-modal-title');
        titleEl.innerText = 'Loading...';
        modal.classList.remove('hidden'); modal.classList.add('flex');
        try {
            const res = await fetch(`/api/logs/samples?runId=${encodeURIComponent(runId)}`);
            const data = await res.json();
            metrics = data.samples || [];
        } catch (e) {
            metrics = [];
        }
    }
    if (!metrics || metrics.length < 2) {
        document.getElementById('expand-modal-title').innerText = 'No telemetry samples for this request';
        // Still show details if available
        if (row && row.detail) renderExpandDetails(row);
        return;
    }
    renderOmniChartCore(metrics, 'Request Telemetry', 'rgba(74,222,128,1)');
    if (row && row.detail) renderExpandDetails(row);
};

// Live counterpart to refreshExpandedChartLive() for the hw chart -- called
// right after responseMetrics.push(snap). No-ops for a frozen/historical
// message's chart since its metrics array reference has stopped growing.
function refreshExpandedHwChartLive() {
    if (!currentExpandedIsHw || !expandedChartInst || !currentExpandedHwMetricsRef) return;
    const metrics = currentExpandedHwMetricsRef;
    const phaseColors = { prefill: '#eab308', think: '#3b82f6', answer: '#22c55e' };
    const tpsLineColor = phaseColors[currentResponsePhase] || '#22c55e';
    setOmniDatasets(expandedChartInst, buildOmniDatasets(metrics, tpsLineColor));
    expandedChartInst.update('none');
}

// --- Monitor (this session only) + History (all-time) ---
// Both are client-agnostic: every completed request (this dashboard's own
// chat, opencode, Cline, curl -- anything hitting the server) shows up in
// both, independent of any specific chat message's DOM lifecycle. Monitor is
// fed purely by live COMPLETION SSE events (server4.js's logCompletedRequest)
// arriving since this page loaded -- no CSV backfill, so it's an honest view
// of "what's happened in front of me." History backfills everything ever
// logged from the CSV on first visit, then also stays live via the same
// COMPLETION events.
let monitorTpsChart = null;
const _monitorTpsLinearX = { value: true }; // true = time-spaced (linear), false = evenly-spaced (categorical)
let monitorDataPoints = []; // [{time, promptTps, genTps}]
let monitorRequestRows = []; // [{timestamp, model, promptTokens, promptTps, genTokens, genTps, wallTime}]
let isMonitorModeActive = false;
// The boot overlay is absolutely positioned within <main>, so it covers
// whichever view is active -- including Bench, where it blocked interaction
// with a sweep for the entire model load. Track whether a boot is in progress
// separately from whether the overlay should be VISIBLE (interactive tab only).
let isInteractiveModeActive = true;
let bootOverlayWanted = false;
function syncBootOverlay() {
    const el = document.getElementById('boot-overlay');
    if (!el) return;
    const show = bootOverlayWanted && isInteractiveModeActive;
    el.classList.toggle('hidden', !show);
    el.classList.toggle('flex', show);
}
let isHistoryModeActive = false;
const SESSION_HISTORY_CAP = 500;

// Shared builder for the monitor/history token/sec charts — linearX controls
// whether the x-axis is time-spaced (linear, elapsed seconds) or evenly-spaced
// (categorical, one tick per data point). Both are useful: linear shows gaps
// between requests; categorical gives a clean per-request view.
function createTpsChart(canvas, linearX) {
    return new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            datasets: [
                { label: 'Prompt t/s', data: [], borderColor: 'rgba(96,165,250,1)', backgroundColor: 'rgba(96,165,250,0.08)', fill: true, borderWidth: 1.5, pointRadius: 2, tension: 0.2 },
                { label: 'Gen t/s', data: [], borderColor: 'rgba(74,222,128,1)', backgroundColor: 'rgba(74,222,128,0.08)', fill: true, borderWidth: 1.5, pointRadius: 2, tension: 0.2 }
            ]
        },
        options: {
            responsive: true, maintainAspectRatio: false, animation: { duration: 0 },
            interaction: { intersect: false, mode: 'index' },
            plugins: { legend: { display: true, labels: { color: '#9ca3af' } } },
            scales: {
                x: linearX
                    ? { type: 'linear', ticks: { color: '#6b7280', maxTicksLimit: 8, callback: v => v >= 60 ? `${Math.floor(v/60)}m` : `${Math.round(v)}s` }, grid: { color: 'rgba(55,65,81,0.3)' }, title: { display: true, text: 'Elapsed', color: '#6b7280', font: { size: 9 } } }
                    : { ticks: { color: '#6b7280', maxTicksLimit: 8 }, grid: { color: 'rgba(55,65,81,0.3)' } },
                y: { ticks: { color: '#6b7280' }, grid: { color: 'rgba(55,65,81,0.3)' }, beginAtZero: true }
            }
        }
    });
}
function initMonitorChart() {
    if (monitorTpsChart) return;
    const canvas = document.getElementById('monitorTpsChart');
    if (!canvas) return;
    _monitorTpsLinearX.value = localStorage.getItem('monitorTpsLinearX') !== 'false'; // default: linear
    monitorTpsChart = createTpsChart(canvas, _monitorTpsLinearX.value);
    window.monitorTpsChart = monitorTpsChart; // expose for toggle handler's getter
    renderMonitorChart();
    initTpsChartToggle('monitor-tps-xaxis-toggle', () => window.monitorTpsChart, _monitorTpsLinearX, 'monitorTpsLinearX', true);
}

function renderMonitorChart() {
    if (!monitorTpsChart) return;
    if (_monitorTpsLinearX.value) {
        // Time-spaced: linear x-axis, elapsed seconds from first point
        const base = monitorDataPoints[0]?.time || 0;
        monitorTpsChart.data.datasets[0].data = monitorDataPoints.map(p => ({ x: (p.time - base) / 1000, y: p.promptTps }));
        monitorTpsChart.data.datasets[1].data = monitorDataPoints.map(p => ({ x: (p.time - base) / 1000, y: p.genTps }));
    } else {
        // Categorical: evenly spaced, one label per point
        monitorTpsChart.data.labels = monitorDataPoints.map(p => new Date(p.time).toLocaleTimeString());
        monitorTpsChart.data.datasets[0].data = monitorDataPoints.map(p => p.promptTps);
        monitorTpsChart.data.datasets[1].data = monitorDataPoints.map(p => p.genTps);
    }
    monitorTpsChart.update('none');
}

function renderRequestTable(rows, tbodyId, emptyId, clickVarName) {
    const tbody = document.getElementById(tbodyId);
    const emptyEl = document.getElementById(emptyId);
    if (!tbody) return;
    if (rows.length === 0) {
        tbody.innerHTML = '';
        emptyEl.classList.remove('hidden');
        return;
    }
    emptyEl.classList.add('hidden');
    const displayRows = [...rows].reverse().slice(0, 100); // most recent first
    // Row click expands the omni graph for that specific request -- live rows
    // carry their samples inline (from the COMPLETION payload), backfilled
    // rows fetch them from the server's short ring buffer on demand (see
    // expandMonitorRequestChart). Keyed by array position since the metrics
    // array can't survive being embedded in an HTML attribute the way the
    // simple fields can. Monitor and History each get their own window var
    // (clickVarName) so switching tabs can't clobber the other's row index.
    window[clickVarName] = displayRows;
    tbody.innerHTML = displayRows.map((r, i) => `
        <tr class="border-b border-gray-800/50 ${r.live ? 'text-amber-300/90' : 'hover:bg-gray-800/30 cursor-pointer'}" ${r.live ? '' : `onclick="expandMonitorRequestChart(window.${clickVarName}[${i}].runId, window.${clickVarName}[${i}].metrics, window.${clickVarName}[${i}])" title="Click for this request's telemetry + launch details"`}>
            <td class="px-4 py-1.5 text-gray-500">${r.live ? '<span class="inline-block h-2 w-2 rounded-full bg-amber-400 animate-pulse"></span> live' : (r.timestamp ? new Date(r.timestamp).toLocaleTimeString() : '--')}${r.aborted ? ' <span class="text-orange-400 cursor-help" title="Request was canceled by the client before finishing (agent tool-call aborts, user interrupts). Counts are the last values observed live, not final totals.">⚠</span>' : ''}</td>
            <td class="px-4 py-1.5 truncate max-w-[220px]" title="${escapeHtml(r.model || '')}">${escapeHtml(r.model || '--')}</td>
            <td class="px-4 py-1.5 text-right font-mono">${r.promptTokens ?? '--'}</td>
            <td class="px-4 py-1.5 text-right font-mono text-blue-400">${r.promptTpsRange || (r.promptTps != null ? Number(r.promptTps).toFixed(1) : '--')}</td>
            <td class="px-4 py-1.5 text-right font-mono">${r.genTokens ?? '--'}</td>
            <td class="px-4 py-1.5 text-right font-mono text-green-400">${r.genTpsRange || (r.genTps != null ? Number(r.genTps).toFixed(1) : '--')}</td>
            <td class="px-4 py-1.5 text-right font-mono text-purple-400" title="${r.draftAcceptRate != null ? `${r.draftAccepted ?? '?'} accepted / ${r.draftGenerated ?? '?'} generated draft tokens${r.draftMeanLen != null ? `, mean accepted run ${Number(r.draftMeanLen).toFixed(2)}` : ''}` : 'no speculative drafting on this request'}">${r.draftAcceptRate != null ? (r.draftAcceptRate * 100).toFixed(0) + '%' : '--'}</td>
            <td class="px-4 py-1.5 text-right font-mono">${r.wallTime != null ? Number(r.wallTime).toFixed(1) : '--'}</td>
        </tr>
    `).join('');
}
function renderMonitorTable() {
    let rows = monitorRequestRows;
    if (liveMonitorRow) {
        rows = [...monitorRequestRows, { ...liveMonitorRow, timestamp: liveMonitorRow.startedAt, wallTime: (Date.now() - liveMonitorRow.startedAt) / 1000 }];
    }
    renderRequestTable(rows, 'monitor-requests-body', 'monitor-requests-empty', '__monitorRowsForClick');
}

// --- Session-wide continuous omni graph (top of Monitor tab) ---
// A flat concatenation of every completed request's already phase-tagged
// samples (see server4.js logCompletedRequest's prefillTps/genTps split) in
// the order they arrived this session -- reuses real, already-computed data
// rather than polling anything new, so it naturally has gaps during idle
// stretches between requests (nothing was sampled because nothing was
// running -- an honest reflection of "activity", not a fabricated flat line).
let sessionOmniHistory = [];
// Client-side-only idle-lull filler points (see renderSessionOmniPreview) --
// deliberately NOT part of sessionOmniHistory above, which only ever holds
// real per-request data.
let sessionIdleSamples = [];
let sessionOmniPreviewChart = null;
let sessionOmniRefreshTimer = null;
const SESSION_OMNI_WINDOW_MS = 2 * 60 * 1000;
const SESSION_OMNI_CAP = 20000; // guard against unbounded growth on a long-uptime session

const SESSION_OMNI_TPS_COLOR = 'rgba(74,222,128,1)';

function initSessionOmniChart() {
    const canvas = document.getElementById('sessionOmniChart');
    if (!canvas) return;
    if (!sessionOmniPreviewChart) {
        // Compact options, same reasoning as the inline chat-bubble chart --
        // this is a small always-on preview card; click it for the fully
        // labeled expand-modal version (bound below).
        const compactOptions = buildOmniOptions();
        compactOptions.scales.x.display = false;
        compactOptions.scales.x.title.display = false;
        compactOptions.scales.y.title.display = false;
        compactOptions.scales.y2.title.display = false;
        sessionOmniPreviewChart = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: { datasets: buildOmniDatasets([], SESSION_OMNI_TPS_COLOR) },
            options: compactOptions
        });
    }
    const card = document.getElementById('session-omni-card');
    if (card && !card.dataset.clickBound) {
        card.dataset.clickBound = '1';
        card.addEventListener('click', () => {
            if (sessionOmniHistory.length < 2) return;
            renderOmniChartCore(sessionOmniHistory, 'Session Telemetry (since page load)', SESSION_OMNI_TPS_COLOR);
        });
    }
}

async function renderSessionOmniPreview() {
    if (!sessionOmniPreviewChart) return;
    const cutoff = Date.now() - SESSION_OMNI_WINDOW_MS;
    let slice = sessionOmniHistory.filter(s => s.t > cutoff);
    // sessionOmniHistory only gains points once a request fully COMPLETES
    // (see handleMonitorCompletion) -- for a request that's still streaming,
    // that could be minutes away, making this graph look dead the whole time
    // despite real GPU/telemetry activity happening right now. Peek the
    // server's in-progress sample buffer (not yet phase-split into prefill/gen
    // since the final timing that split depends on isn't known until
    // completion -- those two lines just stay gapped for these samples) and
    // append it for display only; the real, correctly-tagged version of these
    // same samples lands in sessionOmniHistory for good once the request
    // actually completes, so nothing here is persisted or double-counted.
    try {
        const res = await fetch('/api/logs/active-samples');
        const data = await res.json();
        if (data.samples && data.samples.length > 0) {
            const activeSlice = data.samples.filter(s => s.t > cutoff);
            slice = slice.concat(activeSlice);
        }
    } catch (e) { /* best-effort -- still show whatever completed history we have */ }
    // Fill idle lulls between requests with the same live stats already
    // driving the sidebar cards -- GPU power/temp/util are real and moving
    // (idling, but real) even when nothing's generating, but no sample from
    // either source above ever gets taken during a lull (activeRequestSamples
    // only accumulates while a request is in flight). Without this, the graph
    // had a real cluster of points during each generation and a dead gap
    // between them, making distant timestamps jump straight from one cluster
    // to the next. Unlike sessionOmniHistory (permanent, request-completion-
    // only) these DO need to accumulate across ticks -- one fresh point every
    // 2s tick is what makes this a continuous line instead of a single dot
    // that gets thrown away and recomputed each render. Kept in its own
    // array (not sessionOmniHistory) so it stays cleanly separate from the
    // real, permanent per-request data and only ever needs window-filtering,
    // never phase-tagging or dedup against real samples.
    if (lastPolledTelemetry && lastPolledTelemetry.t > cutoff) {
        const lastIdle = sessionIdleSamples[sessionIdleSamples.length - 1];
        const lastReal = slice[slice.length - 1];
        const idleGapMs = Math.max(600, currentTelemetryRateMs * 1.25);
        const haveRecentPoint = (lastIdle && lastIdle.t > lastPolledTelemetry.t - idleGapMs)
            || (lastReal && lastReal.t > lastPolledTelemetry.t - idleGapMs);
        if (!haveRecentPoint) {
            const s = lastPolledTelemetry.stats;
            sessionIdleSamples.push({
                t: lastPolledTelemetry.t,
                masterPwr: s.master?.gpu_pwr ?? 0, masterTemp: s.master?.gpu_temp ?? 0,
                masterGpuUtil: s.master?.gpu_util ?? 0, masterCpuUtil: s.master?.cpu_util ?? 0,
                workerPwr: s.worker?.gpu_pwr ?? 0, workerTemp: s.worker?.gpu_temp ?? 0,
                workerGpuUtil: s.worker?.gpu_util ?? 0,
                masterVram: s.master?.vram_used != null ? +(s.master.vram_used / 1024).toFixed(2) : null,
                workerVram: s.worker?.vram_used != null ? +(s.worker.vram_used / 1024).toFixed(2) : null,
                prefillTps: null, genTps: null
            });
        }
    }
    // Age out idle points that fell out of the window -- unlike the other two
    // sources (already filtered fresh above), this one is a persistent array
    // that needs its own pruning or it'd grow forever.
    sessionIdleSamples = sessionIdleSamples.filter(s => s.t > cutoff);
    slice = slice.concat(sessionIdleSamples);
    // Sort by time -- history, in-progress, and idle samples arrive from
    // three different sources and aren't guaranteed to already be in order
    // once concatenated; a line chart needs ascending x to render as a
    // sensible line rather than zig-zagging.
    slice.sort((a, b) => a.t - b.t);
    setOmniDatasets(sessionOmniPreviewChart, buildOmniDatasets(slice, SESSION_OMNI_TPS_COLOR));
}

// The "last 2 minutes" window needs to keep sliding even with no new
// completions (old points should age out), so it gets its own light re-filter
// tick -- only runs while Monitor is actually the visible tab. Also the only
// thing driving the in-progress-request peek above, since that has no other
// event to hook (nothing fires client-side while a request is mid-stream from
// some OTHER client, e.g. opencode/curl).
function startSessionOmniRefresh() {
    if (sessionOmniRefreshTimer) return;
    sessionOmniRefreshTimer = setInterval(() => {
        renderSessionOmniPreview();
        if (liveMonitorRow) renderMonitorTable(); // keeps the live row's wall clock ticking
    }, Math.max(500, currentTelemetryRateMs));
}
function stopSessionOmniRefresh() {
    clearInterval(sessionOmniRefreshTimer);
    sessionOmniRefreshTimer = null;
}

// Called from the SSE handler for every COMPLETION event -- keeps the
// underlying arrays current regardless of which tab is active, but only
// re-renders the DOM/chart when Monitor is actually visible (no point paying
// render cost for a hidden tab). History is intentionally NOT updated here in
// its backfilled array -- it re-backfills fresh from the CSV each time you
// switch to it, so it doesn't need live event-driven upkeep.
let lastKnownModelName = '';
// In-flight request shown as a live, ticking row at the top of Monitor's table
let liveMonitorRow = null;
let pendingDraftStatsEl = null;
let pendingDraftStatsExpiry = 0;
function handleMonitorCompletion(payload) {
    liveMonitorRow = null; // the real row replaces the live one
    if (abCaptureResolve) { const r = abCaptureResolve; abCaptureResolve = null; r(payload); }
    // Interactive-mode draft acceptance summary: attach to the bubble whose
    // stream just finished (guarded by a freshness window so a completion from
    // some other client can't stamp a stale bubble).
    if (pendingDraftStatsEl && Date.now() < pendingDraftStatsExpiry) {
        if (payload.draftAcceptRate != null) {
            const div = document.createElement('div');
            div.className = 'text-purple-400/80 font-mono';
            div.innerHTML = `Draft: <span class="val text-gray-200">${(payload.draftAcceptRate * 100).toFixed(0)}% accepted (${payload.draftAccepted ?? '?'}/${payload.draftGenerated ?? '?'}${payload.draftMeanLen != null ? `, mean run ${Number(payload.draftMeanLen).toFixed(2)}` : ''})</span>`;
            pendingDraftStatsEl.appendChild(div);
        }
        pendingDraftStatsEl = null;
    }
    const abLiveC = document.getElementById('ab-live');
    if (abLiveC && abLiveC.textContent) abLiveC.textContent = `last: ${payload.genTokens ?? '?'} tok gen @ ${payload.genTps != null ? Number(payload.genTps).toFixed(1) : '?'} t/s${payload.draftAcceptRate != null ? `, draft acc ${(payload.draftAcceptRate * 100).toFixed(0)}%` : ''}`;
    updateLiveRequestCard('idle', {});
    monitorDataPoints.push({ time: payload.timestamp || Date.now(), promptTps: payload.promptTps, genTps: payload.genTps });
    if (monitorDataPoints.length > SESSION_HISTORY_CAP) monitorDataPoints.shift();
    monitorRequestRows.push({
        timestamp: payload.timestamp, model: payload.model, runId: payload.runId,
        promptTokens: payload.promptTokens, promptTps: payload.promptTps,
        genTokens: payload.genTokens, genTps: payload.genTps,
        wallTime: payload.wallTime != null ? parseFloat(payload.wallTime) : null,
        draftAcceptRate: payload.draftAcceptRate ?? null,
        draftAccepted: payload.draftAccepted ?? null,
        draftGenerated: payload.draftGenerated ?? null,
        draftMeanLen: payload.draftMeanLen ?? null,
        aborted: !!payload.aborted,
        // Carried inline so this specific row's omni graph doesn't need a
        // round trip to /api/logs/samples -- only backfilled (History) rows
        // need that fallback.
        metrics: (payload.metrics && payload.metrics.length >= 2) ? payload.metrics : null,
        // Min-max range from live progress samples (only available when the
        // dashboard itself was the client that generated this request).
        // Only attach range for dashboard's own requests (abortController !== null).
        // External requests (agents) share the same SSE stream, so their
        // COMPLETION would wrongly consume the dashboard's live samples.
        promptTpsRange: (abortController && activePrefillSamples.length > 0) ? fmtTpsWithRange(activePrefillSamples, payload.promptTps) : null,
        genTpsRange: (abortController && activeGenSamples.length > 0) ? fmtTpsWithRange(activeGenSamples, payload.genTps) : null,
        detail: payload.detail || null
    });
    // Only consume samples for dashboard's own request completion.
    if (abortController) {
        activePrefillSamples = [];
        activeGenSamples = [];
    }
    if (monitorRequestRows.length > SESSION_HISTORY_CAP) monitorRequestRows.shift();

    if (payload.metrics && payload.metrics.length > 0) {
        sessionOmniHistory.push(...payload.metrics);
        if (sessionOmniHistory.length > SESSION_OMNI_CAP) {
            sessionOmniHistory.splice(0, sessionOmniHistory.length - SESSION_OMNI_CAP);
        }
    }

    if (isMonitorModeActive) {
        renderMonitorChart();
        renderMonitorTable();
        renderSessionOmniPreview();
    }
}

// --- History (all-time, backfilled from CSV) ---
let historyTpsChart = null;
const _historyTpsLinearX = { value: true }; // true = time-spaced (linear), false = evenly-spaced (categorical)
let historyDataPoints = [];
let historyRequestRows = [];
const HISTORY_CAP = 200;

function initHistoryChart() {
    if (historyTpsChart) return;
    const canvas = document.getElementById('historyTpsChart');
    if (!canvas) return;
    _historyTpsLinearX.value = localStorage.getItem('historyTpsLinearX') !== 'false'; // default: linear
    historyTpsChart = createTpsChart(canvas, _historyTpsLinearX.value);
    window.historyTpsChart = historyTpsChart;
    renderHistoryChart();
    initTpsChartToggle('history-tps-xaxis-toggle', () => window.historyTpsChart, _historyTpsLinearX, 'historyTpsLinearX', false);
}

function renderHistoryChart() {
    if (!historyTpsChart) return;
    if (_historyTpsLinearX.value) {
        const base = historyDataPoints[0]?.time || 0;
        historyTpsChart.data.datasets[0].data = historyDataPoints.map(p => ({ x: (p.time - base) / 1000, y: p.promptTps }));
        historyTpsChart.data.datasets[1].data = historyDataPoints.map(p => ({ x: (p.time - base) / 1000, y: p.genTps }));
    } else {
        historyTpsChart.data.labels = historyDataPoints.map(p => new Date(p.time).toLocaleTimeString());
        historyTpsChart.data.datasets[0].data = historyDataPoints.map(p => p.promptTps);
        historyTpsChart.data.datasets[1].data = historyDataPoints.map(p => p.genTps);
    }
    historyTpsChart.update('none');
}

function renderHistoryTable() {
    renderRequestTable(historyRequestRows, 'history-requests-body', 'history-requests-empty', '__historyRowsForClick');
}

// Re-fetches on every visit (not one-shot) -- History is meant to reflect
// "everything ever logged" at the moment you're looking, including whatever
// completed while you were on a different tab.
async function backfillHistoryData() {
    const statusEl = document.getElementById('history-chart-status');
    try {
        const res = await fetch(`/api/logs/recent?limit=${HISTORY_CAP}`);
        const data = await res.json();
        const rows = data.rows || [];
        historyDataPoints = rows.map(r => ({ time: new Date(r.timestamp).getTime(), promptTps: r.promptTps, genTps: r.genTps }));
        historyRequestRows = rows.map(r => ({
            timestamp: r.timestamp, model: r.model, runId: r.runId,
            promptTokens: r.promptTokens, promptTps: r.promptTps,
            genTokens: r.genTokens, genTps: r.genTps, wallTime: r.wallTime,
            draftAcceptRate: r.draftAcceptRate ?? null,
            draftAccepted: r.draftAccepted ?? null,
            draftGenerated: r.draftGenerated ?? null,
            draftMeanLen: r.draftMeanLen ?? null,
            aborted: !!r.aborted,
            metrics: null,
            promptTpsRange: null,
            genTpsRange: null,
            detail: r.detail || null // full row detail for expanded view
        }));
        if (statusEl) statusEl.textContent = '';
    } catch (e) {
        if (statusEl) statusEl.textContent = 'Failed to load history';
    }
    renderHistoryChart();
    renderHistoryTable();
}

// --- Tab switching (Interactive / Monitor / History) ---
function setTabButtonActive(id, active) {
    document.getElementById(id).className = active
        ? 'px-4 py-2 text-xs font-semibold text-indigo-400 border-b-2 border-indigo-500'
        : 'px-4 py-2 text-xs font-semibold text-gray-500 border-b-2 border-transparent hover:text-gray-300';
}
document.getElementById('tab-interactive').addEventListener('click', () => {
    isInteractiveModeActive = true; syncBootOverlay();
    isMonitorModeActive = false;
    isHistoryModeActive = false;
    stopSessionOmniRefresh();
    setTabButtonActive('tab-interactive', true);
    setTabButtonActive('tab-monitor', false);
    setTabButtonActive('tab-history', false);
    setTabButtonActive('tab-bench', false);
    document.getElementById('bench-view').classList.add('hidden');
    if (typeof benchOmniPollTimer !== 'undefined' && benchOmniPollTimer) { clearInterval(benchOmniPollTimer); benchOmniPollTimer = null; }
    document.getElementById('monitor-view').classList.add('hidden');
    document.getElementById('monitor-view').classList.remove('flex');
    document.getElementById('history-view').classList.add('hidden');
    document.getElementById('history-view').classList.remove('flex');
    document.getElementById('chat-container').classList.remove('hidden');
    document.getElementById('chat-input-bar').classList.remove('hidden');
});
document.getElementById('tab-monitor').addEventListener('click', () => {
    isInteractiveModeActive = false; syncBootOverlay();
    isMonitorModeActive = true;
    isHistoryModeActive = false;
    setTabButtonActive('tab-monitor', true);
    setTabButtonActive('tab-interactive', false);
    setTabButtonActive('tab-history', false);
    setTabButtonActive('tab-bench', false);
    document.getElementById('bench-view').classList.add('hidden');
    if (typeof benchOmniPollTimer !== 'undefined' && benchOmniPollTimer) { clearInterval(benchOmniPollTimer); benchOmniPollTimer = null; }
    document.getElementById('monitor-view').classList.remove('hidden');
    document.getElementById('monitor-view').classList.add('flex');
    document.getElementById('history-view').classList.add('hidden');
    document.getElementById('history-view').classList.remove('flex');
    document.getElementById('chat-container').classList.add('hidden');
    document.getElementById('chat-input-bar').classList.add('hidden');
    initMonitorChart();
    initSessionOmniChart();
    renderMonitorChart();
    renderMonitorTable();
    renderSessionOmniPreview();
    startSessionOmniRefresh();
});
document.getElementById('tab-history').addEventListener('click', () => {
    isInteractiveModeActive = false; syncBootOverlay();
    isMonitorModeActive = false;
    isHistoryModeActive = true;
    stopSessionOmniRefresh();
    setTabButtonActive('tab-history', true);
    setTabButtonActive('tab-interactive', false);
    setTabButtonActive('tab-monitor', false);
    setTabButtonActive('tab-bench', false);
    document.getElementById('bench-view').classList.add('hidden');
    if (typeof benchOmniPollTimer !== 'undefined' && benchOmniPollTimer) { clearInterval(benchOmniPollTimer); benchOmniPollTimer = null; }
    document.getElementById('history-view').classList.remove('hidden');
    document.getElementById('history-view').classList.add('flex');
    document.getElementById('monitor-view').classList.add('hidden');
    document.getElementById('monitor-view').classList.remove('flex');
    document.getElementById('chat-container').classList.add('hidden');
    document.getElementById('chat-input-bar').classList.add('hidden');
    initHistoryChart();
    backfillHistoryData();
});

// --- Bench tab (llama-bench runner) ---
let benchTabInitialized = false;
let benchBuildsCache = [];
let benchModelsCache = [];
const benchDevicesByBuild = {}; // buildId -> devices[] from /api/devices
let benchAutoQueue = [];
let benchAutoTotal = 0;

async function fetchBenchDevices(buildId) {
    if (benchDevicesByBuild[buildId]) return benchDevicesByBuild[buildId];
    try {
        const data = await (await fetch(`/api/devices?build=${encodeURIComponent(buildId)}`)).json();
        benchDevicesByBuild[buildId] = data.devices || [];
    } catch { benchDevicesByBuild[buildId] = []; }
    return benchDevicesByBuild[buildId];
}
// Same physical card exposed through two backends (e.g. the 4090 as both
// CUDA0 and Vulkan1) has an identical description -- such a "pair" is not a
// real pairing.
function benchSamePhysical(a, b) { return a.description === b.description; }
function benchIsIgpu(d) { return /intel|iris|integrated/i.test(d.description || ''); }

async function populateBenchDeviceDropdown() {
    const buildId = document.getElementById('bench-build').value;
    const devices = await fetchBenchDevices(buildId);
    const sel = document.getElementById('bench-devices-select');
    const opts = ['<option value="">(all devices)</option>'];
    for (const d of devices) {
        opts.push(`<option value="${d.id}">${d.id} solo — ${d.description}</option>`);
    }
    for (let i = 0; i < devices.length; i++) {
        for (let j = i + 1; j < devices.length; j++) {
            const a = devices[i], b = devices[j];
            if (benchSamePhysical(a, b)) continue;
            // llama-bench combines devices with '/'; a comma would mean
            // "bench each device separately".
            opts.push(`<option value="${a.id}/${b.id}">${a.id}+${b.id} — pair</option>`);
        }
    }
    opts.push('<option value="__custom__">Custom…</option>');
    sel.innerHTML = opts.join('');
    document.getElementById('bench-devices').classList.add('hidden');
}
function getBenchDevices() {
    const sel = document.getElementById('bench-devices-select');
    if (sel.value === '__custom__') return document.getElementById('bench-devices').value.trim() || null;
    return sel.value || null;
}

async function initBenchTab() {
    if (benchTabInitialized) return;
    benchTabInitialized = true;
    try {
        const { builds } = await (await fetch('/api/builds')).json();
        benchBuildsCache = builds || [];
        const buildSel = document.getElementById('bench-build');
        buildSel.innerHTML = benchBuildsCache.map(b => `<option value="${b.id}">${b.label}</option>`).join('');
        // Default to the build that exposes the most backends (usually the
        // CUDA+Vulkan one) -- that's the right binary for comparisons.
        const cudaBuild = benchBuildsCache.find(b => /cuda/i.test(b.id) || /cuda/i.test(b.label));
        if (cudaBuild) buildSel.value = cudaBuild.id;
        buildSel.addEventListener('change', populateBenchDeviceDropdown);
        await populateBenchDeviceDropdown();
    } catch (e) { /* leave empty; server falls back to first build */ }
    document.getElementById('bench-devices-select').addEventListener('change', (e) => {
        document.getElementById('bench-devices').classList.toggle('hidden', e.target.value !== '__custom__');
    });
    try {
        const data = await (await fetch('/api/models')).json();
        benchModelsCache = (Array.isArray(data) ? data : (data.models || []))
            .slice().sort((a, b) => parseFloat(a.size) - parseFloat(b.size));
        const optsHtml = benchModelsCache.map(m => `<option value="${m.path}">${m.name} (${m.size} GB)</option>`).join('');
        document.getElementById('bench-model').innerHTML = optsHtml;
        document.getElementById('bench-auto-model').innerHTML = optsHtml; // smallest first: solo runs need a one-card fit
    } catch (e) {
        document.getElementById('bench-model').innerHTML = '<option value="">failed to load models</option>';
    }
    try {
        const saved = JSON.parse(localStorage.getItem('bench_auto_queue') || 'null');
        if (saved?.queue?.length) {
            const btn = document.getElementById('bench-auto-resume');
            btn.textContent = `Resume matrix (${saved.queue.length} runs pending)`;
            btn.classList.remove('hidden');
        }
    } catch (e) {}
}
let benchIsRunning = false;
let abRunning = false; // llama-server sweep in flight (see runSweep)
function setBenchRunningUI(running) {
    benchIsRunning = running;
    const rq = document.getElementById('bench-run-queued');
    if (rq) { rq.disabled = running; rq.style.opacity = running ? '0.45' : ''; rq.style.cursor = running ? 'not-allowed' : ''; }
    document.getElementById('bench-run').classList.toggle('hidden', running);
    document.getElementById('bench-stop-btn').classList.toggle('hidden', !running);
    if (!running && benchAutoQueue.length === 0) document.getElementById('bench-status').textContent = '';
    else if (running && benchAutoTotal === 0) document.getElementById('bench-status').textContent = 'running...';
}
// Structured output: llama-bench emits markdown pipe-tables; render those as
// real HTML tables (constant columns collapsed into a caption line so the
// interesting columns fit without sideways scrolling) and style the log lines
// around them. Re-renders are debounced since lines stream in fast.
let benchOutputLines = [];
let benchRenderTimer = null;
// Progress: each completed llama-bench test prints one result row (they all
// contain the +/- stddev marker), and the expected count is knowable from the
// params (tests x depths), so the status line can show real progress.
let benchRunStartedAt = 0;
let benchRunRowsDone = 0;
let benchRunRowsExpected = 0;
let benchTickTimer = null;

function appendBenchLine(line) {
    benchOutputLines.push(line);
    if (benchOutputLines.length > 4000) benchOutputLines = benchOutputLines.slice(-3000);
    if (/\u00b1|±/.test(line) && /^\s*\|/.test(line)) { benchRunRowsDone++; updateBenchProgressText(); }
    if (line.startsWith('$ ')) {
        // A run started (possibly server-chained from the matrix queue) --
        // derive expected result rows from the command itself.
        const pM = line.match(/ -p (\S+)/), nM = line.match(/ -n (\S+)/), dM = line.match(/ -d (\S+)/);
        setBenchRunningUI(true);
        startBenchProgress(expectedBenchRows(pM?.[1], nM?.[1], dM?.[1]));
    }
    if (line.startsWith('===== llama-bench ') || line.startsWith('===== matrix run ')) {
        const m = line.match(/(?:llama-bench|matrix run) (\d+)\/(\d+): (.*?) =====/);
        if (m) {
            document.getElementById('bench-auto-status').textContent = `matrix ${m[1]}/${m[2]}: ${m[3]}`;
            benchCurrentRunLabel = m[3];
            renderBenchCustomRows();
        }
    }
    scheduleBenchRender();
}
function setBenchOutput(lines) {
    benchOutputLines = (lines || []).slice();
    scheduleBenchRender();
}
function scheduleBenchRender() {
    if (benchRenderTimer) return;
    benchRenderTimer = setTimeout(() => { benchRenderTimer = null; renderBenchOutput(); }, 200);
}
// Bench telemetry omni chart -- same dataset builder as everywhere else.
let benchOmniChartInst = null;
function renderBenchOmni(samples, full) {
    const canvas = document.getElementById('benchOmniChart');
    if (!canvas) return;
    if (!benchOmniChartInst) {
        const opts = buildOmniOptions();
        opts.scales.x.title.display = false;
        benchOmniChartInst = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: { datasets: buildOmniDatasets([], 'rgba(74,222,128,1)') },
            options: opts,
            plugins: [omniPointLabelsPlugin, omniGapBandsPlugin]
        });
        canvas.style.cursor = 'pointer';
        canvas.title = 'Click to expand';
        canvas.addEventListener('click', () => {
            const full = benchOmniChartInst.$fullSamples?.length
                ? benchOmniChartInst.$fullSamples : benchOmniChartInst.$lastSamples;
            if (full?.length) renderOmniChartCore(full, 'Bench Run Telemetry', 'rgba(74,222,128,1)', true);
        });
    }
    // $lastSamples is what's DRAWN (the 10-minute live window); $fullSamples is
    // everything recorded this run, which is what the expand view should show.
    benchOmniChartInst.$lastSamples = samples || [];
    benchOmniChartInst.$fullSamples = (full && full.length) ? full : (samples || []);
    setOmniDatasets(benchOmniChartInst, buildOmniDatasets(samples || [], 'rgba(74,222,128,1)'));
}
let benchOmniPollTimer = null;
// Accumulated across the whole run, NOT just the current request. The server
// hands out per-request sample buffers: takeRequestSamples() empties
// activeRequestSamples on every request's "total time" line, so polling it
// directly made the chart wipe and restart from one sample after every
// request (2 reps => the graph visibly "reset" mid-run). Merge by timestamp
// instead so one sweep row draws one continuous series. Cleared when a run
// starts, and by the existing "reset lines" control.
let benchOmniAccum = [];
let benchOmniPollStartedAt = 0;
let benchOmniLastCount = -1;
// Live mini-chart window: plot only the last 10 minutes.
const BENCH_OMNI_WINDOW_MS = 10 * 60 * 1000;
// Draw off the critical path: coalesce to one draw per frame (idle if the
// browser offers it) so a slow rebuild never blocks input handling. Any
// samples that arrive while a draw is pending simply replace the pending one.
let benchOmniPendingDraw = null;
let benchOmniPendingFull = null;
let benchOmniDrawScheduled = false;
const scheduleIdle = window.requestIdleCallback
    ? (fn) => window.requestIdleCallback(fn, { timeout: 1000 })
    : (fn) => requestAnimationFrame(fn);
function scheduleBenchOmniDraw(view, full) {
    benchOmniPendingDraw = view;
    benchOmniPendingFull = full;
    if (benchOmniDrawScheduled) return;
    benchOmniDrawScheduled = true;
    scheduleIdle(() => {
        benchOmniDrawScheduled = false;
        const v = benchOmniPendingDraw;
        const f = benchOmniPendingFull;
        benchOmniPendingDraw = null; benchOmniPendingFull = null;
        if (v && !document.hidden) renderBenchOmni(v, f);
    });
}
function startBenchOmniPoll() {
    if (benchOmniPollTimer) return;
    benchOmniAccum = [];
    benchOmniLastCount = -1;
    // Anything already in the server's buffer predates this run -- it's the
    // tail of the PREVIOUS request (sampling keeps going for
    // ACTIVITY_TIMEOUT_MS after one finishes). Including it stranded a few
    // orphan points minutes to the left of the real data, stretching the axis
    // and painting the whole model-load window as one huge gap band.
    benchOmniPollStartedAt = Date.now();
    benchOmniPollTimer = setInterval(async () => {
        try {
            const data = await (await fetch('/api/logs/active-samples')).json();
            // keep showing the last finished run's series between runs instead
            // of blanking the chart with an empty active buffer
            if (data.samples?.length) {
                const seen = new Set(benchOmniAccum.map(s => s.t));
                for (const s of data.samples) {
                    if (s.t >= benchOmniPollStartedAt && !seen.has(s.t)) benchOmniAccum.push(s);
                }
                benchOmniAccum.sort((a, b) => a.t - b.t);
                // The mini chart is a LIVE view, so keep the 1/s cadence --
                // just bound what it has to draw. Only the last
                // BENCH_OMNI_WINDOW_MS is plotted (older samples stay in the
                // accumulator for the per-block save), and the window is
                // thinned to something a 128px-tall chart can actually
                // resolve. Rebuilding ~14 full-length datasets every second is
                // what made the tab unresponsive.
                const cutoff = Date.now() - BENCH_OMNI_WINDOW_MS;
                const win = benchOmniAccum.filter(s => s.t >= cutoff);
                const view = win.length > 400 ? downsampleSeries(win, 400) : win;
                // Never pay chart-rebuild cost for a chart nobody can see.
                // Samples keep accumulating either way, so a hidden/background
                // tab (the overnight case) redraws once on return instead of
                // thousands of times unseen -- which is what actually ran the
                // renderer out of memory.
                if (document.hidden || !view.length) return;
                if (view.length !== benchOmniLastCount) {
                    benchOmniLastCount = view.length;
                    scheduleBenchOmniDraw(view, benchOmniAccum);
                }
            }
        } catch (e) {}
    }, Math.max(500, currentTelemetryRateMs));
}
function stopBenchOmniPoll() {
    clearInterval(benchOmniPollTimer);
    benchOmniPollTimer = null;
    // one last fetch for the finished run's full series -- but don't let it
    // replace a richer accumulated series (llama-server sweeps accumulate
    // across several requests; /api/bench/status only carries the last one).
    fetch('/api/bench/status').then(r => r.json()).then(st => {
        const final = st.samples || [];
        renderBenchOmni(final.length >= benchOmniAccum.length ? final : benchOmniAccum);
    }).catch(() => {});
}

function benchElapsedText() {
    if (!benchRunStartedAt) return '';
    const s = Math.floor((Date.now() - benchRunStartedAt) / 1000);
    return s >= 60 ? `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s` : `${s}s`;
}
function updateBenchProgressText() {
    const parts = [];
    if (benchRunRowsExpected > 0) parts.push(`results ${benchRunRowsDone}/${benchRunRowsExpected}`);
    parts.push(benchElapsedText());
    document.getElementById('bench-status').textContent = 'running · ' + parts.filter(Boolean).join(' · ');
}
function startBenchProgress(expectedRows) {
    benchRunStartedAt = Date.now();
    benchRunRowsDone = 0;
    benchRunRowsExpected = expectedRows || 0;
    if (benchTickTimer) clearInterval(benchTickTimer);
    benchTickTimer = setInterval(updateBenchProgressText, 1000);
    updateBenchProgressText();
    startBenchOmniPoll();
}
function stopBenchProgress() {
    if (benchTickTimer) clearInterval(benchTickTimer);
    benchTickTimer = null;
    benchRunStartedAt = 0;
    // one fetch for the finished run's full series; the 2s poll itself keeps
    // running as long as the Bench tab is open (see tab handlers)
    fetch('/api/bench/status').then(r => r.json()).then(st => { if (st.samples?.length) renderBenchOmni(st.samples); }).catch(() => {});
}
// (p-values + n-values) x depths = expected result rows for one run
function expectedBenchRows(nPrompt, nGen, depths) {
    const tests = (nPrompt ? String(nPrompt).split(',').length : 0) + (nGen ? String(nGen).split(',').length : 0);
    const d = depths ? String(depths).split(',').filter(Boolean).length : 1;
    return tests * Math.max(d, 1);
}
function renderBenchLogLine(line) {
    const esc = escapeHtml(line);
    if (line.startsWith('===== ')) return `<div class="text-indigo-300 font-semibold pt-2">${esc}</div>`;
    if (line.startsWith('$ ')) return `<div class="text-amber-400 whitespace-pre-wrap break-all">${esc}</div>`;
    if (line.startsWith('[bench]') || line.startsWith('[matrix]') || line.startsWith('[sweep]')) return `<div class="text-orange-400">${esc}</div>`;
    if (!line.trim()) return '<div class="h-1"></div>';
    return `<div class="text-gray-500 whitespace-pre-wrap break-all">${esc}</div>`;
}
function renderBenchTable(lines) {
    const rows = lines
        .map(l => l.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim()))
        .filter(cells => !cells.every(c => /^:?-{2,}:?$/.test(c)));
    if (rows.length === 0) return '';
    const header = rows[0];
    const dataRows = rows.slice(1);
    if (dataRows.length === 0) return renderBenchLogLine(lines[0]);
    // Collapse columns identical across every data row into a caption line.
    const constCols = [], varCols = [];
    header.forEach((h, ci) => {
        const vals = dataRows.map(r => r[ci] ?? '');
        if (dataRows.length > 1 && vals.every(v => v === vals[0])) constCols.push(ci);
        else varCols.push(ci);
    });
    const caption = constCols.map(ci => `${escapeHtml(header[ci])}: <span class="text-gray-300">${escapeHtml(dataRows[0]?.[ci] ?? '')}</span>`).join(' · ');
    const th = varCols.map(ci => `<th class="text-left font-medium px-2 py-1">${escapeHtml(header[ci])}</th>`).join('');
    const trs = dataRows.map(r => '<tr class="border-b border-gray-800/50">' + varCols.map(ci => {
        const v = r[ci] ?? '';
        const numeric = /^[\d.,\s±\u00b1]+$/.test(v);
        return `<td class="px-2 py-1 whitespace-nowrap ${numeric ? 'text-right text-green-300' : ''}">${escapeHtml(v)}</td>`;
    }).join('') + '</tr>').join('');
    return `<div class="my-2 border border-gray-800 rounded-lg overflow-hidden inline-block">
        ${caption ? `<div class="px-2 py-1 text-[10px] text-gray-500 bg-gray-800/40">${caption}</div>` : ''}
        <table class="text-[11px]"><thead><tr class="text-gray-500 border-b border-gray-800">${th}</tr></thead><tbody>${trs}</tbody></table>
    </div>`;
}
// Device/backend init spam is identical every run -- fold each burst of it
// into a collapsed <details> so results dominate the view.
function isBenchBoilerplate(l) {
    return /^(ggml_|\s+Device \d|load_backend|build: |llama_model_load|main: )/.test(l) && !/error/i.test(l);
}
// Output is grouped into per-run accordion blocks, NEWEST FIRST -- the
// running block stays open at the top, finished ones collapse to a summary
// line (title + timestamp + pass/fail).
function splitBenchBlocks(lines) {
    const blocks = [];
    let cur = null;
    const newBlock = () => { cur = { lines: [], title: '', time: '', dev: '', cmd: '', hasCmd: false, status: 'running' }; blocks.push(cur); };
    for (const line of lines) {
        if (line.startsWith('===== ')) { newBlock(); cur.title = line.replace(/=+/g, '').trim(); continue; }
        if (line.startsWith('--- ') && (!cur || cur.hasCmd)) { newBlock(); }
        if (!cur) newBlock();
        if (line.startsWith('--- ')) { cur.time = line.replace(/---/g, '').trim(); continue; }
        if (line.startsWith('$ ')) {
            cur.hasCmd = true;
            if (!cur.cmd) cur.cmd = line.slice(2).trim(); // first $ line is the launch/bench command
            const devM = line.match(/-dev\s+(\S+)/);
            if (devM) cur.dev = devM[1];
        }
        if (line.includes('[bench] exited with code 0') || line.startsWith('[sweep] done')) cur.status = 'ok';
        else if (line.includes('[bench] exited') || line.includes('[bench] error') || line.startsWith('[sweep] failed')) cur.status = 'fail';
        cur.lines.push(line);
    }
    return blocks;
}
function renderBenchChunk(lines) {
    const isTableLine = (l) => /^\s*\|.*\|\s*$/.test(l);
    const chunks = [];
    let i = 0;
    while (i < lines.length) {
        const line = lines[i];
        if (isTableLine(line)) {
            const tbl = [];
            while (i < lines.length && isTableLine(lines[i])) { tbl.push(lines[i]); i++; }
            chunks.push(renderBenchTable(tbl));
        } else if (isBenchBoilerplate(line)) {
            const grp = [];
            while (i < lines.length && isBenchBoilerplate(lines[i])) { grp.push(lines[i]); i++; }
            chunks.push(`<details class="text-gray-600"><summary class="cursor-pointer text-[10px] select-none">backend init (${grp.length} lines)</summary>` +
                grp.map(l => `<div class="text-gray-600 text-[10px] whitespace-pre-wrap break-all pl-3">${escapeHtml(l)}</div>`).join('') + '</details>');
        } else {
            chunks.push(renderBenchLogLine(line));
            i++;
        }
    }
    return chunks.join('');
}
// Starred blocks: visual bookmarks on the collapsible rows, persisted by
// block identity (title|timestamp). Toggled via delegation so re-renders
// don't shed the handlers.
let benchStars = {};
try { benchStars = JSON.parse(localStorage.getItem('bench_stars') || '{}'); } catch (e) {}

// --- Per-block telemetry series (historical graphs in the accordion) ---
// Keyed by the same "title|time" identity the star bookmarks use, so a
// finished block can redraw the telemetry it was recorded with. Persisted to
// localStorage (the server does NOT keep per-run sample series on disk), and
// capped since each series is a few hundred points.
const BENCH_BLOCK_SAMPLES_KEY = 'bench_block_samples';
const BENCH_BLOCK_SAMPLES_MAX = 40;
let benchBlockSamples = {};
// Chart instances currently on screen, keyed by block identity, so each render
// can destroy the previous ones instead of leaking them. Declared here (not
// beside renderBenchOutput) because `const` has no hoisting and that function
// reads it.
const benchBlockCharts = new Map();
try { benchBlockSamples = JSON.parse(localStorage.getItem(BENCH_BLOCK_SAMPLES_KEY) || '{}'); } catch (e) {}
// Evenly thin a series to at most `max` points. A multi-minute run at 1
// sample/s is thousands of points -- far more than a 128px-tall chart can
// show, and enough to blow the localStorage quota once a few runs pile up.
function downsampleSeries(samples, max) {
    if (samples.length <= max) return samples.slice();
    const step = samples.length / max;
    const out = [];
    for (let i = 0; i < max; i++) out.push(samples[Math.floor(i * step)]);
    out[out.length - 1] = samples[samples.length - 1]; // keep the true end
    return out;
}
function saveBlockSamples(key, samples) {
    try {
        // store a trimmed copy -- only the fields the omni chart plots
        benchBlockSamples[key] = downsampleSeries(samples, 200).map(s => ({
            t: s.t, masterPwr: s.masterPwr, workerPwr: s.workerPwr,
            masterTemp: s.masterTemp, workerTemp: s.workerTemp,
            masterGpuUtil: s.masterGpuUtil, workerGpuUtil: s.workerGpuUtil,
            masterVram: s.masterVram, workerVram: s.workerVram,
            masterCpuUtil: s.masterCpuUtil, netMbps: s.netMbps,
            prefillTps: s.prefillTps, genTps: s.genTps,
            thinkTps: s.thinkTps, answerTps: s.answerTps,
            prefillProgress: s.prefillProgress,
        }));
        const keys = Object.keys(benchBlockSamples);
        if (keys.length > BENCH_BLOCK_SAMPLES_MAX) {
            for (const k of keys.slice(0, keys.length - BENCH_BLOCK_SAMPLES_MAX)) delete benchBlockSamples[k];
        }
        localStorage.setItem(BENCH_BLOCK_SAMPLES_KEY, JSON.stringify(benchBlockSamples));
    } catch (e) { /* quota -- graphs are a nicety, never break the run over it */ }
}

// --- In-progress sweep row (live accordion block) ---
// Shape matches splitBenchBlocks() output so renderBenchOutput can treat it
// like any other block. `liveLine` is the one mutable status line (prefill %
// / generating N tok @ X t/s) updated straight from the SSE progress events.
let liveSweepBlock = null;
function beginLiveSweepBlock(label, cmd) {
    liveSweepBlock = {
        startedAt: Date.now(),
        lines: [`$ ${cmd || ''}`, '[sweep] starting…'],
        title: `llama-server: ${label}`,
        time: new Date().toLocaleString(),
        dev: '', hasCmd: true, status: 'running',
        liveLine: '[sweep] starting…',
        reps: [],
    };
    renderBenchOutput();
}
function updateLiveSweepBlock(text) {
    if (!liveSweepBlock) return;
    const structureChanged = liveSweepBlock.lines.length !== liveSweepBlock.reps.length + 2;
    liveSweepBlock.liveLine = text;
    // rebuild: command, any finished reps, then the current live line
    liveSweepBlock.lines = [liveSweepBlock.lines[0], ...liveSweepBlock.reps, text];
    // Fast path: this fires on every progress event (multiple times a second
    // during prefill). A full renderBenchOutput() there rebuilds the entire
    // transcript's innerHTML and re-instantiates every block chart, which is
    // both janky and how the tab used to run itself out of memory. Only the
    // one status line actually changed, so poke it directly and re-render
    // solely when the block's structure changed (a rep landed).
    const liveEl = document.getElementById('live-sweep-line');
    if (liveEl && !structureChanged) { liveEl.textContent = text; return; }
    renderBenchOutput();
}
function addLiveSweepRep(res, repIdx) {
    if (!liveSweepBlock) return;
    liveSweepBlock.reps.push(
        `[rep ${repIdx}] prompt ${res.promptTokens ?? '?'} tok @ ${res.promptTps != null ? Number(res.promptTps).toFixed(1) : '?'} t/s · ` +
        `gen ${res.genTokens ?? '?'} tok @ ${res.genTps != null ? Number(res.genTps).toFixed(1) : '?'} t/s` +
        (res.draftAcceptRate != null ? ` · draft ${(res.draftAcceptRate * 100).toFixed(0)}%` : ''));
    updateLiveSweepBlock(liveSweepBlock.liveLine);
}
function endLiveSweepBlock() { liveSweepBlock = null; renderBenchOutput(); }
document.getElementById('bench-output').addEventListener('click', (e) => {
    const btn = e.target.closest('.bench-star');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation(); // don't toggle the <details> open/closed
    const key = btn.dataset.starkey;
    if (benchStars[key]) delete benchStars[key]; else benchStars[key] = 1;
    try { localStorage.setItem('bench_stars', JSON.stringify(benchStars)); } catch (err) {}
    renderBenchOutput();
});

function renderBenchOutput() {
    const el = document.getElementById('bench-output');
    if (!el) return;
    const prevScroll = el.scrollTop;
    const blocks = splitBenchBlocks(benchOutputLines);
    // In-progress sweep row: a synthetic newest block so a running config is
    // visible in the transcript WHILE it runs (with its live prefill/gen
    // numbers inline), instead of only appearing once it has finished and
    // written its note. Not part of benchOutputLines -- purely a render-time
    // overlay, replaced by the real block when the note lands.
    if (liveSweepBlock) blocks.push(liveSweepBlock);
    const html = blocks.slice().reverse().map((b, ri) => {
        const isNewest = ri === 0;
        // A block with no exit line is only "running" if it's the newest AND a
        // bench is actually in flight -- anything else died mid-run (killed
        // process, dashboard restart) and should say so.
        if (b.status === 'running' && !(isNewest && (benchIsRunning || abRunning))) b.status = 'interrupted';
        const statusBadge = b.status === 'ok' ? '<span class="text-green-400">done</span>'
            : b.status === 'fail' ? '<span class="text-orange-400">failed</span>'
            : b.status === 'interrupted' ? '<span class="text-gray-500">interrupted</span>'
            : '<span class="text-amber-400">running…</span>';
        let rawTitle = b.title || (b.dev ? `llama-bench — ${b.dev}` : 'llama-bench');
        // historical blocks used older wording -- map at display time
        rawTitle = rawTitle.replace(/^sweep:/, 'llama-server:').replace(/^matrix run /, 'llama-bench ');
        const title = escapeHtml(rawTitle);
        const open = (isNewest && b.status === 'running') || blocks.length === 1 ? ' open' : '';
        const starKey = `${rawTitle}|${b.time}`;
        const starred = !!benchStars[starKey];
        return `<details class="border ${starred ? 'border-yellow-700/60' : 'border-gray-800'} rounded-lg mb-2"${open}>
            <summary class="cursor-pointer select-none px-3 py-1.5 text-[11px] text-gray-300">
                <div class="flex gap-3 items-baseline">
                    <span class="text-indigo-300 font-semibold">${title}</span>
                    <span class="text-gray-600">${escapeHtml(b.time)}</span>${statusBadge}
                    <button type="button" class="bench-star ml-auto ${starred ? 'text-yellow-400' : 'text-gray-600 hover:text-yellow-400'}" data-starkey="${escapeHtml(starKey)}" title="Bookmark this block">${starred ? '★' : '☆'}</button>
                </div>
                ${b.cmd ? `<div class="text-[10px] text-gray-500 font-mono truncate mt-0.5" title="${escapeHtml(b.cmd)}">${escapeHtml(b.cmd)}</div>` : ''}
            </summary>
            <div class="px-3 pb-2">${
                b === liveSweepBlock
                    ? renderBenchChunk(b.lines.slice(0, -1)) +
                      `<div id="live-sweep-line" class="text-amber-300/90 font-mono text-[11px] whitespace-pre-wrap break-all">${escapeHtml(b.liveLine || '')}</div>`
                    : renderBenchChunk(b.lines)
            }${
                benchBlockSamples[starKey]?.length
                    ? `<div class="mt-2"><div class="text-[10px] text-gray-600 mb-1">run telemetry</div>
                       <div class="h-32"><canvas data-blockchart="${escapeHtml(starKey)}"></canvas></div></div>`
                    : ''
            }</div>
        </details>`;
    }).join('');
    // Destroy the previous render's charts BEFORE dropping their canvases.
    // innerHTML replacement discards the canvas elements but Chart.js keeps
    // every instance in its own global registry, so without this each render
    // leaked one live Chart per block -- which, at one render per progress
    // event over a long sweep, is enough to OOM the tab ("Aww, Snap").
    for (const c of benchBlockCharts.values()) { try { c.destroy(); } catch (e) {} }
    benchBlockCharts.clear();
    el.innerHTML = html;
    el.scrollTop = prevScroll;
    // Draw only into blocks the user actually has expanded; collapsed ones
    // get their chart on first open (see the toggle handler below). Keeps a
    // long transcript from instantiating dozens of charts at once.
    el.querySelectorAll('details[open] canvas[data-blockchart]').forEach(drawBlockChart);
}
function drawBlockChart(cv) {
    const key = cv.dataset.blockchart;
    const samples = benchBlockSamples[key];
    if (!samples?.length || benchBlockCharts.has(key)) return;
    try {
        benchBlockCharts.set(key, new Chart(cv.getContext('2d'), {
            type: 'line',
            data: { datasets: buildOmniDatasets(samples, 'rgba(74,222,128,1)') },
            options: (() => { const o = buildOmniOptions(); o.scales.x.title.display = false; return o; })(),
            plugins: [omniPointLabelsPlugin, omniGapBandsPlugin]
        }));
    } catch (e) { /* a chart failure must not blank the transcript */ }
}
// Lazy-draw on expand ('toggle' doesn't bubble, so capture).
document.getElementById('bench-output')?.addEventListener('toggle', (e) => {
    const d = e.target;
    if (d.tagName === 'DETAILS' && d.open) d.querySelectorAll('canvas[data-blockchart]').forEach(drawBlockChart);
}, true);

async function startBenchRun(body) {
    try {
        const resp = await fetch('/api/bench/start', {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
        });
        const data = await resp.json();
        if (!resp.ok) {
            document.getElementById('bench-status').textContent = data.error || 'failed to start';
            return false;
        }
        setBenchRunningUI(true);
        return true;
    } catch (e) {
        document.getElementById('bench-status').textContent = 'failed to start: ' + e.message;
        return false;
    }
}

document.getElementById('tab-bench').addEventListener('click', async () => {
    isInteractiveModeActive = false; syncBootOverlay();
    isMonitorModeActive = false;
    isHistoryModeActive = false;
    stopSessionOmniRefresh();
    setTabButtonActive('tab-bench', true);
    setTabButtonActive('tab-interactive', false);
    setTabButtonActive('tab-monitor', false);
    setTabButtonActive('tab-history', false);
    document.getElementById('bench-view').classList.remove('hidden');
    document.getElementById('bench-view').classList.add('flex');
    document.getElementById('monitor-view').classList.add('hidden');
    document.getElementById('monitor-view').classList.remove('flex');
    document.getElementById('history-view').classList.add('hidden');
    document.getElementById('history-view').classList.remove('flex');
    document.getElementById('chat-container').classList.add('hidden');
    document.getElementById('chat-input-bar').classList.add('hidden');
    await initBenchTab();
    startBenchOmniPoll(); // live telemetry while the tab is open (bench runs AND launch sweeps)
    // Restore output/state from the server so a refresh or late tab-open
    // doesn't lose a run that's already in progress or just finished.
    try {
        const status = await (await fetch('/api/bench/status')).json();
        setBenchOutput(status.output || []);
        setBenchRunningUI(!!status.running);
        if (status.samples?.length) renderBenchOmni(status.samples);
        if (status.running) startBenchOmniPoll();
        if (status.queueTotal > 0) {
            document.getElementById('bench-auto-status').textContent =
                `matrix in progress -- ${status.queueRemaining} of ${status.queueTotal} runs still queued (server-side)`;
        }
        // Reconnecting mid-run: restore which row is active so its badge and
        // eventual completed/failed status survive the refresh.
        if (status.running && status.currentLabel) {
            benchCurrentRunLabel = status.currentLabel;
            renderBenchCustomRows();
        }
    } catch (e) { /* leave as-is */ }
});

document.getElementById('bench-run').addEventListener('click', () => {
    benchAutoQueue = []; benchAutoTotal = 0;
    startBenchRun({
        build: document.getElementById('bench-build').value,
        modelPath: document.getElementById('bench-model').value,
        devices: getBenchDevices(),
        splitMode: document.getElementById('bench-sm').value || null,
        tensorSplit: document.getElementById('bench-ts').value.trim() || null,
        fa: document.getElementById('bench-fa').checked,
        cacheK: document.getElementById('bench-kv').value || null,
        cacheV: document.getElementById('bench-kv').value || null,
        nPrompt: document.getElementById('bench-p').value.trim() || null,
        nGen: document.getElementById('bench-n').value.trim() || null,
        depths: document.getElementById('bench-d').value.trim() || null,
        reps: document.getElementById('bench-r').value.trim() || null,
        extraArgs: document.getElementById('bench-extra').value.trim() || null,
    });
});
document.getElementById('bench-stop-btn').addEventListener('click', () => {
    // server cancels its queue too; nothing client-side to clean up anymore
    fetch('/api/bench/stop', { method: 'POST' }).catch(() => {});
});
document.getElementById('bench-clear-btn').addEventListener('click', () => {
    fetch('/api/bench/clear', { method: 'POST' }).catch(() => {});
    setBenchOutput([]); // view only -- the disk log keeps everything (Restore undoes this)
});
document.getElementById('bench-restore-btn').addEventListener('click', async () => {
    try {
        const data = await (await fetch('/api/bench/restore', { method: 'POST' })).json();
        setBenchOutput(data.output || []);
    } catch (e) {}
});
document.getElementById('bench-auto-resume').addEventListener('click', () => {
    try {
        const saved = JSON.parse(localStorage.getItem('bench_auto_queue') || 'null');
        if (!saved || !saved.queue?.length) return;
        localStorage.removeItem('bench_auto_queue');
        document.getElementById('bench-auto-resume').classList.add('hidden');
        submitMatrixQueue(saved.queue); // hand a pre-server-queue-era leftover to the server runner
    } catch (e) {}
});

// --- Custom matrix rows: snapshots of the manual bench form (Target+Params,
// incl. extra args), run with their OWN settings instead of the recommended
// defaults. Persisted alongside the auto-generated rows.
let benchCustomRows = [];
try { benchCustomRows = JSON.parse(localStorage.getItem('bench_custom_rows') || '[]'); } catch (e) {}
function persistBenchCustomRows() {
    try { localStorage.setItem('bench_custom_rows', JSON.stringify(benchCustomRows)); } catch (e) {}
}
let benchCurrentRunLabel = null;
// label -> 'done' | 'failed', persisted so a refresh mid-matrix keeps history
let benchRowStatus = {};
try { benchRowStatus = JSON.parse(localStorage.getItem('bench_row_status') || '{}'); } catch (e) {}
function setBenchRowStatus(label, status) {
    benchRowStatus[label] = status;
    try { localStorage.setItem('bench_row_status', JSON.stringify(benchRowStatus)); } catch (e) {}
}
function renderBenchCustomRows() {
    const el = document.getElementById('bench-custom-list');
    if (!el) return;
    el.innerHTML = benchCustomRows.map((c, i) => {
        const running = benchCurrentRunLabel && benchCurrentRunLabel === c.label;
        const done = benchRowStatus[c.label];
        const badge = running ? '<span class="text-amber-400 font-semibold">running…</span>'
            : done === 'done' ? '<span class="text-green-400">completed</span>'
            : done === 'failed' ? '<span class="text-orange-400">failed</span>'
            : '<span class="text-gray-600">queued for matrix</span>';
        return `
        <div class="flex items-center gap-2 text-[11px]">
            <span class="text-gray-600">${i + 1}.</span>
            <span class="font-mono ${running ? 'text-amber-300' : 'text-gray-300'} flex-1">${escapeHtml(c.label)}</span>
            ${badge}
            <button data-benchdel="${i}" class="text-gray-600 hover:text-red-400 px-1">✕</button>
        </div>`;
    }).join('');
    el.querySelectorAll('[data-benchdel]').forEach(b => b.addEventListener('click', () => {
        const removed = benchCustomRows.splice(parseInt(b.dataset.benchdel), 1)[0];
        persistBenchCustomRows();
        renderBenchCustomRows();
        // if a matrix is mid-flight, also pull it from the server queue so it
        // won't run after the current test completes
        if (removed) fetch('/api/bench/dequeue', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ label: removed.label }) }).catch(() => {});
    }));
    const runQueuedBtn = document.getElementById('bench-run-queued');
    if (runQueuedBtn) {
        runQueuedBtn.classList.toggle('hidden', benchCustomRows.length === 0);
        runQueuedBtn.textContent = `Run queued rows (${benchCustomRows.length})`;
    }
}
document.getElementById('bench-omni-reset').addEventListener('click', () => omniResetLines(benchOmniChartInst));
document.getElementById('session-omni-reset').addEventListener('click', (e) => {
    e.stopPropagation(); // the session card's click opens the expand modal
    omniResetLines(sessionOmniPreviewChart);
});
document.getElementById('bench-run-queued').addEventListener('click', () => {
    if (benchCustomRows.length === 0) return;
    const queue = benchCustomRows.map(c => ({ ...c.body, label: c.label }));
    for (const q of queue) delete benchRowStatus[q.label];
    try { localStorage.setItem('bench_row_status', JSON.stringify(benchRowStatus)); } catch (e) {}
    submitMatrixQueue(queue);
});
document.getElementById('bench-add-row-btn').addEventListener('click', () => {
    const body = {
        build: document.getElementById('bench-build').value,
        modelPath: document.getElementById('bench-model').value,
        devices: getBenchDevices(),
        splitMode: document.getElementById('bench-sm').value || null,
        tensorSplit: document.getElementById('bench-ts').value.trim() || null,
        fa: document.getElementById('bench-fa').checked,
        cacheK: document.getElementById('bench-kv').value || null,
        cacheV: document.getElementById('bench-kv').value || null,
        nPrompt: document.getElementById('bench-p').value.trim() || null,
        nGen: document.getElementById('bench-n').value.trim() || null,
        depths: document.getElementById('bench-d').value.trim() || null,
        reps: document.getElementById('bench-r').value.trim() || null,
        extraArgs: document.getElementById('bench-extra').value.trim() || null,
    };
    const bits = [body.devices || 'all-devices'];
    if (body.tensorSplit) bits.push(`ts=${body.tensorSplit}`);
    if (body.splitMode) bits.push(`sm=${body.splitMode}`);
    if (!body.fa) bits.push('fa=0');
    if (body.cacheK) bits.push(`kv=${body.cacheK}`);
    if (body.extraArgs) bits.push(body.extraArgs);
    bits.push((body.modelPath || '').split('/').pop().replace(/\.gguf$/, ''));
    benchCustomRows.push({ label: `custom: ${bits.join(' ')}`, body });
    persistBenchCustomRows();
    renderBenchCustomRows();
    document.getElementById('bench-status').textContent = `matrix row added -- open Auto Matrix to run`;
});
renderBenchCustomRows();

// --- Auto Matrix: generated checklist of build+device comparison runs ---
document.getElementById('bench-auto-btn').addEventListener('click', async () => {
    const panel = document.getElementById('bench-auto-panel');
    panel.classList.toggle('hidden');
    if (panel.classList.contains('hidden')) return;
    const list = document.getElementById('bench-auto-list');
    list.innerHTML = '<span class="text-gray-500">detecting devices across builds…</span>';
    // Solo runs: every distinct (device id + physical card) across all builds,
    // so the same GPU shows up once per BACKEND (CUDA0 vs Vulkan1 = the
    // backend comparison). Pairs: within each build, cross-physical-GPU combos.
    const rows = [];
    const soloSeen = new Set();
    for (const b of benchBuildsCache) {
        const devs = await fetchBenchDevices(b.id);
        for (const d of devs) {
            const key = d.id + '|' + d.description;
            if (soloSeen.has(key)) continue;
            soloSeen.add(key);
            rows.push({ build: b.id, devices: d.id, ts: null, igpu: benchIsIgpu(d),
                        label: `${d.id} solo — ${d.description} <span class="text-gray-600">[${b.label}]</span>` });
        }
    }
    const pairSeen = new Set();
    for (const b of benchBuildsCache) {
        const devs = benchDevicesByBuild[b.id] || [];
        for (let i = 0; i < devs.length; i++) {
            for (let j = i + 1; j < devs.length; j++) {
                const a = devs[i], c = devs[j];
                if (benchSamePhysical(a, c) || benchIsIgpu(a) || benchIsIgpu(c)) continue;
                const key = `${a.id},${c.id}|${a.description}|${c.description}`;
                if (pairSeen.has(key)) continue;
                pairSeen.add(key);
                // Default -ts from the pair's actual VRAM ratio (total, not
                // free -- free just reflects whatever happens to be loaded).
                let ts = null;
                if (a.totalMib > 0 && c.totalMib > 0) {
                    const pctA = Math.round(a.totalMib / (a.totalMib + c.totalMib) * 100);
                    ts = `${pctA}/${100 - pctA}`;
                }
                rows.push({ build: b.id, devices: `${a.id}/${c.id}`, ts, igpu: false,
                            label: `${a.id}+${c.id} pair <span class="text-gray-600">[${b.label}]</span>` });
            }
        }
    }
    for (const c of benchCustomRows) {
        rows.push({ custom: true, body: c.body, igpu: false, label: `<span class="text-amber-300">${escapeHtml(c.label)}</span>` });
    }
    window.__benchAutoRows = rows;
    list.innerHTML = rows.map((r, i) => `
        <label class="flex items-center gap-2">
            <input type="checkbox" class="bench-auto-cb accent-indigo-500 rounded" data-i="${i}" ${r.igpu ? '' : 'checked'}>
            <span class="flex-1">${r.label}</span>
            ${r.ts != null ? `<span class="text-gray-500">-ts</span> <input type="text" value="${r.ts}" data-ts="${i}" class="w-16 bg-gray-950 border border-gray-700 rounded px-1 text-[10px] font-mono">` : ''}
            ${r.custom ? `<button type="button" data-customdel="${i}" class="text-gray-600 hover:text-red-400 px-1">✕</button>` : ''}
        </label>`).join('');
    list.querySelectorAll('[data-customdel]').forEach(b => b.addEventListener('click', (ev) => {
        ev.preventDefault();
        const row = window.__benchAutoRows[parseInt(b.dataset.customdel)];
        benchCustomRows = benchCustomRows.filter(c => c.body !== row.body);
        persistBenchCustomRows();
        renderBenchCustomRows();
        document.getElementById('bench-auto-btn').click(); // re-render (toggles twice)
        document.getElementById('bench-auto-btn').click();
    }));
});

// The matrix queue survives page reloads: persisted to localStorage on every
// change, offered back as a Resume button if the page comes up with runs
// still pending (the in-flight run itself lives server-side and keeps going).

// The matrix queue now lives SERVER-side (survives tab closes/refreshes);
// the client just submits the whole list in one request.
async function submitMatrixQueue(queue) {
    const ok = await startBenchRun({ queue });
    document.getElementById('bench-auto-status').textContent = ok
        ? `matrix submitted -- ${queue.length} runs (server-side; safe to close the tab)`
        : 'failed to submit matrix';
}
document.getElementById('bench-auto-run').addEventListener('click', () => {
    const modelPath = document.getElementById('bench-auto-model').value;
    if (!modelPath) { document.getElementById('bench-auto-status').textContent = 'pick a model'; return; }
    const rows = window.__benchAutoRows || [];
    const checked = [...document.querySelectorAll('.bench-auto-cb:checked')].map(cb => parseInt(cb.dataset.i));
    if (checked.length === 0) { document.getElementById('bench-auto-status').textContent = 'nothing checked'; return; }
    benchAutoQueue = checked.map(i => {
        const r = rows[i];
        if (r.custom) return { ...r.body, label: r.label.replace(/<[^>]*>/g, '') }; // custom rows carry their own full settings
        const tsInput = document.querySelector(`input[data-ts="${i}"]`);
        return {
            build: r.build, modelPath, devices: r.devices,
            label: `${r.devices || 'all'} [${r.build}]`,
            tensorSplit: tsInput ? (tsInput.value.trim() || null) : null,
            splitMode: null, fa: true, cacheK: 'q8_0', cacheV: 'q8_0',
            nPrompt: '8192', nGen: '128', depths: '0,32768,98304', reps: null, extraArgs: null,
        };
    });
    for (const q of benchAutoQueue) { if (q.label) delete benchRowStatus[q.label]; }
    try { localStorage.setItem('bench_row_status', JSON.stringify(benchRowStatus)); } catch (e) {}
    submitMatrixQueue(benchAutoQueue.map(q => ({ ...q })));
    benchAutoQueue = []; benchAutoTotal = 0;
});

// --- Sidebar Resizers (right: telemetry, left: launch config) ---
const sidebar = document.getElementById('telemetry-sidebar');
const launchSidebar = document.getElementById('launch-sidebar');
// Which sidebar a drag is resizing: null | 'left' | 'right'
let resizingSide = null;
document.getElementById('sidebar-resizer').addEventListener('mousedown', () => {
    resizingSide = 'right';
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
});
document.getElementById('left-resizer').addEventListener('mousedown', () => {
    resizingSide = 'left';
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
});
window.addEventListener('mousemove', (e) => {
    if (!resizingSide) return;
    if (resizingSide === 'right') {
        const newWidth = document.body.clientWidth - e.clientX;
        if (newWidth > 200 && newWidth < 1200) sidebar.style.width = newWidth + 'px';
    } else {
        if (e.clientX > 180 && e.clientX < 900) launchSidebar.style.width = e.clientX + 'px';
    }
});
window.addEventListener('mouseup', () => {
    if (resizingSide) {
        resizingSide = null;
        document.body.style.cursor = '';
        document.body.style.userSelect = '';
        try {
            localStorage.setItem('cluster_sidebar_width', sidebar.style.width);
            localStorage.setItem('launch_sidebar_width', launchSidebar.style.width);
        } catch(e){}
    }
});

// Collapse/expand toggles -- display:none rather than class games, since both
// asides carry responsive show/hide classes of their own.
function setSidebarCollapsed(side, collapsed) {
    const aside = side === 'left' ? launchSidebar : sidebar;
    const res = document.getElementById(side === 'left' ? 'left-resizer' : 'sidebar-resizer');
    aside.style.display = collapsed ? 'none' : '';
    res.style.display = collapsed ? 'none' : '';
    document.getElementById(side === 'left' ? 'toggle-left-sidebar' : 'toggle-right-sidebar')
        .textContent = side === 'left' ? (collapsed ? '⟩⟩' : '⟨⟨') : (collapsed ? '⟨⟨' : '⟩⟩');
    try { localStorage.setItem(`sidebar_collapsed_${side}`, collapsed ? '1' : ''); } catch(e){}
}
document.getElementById('toggle-left-sidebar').addEventListener('click', () =>
    setSidebarCollapsed('left', launchSidebar.style.display !== 'none'));
document.getElementById('toggle-right-sidebar').addEventListener('click', () =>
    setSidebarCollapsed('right', sidebar.style.display !== 'none'));

try {
    const savedWidth = localStorage.getItem('cluster_sidebar_width');
    if (savedWidth) sidebar.style.width = savedWidth;
    const savedLeft = localStorage.getItem('launch_sidebar_width');
    if (savedLeft) launchSidebar.style.width = savedLeft;
    if (localStorage.getItem('sidebar_collapsed_left') === '1') setSidebarCollapsed('left', true);
    if (localStorage.getItem('sidebar_collapsed_right') === '1') setSidebarCollapsed('right', true);
} catch(e) {}


// --- Launch A/B harness: snapshot the sidebar launch config into rows, then
// run each row for real (launch llama-server, wait ready, fire the test
// prompt, harvest the COMPLETION stats, stop, next). llama-bench can't
// exercise speculative decoding; this can.
let lastKnownServerState = 'stopped';
let lastKnownServerError = '';
let abCaptureResolve = null;
let abRows = [];
// abRunning is declared up with benchIsRunning (renderBenchOutput reads it to
// decide whether a block is genuinely running vs interrupted, and `let` has no
// hoisting -- keeping it here risked a temporal-dead-zone ReferenceError if a
// render ever fired during module evaluation).

function abPersist() {
    try {
        localStorage.setItem('launch_ab', JSON.stringify({
            rows: abRows,
            prompt: document.getElementById('ab-prompt').value,
            genTokens: document.getElementById('ab-gen-tokens').value,
            reps: document.getElementById('ab-reps').value,
        }));
    } catch (e) {}
}
function abRestore() {
    try {
        const saved = JSON.parse(localStorage.getItem('launch_ab') || 'null');
        if (!saved) return;
        abRows = saved.rows || [];
        if (saved.prompt) {
            document.getElementById('ab-prompt').value = saved.prompt;
            document.getElementById('ab-prompt-token-count').innerText = `~${Math.ceil(saved.prompt.length / 4)} tokens`;
        }
        if (saved.genTokens) document.getElementById('ab-gen-tokens').value = saved.genTokens;
        if (saved.reps) document.getElementById('ab-reps').value = saved.reps;
        abRenderRows();
        abRenderResults();
    } catch (e) {}
}
function abLabelFor(config) {
    const model = (config.modelPath || '').split('/').pop().replace(/\.gguf$/, '');
    const parts = [model];
    parts.push(config.specType ? `spec=${config.specType}` : 'no-spec');
    if (config.specType) parts.push(`nmax=${config.specDraftNMax ?? '?'}`);
    if (config.specNgramSizeM != null) parts.push(`M=${config.specNgramSizeM}`);
    if (config.specNgramSizeN != null) parts.push(`N=${config.specNgramSizeN}`);
    if (config.specNgramMinHits != null) parts.push(`hits=${config.specNgramMinHits}`);
    if (config.tensorSplit != null) parts.push(`ts=${config.tensorSplit}`);
    if (config.argString) parts.push(config.argString); // extra args are part of the identity
    return parts.join(' ');
}
function abRenderRows() {
    const el = document.getElementById('ab-rows');
    if (abRows.length === 0) { el.innerHTML = '<span class="text-gray-600 text-[11px]">no configs queued -- set up the launch sidebar, then Add</span>'; return; }
    el.innerHTML = abRows.map((r, i) => `
        <div class="flex items-center gap-2 text-[11px] ${r.status === 'running' ? 'text-amber-300' : r.status === 'failed' ? 'text-orange-400' : r.status === 'done' ? 'text-green-400' : 'text-gray-300'}">
            <span class="text-gray-600">${i + 1}.</span>
            <span class="font-mono flex-1">${escapeHtml(r.label)}</span>
            <span class="text-gray-600">${r.status || 'queued'}</span>
            <button data-abrun="${i}" title="Run ONLY this row" class="text-gray-600 hover:text-green-400 px-1" ${abRunning ? 'disabled' : ''}>▶</button>
            <button data-abdel="${i}" class="text-gray-600 hover:text-red-400 px-1" ${abRunning ? 'disabled' : ''}>✕</button>
        </div>`).join('');
    el.querySelectorAll('[data-abdel]').forEach(b => b.addEventListener('click', () => {
        abRows.splice(parseInt(b.dataset.abdel), 1); abPersist(); abRenderRows();
    }));
    el.querySelectorAll('[data-abrun]').forEach(b => b.addEventListener('click', () => {
        const row = abRows[parseInt(b.dataset.abrun)];
        if (row) runSweep(row);
    }));
}
function abRenderResults() {
    const tbody = document.getElementById('ab-results-body');
    const results = abRows.flatMap(r => (r.results || []).map(res => ({ label: r.label, $therm: r.thermal, ...res })));
    document.getElementById('ab-results-card').classList.toggle('hidden', results.length === 0);
    tbody.innerHTML = results.map(r => `
        <tr class="border-b border-gray-800/50">
            <td class="px-2 py-1 font-mono text-[10px]">${escapeHtml(r.label)}</td>
            <td class="px-2 py-1 text-right font-mono">${r.promptTokens ?? '--'}</td>
            <td class="px-2 py-1 text-right font-mono text-blue-400">${r.promptTps != null ? Number(r.promptTps).toFixed(1) : '--'}</td>
            <td class="px-2 py-1 text-right font-mono">${r.genTokens ?? '--'}</td>
            <td class="px-2 py-1 text-right font-mono text-green-400">${r.genTps != null ? Number(r.genTps).toFixed(1) : '--'}</td>
            <td class="px-2 py-1 text-right font-mono text-purple-400">${r.draftAcceptRate != null ? (r.draftAcceptRate * 100).toFixed(0) + '%' : '--'}</td>
            <td class="px-2 py-1 text-right font-mono">${r.wallTime != null ? Number(r.wallTime).toFixed(1) : '--'}</td>
            <td class="px-2 py-1 text-right font-mono">${thermalCell(r.$therm)}</td>
        </tr>`).join('');
}
// Runs that were heat-limited are NOT comparable to cool ones -- mark them so
// a hot outlier is never silently averaged in with clean measurements.
function thermalCell(t) {
    if (!t) return '<span class="text-gray-600">--</span>';
    const parts = [];
    if (t.startGpu != null) parts.push(`start ${t.startGpu}/${t.startCpu ?? '?'}C`);
    if (t.maxGpu != null) parts.push(`max ${t.maxGpu}/${t.maxCpu ?? '?'}C`);
    const title = parts.join(' \u00b7 ');
    if (t.throttled) return `<span class="text-orange-400" title="${title}">THROTTLED</span>`;
    if (t.reachedTarget === false) return `<span class="text-yellow-500" title="${title}">hot start</span>`;
    return `<span class="text-gray-500" title="${title}">${t.maxGpu ?? '?'}/${t.maxCpu ?? '?'}C</span>`;
}
function abStatus(msg) { document.getElementById('ab-status').textContent = msg; }

// --- Thermal handling for sweeps ---------------------------------------
// This rig's CPU shares a heatpipe/fin stack with the 4090, so the CPU sensor
// reads total chassis heat, not CPU load (measured: 85% idle at 800-2800MHz
// while the package sat at 89C). Either sensor being hot means the next row
// starts on a heat-soaked machine, which showed up as a monotonic slowdown
// across a sweep -- an identical control config spanned 24.8-38.7 gen t/s in
// one night, far wider than any knob effect we were trying to measure.
async function readTemps() {
    try {
        const d = await (await fetch('/api/telemetry/latest')).json();
        const m = d?.stats?.master || {};
        return { gpu: Number(m.gpu_temp) || null, cpu: Number(m.cpu_temp) || null,
                 reasons: m.throttle_reasons || [] };
    } catch (e) { return { gpu: null, cpu: null, reasons: [] }; }
}
// sw_power_cap is ALWAYS on here (the 80W firmware cap) -- only thermal
// reasons indicate the run was actually heat-limited.
function isThermalReason(reasons) {
    return (reasons || []).some(r => /thermal/i.test(String(r)));
}
async function coolDownBeforeRow(label) {
    const target = parseFloat(document.getElementById('ab-cool-temp').value) || 0;
    if (target <= 0) return null;
    const maxSec = Math.max(0, parseFloat(document.getElementById('ab-cool-max').value) || 0);
    const t0 = Date.now();
    let last = await readTemps();
    // Gate on GPU temp ONLY. The CPU shares cooling with the dGPU here, so its
    // sensor lags and reads chassis heat -- gating on it would stall every row
    // for minutes on a reading that isn't what limits the GPU's clocks. CPU
    // temp is still recorded and shown, just not a gate.
    while ((Date.now() - t0) / 1000 < maxSec) {
        if (!(last.gpu != null && last.gpu > target)) break;
        const waited = Math.round((Date.now() - t0) / 1000);
        abStatus(`${label}: cooling GPU ${last.gpu}C -> ${target}C (${waited}s, CPU ${last.cpu ?? '?'}C)`);
        await new Promise(r => setTimeout(r, 5000));
        last = await readTemps();
    }
    const waited = Math.round((Date.now() - t0) / 1000);
    return { waited, gpu: last.gpu, cpu: last.cpu,
             reachedTarget: !(last.gpu != null && last.gpu > target) };
}


// --- Manual run lines: 'label :: -m <model-substring> <args...>' ---
// Resolves the -m token against the model list; label optional (defaults to
// the args). Returns {label, modelPath, rest, error}.
function parseManualLine(line, models) {
    let label = null, args = line.trim();
    const sep = args.indexOf('::');
    if (sep !== -1) { label = args.slice(0, sep).trim(); args = args.slice(sep + 2).trim(); }
    const m = args.match(/(^|\s)-m\s+(\S+)/);
    if (!m) return { error: 'line needs -m <model-substring>' };
    const needle = m[2].toLowerCase();
    const hit = models.find(mod => mod.name.toLowerCase().includes(needle) || mod.path.toLowerCase().includes(needle));
    if (!hit) return { error: `no model matches "${m[2]}"` };
    const rest = (args.slice(0, m.index) + ' ' + args.slice(m.index + m[0].length)).replace(/\s+/g, ' ').trim();
    return { label: label || args, modelPath: hit.path, rest };
}

document.getElementById('bench-queue-lines').addEventListener('click', () => {
    const lines = document.getElementById('bench-manual-lines').value.split('\n').map(l => l.trim()).filter(Boolean);
    const errs = [];
    for (const line of lines) {
        const p = parseManualLine(line, benchModelsCache);
        if (p.error) { errs.push(`${p.error}: ${line.slice(0, 40)}`); continue; }
        if (/--port|--spec-type|(^|\s)-c\s+\d{4,}/.test(p.rest)) {
            errs.push(`looks like a llama-server line (has --port/--spec-type/-c) -- paste it in the llama-server tab: ${line.slice(0, 50)}`);
            continue;
        }
        benchCustomRows.push({ label: p.label, body: { build: document.getElementById('bench-build').value, modelPath: p.modelPath, rawArgs: p.rest, label: p.label } });
    }
    persistBenchCustomRows();
    renderBenchCustomRows();
    document.getElementById('bench-status').textContent = errs.length ? errs.join(' | ') : `${lines.length - errs.length} line(s) queued`;
    if (!errs.length) document.getElementById('bench-manual-lines').value = '';
});

document.getElementById('ab-queue-lines').addEventListener('click', () => {
    const lines = document.getElementById('ab-manual-lines').value.split('\n').map(l => l.trim()).filter(Boolean);
    const models = benchModelsCache.length ? benchModelsCache : [];
    const errs = [];
    const binary = (benchBuildsCache.find(b => /cuda/i.test(b.id) || /cuda/i.test(b.label)) || benchBuildsCache[0])?.path;
    if (!binary) { abStatus('open the llama-bench tab once so builds/models load, then retry'); return; }
    for (const line of lines) {
        const p = parseManualLine(line, models);
        if (p.error) { errs.push(`${p.error}: ${line.slice(0, 40)}`); continue; }
        // llama-bench lines pasted here launch a broken llama-server -- catch
        // the telltale flags and redirect.
        if (/(^|\s)-p\s+\d|(^|\s)-d\s+\d|(^|\s)-r\s+\d/.test(p.rest) && !/--port/.test(p.rest)) {
            errs.push(`looks like a llama-bench line (has -p/-d/-r, no --port) -- paste it in the llama-bench tab: ${line.slice(0, 50)}`);
            continue;
        }
        const rawCommand = `${binary} -m ${p.modelPath} ${p.rest}`;
        abRows.push({ label: p.label, config: { rawCommand, modelPath: p.modelPath, model: p.modelPath.split('/').pop(),
            // deviceB drives the server's GPU-B telemetry request during the run
            deviceB: /vulkan2/i.test(p.rest) && /cuda0|vulkan1/i.test(p.rest) ? 'Vulkan2' : null }, status: 'queued', results: [] });
    }
    abPersist();
    abRenderRows();
    abStatus(errs.length ? errs.join(' | ') : `${lines.length - errs.length} line(s) queued`);
    if (!errs.length) document.getElementById('ab-manual-lines').value = '';
});

document.getElementById('ab-add-btn').addEventListener('click', () => {
    const config = buildConfigFromUI();
    config.rawCommand = document.getElementById('raw-launch-command').value.trim();
    abRows.push({ label: abLabelFor(config), config, status: 'queued', results: [] });
    abPersist(); abRenderRows();
});

async function abWaitForState(pred, timeoutMs, failPred) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
        if (pred()) return true;
        if (failPred && failPred(Date.now() - t0)) return false;
        await new Promise(r => setTimeout(r, 2000));
    }
    return false;
}

async function runSweep(onlyRow) {
    if (abRunning) return;
    const prompt = document.getElementById('ab-prompt').value.trim();
    if (!prompt) { abStatus('write a test prompt first'); return; }
    if (abRows.length === 0) { abStatus('nothing queued'); return; }
    const targets = onlyRow ? [onlyRow] : abRows;
    const maxTokens = parseInt(document.getElementById('ab-gen-tokens').value) || 512;
    const reps = Math.max(1, parseInt(document.getElementById('ab-reps').value) || 1);
    abRunning = true;
    document.getElementById('ab-run-btn').disabled = true;
    // Only the rows being run get reset; a single-row run leaves the others'
    // statuses and results alone.
    for (const r of targets) { r.status = 'queued'; r.results = []; }
    abRenderRows(); abRenderResults(); abPersist();
    for (const row of targets) {
        row.status = 'running'; abRenderRows();
        // Cool the machine BEFORE the load, so the row starts from a known
        // thermal state rather than inheriting the previous row's heat.
        const cool = await coolDownBeforeRow(row.label);
        abStatus(`launching: ${row.label}`);
        beginLiveSweepBlock(row.label, row.config?.rawCommand);
        row.thermal = { startGpu: cool?.gpu ?? null, startCpu: cool?.cpu ?? null,
                        cooledFor: cool?.waited ?? 0, reachedTarget: cool?.reachedTarget ?? null,
                        maxGpu: null, maxCpu: null, throttled: false };
        const thermWatch = setInterval(async () => {
            const t = await readTemps();
            const th = row.thermal;
            if (t.gpu != null) th.maxGpu = Math.max(th.maxGpu ?? 0, t.gpu);
            if (t.cpu != null) th.maxCpu = Math.max(th.maxCpu ?? 0, t.cpu);
            if (isThermalReason(t.reasons)) th.throttled = true;
        }, 5000);
        try {
            await fetch('/api/stop', { method: 'POST' }).catch(() => {});
            await new Promise(r => setTimeout(r, 3000));
            lastKnownServerError = '';
            const startRes = await fetch('/api/start', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(row.config) });
            if (!startRes.ok) throw new Error('start refused');
            const ready = await abWaitForState(
                () => lastKnownServerState === 'ready',
                15 * 60 * 1000,
                // Fail fast on a REAL reported failure (the close handler
                // broadcasts 'Launch failed: ...' the moment a process exits
                // before reaching ready -- see server4.js's proc.on('close')),
                // not on lastKnownServerState still reading 'stopped'. That
                // state check was a proxy for "never started", but it's also
                // just the default/pre-launch value, and a slow-but-healthy
                // load (this rig runs close to its VRAM ceiling and can take
                // a while past the fit-params warning before the first state
                // broadcast lands) was tripping it before the real allocator
                // ever got a chance to finish.
                (elapsed) => elapsed > 5000 && !!lastKnownServerError);
            if (!ready) {
                // pull the real reason: the broadcast error if one arrived, else
                // the last error-level lines from the server's log buffer
                let detail = lastKnownServerError;
                if (!detail) {
                    try {
                        const ml = await (await fetch('/api/master/logs')).json();
                        const errLines = (ml.logs || '').split('\n').filter(l => /\sE\s|error|failed/i.test(l)).slice(-2);
                        detail = errLines.join(' | ').slice(0, 300);
                    } catch (e) {}
                }
                throw new Error(`model never became ready${detail ? ' — ' + detail : ' (no error captured; see Master Logs)'}`);
            }
            for (let rep = 0; rep < reps; rep++) {
                abStatus(`${row.label} -- request ${rep + 1}/${reps}`);
                const completionArrived = new Promise(res => { abCaptureResolve = res; });
                console.log(`[ab-sweep] ${row.label} rep ${rep + 1}: sending request, abCaptureResolve armed = ${!!abCaptureResolve}`);
                const reqSentAt = Date.now();
                const resp = await fetch('http://localhost:8080/v1/chat/completions', {
                    method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ model: 'ab-test', messages: [{ role: 'user', content: prompt }], max_tokens: maxTokens, stream: false })
                });
                if (!resp.ok) throw new Error(`request failed (${resp.status})`);
                await resp.json();
                console.log(`[ab-sweep] ${row.label} rep ${rep + 1}: HTTP response done at +${Date.now() - reqSentAt}ms, waiting on COMPLETION broadcast`);
                // stats arrive via the COMPLETION broadcast shortly after --
                // but logCompletedRequest() awaits fetchCurrentTelemetry()
                // first, which shells out to nvidia-smi/amdgpu_top and is
                // documented (see server4.js) to take up to 10s under load --
                // worst load right when a request just finished. 15s was
                // routinely losing that race on real, successful completions
                // and reporting them as "no results captured".
                const payload = await Promise.race([completionArrived, new Promise(r => setTimeout(() => r(null), 30000))]);
                console.log(`[ab-sweep] ${row.label} rep ${rep + 1}: race settled at +${Date.now() - reqSentAt}ms, payload = ${payload ? 'RECEIVED' : 'NULL (timed out)'}`);
                abCaptureResolve = null;
                if (payload) { row.results.push(payload); addLiveSweepRep(payload, rep + 1); abRenderResults(); abPersist(); }
            }
            row.status = 'done';
        } catch (e) {
            row.status = 'failed';
            row.error = e.message;
            abStatus(`${row.label}: ${e.message}`);
        }
        clearInterval(thermWatch);
        abRenderRows(); abPersist();
        // Preserve this config's results in the shared bench transcript
        // (accordion + logs/bench-history.log) so sweeps survive like runs do.
        try {
            const noteLines = [
                `===== llama-server: ${row.label} =====`,
                `--- ${new Date().toLocaleString()} ---`,
            ];
            if (row.config && row.config.rawCommand) noteLines.push(`$ ${row.config.rawCommand}`);
            if (row.status === 'done' && (row.results || []).length > 0) {
                noteLines.push('| rep | prompt tok | prompt t/s | gen tok | gen t/s | draft acc | wall (s) |');
                noteLines.push('| --- | --- | --- | --- | --- | --- | --- |');
                row.results.forEach((r, ri) => noteLines.push(
                    `| ${ri + 1} | ${r.promptTokens ?? ''} | ${r.promptTps != null ? Number(r.promptTps).toFixed(1) : ''} | ${r.genTokens ?? ''} | ${r.genTps != null ? Number(r.genTps).toFixed(1) : ''} | ${r.draftAcceptRate != null ? (r.draftAcceptRate * 100).toFixed(0) + '%' : ''} | ${r.wallTime != null ? Number(r.wallTime).toFixed(1) : ''} |`));
                const th = row.thermal;
                if (th) {
                    noteLines.push(`[thermal] start ${th.startGpu ?? '?'}C GPU / ${th.startCpu ?? '?'}C CPU` +
                        (th.cooledFor ? ` after ${th.cooledFor}s cooldown` : '') +
                        ` | peak ${th.maxGpu ?? '?'}C / ${th.maxCpu ?? '?'}C` +
                        (th.throttled ? ' | THERMALLY THROTTLED -- not comparable to cool runs' : '') +
                        (th.reachedTarget === false ? ' | HOT START (cooldown timed out)' : ''));
                }
                noteLines.push('[sweep] done');
            } else {
                noteLines.push(`[sweep] failed: ${row.error || 'no results captured'}`);
                // The next row's launch clears masterLogBuffer immediately, so
                // a failure that isn't diagnosed right now is undiagnosable
                // later -- snapshot it into the persisted transcript while
                // it's still this row's log.
                try {
                    const ml = await (await fetch('/api/master/logs')).json();
                    // Push each log line as its OWN note line: /api/bench/note
                    // truncates every line to 2000 chars, so joining 80 lines
                    // into one string got chopped mid-word ~25 lines in, which
                    // read misleadingly like the run had died there.
                    const tail = (ml.logs || '').split('\n').slice(-80);
                    // NOT '--- ...' -- splitBenchBlocks() treats any line
                    // starting with that as a new block boundary (it's how it
                    // detects the '--- <timestamp> ---' separator), which was
                    // splitting this off into its own titleless block.
                    if (tail.some(l => l.trim())) noteLines.push('[log] master log (last 80 lines):', ...tail);
                } catch (e) { /* best-effort */ }
            }
            // Persist this run's telemetry series under the note's own key so
            // the finished block can redraw its graph later (see
            // benchBlockSamples / renderBenchChunk).
            // Only THIS row's samples, not the whole sweep so far. Saving the
            // running accumulator meant every block stored an ever-growing
            // superset -- wrong content (a block's graph showed earlier rows
            // too) and enough bulk that localStorage hit quota partway through
            // a sweep, which is why only the last block kept its graph.
            const rowSamples = benchOmniAccum.filter(s => s.t >= (liveSweepBlock?.startedAt ?? 0));
            if (rowSamples.length) {
                saveBlockSamples(`llama-server: ${row.label}|${noteLines[1].replace(/---/g, '').trim()}`, rowSamples);
            }
            await fetch('/api/bench/note', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lines: noteLines }) });
        } catch (e) { /* transcript note is best-effort */ }
        endLiveSweepBlock();
    }
    await fetch('/api/stop', { method: 'POST' }).catch(() => {});
    abRunning = false;
    document.getElementById('ab-run-btn').disabled = false;
    abStatus(onlyRow ? `done: ${onlyRow.label}` : 'sweep complete -- server stopped');
}
document.getElementById('ab-run-btn').addEventListener('click', () => runSweep(null));
document.getElementById('ab-clear-btn').addEventListener('click', () => {
    if (abRunning) return;
    abRows = []; abPersist(); abRenderRows(); abRenderResults();
});
abRestore();
document.querySelectorAll('.omni-smooth-cb').forEach(cb => {
    cb.checked = omniSmoothing;
    cb.addEventListener('change', (e) => { e.stopPropagation(); setOmniSmoothing(cb.checked); });
    cb.parentElement.addEventListener('click', (e) => e.stopPropagation());
});


// --- Bench sub-tabs: hardware (llama-bench) vs spec sweep (llama-server) ---
function setBenchSubtab(which) {
    const hw = which === 'hw';
    document.getElementById('bench-card-hw').classList.toggle('hidden', !hw);
    document.getElementById('bench-card-sweep').classList.toggle('hidden', hw);
    document.getElementById('bench-subtab-hw').className = hw
        ? 'px-3 py-1.5 rounded-md text-xs font-semibold bg-indigo-600 text-white'
        : 'px-3 py-1.5 rounded-md text-xs font-semibold bg-gray-800 text-gray-400 hover:text-gray-200';
    document.getElementById('bench-subtab-server').className = !hw
        ? 'px-3 py-1.5 rounded-md text-xs font-semibold bg-indigo-600 text-white'
        : 'px-3 py-1.5 rounded-md text-xs font-semibold bg-gray-800 text-gray-400 hover:text-gray-200';
    try { localStorage.setItem('bench_subtab', which); } catch (e) {}
}
document.getElementById('bench-subtab-hw').addEventListener('click', () => setBenchSubtab('hw'));
document.getElementById('bench-subtab-server').addEventListener('click', () => setBenchSubtab('server'));
try { setBenchSubtab(localStorage.getItem('bench_subtab') || 'hw'); } catch (e) {}
