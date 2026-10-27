// `llama-cli livechat`: the running benchmark's conversation, printed as it streams.
//
// Reads GET /api/livechat (the dashboard's relay of codebench's proxy tap, see
// ../../lib/livechat.js) and prints append-only, like `tail -f`: new messages when the agent
// sends a request (user text, tool results, truncated), then the model's reply token by token:
// reasoning dim, answer plain, tool calls yellow once their arguments are complete, and a grey
// footer with finish reason / tokens / speed. The same reducer as the browser
// (../../ui/livechat/model.js, a CommonJS file) keeps the state; createPrinter() below turns
// its change records into text and is pure, so it is unit-tested (test/livechat.test.js).
import { createRequire } from 'node:module';
import { Readable } from 'node:stream';
import chalk from 'chalk';

const require = createRequire(import.meta.url);
export const M = require('../../ui/livechat/model.js');

const RESULT_LINES = 8;
const RESULT_LINE_CHARS = 160;
const TEXT_LINES = 20;

function clip(text, maxLines, maxChars = RESULT_LINE_CHARS) {
  const lines = String(text || '').split('\n');
  const shown = lines.slice(0, maxLines).map((l) => (l.length > maxChars ? l.slice(0, maxChars) + '…' : l));
  if (lines.length > maxLines) shown.push(`… (${lines.length - maxLines} more lines)`);
  return shown.join('\n');
}
function argLine(tc) {
  let o = null;
  try { o = JSON.parse(tc.arguments || ''); } catch { /* partial or not JSON */ }
  const pick = o && typeof o === 'object' ? (o.command || o.cmd || o.filePath || o.file_path || o.path || o.pattern || o.query || o.url) : null;
  const s = typeof pick === 'string' ? pick : (tc.arguments || '');
  return s.replace(/\s+/g, ' ').slice(0, 200);
}
export function footer(r) {
  const bits = [];
  if (r.finish) bits.push(r.finish);
  if (r.error) bits.push(r.error);
  const u = r.usage || {}, t = r.timings || {};
  if (u.prompt_tokens != null) bits.push(`${u.prompt_tokens} in`);
  if (u.completion_tokens != null) bits.push(`${u.completion_tokens} out`);
  if (t.predicted_per_second) bits.push(`tg ${Number(t.predicted_per_second).toFixed(1)} t/s`);
  if (r.t_start && r.t_end) bits.push(`${(r.t_end - r.t_start).toFixed(1)} s`);
  return bits.join(' · ');
}

// Returns print(state, change) -> string: what to append to the terminal for one reducer step.
// `c` is a chalk instance (pass `new Chalk({ level: 0 })` for plain text in tests).
export function createPrinter(c = chalk) {
  let thread = null;
  let printedTo = 0;          // absolute index of the next message not printed yet
  let streamedIndex = null;   // message index of the response whose tokens we printed live
  let mode = null;            // 'reasoning' | 'content' within the live response
  let lastCtx = '';
  let lastTapUp = null;

  function message(it, items) {
    if (it.role === 'system') return c.gray(`[system prompt, ${it.text.length} chars]`) + '\n';
    if (it.role === 'user') return c.cyan.bold('user> ') + clip(it.text, TEXT_LINES, 400) + '\n';
    if (it.role === 'tool') {
      const name = it.name || M.toolNameFor(items, it.tool_call_id) || 'tool';
      return c.blue(`  ↳ ${name} result:`) + '\n' + c.gray(clip(it.text, RESULT_LINES).replace(/^/gm, '    ')) + '\n';
    }
    if (it.role === 'assistant') {
      let s = '';
      if (it.reasoning) s += c.dim.italic(clip(it.reasoning, 3, 300)) + '\n';
      if (it.text) s += c.green.bold('assistant> ') + clip(it.text, TEXT_LINES, 400) + '\n';
      for (const tc of it.tool_calls || []) s += c.yellow(`  ⚙ ${tc.name}: `) + argLine(tc) + '\n';
      return s || c.gray('[assistant: empty]\n');
    }
    return c.gray(`[${it.role}] `) + clip(it.text, 4) + '\n';
  }

  return function print(s, ch) {
    let out = '';
    if (ch.kind === 'meta') {
      const x = s.ctx || {};
      const nl = () => { if (mode) { mode = null; return '\n'; } return ''; };   // never start a line mid-token
      const line = [x.model || s.model, x.battery, x.task && `task ${x.task}`].filter(Boolean).join(' · ');
      if (line && line !== lastCtx) { lastCtx = line; out += nl() + c.magenta(`── ${line} ──`) + '\n'; }
      if (s.tap.up !== lastTapUp) {
        lastTapUp = s.tap.up;
        out += nl() + (s.tap.up ? c.gray(`(tap connected on :${s.tap.port})`) + '\n'
          : c.gray(`(no tap on :${s.tap.port || 18090} -- start the proxy with --tap; waiting)`) + '\n');
      }
      return out;
    }
    if (ch.kind === 'reset') {
      const items = M.view(s);
      if (s.thread === null && thread !== null) out += (mode ? '\n' : '') + c.gray('(tap session restarted)') + '\n';
      if (s.thread !== thread) { thread = s.thread; printedTo = s.base; streamedIndex = null; if (s.thread !== null) out += c.magenta(`\n══ conversation ${s.thread}${s.gap ? ` (joined at message ${s.base})` : ''} ══`) + '\n'; }
      for (const it of items) {
        if (it.live || it.index < printedTo) continue;
        // The reply we just streamed comes back as a message: already on screen.
        if (!(it.role === 'assistant' && it.index === streamedIndex)) out += message(it, items);
        printedTo = it.index + 1;
      }
      const r = s.resp;
      if (r) {
        streamedIndex = r.index; mode = null;
        out += c.gray(`── request #${r.id} · ${s.base + s.messages.length} messages${r.model ? ` · ${r.model}` : ''} ──`) + '\n';
        // A snapshot mid-response: print what has streamed so far.
        if (r.reasoning) { out += c.dim.italic(r.reasoning); mode = 'reasoning'; }
        if (r.content) { out += (mode ? '\n' : '') + c.green.bold('assistant> ') + r.content; mode = 'content'; }
        if (r.done) out += finishText(r);
      }
      return out;
    }
    if (ch.kind === 'delta' && ch.target === 'resp') {
      const a = ch.add;
      if (a.reasoning) { if (mode !== 'reasoning') { out += mode ? '\n' : ''; mode = 'reasoning'; } out += c.dim.italic(a.reasoning); }
      if (a.content) { if (mode !== 'content') { out += (mode ? '\n' : '') + c.green.bold('assistant> '); mode = 'content'; } out += a.content; }
      return out;
    }
    if (ch.kind === 'end' && ch.target === 'resp') return finishText(s.resp);
    if (ch.kind === 'side' || (ch.kind === 'end' && ch.target === 'side')) {
      const r = s.side;
      if (ch.kind === 'end' && r) return c.gray(`  (side request #${r.id} → ${JSON.stringify((r.content || '').slice(0, 80))})`) + '\n';
    }
    return out;

    function finishText(r) {
      let t = mode ? '\n' : '';
      for (const tc of r.tool_calls) t += c.yellow(`  ⚙ ${tc.name}: `) + argLine(tc) + '\n';
      t += c.gray(`  [${footer(r)}]`) + '\n';
      mode = null;
      return t;
    }
  };
}

// Connects and prints until interrupted. Reconnects with backoff; the server sends a snapshot
// on every (re)connect, so the printer is rebuilt to redraw from it.
export async function runLivechat({ baseUrl, token, out = process.stdout, fetchImpl = globalThis.fetch }) {
  const url = String(baseUrl).replace(/\/+$/, '') + '/api/livechat';
  const headers = { Accept: 'text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  let backoff = 1000;
  for (;;) {
    const state = M.fresh();
    const print = createPrinter();
    try {
      const res = await fetchImpl(url, { headers });
      if (res.status === 401) throw Object.assign(new Error('authentication required (--token or MC_TOKEN)'), { fatal: true });
      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
      backoff = 1000;
      const dec = new TextDecoder();
      let buf = '';
      for await (const chunk of Readable.fromWeb(res.body)) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, i); buf = buf.slice(i + 2);
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue;
            let ev; try { ev = JSON.parse(line.slice(5)); } catch { continue; }
            const ch = M.apply(state, ev);
            const text = print(state, ch);
            if (text) out.write(text);
          }
        }
      }
      out.write(chalk.gray('\n(stream ended, reconnecting)\n'));
    } catch (err) {
      if (err.fatal) throw err;
      out.write(chalk.gray(`\n(${err.message}; retrying in ${backoff / 1000}s)\n`));
    }
    await new Promise((r) => setTimeout(r, backoff));
    backoff = Math.min(backoff * 2, 15000);
  }
}
