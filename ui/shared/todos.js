// The agent's todo list, drawn as a checklist instead of raw JSON arguments. One helper for both the
// live chat (ui/livechat/index.js) and the saved-transcript view (ui/benchmarks/transcript.js).
//
// Shapes it understands (each call carries the WHOLE list, not a diff):
//   opencode  todowrite  {"todos":[{"content","status":"pending|in_progress|completed|cancelled","priority":"high|medium|low","id"}]}
//   Claude    TodoWrite  {"todos":[{"content","status","activeForm"}]}
//   codex     update_plan {"plan":[{"step","status"}]}
//   pi+SoL-Pi update_plan {"steps":[{"id","goal","status":"pending|in_progress|completed"}],"progress"?:{files_changed,verification,decisions}}
// Anything else -- another tool, arguments still streaming (partial JSON), a list with no usable
// item -- returns null, and the caller keeps its generic tool-call card.

const TODO_TOOL = /^(todowrite|todo_write|update_plan)$/i;
const STATUS = {
    pending: 'pending', todo: 'pending', not_started: 'pending',
    in_progress: 'in_progress', 'in-progress': 'in_progress', active: 'in_progress', doing: 'in_progress',
    completed: 'completed', complete: 'completed', done: 'completed',
    cancelled: 'cancelled', canceled: 'cancelled', skipped: 'cancelled',
};
const escH = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const isTodoTool = (name) => TODO_TOOL.test(String(name || ''));

/** name + arguments (JSON text or an object) -> {items:[{content, status, priority, active}], done, total, current} | null */
export function parseTodos(name, args) {
    if (!isTodoTool(name)) return null;
    let o = args;
    if (typeof o === 'string') { try { o = JSON.parse(o); } catch { return null; } }
    if (!o || typeof o !== 'object') return null;
    const list = Array.isArray(o.todos) ? o.todos : (Array.isArray(o.plan) ? o.plan : (Array.isArray(o.steps) ? o.steps : null));
    if (!list) return null;
    const items = [];
    for (const t of list) {
        if (!t || typeof t !== 'object') continue;
        const content = t.content ?? t.step ?? t.goal ?? t.title ?? t.text;
        if (typeof content !== 'string' || !content.trim()) continue;
        items.push({
            content: content.trim(),
            status: STATUS[String(t.status || 'pending').toLowerCase()] || 'pending',
            priority: typeof t.priority === 'string' && t.priority ? t.priority.toLowerCase() : null,
            active: typeof t.activeForm === 'string' && t.activeForm.trim() ? t.activeForm.trim() : null,
        });
    }
    if (!items.length && list.length) return null;   // an array, but nothing in it we can read
    const done = items.filter((i) => i.status === 'completed').length;
    const current = items.find((i) => i.status === 'in_progress') || null;
    return { items, done, total: items.filter((i) => i.status !== 'cancelled').length, current };
}

export const todoProgressText = (td) => `${td.done}/${td.total} done`;

const MARK = {
    pending: ['☐', 'text-gray-500', 'pending'],
    in_progress: ['▶', 'text-indigo-300 animate-pulse', 'in progress'],
    completed: ['☑', 'text-green-400', 'completed'],
    cancelled: ['✗', 'text-gray-600', 'cancelled'],
};
const PRIO = { high: 'text-red-300', medium: 'text-amber-300', low: 'text-gray-500' };

/** The checklist card's HTML (a whole card: header with the tool name and progress, then one row per item). */
export function renderTodosHtml(td, opts) {
    const o = opts || {};
    const rows = td.items.map((it) => {
        const [ch, cls, word] = MARK[it.status];
        const text = it.status === 'in_progress' && it.active ? it.active : it.content;
        const textCls = it.status === 'in_progress' ? 'text-gray-100 font-semibold'
            : it.status === 'completed' ? 'text-gray-300' : it.status === 'cancelled' ? 'text-gray-600' : 'text-gray-300';
        // completed: italic + a slight fade, still readable (Kyle, 2026-09-29: strike + grey was too hard to read);
        // cancelled keeps the strike -- it means "dropped", not "done"
        const strike = it.status === 'completed' ? ' style="font-style:italic;opacity:.7"'
            : it.status === 'cancelled' ? ' style="text-decoration:line-through"' : '';
        return `<li data-todo-status="${it.status}" class="flex items-baseline gap-1.5 px-1 rounded${it.status === 'in_progress' ? ' bg-indigo-600/20' : ''}" title="${escH(word)}${it.priority ? ` · ${escH(it.priority)} priority` : ''}">`
            + `<span class="shrink-0 ${cls}">${ch}</span>`
            + `<span class="min-w-0 break-words ${textCls}"${strike}>${escH(text)}</span>`
            + (it.priority ? `<span class="ml-auto shrink-0 text-[10px] ${PRIO[it.priority] || 'text-gray-500'}">${escH(it.priority)}</span>` : '')
            + '</li>';
    }).join('');
    return `<div data-todos class="${o.cls || 'mt-1 rounded-md border border-indigo-900/60 bg-gray-950 text-xs min-w-0'}">`
        + `<div class="flex items-baseline gap-2 px-2 py-1 border-b border-gray-800"><span class="font-mono font-semibold text-indigo-300 shrink-0">☰ ${escH(o.name || 'todos')}</span>`
        + `<span class="text-[10px] text-gray-400">plan · ${todoProgressText(td)}${td.items.length > td.total ? ` · ${td.items.length - td.total} cancelled` : ''}</span></div>`
        + `<ul class="px-1 py-1 space-y-0.5">${rows || '<li class="px-1 text-gray-500">(empty list)</li>'}</ul></div>`;
}
