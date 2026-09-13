import { test } from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { render } from 'ink-testing-library';
import { FuzzyList } from '../src/components/fuzzylist.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('fuzzylist: a multi-char paste filters the list instead of being dropped', async (t) => {
  const items = [
    { label: 'alpha-7b.gguf', hint: 'local', value: 'a' },
    { label: 'beta-35b.gguf', hint: 'local', value: 'b' },
    { label: 'gamma-1m.gguf', hint: 'hf', value: 'g' },
  ];
  const view = render(React.createElement(FuzzyList, { items, height: 10, onSelect: () => {}, onCancel: () => {} }));
  t.after(view.unmount);
  await sleep(30);
  assert.match(view.lastFrame() || '', /alpha-7b\.gguf/, 'starts unfiltered');

  // A middle-click paste arrives as ONE multi-char event (previously
  // dropped wholesale -- only single characters reached the filter).
  view.stdin.write('beta-35b.gguf');
  await sleep(30);
  const out = view.lastFrame() || '';
  assert.match(out, /filter: beta-35b\.gguf/, 'paste appended whole to the filter');
  assert.match(out, /beta-35b\.gguf/, 'pasted subsequence matched');
  assert.doesNotMatch(out, /alpha-7b/, 'non-matching items filtered out');
});
