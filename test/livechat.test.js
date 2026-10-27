'use strict';
// Live chat: codebench's SSE delta parser (tools/sse-delta.js, used by tools/record-proxy.js --tap),
// the shared reducer (ui/livechat/model.js) and the relay (lib/livechat.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const http = require('http');
const model = require('../ui/livechat/model.js');
const { createRelay } = require('../lib/livechat');

// The parser lives in the codebench checkout (the proxy runs from there); skip if it is absent.
const parserPath = path.join(require('../lib/codebench').getConfig().root, 'tools', 'sse-delta.js');
const haveParser = fs.existsSync(parserPath);
const sse = haveParser ? require(parserPath) : null;
const skipParser = haveParser ? false : `no codebench checkout at ${parserPath}`;

const chunk = (delta, finish = null, extra = {}) => `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`;

// ------------------------------------------------------------------ parser
test('parser: reasoning, content and tool-call deltas from llama-server chunks', { skip: skipParser }, () => {
    const p = sse.createParser();
    const got = [];
    for (const c of [
        chunk({ role: 'assistant', content: null }),
        chunk({ reasoning_content: 'Let me ' }),
        chunk({ reasoning_content: 'think.' }),
        chunk({ content: 'Running ' }),
        chunk({ tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'bash', arguments: '' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '{"command":' } }] }),
        chunk({ tool_calls: [{ index: 0, function: { arguments: '"ls"}' } }] }),
        chunk({}, 'tool_calls'),
        `data: ${JSON.stringify({ choices: [], usage: { completion_tokens: 9 }, timings: { predicted_per_second: 42 } })}\n\n`,
        'data: [DONE]\n\n',
    ]) got.push(...p.push(Buffer.from(c)));
    got.push(...p.end());
    assert.deepEqual(got.filter((d) => d.reasoning).map((d) => d.reasoning), ['Let me ', 'think.']);
    assert.deepEqual(got.filter((d) => d.content).map((d) => d.content), ['Running ']);
    const t = p.total();
    assert.equal(t.reasoning, 'Let me think.');
    assert.equal(t.content, 'Running ');
    assert.deepEqual(t.tool_calls, [{ index: 0, id: 'call_1', name: 'bash', arguments: '{"command":"ls"}' }]);
    assert.equal(t.finish, 'tool_calls');
    assert.deepEqual(t.usage, { completion_tokens: 9 });
    assert.equal(t.timings.predicted_per_second, 42);
});

test('parser: a data: line split across chunks is parsed once, when complete', { skip: skipParser }, () => {
    const p = sse.createParser();
    const s = chunk({ content: 'hello world' }) + chunk({ content: '!' });
    const out = [];
    for (let i = 0; i < s.length; i += 7) out.push(...p.push(Buffer.from(s.slice(i, i + 7))));
    assert.deepEqual(out.map((d) => d.content), ['hello world', '!']);
});

test('parser: a multi-byte UTF-8 character cut between chunks survives', { skip: skipParser }, () => {
    const p = sse.createParser();
    const b = Buffer.from(chunk({ content: 'naïve → 日本' }));
    const cut = b.indexOf(Buffer.from('→')) + 1;          // inside the 3-byte arrow
    const out = [...p.push(b.subarray(0, cut)), ...p.push(b.subarray(cut))];
    assert.equal(out[0].content, 'naïve → 日本');
});

test('parser: CRLF lines, comments, junk and a final line without newline', { skip: skipParser }, () => {
    const p = sse.createParser();
    const out = [...p.push(': keepalive\r\n\r\n'), ...p.push('data: {not json}\r\n\r\n'),
        ...p.push(`data: ${JSON.stringify({ choices: [{ delta: { content: 'a' } }] })}\r\n\r\n`),
        ...p.push(`data: ${JSON.stringify({ choices: [{ delta: { content: 'b' }, finish_reason: 'stop' }] })}`)];
    out.push(...p.end());
    assert.deepEqual(out.map((d) => d.content), ['a', 'b']);
    assert.equal(p.total().finish, 'stop');
});

test('parser: a non-stream JSON body is parsed at end()', { skip: skipParser }, () => {
    const p = sse.createParser();
    const body = JSON.stringify({ choices: [{ finish_reason: 'stop', message: { role: 'assistant', content: 'Title', reasoning_content: 'hm' } }], usage: { prompt_tokens: 3 } });
    assert.deepEqual(p.push(Buffer.from(body.slice(0, 10))), []);
    p.push(Buffer.from(body.slice(10)));
    const out = p.end();
    assert.equal(out.length, 1);
    assert.equal(out[0].content, 'Title');
    assert.equal(out[0].reasoning, 'hm');
    assert.equal(p.total().finish, 'stop');
});

test('parser: parallel tool calls merge by index', { skip: skipParser }, () => {
    const acc = {};
    sse.mergeDelta(acc, { tool_calls: [{ index: 0, id: 'a', name: 'read', arguments: '{"p' }, { index: 1, id: 'b', name: 'bash' }] });
    sse.mergeDelta(acc, { tool_calls: [{ index: 1, arguments: '{}' }, { index: 0, arguments: '":1}' }] });
    assert.deepEqual(acc.tool_calls, [{ index: 0, id: 'a', name: 'read', arguments: '{"p":1}' }, { index: 1, id: 'b', name: 'bash', arguments: '{}' }]);
});

// ------------------------------------------------------------------ reducer
const sys = { role: 'system', content: 'You are an agent.' };
const user = { role: 'user', content: [{ type: 'text', text: 'Fix the bug.' }] };
const req = (over) => ({ type: 'request', id: 1, thread: 1, prefix: 0, delta: [sys, user], n_messages: 2, tools: ['bash'], model: 'm', ...over });

test('reducer: request, streamed deltas, end, then the echoed message keeps its reasoning', () => {
    const s = model.fresh();
    assert.equal(model.apply(s, req()).kind, 'reset');
    let items = model.view(s);
    assert.deepEqual(items.map((i) => i.role), ['system', 'user', 'assistant']);
    assert.equal(items[1].text, 'Fix the bug.');
    assert.ok(items[2].live);
    assert.equal(model.apply(s, { type: 'delta', id: 1, reasoning: 'hmm ' }).kind, 'delta');
    model.apply(s, { type: 'delta', id: 1, reasoning: 'ok', content: 'Look:' });
    model.apply(s, { type: 'delta', id: 1, tool_calls: [{ index: 0, id: 'c1', name: 'bash', arguments: '{"command"' }] });
    model.apply(s, { type: 'delta', id: 1, tool_calls: [{ index: 0, arguments: ':"ls"}' }] });
    assert.equal(model.apply(s, { type: 'end', id: 1, finish: 'tool_calls', usage: { completion_tokens: 5 } }).kind, 'end');
    items = model.view(s);
    assert.equal(items[2].reasoning, 'hmm ok');
    assert.equal(items[2].text, 'Look:');
    assert.deepEqual(items[2].tool_calls[0], { index: 0, id: 'c1', name: 'bash', arguments: '{"command":"ls"}' });
    assert.equal(s.resp.finish, 'tool_calls');

    // The agent sends it back (without reasoning_content) plus the tool result.
    const asst = { role: 'assistant', content: 'Look:', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] };
    model.apply(s, req({ id: 2, prefix: 2, delta: [asst, { role: 'tool', tool_call_id: 'c1', content: 'a.js\nb.js' }], n_messages: 4 }));
    items = model.view(s);
    assert.deepEqual(items.map((i) => i.role), ['system', 'user', 'assistant', 'tool', 'assistant']);
    assert.equal(items[2].reasoning, 'hmm ok', 'reasoning of the streamed turn is re-attached to the echoed message');
    assert.ok(!items[2].live);
    assert.equal(model.toolNameFor(items, 'c1'), 'bash');
    assert.ok(items[4].live);
});

test('reducer: side requests (no tools, other thread) do not replace the main conversation', () => {
    const s = model.fresh();
    model.apply(s, req());
    const r = model.apply(s, { type: 'request', id: 2, thread: 2, prefix: 0, delta: [{ role: 'user', content: 'title?' }], n_messages: 1, tools: [] });
    assert.equal(r.kind, 'side');
    assert.equal(s.thread, 1);
    model.apply(s, { type: 'delta', id: 2, content: 'A title' });
    assert.equal(s.side.content, 'A title');
    assert.equal(model.apply(s, { type: 'delta', id: 99, content: 'x' }).kind, 'none');
});

test('reducer: a prefix beyond what we know is a gap, a new thread resets, hello forgets', () => {
    const s = model.fresh();
    model.apply(s, req());
    model.apply(s, req({ id: 2, prefix: 9, delta: [{ role: 'tool', content: 'x' }], n_messages: 10 }));
    assert.equal(s.gap, true);
    assert.equal(s.base, 9);
    assert.equal(model.view(s)[0].index, 9);
    model.apply(s, req({ id: 3, thread: 5 }));
    assert.equal(s.gap, false);
    assert.equal(s.messages.length, 2);
    model.apply(s, { type: 'tap', up: true, port: 1 });
    model.apply(s, { type: 'hello' });
    assert.equal(s.messages.length, 0);
    assert.equal(s.tap.up, true, 'hello keeps the tap status');
});

test('reducer: snapshot replaces the state (JSON round trip)', () => {
    const a = model.fresh();
    model.apply(a, req());
    model.apply(a, { type: 'delta', id: 1, content: 'hi' });
    const b = model.fresh();
    model.apply(b, { type: 'snapshot', state: JSON.parse(JSON.stringify(a)) });
    assert.deepEqual(model.view(b), model.view(a));
});

test('reducer: replayed request carries past reasoning', () => {
    const s = model.fresh();
    model.apply(s, req({ id: 7, prefix: 0, replay: true, delta: [sys, user, { role: 'assistant', content: 'x' }, { role: 'tool', content: 'y' }], n_messages: 4, reasoning: { 2: 'earlier thought' } }));
    const items = model.view(s);
    assert.equal(items[2].reasoning, 'earlier thought');
});

// ------------------------------------------------------------------ relay
function listen(server) { return new Promise((r) => server.listen(0, '127.0.0.1', () => r(server.address().port))); }
function readSse(port, pathName, onEvent) {
    return new Promise((resolve) => {
        const req = http.get({ host: '127.0.0.1', port, path: pathName }, (res) => {
            let buf = '';
            res.setEncoding('utf8');
            res.on('data', (c) => {
                buf += c; let i;
                while ((i = buf.indexOf('\n\n')) !== -1) {
                    const f = buf.slice(0, i); buf = buf.slice(i + 2);
                    for (const l of f.split('\n')) if (l.startsWith('data:')) onEvent(JSON.parse(l.slice(5)));
                }
            });
            resolve(req);
        });
    });
}
const until = async (fn, ms = 3000) => { const t0 = Date.now(); while (!fn()) { if (Date.now() - t0 > ms) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 20)); } };

test('relay: dials the tap only while a client watches, snapshots late joiners, relays events', async () => {
    let tapRes = null; let dials = 0;
    const tap = http.createServer((q, r) => {
        dials++;
        r.writeHead(200, { 'Content-Type': 'text/event-stream' });
        r.write(`data: ${JSON.stringify({ type: 'hello' })}\n\n`);
        r.write(`data: ${JSON.stringify(req())}\n\n`);
        tapRes = r;
    });
    const tapPort = await listen(tap);
    const relay = createRelay({ port: tapPort, getCtx: () => ({ task: 't1' }) });
    const web = http.createServer((q, r) => relay.attach(q, r));
    const webPort = await listen(web);
    try {
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(dials, 0, 'nobody watching: the tap is not dialled');
        const a = [];
        const ca = await readSse(webPort, '/api/livechat', (e) => a.push(e));
        await until(() => a.some((e) => e.type === 'request'));
        assert.equal(a[0].type, 'snapshot');
        assert.equal(dials, 1);
        tapRes.write(`data: ${JSON.stringify({ type: 'delta', id: 1, reasoning: 'thinking', content: 'Hel' })}\n\n`);
        tapRes.write(`data: ${JSON.stringify({ type: 'delta', id: 1, content: 'lo' })}\n\n`);
        await until(() => relay.getState().resp && relay.getState().resp.content === 'Hello');
        // A second client connecting now gets the conversation and the response so far.
        const b = [];
        const cb = await readSse(webPort, '/api/livechat', (e) => b.push(e));
        await until(() => b.length > 0);
        const s = model.fresh();
        model.apply(s, b[0]);
        const items = model.view(s);
        assert.equal(items.length, 3);
        assert.equal(items[2].text, 'Hello');
        assert.equal(items[2].reasoning, 'thinking');
        assert.equal(s.tap.up, true);
        assert.deepEqual(s.ctx, { task: 't1' });
        assert.equal(dials, 1, 'one tap connection for any number of clients');
        ca.destroy(); cb.destroy();
    } finally {
        web.close(); tap.closeAllConnections(); tap.close(); web.closeAllConnections();
    }
});
