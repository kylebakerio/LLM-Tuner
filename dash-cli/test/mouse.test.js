import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
import App from '../src/app.js';
import { createAppStore } from '../src/state.js';

// ink-testing-library's stub Stdout is fixed at 100 columns -- the tab/field
// column math below is derived for that width (see StatusBar.tabLayout and
// Launch's groupTabsRow/fieldsStartRow comments).
const client = {
  getJson: async (path) => (path.startsWith('/api/logs') ? { rows: [] } : {}),
  postJson: async (path) => (path === '/api/preview-command' ? { command: '' } : {}),
  connect() {},
  close() {},
};

// One left-button press: SGR mouse mode, SGR-convention numbering
// (button 0 = left), 1-indexed col/row.
const click = (x, y) => `\x1b[<0;${x};${y}M`;
// The X11-style variant some terminals report (button 1 = left) -- must
// work identically.
const x11Click = (x, y) => `\x1b[<1;${x};${y}M`;

// Captures the raw ?1000/?1006 escape writes mouse.js makes on the REAL
// process.stdout (ink-testing-library's frame capture doesn't see them).
function trackEscapeWrites() {
  const written = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk, ...rest) => {
    written.push(String(chunk));
    return orig(chunk, ...rest);
  };
  return {
    written,
    stop() { process.stdout.write = orig; },
  };
}

test('mouse: clicking the Launch tab switches mode, clicking a group tab and a toggle field works', async (t) => {
  const appStore = createAppStore();
  appStore.onConnState('live'); // clears the offline-warning row so the row math below doesn't need to account for it
  const view = render(React.createElement(App, { client, appStore, serverUrl: 'http://localhost:3000' }));
  t.after(view.unmount);
  await sleep(50);
  assert.match(view.lastFrame() || '', /1 Monitor/, 'starts on Monitor');

  // Tab strip (row 2): " 1 Monitor " (11) + "  2 Launch " (12) -> Launch
  // spans columns 12-23. Click well inside it.
  view.stdin.write(click(15, 2));
  await sleep(50);
  let out = view.lastFrame() || '';
  assert.match(out, /LAUNCH/, 'click on the Launch tab switched modes');

  await sleep(700); // catalog load + preview debounce, same as the existing Launch render test

  // Group-tab row: title(1) + running(0, no model loaded) + blank(1) +
  // offline(0, connected) + 1 = row 6. Groups render back-to-back with no
  // gap: " *core"(6) + " *hw"(4) + " *cache"(7) -> cache spans columns 11-17.
  out = view.lastFrame() || '';
  assert.match(out, /core/, 'sanity: default group is core');
  view.stdin.write(click(13, 6));
  await sleep(50);
  out = view.lastFrame() || '';
  const cacheLine = out.split('\n').find((l) => /Flash attn/.test(l));
  assert.ok(cacheLine, 'clicking the cache group tab brought Flash attn into view');
  assert.match(cacheLine, /\boff\b/, 'fa toggle starts off');

  // Field rows start right below the group-tab row (row 7); 'fa' is the
  // first field in the cache group.
  view.stdin.write(click(5, 7));
  await sleep(50);
  out = view.lastFrame() || '';
  const faLine = out.split('\n').find((l) => /Flash attn/.test(l));
  assert.match(faLine, /\bon\b/, 'clicking the fa field row flipped the toggle');
});

test('mouse: tab clicks land with a long model name (header must not wrap)', async (t) => {
  // The old header overflowed by a column or two whenever a model was
  // running (port + uptime) and the name was long, wrapping to a second
  // row and shifting the tab strip from row 2 to row 3 -- every click then
  // missed. Regression test: worst-case header (ready + uptime + a name far
  // longer than the model budget + the brand) must still put the tabs on
  // row 2, and the click must land.
  const appStore = createAppStore();
  appStore.onConnState('live');
  appStore.onSSEEvent({ state: 'starting', model: '', log: '' });
  appStore.onSSEEvent({
    state: 'ready',
    model: 'Qwen3.8-27B-Instruct-262K-GGUF-q8_0-my-very-long-model-name.gguf',
    launchCommand: '/x/llama-server -m /y/model.gguf --port 8080',
    launchConfig: {}, log: '',
  });
  const view = render(React.createElement(App, { client, appStore, serverUrl: 'http://localhost:3000' }));
  t.after(view.unmount);
  await sleep(50);
  const lines = (view.lastFrame() || '').split('\n');
  assert.match(lines[0] || '', /Llama CLI/, 'header row intact (no mangling)');
  assert.match(lines[1] || '', /1 Monitor/, 'tab strip is on row 2 (header did not wrap)');

  view.stdin.write(click(15, 2));
  await sleep(50);
  assert.match(view.lastFrame() || '', /LAUNCH/, 'clicking the Launch tab (row 2) switched modes');
});

test('mouse: X11-style (1-based) left-button clicks work like SGR-convention ones', async (t) => {
  const appStore = createAppStore();
  appStore.onConnState('live');
  const view = render(React.createElement(App, { client, appStore, serverUrl: 'http://localhost:3000' }));
  t.after(view.unmount);
  await sleep(50);
  assert.match(view.lastFrame() || '', /1 Monitor/, 'starts on Monitor');

  // Same Launch-tab position as above, but with X11-style button numbering
  // (left = 1, not 0) -- the convention several terminals report. Must
  // switch modes exactly like the SGR-convention form.
  view.stdin.write(x11Click(15, 2));
  await sleep(50);
  assert.match(view.lastFrame() || '', /LAUNCH/, '1-based left click switched modes');

  // Button 2 (middle in the X11 convention, right in the SGR one) must NOT
  // count as a left click under either convention.
  view.stdin.write('\x1b[<2;15;2M');
  await sleep(50);
  assert.match(view.lastFrame() || '', /LAUNCH/, 'button 2 is not a left click');
});

test('mouse: tracking suspends while a text editor is open (middle-click paste)', async (t) => {
  const tracker = trackEscapeWrites();
  const appStore = createAppStore();
  appStore.onConnState('live');
  const view = render(React.createElement(App, { client, appStore, serverUrl: 'http://localhost:3000' }));
  t.after(() => { view.unmount(); tracker.stop(); });
  try {
    await sleep(50);
    const esc = (s) => tracker.written.filter((w) => w.includes(s));
    assert.ok(esc('?1000h').length >= 1, 'tracking enabled on mount');

    // Switch to Launch, open the ctx text editor (2nd field down from the
    // default focus + Enter).
    view.stdin.write('2');
    await sleep(50);
    view.stdin.write('\x1b[B');
    view.stdin.write('\x1b[B');
    await sleep(50);
    view.stdin.write('\r');
    await sleep(50);
    let out = view.lastFrame() || '';
    assert.match(out, /Enter to commit, Esc to cancel/, 'text editor is open');
    const enabledBefore = esc('?1000h').length;
    const positions = (s) => tracker.written.map((w, i) => (w.includes(s) ? i : -1)).filter((i) => i >= 0);
    assert.ok(positions('?1000l').length > 0, 'tracking disabled while the editor is open');
    assert.ok(Math.max(...positions('?1000l')) > Math.max(...positions('?1000h')),
      'the disable lands after the last enable');

    // Closing the editor restores tracking.
    view.stdin.write('\x1b');
    await sleep(50);
    out = view.lastFrame() || '';
    assert.doesNotMatch(out, /Enter to commit/, 'editor closed');
    assert.ok(esc('?1000h').length > enabledBefore, 'tracking re-enabled after the editor closes');
  } finally {
    tracker.stop();
  }
});
