// Small helpers shared by the Benchmarks (codebench) views. Plain ES module; its imports are the shared classic scripts below.
// Model display names: the one helper (ui/shared/modelname.js, a classic script that sets
// globalThis.ModelName), re-exported so the ES modules take it from here.
import '../shared/modelname.js';
export const { modelName, stripSplitIn, modelFileKind } = globalThis.ModelName;
// Every poll's rules (ui/shared/poll.js, 2026-10-22): nothing while the page is hidden, never two runs at once.
import '../shared/poll.js';
export const { every: pollEvery } = globalThis.Poll;
// A context size in words and a merged row's agent-window note (ui/shared/ctxlabel.js, 2026-10-25): the one rule each,
// shared with lib/models.js (the catalog's ctx_label) and the classic scripts.
import '../shared/ctxlabel.js';
export const { ctxLabel, commonWindow } = globalThis.CtxLabel;
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Every duration in the Benchmarks tab goes through this: `48s`, `12m 30s`, `1h 04m 12s`.
// A bare "3497.4" tells a reader nothing; a cap, a wall clock and an edit timestamp are all
// durations and all read the same way. fmtS is the old name, kept as an alias so every existing
// call site (Runs, Live, the result detail) picks the new format up unchanged.
export function fmtDur(s) {
    if (s == null || s === '' || !Number.isFinite(Number(s))) return '—';
    const n = Number(s); const neg = n < 0;
    const t = Math.round(Math.abs(n));
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), r = t % 60;
    const out = h ? `${h}h ${String(m).padStart(2, '0')}m ${String(r).padStart(2, '0')}s`
        : (m ? `${m}m ${String(r).padStart(2, '0')}s` : `${r}s`);
    return neg ? `-${out}` : out;
}
export const fmtS = fmtDur;
export function fmtDate(ms) {
    if (!ms) return '—';
    const d = new Date(ms); const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
export const fmtN = (n) => (n == null ? '—' : Number(n).toLocaleString());
// Report-card numbers. `xy` renders {passed,total} as passed/total; anything without a numeric
// total (results that predate score.assertions) is '—', never 0/0.
export const xy = (o) => (o && Number.isFinite(Number(o.total)) ? `${o.passed ?? 0}/${o.total}` : '—');
export const xyClass = (o) => (!o || !Number.isFinite(Number(o.total)) ? 'text-gray-600' : ((o.passed ?? 0) >= o.total ? 'text-green-300' : ((o.passed ?? 0) > 0 ? 'text-yellow-300' : 'text-red-300')));
export const fmtPct = (p) => (p == null || !Number.isFinite(Number(p)) ? '—' : `${Math.round(Number(p) * 100)}%`);
// p2p as passed/total plus how many pass_to_pass files the patch broke (null = field absent).
export function p2pCell(row) {
    const base = row && row.p2p ? `<span class="${xyClass(row.p2p)}">${xy(row.p2p)}</span>` : '<span class="text-gray-600">—</span>';
    const broken = row && row.p2p_broken != null && row.p2p_broken > 0 ? `<span class="text-red-300 text-[10px]" title="existing test files (pass_to_pass) that fail with the model's change: each was re-run on its own and failed"> ${row.p2p_broken} file${row.p2p_broken === 1 ? '' : 's'} broken</span>` : '';
    const crashed = row && row.p2p && row.p2p.crashed ? `<span class="text-gray-400 text-[10px]" title="every existing test passed, then the test process crashed on exit (twice) and no file failed on its own: an environment crash, not the model's code; not counted against it"> crashed on exit</span>` : '';
    return base + broken + crashed;
}

// Status vocabulary (harness/status.py): pass, pass*, TIMEOUT, OVERFLOW, KILLED, fail.
const STATUS_CLASS = {
    'pass': 'bg-green-900/60 text-green-300',   // pass*: statusChip draws it in the special-pass dark green
    'fail': 'bg-red-900/60 text-red-300', 'TIMEOUT': 'bg-orange-900/60 text-orange-300',
    'OVERFLOW': 'bg-purple-900/60 text-purple-300', 'KILLED': 'bg-gray-700 text-gray-300',
    // Neither is a model answer: both leave the x/y denominator. ABORTED is what "stop now" records.
    'PROVIDER_ERROR': 'bg-pink-900/60 text-pink-200', 'ABORTED': 'bg-slate-700 text-slate-200',
    'valid': 'bg-green-900/40 text-green-200', 'invalid': 'bg-red-900/40 text-red-200',
    'running': 'bg-indigo-900/60 text-indigo-300 animate-pulse', 'pending': 'bg-gray-800 text-gray-500', 'error': 'bg-red-900/60 text-red-200',
};
export const STATUS_ORDER = ['pass', 'pass*', 'TIMEOUT', 'OVERFLOW', 'KILLED', 'PROVIDER_ERROR', 'ABORTED', 'fail'];
export function statusChip(status, derived) {
    // pass* wears the special-pass dark green (below); vendor/tailwind.css has no green-800, hence inline
    if (status === 'pass*') return `<span class="inline-block px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold" style="background:${SPECIAL_PASS_FILL};color:${SPECIAL_PASS_INK};box-shadow:inset 0 0 0 1px ${SPECIAL_PASS_EDGE}" title="${esc(derived ? 'status derived from solved/hit_timeout (older result without a status field)' : `pass* — ${PASS_AT_CAP_NOTE}`)}">${esc(status)}${derived ? '?' : ''}</span>`;
    const cls = STATUS_CLASS[status] || 'bg-gray-800 text-gray-400';
    return `<span class="inline-block px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold ${cls}" title="${derived ? 'status derived from solved/hit_timeout (older result without a status field)' : esc(status)}">${esc(status)}${derived ? '?' : ''}</span>`;
}
// RUNS THAT ASKED, AND PASSES UNDER SPECIAL CONDITIONS (2026-10-19, Kyle: "Unfinished should be gray, not blue"; "Dark
// greens should be for 'passed but with special conditions'"). One look per meaning, the same on the lab and the public
// pages; the lab adds the detail (the question, a reviewer's note, the wall clock), the public pages only a category note
// (no task text ever). Display only: a special pass counts exactly as a pass, an unfinished run in nothing.
//  - PASSED UNDER SPECIAL CONDITIONS: DARK GREEN -- fill #166534 (green-800) with a #4ade80 (green-400) edge; ink #dcfce7.
//    The conditions (specialPassNotes): pass* (solved, but the run hit the time limit), answered-then-passed (the run
//    stopped to ask, the original prompt was re-supplied, then it passed), and overflowed-then-passed (2026-10-24, Kyle:
//    "these should be 'dark green' cases": the conversation outgrew the context window, the agent compacted and carried on,
//    and it passed; lib/models.js overflowedOfRuns).
//  - UNFINISHED (the run stopped to ask; awaiting the answer): mid GRAY -- fill #8a909b with dark hatching; ink #111827
//    (5.5:1; light ink was 3.1:1). Lighter than excluded #4a4f5c (dE 26) and not-attempted (4.5:1), so the fill alone
//    carries it at phone width, where cells are too narrow to hatch.
// A run that was answered and then failed is an ordinary fail; its hover says it was answered.
export const SPECIAL_PASS_FILL = '#166534';
export const SPECIAL_PASS_EDGE = '#4ade80';
export const SPECIAL_PASS_INK = '#dcfce7';
// the names the answered-then-passed look had (kept: a browser holding an older importer still finds them)
export const ANSWERED_FILL = SPECIAL_PASS_FILL;
export const ANSWERED_EDGE = SPECIAL_PASS_EDGE;
export const ANSWERED_INK = SPECIAL_PASS_INK;
export const UNFINISHED_FILL = '#8a909b';
export const UNFINISHED_HATCH = 'rgba(17,24,39,0.5)';
export const UNFINISHED_INK = '#111827';
export const PASS_AT_CAP_NOTE = 'code passed the tests although the run hit the time limit';
// a passing run whose conversation outgrew the context window (result anomaly "context_overflow"; lib/models.js overflowedOfRuns)
export const OVERFLOW_PASS_NOTE = 'passed after the conversation outgrew the context window (the agent compacted and carried on)';
export const UNFINISHED_NOTE = 'unfinished: the run stopped to ask a question; awaiting the answer';
const durText = (s) => { const v = Number(s); return Number.isFinite(v) && v > 0 ? (v >= 60 ? `${Math.round(v / 60)} min` : `${Math.round(v)} s`) : null; };
const q = (t) => (t ? `"${t}"` : 'a question');
/** The public category of an `answered` mark (lib/models.js answeredOfRuns): no task text. */
export function answeredCategory(a, word = 'passed') {
    if (!a) return '';
    return `${word} after the original prompt was re-supplied (${a.compacted > 0 ? 'asked after compaction' : 'asked'})`;
}
/** The public category note of an `overflowed` mark (lib/models.js overflowedOfRuns: { passed }), '' without one. */
export function overflowedCategory(o, passes) {
    if (!o || !(o.passed > 0)) return '';
    return `${OVERFLOW_PASS_NOTE}${passes > 0 && o.passed < passes ? ` (on ${o.passed} of its ${passes} passing runs)` : ''}`;
}
/** The public category notes of a PASSED cell's special conditions (a task map entry, lib/models.js taskMap): the
 *  answered-then-passed note, the overflowed-then-passed note, then pass*'s. [] for a plain pass or anything not passed.
 *  Display only. */
export function specialPassNotes(t) {
    if (!t || t.excluded || !(t.credit >= 1)) return [];
    const out = [];
    const an = t.answered;
    if (an && an.passed > 0) out.push(`${answeredCategory(an)}${an.passed < t.passes ? ` (on ${an.passed} of its ${t.passes} passing runs)` : ''}`);
    if (t.overflowed && t.overflowed.passed > 0) out.push(overflowedCategory(t.overflowed, t.passes));
    if (t.status === 'pass*') out.push(PASS_AT_CAP_NOTE);
    return out;
}
/** The lab's lines for an `answered` mark: each answered run, and the run(s) a continuation replaced. [] without notes. */
export function answeredLines(a) {
    const notes = (a && Array.isArray(a.answeredNotes)) ? a.answeredNotes : [];
    const out = [];
    for (const n of notes) {
        for (const h of n.history || []) out.push(`first stopped${durText(h.at_s ?? h.wall_s) ? ` at ${durText(h.at_s ?? h.wall_s)}` : ''} asking: ${q(h.asked)}${h.status ? ` (${h.status}${h.dir ? `, ${h.dir}` : ''})` : ''}`);
        const how = n.via === 'continue-from' ? 'continued with the original prompt' : 're-sent the original prompt at the end of the run';
        out.push(`${how}${n.history && n.history.length ? '' : `${durText(n.at_s) ? ` after ${durText(n.at_s)}` : ''}, it had asked: ${q(n.asked)}`}${n.compactions > 0 ? ` (after ${n.compactions} compaction${n.compactions === 1 ? '' : 's'})` : ''} -> ${n.status || '?'}${n.dir ? ` · ${n.dir}` : ''}`);
    }
    return out;
}
/** The lab's lines for an `unfinished` mark (lib/models.js unfinishedMap): the question, the session, a reviewer's note. */
export function unfinishedLines(u) {
    const notes = (u && Array.isArray(u.unfinishedNotes)) ? u.unfinishedNotes : [];
    const out = [];
    for (const n of notes) {
        out.push(`stopped${durText(n.wall_s) ? ` at ${durText(n.wall_s)}` : ''} asking: ${q(n.question)}${n.compactions > 0 ? ` (after ${n.compactions} compaction${n.compactions === 1 ? '' : 's'})` : ''}`);
        out.push(`   session ${n.rebuildable === false ? 'saved but not rebuildable: a fresh run may replace it' : n.session === 'saved' ? 'saved: waits for a continuation' : n.session === 'pruned' ? 'pruned: a fresh run may replace it' : 'unknown'}${n.dir ? ` · ${n.dir}` : ''}`);
        if (n.ai) out.push(`   AI review (${n.ai.answerable}): ${n.ai.note}`);
    }
    return out;
}
/** The public-safe line of an `unfinished` mark. */
export function unfinishedCategory(u) {
    if (!u) return '';
    return `${UNFINISHED_NOTE}${u.n > 1 ? ` (${u.n} runs)` : ''}${u.compacted > 0 ? ' (asked after compaction)' : ''}`;
}
const chip = (bg, ink, edge, attrs, title, text) => `<span class="inline-block ml-1 px-1 py-0.5 rounded text-[10px] font-mono font-semibold" ${attrs} style="background:${bg};color:${ink};box-shadow:inset 0 0 0 1px ${edge}" title="${esc(title)}">${text}</span>`;
/** The tables' chip for an `answered` mark: the special-pass dark green when an answered run passed, else a plain note. */
export function answeredChip(a) {
    if (!a) return '';
    const lines = answeredLines(a);
    if (a.passed > 0) return chip(SPECIAL_PASS_FILL, SPECIAL_PASS_INK, SPECIAL_PASS_EDGE, 'data-answered', [answeredCategory(a), ...lines].join('\n'), 'answered → pass');
    return `<span class="inline-block ml-1 text-[10px] font-mono text-gray-400" data-answered title="${esc([answeredCategory(a, 'failed'), ...lines].join('\n'))}">answered → fail</span>`;
}
/** The tables' chip for an `overflowed` mark (lib/models.js overflowedOfRuns): the special-pass dark green when a passing
 *  run outgrew the context window and carried on. '' without one (an overflow that did not pass is OVERFLOW: excluded). */
export function overflowChip(o, passes) {
    if (!o || !(o.passed > 0)) return '';
    return chip(SPECIAL_PASS_FILL, SPECIAL_PASS_INK, SPECIAL_PASS_EDGE, 'data-overflowed', overflowedCategory(o, passes), 'overflow → pass');
}
/** The tables' chip for an `unfinished` mark (a cell's, or one row's own `unfinished` record). '' without one. */
export function unfinishedChip(u) {
    if (!u) return '';
    const m = u.unfinishedNotes ? u : { n: 1, compacted: Number(u.compactions) > 0 ? 1 : 0, unfinishedNotes: [{ ...u, ai: u.ai || null }] };
    return chip(UNFINISHED_FILL, UNFINISHED_INK, UNFINISHED_HATCH, 'data-unfinished', [unfinishedCategory(m), ...unfinishedLines(m), 'not counted anywhere until the question is answered with the original prompt'].join('\n'), 'unfinished · awaiting answer');
}
/** Battery view: a row a continuation replaced (out of every tally), and a continuation row (it counts). */
export function supersededChip(sup) {
    if (!sup) return '';
    const by = (sup.by || []).map((b) => `${b.dir}/${b.file}`).join(', ');
    return `<span class="inline-block ml-1 px-1 py-0.5 rounded text-[10px] font-mono bg-gray-800 text-gray-400" data-superseded title="${esc(`superseded by its continuation ${by}: that run is the score of this task; this one is history, out of every count`)}">superseded</span>`;
}
export function continuationChip(ct, passed) {
    if (!ct) return '';
    const src = [ct.src_dir, ct.src_file].filter(Boolean).join('/');
    const title = `continues ${src || '(source not recorded)'} with the original prompt: this run counts, and replaces that one`;
    // dark green only when the continuation passed (a pass under a special condition); a failed one is a neutral note
    if (passed) return chip(SPECIAL_PASS_FILL, SPECIAL_PASS_INK, SPECIAL_PASS_EDGE, 'data-continuation', title, 'continuation');
    return `<span class="inline-block ml-1 px-1 py-0.5 rounded text-[10px] font-mono bg-gray-800 text-gray-400" data-continuation title="${esc(title)}">continuation</span>`;
}
export function anomalyChips(list) {
    if (!list || !list.length) return '<span class="text-gray-600">—</span>';
    return list.map((a) => `<span class="inline-block px-1 py-0.5 mr-0.5 rounded bg-yellow-900/50 text-yellow-200 text-[10px] font-mono">${esc(a)}</span>`).join('');
}
export function countChips(counts) {
    return STATUS_ORDER.filter((s) => counts && counts[s]).map((s) => `${statusChip(s)}<span class="text-[10px] text-gray-400 mr-1.5">${counts[s]}</span>`).join('') || '<span class="text-gray-600">—</span>';
}
// What identifies a run: runner + model + the server's devices (build_info alone does not say
// whether it ran on ROCm or Vulkan) + n_ctx. `server` may be null for cloud runners.
export const effortOf = (config, server) => (config && config.effort)
    || ((/CODEBENCH_CLAUDE_EFFORT=(\w+)/.exec((server && server.agent) || '') || [])[1]) || null;
// The harness a run used, as ONE label. pi's scaffold is its extension set (harness/runners/pi.py,
// CODEBENCH_PI_EXT: none | sol-pi), which changes what the harness IS -- so a pi row reads "pi" or
// "pi + SoL-Pi", never "pi · none". claude's scaffold (solo / default / advisor:x) is who else
// served the run and stays its own bit (scaffoldBit).
const PI_SCAFFOLD_LABEL = { 'sol-pi': 'SoL-Pi' };
const isPiScaffold = (sc) => sc === 'none' || sc === 'sol-pi';
export function harnessLabel(runner, scaffold) {
    const sc = scaffold ? String(scaffold).toLowerCase() : '';
    if (runner === 'pi' || (!runner && isPiScaffold(sc))) return PI_SCAFFOLD_LABEL[sc] ? `pi + ${PI_SCAFFOLD_LABEL[sc]}` : 'pi';
    return runner || null;
}
/** The scaffold as its own label bit, or null when harnessLabel already said it (pi's extension set). */
export function scaffoldBit(runner, scaffold) {
    if (!scaffold) return null;
    if (runner === 'pi' || (!runner && isPiScaffold(String(scaffold).toLowerCase()))) return null;
    return scaffold;
}
// The Live view's "what is running" card, from the snapshot's run_info (lib/runlabel.js). The
// battery label and the opencode id are the user's own nicknames ("q2cq4-q8kv-xtx", "q2max") and
// say nothing about the weights; this is read off the server's launch command. Pure: node tests it.
// Only classes present in the static vendor/tailwind.css (or index.html's supplement) -- others do nothing.
const RUN_INFO_SOURCE = {
    proc: "the serving process's own argv, recorded in the newest result JSON",
    'proc-scan': 'the only llama-server process running (no result JSON has landed yet)',
    lldash: "LL-Dash's record of the server it launched",
    launch_command: 'the recorded launch command',
    model_path: "the server's /props (no launch command: MTP, KV and devices are not recorded)",
    'runner model id': 'the runner model id only (no local server recorded)',
};
// opts.label: the card's caption -- "model that ran this task" when Live views a finished task (2026-09-30).
export function runInfoHtml(ri, batteryName, opts) {
    if (!ri) return '';
    const chip = (txt, title, cls) => `<span class="px-2 py-0.5 rounded-md border ${cls || 'border-gray-600 bg-gray-800 text-gray-100'} text-xs font-mono font-semibold" title="${esc(title || '')}">${esc(txt)}</span>`;
    const chips = [];
    if (ri.model && ri.model.quant) chips.push(chip(ri.model.quant, 'quant (from the GGUF file name)'));
    if (ri.ctx) chips.push(chip(`${ctxLabel(ri.ctx)} ctx`, `n_ctx ${ri.ctx}`));
    if (ri.kv) chips.push(chip(`KV ${ri.kv}`, 'KV cache type (--cache-type-k / --cache-type-v; f16 when the flags are absent)'));
    if (ri.devices) chips.push(chip(ri.devices.label, `-dev ${(ri.devices.ids || []).join(',') || '(not pinned)'} — cards are named from the run's own machine record, else the build's --list-devices; RPC = remote worker; an id nothing names is shown as it is`, 'border-indigo-500 bg-gray-800 text-white'));
    if (ri.mtp === true) chips.push(chip('MTP on', '--spec-type draft-mtp', 'border-green-600 bg-green-900/40 text-green-300'));
    else if (ri.mtp === false) chips.push(chip(ri.spec ? `spec ${ri.spec}` : 'MTP off', ri.spec ? 'speculative decoding, not MTP' : 'no --spec-type in the launch command', 'border-gray-700 bg-gray-900 text-gray-400'));
    if (ri.harness) chips.push(chip(ri.harness, `harness runner${ri.scaffold ? ` + scaffold ${ri.scaffold}` : ''}`, 'border-gray-600 bg-gray-800 text-gray-200'));
    if (ri.effort) chips.push(chip(`effort ${ri.effort}`, 'reasoning effort', 'border-gray-600 bg-gray-800 text-amber-300'));
    if (ri.promptLevel) chips.push(chip(ri.promptLevel + (ri.variant ? ` + ${ri.variant}` : ''), ri.variant ? `prompt level ${ri.promptLevel}, prompt variant ${ri.variant}` : `prompt level ${ri.promptLevel}, no prompt variant`));
    if (ri.engine) chips.push(chip(ri.engine, 'engine (no llama-server command: its settings are in the Strata config file the queue item names)', 'border-indigo-500 bg-indigo-900/40 text-indigo-200'));
    const missing = ri.local && !ri.launchCommand ? (ri.engine ? ' <span class="text-gray-400">— Strata settings live in its config file (see the queue item / the model page\'s config line), not in llama-server flags</span>'
        : ' <span class="text-yellow-400">— launch flags not recorded: MTP / KV / devices unknown</span>') : '';
    const pending = !ri.local && (ri.runner === 'opencode' || ri.runner === 'pi') ? ' <span class="text-yellow-400">— no server provenance yet (it arrives with the first finished task)</span>' : '';
    const nick = [batteryName ? `battery <span class="font-mono text-gray-400">${esc(batteryName)}</span>` : '', ri.runnerModel && ri.local ? `${esc(ri.runner || 'runner')} id <span class="font-mono text-gray-400">${esc(ri.runnerModel)}</span>` : ''].filter(Boolean).join(' · ');
    return `<div class="mt-2 rounded-lg border border-indigo-500 bg-gray-900 px-3 py-2">
        <div class="text-[10px] uppercase tracking-wider text-indigo-300">${esc((opts && opts.label) || 'running model')}</div>
        <div class="text-lg font-semibold text-white leading-snug">${esc(ri.model && ri.model.display ? ri.model.display : '(model not recorded)')}</div>
        ${chips.length ? `<div class="flex flex-wrap gap-1.5 mt-1.5">${chips.join('')}</div>` : ''}
        <div class="text-[10px] text-gray-500 mt-1.5">${ri.source ? `from ${esc(RUN_INFO_SOURCE[ri.source] || ri.source)}` : 'nothing recorded about the server'}${missing}${pending}${nick ? ` · ${nick} (labels, not the weights)` : ''}</div>
    </div>`;
}
export function configLine(config, server) {
    const c = config || {}, s = server || {};
    const bits = [];
    if (c.runner) bits.push(`<b class="text-gray-200"${c.runner === 'pi' ? ` title="pi coding agent · scaffold ${esc(c.scaffold || 'not recorded')} (its extension set)"` : ''}>${esc(harnessLabel(c.runner, c.scaffold))}</b>`);
    if (c.model) bits.push(`<span class="font-mono">${esc(c.model)}</span>`);
    const eff = effortOf(c, s);
    if (eff) bits.push(`<span class="font-mono text-amber-300" title="reasoning effort (CODEBENCH_CLAUDE_EFFORT) — an axis of the configuration, not part of the model name">effort ${esc(eff)}</span>`);
    // Scaffold: who else served the run. "default" is NOT "no advisor" -- it inherits
    // ~/.claude/settings.json, which today means a Fable advisor.
    if (scaffoldBit(c.runner, c.scaffold)) bits.push(`<span class="font-mono ${c.scaffold === 'solo' ? 'text-green-300' : 'text-amber-300'}" title="${c.scaffold === 'default' ? 'inherits ~/.claude settings: currently advisor=fable' : (c.scaffold === 'solo' ? 'exactly one model: the Agent tool and the advisor are disabled' : 'per-invocation advisorModel')}">${esc(c.scaffold)}</span>`);
    if (s.agent) bits.push(`<span class="text-gray-400" title="scaffold">${esc(s.agent)}</span>`);
    if (s.devices) bits.push(`<span class="font-mono text-indigo-300" title="devices (from the launch command)">${esc(s.devices)}</span>`);
    if (s.n_ctx) bits.push(`<span class="font-mono" title="n_ctx">${esc(ctxLabel(s.n_ctx))} ctx</span>`);
    if (c.prompt_level) bits.push(esc(c.prompt_level));
    if (c.timeout_s) bits.push(`cap ${fmtS(c.timeout_s)}`);
    if (s.model_path) bits.push(`<span class="text-gray-500 font-mono" title="${esc(s.model_path)}">${esc(modelName(s.model_path))}</span>`);
    if (s.build_info) bits.push(`<span class="text-gray-500 font-mono">${esc(s.build_info)}</span>`);
    return bits.join(' <span class="text-gray-700">·</span> ') || '<span class="text-gray-600">no config recorded</span>';
}
// Re-rendering with innerHTML forgets two things a reader cares about: which <details> are open
// and where a scrollable panel was scrolled -- the Live view re-renders every second (clock) and
// every poll, so a <details> snapped shut and the transcript tail jumped to the top. Give such
// elements a data-key that is stable across renders (e.g. "stderr", "tail:<task>") and render
// through setHtml(), which captures the state before the rebuild and re-applies it after. A
// panel that was scrolled to the bottom stays pinned to the bottom as the tail grows. The two
// helpers are pure over element-like objects ({dataset.key, open, scrollTop, ...}) so node tests them.
export function captureUiState(nodes) {
    const st = {};
    for (const el of nodes || []) {
        const k = el && el.dataset && el.dataset.key; if (!k) continue;
        const e = {};
        if (typeof el.open === 'boolean') e.open = el.open;
        if (Number.isFinite(el.scrollHeight) && Number.isFinite(el.clientHeight) && el.scrollHeight > el.clientHeight) {
            e.scrollTop = el.scrollTop || 0;
            e.atBottom = e.scrollTop + el.clientHeight >= el.scrollHeight - 4;
        }
        // horizontal too: a wide table read sideways must not snap back left on every redraw
        if (Number.isFinite(el.scrollWidth) && Number.isFinite(el.clientWidth) && el.scrollWidth > el.clientWidth) e.scrollLeft = el.scrollLeft || 0;
        st[k] = e;
    }
    return st;
}
export function restoreUiState(nodes, st) {
    let n = 0;
    for (const el of nodes || []) {
        const e = st && el && el.dataset && st[el.dataset.key]; if (!e) continue;
        if (e.open !== undefined && typeof el.open === 'boolean') el.open = e.open;
        if (e.scrollTop !== undefined) {
            const want = e.atBottom ? Math.max(0, (el.scrollHeight || 0) - (el.clientHeight || 0)) : e.scrollTop;
            if (Math.abs((el.scrollTop || 0) - want) > 1) el.scrollTop = want;   // a no-op write can still cancel a gesture in flight
        }
        if (e.scrollLeft !== undefined && Math.abs((el.scrollLeft || 0) - e.scrollLeft) > 1) el.scrollLeft = e.scrollLeft;
        n++;
    }
    return n;
}
// ============================================================================================================
// WHAT THE READER OPENED OR CLOSED, KEPT BY A STABLE ID (2026-10-22). READ THIS BEFORE TOUCHING ANY LIVE VIEW.
// ============================================================================================================
// Kyle, 2026-10-22, on Bench -> Live -> transcript: "lots of stuff is collapsed by default ... and when I expand it,
// it self-collapses right after, a repeat of previous issues we've dealt with in this section". It is the FOURTH
// time this has broken: 09-25 (innerHTML redraws every second), 10-01 (bodies detached/re-attached around a redraw),
// 10-06 (setHtml merge), 10-20 (sub-agents merged into the stream). Each fix was right for the redraw it looked at.
// WHAT CLOBBERS IT. These views are redrawn all the time, and every redraw can create the <details> again:
//   * live.js redraws its whole page every second and on every poll (setHtml);
//   * the transcript view re-reads a running task from event 0 when the server says the list changed order;
//   * the live chat builds a message's node again whenever the message changes (a streaming answer becomes an
//     ordinary message when the agent sends its next request, its text grows, a new thread arrives);
//   * a body is emptied and refilled when the view moves to another battery or task, even for a moment.
//   A new node is born with the markup's default (closed), so the reader's click is gone.
// WHY IT KEPT COMING BACK. The state was kept IN THE DOM (the `open` attribute, read back before each redraw) and
// looked up by a key that was not an identity: an event's index in a list that gets re-ordered (`ev:<dir>:<task>:<i>`;
// lib/codebench.js's sub-agent merge puts the same event at another index once the task ends or a request is not
// "running"), a message's slot in a node map that is rebuilt, or nothing at all. Each new feature added a new way to
// recreate nodes or re-number events, and the old fix did not cover it.
// THE RULE for every view here, new ones too:
//   1. The reader's choice lives in a store OUTSIDE the DOM (createOpenChoices below), recorded when THEY act (a click
//      on the summary / the "show all" button), never inferred from what the DOM says after a redraw.
//   2. It is keyed by what the thing IS: an event's `key` from the server (lib/codebench.js eventKey: a tool call by its
//      call id, else its place in its own append-only file), a chat message by its place in its conversation, a tool
//      call by its id. NEVER by a DOM position, a list index, a page offset or `i`.
//   3. Every place that creates such a node -- a full render, an append, a rebuilt message -- applies the store to the
//      new node (apply / applyAll) right after creating it. Defaults (the markup's `open`) only stand for blocks the
//      reader has never touched.
//   4. A component living inside a data-keep host owns its own state: a parent's setHtml must not capture or restore
//      anything inside it (setHtml below skips nested data-keep hosts).
export function createOpenChoices(cap = 5000) {
    const m = new Map();   // stable key -> true (opened) | false (closed); insertion order = least recently set first
    const watched = typeof WeakSet !== 'undefined' ? new WeakSet() : null;   // roots already listened to (a view rebuilt on the same element)
    return {
        get: (k) => (k ? m.get(k) : undefined),
        set(k, open) { if (!k) return; m.delete(k); m.set(k, !!open); if (m.size > cap) m.delete(m.keys().next().value); },
        /** A node just created: the reader's choice if they made one, else the default it was drawn with. */
        apply(el) { const k = el && el.dataset ? el.dataset.key : null; const v = k ? m.get(k) : undefined; if (v !== undefined && el.open !== v) el.open = v; },
        applyAll(root) { if (root && root.querySelectorAll) for (const d of root.querySelectorAll('details[data-key]')) this.apply(d); },
        /** Record the reader's own clicks on summaries under `root` (a click on a summary is about to flip its details). */
        watch(root) {
            if (!root || !root.addEventListener || (watched && watched.has(root))) return;
            if (watched) watched.add(root);
            root.addEventListener('click', (ev) => {
                const s = ev.target && ev.target.closest ? ev.target.closest('summary') : null;
                const d = s && s.parentElement;
                if (d && d.tagName === 'DETAILS' && d.dataset.key && root.contains(d)) this.set(d.dataset.key, !d.open);
            });
        },
        get size() { return m.size; },
    };
}
// ---------- reading the prompt / generating, for the foot of Live's transcript box (2026-10-22) ----------
// Kyle: "when doing prefill, there should be an animation showing prefill is happening, and stats on generation and on
// prefill should be right there, inline." The numbers already exist for both engines in ONE shape: lib/lanetps.js
// laneRates folds the lane's engine (llama-server GET /slots via lib/slots.js; Strata GET /metrics `live`) and its proxy
// tap into one record per lane -- GET /api/lanes/live, polled by script.js into window.__lanesLive. This turns one such
// record into what the box shows; live.js draws it. Nothing here knows which engine it was.
//   l:       the lane record (phase, gen, prefill, prefillSrc, read, total, generated, reqAgeMs, firstTokenMs, last*)
//   sinceMs: how long ago the browser got it (ages are added to it: no clock has to agree with the server's)
//   seen:    this request's read, if it was watched ({read, total, tps}) -- shown once generation starts
// -> null (nothing running) | { phase: 'prefill'|'gen'|'busy', pct: 0..100 or null (no total known: an animation, not a
//    made-up fraction), text }
export function livePhase(l, sinceMs = 0, seen = null) {
    if (!l || !l.phase || l.phase === 'idle') return null;
    const f0 = (v) => Math.round(Number(v)).toLocaleString(), f1 = (v) => Number(v).toFixed(1);
    const age = (ms) => (ms == null ? null : (Number(ms) + Math.max(0, sinceMs)) / 1000);
    const pos = (v) => v != null && Number(v) > 0;
    const bits = [];
    if (l.phase === 'prefill') {
        const liveRate = pos(l.prefill) && (l.prefillSrc === 'slots' || l.prefillSrc === 'metrics');   // this request's own rate
        const known = pos(l.total) && l.read != null;
        const pct = known ? Math.max(0, Math.min(100, (Number(l.read) / Number(l.total)) * 100)) : null;
        bits.push('reading the prompt');
        if (known) bits.push(`${f0(l.read)} / ${f0(l.total)} tokens (${pct.toFixed(0)}%)`);
        if (liveRate) bits.push(`${f0(l.prefill)} t/s`);
        else if (pos(l.lastReadTps)) bits.push(`last read ran at ${f0(l.lastReadTps)} t/s`);
        const el = age(l.reqAgeMs); if (el != null) bits.push(fmtDur(el));
        if (known && liveRate && Number(l.total) > Number(l.read)) bits.push(`~${fmtDur((Number(l.total) - Number(l.read)) / Number(l.prefill))} left`);
        return { phase: 'prefill', pct, text: bits.join(' · ') };
    }
    if (l.phase === 'gen') {
        bits.push('generating');
        if (l.generated != null) bits.push(`${f0(l.generated)} tokens`);
        if (pos(l.gen)) bits.push(`${f1(l.gen)} t/s`);
        const total = age(l.reqAgeMs), first = l.firstTokenMs != null ? Number(l.firstTokenMs) / 1000 : null;
        if (total != null && first != null) bits.push(fmtDur(Math.max(0, total - first)));
        if (seen && pos(seen.total)) bits.push(`prompt: ${f0(seen.total)} tokens${pos(seen.tps) ? ` at ${f0(seen.tps)} t/s` : ''}${first != null ? ` in ${fmtDur(first)}` : ''}`);
        else if (first != null) bits.push(`first token after ${fmtDur(first)}`);
        return { phase: 'gen', pct: null, text: bits.join(' · ') };
    }
    // between requests: the agent is running a tool (or the lane has not said yet)
    bits.push('between requests');
    if (pos(l.lastPromptTps)) bits.push(`last read ${f0(l.lastPromptTps)} t/s${pos(l.lastPromptN) ? ` (${f0(l.lastPromptN)} tokens)` : ''}`);
    if (pos(l.lastPredTps)) bits.push(`last generation ${f1(l.lastPredTps)} t/s`);
    return { phase: 'busy', pct: null, text: bits.join(' · ') };
}
// Tool-call arguments up to this long are shown open in a live transcript (the live chat's rule since 10-01; the
// transcript view uses it for a running task too, so the two look alike).
export const ARGS_INLINE_MAX = 240;
// The Live view's parsed transcript tail, merged incrementally rather than re-fetched as a sliding
// window: a window of the last N entries shifts under a reader who has scrolled up, and the old
// newest-first list, with its scroller unkeyed, snapped back to the top on every 1 s redraw.
// prev: {start, events} (events[i] is transcript event start+i); page: the /api/codebench/transcript
// answer for `from` onward. The last event already held is re-read each poll (it may still be
// growing) and replaced; `keep` bounds memory, dropping the oldest.
export function mergeTailEvents(prev, from, page, keep = 300) {
    const p = prev && Array.isArray(prev.events) ? prev : { start: from, events: [] };
    const evs = (page && Array.isArray(page.events)) ? page.events : [];
    // an empty answer that does not say the transcript shrank is a hiccup: keep what is held
    if (!evs.length && prev && page && page.total != null && page.total >= p.start + p.events.length) return { start: p.start, events: p.events, total: page.total };
    let start = p.start, events;
    if (from < p.start || from > p.start + p.events.length) { start = from; events = evs.slice(); }   // not contiguous: take the page as is
    else events = p.events.slice(0, from - p.start).concat(evs);
    if (events.length > keep) { const drop = events.length - keep; events = events.slice(drop); start += drop; }
    return { start, events, total: page && page.total != null ? page.total : start + events.length };
}
// A scroller that should follow new content (a transcript tail): pinned to the bottom when it
// first appears and while the reader is at the bottom; left alone once they scroll up. `wasAtBottom`
// is what isAtBottom() said about the same data-key before the redraw (undefined = new scroller).
export const isAtBottom = (el) => (el.scrollTop || 0) + (el.clientHeight || 0) >= (el.scrollHeight || 0) - 4;
export function followScroll(el, wasAtBottom) {
    if (wasAtBottom === false) return false;
    const want = Math.max(0, (el.scrollHeight || 0) - (el.clientHeight || 0));
    if (Math.abs((el.scrollTop || 0) - want) > 1) el.scrollTop = want;   // only when it has to move
    return true;
}
// ---- setHtml: rebuild a view WITHOUT destroying what the reader is scrolling (2026-10-06) -----------------------
// Kyle: "find all places where the scrolly sections bounce up after a second as the content updates and fix this
// issue once and for all ... if I'm scrolling, the scroll event gets interrupted after a second and then can't
// recontinue easily". Every view here redraws on a timer; `root.innerHTML = html` replaced every scroll container,
// so (a) one without a data-key lost its position, (b) one with a key got it written back -- but the element the
// wheel gesture was latched to had been destroyed, so the gesture died until the pointer moved, and (c) components
// that outlive a redraw (the live chat, the accordions' bodies) were detached and re-attached around it, which
// resets their scroll the same way.
// Now the new HTML is parsed off-screen and MERGED into the live tree:
//   * a scroll container, each of its ancestors, and any element marked data-keep stay the SAME NODE: attributes
//     are synced and the children merged in turn, so its scroll position and an in-flight gesture are untouched;
//   * a data-keep element's children are left exactly as they are (a mounted component lives there);
//   * everything else is replaced by fresh nodes, exactly as innerHTML did -- so the views' habit of calling
//     addEventListener on what they just rendered keeps working. For the nodes that DO persist, the listeners a
//     view added after the previous redraw are removed first (recorded below), so handlers never pile up.
// Keys still matter for one thing: telling two sibling scrollers apart when a block appears above them.
const SCROLLER_SEL = '[class*="overflow-auto"],[class*="overflow-y-auto"],[class*="overflow-x-auto"],[class*="overflow-scroll"],[class*="overflow-y-scroll"],[class*="overflow-x-scroll"],[style*="overflow"],[data-streamwrap],[data-follow],textarea';
const KEEP_SEL = '[data-keep]';
const PERSIST_SEL = `${SCROLLER_SEL},${KEEP_SEL}`;
const LISTENERS = typeof WeakMap !== 'undefined' ? new WeakMap() : null;
// Record listeners added to elements inside a setHtml-managed root, so a node that persists can be given a clean
// slate before the view wires it again. Elements outside such a root (charts, the rest of the app) are not recorded.
export function recordListeners(win) {
    const ET = win && win.EventTarget, El = win && win.Element;
    if (!ET || !El || ET.prototype.__cbRecording) return;
    const add = ET.prototype.addEventListener;
    ET.prototype.addEventListener = function (type, fn, opts) {
        try {
            if (this instanceof El && this.closest && this.closest('[data-morph-root]')) {
                let l = LISTENERS.get(this);
                if (!l) LISTENERS.set(this, l = []);
                if (l.length < 256) l.push([type, fn, opts]);
            }
        } catch { /* recording must never break a listener */ }
        return add.call(this, type, fn, opts);
    };
    ET.prototype.__cbRecording = true;
}
if (typeof window !== 'undefined') recordListeners(window);
function dropListeners(el) {
    const l = LISTENERS && LISTENERS.get(el);
    if (!l) return;
    for (const [type, fn, opts] of l) { try { el.removeEventListener(type, fn, opts); } catch { /* gone */ } }
    LISTENERS.delete(el);
}
const isEl = (n) => n && n.nodeType === 1;
const keyOf = (el) => (el.getAttribute && el.getAttribute('data-key')) || '';
// Does this live element have to stay the same node? (it is, or holds, a scroll container or a kept component)
const mustPersist = (el) => isEl(el) && (el.matches(PERSIST_SEL) || !!el.querySelector(PERSIST_SEL));
// Could the new element be the next version of the old one?
function sameSlot(o, n) {
    if (!isEl(o) || !isEl(n) || o.tagName !== n.tagName) return false;
    if (keyOf(o) !== keyOf(n) || (o.id || '') !== (n.id || '')) return false;
    if (o.matches(KEEP_SEL) !== n.matches(KEEP_SEL)) return false;
    return o.matches(SCROLLER_SEL) === n.matches(SCROLLER_SEL);
}
function syncAttrs(o, n) {
    for (const a of Array.from(o.attributes)) {
        if (a.name === 'data-morph-root') continue;
        if (a.name === 'open' && o.tagName === 'DETAILS') continue;   // the reader's own open/closed stands
        if (!n.hasAttribute(a.name)) o.removeAttribute(a.name);
    }
    for (const a of Array.from(n.attributes)) {
        if (a.name === 'open' && o.tagName === 'DETAILS') continue;
        if (o.getAttribute(a.name) !== a.value) o.setAttribute(a.name, a.value);
    }
}
function mergeInto(o, n) {
    dropListeners(o);
    syncAttrs(o, n);
    if (o.matches(KEEP_SEL)) return;   // a mounted component's home: its children are not ours
    mergeChildren(o, n);
}
export function mergeChildren(oldParent, newParent) {
    let o = oldParent.firstChild;
    for (let n = newParent.firstChild; n;) {
        const nextN = n.nextSibling;
        // A new element that holds a scroll container (or a kept component) looks for the live node it is the next
        // version of -- here, or further along when a block above it went away.
        let match = null;
        if (isEl(n) && mustPersist(n)) for (let c = o; c; c = c.nextSibling) if (sameSlot(c, n) && mustPersist(c)) { match = c; break; }
        if (match) {
            while (o && o !== match) { const d = o; o = o.nextSibling; oldParent.removeChild(d); }
            o = match.nextSibling;
            mergeInto(match, n);
        } else if (o && !mustPersist(o)) {
            const d = o; o = o.nextSibling;
            oldParent.replaceChild(n, d);   // an ordinary node: a fresh one in its place, as innerHTML would give
        } else {
            oldParent.insertBefore(n, o);   // `o` persists and waits for its own next version (or there is nothing left)
        }
        n = nextN;
    }
    while (o) { const d = o; o = o.nextSibling; oldParent.removeChild(d); }
}
export function setHtml(root, html) {
    const doc = root.ownerDocument || (typeof document !== 'undefined' ? document : null);
    // Keyed nodes of THIS view only: not those inside a data-keep host below root (rule 4 above). The merge never touches
    // a kept component's children, so there is nothing to put back there -- but capturing them anyway let one block's
    // state be written onto another that shared its key (live.js redraws every second around the transcript view).
    const inKeptChild = (el) => { const k = el.parentElement && el.parentElement.closest ? el.parentElement.closest(KEEP_SEL) : null; return !!k && k !== root && root.contains(k); };
    const q = () => (root.querySelectorAll ? Array.from(root.querySelectorAll('[data-key]')).filter((el) => !inKeptChild(el)) : []);
    if (!doc || !doc.createElement || !root.firstChild) {   // nothing to preserve (first render), or no DOM (unit-test stubs)
        const st = captureUiState(q());
        if (root.setAttribute) root.setAttribute('data-morph-root', '');
        root.innerHTML = html;
        restoreUiState(q(), st);
        return;
    }
    root.setAttribute('data-morph-root', '');
    const st = captureUiState(q());
    const tpl = doc.createElement('template');
    tpl.innerHTML = html;
    mergeChildren(root, tpl.content || tpl);
    // replaced (non-scrolling) keyed nodes get their open/closed state back; a persisted scroller is already where
    // the reader left it, and is only written when it must move (pinned to the bottom as a tail grows)
    restoreUiState(q(), st);
}
// Every request has a timeout and never throws: a fetch left hanging (a dashboard restart mid-response,
// a flaky hotspot/tunnel) used to leave the Live view's poll stuck forever, showing only "last poll
// 9 min ago" (Kyle, 2026-09-25). Errors come back as { error, errorKind } so views can say WHY.
export async function api(url, opts, timeoutMs = 20000) {
    const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const to = ctl ? setTimeout(() => ctl.abort(), timeoutMs) : null;
    try {
        const r = await fetch(url, { ...(opts || {}), ...(ctl ? { signal: ctl.signal } : {}) });
        let j; try { j = await r.json(); } catch { j = { error: `${r.status} ${r.statusText}` }; }
        if (!r.ok && !j.error) j.error = `${r.status} ${r.statusText}`;
        if (r.status === 401) j.errorKind = 'auth';
        return j;
    } catch (e) {
        return { error: e && e.name === 'AbortError' ? `no answer from the dashboard in ${Math.round(timeoutMs / 1000)} s` : `can't reach the dashboard (${(e && e.message) || e})`, errorKind: 'network' };
    } finally { if (to) clearTimeout(to); }
}
// The Models catalog, held ONCE for the whole page (2026-10-06, Kyle: "it still seems unnecessary and surprising that
// the models page is a relatively heavy load"). The Models tab, the launch panel's model and profile pickers, Auto
// queue and the codebench master list each fetched their own 1.7 MB copy and fitted it again. Now they share this
// store: one request at a time, and a request that only asks "is mine still current" -- the server's ETag goes back
// as If-None-Match and a 304 hands every caller the SAME object as before. That identity is the contract: a view
// that kept the last object knows nothing changed (and skips its redraw), and the strength fit is cached per object
// (ui/shared/leaderboard.js fitFor). Lives here because the public site serves this file (it has no ETag: every
// answer there is a new object, as before).
//   load({ maxAgeMs, onProgress }) -> { catalog } | { error, status }     maxAgeMs: an answer this recent is reused without asking
// onProgress (2026-10-22, the Results page's loading bar): called with { phase: 'data', loaded, total } as the bytes
// arrive -- total is the server's X-Body-Length (the DECODED size: the body is brotli/gzip on the wire and a stream reader
// counts decoded bytes, so Content-Length would overshoot; Cloudflare drops it anyway), null when the answer did not
// say -- then { phase: 'parse' } just before the JSON is parsed. It may return a promise (a chance to paint) that is
// awaited first. Every caller sharing the request in flight is told, also one that joins after another caller (a
// picker, at page start) began it: so the body is always read as a stream where the browser offers one.
export function createCatalogStore(fetchFn, url = '/api/models/catalog', now = Date.now) {
    let value = null, etag = null, at = 0, busy = null;
    const listeners = new Set();
    const tell = (p) => Promise.all([...listeners].map((fn) => { try { return fn(p); } catch { return null; } }));
    async function readJson(r) {
        const body = r.body;
        if (!body || typeof body.getReader !== 'function' || typeof TextDecoder === 'undefined') return r.json();
        const total = Number(r.headers && r.headers.get && r.headers.get('X-Body-Length')) || null;
        const reader = body.getReader(), dec = new TextDecoder();
        const parts = []; let loaded = 0;
        await tell({ phase: 'data', loaded, total });
        for (;;) {
            const { done, value: chunk } = await reader.read();
            if (done) break;
            loaded += chunk.byteLength;
            parts.push(dec.decode(chunk, { stream: true }));
            tell({ phase: 'data', loaded, total });   // not awaited: never slow the download down to repaint
        }
        parts.push(dec.decode());
        await tell({ phase: 'parse', loaded, total });
        return JSON.parse(parts.join(''));
    }
    function load({ maxAgeMs = 0, onProgress = null } = {}) {
        if (value && now() - at < maxAgeMs) return Promise.resolve({ catalog: value });
        if (onProgress) { listeners.add(onProgress); }
        if (busy) return onProgress ? busy.finally(() => listeners.delete(onProgress)) : busy;
        busy = (async () => {
            try {
                const r = await fetchFn(url, value && etag ? { headers: { 'If-None-Match': etag } } : undefined);
                if (r.status === 304 && value) { at = now(); return { catalog: value }; }
                if (!r.ok) return { error: `HTTP ${r.status}`, status: r.status, text: await r.text().catch(() => '') };
                let j; try { j = await readJson(r); } catch { return { error: 'bad JSON from ' + url }; }
                if (!j || j.error) return { error: (j && j.error) || 'empty answer from ' + url };
                value = j; etag = (r.headers && r.headers.get && r.headers.get('ETag')) || null; at = now();
                return { catalog: value };
            } catch (e) { return { error: `can't reach the dashboard (${(e && e.message) || e})`, errorKind: 'network' }; }
        })().finally(() => { busy = null; listeners.clear(); });
        return busy;
    }
    return { load, peek: () => value };
}
export const catalogStore = createCatalogStore((u, o) => fetch(u, o));
export const post = (url, body) => api(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
export const btn = 'px-2.5 py-1 rounded border border-gray-700 text-xs text-gray-300 hover:bg-gray-800 hover:border-gray-600';
export const btnPrimary = 'px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-md text-xs font-semibold';
export const input = 'bg-gray-950 border border-gray-700 rounded px-2 py-1 text-xs text-gray-200';
export const th = 'text-left text-[10px] uppercase tracking-wider text-gray-500 font-semibold px-2 py-1 border-b border-gray-800';
export const td = 'px-2 py-1 border-b border-gray-800/60 align-top';
