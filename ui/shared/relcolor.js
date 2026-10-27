// Relative, continuous colour for the request tables' numbers (2026-10-01, Kyle: the Recent Requests
// colours were "broken/uninformative" -- run summaries were fixed blue/green/purple classes, and the
// expanded sub-rows faded red->orange->grey->colour over ONE min..max domain spanning every loaded
// request of every model, so a 27B's requests sat at the red end next to a 3B MoE's and showed
// "almost no variance"). Now:
//   - a colour says where a value sits in ITS comparison set, per column: run summaries against
//     the other summaries on screen, a run's requests against the other requests of that run;
//   - the set's bounds are its 5th..95th percentiles, so one outlier (a cache-hit-ish 3 t/s request,
//     a 40-minute wall) clamps to the end of the ramp instead of squeezing everyone else into one hue;
//   - the ramp is continuous (no thresholds): OKLCH hue 25 (red) -> 95 (yellow) -> 145 (green) at a
//     fixed lightness/chroma, so every step is equally visible and nothing goes dark on the dark
//     theme -- an HSL red->green ramp has a bright yellow middle and dim ends;
//   - direction per column is the caller's: higher-better for t/s and draft acceptance, lower-better
//     for wall time; token counts stay uncoloured;
//   - no usable set (fewer than 2 values, or all within the percentile band equal) -> neutral grey.
// A classic script like ui/shared/modelname.js (script.js is not a module; node tests require() it):
// sets globalThis.RelColor, and module.exports under CommonJS.
(function (root) {
    'use strict';

    const NEUTRAL = 'color: rgb(156,163,175)';     // tailwind gray-400, the table's neutral text
    const L = 0.80, C = 0.13, HUE_BAD = 25, HUE_GOOD = 145;

    /** Value at quantile q of an ascending array (linear interpolation). */
    function quantile(sorted, q) {
        if (!sorted.length) return NaN;
        const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos);
        return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
    }

    /** {lo, hi} = 5th..95th percentile of the finite values, or null when they can't rank anything. */
    function robustDomain(values) {
        const v = values.filter((x) => x != null && x !== '' && Number.isFinite(Number(x))).map(Number).sort((a, b) => a - b);
        if (v.length < 2) return null;
        const lo = quantile(v, 0.05), hi = quantile(v, 0.95);
        return hi > lo ? { lo, hi } : null;
    }

    /** 0 (worst) .. 1 (best) position of v in the domain, clamped; null when not rankable. */
    function score(v, domain, higherBetter = true) {
        if (!domain || v == null || v === '' || !Number.isFinite(Number(v))) return null;
        const t = Math.max(0, Math.min(1, (Number(v) - domain.lo) / (domain.hi - domain.lo)));
        return higherBetter ? t : 1 - t;
    }

    /** CSS declaration for a 0..1 score (null -> neutral). */
    function colorForScore(t) {
        if (t == null) return NEUTRAL;
        const h = HUE_BAD + (HUE_GOOD - HUE_BAD) * t;
        return `color: oklch(${L} ${C} ${h.toFixed(1)})`;
    }

    /** The one call the tables make: style="..." for value v in `domain`. */
    function style(v, domain, higherBetter = true) {
        return colorForScore(score(v, domain, higherBetter));
    }

    const api = { NEUTRAL, quantile, robustDomain, score, colorForScore, style };
    root.RelColor = api;
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
