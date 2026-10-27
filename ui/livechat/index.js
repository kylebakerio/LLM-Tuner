// Live chat: the running benchmark's conversation as a chat, token by token -- mounted in place of
// the "last text" box of Bench -> quality -> Live (ui/benchmarks/live.js) when its toggle says so.
// Source: GET /api/livechat (SSE, lib/livechat.js), which relays codebench's proxy tap
// (tools/record-proxy.js --tap) -- the agent's requests and the model's streamed reply.
// Every frame goes through the shared reducer (ui/livechat/model.js, loaded as a classic script
// before any module: window.LiveChatModel), then the DOM is updated in place:
//   - 'reset' (a new request): the message list is reconciled by absolute index, so nodes whose
//     message did not change keep their DOM (and whatever the user expanded);
//   - 'delta': text is appended to the live message as new Text nodes (no re-render per token).
// The stream is open only while mounted: unmount() closes it, and the server drops its tap
// connection 30 s after the last viewer leaves, so toggling back reconnects instantly from its snapshot.
// The host re-renders its HTML every second, so the chat lives in its own element that the host
// moves back in with detach()/attach() -- which keep the scroll positions a DOM move would reset.
import { parseTodos, renderTodosHtml, todoProgressText } from '../shared/todos.js';
import { harnessLabel, stripSplitIn, createOpenChoices, ARGS_INLINE_MAX } from '../benchmarks/util.js';

const M = window.LiveChatModel;

const RESULT_PREVIEW_CHARS = 700;
const RESULT_PREVIEW_LINES = 10;
// What the reader opened or closed -- thinking, arguments, a system prompt, a result's "show all" -- kept OUTSIDE the
// nodes (ui/benchmarks/util.js createOpenChoices: read its rule before changing how a block is drawn). A message's node
// is built again whenever the message changes (renderAll: the streaming answer becomes message n when the agent sends
// its next request, a few seconds after it ends), and a new node starts from the defaults: that is how an expanded
// thinking block "self-collapsed" (measured 2026-10-22: four times in two minutes on a busy lane). Module-level, so the
// choices also outlive this component being unmounted and mounted again (the box's mode toggle, Live switching the box
// to the transcript view and back). Keys: the battery + thread + the message's place in the CONVERSATION (absolute:
// message n stays message n for the life of the thread, and the streaming answer is told its n when the request is
// sent), a tool call by its id. Never the node map, the list position or anything the DOM says after a rebuild.
const CHOICES = createOpenChoices();

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null && text !== '') e.textContent = text;
    return e;
}
const fmtN = (n) => (n == null ? '—' : Number(n).toLocaleString());
function prettyArgs(s) {
    if (!s) return '';
    try { return JSON.stringify(JSON.parse(s), null, 2); } catch { return s; }   // still streaming: raw
}
// One line that says what a tool call does: the command, the path, the pattern.
function argSummary(name, args) {
    let o = null; try { o = JSON.parse(args || ''); } catch { /* partial */ }
    if (!o || typeof o !== 'object') return (args || '').slice(0, 120);
    const pick = o.command || o.cmd || o.filePath || o.file_path || o.path || o.pattern || o.query || o.url || o.description;
    if (typeof pick === 'string') return pick.split('\n')[0].slice(0, 160);
    return JSON.stringify(o).slice(0, 120);
}

// Auto-scroll that yields to the reader. `box` follows its bottom while `stick` holds; the reader
// pauses it and only the reader resumes it.
//
// Why not just "stick = near the bottom" in a scroll listener (the old code, with a 48 px band):
// scroll events arrive once per frame, AFTER the scroll, while tokens arrive many times per frame.
// A wheel notch (smooth-scrolled), a trackpad or touch drag, or a scrollbar nudge first moves a few
// px; the next token's follow() put scrollTop back at the bottom before the scroll event ever saw
// the move, and the event then read "at the bottom" and kept following. Every token won. The live
// thinking block was worse: it was scrolled to its bottom on every reasoning token unconditionally.
//
// So intent is read from the INPUT events, synchronously, before any token can run: a wheel up, a
// touch drag down, a press on the box's own scrollbar, or PageUp/Home/ArrowUp stops following at
// once, and nothing is scrolled while a finger or the mouse is down on it (a scroll during that hold
// away from the bottom pauses too). Otherwise the scroll listener only ever RESUMES, and only at the
// very bottom (2 px), so neither a token append nor our own scrollTop write can re-arm it. Events
// meant for a nested scroller that can still move that way (a tool output, the thinking block)
// are that scroller's own business. resume() is the "follow live" pill.
export function stickyScroll(box, onChange) {
    let stick = true, hold = false, touchY = null, lastInput = 0, lastWritten = 0, lastTop = 0;
    const INPUT_MS = 1500;   // a scroll this long after the reader's last input is still theirs (smooth wheel, touch momentum)
    const input = () => { lastInput = Date.now(); };
    const atBottom = () => box.scrollHeight - box.scrollTop - box.clientHeight <= 2;
    const set = (v) => { if (v === stick) return; stick = v; if (onChange) onChange(v); };
    // true when the event belongs to a scroller nested inside `box` that can still scroll up
    const innerTakesUp = (t) => {
        for (let e = t instanceof Element ? t : null; e && e !== box; e = e.parentElement) {
            if (e.scrollHeight > e.clientHeight + 1 && e.scrollTop > 0) {
                const oy = getComputedStyle(e).overflowY;
                if (oy === 'auto' || oy === 'scroll') return true;
            }
        }
        return false;
    };
    box.addEventListener('wheel', (e) => { input(); if (e.deltaY < 0 && !innerTakesUp(e.target)) set(false); }, { passive: true });
    box.addEventListener('touchstart', (e) => { input(); hold = true; touchY = e.touches.length ? e.touches[0].clientY : null; }, { passive: true });
    box.addEventListener('touchmove', (e) => {
        input();
        const y = e.touches.length ? e.touches[0].clientY : null;
        if (y != null && touchY != null && y > touchY + 2 && !innerTakesUp(e.target)) set(false);   // finger down = content up
        if (y != null) touchY = y;
    }, { passive: true });
    const release = () => { if (!hold) return; input(); hold = false; touchY = null; if (!stick && box.isConnected && atBottom() && box.scrollTop >= lastTop) set(true); };
    box.addEventListener('touchend', release, { passive: true });
    box.addEventListener('touchcancel', release, { passive: true });
    // the scrollbar belongs to the box itself: a press whose target is the box (not its content)
    const press = (e) => { if (e.target === box && e.button === 0 && e.pointerType !== 'touch') { input(); hold = true; window.addEventListener('pointerup', release, { once: true }); window.addEventListener('mouseup', release, { once: true }); } };
    box.addEventListener('pointerdown', press);
    box.addEventListener('mousedown', press);
    box.addEventListener('keydown', (e) => { input(); if (['PageUp', 'ArrowUp', 'Home'].includes(e.key) && !innerTakesUp(e.target)) set(false); });
    box.addEventListener('scroll', () => {
        if (!box.isConnected || !box.clientHeight) return;   // detached: every size reads 0
        const down = box.scrollTop > lastTop; lastTop = box.scrollTop;
        if (hold) { if (!atBottom()) set(false); return; }   // a scrollbar drag or a finger moved it: the release decides on resuming
        // Our writes only ever move to the bottom, and content shrinking clamps to the bottom too: a
        // position ABOVE what we last wrote, and not at the bottom, is the reader (a scrollbar press
        // no event reported, a keyboard scroll) -- stop following even without a matching input event.
        if (stick && box.scrollTop < lastWritten - 2 && !atBottom()) { set(false); return; }
        // resume only on the reader's own way back DOWN: content shrinking under a short scroll-up
        // (the thinking block folding, a new request re-rendering the list) also lands on the bottom,
        // but by clamping scrollTop lower, and that is not them
        if (!stick && down && atBottom() && Date.now() - lastInput < INPUT_MS) set(true);
    }, { passive: true });
    return {
        get stick() { return stick; },
        follow() { if (stick && !hold) { box.scrollTop = box.scrollHeight; lastWritten = box.scrollTop; } },
        resume() { set(true); box.scrollTop = box.scrollHeight; lastWritten = box.scrollTop; },
    };
}

// Builds the chat inside `view` (which needs a definite height: the message list scrolls inside it)
// and opens the stream. Returns {el, detach, attach(host), unmount}.
export function mountLiveChat(view, opts = {}) {
    let battery = opts.battery || null;   // which lane's tap: /api/livechat?battery=<dir> (2026-09-30)
    if (!M) { view.textContent = 'live chat unavailable: ui/livechat/model.js did not load'; return { el: view, detach() {}, attach(h) { h.appendChild(view); }, unmount() {} }; }
    view.innerHTML = `
        <div class="shrink-0 border-b border-gray-800 bg-gray-900/50 px-3 py-2 space-y-1">
            <div class="flex items-center gap-2 min-w-0">
                <span data-lc="pill" class="shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-gray-800 text-gray-500">off</span>
                <span data-lc="phase" class="text-[10px] text-gray-500 truncate"></span>
                <label class="ml-auto shrink-0 flex items-center gap-1 text-[10px] text-gray-500 cursor-pointer select-none" title="Show the model's reasoning expanded while it streams">
                    <input type="checkbox" data-lc="think" class="accent-indigo-500" checked> thinking
                </label>
            </div>
            <div data-lc="ctx" class="text-[11px] text-gray-400 truncate"></div>
            <div data-lc="plan" class="hidden text-[10px] text-indigo-300 truncate"></div>
            <div data-lc="side" class="hidden text-[10px] text-gray-500 truncate"></div>
        </div>
        <div class="relative flex-1 min-h-0 flex flex-col">
            <div data-lc="scroll" class="flex-1 min-h-0 overflow-y-auto px-3 py-3">
                <div data-lc="empty" class="text-xs text-gray-500 space-y-2"></div>
                <div data-lc="gap" class="hidden text-[10px] text-yellow-300 italic mb-2"></div>
                <div data-lc="list" class="space-y-3"></div>
            </div>
            <button type="button" data-lc="jump" class="hidden absolute px-3 py-1 rounded-full text-xs font-semibold bg-indigo-600 text-white shadow-sm" style="bottom:12px;left:50%;transform:translateX(-50%)">↓ follow live</button>
        </div>`;
    const $ = (k) => view.querySelector(`[data-lc="${k}"]`);
    const scroller = $('scroll'), list = $('list'), jump = $('jump'), thinkBox = $('think');

    let state = M.fresh();
    let es = null;
    let nodes = new Map();      // key -> {node, sig, live parts}
    let liveParts = null;       // DOM handles of the streaming message
    const choices = CHOICES;   // see CHOICES above
    choices.watch(list);
    const msgKey = (it) => `${battery || ''}|${state.thread || ''}:${it.index}`;
    let showThinking = true;
    try { showThinking = localStorage.getItem('livechat_thinking') !== '0'; } catch { /* private mode */ }
    thinkBox.checked = showThinking;
    thinkBox.addEventListener('change', () => { showThinking = thinkBox.checked; try { localStorage.setItem('livechat_thinking', showThinking ? '1' : '0'); } catch { /* ignore */ } });

    // ---- follow / pause ------------------------------------------------------------------
    const main = stickyScroll(scroller, (on) => jump.classList.toggle('hidden', on));
    jump.addEventListener('click', () => main.resume());
    const follow = () => main.follow();

    // ---- header --------------------------------------------------------------------------
    function renderHeader() {
        const pill = $('pill');
        const r = state.resp;
        const streaming = r && !r.done;
        const up = state.tap && state.tap.up;
        pill.textContent = !es ? 'off' : (up ? (streaming ? 'streaming' : 'live') : 'no tap');
        pill.className = 'shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full ' + (!up ? 'bg-gray-800 text-gray-500'
            : (streaming ? 'bg-green-900/40 text-green-300 animate-pulse' : 'bg-indigo-600/20 text-indigo-300'));
        const phase = $('phase');
        if (r && up) {
            if (!r.done) phase.textContent = r.tool_calls.length ? 'calling a tool…' : (r.content ? 'answering…' : (r.reasoning ? 'thinking…' : 'prefill…'));
            else phase.textContent = r.error ? `ended: ${r.error}` : (r.finish === 'tool_calls' ? 'waiting for the tool result' : (r.finish ? `finished (${r.finish})` : 'finished'));
        } else phase.textContent = '';
        const c = state.ctx || {};
        const bits = [];
        const modelName = c.model || state.model;
        if (modelName) bits.push(stripSplitIn(modelName));
        if (c.battery) bits.push(c.battery);
        if (c.task) bits.push(`task ${c.task}${c.of > 1 ? ` (run ${c.run}/${c.of})` : ''}${c.index != null && c.total ? ` · ${c.index}/${c.total}` : ''}`);
        if (c.runner) bits.push(harnessLabel(c.runner, c.scaffold) + (c.agentModel ? ` → ${c.agentModel}` : ''));
        const n = state.base + state.messages.length;
        if (n) bits.push(`${n} messages`);
        $('ctx').textContent = bits.join(' · ');
        $('ctx').title = bits.join('\n');
        const plan = latestTodos(), planEl = $('plan');
        planEl.classList.toggle('hidden', !plan);
        planEl.textContent = plan ? `☰ plan progress: ${todoProgressText(plan)}${plan.current ? ` · now: ${plan.current.active || plan.current.content}` : ''}` : '';
        planEl.title = plan ? plan.items.map((i) => `[${i.status}] ${i.content}`).join('\n') : '';
        const side = $('side');
        const sr = state.side;
        if (sr) {
            const ask = sr.delta && sr.delta.length ? M.textOf(sr.delta[sr.delta.length - 1].content) : '';
            side.textContent = `side request #${sr.id}${ask ? ` "${ask.slice(0, 60)}"` : ''} → ${sr.content ? JSON.stringify(sr.content.slice(0, 120)) : (sr.done ? '(empty)' : '…')}`;
            side.classList.remove('hidden');
        } else side.classList.add('hidden');
    }

    // The agent's latest todo list, newest call first: the streaming reply, then the history.
    // Each call carries the whole list, so the last one that parses is the plan as it stands.
    function latestTodos() {
        const calls = (list) => (Array.isArray(list) ? list : []);
        const r = state.resp;
        if (r) for (const tc of calls(r.tool_calls).slice().reverse()) { const td = parseTodos(tc.name, tc.arguments); if (td) return td; }
        for (let i = state.messages.length - 1; i >= 0; i--) {
            const m = state.messages[i];
            if (!m || m.role !== 'assistant') continue;
            for (const tc of calls(m.tool_calls).slice().reverse()) {
                const td = parseTodos((tc.function && tc.function.name) || tc.name, tc.function ? tc.function.arguments : tc.arguments);
                if (td) return td;
            }
        }
        return null;
    }

    function renderEmpty() {
        const empty = $('empty');
        const hasAny = state.messages.length || state.resp;
        if (hasAny) { empty.classList.add('hidden'); return; }
        empty.classList.remove('hidden');
        const port = (state.tap && state.tap.port) || 18090;
        empty.innerHTML = state.tap && state.tap.up
            ? '<div>Tap connected. Waiting for the agent\'s next request…</div>'
            : `<div class="text-gray-400">No live tap on 127.0.0.1:${port}.</div>
               <div>This view shows a running benchmark's conversation from codebench's recording proxy. Put the proxy in front of the server with <span class="font-mono text-gray-300">--tap ${port}</span>:</div>
               <pre class="font-mono text-[11px] text-gray-300 bg-gray-900 border border-gray-800 rounded p-2 whitespace-pre-wrap break-all">llama-server … --port 18080 &amp;
node ~/code/codebench/tools/record-proxy.js --listen 8080 --upstream 18080 --tap ${port} [--out &lt;requests.jsonl&gt;]</pre>
               <div>It connects on its own when a tap appears.</div>`;
        const gap = $('gap');
        gap.classList.add('hidden');
    }

    // ---- message nodes -------------------------------------------------------------------
    function roleLabel(text, cls) { return el('div', 'text-[10px] font-semibold uppercase tracking-wider mb-1 ' + cls, text); }

    function reasoningBlock(text, open, key) {
        const d = el('details', 'mb-1 rounded border border-gray-800 bg-gray-900/40');
        if (open) d.open = true;
        d.dataset.key = key;
        choices.apply(d);   // rule 3: a new node gets the reader's choice back
        const sum = el('summary', 'cursor-pointer select-none px-2 py-1 text-[10px] text-gray-500 italic', text ? `thinking · ${fmtN(text.length)} chars` : 'thinking');
        // No inner scroll box (2026-10-01, Kyle: "double scroll bars"): the chat list is the scroller; nested max-h
        // boxes put a second scrollbar inside it on every expanded block.
        const body = el('div', 'px-2 pb-2 text-xs text-gray-500 italic whitespace-pre-wrap break-words');
        if (text) body.appendChild(document.createTextNode(text));
        d.append(sum, body);
        return { d, sum, body, follow: stickyScroll(body) };
    }

    function toolCallCard(tc, mk) {
        // a todo list (todowrite / TodoWrite / update_plan) as a checklist once its arguments parse;
        // while they are still streaming, the generic card below shows them arriving
        const td = parseTodos(tc.name, tc.arguments);
        if (td) { const w = el('div'); w.innerHTML = renderTodosHtml(td, { name: tc.name }); return w.firstChild; }
        const card = el('div', 'mt-1 rounded-md border border-yellow-800 bg-yellow-900/20 text-xs min-w-0');
        const head = el('div', 'flex items-baseline gap-2 px-2 py-1 min-w-0');
        head.append(el('span', 'font-mono font-semibold text-amber-300 shrink-0', `⚙ ${tc.name || '…'}`),
            el('span', 'font-mono text-gray-300 truncate', argSummary(tc.name, tc.arguments)));
        card.appendChild(head);
        const pretty = prettyArgs(tc.arguments);
        if (pretty) {
            const d = el('details', 'border-t border-yellow-800');
            if (pretty.length <= ARGS_INLINE_MAX) d.open = true;
            d.dataset.key = tc.id ? `${battery || ''}|tc:${tc.id}` : `${mk}:tc${tc.index}`;   // the id streams in with the call's first delta
            choices.apply(d);
            d.append(el('summary', 'cursor-pointer select-none px-2 py-0.5 text-[10px] text-gray-500', `arguments · ${fmtN(pretty.length)} chars`),
                el('pre', 'px-2 pb-2 font-mono text-[11px] text-gray-300 whitespace-pre-wrap break-all', pretty));
            card.appendChild(d);
        }
        return card;
    }

    function toolResult(it, name, mk) {
        const box = el('div', 'rounded-md border border-gray-800 bg-gray-900/50 text-xs min-w-0');
        const text = it.text || '';
        const lines = text.split('\n');
        const long = text.length > RESULT_PREVIEW_CHARS || lines.length > RESULT_PREVIEW_LINES;
        const head = el('div', 'flex items-baseline gap-2 px-2 py-1 border-b border-gray-800');
        head.append(el('span', 'font-mono text-blue-300', `↳ ${name || 'tool'} result`),
            el('span', 'text-[10px] text-gray-500', `${fmtN(lines.length)} lines · ${fmtN(text.length)} chars`));
        box.appendChild(head);
        const pre = el('pre', 'px-2 py-1 font-mono text-[11px] text-gray-400 whitespace-pre-wrap break-all');
        const preview = long ? lines.slice(0, RESULT_PREVIEW_LINES).join('\n').slice(0, RESULT_PREVIEW_CHARS) + ' …' : text;
        pre.textContent = preview || '(empty)';
        box.appendChild(pre);
        if (long) {
            const key = it.tool_call_id ? `${battery || ''}|res:${it.tool_call_id}` : `${mk}:res`;
            let expanded = choices.get(key) === true;   // rule 3: as the reader left it
            const b = el('button', 'px-2 pb-1 text-[10px] text-indigo-300 hover:text-indigo-300', expanded ? 'collapse' : 'show all');
            b.type = 'button';
            if (expanded) pre.textContent = text;
            b.addEventListener('click', () => {
                expanded = !expanded;
                choices.set(key, expanded);
                pre.textContent = expanded ? text : preview;
                b.textContent = expanded ? 'collapse' : 'show all';
            });
            box.appendChild(b);
        }
        return box;
    }

    function footerText(r) {
        const bits = [];
        if (r.finish) bits.push(r.finish);
        if (r.error) bits.push(r.error);
        const u = r.usage || {}, t = r.timings || {};
        if (u.prompt_tokens != null) bits.push(`${fmtN(u.prompt_tokens)} in`);
        if (u.completion_tokens != null) bits.push(`${fmtN(u.completion_tokens)} out`);
        if (t.prompt_per_second) bits.push(`pp ${Number(t.prompt_per_second).toFixed(0)} t/s`);
        if (t.predicted_per_second) bits.push(`tg ${Number(t.predicted_per_second).toFixed(1)} t/s`);
        if (r.t_start && r.t_end) bits.push(`${(r.t_end - r.t_start).toFixed(1)} s`);
        return bits.join(' · ');
    }

    function messageNode(it, items) {
        const wrap = el('div', 'min-w-0');
        wrap.dataset.idx = String(it.index);
        const mk = msgKey(it);
        if (it.role === 'system') {
            const d = el('details', 'rounded-md border border-gray-800 bg-gray-900/40');
            d.dataset.key = `${mk}:system`;
            d.append(el('summary', 'cursor-pointer select-none px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-gray-500', `system prompt · ${fmtN(it.text.length)} chars`),
                el('pre', 'px-2 pb-2 font-mono text-[11px] text-gray-400 whitespace-pre-wrap break-words', it.text));
            choices.apply(d);
            wrap.appendChild(d);
            return { node: wrap };
        }
        if (it.role === 'user') {
            const box = el('div', 'rounded-lg border border-indigo-900/60 bg-indigo-600/20 px-3 py-2');
            box.append(roleLabel('user', 'text-indigo-300'), el('div', 'text-sm text-gray-200 whitespace-pre-wrap break-words', it.text));
            wrap.appendChild(box);
            return { node: wrap };
        }
        if (it.role === 'tool') {
            wrap.appendChild(toolResult(it, it.name || M.toolNameFor(items, it.tool_call_id), mk));
            return { node: wrap };
        }
        if (it.role === 'assistant') {
            const box = el('div', 'rounded-lg border border-gray-800 bg-gray-900 px-3 py-2 min-w-0');
            box.appendChild(roleLabel(it.live && !it.resp.done ? 'assistant · streaming' : 'assistant', 'text-green-300'));
            const parts = { box, it };
            parts.think = reasoningBlock(it.reasoning || '', it.live && !it.resp.done && showThinking && !it.text && !(it.tool_calls || []).length, `${mk}:think`);
            if (!it.reasoning) parts.think.d.classList.add('hidden');
            box.appendChild(parts.think.d);
            parts.text = el('div', 'text-sm text-gray-100 whitespace-pre-wrap break-words');
            if (it.text) parts.text.appendChild(document.createTextNode(it.text));
            box.appendChild(parts.text);
            parts.calls = el('div', 'space-y-1');
            for (const tc of it.tool_calls || []) parts.calls.appendChild(toolCallCard(tc, mk));
            box.appendChild(parts.calls);
            parts.foot = el('div', 'mt-1 text-[10px] text-gray-500');
            if (it.live) parts.foot.textContent = it.resp.done ? footerText(it.resp) : '';
            if (it.live && !it.resp.done) parts.cursor = el('span', 'inline-block w-2 h-3 ml-1 bg-green-500 animate-pulse');
            if (parts.cursor) parts.text.appendChild(parts.cursor);
            box.appendChild(parts.foot);
            wrap.appendChild(box);
            return { node: wrap, parts };
        }
        const box = el('div', 'rounded border border-gray-800 px-2 py-1 text-xs text-gray-400 whitespace-pre-wrap break-words');
        box.append(roleLabel(it.role, 'text-gray-500'), document.createTextNode(it.text));
        wrap.appendChild(box);
        return { node: wrap };
    }

    // A message's identity for reuse: its position, role, and content size. Messages before
    // `prefix` never change within a thread, so this only really differs for new ones.
    // RE-RENDER SITE: a message whose sig changed gets a NEW node (messageNode), drawn from the defaults and then given
    // the reader's choices back from `choices` (rule 3 in ui/benchmarks/util.js) -- never carried over from the old node.
    const sigOf = (it) => `${state.thread}|${it.role}|${it.live ? 'live' + it.resp.id : ''}|${(it.text || '').length}|${(it.reasoning || '').length}|${(it.tool_calls || []).length}`;

    function renderAll() {
        renderHeader();
        renderEmpty();
        const items = M.view(state);
        const gap = $('gap');
        if (state.gap && state.base > 0) { gap.textContent = `${state.base} earlier messages were sent before this view connected`; gap.classList.remove('hidden'); } else gap.classList.add('hidden');
        const next = new Map();
        let prev = null;
        liveParts = null;
        for (const it of items) {
            const key = it.live ? `live:${it.resp.id}` : `m:${it.index}`;
            const sig = sigOf(it);
            let rec = nodes.get(key);
            if (!rec || rec.sig !== sig) { rec = { ...messageNode(it, items), sig }; }
            next.set(key, rec);
            const want = prev ? prev.nextSibling : list.firstChild;
            if (want !== rec.node) list.insertBefore(rec.node, want);
            prev = rec.node;
            if (it.live) liveParts = rec.parts;
        }
        for (const [k, rec] of nodes) if (!next.has(k) && rec.node.parentNode === list) list.removeChild(rec.node);
        while (prev && prev.nextSibling) list.removeChild(prev.nextSibling);
        if (!prev) list.textContent = '';
        nodes = next;
        follow();
    }

    // In-place update of the streaming message.
    function applyDelta(add) {
        const p = liveParts;
        if (!p) { renderAll(); return; }
        const r = state.resp;
        if (add.reasoning) {
            p.think.d.classList.remove('hidden');
            p.think.body.appendChild(document.createTextNode(add.reasoning));
            if (p.think.d.open) p.think.follow.follow();
        }
        // the answer started: fold the thinking away -- unless the reader opened or closed it themselves (kept by key, so
        // it survives the node being rebuilt; the old per-node flag did not)
        if ((add.content || add.tool_calls) && p.think.d.open && choices.get(p.think.d.dataset.key) === undefined) p.think.d.open = false;
        if (add.content) {
            const t = document.createTextNode(add.content);
            if (p.cursor) p.text.insertBefore(t, p.cursor); else p.text.appendChild(t);
        }
        if (add.tool_calls) {
            p.calls.textContent = '';
            for (const tc of r.tool_calls) p.calls.appendChild(toolCallCard(tc, msgKey(p.it)));
        }
        p.think.sum.textContent = `thinking · ${fmtN(r.reasoning.length)} chars`;
        follow();
    }

    function applyEnd() {
        const p = liveParts;
        const r = state.resp;
        if (!p || !r) { renderAll(); return; }
        if (p.cursor) { p.cursor.remove(); p.cursor = null; }
        p.box.firstChild.textContent = 'assistant';
        p.foot.textContent = footerText(r);
        p.text.normalize(); p.think.body.normalize();
        // keep this node on the next request if nothing else changed: its sig now reflects `done`
        follow();
    }

    function onFrame(ev) {
        const ch = M.apply(state, ev);
        switch (ch.kind) {
            case 'reset': renderAll(); break;
            case 'delta': if (ch.target === 'resp') applyDelta(ch.add); renderHeader(); break;
            case 'end': if (ch.target === 'resp') applyEnd(); renderHeader(); break;
            case 'side': case 'meta': renderHeader(); renderEmpty(); break;
            default: break;
        }
    }

    // ---- stream lifecycle ----------------------------------------------------------------
    function open() {
        if (es) return;
        try {
            es = new EventSource(battery ? `/api/livechat?battery=${encodeURIComponent(battery)}` : '/api/livechat');
            es.onmessage = (e) => { let ev; try { ev = JSON.parse(e.data); } catch { return; } try { onFrame(ev); } catch (err) { console.error('[livechat]', err); } };
            es.onerror = () => { state.tap = { ...state.tap, up: false }; renderHeader(); /* EventSource retries on its own */ };
        } catch { es = null; }
        renderHeader();
    }
    function close() { if (es) { es.close(); es = null; } }
    // A DOM move resets scrollTop: remember the list's and every open inner scroller's position.
    let saved = null;
    function detach() {
        if (!view.parentNode) return;
        saved = { top: scroller.scrollTop, inner: Array.from(view.querySelectorAll('.overflow-y-auto')).filter((e) => e !== scroller && e.scrollTop > 0).map((e) => [e, e.scrollTop]) };
        view.remove();
    }
    function attach(host) {
        if (view.parentNode !== host) host.appendChild(view);
        if (saved) { if (!main.stick) scroller.scrollTop = saved.top; for (const [e, t] of saved.inner) e.scrollTop = t; saved = null; }
        follow();
    }
    function unmount() { close(); view.remove(); }
    renderAll();
    open();
    // Another battery (another lane's tap): drop this stream and its state, start over on the new one.
    function setBattery(b) {
        b = b || null; if (b === battery) return;
        battery = b; close(); state = M.fresh(); renderAll(); open();
    }
    return { el: view, detach, attach, unmount, setBattery };
}
