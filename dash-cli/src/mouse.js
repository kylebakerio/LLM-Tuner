import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useInput } from 'ink';

// StatusBar (in app.js) always renders exactly 2 rows (info line + tab
// strip), followed by one blank spacer Text -- a stable constant as long as
// neither of those change shape. Every mode's own click hit-testing adds
// this to its internal row number to get the terminal-absolute row (which
// only means anything because cli.js puts the whole app in the alternate
// screen buffer -- see its header comment).
export const APP_HEADER_ROWS = 3;

// SGR mouse mode (1000: button events, 1006: extended coordinates -- the
// legacy encoding overflows past column/row 223, which this terminal's
// launch-config table alone can exceed). No mouse library exists for Ink, so
// this is raw escape codes in both directions.
const ENABLE = '\x1b[?1000h\x1b[?1006h';
const DISABLE = '\x1b[?1000l\x1b[?1006l';

// Refcounted so two components enabling mouse tracking at once (the app-level
// tab-strip handler and a mode's own handler) don't have the first one's
// cleanup turn it off under the second one.
let refCount = 0;
function enable() { if (refCount++ === 0) process.stdout.write(ENABLE); }
function disable() { if (refCount > 0 && --refCount === 0) process.stdout.write(DISABLE); }

let exitHookInstalled = false;
function installExitHook() {
  if (exitHookInstalled) return;
  exitHookInstalled = true;
  // Belt-and-suspenders: whatever else happens (crash, unhandled rejection,
  // a signal handler that skips React's unmount), never leave the user's
  // terminal reporting mouse escapes into their next shell session.
  process.on('exit', () => { if (refCount > 0) { process.stdout.write(DISABLE); refCount = 0; } });
}

// Suspend switch: while a mode owns the keyboard with a TEXT editor open,
// the terminal's mouse tracking is turned off entirely (every useMouseClicks
// instance disables, dropping the refcount to zero). Two reasons:
//   - with tracking on, the terminal REPORTS a middle-click as an SGR
//     sequence instead of performing the primary-selection paste the text
//     field depends on;
//   - that report then reaches every useInput callback (Ink strips the
//     leading ESC) and ink-text-input inserts it VERBATIM as text -- the
//     user literally types "[<2;19;60M" into their profile name.
// The gate is module-level rather than an `active` prop because the
// app-level and mode-level useMouseClicks instances live in DIFFERENT
// components: App does not re-render when a mode's editor opens, so a prop
// computed in App would stay stale-true (refcount never hits zero) until an
// unrelated App re-render. setMouseGate() is called from the mode's effect;
// useSyncExternalStore wakes every hook instance so all of them re-run their
// enable/disable effect in the same tick.
let gated = false;
const gateListeners = new Set();
export function setMouseGate(on) {
  const v = !!on;
  if (gated === v) return;
  gated = v;
  for (const l of gateListeners) l();
}
function subscribeGate(l) {
  gateListeners.add(l);
  return () => gateListeners.delete(l);
}

// A single click event is one contiguous SGR sequence
// (`\x1b[<button;x;yM` for press, `...m` for release) that a terminal writes
// in one shot, so it always arrives as one `input` string. Ink's own
// parseKeypress doesn't recognize it (no branch matches), so it falls
// through untouched as the leftover-sequence catch-all and reaches every
// active useInput callback verbatim, one leading ESC already stripped --
// this is intentionally built on the PUBLIC useInput API rather than
// reaching into Ink's internal stdin plumbing, so a mouse click can never
// desync from however Ink itself is currently reading the terminal.
const SGR_RE = /\x1b?\[<(\d+);(\d+);(\d+)([mM])/g;

// SGR's own button numbering is 0=left, 1=middle, 2=right -- but several
// terminals (and some terminal layers) report the X11-style numbering
// instead: 1=left, 2=middle, 3=right. There is no escape-sequence query
// that asks a terminal which convention it uses, and the two show up in the
// wild on the same machine (tmux forwards its outer terminal's SGR code
// VERBATIM, so the convention an app sees depends on the terminal tmux is
// attached to). So the left button is matched against BOTH 0 and 1.
// The only collision is that a MIDDLE-click (1 in the SGR convention)
// counts as a left-click on SGR-convention terminals -- acceptable, because
// the one place a middle-click must NOT act as a click (a text editor) runs
// with mouse tracking suspended entirely (setMouseGate), so the terminal
// performs its native paste there and no SGR events arrive at all. Wheel
// events (64/65 in either convention) match neither code, so scrolling never
// clicks.
function isLeftButton(button) {
  return button === 0 || button === 1;
}

// Reports left-button PRESS events as {x, y}, 1-indexed absolute terminal
// row/column (row 1 = the terminal's own top row) -- callers must know their
// own absolute row offset, which only holds if the app owns the whole
// screen (see cli.js's alternate-screen buffer switch; without it, Ink's
// normal inline rendering start row drifts with scroll position and this
// coordinate space isn't meaningful).
//
// `active` also gates the ENABLE/DISABLE escape codes, not just parsing --
// Chat mode runs with this off so terminal mouse tracking never intercepts
// the primary-selection copy / middle-click paste it depends on (see
// chat.js's header comment), and the gate (setMouseGate) does the same on
// demand while a mode's text editor is open.
export function useMouseClicks(active, onClick) {
  const onClickRef = useRef(onClick);
  onClickRef.current = onClick;
  const gatedNow = useSyncExternalStore(subscribeGate, () => gated);

  useEffect(() => {
    installExitHook();
    if (!active || gatedNow) return undefined;
    enable();
    return () => disable();
  }, [active, gatedNow]);

  useInput((input) => {
    if (!active || gatedNow || !input.includes('[<')) return;
    SGR_RE.lastIndex = 0;
    let m;
    while ((m = SGR_RE.exec(input)) !== null) {
      const button = Number(m[1]);
      const x = Number(m[2]);
      const y = Number(m[3]);
      const press = m[4] === 'M';
      if (press && isLeftButton(button)) {
        onClickRef.current?.({ x, y });
      }
    }
  });
}
