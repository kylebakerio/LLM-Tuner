import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Chalk } from 'chalk';
import { M, createPrinter, footer } from '../src/livechat.js';

const plain = new Chalk({ level: 0 });

function run(events) {
  const s = M.fresh();
  const print = createPrinter(plain);
  let out = '';
  for (const ev of events) out += print(s, M.apply(s, ev));
  return out;
}

const sys = { role: 'system', content: 'You are an agent.' };
const user = { role: 'user', content: 'Fix the bug.' };

test('livechat printer: request, streamed reasoning/answer, tool call, then the tool result', () => {
  const out = run([
    { type: 'tap', up: true, port: 18090 },
    { type: 'request', id: 1, thread: 1, prefix: 0, delta: [sys, user], n_messages: 2, tools: ['bash'], model: 'm' },
    { type: 'delta', id: 1, reasoning: 'Let me ' },
    { type: 'delta', id: 1, reasoning: 'look.' },
    { type: 'delta', id: 1, content: 'Checking.' },
    { type: 'delta', id: 1, tool_calls: [{ index: 0, id: 'c1', name: 'bash', arguments: '{"command":"ls src"}' }] },
    { type: 'end', id: 1, finish: 'tool_calls', usage: { completion_tokens: 7 } },
    { type: 'request', id: 2, thread: 1, prefix: 2, n_messages: 4, tools: ['bash'], delta: [
      { role: 'assistant', content: 'Checking.', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls src"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'a.js\nb.js' }] },
  ]);
  assert.match(out, /\(tap connected on :18090\)/);
  assert.match(out, /\[system prompt, 17 chars\]/);
  assert.match(out, /user> Fix the bug\./);
  assert.match(out, /Let me look\.\nassistant> Checking\.\n {2}⚙ bash: ls src\n {2}\[tool_calls · 7 out\]/);
  assert.match(out, / {2}↳ bash result:\n {4}a\.js\n {4}b\.js/);
  assert.equal(out.match(/assistant> Checking\./g).length, 1, 'the streamed reply is not printed again when echoed back');
  assert.match(out, /request #2 · 4 messages/);
});

test('livechat printer: a snapshot mid-response prints what streamed so far', () => {
  const s = M.fresh();
  M.apply(s, { type: 'request', id: 3, thread: 2, prefix: 0, delta: [sys, user], n_messages: 2, tools: ['bash'] });
  M.apply(s, { type: 'delta', id: 3, reasoning: 'hmm', content: 'Partial' });
  const out = run([{ type: 'snapshot', state: JSON.parse(JSON.stringify(s)) }, { type: 'delta', id: 3, content: ' answer' }]);
  assert.match(out, /══ conversation 2 ══/);
  assert.match(out, /hmm\nassistant> Partial answer/);
});

test('livechat footer', () => {
  assert.equal(footer({ finish: 'stop', usage: { prompt_tokens: 10, completion_tokens: 3 }, timings: { predicted_per_second: 41.26 }, t_start: 1, t_end: 3.5 }),
    'stop · 10 in · 3 out · tg 41.3 t/s · 2.5 s');
});
