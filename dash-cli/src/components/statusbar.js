import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { fmtUptime, portFromCommand, modelName } from '../format.js';
import { h } from '../h.js';

const TABS = [
  ['1', 'Monitor', 'mode1'],
  ['2', 'Launch', 'mode2'],
  ['3', 'Chat', 'mode3'],
];

// Exact text of each tab segment, in render order -- shared by the component
// (styling only, characters must match this) and by app.js's mouse-click hit
// testing (cumulative string length = cumulative column width, since every
// glyph here is a single terminal column). Keeping both derived from the
// same list is what keeps clicks from silently drifting off their tabs if
// this ever changes.
export function tabLayout(mode) {
  return TABS.map(([key, label, modeId], i) => {
    const active = mode === modeId;
    const prefix = i > 0 ? '  ' : '';
    const text = `${prefix} ${key} ${label} `;
    return { modeId, label, active, text };
  });
}

// Top lines: brand + model + state + port + uptime + connection dot,
// then the mode tab strip.
export function StatusBar({ mode, conn, server, modelUpSince }) {
  const { stdout } = useStdout();
  const cols = (stdout && stdout.columns) || 80;
  const running = server.state === 'ready';
  const port = portFromCommand(server.launchCommand);
  const uptime = modelUpSince ? fmtUptime(Date.now() - modelUpSince) : null;
  const stateColor = running ? 'green'
    : (server.state === 'starting' || server.state === 'loading' || server.state === 'stopping') ? 'yellow'
      : 'gray';

  // The info line must be EXACTLY one row, at every width and in every
  // state. It is the anchor for the app-wide row math (APP_HEADER_ROWS in
  // mouse.js, the tab-strip click row, every Launch-mode row offset): if it
  // ever wrapped to a second row, the tab strip and everything below it
  // would shift down one and every click would miss -- silently. The old
  // two-Box space-between layout overflowed by a column or two whenever a
  // model was running (port + uptime push it over), mangling the line
  // ("Llama CL") and shifting the tabs to row 3. So it is now ONE Text with
  // wrap: 'truncate-end' -- any width miscalculation (a long state string,
  // a glyph the terminal renders wide) clips the tail instead of wrapping.
  // The right side is right-aligned with computed padding, because a single
  // Text can't do space-between.
  const state = server.state || 'stopped';
  const stateLen = 4 + state.length; // '  [state]'
  const portLen = running ? 2 + String(port).length : 0;
  const upLen = running && uptime ? 13 : 0; // '  up HH:MM:SS'
  const connText = conn === 'live' ? '\u25CF ' : conn === 'reconnecting' ? '\u25CC reconnecting' : '\u25CB offline';
  const brand = cols >= 96 ? '  LL-Dash' : '';
  const fixedLen = 9 + 2 + stateLen + portLen + upLen + connText.length + brand.length;
  const modelMax = Math.max(14, cols - fixedLen - 2);
  const rawModel = (server.model && modelName(server.model)) || 'no model loaded';
  const model = rawModel.length > modelMax ? rawModel.slice(0, Math.max(1, modelMax - 1)) + '\u2026' : rawModel;
  const pad = Math.max(1, cols - fixedLen - model.length);

  return h(Box, { flexDirection: 'column' },
    h(Text, { wrap: 'truncate-end' },
      h(Text, { bold: true, color: 'blue' }, 'Llama CLI'),
      h(Text, { dimColor: true }, `  ${model}`),
      h(Text, { color: stateColor }, `  [${state}]`),
      running ? h(Text, { dimColor: true }, `  :${port}`) : null,
      running && uptime ? h(Text, { dimColor: true }, `  up ${uptime}`) : null,
      h(Text, null, ' '.repeat(pad)),
      conn === 'live'
        ? h(Text, { color: 'green' }, connText)
        : conn === 'reconnecting'
          ? h(Text, { color: 'yellow' }, connText)
          : h(Text, { color: 'red' }, connText),
      brand ? h(Text, { dimColor: true }, brand) : null),
    h(Box, null, ...tabLayout(mode).map((t, i) => {
      const prefix = i > 0 ? '  ' : '';
      const body = t.text.slice(prefix.length); // strip the shared prefix back off -- rendered separately below so styling only ever colors the tab's own glyphs
      return h(Text, { key: t.modeId }, prefix,
        t.active
          ? h(Text, { bold: true, color: 'white', backgroundColor: 'blue' }, body)
          : h(Text, { dimColor: true }, body));
    })),
  );
}

// Bottom line: contextual key hints -- the key in bold, its label dim, so the
// keys read at a glance. An empty list still takes its row (a hint row that
// comes and goes would shift everything above it).
// The hints are keyed by POSITION on purpose: keyed by content, a hint added
// in front of the others is an insert-before inside a Text, which ink 5.2
// doesn't re-measure (insertBeforeNode returns before marking the node
// dirty) -- the line kept its old width and lost its tail.
export function KeymapBar({ hints }) {
  if (!hints || hints.length === 0) return h(Text, null, ' ');
  return h(Box, null,
    h(Text, null,
      hints.map(([k, label], i) => h(Text, { key: i },
        i > 0 ? '  ' : '',
        h(Text, { bold: true, color: 'cyan' }, k),
        h(Text, { dimColor: true }, `: ${label}`)))),
  );
}
