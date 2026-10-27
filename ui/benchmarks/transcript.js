// Transcript view (plan A5a): one codebench task rendered the way the Interactive tab renders a
// chat -- assistant text, thinking collapsed, tool calls with their input and their output, and
// the markers that explain an outcome (finish reason, compaction, error). Above it sits the task
// context panel: what the model was asked, what the task tests, what must go green, and what a
// weak model usually does instead -- so expectation sits beside outcome on one screen.
//
// Data: GET /api/codebench/transcript?dir=&task=&from=&limit= (normalised events from
// lib/codebench.js) and GET /api/codebench/task?id= (`run.py --show <id> --json`).
// While the task is the one actually running, the view polls from the last index every 3 s and
// APPENDS -- it never re-renders the stream, so an open <details> and the scroll position stay put.
//
// 2026-09-30 (Kyle): the standalone Transcript page is gone from the UI -- "the transcript page is
// mostly a lesser duplicate of the live page". This file is now the renderer LIBRARY the Live view's
// accordions use: createTranscriptView({streamOnly}) is its "Full transcript" accordion (Live draws the
// plan and the task panel itself), renderTaskPanel its "Task" accordion, renderResultDetails (moved here
// from runs.js's old Result tab) its "Scored result" accordion.
import { esc, fmtS, fmtDur, fmtN, fmtPct, xy, xyClass, p2pCell, anomalyChips, statusChip, configLine, api, btn, th, td, setHtml, harnessLabel, createOpenChoices, ARGS_INLINE_MAX, pollEvery } from './util.js';
import { parseTodos, renderTodosHtml } from '../shared/todos.js';

const POLL_MS = 3000;
const PAGE = 400;
// The reader's open / closed blocks, for every transcript view on the page (util.js createOpenChoices: READ ITS RULE
// before changing how this file draws a <details>). Module-level, keyed by battery dir + task + the event's stable
// `key`, so the choices outlive a view being rebuilt (Live empties and recreates its transcript box when it moves to
// another task or battery, even for one poll) and a re-read of the stream from event 0.
const OPEN = createOpenChoices();
const md = (s) => { try { return window.marked ? window.marked.parse(String(s ?? '')) : `<pre class="whitespace-pre-wrap">${esc(s)}</pre>`; } catch { return `<pre class="whitespace-pre-wrap">${esc(s)}</pre>`; } };

// A tool call's one-line summary: the command, the file, or the query -- whichever the runner's
// input names. Every runner spells them differently (opencode bash/command, claude Bash/command
// + file_path, agy run_command/CommandLine + AbsolutePath, pi bash/command + read|edit|write/path),
// so try them all, then fall back to the first short string in the object. SoL-Pi's action fusion
// lets pi's edit / write carry then_run {command}: a validation command run right after the edit,
// whose output comes back in the same result -- so it is named in the summary too.
const SUMMARY_KEYS = ['command', 'CommandLine', 'cmd', 'file_path', 'filePath', 'AbsolutePath', 'TargetFile', 'path', 'filepath',
    'pattern', 'query', 'Query', 'SearchTerm', 'url', 'Url', 'prompt', 'description', 'notebook_path'];
export function toolSummary(inputText) {
    if (!inputText) return '';
    let o = null; try { o = JSON.parse(inputText); } catch { /* not JSON: show the head of it */ }
    if (!o || typeof o !== 'object') return String(inputText).split('\n')[0].slice(0, 200);
    const then = o.then_run && typeof o.then_run === 'object' && typeof o.then_run.command === 'string' && o.then_run.command.trim()
        ? ` → then: ${o.then_run.command.replace(/\s+/g, ' ').trim()}` : '';
    for (const k of SUMMARY_KEYS) {
        const v = o[k];
        if (typeof v === 'string' && v.trim()) return (v.replace(/\s+/g, ' ').trim() + then).slice(0, 240);
    }
    for (const [, v] of Object.entries(o)) if (typeof v === 'string' && v.trim() && v.length < 240) return v.replace(/\s+/g, ' ').trim();
    return Object.keys(o).join(', ').slice(0, 200);
}
const tStamp = (e, approx) => (e.t_s == null ? '' : `<span class="text-[10px] font-mono text-gray-500 shrink-0" title="${approx ? 'estimated: agy stamps no clock, this is the sum of its step durations' : 'seconds since the first transcript line'}">${approx ? '~' : ''}${fmtDur(e.t_s)}</span>`);

// ---------- sub-agents, inline (2026-10-20) ----------
// An opencode run's sub-agent sessions arrive merged into the same event list (lib/codebench.js mergeSubagentEvents):
// their events carry `sub` (the label: "1", "2", nested "2.1") and a `subagent` event opens each one. They are drawn in
// the same flow, indented under a coloured rule with a "sub-agent N" badge; each top-level sub-agent has its own
// colour (inline styles: vendor/tailwind.css is prebuilt and has no classes for these).
const SUB_HUES = ['#2dd4bf', '#f59e0b', '#e879f9', '#38bdf8', '#a3e635', '#fb7185', '#c084fc', '#fdba74'];
export function subHue(label) {
    const n = parseInt(String(label ?? '').split('.')[0], 10);
    return SUB_HUES[(Number.isFinite(n) && n > 0 ? n - 1 : 0) % SUB_HUES.length];
}
const subBadge = (label, extra) => `<span class="px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold" style="color:${subHue(label)};border:1px solid ${subHue(label)}66;background:${subHue(label)}14">sub-agent ${esc(label)}${extra ? ` <span style="opacity:.75;font-weight:400">${esc(extra)}</span>` : ''}</span>`;
function subGroup(label, agent, inner) {
    const hue = subHue(label);
    const depth = String(label).split('.').length;
    return `<div data-sub="${esc(label)}" class="max-w-4xl mx-auto w-full" style="padding-left:${0.6 + 0.9 * (depth - 1)}rem;margin-bottom:.25rem">
        <div style="border-left:3px solid ${hue}99;background:${hue}0d;padding:.25rem 0 .05rem .6rem;border-radius:0 .5rem .5rem 0">
            <div class="mb-1">${subBadge(label, agent)}</div>${inner}</div></div>`;
}

// ---------- one event -> chat markup ----------
// Every <details> here carries data-key = what the event IS (its server `key`), never its index `i`: `i` moves when the
// sub-agent merge re-orders the list, and a key that moves hands the reader's choices to other events (util.js, the
// rule above createOpenChoices). `e.key` is missing only from a dashboard older than 2026-10-22.
// ctx.live (the running task's box in Live): open what the live chat shows open -- arguments up to ARGS_INLINE_MAX,
// every tool output, a sub-agent's prompt, the final message -- so the box reads like the chat it stands in for.
// Thinking stays folded, as it is in the chat once an answer starts. A finished task keeps its compact defaults.
function renderEvent(e, ctx) {
    const approx = !!ctx.approx;
    const live = !!ctx.live;
    const key = `ev:${ctx.dir}:${ctx.task}${ctx.which ? `:${ctx.which}` : ''}:${e.key ?? `i${e.i}`}`;
    const openIf = (on) => (on ? ' open' : '');
    if (e.kind === 'subagent') {
        const head = [e.agent ? `@${e.agent}` : null, e.description || e.title || null].filter(Boolean).join(' — ');
        return `<div class="max-w-4xl mx-auto w-full mb-2 rounded-lg px-3 py-1.5 text-xs" style="border:1px solid ${subHue(e.sub)}66;background:${subHue(e.sub)}12">
            <div class="flex items-center gap-2"><span class="font-mono font-semibold text-[10px] uppercase" style="color:${subHue(e.sub)}">sub-agent ${esc(e.sub)} started</span><span class="text-gray-300 truncate flex-1">${esc(head)}</span>${tStamp(e, approx)}</div>
            ${e.text ? `<details data-key="${esc(key)}:prompt"${openIf(live)}><summary class="text-[10px] text-gray-500 cursor-pointer hover:text-gray-300">its prompt (${fmtN(e.text.length)} chars)</summary><div class="prose prose-invert max-w-none text-xs break-words border border-gray-800 rounded p-2 mt-1 max-h-72 overflow-auto">${md(e.text)}</div></details>` : ''}
        </div>`;
    }
    if (e.kind === 'prompt') return bubble('User', 'border-gray-700 bg-gray-800', 'text-gray-300', e, approx, `<div class="text-sm text-gray-100 whitespace-pre-wrap break-words">${esc(e.text)}</div>`);
    if (e.kind === 'text') return bubble('Assistant', 'border-indigo-900/30 bg-gray-900', 'text-indigo-400', e, approx, `<div class="prose prose-invert max-w-none text-sm break-words">${md(e.text)}</div>`);
    if (e.kind === 'reasoning') {
        const body = e.text || '';
        return `<details data-key="${esc(key)}" class="reasoning-container border border-gray-800 rounded-lg bg-gray-950/50 mb-2 max-w-4xl mx-auto w-full">
            <summary class="flex justify-between px-3 py-1.5 bg-gray-800/30 text-[10px] text-gray-400 border-b border-gray-800 cursor-pointer hover:bg-gray-800/50 list-none">
                <span>🧠 Thinking <span class="text-gray-600">${body ? `~${Math.ceil(body.length / 4)} tokens` : 'redacted by the CLI'}</span></span>${tStamp(e, approx)}
            </summary>
            <div class="text-xs text-gray-500 font-mono p-3 whitespace-pre-wrap break-words max-h-96 overflow-auto">${body ? esc(body) : '<span class="italic">this runner ships the thinking block with its text removed — only the signature survives, so there is nothing to show</span>'}</div>
        </details>`;
    }
    if (e.kind === 'tool_call') {
        const res = ctx.results.get(e.id) || null;
        const failed = !!(res && res.error) || !!e.error;
        const sum = toolSummary(e.input);
        const todos = parseTodos(e.tool, e.input);   // todowrite / TodoWrite / update_plan: the list as a checklist
        if (todos) {
            return `<div class="max-w-4xl mx-auto w-full mb-2">${renderTodosHtml(todos, { name: e.tool, cls: `rounded-lg border ${failed ? 'border-red-900/50' : 'border-indigo-900/60'} bg-gray-950 text-xs min-w-0` })}
                ${failed || !res ? `<div class="px-3 py-1 text-[10px] ${failed ? 'text-red-300' : 'text-yellow-500'}">${failed ? 'this call failed' : 'no result for this call in the transcript'}</div>` : ''}${tStamp(e, approx) ? `<div class="text-right">${tStamp(e, approx)}</div>` : ''}</div>`;
        }
        const spawned = ctx.subCalls && e.id != null ? ctx.subCalls.get(e.id) : null;   // a `task` call that started sub-agent N
        return `<div class="max-w-4xl mx-auto w-full mb-2 border ${failed ? 'border-red-900/50' : 'border-gray-800'} rounded-lg bg-gray-950/40">
            <div class="flex items-center gap-2 px-3 py-1.5 border-b border-gray-800/60">
                <span class="px-1.5 py-0.5 rounded text-[10px] font-mono font-semibold ${failed ? 'bg-red-900/60 text-red-200' : 'bg-gray-800 text-gray-300'}">${esc(e.tool || 'tool')}</span>${spawned ? ` ${subBadge(spawned, '→ inline')}` : ''}
                <code class="text-[11px] text-gray-400 truncate flex-1" title="${esc(sum)}">${esc(sum) || '<span class="text-gray-600">no input recorded</span>'}</code>
                ${failed ? '<span class="text-[10px] text-red-300">failed</span>' : ''}
                ${tStamp(e, approx)}
            </div>
            <div class="px-3 py-1.5 space-y-1">
                ${e.input ? `<details data-key="${esc(key)}:in"${openIf(live && e.input.length <= ARGS_INLINE_MAX)}><summary class="text-[10px] text-gray-500 cursor-pointer hover:text-gray-300">input (${fmtN(e.input.length)} chars)</summary><pre class="mt-1 text-[10px] font-mono text-gray-400 bg-gray-950 border border-gray-800 rounded p-2 max-h-72 overflow-auto whitespace-pre-wrap break-all">${esc(e.input)}</pre></details>` : ''}
                ${res ? renderResultBody(res, key, approx, live) : '<div class="text-[10px] text-yellow-500">no result for this call in the transcript (the run ended mid-call)</div>'}
            </div>
        </div>`;
    }
    if (e.kind === 'tool_result') {   // only reached when its call is on an earlier page
        // its output keyed as its CALL's output (the server's key is the call's + ':result'): drawn under the call
        // after a re-read, it is the same block, still open or closed as the reader left it
        return `<div class="max-w-4xl mx-auto w-full mb-2 border ${e.error ? 'border-red-900/50' : 'border-gray-800'} rounded-lg bg-gray-950/40 px-3 py-1.5">
            <div class="flex items-center gap-2"><span class="text-[10px] text-gray-500">result of an earlier call</span><span class="text-[10px] font-mono text-gray-400">${esc(e.tool || '')}</span>${tStamp(e, approx)}</div>
            ${renderResultBody(e, key.replace(/:result$/, ''), approx, live)}</div>`;
    }
    if (e.kind === 'compaction') return marker('compaction', 'bg-yellow-900/40 text-yellow-200 border-yellow-900/60', 'the context was compacted here — everything before it reached the model as a summary', e, approx, ctx);
    if (e.kind === 'error') return marker('error', 'bg-red-900/40 text-red-200 border-red-900/60', e.text || 'error', e, approx, ctx);
    if (e.kind === 'finish') {
        const tok = e.tokens ? [e.tokens.in != null ? `${fmtN(e.tokens.in)} in` : null, e.tokens.out != null ? `${fmtN(e.tokens.out)} out` : null, e.tokens.thinking ? `${fmtN(e.tokens.thinking)} thinking` : null, e.tokens.cache_read ? `${fmtN(e.tokens.cache_read)} cached` : null].filter(Boolean).join(' · ') : '';
        const bad = e.reason === 'length';
        const turn = !!e.turn && !bad;
        return `<div data-turn="${turn ? '1' : '0'}" class="max-w-4xl mx-auto w-full mb-2 flex items-center gap-2 text-[10px] ${bad ? 'text-orange-300' : 'text-gray-600'}">
            <span class="h-px flex-1 ${bad ? 'bg-orange-900/60' : 'bg-gray-800'}"></span>
            <span>${bad ? 'CUT OFF: the model hit its output limit (finish reason `length`)' : `turn end${e.reason ? ` · ${esc(e.reason)}` : ''}`}${tok ? ` · ${tok}` : ''}</span>
            ${tStamp(e, approx)}<span class="h-px flex-1 ${bad ? 'bg-orange-900/60' : 'bg-gray-800'}"></span>
            ${e.text ? `<details class="w-full" data-key="${esc(key)}"${openIf(live)}><summary class="cursor-pointer">final message</summary><div class="prose prose-invert max-w-none text-sm break-words border border-gray-800 rounded p-2 mt-1">${md(e.text)}</div></details>` : ''}
        </div>`;
    }
    return '';
}
function renderResultBody(r, key, approx, open) {
    const out = r.output;
    if (out == null) return `<div class="text-[10px] ${r.error ? 'text-red-300' : 'text-gray-600'}">${r.error ? 'failed, with no output recorded' : 'no output recorded'}</div>`;
    const lines = out.split('\n').length;
    return `<details data-key="${esc(key)}:out"${open ? ' open' : ''}><summary class="text-[10px] ${r.error ? 'text-red-300' : 'text-gray-500'} cursor-pointer hover:text-gray-300">${r.error ? 'error output' : 'output'} (${fmtN(out.length)} chars, ${fmtN(lines)} lines)</summary><pre class="mt-1 text-[10px] font-mono ${r.error ? 'text-red-200' : 'text-gray-400'} bg-gray-950 border border-gray-800 rounded p-2 max-h-96 overflow-auto whitespace-pre-wrap break-all">${esc(out)}</pre></details>`;
}
function bubble(who, borderCls, whoCls, e, approx, body) {
    return `<div class="msg-wrapper p-4 rounded-xl border ${borderCls} max-w-4xl mx-auto shadow-sm w-full mb-3">
        <div class="flex justify-between items-center mb-2"><div class="text-xs ${whoCls} uppercase tracking-wider">${who}</div>${tStamp(e, approx)}</div>${body}</div>`;
}
function marker(label, cls, text, e, approx) {
    return `<div class="max-w-4xl mx-auto w-full mb-2 border ${cls} rounded-lg px-3 py-1.5 text-xs">
        <div class="flex items-center gap-2"><span class="font-mono font-semibold uppercase text-[10px]">${label}</span>${tStamp(e, approx)}</div>
        ${text ? `<div class="mt-0.5 whitespace-pre-wrap break-words">${esc(text)}</div>` : ''}</div>`;
}

// One page of events -> markup (the transcript view's stream; pure, so the tests can call it). `st` is the view's state:
// {dir, task, which, approx, live, subCalls}; subCalls (task call id -> sub-agent label) is filled in here and kept across pages.
export function renderStream(list, st) {
    const state = st || {};
    // Pair each result with its call so the output sits under the input; a result whose call is
    // on an earlier page renders on its own.
    const results = new Map();
    for (const e of list) if (e.kind === 'tool_result' && e.id != null) results.set(e.id, e);
    const paired = new Set();
    for (const e of list) if (e.kind === 'tool_call' && results.has(e.id)) paired.add(e.id);
    // which `task` call started which sub-agent (kept across pages / polls: the call may arrive after its sub-agent)
    if (!state.subCalls) state.subCalls = new Map();
    for (const e of list) if (e.kind === 'subagent' && e.parent_call && e.sub) state.subCalls.set(e.parent_call, e.sub);
    const ctx = { results, dir: state.dir, task: state.task, which: state.which || null, approx: state.approx, live: !!state.live, subCalls: state.subCalls };
    // consecutive events of one sub-agent share one indented, labelled group
    const out = []; let run = null;
    const flush = () => { if (run) { out.push(subGroup(run.sub, run.agent, run.html.join(''))); run = null; } };
    for (const e of list) {
        if (e.kind === 'tool_result' && paired.has(e.id)) continue;
        const html = renderEvent(e, ctx);
        if (!html) continue;
        if (e.sub && e.kind !== 'subagent') {
            if (!run || run.sub !== e.sub) { flush(); run = { sub: e.sub, agent: e.sub_agent || null, html: [] }; }
            run.html.push(html);
        } else { flush(); out.push(html); }
    }
    flush();
    return out.join('');
}

// ---------- the task context panel ----------
// One hidden-test title's status in a run's per-case results (score.fail_to_pass.cases): the
// runner's name for a case is "file > describe title" (vitest), "title" (TAP) or "file::title"
// (pytest). null = nothing recorded; 'unreported' = recorded, but this title is not among them.
export function matchCase(recorded, title) {
    if (!recorded) return null;
    const t = String(title).trim();
    const hit = recorded.find((c) => c.name === t || c.name.endsWith(' > ' + t) || c.name.endsWith('::' + t) || c.name.endsWith(' ' + t));
    return hit ? hit.status : 'unreported';
}
// Kyle's ask, in his words: "what the prompt is, a summary of what is being tested, the goals it
// has to accomplish, what the expected failure modes are". Four sections, in that order.
export function renderTaskPanel(info, o) {
    const opts = o || {};
    // opts.page: the task's own page (ui/models/task.js), not one run -- no "this run" wording,
    // no per-run record block; per-model case results live in that page's matrix instead.
    const page = !!opts.page;
    if (opts.error) return `<div class="border border-gray-800 rounded-lg p-3 text-xs text-yellow-400">task context unavailable: ${esc(opts.error)} <span class="text-gray-500">(run.py --show)</span></div>`;
    if (!info) return '<div class="border border-gray-800 rounded-lg p-3 text-xs text-gray-500">loading the task context…</div>';
    const level = opts.promptLevel || 'L2';
    const prompts = info.prompts || {};
    const used = prompts[level] ? level : (prompts.L2 ? 'L2' : Object.keys(prompts)[0] || null);
    const others = Object.keys(prompts).filter((k) => k !== used);
    const sec = (title, body, extra) => `<div class="border border-gray-800 rounded-lg p-3">
        <div class="flex items-baseline justify-between gap-2 mb-1.5"><div class="text-[10px] uppercase tracking-wider text-gray-500">${title}</div>${extra || ''}</div>${body}</div>`;
    const kv = (k, v, cls) => (v == null || v === '' ? '' : `<div class="text-xs"><span class="text-gray-500">${esc(k)}</span> <span class="${cls || 'text-gray-200'}">${esc(v)}</span></div>`);

    const promptBody = used
        ? `<div class="text-[10px] text-gray-500 mb-1">level <b class="text-gray-300 font-mono">${esc(used)}</b>${opts.promptLevelSource ? ` <span class="text-gray-600">(${esc(opts.promptLevelSource)})</span>` : ''} — ${page ? (used === 'L2' ? 'the default level: what a model is given unless a battery asks for another' : 'the prompt of this problem: the task asked at this level, a problem of its own') : 'this is what the model was given'}</div>
           <div class="prose prose-invert max-w-none text-sm break-words border border-gray-800 rounded p-2 bg-gray-950/60 max-h-80 overflow-auto" data-key="prompt:${esc(info.id)}">${md(prompts[used])}</div>
           ${info.interface_requirement ? `<div class="mt-2 border border-indigo-900/50 rounded p-2 bg-indigo-950/20"><div class="text-[10px] uppercase tracking-wider text-indigo-300 mb-1">interface requirement</div><div class="prose prose-invert max-w-none text-xs break-words">${md(info.interface_requirement)}</div></div>` : ''}
           ${others.map((k) => `<details class="mt-1" data-key="prompt:${esc(info.id)}:${esc(k)}"><summary class="text-[10px] text-gray-500 cursor-pointer hover:text-gray-300">prompt ${esc(k)}${page ? '' : ' (not used by this run)'}</summary><div class="prose prose-invert max-w-none text-xs break-words border border-gray-800 rounded p-2 mt-1 max-h-64 overflow-auto">${md(prompts[k])}</div></details>`).join('')}`
        : '<div class="text-xs text-gray-500">this task ships no prompt file</div>';

    const testedBody = `${info.probes ? `<div class="text-sm text-gray-200">${esc(info.probes)}</div>` : '<div class="text-xs text-gray-500">no `probes` line in task.yaml</div>'}
        <div class="mt-1.5 flex flex-wrap gap-x-4 gap-y-0.5">
            ${kv('tier', info.tier_predicted || info.tier, 'font-mono text-gray-200')}
            ${kv('variant', info.variant, 'font-mono text-gray-300')}
            ${kv('authored by', info.authored_by, 'font-mono text-gray-300')}
            ${kv('provenance', info.provenance, 'font-mono text-gray-300')}
            ${kv('incident', info.incident_date, 'font-mono text-gray-300')}
            ${kv('repo', info.repo, 'font-mono text-gray-400')}
        </div>
        ${(info.category || []).length ? `<div class="mt-1 flex flex-wrap gap-1">${info.category.map((c) => `<span class="px-1 py-0.5 rounded bg-gray-800 text-gray-400 text-[10px] font-mono">${esc(c)}</span>`).join('')}</div>` : ''}
        ${info.story ? `<div class="mt-2 text-xs text-gray-300 border-l-2 border-gray-700 pl-2 whitespace-pre-wrap">${esc(info.story)}</div>` : ''}`;

    const cases = (info.goals || []).reduce((n, g) => n + g.cases.length, 0);
    // Per-case results, when the run recorded them: match each hidden-test title to the runner's
    // case name ("file > describe > title", "title", "file::title").
    const recorded = Array.isArray(opts.cases) && opts.cases.length ? opts.cases : null;
    const caseStatus = (title) => matchCase(recorded, title);
    const MARK = { pass: ['✓', 'text-green-400'], fail: ['✗', 'text-red-400'], skip: ['↓', 'text-gray-500'], unreported: ['?', 'text-gray-500'] };
    // Against the base (baseline.json): which recorded cases this run turned green ("new") and which
    // base passes it broke ("regressed"). A ✓ with neither tag already passed on the untouched base.
    const prog = opts.progress || null;
    const gainedSet = prog && Array.isArray(prog.gained) ? prog.gained : null;
    const lostSet = prog && Array.isArray(prog.lost) ? prog.lost : null;
    const tagOf = (title) => {
        if (!recorded) return '';
        if (gainedSet && matchCase(gainedSet.map((name) => ({ name, status: 'pass' })), title) === 'pass') return '<span class="ml-1 px-1 rounded bg-green-900/40 text-green-300 text-[9px] font-semibold" title="failed on the untouched base; this run made it pass">new</span>';
        if (lostSet && matchCase(lostSet.map((name) => ({ name, status: 'fail' })), title) === 'fail') return '<span class="ml-1 px-1 rounded bg-yellow-900/50 text-amber-300 text-[9px] font-semibold" title="passed on the untouched base; this run broke it">regressed</span>';
        if (gainedSet && caseStatus(title) === 'pass') return '<span class="ml-1 text-gray-500 text-[9px]" title="already passed on the untouched base: not progress">base</span>';
        return '';
    };
    const mark = (title) => { const st = caseStatus(title); const [ch, cls] = st ? MARK[st] : (page ? ['•', 'text-gray-600'] : ['☐', 'text-gray-600']); return `<span class="${cls} shrink-0" title="${st ? esc(st === 'unreported' ? 'not in the recorded per-case output' : st) : (page ? 'a hidden-test case' : 'not recorded')}">${ch}</span>`; };
    const goalsBody = cases
        ? `${(info.goals || []).map((g) => `<div class="mb-1.5">
                <div class="text-[10px] font-mono text-gray-500">${esc(g.file)}</div>
                <ul class="mt-0.5 space-y-0.5">${g.cases.map((c) => `<li class="text-xs text-gray-300 flex gap-1.5">${mark(c)}<span>${esc(c)}${tagOf(c)}</span></li>`).join('')}</ul></div>`).join('')}
           <div class="text-[10px] text-gray-500 mt-1">${cases} hidden-test case${cases === 1 ? '' : 's'} must go green${info.pass_to_pass != null ? `, and ${info.pass_to_pass} pass_to_pass test${info.pass_to_pass === 1 ? '' : 's'} must keep passing` : ''}. ${page ? (opts.casesNote || '') : opts.live && !recorded
                // the running task (Live, 2026-09-30): nothing is scored yet, which is not "predates per-case recording"
                ? '<span class="text-gray-400">Still running: per-case results arrive when the task is scored.</span>'
                : recorded
                ? `<span class="text-gray-400">Per-case results from this run's scoring: ✓ passed, ✗ failed, ? not in the runner's per-case output.</span>`
                : `<span class="text-yellow-500">This run predates per-case recording (2026-09-25), so only the totals are known; re-grading its stored patch (tools/reoracle.py) would fill this in.</span>`}</div>`
        : '<div class="text-xs text-gray-500">the hidden tests list no parsable case titles</div>';
    // Progress beyond the base first ("+1 of 6 new"): the raw count mostly measures what the base
    // code already passes. Raw stays beside it, smaller.
    const progText = prog && prog.of > 0
        ? `<span class="text-[10px] text-gray-400" title="${esc(`hidden-test cases that FAIL on the untouched base (${prog.of}) and pass in this run (${prog.count})${prog.via === 'totals' ? '; approximate: from the pass counts, not per case (a gain and a loss would cancel)' : ''}${prog.stale ? '; the baseline was recorded for a different version of this task' : ''}`)}">progress beyond base <b class="font-mono ${prog.count > 0 ? 'text-green-300' : 'text-gray-300'}">${prog.exact === false ? '≈' : ''}+${prog.count} of ${prog.of} new</b>${prog.regressions ? ` · <b class="font-mono text-amber-300" title="cases that pass on the untouched base and fail in this run">${prog.regressions} regressed</b>` : ''}${prog.exact === false ? ' <span class="text-gray-600">(approx.)</span>' : ''}</span>`
        : '';
    const goalsExtra = page ? '' : opts.assertions
        ? `${progText}${progText ? ' <span class="text-gray-700">·</span> ' : ''}<span class="text-[10px] text-gray-500">${progText ? 'raw ' : 'assertions '}<b class="font-mono ${xyClass(opts.assertions)}">${xy(opts.assertions)}</b> passed</span>`
        : (progText || '<span class="text-[10px] text-gray-600">assertions not recorded for this run</span>');

    const failBody = `${info.weak_model_failure ? `<div class="text-sm text-gray-200"><span class="text-[10px] uppercase tracking-wider text-gray-500 mr-1">expected</span>${esc(info.weak_model_failure)}</div>` : '<div class="text-xs text-gray-500">no `weak_model_failure` line in task.yaml</div>'}
        ${info.oracle_note ? `<div class="mt-1.5 text-xs text-yellow-300"><span class="text-[10px] uppercase tracking-wider text-gray-500 mr-1">oracle note</span>${esc(info.oracle_note)}</div>` : ''}
        ${page ? '' : `<div class="mt-2 pt-2 border-t border-gray-800">
            <div class="text-[10px] uppercase tracking-wider text-gray-500 mb-1">what this run actually recorded</div>
            ${opts.status ? `<div class="mb-1">${statusChip(opts.status)}</div>` : ''}
            <div>${anomalyChips(opts.anomalies && opts.anomalies.length ? opts.anomalies : null)}</div>
        </div>`}`;

    return `<div class="grid grid-cols-1 lg:grid-cols-2 gap-2">
        ${sec('Prompt', promptBody, `<span class="text-[10px] font-mono text-gray-600">${esc(info.id)}</span>`)}
        ${sec('What is tested', testedBody, info.timeout_s ? `<span class="text-[10px] text-gray-600">cap ${fmtDur(info.timeout_s)}</span>` : '')}
        ${sec('Goals — the hidden tests', goalsBody, goalsExtra)}
        ${page && !info.weak_model_failure && !info.oracle_note ? '' : sec('Expected failure modes', failBody, '')}
    </div>`;
}

// ---------- the view ----------
// opts.streamOnly (Live's "Full transcript" accordion, 2026-09-30): only the status line and the event
// stream -- Live already shows the plan, and the task panel is its own accordion -- and no
// `run.py --show` spawn for a panel that is never drawn.
// opts.live (2026-10-22): this view is the RUNNING task's transcript box in Live, standing in for the live chat (a
// cloud runner, or an opencode run with sub-agents): renderEvent opens what the chat shows open.
export function createTranscriptView(root, viewOpts) {
    const streamOnly = !!(viewOpts && viewOpts.streamOnly);
    const liveBox = !!(viewOpts && viewOpts.live);
    OPEN.watch(root);   // the reader's clicks on summaries, kept by stable key (util.js createOpenChoices)
    // agy emits a turn boundary per LLM turn -- 500 of them in one task. Hidden by default; a
    // `length` cut-off is never hidden, because that one explains an outcome.
    let showTurns = false;
    let state = null;   // {dir, task, events[], stats, total, next_from, truncated, approx, poll}
    let timer = null;
    let infoCache = new Map();

    function stop() { if (timer) { timer.stop(); timer = null; } }

    async function open(o) {
        stop();
        state = { which: o.which === 'verify' ? 'verify' : null, dir: o.dir, task: o.task, taskId: o.taskId || o.task.replace(/__r\d+$/, ''), events: [], stats: null, total: 0, next_from: 0, truncated: false, approx: false, running: false, live: liveBox, info: null, infoError: null, meta: o, loading: true };
        render();
        if (!streamOnly) loadInfo();
        await loadPage(0, true);
        if (state && state.running) timer = pollEvery(pollTail, POLL_MS);   // a running task's tail; nothing while the page is hidden
    }
    async function loadInfo() {
        const id = state.taskId;
        if (infoCache.has(id)) { state.info = infoCache.get(id); render(); return; }
        const j = await api(`/api/codebench/task?id=${encodeURIComponent(id)}`);
        if (!state || state.taskId !== id) return;
        if (j.error) state.infoError = j.error; else { infoCache.set(id, j); state.info = j; }
        render();
    }
    async function loadPage(from, replace) {
        const j = await api(`/api/codebench/transcript?dir=${encodeURIComponent(state.dir)}&task=${encodeURIComponent(state.task)}&from=${from}&limit=${PAGE}${state.which ? `&which=${state.which}` : ''}`);
        if (!state) return;
        state.loading = false;
        if (j.error) { state.error = j.error; render(); return; }
        state.stats = j.stats; state.total = j.total; state.truncated = j.truncated; state.next_from = j.next_from;
        state.runner = j.runner; state.scaffold = j.scaffold || null; state.transcript = j.transcript; state.note = j.note; state.running = !!j.running; state.subagents = j.subagents || null;
        state.approx = !!(j.stats && j.stats.t_approx);
        if (replace) state.events = j.events.slice(); else state.events = state.events.concat(j.events);
        render();
    }
    // The running task: ask only for what we do not have and APPEND, so the stream does not jump.
    async function pollTail() {
        if (!state || !state.running) { stop(); return; }
        const from = state.next_from;
        const j = await api(`/api/codebench/transcript?dir=${encodeURIComponent(state.dir)}&task=${encodeURIComponent(state.task)}&from=${from}&limit=${PAGE}${state.which ? `&which=${state.which}` : ''}`);
        if (!state || j.error) return;
        state.stats = j.stats; state.total = j.total; state.next_from = j.next_from; state.running = !!j.running; state.subagents = j.subagents || state.subagents || null;
        if (!state.running) stop();
        // a finished run with sub-agents is re-ordered once on the server (full time order): read it again from the top.
        // RE-RENDER SITE: every block is drawn again, and most events now sit at another `i` -- the reader's open blocks
        // come back from OPEN by their stable keys in render() (util.js createOpenChoices, rule 3).
        if (!state.running && state.subagents) { await loadPage(0, true); return; }
        if (!j.events.length) { updateStatusLine(); return; }
        state.events = state.events.concat(j.events);
        const stream = root.querySelector('[data-stream]');
        if (stream) {
            // Follow the tail only if the reader is already at the bottom; someone reading an
            // earlier tool output must not be yanked down every 3 s.
            const wrap = root.querySelector('[data-streamwrap]');
            const atBottom = wrap ? wrap.scrollTop + wrap.clientHeight >= wrap.scrollHeight - 24 : false;
            stream.insertAdjacentHTML('beforeend', renderEvents(j.events));
            OPEN.applyAll(stream);   // new blocks: the reader's earlier choice for the same event, if any (rule 3)
            applyTurnFilter(); updateStatusLine();
            if (wrap && atBottom) wrap.scrollTop = wrap.scrollHeight;
        } else render();
    }
    function updateStatusLine() {
        const el = root.querySelector('[data-statusline]');
        if (el) el.innerHTML = statusLine();
    }
    function statusLine() {
        const s = state.stats || {};
        const bits = [
            `<span class="font-mono text-gray-300">${esc(harnessLabel(state.runner, state.scaffold) || '?')}</span>`,
            `${fmtN(state.events.length)} of ${fmtN(state.total)} events`,
            s.tool_calls != null ? `${fmtN(s.tool_calls)} tool calls${s.tool_errors ? ` <span class="text-red-300">(${s.tool_errors} failed)</span>` : ''}` : null,
            s.tokens_out != null ? `${fmtN(s.tokens_in)} in / ${fmtN(s.tokens_out)} out tokens` : null,
            s.duration_s != null ? `spans ${state.approx ? '~' : ''}${fmtDur(s.duration_s)}` : null,
            s.compactions ? `<span class="text-yellow-300">${s.compactions} compaction(s)</span>` : null,
            s.malformed ? `<span class="text-gray-500">${s.malformed} malformed line(s) skipped</span>` : null,
            s.pending_bytes ? `<span class="text-gray-500">${fmtN(s.pending_bytes)} bytes of a half-written line held back</span>` : null,
            state.subagents && state.subagents.sub_agents ? `<span title="${esc(state.subagents.file || '')}">${fmtN(state.subagents.sub_agents)} sub-agent${state.subagents.sub_agents === 1 ? '' : 's'} inline (${fmtN(state.subagents.events)} events)</span>` : null,
            state.running ? '<span class="text-indigo-300 animate-pulse">live — polling every 3 s</span>' : null,
        ].filter(Boolean);
        return bits.join(' <span class="text-gray-700">·</span> ');
    }
    function renderEvents(list) { return renderStream(list, state); }
    function render() {
        if (!state) { setHtml(root, ''); return; }
        const m = state.meta || {};
        const panel = streamOnly ? '' : renderTaskPanel(state.info, {
            promptLevel: m.promptLevel, promptLevelSource: m.promptLevelSource,
            assertions: m.assertions, anomalies: m.anomalies, status: m.status, error: state.infoError, cases: m.cases, progress: m.progress,
        });
        const body = state.loading ? '<div class="text-xs text-gray-500">reading the transcript…</div>'
            : state.error ? `<div class="text-xs text-red-300">${esc(state.error)}</div>`
                : (!state.events.length ? `<div class="text-xs text-gray-500">${esc(state.note || 'this task has no transcript on disk')}</div>` : renderEvents(state.events));
        // The run's plan, pinned above the transcript: every todo-list version the model wrote,
        // newest by default (Kyle, 2026-09-25: plans must be tracked, not only seen inline).
        const plans = (state.events || []).filter((e) => e.kind === 'tool_call' && !e.sub).map((e) => parseTodos(e.tool, e.input)).filter(Boolean);   // a sub-agent's todo list is not the run's plan
        if (state.planRev == null || state.planRev < 0 || state.planRev >= plans.length) state.planRev = plans.length - 1;
        const planHtml = streamOnly ? '' : plans.length ? `<div class="border border-indigo-900/60 rounded-lg p-2">
                <div class="flex flex-wrap items-center gap-1 mb-1 text-[10px] text-gray-400"><span class="uppercase tracking-wider text-gray-500 mr-1">plan</span>${plans.length > 1 ? plans.map((_, i) => `<button type="button" data-plan-rev="${i}" class="px-1.5 rounded border ${i === state.planRev ? 'border-indigo-500 text-indigo-200' : 'border-gray-700 text-gray-400'}">v${i + 1}${i === plans.length - 1 ? ' (final)' : ''}</button>`).join('') : '<span class="text-gray-500">one version</span>'}${state.truncated ? '<span class="text-gray-600 ml-1">(from the events loaded so far)</span>' : ''}</div>
                ${renderTodosHtml(plans[state.planRev], { name: plans.length > 1 ? `plan · v${state.planRev + 1} of ${plans.length}` : 'plan', cls: 'rounded-md border border-indigo-800 bg-gray-950 text-xs min-w-0 max-h-64 overflow-auto' })}</div>` : '';
        setHtml(root, `
            <div class="space-y-2">
                ${planHtml}
                ${state.which === 'verify' ? '<div class="border border-yellow-700/60 rounded-lg px-3 py-1.5 text-xs text-yellow-300 bg-yellow-900/20">Verify follow-up transcript: the extra "verify your work" turn after this run scored fail. Side experiment — its outcome is not counted in mainline results. The goals below show the re-scored (after-verify) cases.</div>' : ''}
                ${panel}
                <div class="flex flex-wrap items-center gap-2 text-[10px] text-gray-400 border-t border-gray-800 pt-2">
                    <span class="uppercase tracking-wider text-gray-500">transcript</span>
                    <span data-statusline>${statusLine()}</span>
                    <label class="flex items-center gap-1 cursor-pointer ml-auto"><input type="checkbox" data-act="turns" class="accent-indigo-500"> show turn boundaries</label>
                    ${state.transcript ? `<span class="font-mono text-gray-600 truncate max-w-full" title="${esc(state.transcript)}">${esc(state.transcript)}</span>` : ''}
                </div>
                <div data-key="stream:${esc(state.dir)}:${esc(state.task)}" class="max-h-[70vh] overflow-auto pr-1" data-streamwrap>
                    <div data-stream class="pt-1">${body}</div>
                    ${state.truncated ? `<div class="text-center py-2"><button type="button" class="${btn}" data-act="more">load the next ${PAGE} events (${fmtN(Math.max(0, state.total - state.next_from))} left)</button></div>` : ''}
                </div>
            </div>`);
        // RE-RENDER SITE (a load, a re-read from event 0, a plan switch, a page appended): setHtml keeps what it can, but
        // any block drawn new starts from its default -- put the reader's choices back by stable key (util.js rule 3).
        OPEN.applyAll(root);
        applyTurnFilter();
        root.querySelector('[data-act=more]')?.addEventListener('click', async (ev) => { ev.currentTarget.disabled = true; await loadPage(state.next_from, false); });
        for (const bt of root.querySelectorAll('[data-plan-rev]')) bt.addEventListener('click', () => { state.planRev = +bt.dataset.planRev; render(); });
        const cb = root.querySelector('[data-act=turns]');
        if (cb) { cb.checked = showTurns; cb.addEventListener('change', () => { showTurns = cb.checked; applyTurnFilter(); }); }
    }
    function applyTurnFilter() {
        for (const el of root.querySelectorAll('[data-turn="1"]')) el.classList.toggle('hidden', !showTurns);
    }

    // The result JSON arrives after the transcript does: update the context panel in place.
    function setMeta(m) { if (!state) return; state.meta = { ...state.meta, ...m }; render(); }
    return { open, setMeta, close: () => { stop(); state = null; setHtml(root, ''); }, stop, get state() { return state; } };
}

// ---------- the scored result (Live's "Scored result" accordion) ----------
// Moved from runs.js's Result tab on 2026-09-30, unchanged but for its name: the outcome chips, the
// timeline / run / server+setup boxes, the hidden-test and pass_to_pass output tails, the patch, who
// actually served the run, and the raw transcript tail. `j` is GET /api/codebench/result.
export function renderResultDetails(j) {
    const x = j.row; const d = j.result || {}; const tl = d.timeline || {}; const run = d.run || {};
    // Every key that holds seconds is a duration: no bare "3497.4" anywhere in this tab.
    const isDur = (k) => /(_s|_secs|_seconds)$/.test(k) || k === 'cap_used' || k === 'secs';
    const kv = (o, keys) => keys.filter((k) => o[k] !== undefined && o[k] !== null).map((k) => `<div><span class="text-gray-500">${esc(k)}</span> <span class="font-mono text-gray-200">${esc(typeof o[k] === 'number' && isDur(k) ? fmtDur(o[k]) : (typeof o[k] === 'object' ? JSON.stringify(o[k]) : o[k]))}</span></div>`).join('');
    const pre = (s, cls = '', key = '') => `<pre${key ? ` data-key="${esc(key)}"` : ''} class="text-[10px] font-mono text-gray-300 bg-gray-950 border border-gray-800 rounded p-2 max-h-[40vh] overflow-auto whitespace-pre-wrap ${cls}">${esc(s ?? '')}</pre>`;
    return `
        <div class="mt-2 flex flex-wrap items-center gap-3 text-xs">
            ${statusChip(x.status, x.status_derived)} ${x.solved_at_cap ? '<span class="text-yellow-300">solved at cap (censored)</span>' : ''} ${x.hit_timeout ? '<span class="text-orange-300">hit timeout</span>' : ''}
            <span class="text-gray-400" title="hidden-test (fail_to_pass) assertions passed / total">hidden <b class="font-mono ${xyClass(x.assertions)}">${xy(x.assertions)}</b>${x.assertions && x.assertions.failed ? ` <span class="text-red-300">(${x.assertions.failed} failed)</span>` : ''}</span>
            <span class="text-gray-400" title="pass_to_pass assertions passed / total">p2p <b class="font-mono">${p2pCell(x)}</b></span>
            <span class="text-gray-400" title="score.partial">partial <b class="font-mono text-gray-200">${fmtPct(x.partial)}</b></span>
            <span class="text-gray-400 ${x.tests_run === 0 ? 'text-yellow-400' : ''}" title="tests_run: how often the model ran tests itself">tests run <b class="font-mono text-gray-200">${x.tests_run ?? '—'}</b></span>
            <span class="text-gray-400">wall <b class="font-mono text-gray-200">${fmtS(x.wall_s)}</b> / cap ${fmtS(x.cap_s)}</span>
            <span class="text-gray-400">tokens in/out <b class="font-mono text-gray-200">${fmtN(x.tokens_in)} / ${fmtN(x.tokens_out)}</b></span>
            <span class="text-gray-400">tool calls <b class="font-mono text-gray-200">${fmtN(x.tool_calls)}</b></span>
            <span class="text-gray-400">anomalies ${anomalyChips(x.anomalies)}</span>
        </div>
        <div class="text-xs text-gray-300 mt-1">${configLine(j.config, j.server)}</div>
        <div class="grid grid-cols-1 md:grid-cols-3 gap-3 mt-3 text-xs">
            <div class="border border-gray-800 rounded-lg p-2 space-y-0.5"><div class="text-[10px] uppercase tracking-wider text-gray-500 mb-1">timeline (edits = tool + shell)</div>
                <div><span class="text-gray-500">edits</span> <span class="font-mono text-gray-200">${x.edits}</span> <span class="text-gray-500">(${x.tool_edits} tool + ${x.shell_edits} shell)</span></div>
                ${kv(tl, ['first_edit_s', 'last_edit_s', 'first_tool_s', 'last_tool_s', 'tests_run', 'first_test_s', 'last_test_s', 'verified_before_done', 'tested_after_last_edit', 'steps', 'compactions', 'length_cutoffs', 'edit_errors', 'end_s', 'completed', 'format'])}
            </div>
            <div class="border border-gray-800 rounded-lg p-2 space-y-0.5"><div class="text-[10px] uppercase tracking-wider text-gray-500 mb-1">run</div>${kv(run, ['wall_s', 'exit_code', 'tool_errors', 'tokens_in', 'tokens_out'])}${kv(d, ['runner', 'model', 'variant', 'cap_used', 'rescored'])}${kv(d.score || {}, ['edit_attempts', 'edit_failures', 'changed'])}</div>
            <div class="border border-gray-800 rounded-lg p-2 space-y-0.5"><div class="text-[10px] uppercase tracking-wider text-gray-500 mb-1">server / setup</div>${kv(j.server || {}, ['devices', 'n_ctx', 'model_path', 'build_info', 'build_path', 'flags', 'agent', 'note'])}${kv(d.setup || {}, ['cmd', 'exit_code'])}</div>
        </div>
        <div class="mt-3 text-[10px] uppercase tracking-wider text-gray-500">hidden tests (fail_to_pass) — ${esc((d.score && d.score.fail_to_pass && d.score.fail_to_pass.cmd) || '')}</div>
        ${pre(j.test_tail.fail_to_pass ?? '(no output tail recorded)', '', 'f2p')}
        ${j.test_tail.pass_to_pass ? `<div class="mt-2 text-[10px] uppercase tracking-wider text-gray-500">pass_to_pass</div>${pre(j.test_tail.pass_to_pass, '', 'p2p')}` : ''}
        ${d.score && d.score.patch ? `<details class="mt-2" data-key="patch"><summary class="text-[10px] uppercase tracking-wider text-gray-500 cursor-pointer">patch (${esc(String(d.score.patch).split('\n').length)} lines)</summary>${pre(d.score.patch, '', 'patch-pre')}</details>` : ''}
        ${modelsUsed(run)}
        <div class="mt-3 text-[10px] uppercase tracking-wider text-gray-500">raw transcript tail — last ${j.transcript_tail ? j.transcript_tail.length : 0} lines of <span class="font-mono normal-case">${esc(j.transcript || 'none')}</span> <span class="normal-case text-gray-600">(the Full transcript accordion renders this properly)</span></div>
        ${pre(j.transcript_tail ? j.transcript_tail.join('\n') : '(no transcript found)', 'max-h-[60vh]', 'transcript')}`;
}
// Who actually served the run, from the CLI's own modelUsage (run.models_used). This is the
// authoritative record of the scaffold: a whole battery once ran with an unnoticed Fable
// advisor on rows labelled with one model. Haiku appears for background work regardless.
export function modelsUsed(run) {
    const mu = run && run.models_used;
    if (!mu || typeof mu !== 'object' || !Object.keys(mu).length) return run && run.scaffold ? `<div class="mt-3 text-[10px] text-gray-500">scaffold <span class="font-mono text-gray-300">${esc(run.scaffold)}</span> · no per-model usage recorded for this run</div>` : '';
    const rows = Object.entries(mu).map(([m, u]) => `<tr>
        <td class="${td} font-mono text-gray-200">${esc(m)}</td>
        <td class="${td} text-right font-mono">${fmtN((u || {}).inputTokens)}</td>
        <td class="${td} text-right font-mono">${fmtN((u || {}).outputTokens)}</td>
        <td class="${td} text-right font-mono">${(u || {}).costUSD != null ? `$${Number(u.costUSD).toFixed(4)}` : '—'}</td></tr>`).join('');
    return `<div class="mt-3 text-[10px] uppercase tracking-wider text-gray-500">models that actually served this run${run.scaffold ? ` — scaffold <span class="font-mono normal-case text-gray-300">${esc(run.scaffold)}</span>` : ''}</div>
        <table class="w-full text-xs mt-1"><thead><tr><th class="${th}">model</th><th class="${th} text-right">tokens in</th><th class="${th} text-right">tokens out</th><th class="${th} text-right">cost</th></tr></thead><tbody>${rows}</tbody></table>
        <div class="text-[10px] text-gray-500 mt-0.5">From the CLI's own <code>modelUsage</code>. A second model here is the scaffold, not the model under test — Haiku appears for background work whatever the scaffold, so only a non-Haiku extra means delegation.</div>`;
}
