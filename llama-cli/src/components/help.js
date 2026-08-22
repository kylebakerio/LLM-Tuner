import React from 'react';
import { Box, Text } from 'ink';

const HELP = {
  global: [
    ['1..5', 'switch mode (3/4/5 not built yet)'],
    ['?', 'toggle this help'],
    ['Ctrl-C', 'quit TUI (server keeps running)'],
    ['q', 'quit TUI (server keeps running)'],
  ],
  mode1: [
    ['x', 'stop the model server (asks to confirm)'],
    ['s', 'go to Launch mode'],
  ],
  mode2: [
    ['↑/↓ or j/k', 'move between fields'],
    ['Enter / →', 'edit the focused field'],
    ['p', 'save profile'],
    ['l', 'load profile'],
    ['d', 'delete loaded profile'],
    ['b', 'launch (start the model)'],
    ['x', 'stop the model server'],
    ['Esc', 'close the field editor'],
  ],
  mode3: [
    ['—', 'Chat mode ships in Phase 3'],
  ],
  mode4: [
    ['—', 'Bench mode ships in Phase 4'],
  ],
  mode5: [
    ['—', 'History mode ships in Phase 5'],
  ],
};

export function Help({ mode }) {
  const rows = [...HELP[mode] || [], ...HELP.global];
  return (
    <Box borderStyle="round" borderColor="blue" paddingX={1} marginTop={1}>
      <Box flexDirection="column">
        <Text bold color="blue">Help</Text>
        {rows.map(([k, label]) => (
          <Text key={k + label}>
            <Text color="cyan">{k.padEnd(16)}</Text>
            {label}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
