// Bench -> codebench -> Queue: the benchmark queue's rows (bench.sqlite queue_items, lib/queue.js), which
// codebench/tools/queue_runner.py executes, one process per lane. Shows each lane's runner, the running
// item (link to Live and to its battery), the pending items in order and recent history with outcome
// counts; edits: reorder (arrows, or drag on a desktop), edit fields, insert from a model preset,
// duplicate, hold / release, skip, cancel, pause / resume a lane, stop-after-task / stop-now.
// Every change is a row edit through /api/queue/*; nothing here starts or kills a process.
// Since 2026-10-07 each pending / running item also shows how long it should take and when the lane gets to it
// (lib/queue.js estimateItem: timed from past runs, marked "rough" when mostly a fallback), the question it
// answers, and a note box for Kyle (queue_meta via /api/queue/item/meta). The question and the note live in a
// box that is mounted once per item and never re-rendered -- see "question + note" below.
// Since 2026-10-26 (Kyle: "the queues should all be collapsed accordions when you open the page, and should open
// scrollable windows--that page is so tall it feels impossible to navigate"; "I also found it hard to restart the paused
// queues"; "the default for adding an item back to the queue from the bottom should be adding it to the top"): every
// lane is a header that reads at a glance over a body that is closed when the page opens and scrolls in a box of its
// own when open (see "lanes" below); a paused lane says who paused it, when and why, with a "Resume lane" button in
// its header; and "again" on a finished item queues the copy at the TOP of its lane (/api/queue/item/duplicate
// position 'top'), not at the end.
import { esc, fmtDur, api, post, setHtml, harnessLabel, pollEvery, ctxLabel } from './util.js';

const BTN = 'px-2 py-0.5 rounded border border-gray-700 text-[11px] text-gray-300 hover:bg-gray-800';
const PRIMARY = 'px-3 py-1.5 bg-indigo-600 hover:bg-indigo-500 text-white rounded-md text-xs font-semibold';
const DANGER = 'px-2 py-0.5 rounded bg-red-600 hover:bg-red-500 text-white text-[11px] font-semibold';
const INPUT = 'bg-gray-950 border border-gray-700 rounded px-1.5 py-0.5 text-[11px] text-gray-200 w-full';
const H = 'text-[10px] font-semibold uppercase tracking-wider text-gray-500';
const CARD = 'bg-gray-900/50 border border-gray-800 rounded-lg p-2';

// Layout and chip colours the vendored Tailwind build does not carry (its content globs scan index.html and script.js).
const CSS = `
#cb-view-queue .qv-row{display:grid;grid-template-columns:1.4rem minmax(0,1fr) auto;gap:.15rem .5rem;align-items:start;padding:.35rem .25rem;border-top:1px solid #252832}
#cb-view-queue .qv-row.qv-drag{opacity:.4}
#cb-view-queue .qv-row.qv-over{box-shadow:inset 0 2px 0 #6366f1}
#cb-view-queue .qv-handle{cursor:grab;color:#525867;user-select:none;font-size:13px;line-height:1}
#cb-view-queue .qv-acts{display:flex;flex-wrap:wrap;gap:.25rem;justify-content:flex-end}
#cb-view-queue .qv-chip{display:inline-block;padding:0 .35rem;border-radius:.25rem;font-size:10px;font-family:ui-monospace,monospace;line-height:1.35rem;white-space:nowrap}
#cb-view-queue .qv-pending{background:#252832;color:#959cab}
#cb-view-queue .qv-running{background:rgba(49,46,129,.7);color:#c7d2fe}
#cb-view-queue .qv-done{background:rgba(20,83,45,.6);color:#bbf7d0}
#cb-view-queue .qv-failed,#cb-view-queue .qv-interrupted{background:rgba(127,29,29,.6);color:#fecaca}
#cb-view-queue .qv-skipped,#cb-view-queue .qv-cancelled{background:#363a47;color:#b9bec9}
#cb-view-queue .qv-paused{background:rgba(113,63,18,.6);color:#fde68a}
#cb-view-queue .qv-k-stage{background:rgba(113,63,18,.35);color:#fcd34d}
#cb-view-queue .qv-k-wait{background:rgba(30,58,138,.4);color:#bfdbfe}
#cb-view-queue .qv-k-shell{background:rgba(88,28,135,.4);color:#e9d5ff}
#cb-view-queue .qv-k-run{background:#252832;color:#959cab}
#cb-view-queue .qv-s-pass{background:rgba(20,83,45,.6);color:#bbf7d0}
#cb-view-queue .qv-s-fail{background:rgba(127,29,29,.6);color:#fecaca}
#cb-view-queue .qv-s-other{background:#363a47;color:#d9dce4}
@media (max-width:760px){#cb-view-queue .qv-row{grid-template-columns:1.4rem minmax(0,1fr)}#cb-view-queue .qv-row>.qv-acts{grid-column:1 / -1;justify-content:flex-start;padding-left:1.4rem}}
#cb-view-queue .qv-form{display:grid;grid-template-columns:minmax(0,1fr);gap:.4rem}
@media (min-width:900px){#cb-view-queue .qv-form{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}#cb-view-queue .qv-wide{grid-column:1 / -1}}
#cb-view-queue .qv-pre{white-space:pre-wrap;word-break:break-all;max-height:12rem;overflow:auto}
#cb-view-queue textarea{font-family:ui-monospace,monospace}
#cb-view-queue .qv-est{font-size:10px;line-height:1.4;color:#959cab}
#cb-view-queue .qv-est b{font-weight:600;color:#e2e5ec}
#cb-view-queue .qv-rough{color:#fcd34d}
#cb-view-queue .qv-row>.qv-more{grid-column:2 / -1;min-width:0}
@media (min-width:761px){#cb-view-queue .qv-row[data-item]>.qv-acts{grid-column:3;grid-row:1}}
#cb-view-queue .qv-meta{display:grid;gap:.2rem;margin-top:.2rem;min-width:0}
#cb-view-queue .qv-q{font-size:12px;line-height:1.4;color:#c7d2fe;overflow-wrap:anywhere}
#cb-view-queue .qv-q .qv-q-none{font-size:10px;color:#525867}
#cb-view-queue .qv-q button{margin-left:.25rem;opacity:.6}
#cb-view-queue .qv-qform{display:flex;flex-wrap:wrap;gap:.25rem;align-items:center}
#cb-view-queue .qv-qform input{flex:1 1 12rem;font-size:12px}
#cb-view-queue textarea.qv-note{display:block;font-family:inherit;font-size:12px;line-height:1.4;padding:.2rem .4rem;min-height:1.75rem;max-height:14rem;resize:vertical}
#cb-view-queue textarea.qv-note:focus,#cb-view-queue .qv-qform input:focus{outline:none;border-color:#6366f1}
#cb-view-queue .qv-note-st{font-size:10px;line-height:1.3;color:#6b7280}
#cb-view-queue .qv-note-st:empty{display:none}
#cb-view-queue .qv-ok{color:#86efac}
#cb-view-queue .qv-bad{color:#fca5a5}
@media (max-width:760px){#cb-view-queue textarea.qv-note,#cb-view-queue .qv-qform input{font-size:16px}}
#cb-view-queue .qv-lhead{display:flex;flex-wrap:wrap;align-items:flex-start;justify-content:space-between;gap:.35rem .5rem}
#cb-view-queue .qv-ltoggle{flex:1 1 18rem;min-width:0;display:flex;flex-direction:column;gap:.2rem;text-align:left;background:none;border:0;padding:0;margin:0;color:inherit;font:inherit;cursor:pointer}
#cb-view-queue .qv-ltoggle:focus-visible{outline:2px solid #6366f1;outline-offset:2px;border-radius:.25rem}
#cb-view-queue .qv-lline{display:flex;flex-wrap:wrap;align-items:center;gap:.25rem .5rem;min-width:0}
#cb-view-queue .qv-caret{display:inline-block;width:.75rem;color:#959cab;font-size:11px;transition:transform .12s}
#cb-view-queue .qv-lane-open .qv-caret{transform:rotate(90deg)}
#cb-view-queue .qv-lname{font-size:12px;font-weight:600;color:#e2e5ec}
#cb-view-queue .qv-lcount{font-size:11px;color:#b9bec9}
#cb-view-queue .qv-lrun{display:flex;align-items:baseline;gap:.4rem;min-width:0;font-size:11px;line-height:1.4;color:#c7d2fe;padding-left:1.25rem}
#cb-view-queue .qv-lrun .qv-trunc{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:ui-monospace,monospace}
#cb-view-queue .qv-lrun .qv-prog{flex:none;color:#959cab}
#cb-view-queue .qv-ldetail{color:#959cab}
#cb-view-queue .qv-lacts{display:flex;flex-wrap:wrap;gap:.25rem;align-items:center}
#cb-view-queue .qv-resume{padding:.3rem .75rem;border-radius:.375rem;background:#15803d;color:#fff;font-size:12px;font-weight:600;line-height:1.2}
#cb-view-queue .qv-resume:hover{background:#16a34a}
#cb-view-queue .qv-lpause{margin-top:.35rem;padding:.3rem .5rem;border-radius:.375rem;background:rgba(113,63,18,.25);border:1px solid rgba(180,83,9,.45);font-size:11px;line-height:1.45;color:#fde68a;overflow-wrap:anywhere}
#cb-view-queue .qv-lpause .qv-lnote{color:#e2e5ec;white-space:pre-wrap}
#cb-view-queue .qv-lpause .qv-dim{color:#959cab}
#cb-view-queue .qv-scroll{max-height:60vh;overflow-y:auto;margin-top:.35rem}
#cb-view-queue .qv-scroll[hidden]{display:none}
#cb-view-queue .qv-lbody>*+*{margin-top:.25rem}
`;
const META_MAX = 4000;   // characters, the server's cap on a question / a note (lib/queue.js)

const STATUS_CLS = (s) => `qv-chip qv-${esc(s)}`;
const ago = (iso) => { if (!iso) return '—'; const s = (Date.now() - Date.parse(iso)) / 1000; return s < 0 ? 'now' : `${fmtDur(s)} ago`; };
const since = (a, b) => (a ? fmtDur(((b ? Date.parse(b) : Date.now()) - Date.parse(a)) / 1000) : '—');
const clock = (iso) => { if (!iso) return '—'; const d = new Date(iso); const p = (n) => String(n).padStart(2, '0'); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };

// An estimate reads as one: "under 5 min", "~40 min", "~2.5 h", "~16 h", never to the minute.
export function fmtEst(h) {
    if (h == null || !Number.isFinite(Number(h))) return '';
    const m = Math.round(Number(h) * 12) * 5;
    if (m < 5) return 'under 5 min';
    if (m < 60) return `~${m} min`;
    return h < 9.95 ? `~${Math.round(h * 10) / 10} h` : `~${Math.round(h)} h`;
}
// "Thu 05:00", to the quarter hour, local time; with the date once it is six days or more away.
export function fmtWhen(iso, now = Date.now()) {
    const t = Date.parse(iso || ''); if (!Number.isFinite(t)) return '—';
    const d = new Date(Math.round(t / 900000) * 900000); const p = (n) => String(n).padStart(2, '0');
    const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()];
    return `${day}${t - now >= 6 * 86400000 ? ` ${p(d.getMonth() + 1)}-${p(d.getDate())}` : ''} ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// What an estimate was timed from, for its tooltip: 'm:<model file>|<n_ctx>[|nothink]' or 'c:<runner model>[|<effort>]'.
const timedFrom = (k) => { const [a, b, c] = String(k || '').slice(2).split('|'); return String(k).startsWith('m:') ? `${a} at ${ctxLabel(b) || '?'} context${c === 'nothink' ? ', thinking off' : ''}` : `${a}${b ? ` at effort ${b}` : ''}`; };
function estTitle(it) {
    const e = it.est; if (!e) return 'no past runs to time this from, and no hand estimate is recorded for the item';
    if (e.basis === 'wait') return 'a timed wait';
    if (e.basis === 'guess') return 'no past runs to time this from: this is the hand estimate recorded with the item';
    const bits = [`${e.measured_tasks} of ${e.tasks} task${e.tasks === 1 ? '' : 's'} timed from past runs of the same task on ${e.timed_from ? timedFrom(e.timed_from) : 'this model + context (it has none yet)'}`];
    if (e.scaled_tasks) bits.push(`${e.scaled_tasks} never run there, timed from other local models' runs of the task${e.speed_ratio != null && e.speed_ratio !== 1 ? ` × ${e.speed_ratio} (this config's pace against theirs)` : ''}`);
    if (e.config_tasks) bits.push(`${e.config_tasks} ${String(e.timed_from).startsWith('c:') ? 'never run there' : 'no local model has run'}, counted at its average over all tasks`);
    if (e.guess_tasks) bits.push(`${e.guess_tasks} from the hand estimate`);
    if (it.timeout_s) bits.push(`each task capped at the item's ${fmtDur(it.timeout_s)}`);
    if (e.hand_hours != null) bits.push(`the hand estimate recorded with the item: ${fmtEst(e.hand_hours)}`);
    return bits.join('; ');
}
/** The estimate line of a pending / running item: "~6 h · starts ~Thu 01:00 · done ~Thu 07:00". Pure: node tests it. */
export function estHtml(it, now = Date.now()) {
    const e = it.est; const c = it.clock; const run = it.status === 'running';
    const at = (iso) => `${c.after_unknown ? '<span title="an item ahead of it has no estimate: no earlier than this">≥</span> ' : '~'}${esc(fmtWhen(iso, now))}`;
    const bits = [];
    if (!e) bits.push(`<span title="${esc(estTitle(it))}">no estimate</span>`);
    else bits.push(`<span title="${esc(estTitle(it))}"><b>${esc(fmtEst(e.hours))}</b>${run ? ' left' : ''}${e.rough ? ' <span class="qv-rough">rough</span>' : ''}</span>`);
    if (e && e.overdue) bits.push('<span class="qv-rough">the task in flight is past its usual time</span>');
    if (!c) bits.push('held: not in the lane’s clock');
    else if (run) { if (c.done_at) bits.push(`done ${at(c.done_at)}`); }
    else { bits.push(`starts ${at(c.starts_at)}`); if (c.done_at) bits.push(`done ${at(c.done_at)}`); }
    return `<div class="qv-est">${bits.join(' · ')}</div>`;
}
function countChips(counts) {
    const e = Object.entries(counts || {});
    if (!e.length) return '<span class="text-gray-600 text-[10px]">no results</span>';
    const order = ['pass', 'pass*', 'fail', 'TIMEOUT', 'OVERFLOW', 'KILLED', 'PROVIDER_ERROR', 'ABORTED', 'not run'];
    e.sort((a, b) => (order.indexOf(a[0]) + 99) % 99 - (order.indexOf(b[0]) + 99) % 99);
    return e.map(([k, v]) => `<span class="qv-chip ${/^pass/.test(k) ? 'qv-s-pass' : k === 'fail' ? 'qv-s-fail' : 'qv-s-other'}">${esc(k)} ${v}</span>`).join(' ');
}
function describeSource(src, depth = 0) {
    if (src == null) return '';
    if (Array.isArray(src)) return `${src.length} tasks`;
    const k = src.from || ['tasks', 'file', 'item', 'sql'].find((x) => x in src);
    if (k === 'tasks') return `${(src.tasks || []).length} listed tasks`;
    if (k === 'file') return `file ${String(src.file || src.path).split('/').pop()}`;
    if (k === 'item') return `#${src.item ?? src.id}'s failures`;
    if (k === 'sql') return 'SQL query';
    if (k === 'cascade') {
        const rule = `${src.model_like} @ ${ctxLabel(src.n_ctx) || '?'}${src.exclude_like ? ` minus ${src.exclude_like}` : ''}`;
        const inner = depth > 2 ? '…' : describeSource(src.input, depth + 1);
        return src.mode === 'failed' ? `(${inner}) failed by ${rule}` : `${inner} → not yet run at ${rule}`;
    }
    return '?';
}
function summary(it) {
    if (it.kind === 'wait') {
        const w = it.wait || {};
        return w.pid ? `wait for pid ${w.pid}${w.cmd_contains ? ` (${w.cmd_contains})` : ''}` : w.log ? `wait for /${w.pattern || 'DONE'}/ in ${String(w.log).split('/').pop()}` : w.seconds ? `wait ${fmtDur(w.seconds)}` : w.file_absent ? `wait until ${w.file_absent} is gone` : 'wait';
    }
    if (it.kind === 'shell') return `<span class="font-mono">${esc(String(it.shell_cmd || '').slice(0, 160))}</span>`;
    const bits = [];
    if (it.model) bits.push(`<span class="font-mono text-gray-300">${esc(it.model)}</span>`);
    const env = it.env || {};
    if (env.CODEBENCH_CLAUDE_EFFORT) bits.push(`<span class="font-mono text-amber-300">effort ${esc(env.CODEBENCH_CLAUDE_EFFORT)} · ${esc(env.CODEBENCH_CLAUDE_SCAFFOLD || '?')}</span>`);
    const resolved = it.resolved_tasks;
    if (resolved && it.status !== 'pending' && it.status !== 'paused') bits.push(`${resolved.length} task${resolved.length === 1 ? '' : 's'}`);
    else if (it.task_source) bits.push(`<span class="text-yellow-300">${esc(describeSource(it.task_source))}</span>${it.approved ? ` <span class="text-gray-500">∩ ${it.approved.length} approved</span>` : ''}`);
    else if (it.tasks) bits.push(it.tasks.length <= 3 ? `<span class="font-mono">${esc(it.tasks.join(' '))}</span>` : `${it.tasks.length} tasks`);
    if (it.timeout_s && it.timeout_s !== 7200) bits.push(`cap ${fmtDur(it.timeout_s)}`);
    if (it.record) bits.push('<span class="text-indigo-300">record</span>');
    return bits.join(' <span class="text-gray-700">·</span> ');
}

export function createQueueView(root, { onOpenLive, onOpenRun } = {}) {
    if (!document.getElementById('qv-css')) { const st = document.createElement('style'); st.id = 'qv-css'; st.textContent = CSS; document.head.appendChild(st); }
    // lanesOpen: the lanes the reader opened, this page load only (see "lanes" below); flash: a one-line "where it went"
    const st = { data: null, presets: null, open: new Set(), edit: null, err: null, previews: {}, timer: null, visible: false, busy: false, meta: new Map(), lanesOpen: new Set(), flash: null };

    async function refresh(force) {
        const j = await api('/api/queue');
        if (j.error) { st.err = j.error; } else { st.err = null; st.data = j; }
        // Re-render only when something changed (or every 30 s, for the elapsed clocks): a rebuild under the
        // pointer loses hover / focus and detaches the row being dragged. Never tear down a form being typed into.
        // (est / clock move with the wall clock on every poll: left out, the 30 s redraw shows them)
        const still = (a) => (a || []).map((i) => ({ ...i, est: undefined, clock: undefined }));
        // (who paused a lane, when and its note are in the header since 10-26: a new pause shows at once)
        const sig = JSON.stringify([st.err, still(j.running), still(j.pending), j.history, (j.lanes || []).map((l) => [l.lane, l.paused, l.alive, l.runner_state, l.runner_detail, l.parked || false, (l.card && l.card.label) || null, l.paused_by || null, l.paused_at || null, l.note || null])]);
        if (!st.edit && (force === true || sig !== st.sig || Date.now() - (st.renderedAt || 0) > 30000)) { st.sig = sig; render(); }
        else renderStatus();
    }
    async function loadPresets() { if (!st.presets) { const p = await api('/api/queue/presets'); if (!p.error) st.presets = p; } }
    async function act(url, body, confirmMsg) {
        if (confirmMsg && !window.confirm(confirmMsg)) return null;
        const r = await post(url, body);
        if (r.error) { st.err = r.error; render(); return null; }
        await refresh(true);
        return r;
    }

    // ---------------------------------------------------------------- question + note (one mounted box per item)
    // This view redraws on a timer through setHtml, which MERGES the new HTML into the live tree: a data-keep
    // element stays the same node and its children are not touched (ui/benchmarks/live.js mounts its chat the same
    // way). So an item's question line and note box are built ONCE (st.meta), never rendered as HTML, and put into
    // the item's data-keep host after every redraw -- the box being typed in is the same element before and after,
    // with its draft, caret and focus. The rows carry a data-key so a host is only ever matched with its own item.
    // When a row MOVES (a reorder; pending -> running) its old host goes and a new one appears: the same box is
    // moved across, which blurs it, so render() puts the focus and the caret back by hand.
    const metaHost = (it) => `<div data-keep data-key="qv-meta-${it.id}" data-meta-host="${it.id}"></div>`;
    const activeItem = (id) => (st.data ? [...st.data.running, ...st.data.pending].find((x) => x.id === id) : null);
    function noteStatus(b, text, cls) { b.stEl.className = `qv-note-st${cls ? ` ${cls}` : ''}`; b.stEl.textContent = text || ''; }
    // The box is as tall as its text (never past the CSS max-height). Measuring means collapsing it to one line for
    // an instant, which can clamp a panel scrolled to its very end: every scrolled ancestor is put back.
    function fitNote(b) {
        const ta = b.ta;
        if (!ta.value) { if (ta.style.height) ta.style.height = ''; return; }   // empty: its one line, nothing to measure
        if (!ta.offsetParent) return;   // not on screen: nothing to measure
        const held = []; for (let el = ta.parentElement; el; el = el.parentElement) if (el.scrollTop) held.push([el, el.scrollTop]);
        ta.style.height = '';
        if (ta.scrollHeight > ta.clientHeight + 1) ta.style.height = `${ta.scrollHeight + 2}px`;
        for (const [el, top] of held) if (el.scrollTop !== top) el.scrollTop = top;
    }
    async function saveNote(b) {
        clearTimeout(b.timer); b.timer = null;
        if (b.saving) { b.again = true; return; }
        const val = b.ta.value;
        if (val === b.saved && !b.failed) { b.dirty = false; noteStatus(b, ''); return; }
        b.saving = true; noteStatus(b, 'saving…');
        const r = await post('/api/queue/item/meta', { id: b.id, user_note: val });
        b.saving = false;
        if (r.error) {
            // the dashboard could not be reached (a restart, a flaky link): keep trying; a refusal waits for an edit
            const retry = r.errorKind === 'network'; b.failed = true; b.tries = (b.tries || 0) + 1;
            noteStatus(b, `NOT saved: ${r.error} — it stays in the box; ${retry ? 'trying again by itself, or ' : ''}click here to try again`, 'qv-bad');
            if (retry && st.meta.get(b.id) === b) { b.timer = setTimeout(() => saveNote(b), Math.min(30000, 5000 * b.tries)); return; }
        } else {
            b.failed = false; b.tries = 0; b.saved = val; b.dirty = b.ta.value !== val;
            const it = activeItem(b.id); if (it) it.user_note = (r.meta && r.meta.user_note) || '';
            noteStatus(b, b.dirty ? 'typing… saves when you pause' : `saved ${new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, b.dirty ? '' : 'qv-ok');
        }
        // typed on while it was saving: once more when the typing pauses (a failed save waits for the next edit or blur)
        if (b.again || (b.dirty && !r.error)) { b.again = false; clearTimeout(b.timer); b.timer = setTimeout(() => saveNote(b), 1500); }
    }
    async function saveQuestion(b) {
        const r = await post('/api/queue/item/meta', { id: b.id, question: b.qIn.value });
        if (r.error) { noteStatus(b, `question NOT saved: ${r.error}`, 'qv-bad'); return; }
        const it = activeItem(b.id); if (it) it.question = (r.meta && r.meta.question) || null;
        b.editingQ = false; b.qForm.style.display = 'none'; noteStatus(b, 'question saved', 'qv-ok');
        if (it) syncMeta(b, it);
    }
    function metaBox(id) {
        let b = st.meta.get(id); if (b) return b;
        const el = document.createElement('div'); el.className = 'qv-meta';
        el.innerHTML = `<div class="qv-q"><span data-qm-q></span><button type="button" class="${BTN}" data-qm-qedit title="edit the question this item answers">✎</button></div>
            <div class="qv-qform" style="display:none"><input class="${INPUT}" maxlength="${META_MAX}" data-qm-qin placeholder="the question this item answers" aria-label="the question this item answers">
                <button type="button" class="${BTN}" data-qm-qsave>save</button><button type="button" class="${BTN}" data-qm-qcancel>cancel</button></div>
            <textarea class="${INPUT} qv-note" rows="1" maxlength="${META_MAX}" data-qm-note placeholder="your note (saves by itself)" aria-label="your note on item #${id}"></textarea>
            <div data-qm-st class="qv-note-st"></div>`;
        const q = (sel) => el.querySelector(sel);
        b = { id, el, ta: q('[data-qm-note]'), qEl: q('[data-qm-q]'), qForm: q('.qv-qform'), qIn: q('[data-qm-qin]'), stEl: q('[data-qm-st]'),
            saved: '', dirty: false, saving: false, failed: false, again: false, timer: null, editingQ: false, hover: false, focus: false };
        st.meta.set(id, b);
        b.ta.addEventListener('input', () => {
            b.dirty = b.ta.value !== b.saved; fitNote(b);
            noteStatus(b, b.dirty ? 'typing… saves when you pause' : '');
            clearTimeout(b.timer); b.timer = b.dirty ? setTimeout(() => saveNote(b), 2000) : null;
        });
        b.ta.addEventListener('blur', () => { if (b.dirty || b.failed) saveNote(b); });
        b.ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); saveNote(b); } });
        b.stEl.addEventListener('click', () => { if (b.failed) saveNote(b); });
        q('[data-qm-qedit]').addEventListener('click', () => {
            b.editingQ = true; b.qIn.value = (activeItem(id) || {}).question || ''; b.qForm.style.display = ''; b.qIn.focus();
        });
        q('[data-qm-qcancel]').addEventListener('click', () => { b.editingQ = false; b.qForm.style.display = 'none'; });
        q('[data-qm-qsave]').addEventListener('click', () => saveQuestion(b));
        b.qIn.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); saveQuestion(b); } else if (e.key === 'Escape') { e.stopPropagation(); b.editingQ = false; b.qForm.style.display = 'none'; } });
        // A pending row is draggable (reorder), and a drag starts from anywhere inside it -- including a text
        // selection in the note. While the pointer or the focus is in the box, the row is not draggable.
        const drag = () => { const row = el.closest('.qv-row'); if (row) row.draggable = !(b.hover || b.focus); };
        b.drag = drag;
        el.addEventListener('pointerenter', () => { b.hover = true; drag(); });
        el.addEventListener('pointerleave', () => { b.hover = false; drag(); });
        el.addEventListener('focusin', () => { b.focus = true; drag(); });
        el.addEventListener('focusout', () => { b.focus = false; drag(); });
        return b;
    }
    // The server's question and note into a box, leaving alone whatever is being edited or is not saved yet.
    function syncMeta(b, it) {
        const qText = it.question || 'no question recorded for this item';
        if (!b.editingQ && b.qEl.textContent !== qText) {   // only when it changed: a rewrite would drop a selection in it
            b.qEl.textContent = qText;
            b.qEl.className = it.question ? '' : 'qv-q-none';
        }
        const note = it.user_note || '';
        if (!b.dirty && !b.saving && !b.failed && document.activeElement !== b.ta && (b.ta.value !== note || b.saved !== note)) {
            b.ta.value = note; b.saved = note; fitNote(b);
        }
        b.drag();
    }
    function attachMeta() {
        const live = new Set();
        for (const host of root.querySelectorAll('[data-meta-host]')) {
            const id = Number(host.dataset.metaHost); const it = activeItem(id); if (!it) continue;
            const b = metaBox(id); live.add(id);
            const moved = b.el.parentNode !== host;
            if (moved) host.appendChild(b.el);   // already there after a merge: appending again would MOVE it (and blur it)
            syncMeta(b, it);
            if (moved) fitNote(b);
        }
        // an item that left the queue (finished, cancelled): its box goes, an unsaved draft is sent first
        for (const [id, b] of st.meta) if (!live.has(id)) { if (b.dirty) saveNote(b); else clearTimeout(b.timer); b.el.remove(); st.meta.delete(id); }
    }
    // The element being typed in, if it is in one of the boxes: put back after a redraw that moved its box.
    function metaFocus() {
        const a = document.activeElement;
        if (!a || a === document.body || ![...st.meta.values()].some((b) => b.el.contains(a))) return null;
        const f = { el: a, top: a.scrollTop, y: a.getBoundingClientRect().top };
        try { f.start = a.selectionStart; f.end = a.selectionEnd; f.dir = a.selectionDirection; } catch { /* a button */ }
        return f;
    }
    function restoreMetaFocus(f) {
        if (!f || !f.el.isConnected) return;
        if (document.activeElement !== f.el) {
            f.el.focus({ preventScroll: true });
            try { if (f.start != null) f.el.setSelectionRange(f.start, f.end, f.dir || 'none'); } catch { /* not a text field */ }
            f.el.scrollTop = f.top;
        }
        // ...and it stays where it was on screen: when rows above it came or went (or its own row moved), the
        // panel that scrolls it is moved by the same amount, so the line being typed does not slide away
        const dy = f.el.getBoundingClientRect().top - f.y;
        if (Math.abs(dy) < 1) return;
        let sc = f.el.parentElement;
        while (sc && !(sc.scrollHeight > sc.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(sc).overflowY))) sc = sc.parentElement;
        if (sc) sc.scrollTop += dy; else window.scrollBy(0, dy);
    }

    // ---------------------------------------------------------------- lanes (accordions since 2026-10-26)
    // Kyle 10-26: "the queues should all be collapsed accordions when you open the page, and should open scrollable
    // windows--that page is so tall it feels impossible to navigate" (local-gpu alone held ~90 rows). Each lane is a
    // header that reads at a glance -- name, cards, paused / running, the running item and how far it has got, how many
    // items wait and how many are held, the lane's hours -- over a body that is CLOSED when the page opens. Opened, the
    // body is a box of its own (60vh at most) that scrolls by itself; dragging a row to reorder works inside it (the
    // browser scrolls the box when the drag nears its edge). The header toggles it (a button: keyboard and screen
    // readers get aria-expanded); the lane's actions sit beside it, outside the toggle.
    // WHICH LANES ARE OPEN lives in st.lanesOpen -- not in the DOM, not in localStorage (rule 1 in ui/benchmarks/util.js,
    // "WHAT THE READER OPENED OR CLOSED"): the markup is drawn from it, so a lane that a redraw rebuilds (setHtml replaces
    // a node that holds no scroller or kept box) comes back as the reader left it, and every page load opens with all
    // lanes closed, which is what Kyle asked for (queue.js kept no per-viewer state before; the Live view's accordions
    // that do remember theirs are another page). A body is in the page closed or open (`hidden`): the note boxes live
    // in it, and attachMeta drops a box whose host is gone. Its class carries "overflow-y-auto" so setHtml treats it as
    // a scroller: the same node across redraws, scroll position and all.
    // PAUSED LANES (Kyle 10-26: "I also found it hard to restart the paused queues"): a pause showed as a chip with its
    // reason only in a tooltip, and "resume" was a small button at the end of a long header. Now a paused lane says so
    // under its header in words -- who paused it (paused_by: "dashboard" is this page or the /api/queue/lane API; a
    // watcher writes its own name, e.g. card-handoff), when, and its note in full -- and its header, open or closed,
    // carries a green "Resume lane" button. Resume keeps the confirm it had (card-handoff and the thermal guards pause a
    // lane for crashed or hot hardware: the confirm repeats who paused it and why). Pause stays one click.
    const laneRow = (lane) => ((st.data && st.data.lanes) || []).find((x) => x.lane === lane) || null;
    /** The running item in its lane's header: its label on one line (all of it in the tooltip) and how far it has got --
     *  "2/5 tasks done · ~45 min left". est.tasks is what is LEFT of the item's tasks, the one in flight included
     *  (lib/queue.js estimateFor counts the item's resolved tasks its battery has not scored); with no estimate (a shell
     *  or wait item, no history), how long it has been running. */
    function runLine(it) {
        const all = it.resolved_tasks || it.tasks || null;
        const left = it.est && it.est.tasks != null && Number.isFinite(Number(it.est.tasks)) ? Number(it.est.tasks) : null;
        const bits = [];
        if ((it.kind === 'run' || it.kind === 'stage') && all && all.length) bits.push(left != null ? `${Math.max(0, all.length - left)}/${all.length} tasks done` : `${all.length} tasks`);
        bits.push(it.est ? `${fmtEst(it.est.hours)} left` : `running ${since(it.started_at)}`);
        if (it.control) bits.push(`${it.control} requested`);
        return `<span class="qv-lrun"><span class="qv-trunc" title="${esc(`#${it.id} ${it.label || ''}`)}">▶ #${it.id} ${esc(it.label || '')}</span><span class="qv-prog">${esc(bits.join(' · '))}</span></span>`;
    }
    /** "Paused by card-handoff · 10-26 07:57 (35m 12s ago)" + the note in full: under a paused lane's header. */
    function pausedHtml(L) {
        const who = L.paused_by ? ` by <span title="who set it: &quot;dashboard&quot; is this page or the /api/queue/lane API; a watcher writes its own name">${esc(L.paused_by)}</span>` : '';
        const when = L.paused_at ? ` · ${esc(clock(L.paused_at))} (${esc(ago(L.paused_at))})` : '';
        const dead = L.alive ? '' : ' · <span class="qv-bad">its runner is not running: resuming starts nothing until the runner is back</span>';
        return `<div class="qv-lpause" data-lane-paused><b>Paused</b>${who}${when}${dead}
            ${L.note ? `<div class="qv-lnote">${esc(L.note)}</div>` : '<div class="qv-dim">no note</div>'}</div>`;
    }
    function laneHtml(lane) {
        const d = st.data;
        const L = laneRow(lane) || { lane, paused: 0 };
        const running = d.running.filter((i) => i.lane === lane);
        const pending = d.pending.filter((i) => i.lane === lane);
        const held = pending.filter((i) => i.status === 'paused').length; const waiting = pending.length - held;
        const open = st.lanesOpen.has(lane);
        // the lane's hours and clock: the running item's remainder + the pending items, back to back from now
        const le = (d.lane_est || {})[lane];
        // The lane's cards on this machine, from the server (/api/queue lanes[].card: the lane's device list read against
        // the machine's topology, or a remote lane's own card name). A lane's NAME says nothing reliable about hardware.
        const c = L.card && L.card.label ? L.card : null;
        const card = c ? `<span class="text-[10px] text-gray-400" title="${esc(c.remote ? 'this lane serves on another machine; the card is the one its runner published' : c.here === false ? 'the card this lane was set up for is not in this machine' : 'the card(s) this lane runs on, in this machine')}">${esc(c.label)}${c.remote ? ' (remote)' : c.here === false ? ' (not in this machine)' : ''}</span>` : '';
        const total = le && (le.items || le.unknown) ? `<span class="qv-est" title="what is left of the running item + the pending items, one after another from now; held items are not counted${L.paused ? '; the lane is paused: this assumes it resumes now' : ''}">${le.items ? `<b>${esc(fmtEst(le.hours))}</b> queued` : ''}${le.unknown ? `${le.items ? ' + ' : ''}${le.unknown} with no estimate` : ''}${le.done_at ? ` · done ${le.unknown ? '≥ ' : '~'}${esc(fmtWhen(le.done_at))}` : ''}${L.paused && le.done_at ? ' if resumed now' : ''}</span>` : '';
        // paused or not, then what the runner says (its own words in the tooltip)
        const runnerSays = `runner ${L.runner_state || 'up'}${L.runner_detail ? `: ${L.runner_detail}` : ''}`;
        const state = [
            L.paused ? '<span class="qv-chip qv-paused">paused</span>' : '',
            !L.alive ? `<span class="qv-chip qv-failed" title="${esc(L.heartbeat_at ? `its runner was last seen ${ago(L.heartbeat_at)}` : 'no runner has reported for this lane')}">runner not running</span>`
                : !L.paused ? `<span class="qv-chip ${running.length ? 'qv-running' : 'qv-pending'}" title="${esc(runnerSays)}">${esc(running.length ? 'running' : (L.runner_state || 'up'))}</span>` : '',
        ].join('');
        const counts = `<span class="qv-lcount">${waiting || held ? `${waiting} pending${held ? ` · ${held} held` : ''}` : 'nothing waiting'}</span>`;
        // second line: the running item; else why a live runner is waiting (waiting-gpu: "ROCm1 in use by item 1465 ...")
        const second = running.length ? running.map(runLine).join('')
            : L.alive && !L.paused && L.runner_detail && L.runner_state !== 'idle' ? `<span class="qv-lrun qv-ldetail"><span class="qv-trunc" title="${esc(runnerSays)}">${esc(L.runner_detail)}</span></span>` : '';
        const body = `${running.map(runningHtml).join('')}
                <div data-list="${esc(lane)}">${pending.map((it, i) => pendingHtml(it, i)).join('') || '<div class="text-[11px] text-gray-600 py-1">nothing pending</div>'}</div>`;
        return `<div class="${CARD}${open ? ' qv-lane-open' : ''}" data-lane="${esc(lane)}" data-key="qv-lane-${esc(lane)}">
            <div class="qv-lhead">
                <button type="button" class="qv-ltoggle" data-lane-toggle="${esc(lane)}" aria-expanded="${open}" aria-controls="qv-lbody-${esc(lane)}" title="${open ? 'hide' : 'show'} this lane's items">
                    <span class="qv-lline"><span class="qv-caret" aria-hidden="true">▸</span><span class="qv-lname">${esc(lane)}</span> ${card} ${state} ${counts} ${total}</span>
                    ${second}
                </button>
                <span class="qv-lacts">
                    ${L.paused ? `<button type="button" class="qv-resume" data-lane-resume="${esc(lane)}" title="let the runner start this lane's next pending item">▶ Resume lane</button>`
                        : `<button type="button" class="${BTN}" data-lane-pause="${esc(lane)}" title="the running item carries on; nothing new starts">⏸ pause lane</button>`}
                    <button type="button" class="${BTN}" data-new="${esc(lane)}">＋ item</button></span>
            </div>
            ${L.paused ? pausedHtml(L) : ''}
            <div class="qv-scroll qv-lbody overflow-y-auto" id="qv-lbody-${esc(lane)}" data-lane-body="${esc(lane)}" data-key="qv-lbody-${esc(lane)}"${open ? '' : ' hidden'}>
                ${body}
            </div>
        </div>`;
    }
    /** Open or close a lane in place (no redraw: a form being typed in at the top stays as it is); the next redraw
     *  draws the same thing from st.lanesOpen. A note box shown for the first time is sized now (fitNote measures only
     *  what is on screen). */
    function toggleLane(lane) {
        const open = !st.lanesOpen.has(lane);
        if (open) st.lanesOpen.add(lane); else st.lanesOpen.delete(lane);
        for (const card of root.querySelectorAll('[data-lane]')) {
            if (card.dataset.lane !== lane) continue;
            card.classList.toggle('qv-lane-open', open);
            const b = card.querySelector('[data-lane-toggle]'); if (b) { b.setAttribute('aria-expanded', String(open)); b.title = `${open ? 'hide' : 'show'} this lane's items`; }
            const body = card.querySelector('[data-lane-body]'); if (!body) continue;
            if (open) body.removeAttribute('hidden'); else body.setAttribute('hidden', '');
            if (open) for (const host of body.querySelectorAll('[data-meta-host]')) { const m = st.meta.get(Number(host.dataset.metaHost)); if (m) fitNote(m); }
        }
    }
    function runningHtml(it) {
        const oc = it.outcome || {};
        const alive = it.harnessAlive;
        const stopping = it.control ? `<span class="qv-chip qv-paused">${esc(it.control)} requested</span>` : '';
        return `<div class="border border-indigo-500 rounded-lg p-2 space-y-1" data-running="${it.id}" data-key="qv-run-${it.id}">
            <div class="flex flex-wrap items-center gap-2">
                <span class="${STATUS_CLS('running')} animate-pulse">running</span> <span class="qv-chip qv-k-${esc(it.kind)}">${esc(it.kind)}</span>
                <span class="text-xs font-semibold text-gray-100 font-mono break-all">${esc(it.label || `#${it.id}`)}</span> <span class="text-[10px] text-gray-500">#${it.id}</span> ${stopping}
            </div>
            <div class="text-[11px] text-gray-400">${summary(it)}</div>
            <div class="text-[10px] text-gray-500">started ${clock(it.started_at)} · ${since(it.started_at)}${it.harness_pid ? ` · harness pid ${it.harness_pid}${alive === false ? ' <span class="text-red-300">(not running)</span>' : ''}` : ''}${oc.tasks_n ? ` · ${oc.tasks_n} tasks` : ''}</div>
            ${it.notes ? `<div class="text-[10px] text-gray-400 whitespace-pre-wrap">${esc(it.notes)}</div>` : ''}
            ${estHtml(it)}${metaHost(it)}
            <div class="flex flex-wrap gap-1 pt-1">
                ${it.kind === 'run' || it.kind === 'stage' ? `<button type="button" class="${BTN}" data-live>Live →</button>` : ''}
                ${it.result_dir ? `<button type="button" class="${BTN}" data-open-run="${esc(it.result_dir.split('/').pop())}">battery →</button>` : ''}
                <button type="button" class="${BTN}" data-ctl="stop-after-task" data-id="${it.id}" title="finish the current task, then end this item; the lane moves on">stop after task</button>
                <button type="button" class="${DANGER}" data-ctl="stop-now" data-id="${it.id}" title="kill the task in flight (recorded ABORTED) and end this item">stop now</button>
                ${it.control ? `<button type="button" class="${BTN}" data-ctl="clear" data-id="${it.id}">clear stop</button>` : ''}
                <button type="button" class="${BTN}" data-toggle="${it.id}">${st.open.has(it.id) ? 'less' : 'details'}</button>
            </div>
            ${st.open.has(it.id) ? detailHtml(it) : ''}
        </div>`;
    }
    function pendingHtml(it, i) {
        const held = it.status === 'paused';
        return `<div class="qv-row" draggable="true" data-item="${it.id}" data-lane-of="${esc(it.lane)}" data-key="qv-item-${it.id}">
            <span class="qv-handle" title="drag to reorder">⋮⋮<div class="text-[10px] text-gray-600">${i + 1}</div></span>
            <div class="min-w-0">
                <div class="flex flex-wrap items-center gap-1">
                    ${held ? `<span class="${STATUS_CLS('paused')}" title="held: the lane passes it by">held</span>` : ''}
                    <span class="qv-chip qv-k-${esc(it.kind)}">${esc(it.kind)}</span>
                    <span class="text-[11px] text-gray-200 font-mono break-all">${esc(it.label || `#${it.id}`)}</span><span class="text-[10px] text-gray-600">#${it.id}${it.created_by ? ` · ${esc(it.created_by)}` : ''}</span></div>
                <div class="text-[11px] text-gray-400 leading-snug">${summary(it)}</div>
                ${it.notes ? `<div class="text-[10px] text-gray-500 whitespace-pre-wrap">${esc(it.notes)}</div>` : ''}
                ${st.open.has(it.id) ? detailHtml(it) : ''}
            </div>
            <div class="qv-more">${estHtml(it)}${metaHost(it)}</div>
            <div class="qv-acts">
                <button type="button" class="${BTN}" data-move="up" data-id="${it.id}" title="earlier">↑</button>
                <button type="button" class="${BTN}" data-move="down" data-id="${it.id}" title="later">↓</button>
                <button type="button" class="${BTN}" data-toggle="${it.id}" title="details and what it would run now">${st.open.has(it.id) ? '▴' : '▾'}</button>
                <button type="button" class="${BTN}" data-edit="${it.id}">edit</button>
                <button type="button" class="${BTN}" data-dup="${it.id}" title="insert a copy right after it">dup</button>
                <button type="button" class="${BTN}" data-status="${held ? 'release' : 'hold'}" data-id="${it.id}" title="${held ? 'back to pending' : 'hold: keep its place, the lane skips it'}">${held ? 'release' : 'hold'}</button>
                <button type="button" class="${BTN}" data-status="skip" data-id="${it.id}" title="drop it (kept in history as skipped)">skip</button>
                <button type="button" class="${BTN}" data-status="cancel" data-id="${it.id}" title="cancel it (kept in history)">✕</button>
            </div>
        </div>`;
    }
    function detailHtml(it) {
        const pv = st.previews[it.id];
        const rows = [];
        const kv = (k, v) => rows.push(`<div><span class="text-gray-500">${esc(k)}</span> <span class="font-mono text-gray-300 break-all">${v}</span></div>`);
        if (it.runner) kv('runner', esc(it.runner === 'pi' ? harnessLabel('pi', (it.env || {}).CODEBENCH_PI_EXT || 'none') : it.runner));
        if (it.launch_cmd) kv('launch_cmd', esc(it.launch_cmd));
        if (pv && pv.expanded && pv.expanded !== it.launch_cmd) kv('expands to', esc(pv.expanded));
        if (it.env) kv('env', esc(Object.entries(it.env).map(([k, v]) => `${k}=${v}`).join(' ')));
        if (it.task_source) kv('task_source', esc(JSON.stringify(it.task_source)));
        if (it.approved) kv('approved', esc(it.approved.join(' ')));
        if (it.tasks) kv('tasks', esc(it.tasks.join(' ')));
        if (it.resolved_tasks) kv('resolved', esc(it.resolved_tasks.join(' ')));
        if (it.wait) kv('wait', esc(JSON.stringify(it.wait)));
        if (it.shell_cmd) kv('shell', esc(it.shell_cmd));
        kv('sandbox', esc(it.sandbox || `/tmp/codebench-${it.label || ''}`));
        if (it.timeout_s) kv('cap', esc(fmtDur(it.timeout_s)));
        if (it.log_path) kv('logs', esc(it.log_path));
        if (it.result_dir) kv('results', esc(it.result_dir));
        if (it.status === 'pending' || it.status === 'paused') {
            if (!pv) rows.push('<div class="text-gray-500">resolving…</div>');
            else if (pv.error) rows.push(`<div class="text-red-300">${esc(pv.error)}</div>`);
            else if (it.kind === 'run' || it.kind === 'stage') rows.push(`<div><span class="text-gray-500">would run now</span> <span class="text-gray-200">${pv.tasks.length}</span>${pv.input ? ` <span class="text-gray-500">of ${pv.input.length} in its input</span>` : ''}: <span class="font-mono text-gray-300 break-all">${esc(pv.tasks.join(' ')) || '—'}</span>${it.kind === 'stage' ? ' <span class="text-gray-600">(re-resolved from the DB when it starts)</span>' : ''}</div>`);
        }
        return `<div class="text-[10px] space-y-0.5 mt-1 border-t border-gray-800 pt-1">${rows.join('')}</div>`;
    }
    function historyHtml() {
        const h = st.data.history || [];
        if (!h.length) return '<div class="text-[11px] text-gray-600">no finished items yet</div>';
        return h.map((it) => {
            const oc = it.outcome || {};
            const reason = oc.reason || oc.error || (oc.stopped ? `stopped: ${oc.stopped}` : '');
            return `<div class="qv-row" style="grid-template-columns:minmax(0,1fr) auto">
                <div class="min-w-0">
                    <div class="flex flex-wrap items-center gap-1"><span class="${STATUS_CLS(it.status)}">${esc(it.status)}</span><span class="qv-chip qv-k-${esc(it.kind)}">${esc(it.kind)}</span>
                        <span class="text-[11px] text-gray-200 font-mono break-all">${esc(it.label || `#${it.id}`)}</span><span class="text-[10px] text-gray-600">#${it.id} · ${esc(it.lane)}</span></div>
                    <div class="text-[11px] text-gray-400">${summary(it)}</div>
                    <div class="flex flex-wrap items-center gap-1 mt-0.5">${it.kind === 'run' || it.kind === 'stage' ? countChips(oc.counts) : ''}
                        ${oc.server_died ? '<span class="qv-chip qv-failed">server died</span>' : ''}
                        ${oc.failed_set ? `<span class="text-[10px] text-gray-500">→ ${oc.failed_set.length} to the next stage</span>` : ''}
                        <span class="text-[10px] text-gray-500">${clock(it.finished_at)}${it.started_at ? ` · took ${since(it.started_at, it.finished_at)}` : ''}</span></div>
                    ${reason ? `<div class="text-[10px] ${it.status === 'failed' || it.status === 'interrupted' ? 'text-red-300' : 'text-gray-500'} break-all">${esc(reason)}</div>` : ''}
                    ${st.open.has(it.id) ? detailHtml(it) : ''}
                </div>
                <div class="qv-acts">
                    ${it.result_dir && (it.outcome || {}).counts && Object.keys(it.outcome.counts).length ? `<button type="button" class="${BTN}" data-open-run="${esc(it.result_dir.split('/').pop())}">results →</button>` : ''}
                    <button type="button" class="${BTN}" data-toggle="${it.id}">${st.open.has(it.id) ? '▴' : '▾'}</button>
                    <button type="button" class="${BTN}" data-again="${it.id}" title="queue a copy at the TOP of ${esc(it.lane)}: it runs next, ahead of every waiting item">again ↑</button>
                </div></div>`;
        }).join('');
    }
    function renderStatus() {
        const el = root.querySelector('[data-qv-status]');
        // where the last "again" went, for a few seconds: its lane is usually closed, so the copy is not in sight
        const fl = st.flash && st.flash.until > Date.now() ? `<span class="qv-ok">${esc(st.flash.text)}</span> · ` : '';
        if (el) el.innerHTML = st.err ? `<span class="text-red-300">${esc(st.err)}</span>` : `${fl}updated ${new Date().toLocaleTimeString()}`;
    }
    function render() {
        st.renderedAt = Date.now();
        if (!st.data) { setHtml(root, `<div class="text-xs ${st.err ? 'text-red-300' : 'text-gray-500'}">${esc(st.err || 'loading the queue…')}</div>`); return; }
        const lanes = st.data.laneNames || ['local-gpu', 'cloud'];
        // Lanes in use first. A parked lane (/api/queue lanes[].parked: paused with no live runner, or set up for
        // cards this machine does not have) is folded into one line below them, with how many items wait on it --
        // unless something is RUNNING on it, which is shown with the rest. An older server sends no `parked`:
        // nothing is folded.
        const busyLanes = new Set((st.data.running || []).map((i) => i.lane));
        const isParked = (n) => { const L = (st.data.lanes || []).find((x) => x.lane === n); return !!(L && L.parked) && !busyLanes.has(n); };
        const parked = lanes.filter(isParked);
        const waiting = (n) => (st.data.pending || []).filter((i) => i.lane === n).length;
        const typing = metaFocus();
        setHtml(root, `
            <div class="flex flex-wrap items-center justify-between gap-2">
                <span class="${H}">Queue <span class="normal-case font-normal text-gray-500">— rows in bench.sqlite, run by codebench/tools/queue_runner.py (one runner per lane)</span></span>
                <span class="flex flex-wrap items-center gap-2"><span class="text-[10px] text-gray-500" data-qv-status></span><button type="button" class="${BTN}" data-reload>reload</button></span>
            </div>
            ${st.err ? `<div class="text-[11px] text-red-300">${esc(st.err)}</div>` : ''}
            ${st.data.est_error ? `<div class="text-[11px] text-yellow-300">no estimates: ${esc(st.data.est_error)}</div>` : ''}
            <div data-qv-form></div>
            ${lanes.filter((n) => !isParked(n)).map(laneHtml).join('')}
            ${parked.length ? `<details data-key="qv-parked" data-qv-parked class="${CARD}"><summary class="${H}">▸ ${parked.length} parked lane${parked.length === 1 ? '' : 's'} <span class="normal-case font-normal text-gray-500">— ${esc(parked.map((n) => (waiting(n) ? `${n} (${waiting(n)} waiting)` : n)).join(', '))}: paused with no runner, or set up for a card that is not in this machine${st.data.machine ? ` (${esc(st.data.machine)})` : ''}</span></summary><div class="mt-1 space-y-1">${parked.map(laneHtml).join('')}</div></details>` : ''}
            <details data-key="qv-history" open class="${CARD}"><summary class="${H}">▸ recent history <span class="normal-case font-normal text-gray-500">— “again ↑” queues a copy at the top of its lane</span></summary><div class="qv-scroll overflow-y-auto" data-key="qv-history-box">${historyHtml()}</div></details>`);
        attachMeta();
        restoreMetaFocus(typing);
        renderStatus();
        wire();
    }

    // ---------------------------------------------------------------- the edit / insert form
    function envText(env) { return Object.entries(env || {}).map(([k, v]) => `${k}=${v}`).join('\n'); }
    function parseEnvText(t) {
        const o = {};
        for (const line of String(t || '').split('\n')) { const m = /^\s*([A-Za-z_]\w*)\s*=\s*(.*?)\s*$/.exec(line); if (m) o[m[1]] = m[2]; }
        return o;
    }
    function presetOptions(lane) {
        const ps = (st.presets && st.presets.presets) || [];
        return ['<option value="">— preset —</option>', ...ps.filter((p) => !lane || p.lane === lane || (lane === 'cloud' === (p.lane === 'cloud')))
            .map((p) => `<option value="${esc(p.id)}">${esc(p.label)}${p.source === 'profiles.json' ? ' (profile)' : ''}${p.weightsOk === false ? ' ⚠ weights missing' : ''}</option>`)].join('');
    }
    function expand(cmd) {
        const vars = (st.presets && st.presets.vars) || {};
        return String(cmd || '').replace(/\$\{?([A-Za-z_]\w*)\}?/g, (a, k) => (k in vars ? vars[k] : a));
    }
    function formHtml(f) {
        const it = f.item; const isNew = !f.id;
        const kind = it.kind || 'run';
        const src = it.task_source;
        const casc = src && src.from === 'cascade' ? src : null;
        const inputOf = (s) => (!s ? '' : s.item != null ? `#${s.item}` : s.file ? s.file : s.tasks ? s.tasks.join(' ') : JSON.stringify(s));
        const lanes = (st.data && st.data.laneNames) || ['local-gpu', 'cloud'];
        const w = it.wait || {};
        const field = (label, html, wide) => `<label class="block ${wide ? 'qv-wide' : ''}"><span class="${H}">${label}</span>${html}</label>`;
        return `<div class="${CARD} space-y-2 border-indigo-500">
            <div class="flex flex-wrap items-center justify-between gap-2"><span class="text-xs font-semibold text-gray-200">${isNew ? 'New queue item' : `Edit #${f.id}`}</span>
                ${isNew ? `<span class="flex flex-wrap items-center gap-1 text-[11px] text-gray-400">insert <select class="${INPUT}" style="width:auto" data-f="where">
                    <option value="end">at the end of the lane</option><option value="top">at the top (runs next)</option></select></span>` : ''}</div>
            <div class="qv-form">
                ${field('lane', `<select class="${INPUT}" data-f="lane">${lanes.map((l) => `<option ${l === it.lane ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`)}
                ${field('kind', `<select class="${INPUT}" data-f="kind">${['run', 'stage', 'wait', 'shell'].map((k) => `<option ${k === kind ? 'selected' : ''}>${k}</option>`).join('')}</select>`)}
                ${kind === 'run' || kind === 'stage' ? `
                    ${field('model preset (fills runner, model, launch command, env)', `<select class="${INPUT}" data-f="preset">${presetOptions(it.lane)}</select>`, true)}
                    ${field('label (results/&lt;label&gt;)', `<input class="${INPUT}" data-f="label" value="${esc(it.label || '')}" placeholder="e.g. q6-deltacursor-128k-mtp">`)}
                    ${field('runner', `<select class="${INPUT}" data-f="runner">${['opencode', 'pi', 'claude'].map((r) => `<option ${r === (it.runner || (it.lane === 'cloud' ? 'claude' : 'opencode')) ? 'selected' : ''}>${r}</option>`).join('')}</select>`)}
                    ${field('model (harness --model; opencode / pi ids get llama-local/)', `<input class="${INPUT}" data-f="model" value="${esc(it.model || '')}">`)}
                    ${field('timeout per task (s)', `<input class="${INPUT}" data-f="timeout_s" inputmode="numeric" value="${esc(it.timeout_s ?? 7200)}">`)}
                    ${field('launch command (no --port; $STOCK $D27MTP $Q4 $Q6 $FLASH_*_CMD allowed)', `<textarea rows="2" class="${INPUT}" data-f="launch_cmd">${esc(it.launch_cmd || '')}</textarea><div class="text-[10px] text-gray-500 font-mono break-all mt-0.5" data-f-expanded>${esc(expand(it.launch_cmd))}</div>`, true)}
                    ${field('env (KEY=value per line; claude items need CODEBENCH_CLAUDE_EFFORT and _SCAFFOLD; pi + SoL-Pi: CODEBENCH_PI_EXT=sol-pi)', `<textarea rows="2" class="${INPUT}" data-f="env">${esc(envText(it.env))}</textarea>`, true)}
                    ${kind === 'run' ? field('tasks (space / newline separated)', `<textarea rows="3" class="${INPUT}" data-f="tasks">${esc((it.tasks || []).join('\n'))}</textarea>`, true) : `
                        ${field('stage input: #item (its failures), a set file path, or task ids', `<input class="${INPUT}" data-f="c_input" value="${esc(inputOf(casc && casc.input))}" placeholder="#12">`)}
                        ${field('model_like (bench.sqlite runs.model_path LIKE)', `<input class="${INPUT}" data-f="c_like" value="${esc((casc && casc.model_like) || '')}" placeholder="%Swift-Qwen3.8-27B%">`)}
                        ${field('n_ctx', `<input class="${INPUT}" data-f="c_nctx" inputmode="numeric" value="${esc((casc && casc.n_ctx) || '')}">`)}
                        ${field('exclude result_path LIKE (optional)', `<input class="${INPUT}" data-f="c_excl" value="${esc((casc && casc.exclude_like) || '')}" placeholder="%nothink%">`)}
                        ${field('approved (optional allow-list)', `<textarea rows="2" class="${INPUT}" data-f="approved">${esc((it.approved || []).join(' '))}</textarea>`, true)}`}
                    ${field('record requests (record-proxy --out)', `<span class="block"><input type="checkbox" data-f="record" ${it.record ? 'checked' : ''}></span>`)}` : ''}
                ${kind === 'wait' ? `
                    ${field('wait for pid', `<input class="${INPUT}" data-f="w_pid" inputmode="numeric" value="${esc(w.pid || '')}">`)}
                    ${field('…or for a regex in a log file', `<input class="${INPUT}" data-f="w_log" value="${esc(w.log || '')}" placeholder="/path/queue17.log">`)}
                    ${field('regex', `<input class="${INPUT}" data-f="w_pat" value="${esc(w.pattern || '')}" placeholder="QUEUE17 DONE">`)}
                    ${field('…or seconds', `<input class="${INPUT}" data-f="w_sec" inputmode="numeric" value="${esc(w.seconds || '')}">`)}
                    ${field('label', `<input class="${INPUT}" data-f="label" value="${esc(it.label || '')}">`)}` : ''}
                ${kind === 'shell' ? `
                    ${field('bash (the lane env files are sourced first; runs in ~/code/codebench)', `<textarea rows="3" class="${INPUT}" data-f="shell_cmd">${esc(it.shell_cmd || '')}</textarea>`, true)}
                    ${field('label', `<input class="${INPUT}" data-f="label" value="${esc(it.label || '')}">`)}
                    ${field('timeout (s, empty = none)', `<input class="${INPUT}" data-f="timeout_s" inputmode="numeric" value="${esc(it.timeout_s ?? '')}">`)}` : ''}
                ${field('notes', `<textarea rows="2" class="${INPUT}" data-f="notes">${esc(it.notes || '')}</textarea>`, true)}
            </div>
            ${f.error ? `<div class="text-[11px] text-red-300">${esc(f.error)}</div>` : ''}
            <div class="flex flex-wrap gap-2"><button type="button" class="${PRIMARY}" data-f-save>${isNew ? 'Insert' : 'Save'}</button><button type="button" class="${BTN}" data-f-cancel>cancel</button></div>
        </div>`;
    }
    function readForm() {
        const el = root.querySelector('[data-qv-form]');
        const v = (k) => { const x = el.querySelector(`[data-f="${k}"]`); return x ? (x.type === 'checkbox' ? x.checked : x.value) : undefined; };
        const it = { ...st.edit.item };
        it.lane = v('lane'); it.kind = v('kind');
        if (v('notes') !== undefined) it.notes = v('notes');
        if (v('label') !== undefined) it.label = v('label').trim();
        if (it.kind === 'run' || it.kind === 'stage') {
            it.runner = v('runner'); it.model = v('model').trim(); it.launch_cmd = v('launch_cmd').trim(); it.env = parseEnvText(v('env'));
            it.timeout_s = v('timeout_s'); it.record = v('record');
            if (it.kind === 'run') it.tasks = v('tasks').split(/[\s,]+/).filter(Boolean);
            else {
                const inp = (v('c_input') || '').trim();
                const input = /^#?\d+$/.test(inp) ? { item: Number(inp.replace('#', '')) } : inp.startsWith('/') ? { file: inp } : { tasks: inp.split(/[\s,]+/).filter(Boolean) };
                it.task_source = { from: 'cascade', input, model_like: v('c_like').trim(), n_ctx: Number(v('c_nctx')) || 0, ...(v('c_excl').trim() ? { exclude_like: v('c_excl').trim() } : {}) };
                const ap = v('approved').split(/[\s,]+/).filter(Boolean); it.approved = ap.length ? ap : null;
            }
        } else if (it.kind === 'wait') {
            it.wait = v('w_pid') ? { pid: Number(v('w_pid')) } : v('w_log') ? { log: v('w_log').trim(), pattern: v('w_pat') || 'DONE' } : v('w_sec') ? { seconds: Number(v('w_sec')) } : null;
        } else if (it.kind === 'shell') { it.shell_cmd = v('shell_cmd'); it.timeout_s = v('timeout_s'); }
        return it;
    }
    function renderForm() {
        const el = root.querySelector('[data-qv-form]'); if (!el) return;
        if (!st.edit) { el.innerHTML = ''; return; }
        el.innerHTML = formHtml(st.edit);
        const q = (s) => el.querySelector(s);
        q('[data-f="kind"]')?.addEventListener('change', () => { st.edit.item = readForm(); renderForm(); });
        q('[data-f="lane"]')?.addEventListener('change', () => { st.edit.item = readForm(); renderForm(); });
        q('[data-f="launch_cmd"]')?.addEventListener('input', (e) => { const x = q('[data-f-expanded]'); if (x) x.textContent = expand(e.target.value); });
        q('[data-f="preset"]')?.addEventListener('change', (e) => {
            const p = ((st.presets && st.presets.presets) || []).find((x) => x.id === e.target.value); if (!p) return;
            const it = readForm();
            const keepLane = it.lane && (it.lane === 'cloud') === (p.lane === 'cloud');
            Object.assign(it, { runner: p.runner, model: p.model || it.model, launch_cmd: p.launch_cmd || '', env: p.env || {}, lane: keepLane ? it.lane : p.lane });
            if (!it.label) it.label = `${p.id.replace(/^profile:bench(-| · )/, '')}-${new Date().toISOString().slice(5, 16).replace(/[-T:]/g, '')}`.replace(/[^\w.-]/g, '-');
            if (it.kind === 'stage') it.task_source = { ...(it.task_source || { from: 'cascade', input: null }), from: 'cascade', model_like: p.dbLike || '', n_ctx: p.nCtx || 0, ...(p.dbExcludeLike ? { exclude_like: p.dbExcludeLike } : {}) };
            st.edit.item = it; renderForm();
        });
        q('[data-f-cancel]').addEventListener('click', () => { st.edit = null; render(); });
        q('[data-f-save]').addEventListener('click', async () => {
            const it = readForm(); st.edit.item = it;
            const fields = {};
            for (const k of ['lane', 'kind', 'label', 'runner', 'model', 'launch_cmd', 'env', 'tasks', 'task_source', 'approved', 'wait', 'shell_cmd', 'timeout_s', 'record', 'notes']) if (it[k] !== undefined) fields[k] = it[k];
            let r;
            if (st.edit.id) r = await post('/api/queue/item/update', { id: st.edit.id, fields });
            else {
                const where = (root.querySelector('[data-f="where"]') || {}).value;
                const first = st.data.pending.find((x) => x.lane === it.lane);
                r = await post('/api/queue/items', { item: fields, ...(where === 'top' && first ? { before: first.id } : {}) });
            }
            if (r.error) { st.edit.error = r.error; renderForm(); return; }
            st.edit = null; await refresh(true);
        });
    }
    async function openForm(id, lane) {
        await loadPresets();
        if (id) { const it = [...st.data.pending, ...st.data.running, ...st.data.history].find((x) => x.id === id); st.edit = { id, item: { ...it } }; }
        else st.edit = { id: null, item: { lane: lane || 'local-gpu', kind: 'run', runner: lane === 'cloud' ? 'claude' : 'opencode', timeout_s: 7200, record: 1 } };   // record: lib/queue.js insert()
        render(); renderForm();
        root.querySelector('[data-qv-form]')?.scrollIntoView({ block: 'nearest' });
    }

    // ---------------------------------------------------------------- wiring
    function wire() {
        const on = (sel, fn) => root.querySelectorAll(sel).forEach((b) => b.addEventListener('click', (e) => { e.preventDefault(); fn(b); }));
        on('[data-reload]', () => refresh(true));
        on('[data-lane-toggle]', (b) => toggleLane(b.dataset.laneToggle));
        // Pause sends an empty note (2026-10-26): the API keeps the lane's old note when none is sent, and the header now
        // shows the note as the reason -- a pause from here would have read as the reason of an earlier one.
        on('[data-lane-pause]', (b) => act('/api/queue/lane', { lane: b.dataset.lanePause, paused: true, note: '' }));
        on('[data-lane-resume]', (b) => {
            const lane = b.dataset.laneResume; const L = laneRow(lane) || {};
            const why = L.paused_by || L.note ? `\n\nPaused${L.paused_by ? ` by ${L.paused_by}` : ''}${L.paused_at ? ` ${clock(L.paused_at)}` : ''}${L.note ? `: ${L.note}` : ''}` : '';
            act('/api/queue/lane', { lane, paused: false }, `Resume lane ${lane}? The runner will start its next pending item.${why}`);
        });
        on('[data-new]', (b) => openForm(null, b.dataset.new));
        on('[data-edit]', (b) => openForm(Number(b.dataset.edit)));
        on('[data-move]', (b) => act('/api/queue/item/move', { id: Number(b.dataset.id), dir: b.dataset.move }));
        on('[data-dup]', (b) => act('/api/queue/item/duplicate', { id: Number(b.dataset.dup) }));   // a waiting item: the copy right after it
        // a finished item: the copy at the TOP of its lane (2026-10-26, Kyle: re-queued items had landed at the bottom)
        on('[data-again]', async (b) => {
            const r = await act('/api/queue/item/duplicate', { id: Number(b.dataset.again), position: 'top' });
            if (r && r.item) { st.flash = { text: `#${r.item.id} queued at the top of ${r.item.lane}`, until: Date.now() + 15000 }; renderStatus(); }
        });
        on('[data-status]', (b) => act('/api/queue/item/status', { id: Number(b.dataset.id), action: b.dataset.status }, b.dataset.status === 'cancel' ? 'Cancel this item? (It stays in history.)' : null));
        on('[data-ctl]', (b) => act('/api/queue/item/control', { id: Number(b.dataset.id), action: b.dataset.ctl },
            b.dataset.ctl === 'stop-now' ? 'Stop NOW? The task in flight is killed and recorded ABORTED; the lane then moves on.' : null));
        on('[data-live]', () => onOpenLive && onOpenLive());
        on('[data-open-run]', (b) => onOpenRun && onOpenRun(b.dataset.openRun));
        on('[data-toggle]', async (b) => {
            const id = Number(b.dataset.toggle);
            if (st.open.has(id)) st.open.delete(id); else {
                st.open.add(id);
                const it = [...st.data.pending, ...st.data.running, ...st.data.history].find((x) => x.id === id);
                if (it && !st.previews[id]) api(`/api/queue/preview?id=${id}`).then((p) => { st.previews[id] = p; if (!st.edit) render(); });
            }
            render();
        });
        // drag to reorder (desktop; touch uses the arrows)
        let dragId = null;
        root.querySelectorAll('.qv-row[draggable]').forEach((row) => {
            row.addEventListener('dragstart', (e) => { dragId = Number(row.dataset.item); row.classList.add('qv-drag'); try { e.dataTransfer.setData('text/plain', String(dragId)); e.dataTransfer.effectAllowed = 'move'; } catch { /* old browsers */ } });
            row.addEventListener('dragend', () => row.classList.remove('qv-drag'));
            row.addEventListener('dragover', (e) => { if (dragId != null && row.dataset.laneOf === (root.querySelector(`[data-item="${dragId}"]`) || {}).dataset?.laneOf) { e.preventDefault(); row.classList.add('qv-over'); } });
            row.addEventListener('dragleave', () => row.classList.remove('qv-over'));
            row.addEventListener('drop', (e) => {
                e.preventDefault(); row.classList.remove('qv-over');
                const lane = row.dataset.laneOf; const target = Number(row.dataset.item);
                if (dragId == null || dragId === target) return;
                const ids = st.data.pending.filter((x) => x.lane === lane).map((x) => x.id).filter((x) => x !== dragId);
                ids.splice(ids.indexOf(target), 0, dragId);
                dragId = null;
                act('/api/queue/reorder', { lane, ids });
            });
        });
        if (st.edit) renderForm();
    }

    return {
        async load() { st.visible = true; await refresh(true); if (!st.timer) st.timer = pollEvery(() => (st.visible ? refresh() : null), 5000); },
        hide() { st.visible = false; },
        refresh,
    };
}
