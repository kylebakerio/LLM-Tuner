import { Box, Text } from 'ink';
import { h } from '../h.js';
import { profileColumns, fit, fitLabel, planCards, planSplit, busyText, wrapLines, PROFILE_GUTTER } from '../launchplan.js';

// Presentational pieces of Launch mode's profile-first flow. No input
// handling here: Launch (modes/launch.js) owns the keyboard and the state,
// these only draw it. Every row is ONE line (wrap: truncate) and the lists
// are padded to a fixed height, so moving the selection, filtering or a
// status message never changes the screen height (the layout-thrash rule
// the Monitor panels follow).

// ---- top of Launch mode: what the dashboard's server is running ----

// Line 1, in every Launch view: model, state, context, cards and uptime of
// the running server (the model name gives way first when the line is
// tight). `run` is launchplan.js runningSummary().
export function RunningLine({ run, cols }) {
  const head = h(Text, { bold: true, color: 'blue' }, 'LAUNCH');
  if (!run.active) {
    const ext = run.external;
    return h(Text, { wrap: 'truncate-end' }, head,
      h(Text, { dimColor: true }, '  ○ no model running'),
      ext ? h(Text, { color: 'yellow' }, `  · external llama-server on :${ext.port || 8080}${ext.model ? ` (${ext.model})` : ''}`) : null);
  }
  const ctx = run.ctx != null ? ` · ctx ${run.ctx.toLocaleString('en-US')}` : '';
  const cards = run.cards ? ` · ${run.cards}` : '';
  const tail = run.loading
    ? ` · loading${run.loadingFor != null ? ` ${run.loadingFor}s` : '…'}`
    : run.state === 'ready'
      ? (run.uptime ? ` · up ${run.uptime}` : ' · uptime unknown')
      : ` · ${run.state}`;
  const fixed = 'LAUNCH  ● '.length + ctx.length + cards.length + tail.length;
  const name = run.model || 'model';
  const max = Math.max(12, cols - fixed - 1);
  const shown = name.length > max ? `${name.slice(0, max - 1)}…` : name;
  const color = run.state === 'ready' ? 'green' : 'yellow';
  return h(Text, { wrap: 'truncate-end' }, head,
    h(Text, { color }, run.state === 'ready' ? '  ● ' : '  ◌ '),
    h(Text, { bold: true }, shown),
    h(Text, null, ctx, cards),
    h(Text, { color: run.state === 'ready' ? undefined : 'yellow', dimColor: run.state === 'ready' && !run.uptime }, tail));
}

// Line 2: the stop / restart keys, spelled out while there is something to
// stop (a blank line otherwise, so the rows below never move).
export function RunningActions({ run }) {
  if (!run.active || run.state === 'stopping') return h(Text, null, ' ');
  return h(Text, { wrap: 'truncate-end' },
    '  ',
    h(Text, { bold: true, color: 'yellow' }, 'x'), h(Text, null, ' stop the server'),
    run.state === 'ready'
      ? h(Text, null, '   ', h(Text, { bold: true, color: 'yellow' }, 'R'), ' restart it (same config)')
      : null,
    h(Text, { dimColor: true }, '   — both ask first'));
}

// ---- profile list ----

// First visible row for a selection: the selection stays near the middle.
export function listTop(sel, count, height) {
  return Math.max(0, Math.min(sel - Math.floor(height / 2), Math.max(count - height, 0)));
}

function statusCell(r, w) {
  if (r.missing) return h(Text, { color: 'red', bold: true }, fit('MISSING', w));
  if (!r.runnable) return h(Text, { dimColor: true }, fit('unavailable', w));
  if (r.neverUsed) return h(Text, { color: 'yellow' }, fit('never used', w));
  return h(Text, { dimColor: true }, fit(r.used, w));
}

// The two-column flag in front of a row: a missing model file, a profile this
// machine can't run, or one that runs with a note (ids moved, a stand-in card).
function flagCell(r) {
  if (r.missing) return h(Text, { bold: true, color: 'red' }, '✗ ');
  if (!r.runnable) return h(Text, { dimColor: true }, '– ');
  if (r.avail && r.avail.status !== 'ready') return h(Text, { color: 'yellow' }, '~ ');
  return h(Text, null, '  ');
}

// rows      -- the rows shown (filtered), launchplan.js profileRow() objects,
//              in profileListRows() order: runnable first, then (dimmed) the
//              profiles this machine can't run
// allRows   -- every row: column widths come from these, so they don't jump
//              while the filter narrows the list
// height    -- list rows drawn (padded)
// counts    -- launchplan.js availabilityCounts(allRows)
// signature -- the machine in one phrase ("2x RX 7900 XTX 24G | 63G RAM"),
//              '' when the server sent no topology
// hideUnavailable -- the `u` toggle: unavailable profiles are left out of `rows`
export function ProfileList({ rows, allRows, sel, height, cols, filter, filtering, loadError, counts = null, signature = '', hideUnavailable = false }) {
  const w = profileColumns(allRows, cols);
  const top = listTop(sel, rows.length, height);
  const lines = [];
  for (let i = 0; i < height; i++) {
    const r = rows[top + i];
    if (!r) { lines.push(h(Text, { key: `pad${i}` }, ' ')); continue; }
    const selected = top + i === sel;
    const off = !r.runnable;
    const noted = !off && r.avail && r.avail.status !== 'ready';
    lines.push(h(Text, { key: r.name, wrap: 'truncate-end' },
      h(Text, { bold: true, color: 'green' }, selected ? '› ' : '  '),
      flagCell(r),
      h(Text, { bold: selected, color: selected ? 'green' : undefined, dimColor: off && !selected }, fit(r.name, w.name)),
      ' ',
      h(Text, { color: r.missing ? 'red' : undefined, dimColor: !r.missing && (off || !selected) }, fit(r.model, w.model)),
      ' ',
      h(Text, { dimColor: off }, String(r.ctx).padStart(w.ctx)),
      ' ',
      h(Text, { color: noted ? 'yellow' : undefined, dimColor: off || (!selected && !noted) }, fitLabel(r.cards, w.cards)),
      w.build ? h(Text, { dimColor: true }, ` ${fit(r.build, w.build)}`) : null,
      ' ',
      statusCell(r, w.status),
    ));
  }
  const cur = rows[Math.min(sel, rows.length - 1)] || null;
  const below = Math.max(0, rows.length - top - height);
  const range = rows.length === 0
    ? (allRows.length === 0 ? '' : 'no profile matches the filter — Esc clears it')
    : `${top + 1}–${Math.min(rows.length, top + height)} of ${rows.length}${rows.length !== allRows.length ? ` (${allRows.length} saved)` : ''}`
      + `${top > 0 ? ` · ↑ ${top} above` : ''}${below > 0 ? ` · ↓ ${below} below` : ''}`;
  // The title line: how many profiles there are, how many of them this
  // machine can run (with the key that hides the rest) and the machine they
  // are judged against. One line: the tail is cut on a narrow terminal, so
  // the counts and the key come before the machine.
  const c = counts || { total: allRows.length, unavailable: 0, runnable: allRows.length };
  const title = c.unavailable > 0
    ? ` · ${c.runnable} of ${c.total} run here (u ${hideUnavailable ? 'shows' : 'hides'} the rest)${signature ? ` · ${signature}` : ''} · most recently used first`
    : ` · ${allRows.length} saved${signature ? ` · ${signature}` : ''} · most recently used first${signature ? '' : ' · shared with the web dashboard'}`;
  const detailNote = cur && cur.availNote ? cur.availNote : '';

  return h(Box, { flexDirection: 'column' },
    h(Text, { wrap: 'truncate-end' },
      h(Text, { bold: true }, ` Profiles`),
      h(Text, { dimColor: true }, title),
    ),
    h(Text, { wrap: 'truncate-end' },
      filtering
        ? h(Text, null, h(Text, { color: 'cyan', bold: true }, ' filter: '), filter, h(Text, { inverse: true }, ' '),
          h(Text, { dimColor: true }, '   Enter: review the selected profile · Esc: clear'))
        : filter
          ? h(Text, null, h(Text, { color: 'cyan' }, ` filter: ${filter}`), h(Text, { dimColor: true }, '   (/ edit · Esc clear)'))
          : h(Text, { dimColor: true }, ' filter: (none — press / and type)'),
    ),
    h(Text, { dimColor: true, wrap: 'truncate-end' },
      `${' '.repeat(PROFILE_GUTTER)}${fit('PROFILE', w.name)} ${fit('MODEL', w.model)} ${'CTX'.padStart(w.ctx)} ${fit('PLACEMENT', w.cards)}`
      + `${w.build ? ` ${fit('BUILD', w.build)}` : ''} ${fit('LAST USED', w.status)}`),
    loadError && allRows.length === 0
      ? h(Text, { color: 'red', wrap: 'truncate-end' }, `  ${loadError}`)
      : allRows.length === 0
        ? h(Text, { color: 'yellow', wrap: 'truncate-end' }, '  No profiles saved yet — press n to open the config editor, then p there to save one.')
        : null,
    ...lines,
    h(Text, { dimColor: true, wrap: 'truncate-end' }, `  ${range}` || ' '),
    // The selected profile in full: the row above cuts long names and paths.
    h(Text, { bold: true, wrap: 'truncate-end' }, cur ? `  ${cur.name}` : ' '),
    cur && cur.missing
      ? h(Text, { color: 'red', wrap: 'truncate-middle' }, `  ✗ ${cur.missingWhy}${cur.filePath ? `: ${cur.filePath}` : ''}`)
      : h(Text, { dimColor: true, wrap: 'truncate-middle' }, cur ? `  ${cur.filePath}` : ' '),
    // Its fit on this machine first (when it is not simply ready), then when
    // it was last used and its note.
    h(Text, { wrap: 'truncate-end' },
      detailNote ? h(Text, { color: 'yellow', bold: !cur.runnable }, `  ${detailNote}`) : null,
      h(Text, { dimColor: true },
        cur
          ? `${detailNote ? ' · ' : '  '}${cur.neverUsed ? 'never used' : `last used ${cur.used}`}${cur.strata ? ` · Strata engine${cur.strataVersion ? ` ${cur.strataVersion}` : ''} (e opens the Strata editor)` : ''}${cur.note ? ` · ${cur.note}` : ''}`
          : ' ')),
  );
}

// ---- confirm panel ----

// One labelled row of the confirm panel. The label column is a fixed-width
// box: as plain sibling text it would be squeezed whenever the value wraps.
const FIELD_LABEL_W = 12;
function Field({ label, children }) {
  return h(Box, null,
    h(Box, { width: FIELD_LABEL_W, flexShrink: 0 }, h(Text, { dimColor: true }, `   ${label}`)),
    h(Box, { flexGrow: 1, flexShrink: 1 }, children));
}

// What is about to launch: the model, context, build, the cards the server
// resolved, the exact command (from /api/preview-command, which never spawns
// anything) -- and, loudly, anything that makes this more than "start a
// server": benchmark-queue items on a needed card, a server that has to be
// stopped first, a model file that isn't there.
// Cards are named by their topology labels (two identical cards read "#1" and
// "#2"); a launch on more than one device also says how the model is split.
// A profile the server says this machine can't run gets its own box, and the
// panel then launches only through the explicit override (launch.js).
//   pending  -- Launch's confirm state (see openProfileConfirm in launch.js)
//   risks    -- launchplan.js launchRisks() entries
//   builds   -- /api/builds list, for the build's label
//   topology -- normalizeTopology() of the machine (null = unknown)
//   maxRows  -- rows the panel may take; the note (3 lines at most), then the
//               command, are cut to fit -- never the warnings
export function LaunchConfirm({ pending, risks, builds, cols, maxRows, topology = null }) {
  const p = pending;
  const row = p.row;
  const cfg = p.config || row.config || {};
  const pv = p.preview;
  const title = p.kind === 'restart'
    ? 'Restart the server'
    : p.kind === 'draft'
      ? `Launch the config from the editor${p.name ? ` (profile “${p.name}”)` : ''}`
      : `Launch profile “${p.name}”`;
  const build = (builds || []).find((b) => b.id === cfg.build);
  const cards = planCards(pv.devices, cfg, topology);
  const split = planSplit(cards.length, pv, cfg);
  const busy = pv.busy || [];
  const avail = row.avail || { status: 'ready', reason: '' };
  const blocked = avail.status === 'unavailable';
  // A profile that runs with a note (ids moved, a stand-in card) says so with
  // the other warnings; one that can't run has the box below.
  const warnings = [...(!blocked && row.availNote ? [row.availNote] : []), ...(p.notes || []), ...(pv.warnings || [])];
  const quiet = risks.filter((r) => r.kind !== 'busy' && r.kind !== 'unavailable');
  const firstCard = topology && topology.cards[0] ? topology.cards[0].label : '';
  const ctxText = row.ctxTokens != null && Number.isFinite(Number(row.ctxTokens))
    ? `${Number(row.ctxTokens).toLocaleString('en-US')} tokens`
    : (row.strata ? 'set by the Strata base config' : 'not set');
  const textW = Math.max(20, cols - FIELD_LABEL_W - 1);
  // Everything but the note and the command: title + blank, model, path,
  // context, cards (and the split line), the blank under the fields, the
  // not-runnable box, the busy box, the risk list.
  const fixedRows = 2 + 1 + (row.filePath ? 1 : 0) + 2 + (split ? 1 : 0) + (warnings.length ? 1 : 0) + 1
    + (blocked ? 6 : 0)
    + (busy.length > 0 ? busy.length + 4 : (p.late ? 1 : 0))
    + (p.step === 'risk' ? risks.length + 2 : (quiet.length ? quiet.length + 1 : 0));
  const room = Math.max(3, maxRows - fixedRows);
  const commandText = p.problem || (pv.loading ? 'resolving with the dashboard…' : (pv.error || pv.command || '(the dashboard returned no command)'));
  // The command comes first: the note shrinks to one line before it loses any.
  const wantCommand = wrapLines(commandText, textW).length;
  const noteRows = row.note ? Math.max(1, Math.min(3, room - wantCommand)) : 0;
  const noteLines = row.note ? wrapLines(row.note, textW, noteRows) : [];
  const commandLines = wrapLines(commandText, textW, Math.max(2, room - noteLines.length));

  return h(Box, { flexDirection: 'column' },
    h(Text, { bold: true, wrap: 'truncate-end' }, ` ${title}`),
    h(Text, null, ' '),
    h(Field, { label: 'model' },
      h(Text, { wrap: 'truncate-end' },
        h(Text, { bold: true, color: row.missing ? 'red' : undefined }, row.model),
        row.missing ? h(Text, { color: 'red', bold: true }, `  ✗ ${row.missingWhy}`) : null)),
    row.filePath
      ? h(Field, { label: '' }, h(Text, { dimColor: true, wrap: 'truncate-middle' }, row.filePath))
      : null,
    h(Field, { label: 'context' },
      h(Text, { wrap: 'truncate-end' },
        ctxText,
        h(Text, { dimColor: true }, '   build '),
        // the Strata install the base config belongs to, when the dashboard says (or its directory name does)
        row.strata ? `Strata engine${row.strataVersion ? ` ${row.strataVersion}` : ''}` : (cfg.build || 'default'),
        build ? h(Text, { dimColor: true }, ` — ${build.label}`) : null)),
    h(Field, { label: 'cards' },
      cards.length > 0
        // each device, then (dim) the server's one-phrase placement when it sent one
        ? h(Text, { wrap: 'truncate-end' }, cards.map((c) => `${c.text}${c.share ? ` ${c.share}` : ''}`).join('  ·  '),
          pv.placement ? h(Text, { dimColor: true }, `   ${pv.placement}`) : null)
        : h(Text, { color: row.strata ? undefined : 'yellow', wrap: 'truncate-end' },
          row.strata
            ? `placed by the Strata engine (its GPU list, else the first card${firstCard ? `: ${firstCard}` : ''})`
            : 'auto — llama-server uses every card it sees')),
    split
      ? h(Field, { label: 'split' },
        h(Text, { color: split.level === 'bad' ? 'red' : split.level === 'warn' ? 'yellow' : undefined, bold: split.level === 'bad', wrap: 'truncate-end' }, split.text))
      : null,
    ...noteLines.map((ln, i) => h(Field, { key: `note${i}`, label: i === 0 ? 'note' : '' },
      h(Text, { dimColor: true, wrap: 'truncate-end' }, ln))),
    ...commandLines.map((ln, i) => h(Field, { key: `cmd${i}`, label: i === 0 ? 'command' : '' },
      h(Text, { color: p.problem || pv.error ? 'red' : undefined, dimColor: !p.problem && pv.loading, wrap: 'truncate-end' }, ln))),
    warnings.length > 0
      ? h(Text, { color: 'yellow', wrap: 'truncate-end' }, ` ⚠ ${warnings.join(' · ')}`)
      : null,
    h(Text, null, ' '),
    blocked
      ? h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'yellow', paddingX: 1 },
        h(Text, { bold: true, color: 'yellow', wrap: 'truncate-end' }, '⚠ NOT RUNNABLE HERE — this profile needs hardware this machine does not have'),
        h(Text, { color: 'yellow', wrap: 'truncate-end' }, `  ${avail.reason || 'The dashboard gave no reason.'}`),
        h(Text, { dimColor: true, wrap: 'truncate-end' }, `  this machine: ${(topology && topology.signature) || 'not described by the dashboard'}`),
        h(Text, { wrap: 'truncate-end' }, p.override
          ? (p.refused
            ? 'The dashboard refused to start it. Launching anyway sends it exactly as saved.'
            : 'Override chosen: it will be launched exactly as saved.')
          : 'Enter does not launch it. e edits it for this machine; O overrides and launches it as saved.'))
      : null,
    busy.length > 0
      ? h(Box, { flexDirection: 'column', borderStyle: 'round', borderColor: 'red', paddingX: 1 },
        h(Text, { bold: true, color: 'red' }, `⚠ CARD BUSY — ${busy.length === 1 ? 'a benchmark is' : 'benchmarks are'} running on ${busy.length === 1 ? 'a card' : 'cards'} this launch needs`),
        ...busy.map((b, i) => h(Text, { key: i, color: 'red', wrap: 'truncate-end' }, `  ${busyText(b)}`)),
        h(Text, { wrap: 'truncate-end' }, p.late
          ? `The dashboard refused to start. Launching anyway takes ${busy.length === 1 ? 'the card from that run' : 'those cards from the runs on them'}.`
          : `Launching takes ${busy.length === 1 ? 'the card from that run' : 'those cards from the runs on them'} — it needs a second confirmation.`))
      : p.late
        ? h(Text, { bold: true, color: 'red', wrap: 'wrap' }, ` ⚠ CARD BUSY — ${p.lateMessage || 'the dashboard refused to start: a benchmark holds a card this launch needs'}`)
        : null,
    p.step === 'risk'
      ? h(Box, { flexDirection: 'column' },
        h(Text, { bold: true, color: 'yellow' }, ` ${p.kind === 'restart' ? 'Start it' : 'Launch'} anyway? This will:`),
        ...risks.map((r, i) => h(Text, { key: i, color: 'yellow', wrap: 'truncate-end' }, `   • ${r.text}`)),
        h(Box, null,
          h(Text, { color: 'yellow' }, ' Press '), h(Text, { bold: true }, 'y'),
          h(Text, { color: 'yellow' }, ' to go ahead, '), h(Text, { bold: true }, 'n'),
          h(Text, { color: 'yellow' }, ' or Esc to cancel '), h(Text, { bold: true }, '[y/N]')))
      // Review step: the busy cards have their own box above; say what else
      // Enter will ask about.
      : quiet.length > 0
        ? h(Box, { flexDirection: 'column' },
          h(Text, { color: 'yellow' }, busy.length > 0 ? ' Launching will also:' : ' Launching will:'),
          ...quiet.map((r, i) => h(Text, { key: i, color: 'yellow', wrap: 'truncate-end' }, `   • ${r.text}`)))
        : null,
  );
}
