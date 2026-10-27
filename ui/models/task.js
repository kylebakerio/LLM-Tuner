// A single codebench TASK's page: what the task is, how hard the overview's fit says it is, and
// every model / config that ran it. Opened from a task-grid cell or a task name on a model page.
//
// Top: a plain-language summary, then the same task context the Bench transcript view shows
// (renderTaskPanel in page mode, from GET /api/codebench/task?id= = `run.py --show <id> --json`):
// the prompt, what it tests, the hidden tests' case titles (the goals), how weak models fail it.
// Where results recorded per-case hidden-test outcomes (score.fail_to_pass.cases, since
// 2026-09-25; GET /api/codebench/cases?task=), a goals x runs matrix says which goals each model
// passed. The reference fix is never fetched or shown: it is the answer itself.
import { esc, fmtDur, fmtN, statusChip, answeredChip, overflowChip, unfinishedChip, api, harnessLabel, scaffoldBit } from '../benchmarks/util.js';
import { renderTaskPanel, matchCase } from '../benchmarks/transcript.js';
import { createLeaderboard, weightsOf, configText, ctxText, showPopover, problemOf, LEVEL_MIN_CONFIGS, DIFFICULTY_BANDS, difficultyBand } from '../shared/leaderboard.js';
import { costPerSolve } from './charts.js';

/**
 * Where a task sits on the fit's difficulty scale: {d, rank (1 = hardest), of, tied, text}; null if
 * no scored run (such a task cannot be placed). Tasks with the same record (say, run by one config
 * only, all passed) get the same difficulty, so ranks are shared ("competition" ranking) and the tie
 * is said out loud. text reads from the nearer end: "hardest 12 of 101", "easiest 3 of 101".
 */
export function difficultyRank(td, id) {
    if (!td || !td.has(id)) return null;
    const d = td.get(id), all = [...td.values()], EPS = 1e-4;
    const harder = all.filter((x) => x > d + EPS).length, easier = all.filter((x) => x < d - EPS).length;
    const of = all.length, tied = of - harder - easier - 1;
    const end = harder <= easier ? `hardest ${harder + 1} of ${of}` : `easiest ${easier + 1} of ${of}`;
    return { d, rank: harder + 1, of, tied, text: end + (tied ? ` (tied with ${tied})` : '') };
}

// One config's outcome on the task, folded across its runs the way the grid colours it:
// credit 1 = pass (pass* when solved at the cap), between 0 and 1 = passed on some runs,
// 0 = fail / TIMEOUT, no scored run = excluded (the status says why).
function outcome(t) {
    if (t.unfinishedOnly) return { word: 'unfinished', chip: 'unfinished', order: 3, unfinished: true };
    if (t.excluded || t.credit == null) return { word: 'excluded', chip: t.status || 'excluded', order: 3 };
    if (t.credit >= 1) return { word: t.status === 'pass*' ? 'pass*' : 'pass', chip: t.status === 'pass*' ? 'pass*' : 'pass', order: 0 };
    if (t.credit > 0) return { word: `pass ${t.passes} of ${t.attempts}`, chip: 'pass', order: 1, partial: true };
    return { word: t.status === 'TIMEOUT' ? 'TIMEOUT' : 'fail', chip: t.status === 'TIMEOUT' ? 'TIMEOUT' : 'fail', order: 2 };
}

// the status chip, except a task passed on only some runs says so ("pass 1/2", amber); + the dark-green "asked" chip
// when a run of it ended asking the user something the prompt already answers, and the dark-green "overflow" chip when a
// passing run of it outgrew the context window and carried on (display only)
const resultChip = (o, t) => (o.unfinished ? unfinishedChip(t.unfinished) : o.partial
    ? `<span class="inline-block px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold bg-yellow-900/40 text-amber-300" title="passed ${t.passes} of ${t.attempts} scored runs">pass ${t.passes}/${t.attempts}</span>`
    : statusChip(o.chip)) + (o.unfinished ? '' : answeredChip(t && t.answered) + overflowChip(t && t.overflowed, t && t.passes) + unfinishedChip(t && t.unfinished));
const card = (label, value, sub, title) => `
    <div class="card !p-4" ${title ? `title="${esc(title)}"` : ''}>
        <div class="text-[10px] uppercase tracking-wider text-gray-500">${esc(label)}</div>
        <div class="text-lg font-semibold text-gray-100 font-mono">${value}</div>
        <div class="text-[10px] text-gray-500">${sub}</div>
    </div>`;
// The difficulty card (Kyle 2026-10-24): the /100 difficulty (leaderboard.js taskDifficulty100: the strength at which a
// config has a 50/50 chance on it), its band word, a bar of the four bands with the task marked on it, and the strength
// points it is worth. The fit's log-odds value stays in the tooltip. Colours are inline: the vendored Tailwind build
// only has the classes it was built with.
export function difficultyCard(dr, d100, points, { diagnostic = false, unscored = false } = {}) {
    if (!dr || d100 == null) {
        return card('difficulty', '—', diagnostic ? 'diagnostic task — not in the fit' : 'no scored run yet — no difficulty',
            'Tasks nobody has scored cannot be placed on the difficulty scale.');
    }
    const band = difficultyBand(d100), at = Math.max(0, Math.min(100, d100));
    let from = 0;
    const segs = DIFFICULTY_BANDS.map((b) => {
        const to = Math.min(100, b.below), wd = to - from; from = to;
        return `<div style="width:${wd}%;background:${b.color};opacity:${b === band ? 0.9 : 0.35}"></div>`;
    }).join('');
    const ptsText = unscored ? 'not scored yet: 0 points' : `worth <b class="text-gray-300">${points != null ? points.toFixed(2) : '—'}</b> of 100 points`;
    const title = `Difficulty /100: the strength score at which a config has a 50/50 chance of solving this task, on the same scale as model strength (a config at ${Math.round(d100)} solves it about half the time; stronger ones more often). `
        + 'Bands: easy under 20, medium 20-40, hard 40-60, very hard 60 and up. '
        + 'Points: this task\'s share of the 100 strength points (the chance a typical config fails it); a config earns them in proportion to its fitted chance of solving it. '
        + `The fit's log-odds difficulty: ${dr.d >= 0 ? '+' : ''}${dr.d.toFixed(2)} (0 = an average task). Tasks with the same record get the same difficulty and share a rank.`;
    return `
    <div class="card !p-4" title="${esc(title)}" data-difficulty="${d100.toFixed(1)}">
        <div class="text-[10px] uppercase tracking-wider text-gray-500">difficulty</div>
        <div style="display:flex;align-items:baseline;gap:6px">
            <span class="text-lg font-semibold text-gray-100 font-mono">${Math.round(d100)}</span><span class="text-[10px] text-gray-500">/ 100</span>
            <span class="px-1.5 py-0.5 rounded text-[10px] font-semibold" style="background:${band.color}2e;color:${band.text}">${esc(band.word)}</span>
        </div>
        <div style="position:relative;height:8px;margin:5px 0 4px">
            <div style="display:flex;height:8px;border-radius:9999px;overflow:hidden">${segs}</div>
            <div style="position:absolute;top:-3px;left:calc(${at.toFixed(1)}% - 1.5px);width:3px;height:14px;background:#f9fafb;border-radius:1px;box-shadow:0 0 0 1px rgba(0,0,0,.7)"></div>
        </div>
        <div class="text-[10px] text-gray-500">${ptsText} · ${esc(dr.text)}</div>
    </div>`;
}
// A short config line for a row (the full one is on hover): what separates configs of one model
// on this page, without the launch command that pushed every figure off the right of the table.
const shortCfg = (c) => [harnessLabel(c.runner, c.scaffold), c.effort && `effort ${c.effort}`, scaffoldBit(c.runner, c.scaffold), ctxText(c, 'row'),
    c.mtp ? 'MTP' : null, c.timeout_s && `${Math.round(c.timeout_s / 60)}m cap`].filter(Boolean).join(' · ') || 'config';
const day = (ts) => (ts ? new Date(ts).toISOString().slice(0, 10) : null);
const med = (a) => {
    const n = a.filter((v) => v != null && Number.isFinite(Number(v))).map(Number).sort((x, y) => x - y);
    if (!n.length) return null;
    const m = n.length >> 1;
    return n.length % 2 ? n[m] : (n[m - 1] + n[m]) / 2;
};

// run.py --show and the per-case scan, cached per task for the session (the rows toggle and the
// overview's re-renders call renderTask again); the case scan goes stale after a minute.
const infoCache = new Map(), infoDone = new Map(), casesCache = new Map();
const CASES_TTL = 60 * 1000;
// A level problem (`T@L3`, 2026-10-17) is task T at another prompt: its context (run.py --show) is T's, its per-case
// results its own level's (the server's listTaskCases files them by problem).
async function loadInfo(id) {
    id = problemOf(id).task;
    if (!infoCache.has(id)) infoCache.set(id, api(`/api/codebench/task?id=${encodeURIComponent(id)}`).catch((e) => ({ error: e.message })));
    const j = await infoCache.get(id);
    if (j && j.error) infoCache.delete(id); else infoDone.set(id, j);   // an error is tried again next time
    return j;
}
async function loadCases(id) {
    const hit = casesCache.get(id);
    if (!hit || Date.now() - hit.at > CASES_TTL) casesCache.set(id, { at: Date.now(), p: api(`/api/codebench/cases?task=${encodeURIComponent(id)}`).catch((e) => ({ error: e.message })) });
    return casesCache.get(id).p;
}

// Markdown's first paragraph as one plain sentence or three: no headings, code ticks, links, emphasis.
function plainPara(md, max) {
    const para = String(md || '').replace(/\r/g, '').split(/\n\s*\n/).map((x) => x.trim()).find((x) => x && !/^#+\s/.test(x) && !/^```/.test(x)) || '';
    let t = para.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/\*\*|`/g, '').replace(/^\s*[-*>]\s+/gm, '').replace(/\s+/g, ' ').trim();
    if (t.length > max) t = t.slice(0, t.lastIndexOf(' ', max) > max * 0.6 ? t.lastIndexOf(' ', max) : max).replace(/[,;:.]$/, '') + ' …';
    return t;
}

/**
 * The one-paragraph "what is this task" at the top of the page: the task's own story, else what it
 * probes, else the head of its L2 prompt -- then what passing takes and how weak models miss it.
 * info = run.py --show (may be null while loading); meta = the catalog's public metadata.
 */
export function taskSummary(info, meta) {
    const x = { ...(meta || {}), ...(info || {}) };
    const prompts = x.prompts || {};
    const lead = x.story ? plainPara(x.story, 600) : x.probes ? `It probes ${String(x.probes).trim().replace(/\.$/, '')}.`
        : (prompts.L2 || Object.values(prompts)[0]) ? `The model is told: “${plainPara(prompts.L2 || Object.values(prompts)[0], 420)}”` : '';
    const kind = { fix: 'a bug fix', feature: 'a feature', synthetic: 'a synthetic question', avoid: 'a feature request posed at the commit before a real bug was introduced (it must be built without re-creating that bug)' }[x.variant] || (x.variant ? `a ${x.variant} task` : 'a task');
    const where = x.repo ? ` in ${String(x.repo).split('/').filter(Boolean).pop()}` : '';
    const tier = x.tier || x.tier_predicted;
    const n = x.goal_cases != null ? x.goal_cases : (x.goals || []).reduce((a, g) => a + (g.cases || []).length, 0);
    const pass = !info ? '' : n
        ? ` To pass, ${n} hidden-test case${n === 1 ? '' : 's'} must go green${x.pass_to_pass ? ` while ${x.pass_to_pass} existing test${x.pass_to_pass === 1 ? '' : 's'} keep passing` : ''}.`
        : ' It has no hidden-test cases with titles to list: it is graded on its answer.';
    const weak = x.weak_model_failure ? ` A weak model typically ${String(x.weak_model_failure).trim().replace(/\.$/, '')}.` : '';
    return `${lead}${lead ? ' ' : ''}This is ${kind}${where}${tier ? `, tier ${tier}` : ''}.${pass}${weak}`.trim();
}

// Which goals each run passed: rows = the hidden tests' case titles, columns = the runs that
// recorded per-case results, labelled by the model whose battery it was.
function goalsMatrix(info, results, colLabel) {
    const goals = (info.goals || []).flatMap((g) => g.cases.map((c) => ({ file: g.file, title: c })));
    if (!goals.length || !results.length) return '';
    const MARK = { pass: ['✓', 'text-green-400'], fail: ['✗', 'text-red-400'], skip: ['↓', 'text-gray-500'], unreported: ['?', 'text-gray-500'] };
    const cols = results.map((r) => ({ r, ...colLabel(r), st: goals.map((g) => matchCase(r.cases, g.title)) }));
    const head = cols.map((c) => `<th class="px-1 py-1 font-normal text-left" style="vertical-align:bottom" title="${esc(c.title)}"><button type="button" ${c.modelKey ? `data-open-model="${esc(c.modelKey)}"` : ''} class="block max-w-[220px] truncate text-[10px] text-gray-300 ${c.modelKey ? 'hover:text-indigo-300' : ''}">${esc(c.label)}</button><div class="text-[10px] text-gray-500 font-mono truncate max-w-[220px]">${esc(c.sub)}</div></th>`).join('');
    const body = goals.map((g, i) => `<tr class="border-t border-gray-800/60"><td class="px-1 py-0.5 text-[11px] text-gray-300 min-w-[12rem]">${esc(g.title)}</td>${cols.map((c) => {
        const [ch, cls] = MARK[c.st[i]] || ['·', 'text-gray-600'];
        return `<td class="px-1 py-0.5 text-center ${cls}" title="${esc(c.label)}: ${esc(c.st[i] === 'unreported' ? 'not in the per-case output' : c.st[i])}">${ch}</td>`;
    }).join('')}</tr>`).join('');
    const tot = cols.map((c) => { const p = c.st.filter((x) => x === 'pass').length; return `<td class="px-1 py-0.5 text-center font-mono text-[10px] ${p === goals.length ? 'text-green-400' : 'text-gray-400'}">${p}/${goals.length}</td>`; }).join('');
    return `<div class="overflow-x-auto"><table class="text-xs"><thead><tr><th class="px-1 text-left text-[10px] text-gray-500 font-normal" style="vertical-align:bottom">goal (hidden-test case)</th>${head}</tr></thead>
        <tbody>${body}<tr class="border-t border-gray-800"><td class="px-1 py-0.5 text-[10px] text-gray-500">goals passed</td>${tot}</tr></tbody></table></div>`;
}

/**
 * ctx: { id, catalog, groups (the overview's quality chart groups), adj (their Rasch fit),
 *        rows: 'best' | 'all', setRows(v), highlight(row) (the overview's search term: true for a row of a matching model -- ringed in gold
 *        on the board; the cost bars read the same test through charts.js; nothing is hidden), detailHtml(g, others), openModel(key), openTask(id), onBack() }
 */
// A chart group's result on a DIAGNOSTIC task (2026-10-17): its member configs' `diagnostics` entries, runs summed, the
// latest status. null when none of them ran it.
export function diagnosticOf(g, id) {
    const list = ((g && g.members) || []).map((x) => x && x.c && x.c.diagnostics && x.c.diagnostics[id]).filter(Boolean);
    if (!list.length) return null;
    const latest = list.slice().sort((a, b) => (b.ran_at || 0) - (a.ran_at || 0))[0];
    const attempts = list.reduce((a, t) => a + (t.attempts || 0), 0), passes = list.reduce((a, t) => a + (t.passes || 0), 0);
    const walls = list.map((t) => t.wall_s).filter((w) => w > 0);
    // passing runs that outgrew the context window and carried on (lib/models.js overflowedOfRuns), summed like the runs
    const ovN = list.reduce((a, t) => a + ((t.overflowed && t.overflowed.passed) || 0), 0);
    const out = { ...latest, attempts, passes, credit: attempts ? passes / attempts : null, excluded: !attempts, solved: passes > 0,
        wall_s: walls.length ? walls.reduce((a, w) => a + w, 0) / walls.length : null, diagnostic: true };
    if (ovN > 0) out.overflowed = { passed: ovN }; else delete out.overflowed;
    return out;
}

export function renderTask(root, ctx) {
    const { id, catalog } = ctx;
    const metaAll = catalog.taskMeta || {};
    const meta = metaAll[id] || null;
    // PROMPT LEVELS ARE PROBLEMS (2026-10-17): `T@L3` is task T asked with its L3 prompt, a problem of its own (its own
    // difficulty and results); T's page links its level problems and theirs links T. Never a result of the other level.
    const prob = problemOf(id), level = (meta && meta.level) || prob.level;
    const sameLevel = (t) => ((metaAll[t] && metaAll[t].level) || problemOf(t).level) === level;
    const levelProblems = level === 'L2' ? Object.keys(metaAll).filter((t) => metaAll[t].level && metaAll[t].base === prob.base && !!metaAll[t].bonus === prob.bonus).sort() : [];
    // sample_group siblings are the same bug at two stages and count once: a config's result on
    // this task may be filed under a sibling, so those count here too (and say so). Only at the same prompt level.
    const siblings = meta && meta.sample_group
        ? Object.keys(metaAll).filter((t) => t !== id && metaAll[t].sample_group === meta.sample_group && sameLevel(t)).sort() : [];
    const byW = new Map();
    for (const g of ctx.groups) {
        let t = g.tasks[id], via = null;
        // a diagnostic task is in no group's scored tasks: its results are each config's `diagnostics` (lib/models.js)
        if (!t && meta && meta.diagnostic) t = diagnosticOf(g, id);
        if (!t) for (const s of siblings) if (g.tasks[s]) { t = g.tasks[s]; via = s; break; }
        // UNFINISHED (2026-10-19): a run of it stopped to ask and waits for the answer -- listed, in no count (order 3)
        const u = g.unfinished && g.unfinished[id];
        if (!t && u) t = { status: 'unfinished', excluded: true, credit: null, attempts: 0, passes: 0, unfinishedOnly: true, unfinished: u };
        else if (t && u) t = { ...t, unfinished: u };
        if (!t) continue;
        const w = weightsOf(g.m);
        if (!byW.has(w)) byW.set(w, []);
        byW.get(w).push({ g, t, via, o: outcome(t) });
    }
    // best config per set of weights on THIS task: best outcome, then more credit, then faster
    const better = (a, b) => (a.o.order - b.o.order) || ((b.t.credit ?? -1) - (a.t.credit ?? -1)) || ((a.t.wall_s ?? 1e9) - (b.t.wall_s ?? 1e9));
    for (const list of byW.values()) list.sort(better);
    const all = [...byW.values()].flat();
    const known = !!meta || all.length > 0 || (catalog.allTaskIds || []).includes(id);

    const dr = difficultyRank(ctx.adj && ctx.adj.taskDifficulty, id);
    const scored = all.filter((e) => e.o.order < 3);
    const solvedW = [...byW.values()].filter((l) => l.some((e) => e.o.order < 2)).length;
    const scoredW = [...byW.values()].filter((l) => l.some((e) => e.o.order < 3)).length;
    const runs = scored.reduce((a, e) => a + (e.t.attempts || 0), 0);
    const passes = scored.reduce((a, e) => a + (e.t.passes || 0), 0);
    const solvers = scored.filter((e) => e.o.order < 2);
    const wallMed = med(solvers.map((e) => e.t.wall_s)), tokMed = med(solvers.map((e) => (e.t.tokens_out > 0 ? e.t.tokens_out : null)));
    const fastest = solvers.filter((e) => e.t.wall_s > 0).sort((a, b) => a.t.wall_s - b.t.wall_s)[0];

    const chip = (text, cls) => `<span class="px-1.5 py-0.5 rounded text-[10px] ${cls}">${esc(text)}</span>`;
    const tags = meta ? [
        level !== 'L2' && chip('prompt ' + level, 'bg-sky-900/50 text-sky-200 font-semibold'),
        meta.unscored && chip(`not scored yet: ${meta.scoredConfigs || 0} of ${catalog.levelMinConfigs || LEVEL_MIN_CONFIGS} configs`, 'bg-gray-800 text-amber-300'),
        meta.bonus && chip('bonus test', 'bg-emerald-900/40 text-emerald-200'),
        meta.variant && chip(meta.variant, meta.variant === 'avoid' ? 'bg-yellow-900/40 text-amber-300' : meta.variant === 'synthetic' ? 'bg-gray-800 text-gray-300' : 'bg-indigo-600/20 text-indigo-300'),
        meta.tier && chip('tier ' + meta.tier, 'bg-gray-800 text-gray-200 font-semibold'),
        ...(meta.category || []).filter((c) => !/^tier-/.test(c)).map((c) => chip(c, 'bg-gray-800 text-gray-400')),
    ].filter(Boolean).join(' ') : '';
    const field = (label, text) => (text ? `<div><div class="text-[10px] uppercase tracking-wider text-gray-500">${label}</div><div class="text-[11px] text-gray-300 whitespace-pre-wrap">${esc(text)}</div></div>` : '');
    const infoNow = infoDone.get(prob.task) || null;   // null until run.py --show has answered once (T's, for `T@L3`)
    const toggle = (val) => `px-1.5 rounded border ${val === ctx.rows ? 'border-indigo-500 text-indigo-200' : 'border-gray-700 text-gray-500'}`;

    root.innerHTML = `
      <div class="space-y-3 max-w-[1100px] mx-auto">
        <div class="flex flex-wrap items-center gap-2">
          <button type="button" id="mt-back" class="btn btn-ghost btn-sm -ml-2">← Results</button>
          <div class="min-w-0">
            <div class="text-[17px] font-semibold text-white font-mono break-all">${esc(level !== 'L2' ? prob.task : id)}${level !== 'L2' ? ` <span class="text-sky-300">· prompt ${esc(level)}</span>` : ''}</div>
            <div class="text-[10px] text-gray-500 font-mono">codebench task${meta && meta.repo ? ' · ' + esc(meta.repo) : ''}${meta && meta.incident_date ? ' · incident ' + esc(meta.incident_date) : ''}${meta && meta.timeout_s ? ' · ' + fmtDur(meta.timeout_s) + ' cap' : ''}</div>
          </div>
          <div class="flex flex-wrap gap-1">${tags}</div>
        </div>
        ${meta && meta.diagnostic ? `<div class="text-[11px] text-amber-300 bg-yellow-900/20 border border-yellow-800/40 rounded p-2">A diagnostic task: a functional check, like a speed test, not a quality task. Its results are shown here and on each model's page, and are left out of the solve rate, coverage, strength fit, task points and the Auto queue planner. A fail is not a failed task.</div>` : ''}
        ${level !== 'L2' ? `<div class="text-[11px] text-sky-200/90 bg-sky-900/20 border border-sky-800/40 rounded p-2">Task <button type="button" data-open-task="${esc(prob.task)}" class="font-mono text-indigo-300 underline">${esc(prob.task)}</button> asked with its prompt ${esc(level)} instead of the default L2 prompt: a problem of its own (<span class="font-mono">${esc(id)}</span>), with its own difficulty, strength points and results. The task's L2 results are on its own page and never count here.${meta && meta.unscored ? ` <b>Not scored yet:</b> ${esc(String(meta.scoredConfigs || 0))} of the ${esc(String(catalog.levelMinConfigs || LEVEL_MIN_CONFIGS))} config rows a prompt-level problem needs before it earns strength points have a scored result on it, so it is not in the strength points, the coverage or the problem total; its results are shown, and its difficulty is estimated from them alone.` : ''}</div>` : ''}
        ${levelProblems.length ? `<div class="text-[11px] text-gray-400">Also run at another prompt level, as a problem of its own: ${levelProblems.map((t) => `<button type="button" data-open-task="${esc(t)}" class="font-mono text-indigo-300 underline">${esc(t)}</button>`).join(', ')}. Those results are not counted on this page.</div>` : ''}
        ${meta && meta.bonus ? `<div class="text-[11px] text-gray-400">The bonus test of <button type="button" data-open-task="${esc(meta.parent)}" class="font-mono text-indigo-300 underline">${esc(meta.parent)}</button>: its own result, graded from the same run (the run's time and tokens are counted once, on the parent). It never changes the parent's pass or fail.${meta.bonus_note ? ` What it checks: ${esc(meta.bonus_note)}.` : ''}</div>` : ''}
        ${!known ? `<div class="text-xs text-red-200 bg-red-900/25 border border-red-800/50 rounded p-3">No codebench task is called <span class="font-mono">${esc(id)}</span>.</div>` : ''}
        ${meta && meta.sample_group ? `<div class="text-[10px] text-gray-400">sample_group <span class="font-mono text-gray-300">${esc(meta.sample_group)}</span>${siblings.length ? ` — the same bug at another stage: ${siblings.map((s) => `<button type="button" data-open-task="${esc(s)}" class="font-mono text-indigo-300 underline">${esc(s)}</button>`).join(', ')}. Siblings count as one sample, so a config's result may be filed under either; rows below say which.` : ''}</div>` : ''}
        <div class="card !p-4">
          <div class="text-[10px] uppercase tracking-wider text-gray-500 mb-1">What this task is</div>
          <div id="mt-summary" class="text-sm text-gray-200">${esc(taskSummary(infoNow, meta)) || '<span class="text-gray-500">loading…</span>'}</div>
        </div>
        <div id="mt-info">${renderTaskPanel(infoNow, { page: true, promptLevel: level })}</div>

        <div class="grid grid-cols-2 md:grid-cols-4 gap-2">
          ${difficultyCard(dr, ctx.adj && ctx.adj.taskDifficulty100 ? ctx.adj.taskDifficulty100.get(id) : null, ctx.adj && ctx.adj.taskPoints ? ctx.adj.taskPoints.get(id) : null,
              { diagnostic: !!(meta && meta.diagnostic), unscored: !!(meta && meta.unscored) })}
          ${card('solved by', `${solvedW}/${scoredW}`, `models (${solvers.length} of ${scored.length} configs)`, 'sets of weights with at least one passing run, over those with a scored run. Excluded runs are not answers.')}
          ${card('runs passed', `${passes}/${runs}`, `scored runs, every config${all.filter((e) => !e.t.unfinishedOnly).length - scored.length ? ` · ${all.filter((e) => !e.t.unfinishedOnly).length - scored.length} config(s) excluded` : ''}${all.some((e) => e.t.unfinishedOnly) ? ` · ${all.filter((e) => e.t.unfinishedOnly).length} unfinished (awaiting answer, not counted)` : ''}`)}
          ${card('solve time', wallMed != null ? fmtDur(wallMed) : '—', fastest ? `median of solvers${tokMed != null ? `, ${fmtN(Math.round(tokMed))} tok` : ''} · fastest ${fmtDur(fastest.t.wall_s)} (${esc(fastest.g.m.display)})` : 'no solve yet', 'wall clock (and output tokens) of the runs that passed, median over the configs that solved it')}
        </div>

        <div class="card !p-4">
          <div class="flex flex-wrap items-center gap-2 mb-1"><div class="text-[13.5px] font-semibold text-gray-100">Every model that ran it</div>
            <div class="ml-auto flex gap-1 text-[10px]">rows:
              <button type="button" data-task-rows="best" class="${toggle('best')}">best per model</button>
              <button type="button" data-task-rows="all" class="${toggle('all')}">all configs</button></div></div>
          <div id="mt-board"></div>
        </div>
        <div id="mt-goals" class="hidden card !p-4"></div>

        <div class="grid grid-cols-1 gap-3">
          <div class="card !p-4">
            <div class="text-[13.5px] font-semibold text-gray-100">Wall clock to solve it</div>
            <div class="text-[10px] text-gray-500 mb-2">Solvers only, fastest first; mean of the runs that passed.</div>
            <div class="w-full max-h-[380px] overflow-auto"><div id="mt-wall-box" style="height:200px"><canvas id="mt-wall"></canvas></div></div>
          </div>
          <div class="card !p-4">
            <div class="text-[13.5px] font-semibold text-gray-100">Output tokens to solve it</div>
            <div class="text-[10px] text-gray-500 mb-2">Solvers only, cheapest first. Tokenizers differ across families by 20–40%.</div>
            <div class="w-full max-h-[380px] overflow-auto"><div id="mt-tok-box" style="height:200px"><canvas id="mt-tok"></canvas></div></div>
          </div>
        </div>
      </div>`;

    root.dataset.taskId = id;
    const still = () => root.dataset.taskId === id && root.querySelector('#mt-info');
    root.querySelector('#mt-back').addEventListener('click', () => ctx.onBack());
    root.querySelectorAll('[data-open-task]').forEach((b) => b.addEventListener('click', () => ctx.openTask(b.dataset.openTask)));
    root.querySelectorAll('[data-task-rows]').forEach((b) => b.addEventListener('click', () => {
        if (b.dataset.taskRows === ctx.rows) return;
        ctx.setRows(b.dataset.taskRows);
        renderTask(root, { ...ctx, rows: b.dataset.taskRows });
    }));

    // best per model: one row per set of weights, its best config ON THIS TASK; all: every config
    const picked = ctx.rows === 'all'
        ? all.map((e) => ({ ...e, others: byW.get(weightsOf(e.g.m)) }))
        : [...byW.values()].map((list) => ({ ...list[0], others: list }));
    const rows = picked.map((e) => {
        const { g, t, o, via } = e;
        const a = t.assertionsAll || t.assertions;
        return {
            key: g.key,
            label: ctx.rows === 'all' ? (g.label || g.m.display) : g.m.display,
            sublabel: [shortCfg(g.c), ctx.rows !== 'all' && e.others.length > 1 ? `best of ${e.others.length} configs that ran it` : null, via ? `result filed under ${via}` : null].filter(Boolean).join(' · '),
            sublabelFull: g.members.map((x) => configText(x.m, x.c, true)).join('\n') + ' — batteries: ' + g.dirs.join(', '),
            badges: resultChip(o, t),
            metrics: {
                // solved first, then by wall clock: the default order of this board
                wall: { v: o.order < 3 ? t.wall_s : null, sort: o.order * 1e9 + (o.order < 3 && t.wall_s > 0 ? t.wall_s : 1e8),
                    note: o.order < 2 ? 'mean wall clock of the runs that passed' : 'mean wall clock of the scored runs' },
                runs: o.order < 3 ? { v: { passed: t.passes, total: t.attempts } } : null,
                // an excluded row is not a model answer: its cost and test figures are not shown
                tokens: { v: o.order < 3 && t.tokens_out > 0 ? t.tokens_out : null },
                tools: { v: o.order < 3 ? t.tool_calls : null },
                assertions: { v: o.order < 3 && a && a.total ? a : null, note: t.assertionsAll ? `summed over ${t.assertionsAll.runs} run(s)` : null },
                date: { v: day(t.ran_at), sort: t.ran_at || null },
            },
            n: t.attempts || 0,
            coverage: { attempted: g.q ? (g.q.counted ?? g.q.attempted) : Object.keys(g.tasks).length, total: catalog.taskTotal },
            warnings: [], _g: g, _t: t, _o: o, _others: e.others.map((x) => x.g),
        };
    });

    const board = createLeaderboard(root.querySelector('#mt-board'), {
        id: 'models-task',
        columns: [
            { id: 'wall', label: 'wall', kind: 'dur', dir: 'asc', title: 'default order: solved first, then by wall clock (runs that passed; for a miss, the scored runs). The result chip beside each name is folded over every scored run: pass, pass* (solved at the cap), pass k/n, TIMEOUT, fail, or the excluded status when no run was a model answer.' },
            { id: 'runs', label: 'passed/runs', kind: 'xy', dir: 'desc', title: 'scored runs that passed / scored runs. Excluded runs are not attempts.' },
            { id: 'tokens', label: 'tok out', kind: 'int', dir: 'asc', title: 'output tokens (mean of the runs that passed, else of the scored runs)' },
            { id: 'tools', label: 'tools', kind: 'num', dir: 'asc', title: 'tool calls (same runs as tokens)' },
            { id: 'assertions', label: 'assertions', kind: 'xy', dir: 'desc', title: 'hidden-test assertions passed / total, summed over the runs that record them' },
            { id: 'date', label: 'last run', kind: 'text', dir: 'desc', title: 'when the latest run of it started' },
        ],
        defaultSort: 'wall',
        note: `One row per ${ctx.rows === 'all' ? 'config' : 'set of weights, under its best config on this task'} (configs grouped as on the overview's quality charts). Solved first, then fastest. Excluded runs (OVERFLOW, KILLED, PROVIDER_ERROR …) are not answers: a row whose every run was excluded sits at the bottom. Click a row for its config and a link to the model.`,
        emptyText: 'No model has run this task yet.',
        highlight: ctx.highlight || null,
        rowDetail: (r) => goalsLine(r) + `<div class="mb-2 pb-1 border-b border-gray-800"><span class="font-mono">${esc(id)}</span>: ${resultChip(r._o, r._t)}${r._t.wall_s ? ` · ${fmtDur(r._t.wall_s)}` : ''}${r._t.tokens_out ? ` · ${fmtN(Math.round(r._t.tokens_out))} tok` : ''}</div>` + ctx.detailHtml(r._g, r._others),
        onRow: (r) => ctx.openModel(r._g.m.key),
    });
    board.setRows(rows);

    // ---- the task context and the per-goal matrix, once run.py --show and the case scan answer ----
    const dirGroup = new Map();
    for (const e of all) for (const d of e.g.dirs || []) if (!dirGroup.has(d)) dirGroup.set(d, e.g);
    let caseRuns = [], goalTitles = [];
    function goalsLine(r) {
        const mine = caseRuns.filter((x) => (r._g.dirs || []).includes(x.dir));
        if (!mine.length || !goalTitles.length) return '';
        return `<div class="mb-2 text-[11px] text-gray-300">hidden-test goals passed: ${mine.map((x) => `<b class="font-mono">${goalTitles.filter((t) => matchCase(x.cases, t) === 'pass').length}/${goalTitles.length}</b> <span class="text-gray-500 font-mono">${esc(x.dir)}${x.run > 1 ? ' #' + x.run : ''}</span>`).join(' · ')}</div>`;
    }
    (async () => {
        const [info, cj] = await Promise.all([loadInfo(id), loadCases(id)]);
        if (!still()) return;
        const ok = info && !info.error ? info : null;
        const runsWith = ok && cj && !cj.error && Array.isArray(cj.results) ? cj.results : [];
        caseRuns = runsWith;
        goalTitles = ok ? (ok.goals || []).flatMap((g) => g.cases) : [];
        const casesNote = !goalTitles.length ? '' : caseRuns.length
            ? '<span class="text-gray-400">Which of them each model passed: the matrix under the model list.</span>'
            : '<span class="text-gray-500">No run of this task has per-case results yet (recorded since 2026-09-25), so only pass/fail totals are known.</span>';
        if (!infoNow || casesNote) root.querySelector('#mt-info').innerHTML = renderTaskPanel(ok, { page: true, promptLevel: level, error: info && info.error, casesNote });
        root.querySelector('#mt-summary').textContent = taskSummary(ok, meta) || (info && info.error ? `task context unavailable: ${info.error}` : '');
        const box = root.querySelector('#mt-goals');
        const m = ok && caseRuns.length ? goalsMatrix(ok, caseRuns, (x) => {
            const g = dirGroup.get(x.dir);
            const sub = `${x.dir}${x.run > 1 ? ' #' + x.run : ''}`;
            if (!g) return { label: x.dir, sub: x.status || '', title: `${sub}: ${x.status || ''}` };
            return { label: ctx.rows === 'all' ? (g.label || g.m.display) : g.m.display, sub, modelKey: g.m.key,
                title: `${g.m.display} — ${shortCfg(g.c)}\nbattery ${sub}: ${x.status || ''}` };
        }) : '';
        if (!m) return;
        box.innerHTML = `<div class="text-[13.5px] font-semibold text-gray-100">Which goals each model passed</div>
            <div class="text-[10px] text-gray-500 mb-2">One column per scored run that recorded per-case hidden-test results (since 2026-09-25): ✓ passed, ✗ failed, ↓ skipped, ? not in the runner's per-case output. Older runs only have totals and are not shown.</div>${m}`;
        box.classList.remove('hidden');
        box.querySelectorAll('[data-open-model]').forEach((b) => b.addEventListener('click', () => ctx.openModel(b.dataset.openModel)));
    })();

    // cost bars over the rows shown above that solved it
    const pick = (key, ev, r) => {
        if (!r || !r._g) return;
        showPopover(ev ? ev.clientX : 200, ev ? ev.clientY : 200, ctx.detailHtml(r._g, r._others),
            { pin: true, actions: [{ label: 'Model details →', onClick: () => ctx.openModel(r._g.m.key) }] });
    };
    const solvedRows = rows.filter((r) => r._o.order < 2);
    const bar = (canvas, value, unit, fmt) => {
        const list = solvedRows.map((r) => ({ key: r.key, label: r.label, provider: r._g.m.provider, solved: r._t.passes, attempted: r._t.attempts,
            value: value(r._t), _g: r._g, _others: r._others })).filter((x) => x.value > 0);
        const box = root.querySelector(`#${canvas}-box`);
        if (!list.length) { if (box) box.innerHTML = '<div class="text-xs text-gray-600 py-6 text-center">No solve with this recorded.</div>'; return; }
        if (box) box.style.height = `${Math.max(140, list.length * 20 + 60)}px`;
        costPerSolve(canvas, list, unit, fmt, 'value', pick);
    };
    bar('mt-wall', (t) => t.wall_s, 'wall clock on this task', (v) => fmtDur(v));
    bar('mt-tok', (t) => t.tokens_out, 'output tokens on this task', (v) => (v >= 1000 ? `${Math.round(v / 1000)}k` : String(Math.round(v))));
}
