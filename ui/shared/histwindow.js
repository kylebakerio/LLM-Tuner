// History chart's time-window math (2026-10-01, Kyle: "a scrollable window that lets us pan into the
// chart's history ... but only loads the data range window we're looking at"). The chart shows a
// window [from, to] (epoch ms) over the whole request log; wheel/pinch zoom it around the pointer,
// drag pans it, and after the gesture settles script.js fetches /api/logs/range for the window plus a
// margin. The pure arithmetic lives here so node can test it -- clamping is where the bugs would be
// (a wheel-in inverting the window, a pan running off into years with no data).
//
// A classic script, not an ES module, for the same reason as ui/shared/modelname.js: script.js is a
// classic script and Node 20's require() cannot load ESM. Sets `globalThis.HistWindow`, and
// `module.exports` under CommonJS.
(function (root) {
    'use strict';

    const MIN_SPAN = 60 * 1000;          // 1 min: below that a burst is a few dots and the axis labels repeat
    const SLACK_FRAC = 0.05;             // may pan 5% of the window past either end of the data, so the newest point isn't glued to the edge

    /**
     * Keep a window sane: span in [MIN_SPAN, extent span + slack], and inside the extent (+ slack).
     * No extent (empty log) -> the window as is, just with the minimum span enforced.
     */
    function clampWindow(win, extent) {
        let from = Math.min(win.from, win.to), to = Math.max(win.from, win.to);
        if (to - from < MIN_SPAN) { const mid = (from + to) / 2; from = mid - MIN_SPAN / 2; to = mid + MIN_SPAN / 2; }
        if (!extent || !Number.isFinite(extent.first) || !Number.isFinite(extent.last)) return { from, to };
        const dataSpan = Math.max(MIN_SPAN, extent.last - extent.first);
        let span = to - from;
        const slack = Math.min(span, dataSpan) * SLACK_FRAC;
        const lo = extent.first - slack, hi = extent.last + slack;
        if (span > hi - lo) { span = hi - lo; const mid = (from + to) / 2; from = mid - span / 2; to = mid + span / 2; }
        if (from < lo) { to += lo - from; from = lo; }
        if (to > hi) { from -= to - hi; to = hi; }
        return { from, to };
    }

    /** Zoom by k (< 1 = in) keeping the time under the pointer (`at`) where it is on screen. */
    function zoomWindow(win, at, k, extent) {
        if (!Number.isFinite(at)) at = (win.from + win.to) / 2;
        return clampWindow({ from: at - (at - win.from) * k, to: at + (win.to - at) * k }, extent);
    }

    /** Shift by dMs (positive = later). Span is preserved -- clampWindow only moves, never squeezes, an in-range span. */
    function panWindow(win, dMs, extent) {
        return clampWindow({ from: win.from + dMs, to: win.to + dMs }, extent);
    }

    /** The range to ask the server for: the window plus `frac` of its span each side, so a small pan
     *  shows real points immediately instead of an empty edge while the refetch is in flight. 15%, not
     *  more: the server's point budget covers the margin too, so a wide margin downsamples a window
     *  that alone would have fit (checked in a node simulation 2026-10-01: 25% margins turned a
     *  800-request day into 653 points). */
    function fetchRange(win, frac = 0.15) {
        const m = (win.to - win.from) * frac;
        return { from: Math.floor(win.from - m), to: Math.ceil(win.to + m) };
    }

    /**
     * Does what's loaded already serve this window? It must cover it, and if the server downsampled it,
     * it must not be much wider than the window -- zooming 10x into a downsampled "all" would otherwise
     * show 1/10 of its ~1500 points, i.e. exactly the detail the zoom was for would be missing.
     */
    function loadedServes(loaded, win) {
        if (!loaded) return false;
        if (loaded.from > win.from || loaded.to < win.to) return false;
        if (!loaded.downsampled) return true;
        return (loaded.to - loaded.from) <= 2 * (win.to - win.from);
    }

    const pad = (n) => String(n).padStart(2, '0');
    /** Axis tick for an epoch-ms value, at a resolution that suits the visible span. */
    function formatTick(ms, span) {
        const d = new Date(ms);
        const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
        const md = `${d.getMonth() + 1}/${d.getDate()}`;
        if (span <= 10 * 60 * 1000) return `${hm}:${pad(d.getSeconds())}`;
        if (span <= 36 * 3600 * 1000) return hm;
        if (span <= 10 * 24 * 3600 * 1000) return `${md} ${hm}`;
        return md;
    }
    /** "9/30 07:06 – 10/1 07:06" for the status line (date shown on both ends: windows often cross midnight). */
    function formatRange(from, to) {
        const f = (ms) => { const d = new Date(ms); return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; };
        return `${f(from)} – ${f(to)}`;
    }

    /**
     * Widest x gap (ms) the chart's lines may span (2026-10-01, Kyle: "lines, not only dots", but never
     * a trend drawn across idle hours). Chart.js 4 takes a NUMBER for spanGaps as exactly this: a
     * segment whose two points are further apart in x than it is not drawn. The threshold is the
     * largest of: 10 min (the floor -- agent turns a few minutes apart are one stretch of work);
     * 4x the median spacing of the loaded points (a steady slow run, one long generation every ~12 min,
     * stays one line); 2.5 server buckets when downsampled (neighbouring non-empty buckets' extremes can
     * sit up to 2 buckets apart; 2.5 still breaks as soon as a whole empty bucket separates them).
     */
    const GAP_FLOOR_MS = 10 * 60 * 1000;
    function gapThreshold(times, bucketMs) {
        let med = 0;
        if (times && times.length > 2) {
            const d = [];
            for (let i = 1; i < times.length; i++) d.push(times[i] - times[i - 1]);
            d.sort((a, b) => a - b);
            med = d[d.length >> 1];
        }
        return Math.max(GAP_FLOOR_MS, 4 * med, bucketMs ? 2.5 * bucketMs : 0);
    }

    /**
     * Scrollbar under the chart (2026-10-01, Kyle): a track the plot's width standing for the whole
     * extent, a thumb for the window. The thumb has a minimum width (grabbable when the window is a
     * sliver of 2.5 months), so position is mapped over the track's USABLE length (track - thumb),
     * not over raw time -- otherwise a min-width thumb would overhang the end at the newest data.
     * Returns {left, width, usable} in px; null without an extent.
     */
    function thumbGeometry(win, extent, trackPx, minPx = 24) {
        if (!win || !extent || !(trackPx > 0)) return null;
        const extSpan = Math.max(1, extent.last - extent.first), span = win.to - win.from;
        const width = Math.min(trackPx, Math.max(minPx, trackPx * span / extSpan));
        const usable = trackPx - width;
        const room = extSpan - span;
        const frac = room > 0 ? Math.max(0, Math.min(1, (win.from - extent.first) / room)) : 0;
        return { left: frac * usable, width, usable };
    }
    /** Thumb dragged by dxPx -> window shifted by the matching time (same usable-length mapping). */
    function thumbDragWindow(win, extent, trackPx, dxPx, minPx = 24) {
        const g = thumbGeometry(win, extent, trackPx, minPx);
        if (!g || g.usable <= 0) return win;
        const room = (extent.last - extent.first) - (win.to - win.from);
        const d = dxPx / g.usable * Math.max(0, room);
        return clampWindow({ from: win.from + d, to: win.to + d }, extent);
    }
    /** Click on the track at px: centre the thumb there (span unchanged). */
    function trackJumpWindow(win, extent, trackPx, px, minPx = 24) {
        const g = thumbGeometry(win, extent, trackPx, minPx);
        if (!g) return win;
        const span = win.to - win.from, room = (extent.last - extent.first) - span;
        const frac = g.usable > 0 ? Math.max(0, Math.min(1, (px - g.width / 2) / g.usable)) : 0;
        const from = extent.first + frac * Math.max(0, room);
        return clampWindow({ from, to: from + span }, extent);
    }

    /**
     * Window to show a run (expanding it in the table): unchanged if the run already fits inside the
     * current window; otherwise the run plus 10% of its span each side (min MIN_SPAN) -- or, when the
     * run is shorter than the current window, the current span centred on it, so expanding a 3-minute
     * run while looking at a day doesn't zoom you into 4 minutes.
     */
    function windowForRun(win, run, extent) {
        if (!run || !Number.isFinite(run.from)) return win;
        const to = Number.isFinite(run.to) ? run.to : run.from;
        if (win && run.from >= win.from && to <= win.to) return win;
        const pad = Math.max((to - run.from) * 0.1, MIN_SPAN / 2);
        const want = { from: run.from - pad, to: to + pad };
        if (win && (want.to - want.from) < (win.to - win.from)) {
            const mid = (run.from + to) / 2, half = (win.to - win.from) / 2;
            return clampWindow({ from: mid - half, to: mid + half }, extent);
        }
        return clampWindow(want, extent);
    }

    /** Wheel event -> 'pan' (horizontal intent: deltaX-dominant, or shift+wheel) or 'zoom', plus a
     *  pixel delta. deltaMode 1 (lines, Firefox) is scaled to ~px. */
    function wheelIntent(e) {
        const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
        const dx = (e.deltaX || 0) * unit, dy = (e.deltaY || 0) * unit;
        if (e.shiftKey) return { kind: 'pan', px: dx || dy };            // shift+wheel: some browsers already moved it to deltaX
        if (Math.abs(dx) > Math.abs(dy)) return { kind: 'pan', px: dx };
        return { kind: 'zoom', px: dy };
    }

    const api = { MIN_SPAN, SLACK_FRAC, GAP_FLOOR_MS, clampWindow, zoomWindow, panWindow, fetchRange, loadedServes, formatTick, formatRange,
        gapThreshold, thumbGeometry, thumbDragWindow, trackJumpWindow, windowForRun, wheelIntent };
    root.HistWindow = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
