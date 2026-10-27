'use strict';
// Bench -> Live -> transcript: what the reader opens STAYS open (2026-10-22, Kyle: "when I expand it, it self-collapses
// right after, a repeat of previous issues we've dealt with in this section... please add code comments explaining why
// this bug keeps re-appearing"). The rule is in ui/benchmarks/util.js above createOpenChoices. These tests pin it:
//   - lib/codebench.js gives every transcript event a stable `key`, the same whichever order the merged list is in
//     (the running list and the finished one put the same event at different indices: that is what broke it in 10-20);
//   - the transcript view keys its blocks by that key and puts the reader's choices back after any rebuild;
//   - the running task's box opens what the live chat opens (the "collapsed by default" half of the complaint);
//   - the prefill / generation strip's words come from one formatter over the lanes record.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { parseHTML } = require('linkedom');
const C = require('../lib/codebench');

const ROOT = path.join(__dirname, 'fixtures', 'subagents');
const DIR = 'sub-mock', TASK = 'two-explorers';
const TDIR = path.join(ROOT, 'results', DIR, TASK);

// The fixture's two files fed as they grew in the real run (as test/subagents.test.js does), merged while running,
// then once more as finished.
function runningThenFinished() {
    const parentLines = fs.readFileSync(path.join(TDIR, 'opencode.jsonl'), 'utf-8').trim().split('\n');
    const subLines = fs.readFileSync(path.join(TDIR, 'subagents', 'stream.jsonl'), 'utf-8').trim().split('\n');
    const P = C.createTranscriptParser('opencode'), S = C.createTranscriptParser('opencode');
    const pr = { parser: P }, sr = { parser: S };
    const steps = [[parentLines.slice(0, 3), []], [[], subLines.slice(0, 2)], [[], subLines.slice(2, 10)], [parentLines.slice(3, 6), subLines.slice(10)], [parentLines.slice(6), []]];
    let running = null;
    const at = `/x/${Math.random()}/opencode.jsonl`;   // one transcript: the running merge appends, the finished one rebuilds
    for (const [pl, sl] of steps) {
        for (const l of pl) P.feed(l);
        for (const l of sl) S.feed(l);
        running = C.mergeSubagentEvents(at, pr, sr, true).events.map((e) => ({ ...e }));
    }
    const finished = C.mergeSubagentEvents(at, pr, sr, false).events.map((e) => ({ ...e }));
    return { running, finished };
}

test('every event has a stable key: the same event keeps it when the merged list is re-ordered; `i` does not', () => {
    const { running, finished } = runningThenFinished();
    assert.equal(running.length, finished.length);
    for (const list of [running, finished]) {
        assert.ok(list.every((e) => typeof e.key === 'string' && e.key), 'every event carries a key');
        assert.equal(new Set(list.map((e) => e.key)).size, list.length, 'keys are unique');
    }
    const byKey = new Map(finished.map((e) => [e.key, e]));
    let moved = 0;
    for (const e of running) {
        const f = byKey.get(e.key);
        assert.ok(f, `${e.key} is in both lists`);
        assert.deepEqual([f.kind, f.sub, f.id, f.text, f.output], [e.kind, e.sub, e.id, e.text, e.output], `${e.key} names the same event`);
        if (f.i !== e.i) moved++;
    }
    assert.ok(moved > 0, 'the re-order really moves events (why `i` must never key UI state)');
    // a result is named after its call (a view draws its output under the call's identity, wherever it sits)
    const call = finished.find((e) => e.kind === 'tool_call' && e.id);
    assert.equal(finished.find((e) => e.kind === 'tool_result' && e.id === call.id).key, call.key + ':result');
    // a transcript without sub-agents gets keys too
    const plain = C.getTranscript(DIR, TASK, { root: ROOT, which: null });
    assert.ok(plain.events.every((e) => e.key));
});

// ---- the transcript view in a DOM, fed by a stub server ----
async function viewHarness() {
    const { window, document } = parseHTML('<!doctype html><html><body><div id="root"></div></body></html>');
    // linkedom has no `open` property on <details>: the attribute, as a browser reflects it
    Object.defineProperty(window.HTMLElement.prototype, 'open', { configurable: true,
        get() { return this.tagName === 'DETAILS' ? this.hasAttribute('open') : undefined; },
        set(v) { if (this.tagName === 'DETAILS') { if (v) this.setAttribute('open', ''); else this.removeAttribute('open'); } } });
    const answers = [];
    globalThis.fetch = async (url) => {
        const a = answers.length > 1 ? answers.shift() : answers[0];
        return { ok: true, status: 200, json: async () => a(url) };
    };
    const T = await import('../ui/benchmarks/transcript.js');
    return { window, document, root: document.getElementById('root'), answers, T };
}
const page = (events, running) => () => ({ dir: DIR, task: TASK, runner: 'opencode', events, total: events.length, next_from: events.length, truncated: false, running,
    stats: { runner: 'opencode' }, subagents: { sub_agents: 2, events: 10 } });
const clickOpen = (window, d) => {   // what a reader's click does: the summary's click (recorded), then the toggle
    d.querySelector('summary').dispatchEvent(new window.Event('click', { bubbles: true }));
    d.open = !d.open;
};
const openKeys = (root) => [...root.querySelectorAll('details[data-key]')].filter((d) => d.open).map((d) => d.dataset.key).sort();

test('REGRESSION: blocks the reader opened or closed stay that way when the stream is rebuilt in another order', async () => {
    const { window, root, answers, T } = await viewHarness();
    const { running, finished } = runningThenFinished();
    answers.push(page(running, true));
    const tv = T.createTranscriptView(root, { streamOnly: true, live: true });
    await tv.open({ dir: DIR, task: TASK });
    tv.stop();
    const blocks = [...root.querySelectorAll('details[data-key]')];
    assert.ok(blocks.length >= 6, 'something to click');
    // the reader opens every thinking block (folded by default) and closes the first tool output (open by default)
    const thinking = blocks.filter((d) => /Thinking/.test(d.querySelector('summary').textContent));
    const output = blocks.find((d) => /:out$/.test(d.dataset.key) && d.open);
    for (const d of thinking) clickOpen(window, d);
    clickOpen(window, output);
    const want = openKeys(root);
    assert.ok(want.length && !want.includes(output.dataset.key));
    // the task "ends" (or the server answers `running: false`): the stream is read again, every event at another index
    answers.length = 0; answers.push(page(finished, false));
    await tv.open({ dir: DIR, task: TASK });
    assert.deepEqual(openKeys(root), want, 'the same blocks are open, matched by what they are, not where they are');
    // and a brand-new view of the same task (Live empties and rebuilds its box when it moves away and back)
    const again = T.createTranscriptView(root, { streamOnly: true, live: true });
    await again.open({ dir: DIR, task: TASK });
    again.stop();
    assert.deepEqual(openKeys(root), want);
});

test('the running task\'s box opens what the live chat opens; a finished task keeps its compact defaults', async () => {
    const T = await import('../ui/benchmarks/transcript.js');
    const { finished } = runningThenFinished();
    const doc = parseHTML('<!doctype html><html><body><div id="r"></div></body></html>').document;
    const draw = (live) => { const r = doc.getElementById('r'); r.innerHTML = T.renderStream(finished, { dir: 'd' + live, task: 't', live }); return r; };
    const r1 = draw(true);
    const opened = (r) => [...r.querySelectorAll('details[data-key]')].filter((d) => d.hasAttribute('open')).map((d) => d.dataset.key.split(':').slice(-1)[0]);
    const liveOpen = opened(r1);
    assert.ok(liveOpen.includes('out'), 'tool outputs are open (the chat showed every result)');
    assert.ok(liveOpen.includes('in'), 'short arguments are open (the chat opened arguments up to 240 chars)');
    assert.ok(liveOpen.includes('prompt'), 'a sub-agent\'s prompt is open (the chat shows every user message)');
    assert.ok(![...r1.querySelectorAll('details.reasoning-container')].some((d) => d.hasAttribute('open')), 'thinking stays folded, as in the chat once the answer starts');
    assert.deepEqual(opened(draw(false)), [], 'a finished task: as compact as before');
});

test('the store: choices by key, applied to new nodes, and only the reader\'s clicks are recorded', async () => {
    const U = await import('../ui/benchmarks/util.js');
    const { window, document } = parseHTML('<!doctype html><html><body><div id="h"><details data-key="a"><summary>s</summary>x</details></div></body></html>');
    Object.defineProperty(window.HTMLElement.prototype, 'open', { configurable: true,
        get() { return this.tagName === 'DETAILS' ? this.hasAttribute('open') : undefined; },
        set(v) { if (this.tagName === 'DETAILS') { if (v) this.setAttribute('open', ''); else this.removeAttribute('open'); } } });
    const st = U.createOpenChoices(3);
    const host = document.getElementById('h');
    st.watch(host);
    host.querySelector('summary').dispatchEvent(new window.Event('click', { bubbles: true }));
    assert.equal(st.get('a'), true, 'a click on a closed block records "open"');
    host.innerHTML = '<details data-key="a"><summary>s</summary>x</details><details data-key="b" open><summary>s</summary>y</details>';
    st.applyAll(host);
    assert.equal(host.querySelector('[data-key=a]').open, true, 'a node drawn new gets the choice back');
    assert.equal(host.querySelector('[data-key=b]').open, true, 'untouched blocks keep their default');
    for (const k of ['c', 'd', 'e']) st.set(k, true);
    assert.equal(st.get('a'), undefined, 'bounded: the oldest choice goes first');
});

test('the prefill / generation strip: one formatter over the lanes record, whichever engine it came from', async () => {
    const { livePhase } = await import('../ui/benchmarks/util.js');
    assert.equal(livePhase(null), null);
    assert.equal(livePhase({ phase: 'idle' }), null);
    // reading with the engine's own counters (Strata `metrics`, llama `slots`): a real fraction, a rate, time, what is left
    const p = livePhase({ phase: 'prefill', read: 12288, total: 40960, prefill: 812, prefillSrc: 'metrics', reqAgeMs: 14000 }, 1000);
    assert.equal(p.phase, 'prefill'); assert.equal(Math.round(p.pct), 30);
    assert.match(p.text, /reading the prompt · 12,288 \/ 40,960 tokens \(30%\) · 812 t\/s · 15s · ~35s left/);
    // reading, no total from the engine (a first ubatch not in yet): no fraction (the strip animates instead), last rate named as such
    const q = livePhase({ phase: 'prefill', prefill: 729, prefillSrc: 'tap', lastReadTps: 729, reqAgeMs: 3000 });
    assert.equal(q.pct, null);
    assert.match(q.text, /reading the prompt · last read ran at 729 t\/s · 3s/);
    assert.doesNotMatch(q.text, /tokens/);
    // generating: tokens so far, rate, time since the first token, and this request's read when it was watched
    const g = livePhase({ phase: 'gen', gen: 45.24, generated: 1234, reqAgeMs: 30000, firstTokenMs: 12000 }, 0, { read: 40960, total: 40960, tps: 812 });
    assert.match(g.text, /generating · 1,234 tokens · 45\.2 t\/s · 18s · prompt: 40,960 tokens at 812 t\/s in 12s/);
    assert.match(livePhase({ phase: 'gen', gen: 30, reqAgeMs: 5000, firstTokenMs: 2000 }).text, /first token after 2s/);
    assert.match(livePhase({ phase: 'busy', lastPromptTps: 413, lastPromptN: 5161, lastPredTps: 24 }).text, /between requests · last read 413 t\/s \(5,161 tokens\) · last generation 24\.0 t\/s/);
});
