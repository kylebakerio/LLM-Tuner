import { useRef, useState } from 'react';
import { Box, Text, useApp, useInput } from 'ink';
import { h } from './h.js';
import { Monitor } from './modes/monitor.js';
import { Launch } from './modes/launch.js';
import { Chat } from './modes/chat.js';
import { StatusBar, tabLayout } from './components/statusbar.js';
import { Help } from './components/help.js';
import { useAppStore } from './state.js';
import { useMouseClicks } from './mouse.js';

const COMING_SOON = {
  mode4: ['Bench', 'Phase 4'],
  mode5: ['History', 'Phase 5'],
};

const TAB_ROW = 2; // StatusBar's second row, 1-indexed

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
    // Alt+1..5 switches modes unconditionally, even while a mode owns the
    // keyboard (Chat's text input swallows a bare digit as a message
    // character -- see Chat's modeGateRef comment). Alt sends the digit
    // prefixed with ESC, which Ink reports as key.meta rather than folding
    // into `input`, so it can never land in a text field as a stray digit.
    //
    // Ctrl+1..5 is deliberately NOT used here: a terminal emits Ctrl+N as the
    // raw control byte \x0N, which is byte-identical to Ctrl+<Nth letter>. So
    // Ctrl+3 == Ctrl+C (exit) and Ctrl+4 == Ctrl+D (EOF) on EVERY terminal --
    // binding them to "tab 3 / tab 4" would quit or kill the app. The
    // terminal-agnostic tab jump from Chat is the /1../5 commands (chat.js);
    // clicking the tab strip (row 2) also works.
    if (key.meta && input.length === 1 && input >= '1' && input <= '5') { setMode(`mode${input}`); return; }
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

  // Mouse click support: Monitor/Launch only -- Chat leaves the terminal's
  // native mouse tracking alone so primary-selection copy and middle-click
  // paste keep working there (see mouse.js / chat.js's header comment), and
  // there is nothing clickable in Chat, Bench or History today either way.
  const mouseActive = mode === 'mode1' || mode === 'mode2';
  useMouseClicks(mouseActive, ({ x, y }) => {
    if (showHelp || modeGateRef.current) return;
    if (y === TAB_ROW) {
      let col = 1;
      for (const t of tabLayout(mode)) {
        if (x >= col && x < col + t.text.length) {
          if (t.built) setMode(t.modeId);
          return;
        }
        col += t.text.length;
      }
    }
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
    // Chat is rendered unconditionally (not `mode === 'mode3' ? ... : null`)
    // so its conversation + any in-flight request stay mounted while you
    // switch to Monitor/Launch and back -- unmounting it used to drop the
    // live thinking stream. It hides its own output while `visible` is false.
    h(Chat, {
      appStore, client, serverUrl,
      modeGateRef,
      visible: mode === 'mode3',
      onMode: (m) => setMode(m),
      onExit: exit,
      onShowHelp: () => setShowHelp(true),
    }),
    coming
      ? h(Box, { flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 2 },
        h(Text, { bold: true, color: 'blue' }, `${coming[0]} mode`),
        h(Text, { dimColor: true }, `not built yet \u2014 ships in ${coming[1]}`),
        h(Text, { dimColor: true }, 'press 1, 2 or 3 (alt+1..5 from Chat) for Monitor / Launch / Chat'),
      )
      : null,
    showHelp ? h(Help, { mode }) : null,
  );
}
