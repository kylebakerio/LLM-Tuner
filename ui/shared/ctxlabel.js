// A context size in words: THE ONE RULE (2026-10-25, Kyle: "one context-label rule"). Every page, the catalog
// (lib/models.js ctx_label, agentWindow.label / serverLabel), the Live card (lib/runlabel.js), the launch sidebar and the
// queue page print a context size through ctxLabel() below; nothing formats one itself.
//   - a size named in thousands reads its name: opencode's local-128k window is 128000 tokens -> "128k" (the old
//     n / 1024 everywhere read it "125k"), local-63k 63000 -> "63k";
//   - any other size reads in kibi, as every label did before: a llama-server context is launched at a multiple of 1024
//     (131072 -> 128k, 262144 -> 256k, 65536 -> 64k, 98304 -> 96k, 229376 -> 224k, 1048576 -> 1024k), so every server
//     context on record reads exactly as it did;
//   - below 1024 the number itself (no context is that small; the profile picker and the model page printed it so);
//   - null for no size (null, 0, not a number).
// Contexts only: VRAM, token counts per solve and the prefill charts' prompt-length ticks are not context sizes and keep
// their own formatting. Not dash-cli either: its launch list prints the profile names' thousands ("131k") on purpose.
//
// A classic script, not an ES module, for the same reason as ui/shared/modelname.js: script.js and the launch sidebar
// (ui/shared/sidegroups.js) are classic scripts and Node 20's require() cannot load ESM (lib/models.js, lib/runlabel.js).
// Sets `globalThis.CtxLabel` (the classic scripts read it; ES modules take `ctxLabel` / `commonWindow` from
// ui/benchmarks/util.js, which imports this file for the side effect), and `module.exports` under CommonJS.
(function (root) {
    'use strict';

    /** 131072 -> "128k", 128000 -> "128k", 262144 -> "256k", 512 -> "512"; null without a size. */
    function ctxLabel(n) {
        const x = Number(n);
        if (n == null || n === '' || !Number.isFinite(x) || x <= 0) return null;
        if (x < 1024) return String(x);
        return x % 1000 === 0 ? `${x / 1000}k` : `${Math.round(x / 1024)}k`;
    }

    /**
     * The agent-window note of a row merged from several runs or configs (2026-10-25). `list`: things carrying
     * `agentWindow` (lib/models.js effectiveContext: there only for a run filed under its agent's window, out of step
     * with its server). -> the note they ALL carry, identical (same window, same server), else null: a row pooling runs
     * with and without one -- the Ornith 128k row, local-128k on a 262144 server and on a 131072 one -- reads plainly at
     * its size ("128k ctx"). A single battery or config line keeps its own. The one rule for the server's groups
     * (lib/models.js groupEntriesByConfig: the Benchmarks board, the catalog's configs) and the pages' (leaderboard.js
     * groupConfigs: the Models page's rows).
     */
    function commonWindow(list) {
        const ws = Array.from(list || [], (x) => (x && x.agentWindow) || null);
        if (!ws.length || !ws[0]) return null;
        const k = JSON.stringify(ws[0]);
        return ws.every((w) => w && JSON.stringify(w) === k) ? ws[0] : null;
    }

    const api = { ctxLabel, commonWindow };
    root.CtxLabel = api;
    if (typeof module === 'object' && module && module.exports) module.exports = api;
})(globalThis);
