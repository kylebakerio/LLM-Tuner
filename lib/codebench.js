'use strict';
// --- CODEBENCH (quality benchmarks) -- plugin seam to ~/code/codebench ---
// codebench is a separate CLI (harness/run.py). This module spawns it, reads
// the NDJSON event stream it emits with --json (harness/EVENTS.md, v1), and
// indexes the result files it writes. It NEVER writes into the codebench tree:
// the only thing that lands there is what run.py itself writes under --out.
//
// Config: dashboard.config.json  "codebench": { "root": "...", "python": "python3" }
//   root   defaults to ~/code/codebench   (results live at <root>/results)
//   python defaults to python3
//
// Result JSON shape (results/<battery>/<task>.json), as written by run.py + score.py:
//   task, runner, model, run{wall_s,tokens_in,tokens_out,tool_calls,transcript,exit_code},
//   score{solved,fail_to_pass{output_tail,...},pass_to_pass,patch,...}, status, anomalies[],
//   timeline{first_edit_s,last_edit_s,edits,shell_edits,tests_run,...}, hit_timeout,
//   solved_at_cap, cap_used, server{model_path,build_info,n_ctx,devices,launch_command,...},
//   manifest (absent on every result to date -- read when present, never required).
// Status vocabulary (harness/status.py): pass, pass*, TIMEOUT, OVERFLOW, KILLED, PROVIDER_ERROR,
// ABORTED, fail. The last four leave the denominator of x/y: they are not model answers.
//
// Edits are ALWAYS edits + shell_edits: Claude Code edits through Bash (sed -i, heredocs),
// so a tool-call-only count reads it as never editing.
const { spawn: realSpawn, spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_FILE = path.join(__dirname, '..', 'dashboard.config.json');
const DEFAULT_ROOT = path.join(os.homedir(), 'code', 'codebench');
const DEFAULT_LOCK = '/tmp/codebench-lldash.lock';
const DEFAULT_CAP_S = 7200;   // harness/status.py DEFAULT_CAP; 2 h since 2026-09-23
// harness/status.py: EXCLUDED leaves the x/y denominator -- none of these is a model answer.
// PROVIDER_ERROR and ABORTED joined the vocabulary on 2026-09-22 (ABORTED is what stop-now
// records for the task in flight, which is why it must never read as a failure the model earned).
// CAP_TOO_LOW joined 2026-09-23: a timeout under a cap below the current 2 h standard never
// had the budget the rest of the corpus is judged against, so it is not a model answer either.
const EXCLUDED = new Set(['OVERFLOW', 'KILLED', 'PROVIDER_ERROR', 'ABORTED', 'CAP_TOO_LOW', 'HARNESS_ERROR', 'CONTAMINATED', 'TASK_INVALID', 'CUTOFF']);
const SOLVED = new Set(['pass', 'pass*']);
const STATUS_ORDER = ['pass', 'pass*', 'TIMEOUT', 'OVERFLOW', 'KILLED', 'PROVIDER_ERROR', 'ABORTED', 'CAP_TOO_LOW', 'HARNESS_ERROR', 'CONTAMINATED', 'TASK_INVALID', 'CUTOFF', 'fail'];
const RUNNERS = ['opencode', 'claude', 'agy', 'pi', 'tau', 'jeff'];
// tau is a Claude Code fork: its tau.jsonl is Claude stream-json, read by the claude adapter.
// Jeff-Code is a pi fork: its jeff.jsonl is pi's JSON event stream, read by the pi adapter.
const FORMAT_OF = (r) => (r === 'tau' ? 'claude' : r === 'jeff' ? 'pi' : r);
// pi's own line types (pi --mode json, docs/json.md) plus the two harness/runners/pi.py writes itself
// (stderr, codebench). None of them collides with claude's assistant|user|system|result.
const PI_TYPES = new Set(['session', 'agent_start', 'agent_settled', 'turn_start', 'message_end', 'tool_execution_start', 'tool_execution_end',
    'compaction_start', 'compaction_end', 'auto_retry_start', 'auto_retry_end', 'queue_update', 'entry_appended', 'stderr', 'codebench']);
const PROMPT_LEVELS = ['L1', 'L2', 'L3'];
const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];   // claude CLI --effort, via CODEBENCH_CLAUDE_EFFORT
// Scaffold: who else serves the run beside the named model (harness/runners/claude.py).
//   solo            --disallowedTools Agent + CLAUDE_CODE_DISABLE_ADVISOR_TOOL=1: exactly one model
//   default         inherits ~/.claude/settings.json, which TODAY means a Fable advisor
//   advisor:<model> per-invocation --settings {"advisorModel":"<model>"}
// A config is not a model name: every claude row before this axis existed was silently
// "main model + Fable advisor" (one session billed 1.43M input tokens of Fable on an Opus row).
const SCAFFOLDS = ['solo', 'default'];
// pi's scaffold is its extension set (harness/runners/pi.py, CODEBENCH_PI_EXT): none = plain pi,
// sol-pi = + NVIDIA's SoL-Pi with its reducer on the SAME local model. Recorded as the row's scaffold.
const PI_SCAFFOLDS = ['none', 'sol-pi'];
const SCAFFOLD_ADVISORS = ['fable', 'opus', 'sonnet', 'haiku'];
const EVENT_VERSION = 1;
const TRANSCRIPT_TAIL_LINES = 200;
const MAX_TRANSCRIPT_LINE = 4000;   // chars; a transcript line can be a whole file read

let overrides = {};          // configure() for tests
function configure(o) { overrides = o || {}; return getConfig(); }
function getConfig() {
    let c = {};
    try { c = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8')).codebench || {}; } catch { /* absent or unparsable: defaults */ }
    const root = overrides.root || c.root || DEFAULT_ROOT;
    return {
        root: root.replace(/^~(?=$|\/)/, os.homedir()),
        python: overrides.python || c.python || 'python3',
        // Shell sessions serialise batteries with `flock <lock> python3 harness/run.py ...`; start()
        // takes the same lock non-blocking so the two never overlap. '' disables it.
        lock: overrides.lock !== undefined ? overrides.lock : (c.lock !== undefined ? c.lock : DEFAULT_LOCK),
    };
}
const resultsRoot = (root) => path.join(root || getConfig().root, 'results');

// ---------- status helpers ----------
function deriveStatus(d) {
    // A retired task (task.yaml `retired: true`) is no longer part of the suite: whatever its old
    // results said, they are not model answers any more -- excluded everywhere, like TASK_INVALID.
    if (d && d.task && retiredTasks().has(String(d.task).replace(/__r\d+$/, ''))) return { status: 'TASK_INVALID', derived: true };
    // The on-disk `status` is authoritative (OVERFLOW/KILLED need the transcript; only
    // score.py's rescoring can say them). Older results lack it; derive the cheap part.
    if (d.status && STATUS_ORDER.includes(d.status)) return { status: d.status, derived: false };
    const solved = !!(d.score && d.score.solved);
    const timeout = !!d.hit_timeout || ((d.run || {}).exit_code === -1);
    if (solved) return { status: timeout ? 'pass*' : 'pass', derived: true };
    // Mirrors harness/status.py: a timeout that landed short of today's cap ran under a smaller
    // one, so it is CAP_TOO_LOW rather than a miss the model earned.
    const cap = num(d.cap_used) || ((d.manifest || {}).timeout_s) || DEFAULT_CAP_S;
    const wall = num((d.run || {}).wall_s) || 0;
    if (timeout && (cap < DEFAULT_CAP_S - 5 || wall < DEFAULT_CAP_S - 5)) return { status: 'CAP_TOO_LOW', derived: true };
    return { status: timeout ? 'TIMEOUT' : 'fail', derived: true };
}
const editsOf = (tl) => ((tl && tl.edits) || 0) + ((tl && tl.shell_edits) || 0);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// What identifies the run: manifest when present, else the top-level fields the harness
// wrote. `server.devices` (from LL-Dash's launchCommand) is the backend identity that
// build_info alone cannot give -- show it wherever config is shown.
function configOf(d) {
    const m = d.manifest || {};
    const server = m.server || d.server || null;
    const cfg = {
        runner: m.runner || d.runner || null,
        model: m.model || d.model || null,
        prompt_level: m.prompt_level || null,
        harness_mode: m.harness_mode || null,
        network: m.network || null,
        timeout_s: num(m.timeout_s) ?? num(d.cap_used),
        runner_version: m.runner_version || null,
        image: m.image || null,
        // Recorded by the runner, not by run.py: claude writes run.scaffold, and the effort ends
        // up in server.agent ("... , CODEBENCH_CLAUDE_EFFORT=high"). Both are axes of the config.
        scaffold: (d.run || {}).scaffold || m.scaffold || null,
        effort: m.effort || ((/CODEBENCH_CLAUDE_EFFORT=([\w-]+)/.exec((server && server.agent) || '') || [])[1]) || null,
    };
    // THE AGENT'S WINDOW (2026-10-25): harness/agent_window.py records {asked, model, window, compaction_at, server_n_ctx,
    // effective_ctx, action, why} on every result of a local runner (and the 7 Ornith "262k" dirs, backfilled). Carried
    // only when present, so a config read from any other result is what it always was; lib/models.js runDescriptor files
    // the run under its effective_ctx.
    const aw = d.agent_window || m.agent_window;
    if (aw && typeof aw === 'object') cfg.agent_window = aw;
    let srv = null;
    if (server && typeof server === 'object') {
        srv = {};
        // `weights`: the model file's content fingerprint run.py records from 2026-10-15 (lib/weightsid.js)
        for (const k of ['model_path', 'weights', 'build_info', 'build_path', 'build', 'machine', 'n_ctx', 'devices', 'launch_command', 'launch_command_source', 'flags', 'agent', 'note', 'local_server']) {
            if (server[k] !== undefined && server[k] !== null) srv[k] = server[k];
        }
        if (!Object.keys(srv).length) srv = null;
    }
    return { config: cfg, server: srv };
}

function safeName(s) { return typeof s === 'string' && /^[\w.@+-]+$/.test(s) && s !== '.' && s !== '..'; }

// results/<dir>/<task>/<runner>.jsonl first (fixtures, moved trees), then run.transcript.
function transcriptPath(d, dirPath) {
    const task = d.task || '';
    const cands = [];
    if (d.runner) cands.push(path.join(dirPath, task, `${d.runner}.jsonl`));
    try {
        for (const f of fs.readdirSync(path.join(dirPath, task))) if (f.endsWith('.jsonl') && !f.startsWith('verify.')) cands.push(path.join(dirPath, task, f));
    } catch { /* no subdir */ }
    const rt = (d.run || {}).transcript;
    if (rt) cands.push(rt);
    for (const c of cands) { try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ } }
    return null;
}

function readScored(dirPath) {
    // [{file, data, mtimeMs, transcriptMtimeMs}] for every scored JSON in a result dir.
    let files;
    try { files = fs.readdirSync(dirPath); } catch { return []; }
    const out = [];
    for (const f of files.sort()) {
        if (!f.endsWith('.json') || f === 'summary.json') continue;
        const fp = path.join(dirPath, f);
        let st, data;
        try { st = fs.statSync(fp); if (!st.isFile()) continue; data = JSON.parse(fs.readFileSync(fp, 'utf-8')); } catch { continue; }
        if (!data || typeof data !== 'object' || !data.score || typeof data.score !== 'object') continue; // validate-* results, partial writes
        let tMtime = null;
        const tp = transcriptPath(data, dirPath);
        if (tp) { try { tMtime = fs.statSync(tp).mtimeMs; } catch { /* none */ } }
        out.push({ file: f, data, mtimeMs: st.mtimeMs, transcriptMtimeMs: tMtime });
    }
    return out;
}

function taskRow(entry) {
    const d = entry.data; const tl = d.timeline || {}; const run = d.run || {}; const sc = d.score || {};
    const { status, derived } = deriveStatus(d);
    return {
        task: d.task || entry.file.replace(/\.json$/, ''),
        file: entry.file,
        status, status_derived: derived,
        solved: !!sc.solved,
        excluded: EXCLUDED.has(status),
        partial: num(sc.partial),
        ...assertionsOf(sc),
        // cases passed beyond what the untouched base already passes (null: no baseline to compare)
        progress: EXCLUDED.has(status) ? null : progressOf(d, readBaselines().get(String(d.task || entry.file.replace(/\.json$/, '')).replace(/__r\d+$/, ''))),
        wall_s: num(run.wall_s),
        tokens_in: num(run.tokens_in), tokens_out: num(run.tokens_out),
        tool_calls: num(run.tool_calls) ?? num(tl.tool_calls),
        anomalies: Array.isArray(d.anomalies) ? d.anomalies : [],
        first_edit_s: num(tl.first_edit_s), last_edit_s: num(tl.last_edit_s),
        edits: editsOf(tl), tool_edits: num(tl.edits) ?? 0, shell_edits: num(tl.shell_edits) ?? 0,
        tests_run: num(tl.tests_run), verified_before_done: tl.verified_before_done ?? null,
        hit_timeout: !!d.hit_timeout, solved_at_cap: !!d.solved_at_cap,
        // the harness re-sent the original prompt once after an early stop (CODEBENCH_RESEND_ON_EARLY_STOP, 2026-10-18):
        // display only, like solved_at_cap; no status or score reads it
        resent: resentOf(d),
        // a CONTINUATION of an earlier session (resend-v2, 2026-10-19: run.resent_prompt.via "continue-from"): it IS the
        // score of that task; its source is superseded (continuationIndex below)
        continuation: continuationOf(d),
        // the run's question was answered with the original prompt (a re-send at the end of the run, or a continuation):
        // { via, at_s, compactions, asked } -- the cell is dark green when such a run then passed
        answered: answeredOf(d),
        // UNFINISHED (2026-10-19, Kyle): the session ended ASKING the user something and the question was never answered
        // with the original prompt -- out of every tally until it is. From the run itself (run.unfinished, harness
        // early_stop resend-v2); getRun adds the past runs of the annotations index (kind "unfinished") and the session state
        unfinished: unfinishedOf(d),
        cap_s: num(d.cap_used),
        runner: d.runner || null, model: d.model || null,
        // Who ACTUALLY served this run, from the CLI's own modelUsage (claude runner). This is the
        // authoritative record: a whole battery once ran with an unnoticed Fable advisor. Haiku
        // appears here for background work regardless -- that is expected, not delegation.
        // pi records its extension set (none | sol-pi) only in the manifest, never as run.scaffold.
        scaffold: run.scaffold || (d.manifest || {}).scaffold || null,
        models_used: run.models_used && typeof run.models_used === 'object' ? run.models_used : null,
        // This ROW's own config and server. A battery is not one config: a server can be restarted
        // mid-battery (t1r3-swift-redo ran on two), and every result file records what served it.
        rowConfig: configOf(d),
        // When this row ran: the manifest's own stamp (run.py, 2026-09-24 on), else the transcript's
        // mtime, else the result file's (backfill tools preserve it).
        ran_at: ((d.manifest || {}).started_at && Date.parse(d.manifest.started_at))
            || entry.transcriptMtimeMs || (entry.mtimeMs ? entry.mtimeMs - (num(run.wall_s) || 0) * 1000 : null),
        // Which of the three ran_at is (2026-10-18): a transcript's mtime is when the run ENDED, not when it started,
        // so a reader that places the run in time (lib/models.js runSpeed: its request window) must know.
        ran_at_source: ((d.manifest || {}).started_at && Date.parse(d.manifest.started_at)) ? 'manifest'
            : entry.transcriptMtimeMs ? 'transcript_mtime' : entry.mtimeMs ? 'result_mtime' : null,
    };
}

// ---------- bonus tests: one run, two test results (2026-10-14) ----------
// Kyle, 2026-10-14: "the dashboard and database should just consider 'bonus points' as their own second, separate
// tests ... except that one test run can produce two test results." A task.yaml may list `extra_tests:`; score.py
// run_extra() runs them after grading into score.extra = {passed, total, all, ran_any, skill, cases} and never touches
// `solved`. A result whose bonus RAN is read as two rows: its own, and `<task>+bonus` (codebench tools/db-rebuild.py
// writes the same second row into `runs`). The bonus row carries the run's identity and config, its own outcome, and
// none of the run's cost (wall, tokens, tool calls, edits): those are the main row's, so nothing is counted twice.
const BONUS_SUFFIX = '+bonus';
const isBonusTask = (t) => typeof t === 'string' && t.endsWith(BONUS_SUFFIX);
const bonusParent = (t) => (isBonusTask(t) ? t.slice(0, -BONUS_SUFFIX.length) : t);
function extraOf(d) {
    const ex = d && d.score && d.score.extra;
    return ex && typeof ex === 'object' && ex.ran_any ? ex : null;
}
/** The bonus test's own row beside `main` (taskRow of the same entry), or null when the result has no bonus that ran.
 *  Status: the main row's when that is excluded (not a model answer, so neither is its bonus), else pass / fail. */
function bonusRow(entry, main) {
    const ex = extraOf(entry.data); if (!ex) return null;
    const excluded = EXCLUDED.has(main.status);
    const total = num(ex.total), passed = num(ex.passed);
    return {
        ...main,
        task: main.task + BONUS_SUFFIX, bonus: true, parent: main.task, bonus_skill: typeof ex.skill === 'string' ? ex.skill : null,
        status: excluded ? main.status : (ex.all ? 'pass' : 'fail'), status_derived: excluded ? main.status_derived : false,
        solved: !!ex.all, excluded,   // as the main row's `solved` (score.solved): the test's own answer, whatever the status
        partial: total ? (passed || 0) / total : null,
        assertions: total != null ? { passed: passed ?? 0, failed: total - (passed ?? 0), total } : null,
        p2p: null, p2p_broken: null, progress: null,
        wall_s: null, tokens_in: null, tokens_out: null, tool_calls: null, anomalies: [],
        first_edit_s: null, last_edit_s: null, edits: null, tool_edits: null, shell_edits: null,
        tests_run: null, verified_before_done: null, models_used: null,
    };
}
/** taskRow for every result of a dir, each followed by its bonus row when it has one. */
function resultRows(entries) {
    const out = [];
    for (const e of entries) { const r = taskRow(e); out.push(r); const b = bonusRow(e, r); if (b) out.push(b); }
    return out;
}

// Report-card numbers (score.py writes them since 2026-09): hidden-test assertions passed/total,
// pass_to_pass assertions passed/total, and how many p2p files the patch broke. Every one is
// null when the result predates the field -- the UI shows '--', never 0/0.
// ---------- unfinished runs, continuations, superseded sources (resend-v2, 2026-10-19, Kyle) ----------
// Kyle: a run whose session ended ASKING the user something "is retroactively treated as an original condition. Treat
// those rows as unfinished until their question is answered with the original prompt."
//  - UNFINISHED: the session ended asking (harness early_stop resend-v2, ending "question") and the question was never
//    answered with the original prompt. New runs say so themselves (run.unfinished, absent once run.resent_prompt.fired);
//    past runs are listed in <root>/annotations/*.json of kind "unfinished" (lib/annotations.js). Out of EVERY tally:
//    battery summaries, task / case tallies, and (lib/models.js) every catalog figure, fit and "already ran" index.
//  - CONTINUATION: run.resent_prompt.via "continue-from" -- the original prompt re-sent into a saved session. It COUNTS:
//    it is the answer of that task.
//  - SUPERSEDED: the source of a continuation (`continued_from.result`, matched by battery dir + file name; a
//    continuation in an INVALID- battery supersedes nothing). Out of every tally; it shows only as history.
// A re-send at the end of a normal run (via "end of run") answers the question inside the run: the run counts as usual.
// A run that PASSED (pass / pass*) is never unfinished, whatever it ended on (Kyle 2026-10-19: "Yes keep passes and void
// fails"): it counts as its pass, from run.unfinished (an older harness wrote it on passes too) and the index alike.
function isContinuation(d) {
    const rp = d && d.run && d.run.resent_prompt;
    return !!(rp && typeof rp === 'object' && rp.via === 'continue-from');
}
/** -> { src_dir, src_file, at_s, reason, previous_status, previous_wall_s } or null. */
function continuationOf(d) {
    if (!isContinuation(d)) return null;
    const rp = d.run.resent_prompt;
    const cf = d.continued_from && typeof d.continued_from === 'object' ? d.continued_from : {};
    let srcDir = null, srcFile = null;
    if (typeof cf.result === 'string' && cf.result.endsWith('.json')) { srcDir = path.basename(path.dirname(cf.result)); srcFile = path.basename(cf.result); }
    else if (typeof cf.battery === 'string' && cf.battery) { srcDir = path.basename(cf.battery); srcFile = `${d.task || ''}.json`; }
    return { src_dir: srcDir, src_file: srcFile, at_s: num(rp.at_s), reason: rp.reason != null ? String(rp.reason) : null,
        previous_status: cf.previous_status != null ? String(cf.previous_status) : null, previous_wall_s: num(cf.previous_wall_s) };
}

const clipText = (v, n) => { if (typeof v !== 'string' || !v.trim()) return null; const t = v.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const resentFired = (d) => !!(d && d.run && d.run.resent_prompt && d.run.resent_prompt.fired === true);
/** The question was answered with the original prompt -> { via, at_s, compactions, asked } or null. `asked` is the run's
 *  own last message (it can quote the task: lab only). */
function answeredOf(d) {
    if (!resentFired(d)) return null;
    const rp = d.run.resent_prompt;
    if (rp.via !== 'end of run' && rp.via !== 'continue-from') return null;
    return { via: rp.via, at_s: num(rp.at_s), compactions: num(rp.compactions), asked: clipText(rp.final_message, 400) };
}
/** Kyle 2026-10-19 ("keep passes and void fails"): a run that PASSED (status pass / pass*, deriveStatus) but ended asking
 *  is NOT unfinished -- it counts as its pass. Only non-passing runs that ended asking stay unfinished. Judged on the
 *  result's own current status (a re-grade can change it), never on the index's stored one, and on the MAIN result, so a
 *  +bonus row follows its parent. */
const solvedRun = (d) => { try { return !!d && SOLVED.has(deriveStatus(d).status); } catch { return false; } };
/** Can this result be unfinished at all? Not when its question was answered (run.resent_prompt.fired), not when it passed. */
const mayBeUnfinished = (d) => !resentFired(d) && !solvedRun(d);
/** run.unfinished (harness early_stop resend-v2) -> { question, compactions, why, source: 'run' } or null; never when the
 *  question was answered (run.resent_prompt.fired), never when the run passed (solvedRun). */
function unfinishedOf(d) {
    const u = d && d.run && d.run.unfinished;
    if (!u || typeof u !== 'object' || !mayBeUnfinished(d)) return null;
    if (u.ending != null && u.ending !== 'question') return null;
    return { question: clipText(u.question, 600), compactions: num(u.compactions), why: u.why != null ? String(u.why) : null, source: 'run' };
}

/** run.resent_prompt when it FIRED -> { at_s, reason, via, policy }; null when the flag was off or it declined. */
function resentOf(d) {
    const rp = d && d.run && d.run.resent_prompt;
    if (!rp || typeof rp !== 'object' || rp.fired !== true) return null;
    return { at_s: num(rp.at_s), reason: rp.reason != null ? String(rp.reason) : null, via: rp.via != null ? String(rp.via) : null, policy: rp.policy != null ? String(rp.policy) : null };
}
function assertionsOf(sc) {
    const a = sc && sc.assertions && typeof sc.assertions === 'object' ? sc.assertions : null;
    const p = sc && sc.pass_to_pass && typeof sc.pass_to_pass === 'object' ? sc.pass_to_pass : null;
    return {
        assertions: a && num(a.total) != null ? { passed: num(a.passed) ?? 0, failed: num(a.failed) ?? 0, total: a.total } : null,
        p2p: p && num(p.assertions_total) != null && num(p.assertions_passed) != null ? { passed: p.assertions_passed, total: p.assertions_total, ...(p.crashed_after_pass ? { crashed: true } : {}) } : null,
        p2p_broken: sc && Array.isArray(sc.p2p_broken) ? sc.p2p_broken.length : null,
    };
}

// ---------- progress beyond the base (codebench tools/baselines.py, 2026-09-25) ----------
// Most hidden-test cases already pass on the untouched base: 126 of 166 "partial" fails scored exactly
// the base's count. tasks/<repo>/<id>/baseline.json records which cases pass at base_sha; score.py
// (from 2026-09-25) stores `progress` (cases the run turned green) and `regressions` (base passes it
// turned red). Older rows get the same comparison here: per case when the row recorded its cases,
// else from the totals when they match the baseline's (net, so marked approximate).
let baselineCache = { at: 0, root: null, map: null, retired: new Set(), diagnostic: new Set() };
const BASELINE_TTL_MS = 60000;
function readBaselines(root) {
    // TTL first: taskRow calls this per row, and getConfig() reads dashboard.config.json
    if (baselineCache.map && (!root || baselineCache.root === root) && Date.now() - baselineCache.at < BASELINE_TTL_MS) return baselineCache.map;
    const r = root || getConfig().root;
    const map = new Map(), retired = new Set(), diagnostic = new Set();
    const tr = path.join(r, 'tasks');
    let repos = []; try { repos = fs.readdirSync(tr, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { /* none */ }
    for (const repo of repos) {
        let ids = []; try { ids = fs.readdirSync(path.join(tr, repo), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { continue; }
        for (const id of ids) {
            // task.yaml `retired: true`: the task left the suite; its results are TASK_INVALID (deriveStatus)
            // task.yaml `category` with `diagnostic` (2026-10-17): a functional check, not a quality task -- its
            // results are counted apart in a battery's summary (summarize: `diagnostic`), never as solved / scored / fail
            try {
                const y = fs.readFileSync(path.join(tr, repo, id, 'task.yaml'), 'utf-8');
                if (/^retired:\s*['"]?(true|yes|on)['"]?\s*$/mi.test(y)) retired.add(id);
                if (isDiagnosticYaml(y)) { diagnostic.add(id); diagnostic.add(id + '+bonus'); }
            } catch { /* no yaml */ }
            let b; try { b = JSON.parse(fs.readFileSync(path.join(tr, repo, id, 'baseline.json'), 'utf-8')); } catch { continue; }
            if (!b || typeof b !== 'object') continue;
            const cases = new Map();
            for (const c of (Array.isArray(b.cases) ? b.cases : [])) if (c && typeof c.name === 'string') cases.set(c.name, c.status);
            map.set(b.task || id, { task_version: b.task_version || null, passed: num(b.passed), total: num(b.total),
                cases_passed: num(b.cases_passed), cases_total: num(b.cases_total), usable: b.usable !== false, cases });
        }
    }
    baselineCache = { at: Date.now(), root: r, map, retired, diagnostic };
    return map;
}
// `category: [a, diagnostic]` or a block list (`category:` then `- diagnostic`), as lib/models.js parseTaskYaml reads it.
function isDiagnosticYaml(y) {
    const m = /^category:[ \t]*(.*)$/m.exec(String(y || ''));
    if (!m) return false;
    if (m[1].trim()) return m[1].replace(/^\[|\]$/g, '').split(',').map((x) => x.trim().replace(/^['"]|['"]$/g, '')).includes('diagnostic');
    const after = String(y).slice(m.index + m[0].length).split('\n').slice(1);
    for (const l of after) { const b = /^\s*-\s*(.+?)\s*$/.exec(l); if (!b) break; if (b[1].replace(/^['"]|['"]$/g, '') === 'diagnostic') return true; }
    return false;
}
/** Task ids whose task.yaml category says `diagnostic` (and their `+bonus` results); same walk and cache. */
function diagnosticTasks(root) { readBaselines(root); return baselineCache.diagnostic || new Set(); }
/** Task ids whose task.yaml says `retired: true` (same walk and cache as readBaselines). */
function retiredTasks(root) { readBaselines(root); return baselineCache.retired || new Set(); }
// The same comparison as score.py compare_to_baseline(). -> {count, of, regressions, exact, stale,
// via: 'score'|'cases'|'totals', gained?, lost?} or null. `detail` keeps the case-name lists.
function progressOf(d, bl, detail) {
    const sc = (d && d.score) || {};
    const rowVersion = (d && d.manifest && d.manifest.task_version) || null;
    const pr = sc.progress && typeof sc.progress === 'object' ? sc.progress : null;
    if (pr && num(pr.count) != null && num(pr.of) != null) {
        const rg = sc.regressions && typeof sc.regressions === 'object' ? sc.regressions : {};
        return { count: pr.count, of: pr.of, regressions: num(rg.count) ?? 0, exact: pr.exact !== false, stale: !!pr.stale, via: 'score',
            ...(detail ? { gained: Array.isArray(pr.cases) ? pr.cases : null, lost: Array.isArray(rg.cases) ? rg.cases : null } : {}) };
    }
    if (!bl || !bl.usable) return null;
    const stale = !!(rowVersion && bl.task_version && rowVersion !== bl.task_version);
    const f2p = sc.fail_to_pass && typeof sc.fail_to_pass === 'object' ? sc.fail_to_pass : {};
    const now = new Map();
    for (const c of (Array.isArray(f2p.cases) ? f2p.cases : [])) if (c && typeof c.name === 'string') now.set(c.name, c.status);
    const a = assertionsOf(sc).assertions;
    const baseBlank = !bl.cases.size && !bl.passed;
    const nowBlank = !now.size && !(a && a.passed);
    if ((now.size || nowBlank) && (bl.cases.size || baseBlank) && (now.size || bl.cases.size) && (now.size || a)) {
        const names = [...new Set([...bl.cases.keys(), ...now.keys()])];
        const gained = names.filter((n) => now.get(n) === 'pass' && bl.cases.get(n) !== 'pass');
        const lost = names.filter((n) => bl.cases.get(n) === 'pass' && now.get(n) !== 'pass');
        return { count: gained.length, of: names.filter((n) => bl.cases.get(n) !== 'pass').length, regressions: lost.length,
            exact: !stale && !!rowVersion, stale, via: 'cases', ...(detail ? { gained, lost } : {}) };
    }
    if (a && bl.passed != null && bl.total != null && a.total === bl.total && a.total > 0) {
        return { count: Math.max(0, a.passed - bl.passed), of: bl.total - bl.passed, regressions: Math.max(0, bl.passed - a.passed),
            exact: false, stale, via: 'totals' };
    }
    return null;
}

function summarize(dir, dirPath, entries, skip = null) {
    const counts = {}; for (const s of STATUS_ORDER) counts[s] = 0;
    let solved = 0, scored = 0, excluded = 0, derived = 0, anomalies = 0;
    // diagnostic tasks (2026-10-17): their results are their own tally, out of counts / solved / scored / excluded
    const diag = { results: 0, passed: 0, tasks: [] };
    let diagIds = new Set(); try { diagIds = diagnosticTasks(path.dirname(path.dirname(dirPath))); } catch { diagIds = new Set(); }
    let aPassed = 0, aTotal = 0, aTasks = 0;   // hidden-test assertions over scored tasks that carry them
    let started = null, ended = null, startedFallback = null, endedFallback = null;
    let bonus = 0;
    // unfinished and superseded results (skipOf): their own tallies, out of every count above (and out of `tasks`)
    const held = { unfinished: 0, superseded: 0 };
    for (const e of entries) {
        const { status, derived: dv } = deriveStatus(e.data);
        const tid = String((e.data && e.data.task) || '').replace(/__r\d+$/, '');
        const why = skip && skip.get(e.file);
        if (why) {
            held[why] = (held[why] || 0) + 1;
            const wall0 = num((e.data.run || {}).wall_s) || 0;   // its time still counts towards the battery's clock
            if (e.transcriptMtimeMs != null) { ended = Math.max(ended ?? 0, e.transcriptMtimeMs); const s0 = e.transcriptMtimeMs - wall0 * 1000; started = started == null ? s0 : Math.min(started, s0); }
            endedFallback = Math.max(endedFallback ?? 0, e.mtimeMs);
            const f0 = e.mtimeMs - wall0 * 1000; startedFallback = startedFallback == null ? f0 : Math.min(startedFallback, f0);
            continue;
        }
        if (diagIds.has(tid)) {
            diag.results++; if (SOLVED.has(status)) diag.passed++; if (!diag.tasks.includes(tid)) diag.tasks.push(tid);
            const wall0 = num((e.data.run || {}).wall_s) || 0;   // its time still counts towards the battery's clock
            if (e.transcriptMtimeMs != null) { ended = Math.max(ended ?? 0, e.transcriptMtimeMs); const s0 = e.transcriptMtimeMs - wall0 * 1000; started = started == null ? s0 : Math.min(started, s0); }
            endedFallback = Math.max(endedFallback ?? 0, e.mtimeMs);
            const f0 = e.mtimeMs - wall0 * 1000; startedFallback = startedFallback == null ? f0 : Math.min(startedFallback, f0);
            continue;
        }
        counts[status] = (counts[status] || 0) + 1;
        // its bonus test is a result of its own (bonusRow): in the counts, never in `tasks` (files) or the clock
        const ex = extraOf(e.data);
        if (ex) {
            bonus++;
            const bst = EXCLUDED.has(status) ? status : (ex.all ? 'pass' : 'fail');
            counts[bst] = (counts[bst] || 0) + 1;
            if (EXCLUDED.has(bst)) excluded++; else {
                scored++; if (SOLVED.has(bst)) solved++;
                if (num(ex.total) != null) { aPassed += num(ex.passed) || 0; aTotal += ex.total; aTasks++; }
            }
        }
        if (dv) derived++;
        if (EXCLUDED.has(status)) excluded++; else {
            scored++; if (SOLVED.has(status)) solved++;
            const a = assertionsOf(e.data.score).assertions;
            if (a) { aPassed += a.passed; aTotal += a.total; aTasks++; }
        }
        if (Array.isArray(e.data.anomalies) && e.data.anomalies.length) anomalies++;
        const wall = num((e.data.run || {}).wall_s) || 0;
        if (e.transcriptMtimeMs != null) {
            ended = Math.max(ended ?? 0, e.transcriptMtimeMs);
            const s0 = e.transcriptMtimeMs - wall * 1000; started = started == null ? s0 : Math.min(started, s0);
        }
        endedFallback = Math.max(endedFallback ?? 0, e.mtimeMs);
        const f0 = e.mtimeMs - wall * 1000; startedFallback = startedFallback == null ? f0 : Math.min(startedFallback, f0);
    }
    // Config from the first entry that has one; devices from any entry that names them.
    let config = null, server = null;
    for (const e of entries) {
        const c = configOf(e.data);
        if (!config && (c.config.runner || c.config.model)) config = c.config;
        if (!server && c.server) server = c.server;
        if (config && server) break;
    }
    return {
        dir, path: dirPath,
        tasks: entries.length - held.unfinished - held.superseded, bonus, counts, solved, scored, excluded, anomalies, status_derived: derived,
        diagnostic: diag.results ? diag : null,   // { results, passed, tasks }: diagnostic tasks' results, never in the counts above
        unfinished: held.unfinished || null,     // results whose question is not answered yet: never in the counts above
        superseded: held.superseded || null,     // results a continuation replaced: never in the counts above
        assertions: aTasks ? { passed: aPassed, total: aTotal, tasks: aTasks } : null,   // null: no result in this battery has the field
        started: started != null ? Math.round(started) : (startedFallback != null ? Math.round(startedFallback) : null),
        ended: ended != null ? Math.round(ended) : (endedFallback != null ? Math.round(endedFallback) : null),
        times_from: started != null ? 'transcripts' : 'json_mtimes',
        config, server,
        battery: batterySummary(dirPath),
        has_summary: fs.existsSync(path.join(dirPath, 'summary.json')),
    };
}

// Per-dir cache keyed on what would change the index; the UI polls this.
const cache = new Map();
function dirSignature(dirPath) {
    try {
        const st = fs.statSync(dirPath); if (!st.isDirectory()) return null;
        let n = 0, latest = 0;
        for (const f of fs.readdirSync(dirPath)) {
            if (!f.endsWith('.json')) continue;
            try { const s = fs.statSync(path.join(dirPath, f)); n++; if (s.mtimeMs > latest) latest = s.mtimeMs; } catch { /* gone */ }
        }
        return `${st.mtimeMs}:${n}:${latest}`;
    } catch { return null; }
}
function loadDir(root, dir) {
    const dirPath = path.join(resultsRoot(root), dir);
    const sig = dirSignature(dirPath); if (!sig) return null;
    const hit = cache.get(dirPath);
    if (hit && hit.sig === sig) return hit;
    const entries = readScored(dirPath);
    const v = { sig, entries, summary: summarize(dir, dirPath, entries) };
    cache.set(dirPath, v);
    loadGen++;
    return v;
}

// The continuation index over every result dir: source "<dir>/<file sans .json>" -> [{ dir, file }] of its continuations,
// and dir -> Set(files) superseded. Rebuilt when any dir was (re)read (loadGen); listRuns forces a sweep of every dir, a
// lone getRun reuses an index under CONT_TTL_MS old (a catalog build calls getRun for every battery right after listRuns).
let loadGen = 0;
const CONT_TTL_MS = 10000;
let contIdx = { root: null, gen: -1, at: 0, bySrc: new Map(), superseded: new Map() };
function continuationIndex(root, { fresh = false } = {}) {
    const r = root || getConfig().root;
    if (!fresh && contIdx.root === r && Date.now() - contIdx.at < CONT_TTL_MS) return contIdx;
    const rr = resultsRoot(r);
    let dirs = []; try { dirs = fs.readdirSync(rr); } catch { dirs = []; }
    for (const dir of dirs) if (safeName(dir)) loadDir(r, dir);
    if (contIdx.root === r && contIdx.gen === loadGen) { contIdx.at = Date.now(); return contIdx; }
    const bySrc = new Map(), superseded = new Map();
    for (const dir of dirs) {
        if (!safeName(dir) || /^INVALID-/i.test(dir)) continue;
        const v = cache.get(path.join(rr, dir)); if (!v) continue;
        for (const e of v.entries) {
            const c = continuationOf(e.data);
            if (!c || !c.src_dir || !c.src_file) continue;
            const k = `${c.src_dir}/${c.src_file.replace(/\.json$/, '')}`;
            if (!bySrc.has(k)) bySrc.set(k, []);
            bySrc.get(k).push({ dir, file: e.file });
            if (!superseded.has(c.src_dir)) superseded.set(c.src_dir, new Set());
            superseded.get(c.src_dir).add(c.src_file);
        }
    }
    contIdx = { root: r, gen: loadGen, at: Date.now(), bySrc, superseded };
    return contIdx;
}
/** file -> 'superseded' | 'unfinished' for the results of a dir that stay out of every tally. */
function skipOf(root, dir, entries) {
    const r = root || getConfig().root;
    const sup = continuationIndex(r).superseded.get(dir);
    const ann = require('./annotations');
    const out = new Map();
    for (const e of entries || []) {
        if (sup && sup.has(e.file)) { out.set(e.file, 'superseded'); continue; }
        if (unfinishedOf(e.data) || (mayBeUnfinished(e.data) && ann.unfinishedIndexOf(r, dir, e.file))) out.set(e.file, 'unfinished');
    }
    return out;
}
/** The battery summary with its unfinished / superseded results left out (memoised per dir and skip set). */
function summaryOf(root, dir, v) {
    const skip = skipOf(root, dir, v.entries);
    if (!skip.size) return v.summary;
    const key = [...skip].map(([f, w]) => f + ':' + w).sort().join('|');
    if (!v.skipMemo || v.skipMemo.key !== key) v.skipMemo = { key, summary: summarize(dir, path.join(resultsRoot(root || getConfig().root), dir), v.entries, skip) };
    return v.skipMemo.summary;
}
/** Is the saved session of <dir>/<file> still there? harness session_store.find: <root>/session-store (or
 *  $CODEBENCH_SESSION_STORE), then <root>/session-store-pinned; both the .json and the .tar.gz. 'pruned' when a store
 *  exists without it; `fallback` (the index's own word) when there is no store at all. */
function sessionState(root, dir, file, fallback = null) {
    const r = root || getConfig().root;
    const base = String(file).replace(/\.json$/, '');
    const stores = [process.env.CODEBENCH_SESSION_STORE || path.join(r, 'session-store'), path.join(r, 'session-store-pinned')];
    let anyStore = false;
    for (const st of stores) {
        try { if (!fs.statSync(st).isDirectory()) continue; } catch { continue; }
        anyStore = true;
        const p = path.join(st, dir, base);
        if (fs.existsSync(p + '.json') && fs.existsSync(p + '.tar.gz')) return 'saved';
    }
    return anyStore ? 'pruned' : fallback;
}

function listRuns(root) {
    try { maybeAdopt(root); } catch { /* adoption must never break the index */ }
    let dirs;
    try { dirs = fs.readdirSync(resultsRoot(root)); } catch { return []; }
    const out = [];
    const loadedDirs = [];
    for (const dir of dirs) {
        if (!safeName(dir)) continue;
        const v = loadDir(root, dir);
        if (!v || !v.entries.length) continue;   // no scored JSONs: validate-* dirs, empty batteries
        loadedDirs.push([dir, v]);
    }
    continuationIndex(root, { fresh: true });   // every dir is loaded now: the superseded sets are current
    for (const [dir, v] of loadedDirs) out.push(summaryOf(root, dir, v));
    out.sort((a, b) => (b.ended || 0) - (a.ended || 0));
    return out;
}

function getRun(dir, root) {
    if (!safeName(dir)) throw new Error('bad result dir name');
    const v = loadDir(root, dir);
    if (!v) throw new Error(`no such result dir: ${dir}`);
    // Each row as it stands (keyed by the result FILE: a level problem's row is `T@L3`, its file `T-L3.json`):
    //  - `superseded`: a continuation replaced it ({ by: [{dir, file}] }) -- lib/models.js leaves it out of everything;
    //  - `unfinished`: its question is not answered yet (run.unfinished, or the annotations index of past runs), with its
    //    session's state ('saved' | 'pruned' | null), `rebuildable` (the index's; null when unknown) and the result path;
    //    the +bonus row of an unfinished result is unfinished too;
    //  - `askedAnswerable`: a reviewer's note that the prompt answers its question (main rows; shown on unfinished cells).
    const ann = require('./annotations');
    const annRoot = root || getConfig().root;
    const idx = continuationIndex(annRoot);
    const data = new Map(v.entries.map((e) => [e.file, e.data]));
    const rows = resultRows(v.entries).map((r) => {
        let o = r;
        const k = `${dir}/${String(r.file).replace(/\.json$/, '')}`;
        const by = idx.bySrc.get(k);
        if (by && !/^INVALID-/i.test(dir)) o = { ...o, superseded: { by } };
        const ix = ann.unfinishedIndexOf(annRoot, dir, r.file);
        const d = data.get(r.file);
        let u = o.unfinished || null;
        if (!u && ix && mayBeUnfinished(d)) u = { question: ix.question, compactions: ix.compactions, why: null, source: 'index' };
        // a superseded run keeps the question it had asked, for its continuation's history
        if (u && o.superseded) o = { ...o, superseded: { ...o.superseded, asked: u.question || null } };
        if (u && !o.superseded) {
            u = { ...u, session: sessionState(annRoot, dir, r.file, ix ? ix.session : null), rebuildable: ix ? ix.rebuildable : null,
                result: path.join(resultsRoot(annRoot), dir, r.file) };
            o = { ...o, unfinished: u };
        } else if (o.unfinished) o = { ...o, unfinished: null };
        if (!r.bonus) { const a = ann.askedAnswerableOf(annRoot, dir, r.file); if (a) o = { ...o, askedAnswerable: a }; }
        return o;
    });
    return { ...summaryOf(annRoot, dir, v), rows };
}

function tailLines(file, n, maxLine) {
    // Last n lines without reading a multi-MB transcript twice: read once, split once.
    let text; try { text = fs.readFileSync(file, 'utf-8'); } catch { return null; }
    const lines = text.split('\n'); if (lines.length && lines[lines.length - 1] === '') lines.pop();
    return lines.slice(-n).map((l) => (l.length > maxLine ? l.slice(0, maxLine) + ` …[+${l.length - maxLine} chars]` : l));
}

function getResult(dir, task, root) {
    if (!safeName(dir) || !safeName(task)) throw new Error('bad dir or task name');
    if (isBonusTask(task)) {   // <task>+bonus: the bonus test's row over its parent's result (one run, one file)
        const p = getResult(dir, bonusParent(task), root);
        const b = bonusRow({ file: `${p.task}.json`, data: p.result }, p.row);
        if (!b) throw new Error(`no bonus test result in ${dir}/${p.task}.json`);
        const ex = extraOf(p.result);
        return { ...p, task, row: b, progress: null, bonus: { parent: p.task, skill: b.bonus_skill, cases: Array.isArray(ex.cases) ? ex.cases : null },
            test_tail: { ...p.test_tail, extra: typeof ex.output_tail === 'string' ? ex.output_tail : null } };
    }
    const dirPath = path.join(resultsRoot(root), dir);
    const file = path.join(dirPath, `${task}.json`);
    let data; try { data = JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { throw new Error(`no result ${dir}/${task}.json`); }
    const tp = transcriptPath(data, dirPath);
    const sc = data.score || {};
    const tailOf = (x) => (x && typeof x === 'object' && typeof x.output_tail === 'string' ? x.output_tail : null);
    return {
        dir, task, file,
        row: taskRow({ file: `${task}.json`, data }),
        // the same, with the case names it gained and lost (the goals panel marks them)
        progress: progressOf(data, readBaselines().get(String(task).replace(/__r\d+$/, '')), true),
        // Side experiment (verify-on-fail): kept beside the row, never inside it -- taskRow, the
        // battery summary and everything that folds rows (lib/models.js) must not see it.
        verify: verifySummary(data, dirPath),
        ...configOf(data),
        result: data,
        transcript: tp,
        transcript_tail: tp ? tailLines(tp, TRANSCRIPT_TAIL_LINES, MAX_TRANSCRIPT_LINE) : null,
        test_tail: { fail_to_pass: tailOf(sc.fail_to_pass), pass_to_pass: tailOf(sc.pass_to_pass) },
    };
}

// ---------- one finished task, in the Live view's own shape (2026-09-30) ----------
// Kyle, 2026-09-30: "clicking a completed item in the bottom chart should just show me the same live
// page, but populated with the previous task's info" -- the separate Transcript page was "mostly a
// lesser duplicate of the live page". So instead of a second renderer, this rebuilds the fields
// liveSnapshot() + transcriptTail() carry, from the files a finished task leaves behind: the result
// JSON (final numbers, tests, cases, progress) and its transcript (transcriptStats: last text, the
// plan versions, tool calls, tokens). The UI renders it with the very same code as the running task.
// Read-only and side-effect free: it never touches `live`, `tailState`, `lastPlan` or `adoptState`,
// never scans /proc (adoptedServer's fall-back), and never rewrites battery.json (scanBatteries does).
// The transcript pass is the only cost (a few MB for a long task), cached per (file, size, mtime).
const snapStatsCache = new Map();
function snapTranscriptStats(file, runner) {
    let st; try { st = fs.statSync(file); if (!st.isFile()) return null; } catch { return null; }
    const key = `${file}|${runner || ''}`;
    const hit = snapStatsCache.get(key);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.v;
    let text; try { text = fs.readFileSync(file, 'utf-8'); } catch { return null; }
    const v = { stats: transcriptStats(runner || null, text), bytes: st.size };
    snapStatsCache.set(key, { size: st.size, mtimeMs: st.mtimeMs, v });
    while (snapStatsCache.size > 8) snapStatsCache.delete(snapStatsCache.keys().next().value);
    return v;
}
// `score.changed` is a `git diff --stat`: one " path | N +-" line per file.
const changedFiles = (s) => (typeof s === 'string' ? s.split('\n').filter((l) => /\|/.test(l)).length : null);
function taskSnapshot(dir, task, root) {
    if (!safeName(dir) || !safeName(task)) throw new Error('bad dir or task name');
    if (isBonusTask(task)) return { ...taskSnapshot(dir, bonusParent(task), root), bonus_of: bonusParent(task) };   // one run: the parent's view
    const dirPath = path.join(resultsRoot(root), dir);
    const r = getResult(dir, task, root);   // throws "no result <dir>/<task>.json" for a task still running
    const d = r.result || {}; const row = r.row; const run = d.run || {}; const tl = d.timeline || {}; const sc = d.score || {};
    const m = /__r(\d+)$/.exec(task); const base = task.replace(/__r\d+$/, ''); const runN = m ? parseInt(m[1], 10) : 1;
    const b = readBatteryFile(dirPath) || {};
    const bc = b.config && typeof b.config === 'object' ? b.config : {};
    const v = loadDir(root, dir);
    const summary = v ? v.summary : null;
    const skip = v ? skipOf(root, dir, v.entries) : new Map();   // unfinished / superseded: listed, never counted
    const runs = num(b.runs) || num((d.manifest || {}).runs) || 1;
    // The battery's other tasks, for the TASKS table under the viewed one (rows in applyEvent's
    // task_done shape). A battery still running into a dir with an earlier attempt's files keeps
    // adoptedLive's rule: those are not this battery's; a finished one shows everything on disk.
    const startedMs = num(b.started) != null ? Math.round(b.started * 1000) : null;
    const runningState = b.state === 'running' || b.state === 'paused' || b.state === 'stopping';
    const entries = runningState ? staleFilter(v ? v.entries : [], startedMs, !!(bc.resume ?? b.resume)).entries : (v ? v.entries : []);
    const tasks = []; let solved = 0, scored = 0, excluded = 0;
    for (const e of entries) {
        const tr = taskRow(e);
        const mm = /__r(\d+)\.json$/.exec(tr.file || ''); const rn = mm ? parseInt(mm[1], 10) : 1;
        tasks.push({ key: `${tr.task.replace(/__r\d+$/, '')}#${rn}`, task: tr.task.replace(/__r\d+$/, ''), run: rn, of: runs, status: tr.status, solved: tr.solved, partial: tr.partial,
            wall_s: tr.wall_s, tokens_in: tr.tokens_in, tokens_out: tr.tokens_out, tool_calls: tr.tool_calls, first_edit_s: tr.first_edit_s, last_edit_s: tr.last_edit_s,
            tests_run: tr.tests_run, hit_timeout: tr.hit_timeout, solved_at_cap: tr.solved_at_cap, anomalies: tr.anomalies, edits: tr.edits,
            assertions: tr.assertions, p2p: tr.p2p, p2p_broken: tr.p2p_broken, ran_at: tr.ran_at, ...(skip.has(e.file) ? { held: skip.get(e.file) } : {}) });
        if (skip.has(e.file)) continue;
        if (EXCLUDED.has(tr.status)) excluded++; else { scored++; if (SOLVED.has(tr.status)) solved++; }
    }
    // Planned order (battery.json) first, then whatever else is on disk, by when it ran.
    const order = new Map((Array.isArray(b.tasks) ? b.tasks : []).map((t, i) => [t, i]));
    tasks.sort((x, y) => ((order.get(x.task) ?? 1e9) - (order.get(y.task) ?? 1e9)) || ((x.ran_at || 0) - (y.ran_at || 0)) || (x.run - y.run));
    const planned = Array.isArray(b.tasks) ? b.tasks : tasks.map((t) => t.task).filter((t, i, a) => a.indexOf(t) === i);
    const index = (() => { const i = planned.indexOf(base); return i >= 0 ? i * runs + runN : null; })();
    // Config: the ROW's own (a battery can change server mid-way), else battery.json's, else the dir's.
    const rc = row.rowConfig || {};
    const config = { ...(summary && summary.config ? summary.config : {}), ...bc, ...Object.fromEntries(Object.entries(rc.config || {}).filter(([, x]) => x != null)) };
    const server = rc.server || (summary && summary.server) || null;
    // the same lookup the transcript reader uses (results/<dir>/<task>__rN/ first), so the stats and the
    // "full transcript" accordion read one file; getResult's path keys on d.task and misses __rN dirs
    const loc = transcriptLocation(dir, task, root);
    const tp = loc.path || r.transcript;
    const runner = d.runner || config.runner || null;
    const ts = tp ? snapTranscriptStats(tp, runner) : null;
    const stats = ts ? ts.stats : null;
    const f2p = row.assertions ? { passed: row.assertions.passed, failed: row.assertions.failed, total: row.assertions.total } : null;
    const current = {
        task: base, run: runN, of: runs, index, total: planned.length * runs || null, tier: d.tier || (d.manifest || {}).tier || null,
        cap_s: num(d.cap_used) ?? num(config.timeout_s) ?? num((d.manifest || {}).timeout_s),
        sandbox: null, started_t: null, startedAt: row.ran_at || null,
        setup: d.setup && typeof d.setup === 'object' ? { exit: d.setup.exit_code ?? null, secs: num(d.setup.secs) } : null,
        steps: num(tl.steps) ?? 0, tool_calls: row.tool_calls ?? 0, edits: row.edits, tool_edits: row.tool_edits, shell_edits: row.shell_edits,
        tokens_out: row.tokens_out, tokens_in: row.tokens_in, elapsed_s: row.wall_s, elapsed_s_now: row.wall_s, wall_s: row.wall_s,
        first_edit_s: row.first_edit_s, last_edit_s: row.last_edit_s,
        last_tool: stats ? stats.last_tool : null, last_path: null, last_kind: null,
        snippet: stats ? stats.last_text : null, snippet_kind: null, snippet_t: null,
        tests: { ...(f2p ? { f2p } : {}), ...(row.p2p ? { p2p: { passed: row.p2p.passed, total: row.p2p.total } } : {}) },
        tests_run: row.tests_run, compactions: num(tl.compactions) ?? 0, length_cutoffs: num(tl.length_cutoffs) ?? 0, errors: 0, tool_errors: num(run.tool_errors) ?? (stats ? stats.tool_errors : 0),
        anomalies: row.anomalies || [], repeated_reads: [],
        // the outcome: what the running card cannot know yet
        finished: true, status: row.status, status_derived: row.status_derived, solved: row.solved, partial: row.partial,
        assertions: row.assertions, p2p: row.p2p, p2p_broken: row.p2p_broken, progress: r.progress,
        hit_timeout: row.hit_timeout, solved_at_cap: row.solved_at_cap, exit_code: num(run.exit_code),
    };
    let runInfo = null;
    try { runInfo = require('./runlabel').describeRun(config, server, { detected: deviceResolver }); } catch { runInfo = null; }
    return {
        viewing: { dir, task, base, run: runN },
        running: false, adopted: false, paused: false, pid: null, note: null,
        startedAt: startedMs, finishedAt: num(b.finished) != null ? Math.round(b.finished * 1000) : null, exitCode: null,
        elapsed_s: startedMs && num(b.finished) != null ? b.finished - startedMs / 1000 : null,
        command: Array.isArray(b.cmd) ? b.cmd.join(' ') : (b.cmd || null), outDir: b.out || dirPath,
        battery: { name: dir, out: b.out || dirPath, tasks: planned, runs, config, server, state: b.state || null, reason: b.reason || null },
        run_info: runInfo,
        tasks, done: tasks.length, total: planned.length * runs || tasks.length, solved, scored, excluded,
        summary: null, errors: [], stderrTail: '', refused: null, error: null, malformed: 0,
        current,
        tail: {
            task: base, run: runN, runner: (stats && stats.format) || runner, transcript: tp || null, sandbox: null,
            lines: [], bytes: ts ? ts.bytes : 0, stats: stats || null,
            files_changed: changedFiles(sc.changed), elapsed_s: row.wall_s, cap_s: current.cap_s, at: Date.now(),
            note: tp ? null : `no transcript under ${path.join(dirPath, task)}`, previous_plan: null,
        },
        // the goals panel and the accordions: everything the old Transcript page knew about the run
        result: {
            prompt_level: config.prompt_level || (d.manifest || {}).prompt_level || null,
            cases: sc.fail_to_pass && Array.isArray(sc.fail_to_pass.cases) ? sc.fail_to_pass.cases : null,
            verify: r.verify, has_patch: !!sc.patch, models_used: row.models_used, scaffold: row.scaffold,
        },
    };
}

// Every recorded per-case hidden-test result for one task across all result dirs (the task page's
// "which goals did each model pass" matrix): [{dir, task, run, status, cases:[{name, status}]}], one
// per result JSON that carries score.fail_to_pass.cases (recorded since 2026-09-25). Reads the
// loadDir cache, so it costs a stat per dir once the index is warm.
// A PROBLEM id is accepted too (2026-10-17, lib/models.js problemId): `<task>@L3` (and `<task>@L3+bonus`) is the task asked
// at prompt level L3, a problem of its own -- only results at that level are its; plain `<task>` is its L2 results only.
const PROBLEM_LEVEL_RE = /^(.+?)@(L\d+)(\+bonus)?$/;
const levelOfPrompt = (pl) => { const l = String(pl == null ? '' : pl).split('+')[0].trim().toUpperCase(); return /^L\d+$/.test(l) ? l : 'L2'; };
function listTaskCases(task, root) {
    if (!safeName(task)) throw new Error('bad task name');
    let level = 'L2';
    const pm = PROBLEM_LEVEL_RE.exec(task);
    if (pm) { task = pm[1] + (pm[3] || ''); level = pm[2]; }
    const bonus = isBonusTask(task);   // <task>+bonus: the bonus test's cases (score.extra.cases) of <task>'s results
    if (bonus) task = bonusParent(task);
    const re = new RegExp(`^${task.replace(/[.+]/g, '\\$&')}(?:__r(\\d+))?\\.json$`);
    let dirs; try { dirs = fs.readdirSync(resultsRoot(root)); } catch { return []; }
    const out = [];
    for (const dir of dirs.sort()) {
        if (!safeName(dir)) continue;
        const v = loadDir(root, dir);
        if (!v) continue;
        let skip = null;
        for (const e of v.entries) {
            const m = re.exec(e.file); if (!m) continue;
            skip = skip || skipOf(root, dir, v.entries);
            if (skip.has(e.file)) continue;   // unfinished / superseded: not a run of the task that counts
            if (levelOfPrompt(configOf(e.data).config.prompt_level) !== level) continue;   // another level: another problem
            const ex = bonus ? extraOf(e.data) : null;
            if (bonus && !ex) continue;
            const f2p = bonus ? ex : (e.data.score && e.data.score.fail_to_pass);
            const cases = f2p && Array.isArray(f2p.cases) ? f2p.cases.filter((c) => c && typeof c.name === 'string')
                .map((c) => ({ name: c.name, status: c.status })) : [];
            if (!cases.length) continue;
            const row = taskRow(e);
            out.push({ dir, task: e.file.slice(0, -5) + (bonus ? BONUS_SUFFIX : ''), run: m[1] ? Number(m[1]) : 1, status: bonus ? bonusRow(e, row).status : row.status, cases });
        }
    }
    return out;
}

// ---------- side experiment: verify-on-fail (codebench harness/run.py verify_followup) ----------
// On a scored `fail` the harness resumes the agent's session with one more user turn ("Can you
// verify your work...?"), re-scores, and records the outcome under `verify` ONLY. It is a side
// experiment: nothing in the mainline (deriveStatus, taskRow, summarize, lib/models.js folds,
// leaderboards) may read it -- a rescue here is never a pass there. test/codebench.test.js pins that.
function verifyTranscriptPath(d, dirPath) {
    const v = d && d.verify; if (!v || typeof v !== 'object') return null;
    const cands = [];
    if (dirPath && d.task && d.runner) cands.push(path.join(dirPath, d.task, `verify.${d.runner}.jsonl`));
    if (dirPath && d.task) { try { for (const f of fs.readdirSync(path.join(dirPath, d.task)).sort()) if (/^verify\..+\.jsonl$/.test(f)) cands.push(path.join(dirPath, d.task, f)); } catch { /* no subdir */ } }
    const rt = v.run && v.run.transcript; if (typeof rt === 'string' && rt) cands.push(rt);
    for (const c of cands) { try { if (fs.statSync(c).isFile()) return c; } catch { /* next */ } }
    return null;
}
// Compact, UI-sized view of result.verify (no patch, no cases list): null when the result has none.
function verifySummary(d, dirPath) {
    const v = d && d.verify; if (!v || typeof v !== 'object') return null;
    if (v.skipped != null) return { kind: 'skipped', status: null, reason: String(v.skipped) };
    if (v.error != null) return { kind: 'error', status: null, reason: String(v.error) };
    const r = v.run && typeof v.run === 'object' ? v.run : {};
    const a = v.assertions && typeof v.assertions === 'object' && num(v.assertions.total) != null
        ? { passed: num(v.assertions.passed) ?? 0, failed: num(v.assertions.failed) ?? 0, total: v.assertions.total } : null;
    return {
        kind: 'attempt',
        status: typeof v.status === 'string' ? v.status : null,
        solved: !!v.solved,
        assertions: a,
        cases: Array.isArray(v.cases) ? v.cases.filter((c) => c && typeof c.name === 'string').length : null,
        // progress beyond base after the follow-up turn: score.py's own when it recorded one, else
        // recomputed from its cases/assertions against baseline.json
        progress: progressOf({ task: d.task, manifest: d.manifest, score: { progress: v.progress, regressions: v.regressions,
            fail_to_pass: { cases: v.cases }, assertions: v.assertions } }, readBaselines().get(String(d.task || '').replace(/__r\d+$/, ''))),
        p2p_broken: Array.isArray(v.p2p_broken) ? v.p2p_broken.length : null,
        patch_changed: typeof v.patch_changed === 'boolean' ? v.patch_changed : null,
        cap_s: num(v.cap_s),
        wall_s: num(r.wall_s), tokens_in: num(r.tokens_in), tokens_out: num(r.tokens_out),
        tool_calls: num(r.tool_calls), tool_errors: num(r.tool_errors), exit_code: num(r.exit_code),
        transcript: verifyTranscriptPath(d, dirPath) || (typeof r.transcript === 'string' ? r.transcript : null),
    };
}
// Every result JSON that carries a `verify` block, across all result dirs, newest first:
// [{dir, task, run, runner, model, effort, scaffold, ran_at, before:{status, assertions, wall_s, tokens_out}, verify}].
// `before` is the mainline row, unchanged. Reads the loadDir cache (a stat per dir once warm).
function listVerifyRuns(root) {
    let dirs; try { dirs = fs.readdirSync(resultsRoot(root)); } catch { return []; }
    const out = [];
    for (const dir of dirs.sort()) {
        if (!safeName(dir)) continue;
        const v = loadDir(root, dir);
        if (!v) continue;
        for (const e of v.entries) {
            if (!e.data.verify || typeof e.data.verify !== 'object') continue;
            const row = taskRow(e); const cfg = row.rowConfig.config;
            const name = e.file.slice(0, -5); const m = /__r(\d+)$/.exec(name);
            out.push({
                dir, task: name, base_task: name.replace(/__r\d+$/, ''), run: m ? Number(m[1]) : 1,
                runner: cfg.runner, model: cfg.model, effort: cfg.effort, scaffold: cfg.scaffold,
                ran_at: row.ran_at,
                before: { status: row.status, assertions: row.assertions, progress: row.progress, wall_s: row.wall_s, tokens_out: row.tokens_out, tool_calls: row.tool_calls },
                verify: verifySummary(e.data, path.join(resultsRoot(root), dir)),
            });
        }
    }
    out.sort((a, b) => (b.ran_at || 0) - (a.ran_at || 0));
    return out;
}

// ---------- task list ----------
function parseTaskListJson(text) {
    const out = [];
    for (const line of String(text || '').split('\n')) {
        const s = line.trim(); if (!s.startsWith('{')) continue;
        try { const o = JSON.parse(s); if (o && o.id) out.push(normalizeTask(o)); } catch { /* skip */ }
    }
    return out;
}
function parseTaskListText(text) {
    // `--list` without --json:  "<id padded>  <variant>  cat1,cat2"
    const out = [];
    for (const line of String(text || '').split('\n')) {
        const m = line.trim().match(/^(\S+)\s+(\S+)(?:\s+(\S+))?$/); if (!m) continue;
        if (m[1] === 'usage:' || m[1].startsWith('-')) continue;
        out.push(normalizeTask({ id: m[1], variant: m[2], category: m[3] ? m[3].split(',').filter(Boolean) : [] }));
    }
    return out;
}
function normalizeTask(o) {
    const cats = Array.isArray(o.category) ? o.category : (typeof o.category === 'string' ? o.category.split(',') : []);
    const tierCat = cats.find((c) => /^tier-/.test(c));
    return {
        id: o.id, repo: o.repo || null, variant: o.variant || null, category: cats,
        tier: o.tier_predicted || (tierCat ? tierCat.replace(/^tier-/, '') : null),
        tier_predicted: o.tier_predicted || null,
        authored_by: o.authored_by || null, provenance: o.provenance || null, incident_date: o.incident_date || null,
        probes: o.probes || null, prompt_levels: o.prompt_levels || null, hidden_tests: o.hidden_tests ?? null,
        timeout_s: o.timeout_s ?? null, dir: o.dir || null,
        weak_model_failure: o.weak_model_failure || null, oracle_note: o.oracle_note || null,
    };
}
function runList(python, root, args, spawnFn) {
    return new Promise((resolve) => {
        let out = '', err = '';
        let p;
        try { p = spawnFn(python, ['harness/run.py', '--list', ...args], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }); }
        catch (e) { return resolve({ code: -1, out: '', err: e.message }); }
        p.stdout.on('data', (b) => { out += b; }); p.stderr.on('data', (b) => { err += b; });
        p.on('error', (e) => resolve({ code: -1, out, err: err + e.message }));
        p.on('close', (code) => resolve({ code, out, err }));
    });
}
async function listTasks(deps) {
    const { root, python } = getConfig(); const spawnFn = (deps && deps.spawn) || realSpawn;
    const j = await runList(python, root, ['--json'], spawnFn);
    if (j.code === 0) { const t = parseTaskListJson(j.out); if (t.length) return { tasks: t, source: 'json' }; }
    // --json not there yet (argparse exits 2 with "unrecognized arguments"), or printed nothing
    const t = await runList(python, root, [], spawnFn);
    if (t.code !== 0) throw new Error(`run.py --list failed (exit ${t.code}): ${(t.err || '').trim().split('\n').pop() || 'no output'}`);
    return { tasks: parseTaskListText(t.out), source: 'text', note: j.code !== 0 ? '--json not supported by this run.py yet' : undefined };
}

// ---------- the event stream ----------
function parseEvent(line) {
    const s = String(line || '').trim(); if (!s.startsWith('{')) return null;
    let o; try { o = JSON.parse(s); } catch { return null; }
    if (!o || typeof o !== 'object' || typeof o.ev !== 'string') return null;
    return o;
}
function freshLive() {
    return {
        running: false, pid: null, startedAt: null, finishedAt: null, exitCode: null, error: null,
        refused: null,          // set when the stream's version is not ours: we stop applying
        command: null, cwd: null, outDir: null,
        battery: null,          // {name, out, tasks[], runs, config, server}
        current: null,          // the running task (see applyEvent task_start/step)
        tasks: [],              // [{key, task, run, status, ...task_done fields}] in start order
        done: 0, total: 0, solved: 0, scored: 0, excluded: 0,
        summary: null, errors: [], events: 0, malformed: 0, lastEventT: null, lastEventAt: null,
        stderrTail: '',
        // adoption + control (harness/CONTROL.md): set when this process did NOT spawn the battery.
        adopted: false, paused: false, pauseRequested: false, batteryState: null, pgid: null,
        control: null, stopping: null, note: null,
    };
}
function taskKey(ev) { return `${ev.task}#${ev.run || 1}`; }
function findTask(live, ev) { const k = taskKey(ev); return live.tasks.find((t) => t.key === k); }
function applyEvent(live, ev) {
    if (!ev) return live;
    if (live.refused) return live;
    if (ev.v !== undefined && ev.v !== EVENT_VERSION) { live.refused = `event stream v${ev.v}; this dashboard understands v${EVENT_VERSION}`; return live; }
    live.events++; live.lastEventT = num(ev.t); live.lastEventAt = Date.now();
    switch (ev.ev) {
        case 'battery_start': {
            const tasks = Array.isArray(ev.tasks) ? ev.tasks : [];
            live.battery = { name: ev.battery || null, out: ev.out || null, tasks, runs: ev.runs || 1, config: ev.config || null, server: ev.server || null, image: ev.image || null };
            live.total = tasks.length * (ev.runs || 1) || (typeof ev.tasks === 'number' ? ev.tasks : 0);
            if (ev.out) live.outDir = ev.out;
            break;
        }
        case 'task_start': {
            const t = { key: taskKey(ev), task: ev.task, run: ev.run || 1, of: ev.of || 1, index: ev.index ?? null, total: ev.total ?? null, tier: ev.tier || null, status: 'running', cap_s: num(ev.cap_s), started_t: num(ev.t), startedAt: Date.now() };
            const i = live.tasks.findIndex((x) => x.key === t.key); if (i >= 0) live.tasks[i] = t; else live.tasks.push(t);
            if (ev.total) live.total = Math.max(live.total, ev.total);   // index/total already count the expanded (task x run) plan
            live.current = {
                task: ev.task, run: t.run, of: t.of, index: t.index, total: t.total, tier: t.tier, cap_s: t.cap_s,
                sandbox: ev.sandbox || null, started_t: t.started_t, startedAt: t.startedAt,
                setup: null, steps: 0, tool_calls: 0, edits: 0, tool_edits: 0, shell_edits: 0, tokens_out: 0, elapsed_s: 0,
                first_edit_s: null, last_edit_s: null, last_tool: null, last_path: null, last_kind: null,
                snippet: null, snippet_kind: null, snippet_t: null, tests: {}, compactions: 0, length_cutoffs: 0, errors: 0, tool_errors: 0,
                anomalies: [], reads: {}, repeated_reads: [],
            };
            break;
        }
        case 'setup': if (live.current && live.current.task === ev.task) live.current.setup = { exit: ev.exit, secs: num(ev.secs) }; break;
        case 'step': {
            const c = live.current; if (!c || c.task !== ev.task) break;
            c.steps++; c.last_kind = ev.kind || null; if (ev.synthetic) c.synthetic = true;   // claude/agy: one summary step at the end, no live stream
            if (num(ev.n) != null) c.steps = Math.max(c.steps, ev.n);
            if (num(ev.elapsed_s) != null) c.elapsed_s = ev.elapsed_s;
            if (num(ev.tool_calls) != null) c.tool_calls = ev.tool_calls;
            if (num(ev.tokens_out) != null) c.tokens_out = ev.tokens_out;
            const te = num(ev.edits), se = num(ev.shell_edits);
            if (te != null) c.tool_edits = te; if (se != null) c.shell_edits = se;
            const edits = c.tool_edits + c.shell_edits;
            if (edits > c.edits) { const at = num(ev.elapsed_s) ?? num(ev.t) ?? c.elapsed_s; if (c.first_edit_s == null) c.first_edit_s = at; c.last_edit_s = at; }
            c.edits = edits;
            if (ev.kind === 'tool_call') {
                c.last_tool = ev.tool || null; c.last_path = ev.path || null; if (ev.error) c.tool_errors++;
                if (ev.path && /^(read|view|cat)/i.test(ev.tool || '')) {
                    const at = num(ev.elapsed_s) ?? num(ev.t) ?? 0;
                    const arr = (c.reads[ev.path] = (c.reads[ev.path] || []).filter((x) => at - x < 300)); arr.push(at);
                    if (arr.length >= 3 && !c.repeated_reads.includes(ev.path)) c.repeated_reads.push(ev.path);
                }
            }
            if ((ev.kind === 'text' || ev.kind === 'reasoning') && typeof ev.snippet === 'string') { c.snippet = ev.snippet; c.snippet_kind = ev.kind; c.snippet_t = num(ev.elapsed_s) ?? num(ev.t); }
            if (ev.kind === 'compaction') { c.compactions++; if (c.compactions >= 2) addAnomaly(c, 'compaction_thrash'); }
            if (ev.kind === 'finish' && (ev.reason === 'length' || ev.finish === 'length')) { c.length_cutoffs++; addAnomaly(c, 'length_cutoff'); }
            if (ev.kind === 'error') { c.errors++; if (/overflow|exceed_context_size/i.test(ev.message || ev.snippet || '')) addAnomaly(c, 'context_overflow'); }
            break;
        }
        case 'tests': if (live.current && live.current.task === ev.task) live.current.tests[ev.phase || '?'] = { passed: ev.passed ?? null, failed: ev.failed ?? null, total: ev.total ?? null, ok: ev.ok ?? null, ran_any: ev.ran_any ?? null, t: num(ev.t) }; break;
        case 'validate': {   // --validate batteries: takes the place of task_done, no model involved
            let t = findTask(live, ev); if (!t) { t = { key: taskKey(ev), task: ev.task, run: ev.run || 1 }; live.tasks.push(t); }
            Object.assign(t, { status: ev.ok ? 'valid' : 'invalid', validate: { ok: !!ev.ok, f2p_fails_at_base: ev.f2p_fails_at_base ?? null, f2p_reason: ev.f2p_reason || null, f2p_passes_at_fix: ev.f2p_passes_at_fix ?? null, p2p_passes_at_base: ev.p2p_passes_at_base ?? null }, result: ev.result || null, anomalies: [], finishedAt: Date.now() });
            live.done++; if (live.current && live.current.task === ev.task) live.current = null;
            break;
        }
        case 'task_done': {
            let t = findTask(live, ev); if (!t) { t = { key: taskKey(ev), task: ev.task, run: ev.run || 1 }; live.tasks.push(t); }
            const st = ev.status || (ev.solved ? 'pass' : 'fail');
            Object.assign(t, {
                status: st, solved: !!ev.solved, partial: num(ev.partial), wall_s: num(ev.wall_s),
                tokens_in: num(ev.tokens_in), tokens_out: num(ev.tokens_out), tool_calls: num(ev.tool_calls),
                first_edit_s: num(ev.first_edit_s), last_edit_s: num(ev.last_edit_s), tests_run: num(ev.tests_run),
                hit_timeout: !!ev.hit_timeout, solved_at_cap: !!ev.solved_at_cap,
                anomalies: Array.isArray(ev.anomalies) ? ev.anomalies : [], result: ev.result || null,
                edits: live.current && live.current.task === ev.task ? live.current.edits : null, finishedAt: Date.now(),
                tests: live.current && live.current.task === ev.task ? live.current.tests : {},
                ...doneAssertions(ev, live.current && live.current.task === ev.task ? live.current.tests : {}),
            });
            live.done++; if (EXCLUDED.has(st)) live.excluded++; else { live.scored++; if (SOLVED.has(st)) live.solved++; }
            if (live.current && live.current.task === ev.task) live.current = null;
            break;
        }
        case 'error': {
            live.errors.push({ task: ev.task || null, message: ev.message || '', t: num(ev.t) });
            if (ev.task) { let t = findTask(live, ev); if (t && t.status === 'running') { t.status = 'error'; t.message = ev.message; live.done++; } if (live.current && live.current.task === ev.task) live.current = null; }
            break;
        }
        // CONTROL.md's control events: the harness telling us it saw control.json.
        case 'paused': live.paused = true; live.pauseRequested = false; live.pausedAfter = ev.after_task || null; break;
        case 'resumed': live.paused = false; break;
        case 'stopping': live.stopping = { ...(live.stopping || {}), mode: ev.mode === 'stop-now' ? 'now' : 'after-task', action: ev.mode || null, acked: true, at: Date.now() }; break;
        case 'battery_done': live.summary = { solved: ev.solved, scored: ev.scored, excluded: ev.excluded, errors: ev.errors ?? null, validated: ev.validated ?? null, secs: num(ev.secs), summary: ev.summary || null, state: ev.state || null, reason: ev.reason || null, unrun: Array.isArray(ev.unrun) ? ev.unrun : null }; if (ev.state) live.batteryState = ev.state; break;
        default: break; // unknown events are ignored (forward-compatible)
    }
    return live;
}
function addAnomaly(c, a) { if (!c.anomalies.includes(a)) c.anomalies.push(a); }
// x/y for a finished task in the Live list: the result JSON task_done points at (one small read,
// once per task; absent in fixtures), else the `tests` events reduced onto current.tests.
function doneAssertions(ev, tests) {
    if (ev.result && typeof ev.result === 'string' && path.isAbsolute(ev.result)) {
        try { const d = JSON.parse(fs.readFileSync(ev.result, 'utf-8')); if (d && d.score) return assertionsOf(d.score); } catch { /* not there (yet) */ }
    }
    const f = (tests || {}).f2p, p = (tests || {}).p2p;
    return {
        assertions: f && num(f.total) != null ? { passed: num(f.passed) ?? 0, failed: num(f.failed) ?? 0, total: f.total } : null,
        p2p: p && num(p.total) != null && num(p.passed) != null ? { passed: p.passed, total: p.total } : null,
        p2p_broken: null,
    };
}

// ---------- running a battery ----------
let live = freshLive();
let child = null;
let killTimer = null;

// `pgrep -f harness/run.py` matches any shell whose argv carries the string (it matched the
// shell that ran this very check). Keep only python processes actually executing run.py, and
// not a --list. A `flock ... python3 harness/run.py` wrapper line matches too: harmless, it IS
// a battery. Pure over pgrep's `-a` output so the filter is testable.
function filterPgrepLines(out, skipPids) {
    const found = [];
    for (const line of String(out || '').split('\n')) {
        const m = line.match(/^(\d+)\s+(.*)$/); if (!m) continue;
        const pid = parseInt(m[1], 10), argv = m[2];
        if (skipPids.includes(pid)) continue;
        if (!/(^|\s|\/)python[0-9.]*\s+\S*harness\/run\.py(\s|$)/.test(argv)) continue;
        if (/\s--list(\s|$)/.test(argv)) continue;
        found.push({ pid, argv });
    }
    return found;
}
function pgrepBattery() {
    let out = '';
    try { const r = spawnSync('pgrep', ['-af', 'harness/run\\.py'], { encoding: 'utf-8', timeout: 5000 }); out = r.stdout || ''; } catch { return []; }
    return filterPgrepLines(out, [process.pid, child ? child.pid : -1]);
}
function hasFlock() {
    for (const dir of (process.env.PATH || '').split(':')) { try { if (fs.statSync(path.join(dir, 'flock')).isFile()) return true; } catch { /* next */ } }
    return false;
}
function sweepRunning() {
    try { const s = require('./sweep').status(); return !!(s && s.running); } catch { return false; }
}

function buildArgs(o) {
    // Returns {args, outDir, errors}. Validation is strict: run.py's argparse would exit 2 on
    // anything odd and the browser would only see "exited".
    const errors = [];
    const runner = String(o.runner || 'opencode');
    if (!RUNNERS.includes(runner)) errors.push(`runner must be one of ${RUNNERS.join(', ')}`);
    const model = o.model == null ? '' : String(o.model).trim();
    if (model && !/^[\w./:@+-]+$/.test(model)) errors.push(`model "${model}" is not a model id — use the id (e.g. gemini-3.8-flash-high, llama-local/<profile>), not a display name; letters, digits and . / : @ + - _ only`);
    if (runner === 'agy' && !model && !o.validate) errors.push('agy needs --model (it records no model identifier itself)');
    let tasks = o.tasks;
    if (typeof tasks === 'string') tasks = tasks.split(/[\s,]+/).filter(Boolean);
    if (tasks != null && !Array.isArray(tasks)) errors.push('tasks must be a list of task ids');
    const ids = (Array.isArray(tasks) ? tasks : []).map(String);
    for (const id of ids) if (!safeName(id)) errors.push(`bad task id: ${id}`);
    const category = o.category == null ? '' : String(o.category).trim();
    if (category && !/^[\w-]+$/.test(category)) errors.push('bad category');
    const all = o.all === true || o.all === 'true';
    if (!ids.length && !category && !all) errors.push('pick tasks (ids) or a category, or tick "every task" — the battery would otherwise run all 102');
    const runs = o.runs == null || o.runs === '' ? 1 : parseInt(o.runs, 10);
    if (!Number.isInteger(runs) || runs < 1 || runs > 20) errors.push('runs must be 1..20');
    const promptLevel = o.promptLevel ? String(o.promptLevel).toUpperCase() : 'L2';
    if (!PROMPT_LEVELS.includes(promptLevel)) errors.push('promptLevel must be L1, L2 or L3');
    let timeoutS = null;
    if (o.timeoutS != null && o.timeoutS !== '') { timeoutS = parseInt(o.timeoutS, 10); if (!Number.isInteger(timeoutS) || timeoutS < 30 || timeoutS > 86400) errors.push('timeoutS must be 30..86400 seconds'); }
    // Reasoning effort. The claude CLI takes --effort and harness/runners/claude.py passes
    // CODEBENCH_CLAUDE_EFFORT straight through, so this is an ENV axis, not a run.py flag: no
    // harness change is needed. It is a real axis of the configuration (a config is not a model
    // name -- plan B2) and it is recorded in the result's server.agent string by the runner.
    // Only claude reads it today: agy bakes the level into the model id (…-low/-medium/-high) and
    // the opencode runner does not pass provider effort through yet.
    const effort = o.effort == null ? '' : String(o.effort).trim().toLowerCase();
    if (effort && !EFFORTS.includes(effort)) errors.push(`effort must be one of ${EFFORTS.join(', ')} (or blank for the CLI default)`);
    if (effort && runner !== 'claude') errors.push(`effort is only wired for the claude runner (${runner} ignores it): agy bakes the level into the model id, opencode's runner does not pass --variant yet`);
    const scaffold = o.scaffold == null ? '' : String(o.scaffold).trim();
    if (scaffold && runner === 'pi') { if (!PI_SCAFFOLDS.includes(scaffold)) errors.push(`scaffold for pi must be ${PI_SCAFFOLDS.join(' or ')} (its extension set)`); }
    else if (scaffold && !SCAFFOLDS.includes(scaffold) && !/^advisor:[\w./:@+-]+$/.test(scaffold)) errors.push(`scaffold must be ${SCAFFOLDS.join(' or ')}, or advisor:<model>`);
    if (scaffold && runner !== 'claude' && runner !== 'pi') errors.push(`scaffold is only wired for the claude runner and for pi's extension set (${runner} ignores it)`);
    const subagentModel = o.subagentModel == null ? '' : String(o.subagentModel).trim();
    if (subagentModel && !/^[\w./:@+-]+$/.test(subagentModel)) errors.push('subagentModel is not a model id');
    if (subagentModel && runner !== 'claude') errors.push('subagentModel is only wired for the claude runner');
    const validate = !!o.validate;   // --validate: check each task's premise at base/fix, no model, `validate` replaces task_done
    const outName = o.outName == null ? '' : String(o.outName).trim();
    if (!outName) errors.push('outName is required (results/<outName>)');
    else if (!safeName(outName)) errors.push('outName may only contain letters, digits, . _ + @ -');
    const args = ['harness/run.py', '--json', '--runner', runner];
    if (validate) args.push('--validate');
    if (model) args.push('--model', model);
    if (category) args.push('--category', category);
    if (ids.length) args.push('--only', ...ids);
    if (runs > 1) args.push('--runs', String(runs));
    if (promptLevel !== 'L2') args.push('--prompt-level', promptLevel);   // L2 is prompt.md, the default; run.py only accepts L1|L3
    if (timeoutS != null) args.push('--timeout-s', String(timeoutS));
    return { args, outName, errors, runner, model, ids, category, runs, promptLevel, timeoutS, validate, effort, scaffold, subagentModel };
}

function start(opts, deps) {
    const d = { spawn: realSpawn, sweepRunning, pgrepBattery, hasFlock, now: Date.now, ...(deps || {}) };
    const cfg = getConfig();
    const b = buildArgs(opts || {});
    if (b.errors.length) throw new Error(b.errors.join('; '));
    // Adopt first: a POST that arrives before the browser's first /live poll must still see a
    // battery that survived a dashboard restart, or it would start a second one beside it.
    try { maybeAdopt(undefined, { force: true }); } catch { /* pgrepBattery below still guards */ }
    // B7: nothing heavy runs beside a capped battery, and never two batteries.
    if (live.running) throw new Error(`refused: a codebench battery is already running (${live.battery ? live.battery.name : 'starting'}, pid ${live.pid})`);
    if (d.sweepRunning()) throw new Error("refused: LL-Dash's own sweep is running; a battery's wall clock would be corrupted");
    const others = d.pgrepBattery();
    if (others.length) throw new Error(`refused: harness/run.py is already running outside the dashboard (pid ${others.map((x) => x.pid).join(', ')})`);
    if (!fs.existsSync(path.join(cfg.root, 'harness', 'run.py'))) throw new Error(`codebench not found at ${cfg.root} (set codebench.root in dashboard.config.json)`);
    const outDir = path.join(resultsRoot(cfg.root), b.outName);
    if (fs.existsSync(outDir)) throw new Error(`refused: results/${b.outName} already exists; pick another outName (run.py would append into it)`);
    const args = [...b.args, '--out', outDir];
    // flock -n: if a shell session holds the lock, run.py never starts and the exit is reported
    // (exit 1, "flock: failed to get lock") instead of two batteries sharing the GPU.
    const useLock = cfg.lock && d.hasFlock();
    const cmd = useLock ? 'flock' : cfg.python;
    const argv = useLock ? ['-n', cfg.lock, cfg.python, ...args] : args;
    live = freshLive();
    live.running = true; live.startedAt = d.now(); live.command = [cmd, ...argv].join(' '); live.cwd = cfg.root; live.outDir = outDir;
    live.battery = { name: b.outName, out: outDir, tasks: b.ids, runs: b.runs, config: { runner: b.runner, model: b.model || null, prompt_level: b.promptLevel, timeout_s: b.timeoutS, category: b.category || null, validate: b.validate, effort: b.effort || null, scaffold: b.scaffold || null, subagent_model: b.subagentModel || null }, server: null };
    // detached: run.py's own children (opencode/claude, the sandbox test runs) share its process
    // group, so stop() can end the whole tree with one signal. It does NOT survive a dashboard
    // restart (its stdout is our pipe; pm2 kills the tree) -- pgrepBattery is for batteries started
    // from a shell, which a restarted dashboard must not run beside.
    const childEnv = { ...process.env, PYTHONUNBUFFERED: '1' };
    // harness/runners/claude.py reads all three: --effort, --settings/--disallowedTools, and the
    // subagent pin. No run.py flag exists for any of them, and none is invented here.
    if (b.effort) childEnv.CODEBENCH_CLAUDE_EFFORT = b.effort;
    if (b.scaffold && b.runner === 'pi') childEnv.CODEBENCH_PI_EXT = b.scaffold;   // harness/runners/pi.py variant()
    else if (b.scaffold) childEnv.CODEBENCH_CLAUDE_SCAFFOLD = b.scaffold;
    if (b.subagentModel) childEnv.CODEBENCH_CLAUDE_SUBAGENT_MODEL = b.subagentModel;
    child = d.spawn(cmd, argv, { cwd: cfg.root, stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: childEnv });
    live.pid = child.pid || null;
    const c = child;
    let buf = '';
    const feed = (chunk) => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i); buf = buf.slice(i + 1);
            if (!line.trim()) continue;
            const ev = parseEvent(line);
            if (!ev) { live.malformed++; continue; }
            applyEvent(live, ev);
            emit(ev);
        }
    };
    if (c.stdout) c.stdout.on('data', (b2) => feed(b2.toString()));
    if (c.stderr) c.stderr.on('data', (b2) => { live.stderrTail = (live.stderrTail + b2.toString()).slice(-8000); });
    c.on('error', (e) => { live.error = e.message; });
    c.on('close', (code, signal) => {
        if (buf.trim()) feed('\n');
        live.running = false; live.exitCode = code; live.finishedAt = d.now();
        if (signal) live.error = live.error || `killed by ${signal}`;
        else if (code !== 0 && !live.error) live.error = (live.events === 0 && /flock/.test(live.command) && code === 1 ? `refused: could not take ${cfg.lock} (a shell session is running a battery)` : `run.py exited ${code}`) + (live.stderrTail ? `: ${live.stderrTail.trim().split('\n').pop()}` : '');
        if (killTimer) { clearTimeout(killTimer); killTimer = null; }
        if (child === c) child = null;
        emit({ ev: 'process_exit', code, signal });
    });
    emit({ ev: 'process_start', pid: live.pid });
    return { ok: true, pid: live.pid, command: live.command, outDir };
}
function emit(ev) {
    const fn = module.exports.broadcast; if (typeof fn !== 'function') return;
    try { fn(JSON.stringify({ event: ev, live: liveSnapshot() })); } catch { /* a dead client is the server's problem */ }
}
function liveSnapshot() {
    const now = Date.now();
    const s = { ...live, tasks: live.tasks, current: live.current ? { ...live.current } : null };
    s.elapsed_s = live.startedAt ? (live.finishedAt || now) / 1000 - live.startedAt / 1000 : null;
    if (s.current) { s.current.elapsed_s_now = live.running ? (now - s.current.startedAt) / 1000 : s.current.elapsed_s; delete s.current.reads; }
    // What is running, in words (lib/runlabel.js): model display, quant, ctx, KV, devices, MTP,
    // harness. On the snapshot itself, so SSE pushes and the /live poll agree.
    try {
        s.run_info = live.battery ? require('./runlabel').describeRun(live.battery.config, live.battery.server, { detected: deviceResolver }) : null;
    } catch { s.run_info = null; }
    return s;
}
// server4.js supplies (binary) => [{id, description}] from its --list-devices cache, so a Vulkan
// id is named after the card it is on this build (Vulkan0 has been both cards over time).
let deviceResolver = null;
function setDeviceResolver(fn) { deviceResolver = typeof fn === 'function' ? fn : null; }
function stop(deps) {
    if (!child || !live.running) return { running: false };
    const c = child; const pid = c.pid;
    // pid must be a real positive pid: process.kill(-0) would signal OUR OWN process group.
    const kill = (sig) => { if (Number.isInteger(pid) && pid > 1) { try { process.kill(-pid, sig); return; } catch { /* no such group: fall through */ } } try { c.kill(sig); } catch { /* gone */ } };
    kill('SIGTERM');
    live.error = live.error || 'stopped from the dashboard';
    killTimer = setTimeout(() => { if (child === c && live.running) kill('SIGKILL'); }, ((deps && deps.graceMs) ?? 10000));
    if (killTimer.unref) killTimer.unref();
    return { running: true, stopping: true, pid };
}

// ---------- live transcript tail ----------
// The cloud runners (agy, claude) emit one synthetic step at the very end, so between task_start
// and task_done the event stream says nothing for 20 minutes. Every runner now streams its
// transcript to disk line by line (<out>/<task>[__rN]/<runner>.jsonl), so the tail of that file
// is the live view. Read incrementally (offset + remainder: a 1500-line agy transcript is 700KB
// and the runner is mid-write, so only complete lines are parsed), stats accumulate over the
// WHOLE file, and the whole thing is cached for TAIL_CACHE_MS so polling cannot hammer the disk.
// Only getLive() (GET /api/codebench/live) pays for it: liveSnapshot() on the SSE path does not.
const TAIL_LINES = 40;
const TAIL_MAX_LINE = 600;      // chars per raw tail line: a file read is a single line
const TAIL_CACHE_MS = 2000;
// A result or transcript last written more than this before the battery started is an earlier
// attempt's, left in a dir the battery is re-running into (adoptedLive, currentTranscriptPath).
const STALE_SLACK_MS = 2000;
const TAIL_TEXT_MAX = 1500;     // chars of "last text" kept
let tailState = null;           // {path, offset, remainder, lines[], stats, at, error, lines_total}
let lastPlan = null;            // the previous task's final plan {task, run, todo, revisions, at}

function freshTailStats(runner) {
    return {
        format: FORMAT_OF(runner) || null, tool_calls: 0, tool_errors: 0, tokens_in: null, tokens_out: null,
        last_text: null, last_tool: null, done: false, lines_total: 0,
        _tool_ids: new Set(), _resp_ids: new Set(), _text_step: null, _text_buf: '', _tok_per_msg: new Map(),
    };
}
// One transcript line into the running stats. Formats (from the files on disk, 2026-09-21):
//   agy:      {"event":"step_update","step_update":{step_index,state:ACTIVE|DONE|ERROR,step_type:tool|agent_response,
//             tool_name,text_delta,usage:{input_tokens,output_tokens}}} ... {"event":"result","result":{response}}
//             ACTIVE/DONE share a step_index (count terminal states once); text arrives as text_delta
//             on ACTIVE agent_response lines, all for one step_index -> concatenate per index.
//   opencode: {"type":"tool_use","part":{type:"tool",callID,tool}}, {"type":"text","part":{text}},
//             {"type":"step_finish","part":{id,tokens:{input,output}}}
//   claude:   {"type":"assistant","message":{id,content:[{type:tool_use|text|thinking}],usage:{output_tokens}}}
//             (one line per content block, same message id, cumulative usage) ... {"type":"result","usage":{}}
//   pi:       {"type":"message_end","message":{role:"assistant",content:[{type:toolCall,id,name,arguments}|{type:text}|
//             {type:thinking}],usage:{input,output,cacheRead}}} (usage is PER message, so it sums), then
//             {"type":"tool_execution_end","toolCallId","isError"} ... {"type":"agent_settled"}. tokens_in is
//             input + cacheRead, exactly as harness/runners/pi.py's PiTracker records it on the row.
function applyTranscriptLine(st, line) {
    st.lines_total++;
    const t = line.trim(); if (!t.startsWith('{')) return;
    let o; try { o = JSON.parse(t); } catch { return; }
    if (!o || typeof o !== 'object') return;
    const fmt = st.format;
    if (fmt === 'agy' || (fmt == null && o.event === 'step_update')) {
        if (o.event === 'step_update' && o.step_update && typeof o.step_update === 'object') {
            const su = o.step_update; const idx = su.step_index;
            if (su.step_type === 'tool') {
                st.last_tool = su.tool_name || (su.tool_info && su.tool_info.name) || st.last_tool;
                if ((su.state === 'DONE' || su.state === 'ERROR') && idx != null && !st._tool_ids.has(idx)) { st._tool_ids.add(idx); st.tool_calls++; if (su.state === 'ERROR') st.tool_errors++; }
            } else if (su.step_type === 'agent_response') {
                if (typeof su.text_delta === 'string') {
                    if (st._text_step !== idx) { st._text_step = idx; st._text_buf = ''; }
                    st._text_buf = (st._text_buf + su.text_delta).slice(-TAIL_TEXT_MAX); st.last_text = st._text_buf;
                }
                if (su.state === 'DONE' && su.usage && idx != null && !st._resp_ids.has(idx)) {
                    st._resp_ids.add(idx);
                    if (num(su.usage.input_tokens) != null) st.tokens_in = (st.tokens_in || 0) + su.usage.input_tokens;
                    if (num(su.usage.output_tokens) != null) st.tokens_out = (st.tokens_out || 0) + su.usage.output_tokens;
                }
            }
        } else if (o.event === 'result') { st.done = true; if (o.result && typeof o.result.response === 'string') st.last_text = o.result.response.slice(-TAIL_TEXT_MAX); }
        return;
    }
    if (fmt === 'opencode' || (fmt == null && o.part && typeof o.part === 'object')) {
        const part = o.part || {};
        if (o.type === 'tool_use' && part.type === 'tool') {
            const id = part.callID || part.id;
            if (id == null || !st._tool_ids.has(id)) { if (id != null) st._tool_ids.add(id); st.tool_calls++; }
            st.last_tool = part.tool || st.last_tool; if (part.state && part.state.status === 'error') st.tool_errors++;
            // the model's plan: keep its LATEST todo list (the Live view shows it outside the transcript)
            if (/^(todowrite|todo_write|TodoWrite|update_plan)$/i.test(String(part.tool || '')) && part.state && part.state.input) { st.last_todo = { tool: part.tool, input: part.state.input, line: st.lines_total }; st.todo_updates = (st.todo_updates || 0) + 1; (st.todos = st.todos || []).push(st.last_todo); if (st.todos.length > 30) st.todos.shift(); }
        } else if (o.type === 'text' && typeof part.text === 'string') st.last_text = part.text.slice(-TAIL_TEXT_MAX);
        else if (o.type === 'step_finish' && part.tokens && (part.id == null || !st._resp_ids.has(part.id))) {
            if (part.id != null) st._resp_ids.add(part.id);
            if (num(part.tokens.input) != null) st.tokens_in = (st.tokens_in || 0) + part.tokens.input;
            if (num(part.tokens.output) != null) st.tokens_out = (st.tokens_out || 0) + part.tokens.output;
        }
        return;
    }
    if (fmt === 'claude' || (fmt == null && o.type === 'assistant')) {
        if (o.type === 'assistant' && o.message && typeof o.message === 'object') {
            const m = o.message;
            for (const c of (Array.isArray(m.content) ? m.content : [])) {
                if (!c || typeof c !== 'object') continue;
                if (c.type === 'tool_use') { const id = c.id; if (id == null || !st._tool_ids.has(id)) { if (id != null) st._tool_ids.add(id); st.tool_calls++; } st.last_tool = c.name || st.last_tool;
                    if (/^(TodoWrite|todowrite|update_plan)$/i.test(String(c.name || '')) && c.input) { st.last_todo = { tool: c.name, input: c.input, line: st.lines_total }; st.todo_updates = (st.todo_updates || 0) + 1; (st.todos = st.todos || []).push(st.last_todo); if (st.todos.length > 30) st.todos.shift(); } }
                else if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) st.last_text = c.text.slice(-TAIL_TEXT_MAX);
            }
            if (m.usage && num(m.usage.output_tokens) != null) { const k = m.id || `#${st.lines_total}`; st._tok_per_msg.set(k, Math.max(st._tok_per_msg.get(k) || 0, m.usage.output_tokens)); }
        } else if (o.type === 'result') {
            st.done = true;
            if (o.usage && num(o.usage.output_tokens) != null) st._result_tokens_out = o.usage.output_tokens;
            if (o.usage && num(o.usage.input_tokens) != null) st.tokens_in = o.usage.input_tokens;   // what run.py records as tokens_in (cache reads excluded)
        }
        return;
    }
    if (fmt === 'pi' || (fmt == null && PI_TYPES.has(o.type))) {
        if (o.type === 'message_end' && o.message && typeof o.message === 'object' && o.message.role === 'assistant') {
            const m = o.message;
            for (const c of (Array.isArray(m.content) ? m.content : [])) {
                if (!c || typeof c !== 'object') continue;
                if (c.type === 'toolCall') { const id = c.id; if (id == null || !st._tool_ids.has(id)) { if (id != null) st._tool_ids.add(id); st.tool_calls++; } st.last_tool = c.name || st.last_tool;
                    // SoL-Pi's update_plan {steps:[{id,goal,status}]}: the plan panel's todo list
                    if (/^(update_plan|todowrite|todo_write)$/i.test(String(c.name || '')) && c.arguments) { st.last_todo = { tool: c.name, input: c.arguments, line: st.lines_total }; st.todo_updates = (st.todo_updates || 0) + 1; (st.todos = st.todos || []).push(st.last_todo); if (st.todos.length > 30) st.todos.shift(); } }
                else if (c.type === 'text' && typeof c.text === 'string' && c.text.trim()) st.last_text = c.text.slice(-TAIL_TEXT_MAX);
            }
            const u = m.usage && typeof m.usage === 'object' ? m.usage : null;
            if (u) {
                if (num(u.input) != null || num(u.cacheRead) != null) st.tokens_in = (st.tokens_in || 0) + (num(u.input) || 0) + (num(u.cacheRead) || 0);
                if (num(u.output) != null) st.tokens_out = (st.tokens_out || 0) + u.output;
            }
        } else if (o.type === 'tool_execution_start') {
            // normally already counted from the assistant message's toolCall block (same id)
            const id = o.toolCallId; if (id == null || !st._tool_ids.has(id)) { if (id != null) st._tool_ids.add(id); st.tool_calls++; }
            st.last_tool = o.toolName || st.last_tool;
        } else if (o.type === 'tool_execution_end') {
            if (o.isError && (o.toolCallId == null || !st._resp_ids.has(o.toolCallId))) { if (o.toolCallId != null) st._resp_ids.add(o.toolCallId); st.tool_errors++; }
        } else if (o.type === 'agent_settled' || (o.type === 'codebench' && /TIMEOUT/.test(String(o.text || '')))) st.done = true;
        return;
    }
    // anything else: raw lines only, stats stay at their nulls/zeros
}
function publicStats(st) {
    let tokensOut = st.tokens_out;
    // claude: the per-message usage.output_tokens Claude Code streams are placeholders (8-16 per message, no
    // thinking); only the final result event carries the real count (thinking included). Until then: unknown.
    let tokensPending = false;
    if (st.format === 'claude') { tokensOut = st._result_tokens_out ?? null; tokensPending = tokensOut == null; }
    return { format: st.format, tool_calls: st.tool_calls, tool_errors: st.tool_errors, tokens_in: st.tokens_in, tokens_out: tokensOut, tokens_out_pending: tokensPending, last_text: st.last_text, last_tool: st.last_tool, done: st.done, lines_total: st.lines_total,
        last_todo: st.last_todo || null, todo_updates: st.todo_updates || 0, todos: st.todos || [] };
}
// Pure helper (tests, one-shot use): stats over a whole transcript text.
function transcriptStats(runner, text) {
    const st = freshTailStats(runner);
    for (const line of String(text || '').split('\n')) if (line.trim()) applyTranscriptLine(st, line);
    return publicStats(st);
}
const clip = (l) => (l.length > TAIL_MAX_LINE ? l.slice(0, TAIL_MAX_LINE) + ` …[+${l.length - TAIL_MAX_LINE} chars]` : l);

function currentTranscriptPath() {
    const c = live.current; if (!c) return null;
    const out = live.outDir || (live.battery && live.battery.out); if (!out) return null;
    const runner = live.battery && live.battery.config && live.battery.config.runner;
    const dirs = []; if (c.run > 1) dirs.push(path.join(out, `${c.task}__r${c.run}`)); dirs.push(path.join(out, c.task));
    for (const d of dirs) {
        const cands = []; if (runner) cands.push(path.join(d, `${runner}.jsonl`));
        try { for (const f of fs.readdirSync(d)) if (f.endsWith('.jsonl')) cands.push(path.join(d, f)); } catch { continue; }
        // A transcript last written before this battery started is an earlier attempt's (a rerun into
        // the same dir): the harness has not reached this task's rewrite yet, so there is none to tail.
        const floor = live.startedAt ? live.startedAt - STALE_SLACK_MS : null;
        for (const f of cands) { try { const st = fs.statSync(f); if (st.isFile() && !(floor != null && st.mtimeMs < floor)) return { path: f, runner: runner || path.basename(f, '.jsonl'), dir: d }; } catch { /* next */ } }
        return { path: null, runner: runner || null, dir: d };   // task dir exists, transcript not yet
    }
    return { path: null, runner: runner || null, dir: dirs[dirs.length - 1] };
}
function filesChanged(sandbox) {
    // `git status --porcelain | wc -l` over the sandbox task_start named: modified + untracked, any runner.
    if (!sandbox || typeof sandbox !== 'string') return null;
    try { if (!fs.statSync(sandbox).isDirectory()) return null; } catch { return null; }
    try {
        const r = spawnSync('git', ['-C', sandbox, 'status', '--porcelain'], { encoding: 'utf-8', timeout: 3000 });
        if (r.status !== 0 || typeof r.stdout !== 'string') return null;
        return r.stdout.split('\n').filter((l) => l.trim()).length;
    } catch { return null; }
}
// The first bytes of an incrementally read file, to notice an in-place rewrite that grew back
// past the read offset before the next poll (a rerun's transcript: same path, same inode).
const HEAD_BYTES = 256;
function readHead(fd) {
    try { const b = Buffer.alloc(HEAD_BYTES); const n = fs.readSync(fd, b, 0, HEAD_BYTES, 0); return b.subarray(0, n); } catch { return null; }
}
function sameHead(fd, head) {
    if (!head || !head.length) return true;
    const now = readHead(fd);
    return !!now && now.length >= head.length && now.subarray(0, head.length).equals(head);
}
function readTailIncremental(st, file) {
    // Append what was written since the last read; parse complete lines only; keep the last TAIL_LINES.
    let fd; try { fd = fs.openSync(file, 'r'); } catch { return; }
    try {
        const size = fs.fstatSync(fd).size;
        // Rewritten in place (truncated, then grown back past where we were): the bytes we hold are
        // another file's. Shrinking is the obvious sign; a changed head catches the rest.
        if (size < st.offset || (st.offset && !sameHead(fd, st.head))) { st.offset = 0; st.remainder = Buffer.alloc(0); st.lines = []; st.stats = freshTailStats(st.stats.format); st.head = null; }
        if (st.offset === 0 && size > 0) st.head = readHead(fd);
        if (size === st.offset) return;
        const buf = Buffer.alloc(size - st.offset); const n = fs.readSync(fd, buf, 0, buf.length, st.offset); st.offset += n;
        let data = Buffer.concat([st.remainder, buf.subarray(0, n)]);
        let i;
        while ((i = data.indexOf(0x0a)) >= 0) {
            const line = data.subarray(0, i).toString('utf-8'); data = data.subarray(i + 1);
            if (!line.trim()) continue;
            applyTranscriptLine(st.stats, line);
            st.lines.push(clip(line)); if (st.lines.length > TAIL_LINES) st.lines.splice(0, st.lines.length - TAIL_LINES);
        }
        st.remainder = Buffer.from(data);
    } finally { fs.closeSync(fd); }
}
// {task, run, runner, transcript, lines[], stats{...}, files_changed, elapsed_s, cap_s, at, note}
// or null when no task is running. maxAgeMs overrides the 2 s cache (tests).
function transcriptTail(opts) {
    const c = live.current; if (!c || !live.running) { tailState = null; return null; }
    const now = (opts && opts.now) || Date.now(); const maxAge = opts && opts.maxAgeMs != null ? opts.maxAgeMs : TAIL_CACHE_MS;
    const loc = currentTranscriptPath();
    const key = `${c.task}#${c.run}:${loc ? loc.path : ''}`;
    if (tailState && tailState.key === key && now - tailState.at < maxAge) return tailState.out;
    if (!tailState || tailState.key !== key) {
        // Keep the finished task's plan: the Live view shows it until the new task writes one, so a
        // plan written at the end of a short task doesn't flash up and vanish (Kyle, 2026-09-25).
        if (tailState && tailState.stats && tailState.stats.last_todo && tailState.out) lastPlan = { task: tailState.out.task, run: tailState.out.run, todo: tailState.stats.last_todo, revisions: tailState.stats.todo_updates || 1, at: now };
        tailState = { key, offset: 0, remainder: Buffer.alloc(0), lines: [], stats: freshTailStats(loc && loc.runner), at: 0, out: null };
    }
    if (loc && loc.path) readTailIncremental(tailState, loc.path);
    const stats = publicStats(tailState.stats);
    tailState.at = now;
    tailState.out = {
        task: c.task, run: c.run, runner: loc ? loc.runner : null, transcript: loc ? loc.path : null, sandbox: c.sandbox || null,
        lines: tailState.lines.slice(), bytes: tailState.offset,
        stats, files_changed: filesChanged(c.sandbox),
        // opencode sub-agents are being captured beside the transcript (the Live view then shows the transcript renderer,
        // which draws them inline, instead of the proxy-tap chat, which can only show one conversation at a time)
        subagents: !!(loc && loc.path && fs.existsSync(subagentStreamPath(loc.path))),
        elapsed_s: (now - c.startedAt) / 1000, cap_s: c.cap_s, at: now,
        note: loc && loc.path ? null : `no transcript yet under ${loc ? loc.dir : '(no out dir)'}`,
        previous_plan: lastPlan,
    };
    return tailState.out;
}

function getLive(opts) { if (!(opts && opts.noAdopt)) { try { maybeAdopt((opts || {}).root, opts); } catch { /* never break the live poll */ } } const s = liveSnapshot(); s.tail = transcriptTail(opts); s.batteries = runningBatteries(); return s; }
// Every battery running right now, for live view's lane switcher: a cloud (claude/agy) battery and a
// local (opencode/pi) one run side by side, one per queue lane. Newest first, as maybeAdopt picks.
function batteryLane(runner, dir) {
    const q = dir ? queueLane(dir) : null;   // the queue lane that runs it (local-gpu, local-3060, local-xtx, cloud)
    return q || (runner === 'claude' || runner === 'agy' ? 'cloud' : 'local');
}
const queueLaneCache = new Map();
function queueLane(dir) {
    const hit = queueLaneCache.get(dir);
    if (hit && Date.now() - hit.at < 60000) return hit.v;
    let v = null;
    try {
        const Database = require('better-sqlite3');
        const ro = new Database(require('./db').DB_PATH, { readonly: true, fileMustExist: true });
        try { const r = ro.prepare('SELECT lane FROM queue_items WHERE label = ? ORDER BY id DESC LIMIT 1').get(dir); v = r ? r.lane : null; } finally { ro.close(); }
    } catch { v = null; }
    queueLaneCache.set(dir, { at: Date.now(), v });
    return v;
}
function runningBatteries() {
    const out = (adoptState.scanned || []).filter((r) => r.adoptable).map((r) => ({
        dir: r.dir, runner: (r.battery && r.battery.runner) || null, model: (r.battery && r.battery.model) || null,
        lane: batteryLane(r.battery && r.battery.runner, r.dir), started: r.started, state: r.state,
        tasks: Array.isArray(r.battery && r.battery.tasks) ? r.battery.tasks.length : null,
    }));
    if (child && live.battery && live.battery.name && !out.some((b) => b.dir === live.battery.name)) {
        const cfg = live.battery.config || {};
        out.unshift({ dir: live.battery.name, runner: cfg.runner || null, model: cfg.model || null, lane: batteryLane(cfg.runner, live.battery.name), started: live.startedAt ? live.startedAt / 1000 : null, state: live.running ? 'running' : null, tasks: Array.isArray(live.battery.tasks) ? live.battery.tasks.length : null });
    }
    return out;
}
// Controls name the battery the viewer is looking at. With two lanes running, `live` can switch
// under a click (another tab chose the other lane); never pause or stop a battery nobody pointed at.
function wrongTarget(o) {
    const want = o && o.battery ? String(o.battery) : null;
    const have = live.battery && live.battery.name;
    return want && want !== have ? { running: !!live.running, error: `refused: this view now shows ${have || 'no battery'}, not ${want}; reload and retry` } : null;
}
function _resetForTests() { baselineCache = { at: 0, root: null, map: null, retired: new Set(), diagnostic: new Set() }; live = freshLive(); child = null; tailState = null; if (killTimer) { clearTimeout(killTimer); killTimer = null; } cache.clear(); snapStatsCache.clear(); transcriptParseCache.clear(); subMergeCache.clear(); taskInfoCache.clear(); taskInfoInflight.clear(); adoptState = { at: 0, dir: null, scanned: [] }; procScanImpl = defaultProcScan; procServerCache = { at: 0, v: null }; deviceResolver = null; }


// Model ids a runner will accept, for the Kick-off datalist. Best effort: an empty list means
// free text. agy: `agy models` (tab-separated id<TAB>name). pi: opencode's llama-local ids (the pi
// runner builds its models.json from that same list, so the ids are identical). opencode: provider/model ids from its
// config. claude: the CLI resolves names itself, so a short static list.
const MODELS_CACHE = { at: 0, agy: null };
async function listModels(runner) {
    if (runner === 'agy') {
        if (MODELS_CACHE.agy && Date.now() - MODELS_CACHE.at < 300000) return MODELS_CACHE.agy;
        const out = await new Promise((resolve) => {
            let buf = ''; let done = false;
            const finish = () => { if (!done) { done = true; resolve(buf); } };
            try {
                const child = require('child_process').spawn('agy', ['models'], { stdio: ['ignore', 'pipe', 'ignore'] });
                child.stdout.on('data', (d) => { buf += d; });
                child.on('close', finish); child.on('error', finish);
                setTimeout(() => { try { child.kill(); } catch (e) {} finish(); }, 30000);
            } catch (e) { finish(); }
        });
        const models = out.split('\n').map((l) => l.split('\t')).filter((p) => p.length >= 2 && /^[\w./:@+-]+$/.test(p[0]))
            .map((p) => ({ id: p[0].trim(), name: p[1].trim() }));
        MODELS_CACHE.agy = models; MODELS_CACHE.at = Date.now();
        return models;
    }
    if (runner === 'opencode' || runner === 'pi' || runner === 'tau') {
        try {
            const cfg = JSON.parse(require('fs').readFileSync(require('path').join(require('os').homedir(), '.config/opencode/opencode.json'), 'utf8'));
            const models = [];
            for (const [prov, p] of Object.entries(cfg.provider || {})) {
                if ((runner === 'pi' || runner === 'tau') && prov !== 'llama-local') continue;   // pi and tau are given the llama-local provider only
                for (const [id, m] of Object.entries(p.models || {})) models.push({ id: `${prov}/${id}`, name: (m && m.name) || id });
            }
            return models;
        } catch (e) { return []; }
    }
    // claude: the CLI resolves both aliases and full ids itself and has NO listing subcommand
    // (`claude models list` waits on stdin forever), so this is a written-down list, not a probe --
    // and the field stays free text so any id works. "CLI default" is an agent configuration, not
    // a model: it resolves to Opus and may delegate subagent turns to Fable (one benchmark session
    // billed 1.43M input tokens of Fable delegation on a row labelled Opus).
    if (runner === 'claude') return [
        { id: '', name: 'CLI default — resolves to Opus, may delegate subagents to Fable' },
        { id: 'fable', name: 'fable (alias)' }, { id: 'opus', name: 'opus (alias)' },
        { id: 'sonnet', name: 'sonnet (alias)' }, { id: 'haiku', name: 'haiku (alias)' },
        { id: 'claude-fable-5-1', name: 'Fable 5.1 (pinned id)' },
        { id: 'claude-opus-5', name: 'Opus 5 (pinned id)' },
        { id: 'claude-sonnet-5', name: 'Sonnet 5 (pinned id)' },
        { id: 'claude-haiku-4-5-20251001', name: 'Haiku 4.5 (pinned id)' },
    ];
    return [];
}

// ================= TRANSCRIPT MODEL (plan A5 / A5a) =================
// One normalised event stream out of four runner formats, so the Benchmarks tab can render a
// run the way the Interactive tab renders a chat. The canonical mapping of each runner's lines
// is harness/events.py (StepTracker / AgyStepTracker / ClaudeStepTracker) and harness/runners/pi.py
// (PiTracker); this mirrors its
// field knowledge and adds what a reader needs that a live `step` event drops: the tool INPUT,
// the tool OUTPUT, and the full text of every assistant part.
//
//   event: {i, t_s|null, kind, tool?, input?, output?, text?, tokens?, reason?, error?, id?, path?}
//   kind:  prompt | text | reasoning | tool_call | tool_result | finish | compaction | error
//
// Per-runner notes (verified against the transcripts on disk, 2026-09-22):
//   opencode  {"type":..,"timestamp":<ms>,"part":{...}} -- ONE line carries a tool's input AND its
//             output (state.status completed|error|pending), so a tool_call and its tool_result are
//             emitted from the same line, paired by part.callID. text parts with
//             metadata.compaction_continue are compaction markers, not text. step-finish carries
//             `reason` (stop|tool-calls|length) and per-turn token counts. t_s from `timestamp`.
//   claude    one content block per line. assistant text|thinking|tool_use, then a `user` line with
//             the tool_result, paired by tool_use_id. system/compact_boundary -> compaction; the
//             final `result` line -> finish (stop_reason) or error (is_error). server_tool_use and
//             advisor_tool_result are skipped, exactly as events.py skips them, so the tool counts
//             here and in the result row agree. t_s from the ISO `timestamp`.
//   agy       {"event":"step_update","step_update":{step_index,state:ACTIVE|DONE|ERROR,step_type,...}}.
//             ACTIVE and DONE SHARE a step_index: the ACTIVE tool line is the call (tool_info.parameters),
//             the DONE/ERROR line is the result (tool_info.output / tool_info.error) -- de-duplicated by
//             step_index so a re-emitted state never doubles a call. agent_response text arrives as
//             text_delta on ACTIVE lines, all for one step_index: accumulated and flushed as ONE text
//             event when the step ends. agy stamps no wall clock at all, only duration_seconds per
//             step, so t_s is the cumulative sum of those durations -- an estimate, flagged as
//             stats.t_source = 'cumulative_durations' and shown with a ~ in the UI.
//   pi        {"type":..,"cb_t":<ms>} -- pi's own events carry no clock; harness/runners/pi.py stamps each
//             line with cb_t on arrival (transcripts from before that fall back to message.timestamp,
//             then the session line's ISO timestamp). A tool call is seen THREE times (the assistant
//             message_end's toolCall block, tool_execution_start, and again as a toolResult message)
//             and its result twice (tool_execution_end, the toolResult message_end): the call is taken
//             from the toolCall block, the result from tool_execution_end, both de-duplicated by
//             toolCallId. An edit's result carries details.diff, appended to the output. Each assistant
//             message_end carries its OWN usage (not cumulative) and a stopReason
//             (stop|toolUse|length|error|aborted) -> one turn `finish`, or an `error` for error/aborted;
//             agent_settled closes the run with one visible `finish`. The user message_end is the
//             `prompt`. compaction_start -> compaction, auto_retry_start / stderr / the harness's own
//             {"type":"codebench","text":"TIMEOUT"} -> error. tokens_in = input + cacheRead, as PiTracker.
const TRANSCRIPT_KINDS = ['prompt', 'text', 'reasoning', 'tool_call', 'tool_result', 'finish', 'compaction', 'error'];
const TOOL_CLIP = 4096;            // chars per tool input and per tool output
const TEXT_CLIP = 64000;           // chars per text / reasoning event
const TRANSCRIPT_MAX_BYTES = 2 * 1024 * 1024;   // cap on one /transcript response
const TRANSCRIPT_PAGE = 400;       // default events per page
const TRANSCRIPT_PAGE_MAX = 5000;

function clipStr(s, max) {
    if (typeof s !== 'string') return s;
    return s.length > max ? `${s.slice(0, max)}\n…[+${s.length - max} chars clipped]` : s;
}
// Any runner-supplied value as display text: a string, claude's tool_result content blocks, or JSON.
function asText(v, max) {
    if (v == null) return null;
    if (typeof v === 'string') return clipStr(v, max);
    if (Array.isArray(v)) {
        const parts = [];
        for (const b of v) {
            if (typeof b === 'string') parts.push(b);
            else if (b && typeof b === 'object') parts.push(typeof b.text === 'string' ? b.text : safeJson(b));
            else if (b != null) parts.push(String(b));
        }
        return clipStr(parts.join('\n'), max);
    }
    if (typeof v === 'object') return clipStr(safeJson(v), max);
    return clipStr(String(v), max);
}
function safeJson(v) { try { return JSON.stringify(v, null, 1); } catch { return String(v); } }
function isoMs(s) { const t = Date.parse(s); return Number.isFinite(t) ? t : null; }

// A stateful parser so a growing transcript can be read incrementally (the running task is polled
// every 3 s and an agy transcript is 700 KB -- re-parsing it each poll is not free).
function createTranscriptParser(runner) {
    const st = {
        runner: RUNNERS.includes(runner) ? runner : null,
        detected: RUNNERS.includes(runner) ? runner : null,
        events: [], i: 0, lines: 0, malformed: 0, skipped: 0,
        t0: null, tAcc: 0, t_source: null,
        open: new Map(),            // tool id -> {tool, input}: a call awaiting its result
        called: new Set(), resulted: new Set(),
        agyText: { idx: null, buf: '' },
        piStop: null,               // pi: the last assistant stopReason, for agent_settled's finish
        tokens_in: 0, tokens_out: 0, tokens_thinking: 0,
        msgTokens: new Map(), resultTokensOut: null, resultTokensIn: null,
        counts: Object.fromEntries(TRANSCRIPT_KINDS.map((k) => [k, 0])),
        tool_errors: 0, last_text: null, done: false, finish_reason: null,
        ms: [],                     // opencode: each event's absolute time (ms), by event index -- merging sub-agent streams
    };
    st.counts.tool_error = 0;

    const push = (ev) => { ev.i = st.i++; st.events.push(ev); st.counts[ev.kind] = (st.counts[ev.kind] || 0) + 1; if (ev.kind === 'text' && ev.text) st.last_text = ev.text; return ev; };
    const stampWall = (ms) => { if (ms == null) return null; if (st.t0 == null) { st.t0 = ms; st.t_source = st.t_source || 'timestamps'; } return Math.round(((ms - st.t0) / 1000) * 10) / 10; };

    function detect(o) {
        if (st.detected) return st.detected;
        if (o.event === 'step_update' || o.event === 'result' || o.event === 'init') st.detected = 'agy';
        else if (o.part && typeof o.part === 'object') st.detected = 'opencode';
        else if (o.type === 'assistant' || o.type === 'user' || o.type === 'system' || o.type === 'result') st.detected = 'claude';
        else if (PI_TYPES.has(o.type)) st.detected = 'pi';
        return st.detected;
    }

    // ---- opencode ----
    // A line from the harness's sub-agent stream (results/<dir>/<task>/subagents/stream.jsonl, runners/opencode.py
    // SubagentStream, 2026-10-20) is an ordinary opencode event plus `codebench_subagent` {label, session, parent_call,
    // agent}: its events carry `sub` (the label: "1", "2", "2.1") so the views can draw them inline, labelled.
    function feedOpencode(o) {
        const r = feedOpencode1(o);
        const tag = o.codebench_subagent && typeof o.codebench_subagent === 'object' ? o.codebench_subagent : null;
        const pt = o.part && typeof o.part === 'object' && o.part.time && typeof o.part.time === 'object' ? o.part.time : {};
        const line = num(pt.start) ?? num(o.timestamp);     // when it began (text / thinking stream from their start)
        for (const ev of r) {
            if (tag && tag.label != null) { ev.sub = String(tag.label); if (tag.agent) ev.sub_agent = String(tag.agent); }
            if (st.ms[ev.i] == null) st.ms[ev.i] = line;
        }
        return r;
    }
    function feedOpencode1(o) {
        const part = o.part && typeof o.part === 'object' ? o.part : null;
        if (!part) {
            if (o.type === 'error') { const e = o.error || {}; return [push({ kind: 'error', t_s: stampWall(num(o.timestamp)), error: true, text: asText(((e.data || {}).message) || e.message || e.name || e, TEXT_CLIP) })]; }
            st.skipped++; return [];
        }
        if (o.type === 'subagent_start' || part.type === 'subagent-start') {   // the harness's marker: a sub-agent began here
            const tag = o.codebench_subagent || {};
            const ms = num(o.timestamp);
            const ev = push({ kind: 'subagent', t_s: stampWall(ms), session: part.sessionID || o.sessionID || null, parent_call: tag.parent_call || null,
                title: part.title || null, description: part.description || null, agent: part.subagent_type || tag.agent || null, text: asText(part.prompt, TEXT_CLIP) });
            st.ms[ev.i] = ms;
            return [ev];
        }
        const t_s = stampWall(num(o.timestamp) ?? num((part.time || {}).start));
        const out = [];
        if (part.type === 'tool') {
            const id = part.callID || part.id || `#${st.lines}`;
            const state = part.state && typeof part.state === 'object' ? part.state : {};
            const status = state.status;
            if (!st.called.has(id)) {
                st.called.add(id);
                const ev = push({ kind: 'tool_call', t_s, tool: part.tool || null, id, input: asText(state.input, TOOL_CLIP), title: state.title || null });
                st.ms[ev.i] = num((state.time || {}).start) ?? num(o.timestamp);
                out.push(ev);
                st.open.set(id, part.tool || null);
            }
            if ((status === 'completed' || status === 'error') && !st.resulted.has(id)) {
                st.resulted.add(id);
                const err = status === 'error';
                if (err) { st.tool_errors++; st.counts.tool_error++; }
                const body = err ? (state.error ?? state.output) : state.output;
                const ev = push({ kind: 'tool_result', t_s: stampWall(num((state.time || {}).end)) ?? t_s, tool: part.tool || st.open.get(id) || null, id, error: err || undefined, output: asText(body, TOOL_CLIP) });
                st.ms[ev.i] = num((state.time || {}).end) ?? num(o.timestamp);
                out.push(ev);
                st.open.delete(id);
            }
            return out;
        }
        if (part.type === 'text') {
            if ((part.metadata || {}).compaction_continue) return [push({ kind: 'compaction', t_s, text: asText(part.text, 400) })];
            return [push({ kind: 'text', t_s, text: asText(part.text, TEXT_CLIP) })];
        }
        if (part.type === 'reasoning') return [push({ kind: 'reasoning', t_s, text: asText(part.text, TEXT_CLIP) })];
        if (part.type === 'step-finish') {
            const tk = part.tokens && typeof part.tokens === 'object' ? part.tokens : null;
            if (tk) { st.tokens_in += num(tk.input) || 0; st.tokens_out += num(tk.output) || 0; st.tokens_thinking += num(tk.reasoning) || 0; }
            st.finish_reason = part.reason || st.finish_reason;
            return [push({ kind: 'finish', t_s, reason: part.reason || null, turn: true, tokens: tk ? { in: num(tk.input), out: num(tk.output), reasoning: num(tk.reasoning), cache_read: num((tk.cache || {}).read), cache_write: num((tk.cache || {}).write) } : null })];
        }
        st.skipped++; return [];
    }

    // ---- claude ----
    function feedClaude(o) {
        const t_s = stampWall(isoMs(o.timestamp));
        const m = o.message && typeof o.message === 'object' ? o.message : {};
        const blocks = Array.isArray(m.content) ? m.content.filter((c) => c && typeof c === 'object') : [];
        const out = [];
        if (o.type === 'assistant') {
            const u = m.usage && typeof m.usage === 'object' ? m.usage : null;
            if (u && num(u.output_tokens) != null) { const k = m.id || `#${st.lines}`; st.msgTokens.set(k, Math.max(st.msgTokens.get(k) || 0, u.output_tokens)); }
            for (const c of blocks) {
                if (c.type === 'text') out.push(push({ kind: 'text', t_s, text: asText(c.text, TEXT_CLIP) }));
                else if (c.type === 'thinking') out.push(push({ kind: 'reasoning', t_s, text: asText(c.thinking, TEXT_CLIP), redacted: !c.thinking ? true : undefined }));
                else if (c.type === 'tool_use') {
                    const id = c.id || `#${st.lines}`;
                    if (!st.called.has(id)) {
                        st.called.add(id); st.open.set(id, c.name || null);
                        out.push(push({ kind: 'tool_call', t_s, tool: c.name || null, id, input: asText(c.input, TOOL_CLIP), subagent: o.parent_tool_use_id ? true : undefined }));
                    }
                } else st.skipped++;   // server_tool_use / advisor_tool_result: events.py skips them, so do we
            }
            return out;
        }
        if (o.type === 'user') {
            for (const c of blocks) {
                if (c.type !== 'tool_result') { st.skipped++; continue; }
                const id = c.tool_use_id || `#${st.lines}`;
                if (st.resulted.has(id)) continue;
                st.resulted.add(id);
                if (c.is_error) { st.tool_errors++; st.counts.tool_error++; }
                out.push(push({ kind: 'tool_result', t_s, tool: st.open.get(id) || null, id, error: c.is_error ? true : undefined, output: asText(c.content, TOOL_CLIP) }));
                st.open.delete(id);
            }
            return out;
        }
        if (o.type === 'system' && o.subtype === 'compact_boundary') return [push({ kind: 'compaction', t_s, text: asText((o.compact_metadata || {}).trigger, 200) })];
        if (o.type === 'result') {
            st.done = true;
            const u = o.usage && typeof o.usage === 'object' ? o.usage : {};
            if (num(u.output_tokens) != null) st.resultTokensOut = u.output_tokens;
            if (num(u.input_tokens) != null) st.resultTokensIn = u.input_tokens;
            const th = num((u.output_tokens_details || {}).thinking_tokens); if (th != null) st.tokens_thinking = th;
            const reason = o.stop_reason || o.subtype || null;
            st.finish_reason = reason;
            const tokens = { in: num(u.input_tokens), out: num(u.output_tokens), cache_read: num(u.cache_read_input_tokens), cache_write: num(u.cache_creation_input_tokens), thinking: th };
            if (o.is_error || String(o.subtype || '').startsWith('error')) {
                let msg = o.result || o.subtype || 'error'; if (Array.isArray(msg)) msg = msg.join(' ');
                return [push({ kind: 'error', t_s, error: true, reason, tokens, text: asText(msg, TEXT_CLIP) })];
            }
            return [push({ kind: 'finish', t_s, reason, tokens, text: asText(o.result, TEXT_CLIP) })];
        }
        if (o.type === 'error') { const e = o.error; return [push({ kind: 'error', t_s, error: true, text: asText((e && typeof e === 'object' ? e.message : e) || o.message || 'error', TEXT_CLIP) })]; }
        st.skipped++; return [];   // system init / thinking_tokens / rate_limit_event / task_* / tool_progress
    }

    // ---- agy ----
    function agyT(dur) {                       // agy stamps no clock: cumulative duration_seconds
        st.t_source = st.t_source || 'cumulative_durations';
        const at = st.tAcc + (num(dur) || 0);
        if (num(dur) != null) st.tAcc = at;
        return Math.round(at * 10) / 10;
    }
    function flushAgyText() {
        const { idx, buf } = st.agyText;
        st.agyText = { idx: null, buf: '' };
        if (idx == null || !buf) return null;
        return push({ kind: 'text', t_s: Math.round(st.tAcc * 10) / 10, text: clipStr(buf, TEXT_CLIP) });
    }
    function feedAgy(o) {
        const out = [];
        const su = o.step_update && typeof o.step_update === 'object' ? o.step_update : null;
        if (su) {
            const idx = su.step_index, state = su.state, stype = su.step_type;
            if (st.agyText.idx != null && st.agyText.idx !== idx) { const f = flushAgyText(); if (f) out.push(f); }
            if (state === 'DONE' || state === 'ERROR') {
                const u = su.usage && typeof su.usage === 'object' ? su.usage : null;
                if (u) { st.tokens_in += num(u.input_tokens) || 0; st.tokens_out += num(u.output_tokens) || 0; st.tokens_thinking += num(u.thinking_tokens) || 0; }
            }
            if (stype === 'tool') {
                const ti = su.tool_info && typeof su.tool_info === 'object' ? su.tool_info : {};
                const tool = su.tool_name || ti.name || null;
                const id = idx == null ? `#${st.lines}` : `s${idx}`;
                if (!st.called.has(id)) { st.called.add(id); st.open.set(id, tool); out.push(push({ kind: 'tool_call', t_s: agyT(null), tool, id, input: asText(ti.parameters, TOOL_CLIP) })); }
                if ((state === 'DONE' || state === 'ERROR') && !st.resulted.has(id)) {
                    st.resulted.add(id);
                    const err = state === 'ERROR';
                    if (err) { st.tool_errors++; st.counts.tool_error++; }
                    const body = err ? (ti.error && typeof ti.error === 'object' ? (ti.error.message || ti.error) : (ti.error ?? ti.output)) : ti.output;
                    out.push(push({ kind: 'tool_result', t_s: agyT(su.duration_seconds), tool: tool || st.open.get(id) || null, id, error: err || undefined, output: asText(body, TOOL_CLIP) }));
                    st.open.delete(id);
                }
                return out;
            }
            if (stype === 'agent_response') {
                if (typeof su.text_delta === 'string' && su.text_delta) {
                    if (st.agyText.idx !== idx) st.agyText = { idx, buf: '' };
                    st.agyText.buf += su.text_delta;
                    st.last_text = st.agyText.buf.slice(-2000);
                }
                if (state === 'DONE' || state === 'ERROR') {
                    const f = flushAgyText(); if (f) out.push(f);
                    const t_s = agyT(su.duration_seconds);
                    if (state === 'ERROR') { const e = su.error; out.push(push({ kind: 'error', t_s, error: true, text: asText((e && typeof e === 'object' ? e.message : e) || 'agent_response ERROR', TEXT_CLIP) })); }
                    else {
                        const u = su.usage && typeof su.usage === 'object' ? su.usage : null;
                        out.push(push({ kind: 'finish', t_s, reason: null, turn: true, tokens: u ? { in: num(u.input_tokens), out: num(u.output_tokens), thinking: num(u.thinking_tokens), cache_read: num(u.cache_read_tokens) } : null }));
                    }
                }
                return out;
            }
            if (su.duration_seconds != null && (state === 'DONE' || state === 'ERROR')) agyT(su.duration_seconds);   // checkpoint etc: keep the clock honest
            st.skipped++; return out;
        }
        if (o.event === 'result') {
            const f = flushAgyText(); if (f) out.push(f);
            st.done = true;
            const r = o.result && typeof o.result === 'object' ? o.result : {};
            const u = r.usage && typeof r.usage === 'object' ? r.usage : null;
            if (u) { if (num(u.input_tokens) != null) st.resultTokensIn = u.input_tokens; if (num(u.output_tokens) != null) st.resultTokensOut = u.output_tokens; }
            st.finish_reason = r.status || null;
            const t_s = num(r.duration_seconds) != null ? Math.round(num(r.duration_seconds) * 10) / 10 : Math.round(st.tAcc * 10) / 10;
            out.push(push({ kind: 'finish', t_s, reason: r.status || null, text: asText(r.response, TEXT_CLIP), tokens: u ? { in: num(u.input_tokens), out: num(u.output_tokens), thinking: num(u.thinking_tokens) } : null }));
            return out;
        }
        if (o.event === 'error') { const e = o.error; return [push({ kind: 'error', t_s: Math.round(st.tAcc * 10) / 10, error: true, text: asText((e && typeof e === 'object' ? e.message : e) || 'error', TEXT_CLIP) })]; }
        st.skipped++; return [];   // init / system_message
    }

    // ---- pi ----
    const piText = (content) => (Array.isArray(content) ? content.filter((c) => c && c.type === 'text' && typeof c.text === 'string').map((c) => c.text).join('\n') : asText(content, TOOL_CLIP));
    function feedPi(o) {
        const m = o.message && typeof o.message === 'object' ? o.message : null;
        const t_s = stampWall(num(o.cb_t) ?? num(m && m.timestamp) ?? (o.type === 'session' ? isoMs(o.timestamp) : null));
        const out = [];
        if (o.type === 'message_end' && m) {
            const blocks = Array.isArray(m.content) ? m.content.filter((c) => c && typeof c === 'object') : [];
            if (m.role === 'user') return [push({ kind: 'prompt', t_s, text: asText(piText(blocks), TEXT_CLIP) })];
            if (m.role === 'toolResult') {   // normally a repeat of tool_execution_end; only used when that line is missing
                const id = m.toolCallId || `#${st.lines}`;
                if (st.resulted.has(id)) return out;
                return piResult(id, m.toolName, blocks, m.details, m.isError, t_s);
            }
            if (m.role !== 'assistant') { st.skipped++; return out; }
            for (const c of blocks) {
                if (c.type === 'text') { if (typeof c.text === 'string' && c.text.trim()) out.push(push({ kind: 'text', t_s, text: asText(c.text, TEXT_CLIP) })); }
                else if (c.type === 'thinking') out.push(push({ kind: 'reasoning', t_s, text: asText(c.thinking, TEXT_CLIP), redacted: !c.thinking ? true : undefined }));
                else if (c.type === 'toolCall') {
                    const id = c.id || `#${st.lines}`;
                    if (!st.called.has(id)) { st.called.add(id); st.open.set(id, c.name || null); out.push(push({ kind: 'tool_call', t_s, tool: c.name || null, id, input: asText(c.arguments, TOOL_CLIP) })); }
                } else st.skipped++;
            }
            const u = m.usage && typeof m.usage === 'object' ? m.usage : null;
            if (u) { st.tokens_in += (num(u.input) || 0) + (num(u.cacheRead) || 0); st.tokens_out += num(u.output) || 0; st.tokens_thinking += num(u.reasoning) || 0; }
            const tokens = u ? { in: num(u.input), out: num(u.output), reasoning: num(u.reasoning) || null, cache_read: num(u.cacheRead), cache_write: num(u.cacheWrite) } : null;
            const reason = m.stopReason || null;
            st.piStop = reason || st.piStop; st.finish_reason = reason || st.finish_reason;
            if (reason === 'error' || reason === 'aborted' || m.errorMessage) out.push(push({ kind: 'error', t_s, error: true, reason, tokens, text: asText(m.errorMessage || `assistant message ${reason}`, TEXT_CLIP) }));
            else out.push(push({ kind: 'finish', t_s, reason, turn: true, tokens }));
            return out;
        }
        if (o.type === 'tool_execution_start') {
            const id = o.toolCallId || `#${st.lines}`;
            if (!st.called.has(id)) { st.called.add(id); st.open.set(id, o.toolName || null); return [push({ kind: 'tool_call', t_s, tool: o.toolName || null, id, input: asText(o.args, TOOL_CLIP) })]; }
            return out;
        }
        if (o.type === 'tool_execution_end') {
            const id = o.toolCallId || `#${st.lines}`;
            if (st.resulted.has(id)) return out;
            const r = o.result && typeof o.result === 'object' ? o.result : {};
            return piResult(id, o.toolName, r.content ?? o.result, r.details, o.isError, t_s);
        }
        if (o.type === 'compaction_start') return [push({ kind: 'compaction', t_s, text: asText(o.reason || 'compaction', 200) })];
        if (o.type === 'compaction_end' && o.aborted) return [push({ kind: 'error', t_s, error: true, text: asText(`compaction aborted${o.errorMessage ? `: ${o.errorMessage}` : ''}`, TEXT_CLIP) })];
        if (o.type === 'auto_retry_start') return [push({ kind: 'error', t_s, error: true, retry: true, text: asText(`retry ${o.attempt ?? '?'}/${o.maxAttempts ?? '?'}: ${o.errorMessage || 'error'}`, TEXT_CLIP) })];
        if (o.type === 'stderr') return [push({ kind: 'error', t_s, error: true, stderr: true, text: asText(`stderr: ${o.text ?? ''}`, TEXT_CLIP) })];
        if (o.type === 'codebench') {
            if (/TIMEOUT/.test(String(o.text || ''))) st.done = true;
            return [push({ kind: 'error', t_s, error: true, text: asText(`codebench: ${o.text ?? ''}`, TEXT_CLIP) })];
        }
        if (o.type === 'agent_settled') {
            // pi's end of run: one visible finish (every per-message finish above is a turn marker)
            st.done = true;
            return [push({ kind: 'finish', t_s, reason: st.piStop, tokens: { in: st.tokens_in, out: st.tokens_out, reasoning: st.tokens_thinking || null } })];
        }
        st.skipped++; return out;   // session / agent_start / turn_start / queue_update / entry_appended / compaction_end / auto_retry_end
    }
    function piResult(id, tool, content, details, isError, t_s) {
        st.resulted.add(id);
        const err = !!isError;
        if (err) { st.tool_errors++; st.counts.tool_error++; }
        let body = piText(content);
        const diff = details && typeof details === 'object' && typeof details.diff === 'string' ? details.diff : null;
        if (diff) body = `${body ? `${body}\n\n` : ''}${diff}`;
        const ev = push({ kind: 'tool_result', t_s, tool: tool || st.open.get(id) || null, id, error: err || undefined, output: asText(body || null, TOOL_CLIP) });
        st.open.delete(id);
        return [ev];
    }

    function feed(line) {
        const s = typeof line === 'string' ? line.trim() : '';
        if (!s) return [];
        st.lines++;
        if (!s.startsWith('{')) { st.malformed++; return []; }
        let o; try { o = JSON.parse(s); } catch { st.malformed++; return []; }
        if (!o || typeof o !== 'object') { st.malformed++; return []; }
        const fmt = FORMAT_OF(st.runner && RUNNERS.includes(st.runner) ? st.runner : detect(o));
        try {
            if (fmt === 'agy') return feedAgy(o);
            if (fmt === 'claude') return feedClaude(o);
            if (fmt === 'opencode') return feedOpencode(o);
            if (fmt === 'pi') return feedPi(o);
        } catch { st.malformed++; return []; }   // a parsable-but-odd line yields nothing, never an exception
        st.skipped++; return [];                 // anything else: no adapter, raw lines only
    }
    function end() { const out = []; const f = flushAgyText(); if (f) out.push(f); return out; }   // a transcript cut off mid-response
    function stats() {
        let tokens_out = st.tokens_out, tokens_in = st.tokens_in;
        if (FORMAT_OF(st.detected || st.runner) === 'claude') { tokens_out = st.resultTokensOut ?? (st.msgTokens.size ? [...st.msgTokens.values()].reduce((a, b) => a + b, 0) : null); tokens_in = st.resultTokensIn ?? null; }
        else if ((st.detected || st.runner) === 'agy' && st.resultTokensOut != null) { tokens_out = st.resultTokensOut; tokens_in = st.resultTokensIn ?? tokens_in; }
        const ts = st.events.map((e) => e.t_s).filter((x) => x != null);
        return {
            runner: st.detected || st.runner || null, format: FORMAT_OF(st.detected || st.runner) || null,
            events: st.events.length, lines: st.lines, malformed: st.malformed, skipped: st.skipped,
            t_source: st.t_source, t_approx: st.t_source === 'cumulative_durations',
            first_t_s: ts.length ? ts[0] : null, last_t_s: ts.length ? ts[ts.length - 1] : null,
            duration_s: ts.length ? ts[ts.length - 1] : null,
            tool_calls: st.counts.tool_call, tool_results: st.counts.tool_result, tool_errors: st.tool_errors,
            texts: st.counts.text, reasonings: st.counts.reasoning, finishes: st.counts.finish,
            compactions: st.counts.compaction, errors: st.counts.error,
            unpaired_tool_calls: st.open.size,
            tokens_in: tokens_in ?? null, tokens_out: tokens_out ?? null, tokens_thinking: st.tokens_thinking || null,
            last_text: st.last_text, done: st.done, finish_reason: st.finish_reason,
        };
    }
    return { feed, end, stats, get events() { return st.events; }, _st: st };
}

// Whole-text parse. `parseTranscript` returns the events (the shape the plan names);
// `parseTranscriptFull` adds the stats a caller usually wants beside them.
function parseTranscriptFull(text, runner) {
    const p = createTranscriptParser(runner);
    for (const line of String(text ?? '').split('\n')) p.feed(line);
    p.end();
    return { runner: p.stats().runner, events: p.events, stats: p.stats() };
}
function parseTranscript(text, runner) { return parseTranscriptFull(text, runner).events; }

// ---------- transcript files ----------
// results/<dir>/<task>/<runner>.jsonl, else the result JSON's run.transcript. Works for a task
// that has NO result JSON yet -- the running one.
function transcriptLocation(dir, task, root, which) {
    const dirPath = path.join(resultsRoot(root), dir);
    const taskDir = path.join(dirPath, task);
    // which === 'verify': the verify-on-fail follow-up's own transcript (verify.<runner>.jsonl).
    if (which === 'verify') {
        let d = null; try { d = JSON.parse(fs.readFileSync(path.join(dirPath, `${task}.json`), 'utf-8')); } catch { /* no result JSON yet */ }
        let p = d ? verifyTranscriptPath(d, dirPath) : null;
        if (!p) { try { const f = fs.readdirSync(taskDir).filter((x) => /^verify\..+\.jsonl$/.test(x)).sort()[0]; if (f) p = path.join(taskDir, f); } catch { /* none */ } }
        const runner = (d && d.runner) || (p ? path.basename(p, '.jsonl').replace(/^verify\./, '') : null);
        return { path: p, runner: RUNNERS.includes(runner) ? runner : (runner || null), dir: taskDir };
    }
    let names = [];
    try { names = fs.readdirSync(taskDir).filter((f) => f.endsWith('.jsonl') && !f.startsWith('verify.')).sort(); } catch { names = []; }
    if (names.length) {
        const known = names.find((f) => RUNNERS.includes(path.basename(f, '.jsonl')));
        const pick = known || names[0];
        return { path: path.join(taskDir, pick), runner: path.basename(pick, '.jsonl'), dir: taskDir };
    }
    try {
        const d = JSON.parse(fs.readFileSync(path.join(dirPath, `${task}.json`), 'utf-8'));
        const rt = (d.run || {}).transcript;
        if (rt && fs.statSync(rt).isFile()) return { path: rt, runner: d.runner || path.basename(rt, '.jsonl'), dir: path.dirname(rt) };
    } catch { /* no result JSON, or it points nowhere */ }
    return { path: null, runner: null, dir: taskDir };
}

// Incremental parse cache: the running task's transcript is polled every 3 s and only the bytes
// appended since the last read are parsed. A trailing partial line is held back UNLESS it already
// parses as JSON (a complete last line with no newline); a genuinely truncated tail is reported as
// stats.pending_bytes rather than guessed at.
const transcriptParseCache = new Map();
const TRANSCRIPT_CACHE_MAX = 12;   // 6 tasks, each with its sub-agent stream beside it
function readTranscriptFile(file, runner) {
    let stt; try { stt = fs.statSync(file); if (!stt.isFile()) return null; } catch { return null; }
    let c = transcriptParseCache.get(file);
    let rewritten = false;
    if (c && c.offset && stt.size >= c.offset) {   // grown past the offset: still the same file? (see readTailIncremental)
        let fd0; try { fd0 = fs.openSync(file, 'r'); rewritten = !sameHead(fd0, c.head); } catch { /* read below fails too */ } finally { if (fd0 != null) fs.closeSync(fd0); }
    }
    if (!c || rewritten || stt.size < c.offset || c.runner !== runner) {
        c = { runner, offset: 0, remainder: Buffer.alloc(0), parser: createTranscriptParser(runner), head: null };
        transcriptParseCache.set(file, c);
        while (transcriptParseCache.size > TRANSCRIPT_CACHE_MAX) transcriptParseCache.delete(transcriptParseCache.keys().next().value);
    }
    if (stt.size > c.offset) {
        let fd; try { fd = fs.openSync(file, 'r'); } catch { return null; }
        try {
            if (c.offset === 0) c.head = readHead(fd);
            const buf = Buffer.alloc(stt.size - c.offset);
            const n = fs.readSync(fd, buf, 0, buf.length, c.offset); c.offset += n;
            let data = Buffer.concat([c.remainder, buf.subarray(0, n)]);
            let i;
            while ((i = data.indexOf(0x0a)) >= 0) { c.parser.feed(data.subarray(0, i).toString('utf-8')); data = data.subarray(i + 1); }
            c.remainder = Buffer.from(data);
        } finally { fs.closeSync(fd); }
    }
    if (c.remainder.length) {   // a complete last line that simply has no trailing newline
        const s = c.remainder.toString('utf-8').trim();
        if (s.startsWith('{')) { try { JSON.parse(s); c.parser.feed(s); c.remainder = Buffer.alloc(0); } catch { /* truly partial: wait for more bytes */ } }
    }
    return { events: c.parser.events, stats: c.parser.stats(), bytes: c.offset, pending_bytes: c.remainder.length, mtimeMs: stt.mtimeMs, size: stt.size, parser: c.parser };
}

// ---------- sub-agents inline (2026-10-20, Kyle: "have the sub agent transcripts output to the live transcript as if
// they were all part of the same flow, with some indicator that these were 'sub agent n'") ----------
// The harness (runners/opencode.py SubagentStream) streams every opencode sub-agent session into
// <task dir>/subagents/stream.jsonl while the run is live; opencode.jsonl itself only ever holds the parent. The two
// parsed streams are merged by absolute time into ONE event list: sub-agent events keep their kinds and carry `sub`
// (their label: "1", "2", nested "2.1"), their t_s is re-stamped against the parent's clock, and a `subagent` marker
// opens each one. Each event's time is when it BEGAN (a tool call at its start, its result at its end, text and
// thinking at their start), so a `task` call sits before the sub-agent it started and its result after it.
//  - Which sub-agents belong to THIS transcript: those started by a `task` call in it (the marker's parent_call; a
//    nested one through its top-level ancestor), or whose start lies inside the transcript's own span (first event to
//    the file's last write): opencode writes a `task` line only when the sub-agent is done, so one cut off by a timeout,
//    the watchdog or stop-now has no call in the transcript and is still shown. A verify-on-fail turn's sub-agents
//    start after the main transcript's last write and their calls are in verify.opencode.jsonl, so they show in the
//    verify view, not the main one. While the task RUNS, everything from 60 s before its first event on is shown.
//  - While the task RUNS the list only ever grows at the end (the Live view and the transcript view poll by index):
//    each poll's new events from both files are time-ordered among themselves and appended. Once it has finished, the
//    list is rebuilt once in full time order.
// Parent-only numbers (tool calls, tokens, last text, the plan) still come from the parent's parser alone.
//
// `i` IS NOT AN IDENTITY (2026-10-22). An event's `i` is its place in the list this answer pages over, and that list is
// re-ordered: the running list (append order: a `task` call lands after its whole sub-agent, because opencode writes
// the call when it ends) and the finished one (full time order: the call before its sub-agent) put the same event at
// different `i`s, and a request that does not count as running (the task ended, or isCurrentTask said no) rebuilds it.
// The views keyed their expanded / collapsed blocks by `i`, so every rebuild moved the reader's choices onto other
// events -- Kyle's "when I expand it, it self-collapses right after". Every event therefore carries `key`
// (eventKey below): what it IS, the same in every order and every page. Views key UI state by `key`, never by `i`.
const SUBAGENT_STREAM = path.join('subagents', 'stream.jsonl');
/**
 * An event's stable id: a tool call by the call id the model gave it, its result by the same id + ':result' (so a view
 * can draw the output under the call's identity whether the result sits under its call or alone on a later page), a
 * sub-agent's start by its label, anything else by its place in ITS OWN file (the parent's transcript `p`, the
 * sub-agent stream `s`): those files are append-only and parsed in order, so that place never changes -- unlike `i`,
 * a place in the merged list. Unique within a transcript.
 */
function eventKey(ev, src) {
    if (ev.kind === 'tool_call' && ev.id != null) return `${src}:call:${ev.id}`;
    if (ev.kind === 'tool_result' && ev.id != null) return `${src}:call:${ev.id}:result`;
    if (ev.kind === 'subagent' && ev.sub != null) return `${src}:sub:${ev.sub}`;
    return `${src}:${ev.i}`;
}
const SUB_BEFORE_MS = 60000, SUB_AFTER_MS = 5000, SUB_SPAN_SLACK_MS = 5000;
const subMergeCache = new Map();   // parent transcript path -> merge state
function subagentStreamPath(transcript) { return transcript ? path.join(path.dirname(transcript), SUBAGENT_STREAM) : null; }
function mergeSubagentEvents(mainPath, pr, sr, running) {
    const pst = pr.parser, sst = sr.parser;
    const P = pst.events, S = sst.events;
    const t0 = pst._st.t0 != null ? pst._st.t0 : (sst._st.t0 != null ? sst._st.t0 : null);
    const pms = pst._st.ms, sms = sst._st.ms;
    let c = subMergeCache.get(mainPath);
    const same = !!c && c.P === P && c.S === S;
    if (same && !running && !c.running && c.pN === P.length && c.sN === S.length) return c;     // finished and unchanged
    // running: append what is new; anything else (first read, finished, a file rewritten) is a full, time-ordered merge
    const append = same && running && c.running && P.length >= c.pN && S.length >= c.sN;
    if (!append) c = { P, S, running, pN: 0, sN: 0, events: [], children: new Set(), lastKey: -Infinity };
    // the parent's keys: an event with no time of its own takes the one before it
    const pKey = new Array(P.length); let carry = -Infinity, first = null, last = null;
    for (let k = 0; k < P.length; k++) { const m = pms[k]; if (m != null) { carry = m; if (first == null || m < first) first = m; if (last == null || m > last) last = m; } pKey[k] = carry; }
    const lo = first == null ? -Infinity : first - SUB_BEFORE_MS;
    // a finished transcript's span: first event .. its last write (a killed run's last JSON line can be long before the
    // `[codebench] TIMEOUT` line the harness appends, which has no time of its own; the file's mtime has)
    const spanLo = first == null ? -Infinity : first - SUB_SPAN_SLACK_MS;
    const spanHi = last == null && pr.mtimeMs == null ? Infinity : Math.max(last ?? -Infinity, pr.mtimeMs ?? -Infinity) + SUB_AFTER_MS;
    // membership: top-level label -> parent_call from its marker; this transcript's task calls
    const callOf = new Map();
    for (let k = 0; k < S.length; k++) { const e = S[k]; if (e.kind === 'subagent' && e.sub && !callOf.has(e.sub)) callOf.set(e.sub, e.parent_call || null); }
    const mine = new Set(); for (const e of P) if (e.kind === 'tool_call' && e.tool === 'task' && e.id != null) mine.add(e.id);
    const startOf = new Map();
    for (let k = 0; k < S.length; k++) { const e = S[k]; if (e.kind === 'subagent' && e.sub && !startOf.has(e.sub)) startOf.set(e.sub, sms[k]); }
    const inSpan = (m) => m != null && m >= spanLo && m <= spanHi;
    const topIn = new Map();      // top-level label -> belongs to this transcript
    const topBelongs = (top) => {
        if (!topIn.has(top)) { const call = callOf.get(top); topIn.set(top, !!(call && mine.has(call)) || inSpan(startOf.get(top))); }
        return topIn.get(top);
    };
    // a sub-agent's marker never sorts before the `task` call that started it (opencode makes the session a few ms first)
    const callMs = new Map(); for (let k = 0; k < P.length; k++) { const e = P[k]; if (e.kind === 'tool_call' && e.tool === 'task' && e.id != null && pms[k] != null) callMs.set(e.id, pms[k]); }
    const keyS = (k) => { const e = S[k]; const m = sms[k]; return e.kind === 'subagent' && e.parent_call && callMs.has(e.parent_call) ? Math.max(m, callMs.get(e.parent_call)) : m; };
    const belongs = (k) => {
        const m = sms[k]; if (m == null) return false;
        if (running) return m >= lo;
        const top = String(S[k].sub).split('.')[0];
        return startOf.has(top) ? topBelongs(top) : inSpan(m);
    };
    // a parent tool call is shown at its start (its line is written when it ends: a `task` call would read as hours late)
    const copyP = (k) => { const e = { ...P[k], key: eventKey(P[k], 'p') }; if (e.kind === 'tool_call' && pms[k] != null && t0 != null) e.t_s = Math.max(0, Math.round(((pms[k] - t0) / 1000) * 10) / 10); return e; };
    const copyS = (k) => { const e = { ...S[k], key: eventKey(S[k], 's') }; const m = sms[k]; if (m != null && t0 != null) e.t_s = Math.max(0, Math.round(((m - t0) / 1000) * 10) / 10); if (e.sub == null) e.sub = '?'; return e; };
    const batch = [];
    for (let k = c.pN; k < P.length; k++) batch.push([0, k, pKey[k]]);
    for (let k = c.sN; k < S.length; k++) if (belongs(k)) batch.push([1, k, keyS(k)]);
    batch.sort((x, y) => (x[2] - y[2]) || (x[0] - y[0]) || (x[1] - y[1]));
    for (const [w, k] of batch) {
        const e = w === 0 ? copyP(k) : copyS(k);
        e.i = c.events.length; c.events.push(e);
        if (w === 1 && e.kind === 'subagent') c.children.add(e.sub);
    }
    c.pN = P.length; c.sN = S.length;
    subMergeCache.set(mainPath, c);
    while (subMergeCache.size > TRANSCRIPT_CACHE_MAX) subMergeCache.delete(subMergeCache.keys().next().value);
    return c;
}

// {task, runner, events, stats, truncated, total} with paging. `from` is an event index, so the
// live view can ask for everything after the last index it already has.
function getTranscript(dir, task, opts) {
    if (!safeName(dir) || !safeName(task)) throw new Error('bad dir or task name');
    task = bonusParent(task);   // a bonus test has no transcript of its own: it is the parent's run
    const o = opts || {};
    const root = o.root;
    const which = o.which === 'verify' ? 'verify' : null;
    const loc = transcriptLocation(dir, task, root, which);
    const from = Math.max(0, parseInt(o.from, 10) || 0);
    let limit = o.limit == null || o.limit === '' ? TRANSCRIPT_PAGE : parseInt(o.limit, 10);
    if (!Number.isInteger(limit) || limit < 1) limit = TRANSCRIPT_PAGE;
    limit = Math.min(limit, TRANSCRIPT_PAGE_MAX);
    const running = isCurrentTask(dir, task);
    const base = {
        dir, task, which, runner: loc.runner, transcript: loc.path, from, limit,
        // the row's scaffold, so the view can label the harness ("pi + SoL-Pi", not just "pi")
        scaffold: transcriptScaffold(dir, task, root, running),
        events: [], stats: null, total: 0, returned: 0, truncated: false, bytes: 0,
        running, note: null,
    };
    if (!loc.path) { base.note = which === 'verify' ? `no verify transcript under ${loc.dir}` : `no transcript under ${loc.dir}`; base.stats = { runner: null, events: 0 }; return base; }
    const r = readTranscriptFile(loc.path, loc.runner);
    if (!r) { base.note = `transcript unreadable: ${loc.path}`; base.stats = { runner: loc.runner, events: 0 }; return base; }
    let all = r.events;
    base.stats = { ...r.stats, pending_bytes: r.pending_bytes, bytes: r.bytes };
    // opencode sub-agents, inline (see mergeSubagentEvents)
    const subPath = (r.stats.format || r.stats.runner) === 'opencode' || loc.runner === 'opencode' ? subagentStreamPath(loc.path) : null;
    const sr = subPath ? readTranscriptFile(subPath, 'opencode') : null;
    if (sr && sr.events.length) {
        const m = mergeSubagentEvents(loc.path, r, sr, running);
        all = m.events;
        base.subagents = { file: subPath, sub_agents: m.children.size, events: all.length - r.events.length, bytes: sr.bytes };
    }
    base.total = all.length;
    base.bytes = r.bytes;
    if (base.stats.runner) base.runner = base.stats.runner;
    // Cap the response near 2 MB: stop adding events and say so, rather than sending 40 MB.
    const out = []; let size = 0;
    for (let k = from; k < all.length && out.length < limit; k++) {
        const ev = all[k];
        const sz = (ev.text ? ev.text.length : 0) + (ev.input ? ev.input.length : 0) + (ev.output ? ev.output.length : 0) + 120;
        if (size + sz > TRANSCRIPT_MAX_BYTES && out.length) { base.truncated = true; break; }
        out.push(ev.key != null ? ev : { ...ev, key: eventKey(ev, 'p') }); size += sz;   // a merged list's events have theirs
    }
    base.events = out; base.returned = out.length;
    base.next_from = out.length ? out[out.length - 1].i + 1 : from;
    if (!base.truncated && base.next_from < all.length) base.truncated = true;   // more pages remain
    return base;
}
// The scaffold recorded for a task's row (result JSON), else the running battery's config.
function transcriptScaffold(dir, task, root, running) {
    try { const d = JSON.parse(fs.readFileSync(path.join(resultsRoot(root), dir, `${task}.json`), 'utf-8')); const sc = configOf(d).config.scaffold; if (sc) return sc; } catch { /* no result JSON yet */ }
    // only the adopted battery's config is at hand (isCurrentTask also says "running" for other lanes since 2026-10-22)
    return running && live.battery && live.battery.name === dir && live.battery.config ? live.battery.config.scaffold || null : null;
}
// Is this the task actually running right now? With --runs N the result file (and so the
// transcript dir, and so the `task` the UI asks for) is `<task>__rN` while live.current.task
// stays the base id -- compare against the name the files use.
// `live` is ONE battery (the one adopted last: whichever a viewer named with ?battery=), and several lanes run at once.
// Asked only about `live`, a running task on any other lane read as finished whenever another tab or device looked at
// a different lane -- and a "finished" answer re-ordered the sub-agent merge and stopped the transcript view's poll
// (2026-10-22). So a battery that is not `live` is answered from the last scan: running, and this is its first planned
// task without a result file (the rule GET /api/models/running uses).
function isCurrentTask(dir, task) {
    const c = live && live.current;
    if (live && live.running && c && (live.battery && live.battery.name) === dir) return task === c.task || task === `${c.task}__r${c.run}`;
    const r = (adoptState.scanned || []).find((x) => x.adoptable && x.dir === dir);
    const planned = r && r.battery && Array.isArray(r.battery.tasks) ? r.battery.tasks : null;
    if (!planned) return false;
    const cur = planned.find((t) => !fs.existsSync(path.join(r.path, `${t}.json`)));
    return !!cur && (task === cur || task.startsWith(`${cur}__r`));
}

// ---------- task context panel: `run.py --show <id> --json` ----------
const TASKINFO_TTL_MS = 300000;
const taskInfoCache = new Map();      // id -> {at, data}
const taskInfoInflight = new Map();   // id -> Promise (two panels must not spawn run.py twice)
function getTaskInfo(id, deps) {
    if (!safeName(id)) return Promise.reject(new Error('bad task id'));
    // <task>+bonus is not a task run.py knows: its parent's page, with the bonus test's own case titles as its goals
    if (isBonusTask(id)) {
        return getTaskInfo(bonusParent(id), deps).then((p) => {
            let names = []; try { names = [...new Set(listTaskCases(id).flatMap((r) => r.cases.map((c) => c.name)))]; } catch { names = []; }
            const goals = names.length ? [{ file: 'bonus test', cases: names }] : [];
            return { ...p, id, bonus: { parent: p.id }, goals, goal_cases: names.length };
        });
    }
    const now = (deps && deps.now) || Date.now;
    const hit = taskInfoCache.get(id);
    if (hit && now() - hit.at < TASKINFO_TTL_MS) return Promise.resolve({ ...hit.data, cached: true });
    if (taskInfoInflight.has(id)) return taskInfoInflight.get(id);
    const { root, python } = getConfig();
    const spawnFn = (deps && deps.spawn) || realSpawn;
    const p = new Promise((resolve, reject) => {
        let out = '', err = '', done = false;
        let child2;
        const finish = (fn, v) => { if (!done) { done = true; taskInfoInflight.delete(id); fn(v); } };
        try { child2 = spawnFn(python, ['harness/run.py', '--show', id, '--json'], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] }); }
        catch (e) { return finish(reject, new Error(`run.py --show failed: ${e.message}`)); }
        const timer = setTimeout(() => { try { child2.kill('SIGKILL'); } catch { /* gone */ } finish(reject, new Error('run.py --show timed out after 30 s')); }, (deps && deps.timeoutMs) || 30000);
        if (timer.unref) timer.unref();
        child2.stdout.on('data', (b) => { out += b; });
        child2.stderr.on('data', (b) => { err = (err + b).slice(-2000); });
        child2.on('error', (e) => { clearTimeout(timer); finish(reject, new Error(`run.py --show failed: ${e.message}`)); });
        child2.on('close', (code) => {
            clearTimeout(timer);
            const data = parseTaskInfo(out);
            if (!data) return finish(reject, new Error(`run.py --show ${id} gave no JSON (exit ${code})${err ? `: ${err.trim().split('\n').pop()}` : ''}`));
            const info = normalizeTaskInfo(data);
            taskInfoCache.set(id, { at: now(), data: info });
            finish(resolve, info);
        });
    });
    taskInfoInflight.set(id, p);
    return p;
}
function parseTaskInfo(text) {
    const lines = String(text || '').split('\n');
    for (let k = lines.length - 1; k >= 0; k--) {            // the last JSON object wins (stderr noise aside)
        const s = lines[k].trim(); if (!s.startsWith('{')) continue;
        try { const o = JSON.parse(s); if (o && o.id) return o; } catch { /* keep looking */ }
    }
    try { const o = JSON.parse(String(text || '')); if (o && o.id) return o; } catch { /* not one object */ }
    return null;
}
function normalizeTaskInfo(o) {
    const cat = Array.isArray(o.category) ? o.category : (typeof o.category === 'string' ? o.category.split(',').filter(Boolean) : []);
    const goals = Array.isArray(o.goals) ? o.goals.map((g) => ({ file: (g && g.file) || null, cases: Array.isArray(g && g.cases) ? g.cases : [] })) : [];
    const prompts = o.prompts && typeof o.prompts === 'object' ? o.prompts : {};
    return {
        id: o.id, repo: o.repo || null, variant: o.variant || null,
        tier_predicted: o.tier_predicted || null, tier: o.tier_predicted || (cat.find((c) => /^tier-/.test(c)) || '').replace(/^tier-/, '') || null,
        category: cat, authored_by: o.authored_by || null, provenance: o.provenance || null,
        incident_date: o.incident_date || null, story: o.story || null, probes: o.probes || null,
        weak_model_failure: o.weak_model_failure || null, oracle_note: o.oracle_note || null,
        prompts, prompt_levels: Object.keys(prompts),
        interface_requirement: o.interface_requirement || null,
        goals, goal_cases: goals.reduce((n, g) => n + g.cases.length, 0),
        pass_to_pass: o.pass_to_pass ?? null, timeout_s: o.timeout_s ?? null,
        base_sha: o.base_sha || null, fix_sha: o.fix_sha || null, dir: o.dir || null,
    };
}

// ================= BATTERY CONTROL AND ADOPTION (harness/CONTROL.md) =================
// A battery is a long-lived child that must survive a dashboard restart. run.py writes
// <out>/battery.json; the UI writes <out>/control.json. The FILES are the contract -- an adopted
// battery's stdout belongs to the process that spawned it and we must not try to reattach.
const BATTERY_FILE = 'battery.json';
const CONTROL_FILE = 'control.json';
const ADOPT_SCAN_MS = 3000;          // live() is polled every 3 s; don't re-scan results/ per call
const STOP_ACK_MS = { 'after-task': 30000, now: 30000 };   // only used when the harness cannot hear control.json (and for stop-now's ack)
let adoptState = { at: 0, dir: null, scanned: [] };

// What the Runs list shows about a battery process for this dir. Liveness is NOT checked here
// (summaries are cached); a dead one is marked aborted on disk by scanBatteries and the rewrite
// changes battery.json's mtime, which is part of dirSignature, so the cache follows.
function batterySummary(dirPath) {
    const b = readBatteryFile(dirPath);
    if (!b) return null;
    return { state: b.state || null, pid: num(b.pid) ?? null, started: num(b.started) ?? null, finished: num(b.finished) ?? null, reason: b.reason || null, runner: b.runner || null, model: b.model || null, host: b.host || null, runs: num(b.runs) ?? null, tasks: Array.isArray(b.tasks) ? b.tasks.length : null };
}
function readBatteryFile(dirPath) {
    try {
        const d = JSON.parse(fs.readFileSync(path.join(dirPath, BATTERY_FILE), 'utf-8'));
        return d && typeof d === 'object' ? d : null;
    } catch { return null; }
}
function writeJsonAtomic(file, obj) {
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 1)}\n`);
    fs.renameSync(tmp, file);
}
function defaultIsAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 1) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e && e.code === 'EPERM'; }   // EPERM: alive, another user
}
function defaultCmdline(pid) {
    try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8').replace(/\0/g, ' ').trim(); } catch { return ''; }
}
// A pid is OUR battery only if it is alive AND its argv still carries harness/run.py: pids are
// recycled, and a recycled pid running something else must never be paused or killed.
function batteryLiveness(b, deps) {
    const isAlive = (deps && deps.isAlive) || defaultIsAlive;
    const cmdline = (deps && deps.cmdline) || defaultCmdline;
    const pid = num(b && b.pid);
    if (pid == null) return { alive: false, reason: 'battery.json has no pid' };
    if (!isAlive(pid)) return { alive: false, reason: `pid ${pid} is gone` };
    const argv = String(cmdline(pid) || '');
    if (!/harness\/run\.py/.test(argv)) return { alive: false, reason: `pid ${pid} was recycled (${argv.slice(0, 60) || 'no cmdline'})`, recycled: true };
    return { alive: true, argv };
}
// Scan results/*/battery.json. A stale one (pid dead or recycled, state still running/paused) is
// marked aborted ON DISK, per CONTROL.md: "mark it aborted on read, don't offer controls".
function scanBatteries(root, deps) {
    const rr = resultsRoot(root);
    let dirs = []; try { dirs = fs.readdirSync(rr); } catch { return []; }
    const out = [];
    for (const dir of dirs) {
        if (!safeName(dir)) continue;
        const dirPath = path.join(rr, dir);
        const b = readBatteryFile(dirPath); if (!b) continue;
        const state = b.state || null;
        const rec = { dir, path: dirPath, battery: b, state, pid: num(b.pid), started: num(b.started), adoptable: false, reason: null };
        if (state === 'running' || state === 'paused' || state === 'stopping') {
            const l = batteryLiveness(b, deps);
            if (l.alive) { rec.adoptable = true; rec.argv = l.argv; }
            else {
                rec.reason = l.reason; rec.recycled = !!l.recycled; rec.state = 'aborted';
                try { writeJsonAtomic(path.join(dirPath, BATTERY_FILE), { ...b, state: 'aborted', finished: Date.now() / 1000, reason: `marked aborted by the dashboard: ${l.reason}` }); rec.marked_aborted = true; }
                catch (e) { rec.reason += ` (could not rewrite battery.json: ${e.message})`; }
            }
        }
        out.push(rec);
    }
    out.sort((a, b2) => (b2.started || 0) - (a.started || 0));
    return out;
}

// Rebuild live state for a battery this process did not spawn: the result JSONs on disk are the
// finished tasks, and the current task's transcript tail is the live signal. No event stream.
function adoptedLive(rec, root) {
    const b = rec.battery || {};
    const l = freshLive();
    const dirPath = rec.path;
    l.adopted = true;
    l.running = rec.state === 'running' || rec.state === 'paused' || rec.state === 'stopping';
    l.paused = rec.state === 'paused';
    l.batteryState = rec.state;
    l.pid = num(b.pid); l.pgid = num(b.pgid) ?? num(b.pid);
    l.startedAt = num(b.started) != null ? Math.round(b.started * 1000) : null;
    l.finishedAt = num(b.finished) != null ? Math.round(b.finished * 1000) : null;
    l.command = Array.isArray(b.cmd) ? b.cmd.join(' ') : (b.cmd || null);
    l.cwd = getConfig().root;
    l.outDir = b.out || dirPath;
    l.note = 'adopted after restart — live steps unavailable, tailing the transcript';
    const tasks = Array.isArray(b.tasks) ? b.tasks : [];
    const runs = num(b.runs) || 1;
    // Finished tasks: every scored result JSON already in the dir.
    const v = loadDir(root, rec.dir);
    // A re-run into the SAME --out dir (a queue item retried under its label, resume off) finds the
    // earlier attempt's result JSONs and transcripts still there until each task is redone. Those are
    // not this battery's: counting them skipped the real current task and dated it from a day-old
    // file (2026-09-28: q2f16-256k-split, rerun over a PROVIDER_ERROR attempt from the day before,
    // showed a just-started task at 28 h+ elapsed and the wrong task as current).
    const bc0 = b.config && typeof b.config === 'object' ? b.config : {};
    const fresh = staleFilter(v ? v.entries : [], l.startedAt, !!(bc0.resume ?? b.resume));
    l.staleResults = fresh.stale;
    if (fresh.stale) l.note += ` · ${fresh.stale} result${fresh.stale === 1 ? '' : 's'} from an earlier attempt in this dir ignored`;
    const entries = fresh.entries;
    // battery.json carries the harness config under `config` (prompt_level, scaffold, harness_mode
    // live only there); the top-level runner/model/timeout_s are the older copy.
    const bc = bc0;
    l.battery = {
        name: rec.dir, out: l.outDir, tasks, runs,
        config: { ...bc, runner: bc.runner || b.runner || null, model: bc.model || b.model || null, prompt_level: bc.prompt_level || b.prompt_level || null,
            timeout_s: num(bc.timeout_s) ?? num(b.timeout_s), effort: bc.effort || b.effort || null, scaffold: bc.scaffold || null },
        // battery.json has no server provenance (only the battery_start EVENT does, and an adopted
        // battery's stream is gone): every result JSON records it, so the newest one says what the
        // server is. Before the first task lands, a lone llama-server process is the next best witness.
        server: adoptedServer(entries, bc.runner || b.runner, rec.dir), adopted: true, state: rec.state, host: b.host || null,
    };
    l.total = tasks.length * runs;
    const byKey = new Map();
    for (const e of entries) {
        const row = taskRow(e);
        const m = /__r(\d+)\.json$/.exec(row.file || '');
        const base = row.task, run = m ? parseInt(m[1], 10) : 1;
        const t = { key: `${base}#${run}`, task: base, run, of: runs, status: row.status, solved: row.solved, partial: row.partial, wall_s: row.wall_s, tokens_in: row.tokens_in, tokens_out: row.tokens_out, tool_calls: row.tool_calls, first_edit_s: row.first_edit_s, last_edit_s: row.last_edit_s, tests_run: row.tests_run, hit_timeout: row.hit_timeout, solved_at_cap: row.solved_at_cap, anomalies: row.anomalies, edits: row.edits, assertions: row.assertions, p2p: row.p2p, p2p_broken: row.p2p_broken, adopted: true };
        byKey.set(t.key, t);
        l.tasks.push(t);
        l.done++;
        if (EXCLUDED.has(t.status)) l.excluded++; else { l.scored++; if (SOLVED.has(t.status)) l.solved++; }
    }
    // The current task: the first planned (task x run) with no result on disk.
    if (l.running) {
        let cur = null, index = 0;
        outer: for (const task of tasks) {
            for (let r = 1; r <= runs; r++) {
                index++;
                if (byKey.has(`${task}#${r}`)) continue;
                cur = { task, run: r, index }; break outer;
            }
        }
        if (cur) {
            const loc = transcriptLocation(rec.dir, cur.run > 1 ? `${cur.task}__r${cur.run}` : cur.task, root);
            const startedAt = adoptedTaskStart(loc.path, l.startedAt, entries);
            l.current = {
                task: cur.task, run: cur.run, of: runs, index: cur.index, total: l.total, tier: null,
                cap_s: num(b.timeout_s), sandbox: b.sandbox ? path.join(b.sandbox, cur.task) : null,
                started_t: null, startedAt, setup: null,
                steps: 0, tool_calls: 0, edits: 0, tool_edits: 0, shell_edits: 0, tokens_out: 0, elapsed_s: (Date.now() - startedAt) / 1000,
                first_edit_s: null, last_edit_s: null, last_tool: null, last_path: null, last_kind: null,
                snippet: null, snippet_kind: null, snippet_t: null, tests: {}, compactions: 0, length_cutoffs: 0,
                errors: 0, tool_errors: 0, anomalies: [], reads: {}, repeated_reads: [], adopted: true,
            };
        }
    }
    return l;
}
// Result entries that belong to THIS battery: written (per the manifest's own start stamp when it
// has one, else the file's mtime) no earlier than the battery started (less STALE_SLACK_MS). With
// resume on, run.py keeps and skips the earlier results, so they count as done and nothing is filtered.
function staleFilter(entries, batteryStartMs, resume) {
    const all = entries || [];
    if (resume || batteryStartMs == null) return { entries: all, stale: 0 };
    const floor = batteryStartMs - STALE_SLACK_MS;
    const out = all.filter((e) => {
        const ms = e.data && e.data.manifest && e.data.manifest.started_at ? Date.parse(e.data.manifest.started_at) : NaN;
        return Number.isFinite(ms) ? ms >= floor : (e.mtimeMs || 0) >= floor;
    });
    return { entries: out, stale: all.length - out.length };
}
// When an adopted battery's current task began, in epoch ms. Never earlier than the battery's own
// start, nor than the moment its previous task's result landed (the harness runs tasks one after
// another). Inside that floor, the transcript's first wall-clock stamp is the task's real start.
// NOT the file's birth time: run.py truncates and rewrites a transcript in place, so a rerun into the
// same dir keeps the earlier attempt's inode and birth time.
function adoptedTaskStart(transcript, batteryStartMs, entries) {
    let floor = batteryStartMs;
    for (const e of (entries || [])) if (e.mtimeMs != null && (floor == null || e.mtimeMs > floor)) floor = e.mtimeMs;
    const first = transcript ? transcriptStartMs(transcript) : null;
    if (first != null && (floor == null || first >= floor - STALE_SLACK_MS)) return Math.round(first);
    return floor != null ? Math.round(floor) : Date.now();
}
// The first wall-clock stamp in a transcript (epoch ms), from its first 64 KB: opencode's numeric
// `timestamp` (ms), claude's ISO `timestamp`, pi's harness-stamped `cb_t` (then message.timestamp).
// agy stamps none -> null.
function transcriptStartMs(file) {
    let text = '';
    let fd; try { fd = fs.openSync(file, 'r'); } catch { return null; }
    try { const buf = Buffer.alloc(64 * 1024); const n = fs.readSync(fd, buf, 0, buf.length, 0); text = buf.subarray(0, n).toString('utf-8'); }
    catch { return null; } finally { fs.closeSync(fd); }
    const epochMs = (x) => {
        if (typeof x === 'string') { const t = isoMs(x); return t != null && t > 1e12 ? t : null; }
        const n = num(x); if (n == null || n <= 0) return null;
        return n > 1e11 ? n : (n > 1e9 ? n * 1000 : null);   // ms, or epoch seconds; anything smaller is a relative offset
    };
    for (const line of text.split('\n')) {
        const t = line.trim(); if (!t.startsWith('{')) continue;
        let o; try { o = JSON.parse(t); } catch { continue; }
        if (!o || typeof o !== 'object') continue;
        const m = o.message && typeof o.message === 'object' ? o.message : null;
        const part = o.part && typeof o.part === 'object' ? o.part : null;
        const ms = epochMs(o.cb_t) ?? epochMs(o.timestamp) ?? epochMs(part && part.time && part.time.start) ?? epochMs(m && m.timestamp);
        if (ms != null) return ms;
    }
    return null;
}
function adoptedServer(list, runner, dir) {
    const entries = (list || []).slice().sort((a, b2) => b2.mtimeMs - a.mtimeMs);
    for (const e of entries) { const srv = configOf(e.data).server; if (srv) return srv; }
    if (!LOCAL_RUNNERS.has(runner)) return null;
    // The queue item first: it names THIS battery's server exactly. The process scan is a guess that
    // only knows llama-server -- with a Strata battery on the XTX and a llama-server on the 3060 it
    // labelled the XTX battery with the 3060's model and 64k context (Kyle, 2026-10-01).
    return queueServer(dir) || procServer();
}
// Last resort: the queue item that launched this battery (bench.sqlite queue_items, label = battery
// dir) recorded the exact command it ran (outcome_json.launch_expanded). Covers a battery whose
// server died before any result carried provenance (2026-09-29: an OOM at 262k showed "model not
// recorded" for as long as the battery lived).
let queueServerCache = new Map();
/** The lane, when it serves on another machine: a queue lane that is not `local-*` (and not unset). */
function remoteLaneOf(lane) {
    const l = typeof lane === 'string' ? lane.trim() : '';
    return l && !/^local\b/.test(l) ? l : null;
}
function queueServer(dir) {
    if (!dir) return null;
    const hit = queueServerCache.get(dir);
    if (hit && Date.now() - hit.at < 30000) return hit.v;
    let v = null;
    try {
        const Database = require('better-sqlite3');
        const ro = new Database(require('./db').DB_PATH, { readonly: true, fileMustExist: true });
        try {
            const row = ro.prepare('SELECT lane, launch_cmd, outcome_json FROM queue_items WHERE label = ? ORDER BY id DESC LIMIT 1').get(dir);
            let cmd = null; try { cmd = JSON.parse(row && row.outcome_json || '{}').launch_expanded || null; } catch { cmd = null; }
            if (cmd) {
                const m = /(?:^|\s)(?:-m|--model)\s+(\S+)/.exec(cmd), c = /(?:^|\s)(?:-c|--ctx-size)\s+(\d+)/.exec(cmd);
                v = { model_path: m ? m[1] : null, n_ctx: c ? Number(c[1]) : null, launch_command: cmd, launch_command_source: 'queue-item' };
                // A lane that serves on another machine (the queue's convention, as lib/topology.js laneCards reads it:
                // `local-*` lanes run here): its command is written in THAT machine's device ids. Say so, as a result
                // JSON's `server.remote` does once one lands, so lib/runlabel.js does not name its CUDA0 after a card
                // of this machine while the battery waits for its first result (2026-10-13).
                const lane = remoteLaneOf(row.lane);
                if (lane) v.remote = { lane };
                // Strata (2026-09-30): no -m; the model is the --native GGUF in the engine config the launcher is given
                const cfgPath = !m && (/(\S+\.json)(?:\s|$)/.exec(cmd) || [])[1];
                if (cfgPath) {
                    try {
                        const sc = JSON.parse(fs.readFileSync(cfgPath, 'utf-8')), a = Array.isArray(sc.args) ? sc.args : [];
                        const ni = a.indexOf('--native'), ci = a.indexOf('--max-context');
                        if (ni >= 0) v.model_path = a[ni + 1] || null;
                        if (ci >= 0) v.n_ctx = Number(a[ci + 1]) || v.n_ctx;
                        v.engine = 'strata';
                    } catch { /* not a Strata config */ }
                }
            }
        } finally { ro.close(); }
    } catch { v = null; }
    queueServerCache.set(dir, { at: Date.now(), v });
    return v;
}
// The llama-server serving the battery, read from /proc when no result JSON has landed yet. Only
// when exactly one llama-server runs: with two, which one the harness talks to is a guess.
const LOCAL_RUNNERS = new Set(['opencode', 'pi', 'tau', 'jeff']);
let procServerCache = { at: 0, v: null };
let procScanImpl = defaultProcScan;
function defaultProcScan() {
    const out = [];
    let pids = []; try { pids = fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x)); } catch { return out; }
    for (const pid of pids) {
        let cmd = ''; try { cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf-8'); } catch { continue; }
        const argv = cmd.split('\0').filter(Boolean);
        if (argv.length && /(^|\/)llama-server$/.test(argv[0])) out.push(argv);
    }
    return out;
}
function procServer() {
    const now = Date.now();
    if (now - procServerCache.at < 10000) return procServerCache.v;
    let v = null;
    try {
        const found = procScanImpl();
        if (found.length === 1) {
            const argv = found[0]; const mi = argv.findIndex((a) => a === '-m' || a === '--model');
            const q = (a) => (/[\s'"]/.test(a) ? `'${a.replace(/'/g, "'\\''")}'` : a);
            v = { model_path: mi >= 0 ? argv[mi + 1] || null : null, launch_command: argv.map(q).join(' '), launch_command_source: 'proc-scan' };
            const ci = argv.findIndex((a) => a === '-c' || a === '--ctx-size');
            if (ci >= 0 && Number(argv[ci + 1])) v.n_ctx = Number(argv[ci + 1]);
        }
    } catch { v = null; }
    procServerCache = { at: now, v };
    return v;
}
function _setProcScan(fn) { procScanImpl = fn || defaultProcScan; procServerCache = { at: 0, v: null }; }

// Called from live() and listRuns(). Never touches a battery this process spawned.
function maybeAdopt(root, deps) {
    const d = deps || {};
    const now = d.now ? d.now() : Date.now();
    if (child) return null;                                     // our own battery owns `live`
    // d.battery: the viewer asked for a specific running battery (live view's lane switcher). A switch
    // skips the scan throttle; staying on the same one keeps it.
    const want = d.battery ? String(d.battery) : null;
    if (!d.force && !(want && want !== adoptState.dir) && now - adoptState.at < ADOPT_SCAN_MS) return adoptState.dir;
    adoptState.at = now;
    let scanned = [];
    try { scanned = scanBatteries(root, d); } catch { scanned = []; }
    adoptState.scanned = scanned;
    // A call that names no battery (listRuns, a viewer with no choice) must not yank the view to the
    // newest battery: keep the one currently shown while it still runs (Kyle, 2026-09-29: clicking LOCAL
    // flipped back to the cloud batch within seconds because the runs poll re-picked the newest).
    const pick = (want && scanned.find((r) => r.adoptable && r.dir === want))
        || (adoptState.dir && scanned.find((r) => r.adoptable && r.dir === adoptState.dir))
        || scanned.find((r) => r.adoptable);
    if (!pick) {
        if (adoptState.dir) {                                   // the battery we had adopted is over
            const was = adoptState.dir;
            const gone = scanned.find((r) => r.dir === was);
            if (live.adopted) {
                // One last rebuild from disk: the previous rebuild ran BEFORE the battery's final
                // task wrote its result, so without this the finished view froze one task short
                // (2026-09-28: q2cq4-q8kv-xtx showed 5/6 with its last task "pending"; it had passed).
                if (gone) { try { const keepErr = live.error; live = adoptedLive(gone, root); live.error = live.error || keepErr; } catch { /* keep the stale view rather than break the poll */ } }
                live.running = false; live.batteryState = gone ? gone.state : (live.batteryState || 'done'); live.current = null;
                if (gone && gone.battery && gone.battery.reason) live.error = live.error || gone.battery.reason;
            }
            adoptState.dir = null;
            return null;
        }
        return null;
    }
    if (live.running && !live.adopted) return adoptState.dir;   // an in-process battery is authoritative
    // Re-adopting the SAME battery rebuilds from disk every few seconds, which would throw away
    // what this dashboard asked for: a pause we requested, the control.json we wrote, the stop
    // watchdog that has not fired yet. Those live only here, so carry them across the rebuild.
    const keep = adoptState.dir === pick.dir && live.adopted
        ? { control: live.control, stopping: live.stopping, pauseRequested: live.pauseRequested, error: live.error }
        : null;
    live = adoptedLive(pick, root);
    if (keep) {
        live.control = keep.control; live.stopping = keep.stopping; live.error = keep.error;
        live.pauseRequested = keep.pauseRequested && !live.paused;   // it landed: stop saying "requested"
        if (live.stopping && !live.stopping.acked && stopAcknowledged()) live.stopping.acked = true;
    }
    adoptState.dir = pick.dir;
    return pick.dir;
}

// ---------- control.json ----------
const CONTROL_ACTIONS = { pause: 'pause', resume: 'run', run: 'run', 'stop-after-task': 'stop-after-task', 'stop-now': 'stop-now' };
function controlTarget() {
    const out = live.outDir || (live.battery && live.battery.out) || null;
    return out;
}
function writeControl(action, deps) {
    const act = CONTROL_ACTIONS[action];
    if (!act) throw new Error(`unknown control action: ${action}`);
    const out = (deps && deps.outDir) || controlTarget();
    if (!out) throw new Error('no battery to control (nothing running and no out dir known)');
    const file = path.join(out, CONTROL_FILE);
    const body = { action: act, at: ((deps && deps.now) || Date.now)() / 1000, by: 'ui' };
    writeJsonAtomic(file, body);
    live.control = { ...body, file };
    return { ok: true, action: act, file, body };
}
function pause(deps) {
    if (!live.running) return { running: false, error: 'no battery is running' };
    const wt = wrongTarget(deps); if (wt) return wt;
    const r = writeControl('pause', deps);
    live.pauseRequested = true;
    return { ...r, running: true, pid: live.pid, note: 'run.py polls control.json between tasks: the current task finishes and is scored first' };
}
function resume(deps) {
    if (!live.running) return { running: false, error: 'no battery is running' };
    const wt = wrongTarget(deps); if (wt) return wt;
    const r = writeControl('resume', deps);
    live.pauseRequested = false;
    return { ...r, running: true, pid: live.pid };
}
// Kill the process group (the old behaviour) -- run.py's children share its group.
function killGroup(sig, pid, c) {
    if (Number.isInteger(pid) && pid > 1) { try { process.kill(-pid, sig); return true; } catch { /* no such group */ } }
    if (c) { try { c.kill(sig); return true; } catch { /* gone */ } }
    if (Number.isInteger(pid) && pid > 1) { try { process.kill(pid, sig); return true; } catch { /* gone */ } }
    return false;
}
// Has the harness noticed control.json? Either it told us (a `stopping`/`paused` event on our own
// stream) or its battery.json left the running/paused states (the only channel an adopted battery has).
function stopAcknowledged() {
    if (!live.running) return true;
    if (live.stopping && live.stopping.acked) return true;
    const out = controlTarget(); if (!out) return false;
    const b = readBatteryFile(out);
    return !!(b && b.state && !['running', 'paused'].includes(b.state));
}
// Does the battery we are controlling speak the control protocol? battery.json in the out dir is
// the tell: harness/control.py writes it at start, and only a run.py that writes it also polls
// control.json. That distinction decides the fallback, because "ignores the file" is not a
// timeout -- a stop-after-task on a 50-minute task is read BETWEEN tasks (CONTROL.md), so
// battery.json legitimately still says "running" half an hour later. Killing then would destroy
// exactly the task the user asked to preserve.
function speaksControlProtocol() { const out = controlTarget(); return !!(out && readBatteryFile(out)); }
// mode: "after-task" (default, CONTROL.md's stop-after-task) | "now" (stop-now: the in-flight task
// is recorded ABORTED, not failed). control.json first; the kill only when the file cannot be
// heard -- an old run.py with no battery.json, or a stop-now that goes unacknowledged.
function stop(opts) {
    const o = opts || {};
    const mode = o.mode === 'now' || o.mode === 'stop-now' ? 'now' : 'after-task';
    if (!live.running) return { running: false };
    const wt = wrongTarget(o); if (wt) return wt;
    const action = mode === 'now' ? 'stop-now' : 'stop-after-task';
    const pid = child ? child.pid : (live.pgid || live.pid);
    let control = null, controlError = null;
    try { control = writeControl(action, o); } catch (e) { controlError = e.message; }
    const speaks = !controlError && speaksControlProtocol();
    // after-task on a harness that speaks the protocol: no watchdog at all, the request is safe
    // to leave pending for as long as the task takes. stop-now: run.py's mid-task watch polls
    // every 2 s, so 30 s is a generous window before the kill.
    const ackMs = o.ackMs != null ? o.ackMs : (speaks ? (mode === 'now' ? STOP_ACK_MS.now : null) : STOP_ACK_MS['after-task']);
    live.stopping = {
        mode, action, at: Date.now(), acked: false, protocol: speaks,
        control: control ? control.file : null, control_error: controlError,
        note: speaks
            ? (mode === 'now' ? 'run.py polls control.json mid-task for stop-now; the task in flight will be recorded ABORTED' : 'run.py reads control.json between tasks: the current task finishes and is scored first')
            : 'this battery wrote no battery.json, so it does not read control.json — falling back to signalling the process group',
    };
    // Only stop-now actually costs something; an after-task request is not an error condition.
    if (mode === 'now' || !speaks) live.error = live.error || (mode === 'now' ? 'stop requested from the dashboard (stop-now: the task in flight is recorded ABORTED)' : 'stop requested from the dashboard (after the current task)');
    const c = child;
    const forName = live.battery && live.battery.name;
    const fallback = () => {
        // The live view may have switched lanes (or the battery ended and `live` was rebuilt) since
        // this stop was requested: only act on the battery it was requested for (crash seen
        // 2026-09-28: live.stopping was null here). Never kill on another battery's state.
        if (!live.running || !live.stopping || (live.battery && live.battery.name) !== forName) return;
        if (stopAcknowledged()) { live.stopping.acked = true; return; }
        live.stopping.fell_back = true;
        killGroup('SIGTERM', pid, c);
        const t2 = setTimeout(() => { if (live.running) killGroup('SIGKILL', pid, c); }, o.graceMs != null ? o.graceMs : 10000);
        if (t2.unref) t2.unref();
    };
    if (ackMs == null) { /* the harness speaks the protocol and this stop can wait: no kill is scheduled */ }
    else if (ackMs <= 0) fallback();
    else { if (killTimer) clearTimeout(killTimer); killTimer = setTimeout(fallback, ackMs); if (killTimer.unref) killTimer.unref(); }
    return { running: true, stopping: true, mode, action, pid, protocol: speaks, note: live.stopping.note,
        control: control ? control.file : null, control_error: controlError,
        fallback_in_s: ackMs == null ? null : ackMs / 1000, adopted: !!live.adopted };
}

module.exports = { listModels,
    getConfig, configure,
    listRuns, getRun, getResult, taskSnapshot, listTaskCases, listVerifyRuns, verifySummary, listTasks, start, stop, live: getLive,
    // transcripts (A5/A5a), the task context panel, and battery control/adoption (CONTROL.md)
    parseTranscript, parseTranscriptFull, createTranscriptParser, getTranscript, transcriptLocation, mergeSubagentEvents, subagentStreamPath,
    getTaskInfo, parseTaskInfo, normalizeTaskInfo,
    pause, resume, writeControl, scanBatteries, runningBatteries, batteryLiveness, adoptedLive, staleFilter, adoptedTaskStart, transcriptStartMs, maybeAdopt, readBatteryFile, batterySummary, setDeviceResolver, _setProcScan,
    remoteLaneOf,
    queueServer,              // the queue item's own launch (model file, context, expanded command): lib/models.js describeRunning
    TRANSCRIPT_KINDS,
    // pure pieces, exported for tests
    parseEvent, applyEvent, freshLive, deriveStatus, taskRow, isContinuation, continuationOf, answeredOf, unfinishedOf, solvedRun, continuationIndex, skipOf, sessionState, bonusRow, resultRows, isBonusTask, bonusParent, assertionsOf, progressOf, readBaselines, retiredTasks, diagnosticTasks, isDiagnosticYaml, parseTaskListJson, parseTaskListText, buildArgs, pgrepBattery, filterPgrepLines, sweepRunning, hasFlock,
    transcriptStats, transcriptTail, filesChanged,
    broadcast: null,          // set by server4.js: (jsonString) => void, sent as SSE `event: codebench`
    STATUS_ORDER, EXCLUDED, SOLVED, RUNNERS, PROMPT_LEVELS, EFFORTS, SCAFFOLDS, PI_SCAFFOLDS, SCAFFOLD_ADVISORS, _resetForTests,
};
