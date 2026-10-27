// Benchmarks tab, Quality subsection v0 ("quality — codebench" sub-tab of the Bench tab).
// Wires itself into the existing Bench sub-tab strip:
//   - index.html carries the button #bench-subtab-codebench and the card #bench-card-codebench
//   - script.js's setBenchSubtab() knows only its own three cards, so this module hides those
//     when the route is #bench/codebench and hides itself when it is another sub-tab's; the sub-tab
//     last used is still localStorage 'bench_subtab'.
// The card IS the battery list: there is no "Runs" button to click, because the run list is
// not somewhere you navigate to. Clicking a battery drills into its task rows; the breadcrumb comes
// back. Leaderboard, Live and Kick off are alternate views of the same card, reached by their own buttons.
// A TASK, from anywhere (2026-09-30, Kyle: "when I click a completed task, I don't want to jump to this
// transcript page"), opens Live showing that finished task (live.viewTask): the battery list's rows,
// Live's own TASKS table, a battery cell on a model's page and the Experiments list. The
// separate Transcript/Result page is no longer reachable; its tabs are accordions in Live.
// NAVIGATION (2026-10-06, Kyle: "all clicks to navigate anywhere in the app should use navigation properly such
// that the browser 'back' functionality correctly works as expected"): every view, battery and task here is a
// route under #bench/codebench (ui/shared/route.js lists them). A click only asks the router to go to one (go);
// the route handler at the end of init() draws what the route names -- for a click, Back/Forward, a link from
// the Models tab and a reload alike. Nothing below switches a view any other way.
import { createRunsView } from './runs.js';
import { createBoardView } from './board.js';
import { createLiveView } from './live.js';
import { createKickoffView } from './kickoff.js';
import { api, pollEvery } from './util.js';

const card = document.getElementById('bench-card-codebench');
const myBtn = document.getElementById('bench-subtab-codebench');
if (card && myBtn) init();

function init() {
    const ON = 'seg-btn is-on';   // .seg-btn: tailwind.src.css (shared with script.js setBenchSubtab)
    const OFF = 'seg-btn';
    const otherCards = ['bench-card-hw', 'bench-card-sweep', 'bench-card-suites'];
    const otherBtns = ['bench-subtab-hw', 'bench-subtab-server', 'bench-subtab-suites'];

    card.innerHTML = `
        <div class="flex items-center justify-between">
            <h3 class="text-xs font-bold text-gray-400 uppercase tracking-wider">codebench <span class="text-gray-600 normal-case font-normal">— quality: private, uncontaminated coding tasks (~/code/codebench)</span></h3>
            <span id="cb-live-badge" class="text-[10px] text-gray-500"></span>
        </div>
        <div class="flex flex-wrap gap-1 items-center">
            <button type="button" data-view="runs" class="${OFF} hidden" data-back="1">← batteries</button>
            <button type="button" data-view="board" class="${OFF}">Leaderboard</button>
            <button type="button" data-view="live" class="${OFF}">Live</button>
            <button type="button" data-view="kickoff" class="${OFF}">Kick off</button>
            <button type="button" data-view="queue" class="${OFF}">Queue</button>
            <button type="button" data-view="autoqueue" class="${OFF}">Auto queue</button>
            <button type="button" data-view="experiments" class="${OFF}">Experiments</button>
        </div>
        <div id="cb-view-runs" class="space-y-2"></div>
        <div id="cb-view-board" class="hidden space-y-2"></div>
        <div id="cb-view-live" class="hidden space-y-2"></div>
        <div id="cb-view-kickoff" class="hidden space-y-2"></div>
        <div id="cb-view-autoqueue" class="hidden space-y-2"></div>
        <div id="cb-view-queue" class="hidden space-y-2"></div>
        <div id="cb-view-experiments" class="hidden space-y-2"></div>`;

    const nav = window.Nav;
    const here = (o) => window.Route.format({ tab: 'bench', sub: 'codebench', ...o });
    const go = (o) => nav.go(here(o));
    const onLive = (r) => r.tab === 'bench' && r.sub === 'codebench' && r.view === 'live' && !r.task;
    // Every "open this task" lands here: Live, viewing it (`view` 'verify' opens its Verify accordion).
    let openAcc = null;   // which accordion the task being opened should show; not part of the route
    const openTaskInLive = (dir, task, view) => { openAcc = view === 'verify' ? 'verify' : null; go({ view: 'live', dir, task }); };
    const runs = createRunsView(card.querySelector('#cb-view-runs'), {
        onOpenTask: (dir, task, view) => openTaskInLive(dir, task, view),
        onOpenRun: (dir) => go({ view: 'runs', dir }),
        onBack: () => nav.up(here({ view: 'runs' })),
    });
    const live = createLiveView(card.querySelector('#cb-view-live'), {
        onTask: (dir, task) => openTaskInLive(dir, task),      // Live's own TASKS table: a finished task, in place
        onBack: () => nav.up(here({ view: 'live' }), onLive),  // "← back to the running task"
        // The lane switcher. The entry being left may only say "live" (whichever battery is newest): record the
        // battery it was showing first, so Back returns to that one and not to the one chosen here.
        onBattery: (dir) => {
            const c = nav.current(), b = live.snapshot && live.snapshot.battery;
            if (c && onLive(c) && !c.dir && b && b.name) nav.note(here({ view: 'live', dir: b.name }));
            go({ view: 'live', dir });
        },
    });
    const kickoff = createKickoffView(card.querySelector('#cb-view-kickoff'), { onStarted: () => go({ view: 'live' }) });
    // The quality master list. Clicking a row lands on that config's battery in the list.
    const board = createBoardView(card.querySelector('#cb-view-board'), {
        onOpenRun: (dir) => go({ view: 'runs', dir }),
    });
    // Auto queue (ui/autoqueue/): loaded on first use, so a problem there can never blank the other views.
    let autoQueue = null;
    function loadAutoQueue() {
        const el = card.querySelector('#cb-view-autoqueue');
        (autoQueue ? Promise.resolve(autoQueue) : import('../autoqueue/index.js').then((m) => (autoQueue = m.createAutoQueueView(el))))
            .then((v) => v.load())
            .catch((e) => { el.innerHTML = `<div class="text-xs text-red-300">Auto queue failed to load: ${String(e && e.message).replace(/</g, '&lt;')}</div>`; });
    }
    // Queue (ui/benchmarks/queue.js): the benchmark queue's rows (bench.sqlite, run by codebench/tools/queue_runner.py). Lazy, like Auto queue.
    let queueView = null;
    function loadQueue() {
        const el = card.querySelector('#cb-view-queue');
        (queueView ? Promise.resolve(queueView) : import('./queue.js').then((m) => (queueView = m.createQueueView(el, {
            onOpenLive: () => go({ view: 'live' }), onOpenRun: (dir) => go({ view: 'runs', dir }) }))))
            .then((v) => v.load())
            .catch((e) => { el.innerHTML = `<div class="text-xs text-red-300">Queue failed to load: ${String(e && e.message).replace(/</g, '&lt;')}</div>`; });
    }
    // Experiments (ui/benchmarks/experiments.js): side experiments kept out of mainline results. Lazy, like Auto queue.
    let experiments = null;
    function loadExperiments() {
        const el = card.querySelector('#cb-view-experiments');
        (experiments ? Promise.resolve(experiments) : import('./experiments.js').then((m) => (experiments = m.createExperimentsView(el, { onOpenTask: (dir, task, v) => openTaskInLive(dir, task, v) }))))
            .then((v) => v.load())
            .catch((e) => { el.innerHTML = `<div class="text-xs text-red-300">Experiments failed to load: ${String(e && e.message).replace(/</g, '&lt;')}</div>`; });
    }
    const badge = card.querySelector('#cb-live-badge');
    let view = null; let active = false; let es = null; let pollTimer = null;   // view: null until the first route is drawn

    function setView(v) {
        view = v;
        for (const b of card.querySelectorAll('button[data-view]')) {
            // The battery list has no button of its own -- only a "← batteries" escape that is
            // shown exactly when you are somewhere else.
            if (b.dataset.back) { b.className = OFF + (v === 'runs' ? ' hidden' : ''); continue; }
            b.className = b.dataset.view === v ? ON : OFF;
        }
        for (const k of ['runs', 'board', 'live', 'kickoff', 'autoqueue', 'queue', 'experiments']) card.querySelector('#cb-view-' + k).classList.toggle('hidden', k !== v);
        if (v === 'runs') runs.refresh();
        if (v === 'board') board.load();
        if (v === 'live') live.show(); else live.hide();
        if (v === 'kickoff') kickoff.load();
        if (v === 'autoqueue') loadAutoQueue();
        if (v === 'experiments') loadExperiments();
        if (v === 'queue') loadQueue(); else if (queueView) queueView.hide();
        try { localStorage.setItem('codebench_view', v); } catch { /* private mode */ }
    }
    // A view button returns to that view as you left it (a battery still open in the list), and refreshes it when
    // it is already the one on show.
    card.querySelectorAll('button[data-view]').forEach((b) => b.addEventListener('click', () => {
        const hash = here({ view: b.dataset.view });
        nav.go(nav.last(hash) || hash, { again: 'view' });
    }));

    function updateBadge(s) {
        if (!s) return;
        badge.textContent = s.running ? `live: ${s.battery ? s.battery.name : ''} ${s.current ? '· ' + s.current.task : ''} · ${s.done}/${s.total || '?'}` : (s.startedAt ? 'last battery finished' : '');
    }
    async function pollLive() { const s = await api('/api/codebench/live'); if (!s.error) { live.update(s); updateBadge(s); } else if (live.setError) live.setError(s); }
    function openSse() {
        if (es) return;
        try {
            es = new EventSource('/api/status');   // own connection: script.js's watchdog recreates its EventSource and would drop a listener
            es.addEventListener('codebench', (e) => {
                let m; try { m = JSON.parse(e.data).codebench || {}; } catch { return; }   // server4.js wraps {event, live} in the normal state envelope under `codebench`
                if (m.live) { live.update(m.live); updateBadge(m.live); }
                const ev = m.event && m.event.ev;
                if (ev === 'task_done' || ev === 'battery_done' || ev === 'process_exit') { runs.refresh(); board.refresh(); }
            });
            // Plain state frames: `external` carries the unmanaged server's live rates (server4.js pollExternalSlots).
            es.onmessage = (e) => { let j; try { j = JSON.parse(e.data); } catch { return; } live.setLiveTps(j && j.external); };
            es.onerror = () => { /* EventSource reconnects on its own; the poll below covers the gap */ };
        } catch { es = null; }
    }

    function activate() {
        for (const id of otherCards) document.getElementById(id)?.classList.add('hidden');
        for (const id of otherBtns) { const b = document.getElementById(id); if (b) b.className = OFF; }
        card.classList.remove('hidden'); myBtn.className = ON;
        try { localStorage.setItem('bench_subtab', 'codebench'); } catch { /* private mode */ }
        if (!active) { active = true; runs.load(); openSse(); pollTimer = pollEvery(pollLive, 15000, { now: true }); }
    }
    function deactivate() { card.classList.add('hidden'); myBtn.className = OFF; live.hide(); }

    // Leaving the Bench tab only hides #bench-view (script.js), which never reaches setView/deactivate:
    // watch it, so the Live view stops polling and its live chat closes its stream while not on screen.
    const benchView = document.getElementById('bench-view');
    if (benchView) new MutationObserver(() => {
        if (benchView.classList.contains('hidden')) live.hide();
        else if (active && view === 'live' && !card.classList.contains('hidden')) live.show();
    }).observe(benchView, { attributes: true, attributeFilter: ['class'] });
    // The route handler: the one place a view, battery or task comes on show. The sub-tab buttons themselves are
    // script.js's (they ask for #bench/<sub-tab>); the view the card opens on when the route does not name one
    // (the last used, localStorage 'codebench_view') is filled in by the router before it gets here.
    nav.on((r, info) => {
        if (r.tab !== 'bench') return;      // the Bench tab going out of sight: the observer above
        if (r.sub !== 'codebench') { if (!card.classList.contains('hidden')) deactivate(); return; }
        const wasHidden = card.classList.contains('hidden');
        activate();
        if (r.chat) live.setTextMode('chat');   // an old /#livechat link (the live chat was a top-level tab until 2026-09-25): Live, with the chat on
        if (r.view !== view || wasHidden || info.again) setView(r.view);
        if (r.view === 'runs') runs.show(r.dir || null);
        if (r.view === 'live') {
            if (r.task) { if (!(live.viewing && live.viewing.dir === r.dir && live.viewing.task === r.task)) live.viewTask(r.dir, r.task, { open: openAcc }); }
            else {
                if (live.viewing) live.backToLive();   // the running task, not a finished one left on screen
                const b = live.snapshot && live.snapshot.battery;
                if (r.dir && (r.dir !== live.chosen || !b || b.name !== r.dir)) live.choose(r.dir);   // also when it is the chosen one but not (yet) the one drawn
            }
        }
        openAcc = null;
    });
    // Modest background badge so a running battery is visible from the other Bench sub-tabs
    // once this one has been opened; nothing is fetched until then (no cost when unused).
    window.addEventListener('beforeunload', () => { if (pollTimer) pollTimer.stop(); if (es) es.close(); });
}
