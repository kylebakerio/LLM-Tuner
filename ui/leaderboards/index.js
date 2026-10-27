// The three leaderboards that live inside the Bench tab's own sub-tab cards:
//   #bench-leaderboard-hw      llama-bench measurements only
//   #bench-leaderboard-sweep   llama-server (launch sweep) rows + the BEST-CONFIGS claim
//   #suite-leaderboard         EvalPlus / Aider
// Same component as the Models overview and the codebench board (ui/shared/leaderboard.js),
// so the denominator and warning semantics cannot drift between them.
//
// No sub-tab's board shows another sub-tab's runs: the hw board is llama-bench rows, the
// sweep board is llama-server rows, and they are never merged (llama-bench cannot drive the
// speculative stack, so its gen numbers are a different measurement entirely).

import { createLeaderboard, SPEED_COLUMNS } from '../shared/leaderboard.js';
import { esc, fmtDur, stripSplitIn } from '../benchmarks/util.js';

const SUITE_STORE = 'suite_results_v1';

const api = async (url) => {
    try {
        const r = await fetch(url);
        if (!r.ok) return { error: r.status === 404 ? 'routes-pending' : `HTTP ${r.status}` };
        return await r.json();
    } catch (e) { return { error: e.message }; }
};

function speedRow(r) {
    const f = r.flags || {};
    const cond = [
        r.buildId ? `build ${r.buildId}` : (f.buildDir || null),
        f.devices, f.ts && `-ts ${f.ts}`,
        f.kvK && `KV ${f.kvK}${f.kvV && f.kvV !== f.kvK ? '/' + f.kvV : ''}`,
        f.ncmoe != null && `-ncmoe ${f.ncmoe}`,
        f.ot && '-ot set',
        f.specType && `${f.specType}${f.specDraftN != null ? ' n' + f.specDraftN : ''}`,
    ].filter(Boolean).join(' · ');
    const warnings = [...(r.warnings || [])];
    if (r.status === 'failed') warnings.push('this config failed to run');
    return {
        key: r.key,
        label: stripSplitIn(`${r.model} — ${r.label}`),
        sublabel: cond || r.configKey, sublabelFull: cond || r.configKey,
        badges: r.measured
            ? ''
            : `<span class="ml-1 px-1 py-0.5 rounded ${r.provisional ? 'bg-amber-900/60 text-amber-200' : 'bg-gray-700 text-gray-300'} text-[9px]">${r.provisional ? 'PROVISIONAL — not measured' : 'documented claim, not a measurement'}</span>`,
        metrics: {
            wall: { v: r.wall, n: r.n, spread: r.wallSpread,
                note: r.workload && (r.workload.promptTokens || r.workload.genTokens)
                    ? `workload: ${r.workload.promptTokens ?? '?'} prompt tokens → ${r.workload.genTokens ?? '?'} generated`
                    : 'no wall time on this row: llama-bench reports rates, not a workload' },
            prefillTps: { v: r.prefillTps, n: r.n, spread: r.prefillSpread, note: r.measured ? `measured, ${r.source}` : 'no measurement on this row' },
            genTps: { v: r.genTps, n: r.n, spread: r.genSpread },
            ctx: r.ctx || null,
            residency: r.residency ? { v: r.residency.label, sort: r.residency.rank, note: r.residency.devices ? `-dev ${r.residency.devices}` : null } : null,
            kv: r.kv || (r.flags && r.flags.kvK) || null,
            draftAcceptRate: { v: r.draftAcceptRate },
        },
        n: r.n,
        coverage: { attempted: null, total: null },
        warnings,
    };
}

async function mountSpeedBoards() {
    const hwEl = document.getElementById('bench-leaderboard-hw');
    const swEl = document.getElementById('bench-leaderboard-sweep');
    if (!hwEl && !swEl) return;
    const j = await api('/api/models/leaderboards');
    const pending = j.error === 'routes-pending';
    const msg = pending
        ? 'The /api/models/* routes are in server4.js but the dashboard process has not been restarted yet — ask the coordinator to restart it.'
        : (j.error ? `Could not load speed rows: ${j.error}` : null);

    const make = (el, rows, id, note) => {
        // The fastest row is not automatically the right choice: a board of t/s cannot express
        // reliability, and at least one config here trades a few percent of wall clock for not
        // dying mid-battery. Per-row warnings carry that; this line makes sure it is read.
        note += ' Rows can carry non-numeric caveats (⚠) — the top row is the fastest measured, not necessarily the one to run.';
        if (!el) return;
        if (msg) { el.innerHTML = `<div class="text-[11px] text-amber-200 bg-amber-900/20 border border-amber-800/40 rounded p-2">${esc(msg)}</div>`; return; }
        const lb = createLeaderboard(el, {
            id, columns: SPEED_COLUMNS, defaultSort: 'wall', note,
            emptyText: 'No runs recorded for this sub-tab yet.',
            onRow: (r) => {
                const key = String(r.key).split('|')[1];
                if (!key) return;
                // (2026-10-06) No click on the Models tab first: the model's page is one route (ui/models/index.js asks
                // the router for it), so one Back returns to this board instead of stopping on the Models overview.
                window.dispatchEvent(new CustomEvent('models:open', { detail: { key } }));
            },
        });
        lb.setRows(rows.map(speedRow));
    };

    const all = (j.speed || []);
    make(hwEl, all.filter((r) => r.source === 'llama-bench'), 'speed-hw',
        'llama-bench only — one row per measured <b>depth</b>, because a t/s number without its context is not a number. '
        + 'llama-bench reports rates, not a job, so these rows have no wall clock: sort them on prefill or generation and remember that those answer different questions — '
        + 'the config with the best generation rate is regularly not the one that finishes a prefill-heavy workload soonest. '
        + 'llama-bench also runs with NO speculative decoding, so its generation figures are no-spec baselines and are not comparable with the launch sweep\'s.');
    make(swEl, all.filter((r) => r.source !== 'llama-bench'), 'speed-sweep',
        'llama-server rows — the real speculative stack. Sorted by <b>wall clock for the stated workload</b>, which is the question "which config should I run"; prefill and generation are beside it and never blended. '
        + 'Ranking on generation alone picks the wrong config on a prefill-heavy mix, and codebench\'s mix is prefill-heavy. '
        + 'The ± is the spread across reps — two configs a rep-spread apart are not separated by their means. '
        + 'KV type is part of the row: it does not transfer between models (f16 wins on the dense 27B, q8_0 on Flash-Next). '
        + 'Reps 2+ of a sweep re-send the identical prompt and are served from the prompt cache, so prefill uses the <b>cold reps only</b>; a row whose reps were all cache hits says so. '
        + 'Rows from BEST-CONFIGS.md are documented claims, not measurements taken here.');
}

// ------------------------------------------------------------------ public suites
// lib/suites.js keeps no history: its state is in memory and one run at a time. So this board
// is built from results this browser has seen and recorded, and says so rather than implying
// a store that does not exist.
function loadSuiteStore() {
    try { return JSON.parse(localStorage.getItem(SUITE_STORE) || '[]'); } catch { return []; }
}
export function recordSuiteResult(rec) {
    if (!rec || !rec.suite) return;
    const list = loadSuiteStore();
    if (list.some((x) => x.startedAt === rec.startedAt && x.suite === rec.suite)) return;
    list.push(rec);
    try { localStorage.setItem(SUITE_STORE, JSON.stringify(list.slice(-100))); } catch { /* quota */ }
    paintSuiteBoard();
}

function scoreOf(result) {
    if (!result || typeof result !== 'object') return null;
    if (Array.isArray(result.pass_at_1) && result.pass_at_1.length) return Math.max(...result.pass_at_1.map(Number).filter(Number.isFinite)) / (Math.max(...result.pass_at_1.map(Number)) > 1 ? 100 : 1);
    if (Array.isArray(result.pass_rate) && result.pass_rate.length) {
        const n = result.pass_rate.map((s) => Number(String(s).split(':').pop())).filter(Number.isFinite);
        return n.length ? Math.max(...n) / 100 : null;
    }
    return null;
}

export function paintSuiteBoard() {
    const el = document.getElementById('suite-leaderboard');
    if (!el) return;
    const rows = loadSuiteStore().map((r, i) => ({
        key: `${r.suite}|${r.startedAt}|${i}`,
        label: `${stripSplitIn(r.model || 'local')} — ${r.suite}${r.dataset ? ' / ' + r.dataset : ''}`,
        sublabel: `${new Date(r.startedAt).toLocaleString()}${r.numTests ? ` · ${r.numTests} tests` : ''}`,
        metrics: {
            score: { v: scoreOf(r.result), note: JSON.stringify(r.result || {}).slice(0, 180) },
            wall: { v: r.wall_s },
            exit: r.exitCode,
        },
        n: r.numTests || null,
        coverage: { attempted: null, total: null },
        warnings: scoreOf(r.result) == null ? ['no score could be parsed out of this run\'s log'] : [],
    }));
    const lb = createLeaderboard(el, {
        id: 'suites',
        columns: [
            { id: 'score', label: 'score', kind: 'pct', dir: 'desc', title: 'pass@1 (EvalPlus) or pass rate (Aider), parsed from the run log' },
            { id: 'wall', label: 'wall', kind: 'dur', dir: 'asc' },
            { id: 'exit', label: 'exit', kind: 'int', dir: 'asc' },
        ],
        defaultSort: 'score',
        note: 'These are <b>public benchmarks that are present in model training data</b>. Treat them as a sanity baseline, never as evidence of capability, and never rank a model against a codebench score using them — that contamination is the entire reason <code>~/code/codebench</code> exists.',
        emptyText: 'No suite run has finished in this browser yet. lib/suites.js keeps no history of its own (its state is in memory, one run at a time), so this board records what this browser has seen.',
    });
    lb.setRows(rows);
}

// Deferred: mounting on page load would run a full buildIndex() on the server for every
// refresh, on a box that is usually mid-battery. The boards load the first time their sub-tab
// is opened (or straight away if that sub-tab is the one being restored).
let speedMounted = false;
function mountSpeedOnce() { if (speedMounted) return; speedMounted = true; mountSpeedBoards(); }
// "Opened" is the route (ui/shared/route.js), so this covers a click, Back/Forward and a link straight to #bench/sweep.
window.Nav?.on((r) => { if (r.tab === 'bench' && (r.sub === 'hw' || r.sub === 'server')) mountSpeedOnce(); });
paintSuiteBoard();
// script.js's suite poller announces a finished run; it has no module scope of its own.
window.addEventListener('suite:finished', (e) => recordSuiteResult(e.detail));
window.addEventListener('leaderboards:refresh', () => { if (speedMounted) mountSpeedBoards(); paintSuiteBoard(); });
