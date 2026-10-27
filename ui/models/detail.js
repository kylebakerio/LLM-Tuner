// A single model's detail view: Speed / Quality / History / Tunings.
// Every duration goes through fmtDur(); a t/s figure always carries the context it was
// measured at; cloud rows say plainly that their only speed number is tokens / wall.

import { esc, fmtDur, fmtN, statusChip, answeredChip, overflowChip, unfinishedChip, xy, xyClass, th, harnessLabel, scaffoldBit, ctxLabel } from '../benchmarks/util.js';
import { modelPrefillCurve, genByConfig, ratesOverTime } from './charts.js';
import { createLeaderboard, SPEED_COLUMNS, QUALITY_COLUMNS, ADJ_COLUMN, configText, ctxText, FACETS, FACET_DEFAULTS, groupConfigs, relSolveTimes, groupMetrics, facetBar, strengthByDir, strengthForDirs, strengthMetric, SPEED_BANDS, SPEED_MIN_REQ } from '../shared/leaderboard.js';

const pct = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : `${(Number(v) * 100).toFixed(1)}%`);
const t1 = (v) => (v == null || !Number.isFinite(Number(v)) ? '—' : Number(v).toFixed(1));
// What the number's spread actually means, in words, on hover.
function bandNote(x, repeats, fmt) {
    if (!x || x.median == null) return null;
    if (repeats) return `median of ${x.n} rep(s)${x.spread != null ? `, ± is half the range across them` : ''}`;
    if (x.p25 == null || x.p75 == null) return `median of ${x.n} logged request(s)`;
    return `median of ${x.n} logged requests · middle half ${fmt(x.p25)} – ${fmt(x.p75)} (workload variation, not measurement noise)`;
}

const VIA_LABEL = {
    model_path: 'the server recorded its own model_path — self-describing, no guess',
    battery_override: 'resolved by an explicit battery-dir entry in lib/models.js (the opencode id was reused across models)',
    dir_heuristic: 'quant read out of the battery dir name because the opencode id is ambiguous — check this one',
    alias: 'resolved by the opencode-id alias map',
    gguf: 'read straight off the gguf filename',
    cloud: 'a known cloud model id',
    runner_default: 'no --model recorded; resolved by the documented runner default',
    unresolved: 'could not be resolved — kept as its own pseudo-model rather than folded into a real one',
};

// DIAGNOSTIC tasks (task.yaml category `diagnostic`, 2026-10-17: "a special test for functionality, like a speed
// test, that isn't a quality test"): their results, one line per task, apart from everything above -- the server leaves
// them out of the solve rate, coverage, strength fit and task points, and a failed one is not a failed task.
export function diagnosticsCard(m, ctx = {}) {
    const d = Object.entries((m && m.diagnostics) || {});
    if (!d.length) return '';
    const rows = d.sort(([a], [b]) => a.localeCompare(b)).map(([task, t]) => `<tr class="border-t border-gray-800/60">
        <td class="px-2 py-1 font-mono">${ctx && ctx.openTask ? `<button type="button" data-open-task="${esc(task)}" class="text-indigo-300 hover:underline">${esc(task)}</button>` : esc(task)}</td>
        <td class="px-2 py-1">${statusChip(t.status)}${overflowChip(t.overflowed, t.passes)}</td>
        <td class="px-2 py-1 text-right font-mono">${t.excluded ? '—' : `${t.passes}/${t.attempts}`}</td>
        <td class="px-2 py-1 text-right font-mono">${t.wall_s > 0 ? fmtDur(t.wall_s) : '—'}</td>
        <td class="px-2 py-1 text-right font-mono text-gray-500">${t.ran_at ? new Date(t.ran_at).toISOString().slice(0, 10) : ''}</td></tr>`).join('');
    return `<div class="card !p-4" data-diagnostics>
      <div class="text-[13.5px] font-semibold text-gray-100 mb-1">Diagnostic tasks <span class="text-gray-600 font-normal">(functional checks, like a speed test — not part of the solve rate, coverage, strength or task points; a fail here is not a failed task)</span></div>
      <table class="w-full text-[11px]"><thead><tr class="text-gray-500 border-b border-gray-800">
        <th class="text-left px-2 py-1 font-medium">task</th><th class="text-left px-2 py-1 font-medium">latest result</th>
        <th class="text-right px-2 py-1 font-medium">runs passed</th><th class="text-right px-2 py-1 font-medium">wall</th><th class="text-right px-2 py-1 font-medium">ran</th></tr></thead>
        <tbody>${rows}</tbody></table></div>`;
}

export function renderDetail(root, m, ctx) {
    // the public site has no Sources tab (where each number was read from: file-level detail, not results)
    const tabs = [['speed', 'Speed'], ['quality', 'Quality'], ['history', 'History'], ['tunings', 'Tunings'], ...(window.PUBLIC_SITE ? [] : [['sources', 'Sources']])];
    let view = ctx.view || 'speed';

    root.innerHTML = `
      <div class="space-y-4 max-w-[1300px] mx-auto">
        <button type="button" id="md-back" class="btn btn-ghost btn-sm -ml-2">← Results</button>
        <div class="flex flex-wrap items-end gap-3">
          <div class="min-w-0">
            <div class="flex flex-wrap items-center gap-2">
              <h2 class="text-[20px] font-semibold tracking-tight text-white">${esc(m.display)}</h2>
              ${m.provider === 'cloud' ? '<span class="tag tag-sky">cloud</span>' : '<span class="tag tag-gray">local</span>'}
              ${m.quant ? `<span class="tag tag-gray font-mono">${esc(m.quant)}</span>` : ''}
              ${m.ambiguous ? '<span class="tag tag-amber" title="' + esc(m.ambiguousNote || '') + '">ambiguous identity</span>' : ''}
              ${m.unresolved ? '<span class="tag tag-red">unresolved</span>' : ''}
            </div>
            <div class="text-[11px] text-gray-500 font-mono mt-1">${esc(m.key)}${m.efforts && m.efforts.length ? ' · effort ' + m.efforts.map(esc).join('/') : ''}</div>
          </div>
          <div class="ml-auto flex flex-wrap gap-1.5 justify-end">
            <span class="stat-chip"><b>${fmtN(m.counts.requests)}</b> requests</span>
            <span class="stat-chip"><b>${fmtN(m.counts.benchRuns)}</b> llama-bench blocks</span>
            <span class="stat-chip"><b>${fmtN(m.counts.sweepRows)}</b> sweep rows</span>
            <span class="stat-chip"><b>${fmtN(m.counts.qualityBatteries)}</b> batteries</span>
            <span class="stat-chip"><b>${fmtN(m.counts.qualityTasks)}</b> quality tasks</span>
          </div>
        </div>
        <div class="seg-row p-1 rounded-[11px] bg-gray-900 border border-gray-800 w-max max-w-full">${tabs.map(([k, l]) => `<button type="button" data-mv="${k}" class="seg-btn">${l}</button>`).join('')}</div>
        <div id="md-body"></div>
      </div>`;

    const ON = 'seg-btn is-on';
    const OFF = 'seg-btn';
    const body = root.querySelector('#md-body');
    root.querySelector('#md-back').addEventListener('click', () => ctx.onBack());

    function setView(v) {
        view = v; ctx.view = v;
        root.querySelectorAll('button[data-mv]').forEach((b) => { b.className = b.dataset.mv === v ? ON : OFF; });
        ({ speed: paintSpeed, quality: paintQuality, history: paintHistory, tunings: paintTunings, sources: paintSources }[v] || paintSpeed)();
    }
    // (2026-10-06) In the dashboard a tab of this page is a route (#results/<key>/<tab>, ui/shared/route.js): the click
    // asks for it (ctx.onView) and the router calls ctx.setView, as it does for Back/Forward. The public site has neither.
    root.querySelectorAll('button[data-mv]').forEach((b) => b.addEventListener('click', () => (ctx.onView ? ctx.onView(b.dataset.mv) : setView(b.dataset.mv))));
    ctx.setView = setView;

    // ---------------------------------------------------------------- Speed
    function paintSpeed() {
        if (m.provider === 'cloud') {
            body.innerHTML = `<div class="text-xs text-gray-400 card !p-4">
                No measured speed exists for a cloud model here. The only rate we can compute is
                <b>output tokens ÷ wall clock</b> over its codebench runs — a coarse end-to-end figure that
                includes tool execution and provider queuing, not a prefill or decode rate:
                <span class="font-mono text-amber-300">~${t1(m.speed && m.speed.tokensPerSec)} tok/s</span>.
                It must not be plotted against a local model's measured prefill curve.</div>`;
            return;
        }
        const d = m.speedDetail || { curve: { fromRequests: [], fromBench: [] }, byConfig: [], benchBlocks: [], sweepRows: [] };
        // The model's FASTEST SPEED CONFIG (2026-10-22): the one the Results page's charts and the compare page price its
        // time at (ui/shared/leaderboard.js fastestSpeedConfig, over its codebench runs; ctx.fastestSpeed from the overview).
        // The table below lists every launch config from the request log; the one that is this config is marked there.
        const fs = ctx.fastestSpeed || null;
        const r1 = (v) => (v == null ? '—' : v >= 100 ? fmtN(Math.round(v)) : t1(v));
        const fsCard = !fs ? '' : `<div class="card !p-4" data-fastest-speed="1">
              <div class="text-[13.5px] font-semibold text-gray-100 mb-1">Fastest speed config <span class="text-gray-500 font-normal">· the one its time is priced at on Results and Compare</span></div>
              <div class="text-[11px] text-gray-400 font-mono break-all mb-2">${esc(fs.label)}${fs.thin ? ' <span class="text-amber-300">(thin: no config has the evidence; the most-measured one)</span>' : ''}</div>
              <div class="overflow-x-auto"><table class="text-xs"><thead><tr class="text-[10px] uppercase tracking-wider text-gray-500">
                <th class="px-2 py-1 text-right">tg all</th>${SPEED_BANDS.map((b) => `<th class="px-2 py-1 text-right" title="${esc(b.title)}">tg ${esc(b.label)}</th>`).join('')}
                <th class="px-2 py-1 text-right">pp all</th>${SPEED_BANDS.map((b) => `<th class="px-2 py-1 text-right" title="${esc(b.title)}">pp ${esc(b.label)}</th>`).join('')}<th class="px-2 py-1 text-right">requests</th></tr></thead>
                <tbody><tr class="font-mono text-gray-200"><td class="px-2 py-1 text-right">${r1(fs.sp.tg)}</td>${fs.sp.bands.map((b) => `<td class="px-2 py-1 text-right">${b.req >= 1 ? r1(b.tg) : '—'}</td>`).join('')}
                  <td class="px-2 py-1 text-right">${r1(fs.sp.pp)}</td>${fs.sp.bands.map((b) => `<td class="px-2 py-1 text-right">${b.req >= 1 ? r1(b.pp) : '—'}</td>`).join('')}
                  <td class="px-2 py-1 text-right text-gray-400">${fmtN(Math.round(fs.sp.req))} <span class="text-gray-600">(${fs.sp.bands.map((b) => fmtN(Math.round(b.req))).join(' · ')}) · ${fs.sp.tasks} tasks</span></td></tr></tbody></table></div>
              <div class="text-[10.5px] text-gray-500 mt-1">Of its ${fs.of} speed config${fs.of === 1 ? '' : 's'} in codebench runs: the one that would do its own work (prompt tokens read and tokens generated at each depth) in the least model time at its measured rates, with at least ${SPEED_MIN_REQ} requests. Generation (tg) and prompt (pp) t/s, token-weighted, by context depth; from the request log, or a Strata engine's own log.</div>
            </div>`;
        body.innerHTML = `
          <div class="space-y-3">
            ${fsCard}
            <div class="card !p-4">
              <div class="text-[13.5px] font-semibold text-gray-100 mb-1">Prefill t/s vs prompt tokens</div>
              <div class="text-[10px] text-gray-500 mb-2">Requests with ≤64 prompt tokens are prompt-cache hits and are excluded — their "prompt t/s" is per-request overhead, not a prefill rate. llama-bench points are measured at an explicit depth.</div>
              <div class="w-full max-w-[760px] mx-auto aspect-square max-h-[380px]"><canvas id="md-curve"></canvas></div>
            </div>
            <div class="card !p-4">
              <div class="text-[13.5px] font-semibold text-gray-100 mb-2">Generation t/s by config <span class="text-gray-600 font-normal">(top 12 by sample count)</span></div>
              <div class="mx-auto w-full" style="height:${Math.max(160, Math.min(12, d.byConfig.length) * 26 + 40)}px;max-width:${2 * Math.max(160, Math.min(12, d.byConfig.length) * 26 + 40)}px"><canvas id="md-gen"></canvas></div>
            </div>
            <div class="card !p-4">
              <div class="text-[13.5px] font-semibold text-gray-100 mb-2">Every config tried</div>
              <div id="md-speed-board"></div>
            </div>
          </div>`;
        modelPrefillCurve('md-curve', d.curve.fromRequests, d.curve.fromBench);
        const gc = d.byConfig.filter((c) => c.genTps.median != null).slice(0, 12)
            .map((c) => ({ label: c.configKey.length > 64 ? c.configKey.slice(0, 63) + '…' : c.configKey, gen: c.genTps.median, n: c.genTps.n }));
        if (gc.length) genByConfig('md-gen', gc);
        const board = createLeaderboard(body.querySelector('#md-speed-board'), {
            id: 'model-speed', columns: SPEED_COLUMNS, defaultSort: 'wall',
            note: 'Sorted by <b>wall clock</b>: generation t/s alone ranks the wrong config when the workload is prefill-heavy, and this model\'s agent workload is. '
                + 'Prefill and generation stay separate columns. KV type is part of the row — it does not transfer between models. '
                + 'A ± appears only where the samples are REPEATS of one measurement (sweep reps); rows built from logged requests show a quartile band on hover instead, because their variation is workload variation, not measurement noise. '
                + 'Prompt-cache hits (≤64 prompt tokens) are excluded from prefill.',
            emptyText: 'No configs recorded for this model yet.',
        });
        board.setRows(d.byConfig.map((c) => ({
            key: c.id || c.configKey,
            label: [c.buildId ? `build ${c.buildId}` : c.build, c.devices].filter(Boolean).join(' · ') || c.configKey,
            sublabel: c.configKey, sublabelFull: c.id || c.configKey,
            badges: (c.sources || []).map((s) => `<span class="ml-1 px-1 py-0.5 rounded bg-gray-800 text-gray-400 text-[9px]">${esc(s)}</span>`).join('')
                + (fs && fs.configKey && c.configKey === fs.configKey ? '<span class="ml-1 px-1 py-0.5 rounded bg-emerald-900/50 text-emerald-200 text-[9px]" title="the launch of its fastest speed config (the card above)">★ fastest</span>' : ''),
            metrics: {
                wall: { v: c.wall_s.median, n: c.wall_s.n, spread: c.wall_s.spread, note: bandNote(c.wall_s, c.repeats, fmtDur) },
                prefillTps: { v: c.prefillTps.median, n: c.prefillTps.n, spread: c.prefillTps.spread, note: bandNote(c.prefillTps, c.repeats, t1) },
                genTps: { v: c.genTps.median, n: c.genTps.n, spread: c.genTps.spread, note: bandNote(c.genTps, c.repeats, t1) },
                ctx: c.ctx,
                residency: c.residency ? { v: c.residency.label, sort: c.residency.rank, note: c.ot ? `-ot ${c.ot}` : (c.residency.devices ? `-dev ${c.residency.devices}` : null) } : null,
                kv: c.kvK ? `${c.kvK}${c.kvV && c.kvV !== c.kvK ? '/' + c.kvV : ''}` : null,
                draftAcceptRate: { v: c.draftAcceptRate.median, n: c.draftAcceptRate.n },
            },
            n: c.n,
            warnings: (c.prefillTps.n === 0 ? ['no cold-prefill sample: every request on this config was a prompt-cache hit'] : [])
                .concat(c.residency && c.residency.cpuOffload ? ['weights are partly on the host — measured elsewhere at roughly half the generation rate and a third of the prefill of a fully resident config'] : [])
                .concat(c.reliability || []),
        })));
    }

    // ---------------------------------------------------------------- Quality
    function paintQuality() {
        const q = m.quality || {};
        const det = m.qualityDetail || { samples: [] };
        if (!q.attempted) { body.innerHTML = '<div class="text-xs text-gray-600 py-6 text-center">No codebench results for this model.</div>'; return; }
        const tiers = Object.entries(q.byTier || {}).sort((a, b) => a[0].localeCompare(b[0]));
        // The model's other quants / efforts ride along (ctx.family), so this lists every config
        // of the MODEL. The overview boards show one of these per board; this is all of them.
        const family = (ctx.family && ctx.family.length) ? ctx.family : [m];
        // Finest-grain configs of these weights; the chips choose which facets separate them.
        const entries = [];
        for (const fm of family) {
            const src = fm.key === m.key ? m : fm;
            for (const c of (src.configs || [])) if (c.agg && c.agg.attempted) entries.push({ m: src, c });
        }
        let keep = FACET_DEFAULTS.full;
        const buildRows = () => {
            const groups = groupConfigs(entries, keep);
            // Solve time is relative to every OTHER run of these weights here; the overview board
            // compares against every model.
            const rel = relSolveTimes(groups);
            return groups.map((g) => {
                const { q, metrics } = groupMetrics(g, rel);
                // strength from the overview's fit (ctx.strengthByDir); a row merging configs the overview keeps apart shows the
                // part bestConfigOf picks (strengthForDirs, the one rule, 2026-10-21)
                const sf = ctx.strengthByDir && strengthForDirs(ctx.strengthByDir, g.dirs || []), sb = sf ? sf.a : null;
                metrics.adjSolveRate = strengthMetric(sb, q);
                const merged = g.members.length > 1
                    ? ` · ${g.members.length} configs merged${g.varies.length ? ` (differ in ${g.varies.map((v) => (FACETS.find((f) => f.id === v) || {}).label || v).join(', ')})` : ''}` : '';
                return {
                    key: g.key, modelKey: g.m.key,
                    label: configText(g.m, g.c) + merged + (g.m.key === m.key && family.length > 1 ? '  ◂ this entry' : ''),
                    sublabel: g.dirs.join(', '),
                    sublabelFull: g.members.map((e) => configText(e.m, e.c, true)).join('\n') + ' — batteries: ' + g.dirs.join(', '),
                    metrics, n: q.scored, coverage: { attempted: q.counted ?? q.attempted, total: m.taskTotal },
                    tasks: g.tasks, warnings: [],
                };
            });
        };
        const familyRows = buildRows();
        const card = (label, value, sub, title) => `
            <div class="card !p-4" ${title ? `title="${esc(title)}"` : ''}>
                <div class="text-[10px] uppercase tracking-wider text-gray-500">${esc(label)}</div>
                <div class="text-lg font-semibold text-gray-100 font-mono">${value}</div>
                <div class="text-[10px] text-gray-500">${sub}</div>
            </div>`;
        body.innerHTML = `
          <div class="space-y-3">
            <div class="card !p-4">
              <div class="text-[13.5px] font-semibold text-gray-100 mb-1">Every config this model has run
                <span class="text-gray-600 font-normal">(${familyRows.length} distinct config${familyRows.length === 1 ? '' : 's'}${family.length > 1 ? ` across ${family.length} effort / scaffold settings` : ''} — batteries share a row only on a perfect config match; click a column to rank by it)</span></div>
              <div id="md-config-facets" class="mb-1"></div>
              <div id="md-config-board"></div>
            </div>
            <div class="text-[10px] text-gray-500">Everything below is <b>${esc(m.display)}</b> only, with all of its configs rolled together.</div>
            <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
              ${card('solve rate', pct(q.solveRate), `${q.solved}/${q.scored} scored`, 'solved ÷ scored. Excluded statuses are not in the denominator.')}
              ${card('excluded', String(q.excluded), 'OVERFLOW / KILLED / PROVIDER_ERROR / ABORTED', 'Not model answers — never counted as failures.')}
              ${card('assertions', q.assertions ? `${q.assertions.passed}/${q.assertions.total}` : '—', q.assertions ? `over ${q.assertions.tasks} task(s) that carry the field` : 'no result carries the field yet')}
              ${card('coverage', `${q.counted ?? q.attempted}/${m.taskTotal ?? '?'}`, 'tasks attempted, one sample per task', 'sample_group siblings are folded to one sample, so this is samples, not files.')}
              ${card('tok / solve', q.tokensPerSolve ? fmtN(Math.round(q.tokensPerSolve.mean)) : '—', q.tokensPerSolve ? `median ${fmtN(Math.round(q.tokensPerSolve.median))} · n=${q.tokensPerSolve.n}` : '')}
              ${card('wall / solve', q.wallPerSolve ? fmtDur(q.wallPerSolve.mean) : '—', q.wallPerSolve ? `median ${fmtDur(q.wallPerSolve.median)} · n=${q.wallPerSolve.n}` : '')}
              ${card('tools / solve', q.toolCallsPerSolve ? t1(q.toolCallsPerSolve.mean) : '—', q.toolCallsPerSolve ? `median ${t1(q.toolCallsPerSolve.median)}` : '')}
              ${card('scored wall clock', q.wallTotal_s ? fmtDur(q.wallTotal_s) : '—', 'time spent across every scored task', 'Per-config relative solve time is in the table above; a solves-per-hour figure cannot say solves of what.')}
            </div>

            ${diagnosticsCard(m, ctx)}

            <div class="card !p-4">
              <div class="text-[13.5px] font-semibold text-gray-100 mb-2">Status mix</div>
              <div class="flex flex-wrap gap-2 text-[11px]">
                ${Object.entries(q.counts || {}).filter(([, n]) => n).map(([s, n]) => `${statusChip(s)}<span class="text-gray-400 mr-2">${Math.round(n * 100) / 100}</span>`).join('') || '<span class="text-gray-600">—</span>'}
              </div>
            </div>

            <div class="card !p-4">
              <div class="text-[13.5px] font-semibold text-gray-100 mb-2">Solve rate by tier</div>
              <table class="w-full text-[11px]"><thead><tr class="text-gray-500 border-b border-gray-800">
                <th class="text-left px-2 py-1 font-medium">tier</th><th class="text-right px-2 py-1 font-medium">solved</th>
                <th class="text-right px-2 py-1 font-medium">scored</th><th class="text-right px-2 py-1 font-medium">excluded</th>
                <th class="text-right px-2 py-1 font-medium">rate</th></tr></thead>
                <tbody class="text-gray-300">${tiers.map(([t, v]) => `<tr class="border-b border-gray-800/50">
                  <td class="px-2 py-1 font-mono">${esc(t)}</td><td class="px-2 py-1 text-right font-mono">${Math.round(v.solved * 100) / 100}</td>
                  <td class="px-2 py-1 text-right font-mono">${v.scored}</td><td class="px-2 py-1 text-right font-mono text-gray-500">${v.excluded}</td>
                  <td class="px-2 py-1 text-right font-mono">${v.scored ? pct(v.solved / v.scored) : '—'}</td></tr>`).join('')}</tbody></table>
              <div class="text-[10px] text-gray-600 mt-1">Tier comes from each task's <code>tier_predicted</code> in <code>tasks/&lt;repo&gt;/&lt;id&gt;/task.yaml</code>; "untiered" means the task file carries none.</div>
            </div>

            <div class="card !p-4">
              <div class="text-[13.5px] font-semibold text-gray-100 mb-2">Batteries <span class="text-gray-600 font-normal">(click to open in the Benchmarks tab)</span></div>
              <table class="w-full text-[11px]"><thead><tr class="text-gray-500 border-b border-gray-800">
                <th class="text-left px-2 py-1 font-medium">dir</th><th class="text-left px-2 py-1 font-medium">config</th>
                <th class="text-right px-2 py-1 font-medium">solved</th><th class="text-right px-2 py-1 font-medium">scored</th>
                <th class="text-right px-2 py-1 font-medium">excl</th><th class="text-right px-2 py-1 font-medium">assertions</th>
                <th class="text-left px-2 py-1 font-medium">identified by</th></tr></thead>
                <tbody class="text-gray-300">${(m.batteries || []).map((b) => `
                  <tr class="border-b border-gray-800/50 hover:bg-gray-800/40 cursor-pointer" data-bat="${esc(b.dir)}">
                    <td class="px-2 py-1 font-mono text-indigo-300">${esc(b.dir)}${b.invalid ? ' <span class="px-1 rounded bg-red-900/60 text-red-200 text-[9px]">INVALID — excluded from every aggregate</span>' : ''}</td>
                    <td class="px-2 py-1 text-gray-400">${[harnessLabel(b.runner, b.scaffold), b.effort && 'effort ' + b.effort, scaffoldBit(b.runner, b.scaffold), ctxText(b, 'row'), b.devices].filter(Boolean).map(esc).join(' · ')}</td>
                    <td class="px-2 py-1 text-right font-mono">${b.solved ?? '—'}</td>
                    <td class="px-2 py-1 text-right font-mono">${b.scored ?? '—'}</td>
                    <td class="px-2 py-1 text-right font-mono text-gray-500">${b.excluded ?? '—'}</td>
                    <td class="px-2 py-1 text-right font-mono ${xyClass(b.assertions)}">${xy(b.assertions)}</td>
                    <td class="px-2 py-1 text-[10px] text-gray-500" title="${esc(VIA_LABEL[b.via] || b.via)}">${esc(b.via)}${b.note ? ' ⚠' : ''}</td>
                  </tr>`).join('')}</tbody></table>
            </div>

            <div class="card !p-4">
              <div class="text-[13.5px] font-semibold text-gray-100 mb-2">Per-task report card <span class="text-gray-600 font-normal">(one sample per task, counted fractionally across its runs; sample_group siblings folded. Click a task name for its page, the rest of the row for the battery)</span></div>
              <div class="overflow-x-auto"><table class="w-full text-[11px]"><thead><tr class="text-gray-500 border-b border-gray-800">
                <th class="text-left px-2 py-1 font-medium">task</th><th class="text-left px-2 py-1 font-medium">tier</th>
                <th class="text-left px-2 py-1 font-medium">status</th><th class="text-right px-2 py-1 font-medium">assertions</th>
                <th class="text-right px-2 py-1 font-medium">tok out</th><th class="text-right px-2 py-1 font-medium">tools</th>
                <th class="text-right px-2 py-1 font-medium">wall</th><th class="text-left px-2 py-1 font-medium">battery</th></tr></thead>
                <tbody class="text-gray-300">${det.samples.map((s) => `
                  <tr class="border-b border-gray-800/50 hover:bg-gray-800/40 cursor-pointer" data-bat="${esc(s.dir)}" data-task="${esc(s.base_task || s.task)}">
                    <td class="px-2 py-1 font-mono">${ctx.openTask ? `<button type="button" data-open-task="${esc(s.task)}" class="text-left font-mono text-indigo-300 underline" title="this task's page: every model that ran it">${esc(s.task)}</button>` : esc(s.task)}${s.folded && s.folded.length ? `<span class="ml-1 px-1 rounded bg-indigo-900/50 text-indigo-200 text-[9px]" title="folded with ${esc(s.folded.join(', '))} — same bug, counted once (sample_group ${esc(s.sample_group)})">+${s.folded.length} folded</span>` : ''}</td>
                    <td class="px-2 py-1 font-mono text-gray-500">${esc(s.tier || '—')}</td>
                    <td class="px-2 py-1">${statusChip(s.status, s.status_derived)}${answeredChip(s.answered)}${overflowChip(s.overflowed)}</td>
                    <td class="px-2 py-1 text-right font-mono ${xyClass(s.assertions)}">${xy(s.assertions)}</td>
                    <td class="px-2 py-1 text-right font-mono">${s.tokens_out == null ? '—' : fmtN(s.tokens_out)}</td>
                    <td class="px-2 py-1 text-right font-mono">${s.tool_calls ?? '—'}</td>
                    <td class="px-2 py-1 text-right font-mono">${fmtDur(s.wall_s)}</td>
                    <td class="px-2 py-1 font-mono text-[10px] text-indigo-300">${esc(s.dir)}</td>
                  </tr>`).join('')}${(det.unfinishedRuns || []).map((u) => `
                  <tr class="border-b border-gray-800/50 hover:bg-gray-800/40 cursor-pointer" data-bat="${esc(u.dir)}" data-task="${esc(String(u.file || '').replace(/\.json$/, ''))}">
                    <td class="px-2 py-1 font-mono">${esc(u.task)}</td><td class="px-2 py-1 font-mono text-gray-500">—</td>
                    <td class="px-2 py-1">${unfinishedChip(u)}</td>
                    <td class="px-2 py-1 text-[10px] text-gray-500" colspan="4">stopped to ask a question; not counted until it is answered with the original prompt</td>
                    <td class="px-2 py-1 font-mono text-[10px] text-indigo-300">${esc(u.dir)}</td>
                  </tr>`).join('')}</tbody></table></div>
            </div>
          </div>`;
        const cfgBoard = createLeaderboard(body.querySelector('#md-config-board'), {
            id: 'model-configs', columns: [ADJ_COLUMN, ...QUALITY_COLUMNS,
                { id: 'relSolveTime', label: 'rel. time', kind: 'num', dir: 'asc', title: 'relative solve time: a joint fit of wall time over every config and task (the length of each task factored out), so 2× = twice as long as a typical config on the same task; only tasks at least two configs solved count' }],
            defaultSort: 'adjSolveRate', commonTasks: true,
            note: 'By default one row per distinct config: every recorded parameter — harness, context, sampling, KV, MTP/draft, GPU placement, build and machine. Runs merge only on a perfect match. Switch a facet off above to merge runs that differ only there. Hover a row for the full config. Sort by any column to see the best config on that dimension' + (family.length > 1 ? '; ◂ marks this entry, click another row to open it.' : '.'),
            onRow: (r) => { if (ctx.openModel) ctx.openModel(r.modelKey); },
            emptyText: 'No codebench configs recorded.',
        });
        cfgBoard.setRows(familyRows);
        keep = facetBar(body.querySelector('#md-config-facets'), 'model-detail', FACET_DEFAULTS.full, (k) => { keep = k; cfgBoard.setRows(buildRows()); });
        if (keep.length !== FACET_DEFAULTS.full.length) cfgBoard.setRows(buildRows());
        body.querySelectorAll('[data-bat]').forEach((el) => el.addEventListener('click', () => ctx.openBattery(el.dataset.bat, el.dataset.task || null)));
        // a task NAME opens the task's page; the rest of its row still opens the battery
        body.querySelectorAll('[data-open-task]').forEach((el) => el.addEventListener('click', (e) => { e.stopPropagation(); ctx.openTask(el.dataset.openTask); }));
    }

    // ---------------------------------------------------------------- History
    function paintHistory() {
        const h = m.history || { series: [], total: 0 };
        if (!h.total) { body.innerHTML = '<div class="text-xs text-gray-600 py-6 text-center">No logged requests for this model.</div>'; return; }
        const first = h.series.find((p) => p.t), last = [...h.series].reverse().find((p) => p.t);
        body.innerHTML = `
          <div class="space-y-3">
            <div class="text-[11px] text-gray-400">${fmtN(h.total)} completed requests${first && last ? ` · ${new Date(first.t).toLocaleString()} → ${new Date(last.t).toLocaleString()}` : ''} · from <code>logs/benchmarks.csv</code></div>
            <div class="card !p-4">
              <div class="text-[13.5px] font-semibold text-gray-100 mb-1">Prefill t/s over time</div>
              <div class="w-full max-w-[760px] mx-auto aspect-square max-h-[380px]"><canvas id="md-hist-pp"></canvas></div>
            </div>
            <div class="card !p-4">
              <div class="text-[13.5px] font-semibold text-gray-100 mb-1">Generation t/s over time</div>
              <div class="text-[10px] text-gray-500 mb-1">Separate charts on purpose: prefill and generation are different measures and must never share a y-axis.</div>
              <div class="w-full max-w-[760px] mx-auto aspect-square max-h-[380px]"><canvas id="md-hist-tg"></canvas></div>
            </div>
          </div>`;
        ratesOverTime('md-hist-pp', 'md-hist-tg', h.series.filter((p) => p.t));
    }

    // ---------------------------------------------------------------- Tunings
    function paintTunings() {
        const t = m.tunings || { missing: true };
        if (t.missing) {
            body.innerHTML = `<div class="text-xs text-gray-400 card !p-4">
                No entry for this model in <code>${esc(t.file || 'BEST-CONFIGS.md')}</code>. Sections that do exist:
                <span class="text-gray-500">${(t.available || []).map(esc).join(' · ') || '—'}</span></div>`;
            return;
        }
        const blockHtml = (b, cls, label) => `
            <div class="mt-2">
              <div class="text-[10px] uppercase tracking-wider ${cls} mb-1">${label}</div>
              <pre class="text-[11px] font-mono text-gray-300 bg-gray-900 border border-gray-800 rounded p-2 whitespace-pre-wrap">${esc(b.flags)}</pre>
              <div class="text-[10px] text-gray-500 mt-1">${[
                  b.parsed.devices && `devices ${b.parsed.devices}`, b.parsed.ts && `-ts ${b.parsed.ts}`,
                  b.parsed.ctx && `${ctxLabel(b.parsed.ctx)} ctx`, b.parsed.kvK && `KV ${b.parsed.kvK}${b.parsed.kvV && b.parsed.kvV !== b.parsed.kvK ? '/' + b.parsed.kvV : ''}`,
                  b.parsed.ncmoe != null && `-ncmoe ${b.parsed.ncmoe}`, b.parsed.specType && `${b.parsed.specType}${b.parsed.specDraftN != null ? ' n' + b.parsed.specDraftN : ''}`,
              ].filter(Boolean).map(esc).join(' · ')}</div>
            </div>`;
        body.innerHTML = `
          <div class="space-y-3">
            <div class="bg-gray-950 border ${t.provisional ? 'border-amber-800/60' : 'border-gray-800'} rounded-lg p-3">
              <div class="flex items-center gap-2">
                <div class="text-[11px] font-semibold text-gray-200">${esc(t.title)}</div>
                ${t.provisional
                    ? '<span class="px-1.5 py-0.5 rounded bg-amber-900/60 text-amber-200 text-[10px] font-semibold">NOT YET TUNED — provisional</span>'
                    : '<span class="px-1.5 py-0.5 rounded bg-green-900/50 text-green-200 text-[10px]">measured</span>'}
              </div>
              ${t.provisional ? `<div class="text-[11px] text-amber-200/90 mt-1">Nothing has been measured for this entry. The flags below are a documented starting point, not a recommendation — a guess shown with the weight of a measurement is how a guess becomes folklore.</div>` : ''}
              ${t.build ? `<div class="text-[10px] text-gray-400 mt-1">Build: <span class="font-mono">${esc(t.build)}</span></div>` : ''}
              ${(t.constraints || []).length ? `<div class="mt-2">
                  <div class="text-[10px] uppercase tracking-wider text-red-300 mb-1">Constraints — why this config is what it is</div>
                  <ul class="text-[11px] text-red-200/90 space-y-1 list-disc pl-4">${t.constraints.map((c) => `<li>${esc(c.replace(/^-\s*/, ''))}</li>`).join('')}</ul>
                  <div class="text-[10px] text-gray-500 mt-1">A KV type that was rejected because it will not fit is a constraint, not a preference — the two look identical in a table and mean opposite things when you are choosing a config.</div>
              </div>` : ''}
              ${t.current ? blockHtml(t.current, t.provisional ? 'text-amber-300' : 'text-green-300', t.provisional ? 'starting point (unmeasured)' : 'current best-known config') : '<div class="text-[11px] text-gray-500 mt-1">No flag block in this entry.</div>'}
              ${t.superseded.length ? `<details class="mt-3"><summary class="cursor-pointer text-[10px] text-gray-500">${t.superseded.length} superseded config${t.superseded.length === 1 ? '' : 's'}${t.supersedeNote ? ' — ' + esc(t.supersedeNote) : ''}</summary>
                 ${t.superseded.map((b) => blockHtml(b, 'text-gray-500', 'superseded')).join('')}</details>` : ''}
            </div>
            ${t.tables.length ? `<div class="card !p-4">
                <div class="text-[13.5px] font-semibold text-gray-100 mb-2">What it bought</div>
                <pre class="text-[10px] font-mono text-gray-400 whitespace-pre overflow-x-auto">${esc(t.tables.join('\n'))}</pre></div>` : ''}
            ${t.notes.length ? `<div class="card !p-4">
                <div class="text-[13.5px] font-semibold text-gray-100 mb-2">Notes from ${esc((t.file || '').split('/').pop())}</div>
                <ul class="text-[11px] text-gray-400 space-y-1 list-disc pl-4">${t.notes.map((n) => `<li>${esc(n.replace(/^-\s*/, ''))}</li>`).join('')}</ul></div>` : ''}
          </div>`;
    }

    // ---------------------------------------------------------------- Sources
    function paintSources() {
        body.innerHTML = `
          <div class="space-y-3">
            <div class="text-[11px] text-gray-400">Every raw identifier that folded into <span class="font-mono text-gray-200">${esc(m.key)}</span>.
              If two different models are listed here, the mapping is wrong: correct it in the
              <code>BATTERY_MODEL</code> / <code>OPENCODE_ALIAS</code> maps at the top of <code>lib/models.js</code>.</div>
            ${m.ambiguous ? `<div class="text-[11px] text-amber-200 bg-amber-900/20 border border-amber-800/40 rounded p-2">⚠ ${esc(m.ambiguousNote || 'an identifier that folded in here has been reused across models')}</div>` : ''}
            ${m.unresolved ? `<div class="text-[11px] text-red-200 bg-red-900/20 border border-red-800/40 rounded p-2">This is a pseudo-model: ${esc(m.why || 'the runs recorded no model')}. Nothing is folded into a real model on a guess.</div>` : ''}
            <table class="w-full text-[11px]"><thead><tr class="text-gray-500 border-b border-gray-800">
              <th class="text-left px-2 py-1 font-medium">where it came from</th><th class="text-left px-2 py-1 font-medium">raw identifier</th>
              <th class="text-left px-2 py-1 font-medium">resolved by</th><th class="text-right px-2 py-1 font-medium">seen</th></tr></thead>
              <tbody class="text-gray-300">${(m.sources || []).map((s) => `<tr class="border-b border-gray-800/50">
                <td class="px-2 py-1 text-gray-400">${esc(s.kind)}${s.dir ? ` <span class="text-[10px] text-gray-600">${esc(s.dir)}</span>` : ''}</td>
                <td class="px-2 py-1 font-mono">${esc(s.raw)}</td>
                <td class="px-2 py-1 text-[10px] ${s.via === 'dir_heuristic' || s.via === 'runner_default' ? 'text-amber-300' : 'text-gray-500'}" title="${esc(VIA_LABEL[s.via] || s.via)}">${esc(s.via)}</td>
                <td class="px-2 py-1 text-right font-mono text-gray-500">${s.count}</td></tr>
                ${s.note ? `<tr><td colspan="4" class="px-2 pb-1 text-[10px] text-amber-300/80">⚠ ${esc(s.note)}</td></tr>` : ''}`).join('')}</tbody></table>
          </div>`;
    }

    setView(view);
}
