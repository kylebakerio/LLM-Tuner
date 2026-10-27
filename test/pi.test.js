// The pi runner (harness/runners/pi.py: the pi coding agent, optionally with NVIDIA's SoL-Pi):
// its transcript through the full parser (the Transcript view), the live tail stats (the Live
// view and its plan panel), the transcript/verify lookup, the harness labels ("pi" vs
// "pi + SoL-Pi") and lib/models.js's handling of pi's scaffold.
// Real sample: test/fixtures/codebench/transcripts/pi.jsonl (a mock-model run, cb_t on every line,
// one truncated line spliced in) and verify.pi.jsonl (its verify-on-fail turn, from before cb_t).
// SoL-Pi's update_plan / then_run and pi's error / retry / compaction lines are not in the real
// sample, so they are hand-written below in the shapes pi --mode json and SoL-Pi document.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const C = require('../lib/codebench.js');
const M = require('../lib/models.js');

const TDIR = path.join(__dirname, 'fixtures', 'codebench', 'transcripts');
const PI = fs.readFileSync(path.join(TDIR, 'pi.jsonl'), 'utf-8');
const PI_VERIFY = fs.readFileSync(path.join(TDIR, 'verify.pi.jsonl'), 'utf-8');
const J = (o) => JSON.stringify(o);

test('pi transcript (real sample): prompt, tool calls paired with their results by toolCallId, the edit diff, thinking, per-message usage summed, cb_t timeline', () => {
    const { events, stats } = C.parseTranscriptFull(PI, 'pi');
    assert.equal(stats.runner, 'pi');
    assert.equal(stats.malformed, 1);                            // the spliced truncated line
    assert.equal(events[0].kind, 'prompt'); assert.equal(events[0].text, 'Change x to 2 in a.py');
    // every call is seen three times in the file (toolCall block, tool_execution_start, toolResult message): once here
    const calls = events.filter((e) => e.kind === 'tool_call');
    assert.deepEqual(calls.map((e) => e.tool), ['bash', 'read', 'edit']);
    assert.deepEqual(calls.map((e) => e.id), ['call_b492cd2d', 'call_f2a28b83', 'call_39511369']);
    assert.match(calls[0].input, /"command": "ls -la"/);
    assert.match(calls[2].input, /"oldText": "x = 1"/);
    const results = events.filter((e) => e.kind === 'tool_result');
    assert.equal(results.length, 3);                             // tool_execution_end, not also the toolResult message
    for (const r of results) { const c = calls.find((x) => x.id === r.id); assert.ok(c && c.i < r.i); assert.equal(c.tool, r.tool); }
    assert.match(results[0].output, /a\.py/);
    assert.equal(results[1].output, 'x = 1\n');
    assert.match(results[2].output, /^Successfully replaced 1 block\(s\) in a\.py\.\n\n-1 x = 1\n\+1 x = 2$/);   // details.diff appended
    assert.ok(events.some((e) => e.kind === 'reasoning' && e.text === 'I should edit a.py'));
    assert.ok(events.some((e) => e.kind === 'text' && e.text === 'Done. Changed x to 2.'));
    // one turn finish per assistant message (toolUse x3, stop), then agent_settled's visible finish
    const fin = events.filter((e) => e.kind === 'finish');
    assert.deepEqual(fin.map((f) => [f.reason, !!f.turn]), [['toolUse', true], ['toolUse', true], ['toolUse', true], ['stop', true], ['stop', false]]);
    assert.deepEqual(fin[0].tokens, { in: 1000, out: 50, reasoning: null, cache_read: 0, cache_write: 0 });
    // tokens_in = input + cacheRead summed over messages, exactly as PiTracker records the row
    assert.equal(stats.tokens_in, 1000 + 1100 + 1200 + 1300); assert.equal(stats.tokens_out, 200);
    assert.equal(stats.tool_calls, 3); assert.equal(stats.tool_results, 3); assert.equal(stats.unpaired_tool_calls, 0);
    assert.equal(stats.done, true); assert.equal(stats.finish_reason, 'stop'); assert.equal(stats.last_text, 'Done. Changed x to 2.');
    // cb_t: the session line is t0, the rest are seconds after it
    assert.equal(stats.t_source, 'timestamps'); assert.equal(stats.t_approx, false);
    assert.equal(events[0].t_s, 0); assert.equal(stats.duration_s, 0.1);
    // detected without being told the runner, too
    assert.equal(C.parseTranscriptFull(PI).stats.runner, 'pi');
});

test('pi transcript before cb_t (the verify turn): time falls back to message.timestamp against the session line', () => {
    const { events, stats } = C.parseTranscriptFull(PI_VERIFY, 'pi');
    assert.equal(events[0].kind, 'prompt'); assert.match(events[0].text, /verify your work/);
    assert.equal(events[0].t_s, 2.1);                            // 1790393392373 ms vs the session's 03:29:50.297Z
    assert.equal(stats.t_source, 'timestamps');
    assert.equal(stats.tokens_in, 1300); assert.equal(stats.tokens_out, 50); assert.equal(stats.done, true);
    assert.ok(stats.skipped >= 4);                               // session / agent_start / turn_start / entry_appended
});

// Hand-written: SoL-Pi's update_plan and then_run, an errored tool, a cut-off message, an API error,
// a retry, a compaction, stderr, the harness's TIMEOUT, and a toolResult message whose
// tool_execution_end is missing.
const SYN = [
    { type: 'session', version: 3, id: 's', timestamp: '2026-09-26T00:00:00.000Z', cwd: '/home/kyle/Code/x', cb_t: 1000 },
    { type: 'message_end', message: { role: 'user', content: [{ type: 'text', text: 'Fix it' }] }, cb_t: 1000 },
    { type: 'message_end', message: { role: 'assistant', content: [
        { type: 'thinking', thinking: 'plan first' },
        { type: 'toolCall', id: 'p1', name: 'update_plan', arguments: { steps: [{ id: '1', goal: 'Read the code', status: 'in_progress' }, { id: '2', goal: 'Fix the bug', status: 'pending' }] } }],
        usage: { input: 100, output: 10, cacheRead: 900, cacheWrite: 0, reasoning: 4 }, stopReason: 'toolUse' }, cb_t: 2000 },
    { type: 'tool_execution_start', toolCallId: 'p1', toolName: 'update_plan', args: {}, cb_t: 2000 },
    { type: 'tool_execution_end', toolCallId: 'p1', toolName: 'update_plan', result: { content: [{ type: 'text', text: 'Plan recorded' }] }, isError: false, cb_t: 2100 },
    { type: 'message_end', message: { role: 'assistant', content: [
        { type: 'toolCall', id: 'e1', name: 'edit', arguments: { path: 'a.js', edits: [{ oldText: 'a', newText: 'b' }], then_run: { command: 'npm test' } } }],
        usage: { input: 50, output: 20, cacheRead: 1000 }, stopReason: 'toolUse' }, cb_t: 3000 },
    { type: 'tool_execution_end', toolCallId: 'e1', toolName: 'edit', result: { content: [{ type: 'text', text: 'Successfully replaced 1 block(s) in a.js.\n\n[then_run:failed]\n\n1 failing' }] }, isError: true, cb_t: 4000 },
    { type: 'message_end', message: { role: 'assistant', content: [
        { type: 'toolCall', id: 'p2', name: 'update_plan', arguments: { steps: [{ id: '1', goal: 'Read the code', status: 'completed' }, { id: '2', goal: 'Fix the bug', status: 'in_progress' }] } }],
        usage: { input: 10, output: 5, cacheRead: 0 }, stopReason: 'toolUse' }, cb_t: 5000 },
    { type: 'message_end', message: { role: 'toolResult', toolCallId: 'p2', toolName: 'update_plan', content: [{ type: 'text', text: 'Progress boundary recorded' }], isError: false }, cb_t: 5100 },
    { type: 'compaction_start', reason: 'threshold', cb_t: 6000 },
    { type: 'compaction_end', reason: 'threshold', aborted: false, cb_t: 6500 },
    { type: 'auto_retry_start', attempt: 1, maxAttempts: 3, errorMessage: '503 upstream', cb_t: 7000 },
    { type: 'auto_retry_end', success: true, cb_t: 7500 },
    { type: 'message_end', message: { role: 'assistant', content: [{ type: 'text', text: 'Half an ans' }], usage: { input: 5, output: 4096, cacheRead: 0 }, stopReason: 'length' }, cb_t: 8000 },
    { type: 'message_end', message: { role: 'assistant', content: [], usage: { input: 0, output: 0 }, stopReason: 'error', errorMessage: 'context overflow' }, cb_t: 9000 },
    { type: 'stderr', text: 'node: warning', cb_t: 9100 },
    { type: 'codebench', text: 'TIMEOUT', cb_t: 10000 },
].map(J).join('\n');

test('pi transcript (hand-written): update_plan is a tool call the plan checklist reads, then_run is in the edit input, errors / cut-off / retry / compaction / TIMEOUT are markers', () => {
    const { events, stats } = C.parseTranscriptFull(SYN, 'pi');
    const byId = (id, kind) => events.find((e) => e.id === id && e.kind === kind);
    assert.equal(byId('p1', 'tool_call').tool, 'update_plan'); assert.match(byId('p1', 'tool_call').input, /"goal": "Read the code"/);
    assert.equal(byId('p1', 'tool_result').output, 'Plan recorded');
    assert.match(byId('e1', 'tool_call').input, /"then_run"/);
    const e1 = byId('e1', 'tool_result'); assert.equal(e1.error, true); assert.match(e1.output, /\[then_run:failed\]/);
    assert.equal(byId('p2', 'tool_result').output, 'Progress boundary recorded');   // from the toolResult message: no tool_execution_end for it
    assert.equal(stats.tool_errors, 1);
    const kinds = events.map((e) => e.kind);
    assert.ok(kinds.includes('compaction')); assert.equal(events.find((e) => e.kind === 'compaction').text, 'threshold');
    assert.ok(events.some((e) => e.kind === 'finish' && e.reason === 'length'));      // the UI's CUT OFF marker
    const errs = events.filter((e) => e.kind === 'error').map((e) => e.text);
    assert.deepEqual(errs, ['retry 1/3: 503 upstream', 'context overflow', 'stderr: node: warning', 'codebench: TIMEOUT']);
    assert.equal(stats.done, true);                              // TIMEOUT ends it
    assert.equal(stats.tokens_in, 100 + 900 + 50 + 1000 + 10 + 5); assert.equal(stats.tokens_out, 10 + 20 + 5 + 4096); assert.equal(stats.tokens_thinking, 4);
    assert.equal(events.find((e) => e.kind === 'reasoning').text, 'plan first');
    assert.equal(events[1].t_s, 1);                              // cb_t 2000 vs the session's 1000
});

test('pi tail stats (Live view): tool calls counted once per toolCallId, errors, tokens, last text, and update_plan as the plan panel todos', () => {
    const s = C.transcriptStats('pi', SYN);
    assert.equal(s.format, 'pi');
    assert.equal(s.tool_calls, 3); assert.equal(s.tool_errors, 1);
    assert.equal(s.tokens_in, 2065); assert.equal(s.tokens_out, 4131);
    assert.equal(s.last_text, 'Half an ans'); assert.equal(s.last_tool, 'update_plan'); assert.equal(s.done, true);
    assert.equal(s.todo_updates, 2); assert.equal(s.todos.length, 2);
    assert.equal(s.last_todo.tool, 'update_plan'); assert.equal(s.last_todo.input.steps[1].status, 'in_progress');
    // the real sample, and the runner detected from the lines when it is not given
    const r = C.transcriptStats(null, PI);
    assert.equal(r.tool_calls, 3); assert.equal(r.tokens_in, 4600); assert.equal(r.tokens_out, 200);
    assert.equal(r.last_text, 'Done. Changed x to 2.'); assert.equal(r.last_tool, 'edit'); assert.equal(r.done, true); assert.equal(r.lines_total, 22);
});

test('pi transcript lookup: <task>/pi.jsonl and verify.pi.jsonl, with the row scaffold for the harness label', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-pi-'));
    try {
        const dir = path.join(root, 'results', 'pi-solpi-fixture'); const td = path.join(dir, 'demo-task');
        fs.mkdirSync(td, { recursive: true });
        fs.writeFileSync(path.join(td, 'pi.jsonl'), PI); fs.writeFileSync(path.join(td, 'verify.pi.jsonl'), PI_VERIFY);
        fs.writeFileSync(path.join(dir, 'demo-task.json'), J({ task: 'demo-task', runner: 'pi', model: 'llama-local/qwen', status: 'fail',
            manifest: { runner: 'pi', model: 'llama-local/qwen', scaffold: 'sol-pi' }, run: { transcript: path.join(td, 'pi.jsonl') }, score: {} }));
        // the row carries it too (pi.py writes it to the manifest only, not run.scaffold)
        const row = C.getRun('pi-solpi-fixture', root).rows.find((r) => r.task === 'demo-task');
        assert.equal(row.scaffold, 'sol-pi'); assert.equal(row.rowConfig.config.scaffold, 'sol-pi'); assert.equal(row.runner, 'pi');
        const loc = C.transcriptLocation('pi-solpi-fixture', 'demo-task', root);
        assert.equal(loc.runner, 'pi'); assert.equal(path.basename(loc.path), 'pi.jsonl');
        const t = C.getTranscript('pi-solpi-fixture', 'demo-task', { root });
        assert.equal(t.runner, 'pi'); assert.equal(t.scaffold, 'sol-pi'); assert.equal(t.total, 14); assert.equal(t.stats.tool_calls, 3);
        const v = C.getTranscript('pi-solpi-fixture', 'demo-task', { root, which: 'verify' });
        assert.equal(path.basename(v.transcript), 'verify.pi.jsonl'); assert.equal(v.runner, 'pi'); assert.equal(v.events[0].kind, 'prompt');
    } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('lib/models.js: pi + SoL-Pi is the same model (weights) as plain pi, but a separate config in the harness facet', () => {
    const base = { key: 'local:qwen3.8-27b:q4-k-xl', display: 'Qwen3.8-27B Q4_K_XL', provider: 'local' };
    assert.equal(M.withScaffold(base, 'sol-pi', 'pi').key, base.key);
    assert.equal(M.withScaffold(base, 'none', 'pi').key, base.key);
    const cloud = { key: 'cloud:claude-haiku-4-5@low', display: 'Claude Haiku 4.5 (low)', provider: 'cloud' };
    assert.equal(M.withScaffold(cloud, 'default', 'claude').key, 'cloud:claude-haiku-4-5@low/default');   // claude's advisor still folds
    const run = (scaffold) => ({ dir: `pi-${scaffold}`, config: { runner: 'pi', model: 'llama-local/qwen', scaffold }, server: { n_ctx: 131072, model_path: '/m/q4.gguf', launch_command: '/bin/llama-server -m /m/q4.gguf -c 131072' } });
    const a = M.runDescriptor(run('none'), 'local', base.key), b = M.runDescriptor(run('sol-pi'), 'local', base.key);
    assert.notEqual(a.identity('quality'), b.identity('quality'));
    assert.notEqual(a.identity('full'), b.identity('full'));
    assert.equal(a.runner, 'pi'); assert.equal(b.scaffold, 'sol-pi');
    // and an opencode run of the same weights is a third config, not a merge with plain pi
    const oc = M.runDescriptor({ ...run(null), config: { runner: 'opencode', model: 'llama-local/qwen', scaffold: null } }, 'local', base.key);
    assert.notEqual(oc.identity('quality'), a.identity('quality'));
});

test('UI helpers: harness labels, the update_plan checklist, and the then_run summary', async () => {
    const U = await import('../ui/benchmarks/util.js');
    assert.equal(U.harnessLabel('pi', 'sol-pi'), 'pi + SoL-Pi');
    assert.equal(U.harnessLabel('pi', 'none'), 'pi');
    assert.equal(U.harnessLabel('pi', null), 'pi');
    assert.equal(U.harnessLabel('claude', 'solo'), 'claude');
    assert.equal(U.scaffoldBit('pi', 'sol-pi'), null); assert.equal(U.scaffoldBit('claude', 'solo'), 'solo');
    assert.match(U.configLine({ runner: 'pi', model: 'llama-local/q', scaffold: 'sol-pi' }, null), /pi \+ SoL-Pi/);
    assert.match(U.configLine({ runner: 'pi', model: 'llama-local/q', scaffold: 'none' }, null), />pi<\/b>/); assert.doesNotMatch(U.configLine({ runner: 'pi', model: 'llama-local/q', scaffold: 'none' }, null), />none</);
    const T = await import('../ui/shared/todos.js');
    const td = T.parseTodos('update_plan', { steps: [{ id: '1', goal: 'Read', status: 'completed' }, { id: '2', goal: 'Fix', status: 'in_progress' }, { id: '3', goal: 'Test', status: 'pending' }] });
    assert.deepEqual(td.items.map((i) => [i.content, i.status]), [['Read', 'completed'], ['Fix', 'in_progress'], ['Test', 'pending']]);
    assert.equal(td.done, 1); assert.equal(td.total, 3); assert.equal(td.current.content, 'Fix');
    const X = await import('../ui/benchmarks/transcript.js');
    assert.equal(X.toolSummary(JSON.stringify({ path: 'src/a.js', edits: [], then_run: { command: 'npm test' } })), 'src/a.js → then: npm test');
    assert.equal(X.toolSummary(JSON.stringify({ path: 'src/a.js' })), 'src/a.js');
});

test('lib/models.js: thinking off and non-opencode harnesses are their own local rows (Kyle, 2026-10-01)', () => {
    const base = { key: 'local:qwen3.8-27b:q4-k-xl', display: 'Qwen3.8-27B Q4_K_XL', provider: 'local' };
    const run = (runner, cmd, scaffold) => ({ config: { runner, scaffold }, server: { launch_command: cmd } });
    const lc = '/bin/llama-server -m /m/q4.gguf -c 131072';
    assert.equal(M.withLocalVariant(base, run('opencode', lc)).key, base.key);                       // the default setup keeps the plain row
    assert.equal(M.withLocalVariant(base, run('opencode', lc + ' --reasoning off --port 8080')).key, base.key + '~nothink');
    assert.equal(M.withLocalVariant(base, run('opencode', lc + ' -rea off')).display, 'Qwen3.8-27B Q4_K_XL (thinking off)');
    assert.equal(M.withLocalVariant(base, run('pi', lc, 'none')).key, base.key + '~pi');
    assert.equal(M.withLocalVariant(base, run('pi', lc), 'sol-pi').display, 'Qwen3.8-27B Q4_K_XL (pi + SoL-Pi)');
    assert.equal(M.withLocalVariant(base, run('opencode', lc + ' --reasoning-format deepseek')).key, base.key);   // other reasoning flags are not "off"
    const cloud = { key: 'cloud:claude-opus-5-5@high', display: 'Claude Opus 5.5 (high)', provider: 'cloud' };
    assert.equal(M.withLocalVariant(cloud, run('claude', '--reasoning off')).key, cloud.key);       // cloud keys already carry effort
});
