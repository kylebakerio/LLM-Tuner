import { Box, Text } from 'ink';
import { h } from '../h.js';

const HELP = {
  mode1: [
    ['x', 'stop the model server (asks to confirm)'],
    ['s', 'go to Launch mode'],
    ['click', 'mode tabs are clickable here too'],
  ],
  // Launch has three screens; a row with an empty key is a section heading.
  // `?` shows the part for the screen it was pressed on (mode2 = profiles and
  // review, mode2editor = the config editor); Help with no topic shows both.
  mode2: [
    ['', 'Profiles (the first screen)'],
    ['\u2191/\u2193 or j/k', 'select a saved profile (PgUp/PgDn page; click selects too)'],
    ['u', 'hide / show the profiles this machine can\u2019t run (listed last, with why)'],
    ['Enter / \u2192', 'review it: resolved command, cards, busy-card warnings \u2014 nothing starts yet'],
    ['/', 'filter (type; Enter reviews the selected profile, Esc clears)'],
    ['e', 'edit the selected profile in the config editor (a Strata profile: the Strata editor)'],
    ['n', 'config editor without loading a profile (new config / the running one)'],
    ['N', 'Strata editor without loading a profile (a new Strata-engine config)'],
    ['d  r  c', 'delete (asks) / rename / duplicate the selected profile'],
    ['x', 'stop the model server (asks to confirm)'],
    ['R', 'restart it with the same config (asks to confirm)'],
    ['', 'Review (after Enter, or b in the editor)'],
    ['Enter', 'launch \u2014 or, if a card is busy, a server must stop or the file is missing, ask once more'],
    ['y', 'at that second question: go ahead (busy cards are then launched over with force)'],
    ['O', 'a profile this machine can\u2019t run: override, launch it as saved (asks again)'],
    ['e', 'edit before launching'],
    ['Esc', 'back'],
  ],
  mode2editor: [
    ['', 'Config editor (e / n from the profiles)'],
    ['\u2191/\u2193 or j/k', 'move between fields'],
    ['tab / \u2190', 'next / previous field group (core, hw, cache, spec, sample, chat, raw)'],
    ['Enter / \u2192', 'edit the focused field (toggles just flip)'],
    ['click', 'group tabs, field rows, and toggle fields are all clickable'],
    ['p', 'save profile (shared with the web dashboard)'],
    ['/', 'flag reference for the build (Enter inserts into raw args)'],
    ['hw group', 'one row per card + RPC worker, in -dev order; launch auto-starts enabled workers'],
    ['space / Enter', 'on a device row: enable / disable it'],
    ['+ / -', 'on a device row: share up / down by 5'],
    ['e', 'on a device row: type its share (blank = auto)'],
    ['[ / ]', 'on a device row: move it earlier / later (-dev order)'],
    ['v', 'on a device row: next backend id that reaches that card'],
    ['S', 'suggest split: shares from free VRAM'],
    ['Split mode', '2+ devices: Enter switches layer (default) / tensor (experimental)'],
    ['w', 'start/stop the focused (or first enabled) RPC worker'],
    ['L', 'worker logs overlay for that worker (refreshes every 3s)'],
    ['b', 'review this config, then launch (same review screen as a profile)'],
    ['x / R', 'stop / restart the model server (both ask)'],
    ['Esc or l', 'back to the profiles (Esc first closes a field editor / overlay)'],
  ],
  mode2strata: [
    ['', 'Strata editor (e on a Strata profile, N for a new one)'],
    ['\u2191/\u2193 or j/k', 'move between fields'],
    ['Enter / \u2192', 'edit the focused field: base config and fixed choices are a list, the rest typed'],
    ['d / Backspace', 'back to the base config\u2019s value (shown as "base: ..." when nothing is set)'],
    ['fields', 'base config, max context, KV type, KV resident, spec n, spec min-p, pipeline windows, resident GiB, GPUs, layer split, stage trim, kernel copy, RoPE, sampling'],
    ['p', 'save as a profile (shared with the web dashboard)'],
    ['b', 'review, then launch (the same review screen as a profile)'],
    ['x / R', 'stop / restart the model server (both ask)'],
    ['Esc or l', 'back to the profiles'],
  ],
  mode3: [
    ['enter', 'send the message'],
    ['esc', 'cancel the in-flight generation'],
    ['^t', 'cycle thinking: xhigh / medium / low / off'],
    ['^w', 'web search off / back to the last setting (default unlimited)'],
    ['^o', 'thinking display: last 8 lines → full → hidden (cycle)'],
    ['\u2190/\u2192, ^a/^e', 'move cursor / jump to start / end'],
    ['paste path', 'attach an image, video, or audio file -> [image/video/audio n]'],
    ['middle-click', 'paste the terminal primary selection into the prompt'],
    ['/new', 'clear the conversation'],
    ['/model', 'show the loaded model'],
    ['/temp <0..2>', 'set temperature for this session (reset = model default)'],
    ['/think <lvl>', 'set thinking explicitly (xhigh|medium|low|off)'],
    ['/web <on|off>', 'toggle web search'],
    ['/searches <n>', 'web calls (searches + page fetches) per answer: 0 = off, n = up to n, -1 = unlimited'],
    ['/show thinking | /show full', 'thinking: last 8 lines | every line'],
    ['/hide thinking', 'hide thinking blocks'],
    ['/m / /l', 'go to Monitor / Launch mode'],
    ['/1 .. /3', 'jump to that tab (Ctrl+1..3 is unusable: Ctrl+3 = Ctrl+C)'],
    ['/exit', 'quit the TUI'],
  ],
};

const GLOBAL = [
  ['', 'Everywhere'],
  ['1 2 3', 'Monitor / Launch / Chat (alt+1..3 or /1../3 from Chat, or click the tab)'],
  ['?', 'toggle this help'],
  ['Ctrl-C', 'quit TUI (server keeps running)'],
  ['q', 'quit TUI (server keeps running)'],
];

// topic (Launch only): 'editor', 'strata' or 'list' -- the screen `?` was pressed on.
export function Help({ mode, topic }) {
  const own = mode === 'mode2'
    ? (topic === 'editor' ? HELP.mode2editor : topic === 'strata' ? HELP.mode2strata : topic ? HELP.mode2 : [...HELP.mode2, ...HELP.mode2editor, ...HELP.mode2strata])
    : (HELP[mode] || []);
  const rows = [...own, ...GLOBAL];
  return h(Box, { borderStyle: 'round', borderColor: 'blue', paddingX: 1, marginTop: 1 },
    h(Box, { flexDirection: 'column' },
      h(Text, { bold: true, color: 'blue' }, 'Help'),
      rows.map(([k, label]) => (k === ''
        ? h(Text, { key: label, bold: true }, label)
        : h(Text, { key: k + label },
          h(Text, { color: 'cyan' }, k.padEnd(16)),
          label,
        ))),
    ),
  );
}
