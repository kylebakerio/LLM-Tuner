import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import App from '../src/app.js';
import { Launch } from '../src/modes/launch.js';
import { createAppStore } from '../src/state.js';

// Launch mode's profile-first flow, driven through ink-testing-library with a
// fake dashboard: profile list -> confirm panel -> launch, the busy-card
// guard (preview `busy`, 409 CARD_BUSY, force: true), stop / restart confirms.
// Nothing here talks to a real server.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ENTER = '\r';
const ESC = '\x1b';
const DOWN = '\x1b[B';
const click = (x, y) => `\x1b[<0;${x};${y}M`;

const XTX = { id: 'ROCm0', name: 'AMD Radeon RX 7900 XTX' };
const N3060 = { id: 'CUDA0', name: 'NVIDIA GeForce RTX 3060' };
const DAILY = {
  modelPath: '/models/alpha-27b-Q4_K_XL.gguf', build: 'all', ctx: 131072, ngl: 999,
  devices: [{ ...XTX, share: 75 }, { ...N3060, share: 25 }],
  fa: true, jinja: true, verbosity: null,
  rawCommand: '/x/llama-server -m /models/stale.gguf', tuningNote: 'two-card daily driver',
};
const STRATA = {
  engine: 'strata', strataBase: '/strata/strata-coder-iq1_m-262k-int8.json',
  rawCommand: '/strata/queue-serve.sh /strata/strata-coder-iq1_m-262k-int8.json --port 8080', temp: 1, topK: 20, topP: 0.95,
};
const NOW = Date.now();
// Most recently used first: daily (1h), strata (2d), gone (never loaded, saved 5d ago), fresh (never, 9d).
const PROFILES = {
  'gone · beta Q6': { config: { ...DAILY, modelPath: '/models/beta-27b-Q6_K_XL.gguf', ctx: 262144, devices: [{ ...XTX }] }, savedAt: NOW - 5 * 86400000, lastLoadedAt: null },
  'daily · alpha Q4': { config: DAILY, savedAt: NOW - 20 * 86400000, lastLoadedAt: NOW - 3600000 },
  'fresh · alpha 64k': { config: { ...DAILY, ctx: 65536, devices: [{ ...N3060 }], tuningNote: undefined }, savedAt: NOW - 9 * 86400000, lastLoadedAt: null },
  'strata coder 262k': { config: STRATA, savedAt: NOW - 30 * 86400000, lastLoadedAt: NOW - 2 * 86400000 },
};
const BUSY = [{ lane: 'local-3060', device: 'CUDA0', card: 'RTX 3060', cardKey: 'rtx3060', itemId: 879, label: 'idle-qwen38-27b-80k-careful' }];
const PREVIEW_CMD = "/x/build-all/bin/llama-server -m /models/alpha-27b-Q4_K_XL.gguf -c 131072 -ngl 999 --split-mode layer -dev 'ROCm0,CUDA0' -ts '75,25'";

function httpError(status, data) {
  return Object.assign(new Error(data.error || `HTTP ${status}`), { status, data });
}

// A fake dashboard. `busy`: what /api/preview-command reports (undefined =
// a server without the guard: no field at all). `start`: per-call results for
// /api/start, each an Error to throw or a value to return.
function fakeDashboard({ profiles = PROFILES, busy, start = [] } = {}) {
  const posts = [];
  const store = { version: 3, profiles: JSON.parse(JSON.stringify(profiles)) };
  const startQueue = [...start];
  const client = {
    baseUrl: 'http://fake',
    posts,
    store,
    of: (path) => posts.filter(([p]) => p === path).map(([, b]) => b),
    getJson: async (p) => {
      if (p === '/api/profiles') return store;
      if (p === '/api/models') return [{ name: 'alpha-27b-Q4_K_XL.gguf', path: '/models/alpha-27b-Q4_K_XL.gguf', size: '17.1', source: 'local', kind: 'model' }];
      if (p === '/api/builds') return { builds: [{ id: 'all', label: 'CUDA + ROCm + Vulkan', path: '/x/build-all/bin/llama-server' }] };
      if (p === '/api/strata/configs') return { configs: [{ path: STRATA.strataBase, name: 'strata-coder-iq1_m-262k-int8.json' }] };
      if (p.startsWith('/api/devices')) return { devices: [], cards: [], workers: [] };
      return {};
    },
    postJson: async (p, body) => {
      posts.push([p, body]);
      if (p === '/api/preview-command') {
        const res = {
          command: body.engine === 'strata' ? `/strata/queue-serve.sh ${body.strataBase} --port 8080` : PREVIEW_CMD,
          devices: body.engine === 'strata' ? [XTX] : (body.devices || []).filter((d) => d.enabled !== false),
          warnings: [],
        };
        if (busy !== undefined) res.busy = busy;
        return res;
      }
      if (p === '/api/start') {
        const next = startQueue.shift();
        if (next instanceof Error) throw next;
        return next || { status: 'launching' };
      }
      if (p === '/api/profiles') {
        if (body.config) store.profiles[body.name] = { config: body.config, savedAt: Date.now(), lastLoadedAt: body.lastLoadedAt || null };
        return { ok: true, name: body.name };
      }
      return {};
    },
    deleteJson: async (p) => {
      posts.push(['DELETE', p]);
      delete store.profiles[decodeURIComponent(p.slice('/api/profiles/'.length))];
      return { ok: true };
    },
    connect() {},
    close() {},
  };
  return client;
}

function stoppedStore() {
  const appStore = createAppStore();
  appStore.onConnState('live');
  appStore.onSSEEvent({ state: 'stopped', model: '', log: '', launchConfig: null });
  return appStore;
}

const RUNNING_CONFIG = { ...DAILY, model: 'alpha-27b-Q4_K_XL.gguf', port: 8080 };
function runningStore({ observedStart = true } = {}) {
  const appStore = createAppStore();
  appStore.onConnState('live');
  const frame = { model: 'alpha-27b-Q4_K_XL.gguf', log: '', launchCommand: '/x/llama-server --port 8080', launchConfig: RUNNING_CONFIG };
  if (observedStart) appStore.onSSEEvent({ ...frame, state: 'loading' });
  appStore.onSSEEvent({ ...frame, state: 'ready' });
  return appStore;
}

function mount(t, client, appStore, extra = {}) {
  const launched = [];
  const gate = { current: false };
  const view = render(React.createElement(Launch, {
    client, appStore, serverUrl: 'http://fake', modeGateRef: gate, onLaunched: () => launched.push(1), ...extra,
  }));
  t.after(view.unmount);
  const press = async (...keys) => {
    for (const k of keys) { view.stdin.write(k); await sleep(60); }
  };
  return { view, launched, gate, press, frame: () => view.lastFrame() || '' };
}

test('Launch opens on the profile list: one line per profile, most recently used first, missing-file and never-used markers', async (t) => {
  const client = fakeDashboard();
  const { frame } = mount(t, client, stoppedStore());
  await sleep(150);
  const out = frame();
  const lines = out.split('\n');

  assert.match(lines[0], /LAUNCH\s+○ no model running/, 'what is running, on the first line');
  assert.match(out, /Profiles · 4 saved · most recently used first/);
  assert.match(out, /PROFILE\s+MODEL\s+CTX\s+PLACEMENT\s+BUILD\s+LAST USED/);

  const row = (name) => lines.find((l) => l.includes(name) && /\d+k|—/.test(l));
  const order = ['daily · alpha Q4', 'strata coder 262k', 'gone · beta Q6', 'fresh · alpha 64k'].map((n) => lines.indexOf(row(n)));
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'rows in most-recently-used order');
  assert.ok(order.every((i) => i > 0), 'every profile has a row');

  assert.match(row('daily · alpha Q4'), /^› {3}daily · alpha Q4\s+alpha-27b-Q4_K_XL\s+131k RX 7900 XTX \+ RTX 3060, 3:1\s+all\s+1h ago/, 'selected row: name, model/quant, ctx, placement, build, last used');
  assert.match(row('gone · beta Q6'), /^ {2}✗ gone · beta Q6\s+beta-27b-Q6_K_XL\s+262k RX 7900 XTX alone\s+all\s+MISSING/, 'model file not in the catalog: marked');
  assert.match(row('fresh · alpha 64k'), /65k RTX 3060 alone\s+all\s+never used/, 'never loaded: marked');
  assert.match(row('strata coder 262k'), /strata coder-iq1_m-262k-\S+\s+— Strata engine\s+strata\s+2d ago/, 'Strata-engine profile');
  assert.doesNotMatch(row('daily · alpha Q4'), /✗|MISSING/);

  // The selected profile in full, under the list.
  assert.match(out, /\/models\/alpha-27b-Q4_K_XL\.gguf/);
  assert.match(out, /last used 1h ago · two-card daily driver/);
  // Key hints are on screen, not only behind `?`.
  assert.match(out, /Enter: review & launch\s+e: edit\s+n: new config\s+\/: filter/);
  assert.match(out, /d: delete\s+r: rename\s+c: duplicate/);
  assert.doesNotMatch(out, /x: stop server|R: restart/, 'no stop/restart hints while nothing runs');
  // The config editor is not the first screen any more.
  assert.doesNotMatch(out, /Flash attn|▏core|command:/);
  assert.equal(client.of('/api/start').length, 0);
  assert.equal(client.of('/api/preview-command').filter((b) => b.modelPath === DAILY.modelPath && b.ctx === 131072).length, 0, 'no profile previewed before Enter');
});

test('profile list: / filters as you type (q and digits are filter text), Esc clears; the detail line names a missing file', async (t) => {
  const client = fakeDashboard();
  const { frame, press, gate } = mount(t, client, stoppedStore());
  await sleep(150);
  assert.equal(gate.current, false, 'list: app keys (1/2/3, q, ?) stay live');

  await press('/', 'q', '6');
  assert.equal(gate.current, true, 'typing the filter: q must not quit the TUI');
  let out = frame();
  assert.match(out, /filter: q6/);
  assert.match(out, /gone · beta Q6/);
  assert.doesNotMatch(out, /daily · alpha Q4|fresh · alpha 64k|strata coder 262k/);
  assert.match(out, /1–1 of 1 \(4 saved\)/);
  assert.match(out, /✗ model file not found: \/models\/beta-27b-Q6_K_XL\.gguf/);
  assert.match(out, /type: filter/);

  await press(ESC);
  out = frame();
  assert.equal(gate.current, false);
  assert.match(out, /filter: \(none/);
  assert.match(out, /daily · alpha Q4/);
  assert.match(out, /fresh · alpha 64k/);

  await press('/', 'zzz');
  assert.match(frame(), /no profile matches the filter/);
});

test('Enter shows the confirm panel (resolved command, cards, no spawn); Enter there launches the profile as saved', async (t) => {
  const client = fakeDashboard({ busy: [] });
  const { frame, press, launched, gate } = mount(t, client, stoppedStore());
  await sleep(150);
  await press(ENTER);
  await sleep(100);
  const out = frame();

  assert.equal(gate.current, true, 'a launch under review owns the keyboard');
  assert.match(out, /Launch profile “daily · alpha Q4”/);
  assert.match(out, /model\s+alpha-27b-Q4_K_XL/);
  assert.match(out, /context\s+131,072 tokens\s+build all — CUDA \+ ROCm \+ Vulkan/);
  assert.match(out, /cards\s+RX 7900 XTX \(ROCm0\) 75%\s+·\s+RTX 3060 \(CUDA0\) 25%/, 'the cards it will use, from the server plan');
  assert.match(out, /note\s+two-card daily driver/);
  assert.match(out, /command\s+\/x\/build-all\/bin\/llama-server -m \/models\/alpha-27b-Q4_K_XL\.gguf/, 'command resolved by the dashboard');
  assert.doesNotMatch(out, /CARD BUSY|Launch anyway|asks once more/);
  assert.match(out, /Enter: launch\s+e: edit before launching\s+Esc: back to profiles/);

  const previews = client.of('/api/preview-command');
  assert.equal(previews.length >= 1, true);
  const sent = previews[previews.length - 1];
  assert.equal(sent.modelPath, DAILY.modelPath);
  assert.equal('rawCommand' in sent, false, 'a stale web rawCommand is never sent');
  assert.equal(sent.verbosity, 3, 'verbosity floor applied');
  assert.equal(client.of('/api/start').length, 0, 'reviewing starts nothing');

  await press(ENTER);
  await sleep(350);
  const starts = client.of('/api/start');
  assert.equal(starts.length, 1, 'one key launches');
  assert.deepEqual(starts[0], sent, 'what was previewed is what is started');
  assert.equal('force' in starts[0], false, 'no force without busy cards');
  assert.equal(client.of('/api/stop').length, 0);
  assert.equal(launched.length, 1, 'switches to Monitor');
  assert.ok(client.of('/api/profiles').some((b) => b.name === 'daily · alpha Q4' && b.lastLoadedAt && !b.config), '"last used" stamped');
});

test('confirm panel degrades without `busy` (older dashboard): no warning, plain launch', async (t) => {
  const client = fakeDashboard({ busy: undefined });
  const { frame, press } = mount(t, client, stoppedStore());
  await sleep(150);
  await press(ENTER);
  await sleep(100);
  assert.doesNotMatch(frame(), /CARD BUSY/);
  await press(ENTER);
  await sleep(100);
  assert.deepEqual(client.of('/api/start').map((b) => 'force' in b), [false]);
});

test('busy cards: prominent warning with card and item label; launching needs a second, explicit yes and sends force: true', async (t) => {
  const client = fakeDashboard({ busy: BUSY });
  const { frame, press, launched } = mount(t, client, stoppedStore());
  await sleep(150);
  await press(ENTER);
  await sleep(100);
  let out = frame();
  assert.match(out, /⚠ CARD BUSY — a benchmark is running on a card this launch needs/);
  assert.match(out, /RTX 3060 \(CUDA0\) — queue item 879 “idle-qwen38-27b-80k-careful” · lane local-3060/);
  assert.match(out, /Enter: launch \(asks once more\)/);

  await press(ENTER);
  out = frame();
  assert.match(out, /Launch anyway\? This will:/);
  assert.match(out, /• take RTX 3060 \(CUDA0\) — queue item 879/);
  assert.match(out, /\[y\/N\]/);
  assert.match(out, /y: yes, go ahead\s+n \/ Esc: cancel/);
  assert.equal(client.of('/api/start').length, 0, 'first Enter only asks');

  await press(ENTER);
  await press(' ');
  assert.equal(client.of('/api/start').length, 0, 'Enter / other keys at the second question do nothing');

  await press('n');
  out = frame();
  assert.doesNotMatch(out, /Launch anyway\?/, 'n goes back to the review');
  assert.match(out, /CARD BUSY/);
  assert.equal(client.of('/api/start').length, 0);

  await press(ENTER, 'y');
  await sleep(350);
  const starts = client.of('/api/start');
  assert.equal(starts.length, 1);
  assert.equal(starts[0].force, true, 'explicit second confirmation -> force');
  assert.equal(starts[0].modelPath, DAILY.modelPath);
  assert.equal(launched.length, 1);
  assert.equal(client.of('/api/preview-command').some((b) => 'force' in b), false, 'force is never part of the config');
});

test('a 409 CARD_BUSY with no prior warning opens the same second confirmation; y resends with force: true', async (t) => {
  const refusal = httpError(409, { error: 'Card busy: the RTX 3060 is running queue item 879 (idle-qwen38-27b-80k-careful)', code: 'CARD_BUSY', busy: BUSY });
  const client = fakeDashboard({ busy: [], start: [refusal] });
  const { frame, press, launched } = mount(t, client, stoppedStore());
  await sleep(150);
  await press(ENTER);
  await sleep(100);
  assert.doesNotMatch(frame(), /CARD BUSY/, 'the preview saw free cards');

  await press(ENTER);
  await sleep(100);
  let out = frame();
  assert.equal(client.of('/api/start').length, 1);
  assert.equal('force' in client.of('/api/start')[0], false, 'first attempt is never forced');
  assert.equal(launched.length, 0);
  assert.match(out, /⚠ CARD BUSY/);
  assert.match(out, /RTX 3060 \(CUDA0\) — queue item 879 “idle-qwen38-27b-80k-careful”/, "the 409's busy list");
  assert.match(out, /The dashboard refused to start/);
  assert.match(out, /Launch anyway\? This will:/);
  assert.match(out, /\[y\/N\]/);

  await press('y');
  await sleep(350);
  const starts = client.of('/api/start');
  assert.equal(starts.length, 2);
  assert.equal(starts[1].force, true);
  assert.deepEqual({ ...starts[1], force: undefined }, { ...starts[0], force: undefined }, 'same config, plus force');
  assert.equal(launched.length, 1);
});

test('a 409 CARD_BUSY can be declined: n sends nothing more', async (t) => {
  const client = fakeDashboard({ start: [httpError(409, { error: 'Card busy', code: 'CARD_BUSY' })] });
  const { frame, press, launched } = mount(t, client, stoppedStore());
  await sleep(150);
  await press(ENTER);
  await sleep(100);
  await press(ENTER);
  await sleep(100);
  assert.match(frame(), /⚠ CARD BUSY — Card busy/, 'a 409 without a busy list still explains itself');
  assert.match(frame(), /\[y\/N\]/);
  await press('n');
  await sleep(60);
  assert.equal(client.of('/api/start').length, 1);
  assert.equal(launched.length, 0);
  assert.match(frame(), /Launch profile “daily · alpha Q4”/, 'back on the review');
});

test('running server on top of Launch (model, ctx, cards, uptime); x asks before stopping', async (t) => {
  const client = fakeDashboard();
  const { frame, press } = mount(t, client, runningStore());
  await sleep(150);
  let out = frame();
  const first = out.split('\n')[0];
  assert.match(first, /LAUNCH\s+● alpha-27b-Q4_K_XL · ctx 131,072 · RX 7900 XTX \+ RTX 3060, 3:1 · up 00:00:0\d/);
  assert.match(out.split('\n')[1], /x stop the server\s+R restart it \(same config\)/);
  assert.match(out, /x: stop server\s+R: restart/, 'and in the key hints');

  await press('x');
  out = frame();
  assert.match(out, /Stop the model server \(alpha-27b-Q4_K_XL, up 00:00:0\d\)\? \[y\/N\]/);
  await press('n');
  assert.equal(client.of('/api/stop').length, 0, 'n: nothing sent');
  assert.doesNotMatch(frame(), /Stop the model server/);

  await press('x', ENTER);
  assert.equal(client.of('/api/stop').length, 0, 'Enter is not a yes');
  await press('y');
  await sleep(60);
  assert.equal(client.of('/api/stop').length, 1);
  assert.equal(client.of('/api/start').length, 0);
});

test('a model that was already running shows no invented uptime; a server-sent startedAt fills it in', async (t) => {
  const appStore = runningStore({ observedStart: false });
  const { frame } = mount(t, fakeDashboard(), appStore);
  await sleep(150);
  assert.match(frame().split('\n')[0], /● alpha-27b-Q4_K_XL · ctx 131,072 · RX 7900 XTX \+ RTX 3060, 3:1 · uptime unknown/);
  appStore.onSSEEvent({
    state: 'ready', model: 'alpha-27b-Q4_K_XL.gguf', log: '', launchCommand: '/x/llama-server --port 8080',
    launchConfig: RUNNING_CONFIG, startedAt: Date.now() - 3723000,
  });
  await sleep(60);
  assert.match(frame().split('\n')[0], /up 01:02:0\d/);
});

test('restart (R) asks, then stops and starts the SAME config, waiting out the old process', async (t) => {
  const stillRunning = () => httpError(400, { error: 'Running' });
  const client = fakeDashboard({ start: [stillRunning(), stillRunning()] });
  const { frame, press, launched } = mount(t, client, runningStore());
  await sleep(150);
  await press('R');
  assert.match(frame(), /Restart alpha-27b-Q4_K_XL \(up 00:00:0\d\)\? It stops, then starts again with the same config\. \[y\/N\]/);
  await press('n');
  assert.equal(client.posts.filter(([p]) => p === '/api/stop' || p === '/api/start').length, 0);

  await press('R', 'y');
  await sleep(1500); // two "Running" answers, 400 ms apart, then accepted
  const calls = client.posts.filter(([p]) => p === '/api/stop' || p === '/api/start').map(([p]) => p);
  assert.deepEqual(calls, ['/api/stop', '/api/start', '/api/start', '/api/start'], 'stop first, start retried until the old server is gone');
  const starts = client.of('/api/start');
  assert.deepEqual(starts[2], RUNNING_CONFIG, 'the running launch config, resent as it was');
  assert.equal('force' in starts[2], false);
  assert.equal(launched.length, 1);
});

test('launching a profile while a server runs: the second confirmation names the server, y stops it first', async (t) => {
  const client = fakeDashboard({ busy: [] });
  const { frame, press, launched } = mount(t, client, runningStore());
  await sleep(150);
  await press(DOWN, DOWN, DOWN, ENTER); // fresh · alpha 64k
  await sleep(100);
  let out = frame();
  assert.match(out, /Launch profile “fresh · alpha 64k”/);
  assert.match(out, /Launching will:\n\s+• stop the running server \(alpha-27b-Q4_K_XL, up 00:00:0\d\) first/);
  await press(ENTER);
  out = frame();
  assert.match(out, /Launch anyway\? This will:/);
  assert.equal(client.of('/api/stop').length + client.of('/api/start').length, 0);
  await press('y');
  await sleep(350);
  const calls = client.posts.filter(([p]) => p === '/api/stop' || p === '/api/start').map(([p]) => p);
  assert.deepEqual(calls, ['/api/stop', '/api/start']);
  assert.equal(client.of('/api/start')[0].ctx, 65536);
  assert.equal('force' in client.of('/api/start')[0], false, 'stopping your own server is not a force');
  assert.equal(launched.length, 1);
});

test('a profile whose model file is missing says so in the confirm panel and asks twice', async (t) => {
  const client = fakeDashboard({ busy: [] });
  const { frame, press } = mount(t, client, stoppedStore());
  await sleep(150);
  await press(DOWN, DOWN, ENTER); // gone · beta Q6
  await sleep(100);
  let out = frame();
  assert.match(out, /model\s+beta-27b-Q6_K_XL\s+✗ model file not found/);
  assert.match(out, /• probably fail to start — model file not found: \/models\/beta-27b-Q6_K_XL\.gguf/);
  await press(ENTER);
  assert.match(frame(), /Launch anyway\?/);
  assert.equal(client.of('/api/start').length, 0);
  await press(ESC);
  assert.doesNotMatch(frame(), /Launch anyway\?/);
});

test('e opens the config editor on the selected profile (the secondary step); b reviews the draft; Esc returns', async (t) => {
  const client = fakeDashboard({ busy: BUSY });
  const { frame, press, gate, launched } = mount(t, client, stoppedStore());
  await sleep(150);
  await press('e');
  await sleep(500); // preview debounce
  let out = frame();
  assert.match(out, /▏core □hw □cache □spec □sample □chat □raw\s+profile: daily · alpha Q4/);
  assert.match(out, /Model\s+alpha-27b-Q4_K_XL\.gguf/);
  assert.match(out, /Context\s+131072/);
  assert.match(out, /command:/);
  assert.match(out, /b: launch.*Esc: profiles/);
  assert.equal(gate.current, false);

  // The editor launches through the same review, busy guard included.
  await press('b');
  await sleep(100);
  out = frame();
  assert.match(out, /Launch the config from the editor \(profile “daily · alpha Q4”\)/);
  assert.match(out, /CARD BUSY/);
  assert.equal(client.of('/api/start').length, 0);
  await press(ENTER, 'y');
  await sleep(350);
  assert.equal(client.of('/api/start').length, 1);
  assert.equal(client.of('/api/start')[0].force, true);
  assert.equal('rawCommand' in client.of('/api/start')[0], false);
  assert.equal(launched.length, 1);
});

test('editor: Esc goes back to the profiles; n opens it without loading a profile', async (t) => {
  const client = fakeDashboard();
  const { frame, press } = mount(t, client, stoppedStore());
  await sleep(150);
  await press('n');
  assert.match(frame(), /▏core □hw.*\(new config — p saves it as a profile\)/);
  await press(ESC);
  await sleep(60);
  assert.match(frame(), /Profiles · 4 saved/);
  assert.doesNotMatch(frame(), /▏core/);
});

test('a Strata-engine profile launches as engine + base config (no rawCommand); e opens the Strata editor, not the llama-server one', async (t) => {
  const client = fakeDashboard({ busy: [] });
  const { frame, press, launched } = mount(t, client, stoppedStore());
  await sleep(150);
  await press(DOWN, 'e');
  await sleep(100);
  assert.match(frame(), /Strata engine\s+profile: strata coder 262k/);
  assert.doesNotMatch(frame(), /▏core/, 'not the llama-server editor');
  await press(ESC);
  await sleep(60);
  assert.match(frame(), /Profiles · 4 saved/, 'Esc goes back to the list');

  await press(ENTER);
  await sleep(100);
  const out = frame();
  assert.match(out, /Launch profile “strata coder 262k”/);
  assert.match(out, /model\s+strata coder-iq1_m-262k-int8/);
  assert.match(out, /build Strata engine/);
  assert.match(out, /command\s+\/strata\/queue-serve\.sh \/strata\/strata-coder-iq1_m-262k-int8\.json --port 8080/);
  await press(ENTER);
  await sleep(350);
  assert.deepEqual(client.of('/api/start'), [{ engine: 'strata', strataBase: STRATA.strataBase, temperature: 1, topK: 20, topP: 0.95 }]);
  assert.equal(launched.length, 1);
});

// 2026-10-17: the settings of the benchmark's two-XTX Strata config, set from the terminal: the base config's own
// values shown as "base: ...", typed overrides validated, saved back into the profile (its tuning note kept, no
// rawCommand), and launched through the same review with exactly those overrides.
test('Strata editor: fields show the base file\'s values; overrides are validated, saved into the profile and launched', async (t) => {
  const client = fakeDashboard({ busy: [] });
  const base = client.getJson;
  client.getJson = async (p) => (p === '/api/strata/configs'
    ? {
      configs: [{ path: STRATA.strataBase, name: 'strata-coder-iq1_m-262k-int8.json', maxContext: '262144', install: '/strata', version: '0.1.44.1',
        settings: { maxContext: 262144, kv: 'int8', spec: 4, specMinP: 0.5, pipelineWindows: null, gpu: '0', stageTrim: 'off', kernelCopy: 'off', temperature: 1, topK: 20, topP: 0.95 } }],
      installs: [{ dir: '/strata', version: '0.1.44.1', label: 'Strata 0.1.44.1 (current)', serveScript: '/strata/queue-serve.sh', thpOff: true }],
    }
    : base(p));
  client.store.profiles['strata coder 262k'].config.tuningNote = 'keep me';
  const { frame, press } = mount(t, client, stoppedStore());
  await sleep(150);
  await press(DOWN, 'e');
  await sleep(150);
  let out = frame();
  assert.match(out, /Base config\s+coder-iq1_m-262k-int8 {2}\(Strata 0\.1\.44\.1\)/);
  assert.match(out, /Spec n\s+base: 4/);
  assert.match(out, /Pipeline win\.\s+base\b/);
  assert.match(out, /GPUs\s+base: 0/);
  assert.match(out, /Strata 0\.1\.44\.1 \(current\) — launcher runs the server with THP off/);
  await sleep(500); // preview debounce
  assert.match(frame(), /command:\s+\/strata\/queue-serve\.sh/);

  // Spec n (row 5): a bad value is refused, a good one taken
  await press(DOWN, DOWN, DOWN, DOWN, ENTER);
  await press('x', ENTER);
  assert.match(frame(), /Spec n must be a whole number/);
  await press(ESC, ENTER, '3', ENTER);
  assert.match(frame(), /Spec n\s+3/);
  // Spec min-p
  await press(DOWN, ENTER, '0.7', ENTER);
  // Pipeline windows: a list (base / 0 / 1 / 2)
  await press(DOWN, ENTER);
  assert.match(frame(), /Select Pipeline win\./);
  await press('2', ENTER);
  assert.match(frame(), /Pipeline win\.\s+2 — next verify window/);
  // Resident GiB, GPUs, layer split (an invalid split is refused)
  await press(DOWN, ENTER, '40', ENTER);
  await press(DOWN, ENTER, '0,1', ENTER);
  await press(DOWN, ENTER, '1', ENTER);
  assert.match(frame(), /Layer split is "auto" or the first layer/);
  await press(ESC, ENTER, 'auto', ENTER);
  // stage trim, kernel copy: on
  await press(DOWN, ENTER, 'on', ENTER);
  await press(DOWN, ENTER, 'on', ENTER);
  out = frame();
  assert.match(out, /Stage trim\s+on — STRATA_STAGE_TRIM=1/);
  assert.match(out, /Kernel copy\s+on — STRATA_HIP_ADAPT_KERNEL_COPY=1/);
  // d puts kernel copy back to the base file's value
  await press('d');
  assert.match(frame(), /Kernel copy\s+base: off/);
  await press(ENTER, 'on', ENTER);

  // save under the loaded name
  await press('p');
  await sleep(60);
  await press(ENTER);
  await sleep(200);
  const saved = client.of('/api/profiles').find((b) => b.config);
  assert.deepEqual(saved.config, {
    engine: 'strata', strataBase: STRATA.strataBase, temp: 1, topK: 20, topP: 0.95, tuningNote: 'keep me',
    spec: 3, specMinP: 0.7, pipelineWindows: 2, residentBudgetGib: 40, gpu: '0,1', layerSplit: 'auto', stageTrim: 'on', kernelCopy: 'on',
  });
  assert.equal('rawCommand' in saved.config, false);

  // review and launch: the overrides go to /api/start as the server's keys
  await press('b');
  await sleep(150);
  assert.match(frame(), /Launch the config from the editor/);
  await press(ENTER);
  await sleep(350);
  const start = client.of('/api/start')[0];
  assert.deepEqual(start, {
    engine: 'strata', strataBase: STRATA.strataBase, spec: 3, specMinP: 0.7, pipelineWindows: 2, residentBudgetGib: 40,
    gpu: '0,1', layerSplit: 'auto', stageTrim: 'on', kernelCopy: 'on', temperature: 1, topK: 20, topP: 0.95,
  });
});

test('Strata editor: N opens an empty one; the base config comes from the dashboard\'s list; Esc returns to the profiles', async (t) => {
  const client = fakeDashboard();
  const { frame, press } = mount(t, client, stoppedStore());
  await sleep(150);
  await press('N');
  await sleep(100);
  assert.match(frame(), /\(new Strata config — p saves it as a profile\)/);
  assert.match(frame(), /Base config\s+\(none — press Enter to pick\)/);
  await press('b');
  assert.match(frame(), /Pick a base config first/);
  await press(ENTER);
  assert.match(frame(), /Select Base config/);
  assert.match(frame(), /coder-iq1_m-262k-int8/);
  await press(ENTER);
  await sleep(500);
  assert.match(frame(), /Base config\s+coder-iq1_m-262k-int8/);
  assert.match(frame(), /command:\s+\/strata\/queue-serve\.sh \/strata\/strata-coder-iq1_m-262k-int8\.json --port 8080/);
  assert.equal(client.of('/api/preview-command').at(-1).engine, 'strata');
  await press(ESC);
  await sleep(60);
  assert.match(frame(), /Profiles · 4 saved/);
});

test('profile list: d asks before deleting; r renames (keeping web-only keys and the last-used stamp); c duplicates', async (t) => {
  const client = fakeDashboard();
  const { frame, press } = mount(t, client, stoppedStore());
  await sleep(150);

  await press('d');
  assert.match(frame(), /Delete profile "daily · alpha Q4"\? \[y\/N\]/);
  await press('n');
  assert.ok(client.store.profiles['daily · alpha Q4'], 'n keeps it');

  await press(DOWN, 'c'); // strata coder 262k
  assert.match(frame(), /Duplicate profile "strata coder 262k" as/);
  await press(ENTER); // accept the offered "... (copy)" name
  await sleep(120);
  const copy = client.store.profiles['strata coder 262k (copy)'];
  assert.ok(copy, 'copy saved');
  assert.equal(copy.config.engine, 'strata', 'a Strata copy still launches: engine kept');
  assert.equal(copy.config.strataBase, STRATA.strataBase);
  assert.equal('rawCommand' in copy.config, false, 'rawCommand left behind');
  assert.match(frame(), /Profiles · 5 saved/);

  // The new copy sorts first (just saved) and is selected; the daily profile is next.
  assert.match(frame(), /^› {3}strata coder 262k \(copy\)/m);
  await press(DOWN, 'r');
  assert.match(frame(), /Rename profile "daily · alpha Q4" to/);
  await press('!', ENTER);
  await sleep(120);
  assert.equal('daily · alpha Q4' in client.store.profiles, false, 'old name removed');
  const renamed = client.store.profiles['daily · alpha Q4!'];
  assert.ok(renamed);
  assert.equal(renamed.config.tuningNote, 'two-card daily driver');
  assert.equal(renamed.lastLoadedAt, PROFILES['daily · alpha Q4'].lastLoadedAt, 'keeps its place in the list');
  const order = client.posts.filter(([p, b]) => (p === '/api/profiles' && b.name === 'daily · alpha Q4!') || p === 'DELETE').map(([p]) => p);
  assert.deepEqual(order, ['/api/profiles', 'DELETE'], 'saved under the new name before the old one is dropped');

  await press('d', 'y');
  await sleep(120);
  assert.equal('daily · alpha Q4!' in client.store.profiles, false);
  assert.match(frame(), /Deleted "daily · alpha Q4!"/);
});

test('with no saved profiles Launch opens the config editor; l / Esc shows the (empty) list with what to do', async (t) => {
  const client = fakeDashboard({ profiles: {} });
  const { frame, press } = mount(t, client, stoppedStore());
  await sleep(150);
  assert.match(frame(), /▏core □hw/);
  await press('l');
  await sleep(60);
  assert.match(frame(), /No profiles saved yet — press n to open the config editor/);
});

test('app: Launch tab lands on the profiles; a click selects a row; ? shows that screen\'s keys and keeps Launch state; no Bench/History tabs', async (t) => {
  const client = fakeDashboard();
  const appStore = stoppedStore();
  const view = render(React.createElement(App, { client, appStore, serverUrl: 'http://fake' }));
  t.after(view.unmount);
  await sleep(60);
  assert.doesNotMatch(view.lastFrame() || '', /Bench|History/, 'placeholder tabs are gone');
  view.stdin.write('4');
  await sleep(40);
  assert.match(view.lastFrame() || '', /no model loaded/, '4 is not a mode any more: still Monitor');

  view.stdin.write('2');
  await sleep(150);
  let out = view.lastFrame() || '';
  assert.match(out, /Profiles · 4 saved/);
  assert.match(out, /^› {3}daily · alpha Q4/m);

  // Rows: status bar 2 + blank 1, Launch header 2, list header 3 -> first
  // profile on row 9; row 11 is the third profile.
  view.stdin.write(click(20, 11));
  await sleep(60);
  out = view.lastFrame() || '';
  assert.match(out, /^› ✗ gone · beta Q6/m, 'click selected the third row');
  assert.equal(client.of('/api/start').length, 0, 'a click never launches');

  view.stdin.write('?');
  await sleep(60);
  out = view.lastFrame() || '';
  assert.match(out, /Help/);
  assert.match(out, /Profiles \(the first screen\)/);
  assert.match(out, /review it: resolved command, cards, busy-card warnings/);
  assert.doesNotMatch(out, /next \/ previous field group/, "the editor's keys are not on the profile screen's help");
  assert.doesNotMatch(out, /PROFILE\s+MODEL\s+CTX/, 'help replaces the mode view instead of running off the screen');
  view.stdin.write('x'); // must not reach the hidden Launch
  await sleep(40);
  view.stdin.write(ESC);
  await sleep(60);
  out = view.lastFrame() || '';
  assert.match(out, /^› ✗ gone · beta Q6/m, 'selection survived the help overlay');
  assert.doesNotMatch(out, /No model running/);

  view.stdin.write('e');
  await sleep(100);
  view.stdin.write('?');
  await sleep(60);
  out = view.lastFrame() || '';
  assert.match(out, /Config editor/);
  assert.match(out, /next \/ previous field group/);
  assert.doesNotMatch(out, /Profiles \(the first screen\)/);
});

test('editing a profile for another build never merges it against the previous build\'s cards', async (t) => {
  // Build "vk" lists the XTX as Vulkan1 only; build "all" lists it as ROCm0 and Vulkan1.
  const xtx = (backends) => ({ name: 'AMD Radeon RX 7900 XTX', vendor: 'amd', preferredId: backends[0], ambiguous: false, backends: backends.map((id) => ({ id, totalMib: 24560, freeMib: 20000 })) });
  const client = fakeDashboard({
    profiles: {
      'vk one': { config: { modelPath: '/models/alpha-27b-Q4_K_XL.gguf', build: 'vk', ctx: 8192, ngl: 99, devices: [{ id: 'Vulkan1', name: 'AMD Radeon RX 7900 XTX' }] }, savedAt: 2, lastLoadedAt: 20 },
      'rocm one': { config: { modelPath: '/models/alpha-27b-Q4_K_XL.gguf', build: 'all', ctx: 8192, ngl: 99, devices: [{ id: 'ROCm0', name: 'AMD Radeon RX 7900 XTX' }] }, savedAt: 1, lastLoadedAt: 10 },
    },
  });
  const base = client.getJson;
  let releaseAll;
  const allCards = new Promise((r) => { releaseAll = r; });
  client.getJson = async (p) => {
    if (p === '/api/devices?build=vk') return { devices: [], cards: [xtx(['Vulkan1'])], workers: [] };
    if (p === '/api/devices?build=all') { await allCards; return { devices: [], cards: [xtx(['ROCm0', 'Vulkan1'])], workers: [] }; }
    return base(p);
  };
  const { frame, press } = mount(t, client, stoppedStore());
  await sleep(150);
  await press('e'); // vk one: its cards load
  await sleep(100);
  await press('\t');
  assert.match(frame(), /\[x\] RX 7900 XTX\s+Vulkan1/);
  await press(ESC, DOWN, 'e'); // rocm one, while build "all"'s device list is still on its way
  await sleep(100);
  await press('\t');
  assert.match(frame(), /\[x\] RX 7900 XTX\s+ROCm0/, 'the saved ROCm0 is not re-pointed by the other build\'s card list');
  releaseAll();
  await sleep(600);
  assert.match(frame(), /\[x\] RX 7900 XTX\s+ROCm0 \(v: ROCm0\/Vulkan1\)/);
  const last = client.of('/api/preview-command').pop();
  assert.deepEqual(last.devices, [{ id: 'ROCm0', name: 'AMD Radeon RX 7900 XTX', vramMib: 24560, enabled: true }], 'the card\'s size rides along (the server\'s stand-in check reads it)');
});
