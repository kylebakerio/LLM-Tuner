import { useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { h } from './h.js';
import { Monitor } from './modes/monitor.js';
import { Launch } from './modes/launch.js';
import { StatusBar } from './components/statusbar.js';
import { Help } from './components/help.js';
import { useAppStore } from './state.js';

const COMING_SOON = {
  mode3: ['Chat', 'Phase 3'],
  mode4: ['Bench', 'Phase 4'],
  mode5: ['History', 'Phase 5'],
};

export default function App({ client, appStore, serverUrl }) {
  const { exit } = useApp();
  const s = useAppStore(appStore);
  const [mode, setMode] = useState('mode1');
  const [showHelp, setShowHelp] = useState(false);
  // Set by the active mode while it owns the keyboard (field editors,
  // confirms, in-flight actions). The app-level handler stands down then,
  // except Ctrl-C which always exits.
  const modeGateRef = useRef(false);

  useInput((input, key) => {
    if (key.ctrl && input === 'c') { exit(); return; }
    const busy = showHelp || modeGateRef.current;
    if (busy) {
      if (showHelp && (key.escape || input === '?')) setShowHelp(false);
      return;
    }
    // length check: a pasted "12" arrives as ONE input event and string-
    // compares as < "5", which would set an invalid mode and blank the
    // main area until a valid key is pressed.
    if (input === '?') setShowHelp((hh) => !hh);
    else if (input === 'q' && !key.ctrl) exit();
    else if (input.length === 1 && input >= '1' && input <= '5') setMode(`mode${input}`);
  });

  const coming = COMING_SOON[mode];
  return h(Box, { flexDirection: 'column' },
    h(StatusBar, { mode, conn: s.conn, server: s.server, modelUpSince: s.modelUpSince }),
    h(Text, null, ' '),
    mode === 'mode1'
      ? h(Monitor, {
          appStore, client, serverUrl,
          modeGateRef,
          onLaunchMode: () => setMode('mode2'),
        })
      : null,
    mode === 'mode2'
      ? h(Launch, {
          appStore, client, serverUrl,
          modeGateRef,
          onLaunched: () => setMode('mode1'),
        })
      : null,
    coming
      ? h(Box, { flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 2 },
        h(Text, { bold: true, color: 'blue' }, `${coming[0]} mode`),
        h(Text, { dimColor: true }, `not built yet \u2014 ships in ${coming[1]}`),
        h(Text, { dimColor: true }, 'press 1 or 2 for Monitor / Launch'),
      )
      : null,
    showHelp ? h(Help, { mode }) : null,
  );
}
