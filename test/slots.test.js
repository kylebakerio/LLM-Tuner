'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { stepSlots, pickSlot } = require('../lib/slots');

// A /slots entry shaped like llama-server's (only the fields stepSlots reads).
const slot = (over = {}) => ({
    id: 0, n_ctx: 65536, is_processing: true, id_task: 2,
    n_prompt_tokens: 18334, n_prompt_tokens_processed: 0, n_prompt_tokens_cache: 14238,
    next_token: [{ n_decoded: 0, n_remain: 16384 }],
    ...over,
});
const dec = (n) => ({ next_token: [{ n_decoded: n }] });

// Feeds [tMs, slotOverrides] pairs through stepSlots, returning every step.
function run(steps) {
    let state = null;
    return steps.map(([t, over]) => {
        const out = stepSlots(state, over === null ? [] : [slot(over)], t);
        state = out.state;
        return out;
    });
}

test('prefill rate comes from the last two CHANGES of the ubatch-stepped counter, held in between', () => {
    const out = run([
        [0, { n_prompt_tokens_processed: 0 }],
        [1000, { n_prompt_tokens_processed: 0 }],
        [2000, { n_prompt_tokens_processed: 2048 }],  // 2048 tokens over 2s
        [3000, { n_prompt_tokens_processed: 2048 }],  // flat tick: rate held, not 0
        [3000 + 1024, { n_prompt_tokens_processed: 4096 }], // 2048 over 2.024s
    ]);
    assert.equal(out[0].prefill, null); // first sight: no delta yet
    assert.equal(out[1].prefill, null); // nothing has moved
    assert.equal(out[2].prefill.instTps, 1024);
    assert.equal(out[2].prefill.nTokens, 2048);
    assert.equal(out[2].prefill.progress, 2048 / (18334 - 14238));
    assert.equal(out[2].prefill.total, 18334 - 14238, 'what this request has to read: the prompt less the cached part (2026-10-22)');
    assert.equal(out[3].prefill.instTps, 1024);
    assert.ok(Math.abs(out[4].prefill.instTps - 2048 / 2.024) < 1e-9);
    assert.equal(out[4].prefill.cumTps, 4096 / 4.024);
    assert.equal(out[4].prefill.progress, 1);
});

test('gen rate is the per-tick n_decoded delta; the average anchors at the first decoding sample', () => {
    const out = run([
        [0, { n_prompt_tokens_processed: 4096, ...dec(10) }],
        [1000, { n_prompt_tokens_processed: 4096, ...dec(40) }],
        [2000, { n_prompt_tokens_processed: 4096, ...dec(60) }],
    ]);
    assert.equal(out[0].gen, null);
    assert.deepEqual(out[1].gen, { avgTps: 30, instTps: 30, nDecoded: 40 });
    assert.deepEqual(out[2].gen, { avgTps: 25, instTps: 20, nDecoded: 60 });
    assert.equal(out[2].prefill, null); // decoding: no prefill emission
});

test('a new id_task resets the deltas and finalizes the previous request', () => {
    const out = run([
        [0, { id_task: 5, ...dec(0) }],
        [1000, { id_task: 5, ...dec(50) }],
        [2000, { id_task: 5, ...dec(100) }],
        [3000, { id_task: 6, n_prompt_tokens_processed: 512, ...dec(0) }],
        [4000, { id_task: 6, n_prompt_tokens_processed: 1024, ...dec(0) }],
    ]);
    assert.deepEqual(out[3].finished, { taskId: 5, promptTps: null, promptTokens: null, genTps: 50, genTokens: 100 });
    assert.equal(out[3].prefill, null);       // new task's first sight: no cross-task delta
    assert.equal(out[3].gen, null);
    assert.equal(out[4].prefill.instTps, 512); // measured within task 6 only
    assert.equal(out[4].state.last.taskId, 5); // kept for the avg fields
});

test('is_processing false ends the request; idle steps report context but no rates', () => {
    const out = run([
        [0, { ...dec(0) }],
        [1000, { ...dec(20) }],
        [2000, { ...dec(40) }],
        [3000, { is_processing: false, ...dec(41) }],
        [4000, { is_processing: false, ...dec(41) }],
    ]);
    assert.equal(out[3].finished.genTps, 20);
    assert.equal(out[3].gen, null);
    assert.equal(out[4].finished, null); // only on the step that ended it
    assert.equal(out[4].state.last.genTps, 20);
    assert.equal(out[4].ctx.busy, false);
});

test('context used covers both n_prompt_tokens semantics', () => {
    // Current builds: n_prompt_tokens is the live position (cache + processed + decoded).
    let [o] = run([[0, { n_prompt_tokens: 33115, n_prompt_tokens_processed: 7126, n_prompt_tokens_cache: 24838, ...dec(1149) }]]);
    assert.deepEqual(o.ctx, { used: 33115, limit: 65536, busy: true });
    // Older builds: n_prompt_tokens stays at the prompt length.
    [o] = run([[0, { n_prompt_tokens: 2048, n_prompt_tokens_processed: 2048, n_prompt_tokens_cache: 0, ...dec(300) }]]);
    assert.equal(o.ctx.used, 2348);
});

test('no slots (server gone) finalizes the in-flight request', () => {
    const out = run([[0, { ...dec(0) }], [1000, { ...dec(30) }], [2000, null]]);
    assert.equal(out[2].finished.genTps, 30);
    assert.equal(out[2].ctx, null);
});

test('pickSlot follows the busy slot, preferring the one already tracked', () => {
    const slots = [{ id: 0, is_processing: false }, { id: 1, is_processing: true }, { id: 2, is_processing: true }];
    assert.equal(pickSlot(slots, null).id, 1);
    assert.equal(pickSlot(slots, 2).id, 2);
    assert.equal(pickSlot([{ id: 0, is_processing: false }, { id: 1, is_processing: false }], 1).id, 1);
    assert.equal(pickSlot([], null), null);
});
