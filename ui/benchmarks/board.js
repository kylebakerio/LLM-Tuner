// The codebench card's own leaderboard: the quality master list across every battery.
//
// Rows are CONFIGS, not models: model + runner + effort + scaffold + n_ctx. "claude at the
// default scaffold" and "claude solo" are different contestants -- the default scaffold
// inherits ~/.claude/settings.json, which today means a Fable advisor, and this suite has
// already been bitten once by treating those as the same entry.
//
// It shares the sorting / denominator / coverage / n= machinery in ui/shared/leaderboard.js
// with the other boards, but the columns and the semantics are this tab's own.

import { esc, harnessLabel, scaffoldBit, catalogStore } from './util.js';
import { createLeaderboard, QUALITY_COLUMNS, ADJ_COLUMN, ctxText, qualityMetricsFor, qualityToMetrics, strengthByDir, strengthForDirs, strengthMetric, overviewView, overviewCatalog } from '../shared/leaderboard.js';

/** The strength cell of a board row: the Models page's config its batteries are in (strengthForDirs), and when that
 *  config pools other batteries too, said so in the cell's note -- the raw columns are this row's own. */
export function boardStrength(byDir, dirs, m) {
    const s = strengthForDirs(byDir, dirs || []);
    const cell = s && strengthMetric(s.a, m);
    if (cell && s.note) { cell.note += ` — ${s.note}`; cell.pooled = true; }
    return cell;
}

export function createBoardView(root, { onOpenRun } = {}) {
    let rows = [];
    let lb = null;
    let byDir = new Map();

    async function load() {
        root.innerHTML = '<div class="text-xs text-gray-500 py-4">loading the master list…</div>';
        let j;
        try {
            const r = await fetch('/api/models/leaderboards');
            if (!r.ok) throw new Error(r.status === 404
                ? 'the /api/models/* routes are in server4.js but the dashboard process has not been restarted yet'
                : `HTTP ${r.status}`);
            j = await r.json();
            // The strength column: the models overview's fit, matched by battery dir (best effort: no catalog, no column values).
            // The page's one catalog (util.js catalogStore, 2026-10-06): a 304 when the Models tab already has it, and its fit is reused.
            // 2026-10-14: fitted on the catalog AS THE MODELS PAGE SHOWS IT (tensor-split rows and f32ssm copies folded, its
            // chart chips), not the raw one -- the raw catalog is another fit, and every number here was off by up to 8 points.
            try {
                const c = await catalogStore.load();
                const v = overviewView();
                const shown = c.catalog ? overviewCatalog(c.catalog, v) : null;
                byDir = shown ? strengthByDir(shown.models || [], v.keepQ, v.keepT) : new Map();
            } catch { byDir = new Map(); }
        } catch (e) {
            root.innerHTML = `<div class="text-xs text-amber-200 bg-amber-900/20 border border-amber-800/40 rounded p-2">${esc(e.message)}</div>`;
            return;
        }
        rows = (j.quality || []).map((q) => {
            // The server's own aggregate for the unfiltered view; qualityMetricsFor is only for the
            // "common tasks only" recompute (the leaderboard does that itself).
            const m = q.agg ? { ...q.agg, tokensPerSolve: q.agg.tokensPerSolve && q.agg.tokensPerSolve.mean,
                tokensPerSolveMedian: q.agg.tokensPerSolve && q.agg.tokensPerSolve.median,
                wallPerSolve: q.agg.wallPerSolve && q.agg.wallPerSolve.mean, wallPerSolveMedian: q.agg.wallPerSolve && q.agg.wallPerSolve.median,
                toolCallsPerSolve: q.agg.toolCallsPerSolve && q.agg.toolCallsPerSolve.mean } : qualityMetricsFor(q.tasks, null);
            return {
                key: q.key,
                label: q.model,
                // the harness filter keys on the harness LABEL, so pi and pi + SoL-Pi are separate chips
                runner: harnessLabel(q.runner, q.scaffold),
                sublabel: [harnessLabel(q.runner, q.scaffold), q.effort && `effort ${q.effort}`, scaffoldBit(q.runner, q.scaffold), ctxText(q, 'row'), q.devices, q.build_info]
                    .filter(Boolean).join(' · '),
                sublabelFull: q.dirs.join(', '),
                badges: q.scaffold === 'default'
                    ? '<span class="ml-1 px-1 py-0.5 rounded bg-amber-900/60 text-amber-200 text-[9px]" title="the default scaffold inherits ~/.claude/settings.json — today that means a Fable advisor also served this run">scaffold: default</span>'
                    : (q.scaffold === 'solo' ? '<span class="ml-1 px-1 py-0.5 rounded bg-green-900/50 text-green-200 text-[9px]" title="exactly one model: the Agent tool and the advisor are disabled">solo</span>' : ''),
                metrics: { ...qualityToMetrics(m), adjSolveRate: boardStrength(byDir, q.dirs, m) },
                n: m.scored,
                coverage: { attempted: m.counted ?? m.attempted, total: q.taskTotal || j.taskTotal },
                tasks: q.tasks,
                dirs: q.dirs,
                warnings: q.dirs.length > 1 ? [`${q.dirs.length} batteries folded into this config — a task run in more than one of them counts fractionally, not latest-wins`] : [],
            };
        });
        render();
    }

    // Optional harness filter. A config's runner is part of its identity, but comparing
    // like for like across harnesses is a different question from ranking everything at once,
    // and the board could not answer it. Runners are read off the rows, so a new one appears
    // here the first time it is used rather than needing to be listed.
    let harness = 'all';
    function render() {
        const runners = [...new Set(rows.map((r) => r.runner).filter(Boolean))].sort();
        if (!runners.includes(harness)) harness = 'all';
        const ON = 'px-2 py-0.5 rounded text-[10px] font-semibold bg-indigo-600 text-white';
        const OFF = 'px-2 py-0.5 rounded text-[10px] font-semibold bg-gray-800 text-gray-400 hover:text-gray-200';
        const chips = ['all', ...runners].map((h) =>
            `<button type="button" data-harness="${esc(h)}" class="${h === harness ? ON : OFF}">${esc(h === 'all' ? 'all harnesses' : h)}</button>`).join(' ');
        root.innerHTML = `<div class="flex flex-wrap items-center gap-1 pb-2">
            <span class="text-[10px] text-gray-500 mr-1">harness:</span>${chips}
          </div><div id="cb-board-mount"></div>`;
        root.querySelectorAll('[data-harness]').forEach((b) => b.addEventListener('click', () => { harness = b.dataset.harness; render(); }));
        lb = createLeaderboard(root.querySelector('#cb-board-mount'), {
            id: 'codebench-quality',
            columns: [ADJ_COLUMN, ...QUALITY_COLUMNS],
            defaultSort: 'adjSolveRate',
            commonTasks: true,
            note: 'One row per <b>configuration</b> — model + runner + effort + scaffold + n_ctx — because those are the contestants, not the model names. '
                + 'Solve rate is over <b>scored</b> tasks: OVERFLOW, KILLED, PROVIDER_ERROR and ABORTED are excluded and counted separately, never as failures. '
                + 'One sample per task, counted <b>fractionally</b> across its runs — 4 passes of 5 is 0.8 of a solve — and <code>sample_group</code> siblings folded to one sample, so the same bug is never weighed twice. '
                + '<code>INVALID-*</code> batteries are left out entirely. '
                + '<b>strength /100</b> is the Models page\'s number for the config these batteries belong to — the same fit, on that page\'s settings (tensor-split rows and f32ssm copies folded in by default, its chart chips) — so it matches the Models page config for config. '
                + 'A strength marked <i>pooled</i> is shared with batteries outside this row (a tensor-split or f32ssm-copy row folded into its base config, launch-unrecorded runs the Models page pools); the raw columns are always this row\'s own. '
                + 'The Models page\'s per-model rows rank a MODEL (all its configs, at the baseline settings), not a config, so they need not equal any row here.',
            onRow: (r) => { if (onOpenRun && r.dirs && r.dirs.length) onOpenRun(r.dirs[0]); },
            emptyText: 'No scored batteries yet.',
        });
        lb.setRows(harness === 'all' ? rows : rows.filter((r) => r.runner === harness));
    }

    return { load, refresh: () => { if (rows.length) load(); } };
}
