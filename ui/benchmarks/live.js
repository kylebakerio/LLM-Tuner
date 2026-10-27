// Live view: what the running battery is doing right now, from the NDJSON event stream
// (harness/EVENTS.md) relayed over SSE as `codebench` events. Each SSE message carries the
// server's whole live snapshot, so this view is a pure function of the last snapshot plus a
// local clock (claude/agy do not stream steps, so elapsed must tick here, not from events).
// Additive on top of SSE: while a battery runs and this view is shown, GET /api/codebench/live
// every 3 s -- that response carries `tail`, the current task's transcript tail read from disk
// plus stats derived from it (tool calls, tokens, last text, files changed in the sandbox), which
// is the only live signal the cloud runners give between task_start and task_done.
// That poll also carries `tps` (server4.js codebenchTps): each task's token-weighted prefill/gen
// t/s averages. The live rates come from the /api/status stream's `external` (setLiveTps).
// The "last text" box toggles in place to the live chat (ui/livechat/index.js), whose stream is
// open only while it is shown here.
//
// Viewing a finished task (2026-09-30, Kyle: "clicking a completed item in the bottom chart should
// just show me the same live page, but populated with the previous task's info (most importantly ...
// the relative time/token chart)"). viewTask(dir, task) swaps the snapshot this view draws for
// GET /api/codebench/task-snapshot (lib/codebench.js taskSnapshot: the live snapshot's own shape,
// rebuilt from the result JSON + transcript), so the card, the attempts chart (this run at its FINAL
// numbers), the plan, the last text / transcript tail and the TASKS table are drawn by the same code.
// "← back to the running task" (backToLive) drops it; the running task stays the default, and the
// live snapshot keeps updating underneath so going back is instant. Every entry point that used to
// open the separate Transcript page (this table, the battery list, the Models tab's deep links, the
// Experiments list) now lands here instead.
// The old page's tabs are ACCORDIONS under the card, for the running task and a viewed one alike:
// Task (prompt, what is tested, goals with per-case results, failure modes), Full transcript, Scored
// result (timeline, run, server/setup, test output, patch, models used), Verify transcript. Each body
// is a persistent element loaded only when first opened and moved back in after every redraw (like the
// live chat), so a long transcript is never rebuilt by the 1 s tick; open/closed is remembered per
// accordion in localStorage.
import { esc, fmtS, fmtDur, fmtN, fmtDate, xy, xyClass, p2pCell, statusChip, anomalyChips, configLine, runInfoHtml, mergeTailEvents, isAtBottom, followScroll, btn, btnPrimary, post, api, setHtml, livePhase, pollEvery } from './util.js';
import { toolSummary, createTranscriptView, renderTaskPanel, renderResultDetails, subHue } from './transcript.js';   // the renderer library behind the accordions
import { verifyNoteText } from './experiments.js';
import { mountLiveChat } from '../livechat/index.js';
import { parseTodos, renderTodosHtml } from '../shared/todos.js';
import { difficultyBand } from '../shared/leaderboard.js';

// The model's own plan -- its latest todo list -- shown OUTSIDE the transcript box, whichever of
// "last text" / "live chat" is on: the quickest read of how it has framed the problem and where it
// is in its process (Kyle, 2026-09-25). From the transcript tail, so it works with or without the tap.
const planView = { key: null, rev: null };   // which plan version the user picked (null = latest), per task
function planPanel(ts, tail, finished) {
    const todos = (ts && ts.todos) || (ts && ts.last_todo ? [ts.last_todo] : []);
    const key = tail ? `${tail.task}#${tail.run}` : null;
    if (planView.key !== key) { planView.key = key; planView.rev = null; }
    if (todos.length) {
        const idx = planView.rev != null && planView.rev < todos.length ? planView.rev : todos.length - 1;
        const td = parseTodos(todos[idx].tool, todos[idx].input);
        if (td) {
            const vers = todos.length > 1 ? `<div class="flex flex-wrap items-center gap-1 mb-1 text-[10px] text-gray-500">plan versions:${todos.map((_, i) =>
                `<button type="button" data-plan-rev="${i}" class="px-1.5 rounded border ${i === idx ? 'border-indigo-500 text-indigo-200' : 'border-gray-700 text-gray-400'}">v${i + 1}${i === todos.length - 1 ? ' (latest)' : ''}</button>`).join('')}</div>` : '';
            return vers + renderTodosHtml(td, { name: `plan${todos.length > 1 ? ` · v${idx + 1} of ${todos.length}` : ''}`, cls: 'rounded-md border border-indigo-800 bg-gray-950 text-xs min-w-0 max-h-64 overflow-auto' });
        }
    }
    // A finished task's plan is not carried over (Kyle, 2026-09-25): the panel shows only the current task's.
    return `<div class="text-[10px] text-gray-500 border border-dashed border-gray-800 rounded px-2 py-1">plan: ${finished ? 'the model never wrote a todo list in this task' : "the model hasn't written a todo list yet"}</div>`;
}

const POLL_MS = 3000;

export function createLiveView(root, opts) {
    // (2026-10-06, Kyle's Back requirement, quoted in ui/shared/route.js) The clicks here that go somewhere -- a
    // finished task, back to the running one, another lane's battery -- are routes
    // (#bench/codebench/live[/<battery>[/<task>]]): they ask index.js for the route, and its route handler calls
    // viewTask / backToLive / choose, as it does for Back/Forward. Without a router they act directly.
    const nav = { task: (opts && opts.onTask) || viewTask, back: (opts && opts.onBack) || backToLive, battery: (opts && opts.onBattery) || choose };
    let snap = null; let receivedAt = 0; let lastError = null;   // lastError: why updates stopped, if they did
    function setError(j) { lastError = { msg: j.error, kind: j.errorKind || null, at: Date.now() }; render(); } let timer = null; let pollTimer = null; let polling = false; let dialog = false; let stopMode = 'after-task';
    let shown = false; let ext = null;
    // "last text" vs "live chat" for the running task's text box; the chat element outlives the
    // 1 s re-render (render() detaches and re-attaches it), its stream only while it is on screen.
    let textMode = 'text'; let chat = null;
    // three tabs over the same box: the model's last text, the live chat (proxy tap), the transcript tail
    try { const v = localStorage.getItem('bench_live_text'); textMode = ['chat', 'tail'].includes(v) ? v : 'text'; } catch { /* private mode */ }
    function setTextMode(m) {
        textMode = ['chat', 'tail'].includes(m) ? m : 'text';
        try { localStorage.setItem('bench_live_text', textMode); } catch { /* private mode */ }
        render();
    }
    function unmountChat() { if (chat) { chat.unmount(); chat = null; } }
    // Historical baseline per task (GET /api/models/tasks): what this task has cost every
    // config that has ever attempted it. Turns "this has been going 11 minutes" into "this has
    // been going 11 minutes and nothing has ever needed more than 5". Cheap: aggregated from
    // results already indexed, cached for 5 minutes, and a 404 (routes not live yet) is silent.
    let baselines = null; let baselinesAt = 0;
    const BASELINE_TTL = 5 * 60 * 1000;
    async function loadBaselines() {
        if (baselines && Date.now() - baselinesAt < BASELINE_TTL) return;
        try {
            const r = await fetch('/api/models/tasks');
            if (!r.ok) { baselines = baselines || {}; baselinesAt = Date.now(); return; }
            const j = await r.json();
            baselines = j.tasks || {};
            baselinesAt = Date.now();
        } catch { baselines = baselines || {}; baselinesAt = Date.now(); }
    }
    // DIFFICULTY + ODDS (Kyle, 2026-10-24: "the live view should show the problem difficulty of the problem being worked on,
    // and a predicted odds of success, and should also show those numbers in columns next to the status column for the
    // task list"). GET /api/codebench/odds (lib/liveodds.js, the Models page's fit): per task its /100 difficulty, band and
    // points, and the chance this battery's config passes it. Asked again when the battery / level / task list changes and
    // every 60 s (the fit moves when results land); an error or a 404 just leaves the columns at "—".
    let odds = null; let oddsKey = null; let oddsAt = 0; let oddsBusy = false;
    const ODDS_TTL = 60 * 1000;
    function wantOdds(battery, level, tasks) {
        if (!battery || !tasks.length || oddsBusy) return;
        const key = `${battery}|${level}|${tasks.join(',')}`;
        if (key === oddsKey && Date.now() - oddsAt < ODDS_TTL) return;
        oddsBusy = true; oddsKey = key; oddsAt = Date.now();
        api(`/api/codebench/odds?battery=${encodeURIComponent(battery)}&level=${encodeURIComponent(level || '')}&tasks=${encodeURIComponent(tasks.join(','))}`, null, 60000)
            .then((j) => { if (oddsKey === key && j && !j.error && j.tasks) { odds = { key, ...j }; render(); } })
            .catch(() => { /* columns stay "—" */ })
            .finally(() => { oddsBusy = false; });
    }
    const oddsOf = (task) => (odds && odds.tasks && odds.tasks[task]) || null;
    // the /100 difficulty: the number in its band's colour (the bands and colours are leaderboard.js DIFFICULTY_BANDS)
    const diffCell = (o) => {
        if (!o || o.difficulty == null) return '<span class="text-gray-600">—</span>';
        const b = difficultyBand(o.difficulty);
        return `<span class="font-mono" style="color:${b.text}">${Math.round(o.difficulty)}</span>`;
    };
    const oddsCell = (o) => (!o || o.p == null ? '<span class="text-gray-600">—</span>' : `<span class="font-mono text-gray-300">${Math.round(o.p * 100)}%</span>`);
    const oddsTitle = (o) => {
        if (!o) return 'difficulty /100 and predicted odds: not loaded';
        const row = odds && odds.row;
        return [o.difficulty != null ? `difficulty ${o.difficulty.toFixed(1)} / 100 (${o.band}): the strength at which a config has a 50/50 chance on it; worth ${o.points != null ? o.points.toFixed(2) : '?'} of the 100 strength points` : `${o.problem}: not in the fit (nobody has scored it), so no difficulty`,
            o.p != null && row ? `predicted odds ${Math.round(o.p * 100)}%: this config's Models-page row "${row.label}", strength ${row.strength.toFixed(1)} over ${row.n} scored tasks` : (odds && odds.why) || 'no prediction'].join('\n');
    };
    // The running task's transcript, PARSED (GET /api/codebench/transcript -> parseTranscript),
    // not the raw JSONL lines. The server's transcript reader is incremental and cached per
    // file, so re-asking every 3 s only costs the bytes that were appended.
    let tailEv = { key: null, start: 0, events: [], total: 0, note: null };
    const TAIL_EVENTS = 40, TAIL_KEEP = 300;
    async function loadParsedTail(dir, task) {
        if (!dir || !task) return;
        const key = `${dir}|${task}`;
        try {
            if (tailEv.key === key && tailEv.events.length) {
                // Incremental: re-read the last entry held (it may still be growing) and everything after it.
                const from = tailEv.start + tailEv.events.length - 1;
                const page = await api(`/api/codebench/transcript?dir=${encodeURIComponent(dir)}&task=${encodeURIComponent(task)}&from=${from}&limit=200`);
                if (page.error) { tailEv = { ...tailEv, note: page.error }; return; }
                if ((page.total || 0) < from) { tailEv = { key: null, start: 0, events: [], total: 0, note: null }; return loadParsedTail(dir, task); }   // shrank: rewritten, start over
                tailEv = { key, ...mergeTailEvents(tailEv, from, page, TAIL_KEEP), note: page.note || null };
                return;
            }
            const head = await api(`/api/codebench/transcript?dir=${encodeURIComponent(dir)}&task=${encodeURIComponent(task)}&limit=1`);
            if (head.error) { tailEv = { key, start: 0, events: [], total: 0, note: head.error }; return; }
            const total = head.total || 0;
            if (!total) { tailEv = { key, start: 0, events: [], total: 0, note: head.note }; return; }
            const from = Math.max(0, total - TAIL_EVENTS);
            const page = await api(`/api/codebench/transcript?dir=${encodeURIComponent(dir)}&task=${encodeURIComponent(task)}&from=${from}&limit=${TAIL_EVENTS}`);
            tailEv = { key, start: from, events: page.error ? [] : (page.events || []), total, note: page.error || page.note || null };
        } catch (e) { tailEv = { key, start: 0, events: [], total: 0, note: e.message }; }
    }

    // ---------- viewing a finished task (2026-09-30) ----------
    // {dir, task (the result file's name: <id> or <id>__rN), snap (task-snapshot answer), error,
    //  tailEv (its last parsed events, for the "transcript tail" box)}; null = the running task.
    let viewing = null; let viewReq = 0;
    const freshTail = () => ({ key: null, start: 0, events: [], total: 0, note: null });
    async function viewTask(dir, task, o) {
        if (!dir || !task) return;
        const req = ++viewReq;
        viewing = { dir, task, snap: null, error: null, tailEv: freshTail() };
        if (o && o.open) setAccOpen(o.open, true);   // e.g. the Experiments list's "verify transcript"
        unmountChat();
        render(true);
        try { root.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch { /* old browser */ }
        const [j] = await Promise.all([api(`/api/codebench/task-snapshot?battery=${encodeURIComponent(dir)}&task=${encodeURIComponent(task)}`), loadBaselines()]);
        if (req !== viewReq || !viewing) return;
        if (j.error) { viewing.error = j.error; render(true); return; }
        viewing.snap = j;
        render(true);
        // the "transcript tail" box: the last TAIL_EVENTS parsed entries of the finished transcript
        const q = `/api/codebench/transcript?dir=${encodeURIComponent(dir)}&task=${encodeURIComponent(task)}`;
        const head = await api(`${q}&limit=1`);
        if (req !== viewReq || !viewing) return;
        const total = head.error ? 0 : head.total || 0; const from = Math.max(0, total - TAIL_EVENTS);
        const page = total ? await api(`${q}&from=${from}&limit=${TAIL_EVENTS}`) : head;
        if (req !== viewReq || !viewing) return;
        viewing.tailEv = { key: `${dir}|${task}`, start: from, events: page.error ? [] : (page.events || []), total, note: page.error || page.note || null };
        render(true);
    }
    function backToLive() {
        viewReq++; viewing = null; resetAccBodies();
        render(true);
        polling = false; poll();
    }

    // ---------- accordions: the old Transcript page's tabs (2026-09-30) ----------
    const ACC_KEY = 'cb-live-acc';
    let accOpen = { task: true };   // goals are the one section open by default
    try { const v = JSON.parse(localStorage.getItem(ACC_KEY) || 'null'); if (v && typeof v === 'object') accOpen = v; } catch { /* private mode: defaults */ }
    function setAccOpen(k, on) {
        accOpen = { ...accOpen, [k]: !!on };
        try { localStorage.setItem(ACC_KEY, JSON.stringify(accOpen)); } catch { /* session only */ }
    }
    const accBodies = new Map();   // key -> {el, id, loaded, tv}
    let accCtx = null;             // what the accordions are about right now (set by render)
    function accBody(k) {
        let bd = accBodies.get(k);
        if (!bd) { const el = document.createElement('div'); el.className = 'mt-2'; bd = { el, id: null, loaded: false, tv: null }; accBodies.set(k, bd); }
        return bd;
    }
    function resetAccBodies() {
        for (const bd of accBodies.values()) { if (bd.tv) bd.tv.stop(); bd.tv = null; bd.loaded = false; bd.id = null; bd.el.innerHTML = ''; }
    }
    // A DOM move resets scrollTop: keep every inner scroller's position across the redraw's detach/attach.
    const SCROLLERS = '[data-streamwrap], .overflow-auto, .overflow-y-auto';
    function detachAccBodies() {
        for (const bd of accBodies.values()) {
            if (!bd.el.parentNode) continue;
            // bd.el ITSELF is a scroller when it is the finished task's transcript box (overflow-auto, fixed height):
            // querySelectorAll only sees descendants, so its own position was dropped on every 3 s poll and the
            // transcript jumped back to the top a moment after you scrolled it (Kyle, 2026-10-01).
            bd.saved = [bd.el, ...bd.el.querySelectorAll(SCROLLERS)].filter((e) => e.scrollTop > 0).map((e) => [e, e.scrollTop]);
            bd.el.remove();
        }
    }
    function accLoad(k) {
        const ctx = accCtx; if (!ctx) return;
        const bd = accBody(k);
        if (bd.id !== ctx.id) { if (bd.tv) bd.tv.stop(); bd.tv = null; bd.loaded = false; bd.el.innerHTML = ''; bd.id = ctx.id; }
        // loaded once per task; the running task's transcript polls (and appends) only while its accordion
        // is open, so closing it stops the poll and clears `loaded` (attachAccBodies' toggle handler)
        if (bd.loaded) return;
        bd.loaded = true;
        const id = ctx.id; const still = () => accCtx && accCtx.id === id && bd.id === id;
        if (k === 'task') {
            bd.el.innerHTML = '<div class="text-xs text-gray-500">loading the task context…</div>';
            api(`/api/codebench/task?id=${encodeURIComponent(ctx.base)}`).then((info) => {
                if (!still()) return;
                bd.el.innerHTML = renderTaskPanel(info.error ? null : info, {
                    error: info.error || null, promptLevel: ctx.promptLevel || 'L2',
                    promptLevelSource: ctx.promptLevel ? "from this run's config" : 'assumed: no prompt_level recorded',
                    assertions: ctx.assertions, anomalies: ctx.anomalies, status: ctx.status, cases: ctx.cases, progress: ctx.progress, live: !ctx.finished,
                });
            });
        } else if (k === 'transcript' || k === 'verify') {
            let host = bd.el;
            if (k === 'verify') {
                bd.el.innerHTML = `<div class="mb-2 border border-yellow-700/60 rounded-lg px-3 py-1.5 text-xs text-yellow-300 bg-yellow-900/20">${esc(verifyNoteText(ctx.verify))} — the extra "verify your work" turn after this run scored fail. Side experiment: never counted in mainline results.</div><div></div>`;
                host = bd.el.lastElementChild;
            }
            if (bd.tv) bd.tv.stop();
            // live: the running task's box (a cloud runner, or opencode with sub-agents) opens what the live chat would
            bd.tv = createTranscriptView(host, { streamOnly: true, live: k === 'transcript' && !ctx.finished });
            bd.tv.open({ dir: ctx.dir, task: ctx.file, which: k === 'verify' ? 'verify' : null });
        } else if (k === 'result') {
            if (!ctx.finished) { bd.el.innerHTML = '<div class="text-xs text-gray-500">the running task has no scored result yet — it lands here when the task is scored (click its row in TASKS then)</div>'; return; }
            bd.el.innerHTML = '<div class="text-xs text-gray-500">reading the result…</div>';
            api(`/api/codebench/result?dir=${encodeURIComponent(ctx.dir)}&task=${encodeURIComponent(ctx.file)}`).then((j) => {
                if (!still()) return;
                bd.el.innerHTML = j.error ? `<div class="text-xs text-yellow-400">${esc(j.error)}</div>` : renderResultDetails(j);
            });
        }
    }
    // Layout (2026-10-01, Kyle): the Task section sits ABOVE the card (above the comparison chart and the chat);
    // there is no separate "full transcript" section any more -- the text box's chat mode is the conversation (the
    // live chat while running, the full transcript for a finished task).
    function accordionsHtml(ctx, which = 'below') {
        if (!ctx) return '';
        const list = which === 'above'
            ? [['task', 'task — prompt · what is tested · goals (hidden tests, per case) · expected failure modes']]
            : [['result', 'scored result — outcome · timeline · run · server / setup · hidden-test and pass_to_pass output · patch · models used · raw transcript tail']];
        if (which !== 'above' && ctx.verify && ctx.verify.kind === 'attempt') list.push(['verify', `verify follow-up transcript — side experiment, not counted (${verifyNoteText(ctx.verify)})`]);
        return `<div class="mt-2 space-y-1">${list.map(([k, title]) => `<details data-acc="${k}" class="border border-gray-800 rounded-lg px-3 py-1.5 bg-gray-900/40" ${accOpen[k] ? 'open' : ''}>
            <summary class="text-[11px] text-gray-300 cursor-pointer select-none">${esc(title)}</summary><div data-acc-host="${k}" data-keep></div></details>`).join('')}</div>`;
    }
    function attachAccBodies() {
        for (const host of root.querySelectorAll('[data-acc-host]')) {
            const k = host.dataset.accHost; const bd = accBody(k); const det = host.closest('details');
            if (bd.el.parentNode !== host) host.appendChild(bd.el);   // already there after a merge: appending again would MOVE it
            if (det.open) accLoad(k);
            det.addEventListener('toggle', () => {
                if (!!accOpen[k] === det.open) return;   // the parser's own toggle for a details born open
                setAccOpen(k, det.open);
                if (det.open) accLoad(k); else if (bd.tv && !(accCtx && accCtx.finished)) { bd.tv.stop(); bd.loaded = false; }
            });
        }
    }

    function update(live) {
        // SSE snapshots carry no `tail` (the server keeps disk reads off the event path): keep the last polled one.
        if (live && live.tail === undefined && snap && snap.tail !== undefined) live.tail = live.running ? snap.tail : null;
        if (live && live.tps === undefined && snap && snap.tps !== undefined) live.tps = snap.tps;   // same for the per-task t/s
        if (live && live.batteries === undefined && snap && snap.batteries !== undefined) live.batteries = snap.batteries;   // and the lane switcher's list
        // ...and the queue item behind the battery (question / notes), while it is still the same battery
        if (live && live.queue_item === undefined && snap && snap.queue_item !== undefined && live.battery && snap.battery && live.battery.name === snap.battery.name) live.queue_item = snap.queue_item;
        // Another battery's snapshot while the one chosen here still runs: drop it (2026-10-22). The SSE stream and the
        // Bench tab's 15 s poll carry the server's ONE adopted battery, which follows whichever lane any viewer asked for
        // last (another tab, another device). Drawn, it swapped the whole view to that lane for up to 3 s: the box's
        // chat reconnected to the other tap and the transcript body was emptied (accCtx changed), so everything the
        // reader had opened was rebuilt closed (util.js createOpenChoices, "what clobbers it"). Our own poll names
        // `chosen`, so its answers always pass. Only once the chosen battery is on screen: before that, any snapshot
        // starts the view (and its poll, which then asks for the chosen one).
        const runningDirs = (live && live.batteries) || (snap && snap.batteries) || [];
        const showingChosen = !!(snap && snap.battery && snap.battery.name === chosen);
        if (chosen && showingChosen && live && live.battery && live.battery.name && live.battery.name !== chosen && runningDirs.some((x) => x.dir === chosen)) return;
        snap = live; receivedAt = Date.now(); lastError = null;
        // While a finished task is on screen the live snapshot updates underneath (Back is instant);
        // redraw only when the TASKS table under it is this live battery's.
        if (viewing && !(viewing.snap && live && live.battery && viewing.snap.battery && viewing.snap.battery.name === live.battery.name)) return;
        render();
    }
    // Lane switcher: with the cloud and local queue lanes both running there are two batteries; the
    // server follows the one named here (?battery=), else the newest. Remembered per browser.
    let chosen = null;
    try { chosen = localStorage.getItem('cb-live-battery') || null; } catch { chosen = null; }
    function choose(dir) {
        try { const sel = window.getSelection && window.getSelection(); if (sel) sel.removeAllRanges(); } catch { /* no selection API */ }
        pointerDown = false;
        chosen = dir || null;
        try { if (chosen) localStorage.setItem('cb-live-battery', chosen); else localStorage.removeItem('cb-live-battery'); } catch { /* storage blocked: session-only choice */ }
        polling = false; poll();
    }
    // A lane's display name (2026-10-02, Kyle: the chips read "local-gpu" / "local-3060"): the card and engine the
    // lanes poll inferred from where the lane's processes hold VRAM ("XTX Strata", "3060 llama"; script.js
    // pollLanesLive -> window.__lanesLive), else the lane id without its "local-" prefix ("3060", "XTX"). The id
    // stays in the tooltip.
    function laneName(lane) {
        if (!lane) return '?';
        if (lane === 'cloud') return 'cloud';
        const L = window.__lanesLive;
        const hit = L && Date.now() - L.at < 15000 ? (L.lanes || []).find((l) => l.lane === lane) : null;
        if (hit && hit.label && hit.label !== lane.replace(/^local-/, '')) return hit.label;
        const id = lane.replace(/^local-/, '');
        return id === 'gpu' ? 'GPU' : id.toUpperCase().replace(/TI$/, ' Ti');
    }
    function switcherHtml(s, b) {
        const list = s.batteries || [];
        if (list.length < 2) return '';
        return `<div class="flex flex-wrap items-center gap-1 text-[11px] mb-2"><span class="text-gray-500 mr-1">running now:</span>${list.map((x) => {
            const on = x.dir === b.name;
            const lane = x.lane === 'cloud' ? 'bg-indigo-600/20 text-blue-300' : 'bg-green-900/40 text-green-300';   // classes present in vendor/tailwind.css
            return `<button type="button" data-battery="${esc(x.dir)}" class="px-2 py-0.5 rounded border ${on ? 'border-indigo-500 text-gray-100' : 'border-gray-700 text-gray-400 hover:text-gray-200'}" title="${esc(`lane ${x.lane} · ${x.runner || '?'} · ${x.model || '?'}${x.tasks != null ? ` · ${x.tasks} tasks` : ''}`)}"><span class="px-1 rounded text-[10px] font-semibold ${lane}">${esc(laneName(x.lane))}</span> <span class="font-mono">${esc(x.dir)}</span></button>`;
        }).join('')}</div>`;
    }
    // What the running battery is FOR (2026-10-07, Kyle: "the 'notes' for the queue item being run on a given lane
    // should be prominently visible in the 'live' summary"): the queue item's question, Kyle's own note on it (both
    // queue_meta, edited on the Queue page) and the item's notes -- long, so the first part shows and the rest
    // opens. Plain markup like the rest of the head: setHtml keeps a keyed <details> open across the 1 s redraws,
    // and a redraw is skipped while text is being selected (show()).
    const NOTES_HEAD = 260;
    function queueItemHtml(q) {
        if (!q || !(q.question || q.user_note || q.notes)) return '';
        const notes = String(q.notes || '').trim();
        let cut = notes.length > NOTES_HEAD + 80 ? notes.lastIndexOf(' ', NOTES_HEAD) : -1;
        if (cut < NOTES_HEAD / 2) cut = notes.length > NOTES_HEAD + 80 ? NOTES_HEAD : -1;
        const notesHtml = !notes ? '' : cut < 0
            ? `<div class="text-[11px] text-gray-300 whitespace-pre-wrap break-words mt-1">${esc(notes)}</div>`
            : `<details class="mt-1" data-key="qitem-notes:${q.id}"><summary class="text-[11px] text-gray-300 cursor-pointer break-words">${esc(notes.slice(0, cut))}… <span class="text-indigo-300">show all (${fmtN(notes.length)} characters)</span></summary>
                <div class="text-[11px] text-gray-300 whitespace-pre-wrap break-words">${esc(notes.slice(cut).trimStart())}</div></details>`;
        return `<div class="mt-2 rounded-lg border border-amber-700 bg-gray-900 px-3 py-2" data-queue-item="${q.id}">
            <div class="text-[10px] uppercase tracking-wider text-amber-200">what this run is for <span class="normal-case text-gray-500">· queue item #${q.id} on ${esc(laneName(q.lane))}</span></div>
            ${q.question ? `<div class="text-base font-semibold text-white leading-snug break-words">${esc(q.question)}</div>` : ''}
            ${q.user_note ? `<div class="mt-1 text-xs text-amber-200 whitespace-pre-wrap break-words"><span class="text-[10px] uppercase tracking-wider text-gray-500">Kyle's note</span> ${esc(q.user_note)}</div>` : ''}
            ${notes ? `<div class="mt-1 text-[10px] uppercase tracking-wider text-gray-500">item notes</div>${notesHtml}` : ''}
        </div>`;
    }
    function localElapsed(base) { return (base || 0) + (Date.now() - receivedAt) / 1000; }
    async function poll() {
        if (polling || !(snap && snap.running)) return;
        polling = true;
        try {
            const j = await api(chosen ? `/api/codebench/live?battery=${encodeURIComponent(chosen)}` : '/api/codebench/live');
            // Lane names for the "running now" chips (laneName): the sidebar's lanes poll pauses in a hidden tab and
            // only runs while a lane is busy, so fetch them here too when the switcher is showing and they are stale.
            if ((j.batteries || []).length > 1 && !(window.__lanesLive && Date.now() - window.__lanesLive.at < 10000)) {
                try { const L = await api('/api/lanes/live'); if (L && Array.isArray(L.lanes)) window.__lanesLive = { ...L, at: Date.now() }; } catch { /* names fall back to the lane id */ }
            }
            if (j.error) setError(j); else {
                await loadBaselines();
                const c = j.current, dir = j.battery && j.battery.name;
                if (c && dir && !viewing) await loadParsedTail(dir, c.run > 1 ? `${c.task}__r${c.run}` : c.task);
                update(j);
            }
        } catch { /* next tick */ } finally { polling = false; }
    }
    function show() {
        shown = true;
        render();
        if (!timer) timer = setInterval(() => { if (snap && snap.running && !viewing) render(); }, 1000);   // a finished task has no clock
        if (!pollTimer) pollTimer = pollEvery(poll, POLL_MS, { now: true });   // nothing while the page is hidden (ui/shared/poll.js)
    }
    function hide() { shown = false; unmountChat(); resetAccBodies(); if (timer) { clearInterval(timer); timer = null; } if (pollTimer) { pollTimer.stop(); pollTimer = null; } }
    // `external` from the /api/status stream (server4.js pollExternalSlots): the unmanaged server's
    // instantaneous rates while a request runs, `last` = the previous request's. Null when LL-Dash runs its own.
    function setLiveTps(e) { ext = e || null; }

    // "pp 246 · gen 18.4" for one task's averages, "—" when nothing was recorded for it.
    const TPS_SRC = { tap: 'exact llama-server timings from the proxy tap', slots: 'the 1 Hz /slots poll (generation only, sampled: reads a few % low)', db: 'the request log (logs/bench.sqlite) over the task\'s time window' };
    const f0 = (v) => (v == null ? '—' : Number(v).toFixed(0));
    const f1 = (v) => (v == null ? '—' : Number(v).toFixed(1));
    function tpsOf(t, src) { const sn = src || snap; const m = sn && sn.tps; return m ? m[`${t.task}#${t.run || 1}`] || null : null; }
    function tpsTitle(r) {
        if (!r) return 'no requests recorded for this task (queue-launched servers reach the request log only after codebench\'s db-import-llama-logs.py runs)';
        return `token-weighted over ${r.n} request${r.n === 1 ? '' : 's'}: ${fmtN(r.prompt_n)} tokens prefilled, ${fmtN(r.predicted_n)} generated\nsource: ${String(r.src || '').split('+').map((k) => TPS_SRC[k] || k).join(' + ')}`;
    }
    const approx = (r) => (r && /slots/.test(r.src || '') ? '≈' : '');   // any sampled request in the mix
    function tpsCell(r) { return r ? `pp ${f0(r.pp)} · gen ${approx(r)}${f1(r.gen)}` : '—'; }
    // What this battery's lane is doing right now (2026-10-01, Kyle: the chip "only ever shows live pp or idle").
    // It read the :8080 server's /slots status, which is one lane, and whose generation is invisible when the engine
    // is Strata behind the record proxy -- so a generating task showed its last prefill rate or idle. The lanes poll
    // (script.js pollLanesLive -> window.__lanesLive) has every lane's phase and live rates; this battery's lane is
    // the one whose queue item is the battery. Falls back to the /slots status when no lane matches.
    // This battery's lane in the last lanes poll (fresh within 6 s), and how long ago the browser got it.
    function laneOf(name) {
        const L = window.__lanesLive;
        if (!name || !L || !(Date.now() - L.at < 6000)) return null;
        const l = (L.lanes || []).find((x) => x.item === name);
        return l ? { l, sinceMs: Date.now() - L.at } : null;
    }
    function laneLiveText(name) {
        const hit = laneOf(name);
        if (!hit) return null;
        const l = hit.l;
        if (l.phase === 'gen' && Number(l.gen) > 0) return `live gen ${f1(l.gen)}`;
        if (l.phase === 'prefill' && Number(l.prefill) > 0) return `live pp ${f0(l.prefill)}`;
        if (l.phase && l.phase !== 'idle') return `live: ${l.phase}`;
        return 'idle';
    }
    // ---------- reading the prompt / generating, at the foot of the transcript box (2026-10-22) ----------
    // Kyle: "when doing prefill, there should be an animation showing prefill is happening, and stats on generation and
    // on prefill should be right there, inline." One strip under whichever renderer fills the box (the live chat or the
    // transcript view), so neither carries a copy. Its words and fraction come from util.js livePhase over the lane's
    // record (both engines, one shape: lib/lanetps.js laneRates); the bar is the engine's own read / total while the
    // prompt is read -- moving stripes when the engine gives no total, never a timer -- and a pulse while generating.
    // The element persists and only its text and width change, so the animation runs on through the 1 s redraws.
    // A battery LL-Dash launched itself (no queue lane) falls back to the :8080 /slots status (`ext`): rates only.
    const phaseEl = document.createElement('div');
    phaseEl.className = 'lp-foot shrink-0';
    phaseEl.innerHTML = '<div class="lp-track"><div class="lp-fill"></div></div><div class="lp-text"><span class="lp-dot"></span><span class="lp-words"></span></div>';
    let phaseSeen = { at: null, read: null };   // this request's read, as watched: {at: when it was sent (browser clock), read}
    // The strip follows each lanes answer as it arrives (script.js applyLanesLive -> 'laneslive': the 1 s tick, and the
    // edges server4.js pushes the moment a lane's tap or engine changes phase), not only this view's 1 s redraw: that
    // wait was up to a second of the "second or two late" Kyle saw (2026-10-22). phaseArgs = the last render's call.
    let phaseArgs = null;
    window.addEventListener('laneslive', () => { if (shown && phaseArgs && phaseArgs[0] && phaseArgs[0].isConnected) paintPhase(phaseArgs[0], phaseArgs[1]); });
    function ensurePhaseStyle() {
        if (document.getElementById('lp-style')) return;
        const st = document.createElement('style');
        st.id = 'lp-style';   // vendor/tailwind.css is prebuilt: only pulse / spin / ping exist there
        st.textContent = `.lp-foot{padding:.35rem .5rem .4rem;border:1px solid #1f2937;border-top:0;border-radius:0 0 .25rem .25rem;background:#0b0f19}
.lp-foot[hidden]{display:none}
.lp-track{position:relative;height:4px;border-radius:9999px;background:rgba(129,140,248,.14);overflow:hidden;margin-bottom:.3rem}
.lp-fill{position:absolute;inset:0 auto 0 0;width:0;border-radius:9999px;background:linear-gradient(90deg,#6366f1,#a5b4fc,#6366f1);background-size:200% 100%;animation:lp-sheen 1.1s linear infinite;transition:width .9s ease-out}
.lp-foot.is-indet .lp-fill{width:32%;transition:none;animation:lp-slide 1.25s ease-in-out infinite,lp-sheen 1.1s linear infinite}
.lp-foot[data-phase=gen] .lp-track,.lp-foot[data-phase=busy] .lp-track{display:none}
.lp-text{display:flex;align-items:center;gap:.4rem;font:500 10.5px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;color:#9ca3af;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.lp-foot[data-phase=prefill] .lp-text{color:#c7d2fe}.lp-foot[data-phase=gen] .lp-text{color:#a7f3d0}
.lp-dot{flex:none;width:7px;height:7px;border-radius:9999px;background:#6b7280}
.lp-foot[data-phase=prefill] .lp-dot{background:#818cf8;animation:lp-pulse 1s ease-in-out infinite}
.lp-foot[data-phase=gen] .lp-dot{background:#34d399;animation:lp-pulse .7s ease-in-out infinite}
.lp-words{overflow:hidden;text-overflow:ellipsis}
@keyframes lp-sheen{from{background-position:200% 0}to{background-position:0 0}}
@keyframes lp-slide{0%{transform:translateX(-110%)}100%{transform:translateX(330%)}}
@keyframes lp-pulse{0%,100%{opacity:.35;transform:scale(.8)}50%{opacity:1;transform:scale(1.15)}}
@media (prefers-reduced-motion: reduce){.lp-fill,.lp-dot{animation:none!important}}`;
        document.head.appendChild(st);
    }
    // name: the battery on screen; host: the transcript box (null = not showing: the strip leaves with it)
    function paintPhase(host, name) {
        let hit = laneOf(name);
        if (!hit && ext && ext.busy) hit = { l: { phase: ext.genTps != null ? 'gen' : 'prefill', gen: ext.genTps, prefill: ext.prefillTps, prefillSrc: 'slots' }, sinceMs: 0 };
        const l = hit && hit.l;
        // remember this request's read while it happens, to name it once generation starts
        const sentAt = l && l.reqAgeMs != null ? Date.now() - hit.sinceMs - l.reqAgeMs : null;
        if (sentAt != null && (phaseSeen.at == null || Math.abs(sentAt - phaseSeen.at) > 2000)) phaseSeen = { at: sentAt, read: null };
        if (l && l.phase === 'prefill' && l.total) phaseSeen.read = { read: l.read, total: l.total, tps: l.prefillSrc === 'slots' || l.prefillSrc === 'metrics' ? l.prefill : null };
        const p = livePhase(l, hit ? hit.sinceMs : 0, phaseSeen.read);
        if (!host || !p) { phaseEl.hidden = true; return; }
        ensurePhaseStyle();
        phaseEl.hidden = false;
        phaseEl.dataset.phase = p.phase;
        phaseEl.classList.toggle('is-indet', p.phase === 'prefill' && p.pct == null);
        phaseEl.querySelector('.lp-fill').style.width = p.pct == null ? '' : `${p.pct.toFixed(1)}%`;
        const words = phaseEl.querySelector('.lp-words');
        if (words.textContent !== p.text) { words.textContent = p.text; phaseEl.title = p.text; }
        if (host.lastElementChild !== phaseEl) host.appendChild(phaseEl);   // last in the box, under the chat / transcript
    }
    function liveTpsText(name) {
        const lane = laneLiveText(name);
        if (lane) return lane;
        const e = ext;
        if (!e) return '';
        if (e.busy && e.genTps != null) return `live gen ${f1(e.genTps)}`;
        if (e.busy && e.prefillTps != null) return `live pp ${f0(e.prefillTps)}`;
        if (e.busy) return 'live: starting';
        return e.last ? `idle · last request pp ${f0(e.last.promptTps)} · gen ${f1(e.last.genTps)}` : 'idle';
    }

    // The transcript tail, rendered as what it IS rather than as raw JSON. Kinds come from
    // the server's own parser (parseTranscript, via GET /api/codebench/transcript), so this
    // view and the full Transcript view agree on what an entry is; the raw JSON for any one
    // entry is one click away for when the summary is not enough.
    const KIND_STYLE = {
        prompt: ['prompt', 'bg-gray-700 text-gray-200'],
        text: ['text', 'bg-indigo-900/60 text-indigo-200'],
        reasoning: ['thinking', 'bg-purple-900/50 text-purple-200'],
        tool_call: ['tool use', 'bg-sky-900/60 text-sky-200'],
        tool_result: ['tool result', 'bg-slate-700 text-slate-200'],
        compaction: ['compaction', 'bg-yellow-900/50 text-yellow-200'],
        error: ['error', 'bg-red-900/60 text-red-200'],
        finish: ['finish', 'bg-green-900/50 text-green-200'],
        subagent: ['sub-agent', 'bg-pink-900/60 text-pink-200'],
    };
    function oneLine(str, n) {
        const t = String(str == null ? '' : str).replace(/\s+/g, ' ').trim();
        return t.length > n ? t.slice(0, n) + '…' : t;
    }
    function tailEntryLine(e) {
        if (e.kind === 'subagent') return `sub-agent ${e.sub} started${e.agent ? ` (@${e.agent})` : ''}: ${oneLine(e.description || e.title || e.text, 200)}`;
        if (e.kind === 'tool_call') return `${e.tool ? e.tool + ': ' : ''}${oneLine(toolSummary(e.input), 200)}`;
        if (e.kind === 'tool_result') return `${e.error ? 'ERROR — ' : ''}${oneLine((e.output || '').split('\n').find((l) => l.trim()) || '(no output)', 200)}`;
        if (e.kind === 'finish') {
            const tk = e.tokens || {};
            return `${e.reason || 'done'}${tk.out != null ? ` · ${fmtN(tk.out)} tok out` : ''}${tk.in != null ? ` / ${fmtN(tk.in)} in` : ''}`;
        }
        // text / thinking / prompt / error / compaction: the tail of what was said is the part
        // that matters while it is still being said.
        const t = String(e.text || '');
        return oneLine(t.length > 220 ? '…' + t.slice(-220) : t, 240) || '(empty)';
    }
    // `hold`: whose parsed tail -- the running task's (tailEv) or a viewed finished task's (viewing.tailEv).
    function renderParsedTail(c, tail, hold, batteryName) {
        const tailEv = hold || freshTail();
        const key = `${batteryName || ''}|${c.run > 1 ? `${c.task}__r${c.run}` : c.task}`;
        const fresh = tailEv.key === key;
        const evs = fresh ? tailEv.events : [];
        if (!evs.length) {
            // Nothing parsed yet: fall back to the cheap raw tail rather than showing nothing.
            if (!tail) return '';
            if (tail.finished) return `<div class="text-[10px] text-gray-500">${fresh && tailEv.note ? esc(tailEv.note) : (fresh ? '(the transcript has no parsed entries)' : 'reading the transcript…')}</div>`;   // a viewed task: no raw tail kept
            return `<details data-key="tail:${esc(c.task)}">
                <summary class="text-[10px] text-gray-500 cursor-pointer">raw transcript tail — last ${tail.lines.length} line(s)${fresh && tailEv.note ? ` · ${esc(tailEv.note)}` : ''}</summary>
                <pre data-key="tailpre:${esc(c.task)}" data-follow class="text-[10px] font-mono text-gray-400 bg-gray-950 border border-gray-800 rounded p-2 max-h-72 overflow-auto whitespace-pre-wrap break-all">${esc(tail.lines.length ? tail.lines.join('\n') : (tail.note || '(empty)'))}</pre>
            </details>`;
        }
        // Oldest first, newest at the bottom, like `tail -f`: the box follows new entries while the
        // reader is at the bottom and stays put once they scroll up (render() -> followScroll).
        const rows = evs.map((e, i) => {
            const [label, cls] = KIND_STYLE[e.kind] || [e.kind || 'event', 'bg-gray-700 text-gray-300'];
            return `<div class="flex items-start gap-2 py-0.5 border-b border-gray-800/50 last:border-0">
                <span class="shrink-0 px-1 py-0.5 rounded text-[9px] font-mono ${cls}">${esc(label)}</span>${e.sub ? `<span class="shrink-0 px-1 py-0.5 rounded text-[9px] font-mono" style="color:${subHue(e.sub)};border:1px solid ${subHue(e.sub)}66" title="an event of sub-agent ${esc(e.sub)}${e.sub_agent ? ` (@${esc(e.sub_agent)})` : ''}">sub ${esc(e.sub)}</span>` : ''}
                <span class="shrink-0 text-[9px] font-mono text-gray-600 w-12 text-right">${e.t_s == null ? '' : fmtS(e.t_s)}</span>
                <span class="flex-1 min-w-0 text-[10px] font-mono text-gray-300 truncate" title="${esc(tailEntryLine(e))}">${esc(tailEntryLine(e))}</span>
                <details class="shrink-0" data-key="ev:${esc(c.task)}:${esc(e.key ?? `i${tailEv.start + i}`)}">
                    <summary class="text-[9px] text-gray-600 cursor-pointer select-none">raw</summary>
                    <pre data-key="evpre:${esc(c.task)}:${esc(e.key ?? `i${tailEv.start + i}`)}" class="mt-1 text-[9px] font-mono text-gray-500 bg-gray-950 border border-gray-800 rounded p-1 max-h-60 max-w-[48rem] overflow-auto whitespace-pre-wrap break-all">${esc(JSON.stringify(e, null, 1))}</pre>
                </details>
            </div>`;
        }).join('');
        return `<details open data-key="tail:${esc(c.task)}">
            <summary class="text-[10px] text-gray-500 cursor-pointer">transcript tail — last ${evs.length} of ${fmtN(tailEv.total)} parsed entries, newest at the bottom${tail && tail.finished ? ' (the whole run: "full transcript" above)' : ' (follows new entries while you are at the bottom)'}</summary>
            <div data-key="tailbox:${esc(c.task)}" data-follow class="mt-1 bg-gray-950 border border-gray-800 rounded p-2 max-h-72 overflow-auto">${rows}</div>
        </details>`;
    }

    // Per-task "everyone who tried this" chart (Kyle, 2026-09-29): every scored config's latest attempt,
    // pass (green) and fail (red), sorted by wall time or tokens out, with THIS run so far (amber)
    // slotted in where it currently stands. From /api/models/tasks `attempts`.
    let attemptsMetric = 'time';
    try { attemptsMetric = localStorage.getItem('cb-live-attempts-metric') || 'time'; } catch { /* default */ }
    // view: a finished task (2026-09-30) -- THIS run is its own attempt in the list (matched by battery dir),
    // drawn at its final numbers; a run not in the list (excluded status, or a later battery of the same
    // config superseded it) is added from the result file instead.
    function attemptsChartHtml(base, elapsed, tokensOut, view) {
        const list0 = (base && base.attempts) || [];
        if (!list0.length && !view) return '';
        const key = attemptsMetric === 'tokens' ? 'tokens_out' : 'wall_s';
        const fmt = (v) => (v == null ? '—' : key === 'wall_s' ? fmtS(v) : fmtN(Math.round(v)));
        let list = list0, me;
        if (view) {
            const own = list0.find((a) => a.dir === view.dir);
            // status from THIS file: with --runs N the config's history row may be another run's
            me = { ...(own || { cfg: '' }), model: `this run (final${own ? '' : ', not in the history'})`, status: view.status, solved: /^pass/.test(view.status || ''), me: true, wall_s: elapsed, tokens_out: tokensOut };
            list = list0.filter((a) => a !== own);
        } else me = { model: 'this run (so far)', cfg: '', status: 'running', me: true, wall_s: elapsed, tokens_out: tokensOut };
        const rows = list.filter((a) => a[key] != null).concat(me[key] != null ? [me] : []).sort((a, b) => a[key] - b[key]);
        const max = Math.max(1, ...rows.map((a) => a[key]));
        const mb = (m, label) => `<button type="button" data-attempts-metric="${m}" class="chip${attemptsMetric === m ? ' is-on' : ''}">${label}</button>`;
        return `<details class="mt-1" ${attemptsOpen ? 'open' : ''} data-attempts-details>
            <summary class="text-[10px] text-gray-400 cursor-pointer select-none">every config that tried this task: ${list0.length} (${list0.filter((a) => a.solved).length} passed) — sorted by ${key === 'wall_s' ? 'time' : 'tokens out'}${view ? ` — this run: ${esc(view.status || '?')}` : ''}</summary>
            <div class="flex flex-wrap items-center gap-3 text-[11px] mt-1.5"><span class="chip-group">${mb('time', 'time')}${mb('tokens', 'tokens out')}</span>
                <span class="legend-item text-gray-400"><span class="legend-sw bg-emerald-500"></span>pass</span><span class="legend-item text-gray-400"><span class="legend-sw bg-red-500"></span>fail</span><span class="legend-item text-gray-400"><span class="legend-sw bg-orange-400"></span>this run</span></div>
            <!-- One grid for every row (2026-10-01, Kyle): names were cut at a fixed 10rem and >1 h times wrapped in a
                 fixed 4rem. Now the name column fits the longest name (capped at 30rem), the time column its widest value. -->
            <div class="mt-1.5 overflow-y-auto pr-1 grid items-center gap-x-3 gap-y-1" style="max-height:16rem;grid-template-columns:fit-content(30rem) minmax(6rem,1fr) max-content">${rows.map((a) => {
                const tip = esc(`${a.model}${a.cfg ? ' · ' + a.cfg : ''} — ${a.status}${a.me && !view ? '' : ` · ${fmtS(a.wall_s)} · ${fmtN(a.tokens_out)} tok out${a.tokens_in != null ? ` · ${fmtN(a.tokens_in)} tok in` : ''}`}`);
                const tone = a.me ? 'text-orange-300 font-semibold' : 'text-gray-300';
                return `
                <span class="text-[11px] ${tone} truncate min-w-0" title="${tip}">${esc(a.model)}${a.cfg ? ` <span class="text-gray-500 font-normal">${esc(a.cfg)}</span>` : ''}</span>
                <span class="h-2 bg-gray-800 rounded-full overflow-hidden" title="${tip}"><span class="block h-2 rounded-full ${a.me ? 'bg-orange-400' : a.solved ? 'bg-emerald-500' : 'bg-red-500'}" style="width:${Math.max(1, (a[key] / max) * 100).toFixed(1)}%"></span></span>
                <span class="text-[11px] ${tone} text-right font-mono whitespace-nowrap" title="${tip}">${fmt(a[key])}</span>`;
            }).join('')}</div>
        </details>`;
    }
    let attemptsOpen = true;
    // Selecting text must survive the 1 s redraw (Kyle, 2026-09-29: the model line could not be copied):
    // while the pointer is down in this view, or a non-empty selection sits inside it, skip redraws;
    // the next tick after the selection clears catches up. The data keeps updating underneath.
    let pointerDown = false;
    root.addEventListener('pointerdown', () => { pointerDown = true; });
    window.addEventListener('pointerup', () => { pointerDown = false; });
    const selecting = () => {
        if (pointerDown) return true;
        const sel = window.getSelection && window.getSelection();
        return !!(sel && !sel.isCollapsed && sel.anchorNode && root.contains(sel.anchorNode));
    };
    // The bar above a viewed finished task: the way back, and what is on screen (2026-09-30).
    function backBarHtml(vs) {
        const live = snap && snap.running && snap.current ? snap : null;
        return `<div class="flex flex-wrap items-center gap-2 text-xs rounded-lg border border-orange-800/70 bg-orange-950/20 px-3 py-1.5">
            <button type="button" class="${btnPrimary}" data-act="back-live">← back to ${live ? 'the running task' : 'Live'}</button>
            <span class="text-gray-300">viewing a <b>finished</b> task${viewing ? `: <span class="font-mono text-gray-100">${esc(viewing.task)}</span> of <span class="font-mono text-gray-400">${esc(viewing.dir)}</span>` : ''}</span>
            ${vs && vs.current && vs.current.startedAt ? `<span class="text-gray-500">ran ${esc(fmtDate(vs.current.startedAt))}</span>` : ''}
            ${live ? `<span class="text-gray-500 ml-auto">running now: <span class="font-mono text-gray-400">${esc(live.current.task)}</span> on <span class="font-mono text-gray-400">${esc((live.battery && live.battery.name) || '')}</span></span>` : ''}
        </div>`;
    }
    let shownBattery = null;
    // A throw in the redraw used to leave the view blank (2026-09-30, mid-edit): say what broke instead,
    // with the way back when a finished task was on screen.
    function render(force) {
        try { renderView(force); } catch (e) {
            console.error('[codebench live]', e);
            try { detachAccBodies(); } catch { /* best effort */ }
            root.innerHTML = `<div class="text-xs text-red-300">the Live view failed to draw: ${esc(e && e.message)}</div>${viewing ? `<button type="button" class="${btn} mt-2" data-act="back-live">← back to the running task</button>` : ''}`;
            root.querySelector('[data-act=back-live]')?.addEventListener('click', () => nav.back());
        }
    }
    function renderView(force) {
        // a lane switch (or a new battery) must always draw, selection or not: a leftover selection
        // from copying text used to freeze the view on the old lane (Kyle, 2026-09-29)
        const shownKey = viewing ? `view:${viewing.dir}|${viewing.task}` : ((snap && snap.battery && snap.battery.name) || null);
        if (!force && (snap || viewing) && selecting() && shownKey === shownBattery) return;
        shownBattery = shownKey;
        // A viewed finished task draws from its own snapshot (task-snapshot), through the same code below.
        const vs = viewing ? viewing.snap : null;
        if (viewing && !vs) {
            detachAccBodies(); unmountChat();
            setHtml(root, backBarHtml(null) + (viewing.error ? `<div class="text-xs text-red-300 mt-2">${esc(viewing.error)}</div>` : '<div class="text-xs text-gray-500 mt-2">reading the finished task…</div>'));
            root.querySelector('[data-act=back-live]')?.addEventListener('click', () => nav.back());
            return;
        }
        if (!snap && !vs) { setHtml(root, '<div class="text-xs text-gray-500">no live state yet</div>'); return; }
        const fin = !!vs;
        const s = vs || snap; const b = s.battery || {}; const c = s.current;
        // The TASKS table: the live battery's own rows when the viewed task belongs to it (the running row
        // and new results keep appearing), else the viewed battery's rows from disk.
        const L = fin && snap && snap.battery && snap.battery.name === b.name ? snap : s;
        const Lb = L.battery || {}; const Lc = L.running ? L.current : null;
        wantOdds(Lb.name, ((Lb.config || {}).prompt_level) || '', [...new Set([...(L.tasks || []).map((t) => t.task), ...(Lb.tasks || []), ...(c && L === s ? [c.task] : [])])]);
        let agg = null;
        for (const t of (L.tasks || [])) if (t.assertions && !t.excluded && !['OVERFLOW', 'KILLED', 'PROVIDER_ERROR', 'ABORTED', 'CAP_TOO_LOW', 'HARNESS_ERROR', 'CONTAMINATED', 'TASK_INVALID', 'CUTOFF'].includes(t.status)) { agg = agg || { passed: 0, total: 0, tasks: 0 }; agg.passed += t.assertions.passed || 0; agg.total += t.assertions.total; agg.tasks += 1; }
        const head = fin ? `${backBarHtml(vs)}
            <div class="flex flex-wrap items-center gap-3 text-xs mt-2">
                <span class="px-2 py-0.5 rounded font-semibold bg-gray-800 text-gray-300">FINISHED TASK</span>
                <span class="font-mono text-gray-200">${esc(b.name)}</span>
                ${b.state ? `<span class="text-gray-500">battery ${esc(b.state)}${b.reason ? ` — ${esc(b.reason)}` : ''}</span>` : ''}
                <span class="text-gray-400">battery done <b class="font-mono text-gray-200">${L.done}/${L.total || '?'}</b> · solved <b class="font-mono text-gray-200">${L.solved}/${L.scored}</b> scored${L.excluded ? ` + ${L.excluded} excluded` : ''} · assertions <b class="font-mono ${xyClass(agg)}">${xy(agg)}</b></span>
            </div>
            ${runInfoHtml(s.run_info, b.name, { label: 'model that ran this task' })}
            <div class="text-[11px] text-gray-400 mt-1">${configLine(b.config, b.server)}</div>
            ${s.command || (b.server && b.server.launch_command) ? `<details class="mt-1" data-key="raw-cmd"><summary class="text-[10px] text-gray-500 cursor-pointer">raw commands</summary>
                ${b.server && b.server.launch_command ? `<div class="text-[10px] text-gray-500 mt-1">server</div><div class="text-[10px] font-mono text-gray-400 break-all">${esc(b.server.launch_command)}</div>` : ''}
                ${s.command ? `<div class="text-[10px] text-gray-500 mt-1">harness</div><div class="text-[10px] font-mono text-gray-400 break-all">${esc(s.command)}</div>` : ''}
            </details>` : ''}` : `${switcherHtml(s, b)}
            <div class="flex flex-wrap items-center gap-3 text-xs">
                <span class="px-2 py-0.5 rounded font-semibold ${s.running ? 'bg-indigo-900/60 text-indigo-200' : (s.startedAt ? 'bg-gray-800 text-gray-300' : 'bg-gray-800 text-gray-500')}">${s.running ? 'RUNNING' : (s.startedAt ? `finished${s.exitCode != null ? ` (exit ${s.exitCode})` : ''}` : 'idle')}</span>
                ${b.name ? `<span class="font-mono text-gray-200">${esc(b.name)}</span>` : ''}
                ${s.pid ? `<span class="text-gray-500">pid ${s.pid}</span>` : ''}
                ${s.startedAt ? `<span class="text-gray-400">battery elapsed <b class="font-mono text-gray-200">${fmtS(s.running ? localElapsed(s.elapsed_s) : s.elapsed_s)}</b></span>` : ''}
                <span class="text-gray-400">done <b class="font-mono text-gray-200">${s.done}/${s.total || '?'}</b> · solved <b class="font-mono text-gray-200" title="solved ÷ scored; excluded tasks (not model answers) sit outside the fraction, so done = scored + excluded">${s.solved}/${s.scored}</b> scored${s.excluded ? ` + ${s.excluded} excluded` : ''} · assertions <b class="font-mono ${xyClass(agg)}" title="hidden-test assertions passed/total, only over tasks whose tests report per-assertion counts (synthetic pass/fail checkers do not)">${xy(agg)}</b>${agg ? ` <span class="text-gray-500">over ${agg.tasks} of ${s.scored} scored task${s.scored === 1 ? '' : 's'}</span>` : ''}</span>
                ${s.running ? `
                    ${s.paused
                        ? `<button type="button" class="${btn} text-green-300" data-act="resume" title="writes control.json {action:'run'}">Resume</button>`
                        : `<button type="button" class="${btn} text-yellow-300" data-act="pause" title="run.py polls control.json between tasks: the current task finishes and is scored first">Pause</button>`}
                    <button type="button" class="${btn} text-red-300" data-act="stop">Stop…</button>` : ''}
                ${s.paused ? '<span class="px-2 py-0.5 rounded bg-yellow-900/60 text-yellow-200 text-[10px] font-semibold">PAUSED between tasks</span>' : ''}
                ${s.pauseRequested && !s.paused ? '<span class="text-[10px] text-yellow-400">pause requested — it takes effect when the current task finishes</span>' : ''}
                ${s.stopping ? `<span class="text-[10px] ${s.stopping.acked ? 'text-orange-300' : 'text-yellow-400'}">stop requested (${esc(s.stopping.mode === 'now' ? 'now' : 'after the current task')})${s.stopping.acked ? ' — the harness acknowledged it' : ' — waiting for the harness'}${s.stopping.fell_back ? ', fell back to signalling the process group' : ''}</span>` : ''}
            </div>
            ${queueItemHtml(s.running ? s.queue_item : null)}
            ${s.adopted ? `<div class="mt-1 text-[10px] text-indigo-300 border border-indigo-900/50 rounded px-2 py-1">adopted after restart — live steps unavailable, tailing the transcript. This dashboard did not start this battery, so there is no event stream to reattach to: the numbers below come from the result files already on disk plus the current task's transcript tail. Pause / Resume / Stop still work — they go through <code>control.json</code>, which is the contract.${s.staleResults ? ` <span class="text-amber-300">${s.staleResults} result file${s.staleResults === 1 ? '' : 's'} in this dir predate${s.staleResults === 1 ? 's' : ''} this battery (an earlier attempt under the same name) and ${s.staleResults === 1 ? 'is' : 'are'} ignored until the task is redone.</span>` : ''}</div>` : ''}
            ${s.control ? `<div class="text-[10px] text-gray-600">last control written: <span class="font-mono">${esc(s.control.action)}</span> → <span class="font-mono">${esc(s.control.file)}</span></div>` : ''}
            ${runInfoHtml(s.run_info, b.name)}
            <div class="text-[11px] text-gray-400 mt-1">${configLine(b.config, b.server)}</div>
            ${s.refused ? `<div class="text-xs text-red-300 mt-1">stream refused: ${esc(s.refused)} — events ignored from that point</div>` : ''}
            ${s.error ? `<div class="text-xs text-orange-300 mt-1">${esc(s.error)}</div>` : ''}
            ${s.malformed ? `<div class="text-[10px] text-gray-500">${s.malformed} malformed line(s) skipped</div>` : ''}
            ${s.command || (b.server && b.server.launch_command) ? `<details class="mt-1" data-key="raw-cmd"><summary class="text-[10px] text-gray-500 cursor-pointer">raw commands</summary>
                ${b.server && b.server.launch_command ? `<div class="text-[10px] text-gray-500 mt-1">server</div><div class="text-[10px] font-mono text-gray-400 break-all">${esc(b.server.launch_command)}</div>` : ''}
                ${s.command ? `<div class="text-[10px] text-gray-500 mt-1">harness</div><div class="text-[10px] font-mono text-gray-400 break-all">${esc(s.command)}</div>` : ''}
            </details>` : ''}`;

        let cur = '<div class="text-xs text-gray-500 mt-3">no task running</div>';
        accCtx = null;
        if (c) {
            const taskFile = fin ? viewing.task : (c.run > 1 ? `${c.task}__r${c.run}` : c.task);
            // what the accordions are about: this task (running or viewed); a new identity resets their bodies
            accCtx = { id: `${fin ? 'view' : 'live'}|${b.name || ''}|${taskFile}`, finished: fin, dir: b.name || null, file: taskFile, base: c.task,
                promptLevel: (fin && vs.result && vs.result.prompt_level) || (b.config && b.config.prompt_level) || null,
                assertions: fin ? c.assertions : (c.tests && c.tests.f2p && c.tests.f2p.total != null ? c.tests.f2p : null),
                anomalies: c.anomalies || null, status: fin ? c.status : 'running',
                cases: fin && vs.result ? vs.result.cases : null, progress: fin ? c.progress || null : null,
                verify: fin && vs.result ? vs.result.verify : null };
            if (!accCtx.dir) accCtx = null;
            const elapsed = s.running ? localElapsed(c.elapsed_s_now ?? c.elapsed_s) : (c.elapsed_s_now ?? c.elapsed_s);
            const cap = c.cap_s || 3600; const pct = Math.min(100, (elapsed / cap) * 100);
            // Colour is the glanceable part; the tick below is the informative part.
            const barCol = pct > 75 ? 'bg-red-500' : (pct > 50 ? 'bg-orange-500' : (pct > 25 ? 'bg-yellow-500' : 'bg-green-600'));
            // the history of this task's PROBLEM (2026-10-17): at prompt L3 it is `<task>@L3`, never the L2 task's
            const pkey = (t) => { const l = String((accCtx && accCtx.promptLevel) || (b.config && b.config.prompt_level) || '').split('+')[0].trim().toUpperCase(); return /^L\d+$/.test(l) && l !== 'L2' ? `${t}@${l}` : t; };
            const base = (baselines && (baselines[pkey(c.task)] || baselines[pkey(String(c.task).replace(/__r\d+$/, ''))])) || null;
            const baseMed = base && base.wall_s ? base.wall_s.median : null;
            const tickPct = baseMed != null && cap ? Math.min(100, (baseMed / cap) * 100) : null;
            const overBy = baseMed && baseMed > 0 ? elapsed / baseMed : null;
            const clock = (v) => (v == null ? '<span class="text-gray-600">—</span>' : `<span class="font-mono text-gray-200">${fmtS(v)}</span>`);
            const sinceLastEdit = c.last_edit_s != null ? elapsed - c.last_edit_s : null;
            const tests = Object.entries(c.tests || {}).map(([ph, t]) => `<span class="font-mono">${esc(ph)} ${t.passed ?? '?'}/${t.total ?? '?'}</span>`).join(' ');
            const tail = s.tail && s.tail.task === c.task ? (fin ? { ...s.tail, finished: true } : s.tail) : null; const ts = tail ? tail.stats || {} : {};
            const tailAge = tail && !fin ? (Date.now() - receivedAt) / 1000 : null;
            // a finished task: the scored row's numbers (what run.py recorded) win over the transcript's
            const toolCalls = fin ? c.tool_calls : tail && ts.tool_calls ? ts.tool_calls : c.tool_calls;
            const tokensOut = fin ? c.tokens_out : tail && ts.tokens_out_pending ? null : tail && ts.tokens_out != null ? ts.tokens_out : c.tokens_out;
            const lastText = tail && ts.last_text ? ts.last_text : c.snippet;
            const lastTool = tail && ts.last_tool ? ts.last_tool : c.last_tool;
            const curTps = tpsOf(c, s);
            // the live chat is the proxy tap's live stream: a finished task has none, its transcript stands in
            const mode = textMode;
            const chatOn = mode === 'chat';
            const modeBtn = (m, label) => `<button type="button" data-text-mode="${m}" class="px-2 py-0.5 text-[10px] font-semibold ${mode === m ? 'bg-indigo-600 text-white' : 'bg-gray-800 text-gray-400 hover:text-gray-200'}">${label}</button>`;
            cur = `
            <div class="mt-3 border ${fin ? 'border-orange-800/70' : 'border-indigo-900/60'} rounded-lg p-3 space-y-2">
                <div class="flex flex-wrap items-center gap-3 text-xs">
                    <span class="font-mono text-gray-100 font-semibold">${esc(c.task)}</span>
                    ${(() => { const o = oddsOf(c.task); if (!o) return ''; const bd = o.difficulty != null ? difficultyBand(o.difficulty) : null;
                        return `<span class="text-gray-400" title="${esc(oddsTitle(o))}">difficulty ${diffCell(o)}<span class="text-gray-600"> / 100</span>${bd ? ` <span class="px-1.5 py-0.5 rounded text-[10px] font-semibold" style="background:${bd.color}2e;color:${bd.text}">${esc(bd.word)}</span>` : ''} · predicted odds ${oddsCell(o)}</span>`; })()}
                    ${fin ? `${statusChip(c.status, c.status_derived)}${c.solved_at_cap ? ' <span class="text-green-400" title="passed under a special condition: code passed the tests although the run hit the time limit (censored time; counts as a pass)">⏱ solved at cap</span>' : ''}${c.hit_timeout ? ' <span class="text-orange-300">hit timeout</span>' : ''}` : ''}
                    ${s.run_info && s.run_info.line ? `<span class="text-indigo-300" title="what is serving this task (see the card above)">${esc(s.run_info.line)}</span>` : ''}
                    ${c.of > 1 ? `<span class="text-gray-500">run ${c.run}/${c.of}</span>` : ''}
                    ${c.index != null ? `<span class="text-gray-500">task ${c.index}/${c.total}</span>` : ''}
                    ${c.tier ? `<span class="text-gray-500">${esc(c.tier)}</span>` : ''}
                    ${c.setup ? `<span class="text-gray-500" title="setup_cmd">setup exit ${c.setup.exit} in ${fmtDur(c.setup.secs)}</span>` : ''}
                    
                </div>
                ${fin ? `<div class="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-gray-400" title="the scored outcome, from the result file">
                    <span>hidden tests <b class="font-mono ${xyClass(c.assertions)}">${xy(c.assertions)}</b>${c.assertions && c.assertions.failed ? ` <span class="text-red-300">(${c.assertions.failed} failed)</span>` : ''}</span>
                    <span>p2p <b class="font-mono">${p2pCell(c)}</b></span>
                    ${c.progress && c.progress.of > 0 ? `<span title="hidden-test cases that fail on the untouched base and pass in this run">progress beyond base <b class="font-mono ${c.progress.count > 0 ? 'text-green-300' : 'text-gray-300'}">${c.progress.exact === false ? '≈' : ''}+${c.progress.count} of ${c.progress.of}</b>${c.progress.regressions ? ` · <b class="font-mono text-amber-300">${c.progress.regressions} regressed</b>` : ''}</span>` : ''}
                    <span>tests run by the model <b class="font-mono ${c.tests_run === 0 ? 'text-yellow-400' : 'text-gray-200'}">${c.tests_run ?? '—'}</b></span>
                    ${c.exit_code != null ? `<span>runner exit <b class="font-mono text-gray-200">${c.exit_code}</b></span>` : ''}
                </div>` : ''}
                ${s.tps == null ? '' : `<div class="flex flex-wrap items-baseline gap-x-2 text-xs text-gray-400">
                    <span title="${esc(tpsTitle(curTps))}"><span class="font-mono text-gray-200">${curTps ? tpsCell(curTps) : '—'}</span> t/s <span class="text-gray-500">(avg${curTps ? `, ${curTps.n} req` : ''})</span></span>
                    ${s.running && liveTpsText(b.name) ? `<span class="font-mono text-green-300" title="what this battery's lane is doing right now: generation or prompt processing, at its live rate (lanes poll, 1 Hz)">· ${esc(liveTpsText(b.name))}</span>` : ''}
                </div>`}
                <div>
                    <div class="flex justify-between text-[10px] text-gray-400">
                        <span>${fin ? 'wall' : 'elapsed'} <b class="font-mono text-gray-200">${fmtS(elapsed)}</b> / cap ${fmtS(cap)}</span>
                        <span>${pct.toFixed(0)}%${overBy != null && overBy > 1.5 ? ` <span class="text-orange-300">${overBy.toFixed(1)}x this task's usual</span>` : ''}</span>
                    </div>
                    <div class="relative h-2 bg-gray-800 rounded overflow-hidden">
                        <div class="h-full ${barCol}" style="width:${pct}%"></div>
                        ${tickPct != null ? `<div class="absolute top-0 bottom-0 w-0.5 bg-gray-100/80" style="left:${tickPct}%" title="historical median for this task: ${fmtS(baseMed)} (over the configs that solved it)"></div>` : ''}
                    </div>
                    ${base ? `<div class="text-[10px] text-gray-500 mt-0.5" title="aggregated over every non-INVALID battery, one sample per configuration; sample_group siblings share one baseline">
                        baseline: solved by <b class="text-gray-300">${base.solvedBy}</b> of <b class="text-gray-300">${base.configs}</b> config${base.configs === 1 ? '' : 's'}
                        ${baseMed != null ? ` · <span class="text-gray-400">to pass:</span> time median <b class="text-gray-300">${fmtS(baseMed)}</b>${base.wall_s.mean != null ? ` / mean <b class="text-gray-300">${fmtS(base.wall_s.mean)}</b>` : ''}` : ''}
                        ${base.wall_s && base.wall_s.max ? ` · slowest solve ${fmtS(base.wall_s.max)}` : ''}
                        ${base.tokens_out && base.tokens_out.median != null ? ` · tokens out median <b class="text-gray-300">${fmtN(Math.round(base.tokens_out.median))}</b>${base.tokens_out.mean != null ? ` / mean <b class="text-gray-300">${fmtN(Math.round(base.tokens_out.mean))}</b>` : ''}` : ''}
                        ${base.tokens_in && base.tokens_in.median != null ? ` · tokens in median ${fmtN(Math.round(base.tokens_in.median))}` : ''}
                        ${base.folded_with && base.folded_with.length ? ` · folded with ${esc(base.folded_with.join(', '))} (same bug)` : ''}
                    </div>${attemptsChartHtml(base, elapsed, tokensOut, fin ? { dir: b.name, status: c.status } : null)}` : '<div class="text-[10px] text-gray-600 mt-0.5">no prior result for this task — nothing to compare the elapsed time against</div>'}
                </div>
                <div class="grid grid-cols-2 md:grid-cols-4 gap-2 text-xs">
                    <div><div class="text-[10px] text-gray-500">tool calls${fin ? ' <span class="text-gray-600">(result)</span>' : tail ? ' <span class="text-gray-600">(transcript)</span>' : ''}</div><div class="font-mono text-gray-200 text-base">${fmtN(toolCalls)}${ts.tool_errors ? `<span class="text-red-300 text-xs"> ${ts.tool_errors} err</span>` : ''}</div></div>
                    <div><div class="text-[10px] text-gray-500">files changed <span class="text-gray-600">(${fin ? 'the scored patch' : 'git status in sandbox'})</span></div><div class="font-mono text-base ${tail && tail.files_changed ? 'text-gray-200' : 'text-yellow-400'}" title="${esc(tail && tail.sandbox || c.sandbox || '')}">${tail && tail.files_changed != null ? tail.files_changed : '—'}</div></div>
                    <div><div class="text-[10px] text-gray-500">edits (tool + shell)</div><div class="font-mono text-base ${c.edits ? 'text-gray-200' : 'text-yellow-400'}" title="${c.tool_edits} tool + ${c.shell_edits} shell">${c.edits}</div></div>
                    <div><div class="text-[10px] text-gray-500">first edit</div><div class="text-base">${clock(c.first_edit_s)}</div></div>
                    <div><div class="text-[10px] text-gray-500">last edit${sinceLastEdit != null ? ` <span class="text-gray-600">(${fmtS(sinceLastEdit)} ago)</span>` : ''}</div><div class="text-base">${clock(c.last_edit_s)}</div></div>
                    <div><div class="text-[10px] text-gray-500">steps</div><div class="font-mono text-gray-200">${c.steps}</div></div>
                    <div><div class="text-[10px] text-gray-500">tokens in / out${fin ? ' <span class="text-gray-600">(result)</span>' : tail ? ' <span class="text-gray-600">(transcript)</span>' : ''}</div><div class="font-mono text-gray-200">${fin ? fmtN(c.tokens_in) : tail && ts.tokens_in != null ? fmtN(ts.tokens_in) : '—'} / ${!fin && tail && ts.tokens_out_pending ? '<span class="text-gray-500" title="Claude Code logs real output-token counts (thinking included) only when the task ends">— (at task end)</span>' : fmtN(tokensOut)}</div></div>
                    <div><div class="text-[10px] text-gray-500">tests</div><div class="text-gray-200">${tests || `<span class="text-gray-600">${fin ? 'none recorded' : 'none yet'}</span>`}</div></div>
                    <div><div class="text-[10px] text-gray-500">last tool</div><div class="font-mono text-gray-200 truncate" title="${esc(c.last_path || '')}">${esc(lastTool || '—')} <span class="text-gray-500">${esc(c.last_path || '')}</span></div></div>
                </div>
                ${c.synthetic ? '<div class="text-[10px] text-gray-400">this runner does not stream steps: the counts above arrived in one summary step at the end</div>' : ''}
                ${tail ? `<div class="text-[10px] text-gray-500">transcript <span class="font-mono">${esc(tail.transcript || tail.note || '')}</span> · ${fmtN(ts.lines_total)} lines · ${fmtN(tail.bytes)} bytes${ts.done && !fin ? ' · <span class="text-green-300">runner finished, scoring</span>' : ''}${tailAge != null && tailAge > 10 ? ` · <span class="text-yellow-400">no update for ${fmtS(tailAge)}${lastError ? ` — ${lastError.kind === 'auth' ? 'signed out: reload the page to sign in' : esc(lastError.msg)}` : ' (the page is not receiving updates; reload if this keeps growing)'}</span>` : ''}</div>` : (s.running ? '<div class="text-[10px] text-gray-500">polling the transcript tail…</div>' : '')}
                ${fin ? (c.first_edit_s == null ? '<div class="text-[10px] text-yellow-400">never edited a file</div>' : '') : c.first_edit_s == null ? '<div class="text-[10px] text-gray-400">no edit yet: exploring</div>' : (sinceLastEdit > 600 ? '<div class="text-[10px] text-yellow-400">last edit was over 10 min ago: polishing, or lost</div>' : '')}
                ${(c.anomalies || []).length ? `<div class="text-xs">anomalies${fin ? '' : ' so far'}: ${anomalyChips(c.anomalies)}</div>` : ''}
                ${(c.repeated_reads || []).length ? `<div class="text-[10px] text-yellow-300">repeated reads: ${c.repeated_reads.map(esc).join(', ')}</div>` : ''}
                ${c.compactions ? `<div class="text-[10px] text-gray-400">compactions: ${c.compactions}</div>` : ''}
                ${planPanel(ts, tail, fin)}
                <div>
                    <div class="flex items-center gap-2 mb-1">
                        <span class="flex rounded overflow-hidden border border-gray-700 shrink-0" title="the model's latest text, the whole conversation streamed live from the proxy tap, or the parsed transcript tail">${modeBtn('text', fin ? 'final text' : 'last text')}${modeBtn('chat', 'transcript')}${modeBtn('tail', 'transcript tail')}</span>
                        <span class="text-[10px] text-gray-500 truncate">${chatOn ? (fin ? 'the whole run, chat-style, from its transcript' : ['claude', 'agy'].includes(((b.config || {}).runner || '').toLowerCase()) ? 'the transcript as it is written (a cloud runner has no tap; polled every 3 s)' : tail && tail.subagents ? 'the transcript with its sub-agents inline, as they work (polled every 3 s; the proxy tap shows one conversation at a time)' : 'streamed from the proxy tap (connected only while shown)') : mode === 'tail' ? '<span class="text-gray-600">the latest transcript events</span>' : (tail && ts.last_text ? '<span class="text-gray-600">from the transcript</span>' : (c.snippet_t != null ? `part at ${fmtS(c.snippet_t)}` : ''))}</span>
                    </div>
                    ${chatOn
                        ? '<div data-lc-host data-keep class="flex flex-col" style="height:min(32rem, 60vh)"></div>'
                        : mode === 'tail' ? renderParsedTail(c, tail, fin ? viewing.tailEv : tailEv, b.name)
                        : `<pre data-key="text:${esc(c.task)}" class="text-[11px] font-mono text-gray-300 bg-gray-950 border border-gray-800 rounded p-2 max-h-40 overflow-auto whitespace-pre-wrap">${esc(lastText || (tail ? '(no text from the model yet)' : '(nothing yet — waiting for the transcript tail)'))}</pre>`}
                </div>
            </div>`;
        }
        // TASKS (from L: the live battery, or the viewed task's battery). A finished row shows that task in
        // this same view (2026-09-30: no more separate Transcript page); the running row comes back to it.
        const planned = (Lb.tasks || []).filter((t) => !(L.tasks || []).some((x) => x.task === t));
        const clickable = !!Lb.name;
        const fileOf = (t) => (t.run > 1 ? `${t.task}__r${t.run}` : t.task);
        const isViewed = (t) => fin && viewing.dir === Lb.name && viewing.task === fileOf(t);
        const rowAttrs = (t) => {
            if (!clickable) return '';
            if (t.status === 'running' || (Lc && Lc.task === t.task && (Lc.run || 1) === (t.run || 1))) return fin ? ' data-back-live="1" title="the running task: back to it"' : '';
            return ` data-view-task="${esc(fileOf(t))}" title="show this finished task here"`;
        };
        const rows = (L.tasks || []).map((t) => `
            <tr class="${isViewed(t) ? 'bg-orange-900/30 ' : ''}${clickable ? 'hover:bg-gray-800/40 cursor-pointer' : ''}"${rowAttrs(t)}><td class="px-2 py-0.5 font-mono text-gray-200">${isViewed(t) ? '▸ ' : ''}${esc(t.task)}${t.of > 1 ? `<span class="text-gray-500"> #${t.run}</span>` : ''}</td>
                <td class="px-2 py-0.5">${statusChip(t.status)}${t.solved_at_cap ? ' ⏱' : ''}</td>
                <td class="px-2 py-0.5 text-right" title="${esc(oddsTitle(oddsOf(t.task)))}">${diffCell(oddsOf(t.task))}</td>
                <td class="px-2 py-0.5 text-right" title="${esc(oddsTitle(oddsOf(t.task)))}">${oddsCell(oddsOf(t.task))}</td>
                <td class="px-2 py-0.5 font-mono text-right ${xyClass(t.assertions)}" title="hidden-test assertions passed/total">${xy(t.assertions)}</td>
                <td class="px-2 py-0.5 font-mono text-right" title="pass_to_pass assertions passed/total">${p2pCell(t)}</td>
                <td class="px-2 py-0.5 font-mono text-right text-gray-400">${fmtS(t.wall_s)}</td>
                <td class="px-2 py-0.5 font-mono text-right text-gray-400 whitespace-nowrap" title="${esc(tpsTitle(tpsOf(t, L)))}">${tpsCell(tpsOf(t, L))}</td>
                <td class="px-2 py-0.5 font-mono text-right text-gray-400">${t.tool_calls ?? '—'}</td>
                <td class="px-2 py-0.5 font-mono text-right text-gray-400">${t.first_edit_s != null ? `${fmtS(t.first_edit_s)} → ${fmtS(t.last_edit_s)}` : '—'}</td>
                <td class="px-2 py-0.5 font-mono text-right text-gray-400">${t.tests_run ?? '—'}</td>
                <td class="px-2 py-0.5">${anomalyChips(t.anomalies)}${t.message ? `<span class="text-red-300 text-[10px]"> ${esc(t.message)}</span>` : ''}</td></tr>`).join('')
            // An adopted battery has no event stream: its task list comes from finished result files, so the task
            // running now is still in `planned` -- mark it from `current` instead of calling it pending.
            + planned.map((t) => { const now = !!(Lc && Lc.task === t && L.running);
                return `<tr class="${now ? 'text-gray-200' : 'text-gray-600'}${now && fin && clickable ? ' hover:bg-gray-800/40 cursor-pointer' : ''}"${now && fin && clickable ? ' data-back-live="1" title="the running task: back to it"' : ''}><td class="px-2 py-0.5 font-mono">${esc(t)}</td><td class="px-2 py-0.5">${statusChip(now ? 'running' : 'pending')}</td><td class="px-2 py-0.5 text-right" title="${esc(oddsTitle(oddsOf(t)))}">${diffCell(oddsOf(t))}</td><td class="px-2 py-0.5 text-right" title="${esc(oddsTitle(oddsOf(t)))}">${oddsCell(oddsOf(t))}</td><td colspan="8"></td></tr>`; }).join('');
        const list = `
            <div class="mt-3 text-[10px] uppercase tracking-wider text-gray-500">tasks${fin && L !== snap ? ` <span class="normal-case text-gray-600">of ${esc(Lb.name || '')}</span>` : ''}${clickable ? ` <span class="normal-case text-gray-600">— click a finished one to see it here${fin ? ', the running one to go back' : ''}</span>` : ''}</div>
            <div data-key="hscroll-1" class="overflow-x-auto"><table class="w-full text-xs"><thead><tr class="text-[10px] text-gray-500"><th class="text-left px-2">task</th><th class="text-left px-2">status</th><th class="text-right px-2" title="difficulty /100: the strength at which a config has a 50/50 chance on the problem (the Models page's fit); coloured easy / medium / hard / very hard">difficulty</th><th class="text-right px-2" title="predicted odds that THIS config passes the problem, at the ability of its Models-page row">odds</th><th class="text-right px-2" title="hidden-test assertions passed/total">hidden</th><th class="text-right px-2" title="pass_to_pass assertions passed/total">p2p</th><th class="text-right px-2">wall</th><th class="text-right px-2 whitespace-nowrap" title="token-weighted average prefill (pp) and generation t/s over the task's requests">avg t/s</th><th class="text-right px-2">tools</th><th class="text-right px-2">edits at</th><th class="text-right px-2">tests</th><th class="text-left px-2">anomalies</th></tr></thead><tbody>${rows || '<tr><td class="px-2 text-gray-600" colspan="12">—</td></tr>'}</tbody></table></div>
            ${(L.errors || []).length ? `<div class="mt-2 text-xs text-red-300">errors: ${L.errors.map((e) => esc(`${e.task || ''}: ${e.message}`)).join('; ')}</div>` : ''}
            ${L.summary && L.summary.unrun && L.summary.unrun.length ? `<div class="mt-2 text-xs text-gray-400">${L.summary.unrun.length} task(s) never ran: <span class="font-mono text-gray-500">${L.summary.unrun.map(esc).join(', ')}</span></div>` : ''}
            ${L.summary ? `<div class="mt-2 text-xs text-gray-300">battery done: solved ${L.summary.solved}/${L.summary.scored}${L.summary.excluded ? ` (+${L.summary.excluded} excluded)` : ''}${L.summary.validated ? ` · validated ${L.summary.validated}` : ''}${L.summary.errors ? ` · errors ${L.summary.errors}` : ''}${L.summary.state ? ` · <span class="font-mono">${esc(L.summary.state)}</span>` : ''}${L.summary.reason ? ` (${esc(L.summary.reason)})` : ''} in ${fmtDur(L.summary.secs)}${L.summary.summary ? ` — <span class="font-mono text-gray-500">${esc(L.summary.summary)}</span>` : ''}</div>` : ''}
            ${L.stderrTail ? `<details class="mt-2" data-key="stderr"><summary class="text-[10px] text-gray-500 cursor-pointer">stderr tail</summary><pre data-key="stderr-pre" class="text-[10px] font-mono text-gray-400 bg-gray-950 border border-gray-800 rounded p-2 max-h-40 overflow-auto whitespace-pre-wrap">${esc(L.stderrTail)}</pre></details>` : ''}`;
        // The page must not move while this view redraws (every second, and on every chat update):
        // with the chat detached the view was briefly shorter by the chat's height, so the browser
        // clamped the page's scroll upward -- a yank on every refresh (Kyle, 2026-09-25). Hold the
        // view's height through the swap and put every scrolled ancestor (and the window) back.
        const scrollers = [];
        for (let el = root.parentElement; el; el = el.parentElement) if (el.scrollTop) scrollers.push([el, el.scrollTop]);
        const winY = window.scrollY, oldMin = root.style.minHeight;
        root.style.minHeight = `${root.offsetHeight}px`;
        // The chat and the accordions' bodies are NOT detached for the redraw any more (2026-10-06): setHtml merges the
        // new HTML into the live tree and leaves a data-keep host and its children alone, so they are never moved --
        // a DOM move resets scroll and kills a scroll gesture in flight, which is what made scrolling them miserable.
        // a different task under the accordions (the running one moved on, or another was opened): start them over
        for (const bd of accBodies.values()) if (bd.id && (!accCtx || bd.id !== accCtx.id)) { if (bd.tv) bd.tv.stop(); bd.tv = null; bd.loaded = false; bd.id = null; bd.el.innerHTML = ''; }
        const follow = new Map();   // tail scrollers: was each at the bottom before the redraw?
        for (const el of root.querySelectorAll('[data-follow]')) follow.set(el.dataset.key, isAtBottom(el));
        // RE-RENDER SITE, every second: setHtml keeps <details> open/closed and scroll positions across the rebuild for this
        // view's own blocks. The transcript box's renderer (live chat / transcript view) lives in a data-keep host and keeps
        // its reader's choices itself, by stable key (util.js createOpenChoices -- read its rule before changing this).
        setHtml(root, head + accordionsHtml(accCtx, 'above') + cur + accordionsHtml(accCtx, 'below') + list + dialogHtml());
        attachAccBodies();
        for (const el of root.querySelectorAll('[data-follow]')) followScroll(el, follow.get(el.dataset.key));
        const host = root.querySelector('[data-lc-host]');
        // A cloud runner (claude, agy) has no llama-server tap to stream from, so the tap chat stayed empty for
        // them (Kyle, 2026-10-01: "no live chat for gemini"). Their transcript IS the live stream -- agy writes
        // every tool call, its command and output as it happens -- so the box shows the transcript view, which
        // polls and appends while the task runs, the same renderer a finished task uses.
        const cloudRun = !fin && ['claude', 'agy'].includes(((b.config || {}).runner || '').toLowerCase());
        // An opencode run whose sub-agents are being captured (runners/opencode.py, 2026-10-20): the tap would flip between
        // the parent's and each sub-agent's conversation, unlabelled. The transcript view shows them all in one flow, each
        // marked "sub-agent N", so the box switches to it (polled every 3 s) once the first sub-agent exists.
        const subRun = !fin && !cloudRun && !!(c && s.tail && s.tail.subagents && s.tail.task === c.task);
        if (host && shown && !fin && !cloudRun && !subRun) {
            if (!chat) {
                const el = document.createElement('div');
                el.className = 'flex flex-col min-h-0 bg-gray-950 border border-gray-800 rounded overflow-hidden';
                el.style.flex = '1 1 0%';   // the box (data-lc-host) has the height: its own scroll keeps the rest of the Live view reachable
                chat = mountLiveChat(el, { battery: b.name || null });
            }
            chat.setBattery(b.name || null);   // each GPU lane has its own tap
            chat.attach(host);
        } else {
            unmountChat();      // toggled off, no task running, or not on screen: close the stream
            if (host && (fin || ((cloudRun || subRun) && shown && accCtx))) {  // a finished task's "full transcript": the transcript renderer, in the same box
                const bd = accBody('transcript');
                bd.el.className = 'flex flex-col min-h-0 overflow-auto bg-gray-950 border border-gray-800 rounded p-2';
                bd.el.style.flex = '1 1 0%';   // the box (data-lc-host) has the height; the phase strip sits under it
                if (bd.el.parentNode !== host) host.appendChild(bd.el);
                accLoad('transcript');
            }
        }
        phaseArgs = [host && !fin && shown && !cloudRun ? host : null, b.name];   // a cloud runner has no engine of ours to read
        paintPhase(phaseArgs[0], phaseArgs[1]);
        root.style.minHeight = oldMin;
        for (const [el, top] of scrollers) if (el.scrollTop !== top) el.scrollTop = top;
        if (window.scrollY !== winY) window.scrollTo(window.scrollX, winY);
        for (const bt of root.querySelectorAll('[data-text-mode]')) bt.addEventListener('click', () => setTextMode(bt.dataset.textMode));
        for (const bt of root.querySelectorAll('[data-plan-rev]')) bt.addEventListener('click', () => { const i = +bt.dataset.planRev; planView.rev = i; render(); });
        // Controls name the battery on screen: the server refuses if its live view has since switched lanes.
        const bq = b.name ? `?battery=${encodeURIComponent(b.name)}` : '';
        for (const bt of root.querySelectorAll('[data-battery]')) bt.addEventListener('click', () => nav.battery(bt.dataset.battery));
        for (const bt of root.querySelectorAll('[data-attempts-metric]')) bt.addEventListener('click', () => { attemptsMetric = bt.dataset.attemptsMetric; try { localStorage.setItem('cb-live-attempts-metric', attemptsMetric); } catch { /* session only */ } render(); });
        root.querySelector('[data-attempts-details]')?.addEventListener('toggle', (e) => { attemptsOpen = e.target.open; });
        root.querySelector('[data-act=pause]')?.addEventListener('click', async () => { note(await post(`/api/codebench/pause${bq}`)); poll(); });
        root.querySelector('[data-act=resume]')?.addEventListener('click', async () => { note(await post(`/api/codebench/resume${bq}`)); poll(); });
        root.querySelector('[data-act=stop]')?.addEventListener('click', () => { dialog = true; stopMode = 'after-task'; render(); });
        // The view re-renders every second while a battery runs, and innerHTML does not carry a
        // radio's checked state: keep the choice here or the dialog would silently snap back to
        // the default a second after the user picked "stop now".
        for (const r of root.querySelectorAll('input[name=cb-stop-mode]')) r.addEventListener('change', () => { stopMode = r.value; });
        root.querySelector('[data-act=stop-cancel]')?.addEventListener('click', () => { dialog = false; render(); });
        root.querySelector('[data-act=stop-go]')?.addEventListener('click', async () => {
            const mode = stopMode;
            dialog = false; render();
            note(await post('/api/codebench/stop', { mode, battery: b.name || undefined })); poll();
        });
        for (const el of root.querySelectorAll('[data-view-task]')) el.addEventListener('click', (ev) => { ev.stopPropagation(); nav.task(Lb.name, el.dataset.viewTask); });
        for (const el of root.querySelectorAll('[data-back-live], [data-act=back-live]')) el.addEventListener('click', (ev) => { ev.stopPropagation(); nav.back(); });
        root.querySelector('[data-acc-jump]')?.addEventListener('click', () => {
            const k = root.querySelector('[data-acc-jump]').dataset.accJump; const det = root.querySelector(`details[data-acc="${k}"]`);
            if (!det) return;
            if (!det.open) det.open = true;   // its toggle handler remembers it and loads the body
            det.scrollIntoView({ block: 'start', behavior: 'smooth' });
        });
    }
    function note(j) { if (j && j.error) alert(j.error); }
    // Stopping is the one control that can lose work, so it asks -- and says exactly what each
    // choice costs. "after the current task" is the default because it loses nothing.
    function dialogHtml() {
        if (!dialog) return '';
        return `<div class="fixed inset-0 z-50 bg-black/60 flex items-center justify-center p-4">
            <div class="bg-gray-900 border border-gray-700 rounded-xl p-4 max-w-lg w-full space-y-3">
                <div class="text-sm font-semibold text-gray-100">Stop this battery?</div>
                <label class="flex gap-2 items-start cursor-pointer p-2 rounded hover:bg-gray-800/60">
                    <input type="radio" name="cb-stop-mode" value="after-task" ${stopMode === 'after-task' ? 'checked' : ''} class="mt-1 accent-indigo-500">
                    <span class="text-xs"><b class="text-gray-100">Stop after the current task</b><br>
                    <span class="text-gray-400">The task in flight runs to its end, is scored and written to disk; the battery then exits cleanly. Nothing is lost — everything after it in the list is simply not run.</span></span>
                </label>
                <label class="flex gap-2 items-start cursor-pointer p-2 rounded hover:bg-gray-800/60">
                    <input type="radio" name="cb-stop-mode" value="now" ${stopMode === 'now' ? 'checked' : ''} class="mt-1 accent-indigo-500">
                    <span class="text-xs"><b class="text-red-200">Stop now</b><br>
                    <span class="text-gray-400">The agent process for the task in flight is killed at once. That task is recorded as <b class="font-mono text-gray-300">ABORTED</b> — excluded from x/y, <b>never counted as a failure the model earned</b>. Tasks already finished keep their results.</span></span>
                </label>
                <div class="text-[10px] text-gray-500">Both are requests written to <code>control.json</code> in the battery's out dir. If the harness has not picked the file up within 30 s, the dashboard falls back to signalling the process group — the old behaviour.</div>
                <div class="flex justify-end gap-2">
                    <button type="button" class="${btn}" data-act="stop-cancel">Cancel</button>
                    <button type="button" class="${btnPrimary} bg-red-600 hover:bg-red-500" data-act="stop-go">Stop</button>
                </div>
            </div>
        </div>`;
    }
    return { update, show, hide, setLiveTps, setTextMode, setError, choose, viewTask, backToLive, get viewing() { return viewing; }, get chosen() { return chosen; }, get snapshot() { return snap; } };
}
