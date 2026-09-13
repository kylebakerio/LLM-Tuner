import { Box, Text } from 'ink';
import { h } from '../h.js';

const HELP = {
  mode1: [
    ['x', 'stop the model server (asks to confirm)'],
    ['s', 'go to Launch mode'],
    ['click', 'mode tabs are clickable here too'],
  ],
  mode2: [
    ['\u2191/\u2193 or j/k', 'move between fields'],
    ['tab / \u2190', 'next / previous field group (core, hw, cache, spec, sample, chat, raw)'],
    ['Enter / \u2192', 'edit the focused field (toggles just flip)'],
    ['click', 'group tabs, field rows, and toggle fields are all clickable'],
    ['p', 'save profile (shared with the web dashboard)'],
    ['l', 'load profile (most recently used first, tagged RPC/Local)'],
    ['d', 'delete loaded profile'],
    ['r', 'rename loaded profile'],
    ['c', 'duplicate loaded profile'],
    ['/', 'flag reference for the build (Enter inserts into raw args)'],
    ['hw › RPC worker', 'on = split with the worker (GPU B locked to None); launch auto-starts it'],
    ['w', 'start/stop the RPC worker on the Worker host (RPC must be on)'],
    ['L', 'worker logs overlay (last 50 lines, refreshes every 3s)'],
    ['b', 'launch (start the model)'],
    ['x', 'stop the model server'],
    ['Esc', 'close the field editor / overlay'],
  ],
  mode3: [
    ['enter', 'send the message'],
    ['esc', 'cancel the in-flight generation'],
    ['^t', 'cycle thinking: xhigh / medium / low / off'],
    ['^w', 'toggle web search (model may call web_search)'],
    ['^o', 'thinking display: last 8 lines → full → hidden (cycle)'],
    ['\u2190/\u2192, ^a/^e', 'move cursor / jump to start / end'],
    ['paste path', 'attach an image, video, or audio file -> [image/video/audio n]'],
    ['middle-click', 'paste the terminal primary selection into the prompt'],
    ['/new', 'clear the conversation'],
    ['/model', 'show the loaded model'],
    ['/temp <0..2>', 'set temperature for this session (reset = model default)'],
    ['/think <lvl>', 'set thinking explicitly (xhigh|medium|low|off)'],
    ['/web <on|off>', 'toggle web search'],
    ['/show thinking | /show full', 'thinking: last 8 lines | every line'],
    ['/hide thinking', 'hide thinking blocks'],
    ['/m / /l', 'go to Monitor / Launch mode'],
    ['/1 .. /5', 'jump to that tab (Ctrl+1..5 is unusable: Ctrl+3=Ctrl+C, Ctrl+4=Ctrl+D)'],
    ['/exit', 'quit the TUI'],
  ],
  mode4: [['\u2014', 'Bench mode ships in Phase 4']],
  mode5: [['\u2014', 'History mode ships in Phase 5']],
};

const GLOBAL = [
  ['1..5 (alt+1..5, or /1../5 in Chat)', 'switch mode (4/5 not built yet)'],
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
