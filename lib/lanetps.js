'use strict';
// --- COMBINED LIVE T/S ACROSS GPU LANES (2026-10-01) ---
// Kyle: "when we have 2 local lanes running, the generation and prefill numbers on the telemetry
// sidebar should reflect the numbers of the two models _combined_." The sidebar's live cards are fed
// by ONE server (LL-Dash's own, or the :8080 /slots poll + the 18090 tap), so with the XTX (Strata)
// and the 3060 (llama-server) lanes both busy they showed one lane -- and with Strata on :8080, whose
// /slots has no live rates, generation sat at 0. Every lane's record-proxy publishes a tap SSE feed
// (codebench tools/record-proxy.js --tap), and both engines put llama.cpp-style `timings` on each
// response's `end` frame, so one meter per tap gives a live rate for any engine.
//
// Design in one line: exact LIVE counters from each lane's engine first (laneRates below), the tap
// meter second. The tap-text estimate was built first and measured too rough to lead -- see
// "MEASURED, THEN DEMOTED" below for the numbers.
//
// Pure: no I/O, time passed in -- server4.js feeds it the tap events (lib/livechat.js onEvent) and
// asks for rates on GET /api/lanes/live; test/lanetps.test.js drives it with synthetic frames.
//
// Generation: the tap carries text, not token counts, coalesced into <= 20 frames/s per response
// (TAP_FLUSH_MS 50). So the live rate is chars/s over the last WINDOW_MS of the CURRENT response's
// frames (a window spanning the previous response + this one's prefill would read low), converted
// with a per-lane chars-per-token ratio calibrated at each `end` (chars streamed / predicted_n).
// Measured 2026-10-01 on the live taps: 2.7 (3060, Qwen3.8-27B UD-Q2_K_XL) to 3.6 (XTX Strata, Qwen3.8-Flash-Next GSQ-RCO IQ1_M) chars/token,
// hence DEFAULT_CPT 3.2 until the first end lands. Uncalibrated, the last request's exact
// predicted_per_second is preferred over the default-ratio guess. A lane with no frame for
// GEN_IDLE_MS contributes 0 (agent running tools, or prefilling the next request).
//
// Prefill: rates exist only at `end` (prompt_per_second), so a lane shows its latest exact prefill
// rate while it is ACTIVE -- a request in flight, or any tap event within ACTIVE_IDLE_MS -- and 0
// once idle. Same prompt_n >= 32 floor as server4.js's live prefill card: a 19-token cached
// re-prompt reports ~45 t/s, which is overhead, not prefill speed.
//
// MEASURED, THEN DEMOTED (same day): replaying 4 min of timestamped live tap frames against each
// response's exact predicted_per_second, the chars/s estimate was off 20-35% on average (p90 40-75%)
// at any window from 3 to 15 s -- chars per token swings 2.1-4.95 between responses (tool-call JSON
// vs reasoning prose) -- and "last request's predicted_per_second" was 9% off on the 3060 but 55% on
// the XTX, whose Strata decode moved between 10-15 and 50-65 t/s from one request to the next. Both
// engines expose exact LIVE counters, so server4.js polls them (~1 Hz, only while combined + viewed)
// and laneRates() below prefers them: llama-server GET /slots through lib/slots.js (the reducer the
// :8080 path already uses), Strata GET /metrics `live` (parseStrataLive). The tap meter stays as the
// fallback (engine unknown / poll failing) and as the source of each request's exact prefill rate
// once its read is over (prompt_per_second on `end`), plus in-flight/idle detection.
//
// Replay: a tap replays the current conversation on connect -- request/delta frames flagged
// `replay`, but the replayed `end` is NOT flagged. Request/end are timed by their own `t` (seconds)
// so a reconnect does not make a long-idle lane look active; replayed deltas count toward
// calibration (they hold the response's full text so far) but never toward the live rate.
//
// EDGES (2026-10-22, Kyle: the Live view's "generating / reading the prompt" strip ran "a second or two late"). The tap
// says the moment a request is sent, its first token streams and it ends; the engine poll says it up to ~1 s later.
// feed() returns that edge ('request' | 'first' | 'end', live frames only) and the meter keeps its time (edgeAt), so
// laneRates() lets the engine's sample speak only when it was taken after the latest edge, and server4.js pushes the
// lanes tick at once on an edge instead of waiting for the next 1 s tick. An end stops generation at once (it used to
// linger GEN_IDLE_MS after the last frame).

const { shortName } = require('./topology');
const WINDOW_MS = 3000;
const GEN_IDLE_MS = 3000;
const ACTIVE_IDLE_MS = 5000;
const INFLIGHT_MAX_MS = 15 * 60 * 1000;   // a request with no end this long is a lost frame, not a 15-min prefill
const MIN_SPAN_MS = 500;                  // two frames 50 ms apart would give a wild rate
const DEFAULT_CPT = 3.2;
const MIN_PROMPT_N = 32;
const READ_MIN_N = 1000;                  // 'last prefill' for a card that is generating: only a sizeable read is a speed
                                          // (a 300-token cached re-read measured 3..95 t/s on a lane whose real rate is 400+)
const CPT_EMA = 0.3;

function deltaChars(ev) {
    let n = (typeof ev.reasoning === 'string' ? ev.reasoning.length : 0) + (typeof ev.content === 'string' ? ev.content.length : 0);
    if (Array.isArray(ev.tool_calls)) for (const tc of ev.tool_calls) {
        if (!tc) continue;
        if (typeof tc.name === 'string') n += tc.name.length;
        if (typeof tc.arguments === 'string') n += tc.arguments.length;
    }
    return n;
}

function createLaneMeter(opts) {
    const o = opts || {};
    const windowMs = o.windowMs || WINDOW_MS;
    const genIdleMs = o.genIdleMs || GEN_IDLE_MS;
    const activeIdleMs = o.activeIdleMs || ACTIVE_IDLE_MS;
    let s;
    function reset() {
        s = { resps: new Map(), curId: null, frames: [], lastDeltaAt: 0, lastDeltaId: null, lastEventAt: 0, edgeAt: 0,
            cpt: null, lastPredTps: null, lastPromptTps: null, lastPromptN: null, lastPromptAt: 0, lastReadTps: null, lastReadN: null };
    }
    reset();
    const evTime = (ev, now) => (Number(ev.t) > 0 ? Number(ev.t) * 1000 : now);
    function resp(id) {
        let r = s.resps.get(id);
        if (!r) {
            r = { chars: 0, t0: null, firstDeltaAt: null, done: false, partial: true, live: false, liveDelta: false };
            s.resps.set(id, r);
            while (s.resps.size > 16) s.resps.delete(s.resps.keys().next().value);
        }
        return r;
    }

    // -> the edge this frame is ('request' | 'first' | 'end'), or null (a replayed frame, or nothing new)
    function feed(ev, now) {
        if (!ev || typeof ev.type !== 'string') return null;
        if (ev.type === 'request') {
            // a live request is timed on THIS clock (a laptop lane's tap stamps `t` with the laptop's); a replayed one by
            // its own `t`, so a reconnect does not make a long-gone request look new
            const t = ev.replay ? evTime(ev, now) : now;
            const r = resp(ev.id);
            Object.assign(r, { chars: 0, t0: t, firstDeltaAt: null, done: false, partial: false, live: !ev.replay, liveDelta: false });
            s.curId = ev.id;
            s.lastEventAt = Math.max(s.lastEventAt, Math.min(t, now));
            if (!ev.replay) { s.edgeAt = now; return 'request'; }
        } else if (ev.type === 'delta') {
            const r = resp(ev.id);
            const n = deltaChars(ev);
            r.chars += n;
            if (!r.firstDeltaAt) r.firstDeltaAt = now;
            if (ev.replay) return null;
            s.frames.push({ t: now, id: ev.id, chars: n });
            if (s.frames.length > 400) s.frames.splice(0, s.frames.length - 400);
            s.lastDeltaAt = now; s.lastDeltaId = ev.id;
            s.lastEventAt = Math.max(s.lastEventAt, now);
            if (!r.liveDelta) { r.liveDelta = true; s.edgeAt = now; return 'first'; }
        } else if (ev.type === 'end') {
            const t = evTime(ev, now);
            const r = resp(ev.id);
            r.done = true;
            s.lastEventAt = Math.max(s.lastEventAt, Math.min(t, now));
            const tm = ev.timings || {}, u = ev.usage || {};
            const predN = Number(tm.predicted_n) || Number(u.completion_tokens) || 0;
            // Calibrate only on a response seen from its request (live or replayed): a delta-only
            // response that began before we dialled holds a fraction of its text (measured: 132 chars
            // for 6003 tokens) -- the 1..8 band catches anything else odd.
            if (!r.partial && predN >= 50 && r.chars > 0) {
                const ratio = r.chars / predN;
                if (ratio >= 1 && ratio <= 8) s.cpt = s.cpt == null ? ratio : s.cpt * (1 - CPT_EMA) + ratio * CPT_EMA;
            }
            if (Number(tm.predicted_per_second) > 0) s.lastPredTps = Number(tm.predicted_per_second);
            if (Number(tm.prompt_n) >= MIN_PROMPT_N && Number(tm.prompt_per_second) > 0) {
                s.lastPromptTps = Number(tm.prompt_per_second);
                s.lastPromptN = Number(tm.prompt_n);
                s.lastPromptAt = t;
                if (Number(tm.prompt_n) >= READ_MIN_N) { s.lastReadTps = Number(tm.prompt_per_second); s.lastReadN = Number(tm.prompt_n); }
            }
            // an edge only for a response seen happening: the end the tap replays on connect is not flagged
            if (r.live || r.liveDelta) { s.edgeAt = now; return 'end'; }
        }
        return null;
    }

    function rates(now) {
        const cut = now - windowMs;
        while (s.frames.length && s.frames[0].t < cut) s.frames.shift();
        const cur = s.curId != null ? s.resps.get(s.curId) : null;
        const inFlight = !!(cur && !cur.done && cur.t0 != null && now - cur.t0 < INFLIGHT_MAX_MS);
        const lastResp = s.lastDeltaId != null ? s.resps.get(s.lastDeltaId) : null;
        const generating = s.lastDeltaAt > 0 && now - s.lastDeltaAt < genIdleMs && !(lastResp && lastResp.done);
        const active = inFlight || (s.lastEventAt > 0 && now - s.lastEventAt < activeIdleMs);

        let gen = 0, genSrc = null;
        if (generating) {
            const fr = s.frames.filter((f) => f.id === s.lastDeltaId);
            const span = fr.length >= 2 ? fr[fr.length - 1].t - fr[0].t : 0;
            const charRate = span >= MIN_SPAN_MS ? fr.slice(1).reduce((a, f) => a + f.chars, 0) / (span / 1000) : null;
            if (charRate != null && s.cpt != null) { gen = charRate / s.cpt; genSrc = 'stream'; }
            else if (s.lastPredTps) { gen = s.lastPredTps; genSrc = 'last'; }
            else if (charRate != null) { gen = charRate / DEFAULT_CPT; genSrc = 'stream~'; }
        }
        const prefill = active && s.lastPromptTps ? s.lastPromptTps : 0;
        const phase = inFlight && cur && !cur.firstDeltaAt ? 'prefill' : generating ? 'gen' : active ? 'busy' : 'idle';
        // The request in flight, in AGES (ms before `now`), never clock times: the browser draws "reading for 14 s" from
        // these plus how long ago it got the answer, so neither machine's clock has to agree with the other's.
        // reqAgeMs: since it was sent; firstTokenMs: from sending to its first streamed token (the read, as the agent saw it).
        const reqAgeMs = inFlight ? Math.max(0, now - cur.t0) : null;
        const firstTokenMs = inFlight && cur.firstDeltaAt ? Math.max(0, cur.firstDeltaAt - cur.t0) : null;
        return { gen: round1(gen), prefill: round1(prefill), phase, active, genSrc, cpt: s.cpt != null ? +s.cpt.toFixed(2) : null,
            lastPredTps: s.lastPredTps, lastPromptTps: s.lastPromptTps, lastPromptN: s.lastPromptN,
            lastReadTps: s.lastReadTps != null ? round1(s.lastReadTps) : null, lastReadN: s.lastReadN, reqAgeMs, firstTokenMs,
            edgeAt: s.edgeAt || null };
    }

    return { feed, rates, reset };
}

const round1 = (x) => Math.round((Number(x) || 0) * 10) / 10;

// A lane's card, in words, when nothing better is known: the card name its runner published (runtime_json `gpu`,
// shortened by lib/topology.js shortName: "RX 7900 XTX", "RTX 4090 Laptop"), else the lane's own name. server4.js
// asks first where the lane's processes hold VRAM and what its device list resolves to on this machine
// (topology.laneCards); this is the fallback before either is known. No card is named here.
function gpuShort(runtime, _itemLabel, lane) {
    const g = runtime && typeof runtime.gpu === 'string' ? runtime.gpu.trim() : '';
    if (g) return shortName(g);
    return String(lane || '?').replace(/^local-/, '');
}
// ["RX 7900 XTX #1", "RX 7900 XTX #2"] -> "2x RX 7900 XTX"; ["RTX 3060", "RX 7900 XTX"] -> "RTX 3060 + RX 7900 XTX".
function joinCardLabels(labels) {
    const list = [...new Set((labels || []).filter(Boolean))];
    if (list.length < 2) return list[0] || null;
    const base = list.map((l) => l.replace(/ #\d+$/, ''));
    return base.every((b) => b === base[0]) ? `${list.length}x ${base[0]}` : list.join(' + ');
}
// /props build_info: llama-server "b10499-6d0549831", Strata "Strata 0.1.30".
function engineOf(props) {
    const b = props && typeof props.build_info === 'string' ? props.build_info : '';
    if (/strata/i.test(b) || /strata/i.test((props && props.model_path) || '')) return 'Strata';
    return b ? 'llama' : null;
}

// Strata GET /metrics -> an engine sample. `live` (sampled 2026-10-01): state reading|generating|idle;
// generating carries tok_s over tok_s_window_s (2 s, the sidebar's tg_3s semantics) and `generated` (tokens so far);
// reading carries prefill_tok_s_mean once its first chunk is in (null before) and prompt_read/prompt_total.
// Every sample below has the same shape, whichever engine it came from (2026-10-22: the Live transcript's prefill /
// generation strip reads it): read / total = tokens of this request's prompt read so far / to read (prefill),
// generated = tokens of its answer so far (generation), null where the engine does not say.
// ctx / ctxMax (2026-10-22, Monitor's per-request samples): the context the request holds now -- Strata: the whole
// prompt (live.prompt_tokens, cached part included) plus what it has generated; llama: lib/slots.js ctx.used -- and the
// server's context size (Strata engine.context; llama n_ctx). Null while idle.
function parseStrataLive(j, now) {
    const l = j && j.live;
    if (!l || typeof l.state !== 'string') return null;
    const nz = (v) => (Number(v) > 0 ? Number(v) : null);
    const n0 = (v) => (v != null && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : null);
    const e = (j && j.engine) || {};
    const ctxMax = nz(e.context) ?? nz(e.max_context);
    const ctx = nz(l.prompt_tokens) != null ? Number(l.prompt_tokens) + (n0(l.generated) || 0) : null;
    if (l.state === 'generating') return { at: now, src: 'metrics', phase: 'gen', gen: nz(l.tok_s) ?? 0, prefill: null, generated: n0(l.generated), ctx, ctxMax };
    if (l.state === 'reading') {
        const progress = Number(l.prompt_total) > 0 && l.prompt_read != null ? Math.min(1, Number(l.prompt_read) / Number(l.prompt_total)) : null;
        return { at: now, src: 'metrics', phase: 'prefill', gen: 0, prefill: nz(l.prefill_tok_s_mean), progress, read: n0(l.prompt_read), total: nz(l.prompt_total), ctx, ctxMax };
    }
    if (l.state === 'idle') return { at: now, src: 'metrics', phase: 'idle', gen: 0, prefill: null, ctx: null, ctxMax };
    return { at: now, src: 'metrics', phase: 'busy', gen: null, prefill: null, ctx, ctxMax };
}
// lib/slots.js stepSlots() output -> an engine sample. Its prefill rate only moves once per 2048-token
// ubatch (a short prefill never registers), hence prefill:null -> laneRates falls back to the tap's
// exact per-request rate.
function slotsSample(out, now) {
    if (!out) return null;
    const c = out.ctx || {};
    const ctx = c.busy && Number(c.used) > 0 ? Number(c.used) : null, ctxMax = Number(c.limit) > 0 ? Number(c.limit) : null;
    if (out.gen) return { at: now, src: 'slots', phase: 'gen', gen: out.gen.instTps, prefill: null, generated: out.gen.nDecoded ?? null, ctx, ctxMax };
    if (out.prefill) return { at: now, src: 'slots', phase: 'prefill', gen: 0, prefill: out.prefill.instTps, progress: out.prefill.progress, read: out.prefill.nTokens ?? null, total: out.prefill.total ?? null, ctx, ctxMax };
    if (out.ctx && out.ctx.busy) return { at: now, src: 'slots', phase: 'busy', gen: null, prefill: null, ctx, ctxMax };
    return { at: now, src: 'slots', phase: 'idle', gen: 0, prefill: null, ctx: null, ctxMax };
}
const SAMPLE_FRESH_MS = 2500;
// One lane's numbers: the engine's live sample when fresh, the tap meter's otherwise.
//   gen:     engine says generating -> its rate; prefilling/idle -> 0 (exact: it is not decoding);
//            unknown ('busy' -- e.g. llama's first tick of a request) or stale -> the meter.
//   prefill: engine mid-read with a live rate -> that; else the meter's latest exact
//            prompt_per_second while the lane is active.
// A sample taken before the tap's latest edge (m.edgeAt: a request sent, its first token, its end) describes the moment
// before it, so the meter speaks until the engine's next sample (~1 s): the phase flips with the tap, not a poll later.
function laneRates(m, sample, now) {
    const fresh = sample && now - sample.at < SAMPLE_FRESH_MS && !(m.edgeAt && sample.at < m.edgeAt) ? sample : null;
    let gen = m.gen, genSrc = m.genSrc, prefill = m.prefill, prefillSrc = m.prefill ? 'tap' : null, phase = m.phase;
    if (fresh) {
        if (fresh.gen != null) { gen = fresh.gen; genSrc = fresh.src; }
        if (fresh.phase === 'prefill' && fresh.prefill) { prefill = fresh.prefill; prefillSrc = fresh.src; }
        if (fresh.phase === 'gen' || fresh.phase === 'prefill') phase = fresh.phase;
        else if (fresh.phase === 'idle') phase = m.active ? 'busy' : 'idle';   // between turns: the agent is running a tool
    }
    // read / total / generated only from a fresh sample in the matching phase: a stale count would be the last request's
    const now1 = (k, ph) => (fresh && fresh.phase === ph && fresh[k] != null ? fresh[k] : null);
    return { ...m, gen: round1(gen), genSrc, prefill: round1(prefill), prefillSrc, phase,
        progress: fresh && fresh.progress != null ? fresh.progress : null,
        read: now1('read', 'prefill'), total: now1('total', 'prefill'), generated: now1('generated', 'gen'),
        ctx: fresh && fresh.ctx != null ? fresh.ctx : null, ctxMax: sample && sample.ctxMax != null ? sample.ctxMax : null };
}

// server4.js laneInfo() -> the local lanes busy now: a tap_port in runtime_json (cloud's is {}) and a
// queue item running. Sorted so the breakdown keeps its order from poll to poll.
function busyLocalLanes(info) {
    const running = (info && info.running) || {}, taps = (info && info.taps) || {};
    return Object.keys(running).filter((lane) => Number(taps[lane]) > 0).sort();
}

// [{lane, label, ...rates}] -> the sidebar's numbers. `combined` needs 2+ lanes: with one, the
// existing single-server path keeps the cards exactly as before.
function combine(lanes) {
    const list = (lanes || []).filter(Boolean);
    const gen = round1(list.reduce((a, l) => a + (Number(l.gen) || 0), 0));
    const prefill = round1(list.reduce((a, l) => a + (Number(l.prefill) || 0), 0));
    const text = (k) => list.map((l) => `${l.label} ${Math.round(Number(l[k]) || 0)}`).join(' · ');
    return { combined: list.length >= 2, gen, prefill, genText: text('gen'), prefillText: text('prefill'), lanes: list };
}

module.exports = { createLaneMeter, combine, busyLocalLanes, gpuShort, joinCardLabels, engineOf, deltaChars, parseStrataLive, slotsSample, laneRates, SAMPLE_FRESH_MS,
    WINDOW_MS, GEN_IDLE_MS, ACTIVE_IDLE_MS, DEFAULT_CPT, MIN_PROMPT_N };
