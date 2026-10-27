// In-app navigation (2026-10-06, Kyle: "all clicks to navigate anywhere in the app should use navigation
// properly such that the browser 'back' functionality correctly works as expected, as opposed to now where
// many in-app navigations don't register and so back causes unexpected jumps in the app").
//
// The URL hash is the single source of truth for which view is showing. A click that goes somewhere only
// asks the router to go to a route (Nav.go); the router adds ONE history entry and then tells every handler
// which route to draw -- the same call Back/Forward, a pasted link and a reload make. Nothing switches a view
// behind the URL's back, so Back always lands on the view that was showing.
//
//   #interactive  #monitor  #history                     the Chat, Monitor and History tabs
//   #bench                                               Bench, on the sub-tab last used
//   #bench/llama-bench  #bench/sweep  #bench/suites      its speed and public-suite sub-tabs
//   #bench/codebench                                     codebench, on the view last used
//   #bench/codebench/<view>                              runs (the battery list) | board | live | kickoff | queue | autoqueue | experiments
//   #bench/codebench/runs/<battery>                      one battery's task rows
//   #bench/codebench/live/<battery>                      Live following that battery (the lane switcher)
//   #bench/codebench/live/<battery>/<task>               Live showing a finished task
//   #results  #results/<key>[/<tab>]  #results/task/<id>  Results overview, a model's page (speed is the default tab), a task's page
//   #results/compare/<a>/<b>[/<c>...]                    two Solve map rows head to head (2026-10-11), or more side by side
//                                                        (2026-10-20); each id is a model's key (its pooled row) or a config
//                                                        group's key (one config's row), its own "/" encoded
//   #models...                                           the same pages: the tab was "Models" until 2026-10-22 (Kyle: "the
//                                                        'models' page should be 'results'"). Old links still open, and the
//                                                        address bar is rewritten to the #results spelling (sync).
//                                                        Inside the app the tab is still `models` (route.tab, the #tab-models
//                                                        and #models-view elements): only what a reader sees was renamed.
//   #livechat                                            old link (a top-level tab until 2026-09-25): Live with the chat on
//
// Push vs replace: opening a tab, sub-tab, view or page pushes. Filling in a default (#bench -> the sub-tab last
// used) and recording what an entry is really showing (note) replace. Toggles, filters and sorts touch nothing.
//
// A classic script, not an ES module, for the same reason as ui/shared/histwindow.js: script.js is a classic
// script and Node 20's require() cannot load ESM. Sets `globalThis.Route` (and `globalThis.Nav`, the page's one
// router, in a browser), and `module.exports` under CommonJS. The public site does not load this file:
// ui/models/index.js, which it shares, only uses Nav when it is there.
(function (root) {
    'use strict';

    const TABS = ['interactive', 'monitor', 'history', 'bench', 'models'];
    // Bench sub-tab id (script.js setBenchSubtab, localStorage 'bench_subtab') -> its word in the URL.
    const SUBS = { hw: 'llama-bench', server: 'sweep', suites: 'suites', codebench: 'codebench' };
    const CB_VIEWS = ['runs', 'board', 'live', 'kickoff', 'queue', 'autoqueue', 'experiments'];
    const MODEL_VIEWS = ['speed', 'quality', 'history', 'tunings', 'sources'];
    const RESULTS = '#results';             // the Results tab's spelling in the URL (`models` inside the app)
    const RESULTS_WORDS = ['results', 'models'];   // what a link may say: the current word, and the old one

    const enc = encodeURIComponent;
    const dec = (s) => { try { return decodeURIComponent(s); } catch { return s; } };   // a hand-typed "%" must not throw
    const subId = (word) => Object.keys(SUBS).find((id) => id === word || SUBS[id] === word) || null;

    /** '#bench/codebench/live/x' -> { tab, sub, view, dir, task } | { tab, model, view } | { tab, task } | { tab, compare: [a, b, ...] } | { tab }. Never throws. */
    function parse(hash) {
        const seg = String(hash || '').replace(/^#/, '').split('/');
        if (seg[0] === 'livechat') return { tab: 'bench', sub: 'codebench', view: 'live', chat: true };
        if (seg[0] === 'bench') {
            const r = { tab: 'bench', sub: subId(seg[1]) };
            if (r.sub !== 'codebench') return r;
            r.view = CB_VIEWS.includes(seg[2]) ? seg[2] : null;
            if ((r.view === 'runs' || r.view === 'live') && seg[3]) r.dir = dec(seg[3]);
            if (r.view === 'live' && r.dir && seg[4]) r.task = dec(seg.slice(4).join('/'));
            return r;
        }
        if (RESULTS_WORDS.includes(seg[0])) {
            // #results/task/<id> is a task page; any other #results/<key> is a model (a key's own "/" is encoded,
            // and an old link with it unencoded still reads as one key). #models/... reads the same.
            if (seg[1] === 'task' && seg[2]) return { tab: 'models', task: dec(seg.slice(2).join('/')) };
            // #results/compare/<a>/<b>[/<c>...]: two ids or more, one per segment (each one's own "/" is encoded, as format()
            // writes it); anything less is a model key. Since 2026-10-20 (any number of rows) a further segment is a further
            // row: a hand-typed second id with its "/" unencoded no longer reads as one id. Empty segments are skipped.
            if (seg[1] === 'compare' && seg[2] && seg[3]) {
                const ids = seg.slice(2).filter((x) => x !== '').map(dec);
                if (ids.length >= 2) return { tab: 'models', compare: ids };
            }
            const rest = seg.slice(1);
            const view = rest.length > 1 && MODEL_VIEWS.includes(rest[rest.length - 1]) ? rest.pop() : 'speed';
            const model = dec(rest.join('/'));
            return model ? { tab: 'models', model, view } : { tab: 'models' };
        }
        return { tab: TABS.includes(seg[0]) ? seg[0] : 'interactive' };
    }

    /** The one spelling of a route; two routes are the same view exactly when their format() is equal. */
    function format(r) {
        if (!r || !TABS.includes(r.tab)) return '#interactive';
        if (r.tab === 'bench') {
            if (!SUBS[r.sub]) return '#bench';
            let h = '#bench/' + SUBS[r.sub];
            if (r.sub !== 'codebench' || !CB_VIEWS.includes(r.view)) return h;
            h += '/' + r.view;
            if ((r.view === 'runs' || r.view === 'live') && r.dir) h += '/' + enc(r.dir) + (r.view === 'live' && r.task ? '/' + enc(r.task) : '');
            return h;
        }
        if (r.tab === 'models') {
            if (r.task) return RESULTS + '/task/' + enc(r.task);
            if (Array.isArray(r.compare) && r.compare.filter(Boolean).length >= 2) return RESULTS + '/compare/' + r.compare.filter(Boolean).map(enc).join('/');
            if (!r.model) return RESULTS;
            return RESULTS + '/' + enc(r.model) + (r.view !== 'speed' && MODEL_VIEWS.includes(r.view) ? '/' + r.view : '');
        }
        return '#' + r.tab;
    }

    /** Fill in what a short link leaves out: #bench -> the sub-tab last used, #bench/codebench -> the view last used. */
    function resolve(r, defaults) {
        if (r.tab !== 'bench') return r;
        const d = defaults || {};
        const out = { ...r };
        if (!out.sub) out.sub = SUBS[d.sub] ? d.sub : 'hw';
        if (out.sub === 'codebench' && !out.view) out.view = CB_VIEWS.includes(d.view) ? d.view : 'runs';   // a stale key must not blank the card
        return out;
    }

    /**
     * The router over one window. Each history entry carries { nav: its id, from: the route it was opened from },
     * which is what lets an in-page "← back" button know whether the browser's Back is the same thing (up()).
     */
    function createRouter(win) {
        const { history, location } = win;
        const handlers = [];
        const recent = [];              // routes shown, oldest first, for last()
        const scrolls = new Map();      // entry id -> { el, top }: where its view was scrolled when we left it
        let opts = {};
        let cur = null, curHash = null, curId = null, started = false, applying = false;
        let seq = Date.now();           // entry ids outlive a reload (history.state does), so never restart at 1
        let overlay = null;             // { name, close } while a page-like overlay is open
        let restoreTimer = null;
        let bounced = null;             // the dead overlay entry sync() is stepping back off

        const canon = (h) => { const route = resolve(parse(h), opts.defaults ? opts.defaults() : null); return { route, hash: format(route) }; };
        // history is unavailable in some embedded views; navigation still works, there is just nothing to go Back to
        const setState = (fn, state, hash) => { try { if (hash == null) history[fn](state, ''); else history[fn](state, '', hash); return true; } catch { return false; } };

        function apply(route, hash, again) {
            const prev = cur;
            cur = route; curHash = hash;
            if (recent[recent.length - 1] !== hash) { recent.push(hash); if (recent.length > 200) recent.shift(); }
            applying = true;
            try {
                for (const fn of handlers.slice()) { try { fn(route, { prev, again: again || null }); } catch (e) { if (win.console) win.console.error('route handler failed', e); } }
            } finally { applying = false; }
        }

        // Back to a page should land where you were on it. The view may still be loading when we get there, so the
        // position is re-asserted for a moment -- until the reader scrolls, clicks or types, or navigates again.
        function saveScroll() { const el = opts.scroller && opts.scroller(); if (el && curId != null) scrolls.set(curId, { el, top: el.scrollTop }); }
        function stopRestore() { if (restoreTimer) { win.clearInterval(restoreTimer); restoreTimer = null; } }
        function restoreScroll(id) {
            stopRestore();
            const s = scrolls.get(id);
            if (!s || !win.setInterval) return;
            let n = 0;
            const put = () => { if (Math.abs(s.el.scrollTop - s.top) > 1) s.el.scrollTop = s.top; if (++n > 30) stopRestore(); };
            restoreTimer = win.setInterval(put, 100);
            put();
        }

        function closeOverlay() { const o = overlay; overlay = null; if (o) { try { o.close(); } catch { /* already gone */ } } }

        /**
         * Go to a route: one new history entry -- unless we are already there, which never adds one. A button that
         * also refreshes when pressed again (the open tab's, as it always did) says what it is with { again: 'tab' },
         * and the handlers then run once more with info.again set.
         * { replace: true } rewrites the current entry instead (a redirect, not a step).
         */
        function go(target, o) {
            if (applying) { Promise.resolve().then(() => go(target, o)); return; }   // a handler redirecting: after every handler has seen this route
            const { route, hash } = canon(target);
            const replace = !!(o && o.replace);
            if (hash === curHash) { if (!replace && o && o.again) apply(route, hash, o.again); return; }
            stopRestore();
            // Going somewhere with an overlay still up: the new page takes the overlay's entry, so that entry is
            // never left in the middle of the history where Forward could not get past it (see sync()).
            const over = !!(history.state && history.state.overlay);
            closeOverlay();
            if (replace && !over) setState('replaceState', history.state, hash);
            else { saveScroll(); const id = ++seq; if (setState(over ? 'replaceState' : 'pushState', { nav: id, from: curHash }, hash)) curId = id; }
            apply(route, hash);
        }

        /** Record that the current entry is really showing `target` (a default that got resolved); no handler runs. */
        function note(target) {
            const { route, hash } = canon(target);
            if (hash === curHash) return;
            setState('replaceState', history.state, hash);
            cur = route; curHash = hash;
        }

        /**
         * An in-page "← back" button. When the entry before this one IS the parent (`target`, or any route `isParent`
         * accepts), step back to it, so the button and the browser's Back agree instead of differing by one entry;
         * otherwise (a deep link, or we came from elsewhere) go to the parent as a new step.
         */
        function up(target, isParent) {
            const from = (history.state || {}).from;
            if (from != null && (isParent ? isParent(parse(from)) : from === canon(target).hash)) history.back();
            else go(target);
        }

        /** The most recent route shown at or under `prefix` ('#results' -> '#results/<the page you left>'), else null. */
        function last(prefix) {
            const p = String(prefix).replace(/^#models(?=\/|$)/, RESULTS);   // the tab button still says '#models' (script.js: '#' + its id)
            for (let i = recent.length - 1; i >= 0; i--) if (recent[i] === p || recent[i].startsWith(p + '/')) return recent[i];
            return null;
        }

        /**
         * An overlay that behaves like a page (the full-screen chart): call with its state whenever it opens or
         * closes. Opening adds an entry under the same URL, so Back closes it; closing it by hand steps back over
         * that entry.
         */
        function setOverlay(name, open, close) {
            const there = (history.state || {}).overlay === name;
            if (open) {
                if (overlay && overlay.name === name) return;
                overlay = { name, close };
                if (there) return;
                saveScroll();
                const id = ++seq;
                if (setState('pushState', { nav: id, from: curHash, overlay: name })) curId = id;
            } else if (overlay && overlay.name === name) {
                overlay = null;
                if (there) history.back();
            }
        }

        // Back/Forward, a hash typed into the address bar, an <a href="#...">.
        function sync() {
            const { route, hash } = canon(location.hash);
            let st = history.state;
            const spelled = location.hash && hash !== location.hash ? hash : null;      // an old or short link gets its one spelling; a bare URL stays bare
            if (!st || st.nav == null) { st = { nav: ++seq, from: curHash }; setState('replaceState', st, spelled); }   // an entry the browser made: adopt it
            else if (spelled) setState('replaceState', st, spelled);
            const o = st.overlay || null;
            if (!o) bounced = null;
            if (st.nav === curId && hash === curHash) return;      // the hashchange that follows a popstate we handled
            if (overlay && overlay.name !== o) closeOverlay();
            // Forward onto a closed overlay's entry (always the newest one, see go()): what it showed is gone, so step
            // back to the page under it -- once, though popstate and hashchange may both report the landing.
            if (o && !overlay) { if (bounced !== st.nav) { bounced = st.nav; history.back(); } return; }
            saveScroll();      // the page is still showing the entry we are leaving
            curId = st.nav;
            if (hash !== curHash) apply(route, hash);
            restoreScroll(curId);
        }

        /** Subscribe: fn(route, { prev, again }); prev is the route shown before (null the first time). A handler added after start() is told the current route at once. */
        function on(fn) {
            handlers.push(fn);
            if (started && cur) fn(cur, { prev: null, again: null });
        }

        /** opts.defaults(): { sub, view } last used (resolve); opts.scroller(): the element that scrolls the view on show. */
        function start(o) {
            opts = o || {};
            started = true;
            const had = history.state && history.state.nav != null ? history.state : null;
            const st = had || { nav: ++seq, from: null };
            const { route, hash } = canon(location.hash);
            // Seed an entry for wherever we started, so the first Back has a destination. A bare URL stays bare.
            setState('replaceState', st, location.hash ? hash : null);
            curId = st.nav;
            apply(route, hash);
            win.addEventListener('popstate', sync);
            win.addEventListener('hashchange', sync);
            if (st.overlay) history.back();     // reloaded with an overlay open: see sync()
            for (const ev of ['wheel', 'touchstart', 'keydown', 'pointerdown']) win.addEventListener(ev, stopRestore, { capture: true, passive: true });
        }

        return { on, start, go, up, note, last, overlay: setOverlay, current: () => cur };
    }

    const api = { TABS, SUBS, CB_VIEWS, MODEL_VIEWS, parse, format, resolve, createRouter };
    root.Route = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else if (root.history && root.location) root.Nav = createRouter(root);
})(typeof globalThis !== 'undefined' ? globalThis : this);
