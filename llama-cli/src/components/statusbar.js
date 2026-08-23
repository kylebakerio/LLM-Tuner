import React from 'react';
import { Box, Text, useStdout } from 'ink';
import { fmtUptime, portFromCommand } from '../format.js';
import { h } from '../h.js';

const TABS = [
  ['1', 'Monitor', 'mode1'],
  ['2', 'Launch', 'mode2'],
  ['3', 'Chat', 'mode3'],
  ['4', 'Bench', 'mode4'],
  ['5', 'History', 'mode5'],
];

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

  // Keep the top line on one row: truncate the (often long) model name to fit,
  // and drop the trailing "Mission Control" brand on narrow terminals.
  const modelMax = Math.max(14, cols - 58);
  const rawModel = server.model || 'no model loaded';
  const model = rawModel.length > modelMax ? rawModel.slice(0, modelMax - 1) + '\u2026' : rawModel;
  const showBrand = cols >= 96;

  const tabs = TABS.map(([key, label, modeId], i) => {
    const active = mode === modeId;
    const built = modeId === 'mode1' || modeId === 'mode2';
    const text = h(Text, null,
      i > 0 ? '  ' : '',
      active
        ? h(Text, { bold: true, color: 'white', backgroundColor: 'blue' }, ` ${key} ${label} `)
        : built
          ? h(Text, { dimColor: true }, ` ${key} ${label} `)
          : h(Text, { color: 'gray' }, ` ${key} ${label}\u00B7 `),
    );
    return text;
  });

  return h(Box, { flexDirection: 'column' },
    h(Box, { justifyContent: 'space-between' },
      h(Box, null,
        h(Text, { bold: true, color: 'blue' }, 'Llama CLI'),
        h(Text, { dimColor: true }, `  ${model}`),
        h(Text, { color: stateColor }, `  [${server.state}]`),
        running ? h(Text, { dimColor: true }, `  :${port}`) : null,
        running && uptime ? h(Text, { dimColor: true }, `  up ${uptime}`) : null,
      ),
      h(Box, null,
        conn === 'live'
          ? h(Text, { color: 'green' }, '\u25CF ')
          : conn === 'reconnecting'
            ? h(Text, { color: 'yellow' }, '\u25CC reconnecting')
            : h(Text, { color: 'red' }, '\u25CB offline'),
        showBrand ? h(Text, { dimColor: true }, '  Mission Control') : null,
      ),
    ),
    h(Box, null, ...tabs),
  );
}

// Bottom line: contextual key hints.
export function KeymapBar({ hints }) {
  return h(Box, null,
    h(Text, { dimColor: true },
      hints.map(([k, label], i) => `${i > 0 ? '  ' : ''}${k}: ${label}`).join('')),
  );
}
