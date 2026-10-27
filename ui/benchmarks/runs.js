// Runs view: result dirs -> per-task rows. Read-only over codebench's result files.
// 2026-09-30 (Kyle: "when I click a completed task, I don't want to jump to this transcript page"):
// a task row no longer opens a Transcript/Result page here. It hands the task to the Live view
// (opts.onOpenTask -> live.viewTask), which shows the same layout as the running task, populated from
// the finished one, with the old page's tabs as accordions. The task page code moved to transcript.js.
// 2026-10-06 (Kyle's Back requirement, quoted in ui/shared/route.js): the battery list and a battery's task rows
// are routes (#bench/codebench/runs[/<battery>]). A row or "← runs" click asks index.js for the route
// (opts.onOpenRun / opts.onBack); its route handler calls show(), as it does for Back/Forward.
import { esc, fmtS, fmtDate, fmtN, fmtPct, xy, xyClass, p2pCell, statusChip, unfinishedChip, supersededChip, continuationChip, answeredChip, overflowChip, anomalyChips, countChips, configLine, api, btn, th, td, setHtml } from './util.js';

export function createRunsView(root, opts) {
    const onOpenTask = (opts && opts.onOpenTask) || null;
    const onOpenRun = (opts && opts.onOpenRun) || openRun;
    const onBack = (opts && opts.onBack) || (() => show(null));
    let runs = []; let sel = { dir: null, task: null }; let cacheRun = null;

    async function load() {
        const j = await api('/api/codebench/runs');
        if (j.error) { setHtml(root, `<div class="text-xs text-red-300">${esc(j.error)}</div>`); return; }
        runs = j.runs || [];
        if (!sel.dir) render();   // a late list refresh must not tear down an open transcript
    }
    async function openRun(dir) {
        sel = { dir, task: null }; cacheRun = null; render();
        const j = await api(`/api/codebench/run?dir=${encodeURIComponent(dir)}`);
        if (j.error) { cacheRun = { error: j.error }; } else cacheRun = j;
        render();
    }
    // What the route says is on show: the battery list (no dir) or one battery's task rows.
    function show(dir) {
        if (dir) { if (sel.dir !== dir) openRun(dir); return; }
        if (sel.dir) { sel = { dir: null, task: null }; render(); }
    }
    // A task row: Live, viewing that task (index.js wires onOpenTask). Kept as openTask so every
    // caller that used to reach the old page lands in the same place.
    function openTask(dir, task, view) { if (onOpenTask) onOpenTask(dir, task, view); }

    function render() {
        if (!sel.dir) return renderList();
        return renderRun();
    }
    function renderList() {
        const rows = runs.map((r) => `
            <tr class="hover:bg-gray-800/40 cursor-pointer" data-dir="${esc(r.dir)}">
                <td class="${td} font-mono text-gray-200">${esc(r.dir)}${r.status_derived ? `<span class="text-yellow-500 ml-1" title="${r.status_derived} rows without a status field (derived)">?</span>` : ''}</td>
                <td class="${td} text-gray-300">${configLine(r.config, r.server)}</td>
                <td class="${td} font-mono text-gray-100 whitespace-nowrap" title="solved / scored (OVERFLOW and KILLED leave the denominator)">${r.solved}/${r.scored}${r.excluded ? `<span class="text-gray-500"> (+${r.excluded} excl.)</span>` : ''}${r.diagnostic ? `<span class="text-gray-500" title="diagnostic task(s), counted apart (not in solved / scored): ${esc(r.diagnostic.tasks.join(', '))}"> (+${r.diagnostic.results} diag. ${r.diagnostic.passed} pass)</span>` : ''}</td>
                <td class="${td} font-mono whitespace-nowrap ${xyClass(r.assertions)}" title="${r.assertions ? `hidden-test assertions passed / total over ${r.assertions.tasks} scored task(s) that recorded them` : 'no result in this battery records score.assertions (older harness)'}">${xy(r.assertions)}</td>
                <td class="${td} whitespace-nowrap">${countChips(r.counts)}</td>
                <td class="${td} text-center ${r.anomalies ? 'text-yellow-300' : 'text-gray-600'}">${r.anomalies || '—'}</td>
                <td class="${td} text-gray-400 whitespace-nowrap" title="${r.times_from === 'transcripts' ? 'from transcript mtimes' : 'from result JSON mtimes (rescoring moves these)'}">${fmtDate(r.started)}</td>
                <td class="${td} text-gray-400 whitespace-nowrap">${r.started && r.ended ? fmtS((r.ended - r.started) / 1000) : '—'}</td>
            </tr>`).join('');
        setHtml(root, `
            <div class="flex items-center justify-between">
                <div class="text-xs text-gray-400">${runs.length} batteries with scored results under <code>results/</code>. Click one for its tasks. <code>x/y</code> excludes OVERFLOW and KILLED.</div>
                <button type="button" class="${btn}" data-act="reload">Reload</button>
            </div>
            <div class="overflow-x-auto"><table class="w-full text-xs">
                <thead><tr><th class="${th}">battery</th><th class="${th}">config</th><th class="${th}">solved</th><th class="${th}" title="hidden-test assertions passed/total, summed over scored tasks">assertions</th><th class="${th}">statuses</th><th class="${th}">anom.</th><th class="${th}">started</th><th class="${th}">span</th></tr></thead>
                <tbody>${rows || `<tr><td class="${td} text-gray-500" colspan="8">no scored results found (codebench.root: results/ empty or unreadable)</td></tr>`}</tbody>
            </table></div>`);
        root.querySelectorAll('tr[data-dir]').forEach((tr) => tr.addEventListener('click', () => onOpenRun(tr.dataset.dir)));
        root.querySelector('[data-act=reload]')?.addEventListener('click', load);
    }
    function crumbs() {
        return `<div class="flex items-center gap-2 text-xs">
            <button type="button" class="${btn}" data-act="back-list">← runs</button>
            <span class="font-mono text-gray-200">${esc(sel.dir)}</span>
        </div>`;
    }
    function wireCrumbs() {
        root.querySelector('[data-act=back-list]')?.addEventListener('click', () => onBack());
    }
    function renderRun() {
        if (!cacheRun) { setHtml(root, crumbs() + '<div class="text-xs text-gray-500 mt-2">loading…</div>'); wireCrumbs(); return; }
        if (cacheRun.error) { setHtml(root, crumbs() + `<div class="text-xs text-red-300 mt-2">${esc(cacheRun.error)}</div>`); wireCrumbs(); return; }
        const r = cacheRun;
        const rows = r.rows.map((x) => `
            <tr class="hover:bg-gray-800/40 cursor-pointer" data-task="${esc(x.file.replace(/\.json$/, ''))}">
                <td class="${td} font-mono text-gray-200">${x.bonus ? `<span class="text-gray-500" title="the bonus test of the row above: its own result from the same run (the run's time and tokens are on that row)">↳ ${esc(x.task)}</span>` : esc(x.file.replace(/\.json$/, ''))}</td>
                <td class="${td}">${statusChip(x.status, x.status_derived)}${x.solved_at_cap ? '<span class="text-green-400 ml-1" title="passed under a special condition: code passed the tests although the run hit the time limit (censored time; counts as a pass)">⏱</span>' : ''}${x.unfinished ? unfinishedChip({ ...x.unfinished, wall_s: x.wall_s, ai: x.askedAnswerable || null }) : ''}${supersededChip(x.superseded)}${x.bonus ? '' : continuationChip(x.continuation, x.status === 'pass' || x.status === 'pass*')}${x.answered && !x.continuation ? answeredChip({ passed: x.solved ? 1 : 0, failed: x.solved ? 0 : 1, compacted: Number(x.answered.compactions) > 0 ? 1 : 0, answeredNotes: [{ ...x.answered, status: x.status }] }) : ''}${(x.status === 'pass' || x.status === 'pass*') && (x.anomalies || []).includes('context_overflow') ? overflowChip({ passed: 1 }) : ''}</td>
                <td class="${td} text-right font-mono ${xyClass(x.assertions)}" title="hidden-test (fail_to_pass) assertions passed / total${x.assertions ? ` (${x.assertions.failed} failed)` : ' — not recorded for this result'}">${xy(x.assertions)}</td>
                <td class="${td} text-right font-mono" title="pass_to_pass assertions passed / total, plus files the patch broke">${p2pCell(x)}</td>
                <td class="${td} text-right font-mono ${x.partial != null && x.partial < 1 ? 'text-yellow-300' : 'text-gray-300'}" title="score.partial: fraction of hidden assertions passing">${fmtPct(x.partial)}</td>
                <td class="${td} text-right font-mono">${fmtS(x.wall_s)}</td>
                <td class="${td} text-right font-mono">${fmtN(x.tokens_out)}</td>
                <td class="${td} text-right font-mono">${fmtN(x.tool_calls)}</td>
                <td class="${td} text-right font-mono" title="edits = tool edits + shell edits (${x.tool_edits} + ${x.shell_edits})">${x.edits ?? '—'}${x.shell_edits ? `<span class="text-gray-500 text-[10px]"> (${x.shell_edits} sh)</span>` : ''}</td>
                <td class="${td} text-right font-mono text-gray-400">${fmtS(x.first_edit_s)} → ${fmtS(x.last_edit_s)}</td>
                <td class="${td} text-right font-mono ${x.tests_run === 0 ? 'text-yellow-400' : ''}" title="tests_run: a pass the model never verified is a different result">${x.tests_run ?? '—'}</td>
                <td class="${td}">${anomalyChips(x.anomalies)}</td>
            </tr>`).join('');
        setHtml(root, crumbs() + `
            <div class="text-xs text-gray-300 mt-2">${configLine(r.config, r.server)}</div>
            ${r.server && r.server.flags ? `<div class="text-[10px] font-mono text-gray-500 break-all">${esc(r.server.flags)}</div>` : ''}
            ${r.server && r.server.launch_command ? `<div class="text-[10px] font-mono text-gray-500 break-all" title="launch command">${esc(r.server.launch_command)}</div>` : ''}
            <div class="text-xs text-gray-400 mt-1">solved <b class="text-gray-100 font-mono">${r.solved}/${r.scored}</b> scored${r.excluded ? ` + ${r.excluded} excluded` : ''}${r.diagnostic ? ` + ${r.diagnostic.results} diagnostic (${r.diagnostic.passed} passed: ${esc(r.diagnostic.tasks.join(', '))}; not scored)` : ''}${r.unfinished ? ` + ${r.unfinished} unfinished (awaiting the answer; not counted)` : ''}${r.superseded ? ` + ${r.superseded} superseded by a continuation (not counted)` : ''} · assertions <b class="font-mono ${xyClass(r.assertions)}" title="${r.assertions ? `hidden-test assertions, only over tasks whose tests report per-assertion counts` : 'not recorded in this battery'}">${xy(r.assertions)}</b>${r.assertions ? ` <span class="text-gray-500">over ${r.assertions.tasks} of ${r.scored} scored</span>` : ''} · ${countChips(r.counts)} · ${fmtDate(r.started)} → ${fmtDate(r.ended)}</div>
            <div class="overflow-x-auto mt-2"><table class="w-full text-xs">
                <thead><tr><th class="${th}">task</th><th class="${th}">status</th><th class="${th} text-right" title="hidden-test assertions passed/total">hidden</th><th class="${th} text-right" title="pass_to_pass assertions passed/total (+ broken files)">p2p</th><th class="${th} text-right">partial</th><th class="${th} text-right">wall</th><th class="${th} text-right">tok out</th><th class="${th} text-right">tools</th><th class="${th} text-right">edits</th><th class="${th} text-right">first → last edit</th><th class="${th} text-right">tests</th><th class="${th}">anomalies</th></tr></thead>
                <tbody>${rows}</tbody></table></div>`);
        wireCrumbs();
        root.querySelectorAll('tr[data-task]').forEach((tr) => tr.addEventListener('click', () => openTask(sel.dir, tr.dataset.task)));   // -> Live, viewing it
    }
    return { load, openTask, openRun, show, refresh: () => { if (!sel.dir) load(); }, get selection() { return sel; } };
}
