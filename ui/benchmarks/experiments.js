// Experiments view (Bench -> quality — codebench -> Experiments): side experiments that must NOT
// affect mainline results. Each experiment is one card in EXPERIMENTS; the first is verify-on-fail.
//
// verify-on-fail (codebench harness/run.py verify_followup, from 2026-09-25): when a run scores
// `fail`, the harness resumes the agent's own session with one more user turn ("Can you verify your
// work and make sure you didn't miss anything?", 30 min cap), re-scores, and records the outcome in
// the result JSON under `verify` only. The run's mainline status and score never change, and nothing
// on the leaderboards, ladder or grid reads `verify` (test/experiments.test.js pins that).
//
// Data: GET /api/codebench/experiments/verify -> {rows: lib/codebench.js listVerifyRuns()}.
// Pure at load (no DOM access until createExperimentsView is called), so node tests can import it.
import { esc, fmtDur, fmtDate, fmtN, xy, xyClass, statusChip, api, btn, th, td, setHtml, harnessLabel, scaffoldBit } from './util.js';
import { wilson } from '../shared/leaderboard.js';

const PAGE = 20;

// "+1 of 6 new" beside the raw counts: progress beyond what the untouched base passes (baseline.json),
// before -> after the follow-up turn, with regressions (base passes now failing). '' without a baseline.
export function progressCell(before, after) {
    const one = (p) => (p && p.of > 0
        ? `<span class="${p.count > 0 ? 'text-green-300' : 'text-gray-400'}">${p.exact === false ? '≈' : ''}+${p.count}/${p.of}</span>${p.regressions ? `<span class="text-amber-300" title="base passes now failing">↓${p.regressions}</span>` : ''}`
        : '<span class="text-gray-600">—</span>');
    if (!(before && before.of > 0) && !(after && after.of > 0)) return '';
    return `<div class="text-[10px] text-gray-500" title="hidden-test cases that fail on the untouched base and pass here, before → after the verify turn (≈ approximate: from totals); ↓ = regressions">new beyond base ${one(before)} <span class="text-gray-600">→</span> ${one(after)}</div>`;
}

export const median = (xs) => {
    const v = xs.filter((x) => x != null && Number.isFinite(Number(x))).map(Number).sort((a, b) => a - b);
    if (!v.length) return null;
    const m = Math.floor(v.length / 2);
    return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
// One configuration = runner + model + effort + scaffold (the same axes the battery config line shows).
export function modelKey(r) { return [r.runner || '?', r.model || '?', r.effort || '', r.scaffold || ''].join('|'); }
export function modelLabel(r) { return [r.model || '(no model)', r.effort, scaffoldBit(r.runner, r.scaffold)].filter(Boolean).join(' · ') + (r.runner ? ` (${harnessLabel(r.runner, r.scaffold)})` : ''); }

// Per-configuration summary of verify-on-fail rows (plus an `all` total). A row is one mainline
// fail the harness tried to follow up: `attempt` (the extra turn ran), `skipped` (e.g. no session
// id) or `error` (the follow-up itself crashed). Rates are over attempts; the cost per rescue is
// every attempt's extra wall time divided by the rescues it bought.
export function summarizeVerify(rows) {
    const groups = new Map();
    const blank = (key, label) => ({ key, label, tried: 0, attempts: 0, rescued: 0, still_failing: 0, timeout: 0, skipped: 0, errored: 0,
        patch_changed: 0, patch_known: 0, walls: [], tokens: [], wall_sum: 0 });
    const all = blank('all', 'all configurations');
    const add = (g, r) => {
        const v = r.verify || {};
        g.tried++;
        if (v.kind === 'skipped') { g.skipped++; return; }
        if (v.kind === 'error' || v.kind !== 'attempt') { g.errored++; return; }
        g.attempts++;
        if (v.status === 'pass' || v.status === 'pass*') g.rescued++;
        else if (v.status === 'TIMEOUT') g.timeout++;
        else g.still_failing++;
        if (typeof v.patch_changed === 'boolean') { g.patch_known++; if (v.patch_changed) g.patch_changed++; }
        if (v.wall_s != null) { g.walls.push(v.wall_s); g.wall_sum += v.wall_s; }
        if (v.tokens_out != null) g.tokens.push(v.tokens_out);
    };
    for (const r of rows || []) {
        const k = modelKey(r);
        if (!groups.has(k)) groups.set(k, blank(k, modelLabel(r)));
        add(groups.get(k), r); add(all, r);
    }
    const fin = (g) => ({
        key: g.key, label: g.label, tried: g.tried, attempts: g.attempts, rescued: g.rescued, still_failing: g.still_failing,
        timeout: g.timeout, skipped: g.skipped, errored: g.errored,
        rate: g.attempts ? g.rescued / g.attempts : null,
        ci: wilson(g.rescued, g.attempts),
        median_wall_s: median(g.walls), median_tokens_out: median(g.tokens),
        wall_per_rescue_s: g.rescued ? g.wall_sum / g.rescued : null,
        patch_changed: g.patch_changed, patch_known: g.patch_known,
    });
    const models = [...groups.values()].map(fin).sort((a, b) => b.tried - a.tried || a.label.localeCompare(b.label));
    return { models, all: fin(all) };
}

const pct = (p) => (p == null ? '—' : `${Math.round(p * 100)}%`);
// "+12 min" for the side notes; the tables use fmtDur.
export function plusTime(s) {
    if (s == null || !Number.isFinite(Number(s))) return '';
    const n = Number(s);
    return n >= 90 ? `+${Math.round(n / 60)} min` : `+${Math.round(n)} s`;
}
// The one-line side note for a run's result page: "after verify: pass (5/7), +12 min".
export function verifyNoteText(v) {
    if (!v) return '';
    if (v.kind === 'skipped') return `verify follow-up skipped: ${v.reason}`;
    if (v.kind === 'error') return `verify follow-up errored: ${v.reason}`;
    const a = v.assertions ? ` (${xy(v.assertions)})` : '';
    const t = plusTime(v.wall_s);
    return `after verify: ${v.status || '?'}${a}${t ? `, ${t}` : ''}`;
}

// ---------- the experiments registry ----------
// Future side experiments get an entry here (and their own render); `planned` ones show as a stub.
const EXPERIMENTS = [
    { id: 'verify-on-fail', code: 'E1', title: 'verify-on-fail', since: '2026-09-25', render: renderVerify },
    { id: 'caution-nudge', code: 'J1', title: 'caution nudge', planned: true,
        blurb: 'Planned: a nudge toward caution before the agent declares done. Not running yet; it will get its own card here.' },
];

function afterChip(v) {
    if (!v) return '<span class="text-gray-600">—</span>';
    if (v.kind === 'skipped') return `<span class="inline-block px-1.5 py-0.5 rounded text-[10px] font-mono bg-gray-800 text-gray-400" title="${esc(v.reason)}">skipped</span>`;
    if (v.kind === 'error') return `<span class="inline-block px-1.5 py-0.5 rounded text-[10px] font-mono bg-red-900/40 text-red-300" title="${esc(v.reason)}">error</span>`;
    return statusChip(v.status || '?');
}

function renderVerify(state) {
    const rows = state.rows || [];
    const intro = `<p class="text-xs text-gray-300">When a codebench run scores <b>fail</b>, the harness resumes the agent's own session with one more turn —
        <i class="text-gray-200">"Can you verify your work and make sure you didn't miss anything?"</i> (30 min cap) — and scores it again.
        <span class="text-yellow-300">Side experiment: a rescue here is never counted as a pass on the leaderboards, ladder, grid or battery totals.</span></p>`;
    if (state.error) return intro + `<div class="text-xs text-red-300 mt-2">${esc(state.error)}</div>`;
    if (state.loading) return intro + '<div class="text-xs text-gray-500 mt-2">loading…</div>';
    if (!rows.length) {
        return intro + `<div class="mt-3 border border-gray-800 rounded-lg p-3 text-xs text-gray-400 space-y-1">
            <div class="text-gray-200 font-semibold">No verify-on-fail data yet.</div>
            <div>The follow-up only runs on new runs from 2026-09-25 on, and only after a run scores <span class="font-mono">fail</span> (opencode and claude runners). Older fails have no follow-up; a tool to run it retroactively on them is deferred.</div>
            <div class="text-gray-500">Rows appear here as soon as a result JSON with a <code>verify</code> block is written under <code>results/</code>.</div>
        </div>`;
    }
    const s = summarizeVerify(rows);
    const mrow = (m, total) => `<tr class="${total ? 'bg-gray-900/40 font-semibold' : 'hover:bg-gray-800/50 cursor-pointer'}" ${total ? '' : `data-model="${esc(m.key)}"`}>
        <td class="${td} ${total ? 'text-gray-300' : 'text-gray-200'} whitespace-nowrap">${esc(m.label)}${!total && state.filter === m.key ? ' <span class="text-indigo-300">●</span>' : ''}</td>
        <td class="${td} text-right font-mono">${m.tried}</td>
        <td class="${td} text-right font-mono whitespace-nowrap ${m.rescued ? 'text-green-300' : 'text-gray-400'}" title="${m.ci ? `95% Wilson interval ${pct(m.ci.lo)}–${pct(m.ci.hi)} over ${m.attempts} attempt(s)` : 'no attempts'}">${m.rescued}/${m.attempts} <span class="text-gray-300">${pct(m.rate)}</span>${m.ci ? ` <span class="text-[10px] text-gray-500">[${pct(m.ci.lo)}–${pct(m.ci.hi)}]</span>` : ''}</td>
        <td class="${td} text-right font-mono ${m.still_failing ? 'text-red-300' : 'text-gray-500'}">${m.still_failing}</td>
        <td class="${td} text-right font-mono ${m.timeout ? 'text-orange-300' : 'text-gray-500'}">${m.timeout}</td>
        <td class="${td} text-right font-mono text-gray-400" title="${m.skipped} skipped, ${m.errored} errored">${m.skipped + m.errored ? `${m.skipped} / ${m.errored}` : '—'}</td>
        <td class="${td} text-right font-mono">${fmtDur(m.median_wall_s)}</td>
        <td class="${td} text-right font-mono">${fmtN(m.median_tokens_out == null ? null : Math.round(m.median_tokens_out))}</td>
        <td class="${td} text-right font-mono ${m.wall_per_rescue_s != null ? 'text-gray-200' : 'text-gray-500'}" title="all extra wall time spent on attempts, divided by the rescues">${m.wall_per_rescue_s != null ? fmtDur(m.wall_per_rescue_s) : (m.attempts ? 'no rescue' : '—')}</td>
        <td class="${td} text-right font-mono text-gray-300" title="attempts whose patch differed at all after the verify turn">${m.patch_known ? `${m.patch_changed}/${m.patch_known}` : '—'}</td>
    </tr>`;
    const summary = `<div class="overflow-x-auto mt-3 border border-gray-800 rounded-lg"><table class="w-full text-xs">
        <thead><tr>
            <th class="${th}">configuration</th>
            <th class="${th} text-right" title="mainline fails the harness followed up (attempts + skipped + errored)">fails tried</th>
            <th class="${th} text-right" title="verify pass / attempts, with the 95% Wilson interval">rescued</th>
            <th class="${th} text-right">still fail</th>
            <th class="${th} text-right">timed out</th>
            <th class="${th} text-right" title="skipped / errored follow-ups">skip / err</th>
            <th class="${th} text-right" title="median extra wall time per attempt">+wall (med)</th>
            <th class="${th} text-right" title="median extra output tokens per attempt">+tok out (med)</th>
            <th class="${th} text-right" title="total extra wall time / rescues">time per rescue</th>
            <th class="${th} text-right" title="attempts where the patch changed at all">patch changed</th>
        </tr></thead>
        <tbody>${s.models.map((m) => mrow(m, false)).join('')}${s.models.length > 1 ? mrow(s.all, true) : ''}</tbody></table></div>
        <div class="text-[10px] text-gray-500 mt-1">Click a configuration to filter the runs below. Rates are over attempts (skipped and errored follow-ups are not attempts). Brackets: 95% Wilson interval — at a handful of attempts it is wide on purpose.</div>`;

    const filtered = state.filter ? rows.filter((r) => modelKey(r) === state.filter) : rows;
    const shown = filtered.slice(0, state.limit);
    const runRow = (r) => {
        const v = r.verify || {};
        const b = r.before || {};
        const extra = v.kind === 'attempt'
            ? `${fmtDur(v.wall_s)}<span class="text-gray-500"> · ${fmtN(v.tokens_out)} tok</span>${v.patch_changed === false ? '<span class="text-gray-500" title="the patch did not change"> · same patch</span>' : ''}`
            : `<span class="text-gray-500" title="${esc(v.reason || '')}">${esc(String(v.reason || '').slice(0, 60))}${String(v.reason || '').length > 60 ? '…' : ''}</span>`;
        return `<tr>
            <td class="${td} whitespace-nowrap"><div class="font-mono text-gray-200">${esc(r.task)}</div><div class="text-[10px] text-gray-400">${esc(modelLabel(r))}</div><div class="font-mono text-[10px] text-gray-500">${esc(r.dir)}</div></td>
            <td class="${td} text-gray-400 whitespace-nowrap">${fmtDate(r.ran_at)}</td>
            <td class="${td} whitespace-nowrap">${statusChip(b.status || '?')} <span class="text-gray-500">→</span> ${afterChip(v)}</td>
            <td class="${td} font-mono whitespace-nowrap"><span class="${xyClass(b.assertions)}">${xy(b.assertions)}</span> <span class="text-gray-500">→</span> <span class="${xyClass(v.assertions)}">${xy(v.assertions)}</span>${progressCell(b.progress, v.progress)}</td>
            <td class="${td} font-mono whitespace-nowrap">${extra}</td>
            <td class="${td} whitespace-nowrap">
                <button type="button" class="${btn}" data-open="transcript" data-dir="${esc(r.dir)}" data-task="${esc(r.task)}">transcript</button>
                ${v.kind === 'attempt' ? `<button type="button" class="${btn}" data-open="verify" data-dir="${esc(r.dir)}" data-task="${esc(r.task)}" title="${esc(v.transcript || '')}">verify transcript</button>` : ''}
            </td>
        </tr>`;
    };
    const list = `<div class="flex flex-wrap items-center gap-2 mt-3">
            <div class="text-[10px] uppercase tracking-wider text-gray-500">runs (${filtered.length}${state.filter ? ` of ${rows.length}` : ''}, newest first)</div>
            ${state.filter ? `<button type="button" class="${btn}" data-act="clear-filter">show all configurations</button>` : ''}
        </div>
        <div class="overflow-x-auto mt-1 border border-gray-800 rounded-lg"><table class="w-full text-xs">
            <thead><tr><th class="${th}">task · configuration · battery</th><th class="${th}">ran</th><th class="${th}">before → after</th><th class="${th}" title="hidden-test assertions passed/total, before → after the verify turn">assertions</th><th class="${th}" title="extra wall time and output tokens the verify turn cost">extra</th><th class="${th}">open</th></tr></thead>
            <tbody>${shown.map(runRow).join('')}</tbody></table></div>
        ${filtered.length > shown.length ? `<div class="mt-1"><button type="button" class="${btn}" data-act="more">show ${Math.min(PAGE, filtered.length - shown.length)} more (${filtered.length - shown.length} left)</button></div>` : ''}`;
    return intro + summary + list;
}

export function createExperimentsView(root, opts) {
    const o = opts || {};
    const state = { rows: [], loading: true, error: null, filter: null, limit: PAGE, open: { 'verify-on-fail': true } };
    try { const f = localStorage.getItem('codebench_exp_filter'); if (f) state.filter = f; } catch { /* private mode */ }

    async function load() {
        state.loading = !state.rows.length; render();
        const j = await api('/api/codebench/experiments/verify');
        state.loading = false;
        if (j.error) state.error = j.error; else { state.error = null; state.rows = j.rows || []; }
        if (state.filter && !state.rows.some((r) => modelKey(r) === state.filter)) state.filter = null;
        render();
    }
    function setFilter(k) {
        state.filter = k; state.limit = PAGE;
        try { if (k) localStorage.setItem('codebench_exp_filter', k); else localStorage.removeItem('codebench_exp_filter'); } catch { /* ignore */ }
        render();
    }
    function render() {
        const cards = EXPERIMENTS.map((e) => {
            if (e.planned) {
                return `<div class="border border-gray-800 rounded-xl p-3 bg-gray-900/40">
                    <div class="flex flex-wrap items-baseline gap-2"><span class="font-mono text-[10px] text-gray-500">${esc(e.code)}</span><span class="text-sm font-semibold text-gray-400">${esc(e.title)}</span><span class="text-[10px] px-1.5 py-0.5 rounded bg-gray-800 text-gray-500">planned</span></div>
                    <div class="text-xs text-gray-500 mt-1">${esc(e.blurb)}</div></div>`;
            }
            const openNow = state.open[e.id] !== false;
            return `<div class="border border-gray-800 rounded-xl p-3 min-w-0" data-exp="${esc(e.id)}">
                <button type="button" class="w-full flex flex-wrap items-baseline gap-2 text-left" data-toggle="${esc(e.id)}">
                    <span class="font-mono text-[10px] text-gray-500">${esc(e.code)}</span>
                    <span class="text-sm font-semibold text-gray-100">${esc(e.title)}</span>
                    <span class="text-[10px] px-1.5 py-0.5 rounded bg-indigo-600/20 text-indigo-300">running since ${esc(e.since)}</span>
                    <span class="text-[10px] px-1.5 py-0.5 rounded bg-yellow-900/40 text-yellow-300">not counted in mainline</span>
                    <span class="ml-auto text-[10px] text-gray-500">${openNow ? '▾' : '▸'}</span>
                </button>
                ${openNow ? `<div class="mt-2">${e.render(state)}</div>` : ''}
            </div>`;
        }).join('');
        setHtml(root, `
            <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="text-xs text-gray-400">Side experiments on codebench runs. Their outcomes live beside the mainline results and never change a run's status, score or any leaderboard.</div>
                <button type="button" class="${btn}" data-act="reload">Reload</button>
            </div>
            <div class="space-y-2 mt-2">${cards}</div>`);
        root.querySelector('[data-act=reload]')?.addEventListener('click', load);
        root.querySelectorAll('[data-toggle]').forEach((b) => b.addEventListener('click', () => { const id = b.dataset.toggle; state.open[id] = state.open[id] === false; render(); }));
        root.querySelectorAll('tr[data-model]').forEach((tr) => tr.addEventListener('click', () => setFilter(state.filter === tr.dataset.model ? null : tr.dataset.model)));
        root.querySelector('[data-act=clear-filter]')?.addEventListener('click', () => setFilter(null));
        root.querySelector('[data-act=more]')?.addEventListener('click', () => { state.limit += PAGE; render(); });
        root.querySelectorAll('button[data-open]').forEach((b) => b.addEventListener('click', () => { if (o.onOpenTask) o.onOpenTask(b.dataset.dir, b.dataset.task, b.dataset.open); }));
    }
    return { load, refresh: load };
}
