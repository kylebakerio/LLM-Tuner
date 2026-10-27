'use strict';
// --- EXTERNAL SERVER: live rates from llama-server's GET /slots ---
// A llama-server LL-Dash did not spawn (benchmark queues, codebench batteries)
// never reaches the stdout parser in server4.js, so the telemetry cards sat at
// 0.0 t/s for the whole run. /slots works on every server (/metrics is off by
// default), so server4.js polls it at ~1 Hz and feeds each response through
// stepSlots() below, which turns counter snapshots into the same numbers the
// managed path derives from progress lines:
//
//   prefill: n_prompt_tokens_processed -- steps once per ubatch (2048 tokens
//            at a time), so between steps it reads flat. The instantaneous
//            rate is the delta between the last two CHANGES, held until the
//            next one (same as differencing consecutive progress lines);
//            differencing every 1s tick would read 2048 t/s, 0, 0, 0...
//   gen:     next_token[0].n_decoded -- per token, plain per-tick delta.
//   context: n_prompt_tokens is the slot's absolute position on current
//            builds (it grows during generation, matching cache + processed +
//            decoded); older builds kept it at the prompt length. max() of the
//            two reads right on both.
//
// Deltas are only taken within one id_task; a new task or is_processing going
// false finalizes the request into `last` and starts clean. Pure (no I/O);
// unit-tested in test/slots.test.js.

// The slot to follow: the one already being tracked if it is still busy, else
// the first busy one, else the tracked one (to see it go idle), else slot 0.
function pickSlot(slots, trackedId) {
    if (!Array.isArray(slots) || slots.length === 0) return null;
    const tracked = trackedId != null ? slots.find((s) => s && s.id === trackedId) : null;
    if (tracked && tracked.is_processing) return tracked;
    return slots.find((s) => s && s.is_processing) || tracked || slots[0] || null;
}

function num(v) {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
}

// Fresh per-request tracking state for a slot that is processing `taskId`.
function beginRequest(slotId, taskId, processed, decoded, nowMs) {
    return {
        slotId, taskId,
        // prefill: first observation + last observed change of the counter
        pFirst: { v: processed, t: nowMs }, pLast: { v: processed, t: nowMs }, pInst: null, pAvg: null,
        // gen: anchored at the first sample where decoding had started
        gFirst: decoded > 0 ? { v: decoded, t: nowMs } : null, gPrev: { v: decoded, t: nowMs }, gInst: null, gAvg: null,
        processed, decoded,
    };
}

// The request's final numbers, for the "avg" fields between requests.
function finalize(req) {
    if (!req) return null;
    // A phase seen for only one delta has no average yet -- its one rate is it.
    const promptTps = req.pAvg != null ? req.pAvg : req.pInst;
    const genTps = req.gAvg != null ? req.gAvg : req.gInst;
    if (promptTps == null && genTps == null) return null; // never saw it move -- nothing to report
    return {
        taskId: req.taskId,
        promptTps, promptTokens: req.processed || null,
        genTps, genTokens: req.decoded || null,
    };
}

// One poll step. `prev` is the previous return's `state` (or null). Returns
//   { state, prefill, gen, ctx, finished }
// prefill: { progress, cumTps, instTps, nTokens, total } while the prompt is being
//          processed and a rate is known, else null (total: the tokens this
//          request has to read, the prompt less what the cache already holds)
// gen:     { avgTps, instTps, nDecoded } once decoding has a rate, else null
// ctx:     { used, limit, busy } for any slot with an n_ctx, else null
// finished: the request that just ended ({ taskId, promptTps, genTps, ... }),
//          set on exactly the step that ended it, else null
function stepSlots(prev, slots, nowMs) {
    const state = { req: prev ? prev.req : null, last: prev ? prev.last : null };
    const slot = pickSlot(slots, state.req ? state.req.slotId : null);
    let finished = null;
    if (!slot) {
        finished = finalize(state.req);
        return { state: { req: null, last: finished || state.last }, prefill: null, gen: null, ctx: null, finished };
    }

    const busy = !!slot.is_processing;
    const nPrompt = num(slot.n_prompt_tokens);
    const processed = num(slot.n_prompt_tokens_processed);
    const cache = num(slot.n_prompt_tokens_cache);
    const nt = Array.isArray(slot.next_token) ? slot.next_token[0] : slot.next_token;
    const decoded = num(nt && nt.n_decoded);
    const ctx = slot.n_ctx ? { used: Math.max(nPrompt, cache + processed + decoded), limit: num(slot.n_ctx), busy } : null;

    // Request boundary: task changed, slot changed, or the slot went idle.
    const req = state.req;
    if (req && (!busy || req.taskId !== slot.id_task || req.slotId !== slot.id)) {
        finished = finalize(req);
        if (finished) state.last = finished;
        state.req = null;
    }
    if (!busy) return { state, prefill: null, gen: null, ctx, finished };
    if (!state.req) {
        state.req = beginRequest(slot.id, slot.id_task, processed, decoded, nowMs);
        return { state, prefill: null, gen: null, ctx, finished };
    }

    const r = { ...state.req, processed, decoded };
    state.req = r;
    let prefill = null;
    let gen = null;

    // Prefill: rate between the last two changes of the (ubatch-stepped) counter.
    if (processed > r.pLast.v) {
        const dT = (nowMs - r.pLast.t) / 1000;
        if (dT > 0.01) r.pInst = (processed - r.pLast.v) / dT;
        const dTAll = (nowMs - r.pFirst.t) / 1000;
        if (dTAll > 0.01) r.pAvg = (processed - r.pFirst.v) / dTAll;
        r.pLast = { v: processed, t: nowMs };
    }
    if (decoded === 0 && r.pInst != null) {
        const toDo = Math.max(1, nPrompt - cache);
        prefill = {
            progress: Math.min(1, Math.max(0, processed / toDo)),
            cumTps: r.pAvg, instTps: r.pInst, nTokens: processed, total: toDo,
        };
    }

    // Gen: plain per-tick delta; average from the first decoding sample.
    if (decoded > 0) {
        if (!r.gFirst) r.gFirst = { v: decoded, t: nowMs };
        const dT = (nowMs - r.gPrev.t) / 1000;
        if (dT > 0.01 && decoded >= r.gPrev.v) r.gInst = (decoded - r.gPrev.v) / dT;
        const dTAll = (nowMs - r.gFirst.t) / 1000;
        if (dTAll > 0.01 && decoded > r.gFirst.v) r.gAvg = (decoded - r.gFirst.v) / dTAll;
        if (r.gInst != null) gen = { avgTps: r.gAvg != null ? r.gAvg : r.gInst, instTps: r.gInst, nDecoded: decoded };
    }
    r.gPrev = { v: decoded, t: nowMs };

    return { state, prefill, gen, ctx, finished };
}

module.exports = { stepSlots, pickSlot };
