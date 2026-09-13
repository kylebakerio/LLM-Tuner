import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { McClient } from '../src/client.js';

function waitFor(cond, ms, what) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const iv = setInterval(() => {
      if (cond()) { clearInterval(iv); resolve(); }
      else if (Date.now() - start > ms) { clearInterval(iv); reject(new Error(`timeout waiting for ${what}`)); }
    }, 25);
  });
}

test('SSE: parses data frames, ignores heartbeats, reconnects after drop', async (t) => {
  const events = [];
  const connStates = [];
  let seq = 0;
  const server = http.createServer((req, res) => {
    if (req.url !== '/api/status') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ state: 'ready', model: `m${seq++}`, log: '' })}\n\n`);
    res.write(': ping\n\n'); // heartbeat comment -- must be ignored
    res.write(`data: ${JSON.stringify({ state: 'ready', model: `m${seq++}`, log: 'GEN_PROGRESS:21.5:19.2:100' })}\n\n`);
    setTimeout(() => res.end(), 150); // drop the connection -> client must reconnect
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;

  const client = new McClient(url, {
    onEvent: (e) => events.push(e),
    onConnState: (c) => connStates.push(c),
  });
  client.connect();
  t.after(() => { client.close(); server.close(); });

  await waitFor(() => events.length >= 2, 3000, 'first-connection events');
  assert.equal(events[0].model, 'm0');
  assert.equal(events[1].log, 'GEN_PROGRESS:21.5:19.2:100');
  assert.equal(connStates[0], 'connecting');
  assert.ok(connStates.includes('live'), 'reported live');

  // after the drop, the client reconnects (1s backoff) and receives m2/m3
  await waitFor(() => events.length >= 4, 6000, 'reconnected events');
  assert.equal(events[2].model, 'm2');
  assert.equal(events[3].log, 'GEN_PROGRESS:21.5:19.2:100');
  assert.ok(connStates.includes('reconnecting'), 'reported reconnecting');
});

test('SSE: close() stops reconnecting', async (t) => {
  const events = [];
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ state: 'ready', model: 'x', log: '' })}\n\n`);
    setTimeout(() => res.end(), 50);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;

  const client = new McClient(url, { onEvent: (e) => events.push(e) });
  client.connect();
  t.after(() => { client.close(); server.close(); });
  await waitFor(() => events.length >= 1, 3000, 'first event');
  client.close();
  await new Promise((r) => setTimeout(r, 1500)); // > 1s backoff; no reconnect expected
  assert.equal(events.length, 1, 'no events after close');
});

test('REST: getJson/postJson surface errors cleanly', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url === '/ok') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: true, echo: req.method }));
    }
    if (req.url === '/err') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ error: 'nope' }));
    }
    res.writeHead(404);
    return res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  t.after(() => server.close());
  const url = `http://127.0.0.1:${server.address().port}`;
  const client = new McClient(url);

  assert.deepEqual(await client.getJson('/ok'), { ok: true, echo: 'GET' });
  const posted = await client.postJson('/ok', { a: 1 });
  assert.equal(posted.echo, 'POST');
  await assert.rejects(() => client.postJson('/err', {}), /nope/);
  await assert.rejects(() => client.getJson('/missing'), /HTTP 404/);
});
