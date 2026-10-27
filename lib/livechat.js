'use strict';
// --- LIVE CHAT: relay codebench's proxy tap to the browser / CLI ---
// codebench's tools/record-proxy.js, run with `--tap <port>`, serves a server-sent-event feed of
// every chat request passing through it (the agent's new messages) and of the model's reply as it
// streams (reasoning, answer, tool calls). This module keeps ONE connection to that feed and
// fans it out to LL-Dash clients on GET /api/livechat (SSE), keeping the reduced state
// (ui/livechat/model.js -- the same reducer the browser runs) so a client that connects
// mid-request first gets {type:'snapshot'} and can draw the conversation so far.
//
// No cost when unused: the tap is only dialled while at least one /api/livechat client is
// connected, and dropped LINGER_MS after the last one leaves. While a client waits and nothing
// listens on the tap port, it retries every RETRY_MS (one refused loopback connect).
//
// Why a separate stream and not /api/status: dash-cli reads every `data:` frame on /api/status
// as a full state envelope, and token deltas at up to 20 frames/s would be pure overhead for
// every client not looking at the chat.
const http = require('http');
const model = require('../ui/livechat/model.js');

const DEFAULT_TAP_PORT = 18090;
const RETRY_MS = 3000;
const LINGER_MS = 30000;
const CTX_MIN_MS = 5000;               // label lookups (battery/task) at most this often
const CLIENT_MAX_BUFFERED = 2 * 1024 * 1024;

function createRelay(opts) {
    const o = opts || {};
    const host = o.host || '127.0.0.1';
    const portOf = () => (typeof o.port === 'function' ? o.port() : o.port) || DEFAULT_TAP_PORT;
    let port = portOf();
    const getCtx = typeof o.getCtx === 'function' ? o.getCtx : () => null;
    const onEnd = typeof o.onEnd === 'function' ? o.onEnd : null;   // every response's final usage/timings (server4.js: per-task t/s)
    // Every tap event, raw (2026-10-01, server4.js: lib/lanetps.js meters for Kyle's combined multi-lane t/s).
    const onEventHook = typeof o.onEvent === 'function' ? o.onEvent : null;
    const log = o.log || (() => {});
    const httpGet = o.httpGet || http.get;

    let state = model.fresh();
    const clients = new Set();
    // Stay connected with nobody watching while server4 says an external server is up: the tap's
    // per-request timings are the only source of a real prefill rate for it (a /slots poll sees
    // prefill move only once per 2048-token ubatch, so short cached prompts never register).
    let wanted = false;
    function setWanted(w) {
        w = !!w; if (w === wanted) return; wanted = w;
        if (wanted) connect(); else if (!clients.size && !lingerTimer) { lingerTimer = setTimeout(disconnect, LINGER_MS); if (lingerTimer.unref) lingerTimer.unref(); }
    }
    let upReq = null, upRes = null, retryTimer = null, lingerTimer = null, ctxAt = 0;

    function send(res, ev) {
        try {
            if (res.writableLength > CLIENT_MAX_BUFFERED) { clients.delete(res); res.destroy(); return; }
            res.write(`data: ${JSON.stringify(ev)}\n\n`);
        } catch { clients.delete(res); }
    }
    function fanout(ev) { for (const c of clients) send(c, ev); }
    function applyAndFanout(ev) { model.apply(state, ev); fanout(ev); }

    function refreshCtx(force) {
        const now = Date.now();
        if (!force && now - ctxAt < CTX_MIN_MS) return;
        ctxAt = now;
        let ctx = null;
        try { ctx = getCtx() || null; } catch { ctx = null; }
        if (JSON.stringify(ctx) !== JSON.stringify(state.ctx)) applyAndFanout({ type: 'ctx', ctx });
    }

    function setTap(up, error) {
        if (state.tap.up === up && !error) return;
        applyAndFanout({ type: 'tap', up, port, error: error || null });
    }

    function onEvent(ev) {
        if (!ev || typeof ev.type !== 'string') return;
        // A new thread is a new agent session, usually a new task: relabel now, not up to CTX_MIN_MS late.
        const newThread = ev.type === 'request' && !ev.side && ev.thread !== state.thread;
        applyAndFanout(ev);
        if (onEventHook) { try { onEventHook(ev); } catch (e) { log(`[livechat] onEvent: ${e.message}`); } }
        if (ev.type === 'request' && !ev.side) refreshCtx(newThread);
        if (ev.type === 'end' && onEnd) { try { onEnd(ev); } catch (e) { log(`[livechat] onEnd: ${e.message}`); } }
    }

    function connect() {
        if (upReq || !(clients.size || wanted)) return;
        retryTimer = null;
        port = portOf();
        let buf = '';
        const req = httpGet({ host, port, path: '/events', headers: { Accept: 'text/event-stream' } }, (res) => {
            if (res.statusCode !== 200) { res.resume(); req.destroy(new Error(`HTTP ${res.statusCode}`)); return; }
            upRes = res;
            setTap(true);
            refreshCtx(true);
            res.setEncoding('utf8');
            res.on('data', (chunk) => {
                buf += chunk;
                let i;
                while ((i = buf.indexOf('\n\n')) !== -1) {
                    const frame = buf.slice(0, i); buf = buf.slice(i + 2);
                    for (const line of frame.split('\n')) {
                        if (!line.startsWith('data:')) continue;
                        let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
                        try { onEvent(ev); } catch (e) { log(`[livechat] event: ${e.message}`); }
                    }
                }
                if (buf.length > 64 * 1024 * 1024) { buf = ''; req.destroy(new Error('frame too large')); }
            });
            res.on('end', () => req.destroy());
        });
        upReq = req;
        req.on('error', () => { /* handled on close */ });
        req.on('close', () => {
            upReq = null; upRes = null;
            setTap(false);
            if ((clients.size || wanted) && !retryTimer) { retryTimer = setTimeout(connect, RETRY_MS); if (retryTimer.unref) retryTimer.unref(); }
        });
    }

    function disconnect() {
        lingerTimer = null;
        if (clients.size || wanted) return;
        if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
        if (upReq) { try { upReq.destroy(); } catch { /* gone */ } }
    }

    // GET /api/livechat -- the caller has already authenticated the request.
    function attach(req, res) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        if (lingerTimer) { clearTimeout(lingerTimer); lingerTimer = null; }
        refreshCtx(true);
        send(res, { type: 'snapshot', state });
        clients.add(res);
        req.on('close', () => {
            clients.delete(res);
            if (!clients.size && !lingerTimer) { lingerTimer = setTimeout(disconnect, LINGER_MS); if (lingerTimer.unref) lingerTimer.unref(); }
        });
        connect();
    }

    function ping() { for (const c of clients) { try { c.write(': ping\n\n'); } catch { clients.delete(c); } } }

    function status() {
        return { tap: { ...state.tap, port }, clients: clients.size, connected: !!upRes, thread: state.thread,
            messages: state.base + state.messages.length, resp: state.resp ? { id: state.resp.id, done: state.resp.done } : null };
    }

    return { attach, ping, status, setWanted, connected: () => !!upRes, getState: () => state, _onEvent: onEvent };
}

module.exports = { createRelay, DEFAULT_TAP_PORT };
