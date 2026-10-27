// Every timer that asks the server for something, under one set of rules (2026-10-22, Kyle: "cloudflare says
// lab.kylebaker.io got 65.1k requests in the last 24 hours ... that's an internal site ... sounds like some terrible
// inefficiency"). Measured that day: one open tab of the private dashboard made 99-154 requests a minute and a tab in
// the background 58-164, each one a Cloudflare request when the tab is on the tunnel. The rules:
//   - nothing while the page is hidden (another browser tab in front, a minimised window), and one run as soon as it is
//     visible again, so what it shows is current the moment anyone can see it;
//   - never two runs at once: the next wait starts when a run has finished, so a slow answer is not asked for again
//     while it is still on its way.
// The sidebar's 1 Hz numbers (telemetry, lanes) are not polled at all while the status stream is up: they arrive on it
// as named events (server4.js LIVE TICKS, script.js onTick). What is left polling goes through every() below.
//
// A classic script, not an ES module, for the same reason as ui/shared/modelname.js: script.js is a classic script and
// Node 20's require() cannot load ESM. Sets `globalThis.Poll` (script.js reads it; ES modules take `pollEvery` from
// ui/benchmarks/util.js, which imports this file for the side effect), and `module.exports` under CommonJS.
(function (root) {
    'use strict';

    /**
     * Run `fn` every `ms` while the page is visible. `ms` is a number, or a function read after every run (a cadence
     * that depends on state). Returns { stop(), now() }: stop() ends it for good; now() runs it at once (unless a run is
     * in flight) and starts the wait again after it.
     * opts.now: the first run right away instead of after one wait.
     * opts.whileHidden(): while it returns true, keep running in a hidden page too. Only for data this tab is
     * RECORDING (a bench run's samples), never for something that is just drawn.
     * opts.doc / opts.timers: a stand-in document and setTimeout/clearTimeout (tests).
     */
    function every(fn, ms, opts = {}) {
        const doc = opts.doc !== undefined ? opts.doc : root.document;
        const T = opts.timers || root;
        const hidden = () => !!(doc && doc.hidden) && !(opts.whileHidden && opts.whileHidden());
        let timer = null, busy = false, stopped = false, parked = false;
        const wait = () => Math.max(0, Number(typeof ms === 'function' ? ms() : ms) || 0);
        const arm = () => { if (!stopped) timer = T.setTimeout(tick, wait()); };
        async function tick() {
            timer = null;
            if (stopped || busy) return;
            if (hidden()) { parked = true; return; }   // no timer while hidden: visibilitychange starts it again
            busy = true;
            try { await fn(); } catch (e) { if (root.console) root.console.error(e); }
            finally { busy = false; }
            arm();
        }
        const onVisibility = () => { if (parked && !hidden()) { parked = false; tick(); } };
        if (doc && doc.addEventListener) doc.addEventListener('visibilitychange', onVisibility);
        if (opts.now) tick(); else arm();
        return {
            stop() {
                stopped = true;
                if (timer) T.clearTimeout(timer);
                timer = null;
                if (doc && doc.removeEventListener) doc.removeEventListener('visibilitychange', onVisibility);
            },
            now() {
                if (stopped || busy) return;
                if (timer) T.clearTimeout(timer);
                parked = false;
                tick();
            },
        };
    }

    const api = { every };
    root.Poll = api;
    if (typeof module === 'object' && module && module.exports) module.exports = api;
})(globalThis);
