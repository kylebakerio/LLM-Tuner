// ai lab -- STATIC MODE (2026-10-06). Loaded only by pages from public/build-static.js (the static build, on Cloudflare);
// the server-rendered site (public/server.js) never includes this file. See public/STATIC-ARCHITECTURE.md.
//
// Kyle: the public page "should deploy to e.g. netlify, and connect to our server _when_ it's up/live, and when
// not, just show the last record of data it had."
//
// The site's code (site.js, live.js, and the dashboard's own ui/models module) asks for data with same-origin
// GET /api/... calls. On a static host there is no /api. This script, loaded in <head> before any of them, wraps
// window.fetch and answers those calls itself:
//   1. from the SNAPSHOT bundled with the build (/snapshot.json + /data/...), which is always there: the numbers, the
//      posts, the catalog and every model record;
//   2. from the LAB (the home server's public API on another origin) for live status only (/api/live,
//      /api/models/running), when a short probe says it is up.
// 2026-10-22: the lab's API is a file server with live status only (public/live_server.py; Kyle: "tiny python server
// sounds fine"), so data no longer comes from the lab when its stamp is newer -- it has no catalog to give.
// A lab request that fails flips the page to "offline"; while offline the lab is probed again every 30 s, so the live
// panel comes on by itself when the machine is back.
//
// A classic script (not a module) so it runs before the module scripts; in Node it exports the pure parts for
// test/staticmode.test.js.

(function (root) {
    'use strict';

    const PROBE_MS = 2500;      // the "is the lab up" question: one small GET
    const LIVE_MS = 4000;       // a small live answer
    const RETRY_MS = 30000;     // while offline: ask again this often

    /** Which API call is this? `url` = pathname + search of a same-origin GET. null = not ours. */
    function classify(url) {
        const q = url.indexOf('?');
        const p = q < 0 ? url : url.slice(0, q);
        if (p === '/api/stats') return { kind: 'stats', source: 'snapshot' };
        if (p === '/api/posts') return { kind: 'posts', source: 'snapshot' };          // the post PAGES are in the build; the list must match them
        if (p === '/api/models/catalog') return { kind: 'catalog', source: 'snapshot' };
        if (p === '/api/model') return { kind: 'model', source: 'snapshot', key: q < 0 ? null : new URLSearchParams(url.slice(q + 1)).get('key') };
        if (p === '/api/live') return { kind: 'live', source: 'live' };
        if (p === '/api/models/running') return { kind: 'running', source: 'live' };
        return null;
    }

    /** Where an answer comes from. state: { probe: 'pending' | 'up' | 'down' }.
     *  -> 'snapshot' | 'live' | 'offline' | 'wait' (the probe is still out: wait for it, it is bounded by PROBE_MS). */
    function plan(route, state) {
        if (route.source === 'snapshot') return 'snapshot';
        return state.probe === 'pending' ? 'wait' : state.probe === 'up' ? 'live' : 'offline';
    }

    /** /api/live while the lab is away: nothing running, plus the last record so the page can say when it was last seen. */
    function offlineLive(snap) {
        const last = snap && snap.live ? snap.live : null;
        return { at: last ? last.at : 0, stale: true, offline: true, lanes: [], running: [], updatedAt: snap ? snap.generatedAt : null, last };
    }

    /** The one-line status note. fmt(ms) -> a local date-time string. */
    function statusLine(state, snap, fmt) {
        const when = snap && snap.generatedAt ? fmt(snap.generatedAt) : null;
        if (state.probe === 'up') return { state: 'live', text: 'live — connected to the lab' };
        if (state.probe === 'down') return { state: 'offline', text: when ? `last updated ${when} — the lab is offline` : 'the lab is offline' };
        return { state: 'checking', text: when ? `last updated ${when}` : '' };
    }

    /**
     * The data layer. deps: { fetch, liveOrigin, snapshotUrl, now, onChange(info) }.
     * -> { fetch (the wrapped one), state, probe(), ready }.
     */
    function create(deps) {
        const origFetch = deps.fetch;
        const liveOrigin = String(deps.liveOrigin || '').replace(/\/+$/, '');
        const snapshotUrl = deps.snapshotUrl || '/snapshot.json';
        const now = deps.now || (() => Date.now());
        const pageOrigin = deps.pageOrigin || (root.location ? root.location.origin : 'http://static.local');
        const state = { probe: 'pending', snap: null, lastProbeAt: 0 };
        const json = (obj, status) => new Response(JSON.stringify(obj), { status: status || 200, headers: { 'Content-Type': 'application/json' } });

        let snapP = null;
        function loadSnapshot() {
            if (!snapP) {
                snapP = Promise.resolve().then(() => origFetch(snapshotUrl, { cache: 'no-cache' })).then((r) => (r.ok ? r.json() : null)).catch(() => null)
                    .then((j) => { if (j) { state.snap = j; changed({ refresh: false }); } else snapP = null; return state.snap; });   // a failed read is tried again by the next caller
            }
            return snapP;
        }
        function changed(info) { try { if (deps.onChange) deps.onChange({ ...info, state }); } catch { /* the note is not worth a broken page */ } }

        /** GET a lab URL, whole body, within `ms`. -> { status, text }; throws on network error, block, or timeout. */
        async function labGet(path, ms, cache) {
            const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
            const t = ctl ? setTimeout(() => ctl.abort(), ms) : null;
            try {
                const r = await origFetch(liveOrigin + path, { mode: 'cors', credentials: 'omit', cache: cache || 'default', ...(ctl ? { signal: ctl.signal } : {}) });
                return { status: r.status, text: await r.text() };
            } finally { if (t) clearTimeout(t); }
        }

        function setProbe(up) {
            const prev = state.probe;
            state.probe = up ? 'up' : 'down';
            if (prev === state.probe) return;
            changed({ refresh: up && prev === 'down' });   // the lab is back: redraw what shows live status
        }

        let probeP = null;
        function probe() {
            if (probeP) return probeP;
            state.lastProbeAt = now();
            probeP = (async () => {
                let up = false;
                if (liveOrigin) {
                    try {
                        const a = await labGet('/api/stats', PROBE_MS, 'no-store');
                        const j = a.status >= 200 && a.status < 300 ? JSON.parse(a.text) : null;
                        up = !!(j && typeof j.generatedAt === 'number');   // the lab's own answer, not some page that says 200
                    } catch { /* unreachable, blocked, slow, stale (503) or not JSON: offline */ }
                }
                await loadSnapshot();
                setProbe(up);
            })().finally(() => { probeP = null; });
            return probeP;
        }
        /** While offline, look again now and then (callers poll; this never makes them wait). */
        function reprobe() {
            if (state.probe === 'down' && liveOrigin && now() - state.lastProbeAt >= RETRY_MS - 1000) probe();
        }

        async function fromLab(url, ms, cache) {
            try {
                const a = await labGet(url, ms, cache);
                if (a.status < 200 || a.status >= 300) throw new Error('HTTP ' + a.status);   // live status is a file that is there and fresh, or the lab is not up
                return new Response(a.text, { status: a.status, headers: { 'Content-Type': 'application/json' } });
            } catch { setProbe(false); return null; }
        }

        async function fromSnapshot(route) {
            const snap = await loadSnapshot();
            if (!snap) return json({ error: 'snapshot unavailable' }, 503);
            if (route.kind === 'stats') return json(snap.stats || {});
            if (route.kind === 'posts') return json(snap.posts || []);
            if (route.kind === 'catalog') return origFetch(snap.catalog);
            if (route.kind === 'model') {
                const file = route.key && snap.models ? snap.models[route.key] : null;
                return file ? origFetch(file) : json({ error: 'no such model' }, 404);
            }
            return json({ error: 'not in the snapshot' }, 404);
        }

        async function offline(route) {
            reprobe();
            if (route.kind === 'live') return json(offlineLive(await loadSnapshot()));
            return json({ running: [] });
        }

        async function answer(route, url, init) {
            let how = plan(route, state);
            if (how === 'wait') { await probe(); how = plan(route, state); }
            if (how === 'snapshot') return fromSnapshot(route);
            if (how === 'offline') return offline(route);
            return (await fromLab(url, LIVE_MS, init && init.cache)) || offline(route);
        }

        /** The replacement for window.fetch: same-origin GET /api/... is answered here, everything else passes through. */
        function wrapped(input, init) {
            try {
                const method = String((init && init.method) || (input && typeof input === 'object' && input.method) || 'GET').toUpperCase();
                const raw = typeof input === 'string' ? input : input && input.url ? input.url : String(input);
                const u = new URL(raw, pageOrigin);
                if (method === 'GET' && u.origin === pageOrigin && u.pathname.startsWith('/api/')) {
                    const route = classify(u.pathname + u.search);
                    if (route) return answer(route, u.pathname + u.search, init);
                }
            } catch { /* not a URL we understand: let the real fetch decide */ }
            return origFetch(input, init);
        }

        const ready = Promise.all([loadSnapshot(), probe()]);
        return { fetch: wrapped, state, probe, reprobe, ready };
    }

    const api = { classify, plan, offlineLive, statusLine, create, PROBE_MS, RETRY_MS };
    if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }

    // ------------------------------------------------------------------ in the page
    const script = document.currentScript;
    const cfg = (script && script.dataset) || {};
    const fmt = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    let note = null;
    let mode = null;

    function paint() {
        if (!note || !mode) return;
        const s = statusLine(mode.state, mode.state.snap, fmt);
        note.dataset.state = s.state;
        note.querySelector('span').textContent = s.text;
        const dot = document.querySelector('.site-mark .site-dot');
        if (dot) dot.classList.toggle('is-idle', s.state === 'offline');
    }

    mode = create({
        fetch: root.fetch.bind(root), liveOrigin: cfg.liveOrigin || '', snapshotUrl: cfg.snapshot || '/snapshot.json',
        onChange: (info) => { paint(); if (info.refresh) root.dispatchEvent(new CustomEvent('site:refresh')); },
    });
    root.fetch = mode.fetch;
    root.STATIC_SITE = mode;   // for the console: STATIC_SITE.state

    function mount() {
        const head = document.querySelector('.site-head');
        if (!head || document.getElementById('site-status')) return;
        note = document.createElement('div');
        note.id = 'site-status';
        note.className = 'site-wrap site-status';
        note.setAttribute('role', 'status');
        note.innerHTML = '<i></i><span></span>';
        head.insertAdjacentElement('afterend', note);   // beside <main>, never inside it: site.js reads "main has children" as a server-rendered post
        paint();
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
    // Pages that poll nothing (results, writing, about) still notice the lab coming back.
    setInterval(() => { if (!document.hidden) mode.reprobe(); }, RETRY_MS);
})(typeof window !== 'undefined' ? window : globalThis);
