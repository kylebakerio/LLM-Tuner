import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import {
  thinkingKwargs,
  toApiContent,
  apiMessagesFrom,
  parseSearchSetting,
  searchSettingLabel,
  extractMedia,
  mdClassify,
  mdInline,
  THINKING_MODES,
  thinkingNote,
  thinkingLines,
  liveStatsLine,
} from '../src/modes/chat.js';
import { createAppStore } from '../src/state.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('thinkingKwargs maps level -> chat_template_kwargs', () => {
  // off: thinking disabled entirely (no reasoning_effort key)
  assert.deepEqual(thinkingKwargs('off'), { enable_thinking: false });
  // on: the three Qwen3.8 effort levels, all with enable_thinking true
  assert.deepEqual(thinkingKwargs('xhigh'), { enable_thinking: true, reasoning_effort: 'xhigh' });
  assert.deepEqual(thinkingKwargs('medium'), { enable_thinking: true, reasoning_effort: 'medium' });
  assert.deepEqual(thinkingKwargs('low'), { enable_thinking: true, reasoning_effort: 'low' });
});

test('toApiContent: plain string when there is no media', () => {
  assert.equal(toApiContent({ text: 'hello' }), 'hello');
  assert.equal(toApiContent({ text: 'hello', media: [] }), 'hello');
});

test('toApiContent: interleaves text + image_url parts in place', () => {
  const out = toApiContent({
    text: 'describe [image 1] and [image 2] please',
    media: [
      { n: 1, kind: 'image', dataUrl: 'data:image/png;base64,AAA' },
      { n: 2, kind: 'image', dataUrl: 'data:image/jpeg;base64,BBB' },
    ],
  });
  // The [image n] markers are consumed and replaced by image_url parts, so the
  // model can reference images positionally.
  assert.deepEqual(out, [
    { type: 'text', text: 'describe ' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    { type: 'text', text: ' and ' },
    { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,BBB' } },
    { type: 'text', text: ' please' },
  ]);
});

test('toApiContent: image at the start emits no empty leading text part', () => {
  const out = toApiContent({
    text: '[image 1] what is this?',
    media: [{ n: 1, kind: 'image', dataUrl: 'data:image/png;base64,AAA' }],
  });
  assert.deepEqual(out, [
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAA' } },
    { type: 'text', text: ' what is this?' },
  ]);
});

test('toApiContent: video/audio use the native input_video/input_audio types with raw base64 (no data: URI)', () => {
  const out = toApiContent({
    text: 'watch [video 1] and listen to [audio 1]',
    media: [
      { n: 1, kind: 'video', dataB64: 'VIDEOBYTES' },
      { n: 1, kind: 'audio', dataB64: 'AUDIOBYTES' },
    ],
  });
  assert.deepEqual(out, [
    { type: 'text', text: 'watch ' },
    { type: 'input_video', input_video: { data: 'VIDEOBYTES' } },
    { type: 'text', text: ' and listen to ' },
    { type: 'input_audio', input_audio: { data: 'AUDIOBYTES' } },
  ]);
});

test('apiMessagesFrom: no system message when web search is off', () => {
  const msgs = apiMessagesFrom(
    [
      { kind: 'user', text: 'hi' },
      { kind: 'assistant', text: 'hello' },
    ],
    { webSearch: false },
  );
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'assistant']);
  assert.deepEqual(msgs[0], { role: 'user', content: 'hi' });
  assert.deepEqual(msgs[1], { role: 'assistant', content: 'hello' });
});

test('apiMessagesFrom: system prompt + tool replay when web search is on', () => {
  const msgs = apiMessagesFrom(
    [
      { kind: 'user', text: 'what is the latest node release?' },
      {
        kind: 'assistant',
        text: null,
        toolCalls: [{ id: 'call_1', type: 'function', function: { name: 'web_search', arguments: '{"query":"node release"}' } }],
        toolResults: [{ id: 'call_1', content: '{"results":[]}' }],
      },
      { kind: 'assistant', text: 'Node 22.' },
    ],
    { webSearch: true },
  );
  // system, user, assistant(tool_calls), tool, assistant(final)
  assert.deepEqual(msgs.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'assistant']);
  assert.match(msgs[0].content, /web_search/);
  assert.equal(msgs[2].tool_calls[0].id, 'call_1');
  assert.equal(msgs[3].tool_call_id, 'call_1');
  assert.equal(msgs[3].content, '{"results":[]}');
  assert.equal(msgs[4].content, 'Node 22.');
});

test('apiMessagesFrom: several search rounds replay each round with only its own results', () => {
  const call = (id, q) => ({ id, type: 'function', function: { name: 'web_search', arguments: JSON.stringify({ query: q }) } });
  const msgs = apiMessagesFrom(
    [
      { kind: 'user', text: 'qwen next quant sizes?' },
      {
        kind: 'assistant',
        text: 'About 45 GB at Q4.',
        toolRounds: [
          { toolCalls: [call('a', 'qwen next gguf')], toolResults: [{ id: 'a', content: '{"count":5}' }] },
          { toolCalls: [call('b', 'qwen next q4 size'), call('c', 'unsloth qwen next')], toolResults: [{ id: 'b', content: '{"count":3}' }, { id: 'c', content: '{"count":0}' }] },
        ],
      },
    ],
    { webSearch: true },
  );
  assert.deepEqual(msgs.map((m) => m.role), ['system', 'user', 'assistant', 'tool', 'assistant', 'tool', 'tool', 'assistant']);
  assert.deepEqual(msgs[2].tool_calls.map((c) => c.id), ['a']);
  assert.equal(msgs[3].tool_call_id, 'a');
  assert.deepEqual(msgs[4].tool_calls.map((c) => c.id), ['b', 'c']);
  assert.deepEqual([msgs[5].tool_call_id, msgs[6].tool_call_id], ['b', 'c']);
  assert.equal(msgs[7].content, 'About 45 GB at Q4.');
});

test('apiMessagesFrom: the system prompt mentions a search limit only when one is set', () => {
  const user = [{ kind: 'user', text: 'hi' }];
  assert.doesNotMatch(apiMessagesFrom(user, { webSearch: true })[0].content, /up to/);
  assert.doesNotMatch(apiMessagesFrom(user, { webSearch: true, maxSearches: -1 })[0].content, /up to/);
  assert.match(apiMessagesFrom(user, { webSearch: true, maxSearches: 3 })[0].content, /up to 3 web calls/);
});

test('parseSearchSetting: 0/off = off, n = up to n, -1/unlimited = unlimited, anything else rejected', () => {
  assert.equal(parseSearchSetting('0'), 0);
  assert.equal(parseSearchSetting('off'), 0);
  assert.equal(parseSearchSetting('5'), 5);
  assert.equal(parseSearchSetting('-1'), -1);
  assert.equal(parseSearchSetting('unlimited'), -1);
  assert.equal(parseSearchSetting('-2'), null);
  assert.equal(parseSearchSetting('lots'), null);
  assert.equal(parseSearchSetting(''), null);
  assert.equal(searchSettingLabel(0), 'off');
  assert.equal(searchSettingLabel(-1), 'unlimited');
  assert.equal(searchSettingLabel(3), 'up to 3 per answer');
});

// 1x1 transparent PNG
const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
);

test('extractMedia: a missing / non-media path stays plain text', async () => {
  const { text, media, problems } = await extractMedia('see /does/not/exist.png and notes.txt');
  assert.equal(media.length, 0);
  assert.equal(problems.length, 0);
  assert.equal(text, 'see /does/not/exist.png and notes.txt');
});

test('extractMedia: a real image becomes [image 1] + a base64 data URL', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatimg-'));
  const imgPath = path.join(dir, 'pic.png');
  await fs.writeFile(imgPath, TINY_PNG);
  try {
    const { text, media, problems } = await extractMedia(`look at ${imgPath} ok`);
    assert.equal(problems.length, 0);
    assert.equal(text, 'look at [image 1] ok');
    assert.equal(media.length, 1);
    assert.equal(media[0].n, 1);
    assert.equal(media[0].kind, 'image');
    assert.equal(media[0].name, 'pic.png');
    assert.ok(media[0].dataUrl.startsWith('data:image/png;base64,'));
    const roundtrip = Buffer.from(media[0].dataUrl.split(',')[1], 'base64');
    assert.equal(roundtrip.equals(TINY_PNG), true);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('extractMedia: two images get sequential placeholders', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatimg2-'));
  const a = path.join(dir, 'a.png');
  const b = path.join(dir, 'b.jpg');
  await fs.writeFile(a, TINY_PNG);
  await fs.writeFile(b, TINY_PNG);
  try {
    const { text, media } = await extractMedia(`first ${a} then ${b}`);
    assert.equal(text, 'first [image 1] then [image 2]');
    assert.deepEqual(media.map((i) => i.n), [1, 2]);
    assert.ok(media[0].dataUrl.startsWith('data:image/png;base64,'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('extractMedia: a video path becomes [video 1] + raw base64 (no client-side extraction, no data: URI)', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatvid-'));
  const vidPath = path.join(dir, 'clip.mp4');
  const bytes = Buffer.from('not-a-real-video-but-mtmd-sniffs-server-side');
  await fs.writeFile(vidPath, bytes);
  try {
    const { text, media, problems } = await extractMedia(`watch ${vidPath}`);
    assert.equal(problems.length, 0);
    assert.equal(text, 'watch [video 1]');
    assert.equal(media.length, 1);
    assert.equal(media[0].kind, 'video');
    assert.equal(media[0].n, 1);
    assert.equal(media[0].dataB64, bytes.toString('base64'));
    assert.equal(media[0].dataUrl, undefined, 'video must not carry a data: URI -- the server only accepts raw base64 for input_video');
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('extractMedia: an audio path becomes [audio 1] + raw base64', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chataudio-'));
  const audioPath = path.join(dir, 'clip.wav');
  const bytes = Buffer.from('not-real-audio-but-mtmd-sniffs-server-side');
  await fs.writeFile(audioPath, bytes);
  try {
    const { text, media, problems } = await extractMedia(`listen to ${audioPath}`);
    assert.equal(problems.length, 0);
    assert.equal(text, 'listen to [audio 1]');
    assert.equal(media.length, 1);
    assert.equal(media[0].kind, 'audio');
    assert.equal(media[0].dataB64, bytes.toString('base64'));
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('extractMedia: video and audio counts are tracked separately from images, and share the AV cap', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'chatmix-'));
  const img = path.join(dir, 'a.png');
  const vid1 = path.join(dir, 'v1.mp4');
  const vid2 = path.join(dir, 'v2.mp4');
  const aud1 = path.join(dir, 'a1.wav');
  await fs.writeFile(img, TINY_PNG);
  await fs.writeFile(vid1, Buffer.from('v1'));
  await fs.writeFile(vid2, Buffer.from('v2'));
  await fs.writeFile(aud1, Buffer.from('a1'));
  try {
    // MAX_AV_FILES is 2 (video+audio combined) -- the third AV attachment
    // (aud1, after vid1+vid2) should be rejected while the image sails
    // through on its own separate cap.
    const { text, media, problems } = await extractMedia(`${img} ${vid1} ${vid2} ${aud1}`);
    assert.equal(media.length, 3);
    assert.deepEqual(media.map((m) => m.kind), ['image', 'video', 'video']);
    assert.equal(problems.length, 1);
    assert.match(problems[0], /too many video\/audio attachments/);
    assert.equal(text, `[image 1] [video 1] [video 2] ${aud1}`);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});

test('mdClassify: fences toggle in place, headings strip the #s', () => {
  let inFence = false;
  const lines = ['intro', '```js', 'console.log(1)', '```', '## Setup', '> note', 'plain'];
  const types = [];
  for (const line of lines) {
    const cls = mdClassify(line, inFence);
    inFence = cls.inFence;
    types.push(cls.type);
  }
  assert.deepEqual(types, ['plain', 'fence', 'code', 'fence', 'heading', 'quote', 'plain'],
    'fence state toggles across the delimiter lines');
  assert.equal(mdClassify('## Setup', false).text, 'Setup');
  assert.equal(mdClassify('# H1', false).type, 'heading');
  assert.equal(mdClassify('#nospace', false).type, 'plain', 'a # mid-text is not a heading');
  assert.equal(mdClassify('~~~', false).type, 'fence', 'tilde fences too');
});

test('mdInline: bold, code, italic, links; code spans shield their contents', () => {
  assert.deepEqual(mdInline('no markup at all'), [{ text: 'no markup at all' }]);
  assert.deepEqual(mdInline('a **bold** b'), [
    { text: 'a ' }, { text: 'bold', bold: true }, { text: ' b' },
  ]);
  assert.deepEqual(mdInline('x `code **not bold**` y'), [
    { text: 'x ' }, { text: 'code **not bold**', color: 'cyan' }, { text: ' y' },
  ]);
  assert.deepEqual(mdInline('a _dim_ b'), [
    { text: 'a ' }, { text: 'dim', dim: true }, { text: ' b' },
  ]);
  assert.deepEqual(mdInline('see [docs](https://x.dev/a) now'), [
    { text: 'see ' }, { text: 'docs', color: 'cyan' },
    { text: ' (https://x.dev/a)', dim: true }, { text: ' now' },
  ]);
  // snake_case inside code must not become italic
  assert.deepEqual(mdInline('use `foo_bar_baz`'), [
    { text: 'use ' }, { text: 'foo_bar_baz', color: 'cyan' },
  ]);
});

test('thinkingLines: tail mode caps at 8 + marker, full mode keeps every line', () => {
  const many = Array.from({ length: 30 }, (_, i) => `step ${i + 1}`).join('\n');
  const tail = thinkingLines(many, 100, 'tail');
  assert.equal(tail.length, 9, 'marker + 8 lines');
  assert.match(tail[0], /…22 more lines…/);
  assert.equal(tail[tail.length - 1], 'step 30');
  const full = thinkingLines(many, 100, 'full');
  assert.equal(full.length, 30, 'full mode is uncapped');
  assert.equal(full[0], 'step 1');
  // Short reasoning: tail and full are identical (no marker, no cap).
  const short = 'a\nb\nc';
  assert.deepEqual(thinkingLines(short, 100, 'tail'), ['a', 'b', 'c']);
  assert.deepEqual(thinkingLines(short, 100, 'full'), ['a', 'b', 'c']);
});

test('thinkingNote: each display mode has a distinct status line', () => {
  assert.match(thinkingNote('full'), /full/);
  assert.match(thinkingNote('hidden'), /hidden/);
  assert.match(thinkingNote('tail'), /8 lines/);
  assert.notEqual(thinkingNote('full'), thinkingNote('hidden'));
  assert.equal(THINKING_MODES.length, 3);
});

test('liveStatsLine: shows elapsed always, t/s and ctx only when the store has them', () => {
  // Fresh turn, server hasn't pushed progress yet: just the elapsed clock.
  assert.match(liveStatsLine({ genTps: null, genInst: null, ctxTotal: 0 }, 1.23), /^  \u23F1 1\.2s$/);
  // Full live readout once GEN_PROGRESS + CTX_LIVE have landed.
  const line = liveStatsLine({ genTps: 45.67, genInst: 60, ctxUsed: 3210, ctxTotal: 8192 }, 2.0);
  assert.match(line, /2\.0s/);
  assert.match(line, /45\.7 t\/s gen/);
  assert.match(line, /\(60 inst\)/);
  assert.match(line, /ctx 3k\/8k/);
});

test('chat: a streamed markdown answer renders styled lines with stats', async (t) => {
  const { Chat } = await import('../src/modes/chat.js');
  const appStore = createAppStore();
  appStore.onConnState('live');
  appStore.onSSEEvent({
    state: 'ready', model: '/m/test.gguf',
    launchCommand: '/x/llama-server -m /m/test.gguf --port 8080', launchConfig: {}, log: '',
  });
  // Pre-existing completion: send() snapshots these as `seen`, so the
  // COMPLETION pushed below is the one its stats wait picks up.
  appStore.backfillCompletions([{
    runId: 'r0', timestamp: Date.now(), model: 'test.gguf',
    promptTps: 100, genTps: 20, promptTokens: 10, genTokens: 5, wallTime: 0.5, aborted: false,
  }]);

  const encoder = new TextEncoder();
  const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
  const md = '## Title\n\nsome **bold** and `code` and a [link](https://x.dev/a)\n```js\nconst a = 1;\n```\n> quoted line';
  const client = {
    getJson: async () => ({}),
    postJson: async () => ({}),
    postStream: async () => ({
      body: new ReadableStream({
        start(c) {
          c.enqueue(encoder.encode(sse({ choices: [{ delta: { reasoning_content: 'hmm' } }] })));
          c.enqueue(encoder.encode(sse({ choices: [{ delta: { content: md } }] })));
          c.enqueue(encoder.encode(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] })));
          c.close();
        },
      }),
    }),
    connect() {},
    close() {},
  };

  const view = render(React.createElement(Chat, {
    client, appStore, serverUrl: 'http://localhost:3000',
    modeGateRef: { current: false }, onMode: () => {}, onExit: () => {}, onShowHelp: () => {},
  }));
  t.after(view.unmount);
  await sleep(50);

  // Type the prompt, then Enter as a SEPARATE event (one combined chunk
  // would insert the text but never fire the return handler).
  view.stdin.write('what is this?');
  await sleep(20);
  view.stdin.write('\r');
  // The dashboard tails the COMPLETION row a moment after the stream ends --
  // deliver it the way the real SSE leg does: a full status snapshot (see
  // server4.js's /api/status payload) carrying the COMPLETION log line.
  setTimeout(() => appStore.onSSEEvent({
    state: 'ready', model: '/m/test.gguf', isRpc: false,
    launchCommand: '/x/llama-server -m /m/test.gguf --port 8080', launchConfig: {},
    loadStartTime: 0, finalLoadTime: 0, error: '',
    log: 'COMPLETION:' + JSON.stringify({
      runId: 'r-new', timestamp: Date.now(), model: 'test.gguf',
      promptTps: 900, genTps: 30, promptTokens: 100, genTokens: 50, wallTime: 1.2, aborted: false,
    }),
  }), 50);
  await sleep(900);
  const out = view.lastFrame() || '';

  assert.match(out, /test\.gguf/, 'model name still in the header after the turn');
  assert.match(out, /You: what is this\?/, 'user entry');
  assert.match(out, /Model:/, 'model label');
  assert.doesNotMatch(out, /## Title/, 'heading #s stripped');
  assert.match(out, /Title/, 'heading text');
  assert.match(out, /const a = 1;/, 'fenced code content');
  assert.match(out, /link \(https:\/\/x\.dev\/a\)/, 'link text + url');
  assert.match(out, /1\.2s/, 'stats wall time from the COMPLETION row');
  assert.match(out, /100 in/, 'stats prompt tokens');
  assert.match(out, /30\.0 t\/s gen/, 'stats gen t/s');
});

test('chat: an in-flight stream is still visible after switching to Monitor and back', async (t) => {
  // Regression: Chat used to UNMOUNT on mode switch, so a generation started
  // in Chat was dropped the moment you looked at Monitor -- the live thinking
  // stream was gone when you came back. Chat is now always mounted (hidden
  // while another mode shows), so the stream keeps running and re-appears.
  const { default: App } = await import('../src/app.js');
  const appStore = createAppStore();
  appStore.onConnState('live');
  appStore.onSSEEvent({
    state: 'ready', model: '/m/test.gguf',
    launchCommand: '/x/llama-server -m /m/test.gguf --port 8080', launchConfig: {}, log: '',
  });

  const enc = new TextEncoder();
  const sse = (o) => `data: ${JSON.stringify(o)}\n\n`;
  let streamOpen = false;
  const client = {
    getJson: async () => ({}),
    postJson: async () => ({}),
    postStream: async () => ({
      body: new ReadableStream({
        start(c) {
          streamOpen = true;
          c.enqueue(enc.encode(sse({ choices: [{ delta: { reasoning_content: 'pondering deeply' } }] })));
          c.enqueue(enc.encode(sse({ choices: [{ delta: { content: 'the answer is 42' } }] })));
          // Keep the stream in-flight for a while so we can observe it while
          // away, then finish.
          setTimeout(() => { c.enqueue(enc.encode(sse({ choices: [{ delta: {}, finish_reason: 'stop' }] }))); c.close(); streamOpen = false; }, 1500);
        },
      }),
    }),
    connect() {}, close() {},
  };

  const view = render(React.createElement(App, { client, appStore, serverUrl: 'http://localhost:3000' }));
  t.after(view.unmount);
  await sleep(60);

  // Monitor -> Chat.
  view.stdin.write('3');
  await sleep(40);
  // Start a generation.
  view.stdin.write('what is the answer?');
  await sleep(20);
  view.stdin.write('\r');
  await sleep(300);
  let out = view.lastFrame() || '';
  assert.match(out, /You: what is the answer\?/, 'user message in transcript');
  assert.match(out, /the answer is 42/, 'live stream visible while in Chat');
  assert.ok(streamOpen, 'stream is in-flight');

  // Switch to Monitor mid-stream (/1 -- works even while busy).
  view.stdin.write('/1');
  await sleep(20);
  view.stdin.write('\r');
  await sleep(150);
  out = view.lastFrame() || '';
  assert.doesNotMatch(out, /CHAT/, 'Chat is hidden -- Monitor is on screen');
  assert.ok(streamOpen, 'generation keeps running while away (not aborted by the switch)');

  // Come back to Chat -- the in-flight stream must be visible again.
  view.stdin.write('3');
  await sleep(300);
  out = view.lastFrame() || '';
  assert.match(out, /You: what is the answer\?/, 'conversation survived the round-trip');
  assert.match(out, /the answer is 42/, 'live stream is still visible after returning');
  assert.match(out, /generating/i, 'still busy (mid-stream)');
});

test('chat: /1../5 jump to the numbered tab (terminal-agnostic tab switch)', async (t) => {
  const { Chat } = await import('../src/modes/chat.js');
  const appStore = createAppStore();
  appStore.onConnState('live');
  appStore.onSSEEvent({
    state: 'ready', model: '/m/test.gguf',
    launchCommand: '/x/llama-server -m /m/test.gguf --port 8080', launchConfig: {}, log: '',
  });
  const client = {
    getJson: async () => ({}), postJson: async () => ({}),
    postStream: async () => ({ body: new ReadableStream({ start(c) { c.close(); } }) }),
    connect() {}, close() {},
  };
  const calls = [];
  const view = render(React.createElement(Chat, {
    client, appStore, serverUrl: 'http://localhost:3000',
    modeGateRef: { current: false },
    onMode: (m) => calls.push(m), onExit: () => {}, onShowHelp: () => {},
  }));
  t.after(view.unmount);
  await sleep(40);
  view.stdin.write('/3');
  await sleep(20);
  view.stdin.write('\r');
  await sleep(40);
  assert.deepEqual(calls, ['mode3'], '/3 switches to mode3 via onMode');
});
