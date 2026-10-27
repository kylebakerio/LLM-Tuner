// Live chat: the state of the conversation passing through codebench's recording proxy
// (tools/record-proxy.js --tap), built from its event feed. ONE reducer, used on both sides:
//   - server4.js (lib/livechat.js) applies every tap event to keep the backlog a browser gets
//     when it connects mid-request ({type:'snapshot'});
//   - the browser (ui/livechat/index.js) applies the same events to draw the chat.
// That is why this file is a classic script, not an ES module: Node 20's require() cannot load
// ESM, so it attaches to `module.exports` under Node and to `window.LiveChatModel` in a page.
//
// Events (from the tap, relayed unchanged):
//   {type:'hello'}                                    a (re)connected tap: forget the conversation
//   {type:'request', id, thread, prefix, delta[], n_messages, tools[], model, side, replay, reasoning?}
//        the agent sent a chat request: messages[0..prefix) are unchanged, `delta` is the rest.
//        `side`: a request without tools on another thread (title generation, summaries).
//   {type:'delta', id, reasoning?, content?, tool_calls?[{index, id?, name?, arguments?}]}
//   {type:'end', id, finish, usage, timings, status, error}
// and from lib/livechat.js itself: {type:'tap', up, port}, {type:'ctx', ...}, {type:'snapshot', state}.
//
// Message indices are ABSOLUTE conversation positions: `base` is the index of messages[0]
// (non-zero only after a gap). A response to a request of n messages becomes message n of the
// next request, so `resp.index` = n and `reasoning[n]` keeps its thinking once the agent sends
// the message back without it (agents do not echo reasoning_content).
(function (root) {
    'use strict';
    const REASONING_KEEP = 24;

    function fresh() {
        return { rev: 0, tap: { up: false, port: null }, ctx: null,
            thread: null, base: 0, messages: [], tools: [], model: null, gap: false,
            reasoning: {}, resp: null, side: null, requests: 0 };
    }
    function newResp(ev) {
        const r = { id: ev.id, thread: ev.thread, index: ev.n_messages, side: !!ev.side, model: ev.model || null,
            t_start: ev.t || null, t_end: null, reasoning: '', content: '', tool_calls: [], done: false,
            finish: null, usage: null, timings: null, status: null, error: null };
        if (ev.side) r.delta = Array.isArray(ev.delta) ? ev.delta : [];   // a side request's own messages (small)
        return r;
    }
    function keepReasoning(s, r) {
        if (!r || !r.reasoning || r.side) return;
        s.reasoning[r.index] = r.reasoning;
        const keys = Object.keys(s.reasoning).map(Number).sort((a, b) => a - b);
        while (keys.length > REASONING_KEEP) delete s.reasoning[keys.shift()];
    }
    function mergeToolCalls(list, add) {
        for (const tc of add || []) {
            if (!tc || typeof tc !== 'object') continue;
            const idx = Number.isInteger(tc.index) ? tc.index : list.length;
            let t = list.find((x) => x.index === idx);
            if (!t) { t = { index: idx, id: null, name: '', arguments: '' }; list.push(t); }
            if (tc.id) t.id = tc.id;
            if (tc.name && tc.name !== t.name) t.name += tc.name;
            if (tc.arguments) t.arguments += tc.arguments;
        }
    }

    // Applies one event; returns what changed so a renderer can update in place:
    //   {kind:'reset'}  redraw everything    {kind:'delta', target:'resp'|'side', add}
    //   {kind:'end', target}    {kind:'side'}    {kind:'meta'}    {kind:'none'}
    function apply(s, ev) {
        if (!ev || typeof ev !== 'object') return { kind: 'none' };
        s.rev++;
        switch (ev.type) {
            case 'snapshot': {
                const n = ev.state && typeof ev.state === 'object' ? ev.state : fresh();
                for (const k of Object.keys(s)) delete s[k];
                Object.assign(s, fresh(), n);
                return { kind: 'reset' };
            }
            case 'hello': {
                const keep = { tap: s.tap, ctx: s.ctx, rev: s.rev };
                for (const k of Object.keys(s)) delete s[k];
                Object.assign(s, fresh(), keep);
                return { kind: 'reset' };
            }
            case 'tap': s.tap = { up: !!ev.up, port: ev.port ?? null, error: ev.error || null }; return { kind: 'meta' };
            case 'ctx': s.ctx = ev.ctx || null; return { kind: 'meta' };
            case 'request': {
                s.requests++;
                const delta = Array.isArray(ev.delta) ? ev.delta : [];
                const prefix = Math.max(0, Number(ev.prefix) || 0);
                const tools = Array.isArray(ev.tools) ? ev.tools : [];
                const side = !!ev.side || (!tools.length && s.thread !== null && ev.thread !== s.thread && s.tools.length > 0);
                if (side) { s.side = newResp({ ...ev, side: true }); return { kind: 'side' }; }
                if (s.resp && s.resp.thread === ev.thread) keepReasoning(s, s.resp);
                const known = s.base + s.messages.length;
                if (ev.thread !== s.thread || ev.replay || prefix === 0) {
                    s.reasoning = prefix === 0 || ev.thread !== s.thread ? {} : s.reasoning;
                    s.base = prefix; s.messages = delta.slice(); s.gap = prefix > 0;
                } else if (prefix < s.base || prefix > known) {
                    s.base = prefix; s.messages = delta.slice(); s.gap = prefix > 0;
                } else {
                    s.messages = s.messages.slice(0, prefix - s.base).concat(delta);
                }
                if (ev.reasoning && typeof ev.reasoning === 'object') Object.assign(s.reasoning, ev.reasoning);
                for (const k of Object.keys(s.reasoning)) if (Number(k) >= prefix + delta.length) delete s.reasoning[k];
                s.thread = ev.thread; s.tools = tools; s.model = ev.model || s.model;
                s.resp = newResp(ev);
                if (s.side && s.side.done) s.side = null;   // a finished side request has been seen long enough
                return { kind: 'reset' };
            }
            case 'delta': {
                const target = s.resp && s.resp.id === ev.id ? 'resp' : (s.side && s.side.id === ev.id ? 'side' : null);
                if (!target) return { kind: 'none' };
                const r = s[target];
                const add = {};
                if (typeof ev.reasoning === 'string' && ev.reasoning) { r.reasoning += ev.reasoning; add.reasoning = ev.reasoning; }
                if (typeof ev.content === 'string' && ev.content) { r.content += ev.content; add.content = ev.content; }
                if (Array.isArray(ev.tool_calls) && ev.tool_calls.length) { mergeToolCalls(r.tool_calls, ev.tool_calls); add.tool_calls = true; }
                return { kind: 'delta', target, add };
            }
            case 'end': {
                const target = s.resp && s.resp.id === ev.id ? 'resp' : (s.side && s.side.id === ev.id ? 'side' : null);
                if (!target) return { kind: 'none' };
                const r = s[target];
                r.done = true; r.finish = ev.finish || null; r.usage = ev.usage || null; r.timings = ev.timings || null;
                r.status = ev.status ?? null; r.error = ev.error || null; r.t_end = ev.t || null;
                return { kind: 'end', target };
            }
            default: s.rev--; return { kind: 'none' };
        }
    }

    // Plain text of a message's content (string, or OpenAI content parts).
    function textOf(content) {
        if (typeof content === 'string') return content;
        if (Array.isArray(content)) return content.map((p) => (p && typeof p === 'object') ? (p.text ?? (p.type === 'image_url' ? '[image]' : '')) : String(p ?? '')).join('');
        if (content == null) return '';
        try { return JSON.stringify(content); } catch { return String(content); }
    }

    // The conversation as a flat list of display items, oldest first. The in-flight (or last,
    // not yet echoed back) response is appended as {role:'assistant', live:true}.
    function view(s) {
        const items = [];
        s.messages.forEach((m, i) => {
            const abs = s.base + i;
            if (!m || typeof m !== 'object') return;
            const it = { index: abs, role: m.role || '?', text: textOf(m.content) };
            if (m.role === 'assistant') {
                it.reasoning = typeof m.reasoning_content === 'string' && m.reasoning_content ? m.reasoning_content : (s.reasoning[abs] || '');
                it.tool_calls = (Array.isArray(m.tool_calls) ? m.tool_calls : []).map((tc, k) => ({
                    index: k, id: tc && tc.id, name: (tc && tc.function && tc.function.name) || (tc && tc.name) || '?',
                    arguments: tc && tc.function ? (typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments ?? '')) : '' }));
            }
            if (m.role === 'tool') { it.tool_call_id = m.tool_call_id || null; it.name = m.name || null; }
            items.push(it);
        });
        const r = s.resp;
        if (r && r.index >= s.base + s.messages.length) {
            items.push({ index: r.index, role: 'assistant', live: true, resp: r, text: r.content, reasoning: r.reasoning, tool_calls: r.tool_calls });
        }
        return items;
    }

    // Tool name for a tool-result message: the assistant call it answers.
    function toolNameFor(items, callId) {
        if (!callId) return null;
        for (let i = items.length - 1; i >= 0; i--) {
            const tcs = items[i].tool_calls || [];
            const hit = tcs.find((t) => t.id === callId);
            if (hit) return hit.name;
        }
        return null;
    }

    const api = { fresh, apply, view, textOf, toolNameFor, REASONING_KEEP };
    if (typeof module === 'object' && module.exports) module.exports = api;
    else root.LiveChatModel = api;
})(typeof window !== 'undefined' ? window : globalThis);
