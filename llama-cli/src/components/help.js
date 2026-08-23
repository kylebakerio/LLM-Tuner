import { Box, Text } from 'ink';
import { h } from '../h.js';

const HELP = {
  mode1: [
    ['x', 'stop the model server (asks to confirm)'],
    ['s', 'go to Launch mode'],
  ],
  mode2: [
    ['\u2191/\u2193 or j/k', 'move between fields'],
    ['tab / \u2190', 'next / previous field group (core, hw, cache, spec, sample, chat, raw)'],
    ['Enter / \u2192', 'edit the focused field (toggles just flip)'],
    ['p', 'save profile (shared with the web dashboard)'],
    ['l', 'load profile'],
    ['d', 'delete loaded profile'],
    ['b', 'launch (start the model)'],
    ['x', 'stop the model server'],
    ['Esc', 'close the field editor'],
  ],
  mode3: [['\u2014', 'Chat mode ships in Phase 3']],
  mode4: [['\u2014', 'Bench mode ships in Phase 4']],
  mode5: [['\u2014', 'History mode ships in Phase 5']],
};

const GLOBAL = [
  ['1..5', 'switch mode (3/4/5 not built yet)'],
  ['?', 'toggle this help'],
  ['Ctrl-C', 'quit TUI (server keeps running)'],
  ['q', 'quit TUI (server keeps running)'],
];

export function Help({ mode }) {
  const rows = [...(HELP[mode] || []), ...GLOBAL];
  return h(Box, { borderStyle: 'round', borderColor: 'blue', paddingX: 1, marginTop: 1 },
    h(Box, { flexDirection: 'column' },
      h(Text, { bold: true, color: 'blue' }, 'Help'),
      rows.map(([k, label]) => h(Text, { key: k + label },
        h(Text, { color: 'cyan' }, k.padEnd(16)),
        label,
      )),
    ),
  );
}
