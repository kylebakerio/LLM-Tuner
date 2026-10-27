'use strict';
// Sub-agents inline (2026-10-20, Kyle: "have the sub agent transcripts output to the live transcript as if they were all
// part of the same flow, with some indicator that these were 'sub agent n'"). The harness streams every opencode
// sub-agent session to <task>/subagents/stream.jsonl (codebench harness/runners/opencode.py SubagentStream); lib/codebench.js
// merges it into the task's transcript events, and ui/benchmarks/transcript.js draws them inline, labelled.
// The fixture is a real opencode 1.18.34 run through the real harness against a scripted mock model (two parallel
// `task` calls, an @explore and a @general sub-agent, each one glob then a report).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../lib/codebench');

const ROOT = path.join(__dirname, 'fixtures', 'subagents');
const DIR = 'sub-mock', TASK = 'two-explorers';
const TDIR = path.join(ROOT, 'results', DIR, TASK);

test.beforeEach(() => { C._resetForTests(); C.configure({ root: ROOT, python: 'python3' }); });

test('parser: a sub-agent stream line keeps its kind and carries its label; the start marker is a `subagent` event', () => {
    const lines = fs.readFileSync(path.join(TDIR, 'subagents', 'stream.jsonl'), 'utf-8');
    const evs = C.parseTranscript(lines, 'opencode');
    const marks = evs.filter((e) => e.kind === 'subagent');
    assert.deepEqual(marks.map((e) => e.sub), ['1', '2']);
    assert.equal(marks[0].agent, 'explore'); assert.equal(marks[0].description, 'probe one'); assert.match(marks[0].text, /SUBTASK-1/);
    assert.ok(marks[0].parent_call && marks[1].parent_call && marks[0].parent_call !== marks[1].parent_call);
    assert.ok(evs.every((e) => e.sub === '1' || e.sub === '2'), 'every event is labelled');
    assert.ok(evs.some((e) => e.kind === 'tool_call' && e.tool === 'glob' && e.sub === '2' && e.sub_agent === 'general'));
    // the parent stream alone is unchanged: no labels, no markers
    const parent = C.parseTranscript(fs.readFileSync(path.join(TDIR, 'opencode.jsonl'), 'utf-8'), 'opencode');
    assert.ok(parent.every((e) => e.sub == null && e.kind !== 'subagent'));
});

test('getTranscript: a finished run reads as one flow in time order, each task call before its sub-agent, results after', () => {
    const t = C.getTranscript(DIR, TASK, { root: ROOT });
    assert.equal(t.subagents.sub_agents, 2);
    const parentOnly = C.parseTranscript(fs.readFileSync(path.join(TDIR, 'opencode.jsonl'), 'utf-8'), 'opencode');
    assert.equal(t.total, parentOnly.length + t.subagents.events);
    assert.deepEqual(t.events.map((e) => e.i), t.events.map((_, k) => k), 'indices are the merged positions');
    // the parent's own numbers are the parent's
    assert.equal(t.stats.tool_calls, 2);
    for (const label of ['1', '2']) {
        const mark = t.events.find((e) => e.kind === 'subagent' && e.sub === label);
        const call = t.events.find((e) => e.kind === 'tool_call' && e.tool === 'task' && e.id === mark.parent_call);
        const result = t.events.find((e) => e.kind === 'tool_result' && e.id === mark.parent_call);
        const own = t.events.filter((e) => e.sub === label);
        assert.ok(call.i < mark.i, `sub-agent ${label}: its task call comes first`);
        assert.ok(own.every((e) => e.i > call.i), `sub-agent ${label}: all of it after the call`);
        assert.ok(own.filter((e) => e.kind !== 'subagent').every((e) => e.i < result.i), `sub-agent ${label}: its work before the call's result`);
        assert.ok(own.every((e) => e.t_s != null && e.t_s >= 0), 'sub-agent times are on the parent\'s clock');
    }
    // the parent's final answer is last
    assert.equal(t.events[t.events.length - 1].sub, undefined);
    // paging is a window on the same merged stream
    const p = C.getTranscript(DIR, TASK, { root: ROOT, from: 5, limit: 4 });
    assert.deepEqual(p.events, t.events.slice(5, 9));
});

test('getTranscript: sub-agents started by another transcript\'s task calls (a verify turn) stay out of this one', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-sub-'));
    try {
        const d = path.join(tmp, 'results', DIR, TASK);
        fs.mkdirSync(path.join(d, 'subagents'), { recursive: true });
        fs.copyFileSync(path.join(TDIR, 'opencode.jsonl'), path.join(d, 'opencode.jsonl'));
        // the same sub-agent stream, but a verify transcript that made no task call of its own
        fs.copyFileSync(path.join(TDIR, 'subagents', 'stream.jsonl'), path.join(d, 'subagents', 'stream.jsonl'));
        const last = JSON.parse(fs.readFileSync(path.join(TDIR, 'opencode.jsonl'), 'utf-8').trim().split('\n').pop());
        const v = [{ type: 'text', timestamp: last.timestamp + 1000, sessionID: last.sessionID, part: { type: 'text', text: 'verified', time: { start: last.timestamp + 900, end: last.timestamp + 1000 } } }];
        fs.writeFileSync(path.join(d, 'verify.opencode.jsonl'), v.map((o) => JSON.stringify(o)).join('\n') + '\n');
        const main = C.getTranscript(DIR, TASK, { root: tmp });
        assert.equal(main.subagents.sub_agents, 2);
        const ver = C.getTranscript(DIR, TASK, { root: tmp, which: 'verify' });
        assert.equal(ver.total, 1); assert.equal(ver.events[0].text, 'verified');
        assert.equal(ver.subagents.sub_agents, 0);
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('getTranscript: a run killed mid-`task` (timeout, watchdog, stop-now) still shows its sub-agents once finished', () => {
    // opencode writes a task's line only when the sub-agent is done: cut the parent before both task lines, as a
    // timeout would, and add the harness's marker line
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-sub-'));
    try {
        const d = path.join(tmp, 'results', DIR, TASK);
        fs.mkdirSync(path.join(d, 'subagents'), { recursive: true });
        const lines = fs.readFileSync(path.join(TDIR, 'opencode.jsonl'), 'utf-8').trim().split('\n');
        const cut = lines.findIndex((l) => JSON.parse(l).type === 'tool_use');
        fs.writeFileSync(path.join(d, 'opencode.jsonl'), lines.slice(0, cut).join('\n') + '\n\n[codebench] TIMEOUT\n');
        fs.copyFileSync(path.join(TDIR, 'subagents', 'stream.jsonl'), path.join(d, 'subagents', 'stream.jsonl'));
        const t = C.getTranscript(DIR, TASK, { root: tmp });
        assert.equal(t.running, false);
        assert.equal(t.subagents.sub_agents, 2);
        assert.equal(t.subagents.events, 16, 'every event of both sub-agents (18 stream lines; a step_start makes no event)');
        assert.ok(!t.events.some((e) => e.kind === 'tool_call' && e.tool === 'task'), 'no task line in the cut transcript');
    } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
});

test('mergeSubagentEvents: while the task runs, the list only ever grows at the end (the views poll by index)', () => {
    const parentLines = fs.readFileSync(path.join(TDIR, 'opencode.jsonl'), 'utf-8').trim().split('\n');
    const subLines = fs.readFileSync(path.join(TDIR, 'subagents', 'stream.jsonl'), 'utf-8').trim().split('\n');
    const P = C.createTranscriptParser('opencode'), S = C.createTranscriptParser('opencode');
    const pr = { parser: P }, sr = { parser: S };
    // the order the files grew in the real run: parent's first step, the sub-agents' work, then the task results
    const steps = [[parentLines.slice(0, 3), []], [[], subLines.slice(0, 2)], [[], subLines.slice(2, 10)], [parentLines.slice(3, 6), subLines.slice(10)], [parentLines.slice(6), []]];
    let held = [];
    for (const [pl, sl] of steps) {
        for (const l of pl) P.feed(l);
        for (const l of sl) S.feed(l);
        const m = C.mergeSubagentEvents('/x/opencode.jsonl', pr, sr, true);
        assert.ok(m.events.length >= held.length);
        for (let k = 0; k < held.length; k++) assert.deepEqual(m.events[k], held[k], `event ${k} moved while running`);
        held = m.events.map((e) => ({ ...e }));
    }
    assert.equal(held.length, P.events.length + S.events.length);
    assert.equal(held.filter((e) => e.kind === 'subagent').length, 2);
    // once finished: rebuilt once, in full time order (the task calls move before their sub-agents)
    const fin = C.mergeSubagentEvents('/x/opencode.jsonl', pr, sr, false);
    const call1 = fin.events.findIndex((e) => e.kind === 'tool_call' && e.tool === 'task');
    const mark1 = fin.events.findIndex((e) => e.kind === 'subagent');
    assert.ok(call1 < mark1);
});

test('subagentStreamPath sits beside the transcript, inside subagents/ (never a *.jsonl the task-dir scans pick up)', () => {
    assert.equal(C.subagentStreamPath('/r/b/t/opencode.jsonl'), path.join('/r/b/t', 'subagents', 'stream.jsonl'));
    assert.equal(C.subagentStreamPath(null), null);
    assert.equal(C.transcriptLocation(DIR, TASK, ROOT).path, path.join(TDIR, 'opencode.jsonl'));
});

test('transcript view: sub-agent events are drawn inline, indented and labelled "sub-agent N"; the task call names its sub-agent', async () => {
    const T = await import('../ui/benchmarks/transcript.js');
    const t = C.getTranscript(DIR, TASK, { root: ROOT });
    const st = { dir: DIR, task: TASK };
    const html = T.renderStream(t.events, st);
    assert.match(html, /sub-agent 1 started/); assert.match(html, /sub-agent 2 started/);
    assert.match(html, /data-sub="1"/); assert.match(html, /data-sub="2"/);
    assert.equal(st.subCalls.size, 2);
    assert.match(html, /sub-agent 1 <span[^>]*>→ inline/, 'the parent task call carries the label of the sub-agent it started');
    assert.notEqual(T.subHue('1'), T.subHue('2')); assert.equal(T.subHue('2.1'), T.subHue('2'));
    // a run with no sub-agents renders exactly as before: no groups, no badges
    const plain = T.renderStream(t.events.filter((e) => !e.sub), { dir: DIR, task: TASK });
    assert.doesNotMatch(plain, /data-sub=/);
});
